// 会话模型（我）写正式总结 → out/<BV>/summary.cloud.json
// 用法：node scripts/summary_write.mjs <json文件>   或   echo '{...}' | node scripts/summary_write.mjs -
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DATA_ROOT } from './lib/paths.mjs';

// 数据目录：产物写这里（旧布局下就是包根，本机行为不变）
const ROOT = DATA_ROOT;
const OUT = path.join(ROOT, 'out');

const arg = process.argv[2];
if (!arg) { console.error('用法: node scripts/summary_write.mjs <json文件|->'); process.exit(2); }
const raw = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
let data;
try { data = JSON.parse(raw); } catch (e) { console.error('JSON 解析失败:', e.message); process.exit(2); }

const need = ['bv', 'gist', 'bullets', 'verdict'];
for (const k of need) if (!data[k] || (k === 'bullets' && !Array.isArray(data[k]))) { console.error('缺字段:', k); process.exit(2); }
if (!/^BV[0-9A-Za-z]{6,14}$/.test(data.bv)) { console.error('bv 不合法'); process.exit(2); }
if (String(data.gist).length > 240) { console.error('gist 太长（>240 字）'); process.exit(2); }
if (data.bullets.length > 6) { console.error('bullets 太多（>6 条）'); process.exit(2); }
for (const b of data.bullets) if (String(b).length > 120) { console.error('单条 bullet 太长（>120 字）'); process.exit(2); }

const dir = path.join(OUT, data.bv);
if (!fs.existsSync(dir)) { console.error('产物目录不存在（先跑 digest）:', dir); process.exit(2); }

const out = {
  at: new Date().toISOString(),
  source: 'cloud',
  model: data.model || 'deepseek-flash (session)',
  bv: data.bv,
  reviewed: true,
  gist: data.gist,
  bullets: data.bullets,
  mark: data.mark || null,
  verdict: data.verdict,
  caveat: data.caveat || null,
  evidence: Array.isArray(data.evidence) ? data.evidence.slice(0, 8) : [],
  persona: data.persona || null,
  note: data.note || '会话模型（云端）依据事实卡+清单+OCR+弹幕撰写，已复核，可对外引用'
};
const tmp = path.join(dir, '.summary.cloud.json.tmp');
fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
fs.renameSync(tmp, path.join(dir, 'summary.cloud.json'));
console.log('已写入 out/' + data.bv + '/summary.cloud.json  (' + out.gist.length + ' 字 gist · ' + out.bullets.length + ' 条要点)');
