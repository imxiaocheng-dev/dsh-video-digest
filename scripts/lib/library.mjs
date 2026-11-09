// 本地「视频台账」：一条视频一行，状态机流转。
// 队列页读 candidate/queued/running/failed；归档页读 seen + ledger.runs；去重查主键。0 token、0 风控。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT } from './paths.mjs';

// 数据目录：台账写这里（旧布局下就是包根，本机行为不变）
export const ROOT = DATA_ROOT;
export const DB = path.join(ROOT, 'logs', 'library.db');

// 状态机：
//   candidate 候选中 → queued 排队中 → running 进行中 → seen 完成（进归档）
//   failed 异常（可人工转候选/排队/删除） / deleted 删除（不进归档） / skipped 主动跳过 / kept 你保留 / rejected 你否掉
export const STATUSES = ['candidate', 'queued', 'running', 'seen', 'failed', 'deleted', 'skipped', 'kept', 'rejected'];

// 队列里算"待处理"的状态（不含异常、不含归档）
export const PENDING = ['candidate', 'queued', 'running'];

export function open(file = DB) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS videos (
    bvid TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    score REAL,
    via TEXT,
    depth TEXT,
    title TEXT,
    up TEXT,
    first_seen TEXT,
    last_seen TEXT,
    note TEXT
  )`);
  // 候选需要展示的富字段（老库走 ALTER 补齐，不影响已有行）
  const add = [
    ['dur_sec', 'INTEGER'], ['play', 'INTEGER'], ['danmaku', 'INTEGER'],
    ['tname', 'TEXT'], ['prio', 'INTEGER'], ['fails', 'INTEGER'], ['extra', 'TEXT'],
    // 2026-10-31：出队审计（离开队列的时刻与原因），供队列页「最近出队」用
    ['exited_at', 'TEXT'], ['exit_reason', 'TEXT'],
    // 2026-11-06（A2-06）：真删除时刻。历史页据此区分「记录被删」与「有产物」
    ['deleted_at', 'TEXT'],
  ];
  const cols = new Set(db.prepare('PRAGMA table_info(videos)').all().map(r => r.name));
  for (const [name, type] of add) {
    if (!cols.has(name)) db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_status ON videos(status)');
  return db;
}

let _db = null;
const db = () => (_db ||= open());

// 离开队列的状态（进入这些状态时记一次出队时间与原因；回到队列态则清空）
const EXIT_STATES = ['seen', 'failed', 'deleted', 'skipped', 'kept', 'rejected'];
const isExitState = st => EXIT_STATES.includes(st);
// 出队原因：优先用调用方给的 note，否则用状态名
const exitReason = (st, note) => (String(note || '').trim() || st).slice(0, 80);

export function get(bvid) {
  return db().prepare('SELECT * FROM videos WHERE bvid = ?').get(bvid) || null;
}
export const seen = get; // 兼容旧调用名

// picker 去重：任何非 deleted 状态都算"已认识"
export function isKnown(bvid) {
  const r = get(bvid);
  return Boolean(r && r.status !== 'deleted');
}
export function isSeen(bvid) {
  const r = get(bvid);
  return Boolean(r && !['deleted', 'candidate'].includes(r.status));
}

/**
 * 写一条记录（不存在则插入，存在则更新给定字段）。
 * extra 会被 JSON 序列化进 extra 列（存 hits/tag/desc 等展示用富信息）。
 */
export function mark({
  bvid, status, score = null, via = '', depth = '', title = '', up = '', note = '',
  dur_sec = null, play = null, danmaku = null, tname = null, prio = null, fails = null, extra = null,
}) {
  if (!bvid) throw new Error('mark 需要 bvid');
  if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join('/')}`);
  const now = new Date().toISOString();
  const ex = extra && typeof extra === 'object' ? JSON.stringify(extra) : (typeof extra === 'string' ? extra : null);
  const atExit = isExitState(status);
  const xa = atExit ? now : null;
  const xr = atExit ? exitReason(status, note) : null;
  const del = status === 'deleted' ? now : null;
  db().prepare(`INSERT INTO videos (bvid,status,score,via,depth,title,up,first_seen,last_seen,note,dur_sec,play,danmaku,tname,prio,fails,extra,exited_at,exit_reason,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bvid) DO UPDATE SET
      status=excluded.status,
      score=COALESCE(excluded.score, videos.score),
      via=CASE WHEN excluded.via != '' THEN excluded.via ELSE videos.via END,
      depth=CASE WHEN excluded.depth != '' THEN excluded.depth ELSE videos.depth END,
      title=CASE WHEN excluded.title != '' THEN excluded.title ELSE videos.title END,
      up=CASE WHEN excluded.up != '' THEN excluded.up ELSE videos.up END,
      note=excluded.note,
      dur_sec=COALESCE(excluded.dur_sec, videos.dur_sec),
      play=COALESCE(excluded.play, videos.play),
      danmaku=COALESCE(excluded.danmaku, videos.danmaku),
      tname=COALESCE(excluded.tname, videos.tname),
      prio=COALESCE(excluded.prio, videos.prio),
      fails=COALESCE(excluded.fails, videos.fails),
      extra=COALESCE(excluded.extra, videos.extra),
      last_seen=excluded.last_seen,
      exited_at=excluded.exited_at,
      exit_reason=excluded.exit_reason,
      deleted_at=CASE WHEN excluded.status='deleted' THEN COALESCE(videos.deleted_at, excluded.deleted_at)
                      WHEN excluded.status IN ('candidate','queued','running') THEN NULL
                      ELSE videos.deleted_at END`)
    .run(bvid, status, score, via, depth, title, up, now, now, note, dur_sec, play, danmaku, tname, prio, fails, ex, xa, xr, del);
  return get(bvid);
}

/** 只改状态（保留其它字段） */
export function setStatus(bvid, status, note = '') {
  if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join('/')}`);
  const now = new Date().toISOString();
  if (isExitState(status)) {
    // 只在第一次出队时记时刻（后续 note 变更不刷新 exited_at，保持"何时离开队列"的语义）
    db().prepare(`UPDATE videos SET status = ?, note = ?, last_seen = ?,
        exited_at = COALESCE(exited_at, ?), exit_reason = ?,
        deleted_at = CASE WHEN ? = 'deleted' THEN COALESCE(deleted_at, ?) ELSE deleted_at END
        WHERE bvid = ?`)
      .run(status, note, now, now, exitReason(status, note), status, now, bvid);
  } else {
    // 回到队列态：清出队审计与删除时刻
    db().prepare('UPDATE videos SET status = ?, note = ?, last_seen = ?, exited_at = NULL, exit_reason = NULL, deleted_at = NULL WHERE bvid = ?')
      .run(status, note, now, bvid);
  }
  return get(bvid);
}

/**
 * 条件更新：只有当前状态等于 fromStatus 才改。
 * A2-04：runner 正常收尾用 setStatusIf(bv, 'running', 'seen')，避免把用户刚删掉/改过的行"复活"。
 */
export function setStatusIf(bvid, fromStatus, status, note = '') {
  if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join('/')}`);
  if (!STATUSES.includes(fromStatus)) throw new Error(`fromStatus 必须是 ${STATUSES.join('/')}`);
  const now = new Date().toISOString();
  let r;
  if (isExitState(status)) {
    r = db().prepare(`UPDATE videos SET status = ?, note = ?, last_seen = ?,
        exited_at = COALESCE(exited_at, ?), exit_reason = ?,
        deleted_at = CASE WHEN ? = 'deleted' THEN COALESCE(deleted_at, ?) ELSE deleted_at END
        WHERE bvid = ? AND status = ?`)
      .run(status, note, now, now, exitReason(status, note), status, now, bvid, fromStatus);
  } else {
    r = db().prepare('UPDATE videos SET status = ?, note = ?, last_seen = ?, exited_at = NULL, exit_reason = NULL, deleted_at = NULL WHERE bvid = ? AND status = ?')
      .run(status, note, now, bvid, fromStatus);
  }
  return { changed: !!(r && r.changes), from: fromStatus, to: status, row: get(bvid) };
}

/** 记一次失败：fails+1；到上限转 failed */
export function bumpFail(bvid, { maxFails = 3, note = '' } = {}) {
  const r = get(bvid);
  if (!r) return null;
  const fails = (r.fails || 0) + 1;
  if (fails >= maxFails) {
    const now = new Date().toISOString();
    db().prepare("UPDATE videos SET status='failed', fails=?, note=?, last_seen=?, exited_at=COALESCE(exited_at,?), exit_reason=? WHERE bvid=?")
      .run(fails, note || `连续失败 ${fails} 次`, now, now, exitReason('failed', note), bvid);
  } else {
    db().prepare('UPDATE videos SET fails=?, note=?, last_seen=? WHERE bvid=?')
      .run(fails, note, new Date().toISOString(), bvid);
  }
  return get(bvid);
}

export function list(statuses = [], limit = 500) {
  const arr = Array.isArray(statuses) ? statuses : [statuses];
  if (!arr.length) return db().prepare('SELECT * FROM videos ORDER BY last_seen DESC LIMIT ?').all(limit);
  const ph = arr.map(() => '?').join(',');
  return db().prepare(`SELECT * FROM videos WHERE status IN (${ph}) ORDER BY score DESC, last_seen DESC LIMIT ?`).all(...arr, limit);
}

/** 全量行（归档这类一次性批量读取用，避免逐条 get 反复 prepare） */
export function allRows(limit = 10000) {
  return db().prepare('SELECT * FROM videos ORDER BY last_seen DESC LIMIT ?').all(limit);
}

/** 最近出队（离开队列的条目，按出队时间倒序） */
export function exited(limit = 10) {
  const ph = EXIT_STATES.map(() => '?').join(',');
  return db().prepare(`SELECT * FROM videos WHERE exited_at IS NOT NULL AND status IN (${ph})
    ORDER BY exited_at DESC LIMIT ?`).all(...EXIT_STATES, limit);
}

export function counts() {
  const rows = db().prepare('SELECT status, COUNT(*) n FROM videos GROUP BY status').all();
  const by = Object.fromEntries(rows.map(r => [r.status, r.n]));
  const total = rows.reduce((a, r) => a + r.n, 0);
  // 待处理 = 候选 + 排队 + 进行中（自动入列的 30 条口径）
  const pending = PENDING.reduce((a, k) => a + (by[k] || 0), 0);
  // 手动/入站未完成（100 条口径）
  const manualOpen = db().prepare(
    "SELECT COUNT(*) n FROM videos WHERE status IN ('queued','running','failed') AND via IN ('manual','inbound','gray')"
  ).get().n;
  return { total, by, pending, manualOpen };
}

export function stats() {
  const c = counts();
  const today = db().prepare('SELECT COUNT(*) n FROM videos WHERE substr(last_seen,1,10) = ?').get(new Date().toISOString().slice(0, 10)).n;
  return { total: c.total, byStatus: c.by, today, pending: c.pending, manualOpen: c.manualOpen };
}

/* 本地日期（videos 里存的是 UTC ISO，日界必须按本地算，否则凌晨那几条会算进前一天） */
export function dayOf(v) {
  const d = v instanceof Date ? v : new Date(v || Date.now());
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 今日自动入列了几条（via 以 search: 开头、first_seen 是今天） */
export function enlistedToday() {
  const today = dayOf(new Date());
  const rows = db().prepare("SELECT first_seen FROM videos WHERE via LIKE 'search:%'").all();
  return rows.filter(r => dayOf(r.first_seen) === today).length;
}

export function recent(limit = 10) {
  return db().prepare('SELECT bvid,status,score,depth,title,via,last_seen FROM videos ORDER BY last_seen DESC LIMIT ?').all(limit);
}

// CLI: node scripts/lib/library.mjs stats|list
if (process.argv[1] && process.argv[1].endsWith('library.mjs')) {
  const cmd = process.argv[2] || 'stats';
  if (cmd === 'stats') {
    const s = stats();
    console.log(`已知 ${s.total} 条 · 待处理 ${s.pending} 条 · 手动/入站未完成 ${s.manualOpen} 条 · 今日读写 ${s.today} 条`);
    for (const [k, v] of Object.entries(s.byStatus)) console.log(`  ${k}: ${v}`);
  } else if (cmd === 'list') {
    for (const r of recent(20)) console.log(`${r.last_seen.slice(0, 16)}  ${r.status.padEnd(9)} ${String(r.score ?? '-').padStart(5)}  ${r.bvid}  ${r.title || ''}`);
  } else {
    console.log('用法: node scripts/lib/library.mjs stats|list');
  }
}
