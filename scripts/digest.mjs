// S1 单条视频 digest：解析 → 下载 1080p → 拉 AI 字幕 → 宫格 + 紧凑清单 + OCR + 定点帧 + evidence → 记 token 账
// 复用 dsh-video-storyboard 的 scan/plan/density/sheet/pipeline（不重写），本文件只做 B 站接入、类型自适应与记账。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, CODE_ROOT, ensureData } from './lib/paths.mjs';

// 数据目录：台账/产物/缓存/配置/凭证都写这里（旧布局下就是包根，本机行为不变）
ensureData();
const ROOT = DATA_ROOT;
// 代码目录：随包发布的只读资源（vendor / scripts），不在这里写数据
// 故事板依赖：优先用 npm 装的（node_modules），没有再回落到随包 vendor 的那份（MIT，见它的 LICENSE）
const SB = [
  path.join(CODE_ROOT, 'node_modules', 'dsh-video-storyboard', 'src'),
  path.join(CODE_ROOT, 'vendor', 'dsh-video-storyboard@0.4.5', 'src'),
].find((p) => fs.existsSync(path.join(p, 'pipeline.js')));
if (!SB) {
  console.error('缺少 dsh-video-storyboard：npm i dsh-video-storyboard，或把它的 src 放到 vendor/dsh-video-storyboard@0.4.5/');
  process.exit(3);
}

// 外部工具：优先随包内置（Windows 版从 GitHub Release 下载 zip，首次运行时解压到数据目录），
// 其次 VD_FFMPEG / VD_FFPROBE、PATH、常见安装位置（探测顺序见 scripts/lib/tools.mjs）
const { ensureFfmpegTools } = await import(pathToFileURL(path.join(CODE_ROOT, 'scripts', 'lib', 'tools.mjs')).href);
const TOOLS = await ensureFfmpegTools();
const FFMPEG = TOOLS.ffmpeg;
const FFPROBE = TOOLS.ffprobe;
if (!FFMPEG || !FFPROBE) {
  console.error(`缺少 ffmpeg/ffprobe。${TOOLS.hint || ''}`);
  process.exit(3);
}

const { runStoryboard, saveStoryboards } = await import(pathToFileURL(path.join(SB, 'pipeline.js')).href);
const bili = await import(pathToFileURL(path.join(CODE_ROOT, 'scripts', 'lib', 'bili.mjs')).href);
const dmLib = await import(pathToFileURL(path.join(CODE_ROOT, 'scripts', 'lib', 'danmaku.mjs')).href);

const args = process.argv.slice(2);
const bvid = args.find((a) => /^BV[0-9A-Za-z]+$/.test(a));
const depth = (args.find((a) => a.startsWith('--depth=')) || '--depth=T2').split('=')[1];
// 格数：短片默认 12 格单图（图 token 与格数无关，信息量 ×3）；长片交给 auto，由 plan 按 40s/格 + minGap 自动出多张 sheet
const cellsArg = Number((args.find((a) => a.startsWith('--cells=')) || '').split('=')[1]) || 0;
const charsArg = Number((args.find((a) => a.startsWith('--chars=')) || '').split('=')[1]) || 0;
const ocrLineCap = Number((args.find((a) => a.startsWith('--ocr-lines=')) || '').split('=')[1]) || 12;
const ocrMode = (args.find(a => a.startsWith('--ocr=')) || '--ocr=fields').split('=')[1]; // fields(默认) | full
const doOcr = depth === 'T3' || depth === 'T4' || args.includes('--ocr');
const zoomK = Number((args.find((a) => a.startsWith('--zoom=')) || '').split('=')[1]) || (depth === 'T4' ? 2 : 0);
// 弹幕默认开（0 token 抓取 + 本地聚合）：它是"哪一刻观众有反应"最便宜的线索
const doDanmaku = !args.includes('--no-danmaku') && depth !== 'T0' && depth !== 'T1';
const PY = (() => {
  for (const c of [process.env.VD_PYTHON, 'python', 'python3', 'py'].filter(Boolean)) {
    try { const r = spawnSync(c, ['--version'], { stdio: 'ignore' }); if (r && r.status === 0) return c; } catch { /* 试下一个 */ }
  }
  return 'python';
})();
if (!bvid) { console.error('用法: node scripts/digest.mjs BV1xxxxxxxxx [--depth=T2|T3|T4] [--cells=N] [--cell=3,7]'); process.exit(2); }

const dirs = {
  video: path.join(ROOT, 'cache', 'video'),
  api: path.join(ROOT, 'cache', 'api'),
  sheets: path.join(ROOT, 'cache', 'sheets'),
  out: path.join(ROOT, 'out', bvid),
  logs: path.join(ROOT, 'logs'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(...a);
const t0 = Date.now();
const stage = {};
let _last = Date.now();
const mark = (name) => { stage[name] = +((Date.now() - _last) / 1000).toFixed(2); _last = Date.now(); };

// ---------- 紧凑清单（替掉 storyboard 模板里的 507 token 说明文字）----------
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (s) => `${pad2(Math.floor(s / 60))}:${pad2(Math.floor(s % 60))}`;
const squeeze = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n) + '…'; };
// 只用于"同句判定"：去空白/标点/符号，小写
const normText = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
function formatCompact(board, { cellChars, title, bvid, duration, kind, cutRate, speechRate, dupOf, dupText }) {
  const sheets = board.sheets || [];
  const cells = sheets.flatMap((s) => s.cells || []);
  const dupN = (dupOf || []).filter(Boolean).length;
  const out = [
    `# ${title}`,
    `# ${bvid} · ${hhmm(duration)} · ${cells.length}格/${sheets.length}张图 · cuts=${board.cuts?.length ?? 0} · 类型=${kind}(刀${cutRate.toFixed(2)}/s 语速${speechRate.toFixed(2)}字/s) · 台词≤${cellChars}字${dupN ? ` · 同画面${dupN}` : ''}`,
    `# 格号=宫格图左上角编号；[起-止] frame@=该格取帧时刻(非起点)；台词为摘录，全文在 cache/api`,
  ];
  cells.forEach((c, i) => {
    const d = dupOf ? dupOf[i] : null;
    const dt = dupText ? dupText[i] : false;
    if (d && dt) {
      // 同画面且台词也几乎相同：只留时间码 + 指路，省掉整行重复台词
      out.push(`${i + 1}. [${hhmm(c.t_start)}-${hhmm(c.t_end)}] ＝同第${d}格（同画面，略）`);
      return;
    }
    if (d) {
      // 同画面但台词不同（= 一个画面讲了两句不同的话）：画面不再描述，台词保留
      out.push(`${i + 1}. [${hhmm(c.t_start)}-${hhmm(c.t_end)}] ＝同第${d}格画面 刀${c.cuts ?? 0} ${squeeze(c.text || '', cellChars)}`);
      return;
    }
    out.push(`${i + 1}. [${hhmm(c.t_start)}-${hhmm(c.t_end)}] frame@${Number.isFinite(c.t_frame) ? hhmm(c.t_frame) : '?'} 刀${c.cuts ?? 0} ${squeeze(c.text || '', cellChars)}`);
  });
  return out.join('\n');
}

function run(bin, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(bin)} exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

// 二进制输出（rawvideo 帧签名用）：run() 走字符串拼接会破坏二进制，这里单独一份
function runBuf(bin, argv) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let err = '';
    c.stdout.on('data', (d) => chunks.push(d));
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${path.basename(bin)} exit ${code}: ${String(err).slice(-300)}`))));
  });
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return { dest, bytes: fs.statSync(dest).size, cached: true };
  const res = await fetch(url, { headers: bili.headers() });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { dest, bytes: buf.length, cached: false };
}

// ---------- S0 解析 ----------
const info = await bili.view(bvid);
const subs = await bili.subtitles(info.aid, info.cid);
const zh = subs.find((s) => s.lan === 'ai-zh') || subs[0] || null;
mark('resolve');
log(`[S0] ${bvid} ${info.title}`);
log(`     ${bili.fmtDur(info.duration)} · ${info.dimension.width}x${info.dimension.height} · cid=${info.cid} · UP=${info.owner.name} · 字幕轨=${subs.length}${zh ? ' (用 ' + zh.lan + ')' : ''}`);

/* v49 A2：充电专属试看永远不可跑 —— 下载前就定性，exit 3（runner 据此首败终态，不反复重试） */
if (info.is_upower_exclusive && info.is_upower_preview) {
  const line = 'SKIP_PREVIEW 充电专属试看：UP 主充电专享，当前账号未充电';
  try { fs.writeSync(2, line + '\n'); } catch (e) {}
  try { fs.writeSync(1, line + '\n'); } catch (e) {}
  process.exit(3);
}

// ---------- S1 下载 ----------
const pu = await bili.playurl(info, 80);
const dash = pu.dash || {};
const vstream = (dash.video || []).filter((v) => v.id === 80 && v.codecid === 7)[0]
  || (dash.video || []).filter((v) => v.id === 80)[0]
  || (dash.video || [])[0];
if (!vstream) {
  /* 没有 dash 流：充电/试看片只回 durl（90 秒试看），其余情况也当不可跑，exit 3 */
  const line = (info.is_upower_exclusive || info.is_upower_preview)
    ? 'SKIP_PREVIEW 充电专属试看：UP 主充电专享，当前账号未充电'
    : 'SKIP_NOSTREAM playurl 没有可下载的视频流（dash 缺失，durl 也不完整）';
  try { fs.writeSync(2, line + '\n'); } catch (e) {}
  try { fs.writeSync(1, line + '\n'); } catch (e) {}
  process.exit(3);
}
const astream = (dash.audio || []).sort((a, b) => b.bandwidth - a.bandwidth)[0];
const vPath = path.join(dirs.video, `${bvid}-${vstream.width}p.m4s`);
const aPath = path.join(dirs.video, `${bvid}-audio.m4s`);
const vdl = await download(vstream.base_url, vPath);
const adl = astream ? await download(astream.base_url, aPath) : null;
const mp4 = path.join(dirs.video, `${bvid}.mp4`);
if (!fs.existsSync(mp4)) {
  const argv = ['-y', '-v', 'error', '-i', vdl.dest];
  if (adl) argv.push('-i', adl.dest);
  argv.push('-c', 'copy', '-movflags', '+faststart', mp4);
  await run(FFMPEG, argv);
}
mark('download');
log(`[S1] 视频 ${vstream.width}x${vstream.height} codecid=${vstream.codecid} ${(vdl.bytes / 1048576).toFixed(1)}MB${vdl.cached ? '(缓存)' : ''}`
  + (adl ? ` + 音频 ${(adl.bytes / 1048576).toFixed(1)}MB` : '') + ` → ${path.basename(mp4)}`);

// ---------- S2 字幕 → SRT ----------
let srtPath = null;
if (zh) {
  let url = zh.subtitle_url;
  if (url.startsWith('//')) url = 'https:' + url;
  const srtCache = path.join(dirs.api, `${bvid}.${zh.lan}.srt`);
  if (!fs.existsSync(srtCache)) {
    const j = await bili.jget(url);
    const cues = j.body || [];
    const stamp = (s) => {
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000);
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    const srt = cues.map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(c.to)}\n${c.content}\n`).join('\n');
    fs.writeFileSync(srtCache, srt, 'utf8');
    fs.writeFileSync(path.join(dirs.api, `${bvid}.${zh.lan}.json`), JSON.stringify({ meta: { bvid, lang: zh.lan, count: cues.length }, body: cues }, null, 1), 'utf8');
  }
  srtPath = srtCache;
}
mark('subtitle');
if (srtPath) {
  const cues = JSON.parse(fs.readFileSync(path.join(dirs.api, `${bvid}.${zh.lan}.json`), 'utf8')).body;
  log(`[S2] 字幕 ${zh.lan} ${cues.length} 条 / ${cues.reduce((a, c) => a + c.content.length, 0)} 字 → ${path.basename(srtPath)}`);
}

// ---------- S3 宫格 ----------
const longVideo = info.duration > 480;
const basePlan = cellsArg ? { cells: cellsArg, sheets: 1 } : (longVideo ? {} : { cells: 12, sheets: 1 });
const buildBoard = (planOpts) => runStoryboard({
  input: mp4,
  transcriptFile: srtPath || undefined,
  transcript: srtPath ? 'auto' : 'off',
  ...planOpts,
  pick: 'sharp',
  burn: 'index',
  budget: 640_000,
  audioStrip: true,
  ocr: false,
  ffmpegPath: FFMPEG,
  ffprobePath: FFPROBE,
});
let board = await buildBoard(basePlan);
mark('board');

// ---------- 按类型给台词长度 + 修格数（0 token 判定：刀密度 / 语速）----------
// 坑：storyboard 的 suggest() 在"语速快"时会把格数 ×0.6（假设台词承担信息），
// 对快剪片是错的——画面才是信息，6 格铺 8 分钟等于没看。这里按刀密度补一次。
const cutRate = (board.cuts?.length ?? 0) / Math.max(1, info.duration);
let subChars = 0;
try { subChars = JSON.parse(fs.readFileSync(path.join(dirs.api, `${bvid}.${zh.lan}.json`), 'utf8')).body.reduce((a, c) => a + c.content.length, 0); } catch { /* 无字幕 */ }
const speechRate = subChars / Math.max(1, info.duration);
let kind = '通用';
let cellChars = 80;
if (cutRate > 0.3) { kind = '快剪'; cellChars = 40; }
else if (speechRate > 3 && cutRate < 0.2) { kind = '静态讲解'; cellChars = 60; }
else if (cutRate < 0.08 && speechRate < 3.5) { kind = '访谈/播客'; cellChars = 120; }
if (charsArg) cellChars = charsArg;

let cellsNow = (board.sheets || []).flatMap((s) => s.cells || []).length;
let rePlan = '';
if (!cellsArg && cellsNow < 9 && info.duration > 240) {
  // 需要细看的类型：快剪 / 通用（有大量镜头切换但语速也快）
  const cuts = board.cuts?.length ?? 0;
  const want = cuts >= 150 ? 16 : 12;
  // 一张图放 16 格已是上限：再多格里的小字就不可读了。只有 >10 分钟才拆第二张。
  const sheets = info.duration > 600 ? 2 : 1;
  log(`[S3] ${cellsNow} 格对 ${Math.round(info.duration)}s 太粗（刀 ${cuts}）→ 重排 ${want} 格 / ${sheets} 张`);
  board = await buildBoard({ cells: want, sheets });
  mark('board2');
  cellsNow = (board.sheets || []).flatMap((s) => s.cells || []).length;
  rePlan = ` · 重排自 ${want}格`;
}

const sheetPath = path.join(dirs.out, 'sheet.png');

// ---------- S3.1 相邻格去重（0 token：帧感知哈希 + 台词相似）----------
// 判定：相邻两格 9x8 灰度 dHash 汉明距离、平均亮度差、台词二元组重合。
// 两档：visualSame=画面像素级相同（台词可能不同）；dupText=连台词也几乎相同（整行可省）。
const noDedupe = args.includes('--no-dedupe');
async function dedupeBoard(bd) {
  const cells = (bd.sheets || []).flatMap((s) => s.cells || []);
  const n = cells.length;
  const dOf = new Array(n).fill(null);
  const dText = new Array(n).fill(false);
  const pairs = [];
  if (noDedupe || n < 2) return { cells, dupOf: dOf, dupText: dText, pairs, ms: 0 };
  const tD = Date.now();
  const popcnt = (v) => { let c = 0; while (v) { v &= v - 1n; c++; } return c; };
  const hamming = (a, b) => popcnt(BigInt('0x' + a) ^ BigInt('0x' + b));
  const bigrams = (s) => { const t = normText(s); const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const dice = (ma, mb) => {
    if (!ma.size || !mb.size) return 0;
    let hit = 0, tot = 0;
    for (const [g, k] of ma) { tot += k; hit += Math.min(k, mb.get(g) || 0); }
    for (const [, k] of mb) tot += k;
    return (2 * hit) / tot;
  };
  const sigOf = async (t) => {
    try {
      const b = await runBuf(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', mp4, '-frames:v', '1',
        '-vf', 'scale=9:8', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
      if (b.length < 72) return null;
      let hex = '', luma = 0;
      for (let y = 0; y < 8; y++) {
        let nib = 0;
        for (let x = 0; x < 8; x++) { nib = (nib << 1) | (b[y * 9 + x] < b[y * 9 + x + 1] ? 1 : 0); luma += b[y * 9 + x]; }
        hex += nib.toString(16);
      }
      return { hex, luma: luma / 72 };
    } catch { return null; }
  };
  const sigs = [];
  for (const c of cells) {
    const t = Number.isFinite(c.t_frame) ? c.t_frame : (c.t_start + c.t_end) / 2;
    sigs.push({ s: await sigOf(t), bg: bigrams(c.text || ''), txtLen: normText(c.text || '').length });
  }
  const dbg = args.includes('--debug-dedupe');
  for (let i = 1; i < sigs.length; i++) {
    const a = sigs[i - 1].s, b = sigs[i].s;
    if (!a || !b) continue;
    const h = hamming(a.hex, b.hex);
    const dl = Math.abs(a.luma - b.luma);
    const sim = dice(sigs[i - 1].bg, sigs[i].bg);
    const bothShort = sigs[i - 1].txtLen < 8 && sigs[i].txtLen < 8;
    const visualSame = h <= 4 && dl <= 2;
    const sameText = sim >= 0.55 || bothShort;
    if (dbg) log(`        对 ${i}-${i + 1}: h=${h} lumaΔ=${dl.toFixed(1)} 台词相似=${sim.toFixed(2)}`
      + (visualSame ? ' → 同画面' : '') + (visualSame && sameText ? '（台词也同）' : ''));
    if (visualSame || (h <= 6 && dl <= 6 && sameText)) {
      dOf[i] = dOf[i - 1] ?? i;
      dText[i] = visualSame && sameText;
      pairs.push({ cell: i + 1, dupOf: dOf[i], kind: dText[i] ? '同画面+同台词' : '同画面', hamming: h, lumaDiff: +dl.toFixed(1), textSim: +sim.toFixed(2) });
    }
  }
  return { cells, dupOf: dOf, dupText: dText, pairs, ms: Date.now() - tD };
}

let ded = await dedupeBoard(board);
const fmtPairs = (p) => (p.length ? `（${p.map((x) => `第${x.cell}格＝第${x.dupOf}格`).join('、')}）` : '');
log(`[S3.1] 相邻格去重：${ded.cells.length} 格 → ${ded.pairs.length} 个重复${fmtPairs(ded.pairs)} · 耗时 ${ded.ms}ms · 0 token`);
// 真省钱的做法：同画面格白占一个格位。少要一格 → 每格变长（图 token 不变），但清单/OCR 各少一份。
// 只在自动格数时做一次，且要求重排后重复没变多。
// 实测结论（2026-10-30，三条片）：少要一格再重排**消不掉**重复——重复来自素材本身
// （连续镜头 / 一个画面讲两句），重排只是把重复挪个位置，长片还会变多（18格→17格重复 1→2）。
// 所以默认不做，只留 --try-rebalance 供以后素材变了再验证。
if (args.includes('--try-rebalance') && !cellsArg && ded.pairs.length && cellsNow - ded.pairs.length >= 9) {
  const want = cellsNow - ded.pairs.length;
  const sheets = (board.sheets || []).length;
  const b2 = await buildBoard({ cells: want, sheets });
  const d2 = await dedupeBoard(b2);
  if (d2.cells.length < ded.cells.length && d2.pairs.length <= ded.pairs.length) {
    board = b2;
    ded = d2;
    cellsNow = d2.cells.length;
    rePlan += ` · 去重后重排 ${cellsNow}格`;
    mark('board3');
    log(`[S3.1] 同画面格占位 → 重排 ${want} 格，现 ${d2.cells.length} 格 / 重复 ${d2.pairs.length}${fmtPairs(d2.pairs)}`);
  } else {
    log(`[S3.1] 重排 ${want} 格后重复变多（${d2.pairs.length}），保留原 ${ded.cells.length} 格`);
  }
}
const { dupOf, dupText } = ded;
const sheetPaths = await saveStoryboards(board, sheetPath, { ffmpegPath: FFMPEG, evidence: true });
mark('save');

const manifestCore = formatCompact(board, { cellChars, title: info.title, bvid, duration: info.duration, kind, cutRate, speechRate, dupOf, dupText });
log(`[S3] 类型=${kind}（刀密度 ${cutRate.toFixed(2)}/s · 语速 ${speechRate.toFixed(2)} 字/s）→ 每格台词 ≤${cellChars} 字 · ${cellsNow} 格${rePlan}`);

// ---------- S3.2 弹幕（抓取 0 token，本地去噪聚合）----------
let dmText = '';
let dmStats = null;
if (doDanmaku) {
  try {
    const xml = await dmLib.fetchDanmakuXml(info.cid);
    const dmItems = dmLib.parseXml(xml);
    const a = dmLib.analyze(dmItems, { duration: info.duration });
    dmText = dmLib.formatDense(a);
    dmStats = {
      total: a.total, kept: a.kept, junk: a.junk, spam: a.spam, marks: a.marks,
      hot_peaks: a.hotPeaks.slice(0, 8).map((w) => ({ t0: w.t0, count: w.count, top: w.top.slice(0, 2) })),
      signal_peaks: a.signalPeaks.slice(0, 5).map((w) => ({ t0: w.t0, marks: w.marks, top: w.top.slice(0, 2) })),
    };
    fs.mkdirSync(dirs.out, { recursive: true });
    fs.writeFileSync(path.join(dirs.out, 'danmaku.txt'), dmText, 'utf8');
    log(`[S3.2] 弹幕 ${a.total} 条 → 保留 ${a.kept}（剔刷屏 ${a.spam} / 无意义 ${a.junk}）· 文本 ${dmText.length} 字`);
  } catch (e) {
    log('[S3.2] 弹幕抓取失败（不影响主流程）：', e.message);
  }
}
const manifestText = dmText ? `${manifestCore}\n\n${dmText}` : manifestCore;

const cellList = (board.sheets || []).flatMap((s) => s.cells || []);

// ---------- S3.5 本地 OCR（0 token 的"读画面文字"）----------
let ocrText = '';
let ocrStats = null;
let ocrRows = [];
if (doOcr && cellList.length) {
  // 去重用：AI 字幕全文（已有，0 成本）——OCR 读到的烧字幕不该重复计费
  let cues = [];
  try { cues = JSON.parse(fs.readFileSync(path.join(dirs.api, `${bvid}.${zh.lan}.json`), 'utf8')).body || []; } catch { cues = []; }
  const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const cueN = cues.map((c) => ({ t0: c.from, t1: c.to, n: norm(c.content) }));
  const isBurntSubtitle = (txt, t) => {
    const n = norm(txt);
    if (n.length < 4) return false;
    const bg = new Map();
    for (let i = 0; i < n.length - 1; i++) { const g = n.slice(i, i + 2); bg.set(g, (bg.get(g) || 0) + 1); }
    for (const c of cueN) {
      if (t < c.t0 - 3 || t > c.t1 + 3) continue;
      if (c.n.includes(n) || n.includes(c.n)) return true;
      let hit = 0;
      for (const [g, k] of bg) if (c.n.includes(g)) hit += k;
      if (hit / Math.max(1, n.length - 1) >= 0.7) return true;
    }
    return false;
  };
  // 实测定下的系统性错字 / 水印映射
  const TERM_MAP = [[/囗/g, '口'], [/LiliLili/gi, ''], [/bilibili/gi, '']];
  const upNorm = norm(info.owner?.name || '');
  const frameDir = path.join(ROOT, 'cache', 'frames', bvid);
  fs.mkdirSync(frameDir, { recursive: true });
  const frames = [];
  let dupSkipped = 0;
  for (let i = 0; i < cellList.length; i++) {
    const c = cellList[i];
    if (dupOf[i]) { dupSkipped++; continue; } // 同画面格不重复 OCR
    const t = Number.isFinite(c.t_frame) ? c.t_frame : (c.t_start + c.t_end) / 2;
    // 2× Lanczos 预放大（实测：ASCII 码表帧从乱码变成有结构内容），0 token
    const p = path.join(frameDir, `f${String(i + 1).padStart(2, '0')}_${t.toFixed(2)}@2x.png`);
    if (!fs.existsSync(p)) {
      await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', mp4, '-frames:v', '1',
        '-vf', 'scale=iw*2:ih*2:flags=lanczos', '-q:v', '2', p]);
    }
    frames.push({ t, p });
  }
  const listFile = path.join(frameDir, 'list.txt');
  fs.writeFileSync(listFile, frames.map((f) => f.p).join('\n'), 'utf8');
  const { out } = await run(PY, [path.join(CODE_ROOT, 'scripts', 'ocr_winsdk.py'), listFile], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const byPath = new Map();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); byPath.set(j.path, j); } catch { /* 跳过 */ }
  }
  const clean = (s) => String(s || '')
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/\s{2,}/g, ' ').trim();
  /* 字段模式判据（0 token）：只留"能当事实用"的行
     - 命中参数/型号/价格/比例 → 留（这是字幕里通常没有的硬信息）
     - 有 ≥4 字连续可读汉字且不是"单字乱码拼接"（单字 token 占比 <55%）→ 留
     - 其余整行丢（实测这批素材 63% 是噪声，且噪声行最贵） */
  // 注意：裸的 A / V 会误命中乱码里的 "49A" "3Vu"，所以两侧都加边界，且单位后不能再接字母
  const PARAM_RE = /(?<![A-Za-z0-9])(\d+(?:\.\d+)?\s*(?:mm|cm|mAh|W|V|A|Hz|kHz|MHz|GB|TB|MB\/s|℃|度|nm|bit|fps|kg|寸|英寸|米|块|元|倍|%))(?![A-Za-z0-9])|(?<![A-Za-z0-9])([A-Z]{2,}-?\d{3,}[A-Za-z0-9-]*)|(?<![A-Za-z0-9])([A-Z]{2,}\d{2,}[A-Za-z0-9-]*)/;
  const WATER_RE = /bilibili|哔哩哔哩|抖音|快手|小红书|youtube|lofter/i;
  const CJK_RUN_RE = /[\u4e00-\u9fff]{4,}/g;
  const USELESS_RUN = /^[的了是在和与及或上下个这那些么什怎一二三四五六七八九十百千万]+$/;
  const isInformative = (txt) => {
    if (WATER_RE.test(txt)) return false;
    const t = String(txt).trim();
    if ([...t].length < 3) return false;
    if (PARAM_RE.test(t)) return true;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk < 4) return false;
    // 汉字必须占"有效字符"的多数，否则是"乱码里夹了几个汉字"
    const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
    if (cjk / Math.max(1, cjk + alnum) < 0.6) return false;
    const toks = t.split(/\s+/).filter(Boolean);
    const singleRatio = toks.filter(x => [...x].length === 1).length / Math.max(1, toks.length);
    if (singleRatio >= 0.5) return false;
    const runs = (t.match(CJK_RUN_RE) || []).filter(r => !USELESS_RUN.test(r));
    return runs.length > 0;
  };

  const seen = new Set();
  const seenSeg = new Set();
  const rows = [];
  const rawRows = [];
  const dropped = { subtitle: 0, watermark: 0, dup: 0, short: 0, capped: 0, noisy: 0 };
  let rawLines = 0;
  for (const f of frames) {
    const j = byPath.get(f.p);
    if (!j || j.error) continue;
    let lines = [];
    const rawLinesList = [];
    for (const l of j.lines || []) {
      rawLines++;
      let txt = clean(l.t);
      for (const [re, to] of TERM_MAP) txt = txt.replace(re, to);
      txt = clean(txt);
      if (txt.length < 2) { dropped.short++; continue; }
      if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(txt)) { dropped.short++; continue; }
      if (upNorm && norm(txt) === upNorm) { dropped.watermark++; continue; }
      if (isBurntSubtitle(txt, f.t)) { dropped.subtitle++; continue; }
      const key = txt.replace(/\s/g, '');
      if (seen.has(key)) { dropped.dup++; continue; }
      seen.add(key);
      rawLinesList.push(txt);
      const segs = txt.split(/\s*[\/|｜]+\s*/).map(x => x.trim()).filter(x => x.length >= 2);
      let keepSegs;
      if (ocrMode === 'full') keepSegs = segs;
      else {
        keepSegs = segs.filter(isInformative);
        dropped.noisy += Math.max(0, segs.length - keepSegs.length);
      }
      keepSegs = keepSegs.filter((sg) => {
        const k = sg.replace(/\s/g, '');
        if (seenSeg.has(k)) { dropped.dup++; return false; }
        seenSeg.add(k); return true;
      });
      if (keepSegs.length) lines.push(keepSegs.join(' / '));
      else if (ocrMode !== 'full') dropped.noisy++;
    }
    if (lines.length > ocrLineCap) {
      // 密集文字帧限行：只留最长的 N 行（信息密度最高），省 token
      const keepIdx = lines.map((l, k) => [l, k]).sort((a, b) => b[0].length - a[0].length)
        .slice(0, ocrLineCap).map(([, k]) => k).sort((a, b) => a - b);
      dropped.capped += lines.length - ocrLineCap;
      lines = keepIdx.map((k) => lines[k]);
    }
    if (rawLinesList.length) rawRows.push({ t: f.t, lines: rawLinesList });
    if (lines.length) rows.push({ t: f.t, lines });
  }
  const stamp = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  ocrText = rows.map((r) => `[${stamp(r.t)}] ${r.lines.join(' / ')}`).join('\n');
  const rawText = rawRows.map((r) => `[${stamp(r.t)}] ${r.lines.join(' / ')}`).join('\n');
  ocrStats = { frames: frames.length, hits: rows.length, lines: (rows.flatMap(r => r.lines)).length, raw_lines: rawLines, clean_lines: seen.size, dropped, chars: ocrText.length, raw_chars: rawText.length, dedupe_skipped: dupSkipped, mode: ocrMode };
  ocrRows = rows;
  fs.writeFileSync(path.join(dirs.out, 'ocr.txt'), ocrText, 'utf8');
  fs.writeFileSync(path.join(dirs.out, 'ocr.raw.txt'), rawText, 'utf8');
  mark('ocr');
  log(`[S3.5] OCR ${ocrStats.frames} 帧(2×放大) → ${ocrStats.hits} 帧有字 / ${ocrStats.lines} 行 / ${ocrStats.chars} 字（0 token）`
    + (dupSkipped ? ` · 同画面跳过 ${dupSkipped} 帧` : '')
    + ` · 丢弃 烧字幕${dropped.subtitle} 水印${dropped.watermark} 重复${dropped.dup} 短行${dropped.short} 超限${dropped.capped} 噪声${dropped.noisy} / 原始 ${rawLines} 行 · 模式 ${ocrMode}`);
}

// ---------- S3.6 定点原生帧（T4）：三源合并打分选格 ----------
// 判据：画面文字量（OCR）+ 镜头切换密度 + 台词关键词密度。同刻多源命中 = 值得细看。
const KEYWORDS = ['代码', '报错', '错误', '参数', '配置', '步骤', '注意', '原理', '公式', '总结', '对比', '表格', '型号', '价格', '版本', '接口', '命令', '设置', '规则', '警告'];
const ocrCharsOf = (c) => ocrRows.filter((r) => r.t >= c.t_start && r.t <= c.t_end).reduce((a, r) => a + r.lines.join('').length, 0);
const kwOf = (c) => { const t = String(c.text || ''); return KEYWORDS.reduce((a, k) => a + (t.split(k).length - 1), 0); };
const maxCuts = Math.max(1, ...cellList.map((c) => c.cuts || 0));
const ocrArr = cellList.map(ocrCharsOf);
const maxOcr = Math.max(1, ...ocrArr);
const kwArr = cellList.map(kwOf);
const maxKw = Math.max(1, ...kwArr);
// 弹幕信号：热峰按条数、争议/干货峰按信号数加权。按格时长归一（格长 36–71s 差一倍，绝对数会灌水）
const dmPeaks = [];
if (dmStats) {
  for (const p of dmStats.hot_peaks || []) dmPeaks.push({ t: p.t0, w: p.count });
  for (const p of dmStats.signal_peaks || []) dmPeaks.push({ t: p.t0, w: Object.values(p.marks || {}).reduce((a, b) => a + b, 0) * 6 });
}
const dmDensity = (c) => {
  if (!dmPeaks.length) return 0;
  const durMin = Math.max(1, (c.t_end - c.t_start) / 60);
  return dmPeaks.filter((p) => p.t >= c.t_start && p.t <= c.t_end).reduce((a, p) => a + p.w, 0) / durMin;
};
const dmArr = cellList.map(dmDensity);
const maxDm = Math.max(1, ...dmArr);
const scored = cellList.map((c, i) => ({
  c,
  id: i + 1,
  // 四源：画面文字 0.35 · 镜头切换 0.25 · 台词关键词 0.15 · 弹幕反应 0.25（有弹幕时）
  score: +(0.35 * (ocrArr[i] / maxOcr) + 0.25 * ((c.cuts || 0) / maxCuts) + 0.15 * (kwArr[i] / maxKw) + 0.25 * (dmArr[i] / maxDm)).toFixed(3),
  why: `画面文字${ocrArr[i]}字 刀${c.cuts || 0} 关键词${kwArr[i]} 弹幕密度${dmArr[i].toFixed(0)}`,
}));
let zoomFiles = [];
let zoomMeta = [];
if (zoomK > 0 && cellList.length) {
  const zoomDir = path.join(dirs.out, 'zoom');
  fs.mkdirSync(zoomDir, { recursive: true });
  const ranked = scored.filter((s) => !dupOf[s.id - 1]).sort((a, b) => b.score - a.score).slice(0, zoomK);
  const dupSkippedZoom = scored.filter((s) => dupOf[s.id - 1]).map((s) => s.id);
  if (dupSkippedZoom.length) log(`[S3.6] 同画面格不参与定点选择：第${dupSkippedZoom.join('、')}格`);
  for (let i = 0; i < ranked.length; i++) {
    const { c, id, score, why } = ranked[i];
    const t = Number.isFinite(c.t_frame) ? c.t_frame : (c.t_start + c.t_end) / 2;
    const p = path.join(zoomDir, `z${i + 1}_c${id}_${t.toFixed(2)}.png`);
    if (!fs.existsSync(p)) {
      await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', mp4, '-frames:v', '1',
        '-vf', 'scale=1280:-2', '-q:v', '2', p]);
    }
    zoomFiles.push(p);
    zoomMeta.push({ cell: id, t, score, why, bytes: fs.statSync(p).size });
  }
  mark('zoom');
  log(`[S3.6] 定点帧 ${zoomFiles.length} 张（打分选格）→ ${zoomDir}`);
  for (const z of zoomMeta) log(`        第${z.cell}格 score=${z.score} ${z.why}`);
}

// ---------- S3.7 按格回看（cellId ↔ 时间反查，原生分辨率）----------
const selArg = (args.find((a) => a.startsWith('--cell=')) || '').split('=')[1] || '';
const selIds = selArg ? selArg.split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0) : [];
const cellShots = [];
if (selIds.length && cellList.length) {
  const cdir = path.join(dirs.out, 'cells');
  fs.mkdirSync(cdir, { recursive: true });
  const stamp = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  for (const id of selIds) {
    const c = cellList[id - 1];
    if (!c) { log(`[S3.7] 第 ${id} 格不存在（本片共 ${cellList.length} 格）`); continue; }
    if (dupOf[id - 1]) log(`[S3.7] 注意：第${id}格与第${dupOf[id - 1]}格同画面（你手动指定，仍取原生帧）`);
    const t = Number.isFinite(c.t_frame) ? c.t_frame : (c.t_start + c.t_end) / 2;
    const p = path.join(cdir, `c${String(id).padStart(2, '0')}_${t.toFixed(2)}.png`);
    if (!fs.existsSync(p)) {
      await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', mp4, '-frames:v', '1', '-q:v', '1', p]);
    }
    cellShots.push({ cell: id, t: +t.toFixed(2), file: p });
    const ocrLines = ocrRows.filter((r) => r.t >= c.t_start && r.t <= c.t_end).flatMap((r) => r.lines);
    log(`[S3.7] 第${id}格 ${stamp(c.t_start)}-${stamp(c.t_end)} frame@${stamp(t)} 刀${c.cuts || 0} 原生${vstream.width}x${vstream.height} → ${path.basename(p)}`);
    if (c.text) log(`        台词: ${String(c.text).slice(0, 220)}`);
    if (ocrLines.length) log(`        画面文字: ${ocrLines.slice(0, 14).join(' / ')}`);
  }
  mark('cells');
}

// ---------- S4 记账 ----------
const TOK = (w, h) => {
  // 宿主会把图缩到 ceil(w/42)*ceil(h/42) ≤ 1024 再送模型；按同一规则求"实际计费尺寸"
  for (let k = 1; k > 0.05; k -= 0.01) {
    const t = Math.ceil((w * k) / 42) * Math.ceil((h * k) / 42);
    if (t <= 1024) return t;
  }
  return 1024;
};
const textTokens = (s) => {
  const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk * 1.0 + other / 3.5);
};
const sheetsMeta = (board.sheets || []).map((s) => ({ w: s.width, h: s.height, cellW: s.cellW, cellH: s.cellH, cells: s.cells?.length || 0, tokens: TOK(s.width, s.height) }));
const imgTokens = sheetsMeta.reduce((a, s) => a + s.tokens, 0);
const zoomTokens = zoomFiles.length * TOK(1280, 720) + cellShots.length * TOK(vstream.width, vstream.height);
const txtTokens = textTokens(manifestCore);
const dmTokens = dmText ? textTokens(dmText) : 0;
const ocrTokens = textTokens(ocrText);
const minutes = info.duration / 60;
const wall = (Date.now() - t0) / 1000;

const cost = {
  bvid, title: info.title, depth, kind, cell_chars: cellChars,
  up: info.owner && info.owner.name ? info.owner.name : '',
  up_mid: info.owner && info.owner.mid ? Number(info.owner.mid) : 0,
  duration_sec: info.duration, minutes: +minutes.toFixed(2),
  source: { width: vstream.width, height: vstream.height, codecid: vstream.codecid, download_mb: +((vdl.bytes + (adl?.bytes || 0)) / 1048576).toFixed(1) },
  transcript: srtPath ? { lang: zh.lan, cues: JSON.parse(fs.readFileSync(path.join(dirs.api, `${bvid}.${zh.lan}.json`), 'utf8')).body.length } : null,
  cuts: board.cuts?.length ?? 0,
  frames: board.info ? { w: board.info.width, h: board.info.height, fps: board.info.fps } : null,
  sheets: sheetsMeta,
  dedupe: {
    method: 'dhash9x8 + luma + 台词二元组',
    pairs: ded.pairs,
    dup_cells: ded.pairs.length,
    ocr_frames_skipped: ocrStats?.dedupe_skipped || 0,
    zoom_cells_excluded: ded.pairs.map((p) => p.cell),
    ms: ded.ms,
  },
  ocr: ocrStats,
  danmaku: dmStats,
  zoom: zoomFiles.length ? { k: zoomFiles.length, tokens_each: TOK(1280, 720), picks: zoomMeta, files: zoomFiles.map((p) => path.basename(p)) } : null,
  cell_shots: cellShots.length ? { k: cellShots.length, tokens_each: TOK(vstream.width, vstream.height), items: cellShots } : null,
  tokens: {
    sheet_images: imgTokens,
    zoom_images: zoomTokens,
    manifest_text: txtTokens,
    danmaku_text: dmTokens,
    ocr_text: ocrTokens,
    total: imgTokens + zoomTokens + txtTokens + dmTokens + ocrTokens,
  },
  per_minute: +(((imgTokens + zoomTokens + txtTokens + dmTokens + ocrTokens) / minutes)).toFixed(0),
  artifacts: { sheets: sheetPaths, evidence: board.evidencePath, manifest_chars: manifestText.length },
  timing_sec: stage, wall_sec: +wall.toFixed(1),
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(dirs.out, 'cost.json'), JSON.stringify(cost, null, 2), 'utf8');
fs.writeFileSync(path.join(dirs.out, 'manifest.txt'), manifestText, 'utf8');

// SQLite 账本（node:sqlite 内建）
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dirs.logs, 'ledger.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, bvid TEXT, title TEXT, depth TEXT,
    duration_sec REAL, minutes REAL, images INTEGER, text_tokens INTEGER, total_tokens INTEGER,
    per_minute REAL, cuts INTEGER, wall_sec REAL, sheets INTEGER, source TEXT)`);
  db.prepare(`INSERT INTO runs (at,bvid,title,depth,duration_sec,minutes,images,text_tokens,total_tokens,per_minute,cuts,wall_sec,sheets,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    cost.at, bvid, info.title, depth, info.duration, cost.minutes,
    imgTokens + zoomTokens, txtTokens + dmTokens + ocrTokens, imgTokens + zoomTokens + txtTokens + dmTokens + ocrTokens, cost.per_minute,
    cost.cuts, cost.wall_sec, sheetsMeta.length, `${vstream.width}p`,
  );
  const row = db.prepare('SELECT COUNT(*) n, SUM(total_tokens) t, SUM(minutes) m FROM runs').get();
  log(`[账本] 累计 ${row.n} 条 / ${row.t} token / ${Number(row.m).toFixed(1)} 分钟 → 均值 ${(row.t / Math.max(0.01, row.m)).toFixed(0)} token/分钟`);
} catch (e) {
  log('[账本] SQLite 写入失败：', e.message);
}

log('');
log(`[S3] 宫格 ${sheetsMeta.map((s) => `${s.w}x${s.h}(${s.cells}格)`).join(' ')} → ${sheetPaths.map((p) => path.basename(p)).join(', ')}`);
log(`[清单] ${manifestCore.length} 字 ≈ ${txtTokens} token${dmText ? ` ｜ 弹幕 ${dmText.length} 字 ≈ ${dmTokens}` : ''}${ocrStats ? ` ｜ OCR ${ocrStats.chars} 字 ≈ ${ocrTokens}` : ''}`);
log(`[成本] 宫格图 ${imgTokens}${zoomTokens ? ` + 定点图 ${zoomTokens}` : ''} + 文本 ${txtTokens}${dmTokens ? ` + 弹幕 ${dmTokens}` : ''}${ocrTokens ? ` + OCR ${ocrTokens}` : ''} = ${imgTokens + zoomTokens + txtTokens + dmTokens + ocrTokens} token / ${minutes.toFixed(2)} 分钟`);
log(`       ★ ${cost.per_minute} token/分钟`);
log(`[耗时] 总 ${wall.toFixed(1)}s  各段 ${JSON.stringify(stage)}`);
log(`[产物] ${dirs.out}`);
