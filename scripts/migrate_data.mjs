#!/usr/bin/env node
// 数据目录迁移：把旧布局（数据与代码挤在同一目录）搬到标准位置。
//
// 标准位置（见 scripts/lib/paths.mjs）：
//   $VD_DATA                     显式指定
//   $DSH_HOME/video-digest/      DSH_HOME 默认 ~/.dsh
//
// 用法：
//   node scripts/migrate_data.mjs                 只打印计划（dry-run，默认）
//   node scripts/migrate_data.mjs --apply         复制过去（**不含 cache**，cache 可重建）
//   node scripts/migrate_data.mjs --apply --with-cache   连 7GB 级的 cache 一起搬
//   node scripts/migrate_data.mjs --junction      建目录联接（零拷贝，数据仍在原地）
//   node scripts/migrate_data.mjs --verify        只校验目标是否完整
//   node scripts/migrate_data.mjs --prune --yes   校验通过后删除源数据（先 --apply 过）
//
// 可选：
//   --from <旧数据目录>   --to <新数据目录>   --force（目标已有数据时强制继续）
//
// 校验（--verify 与 --apply/--junction 结束时自动跑）：
//   ① 各目录文件数、总字节数与源一致  ② *.db 逐个 PRAGMA integrity_check
//   ③ 台账行数（library.videos / ledger.runs / inbound / outbound）
//   ④ config/ 与 secrets/ 下所有 .json 可解析
// 报告写到 <目标>/logs/migrate-report.json。
//
// 安全约定：默认不动源数据（只复制）；--prune 才删，且必须 --yes 且校验通过。
// 建议迁移前先退出 DSH（SQLite 用 VACUUM INTO 做一致性快照，但退出最稳）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { DATA_ROOT, CODE_ROOT, DATA_SOURCE, DEFAULT_DATA_ROOT, dataInfo } from './lib/paths.mjs';

const ARGS = process.argv.slice(2);
const flag = (n) => ARGS.includes('--' + n);
const opt = (n, dflt = null) => {
  const i = ARGS.indexOf('--' + n);
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : dflt;
};

const APPLY = flag('apply');
const JUNCTION = flag('junction');
const VERIFY_ONLY = flag('verify');
const PRUNE = flag('prune');
const YES = flag('yes');
const FORCE = flag('force');
const WITH_CACHE = flag('with-cache');

const hasData = (dir) => {
  try {
    return !!dir && fs.existsSync(path.join(dir, 'logs', 'library.db'));
  } catch {
    return false;
  }
};
const isJunction = (p) => {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return false;
    return fs.realpathSync(p) !== path.resolve(p); // Windows junction 也算
  } catch {
    return false;
  }
};
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

/* ── 源 / 目标 ─────────────────────────────────────────────────────────── */
const DST = path.resolve(
  opt('to') || (DATA_SOURCE === 'env' ? DATA_ROOT : DEFAULT_DATA_ROOT)
);
const SRC = path.resolve(
  opt('from') ||
    (() => {
      // 旧布局兜底命中 → 源就是代码根；否则若代码根仍有数据、且不是目标，也认为要搬
      if (DATA_SOURCE === 'legacy') return CODE_ROOT;
      const codeHasData = hasData(CODE_ROOT) && path.resolve(CODE_ROOT) !== DST;
      return codeHasData ? CODE_ROOT : DATA_ROOT;
    })()
);

/* 要搬的目录。cache 只在 --with-cache 时搬（视频下载 + 放大帧，7GB 级，可重建）。
   logs: 台账 library.db/ledger.db + 日志；out: 产物；config/secrets: 配置与凭证；
   runtime: Python pylibs（OCR）；derived/inbox: 派生与入站。 */
const DATA_DIRS = ['logs', 'out', 'config', 'secrets', 'runtime', 'derived', 'inbox'];
const DIRS_TO_MIGRATE = WITH_CACHE ? [...DATA_DIRS, 'cache'] : DATA_DIRS;

/* 不搬的东西：__pycache__/*.pyc（可重建）、临时文件、以及 SQLite 的 -wal/-shm/-journal
   边车文件（.db 本体用 VACUUM INTO 取一致性快照，快照里已含 WAL 里未检查点的数据；
   边车单独拷过去反而会让目标库看起来"索引条目数不对"）。 */
const SKIP_NAME = (n) =>
  n === '__pycache__' || n.endsWith('.pyc') || n.endsWith('.tmp') || n.endsWith('.part') || /\.db-(wal|shm|journal)$/i.test(n);
const SKIP_DIR = new Set(['node_modules']);

function walk(dir, out = []) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (SKIP_NAME(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(fp, out);
    } else {
      try {
        const st = fs.statSync(fp);
        out.push({ abs: fp, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* 读不到就跳过（可能正被占用） */
      }
    }
  }
  return out;
}

function scan(root, dirs) {
  const per = {};
  let files = 0;
  let bytes = 0;
  for (const d of dirs) {
    const abs = path.join(root, d);
    const list = fs.existsSync(abs) ? walk(abs) : [];
    let b = 0;
    for (const f of list) b += f.size;
    per[d] = { exists: fs.existsSync(abs), files: list.length, bytes: b };
    files += list.length;
    bytes += b;
  }
  return { per, files, bytes };
}

/* ── 一致性复制 ─────────────────────────────────────────────────────────── */
/* .db 用 VACUUM INTO 做快照（WAL 里尚未检查点的内容也会写进去，不会拷出半个库）；
   失败再退回普通复制。目标存在时先删（VACUUM INTO 要求目标不存在）。 */
function copySqlite(srcFile, dstFile) {
  // 目标旁边的旧边车（-wal/-shm/-journal）会让新快照看起来损坏，先清掉
  for (const sfx of ['-wal', '-shm', '-journal']) {
    try {
      if (fs.existsSync(dstFile + sfx)) fs.rmSync(dstFile + sfx, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    const db = new DatabaseSync(srcFile, { readOnly: true });
    try {
      if (fs.existsSync(dstFile)) fs.rmSync(dstFile, { force: true });
      db.exec(`VACUUM INTO '${dstFile.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    return 'vacuum';
  } catch (e) {
    fs.copyFileSync(srcFile, dstFile);
    return 'copy';
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyAll(srcRoot, dstRoot, dirs, onDirDone) {
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  for (const d of dirs) {
    const sdir = path.join(srcRoot, d);
    if (!fs.existsSync(sdir)) continue;
    const list = walk(sdir);
    for (const f of list) {
      const r = rel(sdir, f.abs);
      const dst = path.join(dstRoot, d, r);
      ensureDir(path.dirname(dst));
      try {
        const same = fs.existsSync(dst) && fs.statSync(dst).size === f.size;
        if (same && !f.abs.endsWith('.db')) {
          skipped++;
          continue;
        }
        if (f.abs.endsWith('.db')) copySqlite(f.abs, dst);
        else fs.copyFileSync(f.abs, dst);
        try {
          const t = new Date(f.mtime);
          fs.utimesSync(dst, t, t);
        } catch {
          /* 时间戳不重要 */
        }
        copied++;
        bytes += f.size;
      } catch (e) {
        throw new Error(`复制失败 ${f.abs} → ${dst}：${e.message}（若文件被占用，先退出 DSH 再试）`);
      }
    }
    if (onDirDone) onDirDone(d, list.length);
  }
  return { copied, skipped, bytes };
}

/* ── 校验 ───────────────────────────────────────────────────────────────── */
function dbCheck(file) {
  const out = { file: rel(DST, file), ok: false };
  if (!fs.existsSync(file)) {
    out.error = '不存在';
    return out;
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare('PRAGMA integrity_check').get();
    const val = r ? Object.values(r)[0] : null;
    out.integrity = val;
    out.ok = val === 'ok';
    out.rows = {};
    // 逐个真实表数行数（不假设表名：inbound.db 是 events/strangers，outbound.db 是 posts…）
    let tables = [];
    try {
      tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name);
    } catch {
      tables = [];
    }
    for (const t of tables) {
      try {
        out.rows[t] = db.prepare(`SELECT COUNT(*) n FROM "${String(t).replace(/"/g, '""')}"`).get().n;
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    out.error = String(e.message || e);
  } finally {
    try {
      db && db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

function verify() {
  const problems = [];
  const s = scan(SRC, DIRS_TO_MIGRATE);
  const d = scan(DST, DIRS_TO_MIGRATE);
  const dirs = [];
  for (const name of DIRS_TO_MIGRATE) {
    const a = s.per[name];
    const b = d.per[name];
    // 目标文件数/字节数 ≥ 源（允许多，因为迁移后系统又写了新东西）
    const ok = b.files >= a.files && b.bytes >= a.bytes;
    dirs.push({ dir: name, srcFiles: a.files, dstFiles: b.files, srcMB: Number(fmtMB(a.bytes).replace(' MB', '')), dstMB: Number(fmtMB(b.bytes).replace(' MB', '')), ok });
    if (!ok && a.files > 0) problems.push(`${name}: 目标比源少了文件/字节（${a.files}/${a.bytes} → ${b.files}/${b.bytes}）`);
  }
  // sqlite
  const dbs = [];
  for (const dbf of ['logs/library.db', 'logs/ledger.db', 'logs/inbound.db', 'logs/outbound.db']) {
    const abs = path.join(DST, dbf);
    if (!fs.existsSync(abs)) continue;
    const r = dbCheck(abs);
    dbs.push(r);
    if (!r.ok) problems.push(`${dbf}: ${r.error || 'integrity_check = ' + r.integrity}`);
  }
  // 行数与源对比（源还能读时）
  const rowCompare = [];
  for (const dbf of ['logs/library.db', 'logs/ledger.db']) {
    const srcAbs = path.join(SRC, dbf);
    const dstAbs = path.join(DST, dbf);
    if (!fs.existsSync(srcAbs) || !fs.existsSync(dstAbs)) continue;
    const a = dbCheck(srcAbs);
    const b = dbCheck(dstAbs);
    for (const t of Object.keys(a.rows || {})) {
      const same = (a.rows[t] || 0) <= (b.rows[t] || 0);
      rowCompare.push({ db: dbf, table: t, src: a.rows[t], dst: b.rows[t], ok: same });
      if (!same) problems.push(`${dbf} ${t}: 目标行数少于源（${a.rows[t]} → ${b.rows[t]}）`);
    }
  }
  // JSON 可解析
  const badJson = [];
  for (const sub of ['config', 'secrets']) {
    const dir = path.join(DST, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      if (!/\.json$/i.test(f.abs)) continue;
      try {
        JSON.parse(fs.readFileSync(f.abs, 'utf8'));
      } catch (e) {
        badJson.push(rel(DST, f.abs) + ': ' + e.message);
      }
    }
  }
  for (const b of badJson) problems.push('JSON 解析失败 ' + b);
  return { ok: problems.length === 0, dirs, dbs, rowCompare, badJson, problems, src: s, dst: d };
}

/* ── 报告 ───────────────────────────────────────────────────────────────── */
function writeReport(report) {
  try {
    ensureDir(path.join(DST, 'logs'));
    const file = path.join(DST, 'logs', 'migrate-report.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

const line = (s = '') => process.stdout.write(s + '\n');
const hr = () => line('─'.repeat(64));

/* ── 主流程 ─────────────────────────────────────────────────────────────── */
async function main() {
  const info = dataInfo();
  hr();
  line('数据目录迁移');
  hr();
  line(`代码根   CODE_ROOT = ${CODE_ROOT}`);
  line(`源数据   SRC       = ${SRC}`);
  line(`目标     DST       = ${DST}`);
  line(`当前解析 DATA_ROOT = ${DATA_ROOT}  (${DATA_SOURCE})`);
  line('');

  if (path.resolve(SRC) === path.resolve(DST)) {
    line('源与目标相同，无需迁移。');
    if (VERIFY_ONLY) return finish(0);
    return finish(0);
  }
  if (!fs.existsSync(SRC)) return fail(`源目录不存在：${SRC}`);
  if (!hasData(SRC)) {
    line(`提示：${SRC} 里没有 logs/library.db，看起来不是数据目录。`);
    if (!FORCE) return fail('拒绝执行（确实要继续请加 --force）。');
  }

  /* --verify：只校验 */
  if (VERIFY_ONLY) {
    if (!fs.existsSync(DST)) return fail(`目标不存在：${DST}`);
    const v = verify();
    printVerify(v);
    writeReport({ at: new Date().toISOString(), mode: 'verify', from: SRC, to: DST, ...v });
    return finish(v.ok ? 0 : 1);
  }

  /* 目标已有数据 → 默认拒绝，防手滑覆盖。--prune 是"复制之后的第二步"，此时目标当然有数据。 */
  if (hasData(DST) && !isJunction(DST) && !FORCE && !PRUNE) {
    line(`目标已有数据（${path.join(DST, 'logs', 'library.db')} 存在）。`);
    line('  若确认要继续（增量补齐 + 校验）：加 --force');
    line('  若只想校验现有目标：--verify');
    return finish(1);
  }

  /* --junction：零拷贝，把目标目录变成指向源的目录联接 */
  if (JUNCTION) {
    ensureDir(path.dirname(DST));
    if (fs.existsSync(DST)) {
      if (isJunction(DST)) {
        const real = path.resolve(fs.realpathSync(DST));
        line(`目标已是指向 ${real} 的联接，跳过创建。`);
      } else {
        return fail(`目标已存在且不是联接：${DST}（先移走，或改用 --apply 复制）`);
      }
    } else {
      /* stdio: 'ignore'：某些受限环境（DSH 沙箱）下带管道的 spawn 会 EPERM，
         而 mklink 不需要读输出，用文件系统判断成败更可靠。 */
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', DST, SRC], { windowsHide: true, stdio: 'ignore' });
      if (r.status !== 0 || !fs.existsSync(DST)) {
        return fail(
          `mklink 失败（status=${r.status}${r.error ? '，' + r.error.message : ''}）。` +
            `可手动执行：cmd /c mklink /J "${DST}" "${SRC}"`
        );
      }
      line(`已创建目录联接：${DST} → ${SRC}（零拷贝；数据仍在原处，删联接用 rmdir "${DST}"）`);
    }
    const v = verify();
    printVerify(v);
    writeReport({ at: new Date().toISOString(), mode: 'junction', from: SRC, to: DST, ...v });
    line('');
    line('下一步：重启 DSH（插件在加载时解析数据根）。之后面板 /api/meta 的 dataRoot 应指向新目录。');
    return finish(v.ok ? 0 : 1);
  }

  /* --prune（不带 --apply）：校验通过后删源，适合"先 --apply 过、现在收尾" */
  if (PRUNE && !APPLY) {
    if (!fs.existsSync(DST)) return fail(`目标不存在：${DST}`);
    const v = verify();
    printVerify(v);
    writeReport({ at: new Date().toISOString(), mode: 'prune-verify', from: SRC, to: DST, ...v });
    if (!v.ok) {
      line('');
      line('校验未通过，拒绝删除源数据。');
      return finish(1);
    }
    if (!YES) {
      line('');
      line('校验通过。确认要删除源数据请加 --yes：');
      line(`  node scripts/migrate_data.mjs --prune --yes${WITH_CACHE ? ' --with-cache' : ''}`);
      return finish(0);
    }
    pruneSource();
    line('');
    line('下一步：重启 DSH（插件在加载时解析数据根）。');
    return finish(0);
  }

  /* dry-run：只打印计划 */
  const s = scan(SRC, DIRS_TO_MIGRATE);
  line('计划（dry-run，未改任何文件）：');
  line('  目录            文件数        体积');
  let totF = 0;
  let totB = 0;
  for (const d of DIRS_TO_MIGRATE) {
    const p = s.per[d];
    line(`  ${d.padEnd(14)} ${String(p.exists ? p.files : '—').padStart(8)}  ${p.exists ? fmtMB(p.bytes) : '（不存在）'}`);
    if (p.exists) {
      totF += p.files;
      totB += p.bytes;
    }
  }
  line(`  ${'合计'.padEnd(13)} ${String(totF).padStart(8)}  ${fmtMB(totB)}`);
  if (!WITH_CACHE && fs.existsSync(path.join(SRC, 'cache'))) {
    const c = scan(SRC, ['cache']);
    line(`  （cache 未包含：${c.per.cache.files} 个文件 ${fmtMB(c.per.cache.bytes)}。需要的话加 --with-cache）`);
  }
  line('');
  if (!APPLY) {
    line('这是计划预览。确认无误后执行：');
    line(`  node scripts/migrate_data.mjs --apply${WITH_CACHE ? ' --with-cache' : ''}`);
    line('数据量不是特别大时推荐 --apply（真搬家）；不愿挪动 7GB 数据可用 --junction（零拷贝）。');
    return finish(0);
  }

  /* --apply：复制 → 校验 → 可选剪枝 */
  line('开始复制…');
  ensureDir(DST);
  const t0 = Date.now();
  const res = copyAll(SRC, DST, DIRS_TO_MIGRATE, (dir, total) => {
    line(`  ${dir}: ${total} 个文件`);
  });
  line(`复制完成：新增 ${res.copied}、跳过已存在 ${res.skipped}、共 ${fmtMB(res.bytes)}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  line('');
  line('开始校验…');
  const v = verify();
  printVerify(v);
  const reportFile = writeReport({
    at: new Date().toISOString(),
    mode: 'apply',
    withCache: WITH_CACHE,
    from: SRC,
    to: DST,
    copy: res,
    ...v,
  });
  if (reportFile) line(`报告：${reportFile}`);

  if (!v.ok) {
    line('');
    line('校验未通过，源数据原样保留（没有任何删除）。排查后可重跑 --apply 增量补齐。');
    return finish(1);
  }

  if (PRUNE) {
    if (!YES) {
      line('');
      line('校验通过。要删除源数据请加 --yes：');
      line(`  node scripts/migrate_data.mjs --prune --yes${WITH_CACHE ? ' --with-cache' : ''}`);
      return finish(0);
    }
    pruneSource();
  } else {
    line('');
    line('源数据原样保留。确认新目录跑得没问题后，可以：');
    line(`  node scripts/migrate_data.mjs --prune --yes${WITH_CACHE ? ' --with-cache' : ''}`);
  }
  line('');
  line('下一步：重启 DSH（插件加载时解析数据根）。之后面板 /api/meta 的 dataRoot 应指向新目录。');
  return finish(0);
}

/* 删除源数据（只删数据目录，代码目录 scripts/ vendor/ panel/ 一律不动） */
function pruneSource() {
  line('');
  line(`校验通过，删除源数据目录（仅数据目录，代码目录不动）：${SRC}`);
  for (const d of DIRS_TO_MIGRATE) {
    const abs = path.join(SRC, d);
    if (!fs.existsSync(abs)) continue;
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      line(`  已删除 ${d}`);
    } catch (e) {
      line(`  删除失败 ${d}：${e.message}`);
    }
  }
  line('源数据已清理。注意：旧目录里的 scripts/ vendor/ panel/ 等代码保持不动。');
}

function printVerify(v) {
  line('  目录            源         目标');
  for (const d of v.dirs) line(`  ${d.dir.padEnd(14)} ${String(d.srcFiles).padStart(7)}  ${String(d.dstFiles).padStart(7)}   ${d.ok ? '✓' : '✗'}`);
  if (v.dbs.length) {
    line('  数据库：');
    for (const r of v.dbs) line(`  ${r.ok ? '✓' : '✗'} ${r.file}  integrity=${r.integrity || r.error}  行数=${JSON.stringify(r.rows || {})}`);
  }
  if (v.rowCompare.length) {
    const bad = v.rowCompare.filter((r) => !r.ok);
    line(`  行数对比：${v.rowCompare.length - bad.length}/${v.rowCompare.length} 通过`);
  }
  if (v.badJson.length) line(`  JSON 解析失败 ${v.badJson.length} 个`);
  if (v.ok) line('校验结果：PASS');
  else {
    line('校验结果：FAIL');
    for (const p of v.problems) line('  - ' + p);
  }
}

function fail(msg) {
  line('✗ ' + msg);
  process.exitCode = 1;
  return 1;
}
function finish(code) {
  process.exitCode = code;
  return code;
}

main().catch((e) => {
  line('✗ 迁移异常：' + (e && (e.stack || e.message || e)));
  process.exitCode = 1;
});
