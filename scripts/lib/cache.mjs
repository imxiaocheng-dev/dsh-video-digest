// 缓存与产物管理（v26）—— 唯一真源。
// 规则（用户 2026-11-02 定）：
//   · cache/video（整段视频 m4s/mp4）与 cache/frames（帧图）是可随时重下的缓存，可以删；
//   · out/<bv>/ 是产物，其中「宫格图 sheet*.png」和「总结 summary*.json」永不自动删；
//   · 删一条视频记录时，对应产物与缓存一起删，腾空间。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, configFile } from './paths.mjs';

export const CACHE_ROOT = path.join(DATA_ROOT, 'cache');
export const VIDEO_DIR = path.join(CACHE_ROOT, 'video');
export const FRAMES_DIR = path.join(CACHE_ROOT, 'frames');
export const API_DIR = path.join(CACHE_ROOT, 'api');
export const OUT_DIR = path.join(DATA_ROOT, 'out');
// 删除可恢复（A5-03）：删记录先把产物/缓存移进 out/.trash/<bv>-<ts>/，撤销窗口内可移回，超时惰性真删。
export const TRASH_DIR = path.join(OUT_DIR, '.trash');
export const TRASH_TTL_MS = 600 * 1000;

export const STORAGE_DEFAULT = {
  version: 1,
  keepDays: 7,
  afterDone: 'keep', // keep | drop-video | drop-cache
  sweepOnDone: true,
  note: '缓存保留天数：超过就把 cache/video + cache/frames 清掉（out/ 里的宫格图和总结永远保留）。afterDone：跑完一条后是否立刻清理（keep=不动 / drop-video=删视频 / drop-cache=删视频+帧）。',
};

export function readStorage() {
  try {
    const o = JSON.parse(fs.readFileSync(configFile('storage.json'), 'utf8'));
    return { ...STORAGE_DEFAULT, ...o };
  } catch {
    return { ...STORAGE_DEFAULT };
  }
}

const BV_RE = /^BV[0-9A-Za-z]{6,14}$/;

/** 该 bvid 的视频缓存文件（cache/video/<bv>.mp4 / <bv>-1920p.m4s / <bv>-audio.m4s） */
export function videoFilesOf(bv) {
  let names = [];
  try { names = fs.readdirSync(VIDEO_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.startsWith(String(bv))) continue;
    const rest = n.slice(String(bv).length);
    if (!/^[.-]/.test(rest)) continue; // 防 BV1x 误匹配 BV1xy
    const fp = path.join(VIDEO_DIR, n);
    try { if (fs.statSync(fp).isFile()) out.push(fp); } catch {}
  }
  return out;
}

export function framesDirOf(bv) {
  return path.join(FRAMES_DIR, String(bv));
}

export function outDirOf(bv) {
  return path.join(OUT_DIR, String(bv));
}

function sizeOfDir(dir) {
  let n = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else { try { n += fs.statSync(fp).size; } catch {} }
    }
  };
  walk(dir);
  return n;
}

function rmFile(fp) {
  try { const s = fs.statSync(fp).size; fs.unlinkSync(fp); return s; } catch { return 0; }
}

function rmDir(dir) {
  const s = sizeOfDir(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); return s; } catch { return 0; }
}

/** 缓存状态（B2-2 四态）：full=还有整段视频；partial=只剩帧或部分；
 *  cleaned=跑过但缓存被清（产物目录还在）；never=从没下过（连产物目录都没有）。
 *  面板 cacheZh 认 full/partial/cleaned/never 四态。 */
export function cacheStateOf(bv) {
  const vids = videoFilesOf(bv);
  const video = vids.length > 0;
  let frames = false;
  // B2-3：空目录不算 partial（只有真的留下了帧图才算）
  try { frames = fs.readdirSync(framesDirOf(bv)).length > 0; } catch {}
  let ever = false;
  try { ever = fs.existsSync(outDirOf(bv)); } catch {}
  const state = video ? 'full' : (frames ? 'partial' : (ever ? 'cleaned' : 'never'));
  return { video, frames, state, videoBytes: vids.reduce((a, f) => { try { return a + fs.statSync(f).size; } catch { return a; } }, 0) };
}

export function purgeVideoCache(bv) {
  let freed = 0, removed = 0;
  for (const f of videoFilesOf(bv)) { const s = rmFile(f); if (s) { freed += s; removed++; } }
  return { freed, removed };
}

export function purgeFrames(bv) {
  const d = framesDirOf(bv);
  if (!fs.existsSync(d)) return { freed: 0, removed: 0 };
  const freed = rmDir(d);
  return { freed, removed: freed ? 1 : 0 };
}

/** 删产物目录（out/<bv>）——只在「删记录」时用，缓存清理绝不碰它 */
export function purgeArtifacts(bv) {
  const d = outDirOf(bv);
  if (!fs.existsSync(d)) return { freed: 0, removed: 0 };
  const freed = rmDir(d);
  return { freed, removed: freed ? 1 : 0 };
}

/** 删记录 = 产物 + 视频缓存 + 帧图 一起删 */
export function purgeEverything(bv) {
  const a = purgeArtifacts(bv), v = purgeVideoCache(bv), f = purgeFrames(bv);
  return { freed: a.freed + v.freed + f.freed, files: a.removed + v.removed + f.removed };
}

// ── 删除可恢复（trash）──────────────────────────────────────────────
// 布局：out/.trash/<bv>-<ts>/{out/<bv>, cache/video/<file>, cache/frames/<bv>}
function trashCandidates(bv) {
  const b = String(bv);
  const pre = b + '-';
  let names = [];
  try { names = fs.readdirSync(TRASH_DIR); } catch { return []; }
  return names
    .filter((n) => n.startsWith(pre) && /^[0-9]+$/.test(n.slice(pre.length)))
    .sort((x, y) => Number(y.slice(pre.length)) - Number(x.slice(pre.length)))
    .map((n) => path.join(TRASH_DIR, n));
}

/** 把一个 bv 的产物 + 视频缓存 + 帧图移进 trash（不真删） */
export function trashBv(bv) {
  const b = String(bv);
  if (!BV_RE.test(b)) return { trashed: false, freed: 0, dir: null };
  const now = Date.now();
  const dir = path.join(TRASH_DIR, b + '-' + now);
  const moves = [];
  const a = outDirOf(b);
  if (fs.existsSync(a)) moves.push({ src: a, dst: path.join(dir, 'out', b), isDir: true });
  const f = framesDirOf(b);
  if (fs.existsSync(f)) moves.push({ src: f, dst: path.join(dir, 'cache', 'frames', b), isDir: true });
  for (const vf of videoFilesOf(b)) moves.push({ src: vf, dst: path.join(dir, 'cache', 'video', path.basename(vf)), isDir: false });
  if (!moves.length) return { trashed: false, freed: 0, dir: null };
  let freed = 0, files = 0;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  for (const m of moves) {
    let size = 0;
    try { size = m.isDir ? sizeOfDir(m.src) : fs.statSync(m.src).size; } catch {}
    try {
      fs.mkdirSync(path.dirname(m.dst), { recursive: true });
      fs.renameSync(m.src, m.dst);
      freed += size; files++;
    } catch { /* 占用/跨设备：留原样，不影响记录删除 */ }
  }
  if (!files) { try { fs.rmdirSync(dir); } catch {} return { trashed: false, freed: 0, dir: null }; }
  return { trashed: true, freed, files, dir };
}

/** 从 trash 移回最近一次删除的产物与缓存（撤销） */
export function restoreBv(bv) {
  const b = String(bv);
  if (!BV_RE.test(b)) return { ok: false, reason: 'bad-bv' };
  const cands = trashCandidates(b);
  if (!cands.length) return { ok: false, reason: 'no-trash' };
  const dir = cands[0];
  let restored = 0;
  const put = (src, dst) => {
    try {
      if (!fs.existsSync(src)) return false;
      if (fs.existsSync(dst)) return false; // 不覆盖现存产物
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      restored++;
      return true;
    } catch { return false; }
  };
  put(path.join(dir, 'out', b), outDirOf(b));
  put(path.join(dir, 'cache', 'frames', b), framesDirOf(b));
  const vdir = path.join(dir, 'cache', 'video');
  let vnames = [];
  try { vnames = fs.readdirSync(vdir); } catch {}
  for (const n of vnames) put(path.join(vdir, n), path.join(VIDEO_DIR, n));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!restored) return { ok: false, reason: 'nothing-to-restore', dir };
  return { ok: true, restored, dir };
}

/** 惰性清理：trash 里超过 TTL（默认 600s）的目录真删 */
export function sweepTrash(nowMs = Date.now(), ttlMs = TRASH_TTL_MS) {
  let names = [];
  try { names = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return { removed: 0, freed: 0 }; }
  let removed = 0, freed = 0;
  for (const n of names) {
    const fp = path.join(TRASH_DIR, n);
    const t = Math.max(maxMtime(fp), (() => { try { return fs.statSync(fp).mtimeMs; } catch { return 0; } })());
    if (nowMs - t < ttlMs) continue;
    freed += sizeOfDir(fp);
    try { fs.rmSync(fp, { recursive: true, force: true }); removed++; } catch {}
  }
  return { removed, freed };
}

/** 跑完一条后的按策略清理（afterDone） */
export function afterDoneCleanup(bv) {
  const cfg = readStorage();
  if (cfg.afterDone === 'drop-cache') {
    const v = purgeVideoCache(bv), f = purgeFrames(bv);
    return { mode: cfg.afterDone, freed: v.freed + f.freed };
  }
  if (cfg.afterDone === 'drop-video') {
    const v = purgeVideoCache(bv);
    return { mode: cfg.afterDone, freed: v.freed };
  }
  if (cfg.sweepOnDone) return sweep(cfg); // keep 模式下也顺手扫一遍过期的
  return { mode: 'keep', freed: 0 };
}

function maxMtime(dir) {
  let t = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      try { const st = fs.statSync(fp); if (st.mtimeMs > t) t = st.mtimeMs; } catch {}
      if (e.isDirectory()) walk(fp);
    }
  };
  walk(dir);
  return t;
}

/** 按 keepDays 扫一遍：清「已归档且产物够旧」的视频/帧缓存，以及没有产物的孤儿缓存 */
export function sweep(cfg = readStorage(), nowMs = Date.now()) {
  const keepMs = Math.max(0, Number(cfg.keepDays) || 0) * 86400000;
  const due = (ms) => (keepMs === 0 ? true : nowMs - ms > keepMs);
  let freed = 0, videos = 0, frames = 0, orphans = 0;
  const artifactBvs = new Set();
  let outDirs = [];
  try { outDirs = fs.readdirSync(OUT_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
  for (const bv of outDirs) {
    if (!BV_RE.test(bv)) continue;
    artifactBvs.add(bv);
    const t = maxMtime(outDirOf(bv));
    if (!due(t)) continue;
    // 已归档且够旧：清缓存（out/ 里的宫格与总结保留）
    const st = cacheStateOf(bv);
    if (st.video) { const r = purgeVideoCache(bv); freed += r.freed; videos += r.removed; }
    if (st.frames) { const r = purgeFrames(bv); freed += r.freed; frames += r.removed; }
  }
  // 孤儿缓存：有缓存没产物
  const orphanBvs = new Set();
  try {
    for (const n of fs.readdirSync(VIDEO_DIR)) {
      const m = n.match(/^(BV[0-9A-Za-z]{6,14})[.-]/);
      if (m && !artifactBvs.has(m[1])) orphanBvs.add(m[1]);
    }
  } catch {}
  try {
    for (const n of fs.readdirSync(FRAMES_DIR, { withFileTypes: true })) {
      if (n.isDirectory() && BV_RE.test(n.name) && !artifactBvs.has(n.name)) orphanBvs.add(n.name);
    }
  } catch {}
  for (const bv of orphanBvs) {
    const vf = videoFilesOf(bv);
    const t = Math.max(0, ...vf.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }));
    const ft = maxMtime(framesDirOf(bv));
    const t2 = Math.max(t, ft);
    if (!due(t2)) continue;
    const r1 = purgeVideoCache(bv), r2 = purgeFrames(bv);
    freed += r1.freed + r2.freed; orphans++;
  }
  return { keepDays: cfg.keepDays, freed, videos, frames, orphans, at: new Date(nowMs).toISOString() };
}

function sizeOfSub(dir) { return fs.existsSync(dir) ? sizeOfDir(dir) : 0; }

/** 各部分占用（给面板显示） */
export function usage() {
  return {
    videoBytes: sizeOfSub(VIDEO_DIR),
    framesBytes: sizeOfSub(FRAMES_DIR),
    apiBytes: sizeOfSub(API_DIR),
    sheetsBytes: sizeOfSub(path.join(CACHE_ROOT, 'sheets')),
    // 契约 8：.trash 里的等待清理项不算「产物占用」
    outBytes: Math.max(0, sizeOfSub(OUT_DIR) - sizeOfSub(TRASH_DIR)),
  };
}
