// 一次性回填：把「点播源」的旧门禁结论改回直通（v39）
//
// 问题：v39 之前 gate.mjs 不知道 via，点播片（inbound / manual / panel / gray）也会被自动门禁
// 判成「一般般（local-hold）」或「没意思（skip）」，于是不写总结、不投递 —— 与「点播源直接跑然后出总结推送」
// 的约定相反。
//
// 本脚本只做一件事：对台账里 via 属于点播源的视频，若 out/<bv>/gate.json 的 route 不是花钱那两档
// （pass-final / pass-sampled），就按直通重写成 pass-final，理由保留「点播源直通（历史回填）」+ 原来的判据，
// 让它们重新进入「待写总结」队列（面板/执行器自己会捡）。
//
// 用法：
//   node scripts/gate_vod_fix.mjs            # 干跑：只列会改的
//   node scripts/gate_vod_fix.mjs --apply    # 真写 gate.json
//   node scripts/gate_vod_fix.mjs --apply --all   # 连「现在已经是 pass-final/pass-sampled」的也重算一遍
//
// 只动 out/<bv>/gate.json，不碰台账状态、不碰 why.local.json、不花钱。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './lib/paths.mjs';
import { DB, list as libList } from './lib/library.mjs';
import { isVodVia, normalizeRoute, zhOf } from './lib/routes.mjs';

const ROOT = DATA_ROOT;
const OUT = path.join(ROOT, 'out');
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}

const rows = libList([], 5000).filter(r => isVodVia(r.via));
const plan = [];
for (const r of rows) {
  const gp = path.join(OUT, r.bvid, 'gate.json');
  if (!fs.existsSync(gp)) continue;
  const g = readJson(gp, null);
  if (!g) continue;
  const route = normalizeRoute(g.route);
  const spend = route === 'pass-final' || route === 'pass-sampled';
  if (spend && !ALL) continue;
  plan.push({ bvid: r.bvid, title: r.title, via: r.via, old: route, gatePath: gp, g });
}

console.log(`数据根：${ROOT}`);
console.log(`点播源视频 ${rows.length} 条；需要回填 ${plan.length} 条${ALL ? '（--all：含已直通的也重写）' : ''}`);
for (const p of plan.slice(0, 40)) {
  console.log(`  ${p.bvid}  ${String(p.via).padEnd(8)} ${p.old} → pass-final  ${String(p.title || '').slice(0, 40)}`);
}
if (plan.length > 40) console.log(`  … 还有 ${plan.length - 40} 条`);

if (!APPLY) {
  console.log('\n干跑结束。加 --apply 才会真写 gate.json。');
  process.exit(0);
}

let wrote = 0;
for (const p of plan) {
  const oldReasons = Array.isArray(p.g.reasons) ? p.g.reasons : [];
  const next = {
    ...p.g,
    at: new Date().toISOString(),
    route: 'pass-final',
    routeZh: zhOf('pass-final'),
    score: 1,
    vod: true,
    via: p.via,
    reasons: ['点播源直通（历史回填 v39）', ...oldReasons.filter(x => !/点播源直通/.test(x))],
  };
  fs.writeFileSync(p.gatePath, JSON.stringify(next, null, 2));
  wrote += 1;
}
console.log(`\n已重写 ${wrote} 条 gate.json（点播源直通）。下一步：面板「队列 → 待写」或等执行器自己捡；这些片子不再走判否说明。`);
console.log(`台账：${DB}`);
