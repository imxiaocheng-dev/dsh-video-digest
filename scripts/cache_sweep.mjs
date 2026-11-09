#!/usr/bin/env node
// 缓存清理（v26）。
// 规则：只清 cache/video + cache/frames；out/ 里的宫格图（sheet*.png）与总结（summary*.json）永远不删。
// 用法：
//   node scripts/cache_sweep.mjs            # 按 config/storage.json 的 keepDays 清一遍（dry 先看）
//   node scripts/cache_sweep.mjs --dry      # 只显示占用与策略，不删
//   node scripts/cache_sweep.mjs --keep-days=3   # 临时覆盖保留天数
// 结果写 logs/cache-sweep.json（面板 /api/storage 会读它显示上次清理）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './lib/paths.mjs';
import { readStorage, sweep, usage } from './lib/cache.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const KD = (argv.find((a) => a.startsWith('--keep-days=')) || '').split('=')[1];

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const gb = (b) => (b / 1073741824).toFixed(2) + ' GB';
const cfg = readStorage();
if (KD != null && KD !== '') cfg.keepDays = Math.max(0, Math.min(365, Number(KD) || 0));

const u = usage();
console.log(`数据根：${DATA_ROOT}`);
console.log(`缓存视频 ${gb(u.videoBytes)} · 帧图 ${gb(u.framesBytes)} · 接口缓存 ${mb(u.apiBytes)} · 产物 out/ ${mb(u.outBytes)}`);
console.log(`策略：保留 ${cfg.keepDays} 天 · 跑完后 ${cfg.afterDone} · 每次跑完顺手扫 ${cfg.sweepOnDone ? '是' : '否'}`);
console.log('宫格图与总结永不自动删。');

if (DRY) {
  console.log('\n（--dry）不执行删除。去掉 --dry 才清。');
  process.exit(0);
}

const t0 = Date.now();
const r = sweep(cfg);
const out = { at: new Date().toISOString(), keepDays: cfg.keepDays, afterDone: cfg.afterDone, freed: r.freed, videos: r.videos, frames: r.frames, orphans: r.orphans, ms: Date.now() - t0, before: u };
try {
  fs.mkdirSync(path.join(DATA_ROOT, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(DATA_ROOT, 'logs', 'cache-sweep.json'), JSON.stringify(out, null, 1));
} catch {}
console.log(`\n清理完成：视频 ${r.videos} 个 / 帧目录 ${r.frames} 个 / 孤儿 ${r.orphans} 个，释放 ${gb(r.freed)}（${out.ms} ms）`);
