import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as lib from './lib/library.mjs';
import * as inbound from './lib/inbound.mjs';
import { spawn, execFileSync } from 'node:child_process';
/* ── v26：缓存/存储、人设语气、文案模板、投递文案（Lead 提供的只读真源，勿在本文件重复实现）──
   注意 readPersona：本文件下面已有同名本地函数（读 config/persona.json 原文，缺失即抛错，
   /api/persona 的旧契约靠它），所以人设渲染版改名为 readPersonaLib，避免重复声明。 */
import { cacheStateOf, purgeEverything, readStorage, sweep as cacheSweep, usage as cacheUsage, trashBv, restoreBv, sweepTrash } from './lib/cache.mjs?v=54';
import { readPersona as readPersonaLib, personaText, personaSummary, personaKey, personaGenKey, personaPromptBlock, formatInfo, enforceParticles, particleWhitelist, readShape, structureKeys } from './lib/persona-text.mjs?v=56';
import { templateInfo, summaryRulesText, whyRulesText } from './lib/templates.mjs?v=54';
import { buildComment, buildDm, commentCore, COMMENT_CORE_MAX, stripLeakSentences, scrubAnalysisLeak, replaceAnalysisLeak } from './lib/copy.mjs?v=59';
/* v30：人设「实时样例」——真跑本地模型，用与正式生成同一套 prompt 现写一条 */
import { generateSample, pickRecentDelivered, sampleMaterial, buildSamplePrompt, buildSampleParts } from './lib/sample.mjs?v=58';
/* v55：私信结构化 JSON 契约 —— 预览「按字段生成 → buildDm 渲染」，与正式投递同一条版式 */
import { parseDmJson } from './lib/dm-json.mjs?v=5';
/* A3-02 / 契约 6：同步读 B 站风控状态（inbound.mjs 已静态 import bili.mjs，这里拿到的是同一个模块实例） */
import * as biliLib from './lib/bili.mjs';
/* v47：可跑时间段 —— 纯函数（迁移/归一化/判定/摘要），panel_server 与 runner 共用同一套语义 */
import { normalizeRunWindow, windowAllows, describeRunWindow, apiTroughInfo } from './lib/runwindow.mjs?v=54';
/* v52：私信发送 + 回执（ack）—— sender 与面板共用同一实现；readInboundAck 让「收到后先回一句」这个开关真生效 */
import { sendDmText, readInboundAck, writeAckLog } from './lib/dm.mjs?v=54';
/* v52：人设 emoji 取字器（A 段在 persona-text 新增 personaEmojiChar）用命名空间导入 —— A 段未落地时回执自动省略 emoji，不炸面板 */
import * as personaTextExt from './lib/persona-text.mjs?v=56';

/* 路径不写死，而且**代码根与数据根分开**（唯一真源：scripts/lib/paths.mjs）：
     DATA = 数据根（台账/产物/缓存/配置/凭证，可写；$VD_DATA 或 $DSH_HOME/video-digest/，老布局自动兜底）
     CODE = 代码根（本文件所在的包：scripts/、panel/、vendor/，只读、随包升级）
     ROOT = 面板静态文件目录（<CODE>/panel）
   这样别人把包装到 node_modules / 插件目录（只读）也能跑，数据写到自己的目录里。 */
import { DATA_ROOT as DATA, CODE_ROOT as CODE, DSH_HOME, DATA_SOURCE, dataInfo, ensureData } from './lib/paths.mjs';
import { normalizeRoute, zhOf, routeTable, spendsMoney, isVodVia, VOD_PASS } from './lib/routes.mjs';
ensureData();  // 首次运行：自建 out/logs/cache/config/secrets/runtime 并从包里播种缺失配置（幂等）
const ROOT = path.join(CODE, 'panel');
const port = Number(process.argv[2] || 8791) || 8791;
/* 面板版本号：唯一真源。meta / health / 版本变更自动快照都用它（bump 时只改这一行）。 */
const PANEL_VERSION = 'v0.2.0';

/* ── 路由总表（最终版 v42）──────────────────────────────────────────────────
   一张表看清全部入口：没有重复路径、没有实验期死端点（/api/gui-port、/api/status、
   /api/pending-summary、/api/library、/api/gate/backfill、/api/inbound/mark、
   /api/inbox/last、/api/events 已按契约删除，别再恢复）。方法不写 = 任意方法。
   [页面] GET /               面板单页（11 页）；GET /sheet/<BV>.png 真实宫格图；GET /go 跳到运行中的 DSH GUI
   [概览] GET /api/overview   概览数字；GET /api/meta 版本/目录/配置/门禁表/缓存策略
   [账本] GET /api/runs       账本（分页/排序）；GET /api/run?bv= 单条详情；GET /api/queue/history 最近出队
   [队列] GET /api/queue      队列/候选/风控/执行器；POST /api/enqueue 入队；POST /api/queue/promote 升格；
          POST /api/queue/delete 删除（产物先移 out/.trash）；POST /api/queue/restore 撤销/移回；POST /api/queue/clear 清候选；
          POST /api/queue/retry 异常行重试（failed→排队、失败计数清零）；GET /api/picks 最近一次选片的候选（只读 out/pick，偏好页用）
   [执行] POST /api/runner/start 起 runner；GET /api/runner 执行器状态；POST /api/watch/beat 写者心跳
   [归档] GET /api/archive    归档分页；GET /api/archive/neighbors 邻近条；POST /api/archive/delete 批量删（同样走 .trash）
   [投递] POST /api/deliver   手动投递（mode=dry|send，缺省 dry）；GET /api/deliver/state 投递队列；
          GET /api/push 推送账号；POST /api/push 保存账号；GET /api/account B 站登录态（60s 缓存）
   [总结] GET /api/summary/queue 待写队列；POST /api/summary/write 写云端总结（body.deliver=false 只落盘不投）
   [入站] GET /api/inbound    入站状态；GET /api/inbound/pending 待审；POST /api/inbound/decide 拍板；
          GET /api/inbound/history 历史；GET /api/inbox/tick 跑一次巡检；GET /api/inbox/poll 插件长轮询读取；
          GET /api/inbox 私信/@ 列表；GET /api/mutual 互关列表；GET|POST /api/permissions 权限矩阵
   [人设] GET /api/persona    读人设；POST /api/persona 保存；POST /api/persona/preview 真跑一条样例
   [配置] GET|POST /api/pacing 节奏；GET|POST /api/gate 门禁阈值；GET|POST /api/summarize 总结来源；
          POST /api/summarize/test 测试；GET|POST /api/pricing 计价；GET|POST /api/budget 预算；
          GET|POST /api/prefs 偏好；GET /api/prefs/suggest 分区/标签建议；POST /api/prefs/try 试搜（本地/联网）；
          POST /api/export 导出配置；GET /api/templates 模板列表；GET|POST /api/template 读写模板
   [缓存] GET|POST /api/storage 存储策略；POST /api/cache/clear 清某类缓存；POST /api/cache/sweep 按策略清理
   [成本] GET /api/cost       成本；GET /api/usage DSH 扣款；GET /api/spend 本站花费账
   [工具] GET /api/health     健康；GET /api/plugin-report 客户端自检信标（GET 信标）；POST /api/why/rebuild 重跑判否说明；
          /api/open 用默认浏览器开面板；POST /api/open-folder 打开某 BV 产物目录（只允许 out/<bv>）
   加新路由前先看这张表：同一能力不要开第二个入口。 */

/* ── v24：版本变更自动快照钩子（fire-and-forget，绝不影响面板启动）─────────────
   scripts/lib/git-snapshot.mjs 由 git-mgr 提供，导出 snapshotIfVersionChanged(version)：
   发现「当前版本号 ≠ 上次快照的版本号」时在后台打一次快照。
   这里刻意**不用 top-level await**（契约骨架里是 await，但本文件在 inproc 模式下会被宿主
   每次请求按 mtime 重新 import，TLA 会把每次冷加载都拖住一拍）；改成 import().then() 的
   fire-and-forget，语义仍是「异步、失败只写日志」。失败写 config-audit.log 一行 + console.error。 */
try {
  const _snapFile = path.join(CODE, 'scripts', 'lib', 'git-snapshot.mjs');
  import(pathToFileURL(_snapFile).href + '?v=' + Date.now())
    .then(m => { if (m && typeof m.snapshotIfVersionChanged === 'function') return m.snapshotIfVersionChanged(PANEL_VERSION); })
    .catch(e => {
      const msg = String((e && e.message) || e).slice(0, 300);
      try {
        fs.appendFileSync(path.join(DATA, 'logs/config-audit.log'),
          JSON.stringify({ at: new Date().toISOString(), tag: 'git-snapshot', error: msg }) + '\n');
      } catch (e2) {}
      console.error('[panel] v24 自动快照钩子失败（忽略）：' + msg);
    });
} catch (e) {
  try { console.error('[panel] v24 自动快照钩子初始化失败（忽略）：' + String((e && e.message) || e)); } catch (e2) {}
}

/* ── inbound-tick 按 mtime 动态加载（v23）────────────────────────────────────
   inproc 模式下宿主只给本文件加 ?v=mtime 重新 import（scripts/lib/inproc-api.mjs 的
   getHandler），静态 import 的 ./lib/* 一律命中 ESM 缓存 —— 改 lib/inbound-tick.mjs
   就得重启 DSH 才生效。入站权限档位（permissions）就在那个文件里，而用户改完档位
   应该「刷新面板即生效」，所以这里手动按 mtime 加 ?v= 重新 import。
   代价：每拍一次 statSync（毫秒级），只有 mtime 变了才真的重新 import。 */
const _TICK_FILE = path.join(CODE, 'scripts', 'lib', 'inbound-tick.mjs');
let _tickMod = null;
let _tickVer = 0;
async function inboundTick(opts = {}) {
  const ver = fs.statSync(_TICK_FILE).mtimeMs;
  if (!_tickMod || ver !== _tickVer) {
    _tickMod = await import(pathToFileURL(_TICK_FILE).href + '?v=' + ver);
    _tickVer = ver;
  }
  return _tickMod.tick(opts);
}

/* ── 找"真正的 node" ────────────────────────────────────────────────────────
   本文件现在有两种运行方式：①独立进程（node panel_server.mjs 8791）；
   ②被插件 import 进 DSH 宿主进程（Electron）。宿主里 process.execPath 是
   "DeepSeek Harness.exe"，拿它跑 .mjs 会把 GUI 再拉起来（whale 踩过同一个坑，
   见 docs/HANDOFF 第六节）。手动起的 node 保底可用。 */
const NODE_EXE = (() => {
  const home = String(process.env.DSH_HOME || '').replace(/\\/g, '/') ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh').replace(/\\/g, '/');
  const cands = [
    process.env.DSH_NODE,
    home && `${home}/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`,
    home && `${home}/dsh-runtimes/dsh-primary-runtime/dependencies/node/node.exe`,
    'C:/Users/pc/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch (e) {} }
  if (/node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  return 'node';
})();
const CHILD_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '' };  // 子进程绝不能再当 Electron 用

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8' };

/* ── 计价（与 docs 一致：输入未命中 1 元/M、缓存命中 0.02 元/M、输出 4 元/M；高峰 ×2）── */
const PRICE = { inMiss: 1, inHit: 0.02, out: 4, prefixTok: 2500, outTok: 500 };
const OUT_TOK_EST = 500;     // 每次总结的预估输出 token
const PREFIX_TOK_EST = 2500;  // 固定前缀（吃缓存价）

function isPeakAt(d, p) {
  const dt = new Date(d);
  const hh = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  const dayOk = (p.peakDays || [1,2,3,4,5]).includes(dt.getDay());
  const hourOk = (p.peakHours || [['09:00','12:00'],['14:00','18:00']]).some(([a, b]) => hh >= a && hh < b);
  return dayOk && hourOk;
}

/* 单条成本：total_tokens 视为输入，另加固定前缀与输出；高峰 ×peakMultiplier */
function costYuan(tokens, peak = false, p = null) {
  const pr = p || readPricing();
  const k = peak ? (pr.peakMultiplier || 2) : 1;
  return ((tokens || 0) * (pr.inMiss || 1) + PREFIX_TOK_EST * (pr.inHit || 0.02) + OUT_TOK_EST * (pr.out || 4)) / 1e6 * k;
}

/* ── 本地时区（Asia/Shanghai）──
   面板所有"日期/几点"都走这里。此前用 toISOString().slice 是 UTC，显示差 8 小时、
   "今天"边界错（本地 00:00–08:00 的跑被算进前一天）、预算跨日不清零。
   getFullYear/getMonth/getDate 本来就是本地时区，不需要手动加偏移。 */
const pad2 = n => String(n).padStart(2, '0');
function localDay(v) {
  const d = v instanceof Date ? v : new Date(v || Date.now());
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localHM(v) {
  const d = v instanceof Date ? v : new Date(v || Date.now());
  if (isNaN(d)) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function localMonth(v) {
  const s = localDay(v);
  return s ? s.slice(0, 7) : '';
}
/* 今天往前第 n 天（本地口径） */
function dayAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDay(d);
}

async function bili_risk_async() {
  try { const m = await import('./lib/bili.mjs'); return m.riskState(); } catch (e) { return { cooling: false, error: String(e.message || e) }; }
}
// 同步版本：路由与 dispatchTick 里用（biliLib 是静态 import，riskState() 同进程同实例，真实有效）
// A3-04 / 契约 6：risk 恒为四字段，首拍就不会只剩 {cooling:false}
let _riskCache = { cooling: false, until: null, streak: 0, last: null };
function bili_risk() {
  try {
    const s = biliLib.riskState();
    _riskCache = { cooling: !!s.cooling, until: s.until || null, streak: Number(s.streak) || 0, last: s.last || null };
  } catch (e) { /* 读不到就沿用上一次的值 */ }
  return _riskCache;
}
function refreshRisk() { bili_risk_async().then(r => { _riskCache = { cooling: !!r.cooling, until: r.until || null, streak: Number(r.streak) || 0, last: r.last || null }; }).catch(() => {}); }

/* ── B2：GET /api/account —— 探一次 B 站登录态（60 秒缓存，?force=1 绕过）──
   cookie 缺失 / 失效 / 风控一律返回结构体，不抛 500：账号卡读不出来不能带崩整页。
   nav 只给 mid/uname/level/vip；关注数与粉丝数来自 relation/stat（顺带一枪，失败就留 null）。 */
let _accountCache = { at: 0, data: null };
async function accountInfo(force) {
  const now = Date.now();
  if (!force && _accountCache.data && now - _accountCache.at < 60000) {
    return { ..._accountCache.data, cached: true, cacheAgeSec: Math.round((now - _accountCache.at) / 1000) };
  }
  const at = new Date().toISOString();
  const base = { ok: false, loggedIn: false, uid: null, uname: null, level: null, vip: { status: 0, label: '非大会员' }, following: null, fans: null, at };
  let nav = null;
  try { nav = await biliLib.api('/x/web-interface/nav'); }
  catch (err) {
    const msg = String((err && err.message) || err);
    const human = /风控|冷却/.test(msg)
      ? ('B 站风控冷却中，稍后再试：' + msg.slice(0, 120))
      : (/ENOENT|no such file|Cannot read/i.test(msg) ? '没有 secrets/bili.json（还没导出 B 站 cookie）' : ('读 B 站登录态失败：' + msg.slice(0, 120)));
    const out = { ...base, error: human };
    _accountCache = { at: now, data: out };
    return { ...out, cached: false, cacheAgeSec: 0 };
  }
  const d = (nav && nav.data) || {};
  if (Number(nav && nav.code) !== 0 || !d.isLogin) {
    const human = Number(nav && nav.code) === -101
      ? 'B 站 cookie 已失效（未登录），请重新导出 secrets/bili.json'
      : ('B 站返回 ' + String((nav && nav.code) != null ? nav.code : '未知') + ' ' + String((nav && nav.message) || '').slice(0, 100)).trim();
    const out = { ...base, error: human };
    _accountCache = { at: now, data: out };
    return { ...out, cached: false, cacheAgeSec: 0 };
  }
  const vs = Number(d.vipStatus) || 0;
  const vt = Number(d.vipType) || 0;
  const vipLabel = vs === 1 ? (vt === 2 ? '大会员（年度）' : vt === 1 ? '大会员（月度）' : '大会员') : '非大会员';
  let following = null, fans = null;
  try {
    const rel = await biliLib.api('/x/relation/stat', { vmid: d.mid });
    if (rel && Number(rel.code) === 0 && rel.data) {
      following = Number(rel.data.following);
      fans = Number(rel.data.follower);
    }
  } catch (e) { /* 关注/粉丝数拿不到不影响登录态本身 */ }
  const out = {
    ok: true, loggedIn: true,
    uid: Number(d.mid) || null,
    uname: String(d.uname || ''),
    level: Number((d.level_info && d.level_info.current_level) != null ? d.level_info.current_level : d.level) || 0,
    vip: { status: vs, label: vipLabel },
    following, fans, at,
  };
  _accountCache = { at: now, data: out };
  return { ...out, cached: false, cacheAgeSec: 0 };
}

function openDb(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return null;
  return new DatabaseSync(p, { readOnly: true });
}

function runs(limit = 500) {
  const db = openDb('logs/ledger.db');
  if (!db) return [];
  try {
    return db.prepare(`select * from runs order by id desc limit ?`).all(limit);
  } finally { db.close(); }
}

function enrich(r) {
  const p = readPricing();
  const yuan = costYuan(r.total_tokens || 0, isPeakAt(r.at, p), p);
  let spend = 0;
  try { spend = Number(spendByBv()[r.bvid] || 0); } catch (e) { spend = 0; }
  return {
    ...r,
    at_short: localHM(r.at),
    day: localDay(r.at),
    mm: Number(r.minutes || 0),
    yuan: Number(yuan.toFixed(6)),
    fen: Number((yuan * 100).toFixed(3)),
    peak: isPeakAt(r.at, p),
    img_tok: r.images || 0,
    text_tok: r.text_tokens || 0,
    /* v36：这条视频在本插件里真实花掉的钱（来源：logs/llm-cost.jsonl，按 bvid 汇总；没有记录=0） */
    spend: Number(spend.toFixed(6)),
    spend_fen: Number((spend * 100).toFixed(3)),
  };
}

function overview() {
  const all = runs(2000).map(enrich);
  const today = localDay(new Date());
  const t = all.filter(r => r.day === today);
  const sum = a => a.reduce((n, r) => n + (r.total_tokens || 0), 0);
  const sumY = a => a.reduce((n, r) => n + r.yuan, 0);
  const sumM = a => a.reduce((n, r) => n + r.mm, 0);

  // 近 7 天（本地口径）
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = dayAgo(i);
    const rs = all.filter(r => r.day === d);
    days.push({ day: d.slice(5), label: i === 0 ? '今天' : d.slice(5), runs: rs.length, tokens: sum(rs), yuan: Number(sumY(rs).toFixed(6)) });
  }
  // 成本构成（最近 6 条）
  const last6 = all.slice(0, 6);
  const comp = last6.length ? {
    text: Math.round(last6.reduce((n, r) => n + r.text_tok, 0) / last6.length),
    img: Math.round(last6.reduce((n, r) => n + r.img_tok, 0) / last6.length),
    total: Math.round(last6.reduce((n, r) => n + (r.total_tokens || 0), 0) / last6.length),
    n: last6.length,
  } : null;

  const month = all.filter(r => (r.day || '').slice(0, 7) === today.slice(0, 7));  return {
    today: { runs: t.length, tokens: sum(t), yuan: Number(sumY(t).toFixed(6)), perMin: sumM(t) ? Math.round(sum(t) / sumM(t)) : 0 },
    month: { runs: month.length, yuan: Number(sumY(month).toFixed(6)) },
    total: { runs: all.length, tokens: sum(all), yuan: Number(sumY(all).toFixed(6)) },
    days, comp, recent: all.slice(0, 5),
    price: { note: '谷时；高峰（工作日 9-12/14-18）×2', ...PRICE },
  };
}

function readGateFile(bv) {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(DATA, 'out', bv, 'gate.json'), 'utf8'));
    // 老数据（pass / gray-sampled / gray）只在读取时归一，不重写历史文件
    g.route = normalizeRoute(g.route);
    g.routeZh = zhOf(g.route);
    return g;
  } catch { return null; }
}
// 宫格图：优先 sheet.png，多张时取 sheet-1.png（长片会拆成 sheet-1..N）
function sheetFile(bv) {
  const dir = path.join(DATA, 'out', bv);
  const one = path.join(dir, 'sheet.png');
  if (fs.existsSync(one)) return one;
  try {
    const cands = fs.readdirSync(dir).filter(n => /^sheet(-\d+)?\.png$/.test(n)).sort();
    if (cands.length) return path.join(dir, cands[0]);
  } catch (e) {}
  return null;
}
function readFactcard(bv) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'out', bv, 'factcard.json'), 'utf8')); } catch { return null; }
}

function readSummary(bv) {
  const readOne = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'out', bv, f), 'utf8')); } catch { return null; } };
  /* v53：v53 之前写的旧总结里可能也带着取证腔与「我们要留意」的缺陷说明。
     面板只负责展示、不改历史文件，所以读出来先过一遍清洗，别让旧文案继续误导。 */
  const tidy = (sm) => {
    if (!sm || typeof sm !== 'object') return sm;
    try {
      const tidyPart = (t) => {
        const s = scrubAnalysisLeak(String(t == null ? '' : t));
        /* 「材料」在内容语境里可能是正常词（行情材料、装修材料），整句丢太狠；只把明显当管道说的那种换成「内容」 */
        return s.replace(/材料(?=(?:里|中|上)?(?:把|将|显示|只|还|也))/g, '内容').replace(/\s{2,}/g, ' ').trim();
      };
      if (typeof sm.gist === 'string') sm.gist = tidyPart(sm.gist);
      if (Array.isArray(sm.bullets)) sm.bullets = sm.bullets.map(tidyPart).filter(Boolean);
      if (typeof sm.caveat === 'string') sm.caveat = stripLeakSentences(sm.caveat, { aggressive: true }).slice(0, 200);
    } catch (e) { /* 清洗失败就原样返回，不能因为文案问题让详情页打不开 */ }
    return sm;
  };
  const cloud = tidy(readOne('summary.cloud.json'));
  const local = tidy(readOne('summary.json'));
  /* B4-3/B4-6：前端要按 engine 标「直连 API / 会话模型 / 未记录」，老总结没有这个字段就如实给 null */
  if (cloud) { cloud.source = 'cloud'; cloud.local = local; if (cloud.engine === undefined) cloud.engine = null; return cloud; }
  if (local) { local.source = 'local'; if (local.engine === undefined) local.engine = null; return local; }
  return null;
}
/* ---------- v16：台账元信息（标题/UP/时长）+ 事件流 + 待写优先级 ---------- */
let RUN_META_CACHE = { at: 0, map: null };
function runMeta() {
  if (RUN_META_CACHE.map && Date.now() - RUN_META_CACHE.at < 30000) return RUN_META_CACHE.map;
  const map = new Map();
  try {
    for (const r of runs(3000)) {
      if (!r.bvid || map.has(r.bvid)) continue;
      map.set(r.bvid, { title: r.title || '', depth: r.depth || '', dur_sec: r.duration_sec || 0, minutes: r.minutes || 0, tokens: r.total_tokens || 0, at: r.at });
    }
  } catch (e) { /* ignore */ }
  RUN_META_CACHE = { at: Date.now(), map };
  return map;
}
const EVENTS_FILE = 'logs/events.jsonl';
function emitEvent(type, data) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...(data || {}) });
    fs.appendFileSync(path.join(DATA, EVENTS_FILE), line + '\n');
  } catch (e) { /* ignore */ }
}
/* 单条视频的总结四态：formal 正式版 / pending 待写 / worthless 不值得 / optional 灰区可选 / none 未评估
   门禁档位已改名（2026-11-02）：推荐看 pass-final / 可以看 pass-sampled / 一般般 local-hold / 没意思 skip。
   老数据里的 pass|gray-sampled|gray 通过 routes.mjs 的别名映射，读取时自动归一。 */
function sumStateOf(bv, gate, hasCloud, hasLocal) {
  const route = gate ? normalizeRoute(gate.route) : null;
  if (hasCloud) return { state: 'formal', why: '云端正式版' };
  if (route === 'pass-final' || route === 'pass-sampled') return { state: 'pending', why: route === 'pass-final' ? `门禁通过（${zhOf(route)}）` : `灰区抽样命中（${zhOf(route)}）` };
  if (route === 'skip') return { state: 'worthless', why: `门禁判不值得（${zhOf(route)}：密度/事实/争议都不够）` };
  if (route === 'local-hold') return { state: 'optional', why: `灰区未抽样（${zhOf(route)}），可选` };
  if (hasLocal) return { state: 'pending', why: '只有本地草稿' };
  return { state: 'none', why: '没跑过门禁（可补跑，0 token）' };
}
function autoWriteCap() {
  // 2026-10-31 用户拍板：写入改 1:1 —— 门禁放行（推荐看 pass-final / 可以看 pass-sampled）的每条都写。
  // 所以 cap 不再是「真看条数 × 0.6」的省钱折扣，只留一个很宽的兜底（默认 40 条/天）防死循环。
  const s = readSummarize();
  const safety = Number(s.dailyWriteMax || 0) > 0 ? Number(s.dailyWriteMax) : 40;
  return Math.max(1, safety);
}
function pendingSummaries() {
  const outDir = path.join(DATA, 'out');
  const dirs = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const meta = runMeta();
  const out = [];
  for (const bv of dirs) {
    if (!/^BV[0-9A-Za-z]{6,14}$/.test(bv)) continue;
    const dir = path.join(outDir, bv);
    if (!fs.existsSync(path.join(dir, 'manifest.txt'))) continue;
    const hasCloud = fs.existsSync(path.join(dir, 'summary.cloud.json'));
    if (hasCloud) continue;
    let gate = null; try { gate = JSON.parse(fs.readFileSync(path.join(dir, 'gate.json'), 'utf8')); } catch {}
    const route = gate ? normalizeRoute(gate.route) : null;
    if (route !== 'pass-final' && route !== 'pass-sampled') continue;
    let cost = null; try { cost = JSON.parse(fs.readFileSync(path.join(dir, 'cost.json'), 'utf8')); } catch {}
    const m = meta.get(bv) || {};
    const minutes = (cost && cost.minutes) || m.minutes || 0;
    const density = gate && typeof gate.infoDensity === 'number' ? gate.infoDensity : 0;
    const facts = gate ? gate.factCount : 0;
    const disputes = gate && gate.danmaku ? Number(gate.danmaku.disputes || 0) : 0;
    // 优先级：信息密度 × 时长权重（20 分钟封顶）× 门禁档位
    const durW = Math.min(minutes, 20) / 20;
    const routeW = route === 'pass-final' ? 1 : 0.8;
    const priority = Number(((density * 0.6 + (facts >= 3 ? 0.25 : 0) + (disputes >= 2 ? 0.15 : 0)) * (0.5 + durW) * routeW).toFixed(3));
    out.push({ bv, title: m.title || '', up: '', depth: m.depth || '', dur_sec: m.dur_sec || 0, minutes, tokens: (cost && cost.tokens && cost.tokens.total) || m.tokens || 0, route, routeZh: zhOf(route), density, facts, disputes, why: route === 'pass-final' ? `门禁通过（${zhOf(route)}）` : `灰区抽样（${zhOf(route)}）`, priority });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}
/* ---------- 入站轮询：每 5 分钟拉一次 @ 与私信卡片，命中已绑定推送账号就自动入队（0 token） ---------- */
const INBOX_POLL_MS = 5 * 60 * 1000;

function pushUidSet() {
  try {
    const pu = readPush();
    const set = new Set();
    for (const a of (pu.accounts || [])) if (a && a.enabled !== false && Number(a.uid)) set.add(Number(a.uid));
    return set;
  } catch { return new Set(); }
}

/* ---------- v52：入站回执（config/pacing.json 的 inbound.ack 以前是假开关，全仓无消费点） ----------
   用户发来视频后，插件 5 分钟定时（/api/inbox/poll）会入队并自动跑片，但「收到后先回一句」从没实现，
   用户等一分钟没反馈就以为功能死了。这里补上：ack=true 时对新入队的前 3 条发一条私信回执。
   - 去重 logs/ack.json（数组，保留最近 300 条 {bv,at}），同一 BV 24 小时内只回执一次
   - 回执失败不写去重表（下一拍还能重试），只记 out.ackError，绝不阻断入队与 autoRun
   - 每次尝试都写 logs/inbound-ack.log（B 站返回码原样落盘，成不成功都能查） */
const ACK_STORE = path.join(DATA, 'logs', 'ack.json');
const ACK_TTL_MS = 24 * 3600 * 1000;
const ACK_KEEP = 300;
const ACK_MAX_PER_TICK = 3;

function readAckStore() {
  try {
    const a = JSON.parse(fs.readFileSync(ACK_STORE, 'utf8'));
    return Array.isArray(a) ? a.filter(x => x && x.bv) : [];
  } catch (e) { return []; }
}
function writeAckStore(list) {
  const now = Date.now();
  const keep = list
    .filter(x => x && x.bv && Number.isFinite(Date.parse(x.at)) && now - Date.parse(x.at) < 7 * 24 * 3600 * 1000)
    .slice(-ACK_KEEP);
  try {
    fs.mkdirSync(path.dirname(ACK_STORE), { recursive: true });
    fs.writeFileSync(ACK_STORE, JSON.stringify(keep, null, 2) + '\n');
  } catch (e) {}
  return keep;
}
function ackRecently(bv, store, now) {
  return store.some(x => x && x.bv === bv && Number.isFinite(Date.parse(x.at)) && now - Date.parse(x.at) < ACK_TTL_MS);
}
/** 人设 emoji（A 段 personaEmojiChar：off/取不到返回空串 → 回执省略）。保留一个完整字符（可能是多码点）。 */
function ackEmoji() {
  try {
    const fn = personaTextExt && personaTextExt.personaEmojiChar;
    if (typeof fn !== 'function') return '';
    const e = String(fn(readPersonaLib()) || '').trim();
    if (!e) return '';
    return Array.from(e).slice(0, 2).join('');
  } catch (e) { return ''; }
}
/** 回执正文：标题截 22 字（拿不到标题就用 BV），句末按人设补一个 emoji。 */
function ackTextOf(it) {
  const bv = String((it && it.bvid) || '');
  const title = Array.from(String((it && it.title) || '').trim()).slice(0, 22).join('') || bv;
  return '收到，开始看了：' + title + '（' + bv + '）。几分钟后把总结私信给你。' + ackEmoji();
}
/**
 * 对 items 里「前 3 条未在 24h 内回执过」的发私信回执。
 * @returns {Promise<number>} 实际发出（B 站 code=0）的条数
 */
async function sendInboundAcks(items, out) {
  const list = (Array.isArray(items) ? items : []).filter(x => x && x.bvid && Number(x.uid) > 0);
  if (!list.length) return 0;
  let enabled = false;
  try { enabled = readInboundAck(); } catch (e) { enabled = false; }
  if (!enabled) return 0;
  let store = readAckStore();
  const now = Date.now();
  const pending = [];
  for (const it of list) {
    if (pending.length >= ACK_MAX_PER_TICK) break;
    if (ackRecently(it.bvid, store, now)) continue;
    pending.push(it);
  }
  let sent = 0;
  for (const it of pending) {
    const at = new Date().toISOString();
    let code = null, msg = '', ok = false;
    try {
      const r = await sendDmText(String(it.uid), ackTextOf(it));
      code = r && r.code != null ? r.code : null;
      msg = String((r && r.message) || '');
      ok = Number(code) === 0;
    } catch (e) {
      msg = String((e && e.message) || e);
    }
    try { writeAckLog({ at, bv: it.bvid, uid: Number(it.uid), title: String(it.title || ''), code, msg, ok }); } catch (e) {}
    if (ok) { store = store.filter(x => !(x && x.bv === it.bvid)).concat([{ bv: it.bvid, at }]); sent += 1; }
    else if (out) out.ackError = msg || ('code ' + String(code));
  }
  if (sent > 0) writeAckStore(store);
  return sent;
}

async function inboxPollerOnce() {
  const out = { at: new Date().toISOString(), added: 0, checked: 0, items: [], error: null };
  const addedList = [];   // v52：本拍新入队的条目，循环结束后用来发「收到」回执
  // 可跑时间段（v47 唯一真源 runWindow；旧 blackout 配置由 windowAllows 内部迁移）：不允时段连拉取都不做
  try {
    const pac0 = readPacing();
    const h = new Date().getHours();
    if (!windowAllows(pac0.runWindow, new Date(), readPricing())) {
      out.blackoutSkip = true; out.hour = h;
      try { fs.appendFileSync(path.join(DATA, 'logs', 'inbound-poller.log'), JSON.stringify(out) + '\\n'); } catch (e) {}
      return out;
    }
  } catch (e) {}
  try {
    const d = await inbox(true);
    const uids = pushUidSet();
    const rows = [];
    for (const x of (d.at || [])) rows.push(Object.assign({}, x, { kind: 'at' }));
    for (const x of (d.dms || [])) rows.push(Object.assign({}, x, { kind: 'dm' }));
    out.checked = rows.length;
    for (const x of rows) {
      const uid = Number(x.uid);
      if (!x.bvid || !uids.has(uid)) continue;
      out.items.push({ bvid: x.bvid, uid: uid, kind: x.kind, msgType: x.msgType || 1, title: x.cardTitle || x.title || '' });
    }
    for (const it of out.items) {
      if (lib.isSeen(it.bvid)) continue;   // 已在库里（无论 queued/seen/skipped）= 不重复入队、不降级状态
      lib.mark({ bvid: it.bvid, status: 'queued', score: null, via: 'inbound', depth: 'T3', title: it.title || '', up: '' });
      out.added++;
      addedList.push({ bvid: it.bvid, uid: it.uid, title: it.title || '' });   // v52：待回执
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  /* v52：ack=true 时对新入队的前 3 条发「收到，开始看了…」私信回执。
     单独 try/catch —— 回执失败只写 out.ackError，绝不阻断下面的 autoRun 与入队结果返回。 */
  if (addedList.length && readInboundAck()) {
    try {
      const nAck = await sendInboundAcks(addedList, out);
      if (nAck) out.ackSent = nAck;
    } catch (e) { out.ackError = String((e && e.message) || e); }
  }
  // 新入队 > 0 且现在是"能跑"的时间（非夜间 + 预算没耗尽）就自动起 runner（用户手动「开始跑」仍走 force）
  if (out.added > 0) {
    try {
      const pac = readPacing();
      const cr = costReport();
      /* v47（契约 §2b）：时段闸门只看 runWindow —— heat/nightStop 不再否决跑片，heat 仅作展示/其它用途 */
      const okWindow = windowAllows(pac.runWindow, new Date(), readPricing());
      const okBudget = !cr || cr.state !== 'exhausted';
      if (okWindow && okBudget && !RUNNER.running) {
        const child = spawn(NODE_EXE, [path.join(CODE, 'scripts', 'runner.mjs'), '--limit=' + Math.min(5, out.added), '--depth=T3'], { cwd: DATA, windowsHide: true, detached: true, stdio: 'ignore', env: CHILD_ENV });
        child.unref();
        out.autoRun = true;
      } else {
        out.deferred = true;
        out.deferReason = !okWindow ? 'blackout' : 'budget';
      }
    } catch (e) { out.autoRunError = String((e && e.message) || e); }
  }
  try { fs.appendFileSync(path.join(DATA, 'logs', 'inbound-poller.log'), JSON.stringify(out) + '\n'); } catch (e) {}
  return out;
}

function inboundCfg() {
  try {
    const p = readPacing() || {};
    const i = p.inbound || {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      activeSec: num(i.activeSec, 20), idleSec: num(i.idleSec, 60), nightSec: num(i.nightSec, 180),
      activeWindowMin: num(i.activeWindowMin, 10),
    };
  } catch (e) {
    return { activeSec: 20, idleSec: 60, nightSec: 180, activeWindowMin: 10 };
  }
}

// 自适应入站守候：活跃 20s / 空闲 60s / 夜间 180s（参数在面板「入站与投递」可改）
// 原来的 5 分钟 inboxPollerOnce 保留给 /api/inbox/poll 手动调用，不再做常驻轮询。
function startInboxPoller() {
  let hitAt = 0;
  let round = 0;
  const loop = async () => {
    let next = 60;
    try {
      const cfg = inboundCfg();
      const hour = new Date().getHours();
      const night = hour >= 0 && hour < 6;
      next = night ? cfg.nightSec : (Date.now() - hitAt < cfg.activeWindowMin * 60000 ? cfg.activeSec : cfg.idleSec);
      const r = await inboundTick({});
      round += 1;
      const n = (r && r.found && r.found.length) || 0;
      if (n > 0) hitAt = Date.now();
      /* v52：面板自己的 tick 路径同样发回执（ack=true 时，对发现的条目取前 3 条；去重/日志同 poll 路径） */
      let ackInfo = {};
      if (n > 0 && readInboundAck()) {
        try {
          const ackSent = await sendInboundAcks(r.found || [], null);
          if (ackSent) ackInfo = { ackSent };
        } catch (e) { ackInfo = { ackError: String((e && e.message) || e) }; }
      }
      if (round % 30 === 1 || n > 0) {
        try {
          fs.appendFileSync(path.join(DATA, 'logs', 'inbound-tick.log'), JSON.stringify({
            at: new Date().toISOString(), by: 'panel', round, found: n, ms: (r && r.ms) || null,
            next, night, error: (r && r.error) || null, ...ackInfo,
          }) + '\n');
        } catch (e) {}
      }
    } catch (e) {
      try {
        fs.appendFileSync(path.join(DATA, 'logs', 'inbound-tick.log'), JSON.stringify({
          at: new Date().toISOString(), by: 'panel', error: String(e && e.message || e),
        }) + '\n');
      } catch (e2) {}
    }
    const t = setTimeout(loop, Math.max(5, Number(next) || 60) * 1000);
    if (t && typeof t.unref === 'function') t.unref();
  };
  const boot = setTimeout(loop, 8000);
  if (boot && typeof boot.unref === 'function') boot.unref();
}

function runDetail(bv) {
  const r = runs(2000).find(x => x.bvid === bv);
  const dir = path.join(DATA, 'out', bv);
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  let cost = null;
  try { cost = JSON.parse(read('cost.json') || 'null'); } catch { cost = null; }
  const manifest = read('manifest.txt');
  const dlv = deliveredFor(bv);
  return {
    summary: readSummary(bv),
    /* B1-5/B4-7：投递真实状态，和 /api/archive 行同一口径（outbound.db posts 表） */
    dm_sent: !!dlv.dm,
    comment_sent: !!dlv.comment,
    gate: readGateFile(bv),
    fact: (() => { const f = readFactcard(bv); return f ? { factCount: f.factCount, infoDensity: f.infoDensity, cuts: f.cuts, cells: f.cells, cellsWithText: f.cellsWithText } : null; })(),
    run: r ? enrich(r) : null,
    cost,
    manifest,
    manifest_first: manifest ? manifest.split('\n').slice(0, 18).join('\n') : null,
    hasSheet: !!sheetFile(bv),
    hasOcr: fs.existsSync(path.join(dir, 'ocr.txt')),
    hasDanmaku: fs.existsSync(path.join(dir, 'danmaku.txt')),
    /* v26：本地判否说明（为什么没让它上云端）——只会出现在 gate 判为 local-hold/skip 的条目里 */
    why: (function () { try { return readWhy(bv).doc; } catch (e) { return null; } })(),
    ocr: read('ocr.txt'),
    danmaku: read('danmaku.txt'),
    bv,
  };
}


/* ── v24：面板本次加载时刻（B2 修 uptimeSec） ────────────────────────────────
   原来这里写死成 '2026-10-30T12:54:56.698Z'，于是 /api/meta 的 uptimeSec
   永远从那个固定日期算起，假装"已跑 61 小时"，跟真实运行时长无关。
   inproc 模式下宿主每次热加载都会重新 import 本文件，模块加载时刻就是
   「面板本次加载」的起点，重启/热加载后 uptimeSec 归零，含义诚实。 */
const PANEL_LOADED_AT = new Date().toISOString();
const PANEL_LOADED_MS = Date.parse(PANEL_LOADED_AT);
function dirSize(rel, base = DATA) {
  const abs = path.join(base, rel);
  let bytes = 0, files = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__pycache__') walk(fp); }
      else { try { bytes += fs.statSync(fp).size; files++; } catch {} }
    }
  };
  walk(abs);
  return { bytes, files, mb: Number((bytes / 1048576).toFixed(1)) };
}
function configList() {
  const out = [];
  const dir = path.join(DATA, 'config');
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const fp = path.join(dir, e.name);
    let obj = null, st = null;
    try { obj = JSON.parse(fs.readFileSync(fp, 'utf8')); st = fs.statSync(fp); } catch {}
    out.push({
      file: 'config/' + e.name,
      version: obj && obj.version != null ? obj.version : null,
      updatedAt: (obj && obj.updatedAt) || (st ? st.mtime.toISOString() : null),
      bytes: st ? st.size : 0,
    });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}
function meta() {
  const ledgerRows = (() => { try { const d = openDb('logs/ledger.db'); const r = d.prepare('SELECT COUNT(*) n FROM runs').get(); d.close(); return r.n; } catch { return null; } })();
  const libStats = (() => { try { return lib.stats(); } catch { return null; } })();
  const cands = (() => { try { return fs.readdirSync(path.join(DATA, 'out', 'pick')).filter(f => f.endsWith('.json')).length; } catch { return 0; } })();
  return {
    version: PANEL_VERSION, startedAt: PANEL_LOADED_AT,
    uptimeSec: Math.max(0, Math.round((Date.now() - PANEL_LOADED_MS) / 1000)),
    port, host: '127.0.0.1', node: process.version,
    /* 独立进程 = 自己 listen；被插件 import = 挂在宿主 webServer 的 /video-panel 上，不占端口 */
    mode: IS_MAIN_EARLY ? 'standalone' : 'inproc',
    addr: IS_MAIN_EARLY ? `127.0.0.1:${port}` : 'host:/video-panel',
    dataDir: DATA, codeDir: CODE, dataSource: DATA_SOURCE, dataDirDefault: dataInfo().defaultRoot,
    dirs: {
      cache: ['cache/api', 'cache/video', 'cache/frames', 'cache/sheets', 'cache/ocr'].map(d => ({ dir: d, ...dirSize(d) })),
      logs: dirSize('logs'), out: dirSize('out'),
      /* vendor/ 与 scripts/ 属代码根（随包走、只读），不计入数据体积 */
      vendor: dirSize('vendor', CODE), scripts: dirSize('scripts', CODE),
    },
    counts: { ledger: ledgerRows, library: libStats, candidates: cands },
    configs: configList(),
    /* v26：缓存保留策略（保留天数 / 跑完后清理方式），面板设置页直接读这里 */
    storage: readStorage(),
    /* 门禁档位与入队来源的显示名（面板只读这张表，不硬编码中文） */
    routes: routeTable(),
    /* gate_zh：门禁码 → 中文（含老值别名 pass/gray-sampled/gray），前端详情页直接查表，
       与 routes.mjs 的 ROUTES 保持同一真源；未知码前端回退显示原码。 */
    gate_zh: (() => {
      const t = {};
      try {
        for (const r of routeTable()) {
          t[r.code] = r.zh;
          for (const old of (r.legacy || [])) t[old] = r.zh;
        }
      } catch (e) {}
      return t;
    })(),
    entry: { vod: VOD_PASS },
  };
}
function exportConfig() {
  const bundle = { at: new Date().toISOString(), version: 'v12', configs: {} };
  for (const c of configList()) {
    try { bundle.configs[c.file] = JSON.parse(fs.readFileSync(path.join(DATA, c.file), 'utf8')); } catch {}
  }
  const dir = path.join(DATA, 'logs', 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const file = 'logs/exports/config-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(bundle, null, 2));
  return { ok: true, file, bytes: fs.statSync(path.join(DATA, file)).size, configs: Object.keys(bundle.configs) };
}
const SAFE_CACHE = new Set(['cache/api', 'cache/video', 'cache/frames', 'cache/sheets', 'cache/ocr']);
function clearCache(which) {
  if (!SAFE_CACHE.has(which)) return { ok: false, error: '只能清 ' + [...SAFE_CACHE].join(' / ') };
  const abs = path.join(DATA, which);
  let freed = 0, removed = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      try {
        if (e.isDirectory()) { walk(fp); fs.rmSync(fp, { recursive: true, force: true }); }
        else { freed += fs.statSync(fp).size; fs.unlinkSync(fp); removed++; }
      } catch {}
    }
  };
  walk(abs);
  return { ok: true, which, removed, freed_mb: Number((freed / 1048576).toFixed(1)) };
}

/* v32：宿主 inproc 每次按 mtime 重新 import 这个文件，都会新造一份模块级状态和定时器。
   v31 及以前 RUNNER 是模块级的 → 反复 reload 后同时存在好几个「自认为空闲」的实例，
   同一个排队视频会被并发拉起好几个 runner（dispatch.log 里 09:12:03 一秒内 4 条 launch），
   状态互相覆盖、最后卡在 running。把它挂到 globalThis，全进程只有一份。 */
const GLOBAL_LIVE = (globalThis.__vdPanelLive = globalThis.__vdPanelLive || {});
function freshRunner() {
  return { running: false, startedAt: null, finishedAt: null, limit: 0, depth: 'T3', result: null, error: null, tail: [] };
}
let RUNNER = GLOBAL_LIVE.RUNNER || (GLOBAL_LIVE.RUNNER = freshRunner());
function runnerState() {
  return {
    running: RUNNER.running, startedAt: RUNNER.startedAt, finishedAt: RUNNER.finishedAt,
    limit: RUNNER.limit, depth: RUNNER.depth, result: RUNNER.result, error: RUNNER.error, tail: RUNNER.tail.slice(-12),
  };
}
function startRunner(limit, depth, force, bv) {
  if (RUNNER.running) return { ok: false, error: '已经在跑了（' + RUNNER.limit + ' 条 / ' + RUNNER.depth + '）' };
  limit = Math.max(1, Math.min(10, limit));
  depth = ['T2', 'T3', 'T4'].includes(depth) ? depth : 'T3';
  RUNNER = freshRunner();
  RUNNER.running = true;
  RUNNER.startedAt = new Date().toISOString();
  RUNNER.limit = limit;
  RUNNER.depth = depth;
  GLOBAL_LIVE.RUNNER = RUNNER;
  const child = spawn(NODE_EXE, [path.join(CODE, 'scripts', 'runner.mjs'), '--limit=' + limit, '--depth=' + depth].concat(force ? ['--force'] : []).concat(bv ? ['--bv=' + bv] : []), { cwd: DATA, windowsHide: true, env: CHILD_ENV });
  let outBuf = '';
  child.stdout.on('data', d => {
    const t = d.toString();
    outBuf += t;
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^RESULTS (\{.*\})$/);
      if (m) { try { RUNNER.result = JSON.parse(m[1]); } catch (e) { /* ignore */ } }
      else if (line.trim()) RUNNER.tail.push(line.trim().slice(0, 200));
    }
  });
  child.stderr.on('data', d => { const t = d.toString().trim(); if (t) RUNNER.tail.push('[stderr] ' + t.slice(0, 200)); });
  child.on('close', code => {
    RUNNER.running = false;
    RUNNER.finishedAt = new Date().toISOString();
    if (code !== 0 && !RUNNER.error) RUNNER.error = 'runner exit ' + code;
    if (!RUNNER.result && code === 0) RUNNER.error = 'runner 未输出 RESULTS';
  });
  child.on('exit', () => {
    try { scheduleDispatchAfterRun(); } catch (e) {}
    try { setTimeout(() => { try { autoDeliverAfterRun(); } catch (e) {} }, 1500); } catch (e) {}
  });
  return { ok: true, limit, depth, startedAt: RUNNER.startedAt };
}

/* ---------- 出站投递：跑完把总结私信给推送账号 ---------- */
const DELIVER_LOG = path.join(DATA, 'logs', 'deliver.log');
function deliverLog(o) {
  try { fs.appendFileSync(DELIVER_LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch (e) {}
}
/* v57（2026-11-08 用户：「新添了用户不能入站和推送」）：
   push.json 约定「数量不限 · 前 3 位生效」，但这里和 sender 以前都只取 [0]，
   第 2/3 个账号永远收不到。现在统一按前 3 个启用账号算；channel=panel 只留面板，
   不算外部收件人。 */
function activePushTargets() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA, 'config', 'push.json'), 'utf8'));
    return (p.accounts || []).filter(a => a.enabled !== false && Number(a.uid)).slice(0, 3);
  } catch (e) { return []; }
}
function dmTargets() {
  return activePushTargets().filter(a => String(a.channel || 'dm') === 'dm');
}
function pushTarget() {
  return activePushTargets()[0] || null;
}
function openOutbound() {
  try {
    const db = new DatabaseSync(path.join(DATA, 'logs', 'outbound.db'), { readOnly: true });
    return db;
  } catch (e) { return null; }
}
function deliveredMap() {
  const map = {};
  const db = openOutbound();
  if (!db) return map;
  try {
    const rows = db.prepare("SELECT bvid, kind, MAX(sent) sent, MAX(at) at FROM posts GROUP BY bvid, kind").all();
    for (const r of rows) {
      map[r.bvid] = map[r.bvid] || {};
      map[r.bvid][r.kind] = { sent: !!r.sent, at: r.at };
    }
  } catch (e) {} finally { try { db.close(); } catch (e) {} }
  return map;
}
/* v57：去重按 bvid + target_uid。以前只看 bvid，任一账号发过整条视频就算已投，
   新加账号会被 autoDeliverAfterRun 一直跳过（用户实测的「推送不出去」）。 */
function alreadyDm(bv, uid) {
  const db = openOutbound();
  if (!db) return false;
  try {
    const r = uid === undefined
      ? db.prepare("SELECT COUNT(*) n FROM posts WHERE bvid=? AND kind='dm' AND sent=1").get(bv)
      : db.prepare("SELECT COUNT(*) n FROM posts WHERE bvid=? AND kind='dm' AND sent=1 AND target_uid=?").get(bv, String(uid));
    return !!(r && r.n);
  } catch (e) { return false; } finally { try { db.close(); } catch (e) {} }
}
function dmMissing(bv) {
  const ts = dmTargets();
  if (!ts.length) return [];
  return ts.filter(a => !alreadyDm(bv, a.uid));
}
/* B1-5/B4-7：单条投递状态（detail 页行数据不在当前页时不再靠猜）——kind 实测为 'dm'/'comment' */
function deliveredFor(bv) {
  const out = { dm: false, comment: false };
  const db = openOutbound();
  if (!db) return out;
  try {
    const rows = db.prepare("SELECT kind, MAX(sent) sent FROM posts WHERE bvid=? GROUP BY kind").all(bv);
    for (const r of rows) out[r.kind] = !!r.sent;
  } catch (e) {} finally { try { db.close(); } catch (e) {} }
  return out;
}
const DELIVER = { running: false, queue: [], last: null };
function hasCloudSummary(bv) {
  try { return fs.existsSync(path.join(DATA, 'out', bv, 'summary.cloud.json')); } catch (e) { return false; }
}
function spawnDeliver(bv, mode) {
  if (!bv) return { ok: false, error: 'no bvid' };
  const targets = dmTargets();
  if (!targets.length) return { ok: false, error: '没有启用的私信推送账号' };
  /* 只投云端正式版：没写好总结的一律不投，等 /api/summary/write 写完再自动投 */
  if (mode !== 'brief' && !hasCloudSummary(bv)) {
    deliverLog({ action: 'skip', bvid: bv, why: 'no-cloud-summary' });
    return { ok: false, error: 'no-summary', bvid: bv };
  }
  if (DELIVER.running) { if (!DELIVER.queue.includes(bv)) DELIVER.queue.push(bv); return { ok: true, queued: true, bvid: bv }; }
  DELIVER.running = true;
  const argv = [path.join(CODE, 'scripts', 'sender.mjs'), '--bv=' + bv];
  if (mode === 'send' || mode === 'brief') argv.push('--send');
  if (mode === 'brief') argv.push('--brief');
  deliverLog({ action: 'start', bvid: bv, mode, target: targets.map(t => String(t.uid)).join(',') });
  const child = spawn(NODE_EXE, argv, { cwd: DATA, windowsHide: true, env: CHILD_ENV });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  child.on('close', code => {
    let res = null;
    const m = out.match(/RESULTS ({.*})/);
    if (m) { try { res = JSON.parse(m[1]); } catch (e) {} }
    const item = res && res.items && res.items[0] ? res.items[0] : null;
    DELIVER.running = false;
    DELIVER.last = { at: new Date().toISOString(), bvid: bv, mode, code, item };
    /* v24（B1 连带）：done 记录必须带「每个通道的结果」。
       v23 只写 dm:item.dmVerified，sender 私信失败时 item 里没有该字段 → dm 字段整个消失，
       事后翻 deliver.log 看不出是没发还是发失败。现在固定输出 dm/dmCode/dmMsg 与
       comment/commentCode/commentMsg/commentSkip（字段来源 = sender 的 RESULTS items[0]）。 */
    const dmOk = !!(item && item.dm !== undefined ? item.dm : item && item.dmVerified);
    const cmOk = !!(item && item.comment !== undefined ? item.comment : item && item.commentVerified);
    deliverLog({
      action: 'done', bvid: bv, mode, code,
      dry: !!(res && res.dry) || !!(item && item.dry),
      dm: dmOk,
      dmCode: item && item.dmCode !== undefined && item.dmCode !== null ? item.dmCode : (dmOk ? 0 : null),
      dmMsg: String((item && item.dmMsg) || (!item && res && res.error) || '').slice(0, 300),
      dmVerified: !!(item && item.dmVerified),
      comment: cmOk,
      commentCode: item && item.commentCode !== undefined && item.commentCode !== null ? item.commentCode : (cmOk ? 0 : null),
      commentMsg: String((item && item.commentMsg) || '').slice(0, 300),
      commentSkip: (item && item.commentSkip) || null,
      skipped: (item && item.commentSkipped) || null,
    });
    const next = DELIVER.queue.shift();
    if (next) spawnDeliver(next, 'send');
  });
  return { ok: true, bvid: bv, mode, target: { uid: String(targets[0].uid), name: targets[0].name }, targets: targets.map(t => ({ uid: String(t.uid), name: t.name })) };
}
function autoDeliverAfterRun() {
  if (!dmTargets().length) return;
  const items = (RUNNER.result && RUNNER.result.items) || [];
  const done = items.filter(i => i.action === 'done' && i.bvid);
  for (const it of done) {
    /* v57：只有「所有 dm 账号都收过」才算投完；少一个就再跑一次 sender 补投。 */
    const missing = dmMissing(it.bvid);
    if (!missing.length) { deliverLog({ action: 'skip', bvid: it.bvid, why: 'already-dm' }); continue; }
    deliverLog({ action: 'queue', bvid: it.bvid, missing: missing.map(t => t.name) });
    if (!hasCloudSummary(it.bvid)) { deliverLog({ action: 'skip', bvid: it.bvid, why: 'no-cloud-summary-await' }); continue; }
    spawnDeliver(it.bvid, 'send');
  }
}

/* ---------- 自动投递 dispatcher：入列 / 升格 / 投递 ---------- */
// 写手（插件里的 watch tick）心跳：dispatcher 用它判断「现在能不能先等写完再跑下一条」
const WATCH = { lastBeat: 0, lastWhy: '', lastBv: '', beats: 0 };

const DISP = { lastTickAt: 0, lastPickAt: 0, lastPromoteAt: 0, ticks: 0, lastSkip: null, lastSkipAt: null, lastSkipDetail: null };
/* v49 A1：队列「为什么不动」—— 每次早返回都记下原因/时间/一句话，/api/queue 的 stall 直接读它 */
function skip(reason, detail = null) {
  DISP.lastSkip = reason;
  DISP.lastSkipAt = new Date().toISOString();
  DISP.lastSkipDetail = detail || null;
}
function clearSkip() {
  DISP.lastSkip = null;
  DISP.lastSkipAt = null;
  DISP.lastSkipDetail = null;
}

/* v40（用户 m06240：「点播源入队后一直在排队」）：写优先不能无限等。
   判据不是「写手进程在不在」，而是「它最近有没有真的写出东西」——扫 out/<bv>/summary.cloud.json 的最新 mtime。
   写手卡住（nudge 过但一条没写）超过 WRITER_STALL_MS，dispatcher 就不再让路，点播源照跑。 */
const WRITER_STALL_MS = 12 * 60 * 1000;
let _lastWriteCache = { at: 0, t: 0 };
function lastSummaryWriteAt() {
  const now = Date.now();
  if (now - _lastWriteCache.at < 8000) return _lastWriteCache.t;
  let newest = 0;
  try {
    const outDir = path.join(DATA, 'out');
    for (const d of fs.readdirSync(outDir)) {
      if (!/^BV[0-9A-Za-z]{6,14}$/.test(d)) continue;
      try {
        const st = fs.statSync(path.join(outDir, d, 'summary.cloud.json'));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (e) { /* 没有就算了 */ }
    }
  } catch (e) { /* 读不到目录就当没写过 */ }
  _lastWriteCache = { at: now, t: newest || (now - WRITER_STALL_MS * 2) };
  return _lastWriteCache.t;
}
function dispLog(o) {
  try { fs.appendFileSync(path.join(DATA, 'logs', 'dispatch.log'), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch (e) { /* ignore */ }
}
function dispTodayRuns() {
  try { const t = localDay(new Date()); return runs(800).filter(r => localDay(r.at) === t).length; } catch (e) { return 0; }
}
/* v32：跨实例的「真的有 runner 在跑吗」。RUNNER 只在内存里，模块 reload 之后旧实例仍在跑；
   光靠内存判断会重复拉起。这里用 DB 里 running 行的 last_seen 做兜底：
   18 分钟内有 running 行 → 这一拍不投（等它自己收尾）；超过 18 分钟（>digest 的 15 分钟超时）
   → 视为卡死，回退成 queued 让它重跑，顺便修掉「卡在分析中、永远不结束」的那类脏状态。 */
const STALE_RUNNING_MS = 18 * 60 * 1000;
function runningRowState() {
  let rows = [];
  try { rows = lib.list(['running'], 20); } catch (e) { return { active: false, stale: [] }; }
  const now = Date.now();
  const stale = [];
  let active = false;
  for (const r of rows) {
    const t = Date.parse(r.last_seen || r.first_seen || 0) || 0;
    if (now - t > STALE_RUNNING_MS) stale.push(r);
    else active = true;
  }
  return { active, stale };
}
/* v46：候选补货（picker）与跑片解耦 —— 放在 dispatch.enabled 判断之后、RUNNER.running /
   running-row / 夜间黑名单之前。原先是 dispatchTick 最后一步，前面任一闸门 return 都会把
   「每天自动搜集」一起挡掉（blackout 每天挡 13 小时 → 连续几天 0 候选）。 */
const PICK_LAST_FILE = 'logs/pick-last.json';
const PICK_STATS_KEYS = ['order', 'maxAgeDays', 'queries', 'queriesDropped', 'searched', 'failed',
  'fetched', 'unique', 'seenFiltered', 'durFiltered', 'ageFiltered', 'ranked', 'picked', 'enlisted', 'took'];
function readLastPick() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, PICK_LAST_FILE), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    return j;
  } catch (e) { return null; }
}
function refillPicker(D) {
  const wm = Math.max(0, Number(D.candidateWatermark || 10));
  let cands = [];
  try { cands = lib.list(['candidate'], 500); } catch (e) { return; }
  let pending = 0;
  try { pending = lib.counts().pending || 0; } catch (e) {}
  let enlisted = 0;
  try { enlisted = lib.enlistedToday ? lib.enlistedToday() : 0; } catch (e) {}
  const roomEnlist = Math.max(0, Number(D.dailyEnlist || 10) - enlisted);
  const roomPending = Math.max(0, Number(D.autoMaxPending || 30) - pending);
  /* v46：上一轮被 412 全拦时 15 分钟后就再试（风控冷却通常 5s–30min 级，等一小时太钝）；
     正常（搜到过东西）才按 1 小时节流。 */
  const prevPick = readLastPick();
  /* 旧记录没有 ok 字段或 ok=true 但一个词都没搜成，也算「上一轮没跑成」→ 15 分钟重试 */
  const prevBad = !!(prevPick && (prevPick.ok === false || Number(prevPick.searched || 0) === 0));
  const minGapMs = prevBad ? 15 * 60 * 1000 : 3600 * 1000;
  if (!(cands.length < wm && roomEnlist > 0 && roomPending > 0 && Date.now() - DISP.lastPickAt > minGapMs)) return;
  DISP.lastPickAt = Date.now();
  const at = new Date().toISOString();
  const t0 = Date.now();
  try {
    const ch = spawn(NODE_EXE, [path.join(CODE, 'scripts', 'pick.mjs'), '--auto'], { cwd: DATA, windowsHide: true, env: CHILD_ENV });
    let buf = '';
    ch.stdout.on('data', d => { buf += d.toString(); });
    ch.stderr.on('data', d => { buf += d.toString(); });
    ch.on('close', code => {
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const tail = lines.slice(-8); /* v46：3 行看不到失败原因，改 8 行 */
      const sumLine = lines.filter(l => l.startsWith('[搜集汇总] ')).pop() || '';
      let stats = null;
      try { stats = sumLine ? JSON.parse(sumLine.slice('[搜集汇总] '.length)) : null; } catch (e) { stats = null; }
      /* v46：ok 必须真的发起并成功过搜索（searched>0）。全部词被 412 拦下时 code 仍是 0，
        但这一轮对用户来说就是「没跑成」，前端要如实显示，并允许 15 分钟后重试。 */
      const rec = { at, code, ms: Date.now() - t0, ok: code === 0 && !!stats && Number(stats.searched || 0) > 0 };
      for (const k of PICK_STATS_KEYS) {
        rec[k] = stats && stats[k] !== undefined ? stats[k] : ((k === 'queries' || k === 'failed') ? [] : null);
      }
      rec.tail = tail;
      try { fs.writeFileSync(path.join(DATA, PICK_LAST_FILE), JSON.stringify(rec)); } catch (e) {}
      dispLog({ action: 'pick', code, ms: rec.ms, ok: rec.ok, order: rec.order, searched: rec.searched, picked: rec.picked, enlisted: rec.enlisted, tail });
    });
  } catch (e) {
    dispLog({ action: 'pick', error: String((e && e.message) || e) });
  }
}
function dispatchTick() {
  DISP.ticks++;
  let p; try { p = readPacing(); } catch (e) { return; }
  const D = { ...PACING_DEFAULT.dispatch, ...(p.dispatch || {}) };
  /* A4-03：18 分钟 stale 回退**必须无条件执行**。
     原来它排在 `D.enabled === false` 与 `RUNNER.running` 两个早返回之后 ——
     dispatch 被关掉、或本实例 runner 正在跑时，卡死的 running 行永远不会被自愈。 */
  let rs = { active: false, stale: [] };
  try { rs = runningRowState(); } catch (e) { /* 读库失败就当没有 running 行 */ }
  for (const r of rs.stale) {
    try { lib.setStatus(r.bvid, 'queued', 'stale-running-reset'); } catch (e) { /* ignore */ }
    dispLog({ action: 'stale-reset', bvid: r.bvid, last_seen: r.last_seen || null });
  }
  /* A3-02 / 契约 7：B 站风控冷却窗口内不 launch 新跑片，且把原因记进 lastSkip（/api/health 可见）。
     放在 enabled/running 早返回**之前**：即使执行器关着、或本实例 runner 在跑，也要先把 risk 读出来——
     否则 /api/health 永远看不到 risk 这个跳过原因，也测不出冷却窗口。 */
  const rk = bili_risk();
  if (rk && rk.cooling) {
    let _untilTxt = null;
    try { if (rk.until) _untilTxt = '冷却至 ' + localHM(new Date(rk.until).toISOString()); } catch (e) {}
    skip('risk', _untilTxt);
    dispLog({ action: 'risk-skip', until: rk.until || null, streak: rk.streak || 0 });
    return;
  }
  if (D.enabled === false) { skip('disabled'); return; }
  /* v46：先补货再判跑片 —— 本条在跑 / 夜间黑名单都不再挡住「每天自动搜集」。 */
  try { refillPicker(D); } catch (e) { dispLog({ action: 'pick-error', error: String((e && e.message) || e) }); }
  if (RUNNER.running) { skip('running', '本实例执行器在跑片'); return; }
  /* v32：跨实例互斥（见 runningRowState 的注释） */
  if (rs.active) { skip('running-row', '另一个实例正在跑片'); return; }
  // 1) 可跑时间段 —— 用户点播（私信/@/手动加视频）不受夜间黑名单限制
  /* v47：时段判定只看 runWindow（唯一真源），旧 blackout 配置内部迁移 */
  const windowOkNow = windowAllows(p.runWindow, new Date(), readPricing());
  const qNow = lib.list(['queued', 'running'], 50);
  const VIP_VIA = ['inbound', 'manual', 'gray']; // 只用于文档可读性；判断统一走 isVodVia()
  const vip = qNow.filter(r => isVodVia(r.via)).sort((a, b) => (Number(b.prio) || 0) - (Number(a.prio) || 0))[0] || null;
  DISP.vip = vip ? vip.bvid : null;
  if (!windowOkNow && !vip) { skip('blackout'); return; }
  // 2) 上一条跑完要等 gapSec（秒）
  if (RUNNER.finishedAt) {
    const gap = Math.max(0, Number(D.gapSec || 5)) * 1000;
    if (Date.now() - Date.parse(RUNNER.finishedAt) < gap) return;
  }
  // 3) 今日真看上限 + 预算
  // dailyWatch 允许设成 0（不能写成 `|| 8`，否则 0 会被当成 8）
  const dwRaw = Number((p.fetch || {}).dailyWatch);
  const dailyWatch = Math.max(0, Number.isFinite(dwRaw) ? dwRaw : 8);
  const todayRunsNow = dispTodayRuns();
  if (todayRunsNow >= dailyWatch && !vip) { skip('dailyWatch', '今日真看 ' + todayRunsNow + '/' + dailyWatch); return; }
  try { const cr = costReport(); if (cr && cr.state === 'exhausted') { skip('budget'); return; } } catch (e) {}
  clearSkip();

  // 3.5) 写优先：还有待写、且写手（插件守候）在线、且它最近确实写出过东西 → 先等它写完，不投下一条
  //      写手在线但「卡住」（比如 nudge 过却一条没写出来）时不能无限等——否则点播源排队永远不跑（v40，用户 m06240）
  try {
    const backlog = pendingSummaries().length;
    const writerAlive = Date.now() - WATCH.lastBeat < 180000;
    const wroteAgo = Date.now() - lastSummaryWriteAt();
    if (backlog > 0 && writerAlive && wroteAgo < WRITER_STALL_MS) {
      skip('wait-write', '待写 ' + backlog + ' 条');
      return;
    }
    if (backlog > 0 && writerAlive && wroteAgo >= WRITER_STALL_MS) {
      skip('writer-stalled', '写手卡住 ' + Math.round(wroteAgo / 1000) + 's');
      dispLog({ action: 'writer-stalled', backlog, wroteAgoSec: Math.round(wroteAgo / 1000), lastWhy: WATCH.lastWhy || '' });
      /* 继续往下走：写手卡住不该拖住点播源 */
    }
  } catch (e) {}

  // 4) 升格：排队中为空 → 按分数把候选升 1 条（每 tickSec 最多一次）
  const queued = lib.list(['queued', 'running'], 50);
  if (!queued.length) {
    const tickMs = Math.max(10, Number(D.tickSec || 60)) * 1000;
    if (Date.now() - DISP.lastPromoteAt >= tickMs) {
      const cands = lib.list(['candidate'], 500);
      if (cands.length) {
        const c = cands[0];
        lib.mark({ bvid: c.bvid, status: 'queued', prio: 0, note: 'auto-promote' });
        DISP.lastPromoteAt = Date.now();
        dispLog({ action: 'promote', bvid: c.bvid, score: c.score, title: c.title });
      }
    }
  }

  // 5) 投递：排队中仍有东西 → 立刻起 runner（一次 1 条）
  const q2 = lib.list(['queued'], 50);
  if (q2.length) {
    const head = q2.slice().sort((a, b) => (Number(b.prio) || 0) - (Number(a.prio) || 0))[0];
    const isVip = isVodVia(head && head.via);
    const r = startRunner(1, 'T3', !!isVip, null);
    dispLog({ action: 'launch', ok: !!r.ok, error: r.error || null, queued: q2.length, vip: isVip ? head.bvid : null });
    return;
  }

}
/* v32：同一个 dispatch 定时器只允许存在一份。模块 reload 时先把上一份清掉，
   否则旧实例的定时器会一直活着、和新实例抢着 launch runner（就是「一秒 4 条 launch」的来源）。 */
try { if (GLOBAL_LIVE.dispatchTimer) clearInterval(GLOBAL_LIVE.dispatchTimer); } catch (e) {}
GLOBAL_LIVE.dispatchTimer = setInterval(() => { try { dispatchTick(); } catch (e) { dispLog({ action: 'tick-error', error: String(e && e.message || e) }); } }, 15000);
try { if (GLOBAL_LIVE.dispatchTimer.unref) GLOBAL_LIVE.dispatchTimer.unref(); } catch (e) {}
dispLog({ action: 'panel-version', version: PANEL_VERSION, pid: process.pid, risk: (() => { try { return bili_risk(); } catch (e) { return null; } })() });
// runner 结束 3 秒后立刻再 tick 一次（配合 gapSec 实现"跑完就投下一条"）
function scheduleDispatchAfterRun() { setTimeout(() => { try { dispatchTick(); } catch (e) {} }, 3000); }

/* 只有"独立运行"时才接管全局异常：被插件 import 时（宿主进程内）绝不能抢宿主的
   uncaughtException/unhandledRejection，否则宿主真正的崩溃会被我们吞掉。 */
const IS_MAIN_EARLY = (() => {
  try { return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url }
  catch (e) { return false }
})();
if (IS_MAIN_EARLY) {
  try {
    process.on('uncaughtException', (e) => {
      try { fs.appendFileSync(path.join(DATA, 'logs', 'panel-server.crash.log'), JSON.stringify({ at: new Date().toISOString(), err: String(e && e.stack || e) }) + '\n'); } catch (x) {}
    });
    process.on('unhandledRejection', (e) => {
      try { fs.appendFileSync(path.join(DATA, 'logs', 'panel-server.crash.log'), JSON.stringify({ at: new Date().toISOString(), rej: String(e && e.stack || e) }) + '\n'); } catch (x) {}
    });
  } catch (e) {}
}

const HIDDEN_FILE = 'logs/queue-hidden.json';

function readHiddenList() {
  try {
    const o = readJsonFile(HIDDEN_FILE, { bvids: [] });
    if (Array.isArray(o)) return o;            // 兼容旧格式
    return Array.isArray(o && o.bvids) ? o.bvids : [];
  } catch { return []; }
}
function writeHiddenList(list) {
  try {
    const bvids = Array.from(new Set(list)).slice(-5000);
    writeJsonFile(HIDDEN_FILE, { bvids, count: bvids.length }, 'queue-hidden');
  } catch (e) { console.error('[queue-hidden] 写失败:', e.message); }
}

/* ── 队列：全部读库（logs/library.db）。候选不再读 out/pick/*.json ── */
function parseExtra(row) {
  if (!row || !row.extra) return {};
  try { return JSON.parse(row.extra) || {}; } catch { return {}; }
}
function shapeVideo(r) {
  const e = parseExtra(r);
  return {
    ...e,
    bvid: r.bvid, title: r.title || '', up: r.up || '', via: r.via || '',
    status: r.status, score: r.score, depth: r.depth, note: r.note,
    dur: r.dur_sec || 0, dur_sec: r.dur_sec || 0, play: r.play || 0, danmaku: r.danmaku || 0,
    tname: r.tname || e.tname || '', prio: r.prio == null ? 0 : r.prio, fails: r.fails || 0,
    first_seen: r.first_seen, last_seen: r.last_seen,
    day: localDay(r.last_seen), at_short: localHM(r.last_seen),
  };
}
function queue() {
  const c = lib.counts();
  let p = PACING_DEFAULT;
  try { p = readPacing() || PACING_DEFAULT; } catch (e) { p = PACING_DEFAULT; }
  const D = { ...PACING_DEFAULT.dispatch, ...(p.dispatch || {}) };
  const all = lib.list(['candidate', 'queued', 'running', 'failed'], 400);
  const cand = all.filter(r => r.status === 'candidate')
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.first_seen).localeCompare(String(b.first_seen)));
  // 排队中：手动/入站（prio=1）优先，同类内按分数；先到先跑靠 first_seen
  const q = all.filter(r => r.status === 'queued')
    .sort((a, b) => ((b.prio || 0) - (a.prio || 0)) || ((b.score || 0) - (a.score || 0)) || String(a.first_seen).localeCompare(String(b.first_seen)));
  const run = all.filter(r => r.status === 'running');
  const failed = all.filter(r => r.status === 'failed')
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  /* v49 A1：stall —— 队列「为什么不动」的一句话解释（只读；canRun 仅供展示，不参与调度） */
  let risk = { cooling: false, until: null, streak: 0, last: null };
  try {
    refreshRisk();
    const r0 = bili_risk();
    risk = { cooling: !!r0.cooling, until: r0.until || null, streak: Number(r0.streak) || 0, last: r0.last || null };
  } catch (e) { /* 读不到风控就按不冷却展示 */ }
  const stall = (() => {
    const todayRuns = dispTodayRuns();
    const dwRaw = Number((p.fetch || {}).dailyWatch);
    const dailyWatch = Math.max(0, Number.isFinite(dwRaw) ? dwRaw : 8);
    let windowOk = true;
    try { windowOk = windowAllows(p.runWindow, new Date(), readPricing()); } catch (e) { windowOk = true; }
    const enabled = D.enabled !== false;
    const canRun = !risk.cooling && enabled && windowOk && todayRuns < dailyWatch;
    const SKIP_ZH = {
      risk: 'B 站风控冷却中', running: '执行器正在跑片', 'running-row': '另一个实例正在跑',
      blackout: '当前不在可跑时间段', dailyWatch: '今日真看已达上限', budget: '今日预算已用尽',
      'wait-write': '等写手把待写总结写完', 'writer-stalled': '写手卡住，已跳过等待',
      disabled: '自动投递关着',
    };
    const lastSkip = DISP.lastSkip || null;
    let hint = null;
    if (!canRun) {
      if (!enabled) hint = '自动投递关着 —— 手动「跑这条」/「↑ 升排队」仍可用';
      else if (todayRuns >= dailyWatch) hint = '今天想继续看：点某条行的「跑这条」或「↑ 升排队」，或明天 00:00 自动重置';
      else if (!windowOk) hint = '等可跑时间段（节奏与护栏页可改），或手动点「跑这条」';
      else if (lastSkip === 'budget') hint = '今天预算用尽 —— 可在「计价与预算」页调高或等到明天';
      else if (risk.cooling) hint = '等冷却结束，或用「跑这条」手动试';
    }
    return {
      lastSkip, lastSkipZh: lastSkip ? (SKIP_ZH[lastSkip] || null) : '空闲',
      lastSkipDetail: DISP.lastSkipDetail || null, lastSkipAt: DISP.lastSkipAt || null,
      enabled, todayRuns, dailyWatch,
      enlistedToday: (() => { try { return lib.enlistedToday(); } catch (e) { return 0; } })(),
      dailyEnlist: Number(D.dailyEnlist) || 10, candidate: c.by.candidate || 0,
      candWatermark: Number(D.candidateWatermark) || 10, pending: c.pending || 0,
      pendingMax: Number(D.autoMaxPending) || 30, canRun, hint,
    };
  })();
  return {
    stats: {
      candidate: cand.length, queued: q.length, running: run.length, failed: failed.length,
      seen: c.by.seen || 0, pending: c.pending, manualOpen: c.manualOpen,
      enlistedToday: lib.enlistedToday(),
      dispatch: D, autoMaxPending: D.autoMaxPending, manualCap: D.manualCap,
      candFile: null, candCount: cand.length, library: c.total,
    },
    candidates: cand.map(shapeVideo),
    queue: q.map(shapeVideo),
    running: run.map(shapeVideo),
    failed: failed.map(shapeVideo),
    seen: lib.list(['seen'], 20).map(r => ({ ...shapeVideo(r) })),
    /* v32：队列页要能看见「为什么没动静」——B 站风控冷却时入站守候整拍跳过，面板必须说出来。
       A3-04 / 契约 6：risk 恒为 {cooling,until,streak,last} 四字段，首拍也不缺。
       A4-03：staleResetPossible 说明「有 running 行时 18 分钟自动回退」这条自愈现在真的会跑
       （即便 dispatch 被关掉 / 本实例 runner 在跑）。 */
    risk,
    stall,
    staleResetPossible: (() => { try { return lib.list(['running'], 20).length > 0; } catch (e) { return false; } })(),
    /* v46：上次自动搜集的汇总（picker 子进程结束后写 logs/pick-last.json；缺失/坏 JSON → null） */
    lastPick: readLastPick(),
    runner: { running: RUNNER.running, startedAt: RUNNER.startedAt || null },
  };
}

/* ── v44：最近一次选片结果（只读 out/pick/cand-*.json）──
   文件名倒序找第一个 list 非空的文件。契约原写「最多扫 40 个」，但本机最新 40 个
   全是空 list（首个非空在第 66 个）—— 严格 40 会让偏好页永远空白，所以先扫 40，
   仍为空再继续向后找，总上限 400（仅防目录失控的护栏）。 */
function latestPicks(limit = 5) {
  const rawLimit = String(limit == null ? '' : limit).trim();
  const parsed = rawLimit === '' ? 5 : Math.floor(Number(rawLimit));
  const n = Number.isFinite(parsed) ? Math.max(1, Math.min(20, parsed)) : 5;
  const dir = path.join(DATA, 'out', 'pick');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^cand-.*\.json$/.test(f)).sort((a, b) => b.localeCompare(a)); }
  catch (e) { return { ok: true, empty: true, at: null, queries: [], count: 0, scanned: 0, list: [] }; }
  const MAX_SCAN = 400;
  let scanned = 0;
  for (const f of files.slice(0, MAX_SCAN)) {
    scanned++;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    const list = j && Array.isArray(j.list) ? j.list : [];
    if (!list.length) continue;
    const items = list.slice(0, n).map(it => ({
      bvid: String((it && it.bvid) || ''),
      title: String((it && it.title) || ''),
      author: String((it && it.author) || ''),
      tname: String((it && it.tname) || ''),
      via: String((it && it.via) || ''),
      total: Number((it && it.total) || 0),
      scoreTitle: Number((it && it.scoreTitle) || 0),
      scoreAll: Number((it && it.scoreAll) || 0),
      rBoost: Number((it && it.rBoost) || 0),
      dmBoost: Number((it && it.dmBoost) || 0),
      hits: it && Array.isArray(it.hits) ? it.hits : [],
      focus: String((it && it.focus) || ''),
    }));
    return {
      ok: true, at: j.at || null, queries: Array.isArray(j.queries) ? j.queries : [],
      count: Number(j.count) || list.length, scanned, empty: false, list: items,
    };
  }
  return { ok: true, empty: true, at: null, queries: [], count: 0, scanned, list: [] };
}

/* ── v45：类目「搜索词」建议 + 试搜（只读；suggest 缓存 60s，try 每次现算）──
   语料 = DATA/out/pick/cand-*.json（文件名倒序；**跳过空 list 继续往后扫**，最多 400 个文件、
   收满 60 个非空 list 即停 —— 生产 268 个文件里只有 11 个非空，只读前 120 个会几乎全空）。
   local 试搜再叠加 library 里已入过库的行（title/tname/tag）。live 试搜才联网，且最多 3 个 query。 */
const PREFS_SUGGEST_TTL_MS = 60 * 1000;
const PREFS_CORPUS_MAX_FILES = 400;
const PREFS_CORPUS_MAX_NONEMPTY = 60;
const PREFS_BAD_TAG_RE = /(科技猎手|挑战赛|有奖|征稿|活动|第\d季|新品|新春|元宝|赛博星人|新手|官方|直播|测评|vlog)/i;
let _prefsSuggestCache = { at: 0, data: null };

function readCandCorpus(maxFiles = PREFS_CORPUS_MAX_FILES, maxNonEmpty = PREFS_CORPUS_MAX_NONEMPTY) {
  const dir = path.join(DATA, 'out', 'pick');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^cand-.*\.json$/.test(f)).sort((a, b) => b.localeCompare(a)); }
  catch (e) { return { items: [], scanned: 0, nonEmpty: 0, entries: 0 }; }
  const byBv = new Map();
  let scanned = 0, nonEmpty = 0, entries = 0;
  for (const f of files.slice(0, Math.max(1, maxFiles))) {
    scanned++;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    const list = j && Array.isArray(j.list) ? j.list : [];
    if (!list.length) continue;
    nonEmpty++;
    entries += list.length;
    for (const it of list) {
      const bvid = String((it && it.bvid) || '');
      if (!bvid || byBv.has(bvid)) continue;
      byBv.set(bvid, {
        bvid,
        title: String((it && it.title) || ''),
        tname: String((it && it.tname) || ''),
        tag: String((it && it.tag) || ''),
      });
    }
    if (nonEmpty >= Math.max(1, maxNonEmpty)) break;
  }
  return { items: [...byBv.values()], scanned, nonEmpty, entries };
}

/* GET /api/prefs/suggest：从本机候选里统计「B站相近分区」与「常见标签」 */
function prefsSuggest() {
  const now = Date.now();
  if (_prefsSuggestCache.data && now - _prefsSuggestCache.at < PREFS_SUGGEST_TTL_MS) return _prefsSuggestCache.data;
  const { items, scanned, nonEmpty, entries } = readCandCorpus();
  const tn = new Map(), tg = new Map();
  const good = (s) => s.length >= 2 && s.length <= 12 && !PREFS_BAD_TAG_RE.test(s);
  const addTag = (raw) => {
    const t = String(raw || '').trim();
    if (good(t)) tg.set(t, (tg.get(t) || 0) + 1);
  };
  for (const it of items) {
    const name = String(it.tname || '').trim();
    if (good(name)) tn.set(name, (tn.get(name) || 0) + 1);
    for (const raw of String(it.tag || '').split(/[,，;；]/)) addTag(raw);
  }
  /* 候选里只有少数几个非空 list，光靠它汇总太薄：把已入库行的 tname / extra.tag
     也并进来（同一个 bvid 在 cand 里出现过就不重复计）。 */
  const seenBv = new Set(items.map(it => it.bvid));
  try {
    for (const r of lib.allRows(10000)) {
      if (!r || !r.bvid || seenBv.has(r.bvid)) continue;
      const e = parseExtra(r) || {};
      const name = String(r.tname || e.tname || '').trim();
      if (good(name)) tn.set(name, (tn.get(name) || 0) + 1);
      for (const raw of String(e.tag || '').split(/[,，;；]/)) addTag(raw);
    }
  } catch (e) { /* library 读不到也不影响候选部分的建议 */ }
  const top = (m, key) => [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([k, v]) => (key === 'name' ? { name: k, count: v } : { tag: k, count: v }));
  /* items = 收集到的候选条目数（同一视频会在多天的 cand 文件里重复出现）；去重后的唯一视频数见 corpus */
  const data = { ok: true, scanned, items: entries, nonEmpty, tnames: top(tn, 'name'), tags: top(tg, 'tag') };
  _prefsSuggestCache = { at: now, data };
  return data;
}

const countOcc = (hay, needle) => {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
};
const stripTags = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, '');

/* POST /api/prefs/try：本地即时试搜；live:true 才联网（最多 3 个 query，间隔 2200ms）。
   绝不写盘（不写 config、不写 library、不落候选文件）。 */
async function prefsTry(body = {}) {
  const bad = (msg) => Object.assign(new Error(msg || 'bad-query'), { status: 400, code: 'bad-query' });
  const normList = (v) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw bad();
    if (v.length > 6) throw bad();
    const out = [];
    for (const x of v) {
      const s = String(x == null ? '' : x).trim();
      if (!s || s.length > 30) throw bad();
      out.push(s);
    }
    return out;
  };
  const queries = normList(body.queries);
  const terms = normList(body.terms);
  const live = body.live === true;

  if (live) {
    const rk = (() => { try { return biliLib.riskState(); } catch (e) { return { cooling: false }; } })();
    if (rk && rk.cooling) {
      return { ok: false, error: 'risk-cooling', retryAfterSec: Math.max(1, Math.ceil(((rk.until || Date.now()) - Date.now()) / 1000)) };
    }
    const qs = queries.slice(0, 3);
    const out = [];
    try {
      for (let i = 0; i < qs.length; i++) {
        const q = qs[i];
        const r = await biliLib.api('/x/web-interface/search/type',
          { search_type: 'video', keyword: q, page_size: 20, order: 'click' }, { sign: true });
        const d = (r && r.data) || {};
        const items = Array.isArray(d.result) ? d.result : [];
        out.push({
          q,
          count: Number(d.numResults) || items.length,
          items: items.slice(0, 5).map(it => ({
            bvid: String((it && it.bvid) || ''),
            title: stripTags(it && it.title),
            tname: stripTags((it && (it.typename || it.tname)) || ''),
            tag: stripTags((it && it.tag) || ''),
          })),
        });
        if (i < qs.length - 1) await new Promise(r => setTimeout(r, 2200));
      }
    } catch (e) {
      return { ok: false, error: 'search-failed', detail: String((e && e.message) || e).slice(0, 200) };
    }
    return { ok: true, live: true, queries: out };
  }

  /* 本地分支：cand 语料 + library 已入库行，永不联网 */
  const { items } = readCandCorpus();
  const byBv = new Map(items.map(it => [it.bvid, it]));
  try {
    for (const r of lib.allRows(10000)) {
      if (!r || !r.bvid || byBv.has(r.bvid)) continue;
      const e = parseExtra(r) || {};
      byBv.set(r.bvid, {
        bvid: r.bvid,
        title: String(r.title || ''),
        tname: String(r.tname || e.tname || ''),
        tag: String(e.tag || ''),
      });
    }
  } catch (e) {}
  const corpus = [...byBv.values()];
  const qLower = queries.map(q => q.toLowerCase());
  const tLower = terms.map(t => t.toLowerCase());
  const qCount = queries.map(() => 0);
  const tCount = terms.map(() => 0);
  const hits = [];
  for (const it of corpus) {
    const hay = (it.title + ' ' + it.tname + ' ' + it.tag).toLowerCase();
    const mq = [], mt = [];
    qLower.forEach((q, i) => { if (q && hay.includes(q)) { qCount[i]++; mq.push(queries[i]); } });
    tLower.forEach((t, i) => { const n = countOcc(hay, t); if (n) { tCount[i] += n; mt.push(terms[i]); } });
    if (!mq.length && !mt.length) continue;
    hits.push({ bvid: it.bvid, title: it.title, tname: it.tname, tag: it.tag, matchedQueries: mq, matchedTerms: mt });
  }
  hits.sort((a, b) => b.matchedQueries.length - a.matchedQueries.length || b.matchedTerms.length - a.matchedTerms.length || a.bvid.localeCompare(b.bvid));
  return {
    ok: true, live: false, corpus: corpus.length,
    queries: queries.map((q, i) => ({ q, count: qCount[i] })),
    terms: terms.map((t, i) => ({ t, count: tCount[i] })),
    hits: hits.slice(0, 5),
    hitCount: hits.length, /* v45：命中的候选条数（按 bvid 去重），前端优先用它 */
  };
}

/* ── 归档：ledger.runs 每个 bvid 取最近一次（既有完成时间也有 token/时长） ── */
function archiveRows() {
  /* 契约 8：归档读取时顺手做一次 trash 惰性清理（>600s 的真删） */
  try { sweepTrash(); } catch (e) {}
  const deliveredAll = deliveredMap();
  /* 行状态/来源取 library（ledger.runs 没有 status/via）：一次批量读，别逐条 get */
  const libAll = (() => { try { const m = {}; for (const x of lib.allRows(10000)) m[x.bvid] = x; return m; } catch (e) { return {}; } })();
  const all = runs(3000).map(enrich);
  const done = new Set();
  const rows = [];
  for (const r of all) {
    if (!r.bvid || done.has(r.bvid)) continue;
    /* B3-2：归档只列「真有产物」的条目 —— 先是 BV 号（过滤 pick/_probe 这类临时目录），
       再要求 out/<bv>/cost.json 存在（产物被删/只剩残迹的不再冒充归档行）。 */
    if (!isBv(r.bvid)) continue;
    if (!fs.existsSync(path.join(DATA, 'out', r.bvid, 'cost.json'))) continue;
    done.add(r.bvid);
    const sm = readSummary(r.bvid);
    const g = readGateFile(r.bvid);
    rows.push({
      bvid: r.bvid, title: r.title || '', depth: r.depth || '', at: r.at, at_short: r.at_short, day: r.day,
      /* 前端口径：via=入队来源（点播流判断）、status=库里的状态（含 deleted）、has_artifact=磁盘真实存在 */
      via: (libAll[r.bvid] && libAll[r.bvid].via) || r.via || r.source || '',
      status: libAll[r.bvid] ? libAll[r.bvid].status : null,
      has_artifact: fs.existsSync(path.join(DATA, 'out', r.bvid)),
      dur_sec: r.duration_sec || 0, minutes: r.minutes || 0,
      tokens: r.total_tokens || 0, per_minute: r.per_minute || 0,
      yuan: r.yuan, fen: r.fen, peak: r.peak,
      summary: sm ? (sm.source === 'cloud' ? 'cloud' : 'local') : null,
      sum_state: (function () { const st = sumStateOf(r.bvid, g, sm && sm.source === 'cloud', sm && sm.source === 'local'); return st.state; })(),
      sum_why: (function () { const st = sumStateOf(r.bvid, g, sm && sm.source === 'cloud', sm && sm.source === 'local'); return st.why; })(),
      gate: g ? g.route : null,
      gate_zh: g ? zhOf(g.route) : null,
      has_sheet: !!sheetFile(r.bvid),
      dm_sent: (function () { const m = deliveredAll[r.bvid]; return m && m.dm ? m.dm.sent : false; })(),
      comment_sent: (function () { const m = deliveredAll[r.bvid]; return m && m.comment ? m.comment.sent : false; })(),
    });
  }
  return rows;
}
function archiveList(page = 1, size = 10) {
  const rows = archiveRows();
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page || 1), pages);
  /* v41（B2-2）：缓存徽章四态 —— full=整段视频还在 / partial=只剩抽帧 /
     cleaned=缓存已清（曾经下过）/ never=没下过（cacheStateOf 目前只会给前三种，never 由前端兜底显示）。
     只对当前页补算——cacheStateOf 会扫 cache/video 目录，整张表逐条算太贵。 */
  const pageRows = rows.slice((p - 1) * size, p * size).map(r => ({ ...r, ...archiveBadge(r.bvid) }));
  return { total, page: p, pages, size, rows: pageRows };
}
function archiveNeighbors(bv) {
  const rows = archiveRows();
  const i = rows.findIndex(r => r.bvid === bv);
  const brief = r => (r ? { bvid: r.bvid, title: r.title, day: r.day, at_short: r.at_short } : null);
  return {
    total: rows.length, index: i < 0 ? null : i + 1,
    prev: i > 0 ? brief(rows[i - 1]) : null,
    next: i >= 0 && i < rows.length - 1 ? brief(rows[i + 1]) : null,
  };
}

/* v23：词表权重统一成"有符号"的**唯一规则**——允许负数，polarity 只是显示/兼容字段，
   一律按 weight 的正负重算，避免"滑杆负值 + polarity=pos"这种自相矛盾的数据。
   兼容旧数据/旧前端：polarity==='neg' 且 weight>0 视为负向，取 -|weight|。
   clamp 到 [-1.5, 1.5]（与面板滑杆 range 一致），非数字按 0。
   注意：**读盘也要过这一道**——磁盘上的老数据是 polarity:'neg' + 正幅值，
   不归一的话面板会把负权重显示成正数（v22 的 bug 就是这么来的）。 */
function normalizePrefsWords(obj) {
  const o = obj && typeof obj === 'object' ? { ...obj } : {};
  if (Array.isArray(o.words)) {
    o.words = o.words.map((w) => {
      const x = w && typeof w === 'object' ? { ...w } : {};
      let weight = Number(x.weight);
      if (!Number.isFinite(weight)) weight = 0;
      if (x.polarity === 'neg' && weight > 0) weight = -Math.abs(weight);
      weight = Math.min(1.5, Math.max(-1.5, weight));
      x.weight = weight;
      x.polarity = weight < 0 ? 'neg' : 'pos';
      /* v45：搜索词 queries（可选）—— trim、去空、≤6 个、每个 ≤30 字 */
      if (x.queries !== undefined) {
        const qs = [];
        for (const raw of Array.isArray(x.queries) ? x.queries : []) {
          const s = String(raw == null ? '' : raw).trim();
          if (!s || s.length > 30) continue;
          qs.push(s);
          if (qs.length >= 6) break;
        }
        x.queries = qs;
      }
      return x;
    });
  }
  return o;
}

/* v29：UP 白/黑名单（原来只是弹窗里的演示假数据）。
   存 config/prefs.json 顶层 upWhite / upBlack：字符串数组，匹配用「包含」（忽略空格/标点/大小写）。
   读的时候也走一遍 normalize，保证面板拿到的永远是干净数组。 */
const UP_LIST_MAX = 200;
function normalizeUpList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of v) {
    const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
    if (!s || s.length > 60) continue;
    const k = s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= UP_LIST_MAX) break;
  }
  return out;
}

function readPrefs() {
  try {
    const p = normalizePrefsWords(JSON.parse(fs.readFileSync(path.join(DATA, 'config/prefs.json'), 'utf8')));
    p.upWhite = normalizeUpList(p.upWhite);
    p.upBlack = normalizeUpList(p.upBlack);
    return p;
  } catch (e) { return { error: String(e) }; }
}

function writePrefs(body) {
  const file = path.join(DATA, 'config/prefs.json');
  const dir = path.dirname(file);
  const src = body && typeof body === 'object' ? body : {};
  const next = { ...src, updatedAt: new Date().toISOString() };
  if (Array.isArray(src.words)) next.words = normalizePrefsWords(src).words;
  if (src.upWhite !== undefined) next.upWhite = normalizeUpList(src.upWhite);
  if (src.upBlack !== undefined) next.upBlack = normalizeUpList(src.upBlack);
  // v24 写盘节流（同 writeJsonFile）：内容未变就不写盘/不备份 —— 自动保存会反复推同一份词表
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
  if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
    const a = stableJson(withoutVolatile(prev));
    const b = stableJson(withoutVolatile(next));
    if (a !== null && a === b) return { ok: true, unchanged: true, updatedAt: prev.updatedAt || null, backup: null };
  }
  // 备份：同一分钟只留一个（覆盖），并按 mtime 只保留最近 60 个 *.json
  const bak = path.join(DATA, BACKUP_REL, 'prefs-' + minuteStamp() + '.json');
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, bak);
  // 原子写：tmp + rename
  const tmp = path.join(dir, '.prefs.tmp-' + process.pid);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  // 审计
  const log = path.join(DATA, 'logs/prefs-audit.log');
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), backup: path.basename(bak), words: (next.words || []).length, upWhite: (next.upWhite || []).length, upBlack: (next.upBlack || []).length, source: 'panel' }) + '\n');
  pruneBackupDir(isJsonBackup, BACKUP_KEEP_JSON, 'prefs');
  return { ok: true, updatedAt: next.updatedAt, backup: path.basename(bak) };
}


// ---------- 通用配置文件读写（价目表 / 预算）：备份 + 原子写 + 审计 ----------
function readJsonFile(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8')); }
  catch (e) { return { ...fallback, error: String(e).slice(0, 120) }; }
}

/* ── v24 配置写盘节流（面板改成"改一下就自动保存"后写接口会被高频调用）────────
   1) 内容未变（忽略 updatedAt）→ 直接 {ok:true, unchanged:true}：不写盘、不备份、不审计，
      避免"点一下就多一个备份文件 + 一行审计"；
   2) 备份名带「分钟」而不是毫秒（pacing-2026-11-02T02-40.json）：同一 tag 同一分钟内只留一个，
      后写覆盖前写；
   3) 备份目录按 mtime 只保留最近 N 个（*.json 60 个 / tpl-*.md 40 个），删除时也写一行审计
      {at, tag, prune}。只按文件名形态匹配，不碰目录里别的东西。 */
const BACKUP_REL = 'config/backup';
const BACKUP_KEEP_JSON = 60;
const BACKUP_KEEP_TPL = 40;

/* 稳定 JSON：键排序后再比较，避免前端键序不同被误判成"内容变了" */
function stableValue(v) {
  if (Array.isArray(v)) return v.map(stableValue);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = stableValue(v[k]);
    return o;
  }
  return v;
}
function stableJson(v) { try { return JSON.stringify(stableValue(v)); } catch (e) { return null; } }
function withoutUpdatedAt(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const c = { ...o };
  delete c.updatedAt;
  return c;
}
/* v24：比较"内容是否真的变了"时要同时忽略 updatedAt 与 version —— version 是每次写盘自增的
   修订号，把它算进去等于"永远不相等"，自动保存就会每敲一下就写盘+备份+递增版本号。 */
function withoutVolatile(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const c = { ...o };
  delete c.updatedAt;
  delete c.version;
  return c;
}
/* 分钟级时间戳：2026-11-02T02-40 —— 同一分钟内同名，备份互相覆盖 */
function minuteStamp(d) {
  const iso = (d instanceof Date ? d : new Date()).toISOString();
  return iso.slice(0, 16).replace(/:/g, '-');
}
const isJsonBackup = (n) => /\.json$/i.test(n);
const isTplBackup = (n) => /^tpl-.*\.md$/i.test(n);

/* 备份裁剪：只匹配 isMatch 的文件名，按 mtime 从旧到新删，保留最近 keep 个 */
function pruneBackupDir(isMatch, keep, tag) {
  try {
    const dir = path.join(DATA, BACKUP_REL);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
    const files = [];
    for (const e of ents) {
      if (!e.isFile() || !isMatch(e.name)) continue;
      const fp = path.join(dir, e.name);
      let m = 0;
      try { m = fs.statSync(fp).mtimeMs; } catch (e) { continue; }
      files.push({ fp, m });
    }
    if (files.length <= keep) return 0;
    files.sort((a, b) => a.m - b.m);
    let removed = 0;
    for (const f of files.slice(0, files.length - keep)) {
      try { fs.unlinkSync(f.fp); removed++; } catch (e) {}
    }
    if (removed > 0) {
      try {
        fs.appendFileSync(path.join(DATA, 'logs/config-audit.log'),
          JSON.stringify({ at: new Date().toISOString(), tag, prune: removed }) + '\n');
      } catch (e) {}
    }
    return removed;
  } catch (e) { return 0; }
}

function writeJsonFile(rel, body, tag) {
  const file = path.join(DATA, rel);
  const next = { ...body, updatedAt: new Date().toISOString() };
  // ① 内容未变 → 不落盘（自动保存最常见的就是这种：debounce 后又推一遍同样的值）
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
  if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
    const a = stableJson(withoutVolatile(prev));
    const b = stableJson(withoutVolatile(next));
    if (a !== null && a === b) {
      return { ok: true, unchanged: true, updatedAt: prev.updatedAt || null, backup: null };
    }
  }
  // ② 备份：同一 tag 同一分钟内只留一个文件（后写覆盖前写）
  const bak = path.join(DATA, BACKUP_REL, tag + '-' + minuteStamp() + '.json');
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, bak);
  // ③ 原子写 + 审计 + 裁剪
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  fs.appendFileSync(path.join(DATA, 'logs/config-audit.log'),
    JSON.stringify({ at: next.updatedAt, tag, backup: path.basename(bak), keys: Object.keys(body) }) + '\n');
  pruneBackupDir(isJsonBackup, BACKUP_KEEP_JSON, tag);
  return { ok: true, updatedAt: next.updatedAt, backup: path.basename(bak) };
}

// ---------- 总结/话术模板（.md）：备份 + 原子写 + 审计 ----------
const TPL_DIR = 'config/templates';
const TPL_ALLOW = new Set(['summary.md', 'comment.md', 'dm.md', 'why.md']);

function tplList() {
  const dir = path.join(DATA, TPL_DIR);
  /* v26：按白名单列（而不是只列目录里已有文件）——why.md 可能还没建，面板也要能编辑它 */
  const out = [];
  for (const name of TPL_ALLOW) {
    const f = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(f); } catch (e) { st = null; }
    out.push({
      name, file: name, kind: name.replace(/\.md$/, ''), exists: !!st,
      bytes: st ? st.size : 0,
      updatedAt: st ? st.mtime.toISOString() : null,
      mtime: st ? st.mtime.toISOString() : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readTpl(name) {
  if (!TPL_ALLOW.has(name)) throw new Error('未知模板: ' + name);
  const f = path.join(DATA, TPL_DIR, name);
  if (!fs.existsSync(f)) return { name, text: '', missing: true };
  return { name, text: fs.readFileSync(f, 'utf8') };
}

function writeTpl(name, text) {
  if (!TPL_ALLOW.has(name)) throw new Error('未知模板: ' + name);
  const body = String(text == null ? '' : text);
  if (!body.trim()) throw new Error('模板内容不能为空');
  if (body.length > 20000) throw new Error('模板太长（上限 20000 字符）');
  const file = path.join(DATA, TPL_DIR, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // ① 内容未变 → 不写盘、不备份（自动保存会把同一份模板重复提交）
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { cur = null; }
  if (cur !== null && cur === body) {
    return { ok: true, unchanged: true, name, bytes: Buffer.byteLength(body), backup: null };
  }
  // ② 备份：同一分钟只留一个 tpl-<name>-<minute>.md
  const bak = path.join(DATA, BACKUP_REL, 'tpl-' + name.replace(/\.md$/, '') + '-' + minuteStamp() + '.md');
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, bak);
  // ③ 原子写 + 审计 + 裁剪（模板备份只保留最近 40 个）
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  fs.appendFileSync(path.join(DATA, 'logs/config-audit.log'),
    JSON.stringify({ at: new Date().toISOString(), tag: 'template', name, bytes: Buffer.byteLength(body), backup: path.basename(bak) }) + '\n');
  pruneBackupDir(isTplBackup, BACKUP_KEEP_TPL, 'template');
  return { ok: true, name, bytes: Buffer.byteLength(body), backup: path.basename(bak) };
}

const TPL_DEFAULT = (name) => fs.existsSync(path.join(DATA, TPL_DIR, name)) ? fs.readFileSync(path.join(DATA, TPL_DIR, name), 'utf8') : '';

/* ══ v26：缓存/存储 · 判否说明（why） · 人设预览 ═════════════════════════════════
   用户要求（2026-11-02）：删归档可批量、缓存可清（宫格图与总结永不自动删）、
   判否说明由本地模型写（云端链路绝不调用本地模型）、预览要真渲染当前人设。
   真源都在 Lead 的 lib：cache.mjs / persona-text.mjs / templates.mjs / copy.mjs —— 这里只做 HTTP 编排。 */
const BV_OK_RE = /^BV[0-9A-Za-z]{6,14}$/;
function isBv(v) { return BV_OK_RE.test(String(v == null ? '' : v)); }

/** 读 out/<bv>/why.local.json（本地判否说明）。返回 {state:'ok'|'error'|null, at, error, doc}
    why.mjs 的产物形状：{at,bv,route,routeZh,model,endpoint,personaKey,ms,tokens,reasons[],couldBe[],material{},error?:{code,zh,message}} */
function readWhy(bv) {
  const fp = path.join(DATA, 'out', String(bv), 'why.local.json');
  let raw = null;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { return { state: null, at: null, error: null, doc: null }; }
  let doc = null;
  try { doc = JSON.parse(raw); } catch (e) { return { state: 'error', at: null, error: '判否说明文件不是合法 JSON，重新生成即可', doc: null }; }
  const err = doc && doc.error && typeof doc.error === 'object' ? doc.error : null;
  if (err) {
    const zh = String(err.zh || err.message || err.code || '本地模型不可用').slice(0, 140);
    return { state: 'error', at: doc.at || null, error: zh, doc };
  }
  return { state: 'ok', at: (doc && doc.at) || null, error: null, doc };
}

/** 归档行补「缓存徽章 + 判否说明状态」字段（只给当前页算，避免整表扫盘） */
function archiveBadge(bv) {
  const cs = cacheStateOf(bv);
  const w = readWhy(bv);
  return {
    cache_state: cs.state, cache_video: cs.video, cache_frames: cs.frames, cache_video_bytes: cs.videoBytes,
    why_state: w.state, why_at: w.at, why_error: w.error,
  };
}

/** logs/cache-sweep.json（最近一次清理结果）——没有就 null */
function readSweepLog() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(DATA, 'logs', 'cache-sweep.json'), 'utf8'));
    if (!o || typeof o !== 'object') return null;
    return { at: o.at || null, keepDays: o.keepDays == null ? null : o.keepDays, freed: Number(o.freed) || 0, videos: Number(o.videos) || 0, frames: Number(o.frames) || 0, orphans: Number(o.orphans) || 0 };
  } catch (e) { return null; }
}

/** 投递账号显示名（config/push.json 第一个启用的账号）；读不到就用占位名 */
function pushAccountName() {
  const t = pushTarget();
  const n = t && typeof t.name === 'string' ? t.name.trim() : '';
  return n || '推送账号';
}

/** 存储设置 + 占用 + 最近一次清理 + 磁盘剩余 */
function storagePayload() {
  let disk = null;
  try {
    const st = fs.statfsSync(DATA);
    if (st && Number(st.bsize) > 0) {
      disk = { freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
    }
  } catch (e) { disk = null; }
  return { ok: true, config: readStorage(), usage: cacheUsage(), lastSweep: readSweepLog(), disk };
}

const STORAGE_MODES = new Set(['keep', 'drop-video', 'drop-cache']);
/** 写 config/storage.json（校验后走 writeJsonFile：config/backup 备份 + 原子写 + 审计） */
function writeStorage(body) {
  const b = body && typeof body === 'object' ? body : {};
  const cur = readStorage();
  const next = { ...cur };
  if (b.keepDays !== undefined) {
    const v = Number(b.keepDays);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 365) throw new Error('保留天数必须是 0–365 之间的整数（0 = 每次清理都清）');
    next.keepDays = v;
  }
  if (b.afterDone !== undefined) {
    const m = String(b.afterDone == null ? '' : b.afterDone);
    if (!STORAGE_MODES.has(m)) throw new Error('跑完后只能是 keep（不清理）/ drop-video（删视频）/ drop-cache（删视频+帧）');
    next.afterDone = m;
  }
  if (b.sweepOnDone !== undefined) next.sweepOnDone = b.sweepOnDone === true || b.sweepOnDone === 'true';
  next.version = (Number(cur.version) || 1) + 1;
  const r = writeJsonFile('config/storage.json', next, 'storage');
  return { ok: true, config: readStorage(), backup: (r && r.backup) || null, unchanged: !!(r && r.unchanged) };
}

/** 立即清过期缓存。dry=true 只回报策略与占用，不动任何文件（sweep() 会真删，没法干跑） */
function runCacheSweep(dry) {
  const cfg = readStorage();
  const before = cacheUsage();
  if (dry) return { ok: true, dry: true, config: cfg, usage: before, lastSweep: readSweepLog() };
  const r = cacheSweep(cfg);
  try {
    const fp = path.join(DATA, 'logs', 'cache-sweep.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = fp + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...r, policy: { keepDays: cfg.keepDays, afterDone: cfg.afterDone, sweepOnDone: cfg.sweepOnDone } }, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    fs.appendFileSync(path.join(DATA, 'logs', 'config-audit.log'),
      JSON.stringify({ at: new Date().toISOString(), tag: 'cache-sweep', freed: r.freed, videos: r.videos, frames: r.frames, orphans: r.orphans }) + '\n');
  } catch (e) { /* 日志写失败不影响清理结果 */ }
  try { emitEvent('cache.swept', { freed: r.freed, videos: r.videos, frames: r.frames, orphans: r.orphans }); } catch (e) {}
  return { ok: true, dry: false, result: r, usage: cacheUsage(), lastSweep: readSweepLog() };
}

/** 批量删归档：产物 + 视频缓存 + 帧图一起删；dropRecords=true 才把已看库记录置 deleted（默认保留，保住去重） */
function archiveDelete(body) {
  const b = body && typeof body === 'object' ? body : {};
  const want = Array.isArray(b.bvids) ? b.bvids : [];
  const bvids = Array.from(new Set(want.map(v => String(v == null ? '' : v)).filter(isBv))).slice(0, 200);
  /* B5：没有有效 bv、或全部查无产物/记录 → 404 not-found（别回 200 空操作） */
  const has = (bv) => { try { return fs.existsSync(path.join(DATA, 'out', bv)) || !!lib.get(bv); } catch (e) { return false; } };
  const alive = bvids.filter(has);
  if (!bvids.length || !alive.length) throw Object.assign(new Error('not-found'), { status: 404 });
  const dropRecords = b.dropRecords === true;
  const removed = [], failed = [];
  let freed = 0;
  for (const bv of bvids) {
    try {
      /* A5-03：不真删，先移进 out/.trash —— 5 秒内撤销能把产物移回（/api/queue/restore） */
      const r = trashBv(bv);
      freed += Number(r && r.freed) || 0;
      if (dropRecords) lib.setStatus(bv, 'deleted', 'archive-delete');
      removed.push(bv);
    } catch (e) {
      failed.push({ bv, error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  try { emitEvent('archive.delete', { count: removed.length, freed, dropRecords }); } catch (e) {}
  return { ok: true, removed, failed, freed, dropRecords };
}

/** 后台重跑本地判否说明（scripts/why.mjs）。detached + stdio ignore：子进程崩了也不影响响应 */
function spawnWhyRebuild(bv) {
  const script = path.join(CODE, 'scripts', 'why.mjs');
  if (!fs.existsSync(script)) return { ok: false, started: false, error: '缺少 scripts/why.mjs' };
  try {
    /* --force：why.mjs 默认「已有产物就跳过」，而「重试」恰恰是要覆盖上一次的 error 记录 */
    spawn(NODE_EXE, [script, '--bv=' + bv, '--force'], { cwd: CODE, detached: true, stdio: 'ignore', windowsHide: true, env: CHILD_ENV })
      .unref();
    return { ok: true, started: true, bv };
  } catch (e) {
    return { ok: false, started: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

/* 人设预览用的内置样例（契约 3.5 原文；bvid 给了且有云端总结时用真数据替换） */
const SAMPLE_FACTS = {
  bv: 'BV1xx411c7mD', title: '5 分 43 秒的装系统教程', dur: '05:43', cells: 12, mark: '02:56', dmHot: null, ocrCount: 3, dmN: 6,
  summary: {
    verdict: '值得看', gist: '不用 PE，改用微软官方工具做干净 U 盘。',
    bullets: ['用微软官方的媒体创建工具做系统 U 盘，而不是网上那些 PE 镜像站。', '准备一个 ≥16G 的 U 盘，制作过程会清空资料。'],
    mark: '02:56', caveat: '未复测官网入口位置。',
  },
  facts: ['02:16 64mm平刀盘', '03:16 37℃温控'], brief: [],
};

/** 预览素材：优先该 bv 的真实云端总结（summary.cloud.json），否则内置样例 */
function previewFacts(bv) {
  const b = isBv(bv) ? String(bv) : '';
  if (!b) return { facts: SAMPLE_FACTS, real: false };
  const fp = path.join(DATA, 'out', b, 'summary.cloud.json');
  let sm = null;
  try { sm = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { sm = null; }
  if (!sm) return { facts: { ...SAMPLE_FACTS, bv: b }, real: false };
  let row = null;
  try { row = lib.get(b); } catch (e) { row = null; }
  const sec = Number(row && row.dur_sec) || 0;
  const dur = sec > 0 ? String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0') : SAMPLE_FACTS.dur;
  return { facts: { ...SAMPLE_FACTS, bv: b, title: (row && row.title) || SAMPLE_FACTS.title, dur, summary: sm }, real: true };
}

/**
 * v30：人设「实时样例」预览。
 * v26–v29 这里只是把「它会读到的规则」贴出来，用户看到的是一堆提示词，所以永远显得生硬；
 * 现在改成**真跑一次本地模型**（config/summarize.json 的 baseUrl/model，默认 ollama）：用与正式生成
 * 同一套 prompt（模板硬规矩 + 人设语气块 + 表达格式六旋钮）对样例材料现写一条，直接看成品口吻。
 * 模型不可用时回退到「规则拼装版」，并在 note 里写明「不代表真实生成效果」。
 * body: { target?: 'summary'|'comment'|'dm', bv?: string, useModel?: boolean }
 */
async function personaPreview(body) {
  const b = body && typeof body === 'object' ? body : {};
  const target = String(b.target == null ? '' : b.target);
  if (!['summary', 'comment', 'dm'].includes(target)) throw new Error('target 只能是 summary / comment / dm');
  const p0 = readPersonaLib();
  const shape = (() => { try { return normalizeShape(readShape()); } catch (e) { return Object.assign({}, SHAPE_DEFAULT); } })();
  /* v55：预览可临时指定结构（body.structure）——只影响这一次预览，不写配置、不重载插件。
     配合 body.json=true 走「按字段生成 → buildDm 渲染」，看到的就是真正会发出去的那条私信。 */
  const wantJson = b.json === true && target === 'dm';
  const structOverride = String(b.structure || '').trim();
  const p = (wantJson && structOverride && structureKeys().includes(structOverride))
    ? Object.assign({}, p0, { format: Object.assign({}, p0.format || {}, { structure: structOverride }) })
    : p0;
  /* C-EXTRA-2 / 契约 5：预览里的评论开头统一用「正式投递账号」的名字（config/push.json 第一个 enabled 的 name），
     不再用人设里的称呼 —— 用户要看到的就是真会发出去的那条。 */
  const targetName = (() => { try { return pushAccountName(); } catch (e) { return '推送账号'; } })();
  const base = {
    target,
    targetName,
    shape,
    personaKey: personaKey(p),
    personaSummary: personaSummary(p),
    personaText: personaText(p),
    format: formatInfo(p, shape),
    rules: target === 'summary' ? summaryRulesText(personaPromptBlock(p, shape)) : '',
  };

  /* ── v34：预览改成「直连模型的一次短调用」 ──
     用户 m04960：「生成一条 2 毛钱太贵了」。
     病根：v33 的预览走 `__vdCloud`（把指示投给摘要工人会话）——那个会话的历史已经涨到 38 MB
     ≈160 万 token，每问一句都要把整段历史重新计费一遍，再加「读两个文件 + 调一次工具」两三轮，
     一次预览实扣 0.09–0.17 元（DSH 账本核对过）。
     现在：优先用插件挂的 `__vdLlm.quick()`（ctx.llm.stream，官方插件 API）——材料内联、单轮、
     无历史、无工具循环，输入几千 token、输出几百 token，一次约 0.003–0.006 元。
     旧会话通路保留但需显式 body.engine === 'session'（贵，只做对照用）；再不行退本地 8B（免费）。
     另外加 10 分钟结果缓存：同一条样例 + 同一套人设/格式，连点两次第二次直接复用，0 元。 */
  const wantLocal = b.engine === 'local';
  const wantSession = b.engine === 'session';
  /* C8-4：接受 bv 与 bvid 两个参数名（老前端/插件发 bvid，新前端发 bv） */
  const bvIn = String(b.bv || b.bvid || '');
  const sampleBv = /^BV[0-9A-Za-z]{10}$/.test(bvIn) ? bvIn : pickRecentDelivered();
  const mat = sampleMaterial(sampleBv);
  /* v56：auto 档在预览里也要落成具体一档 —— payload 与说明显示真正生效的结构，模型拿到的也是它 */
  const stResolved = wantJson
    ? personaTextExt.resolveStructure(formatInfo(p, shape).structure, String((mat && mat.facts && mat.facts.title) || ''), '')
    : ''
  if (stResolved) base.format = formatInfo(personaTextExt.withStructure(p, stResolved), shape)
  /* C-EXTRA-1 / 契约 5：cacheKey 必须含 personaGenKey（人设内容+表达格式），否则改了人设还在复用旧结果；
     engineMode 进 key —— 直连 / 本地 / 会话三种通路的结果不能互相复用。 */
  const engineMode = wantSession ? 'session' : wantLocal ? 'local' : 'auto';
  const cacheKey = [target, engineMode, sampleBv, personaGenKey(p, shape), JSON.stringify(formatInfo(p, shape)), JSON.stringify(shape),
    wantJson ? 'json' : 'text',
    /* v56：预览缓存跨 handler 重载存活（globalThis），改了渲染/裁剪口径必须换 tag，否则会复用旧结果 */
    'pv56-json-5',
    String((mat && mat.facts && mat.facts.gist) || '').length, String((mat && mat.facts && mat.facts.mark) || '')].join('|');
  const CACHE = (globalThis.__vdPreviewCache = globalThis.__vdPreviewCache || new Map());
  /* C3-2：10 分钟结果缓存对 local/fallback 也生效（以前只有直连复用，本地每次重跑）。
     会话通路（engine='session'）是显式对照、按次计费，不复用。 */
  const CACHE_TTL_MS = 600 * 1000;
  const cached = CACHE.get(cacheKey);
  if (!wantSession && cached && cached.payload && Date.now() - cached.at < CACHE_TTL_MS) {
    const age = Math.max(0, Math.round((Date.now() - cached.at) / 1000));
    return { ...cached.payload, ...base, cached: true, cacheAgeSec: age,
      engineNote: '复用 ' + age + ' 秒前那次结果（同一套人设/格式与样例，10 分钟内不重跑、不再花钱）' };
  }

  let cloudNote = '';
  if (!wantLocal && !wantSession) {
    const direct = globalThis.__vdLlm;
    if (direct && (typeof direct.quick === 'function' || typeof direct.gen === 'function')) {
      try {
        /* v35：system 段（人设+形态+铁律）与 user 段（这条视频的材料）分开送 —— 稳定前缀才能吃到提示词缓存 */
        /* C-EXTRA-2：targetName 透传给 sample.mjs（评论开头用正式投递账号名，不再是人设里的称呼） */
        const parts = buildSampleParts(target, mat.facts, p, shape, wantJson ? { targetName, json: true } : targetName);
        const r = (typeof direct.gen === 'function')
          ? await direct.gen({ system: parts.system, user: parts.user, maxTokens: parts.maxTokens, purpose: 'preview', target, bv: sampleBv })
          : await direct.quick(parts.system + '\n\n' + parts.user);
        if (r && r.ok && r.text) {
          /* v55：结构化通路 —— 先解析字段，再由 buildDm 渲染成「真会发出去」的那条私信。
             不让模型自由排版：自由排版正是「技术细节被压成三句、评估没有落点」的来源。 */
          if (wantJson && !parseDmJson(r.text)) {
            return {
              ok: false, cached: false, cacheAgeSec: 0, ...base,
              sample: !!(mat && mat.real), engine: 'direct', source: 'direct',
              engineNote: '模型这次没有按 JSON 契约回答（拿到的是自然段）—— 本次预览作废，重试一次即可',
              model: r.model || '', bv: sampleBv,
              raw: String(r.text || '').slice(0, 600),
              text: '', jsonMode: true, error: 'json_parse_failed',
            };
          }
          let text;
          let clipped = false;
          let measure = null;
          let fields = null;
          if (wantJson) {
            fields = parseDmJson(r.text);
            let dm = buildDm({ bv: sampleBv, title: (mat && mat.facts && mat.facts.title) || '', summary: fields }, { persona: p });
            dm = scrubInternalWords(String(dm || '').trim());
            try { dm = enforceParticles(dm, particleWhitelist(p)); } catch (e) {}
            try { dm = scrubAnalysisLeak(dm); } catch (e) {}
            const fit = fitPreviewText(dm, 'dm', shape, { targetName });
            text = fit.text; clipped = fit.clipped; measure = fit.measure;
          } else {
            text = scrubInternalWords(String(r.text).trim());
            try { text = enforceParticles(text, particleWhitelist(p)); } catch (e) {}
            /* v53（契约 §4）：预览=投递 —— 展示文本在 fitPreviewText 之前再洗一遍取证腔/缺陷说明 */
            try { text = scrubAnalysisLeak(text); } catch (e) {}
            /* v37：模型不一定守篇幅契约 —— 预览也照正式投递的口径硬截断，超了就裁到上限并标记 */
            const fit = fitPreviewText(text, target, shape, { targetName });
            text = fit.text; clipped = fit.clipped; measure = fit.measure;
          }
          const u = r.usage || {};
          const inTok = Number(u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? 0) || 0;
          const outTok = Number(u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? 0) || 0;
          const pr = readPricing();
          /* 按「输入全部未命中缓存」算上限（实际大多有命中，只会更便宜） */
          const yuan = (inTok + outTok) ? +(((inTok * (pr.inMiss || 1)) + (outTok * (pr.out || 4))) / 1e6).toFixed(6) : null;
          /* C5-3：篇幅上限按 target 取对应旋钮（评论 40 / 私信 860 / 总结 900），不再恒写 summaryMax */
          const lim = target === 'comment' ? shape.commentMax : target === 'dm' ? shape.dmMax : shape.summaryMax;
          const limZh = target === 'comment' ? '评论' : target === 'dm' ? '私信' : '总结';
          const costNote = '思考档 ' + (r.effort || '默认') + ' · 输出上限 ' + (r.maxTokens || 0) + ' token · 篇幅上限 ' + lim + ' 字（' + limZh + '）';
          const payload = {
            ok: true,
            cached: false,
            cacheAgeSec: 0,
            sample: !!(mat && mat.real),
            engine: 'direct',
            engineNote: yuan != null
              ? ('直连模型一次调用：输入 ' + inTok + ' / 输出 ' + outTok + ' token ≈ ' + yuan.toFixed(4) + ' 元（上限）；' + costNote)
              : ('直连模型一次调用（不经过工作会话）；' + costNote),
            source: 'direct',
            model: r.model || '',
            endpoint: r.provider || 'llm',
            ms: r.ms || 0,
            tokens: { input: inTok, output: outTok },
            costYuan: yuan,
            effort: r.effort || '',
            maxTokens: r.maxTokens || 0,
            text,
            note: wantJson
              ? '结构化通路：模型按字段写，正文由 buildDm 渲染（与正式投递同一版式）；前 4 条要点才会进私信，末句判断在「我的评估」里。'
              : '直连模型按当前人设现写的样例；改人设后再点一次会变（10 分钟内同设置会复用上次结果）。',
            bv: sampleBv,
            clipped,
            jsonMode: !!wantJson,
            fields: fields || null,
            structure: stResolved || formatInfo(p, shape).structure,
            hint: wantJson
              ? '这是「按字段生成 → buildDm 渲染」的试验预览：看到的就是私信正文，改结构只影响这次预览，不写配置。'
              : '这份样例用「最近一条已投递的视频」的真实材料写成，和正式总结走同一套人设与格式；不经过工作会话，所以便宜。',
          };
          /* v37：把「实际字数 / 硬上限 / 软目标」一起回给面板，让用户看得见有没有达标 */
          payload.measure = measure;
          CACHE.set(cacheKey, { at: Date.now(), payload });
          /* v36：预览的这笔钱由面板自己记账（插件那份账只记会话投递，避免重复计） */
          try {
            appendSpend({ kind: 'preview', bv: sampleBv, target, model: r.model || '', input: inTok, output: outTok, yuan: yuan || 0, source: 'usage', via: 'panel' });
          } catch (e) {}
          return { ...payload, ...base };
        }
        cloudNote = (r && r.error && (r.error.zh || r.error.code)) || '直连模型没有返回正文';
      } catch (e) {
        cloudNote = String((e && e.message) || e);
      }
    } else {
      cloudNote = '直连模型桥没装载（插件是旧版本，重启 DSH 后可用）';
    }
  }

  if (wantSession) {
    const bridge = globalThis.__vdCloud;
    if (bridge && typeof bridge.preview === 'function') {
      try {
        const r = await bridge.preview({ target, bv: sampleBv });
        if (r && r.ok && r.text) {
          /* C4-6：预览要等于投递 —— 与正式写盘走同一层语气清洗 */
          /* v53：会话通路同样洗取证腔（cleanPreviewParticles 之后、fitPreviewText 之前） */
          const sText = scrubAnalysisLeak(cleanPreviewParticles(scrubInternalWords(r.text), p));
          const fit = fitPreviewText(sText, target, shape, { targetName });
          return {
            ok: true,
            cached: false,
            cacheAgeSec: 0,
            ...base,
            sample: !!sampleBv,
            engine: 'cloud',
            engineNote: '⚠️ 走的是工作会话（贵，一次约 0.1 元），只在对照时用',
            source: 'cloud',
            model: r.model || 'deepseek-flash (session)',
            endpoint: 'dsh-session',
            ms: r.ms || 0,
            tokens: null,
            text: fit.text,
            clipped: fit.clipped,
            measure: fit.measure,
            note: '云端工作会话写的样例（贵）。日常请用默认的直连模式。',
            bv: sampleBv,
            hint: '这条通路会把整段会话历史重新计费，成本约是直连的 20–40 倍。',
          };
        }
        cloudNote = (r && r.error && (r.error.zh || r.error.code)) || '工作会话没有返回正文';
      } catch (e) {
        cloudNote = String((e && e.message) || e);
      }
    } else {
      cloudNote = '会话预览桥没装载（插件是旧版本，重启 DSH 后可用）';
    }
  }

  /* C-EXTRA-2：targetName 一并透传（sample.mjs 的 prompt 里用它 @ 账号） */
  const gen = await generateSample({ target, bv: sampleBv, useModel: b.useModel !== false, targetName });
  const engine = gen.source === 'model' ? 'local' : 'fallback';
  /* C5-2：engineNote/hint 必须按引擎三分支说真话 —— fallback 时不能说「已退回本地 8B」
     （本地 8B 也不可用，给的是规则拼装示例）。 */
  /* 判据必须是「实际引擎」而不是「用户点的是不是本地」：点了本地但模型不可用时，
     实际引擎是 fallback，仍然不能说「本地 8B 写的样例」。 */
  const engineNote = engine === 'fallback'
    ? ('云端不可用（' + cloudNote + '），本地 8B 也不可用 —— 下面是规则拼装的回退示例（不是模型写的，只看版式）。')
    : wantLocal
      ? '本地 8B 模型写的样例（免费，不花钱；口吻和云端有差距）。'
      : ('云端不可用（' + cloudNote + '），已用本地 8B 现写（免费，口吻和云端有差距）。');
  const hint = engine === 'fallback'
    ? '规则拼装的回退示例：只能看版式与篇幅，不代表真实生成口吻；等直连或本地模型可用再看一次。'
    : '本地 8B 写的样例（免费，口吻和云端有差距）；改人设或表达格式会立刻变（10 分钟内同设置会复用）。';
  /* C4-6：预览要等于投递 —— 本地/回退样例也过同一层语气清洗（否则用户改完口头禅，
     预览里还留着旧词，正是「改了没生效」的观感来源） */
  const fit = fitPreviewText(scrubAnalysisLeak(cleanPreviewParticles(scrubInternalWords(gen.text || ''), p)), target, shape, { targetName });
  const payload = {
    ok: gen.ok !== false,
    cached: false,
    cacheAgeSec: 0,
    ...base,
    sample: gen.real,
    engine,
    engineNote,
    source: gen.source,
    model: gen.model || '',
    endpoint: gen.endpoint || '',
    ms: gen.ms || 0,
    tokens: gen.tokens || null,
    text: fit.text,
    clipped: fit.clipped,
    measure: fit.measure,
    note: gen.note || '',
    error: gen.error || null,
    bv: gen.bv || '',
    hint,
  };
  /* C3-2：local / fallback 结果也进 10 分钟缓存（成功才缓存；失败每次都该重试） */
  if (gen.ok !== false) CACHE.set(cacheKey, { at: Date.now(), payload });
  return payload;
}

function readPricing() {
  /* v48：读不到/坏 JSON 时的兜底必须带 peakHours + peakDays（谷时唯一真源；不要改这里的高峰定义） */
  return readJsonFile('config/pricing.json', {
    inMiss: 1, inHit: 0.02, out: 4,
    peakMultiplier: 2,
    peakHours: [['09:00', '12:00'], ['14:00', '18:00']],
    peakDays: [1, 2, 3, 4, 5],
  });
}

/* 今日 / 本周 / 本月已花（元）。峰谷按 pricing.peakHours 判断，输出按 500 token 估。 */
// 互关名单：followings ∩ fans（各一次请求；缓存 6 小时）。互关是私信通道的前提。
let mutualCache = { at: 0, list: [] };
async function mutualList(force) {
  if (!force && Date.now() - mutualCache.at < 6 * 3600e3) return mutualCache;
  const mid = Number(readJsonFile('secrets/bili.json', {}).dede_user_id || 0);
  if (!mid) throw new Error('secrets/bili.json 缺 dede_user_id');
  const [fol, fan] = await Promise.all([
    biliGet('https://api.bilibili.com/x/relation/followings?vmid=' + mid + '&pn=1&ps=50'),
    biliGet('https://api.bilibili.com/x/relation/fans?vmid=' + mid + '&pn=1&ps=50'),
  ]);
  const fl = (fol.code === 0 && fol.data && fol.data.list) || [];
  const fs2 = (fan.code === 0 && fan.data && fan.data.list) || [];
  const fanMap = new Map(fs2.map(x => [Number(x.mid), x]));
  const list = fl.filter(x => fanMap.has(Number(x.mid))).map(x => ({
    uid: Number(x.mid),
    name: x.uname || ('uid ' + x.mid),
    sign: String(x.sign || '').slice(0, 40),
    face: String(x.face || ''),
    mutual: true,
  }));
  mutualCache = { at: Date.now(), list };
  return mutualCache;
}

function readPush() {
  const c = readJsonFile('config/push.json', null);
  if (!c || !Array.isArray(c.accounts)) throw new Error('config/push.json 缺失或格式不对');
  return c;
}

// 每个推送账号补上：昵称（缺失时反查）、是否互关（决定私信通道是否可用）、本周已发条数
const relCache = new Map();
function dmWeekCounts() {
  const map = new Map();
  const db = openOutbound();
  if (!db) return map;
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
    const rows = db.prepare("SELECT target_uid, COUNT(*) n FROM posts WHERE kind='dm' AND sent=1 AND at>=? GROUP BY target_uid").all(since);
    for (const r of rows) map.set(String(r.target_uid), Number(r.n) || 0);
  } catch (e) {} finally { try { db.close(); } catch (e) {} }
  return map;
}
async function pushDetail() {
  const c = readPush();
  const opMid = Number(readJsonFile('secrets/bili.json', {}).dede_user_id || 0);
  const weekCounts = dmWeekCounts();
  const accounts = [];
  for (const a of c.accounts) {
    let uname = a.name || unameCache.get(a.uid) || '';
    let mutual = null;
    const hit = relCache.get(a.uid);
    if (hit && Date.now() - hit.at < 6 * 3600e3) mutual = hit.mutual;
    else {
      try {
        const r = await biliGet('https://api.bilibili.com/x/relation?fid=' + a.uid);
        if (r.code === 0 && r.data) {
          mutual = Number(r.data.attribute) === 6;
          if (!uname && r.data.uname) uname = r.data.uname;
          relCache.set(a.uid, { mutual, at: Date.now() });
        }
      } catch {}
    }
    if (!uname) {
      try {
        const r = await biliGet('https://api.bilibili.com/x/web-interface/card?mid=' + a.uid);
        if (r.code === 0 && r.data && r.data.card) { uname = r.data.card.name; unameCache.set(a.uid, uname); }
      } catch {}
    }
    accounts.push({ ...a, uname: uname || ('uid ' + a.uid), mutual, dmAvailable: mutual === true, lastWeek: weekCounts.get(String(a.uid)) || 0 });
  }
  return {
    version: c.version, updatedAt: c.updatedAt, guard: c.guard, accounts,
    shape: normalizeShape(c.shape),
    operator: {
      uid: opMid || null,
      name: opMid ? (unameCache.get(opMid) || 'B站账号') : null,
      note: '持 cookie 的那个号：它去刷、去看、去发。推送账号只存 uid+昵称。',
    },
  };
}

// v33：投递形态（评论信息核上限 / 私信长度上限）——从「账号与推送」假卡搬到个性化页后必须能真存。
// v36：新增 summaryMax（总结字数上限，用户 m05320）——它同时是 formatText 里「篇幅」的唯一真源。
// copy.mjs 的 buildComment/buildDm 直接读 config/push.json 的 shape，这里只负责校验与落盘。
const SHAPE_DEFAULT = { commentMax: 40, dmMax: 860, summaryMax: 900 };
/* v37：上限按用户设置执行（不再夹自设保守线）；dm 的 860 是 B 站 21007 平台硬限 */
const SHAPE_LIMITS = { commentMin: 20, commentMax: 200, dmMin: 200, dmMax: 860, summaryMin: 200, summaryMax: 2000 };
function normalizeShape(v) {
  const s = v && typeof v === 'object' ? v : {};
  const clamp = (x, lo, hi, dflt) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  return {
    commentMax: clamp(s.commentMax, SHAPE_LIMITS.commentMin, SHAPE_LIMITS.commentMax, SHAPE_DEFAULT.commentMax),
    dmMax: clamp(s.dmMax, SHAPE_LIMITS.dmMin, SHAPE_LIMITS.dmMax, SHAPE_DEFAULT.dmMax),
    summaryMax: clamp(s.summaryMax, SHAPE_LIMITS.summaryMin, SHAPE_LIMITS.summaryMax, SHAPE_DEFAULT.summaryMax),
  };
}

/** C6-5：把文本硬裁到 hardMax 以内 —— 先给 '…' 留一格（裁到 hardMax-1）再拼单个 '…'，
 *  最终长度一定 ≤ hardMax（旧版先裁 n 再拼 9 字后缀，实测会超到 n+9）。
 *  opts.punct 给了就在标点处断开（回退点不低于可用长度的 60%），避免把词/句切断。 */
function clipToHard(text0, hardMax, opts = {}) {
  const chars = [...String(text0 || '')];
  const n = Math.max(2, Math.round(Number(hardMax) || 1));
  if (chars.length <= n) return { text: chars.join('').trim(), clipped: false };
  const room = n - 1;                     // 最后一格留给 '…'
  let head = chars.slice(0, room).join('');
  if (opts.punct && opts.punct.length) {
    let cut = -1;
    for (const p of opts.punct) {
      const i = head.lastIndexOf(p);
      if (i + 1 >= Math.floor(room * 0.6)) cut = Math.max(cut, i + 1);
    }
    if (cut > 0) head = head.slice(0, cut);
  }
  let out = head.replace(/[，、；：,;:\s]+$/, '').trim();
  if (!out) out = head.trim();
  /* 兜底：极端情况下（全角/组合字符）再裁一次，保证 +'…' 后不超 */
  let arr = [...out];
  if (arr.length > room) arr = arr.slice(0, room);
  return { text: arr.join('') + '…', clipped: true };
}

/** C6-5：散文（总结/私信）裁到上限 —— 结果 ≤ max，'…' 只有一格 */
function clipProse(text, max) {
  const hard = Math.max(60, Number(max) || 900);
  return clipToHard(text, hard, { punct: ['。', '！', '？', '\n'] });
}

/** C6-5：评论裁到上限（句读处回退优先；结果 ≤ max） */
function clipComment(text, max) {
  const hard = Math.max(10, Number(max) || 40);
  return clipToHard(text, hard, { punct: ['。', '！', '？', '；', '，', '、', ' '] }).text;
}

/** C4-6：预览文本也过正式写盘那层语气清洗（enforceParticles + 人设白名单） */
function cleanPreviewParticles(text, p) {
  try { return enforceParticles(String(text == null ? '' : text), particleWhitelist(p)); }
  catch (e) { return String(text == null ? '' : text); }
}

/** v50：兜底把提示词残留的内部说法清掉 —— 模型偶尔仍会写「材料里没讲」这类话，
 *  正式写盘与预览走同一条清洗，保证「只讲视频本身」。只处理明显属于内部词汇的替换，不动「素材」（那是内容词）。 */
const SCRUB_RULES = [
  [/材料里没(?:有)?(?:讲|提)(?:到|过)?/g, '视频里没讲'],
  [/材料里(?:讲|提)(?:到|过)?/g, '视频里讲了'],
  [/材料里(?:也)?没有/g, '视频里没有'],
  [/材料里?/g, '视频'],
  [/资料里?/g, '内容'],
  [/台词摘录/g, '台词'],
  [/事实卡/g, '这条视频'],
  [/宫格图?/g, '画面'],
  [/第\s*\d+\s*格(?:到第\s*\d+\s*格)?/g, '这一段'],
  [/格号/g, '时间码'],
];
function scrubInternalWords(text) {
  let s = String(text == null ? '' : text);
  try {
    for (const [re, to] of SCRUB_RULES) s = s.replace(re, to);
  } catch (e) { /* 替换失败就原样返回 */ }
  return s;
}

/** C6-5/C6-6 + 契约 5：预览文本统一「按上限裁 + 算实测字数」。
 *  · 裁剪与 measure 用**同一段展示文本**（评论开头 @ 账号名也算进去，不再剥掉 @ 再算）；
 *  · 裁完 ≤ hardMax，over 不会因后缀变 true；
 *  · chars = 最终展示文本长度，unit='字（按展示文本计）'。
 *  opts.targetName 给了且 target='comment' 时，开头统一替换成 '@'+targetName（C-EXTRA-2）。 */
function fitPreviewText(text0, target, shape, opts = {}) {
  let text = String(text0 || '');
  const hard = target === 'comment' ? shape.commentMax : target === 'dm' ? shape.dmMax : shape.summaryMax;
  const lenOf = (s) => [...String(s || '')].length;
  /* C-EXTRA-2：评论预览开头统一 @ 正式投递账号（去掉模型/人设自带的 @称呼） */
  if (target === 'comment' && opts.targetName) {
    const body = text.replace(/^\s*(?:@\S+\s*)+/, '').trim();
    const nm = String(opts.targetName).trim();
    text = nm ? ('@' + nm + (body ? ' ' + body : '')) : body;
  }
  let clipped = false;
  if (lenOf(text) > hard) {
    const r = target === 'comment'
      ? clipToHard(text, hard, { punct: ['。', '！', '？', '；', '，', '、', ' '] })
      : clipProse(text, hard);
    text = r.text;
    clipped = true;
  }
  const chars = lenOf(text);
  return {
    text,
    clipped,
    measure: {
      chars,
      hardMax: hard,
      softMax: Math.max(1, Math.round(hard * 0.75)),
      over: chars > hard,
      clipped,
      unit: '字（按展示文本计）',
    },
  };
}

/** v38：写入正式总结 —— `/api/summary/write` 与插件「直连模型」通路共用这一份逻辑
 *  （校验 gist/bullets/comment、落盘 summary.cloud.json、记账、触发投递）。
 *  失败抛错并带 status，方便路由回 4xx、桥回 {ok:false}。 */
function applySummaryWrite(b) {
  b = b || {};
  const bv = String(b.bv || '');
  if (!/^BV[0-9A-Za-z]{6,14}$/.test(bv)) throw Object.assign(new Error('bad bv'), { status: 400 });
  /* C4-6：落盘前先按人设语气词白名单清洗（和插件侧同一套规则），再校验长度 ——
     否则「洗掉语气词后其实没超」的会被误拒，「洗完反而超」的会漏网。 */
  const _pl = (() => { try { return particleWhitelist(readPersonaLib()); } catch (e) { return []; } })();
  /* v53：清洗顺序 —— 内部词替换 → 取证腔/缺陷说明清洗 → 人设语气词白名单。
     scrubAnalysisLeak 只做句子级清洗，不改写视频内容；bullets/comment 不允许出现「画面文字 / 台词 / 材料」这类话。 */
  const _clean = (s, opts = {}) => { try { const rep = opts.strip === false ? replaceAnalysisLeak : scrubAnalysisLeak; return String(enforceParticles(rep(scrubInternalWords(String(s == null ? '' : s))), _pl) || '').trim(); } catch (e) { return String(s == null ? '' : s).trim(); } };
  /* v53b（lead 修正）：gist 只做替换、不做句级丢弃 —— 丢一句总结就断，
     且「核对/核实/逐字」这类词在正常 gist 里是内容，不能因 LEAK 命中就整句删掉。 */
  const gist = _clean(b.gist, { strip: false });
  if (!gist || [...gist].length > 240) throw Object.assign(new Error('gist 必填且 ≤240 字'), { status: 400 });
  const bullets = Array.isArray(b.bullets) ? b.bullets.map(x => _clean(x)).filter(Boolean).slice(0, 8) : [];
  if (bullets.some(x => [...x].length > 120)) throw Object.assign(new Error('bullet 每条 ≤120 字'), { status: 400 });
  /* v53（契约 §4）：caveat 只留「视频本身没交代清楚的地方」——
     先按 aggressive LEAK 丢掉「我们怎么看这条片」的句子，再截 60 字；空则空串（落盘字段名不变）。 */
  const caveat = [...stripLeakSentences(String(b.caveat || ''), { aggressive: true })].slice(0, 60).join('').trim();
  /* v56：take —— 我的评估（证据强度 + 判断），末句就是结论；旧总结没有这个字段就留空。
     长度与预览/契约一致（硬顶 200 字），超了整段截断而不是报错（生成侧已按 180 写）。 */
  const take = [..._clean(b.take)].slice(0, 200).join('').trim();
  /* v37：云端模型顺带写的评论（可选）。超过评论上限自动截断；投递端校验不过会回退到规则拼装。 */
  const shp = normalizeShape(readShape());
  const rawComment = _clean(String(b.comment || '').replace(/\s+/g, ' ').trim());
  const comment = rawComment ? clipComment(rawComment, shp.commentMax) : '';
  /* B4：deliver 缺省 true；插件直写时传 deliver:false 只落盘、不排队投递（投递由人另行确认） */
  const wantDeliver = b.deliver !== false;
  const dir = path.join(DATA, 'out', bv);
  if (!fs.existsSync(dir)) throw Object.assign(new Error('没有这条的产物目录'), { status: 404 });
  /* v38：记下这条是「直连一次调用」还是「工作会话」写的，面板和后人都能看到成本口径 */
  const engine = b.engine === 'direct' ? 'direct' : 'session';
  const cost = b.cost && typeof b.cost === 'object'
    ? { yuan: Number(b.cost.yuan) || 0, tokens: b.cost.tokens || null, at: new Date().toISOString() }
    : null;
  const obj = {
    at: new Date().toISOString(), source: engine === 'direct' ? 'direct' : 'cloud',
    model: String(b.model || (engine === 'direct' ? 'deepseek-flash (direct)' : 'deepseek-flash (session)')),
    engine, bv, reviewed: true, gist, bullets,
    mark: String(b.mark || ''), verdict: String(b.verdict || ''), caveat, take,
    evidence: Array.isArray(b.evidence) ? b.evidence.slice(0, 8).map(x => String(x)).filter(Boolean) : [],
    persona: String(b.persona || ''), note: String(b.note || 'panel-write'),
    commentFor: comment ? { at: new Date().toISOString(), text: comment, max: shp.commentMax, by: 'cloud-model' } : null,
    cost,
  };
  const abs = path.join(dir, 'summary.cloud.json');
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, abs);
  /* 直连这条的真 usage 由这里记（面板账本只统计本站花费）；会话那条由插件按时间窗归因记，别重复 */
  if (engine === 'direct' && cost && cost.yuan > 0) {
    try {
      appendSpend({ kind: 'summarize', bv, model: obj.model, input: (cost.tokens && cost.tokens.input) || 0, output: (cost.tokens && cost.tokens.output) || 0, yuan: cost.yuan, source: 'usage', via: 'plugin-direct' });
    } catch (e) {}
  }
  emitEvent('summary.ready', { bv, source: obj.source, engine, gist: gist.slice(0, 60) });
  let dv = null;
  if (wantDeliver) {
    dv = spawnDeliver(bv, 'send');
    emitEvent('deliver.queued', { bv, ok: !!(dv && dv.ok), error: dv && dv.error });
  }
  return { ok: true, bv, engine, file: 'out/' + bv + '/summary.cloud.json', deliver: dv, delivered: !!(dv && dv.ok) };
}

/* v38：插件在同一进程里直接调这一步（直连模型写完就地落盘），不用再绕 HTTP/工具调用。
   放在模块顶层注册：面板 handler 第一次请求时 import 本文件就会挂上。 */
try {
  globalThis.__vdSummaryWrite = (b) => {
    try { return applySummaryWrite(b); }
    catch (e) { return { ok: false, error: String((e && e.message) || e), status: (e && e.status) || 400 }; }
  };
} catch (e) {}

function writePush(body) {
  const cur = readPush();
  /* v36：允许只提 shape（投递形态）不动账号 —— 面板「投递形态」卡自动保存时只带 shape */
  const accounts = Array.isArray(body && body.accounts) ? body.accounts : (Array.isArray(cur.accounts) ? cur.accounts : null);
  if (!accounts) throw new Error('accounts 必须是数组');
  const seen = new Set();
  const clean = accounts.map((a, i) => {
    const uid = Number(a.uid);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('第 ' + (i + 1) + ' 行 uid 不合法');
    if (seen.has(uid)) throw new Error('uid ' + uid + ' 重复');
    seen.add(uid);
    const channel = ['comment', 'dm', 'panel'].includes(a.channel) ? a.channel : 'comment';
    return {
      uid,
      name: String(a.name || '').slice(0, 40),
      channel,
      inbound: !!a.inbound,
      bind: a.bind || 'manual',
      enabled: a.enabled !== false,
      note: String(a.note || '').slice(0, 120),
      addedAt: a.addedAt || new Date().toISOString(),
    };
  });
  const next = {
    ...cur,
    version: (cur.version || 1) + 1,
    updatedAt: new Date().toISOString(),
    guard: body.guard && typeof body.guard === 'object' ? { ...cur.guard, ...body.guard } : cur.guard,
    shape: body.shape && typeof body.shape === 'object' ? normalizeShape({ ...normalizeShape(cur.shape), ...body.shape }) : normalizeShape(cur.shape),
    accounts: clean,
  };
  writeJsonFile('config/push.json', next, 'push');
  return { ok: true, version: next.version, count: clean.length, file: 'config/push.json' };
}

const PACING_DEFAULT = {
  runWindow: normalizeRunWindow({
    mode: 'week',
    week: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ from: 300, to: 1440 }]])),
  }),
  version: 1, seed: 20261030,
  heat: [0,0,0,0,0,0, 0.2,0.2,0.2, 0.5,0.5,0.5, 1,1,0.5, 0.5,0.5,1, 1,1,0.5, 0.2,0,0],
  fetch: { intervalMedianSec: 8, tailMaxSec: 90, sessionMinMin: 15, sessionMaxMin: 40, sessionsPerDay: [1,3], dailyCandidates: 30, dailyWatch: 8, minGapSec: 3, cooldown352Sec: 1800 },
  guard: { serialOnly: true, nightStop: true, hourlyCap: 30, sameUpStreakPct: 5, weekendBoost: 1.5, dailyBudgetYuan: 0.2 },
  switches: { queueToOffPeak: true, weekendBoost: true, sameUpStreak: true },
  dispatch: { enabled: true, tickSec: 60, gapSec: 5, candidateWatermark: 10, dailyEnlist: 10, dailyEnlistMax: 20, manualCap: 100, maxFails: 3, autoMaxPending: 30 },
  inbound: {
    activeSec: 20, idleSec: 60, nightSec: 180, activeWindowMin: 10,
    ack: false, maxReadPerTick: 5,
    note: '守候频率：刚有互动 activeWindowMin 分钟内用 activeSec，其余 idleSec，0–6 点 nightSec；ack=收到后先回一句（默认关）',
  },
};
function readPacing() {
  const p = readJsonFile('config/pacing.json', null);
  return p && Array.isArray(p.heat) ? p : { ...PACING_DEFAULT, sourceLabel: '默认值（config/pacing.json 缺失）' };
}
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
function writePacing(body) {
  /* v47：runWindow 统一走 normalizeRunWindow（旧 blackout 形状在库内部迁移），note 随后由 describeRunWindow 生成 */
  const cur = readPacing();
  const b = body && typeof body === 'object' ? body : {};
  const heat = Array.isArray(b.heat) && b.heat.length === 24
    ? b.heat.map(v => clampNum(v, 0, 1, 0))
    : cur.heat;
  const f = b.fetch && typeof b.fetch === 'object' ? b.fetch : {};
  const g = b.guard && typeof b.guard === 'object' ? b.guard : {};
  const sw = b.switches && typeof b.switches === 'object' ? b.switches : {};
  const next = {
    ...cur,
    version: cur.version || 1, // v24：先按旧版本号组装，内容确实变了才 +1（见下方 no-op 短路）
    updatedAt: new Date().toISOString(),
    seed: Number.isFinite(Number(b.seed)) ? Number(b.seed) : cur.seed,
    heat,
    fetch: {
      intervalMedianSec: clampNum(f.intervalMedianSec, 1, 600, cur.fetch.intervalMedianSec),
      tailMaxSec: clampNum(f.tailMaxSec, 10, 3600, cur.fetch.tailMaxSec),
      sessionMinMin: clampNum(f.sessionMinMin, 1, 240, cur.fetch.sessionMinMin),
      sessionMaxMin: clampNum(f.sessionMaxMin, 1, 300, cur.fetch.sessionMaxMin),
      sessionsPerDay: Array.isArray(cur.fetch.sessionsPerDay) ? cur.fetch.sessionsPerDay : [1, 3],
      dailyCandidates: clampNum(f.dailyCandidates, 1, 200, cur.fetch.dailyCandidates),
      dailyWatch: clampNum(f.dailyWatch, 0, 50, cur.fetch.dailyWatch),
      minGapSec: clampNum(f.minGapSec, 1, 600, cur.fetch.minGapSec),
      cooldown352Sec: clampNum(f.cooldown352Sec, 60, 86400, cur.fetch.cooldown352Sec),
    },
    guard: {
      ...cur.guard,
      serialOnly: g.serialOnly !== undefined ? !!g.serialOnly : cur.guard.serialOnly,
      nightStop: g.nightStop !== undefined ? !!g.nightStop : cur.guard.nightStop,
      hourlyCap: clampNum(g.hourlyCap, 1, 500, cur.guard.hourlyCap),
      sameUpStreakPct: clampNum(g.sameUpStreakPct, 0, 100, cur.guard.sameUpStreakPct),
      weekendBoost: clampNum(g.weekendBoost, 1, 3, cur.guard.weekendBoost),
      dailyBudgetYuan: clampNum(g.dailyBudgetYuan, 0, 100, cur.guard.dailyBudgetYuan),
    },
    switches: {
      queueToOffPeak: sw.queueToOffPeak !== undefined ? !!sw.queueToOffPeak : cur.switches.queueToOffPeak,
      weekendBoost: sw.weekendBoost !== undefined ? !!sw.weekendBoost : cur.switches.weekendBoost,
      sameUpStreak: sw.sameUpStreak !== undefined ? !!sw.sameUpStreak : cur.switches.sameUpStreak,
    },
  };
  // 自动投递参数（候选水位 / 日入列 / 手动上限 / 失败与异常上限 / tick 与间隔）
  const d = b.dispatch && typeof b.dispatch === 'object' ? b.dispatch : {};
  const cd = { ...PACING_DEFAULT.dispatch, ...(cur.dispatch || {}) };
  next.dispatch = {
    enabled: d.enabled !== undefined ? !!d.enabled : cd.enabled,
    tickSec: clampNum(d.tickSec, 20, 600, cd.tickSec),
    gapSec: clampNum(d.gapSec, 0, 120, cd.gapSec),
    candidateWatermark: clampNum(d.candidateWatermark, 1, 50, cd.candidateWatermark),
    dailyEnlistMax: clampNum(d.dailyEnlistMax, 1, 20, cd.dailyEnlistMax),
    dailyEnlist: clampNum(d.dailyEnlist, 1, clampNum(d.dailyEnlistMax, 1, 20, cd.dailyEnlistMax), cd.dailyEnlist),
    manualCap: clampNum(d.manualCap, 1, 500, cd.manualCap),
    maxFails: clampNum(d.maxFails, 1, 10, cd.maxFails),
    autoMaxPending: clampNum(d.autoMaxPending, 5, 200, cd.autoMaxPending),
    note: String(d.note !== undefined ? d.note : (cd.note || '')).slice(0, 200),
  };
  // 入站守候参数（频率 / 回执 / 单次最多读几个会话）
  const ib = b.inbound && typeof b.inbound === 'object' ? b.inbound : {};
  const ci = { ...PACING_DEFAULT.inbound, ...(cur.inbound || {}) };
  next.inbound = {
    activeSec: clampNum(ib.activeSec, 5, 600, ci.activeSec),
    idleSec: clampNum(ib.idleSec, 10, 3600, ci.idleSec),
    nightSec: clampNum(ib.nightSec, 30, 3600, ci.nightSec),
    activeWindowMin: clampNum(ib.activeWindowMin, 1, 120, ci.activeWindowMin),
    ack: ib.ack !== undefined ? !!ib.ack : ci.ack,
    maxReadPerTick: clampNum(ib.maxReadPerTick, 1, 20, ci.maxReadPerTick),
    note: ci.note,
  };
  /* v48：新形状 {mode,week,note}（mode 多了 'trough'）；旧 trough 字段迁移时并入 week 后丢弃。
     trough 模式只传 mode 时保留当前 week（用户之前自定义的时段，切回 week 还在）。 */
  let rwIn = (body && body.runWindow) ? body.runWindow : cur.runWindow;
  if (rwIn && typeof rwIn === 'object' && !Array.isArray(rwIn) && rwIn.mode === 'trough' && rwIn.week === undefined) {
    const cw = cur && cur.runWindow;
    if (cw && typeof cw === 'object' && cw.week && typeof cw.week === 'object') rwIn = { ...rwIn, week: cw.week };
  }
  const prc = readPricing();
  next.runWindow = normalizeRunWindow(rwIn, prc);
  next.runWindow.note = describeRunWindow(next.runWindow, prc);
  if (next.fetch.sessionMaxMin < next.fetch.sessionMinMin) throw new Error('单次时长 最大 不能小于 最小');
  // v24（S1 补充）：内容（忽略 updatedAt / version）没变 → 不写盘、不备份、不递增 version。
  // 自动保存会反复推同一份配置（滑杆停在原地、开关被别的页触发保存等），这里短路掉。
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(DATA, 'config/pacing.json'), 'utf8'));
    if (stableJson(withoutVolatile(prev)) === stableJson(withoutVolatile(next))) {
      return { ok: true, unchanged: true, version: cur.version || 1, file: 'config/pacing.json', seed: next.seed, runWindow: next.runWindow, dispatch: next.dispatch };
    }
  } catch (e) { /* 文件不存在/坏了 → 正常写 */ }
  next.version = (cur.version || 1) + 1;
  writeJsonFile('config/pacing.json', next, 'pacing');
  return { ok: true, version: next.version, file: 'config/pacing.json', seed: next.seed, runWindow: next.runWindow, dispatch: next.dispatch };
}

/* ── v23：权限（存 config/pacing.json 顶层 permissions，不新建配置文件） ──
   dm_push / at_push / stranger 三档：auto | ask | block（陌生人那行语义等价：直接丢弃/问我/自动）。
   写盘复用 writeJsonFile（config/backup/pacing-<stamp>.json 备份 + tmp+rename 原子写 + config-audit.log 审计一行）。 */
const PERM_CHOICES = {
  dm_push: ['auto', 'ask', 'block'],
  at_push: ['auto', 'ask', 'block'],
  stranger: ['block', 'ask', 'auto'],
  comment: ['auto', 'block'], // v24：评论投递开关（auto=照常发，block=只发私信）
};
const PERM_LABELS = { auto: '自动', ask: '问我', block: '禁止', stranger_block: '直接丢弃' };
/* v24：评论这一行只有两档，语义不是「自动/禁止」而是「照常发/只发私信」，
   所以单独给一组标签（labels.comment = {auto,block}），不动其它行的 labels 形状。 */
const PERM_LABELS_COMMENT = { auto: '照常发', block: '只发私信' };
const PERMS_DEFAULT = { dm_push: 'auto', at_push: 'auto', stranger: 'block', comment: 'auto', allowedStrangers: [], blockedStrangers: [] };

function readRawPacing() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config/pacing.json'), 'utf8')) || {}; }
  catch (e) { const p = readPacing(); delete p.sourceLabel; return p; }
}
function normUidArr(v) {
  const out = [];
  for (const x of (Array.isArray(v) ? v : [])) {
    const n = Number(x);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}
function readPerms() {
  const raw = readRawPacing();
  const p = raw && raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : {};
  const pick = (k, dflt) => (PERM_CHOICES[k].includes(p[k]) ? p[k] : dflt);
  return {
    dm_push: pick('dm_push', PERMS_DEFAULT.dm_push),
    at_push: pick('at_push', PERMS_DEFAULT.at_push),
    stranger: pick('stranger', PERMS_DEFAULT.stranger),
    comment: pick('comment', PERMS_DEFAULT.comment),
    allowedStrangers: normUidArr(p.allowedStrangers),
    blockedStrangers: normUidArr(p.blockedStrangers),
  };
}
function writePermissions(patch) {
  const b = patch && typeof patch === 'object' ? patch : {};
  const cur = readPerms();
  const next = { ...cur };
  for (const k of Object.keys(PERM_CHOICES)) {
    if (b[k] === undefined) continue;
    const v = String(b[k]);
    if (!PERM_CHOICES[k].includes(v)) throw httpErr(400, `权限 ${k} 只能是 ${PERM_CHOICES[k].join(' / ')}`);
    next[k] = v;
  }
  if (b.allowedStrangers !== undefined) next.allowedStrangers = normUidArr(b.allowedStrangers);
  if (b.blockedStrangers !== undefined) next.blockedStrangers = normUidArr(b.blockedStrangers);
  // v24（S1 补充）：权限没变就不写盘（自动保存会反复推同一份矩阵）
  if (stableJson({ ...cur }) === stableJson({ ...next })) return next;
  const raw = readRawPacing();
  const doc = {
    ...raw,
    version: (Number(raw.version) || 1) + 1,
    updatedAt: new Date().toISOString(),
    permissions: next,
  };
  writeJsonFile('config/pacing.json', doc, 'pacing');
  return next;
}
function todayAutoCount() {
  const today = localDay(new Date());
  try {
    return inbound.list(null, 500).filter(r => localDay(r.created_at) === today && (r.status === 'processing' || r.status === 'done')).length;
  } catch (e) { return 0; }
}
function permissionsPayload() {
  const p = readPerms();
  const dm = p.dm_push === 'auto' ? '私信自动分析' : p.dm_push === 'ask' ? '私信先放待审、你点允许才分析' : '私信不处理';
  const at = p.at_push === 'auto' ? '评论区 @ 自动分析' : p.at_push === 'ask' ? '评论区 @ 先放待审、你点允许才分析' : '评论区 @ 不处理';
  const st = p.stranger === 'block' ? '陌生人的互动直接丢弃' : p.stranger === 'ask' ? '陌生人的互动先放待审' : '陌生人的互动也自动处理';
  const cm = p.comment === 'block' ? '评论：只发私信（不发评论）。' : '评论：照常发。';
  let pending = 0, strangers = 0;
  try { pending = inbound.list('pending', 100).length; } catch (e) {}
  try { const r = inbound.open().prepare('SELECT COUNT(*) n FROM strangers').get(); strangers = r ? Number(r.n) || 0 : 0; } catch (e) {}
  return {
    ok: true,
    perms: { dm_push: p.dm_push, at_push: p.at_push, stranger: p.stranger, comment: p.comment },
    choices: PERM_CHOICES,
    labels: { ...PERM_LABELS, comment: PERM_LABELS_COMMENT },
    summary: `看视频后：${dm}；${at}；${st}。${cm}`,
    stats: { autoToday: todayAutoCount(), pending, strangers },
  };
}
function findInboundEvent(key) {
  try { const r = inbound.open().prepare('SELECT * FROM events WHERE receipt = ?').get(String(key)); return r ? { ...r } : null; }
  catch (e) { return null; }
}
function findStranger(uid) {
  try { const r = inbound.open().prepare('SELECT * FROM strangers WHERE uid = ?').get(Number(uid)); return r ? { ...r } : null; }
  catch (e) { return null; }
}
/* 待审：只列需要人拍板的条目；陌生人仅在 stranger==='ask' 时出现（且过滤掉已白/黑名单 uid） */
const PENDING_STRANGERS_MAX = 5; // v24：陌生人待审最多展示 5 条，其余用 strangersMore 告知
function pendingItems() {
  const p = readPerms();
  const items = [];
  let strangersMore = 0;
  try {
    for (const r of inbound.list('pending', 50)) {
      const kind = String(r.kind || '');
      items.push({
        key: r.receipt,
        kind,
        from: r.source || (kind.startsWith('dm') ? 'dm' : 'at'),
        uid: r.uid == null ? null : Number(r.uid),
        uname: r.uname || '',
        stranger: false,
        bvid: r.bvid || '',
        title: r.title || '',
        ts: r.created_at,
        reason: '权限设为「问我」',
      });
    }
  } catch (e) {}
  if (p.stranger === 'ask') {
    /* v24：陌生人最多展示 5 条（v23 是 20 条，会把这页挤出屏幕），多出来的
       用 strangersMore 报给 UI（"还有 N 条陌生人未展示"）。inbound.strangers 已是 last_seen DESC。 */
    const skip = new Set([...p.allowedStrangers, ...p.blockedStrangers].map(Number));
    let total = 0;
    try {
      for (const s of inbound.strangers(500)) {
        const uid = Number(s.uid);
        if (!Number.isFinite(uid) || skip.has(uid)) continue;
        total++;
        if (total > PENDING_STRANGERS_MAX) continue;
        items.push({
          key: 'stranger:' + uid,
          kind: 'dm',
          from: 'dm',
          uid,
          uname: s.uname || '',
          stranger: true,
          bvid: '',
          title: '',
          ts: s.last_seen || s.first_seen || '',
          reason: '陌生人的互动（点允许后加入白名单）',
        });
      }
    } catch (e) {}
    strangersMore = Math.max(0, total - PENDING_STRANGERS_MAX);
  }
  return { items, strangersMore };
}
/* ── 历史审批：<DATA>/logs/approvals.json，最多 50 条、最新在前；读-改-写 + 原子 rename ── */
const APPROVALS_FILE = 'logs/approvals.json';
const APPROVALS_MAX = 50;
function approvalsPath() { return path.join(DATA, APPROVALS_FILE); }
function readApprovals() {
  try {
    const j = JSON.parse(fs.readFileSync(approvalsPath(), 'utf8'));
    return Array.isArray(j && j.items) ? j.items.slice(0, APPROVALS_MAX) : [];
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.error('[panel] logs/approvals.json 读取失败，按空表处理：' + String(e.message || e));
    return [];
  }
}
function appendApproval(rec) {
  const items = [rec, ...readApprovals()].slice(0, APPROVALS_MAX);
  try {
    const file = approvalsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[panel] logs/approvals.json 写入失败：' + String(e.message || e));
  }
  return rec;
}
function httpErr(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
/* 允许 / 丢弃。幂等：事件已不在 pending 也照常返回 ok（setStatus 影响 0 行、mark 是 upsert）。 */
function decideInbound(key, action) {
  const isStranger = String(key).startsWith('stranger:');
  const p = readPerms();
  let ev = null, uid = null, bvid = '', verified = null, uname = '', title = '', kind = 'dm', from = 'dm';
  if (isStranger) {
    uid = Number(String(key).slice('stranger:'.length));
    if (!Number.isInteger(uid) || uid <= 0) throw httpErr(400, '陌生人的 uid 不合法');
    const s = findStranger(uid);
    if (s) uname = s.uname || '';
    if (action === 'allow') {
      writePermissions({
        allowedStrangers: p.allowedStrangers.includes(uid) ? p.allowedStrangers : [...p.allowedStrangers, uid],
        blockedStrangers: p.blockedStrangers.filter(x => x !== uid),
      });
    } else {
      writePermissions({
        blockedStrangers: p.blockedStrangers.includes(uid) ? p.blockedStrangers : [...p.blockedStrangers, uid],
        allowedStrangers: p.allowedStrangers.filter(x => x !== uid),
      });
    }
  } else {
    ev = findInboundEvent(key);
    bvid = String((ev && ev.bvid) || '');
    kind = ev ? String(ev.kind || 'dm') : 'dm';
    from = ev ? String(ev.source || '') : '';
    uname = ev ? String(ev.uname || '') : '';
    title = ev ? String(ev.title || '') : '';
    if (action === 'allow') {
      if (!bvid) throw httpErr(400, '这条没有视频号，无法入队');
      // 顺序按契约：入队 → 回读验证 → 事件标为 processing
      lib.mark({ bvid, status: 'queued', via: 'inbound', depth: 'T3', prio: 1, note: 'approved:' + key });
      const row = lib.get(bvid);
      verified = row ? row.status : null;
      try { inbound.setStatus(key, 'processing', 'approved-by-user'); } catch (e) {}
    } else {
      try { inbound.setStatus(key, 'ignored', 'dropped-by-user'); } catch (e) {}
    }
  }
  const rec = {
    ts: new Date().toISOString(),
    action,
    key,
    kind,
    from,
    uid: isStranger ? uid : (ev && ev.uid != null ? Number(ev.uid) : null),
    uname,
    bvid: isStranger ? '' : bvid,
    title,
    verified: action === 'allow' ? (verified || '') : '',
    note: '',
  };
  appendApproval(rec);
  return { ok: true, action, verified: { bvid: rec.bvid, status: verified || '' }, record: rec };
}
const VIDEO_RESULT = { queued: '已入队', running: '分析中', seen: '已跑完', failed: '失败', candidate: '候选', deleted: '已丢弃' };
function videoResult(st) { return VIDEO_RESULT[st] || ''; }
/* 历史审批（GET）：approvals.json 手工记录 + events 表自动记录合并；ts 倒序取最近 50 条再分页。
   结果/token/depth 每条现算（library.db + ledger.db），让用户能确认"确实生效了"。 */
function inboundHistory(page, size) {
  const approvals = readApprovals();
  const byKey = new Set(approvals.map(a => String(a.key || '')));
  const rows = approvals.map(a => ({ ...a }));
  const autoStates = new Set(['done', 'processing', 'ignored']);
  try {
    for (const r of inbound.list(null, 200)) {
      if (!autoStates.has(r.status)) continue;
      if (r.receipt && byKey.has(r.receipt)) continue; // 手工记录（带 verified）优先，不重复展示
      const note = String(r.note || '');
      const action = (note.includes('dropped-by-user') || note.includes('perm-block')) ? 'drop' : (note.includes('approved-by-user') ? 'allow' : 'auto');
      rows.push({
        ts: r.created_at, action, key: r.receipt, kind: r.kind, from: r.source,
        uid: r.uid == null ? null : Number(r.uid), uname: r.uname || '', bvid: r.bvid || '',
        title: r.title || '', verified: action === 'allow' ? 'queued' : '', note: '',
      });
    }
  } catch (e) {}
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  // 同一条审批被连点两次（幂等 allow/drop）只保留最新一条，避免历史里出现重复行
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const sig = String(r.key || '') + '|' + String(r.action || '');
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(r);
  }
  const recent = deduped.slice(0, APPROVALS_MAX);
  const total = recent.length;
  const sz = Math.min(10, Math.max(1, Number(size) || 5));
  const pages = Math.ceil(total / sz);
  const pg = Math.min(Math.max(1, Number(page) || 1), Math.max(1, pages));
  let ledger = null;
  try { ledger = openDb('logs/ledger.db'); } catch (e) { ledger = null; }
  let tokStmt = null;
  try { tokStmt = ledger ? ledger.prepare('SELECT total_tokens FROM runs WHERE bvid = ? ORDER BY id DESC LIMIT 1') : null; } catch (e) { tokStmt = null; }
  const out = recent.map((r) => {
    let v = null;
    try { v = r.bvid ? lib.get(r.bvid) : null; } catch (e) {}
    const status = v ? v.status : null;
    let tokens = null;
    if (status === 'seen' && tokStmt) { try { const q = tokStmt.get(r.bvid); if (q) tokens = q.total_tokens; } catch (e) {} }
    return { ...r, status, result: videoResult(status), tokens, depth: v ? (v.depth || '') : '' };
  });
  try { if (ledger) ledger.close(); } catch (e) {}
  return { ok: true, page: pg, size: sz, pages, total, rows: out.slice((pg - 1) * sz, pg * sz) };
}

const GATE_DEFAULT = {
  sampleRatio: 0.25, lowDensity: 0.30, lowFacts: 2, passFacts: 6,
  passDensity: 0.75, passDensityMinDur: 300, passDisputes: 3, passPrefs: 0.8,
};
const GATE_LIMITS = {
  sampleRatio: [0, 1], lowDensity: [0, 1], lowFacts: [0, 50], passFacts: [0, 100],
  passDensity: [0, 1], passDensityMinDur: [0, 3600], passDisputes: [0, 100], passPrefs: [0, 10],
};
function readGate() {
  const raw = readJsonFile('config/gate.json', {}) || {};
  const out = { ...GATE_DEFAULT };
  for (const k of Object.keys(GATE_DEFAULT)) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = raw[k];
  out.updatedAt = raw.updatedAt || null;
  out.version = raw.version || 0;
  return out;
}
function writeGate(body) {
  const cur = readGate();
  const next = { ...cur };
  for (const [k, [lo, hi]] of Object.entries(GATE_LIMITS)) {
    if (body[k] === undefined) continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v)) throw new Error(k + ' 不是数字');
    next[k] = Math.min(hi, Math.max(lo, v));
  }
  if (next.passFacts < next.lowFacts) throw new Error('passFacts 不能小于 lowFacts');
  const doc = { _note: '门禁阈值：决定一条视频值不值得上云总结', version: (cur.version || 0) + 1, updatedAt: new Date().toISOString() };
  for (const k of Object.keys(GATE_DEFAULT)) doc[k] = next[k];
  const r = writeJsonFile('config/gate.json', doc, 'gate');
  return { ok: true, gate: readGate(), backup: (r && r.backup) || null };
}

/* ---------- 总结来源：云端（默认，会话模型写 summary.cloud.json）/ 本地端点（备用，写 summary.json 草稿） ---------- */
const SUMM_DEFAULT = { mode: 'cloud', enabled: false, baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', apiKey: '', directSummary: true };
function readSummarize() {
  const raw = readJsonFile('config/summarize.json', {}) || {};
  const out = { ...SUMM_DEFAULT };
  out.mode = (raw.mode === 'local' || raw.mode === 'api' || raw.mode === 'session') ? raw.mode : (raw.enabled === true ? 'local' : 'session');
  out.enabled = raw.enabled === true;
  /* v38：正式总结优先「直连模型一次调用」（省 5–10 倍），失败/材料缺失时自动回落会话工人。默认开。 */
  out.directSummary = raw.directSummary !== false;
  out.autoWriteRatio = Number.isFinite(Number(raw.autoWriteRatio)) ? Math.min(1, Math.max(0, Number(raw.autoWriteRatio))) : 0.6;
  out.dailyWriteMax = Number.isFinite(Number(raw.dailyWriteMax)) ? Math.min(50, Math.max(0, Number(raw.dailyWriteMax))) : 0;
  out.baseUrl = (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) ? raw.baseUrl.trim() : SUMM_DEFAULT.baseUrl;
  out.model = (typeof raw.model === 'string' && raw.model.trim()) ? raw.model.trim() : SUMM_DEFAULT.model;
  out.apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
  out.endpoint = /\/v1(\/|$)/.test(out.baseUrl) ? 'openai' : 'ollama';
  out.updatedAt = raw.updatedAt || null;
  out.version = raw.version || 0;
  return out;
}
function writeSummarize(body) {
  const cur = readSummarize();
  const next = { ...cur };
  if (body.mode !== undefined) next.mode = (body.mode === 'local' || body.mode === 'api' || body.mode === 'session') ? body.mode : 'session';
  if (body.enabled !== undefined) next.enabled = body.enabled === true;
  if (body.autoWriteRatio !== undefined) { const v = Number(body.autoWriteRatio); if (Number.isFinite(v)) next.autoWriteRatio = Math.min(1, Math.max(0, v)); }
  if (body.dailyWriteMax !== undefined) { const v = Number(body.dailyWriteMax); if (Number.isFinite(v)) next.dailyWriteMax = Math.min(50, Math.max(0, Math.round(v))); }
  if (body.baseUrl !== undefined) {
    const v = String(body.baseUrl || '').trim();
    if (!/^https?:\/\//.test(v)) throw new Error('请求地址必须以 http:// 或 https:// 开头');
    next.baseUrl = v.slice(0, 300);
  }
  if (body.model !== undefined) next.model = String(body.model || '').trim().slice(0, 80) || SUMM_DEFAULT.model;
  if (body.apiKey !== undefined) next.apiKey = String(body.apiKey || '').trim().slice(0, 200);
  if (body.directSummary !== undefined) next.directSummary = body.directSummary !== false;
  const doc = {
    _note: '总结来源：session=会话模型写 summary.cloud.json（默认，不要 key）；api=脚本直连云端 API 写（需 key，可离线/无人值守）；local=本地端点写 summary.json 草稿（标未复核）；directSummary=正式总结优先直连模型一次调用（失败自动回落会话）',
    mode: 'session',
    autoWriteRatio: 0.6,
    dailyWriteMax: 0,
    version: (cur.version || 0) + 1,
    updatedAt: new Date().toISOString(),
    mode: next.mode, enabled: next.enabled, directSummary: next.directSummary !== false, baseUrl: next.baseUrl, model: next.model, apiKey: next.apiKey,
  };
  const r = writeJsonFile('config/summarize.json', doc, 'summarize');
  return { ok: true, summarize: readSummarize(), backup: (r && r.backup) || null };
}
async function testSummarize(body) {
  const cfg = readSummarize();
  const base = String((body && body.baseUrl) || cfg.baseUrl || '').replace(/\/+$/, '');
  const model = String((body && body.model) || cfg.model || '');
  const key = String((body && (body.apiKey || body.apiKey === '')) ? body.apiKey : (cfg.apiKey || ''));
  if (!/^https?:\/\//.test(base)) throw new Error('请求地址必须以 http:// 或 https:// 开头');
  const openai = /\/v1(\/|$)/.test(base);
  const url = openai ? base + '/models' : base + '/api/tags';
  const headers = {};
  if (key) headers['authorization'] = 'Bearer ' + key;
  const t0 = Date.now();
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let models = [];
  try {
    const j = JSON.parse(text);
    models = openai ? (j.data || []).map(m => m.id) : (j.models || []).map(m => m.name);
  } catch {}
  if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + text.slice(0, 160));
  return { ok: true, endpoint: openai ? 'openai' : 'ollama', url, ms: Date.now() - t0, models: models.slice(0, 30), modelFound: models.includes(model), model };
}

function readPersona() {
  const p = readJsonFile('config/persona.json', null);
  if (!p || !p.presets) throw new Error('config/persona.json 缺失或格式不对');
  return p;
}
const PERSONA_STRUCT = ['news', 'picked', 'conclusion', 'timeline', 'list', 'tech', 'teardown', 'memo', 'auto'];
const PERSONA_TERMS = ['pop', 'neutral', 'insider'];
const PERSONA_VOICE = ['direct', 'friend', 'brief'];
const PERSONA_UNC = ['conflict', 'all', 'none'];
const PERSONA_EMOJI = ['off', 'few', 'normal'];

/** v28：写盘前兜底 —— 旧页面/手改 JSON 可能把枚举写成空串，落盘一律收敛到合法值 */
function normalizePersonaDoc(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const f = Object.assign({}, d.format || {});
  /* v30：空串 = 跟随人设卡（严谨=五段式 / 轻快·亲切=三段式）；显式选了就以面板为准 */
  f.structure = (String(f.structure) === '' || PERSONA_STRUCT.includes(String(f.structure))) ? String(f.structure) : '';
  f.terms = PERSONA_TERMS.includes(String(f.terms)) ? String(f.terms) : 'neutral';
  f.voice = PERSONA_VOICE.includes(String(f.voice)) ? String(f.voice) : 'friend';
  f.uncertainty = PERSONA_UNC.includes(String(f.uncertainty)) ? String(f.uncertainty) : 'all';
  f.maxChars = Math.max(100, Math.min(2000, Number(f.maxChars) || 900));
  f.timecode = !!f.timecode;
  d.format = f;
  for (const k of Object.keys(d.presets || {})) {
    const pr = d.presets[k] || {};
    if (!PERSONA_EMOJI.includes(String(pr.emoji))) pr.emoji = 'few';
    if (pr.structure && !PERSONA_STRUCT.includes(String(pr.structure))) delete pr.structure;
    d.presets[k] = pr;
  }
  return d;
}

function writePersona(body) {
  const cur = readPersona();
  const next = normalizePersonaDoc({
    ...cur,
    ...(body && typeof body === 'object' ? body : {}),
    version: (cur.version || 1) + 1,
    updatedAt: new Date().toISOString(),
  });
  if (!next.presets || !next.presets[next.active]) throw new Error('active 必须是 presets 里的 key');
  writeJsonFile('config/persona.json', next, 'persona');
  /* C-EXTRA-1：写完人设立刻清空预览结果缓存 —— 否则 cacheKey 命中旧结果，
     「改人设后再点一次会变」就是空话（cacheKey 里已加 personaGenKey，这里再兜一层）。 */
  try { if (globalThis.__vdPreviewCache && typeof globalThis.__vdPreviewCache.clear === 'function') globalThis.__vdPreviewCache.clear(); } catch (e) {}
  return { ok: true, version: next.version, file: 'config/persona.json' };
}

/* ══ v31：DSH 真实扣款（.dshw-usage.json）═══════════════════════════════════════
   用户要求 m03774⑥：核实计价、包含所有费用——按 token 的「单条估算」永远对不上真实扣款
   （估算不含会话系统提示、多轮工具调用、缓存差价）。唯一真源是 DSH 自己的计费记录：
     <DSH_HOME>/.dshw-usage.json
   实测结构（2026-11-02）：{date, lastBalance, todayUsage, dayStart,
     history:{day:元}, accounting:{books:{<book>: {days:{<day>:{openingUnits,lastUnits,debitUnits,creditUnits}}}},
     events:[{ts,day,model,cost,tokens}]}
   单位：debitUnits/openingUnits/lastUnits 是「1e8 = 1 元」的整数单位（如 2516853000 ↔ 25.16853 元），
        但 lastBalance/todayUsage/dayStart 与 history 里的值已经是元，直接用。
   events 可能被裁剪（实测只有最后一天能对齐 history）→ partial:true，面板按此提示。 */
const USAGE_FILE = path.join(DSH_HOME, '.dshw-usage.json');
function readDshUsage() {
  let raw = '';
  try { raw = fs.readFileSync(USAGE_FILE, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, error: { code: 'usage-missing', zh: '本机还没有 DSH 计费记录（~/.dsh/.dshw-usage.json 不存在）' } };
    return { ok: false, error: { code: 'usage-unreadable', zh: 'DSH 计费记录读不出来：' + String((e && e.message) || e).slice(0, 120) } };
  }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) {
    return { ok: false, error: { code: 'usage-bad', zh: 'DSH 计费记录格式不对（不是合法 JSON）' } };
  }
  if (!j || typeof j !== 'object') return { ok: false, error: { code: 'usage-bad', zh: 'DSH 计费记录格式不对（不是对象）' } };
  const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

  // 日总额（元）：history 是权威口径，正序取最近 14 天
  const hist = [];
  const h = j.history && typeof j.history === 'object' ? j.history : {};
  for (const day of Object.keys(h).sort()) {
    const y = num(h[day]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && y !== null) hist.push({ day, yuan: +y.toFixed(6) });
  }
  const history = hist.slice(-14);

  // 按模型聚合 events（可能不全，见 partial）
  const byModel = new Map();
  let evCount = 0, evCost = 0, evTokens = 0;
  const evs = Array.isArray(j.events) ? j.events : [];
  for (const e of evs) {
    if (!e || typeof e !== 'object') continue;
    evCount++;
    const model = String(e.model || 'unknown').slice(0, 60);
    const cost = num(e.cost) || 0, tok = num(e.tokens) || 0;
    const cur = byModel.get(model) || { model, yuan: 0, tokens: 0, events: 0 };
    cur.yuan += cost; cur.tokens += tok; cur.events++;
    byModel.set(model, cur);
    evCost += cost; evTokens += tok;
  }
  const models = [...byModel.values()]
    .map(m => ({ ...m, yuan: +m.yuan.toFixed(6) }))
    .sort((a, b) => b.yuan - a.yuan);

  const todayDay = localDay(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || '')) ? String(j.date) : todayDay;
  const todayYuan = num(j.todayUsage) !== null ? num(j.todayUsage) : (h[day] !== undefined ? num(h[day]) : 0);
  return {
    ok: true,
    source: '~/.dsh/.dshw-usage.json',
    currency: 'CNY',
    today: { day, yuan: +Number(todayYuan || 0).toFixed(6) },
    balance: num(j.lastBalance),
    dayStart: num(j.dayStart),
    history,
    models,
    eventsCount: evCount,
    // 事件汇总（与 history 对照用：不相等说明 events 被裁剪过）
    eventsSum: { yuan: +evCost.toFixed(6), tokens: evTokens },
    partial: true,
    at: new Date().toISOString(),
  };
}

/** /api/cost 增补用的精简视图：today(数字)/balance/dayStart/history；读不到就 null（绝不抛） */
function usageRealSummary() {
  try {
    const u = readDshUsage();
    if (!u || !u.ok) return null;
    return { today: u.today.yuan, day: u.today.day, balance: u.balance, dayStart: u.dayStart, history: u.history };
  } catch (e) { return null; }
}

/* ── v36：本插件自己的花费账（用户 m05320：「实扣统计把 DSH 其他对话一起算进去了」）──────────
   DSH 的 .dshw-usage.json 只有按日总额（history）+ 会被裁剪的 events，没有会话归属，
   所以它永远只能回答「这台机器今天花了多少」，回答不了「看视频花了多少」。
   做法：插件自己记账，写 logs/llm-cost.jsonl，一行一次花钱动作：
     · kind='preview'   —— 面板预览的直连调用（有真实 usage，精确）
     · kind='summarize' —— 投递给摘要工人的一次（拿不到 usage，用「投递时间窗内的 DSH events」归因，标 source:'window'）
     · kind='why'       —— 本地判否说明（几乎 0 元，也记一行便于核对）
   本文件只负责聚合展示；写行由 plugin/index.js 与 scripts/why.mjs 负责（同一份文件格式）。 */
const SPEND_LOG = path.join(DATA, 'logs', 'llm-cost.jsonl');
/** v36：追加一笔本站花费（面板侧写：预览直连；插件侧写：会话投递按时间窗归因） */
function appendSpend(rec) {
  try {
    fs.mkdirSync(path.dirname(SPEND_LOG), { recursive: true });
    fs.appendFileSync(SPEND_LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
  } catch (e) {}
}
function readSpendLog(limit = 40) {
  let raw = '';
  try { raw = fs.readFileSync(SPEND_LOG, 'utf8'); }
  catch (e) { if (e && e.code !== 'ENOENT') return { ok: false, error: { code: 'spend-unreadable', zh: '花费账读不出来：' + String(e.message || e).slice(0, 100) } }; }
  const lines = raw.split('\n').filter(Boolean);
  const rows = [];
  for (const ln of lines) {
    try { const j = JSON.parse(ln); if (j && typeof j === 'object') rows.push(j); } catch (e) {}
  }
  const today = localDay(new Date());
  const day7 = dayAgo(6);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  /* v49 A3：插件 kind='summary' 与面板 kind='summarize' 会对同一笔直连总结各记一次账。
     插件那条的 bv 经常是空串，所以配对键不靠 bv：|at 差|<=5s、input/output 相等、|yuan 差|<1e-9；
     两边 bv 都非空且不同则不算。命中时剔除 summary 那条（保留面板的明细），并把条数告诉前端。 */
  const _ts = (r) => Date.parse(r && r.at);
  const dropped = new Set();
  let deduped = 0;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (!a || a.kind !== 'summary') continue;
    const ta = _ts(a);
    if (!Number.isFinite(ta)) continue;
    for (let j = 0; j < rows.length; j++) {
      if (i === j || dropped.has(j)) continue;
      const bb = rows[j];
      if (!bb || bb.kind !== 'summarize') continue;
      const tb = _ts(bb);
      if (!Number.isFinite(tb) || Math.abs(ta - tb) > 5000) continue;
      if (num(a.input) !== num(bb.input) || num(a.output) !== num(bb.output)) continue;
      if (Math.abs(num(a.yuan) - num(bb.yuan)) >= 1e-9) continue;
      const bva = String(a.bv || ''), bvb = String(bb.bv || '');
      if (bva && bvb && bva !== bvb) continue;
      dropped.add(i); deduped++;
      break;
    }
  }
  const kept = rows.filter((_, i) => !dropped.has(i));
  const agg = { yuan: 0, count: 0 }, aggToday = { yuan: 0, count: 0 }, agg7 = { yuan: 0, count: 0 };
  const byKind = new Map(), byBv = new Map();
  for (const r of kept) {
    const y = num(r.yuan), d = localDay(r.at);
    agg.yuan += y; agg.count++;
    if (d === today) { aggToday.yuan += y; aggToday.count++; }
    if (d >= day7) { agg7.yuan += y; agg7.count++; }
    const k = String(r.kind || 'unknown');
    const kc = byKind.get(k) || { kind: k, yuan: 0, count: 0 };
    kc.yuan += y; kc.count++; byKind.set(k, kc);
    const bv = String(r.bv || '');
    if (bv) { const bc = byBv.get(bv) || { bv, yuan: 0, count: 0 }; bc.yuan += y; bc.count++; byBv.set(bv, bc); }
  }
  const r6 = (x) => +Number(x).toFixed(6);
  return {
    ok: true,
    source: 'logs/llm-cost.jsonl（本插件自己记的账）',
    note: '只统计「一起看视频」插件自己花的钱：预览直连、投给摘要工人的每次、本地判否说明。DSH 里别的对话不算。'
      + (deduped ? `已合并插件与面板对同一笔直连总结的重复记账 ${deduped} 条。` : '已合并插件与面板对同一笔直连总结的重复记账。'),
    deduped,
    total: { yuan: r6(agg.yuan), count: agg.count },
    today: { day: today, yuan: r6(aggToday.yuan), count: aggToday.count },
    days7: { from: day7, yuan: r6(agg7.yuan), count: agg7.count },
    byKind: [...byKind.values()].map((x) => ({ ...x, yuan: r6(x.yuan) })).sort((a, b) => b.yuan - a.yuan),
    topVideos: [...byBv.values()].map((x) => ({ ...x, yuan: r6(x.yuan) })).sort((a, b) => b.yuan - a.yuan).slice(0, 8),
    rows: kept.slice(-Math.max(1, Math.min(200, limit))).reverse().map((r) => ({
      at: r.at, day: localDay(r.at), hm: localHM(r.at), kind: String(r.kind || ''), bv: String(r.bv || ''),
      target: String(r.target || ''), yuan: r6(num(r.yuan)), input: num(r.input), output: num(r.output),
      tokens: num(r.tokens), events: num(r.events), source: String(r.source || ''), model: String(r.model || ''),
    })),
    at: new Date().toISOString(),
  };
}
/** 按 bvid 汇总（账本表格每行用）：读一次文件、缓 8 秒，热循环里别反复读盘 */
function spendByBv() {
  const g = (globalThis.__vdSpendCache = globalThis.__vdSpendCache || { at: 0, map: {} });
  if (Date.now() - g.at < 8000) return g.map;
  const out = {};
  try {
    const r = readSpendLog(1);
    for (const v of (r.topVideos || [])) out[v.bv] = v.yuan;
    /* topVideos 只有前 8 条，这里再全量扫一次保证完整（文件很小，几万行也够快） */
    let raw = '';
    try { raw = fs.readFileSync(SPEND_LOG, 'utf8'); } catch (e) { raw = ''; }
    for (const ln of raw.split('\n')) {
      if (!ln) continue;
      try {
        const j = JSON.parse(ln);
        if (j && j.bv) { const y = Number(j.yuan); if (Number.isFinite(y)) out[j.bv] = +(((out[j.bv] || 0) + y).toFixed(6)); }
      } catch (e) {}
    }
  } catch (e) {}
  g.at = Date.now(); g.map = out;
  return out;
}

function costReport() {
  const p = readPricing();
  const db = openDb('logs/ledger.db');
  if (!db) return { error: 'no ledger.db', real: usageRealSummary() };
  const rows = db.prepare('SELECT at, total_tokens FROM runs').all();
  const now = new Date();
  const dayKey = d => localDay(d);
  const today = dayKey(now);
  const weekAgo = dayAgo(6);
  const monthAgo = dayAgo(29);
  const yuan = (tok, d) => costYuan(tok, isPeakAt(d, p), p);
  const sum = pred => rows.filter(r => pred(dayKey(r.at))).reduce((a, r) => a + yuan(r.total_tokens, r.at), 0);
  const todayYuan = sum(k => k === today);
  const weekYuan = sum(k => k >= weekAgo);
  const monthYuan = sum(k => k >= monthAgo);
  const b = readJsonFile('config/budget.json', { daily: 1, weekly: 5, monthly: 20, warnPct: 80, overAction: 'degrade' });
  const ratio = b.daily ? todayYuan / b.daily : 0;
  const state = ratio >= 1 ? 'exhausted' : ratio >= (b.warnPct || 80) / 100 ? 'warn' : 'ok';
  return {
    pricing: p, budget: b,
    today: { yuan: +todayYuan.toFixed(6), fen: +(todayYuan * 100).toFixed(2), count: rows.filter(r => dayKey(r.at) === today).length },
    week: { yuan: +weekYuan.toFixed(6) },
    month: { yuan: +monthYuan.toFixed(6) },
    left: { today: +(b.daily - todayYuan).toFixed(6), week: +(b.weekly - weekYuan).toFixed(6), month: +(b.monthly - monthYuan).toFixed(6) },
    ratio: +(ratio * 100).toFixed(1), state,
    // 1 元能换多少条 T3（按最近 T3 平均 token 估）
    perYuanT3: (() => {
      const t3 = db.prepare("SELECT AVG(total_tokens) a FROM runs WHERE depth='T3'").get();
      const avg = t3 && t3.a ? t3.a : 1600;
      const unit = (avg * (p.inMiss || 1) + 2500 * (p.inHit || 0.02) + 500 * (p.out || 4)) / 1e6;
      return unit > 0 ? Math.round(1 / unit) : null;
    })(),
    nowPeak: (() => {
      const hh = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      return (p.peakDays || []).includes(now.getDay()) && (p.peakHours || []).some(([a, b2]) => hh >= a && hh < b2);
    })(),
    at: now.toISOString(),
    /* v31：真实扣款（同源 /api/usage）——估算与实扣并列，面板据此解释「为什么对不上」 */
    real: usageRealSummary(),
  };
}


// ---------- 入站：@ 与私信（只读，cookie 只在本进程内用，绝不下发） ----------
let inboxCache = { at: 0, data: null };

function biliCookie() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets/bili.json'), 'utf8'));
    const map = [['sessdata', 'SESSDATA'], ['bili_jct', 'bili_jct'], ['buvid3', 'buvid3'], ['dede_user_id', 'DedeUserID']];
    return map.filter(([k]) => c[k]).map(([k, n]) => n + '=' + c[k]).join('; ');
  } catch { return ''; }
}

const BILI_HEADERS = () => ({
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'referer': 'https://message.bilibili.com/',
  'origin': 'https://message.bilibili.com',
  'cookie': biliCookie(),
});

async function biliGet(url) {
  const r = await fetch(url, { headers: BILI_HEADERS(), signal: AbortSignal.timeout(12000) });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { code: r.status, message: 'non-json', raw: txt.slice(0, 160) }; }
}

// bilibili 的时间戳单位不统一：at_time 是秒，session_ts 是微秒（16 位）
function biliMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.round(n / 1000) : Math.round(n * 1000);
}
function isoOrNull(v) {
  const ms = biliMs(v);
  if (ms === null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

const unameCache = new Map();

// 会话里最后一条消息只有文本摘要；视频分享卡片要再拉一次消息列表（msg_type=7 的 content 里有 bvid/title）
async function dmLatestVideo(tid) {
  try {
    const r = await biliGet('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=' +
      tid + '&session_type=1&size=10&build=0&mobi_app=web&platform=web');
    const msgs = (r.data && r.data.messages) || [];
    for (const m of msgs) {
      if (Number(m.sender_uid) !== Number(tid)) continue;   // 只算对方发来的（我自己的回复不算入站）
      let o = {};
      try { o = JSON.parse(m.content || '{}'); } catch {}
      const bvid = o.bvid || ((String(m.content || '').match(/BV[0-9A-Za-z]{8,14}/) || [])[0] || null);
      if (bvid) return { bvid, cardTitle: o.title || '', msgType: m.msg_type || 0, ts: isoOrNull(m.timestamp) };
    }
  } catch {}
  return null;
}

async function inbox(force) {
  if (!force && inboxCache.data && Date.now() - inboxCache.at < 60000) return inboxCache.data;
  const cookie = biliCookie();
  if (!cookie) return { error: 'no_cookie', hint: 'secrets\\bili.json 里没有 sessdata' };
  const out = { at: [], dms: [], unread: null, fetchedAt: new Date().toISOString(), error: null };
  try {
    const at = await biliGet('https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web&platform=web');
    if (at.code === 0 && at.data && Array.isArray(at.data.items)) {
      // 身份先于内容：先核实是不是自己人，陌生人只登记 uid/昵称/时间，标题与正文一律不取
      out.at = await Promise.all(at.data.items.slice(0, 30).map(async it => {
        const uid = Number(it.user && it.user.mid) || 0;
        const uname = (it.user && it.user.nickname) || '';
        const who = await inbound.identify(uid);
        if (!who.ok) {
          try { inbound.noteStranger({ uid, uname, unread: 1 }); } catch (e) {}
          return { at: isoOrNull(it.at_time), uid, uname, stranger: true, level: who.level, reason: who.reason, title: '', uri: '', bvid: null, source: '', raw: '' };
        }
        return {
          at: isoOrNull(it.at_time),
          uid, uname, stranger: false, level: who.level,
          title: (it.item && it.item.title) || '',
          uri: (it.item && it.item.uri) || '',
          bvid: ((it.item && it.item.uri) || '').match(/BV[0-9A-Za-z]{8,14}/)?.[0] || null,
          source: (it.item && it.item.source) || '',
          raw: (it.item && it.item.source_content) ? String(it.item.source_content).slice(0, 60) : '',
        };
      }));
    } else if (at.code !== 0) out.error = 'at:' + at.code + ' ' + (at.message || '');
    const ses = await biliGet('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group=1&build=0&mobi_app=web&platform=web');
    if (ses.code === 0 && ses.data && Array.isArray(ses.data.session_list)) {
      const raw = ses.data.session_list.slice(0, 20).map(x => {
        let txt = '';
        if (x.last_msg) {
          try {
            const o = JSON.parse(x.last_msg.content || '{}');
            txt = o.content || o.text || o.title || '';
          } catch { txt = ''; }
        }
        const uid = Number(x.talker_id) || 0;
        // 系统账号（登录通知/服务号）的 talker_id 是 15 位以上伪 id，不是真实用户
        return {
          uid, uname: x.talker_name || (x.last_msg && x.last_msg.name) || '',
          unread: x.unread_count || 0, last: String(txt).slice(0, 40),
          ts: isoOrNull(x.session_ts), system: uid >= 1e14,
        };
      }).filter(x => !x.system);
      // 会话接口不下发昵称：按 mid 反查一次名片补上（结果进程内缓存）
      out.dms = await Promise.all(raw.map(async x => {
        const who = await inbound.identify(x.uid);
        if (!who.ok) {
          try { inbound.noteStranger({ uid: x.uid, uname: x.uname, unread: x.unread }); } catch (e) {}
          return { ...x, stranger: true, level: who.level, reason: who.reason, last: '', bvid: null, noRead: true };
        }
        const video = await dmLatestVideo(x.uid);
        const extra = video ? { bvid: video.bvid, cardTitle: video.cardTitle, msgType: video.msgType } : { bvid: null };
        if (x.uname) return { ...x, ...extra };
        const cached = unameCache.get(x.uid);
        if (cached) return { ...x, uname: cached, ...extra };
        try {
          const c = await biliGet('https://api.bilibili.com/x/web-interface/card?mid=' + x.uid);
          const nm = c.code === 0 && c.data && c.data.card && c.data.card.name;
          if (nm) { unameCache.set(x.uid, nm); return { ...x, uname: nm, ...extra }; }
        } catch {}
        return { ...x, uname: 'uid ' + x.uid, ...extra };
      }));
    } else if (ses.code !== 0) out.error = (out.error ? out.error + ' / ' : '') + 'dm:' + ses.code;
    const un = await biliGet('https://api.vc.bilibili.com/session_svr/v1/session_svr/single_unread?unread_type=0&build=0&mobi_app=web&platform=web');
    if (un.code === 0 && un.data) out.unread = un.data;
  } catch (e) { out.error = String(e && e.message || e); }
  inboxCache = { at: Date.now(), data: out };
  return out;
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* 路由处理函数。两种承载方式共用同一份实现：
   ①独立模式：本文件直接运行 → 自己 listen 127.0.0.1:8791（下面 isMain 分支）
   ②宿主内模式：被 DSH 插件 import → 挂到宿主 webServer 的 /video-panel 前缀下
   参考 billion-context（dist/agent/dsh-native.js）的做法：ctx.inject(['webServer'], sub =>
     sub.effect(() => sub.webServer.register({ kind:'prefix', path:'/bili', handler }), '…'))
   同源、同端口、随 DSH 启停，不需要第二个进程/端口/计划任务。 */
/* 找 DSH GUI 端口：netstat 列出本机监听端口 → 逐个探 /video-panel/api/health（只有挂在宿主里的我们才 200） */
let _guiPortCache = { port: 0, at: 0 };
async function findGuiPort() {
  const now = Date.now();
  if (_guiPortCache.port && now - _guiPortCache.at < 60000) return _guiPortCache.port;
  let out = '';
  try { out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 4000 }); }
  catch (e) { return 0; }
  const cands = new Set();
  for (const line of String(out).split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const m = line.match(/127\.0\.0\.1:(\d{2,5})\s/);
    if (!m) continue;
    const p = Number(m[1]);
    if (!p || p === port || p < 1024) continue;
    cands.add(p);
  }
  const hits = [];
  const probe = (p) => new Promise((resolve) => {
    const rq = http.get({ host: '127.0.0.1', port: p, path: '/video-panel/api/health', timeout: 500 }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; if (b.length > 4000) rq.destroy(); });
      r.on('end', () => { try { const j = JSON.parse(b); if (j && j.ok && j.version) hits.push(p); } catch (e) {} resolve(); });
    });
    rq.on('timeout', () => { rq.destroy(); resolve(); });
    rq.on('error', () => resolve());
  });
  await Promise.all([...cands].map(probe));
  const p = hits.sort((a, b) => a - b)[0] || 0;
  _guiPortCache = { port: p, at: Date.now() };
  return p;
}
function createPanelHandler() {
  return (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const u = decodeURIComponent(url.pathname);

  /* ── 客户端自检上报：浏览器里那个「🐟 视频面板」按钮到底装上没有 ──
     插件把面板挂到宿主 webServer（/video-panel）之后，UI 是否真的渲染出来，服务端是看不见的。
     所以那侧的 client.js 会在 apply / 首次渲染 / 点击时往这里打一行，落 logs\plugin-client.log。
     参数用 query（GET + 信标）—— 只要能上报成功，就说明浏览器里那段代码确实跑到了。 */
  /* ── 让宿主用「系统默认浏览器」打开面板 ──
     DSH 桌面版（Electron）会拦 window.open / target=_blank（点了没反应就是这个原因），
     所以别在渲染进程里开窗：这里由宿主 spawn `cmd /c start "" <url>`，等于双击一个网址，
     交给 Windows 默认浏览器。URL 只允许本机回环地址（防被页面塞任意链接当跳板）。 */
  /* ── /go：桌面快捷方式用的固定地址。先探出正在运行的 DSH GUI 端口，再 302 到它的 /video-panel/。
     这样 GUI 端口每次重启都变也没关系（快捷方式永远指向 8791/go）。 ── */
  if (u === '/go') {
    findGuiPort().then((found) => {
      if (found) {
        const to = 'http://127.0.0.1:' + found + '/video-panel/';
        try { fs.appendFileSync(path.join(DATA, 'logs', 'plugin-client.log'), JSON.stringify({ at: new Date().toISOString(), stage: 'go', ok: '1', detail: to }) + '\n'); } catch (e) {}
        res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>视频面板</title><body style="font:14px/1.7 system-ui;background:#0f1419;color:#d7e0ea;padding:40px"><h2>没找到正在运行的 DSH 界面</h2><p>先启动 DeepSeek Harness（桌面应用），再刷新本页。</p><p>独立面板：<a style="color:#7ac0ff" href="/">点这里打开（8791）</a></p></body>');
    }).catch(() => { try { res.writeHead(500); res.end('go failed'); } catch (e) {} });
    return;
  }
  if (u === '/api/open') {
    const hostHdr = String(req.headers.host || '127.0.0.1:8791').replace(/[^0-9a-zA-Z.:\[\]-]/g, '');
    const want = String(url.searchParams.get('url') || '').trim();
    const target = want || ('http://' + hostHdr + (req.__panelBase || '') + '/');
    let parsed = null;
    try { parsed = new URL(target) } catch (e) { parsed = null; }
    const loopback = parsed && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || parsed.hostname === '::1');
    if (!parsed || parsed.protocol !== 'http:' || !loopback) {
      json(res, { ok: false, error: 'only loopback http url allowed', target }, 400);
      return;
    }
    try {
      spawn(process.env.ComSpec || 'C:/Windows/System32/cmd.exe', ['/c', 'start', '', parsed.toString()], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
      fs.appendFileSync(path.join(DATA, 'logs', 'plugin-client.log'),
        JSON.stringify({ at: new Date().toISOString(), stage: 'open-browser', ok: '1', detail: parsed.toString() }) + '\n');
      json(res, { ok: true, opened: parsed.toString() });
    } catch (e) {
      json(res, { ok: false, error: String(e) }, 500);
    }
    return;
  }

  /* ── B2：B 站登录态（只读 nav）──
     60 秒缓存（?force=1 强刷）；cookie 缺失 / 失效 / 风控都返回结构体而不是 500，
     账号卡读不出来不能把整页带崩。following/fans 顺带查 relation/stat，失败留 null。 */
  if (u === '/api/account') {
    if (req.method !== 'GET') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    accountInfo(url.searchParams.get('force') === '1')
      .then(d => json(res, d))
      .catch(e => json(res, { ok: false, loggedIn: false, error: String((e && e.message) || e).slice(0, 160) }, 503));
    return;
  }

  /* ── B3：资源管理器打开某条产物目录（只接受 out/<bv>，不接受任意路径）── */
  if (u === '/api/open-folder') {
    if (req.method !== 'POST') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const bv = String((body && (body.bv || body.bvid)) || '');
        if (!isBv(bv)) { json(res, { ok: false, error: 'bad-bv' }, 400); return; }
        const outRoot = path.join(DATA, 'out');
        const dir = path.resolve(outRoot, bv);
        if (dir !== outRoot && !dir.startsWith(outRoot + path.sep)) { json(res, { ok: false, error: 'bad-path' }, 400); return; }
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { json(res, { ok: false, error: 'not-found', bv }, 404); return; }
        try {
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } catch (e) {
          json(res, { ok: false, error: 'open-failed', path: dir }, 500);
          return;
        }
        json(res, { ok: true, path: dir });
      } catch (e) { json(res, { ok: false, error: String((e && e.message) || e).slice(0, 120) }, 400); }
    });
    return;
  }

  if (u === '/api/plugin-report') {
    try {
      const q = url.searchParams;
      const line = JSON.stringify({
        at: new Date().toISOString(),
        stage: String(q.get('stage') || '').slice(0, 40),
        ok: String(q.get('ok') || '').slice(0, 10),
        detail: String(q.get('detail') || '').slice(0, 300),
        slot: String(q.get('slot') || '').slice(0, 80),
        href: String(q.get('href') || '').slice(0, 200),
        ua: String(req.headers['user-agent'] || '').slice(0, 90),
      });
      fs.appendFileSync(path.join(DATA, 'logs', 'plugin-client.log'), line + '\n');
    } catch (e) {}
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (u === '/api/overview') { try { json(res, overview()); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  if (u === '/api/runs') {
    try {
      const q = url.searchParams;
      /* 兼容老调用：只给 limit（没有 page/size）→ 老行为 {rows:[...]}，字段不变 */
      if (q.has('limit') && !q.has('page') && !q.has('size')) {
        const limit = Math.min(2000, Number(q.get('limit') || 500) || 500);
        json(res, { rows: runs(limit).map(enrich) });
        return;
      }
      /* v31：账本分页 + 排序（用户 m03774⑤）。sum 是全量合计，不受分页影响 */
      const page = Math.max(1, Math.floor(Number(q.get('page') || 1) || 1));
      const size = Math.min(200, Math.max(1, Math.floor(Number(q.get('size') || 20) || 20)));
      const sort = ['at', 'dur', 'yuan', 'tok', 'mm'].includes(String(q.get('sort') || '')) ? String(q.get('sort')) : 'at';
      const order = String(q.get('order') || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
      const all = runs(2000).map(enrich);
      const sortVal = (r) => sort === 'dur' ? Number(r.duration_sec || 0)
        : sort === 'yuan' ? Number(r.yuan || 0)
          : sort === 'tok' ? Number(r.total_tokens || 0)
            : sort === 'mm' ? Number(r.mm || 0)
              : (new Date(r.at).getTime() || 0);
      const dir = order === 'asc' ? 1 : -1;
      all.sort((a, b) => (sortVal(a) - sortVal(b)) * dir || (Number(b.id || 0) - Number(a.id || 0)));
      const total = all.length;
      const pages = Math.max(1, Math.ceil(total / size));
      const p = Math.min(page, pages);
      const rows = all.slice((p - 1) * size, p * size).map(r => ({ ...r, yuanReal: null }));
      const sum = {
        count: total,
        tokens: all.reduce((n, r) => n + Number(r.total_tokens || 0), 0),
        yuan: +all.reduce((n, r) => n + Number(r.yuan || 0), 0).toFixed(6),
        minutes: +all.reduce((n, r) => n + Number(r.mm || 0), 0).toFixed(1),
      };
      json(res, { ok: true, page: p, size, pages, total, sort, order, rows, sum });
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }
  if (u === '/api/run') {
    try {
      const bv = url.searchParams.get('bv') || '';
      if (!/^BV[0-9A-Za-z]{6,14}$/.test(bv)) { json(res, { error: 'bad bv' }, 400); return; }
      const d = runDetail(bv);
      /* B4-10：产物与账本记录都不存在 → 404 {ok:false,error:'no-artifacts'}，
         前端据此显示「产物已删除」并给「重新入队」，而不是渲染一屏 null。 */
      if (!d.run && !fs.existsSync(path.join(DATA, 'out', bv))) {
        json(res, { ok: false, error: 'no-artifacts', bv }, 404);
        return;
      }
      json(res, d);
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }


  /* ── 队列执行器：真跑 scripts/runner.mjs（异步，轮询 /api/runner）── */
  if (u === '/api/runner/start' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const one = String(body.bv || body.bvid || '');
        json(res, startRunner(Number(body.limit) || 1, String(body.depth || 'T3').toUpperCase(), Boolean(body.force), /^BV[0-9A-Za-z]{6,14}$/.test(one) ? one : null));
      } catch (e) {
        /* B5：不外泄 SyntaxError / 堆栈，只回人话 */
        const raw = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 120);
        const human = /JSON|Unexpected|position/i.test(raw)
          ? '请求体不是合法 JSON'
          : (/^(bad|invalid|参数)/i.test(raw) ? ('参数不合法：' + raw) : ('执行器没起来：' + raw));
        json(res, { ok: false, error: human }, 400);
      }
    });
    return;
  }
  if (u === '/api/runner') { json(res, runnerState()); return; }
  if (u === '/api/templates') { try { json(res, { files: tplList(), info: templateInfo() }); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  if (u === '/api/template' && req.method === 'GET') {
    try {
      const name = url.searchParams.get('name') || 'summary.md';
      json(res, readTpl(name));
    } catch (e) { json(res, { error: String(e) }, 400); }
    return;
  }
  if (u === '/api/template' && req.method === 'POST') {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 400000) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(b || '{}');
        json(res, writeTpl(body.name || 'summary.md', body.text));
      } catch (e) { json(res, { ok: false, error: String(e && e.message || e) }, 400); }
    });
    return;
  }
  if (u === '/api/meta') { try { json(res, meta()); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  if (u === '/api/export' && req.method === 'POST') { try { json(res, exportConfig()); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  if (u === '/api/cache/clear' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const out = clearCache(String(body.which || ''));
        /* B5：which 不在白名单是客户端错误 → 400（而不是 200 + ok:false） */
        json(res, out, out && out.ok === false ? 400 : 200);
      } catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }
  /* ---------- 候选：删除单条 / 清空（写库 status=deleted，不动归档） ---------- */
  if (u === '/api/queue/delete' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        /* 前端发 {bv}（index.html 队列删除 / 撤销都是 bv），插件侧历史上发 {bvid} —— 两个名字都认 */
        const _b = JSON.parse(buf || '{}');
        const bvid = String((_b && (_b.bv || _b.bvid)) || '');
        if (!isBv(bvid)) throw new Error('bad bvid');
        const row = lib.get(bvid);
        /* A2-04：runner 正在跑这条时不允许删 —— runner 收尾会把行写回 seen，
           删了也会被"复活"（/api/queue/restore 才是撤销的正路）。 */
        if (row && row.status === 'running') { json(res, { ok: false, error: 'running', bvid }, 409); return; }
        /* A5-03：删除 = 记录置 deleted + 产物/缓存移进 out/.trash（不真删）。
           5 秒撤销走 /api/queue/restore；超过 600s 由 sweepTrash 惰性真删。 */
        let freed = 0, trashed = false;
        try { sweepTrash(); } catch (e) { /* ignore */ }
        try { const t = trashBv(bvid); freed = Number(t && t.freed) || 0; trashed = !!(t && t.trashed); } catch (e) { freed = 0; }
        if (row) lib.setStatus(bvid, 'deleted', 'panel-delete');
        json(res, { ok: true, deleted: !!row, status: row ? lib.get(bvid).status : null, freed, trashed });
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }
  /* A5-03：撤销删除 —— 把 out/.trash/<bv>-<ts>/ 里的产物与缓存移回原位；
     记录若已被删（或本来就不在）则重新入队（排到最前，A2-03：fails 清零）。
     契约 2：返回 {ok, restored:[bv...], failed:[{bv,reason}]}，没有回收站产物就报 failed 交给前端降级 enqueue。 */
  if (u === '/api/queue/restore' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const want = Array.isArray(body.bvs) ? body.bvs : (body.bv ? [body.bv] : []);
        const bvs = Array.from(new Set(want.map(v => String(v == null ? '' : v)).filter(isBv))).slice(0, 200);
        try { sweepTrash(); } catch (e) { /* ignore */ }
        const restored = [], failed = [];
        for (const bv of bvs) {
          try {
            const r = restoreBv(bv);
            if (!r || !r.ok) { failed.push({ bv, reason: (r && r.reason) || 'no-trash' }); continue; }
            const row = lib.get(bv);
            if (!row || row.status === 'deleted') lib.mark({ bvid: bv, status: 'queued', prio: 1, fails: 0, note: 'panel-restore' });
            restored.push(bv);
          } catch (e) {
            failed.push({ bv, reason: String((e && e.message) || e).slice(0, 120) });
          }
        }
        try { emitEvent('queue.restore', { restored: restored.length, failed: failed.length }); } catch (e) {}
        json(res, { ok: true, restored, failed });
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }
  /* v49 A1：异常行「↻ 重试」—— 只接受 failed → queued 且失败计数清零（与「→排队」立刻起跑的语义不同）。
     行不存在 404、状态不是 failed 409、非 POST 405。 */
  if (u === '/api/queue/retry') {
    if (req.method !== 'POST') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const bvid = String((body && (body.bvid || body.bv)) || '');
        if (!isBv(bvid)) { json(res, { ok: false, error: 'bad bvid' }, 400); return; }
        const row = lib.get(bvid);
        if (!row) { json(res, { ok: false, error: 'not-found' }, 404); return; }
        if (row.status !== 'failed') { json(res, { ok: false, error: 'not-failed', status: row.status }, 409); return; }
        lib.mark({ bvid, status: 'queued', fails: 0, note: 'panel-retry' });
        json(res, { ok: true, bv: bvid, status: 'queued' });
      } catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }
  /* 手动投递这一条（面板「📨 投递这条」）：只投云端正式版，mode='dry' 只看不发 */
  if (u === '/api/deliver' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const bv = String((body && body.bvid) || '');
        if (!/^BV[0-9A-Za-z]{6,14}$/.test(bv)) { json(res, { ok: false, error: 'bad bvid' }, 400); return; }
        /* B4：缺省 dry（只看不发），只接受 dry|send；别的值明确 400，别再猜 */
        const raw = body && body.mode;
        const mode = raw == null || raw === '' ? 'dry' : String(raw);
        if (mode !== 'dry' && mode !== 'send') { json(res, { ok: false, error: 'mode must be dry|send' }, 400); return; }
        json(res, spawnDeliver(bv, mode));
      } catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }
  /* 升格：候选/异常 → 排队中（手动点，prio=1 最高） */
  if (u === '/api/deliver/state') {
    json(res, { running: DELIVER.running, queue: DELIVER.queue, last: DELIVER.last, target: pushTarget(), targets: dmTargets().map(t => ({ uid: String(t.uid), name: t.name })) });
    return;
  }
  if (u === '/api/inbound' && req.method === 'GET') {
    let cfg = {};
    try { cfg = (readPacing().inbound) || {}; } catch (e) {}
    return json(res, {
      ok: true,
      stats: inbound.stats(),
      events: inbound.list(null, 60),
      strangers: inbound.strangers(20),
      risk: bili_risk(),
      cfg,
    });
  }
  /* B5：/api/inbox/tick = 立刻跑一次入站巡检（会写库，所以只允许 GET 触发） */
  if (u === '/api/inbox/tick') {
    if (req.method !== 'GET') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    const dry = url.searchParams.get('dry') === '1';
    inboundTick({ dry }).then(r => json(res, { ok: true, ...r })).catch(e => json(res, { ok: false, error: String((e && e.message) || e) }, 500));
    return;
  }

  /* ---------- v23：权限矩阵（真能设置，写 config/pacing.json.permissions） ---------- */
  if (u === '/api/permissions' && req.method === 'GET') {
    try { json(res, permissionsPayload()); }
    catch (e) { json(res, { ok: false, error: String(e && e.message || e) }, 500); }
    return;
  }
  if (u === '/api/permissions' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(buf || '{}'); } catch (e) { return json(res, { ok: false, error: 'body 不是合法 JSON' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, { ok: false, error: 'body 必须是对象' }, 400);
      try {
        writePermissions(body);
        json(res, permissionsPayload());
      } catch (e) { json(res, { ok: false, error: String(e && e.message || e) }, (e && e.statusCode) || 500); }
    });
    return;
  }
  /* ---------- v23：待审（只显示需要人拍板的） ---------- */
  if (u === '/api/inbound/pending' && req.method === 'GET') {
    try {
      const { items, strangersMore } = pendingItems();
      json(res, { ok: true, count: items.length, autoToday: todayAutoCount(), strangersMore: strangersMore || 0, items });
    } catch (e) { json(res, { ok: false, error: String(e && e.message || e) }, 500); }
    return;
  }
  if (u === '/api/inbound/decide' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const key = String((body && body.key) || '');
        const action = String((body && body.action) || '');
        if (!key) return json(res, { ok: false, error: '需要 key' }, 400);
        if (action !== 'allow' && action !== 'drop') return json(res, { ok: false, error: 'action 只能是 allow / drop' }, 400);
        json(res, decideInbound(key, action));
      } catch (e) {
        const code = e && e.statusCode === 400 ? 400 : 500;
        json(res, { ok: false, error: String(e && e.message || e) }, code);
      }
    });
    return;
  }
  if (u === '/api/inbound/history' && req.method === 'GET') {
    try {
      json(res, inboundHistory(url.searchParams.get('page'), url.searchParams.get('size')));
    } catch (e) { json(res, { ok: false, error: String(e && e.message || e) }, 500); }
    return;
  }

  if (u === '/api/queue/promote' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { bvid, status } = JSON.parse(buf || '{}');
        if (!/^BV[0-9A-Za-z]{6,14}$/.test(String(bvid || ''))) throw new Error('bad bvid');
        const to = status === 'candidate' ? 'candidate' : 'queued';
        const r = lib.setStatus(bvid, to, to === 'queued' ? 'panel-promote' : 'panel-back-to-candidate');
        if (r && to === 'queued') lib.mark({ bvid, status: 'queued', prio: 1, note: 'panel-promote' });
        json(res, { ok: true, bvid, status: to });
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }
  if (u === '/api/queue/clear' && req.method === 'POST') {
    try {
      const rows = lib.list(['candidate'], 500);
      for (const r of rows) lib.setStatus(r.bvid, 'deleted', 'panel-clear');
      // 旧候选 JSON 归档留证（不再当数据源）
      const dir = path.join(DATA, 'out', 'pick');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^cand-.*\.json$/.test(f)) : [];
      const arch = path.join(dir, 'archive'); fs.mkdirSync(arch, { recursive: true });
      for (const f of files) { try { fs.renameSync(path.join(dir, f), path.join(arch, f)); } catch {} }
      json(res, { ok: true, cleared: rows.length, archivedFiles: files.length });
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  if (u === '/api/archive' && req.method === 'GET') {
    try {
      const page = Number(url.searchParams.get('page') || 1);
      const size = Math.min(300, Math.max(1, Number(url.searchParams.get('size') || 10)));
      json(res, archiveList(page, size));
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }
  if (u === '/api/archive/neighbors' && req.method === 'GET') {
    try { json(res, archiveNeighbors(String(url.searchParams.get('bv') || ''))); }
    catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }
  /* ---------- v26：归档批量删除（产物+缓存一起删；记录默认保留） ---------- */
  if (u === '/api/archive/delete' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try { json(res, archiveDelete(JSON.parse(buf || '{}'))); }
      catch (e) { json(res, { ok: false, error: String((e && e.message) || e).replace(/^Error:\s*/, '') }, (e && e.status) || 400); }
    });
    return;
  }
  /* ---------- v26：缓存清理策略（保留天数 / 跑完后 / 立即清理） ---------- */
  if (u === '/api/storage' && req.method === 'GET') {
    try { json(res, storagePayload()); } catch (e) { json(res, { ok: false, error: String(e) }, 500); }
    return;
  }
  if (u === '/api/storage' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try { json(res, writeStorage(JSON.parse(buf || '{}'))); }
      catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }
  if (u === '/api/cache/sweep' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try { const body = JSON.parse(buf || '{}'); json(res, runCacheSweep(body && body.dry === true)); }
      catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }
  /* ---------- v26：重跑本地判否说明（面板「重试」按钮） ---------- */
  if (u === '/api/why/rebuild' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const bv = String((body && body.bvid) || '');
        if (!isBv(bv)) { json(res, { ok: false, started: false, error: 'bad bvid' }, 400); return; }
        json(res, spawnWhyRebuild(bv));
      } catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }

  if (u === '/api/queue') { try { json(res, queue()); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  /* v44：偏好页「最近一次选片」——只读最近的非空 cand 文件，不触发抓取 */
  if (u === '/api/picks') {
    if (req.method !== 'GET') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    try { json(res, latestPicks(url.searchParams.get('limit'))); }
    catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  if (u === '/api/prefs' && req.method === 'GET') { json(res, readPrefs()); return; }
  if (u === '/api/prefs' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, { error: 'body must be object' }, 400); return; }
        json(res, writePrefs(body));
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }

  /* v45：类目搜索词建议 + 试搜（只读；suggest GET，try POST） */
  if (u === '/api/prefs/suggest') {
    if (req.method !== 'GET') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    try { json(res, prefsSuggest()); } catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 500); }
    return;
  }
  if (u === '/api/prefs/try') {
    if (req.method !== 'POST') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(buf || '{}');
        json(res, await prefsTry(body && typeof body === 'object' ? body : {}));
      } catch (e) {
        json(res, { ok: false, error: (e && e.code) || String((e && e.message) || e) }, (e && e.status) || 400);
      }
    });
    return;
  }

  if (u === '/api/summary/queue' && req.method === 'GET') {
    try {
      const rows = pendingSummaries();
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      let writtenToday = 0;
      try { const t = localDay(new Date()); for (const bv of fs.readdirSync(path.join(DATA, 'out'))) { const f = path.join(DATA, 'out', bv, 'summary.cloud.json'); if (fs.existsSync(f) && localDay(JSON.parse(fs.readFileSync(f, 'utf8')).at) === t) writtenToday++; } } catch (e) {}
      const s = readSummarize();
      const cap = autoWriteCap();
      const backlog = rows.length;
      const writerAlive = Date.now() - WATCH.lastBeat < 180000;
      json(res, {
        total: rows.length, rows: rows.slice(0, limit), mode: s.mode,
        writePolicy: '1to1', ratio: null, cap, safety: cap, writtenToday, backlog,
        writer: { alive: writerAlive, lastWhy: WATCH.lastWhy || '', lastBv: WATCH.lastBv || '', lastBeat: WATCH.lastBeat ? new Date(WATCH.lastBeat).toISOString() : null },
        nextDueAt: null,
      });
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }
  if (u === '/api/summary/write' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(buf || '{}');
        json(res, applySummaryWrite(b));
      } catch (e) {
        /* B5：错误串去掉 'Error: ' 前缀（前端直接展示，不给人看堆栈味） */
        const msg = String((e && e.message) || e).replace(/^Error:\s*/, '');
        json(res, { ok: false, error: msg }, (e && e.status) || 400);
      }
    });
    return;
  }
  if (u === '/api/watch/beat' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = buf ? JSON.parse(buf) : {};
        WATCH.lastBeat = Date.now();
        WATCH.beats++;
        WATCH.lastWhy = String(b.why || '').slice(0, 60);
        WATCH.lastBv = String(b.bvid || '').slice(0, 20);
        json(res, { ok: true, beats: WATCH.beats });
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }
  if (u === '/api/queue/history' && req.method === 'GET') {
    try {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      const byBv = new Map();
      for (const r of archiveRows()) byBv.set(r.bvid, r);
      const rows = (lib.exited ? lib.exited(limit) : []).map(r => {
        const a = byBv.get(r.bvid) || {};
        return {
          bvid: r.bvid,
          title: r.title || a.title || r.bvid,
          first_seen: r.first_seen || null, // v23：队列「入列时间」列
          up: r.up || a.up || '',
          via: r.via || a.source || '',
          status: r.status,
          exit_reason: r.exit_reason || a.sum_why || '',
          exited_at: r.exited_at,
          dur_sec: r.dur_sec || a.duration_sec || 0,
          tokens: a.tokens || 0,
          fen: a.fen || 0,
          summary: a.summary || 'none',
          gate: a.gate || null,
          gate_zh: a.gate_zh || null,
          source_zh: isVodVia(r.via || a.source) ? VOD_PASS.zh : '',
          /* A2-06：has_artifact 以磁盘为准（账本里有行 ≠ 产物还在）；deleted_at 说明记录何时被删 */
          has_artifact: fs.existsSync(path.join(DATA, 'out', r.bvid)),
          deleted_at: r.deleted_at || null,
          dm_sent: !!a.dm_sent,
          comment_sent: !!a.comment_sent,
        };
      });
      json(res, { rows, total: rows.length, watch: { alive: Date.now() - WATCH.lastBeat < 180000, lastWhy: WATCH.lastWhy || '', lastBv: WATCH.lastBv || '' } });
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }
  if (u === '/api/health' && req.method === 'GET') {
    try {
      const c = lib.counts();
      json(res, { ok: true, version: PANEL_VERSION, at: new Date().toISOString(), db: true, counts: c, runner: { running: RUNNER.running, startedAt: RUNNER.startedAt }, dispatch: { ticks: DISP.ticks, lastSkip: DISP.lastSkip || null },
        watch: { beats: WATCH.beats, alive: Date.now() - WATCH.lastBeat < 180000, lastWhy: WATCH.lastWhy || '', lastBv: WATCH.lastBv || '', lastBeat: WATCH.lastBeat ? new Date(WATCH.lastBeat).toISOString() : null } });
    } catch (e) { json(res, { ok: false, error: String(e) }, 500); }
    return;
  }
  /* ── 入队（唯一入口；B1：/api/status 已删）──
     body 可以是 {items:[...]} 或单条 {bvid,...}；非法 bvid 记进 skipped 并说明原因，
     一条有效都没有就 400 no-valid-bvid（而不是假装成功 200）。 */
  if (u === '/api/enqueue' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        const list = Array.isArray(body.items) ? body.items : [body];
        const ok = [], skipped = [];
        const D = { ...PACING_DEFAULT.dispatch, ...(readPacing().dispatch || {}) };
        for (const it of list) {
          const bvid = String((it && (it.bvid || it.bv)) || '');
          if (!isBv(bvid)) { skipped.push({ bvid: bvid || null, reason: 'bad-bvid' }); continue; }
          // 入队：手动/入站/gray 都是最高优先级（prio=1），同类内先到先跑
          const via = String((it && it.via) || 'manual');
          const isManual = isVodVia(via);
          const c = lib.counts();
          if (isManual && c.manualOpen >= D.manualCap) { skipped.push({ bvid, reason: `手动/入站已达上限 ${c.manualOpen}/${D.manualCap}` }); continue; }
          lib.mark({
            bvid, status: 'queued', prio: isManual ? 1 : 0, via,
            score: it.score ?? null, depth: it.depth || 'T3',
            title: it.title || null, up: it.up || it.author || null, note: it.note || 'panel-enqueue',
            /* A2-03：重新入队必须把连续失败清零，否则刚入队就因旧 fails 再次转 failed */
            fails: 0,
          });
          ok.push(bvid);
        }
        if (!ok.length) {
          json(res, { ok: false, error: 'no-valid-bvid', count: 0, bvids: [], skipped, stats: lib.stats() }, 400);
          return;
        }
        json(res, { ok: true, count: ok.length, bvids: ok, skipped, stats: lib.stats() });
      } catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }
  /* B5：/api/inbox/poll = 插件长轮询「读」一次入站结果（只 GET，别拿来触发写） */
  if (u === '/api/inbox/poll') {
    if (req.method !== 'GET') { json(res, { ok: false, error: 'method-not-allowed' }, 405); return; }
    inboxPollerOnce().then(d => json(res, d)).catch(e => json(res, { ok: false, error: String((e && e.message) || e) }, 500));
    return;
  }
  if (u === '/api/inbox') {
    inbox(url.searchParams.get('force') === '1').then(d => json(res, d)).catch(e => json(res, { error: String(e) }, 500));
    return;
  }
  if (u === '/api/mutual') {
    const force = url.searchParams.get('force') === '1';
    mutualList(force).then(d => json(res, { at: d.at, list: d.list }))
      .catch(e => json(res, { error: String(e), list: [] }, 500));
    return;
  }
  if (u === '/api/push' && req.method === 'GET') { pushDetail().then(d => json(res, d)).catch(e => json(res, { error: String(e) }, 500)); return; }
  if (u === '/api/push' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        json(res, writePush(body));
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }
  /* ---------- 门禁阈值 ---------- */
  if (u === '/api/gate' && req.method === 'GET') { try { json(res, readGate()); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  if (u === '/api/gate' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try { json(res, writeGate(JSON.parse(buf || '{}'))); } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }

  /* ---------- 总结来源 ---------- */
  if (u === '/api/summarize' && req.method === 'GET') { try { json(res, readSummarize()); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  if (u === '/api/summarize' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try { json(res, writeSummarize(JSON.parse(buf || '{}'))); } catch (e) { json(res, { error: String(e.message || e) }, 400); }
    });
    return;
  }
  if (u === '/api/summarize/test' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(buf || '{}'); } catch {}
      testSummarize(body).then(d => json(res, d)).catch(e => json(res, { error: String(e.message || e) }, 400));
    });
    return;
  }

  if (u === '/api/pacing' && req.method === 'GET') {
    try {
      const p = readPacing();
      /* v48：前端永远拿到新形状（旧 blackout/trough 配置在读取时迁移，不写盘）；
         顶层 apiTrough = 价目表算出的谷时（前端据此渲染并锁定时段，不许自己另算一份）。 */
      const prc = readPricing();
      p.runWindow = normalizeRunWindow(p.runWindow, prc);
      p.apiTrough = apiTroughInfo(prc);
      json(res, p);
    } catch (e) { json(res, { error: String(e) }, 500); } return;
  }
  if (u === '/api/pacing' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        json(res, writePacing(body));
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }
  /* ---------- v26：人设真生效预览（总结规则 / 评论 / 私信，三种 target） ---------- */
  if (u === '/api/persona/preview' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e5) req.destroy(); });
    req.on('end', async () => {
      try { json(res, await personaPreview(JSON.parse(buf || '{}'))); }
      catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 400); }
    });
    return;
  }
  if (u === '/api/persona' && req.method === 'GET') {
    try {
      const p = readPersona();
      /* v26：附带渲染后的人设文本/一句话概览/主键（面板个性化页与预览区直接用，免得前端自己拼） */
      let extra = { personaText: '', personaSummary: '', personaKey: 'none' };
      try {
        const lp = readPersonaLib();
        extra = { personaText: personaText(lp), personaSummary: personaSummary(lp), personaKey: personaKey(lp) };
      } catch (e) { /* 人设文件缺失时旧契约仍返回，别让整个接口挂掉 */ }
      json(res, { ...p, ...extra });
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }
  if (u === '/api/persona' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, { error: 'body must be object' }, 400); return; }
        json(res, writePersona(body));
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }
  if (u === '/api/pricing' && req.method === 'GET') { json(res, readPricing()); return; }
  if (u === '/api/budget' && req.method === 'GET') { json(res, readJsonFile('config/budget.json', { daily: 1, weekly: 5, monthly: 20, warnPct: 80, overAction: 'degrade' })); return; }
  if (u === '/api/cost') { try { json(res, costReport()); } catch (e) { json(res, { error: String(e) }, 500); } return; }
  /* v31：DSH 真实扣款（读 ~/.dsh/.dshw-usage.json，只读；缺失/坏 → {ok:false,error}，不抛） */
  if (u === '/api/usage') { try { json(res, readDshUsage()); } catch (e) { json(res, { ok: false, error: { code: 'usage-bad', zh: 'DSH 计费记录读不出来' } }); } return; }
  if (u === '/api/spend') { try { json(res, readSpendLog(Number(url.searchParams.get('limit') || 40) || 40)); } catch (e) { json(res, { ok: false, error: { code: 'spend-bad', zh: '本插件花费账读不出来：' + String(e && e.message || e).slice(0, 80) } }); } return; }
  if ((u === '/api/pricing' || u === '/api/budget') && req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(buf || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, { error: 'body must be object' }, 400); return; }
        const tag = u === '/api/pricing' ? 'pricing' : 'budget';
        const rel = 'config/' + tag + '.json';
        json(res, writeJsonFile(rel, body, tag));
      } catch (e) { json(res, { error: String(e) }, 400); }
    });
    return;
  }

  // 真实产物的宫格图（只读，按 bvid 白名单）
  const sheet = /^\/sheet\/(BV[0-9A-Za-z]{6,14})\.png$/.exec(u);
  if (sheet) {
    const sdir = path.join(DATA, 'out', sheet[1]);
    let f = path.resolve(path.join(sdir, 'sheet.png'));
    if (!fs.existsSync(f)) {
      // 多张宫格（sheet-1.png / sheet-2.png …）时取第一张
      let pick = null;
      try {
        const cands = fs.readdirSync(sdir).filter(n => /^sheet(-\d+)?\.png$/.test(n)).sort();
        if (cands.length) pick = path.resolve(path.join(sdir, cands[0]));
      } catch (e) {}
      if (pick) f = pick;
    }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); res.end('no sheet for ' + sheet[1]); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  const rel = u === '/' ? 'index.html' : u.replace(/^\/+/, '');
  const file = path.resolve(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    const isHtml = path.extname(file) === '.html';
    /* 挂在宿主前缀下时（插件把本处理器注册到 webServer 的 /video-panel），页面里那些
       写死的绝对路径（fetch('/api/…') 与 img.src='/sheet/…'）要自动加上前缀。
       只在宿主模式下插这段 prelude；独立模式（8791 根路径）什么都不变。 */
    if (isHtml && req.__panelBase) {
      const prelude = `<script>(function(){var B=${JSON.stringify(req.__panelBase)};
var f=window.fetch;window.fetch=function(u,o){try{if(typeof u==='string'&&u.charAt(0)==='/'&&u.indexOf(B)!==0)u=B+u}catch(e){}return f.call(this,u,o)};
var X=window.XMLHttpRequest.prototype.open;window.XMLHttpRequest.prototype.open=function(m,u){try{if(typeof u==='string'&&u.charAt(0)==='/'&&u.indexOf(B)!==0)arguments[1]=B+u}catch(e){}return X.apply(this,arguments)};
try{var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{get:d.get,set:function(v){try{if(typeof v==='string'&&v.charAt(0)==='/'&&v.indexOf(B)!==0)v=B+v}catch(e){}return d.set.call(this,v)}})}catch(e){}
})();</script>`;
      const html = buf.toString('utf8').replace(/<head>/i, (m) => m + prelude);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
  };
}

/* 只有"直接运行本文件"时才自己开端口（独立模式）。
   被插件 import 时不监听、也不跑轮询——那些由插件按 DSH 生命周期管理。 */
const isMain = (() => {
  try { return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url }
  catch (e) { return false }
})();

/* 宿主内模式（被插件 import）唯一的出口：面板请求处理器。
   必须有这一行——2026-10-31 /video-panel/* 全部 503 的根因就是它缺失
   （plugin/index.js 里 `m.createPanelHandler` 拿到 undefined）。 */
export { createPanelHandler };

if (isMain) {
  const server = http.createServer(createPanelHandler());

  /* 端口被占用时不要变成"活着但没监听"的僵尸进程：
     计划任务与插件可能同时拉面板，第二份若静默崩掉，插件的 /api/health 探测就一直失败、
     每 20 秒再拉一个，越堆越多。这里显式识别 EADDRINUSE 并以 0 退出（单实例语义）。 */
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.log(`[panel] 端口 ${port} 已被占用，本进程退出（单实例）`);
      process.exit(0);
    }
    console.error('[panel] server error:', e && (e.stack || e.message || e));
    try { fs.appendFileSync(path.join(DATA, 'logs', 'panel-server.crash.log'), `[${new Date().toISOString()}] server error: ${e && (e.stack || e.message || e)}\n`); } catch (_) {}
  });

  server.listen(port, '127.0.0.1', () => console.log(`[panel] http://127.0.0.1:${port}  面板：11 页全部真实数据（logs/*.db、config/*.json、secrets/bili.json）；无演示按钮；写盘走备份→原子写→审计`));
  startInboxPoller();
}

