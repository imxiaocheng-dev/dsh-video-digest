#!/usr/bin/env node
/**
 * runner.mjs —— 队列执行器（本地跑，0 常驻 token）
 *
 * 干什么：从 logs/library.db 取 status=queued 的视频，逐个跑 scripts/digest.mjs，
 *         跑前检查（夜间停 / 每小时上限 / 日预算三档），跑完回写状态与账本，
 *         每次没跑或降级都写原因码。
 *
 * 用法：
 *   node scripts/runner.mjs --limit=2                 # 跑队列前 2 条（默认 T3）
 *   node scripts/runner.mjs --limit=1 --depth=T2      # 指定档位
 *   node scripts/runner.mjs --limit=2 --dry           # 只报告要做什么，不真跑
 *   node scripts/runner.mjs --bv=BV1xxxx              # 只跑指定视频（不看队列）
 *
 * 输出：最后一行 `RESULTS {json}`，同时写 logs/runner.log（每行一条 JSON）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as lib from './lib/library.mjs';
import { normalizeRoute } from './lib/routes.mjs';
import { afterDoneCleanup, sweep, readStorage } from './lib/cache.mjs';
import { DATA_ROOT, CODE_ROOT, ensureData } from './lib/paths.mjs';
/* v47：可跑时间段（纯函数；旧 blackout 配置内部迁移） */
import { windowAllows } from './lib/runwindow.mjs?v=54';

// 数据目录：台账/日志/产物都写这里（旧布局下就是包根，本机行为不变）
ensureData();
const ROOT = DATA_ROOT;
const LIB = path.join(ROOT, 'logs', 'library.db');
const LEDGER = path.join(ROOT, 'logs', 'ledger.db');
const LOG = path.join(ROOT, 'logs', 'runner.log');
const NODE = process.execPath;
// 代码目录：被 spawn 的脚本自身（随包走，不在这里写数据）
const DIGEST = path.join(CODE_ROOT, 'scripts', 'digest.mjs');
const FACT = path.join(CODE_ROOT, 'scripts', 'factcard.mjs');
const GATE = path.join(CODE_ROOT, 'scripts', 'gate.mjs');
const SUMM = path.join(CODE_ROOT, 'scripts', 'summarize.mjs');
const WHY = path.join(CODE_ROOT, 'scripts', 'why.mjs');

const args = process.argv.slice(2);
const arg = (k, d) => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const flag = k => args.includes('--' + k);
const LIMIT = Number(arg('limit', 1));
const DEPTH = String(arg('depth', 'T3')).toUpperCase();
const BV = arg('bv', null);
const DRY = flag('dry');
const FORCE = args.includes('--force'); // 用户手动点「开始跑」= 显式指令，可越过夜间停（预算仍生效）
/* 本地总结默认不跑：主路是云端（会话模型写 summary.cloud.json）。
   只有 config/summarize.json 里 enabled=true，或手工加 --local-summary，才会调本地模型。 */
const SUMM_CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'summarize.json'), 'utf8')); } catch { return {}; } })();
const LOCAL_SUMMARY = !args.includes('--no-summary') && (SUMM_CFG.enabled === true || args.includes('--local-summary'));

const readJson = (rel, dflt) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return dflt; }
};
const logLine = obj => {
  try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n'); } catch {}
};

// ---------- 计价（与 panel_server 同一公式） ----------
const pricing = readJson('config/pricing.json', { inMiss: 1, inHit: 0.02, out: 4, peakMultiplier: 2, peakHours: [['09:00', '12:00'], ['14:00', '18:00']], peakDays: [1, 2, 3, 4, 5] });
const budget = readJson('config/budget.json', { daily: 1, weekly: 5, monthly: 20, warnPct: 80, overAction: 'degrade' });
const pacing = readJson('config/pacing.json', { heat: [], fetch: {}, guard: {}, switches: {} });
const OUT_TOK_EST = 500, PREFIX_TOK_EST = 2500;

function isPeakAt(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  if (!(pricing.peakDays || [1, 2, 3, 4, 5]).includes(day)) return false;
  const hm = dt.getHours() * 60 + dt.getMinutes();
  return (pricing.peakHours || []).some(([a, b]) => {
    const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number);
    return hm >= h1 * 60 + m1 && hm < h2 * 60 + m2;
  });
}
const costYuan = (tokens, peak) =>
  ((tokens * (pricing.inMiss ?? 1) + PREFIX_TOK_EST * (pricing.inHit ?? 0.02) + OUT_TOK_EST * (pricing.out ?? 4)) / 1e6) *
  (peak ? (pricing.peakMultiplier ?? 2) : 1);

function spentToday() {
  try {
    const db = new DatabaseSync(LEDGER, { readOnly: true });
    const rows = db.prepare('SELECT at, total_tokens FROM runs').all();
    db.close();
    const today = new Date().toISOString().slice(0, 10);
    let sum = 0;
    for (const r of rows) {
      if (String(r.at).slice(0, 10) !== today) continue;
      sum += costYuan(Number(r.total_tokens) || 0, isPeakAt(r.at));
    }
    return sum;
  } catch { return 0; }
}

// ---------- 护栏检查 ----------
function guardCheck() {
  const g = pacing.guard || {}, f = pacing.fetch || {};
  const now = new Date();
  const reasons = [];
  const hour = now.getHours();
  const heat = Array.isArray(pacing.heat) && pacing.heat.length === 24 ? pacing.heat : null;
  /* v47（契约 §2b）：heat / guard.nightStop 不再作为跑片闸门 —— 跑不跑只看 runWindow；
     nightStop 字段保留在配置里兼容旧配置，heat 仅保留展示/其它用途。 */
  if (String(DEPTH) === 'T3' && pacing.switches && pacing.switches.queueToOffPeak === true && isPeakAt(now)) {
    // 不阻断，只提示：可以排队到谷时
    reasons.push('note_peak_window');
  }
  /* v48：唯一时段真源 runWindow（trough 模式的谷时来自价目表 pricing）；旧 blackout/trough 由 windowAllows 内部迁移 */
  const windowOk = windowAllows(pacing.runWindow, now, pricing);
  if (!windowOk) reasons.push(FORCE ? 'force_bypass_blackout' : 'guard_blackout');
  const spent = spentToday();
  const daily = Number(budget.daily) || 1;
  let budgetState = 'ok';
  if (spent >= daily) budgetState = 'exhausted';
  else if (spent >= daily * ((Number(budget.warnPct) || 80) / 100)) budgetState = 'warn';
  return { reasons, spent, daily, budgetState, hour, heatOk: !(g.nightStop && heat && heat[hour] === 0), windowOk };
}

// ---------- 队列 ----------
function pick() {
  const db = new DatabaseSync(LIB);
  let rows;
  if (BV) {
    rows = db.prepare("SELECT bvid,title,status,score FROM videos WHERE bvid=? LIMIT 1").all(BV);
  } else {
    // 手动/入站（prio=1）优先，同类内分数高的先跑，同分先到先跑
    rows = db.prepare("SELECT bvid,title,status,score FROM videos WHERE status='queued' ORDER BY COALESCE(prio,0) DESC, COALESCE(score,0) DESC, first_seen ASC LIMIT ?").all(LIMIT);
  }
  db.close();
  return rows;
}
function setStatus(bvid, status, note, depth, fromStatus) {
  // v23：状态与「出队时刻」统一交给 library.setStatus —— 它才会写 exited_at / exit_reason。
  // 之前这里自己裸写 UPDATE，漏了这两列，导致队列页「最近出队」从 2026-10-31 起不再更新
  // （22 条 seen 全部 exited_at IS NULL，被 library.exited() 的 exited_at IS NOT NULL 过滤掉）。
  // v41（A2-04）：传 fromStatus 时走条件更新，行已不是该状态（用户删了/改过）就不动它。
  if (fromStatus) {
    const r = lib.setStatusIf(bvid, fromStatus, status, String(note ?? ''));
    if (!r || !r.changed) return r;
  } else {
    lib.setStatus(bvid, status, String(note ?? ''));
  }
  if (depth) {
    const db = new DatabaseSync(LIB);
    db.prepare('UPDATE videos SET depth = COALESCE(?, depth) WHERE bvid=?').run(depth, bvid);
    db.close();
  }
}

// ---------- 跑单个 ----------
function runOne(row, plannedDepth) {
  const t0 = Date.now();
  const argv = [DIGEST, row.bvid, '--depth=' + plannedDepth];
  const r = spawnSync(NODE, argv, { cwd: CODE_ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    const stdout = String(r.stdout || '');
    const stderr = String(r.stderr || '');
    /* v49 A2：digest 用 exit 3 + SKIP_ 标记宣告「这条不可跑」（充电专属试看 / 没有 dash 流）。
       这是永久性片源问题，不该按 maxFails 反复重试（白烧 3 次时间）。 */
    const skipHit = (stderr + '\n' + stdout).match(/^SKIP_(PREVIEW|NOSTREAM)\s+(.+)$/m);
    if (skipHit) return { ok: false, skip: true, skipCode: 'SKIP_' + skipHit[1], reason: skipHit[2].trim().slice(0, 160), wall };
    /* 错误摘要别只留末 4 行（Windows 上那 4 行常常全是栈帧，把 "Error: xxx" 丢了） */
    const lines = (stderr || stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const head = lines.find((l) => /^Error:/.test(l)) || lines.find((l) => !/^\s*at\s/.test(l) && !/^\s*\^/.test(l) && !/^node:internal/.test(l));
    const tail = String(head || lines.slice(-4).join(' | ') || ('exit ' + r.status)).slice(0, 400);
    return { ok: false, wall, error: tail };
  }
  const cost = readJson(path.join('out', row.bvid, 'cost.json'), null);

  /* ---- 后处理：事实卡 → 门禁（全部 0 token）→ 可选本地草稿（默认关） ---- */
  const post = { factcard: null, gate: null, summary: null, summaryError: null, localSummarySkipped: !LOCAL_SUMMARY };
  try {
    const rf = spawnSync(NODE, [FACT, row.bvid], { cwd: CODE_ROOT, encoding: 'utf8', timeout: 120000 });
    if (rf.status === 0) post.factcard = 'ok';
  } catch (e) { post.factcard = String(e.message || e); }

  try {
    /* v39：把台账里的 via 传给门禁 —— 点播源（inbound/manual/panel/gray）在 gate 里直接短路成「推荐看」，
       不再被判「一般般 / 没意思」而不写总结 */
    const viaArg = row.via ? '--via=' + row.via : '';
    const rg = spawnSync(NODE, viaArg ? [GATE, row.bvid, viaArg] : [GATE, row.bvid], { cwd: CODE_ROOT, encoding: 'utf8', timeout: 120000 });
    const gp = path.join(ROOT, 'out', row.bvid, 'gate.json');
    if (fs.existsSync(gp)) post.gate = JSON.parse(fs.readFileSync(gp, 'utf8'));
    if (rg.status !== 0) post.gateError = String(rg.stderr || '').slice(-200);
  } catch (e) { post.gateError = String(e.message || e); }

  if (LOCAL_SUMMARY) {
    try {
      const rs = spawnSync(NODE, [SUMM, '--bv=' + row.bvid], { cwd: CODE_ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000 });
      const sp = path.join(ROOT, 'out', row.bvid, 'summary.json');
      if (fs.existsSync(sp)) {
        const sj = JSON.parse(fs.readFileSync(sp, 'utf8'));
        post.summary = { verdict: sj.verdict || null, mark: sj.mark || null, model: sj.model || null, gist: (sj.gist || '').slice(0, 80) };
      } else {
        post.summaryError = String(rs.stderr || rs.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 200) || ('exit ' + rs.status);
      }
    } catch (e) { post.summaryError = String(e.message || e); }
  }

  /* v26（P3）：门禁判「一般般 / 没意思」→ 本地写「判否说明」（why.local.json，4–7 秒、0 元）。
     云端那两档（推荐看/可以看）绝不走这里；ollama 挂了也只记原因，不影响队列。 */
  const route = post.gate ? normalizeRoute(post.gate.route) : null;
  post.route = route;
  if (route === 'local-hold' || route === 'skip') {
    try {
      const rw = spawnSync(NODE, [WHY, '--bv=' + row.bvid], { cwd: CODE_ROOT, encoding: 'utf8', timeout: 4 * 60 * 1000 });
      const wp = path.join(ROOT, 'out', row.bvid, 'why.local.json');
      if (fs.existsSync(wp)) {
        const wj = JSON.parse(fs.readFileSync(wp, 'utf8'));
        post.why = wj.error ? { error: wj.error.code, zh: wj.error.zh } : { reasons: (wj.reasons || []).length, model: wj.model || null, ms: wj.ms || 0 };
      } else {
        post.why = { error: String(rw.stderr || rw.stdout || '').trim().split('\n').slice(-1)[0].slice(0, 120) || 'no-output' };
      }
    } catch (e) { post.why = { error: String(e.message || e) }; }
  }

  /* v26（P5）：跑完清缓存 —— afterDone='purge' 时立刻删视频与帧（宫格图/总结在 out/ 里，不动） */
  try { post.cache = afterDoneCleanup(row.bvid); } catch (e) { post.cache = { error: String(e.message || e) }; }

  return { ok: true, wall, cost, post };
}

// ---------- 主流程 ----------
const g = guardCheck();
const picked = pick();
const out = { at: new Date().toISOString(), depth: DEPTH, dry: DRY, guard: g, picked: picked.length, items: [] };

/* v47：heat/nightStop 不再拦跑片 —— 只有 runWindow 不允许才 skip */
if (g.windowOk === false && !FORCE) {
  for (const row of picked) {
    out.items.push({ bvid: row.bvid, title: row.title, action: 'skip', reason: 'guard_blackout' });
    logLine({ bvid: row.bvid, action: 'skip', reason: 'guard_blackout' });
  }
} else if (g.budgetState === 'exhausted') {
  for (const row of picked) {
    out.items.push({ bvid: row.bvid, title: row.title, action: 'degrade', reason: 'skip_budget_free_tier', note: '只给免费层（标题+弹幕峰+关键词），0 元' });
    setStatus(row.bvid, 'queued', 'free_tier_only');
    logLine({ bvid: row.bvid, action: 'degrade', reason: 'skip_budget_free_tier' });
  }
} else {
  for (const row of picked) {
    if (DRY) {
      out.items.push({ bvid: row.bvid, title: row.title, action: 'would_run', depth: DEPTH, est: Number((spentToday() + costYuan(1600, isPeakAt(new Date()))).toFixed(4)) });
      continue;
    }
    // 预算档位：warn 时降一档 T4→T3→T2
    let depth = DEPTH;
    if (g.budgetState === 'warn') {
      if (depth === 'T4') depth = 'T3';
      else if (depth === 'T3') depth = 'T2';
    }
    setStatus(row.bvid, 'running', 'runner:' + depth);
    logLine({ bvid: row.bvid, action: 'start', depth });
    const res = runOne(row, depth);
    // v41（A2-04）：收尾前确认这一行还是本次跑的那一行；用户删了/改过就只记账不改状态，
    // 否则 setStatus(seen) 会把刚删掉的行「复活」回归档之外。
    const cur = lib.get(row.bvid);
    const stillRunning = !!(cur && cur.status === 'running');
    if (!stillRunning) {
      logLine({ bvid: row.bvid, action: 'finish-skipped', depth, ok: res.ok, status: cur ? cur.status : null });
      out.items.push({ bvid: row.bvid, title: row.title, action: 'finish-skipped', depth, status: cur ? cur.status : null, ok: res.ok });
    } else if (res.ok) {
      setStatus(row.bvid, 'seen', 'runner ok', depth, 'running');
      logLine({ bvid: row.bvid, action: 'done', depth, post: res.post, wall: res.wall, tokens: res.cost?.tokens?.total ?? null, perMin: res.cost?.per_minute });
      const tk = res.cost?.tokens?.total ?? res.cost?.total ?? null;
      out.items.push({ bvid: row.bvid, title: row.title, action: 'done', depth, post: res.post, wall_s: Number(res.wall), tokens: tk, per_minute: res.cost?.per_minute ?? null });
    } else if (res.skip) {
      /* v49 A2：片源不可下载（充电专属试看 / 没有 dash 流）→ 首败就定格，不进 maxFails 重试 */
      setStatus(row.bvid, 'skipped', '不可跑：' + res.reason, depth, 'running');
      logLine({ bvid: row.bvid, action: 'skip-unavailable', code: res.skipCode, reason: res.reason, wall: res.wall });
      out.items.push({ bvid: row.bvid, title: row.title, action: 'skipped', depth, code: res.skipCode, reason: res.reason, wall_s: Number(res.wall) });
    } else {
      // 失败：累计到 maxFails 就转 failed（进队列页「异常」栏），否则退回排队重试
      const maxFails = Number((pacing.dispatch || {}).maxFails) || 3;
      const rec = lib.bumpFail(row.bvid, { maxFails, note: 'runner failed: ' + res.error.slice(0, 80) });
      if (rec && rec.status === 'failed') setStatus(row.bvid, 'failed', 'runner failed: ' + res.error.slice(0, 80), depth, 'running');
      else setStatus(row.bvid, 'queued', 'runner failed: ' + res.error.slice(0, 80), depth, 'running');
      logLine({ bvid: row.bvid, action: 'fail', depth, error: res.error, fails: rec ? rec.fails : null, status: rec ? rec.status : null });
      out.items.push({ bvid: row.bvid, title: row.title, action: 'fail', depth, error: res.error, fails: rec ? rec.fails : null, status: rec ? rec.status : 'queued' });
    }
  }
}

out.spent_after = Number(spentToday().toFixed(4));
out.daily = Number(budget.daily) || 1;
/* v26（P5）：每轮跑完按 keepDays 扫一次缓存（out/ 里的宫格图与总结永不删） */
try {
  const sweepRes = sweep(readStorage());
  out.cacheSweep = { keepDays: sweepRes.keepDays, videos: sweepRes.videos, frames: sweepRes.frames, orphans: sweepRes.orphans, freedMB: Number((sweepRes.freed / 1048576).toFixed(1)) };
} catch (e) { out.cacheSweep = { error: String(e.message || e) }; }
out.localSummary = LOCAL_SUMMARY; // false = 只跑事实卡+门禁，总结交给云端（默认）
out.summarizeMode = SUMM_CFG.mode || 'cloud';
console.log('RESULTS ' + JSON.stringify(out));
