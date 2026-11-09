// 路径唯一真源：**代码根（CODE_ROOT）** 与 **数据根（DATA_ROOT）** 分开。
//
// 为什么必须分开：发布后代码会装进 node_modules / DSH 插件目录（只读、随包升级被覆盖），
// 而台账、产物、缓存、配置、凭证必须落在用户自己的数据目录里。
// 以前这些路径写死成 'D:/一起看视频'，别人装到任何别的位置都写不进数据。
//
// 数据根解析顺序（第一个命中的胜出，结果见 DATA_SOURCE）：
//   1) $VD_DATA                    显式指定，最高优先，严格使用（不做任何兜底）
//   2) $DSH_HOME/video-digest/     DSH_HOME 默认 ~/.dsh，即 ~/.dsh/video-digest/
//   3) 旧布局兜底：<CODE_ROOT>/logs/library.db 存在 → 把代码根当数据根
//      （老用户不迁移也能继续跑，只打一条告警；迁移用 scripts/migrate_data.mjs）
//   4) 首次运行（以上都没有数据）→ 用 2，并由 ensureData() 自建目录
//
// 数据目录结构（都在 DATA_ROOT 下）：
//   logs/      台账 library.db、ledger.db、各种 .log/.jsonl
//   out/       产物（每条视频一个目录）
//   cache/     视频下载 + 放大帧 + API 缓存（可随时删，7GB 级）
//   config/    配置（首次运行从包的 config/ 播种，之后用户自己的）
//   secrets/   凭证（永不入库）
//   runtime/   Python pylibs（OCR 用，可重建）
//   derived/   派生数据
//   inbox/     入站
//
// 用法（脚本里）：
//   import { DATA_ROOT, CODE_ROOT, DIRS, ensureData } from './lib/paths.mjs';
//   ensureData();                 // 首次运行自建目录 + 播种配置，幂等
//   const ROOT = DATA_ROOT;       // 绝大多数脚本只需要这一个
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <code>/scripts/lib
/** 代码根：scripts/lib 往上两级（包的根目录；也兼容 <pkg>/plugin 布局，见 plugin/index.js 的探测） */
export const CODE_ROOT = path.resolve(HERE, '..', '..');

const cleanEnv = (v) => {
  const s = String(v == null ? '' : v).trim().replace(/^["']|["']$/g, '');
  return s ? path.resolve(s) : '';
};

/** DSH_HOME：默认 ~/.dsh（与 DSH 宿主一致） */
export const DSH_HOME = cleanEnv(process.env.DSH_HOME) || path.join(homedir(), '.dsh');

/** 默认数据根：<DSH_HOME>/video-digest */
export const DEFAULT_DATA_ROOT = path.join(DSH_HOME, 'video-digest');

/** 旧布局（数据与代码同目录）的判定依据 */
const LEGACY_MARK = path.join('logs', 'library.db');

const hasData = (dir) => {
  try {
    return !!dir && fs.existsSync(path.join(dir, LEGACY_MARK));
  } catch {
    return false;
  }
};

function resolveDataRoot() {
  const envRoot = cleanEnv(process.env.VD_DATA);
  if (envRoot) return { root: envRoot, source: 'env' };
  if (process.env.VD_DATA != null && String(process.env.VD_DATA).trim() === '') {
    // 显式设成空串 = 用户想用默认值，继续往下走
  }
  if (hasData(DEFAULT_DATA_ROOT)) return { root: DEFAULT_DATA_ROOT, source: 'dsh-home' };
  if (hasData(CODE_ROOT) && path.resolve(CODE_ROOT) !== path.resolve(DEFAULT_DATA_ROOT))
    return { root: CODE_ROOT, source: 'legacy' };
  return { root: DEFAULT_DATA_ROOT, source: 'fresh' };
}

const _resolved = resolveDataRoot();

/** 数据根：台账/产物/缓存/配置/凭证 都在它下面 */
export const DATA_ROOT = _resolved.root;
/** 数据根来源：'env' | 'dsh-home' | 'legacy' | 'fresh' */
export const DATA_SOURCE = _resolved.source;

/** 数据目录下的标准子目录（用 DIRS.xxx，别自己拼） */
export const DIRS = Object.freeze({
  out: path.join(DATA_ROOT, 'out'),
  logs: path.join(DATA_ROOT, 'logs'),
  cache: path.join(DATA_ROOT, 'cache'),
  config: path.join(DATA_ROOT, 'config'),
  secrets: path.join(DATA_ROOT, 'secrets'),
  runtime: path.join(DATA_ROOT, 'runtime'),
  templates: path.join(DATA_ROOT, 'config', 'templates'),
  derived: path.join(DATA_ROOT, 'derived'),
  inbox: path.join(DATA_ROOT, 'inbox'),
  backup: path.join(DATA_ROOT, 'config', 'backup'),
});

/** 代码目录下的标准位置（发布包里随包走的只读资源） */
export const CODE_DIRS = Object.freeze({
  scripts: path.join(CODE_ROOT, 'scripts'),
  lib: path.join(CODE_ROOT, 'scripts', 'lib'),
  panel: path.join(CODE_ROOT, 'panel'),
  config: path.join(CODE_ROOT, 'config'),
  vendor: path.join(CODE_ROOT, 'vendor'),
});

const MARKER = path.join(DIRS.logs, 'data-root.json');

/** 数据根诊断信息（写进 /api/meta、日志、迁移报告） */
export function dataInfo() {
  let note = '';
  if (DATA_SOURCE === 'legacy')
    note = '正在使用旧布局（数据与代码同目录）。建议运行 node scripts/migrate_data.mjs 迁移到 ' + DEFAULT_DATA_ROOT;
  else if (DATA_SOURCE === 'fresh') note = '首次运行，已使用默认数据目录 ' + DEFAULT_DATA_ROOT;
  else if (DATA_SOURCE === 'env') note = '数据目录由环境变量 VD_DATA 指定';
  return {
    dataRoot: DATA_ROOT,
    codeRoot: CODE_ROOT,
    source: DATA_SOURCE,
    defaultRoot: DEFAULT_DATA_ROOT,
    dshHome: DSH_HOME,
    note,
  };
}

/** 警告只打一次（脚本/面板共进程重复 import 也只有一个） */
let _warned = false;
function warnLegacy() {
  if (_warned || DATA_SOURCE !== 'legacy') return;
  _warned = true;
  if (process.env.VD_QUIET === '1') return;
  console.error(
    '[video-digest] 注意：数据目录仍在使用旧布局 ' +
      DATA_ROOT +
      '\n             建议迁移到 ' +
      DEFAULT_DATA_ROOT +
      '（node scripts/migrate_data.mjs 先看计划，加 --apply 执行）'
  );
}

function copyIfMissing(src, dst) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

function seedConfig() {
  // 数据根 = 代码根（老布局）时不需要播种，本来就是同一份
  if (path.resolve(DATA_ROOT) === path.resolve(CODE_ROOT)) return [];
  const srcDir = path.join(CODE_ROOT, 'config');
  const dstDir = DIRS.config;
  const seeded = [];
  if (!fs.existsSync(srcDir)) return seeded;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (name === 'backup' || name.startsWith('.')) continue;
    const src = path.join(srcDir, name);
    let st;
    try {
      st = fs.statSync(src);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // 目前只有 templates/；只播种缺失的文件，不覆盖用户改动
      if (name === 'templates') {
        try {
          for (const f of fs.readdirSync(src)) {
            if (copyIfMissing(path.join(src, f), path.join(dstDir, name, f))) seeded.push(`config/${name}/${f}`);
          }
        } catch {
          /* 播种失败不致命 */
        }
      }
      continue;
    }
    if (copyIfMissing(src, path.join(dstDir, name))) seeded.push(`config/${name}`);
  }
  return seeded;
}

/**
 * 首次运行准备：自建标准目录 + 从包里播种缺失的配置 + 写数据目录标记。幂等，可反复调用。
 * 已存在的文件一律不覆盖（配置一旦落到数据根就归用户所有）。
 */
export function ensureData() {
  const created = [];
  for (const dir of [DIRS.out, DIRS.logs, DIRS.cache, DIRS.config, DIRS.secrets, DIRS.runtime, DIRS.derived, DIRS.inbox]) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(path.relative(DATA_ROOT, dir).split(path.sep).join('/'));
      }
    } catch {
      /* 单目录失败不影响其它；真写不进去会在用的时候报错 */
    }
  }
  const seeded = seedConfig();
  try {
    const info = dataInfo();
    info.at = new Date().toISOString();
    info.schema = 1;
    fs.writeFileSync(MARKER, JSON.stringify(info, null, 2), 'utf8');
  } catch {
    /* 标记写不了不致命 */
  }
  warnLegacy();
  return { ...dataInfo(), created, seeded, marker: MARKER };
}

/**
 * 配置文件路径：数据根里已有就用数据根的；否则回落到包的默认配置（只读，不复制）。
 * 用于读配置，不会触发建目录。
 */
export function configFile(name) {
  const inData = path.join(DIRS.config, name);
  try {
    if (fs.existsSync(inData)) return inData;
  } catch {
    /* ignore */
  }
  const inCode = path.join(CODE_ROOT, 'config', name);
  try {
    if (fs.existsSync(inCode)) return inCode;
  } catch {
    /* ignore */
  }
  return inData;
}

/** 数据根下的路径 */
export const dataPath = (...p) => path.join(DATA_ROOT, ...p);
/** 代码根下的路径 */
export const codePath = (...p) => path.join(CODE_ROOT, ...p);

/** 一行式描述（日志/CLI 用） */
export function describe() {
  const i = dataInfo();
  return `data=${i.dataRoot} (${i.source}) code=${i.codeRoot}`;
}

warnLegacy();
