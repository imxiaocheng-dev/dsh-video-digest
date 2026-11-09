// 入站台账（私信 / @）—— 游标 + 收据状态机 + 陌生人计数
//
// 设计要点（对照 dsh-bili-whale 的经验）：
//  1. 发现「有人来信」只是第一步；真正处理完才推进游标（至少一次语义），
//     否则进程崩了 / 预算不够 / 被跳过时，用户会看到「我发了它没理我」。
//  2. 所有回调都要幂等：同一条消息（msg_key）不论被 tick 看到几次，只产出一个 receipt。
//  3. 陌生人只统计「有 N 条未读」，不读正文、不落库、不展示。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as bili from './bili.mjs';
import { DATA_ROOT } from './paths.mjs';

// 数据目录：入站台账与推送配置都写这里（旧布局下就是包根，本机行为不变）
export const ROOT = DATA_ROOT;
export const DB_FILE = path.join(ROOT, 'logs', 'inbound.db');
export const PUSH_FILE = path.join(ROOT, 'config', 'push.json');

let _db = null;

export function open() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  _db = new DatabaseSync(DB_FILE);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cursor (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      uid INTEGER NOT NULL,
      uname TEXT,
      msg_key TEXT,
      bvid TEXT,
      title TEXT,
      receipt TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_msgkey ON events(msg_key) WHERE msg_key IS NOT NULL AND msg_key <> '';
    CREATE INDEX IF NOT EXISTS idx_status ON events(status, id DESC);
    CREATE TABLE IF NOT EXISTS strangers (
      uid INTEGER PRIMARY KEY,
      uname TEXT,
      unread INTEGER,
      hits INTEGER DEFAULT 1,
      last_ts INTEGER,
      first_seen TEXT,
      last_seen TEXT
    );
  `);
  return _db;
}

const nowIso = () => new Date().toISOString();

export function getCursor(k) {
  const r = open().prepare('SELECT v FROM cursor WHERE k = ?').get(k);
  return r ? String(r.v || '') : '';
}

export function setCursor(k, v) {
  open().prepare('INSERT INTO cursor(k, v, updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
    .run(k, String(v ?? ''), nowIso());
}

export function makeReceipt(kind, uid, msgKey) {
  const h = crypto.createHash('sha1').update(`${kind}|${uid}|${msgKey}`).digest('hex').slice(0, 10);
  return `${kind}-${uid}-${h}`;
}

/**
 * 记一条入站事件；幂等（同 kind+uid+msg_key 只成功一次）。
 * 返回 { ok, receipt, dup }。
 */
export function addEvent({ kind, source = 'dm', uid, uname = '', msg_key = '', bvid = '', title = '' }) {
  const db = open();
  const receipt = makeReceipt(kind, uid, msg_key || bvid || Date.now());
  if (msg_key) {
    const hit = db.prepare('SELECT receipt FROM events WHERE msg_key = ?').get(msg_key);
    if (hit) return { ok: false, dup: true, receipt: String(hit.receipt) };
  }
  try {
    db.prepare(`INSERT INTO events(kind, source, uid, uname, msg_key, bvid, title, receipt, status, created_at)
                VALUES(?,?,?,?,?,?,?,?, 'pending', ?)`)
      .run(kind, source, uid, uname, msg_key || null, bvid || null, title || null, receipt, nowIso());
    return { ok: true, receipt };
  } catch (e) {
    return { ok: false, dup: true, receipt, error: String(e.message || e) };
  }
}

export function setStatus(receipt, status, note = '') {
  open().prepare('UPDATE events SET status = ?, note = ?, updated_at = ? WHERE receipt = ?')
    .run(status, note, nowIso(), receipt);
}

export function list(status = null, limit = 50) {
  const db = open();
  const rows = status
    ? db.prepare('SELECT * FROM events WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r }));
}

export function pending() {
  return list('pending', 200);
}

/** 陌生人：只记 uid/昵称/未读数，正文一律不落 */
export function noteStranger({ uid, uname = '', unread = 0, ts = null }) {
  open().prepare(`INSERT INTO strangers(uid, uname, unread, hits, last_ts, first_seen, last_seen)
                  VALUES(?,?,?,1,?,?,?)
                  ON CONFLICT(uid) DO UPDATE SET uname = excluded.uname, unread = excluded.unread,
                    hits = strangers.hits + 1, last_ts = excluded.last_ts, last_seen = excluded.last_seen`)
    .run(uid, uname, unread, ts, nowIso(), nowIso());
}

export function strangers(limit = 20) {
  return open().prepare('SELECT * FROM strangers ORDER BY last_seen DESC LIMIT ?').all(limit).map((r) => ({ ...r }));
}

export function stats() {
  const db = open();
  const by = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM events GROUP BY status').all()) by[r.status] = r.n;
  const st = db.prepare('SELECT COUNT(*) n FROM strangers').get();
  return {
    by,
    total: Object.values(by).reduce((a, b) => a + b, 0),
    pending: by.pending || 0,
    done: by.done || 0,
    failed: by.failed || 0,
    strangers: st ? st.n : 0,
    cursors: {
      dm: getCursor('dm_seqno'),
      at: getCursor('at_cursor'),
      reply: getCursor('reply_cursor'),
    },
  };
}

// ── 身份核实（身份先于内容）──────────────────────────────────
const _mutual = new Map(); // uid -> {ok, at}

export function pushAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
    return (j.accounts || []).filter((a) => a && Number(a.uid) > 0);
  } catch {
    return [];
  }
}

export function operatorUid() {
  try {
    return Number(bili.cookie().dede_user_id || 0);
  } catch {
    return 0;
  }
}

/** 互关检查（结果缓存 6 小时；失败按不互关处理，宁可保守） */
export async function isMutual(uid) {
  const hit = _mutual.get(Number(uid));
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.ok;
  let ok = false;
  try {
    const r = await bili.api('/x/relation', { fid: uid });
    ok = Number(r?.data?.attribute) === 6;
  } catch {
    ok = false;
  }
  _mutual.set(Number(uid), { ok, at: Date.now() });
  return ok;
}

/**
 * 三级身份：bound（在推送账号表里且启用）/ mutual（互关）/ stranger（其余）
 * 返回 { ok, level, reason }；ok=true 才允许读正文。
 */
export async function identify(uid) {
  const n = Number(uid);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, level: 'bad', reason: '非法 uid' };
  if (n === operatorUid()) return { ok: false, level: 'self', reason: '这是操作账号自己（我方发言，不当入站）' };
  const acct = pushAccounts().find((a) => Number(a.uid) === n);
  if (acct && acct.enabled !== false) {
    const mutual = await isMutual(n);
    return {
      ok: true,
      level: mutual ? 'bound-mutual' : 'bound',
      reason: mutual ? `已绑定推送账号 + 互关（${acct.name || n}）` : `已绑定推送账号（${acct.name || n}），未互关（只投面板，不私信回去）`,
    };
  }
  return { ok: false, level: 'stranger', reason: acct ? '该账号已绑定但被停用' : '不在推送账号表里' };
}
