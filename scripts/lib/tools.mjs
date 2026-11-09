// 外部工具定位：内置版 ffmpeg/ffprobe 不再进 git 仓库（74MB 的 zip 放 GitHub Release 附件）。
// 查找顺序：VD_FFMPEG/VD_FFPROBE → 数据目录 tools → 包内 tools → PATH → 常见安装位置。
// 都没有时，按以下顺序尝试“内置包”：VD_TOOLS_ZIP 指定的本地 zip → 数据目录 tools/*.zip
// → 包内 tools/win64/*.zip → 从 toolsZipUrl（config/plugin.json）或 VD_TOOLS_URL 下载到数据目录再解压。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_ROOT, CODE_ROOT } from './paths.mjs';

const EXE = process.platform === 'win32' ? '.exe' : '';
const TOOLS_DIR = path.join(DATA_ROOT, 'tools');
const ZIP_NAME = 'ffmpeg-9.0.2-win64.zip';

/** 从 package.json 的 repository 推 Release 附件地址（避免把 owner 写死在代码里） */
function releaseToolsUrl() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'package.json'), 'utf8'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || '';
    const m = /github\.com[/:]([^/]+)\/([^/.#]+)/i.exec(repo);
    if (!m) return '';
    if (/^owner$/i.test(m[1])) return ''; // 占位地址，等维护者填真实仓库
    const version = String(pkg.version || '').trim();
    if (!version) return '';
    return `https://github.com/${m[1]}/${m[2]}/releases/download/v${version}/${ZIP_NAME}`;
  } catch { return ''; }
}

function log(msg) {
  try { console.error(`[tools] ${msg}`); } catch { /* ignore */ }
}

function ok(bin) {
  if (!bin) return false;
  try {
    const usePath = !(bin.includes('/') || bin.includes('\\'));
    if (!usePath && !fs.existsSync(bin)) return false;
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 8000 });
    return Boolean(r && r.status === 0);
  } catch { return false; }
}

function candidates(exe, envName, extra = []) {
  return [
    process.env[envName],
    path.join(TOOLS_DIR, exe + EXE),
    path.join(CODE_ROOT, 'tools', exe + EXE),
    path.join(CODE_ROOT, 'tools', 'win64', exe + EXE),
    exe,
    ...extra,
  ].filter(Boolean);
}

/** 返回 ffmpeg 可执行路径；找不到返回 null（不抛错，调用方决定怎么提示） */
export function findFfmpeg() {
  for (const c of candidates('ffmpeg', 'VD_FFMPEG', ['C:\\ffmpeg\\bin\\ffmpeg.exe', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'])) {
    if (ok(c)) return c;
  }
  return null;
}

/** 返回 ffprobe 可执行路径；找不到返回 null */
export function findFfprobe() {
  for (const c of candidates('ffprobe', 'VD_FFPROBE', ['C:\\ffmpeg\\bin\\ffprobe.exe', '/usr/bin/ffprobe', '/opt/homebrew/bin/ffprobe'])) {
    if (ok(c)) return c;
  }
  return null;
}

function findLocalZip() {
  const out = [];
  if (process.env.VD_TOOLS_ZIP) out.push(process.env.VD_TOOLS_ZIP);
  out.push(path.join(TOOLS_DIR, ZIP_NAME));
  out.push(path.join(CODE_ROOT, 'tools', 'win64', ZIP_NAME));
  for (const dir of [TOOLS_DIR, path.join(CODE_ROOT, 'tools', 'win64')]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.zip$/i.test(f)) out.push(path.join(dir, f));
      }
    } catch { /* 目录不存在 */ }
  }
  return out.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function configToolsUrl() {
  if (process.env.VD_TOOLS_URL) return process.env.VD_TOOLS_URL;
  for (const dir of [DATA_ROOT, CODE_ROOT]) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'plugin.json'), 'utf8'));
      if (raw && typeof raw.toolsZipUrl === 'string' && raw.toolsZipUrl.trim()) return raw.toolsZipUrl.trim();
    } catch { /* 试下一个 */ }
  }
  return '';
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('响应没有 body');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

/** 把 zip 解压到 <数据目录>/tools（幂等） */
export function extractZip(zipPath) {
  const dir = TOOLS_DIR;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const attempts = [
    // Windows 10+ 自带 bsdtar，能直接解 zip，比 PowerShell 快且不受执行策略影响
    ['tar', ['-xf', zipPath, '-C', dir]],
    ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]],
  ];
  for (const [bin, argv] of attempts) {
    try {
      const r = spawnSync(bin, argv, { stdio: 'ignore', timeout: 120000 });
      if (r && r.status === 0 && fs.existsSync(path.join(dir, 'ffmpeg' + EXE))) return { ok: true, dir };
    } catch { /* 试下一个 */ }
  }
  return { ok: false, why: 'extract-failed' };
}

/** 兼容旧接口：解压内置 zip（本地或已下载的） */
export function extractBundledTools() {
  const zip = findLocalZip();
  if (!zip) return { ok: false, why: 'no-bundle' };
  return extractZip(zip);
}

/**
 * 确保 ffmpeg/ffprobe 可用：先找；找不到就用本地 zip / 下载 Release 附件，解压后再找。
 * 返回 { ffmpeg, ffprobe, extracted, downloaded, zip, hint? }；都失败时 ffmpeg/ffprobe 为 null。
 */
export async function ensureFfmpegTools() {
  let ffmpeg = findFfmpeg();
  let ffprobe = findFfprobe();
  if (ffmpeg && ffprobe) return { ffmpeg, ffprobe, extracted: false, downloaded: false, zip: null };

  let zip = findLocalZip();
  let downloaded = false;
  if (!zip) {
    // 优先级：VD_TOOLS_URL / config toolsZipUrl > package.json repository 推导出的 Release 附件地址
    const url = configToolsUrl() || releaseToolsUrl();
    if (url) {
      const dest = path.join(TOOLS_DIR, ZIP_NAME);
      try {
        log(`首次运行：正在从 ${url} 下载 ffmpeg（约 74MB）…`);
        zip = await download(url, dest);
        downloaded = true;
      } catch (e) {
        log(`下载失败：${e && e.message}`);
      }
    }
  }
  let extracted = false;
  if (zip) {
    log(`正在解压 ${path.basename(zip)} 到 ${TOOLS_DIR} …`);
    const r = extractZip(zip);
    extracted = Boolean(r.ok);
    if (extracted) {
      ffmpeg = ffmpeg || findFfmpeg();
      ffprobe = ffprobe || findFfprobe();
    }
  }
  const hint = ffmpeg && ffprobe
    ? null
    : 'Windows：从 GitHub Release 下载 ffmpeg-9.0.2-win64.zip 放到 <数据目录>/tools/ 后重试（或把下载地址写进 config/plugin.json 的 toolsZipUrl / 环境变量 VD_TOOLS_URL）。其它平台：安装 ffmpeg 到 PATH，或用 VD_FFMPEG / VD_FFPROBE 指定。';
  return { ffmpeg, ffprobe, extracted, downloaded, zip, hint };
}

/** 给面板/体检用的摘要 */
export async function toolsInfo() {
  const r = await ensureFfmpegTools();
  return {
    ffmpeg: r.ffmpeg || null,
    ffprobe: r.ffprobe || null,
    zip: r.zip || null,
    toolsDir: TOOLS_DIR,
    hint: r.hint || null,
  };
}
