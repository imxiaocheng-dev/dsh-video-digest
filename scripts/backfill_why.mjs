#!/usr/bin/env node
// 补跑历史「判否说明」（v26）。
// 用法：
//   node scripts/backfill_why.mjs            # 干跑：列出会补哪些
//   node scripts/backfill_why.mjs --apply    # 真跑（串行调本地模型，约 4–7 秒/条）
//   --force   覆盖已有 why.local.json
//   --limit=N 只跑前 N 条
// 只会处理门禁判为 local-hold / skip 的条目；云端那两档永远不碰。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './lib/paths.mjs';
import { normalizeRoute, zhOf } from './lib/routes.mjs';
import { generateWhy } from './why.mjs';

const OUT = path.join(DATA_ROOT, 'out');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }

let dirs = [];
try { dirs = fs.readdirSync(OUT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {
  console.error('没有 out/ 目录：' + OUT);
  process.exit(1);
}

const todo = [];
for (const bv of dirs) {
  if (!/^BV[0-9A-Za-z]{6,14}$/.test(bv)) continue;
  const g = readJson(path.join(OUT, bv, 'gate.json'));
  if (!g) continue;
  const route = normalizeRoute(g.route);
  if (route !== 'local-hold' && route !== 'skip') continue;
  const fp = path.join(OUT, bv, 'why.local.json');
  const has = fs.existsSync(fp);
  const prev = has ? readJson(fp) : null;
  if (has && !FORCE && !(prev && prev.error)) continue; // 已有成功的就跳过；失败的自动重试
  todo.push({ bv, route, has: has && !!(prev && !prev.error) });
}
const list = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;

console.log(`数据根：${DATA_ROOT}`);
console.log(`待补：${list.length} 条（${APPLY ? '真跑' : '干跑'}${FORCE ? ' · 覆盖已有' : ''}）`);
const stat = { 'local-hold': 0, skip: 0 };
for (const t of list) stat[t.route] = (stat[t.route] || 0) + 1;
console.log('分布：' + Object.entries(stat).map(([k, v]) => `${zhOf(k)} ${v}`).join(' / '));
for (const t of list.slice(0, 40)) console.log(` · ${t.bv}  ${zhOf(t.route)}${t.has ? '（重试上次失败）' : ''}`);
if (list.length > 40) console.log(` … 另有 ${list.length - 40} 条`);

if (!APPLY) {
  console.log('\n干跑结束。真跑加 --apply（串行调本地模型，可随时中断，已生成的不会重做）。');
  process.exit(0);
}

let ok = 0, fail = 0, skipped = 0;
for (let i = 0; i < list.length; i++) {
  const t = list[i];
  process.stdout.write(`[${i + 1}/${list.length}] ${t.bv} … `);
  try {
    const rec = await generateWhy(t.bv, { force: FORCE });
    if (!rec) { skipped++; console.log('跳过（route 变了/无产物）'); continue; }
    if (rec.error) { fail++; console.log('失败：' + rec.error.zh); }
    else { ok++; console.log(`ok（${(rec.reasons || []).length} 条理由）`); }
  } catch (e) {
    fail++; console.log('异常：' + e.message);
  }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`\n完成：成功 ${ok} · 失败 ${fail} · 跳过 ${skipped}`);
console.log('失败条目会在面板显示原因，下次跑本脚本会自动重试。');
