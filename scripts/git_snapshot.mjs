#!/usr/bin/env node
// v24 · git 快照 CLI（契约 G）
//
//   node scripts/git_snapshot.mjs                 # 默认版本：$VD_VERSION，再默认读 panel_server.mjs 的 PANEL_VERSION
//   node scripts/git_snapshot.mjs --version v26   # 手动给某个版本打快照（也可 --version=v26）
//   node scripts/git_snapshot.mjs --status        # 只读体检：仓库/最近 commit/tag/快照状态
//
// 说明：
//  - 面板（panel_server.mjs）加载时会自动调用同一份模块；这个 CLI 是"手动触发/排查"入口。
//  - 输出 JSON（方便脚本化），成功 exit 0，失败 exit 1。
//  - --status 不写任何东西。
import { readFileSync } from 'node:fs';
import {
  snapshotIfVersionChanged,
  gitSnapshotStatus,
  SNAPSHOT_STATE,
  SNAPSHOT_LOG,
} from './lib/git-snapshot.mjs';

const argv = process.argv.slice(2);

function has(flag) { return argv.includes(flag); }
function value(flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      return next && !next.startsWith('--') ? next : '';
    }
    if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1);
  }
  return '';
}

if (has('--help') || has('-h')) {
  console.log([
    '用法: node scripts/git_snapshot.mjs [--version v26] [--status]',
    '',
    '  --version <v>  要快照的版本号（默认 $VD_VERSION，再默认读 panel_server.mjs 的 PANEL_VERSION）',
    '  --status       只读体检，不改仓库',
    '  --help         这张帮助',
    '',
    `状态文件: ${SNAPSHOT_STATE}`,
    `失败日志: ${SNAPSHOT_LOG}`,
    '环境变量: VD_REPO 指定仓库根 · VD_GIT 指定 git.exe',
  ].join('\n'));
  process.exit(0);
}

if (has('--status')) {
  const st = gitSnapshotStatus();
  console.log(JSON.stringify(st, null, 2));
  process.exit(st && st.isRepo ? 0 : 1);
}

/* 版本号唯一真源是 panel_server.mjs 顶部的 PANEL_VERSION —— 这里直接读它，避免 CLI 与面板脱节 */
function panelVersion() {
  try {
    const src = readFileSync(new URL('./panel_server.mjs', import.meta.url), 'utf8');
    const m = /const PANEL_VERSION = '([^']+)'/.exec(src);
    return m ? m[1] : '';
  } catch { return ''; }
}
const version = value('--version') || String(process.env.VD_VERSION || '').trim() || panelVersion() || 'v26';

let result;
try {
  result = await snapshotIfVersionChanged(version);
} catch (e) {
  // snapshotIfVersionChanged 契约上不抛；真抛了说明模块坏了，照样给结构化输出
  result = { ok: false, version, reason: 'exception', error: String((e && (e.message || e)) || e) };
}
console.log(JSON.stringify(result, null, 2));
process.exit(result && result.ok === false ? 1 : 0);
