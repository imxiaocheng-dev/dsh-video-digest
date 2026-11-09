// B 站 API 访问层（已实测：登录态 nav/playurl/subtitle 全通）
// 只读，不发任何写请求（不投币、不点赞、不评论）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_ROOT } from './paths.mjs';

// 数据目录：凭证不随包发布，放数据目录（旧布局下就是包根，本机行为不变）
export const ROOT = DATA_ROOT;
export const SECRETS = path.join(ROOT, 'secrets', 'bili.json');
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// B 站 cookie 名大小写敏感，必须用规范名。
const CANON = [['sessdata', 'SESSDATA'], ['bili_jct', 'bili_jct'], ['dede_user_id', 'DedeUserID'], ['buvid3', 'buvid3']];

export function cookie() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  } catch (e) {
    const hint = e && e.code === 'ENOENT'
      ? `还没登录 B 站：找不到 ${SECRETS}。`
      : `登录凭证读不了（${SECRETS}）：${e && e.message}`;
    const err = new Error(`${hint} 先在包根跑一次 python scripts/bili_qrlogin.py login 扫码登录（见 README「扫码登录」）。`);
    err.code = 'VD_NO_COOKIE';
    throw err;
  }
  return raw;
}

export function cookieHeader(c = cookie()) {
  return CANON.filter(([k]) => c[k]).map(([k, n]) => `${n}=${c[k]}`).join('; ');
}

export function headers(c) {
  return {
    'User-Agent': UA,
    Cookie: cookieHeader(c),
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
  };
}

const WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

let _wbi = null; // { mixin, at }
let _lastReq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle(minGap = 800) {
  // 加抖动：固定间隔本身就是机器指纹
  const wait = _lastReq + minGap + Math.floor(Math.random() * 400) - Date.now();
  if (wait > 0) await sleep(wait);
  _lastReq = Date.now();
}

export async function jget(url, { retries = 2, gap = 800, timeout = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    // A3-02：风控冷却窗口内一律不再发请求（以前只有 bget 认 _riskUntil，api/view/playurl/下载全都照发）
    const left = _riskUntil - Date.now();
    if (left > 0) {
      // 重试时把「第一次那一拍的真实错因」带出去，别用笼统的冷却提示盖掉
      if (lastErr && /风控/.test(String(lastErr.message))) throw lastErr;
      throw new Error(`风控冷却中，还需 ${Math.ceil(left / 1000)}s`);
    }
    try {
      await throttle(gap);
      const res = await fetch(url, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 412 || res.status === 429) {
          // 412 是瞬时风控（实测同秒连发会被随机拦一条），冷却 2–5s 而不是 30s，否则一条 412 能拖死整批
          noteRisk(null, res.status, res.headers.get('retry-after'), 5000);
          await sleep(2000 + Math.random() * 3000);
          throw new Error(`HTTP ${res.status} 风控`);
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      }
      if (text.trimStart().startsWith('<')) throw new Error('返回 HTML（疑似风控页）');
      const j = JSON.parse(text);
      // 业务风控码（-352/-509/-412/-799/-10403）也进冷却，dispatch 才能看到 riskState
      if (RISK_CODES.has(Number(j && j.code))) {
        noteRisk(j.code, res.status, res.headers.get('retry-after'));
        throw new Error(`${j.code} 风控`);
      }
      return j;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(600 * 2 ** i + Math.floor(Math.random() * 500));
    }
  }
  throw new Error(`请求失败 ${url}: ${lastErr?.message}`);
}

async function wbiMixin() {
  if (_wbi && Date.now() - _wbi.at < 3600e3) return _wbi.mixin;
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav');
  const img = nav?.data?.wbi_img?.img_url || '';
  const sub = nav?.data?.wbi_img?.sub_url || '';
  if (!img || !sub) throw new Error('拿不到 wbi_img');
  const ik = img.split('/').pop().split('.')[0];
  const sk = sub.split('/').pop().split('.')[0];
  const mixin = WBI_TAB.map((i) => (ik + sk)[i]).join('').slice(0, 32);
  _wbi = { mixin, at: Date.now() };
  return mixin;
}

export async function signedQuery(params) {
  const mixin = await wbiMixin();
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join('&');
  const w_rid = crypto.createHash('md5').update(q + mixin).digest('hex');
  return `${q}&w_rid=${w_rid}`;
}

export async function api(pathname, params = {}, { sign = false } = {}) {
  const base = 'https://api.bilibili.com';
  const qs = sign ? await signedQuery(params) : new URLSearchParams(params).toString();
  return jget(`${base}${pathname}${qs ? '?' + qs : ''}`);
}

export const mdh = (n) => crypto.createHash('md5').update(String(n)).digest('hex');

export async function view(bvid) {
  const r = await api('/x/web-interface/view', { bvid });
  if (r.code !== 0) throw new Error(`view 失败 ${r.code} ${r.message}`);
  return r.data;
}

export async function playurl(d, qn = 80) {
  const r = await api('/x/player/playurl', { avid: d.aid, cid: d.cid, qn, fnval: 4048, fnver: 0, fourk: 1 });
  if (r.code !== 0) throw new Error(`playurl 失败 ${r.code} ${r.message}`);
  return r.data;
}

export async function subtitles(aid, cid) {
  const r = await api('/x/player/wbi/v2', { aid, cid }, { sign: true });
  if (r.code !== 0) throw new Error(`player/wbi/v2 失败 ${r.code} ${r.message}`);
  return r.data?.subtitle?.subtitles || [];
}

export async function search(keyword, { page = 1, pageSize = 20, order = 'totalrank' } = {}) {
  const r = await api('/x/web-interface/search/type', { search_type: 'video', keyword, page, page_size: pageSize, order }, { sign: true });
  if (r.code !== 0) throw new Error(`search 失败 ${r.code} ${r.message}`);
  return r.data?.result || [];
}

/** 把 "12:34" / "1:02:03" 解析成秒 */
export function dur2sec(s) {
  const p = String(s || '').split(':').map(Number);
  if (p.some(Number.isNaN)) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
}

export function fmtDur(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? `${h}:` : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(ss).padStart(2, '0');
}

// ════════════════════════════════════════════════════════════════
// 入站层（私信 / @ 收件箱）
// 设计参考 dsh-bili-whale 的 tools/lib/{dm-history,msgfeed,traffic}.mjs，
// 但去掉它的 20s 固定频率与 JSON 游标；这里只做「读」，状态在 logs/inbound.db。
// ════════════════════════════════════════════════════════════════

/** 风控码表（抄 whale traffic.mjs:164 的实测集合：状态码 + 业务码都要认） */
const RISK_CODES = new Set([-412, -352, -799, -509, -10403]);
let _inflight = null;      // 全局单飞槽：同时只允许一个请求在飞
let _riskStreak = 0;
let _riskUntil = 0;
let _riskLast = null;

export function riskState() {
  return {
    cooling: Date.now() < _riskUntil,
    until: _riskUntil || null,
    streak: _riskStreak,
    last: _riskLast,
  };
}

export function resetRisk() {
  _riskStreak = 0;
  _riskUntil = 0;
  _riskLast = null;
}

/** B 站消息类接口要带 message 站 referer，否则容易 -352 */
function msgHeaders() {
  return { ...headers(), Referer: 'https://message.bilibili.com/', Origin: 'https://message.bilibili.com' };
}

/** 指数退避：base * 2^(n-1)，默认 base=300s、封顶 30min，并尊重 Retry-After。
 *  baseMs 给 412/429 这类「HTTP 瞬时风控」留短冷却（默认 5s，别一条 412 拖死整批）。 */
function noteRisk(code, status, retryAfter, baseMs) {
  const hit = RISK_CODES.has(Number(code)) || status === 412 || status === 429;
  if (!hit) {
    if (_riskStreak) _riskStreak = 0;
    return false;
  }
  _riskStreak += 1;
  const base = Number(baseMs) > 0 ? Number(baseMs) : 300e3;
  const cap = 30 * 60e3;
  let wait = Math.min(cap, base * 2 ** (_riskStreak - 1));
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) wait = Math.max(wait, Math.min(cap, ra * 1000));
  _riskUntil = Date.now() + wait;
  _riskLast = { code: Number(code) || null, status, at: new Date().toISOString(), waitMs: wait };
  return true;
}

async function singleFlight(fn) {
  while (_inflight) {
    try { await _inflight; } catch { /* 前一个失败不影响下一个 */ }
  }
  const p = (async () => fn())();
  _inflight = p;
  try { return await p; } finally { if (_inflight === p) _inflight = null; }
}

async function bget(url, { timeout = 15000 } = {}) {
  const left = _riskUntil - Date.now();
  if (left > 0) throw new Error(`风控冷却中，还需 ${Math.ceil(left / 1000)}s`);
  return singleFlight(async () => {
    await throttle(1200);
    const res = await fetch(url, { headers: msgHeaders(), signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 可能是风控 HTML */ }
    if (noteRisk(j && j.code, res.status, res.headers.get('retry-after'))) {
      throw new Error(`风控 ${res.status}/${j ? j.code : 'non-json'}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
    if (!j) throw new Error('返回非 JSON（疑似风控页）');
    if (j.code !== 0 && j.code !== undefined) throw new Error(`code ${j.code} ${j.message || ''}`);
    return j;
  });
}

/** 平台时间戳两种单位都见过：私信是微秒（16 位），@ 是秒（10 位） */
export function tsMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.round(n / 1000) : Math.round(n * 1000);
}

/**
 * 会话列表：只回答「谁在、几条未读、最后何时」。
 * 刻意不解析 last_msg.content —— 那是平台在列表里就下发的摘要，
 * 按「身份先于内容」的规则，未经身份核实一律不读、不落库、不展示。
 */
export async function sessions() {
  const j = await bget('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&Build=0&mobi_app=web');
  const list = (j.data && j.data.session_list) || [];
  return list.map((s) => ({
    uid: Number(s.talker_id),
    unread: Number(s.unread_count) || 0,
    ts: tsMs(s.session_ts),
  })).filter((s) => Number.isFinite(s.uid) && s.uid > 0);
}

/** 取「我和某人」的私信历史（WBI 签名；只能取自己参与的会话） */
export async function dmHistory(talkerId, { beginSeqno = '', size = 30 } = {}) {
  const params = { talker_id: talkerId, session_type: 1, size, build: 0, mobi_app: 'web' };
  if (beginSeqno) params.begin_seqno = beginSeqno;
  const qs = await signedQuery(params);
  const r = await bget(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?${qs}`);
  const raw = (r.data && r.data.messages) || [];
  const me = Number(cookie().dede_user_id || 0);
  const withdrawn = new Set();
  for (const m of raw) {
    if (Number(m.msg_type) === 5) {
      try {
        const o = JSON.parse(m.content || '{}');
        if (o.msg_key) withdrawn.add(String(o.msg_key));
      } catch { /* 忽略解析失败 */ }
    }
  }
  const msgs = raw.map((m) => {
    let content = m.content;
    let o = null;
    if (typeof content === 'string' && content.trim().startsWith('{')) {
      try { o = JSON.parse(content); } catch { o = null; }
    }
    const text = o && typeof o.content === 'string' ? o.content : (typeof content === 'string' && !content.trim().startsWith('{') ? content : '');
    const card = o && (o.jump_url || o.bvid || o.author || o.title)
      ? { bvid: o.bvid || (String(o.jump_url || '').match(/BV[0-9A-Za-z]{10}/) || [])[0] || '', title: o.title || '', author: o.author || '' }
      : null;
    return {
      key: String(m.msg_key || m.msg_seqno || `${m.timestamp}-${m.sender_uid}`),
      ts: tsMs(m.timestamp),
      sender: Number(m.sender_uid),
      fromMe: Number(m.sender_uid) === me,
      type: Number(m.msg_type) || 0,
      text,
      card,
      withdrawn: withdrawn.has(String(m.msg_key)),
      seqno: m.msg_seqno ? String(m.msg_seqno) : '',
    };
  });
  const seqnos = msgs.map((m) => Number(m.seqno)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    messages: msgs.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)), // 统一升序，便于游标推进
    nextSeqno: seqnos.length ? String(Math.max(...seqnos)) : (beginSeqno || ''),
    maxTs: msgs.reduce((a, m) => Math.max(a, m.ts || 0), 0) || null,
  };
}

/** @ 收件箱（cursor 翻页，有重叠 → 调用方按 id 去重） */
export async function msgfeedAt({ cursor = '' } = {}) {
  const qs = new URLSearchParams({ platform: 'web', build: '0', mobi_app: 'web' });
  if (cursor) qs.set('cursor', cursor);
  const j = await bget(`https://api.bilibili.com/x/msgfeed/at?${qs}`);
  const items = (j.data && j.data.items) || [];
  const c = (j.data && j.data.cursor) || null;
  return {
    cursor: c ? String(c.next ?? c.id ?? c.offset ?? '') : null,
    isEnd: !!(c && c.is_end),
    items: items.map((it) => ({
      id: String(it.id || ''),
      ts: tsMs(it.at_time ?? it.reply_time),
      mid: Number(it.user && it.user.mid) || 0,
      who: (it.user && it.user.nickname) || '',
      title: (it.item && it.item.title) || '',
      source: (it.item && it.item.source_content) || '',
      uri: (it.item && it.item.uri) || '',
      oid: Number(it.item && it.item.subject_id) || 0,
      root: Number(it.item && it.item.root_id) || 0,
      parent: Number(it.item && it.item.source_id) || 0,
      business: Number(it.item && it.item.business_id) || 1,
    })).filter((x) => x.id),
  };
}

/**
 * 楼层回读：收件箱里的 title 不一定是那条新回复的正文，真要知道「对方说了什么」必须回读。
 * 返回 { replies, exact, note }，exact=false 表示没精确定位到 parent，退化用了最后一条。
 */
export async function replyThread({ type = 1, oid, root, parent, mid = 0, maxPages = 6 } = {}) {
  let fallback = null;
  for (let pn = 1; pn <= maxPages; pn++) {
    const r = await api('/x/v2/reply/reply', { type, oid, root, pn, ps: 20 });
    const list = (r.data && r.data.replies) || [];
    if (!list.length) break;
    const mine = mid ? list.filter((x) => Number(x.mid) === Number(mid)) : list;
    const exact = mine.find((x) => String(x.rpid) === String(parent) || String(x.parent) === String(parent));
    if (exact) return { replies: list, exact: true, hit: { rpid: exact.rpid, mid: exact.mid, message: exact.content && exact.content.message, ctime: exact.ctime } };
    if (!fallback && mine.length) {
      const last = mine[mine.length - 1];
      fallback = { rpid: last.rpid, mid: last.mid, message: last.content && last.content.message, ctime: last.ctime };
    }
  }
  return { replies: [], exact: false, hit: fallback, note: fallback ? '未精确定位 parent，退回最后一条同 mid 回复' : '楼层里没有该 mid 的回复' };
}
