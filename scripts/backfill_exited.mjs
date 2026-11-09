#!/usr/bin/env node
/**
 * backfill_exited.mjs —— 一次性回填「出队时刻」（修复 v22 及以前的遗留数据）
 *
 * 背景：2026-10-31 之前（含）scripts/runner.mjs 自己裸写 `UPDATE videos SET status=?,...`，
 *       漏写 exited_at / exit_reason；而 scripts/lib/library.mjs 的 setStatus 才会写这两列。
 *       后果：队列页「最近出队」从 2026-10-31 07:07 起不再更新（那些 seen 记录被
 *       library.exited() 的 `exited_at IS NOT NULL` 过滤掉了）。
 *       runner.mjs 已在 v23 修好（改走 lib.setStatus）；本脚本只管历史数据。
 *
 * 用法：
 *   node scripts/backfill_exited.mjs              # 干跑：列出要回填哪些、值是什么，不写库
 *   node scripts/backfill_exited.mjs --apply      # 真正写库（先 VACUUM INTO 备份 library.db）
 *   node scripts/backfill_exited.mjs --apply --fallback-last-seen
 *                                                 # 某些行没有账本记录时，退而用 videos.last_seen 当出队时刻
 *
 * 取值来源：优先 logs/ledger.db 的 runs.at（真正跑完的时刻），取该 bvid 最新一条。
 * 幂等：只填 exited_at IS NULL 的行，可重复执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT, ensureData } from './lib/paths.mjs';

ensureData();
const ROOT = DATA_ROOT;
const LIB = path.join(ROOT, 'logs', 'library.db');
const LEDGER = path.join(ROOT, 'logs', 'ledger.db');
const BACKUP_DIR = path.join(ROOT, 'logs', 'backup');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FALLBACK = args.includes('--fallback-last-seen');

const EXIT_STATES = ['seen', 'failed', 'deleted', 'skipped', 'kept', 'rejected'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(LIB)) {
  console.error(`找不到台账：${LIB}`);
  process.exit(1);
}

// 只读收集
const db = new DatabaseSync(LIB, { readOnly: true });
const ph = EXIT_STATES.map(() => '?').join(',');
const rows = db.prepare(`SELECT bvid, title, status, first_seen, last_seen, exited_at, exit_reason
                         FROM videos WHERE status IN (${ph}) AND exited_at IS NULL
                         ORDER BY last_seen DESC`).all(...EXIT_STATES);
const total = db.prepare('SELECT COUNT(*) n FROM videos').get().n;
const exitedBefore = db.prepare('SELECT COUNT(*) n FROM videos WHERE exited_at IS NOT NULL').get().n;
db.close();

// 账本里有记录的时刻
const atByBvid = new Map();
if (fs.existsSync(LEDGER)) {
  const led = new DatabaseSync(LEDGER, { readOnly: true });
  try {
    for (const r of led.prepare('SELECT bvid, at FROM runs WHERE bvid IS NOT NULL AND bvid <> \'\'').all()) {
      const prev = atByBvid.get(r.bvid);
      if (!prev || String(r.at) > String(prev)) atByBvid.set(r.bvid, r.at);
    }
  } finally { led.close(); }
}

const plan = rows.map((r) => {
  const fromLedger = atByBvid.get(r.bvid) || '';
  const value = fromLedger || (FALLBACK ? r.last_seen : '');
  return {
    bvid: r.bvid,
    title: String(r.title || '').slice(0, 40),
    status: r.status,
    exited_at: value,
    source: fromLedger ? 'ledger.runs.at' : (FALLBACK ? 'videos.last_seen' : 'missing'),
  };
});
const todo = plan.filter((p) => p.exited_at);
const missing = plan.filter((p) => !p.exited_at);

console.log(`台账：${LIB}`);
console.log(`总行数 ${total} · 已有 exited_at ${exitedBefore} · 待回填 ${rows.length}`);
console.log(`其中可由账本确定时刻 ${plan.filter((p) => p.source === 'ledger.runs.at').length}` +
  (FALLBACK ? ` · 用 last_seen 兜底 ${plan.filter((p) => p.source === 'videos.last_seen').length}` : '') +
  (missing.length ? ` · 取不到时刻 ${missing.length}` : ''));
console.log('\n--- 计划回填（按 last_seen 倒序，最多显示 40 条）---');
for (const p of todo.slice(0, 40)) {
  console.log(`${p.bvid}  ${p.exited_at}  ${p.status.padEnd(8)} ${p.source.padEnd(15)} ${p.title}`);
}
if (missing.length) {
  console.log('\n--- 取不到时刻（不写；加 --fallback-last-seen 可用 last_seen 兜底）---');
  for (const p of missing.slice(0, 40)) console.log(`${p.bvid}  ${p.status.padEnd(8)} ${p.title}`);
}

if (!APPLY) {
  console.log('\n[干跑] 没有写库。确认无误后加 --apply 执行（会先备份 library.db）。');
  process.exit(0);
}

if (!todo.length) {
  console.log('\n没有需要回填的行。');
  process.exit(0);
}

// 备份：VACUUM INTO 拿一致性快照（库在 WAL 模式下直接 copy 可能不一致）
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const bak = path.join(BACKUP_DIR, `library-${stamp}.db`);
try {
  const bdb = new DatabaseSync(LIB);
  bdb.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  bdb.close();
} catch (e) {
  // 兜底：整文件复制（WAL 已 checkpoint 的情况下也安全够用）
  fs.copyFileSync(LIB, bak);
  console.error(`VACUUM INTO 失败（${e.message}），已改用 copyFileSync 备份`);
}
console.log(`\n已备份 → ${bak}`);

const w = new DatabaseSync(LIB);
let wrote = 0;
try {
  w.exec('BEGIN');
  const upd = w.prepare(`UPDATE videos SET exited_at = ?, exit_reason = ?
                         WHERE bvid = ? AND exited_at IS NULL`);
  for (const p of todo) {
    const r = upd.run(p.exited_at, String(p.status).slice(0, 80), p.bvid);
    if (r.changes) wrote += 1;
  }
  w.exec('COMMIT');
} catch (e) {
  try { w.exec('ROLLBACK'); } catch { /* 忽略 */ }
  w.close();
  console.error('写库失败，已回滚：' + (e && e.message || e));
  process.exit(1);
}

const after = w.prepare(`SELECT COUNT(*) n FROM videos WHERE exited_at IS NOT NULL`).get().n;
const remaining = w.prepare(`SELECT COUNT(*) n FROM videos WHERE status IN (${ph}) AND exited_at IS NULL`).get(...EXIT_STATES);
w.close();

console.log(`写入 ${wrote} 行 · 现有 exited_at ${after} 行 · 仍缺 ${remaining.n} 行`);
console.log('\n最近出队（回填后前 5 条）：');
const chk = new DatabaseSync(LIB, { readOnly: true });
for (const r of chk.prepare(`SELECT bvid, status, exited_at, exit_reason FROM videos
                             WHERE exited_at IS NOT NULL ORDER BY exited_at DESC LIMIT 5`).all()) {
  console.log(`${r.exited_at}  ${r.bvid}  ${r.status}  ${r.exit_reason || ''}`);
}
chk.close();
