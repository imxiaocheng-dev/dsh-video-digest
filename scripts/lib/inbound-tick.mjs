// 入站 tick：一次「看一眼有没有新消息」，命中就入队（不自建调度，靠面板 dispatcher 立刻跑）
//
// 三步，严格按「身份先于内容」：
//   1) 轻探测：get_sessions（只取 uid/unread/ts，不读 last_msg 正文）+ @ 收件箱（只有 id/时间/mid/uri）
//   2) 身份核实：inbound.identify(uid) —— 必须是已绑定的推送账号；陌生只记计数，绝不读正文
//   3) 断言内容：只对通过核实的 uid 调 fetch_session_msgs / 楼层回读，取 bvid 入队
//
// 幂等由 logs/inbound.db 的 receipt 保证；游标只在事件落库之后推进（至少一次）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as bili from './bili.mjs';
import * as inbound from './inbound.mjs';
import * as lib from './library.mjs';
import { DATA_ROOT } from './paths.mjs';

// 数据目录：配额配置与崩溃日志都写这里（旧布局下就是包根，本机行为不变）
export const ROOT = DATA_ROOT;
const PACE = path.join(ROOT, 'config', 'pacing.json');
const CRASH = path.join(ROOT, 'logs', 'inbound-tick.log');

function logLine(o) {
  try {
    fs.mkdirSync(path.dirname(CRASH), { recursive: true });
    fs.appendFileSync(CRASH, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
  } catch { /* 日志失败不影响主流程 */ }
}

function readInboundCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(PACE, 'utf8'));
    return { ack: false, maxReadPerTick: 5, ...(j.inbound || {}) };
  } catch {
    return { ack: false, maxReadPerTick: 5 };
  }
}

/**
 * 权限档位（v23）：存在 config/pacing.json 顶层 `permissions`，由面板「入站与投递」页设置。
 *   dm_push / at_push : auto 自动入队 | ask 留在待审等人点允许 | block 直接丢弃
 *   stranger          : block 直接丢弃（默认） | ask 进待审 | auto 当普通来源处理
 *   allowedStrangers / blockedStrangers：面板「待审」里点允许/丢弃时写入的 uid 名单
 * 缺键/写坏一律回落默认值——权限读不到时宁可"别多做事"。
 */
const PERM_LOG = ['auto', 'ask', 'block'];
const PERM_STRANGER = ['block', 'ask', 'auto'];

export function readPermissions() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(PACE, 'utf8')) || {}; } catch { /* 配置缺失用默认 */ }
  const p = j.permissions || {};
  const pick = (v, d, ok) => (ok.includes(v) ? v : d);
  const uids = (a) => (Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []);
  return {
    dm_push: pick(p.dm_push, 'auto', PERM_LOG),
    at_push: pick(p.at_push, 'auto', PERM_LOG),
    stranger: pick(p.stranger, 'block', PERM_STRANGER),
    allowedStrangers: uids(p.allowedStrangers),
    blockedStrangers: uids(p.blockedStrangers),
  };
}

const BV_RE = /BV[0-9A-Za-z]{10}/;

function bvidOf(...vals) {
  for (const v of vals) {
    if (!v) continue;
    const m = String(v).match(BV_RE);
    if (m) return m[0];
  }
  return '';
}

/** aid → bvid（@ 收件箱只给 oid/aid） */
async function aidToBvid(aid) {
  try {
    const r = await bili.api('/x/web-interface/view', { aid });
    return (r && r.data && r.data.bvid) || '';
  } catch {
    return '';
  }
}

/** 把一条私信消息变成事件（只处理文本与分享卡片） */
function dmToEvent(m) {
  if (m.withdrawn || m.fromMe) return null;
  if (m.card) {
    const bv = bvidOf(m.card.bvid, m.card.title);
    if (bv) return { kind: 'dm_card', title: m.card.title || '', bvid: bv };
    return null;
  }
  if (m.type === 1 && m.text) {
    const bv = bvidOf(m.text);
    if (bv) return { kind: 'dm_text', title: '', bvid: bv };
  }
  return null;
}

/** uid → 推送账号昵称（只用于展示，不参与判定） */
function nameOf(uid) {
  const a = inbound.pushAccounts().find((x) => Number(x.uid) === Number(uid));
  return (a && a.name) || '';
}

export async function tick({ dry = false } = {}) {
  const t0 = Date.now();
  const out = { at: new Date().toISOString(), dry, stages: [], found: [], strangers: 0, dup: 0, risk: null };

  if (bili.riskState().cooling) {
    out.skipped = 'risk-cooling';
    out.risk = bili.riskState();
    return out;
  }

  const cfg = readInboundCfg();
  const opUid = inbound.operatorUid();

  // 权限闸门（v23）：每拍读一次，面板改完下一拍生效
  const perms = readPermissions();
  out.perms = { dm_push: perms.dm_push, at_push: perms.at_push, stranger: perms.stranger };
  const allowStr = new Set(perms.allowedStrangers);
  const blockStr = new Set(perms.blockedStrangers);
  // 陌生人能否按普通来源处理（会读正文取 bvid）：只有「自动」档或显式白名单
  const strangerReadable = (uid) => allowStr.has(Number(uid)) || (perms.stranger === 'auto' && !blockStr.has(Number(uid)));

  // ── 第 1 步：轻探测（只问「谁在」，不碰正文）──────────────
  let sess = [];
  try {
    sess = await bili.sessions();
    out.stages.push({ stage: 'sessions', n: sess.length, ms: Date.now() - t0 });
  } catch (e) {
    out.stages.push({ stage: 'sessions', error: String(e.message || e) });
    logLine({ action: 'tick', step: 'sessions', error: String(e.message || e) });
    return out;
  }

  // 有未读的会话分成「可能是主人」与「陌生人」两类
  const unreadSess = sess.filter((s) => s.unread > 0 && !dry);
  for (const s of unreadSess) {
    if (s.uid === opUid) continue;
    const id = await inbound.identify(s.uid);
    if (!id.ok) {
      if (s.uid >= 1e14) continue; // 系统账号（登录通知等）不参与统计
      // 陌生人：只记「有 N 条未读」，不读正文、不落标题
      inbound.noteStranger({ uid: s.uid, unread: s.unread, ts: s.ts });
      out.strangers += 1;
      // 丢弃 = 不读正文、不分析、不回复、不进任何列表（只保留计数）；仅在「问我」档才在面板待审里出现
      const mode = blockStr.has(Number(s.uid)) ? 'blocked' : (strangerReadable(s.uid) ? 'auto' : perms.stranger);
      logLine({ action: 'stranger', uid: s.uid, unread: s.unread, mode });
    }
  }

  // ── 第 2 步：对通过核实的会话，按游标取私信 ─────────────
  const verified = [];
  for (const s of sess) {
    if (s.uid === opUid) continue;
    /* v32：只在「未读数变了」或「还没落过游标」时才拉私信正文。
       以前每拍对「所有会话」都调 dmHistory：一拍 3–5 个请求、20 秒一拍，很容易吃 -509 风控，
       而一旦被风控，整条入站守候要盲 5 分钟（用户发视频后两分钟没反应就是这么来的）。
       只比 dm_seqno 不够——未读数在面板这边没人读，它会一直停在 >0，于是每拍都拉。 */
    const unreadKey = 'dm_unread:' + s.uid;
    const tsKey = 'dm_lastts:' + s.uid;
    const lastUnread = inbound.getCursor(unreadKey);
    const lastTs = inbound.getCursor(tsKey);
    const hasCursor = !!inbound.getCursor('dm_seqno:' + s.uid);
    const sameUnread = lastUnread !== '' && lastUnread !== null && Number(lastUnread) === Number(s.unread);
    /* v57 修：未读数相等不代表没有新消息 —— 我方发过私信/在别处读过会话时，B 站的 unread 会停在 1，
       正好和上一拍存下的游标撞值，于是新消息永远等不到下一次拉取（用户实测「对方发来视频 4 分钟没反应」，
       实际是 5 分钟一次的插件轮询才捞到）。现在再加一个「会话最后一条消息时间 ts」游标：
       未读数变了，或 ts 变了，就拉；两者都没变才跳过。 */
    const tsKnown = Number(s.ts) > 0;
    const sameTs = tsKnown && lastTs !== '' && lastTs !== null && Number(lastTs) === Number(s.ts);
    if (hasCursor && sameUnread && (!tsKnown || sameTs)) continue;
    /* v57：未读游标改到「拉取成功之后」再推进（见下面 dm_history 那里）。以前在拉取前就写，
       遇到拉取失败/预算耗尽会把这个会话永久标成「已看过」，之后再也不读了。 */
    const id = await inbound.identify(s.uid);
    if (id.ok) verified.push({ ...s, id });
    else if (strangerReadable(s.uid) && !(s.uid >= 1e14)) {
      // 陌生人白名单 / 「自动」档：按普通来源处理（身份先于内容的例外，用户显式开启才走到这里）
      verified.push({ ...s, id: { ok: true, level: 'stranger-allowed', reason: '白名单或陌生人自动档' } });
    }
  }
  out.stages.push({ stage: 'identify', verified: verified.length });
  out.verified = verified.map((v) => ({ uid: v.uid, unread: v.unread, level: (v.id && v.id.level) || 'stranger' }));

  let budget = Number(cfg.maxReadPerTick) || 5;
  for (const v of verified) {
    if (budget <= 0) break;
    const ck = `dm_seqno:${v.uid}`;
    const begin = inbound.getCursor(ck);
    let hist;
    try {
      hist = await bili.dmHistory(v.uid, { beginSeqno: begin, size: 30 });
      budget -= 1;
    } catch (e) {
      out.stages.push({ stage: 'dm', uid: v.uid, error: String(e.message || e) });
      continue;
    }
    if (!dry) {
      inbound.setCursor(`dm_unread:${v.uid}`, String(v.unread || 0));
      if (Number(v.ts) > 0) inbound.setCursor(`dm_lastts:${v.uid}`, String(v.ts));
    }
    /* v57：首跑不再「记完 baseline 就丢」——新绑定账号在第一次 tick 之前发来的视频会被静默吞掉
       （用户加完人、对方马上发视频，正好撞上首跑）。现在按 addedAt（回退 1 小时）取 recent 当新消息处理；
       窗口之前的历史仍然不回放（whale 的 baseline 语义）。 */
    const isFirst = !begin;
    let fresh;
    if (isFirst) {
      const acct = (inbound.pushAccounts() || []).find((x) => Number(x.uid) === Number(v.uid));
      const added = acct && acct.addedAt ? Date.parse(acct.addedAt) : NaN;
      const floor = Number.isFinite(added) ? added - 3600 * 1000 : Date.now() - 24 * 3600 * 1000;
      const recent = hist.messages.filter((m) => Number(m.ts || 0) >= floor);
      logLine({ action: 'dm-first', uid: v.uid, nextSeqno: hist.nextSeqno, recent: recent.length });
      out.stages.push({ stage: 'dm-first', uid: v.uid, n: recent.length });
      fresh = recent.filter((m) => !m.fromMe && !m.withdrawn && (m.type === 1 || m.type === 7 || m.type === 8));
      if (!fresh.length) { inbound.setCursor(ck, hist.nextSeqno || ''); continue; }
    } else {
      // 四条件：文本/卡片、非撤回、非我方、游标之后
      fresh = hist.messages.filter((m) => !m.fromMe && !m.withdrawn && (m.type === 1 || m.type === 7 || m.type === 8));
    }
    let lastSeq = begin;
    for (const m of fresh) {
      const ev = dmToEvent(m);
      if (!ev) continue;
      if (!dry) {
        const r = inbound.addEvent({ kind: ev.kind, source: 'dm', uid: v.uid, uname: nameOf(v.uid), msg_key: m.key, bvid: ev.bvid, title: ev.title });
        if (r.ok) out.found.push({ ...ev, uid: v.uid, receipt: r.receipt });
        else out.dup += 1;
      } else {
        out.found.push({ ...ev, uid: v.uid, dry: true });
      }
      if (m.seqno && Number(m.seqno) > Number(lastSeq || 0)) lastSeq = m.seqno;
    }
    if (!dry) {
      if (isFirst) inbound.setCursor(ck, hist.nextSeqno || String(lastSeq || ''));
      else if (lastSeq) inbound.setCursor(ck, String(lastSeq));
    }
  }

  // ── 第 3 步：@ 收件箱 ───────────────────────────────────
  try {
    const ck = 'at_cursor';
    const begin = inbound.getCursor(ck);
    const lastId = inbound.getCursor('at_last_id');
    const feed = await bili.msgfeedAt({ cursor: begin });
    const items = feed.items || [];
    if (!begin) {
      if (feed.cursor) inbound.setCursor(ck, feed.cursor);
      out.stages.push({ stage: 'at-baseline', n: items.length });
    } else {
      const seenIds = new Set();
      for (const it of items) {
        if (seenIds.has(it.id)) continue;
        seenIds.add(it.id);
        try {
          if (lastId && BigInt(it.id) <= BigInt(lastId)) continue; // 已经处理过这一批
        } catch { /* id 不是数字就照常处理 */ }
        if (!it.mid) continue;
        const id = await inbound.identify(it.mid);
        if (!id.ok) {
          inbound.noteStranger({ uid: it.mid, uname: it.who, unread: 1, ts: it.ts });
          if (!strangerReadable(it.mid)) continue; // 丢弃档：陌生人 @ 也不读
        }
        // @ 的 oid 是 aid；uri 里通常带 BV 号，优先用它
        let bv = bvidOf(it.uri, it.source, it.title);
        if (!bv && it.oid) bv = await aidToBvid(it.oid);
        if (!bv) continue;
        if (dry) { out.found.push({ kind: 'at', bvid: bv, uid: it.mid, title: it.title, dry: true }); continue; }
        const r = inbound.addEvent({ kind: 'at', source: 'at', uid: it.mid, uname: it.who, msg_key: 'at:' + it.id, bvid: bv, title: it.title });
        if (r.ok) out.found.push({ kind: 'at', bvid: bv, uid: it.mid, title: it.title, receipt: r.receipt });
        else out.dup += 1;
      }
      if (feed.cursor && feed.cursor !== begin && (feed.isEnd || items.length)) inbound.setCursor(ck, feed.cursor);
      if (items.length) {
        try {
          const maxId = items.map(x => BigInt(x.id)).reduce((a, b) => (a > b ? a : b));
          inbound.setCursor('at_last_id', String(maxId));
        } catch { /* 忽略 */ }
      }
    }
  } catch (e) {
    out.stages.push({ stage: 'at', error: String(e.message || e) });
  }

  // ── 入队（prio=1，走「用户点播」通道：跳过门禁与夜间围栏）────
  // v23 起先过权限闸门：auto 入队 / ask 留在待审等人点「允许」 / block 丢掉并留档
  const permFor = (kind) => (kind === 'at' ? perms.at_push : perms.dm_push);
  for (const f of out.found) {
    try {
      if (f.dry) { // 干跑：只报会怎么处理，不写库
        out.dryPlan = out.dryPlan || [];
        out.dryPlan.push({ bvid: f.bvid, kind: f.kind, perm: permFor(f.kind) });
        continue;
      }
      const known = lib.get(f.bvid);
      const title = f.title || (known && known.title) || '';
      // 已经分析过的视频不重跑（历史 @/私信 不回放），只把 receipt 标 done 留档
      if (known && known.status === 'seen') {
        if (f.receipt) inbound.setStatus(f.receipt, 'done', 'already-analyzed');
        out.skippedSeen = (out.skippedSeen || 0) + 1;
        logLine({ action: 'skip-seen', bvid: f.bvid, receipt: f.receipt || null });
        continue;
      }
      // 已在队列/正在跑：不重复入队，事件推进到 processing（避免在「待审」里挂着一条其实已在跑的事）
      if (known && (known.status === 'queued' || known.status === 'running')) {
        if (f.receipt) inbound.setStatus(f.receipt, 'processing', 'already-queued');
        out.alreadyQueued = (out.alreadyQueued || 0) + 1;
        logLine({ action: 'already-queued', bvid: f.bvid, status: known.status });
        continue;
      }
      const perm = permFor(f.kind);
      if (perm === 'block') {
        if (f.receipt) inbound.setStatus(f.receipt, 'ignored', 'perm-block');
        out.blocked = (out.blocked || 0) + 1;
        logLine({ action: 'perm-block', bvid: f.bvid, receipt: f.receipt || null, kind: f.kind });
        continue;
      }
      if (perm === 'ask') {
        // 事件保持 pending：面板「待审」里出现，等人点「允许」才入队
        out.ask = (out.ask || 0) + 1;
        logLine({ action: 'perm-ask', bvid: f.bvid, receipt: f.receipt || null, kind: f.kind });
        continue;
      }
      lib.mark({
        bvid: f.bvid, status: 'queued', score: null, via: 'inbound', depth: 'T3',
        title, up: '', prio: 1, note: f.receipt ? `inbound:${f.receipt}` : 'inbound',
      });
      if (f.receipt) inbound.setStatus(f.receipt, 'processing', 'enqueued');
      out.enqueued = (out.enqueued || 0) + 1;
      logLine({ action: 'enqueue', bvid: f.bvid, receipt: f.receipt || null, source: f.kind });
    } catch (e) {
      out.stages.push({ stage: 'enqueue', bvid: f.bvid, error: String(e.message || e) });
    }
  }

  // ── 收尾：把「已经在跑/已跑完」的事件标 done（pending 是等人拍板的，不动）──
  try {
    for (const ev of inbound.list('processing', 200)) {
      if (!ev.bvid) continue;
      const row = lib.get(ev.bvid);
      if (row && row.status === 'seen') inbound.setStatus(ev.receipt, 'done', 'analyzed');
      else if (row && row.status === 'failed') inbound.setStatus(ev.receipt, 'failed', 'analysis-failed');
    }
  } catch { /* 忽略 */ }

  out.ms = Date.now() - t0;
  out.risk = bili.riskState();
  logLine({ action: 'tick', ms: out.ms, found: out.found.length, dup: out.dup, strangers: out.strangers });
  return out;
}

// CLI：node scripts/lib/inbound-tick.mjs [--dry]
const _self = (() => {
  try { return new URL(import.meta.url).href; } catch { return ''; }
})();
const _argv = (() => {
  try { return new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href; } catch { return ''; }
})();
if (_self && _argv && _self === _argv) {
  const dry = process.argv.includes('--dry');
  tick({ dry })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('TICK_FAIL', (e && e.stack) || e); process.exit(1); });
}
