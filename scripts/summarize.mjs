import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './lib/paths.mjs';

// 数据目录：产物/配置都走这里（旧布局下就是包根，本机行为不变）
const ROOT = DATA_ROOT;
const CFG = path.join(ROOT, 'config', 'summarize.json');
const args = process.argv.slice(2);

/* 配置：面板「个性化 → 总结来源」可改；CLI 参数优先 */
function readCfg() {
  const def = { mode: 'cloud', enabled: false, baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', apiKey: '' };
  try { return { ...def, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; } catch { return def; }
}
const cfg = readCfg();
const arg = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const BASE = arg('base', cfg.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = arg('model', cfg.model || 'qwen3:8b');
const APIKEY = arg('key', cfg.apiKey || '');
const BV = arg('bv', null);
const ALL = args.includes('--all');
const OPENAI = /\/v1(\/|$)/.test(BASE);

function readOut(bv) {
  const dir = path.join(ROOT, 'out', bv);
  const g = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  let cost = null; try { cost = JSON.parse(g('cost.json')); } catch {}
  return { bv, dir, manifest: g('manifest.txt'), ocr: g('ocr.txt'), danmaku: g('danmaku.txt'), cost };
}

/* 只把"可核实的观察"喂给本地模型，并要求它不许编造 */
function buildPrompt(o) {
  const lines = o.manifest.split('\n');
  const title = (lines.find(l => l.startsWith('# ')) || '').replace(/^#\s*/, '').replace(/\s*·\s*[\d:]+.*$/, '').trim();
  const cells = lines.filter(l => /^\d+\.\s*\[/.test(l)).slice(0, 16);
  const ocr = o.ocr.split('\n').filter(l => l.startsWith('[')).slice(0, 30);
  const dm = o.danmaku.split('\n').slice(0, 8);
  const minutes = (o.cost && o.cost.minutes) ? o.cost.minutes.toFixed(1) : '?';
  return `你是视频笔记助手。下面是一条 B 站视频我本地跑出来的客观数据。请只依据这些数据写中文笔记。

【硬规则】
1. 不许编造数据里没有的信息（不许猜剧情、不许编数字）。
2. 数据不足就直说"信息有限"，可以只给时长和画面文字的观察。
3. 输出必须是 JSON，不要 markdown 代码块。

【视频】${title}（${minutes} 分钟）
【每格清单（时间码 + 刀数 + 台词摘录）】
${cells.join('\n') || '(无)'}
【画面文字 OCR（时间码 + 识别到的字，可能含识别错误）】
${ocr.join('\n') || '(无)'}
【弹幕摘要】
${dm.join('\n') || '(无)'}

输出 JSON 结构：
{"gist":"2-3 句话的整体总结","bullets":["要点1","要点2","要点3"],"mark":"最值得看的时间码(如 02:10)，没有就空字符串","verdict":"值得看/一般/不建议整片看","caveat":"一句诚实的局限说明"}`;
}

/* 两种端点：ollama 原生 /api/generate，或 OpenAI 兼容 /v1/chat/completions */
async function callModel(prompt) {
  const t0 = Date.now();
  if (OPENAI) {
    const headers = { 'content-type': 'application/json' };
    if (APIKEY) headers['authorization'] = 'Bearer ' + APIKEY;
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    return { raw, eval_count: j?.usage?.completion_tokens || 0, prompt_eval_count: j?.usage?.prompt_tokens || 0, ms: Date.now() - t0, api: 'openai' };
  }
  const r = await fetch(BASE + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, format: 'json', think: false, options: { temperature: 0.3, num_predict: 500 } }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error('ollama HTTP ' + r.status);
  const j = await r.json();
  return { raw: j.response, eval_count: j.eval_count || 0, prompt_eval_count: j.prompt_eval_count || 0, ms: Math.round((j.total_duration || 0) / 1e6) || (Date.now() - t0), api: 'ollama' };
}

let bvs = [];
if (BV) bvs = [BV];
else if (ALL) {
  const dir = path.join(ROOT, 'out');
  bvs = fs.readdirSync(dir).filter(n => /^BV[0-9A-Za-z]+$/.test(n) && fs.existsSync(path.join(dir, n, 'manifest.txt'))).slice(-6);
} else {
  console.log('用法：node scripts/summarize.mjs --bv=BVxxx   或   --all');
  process.exit(2);
}

console.log(`本地总结 · 端点 ${BASE}（${OPENAI ? 'OpenAI 兼容' : 'ollama'}）· 模型 ${MODEL}`);
const results = [];
for (const bv of bvs) {
  const o = readOut(bv);
  if (!o.manifest) { console.log('跳过', bv, '没有产物'); continue; }
  const prompt = buildPrompt(o);
  try {
    const out = await callModel(prompt);
    let s = null;
    try { s = JSON.parse(out.raw); } catch { s = { gist: String(out.raw || '').slice(0, 200), bullets: [], mark: '', verdict: '', caveat: '模型返回非 JSON' }; }
    const rec = {
      at: new Date().toISOString(), model: MODEL, endpoint: BASE, api: out.api, bv, ...s,
      meta: { prompt_eval_count: out.prompt_eval_count, eval_count: out.eval_count, ms: out.ms },
    };
    fs.writeFileSync(path.join(o.dir, 'summary.json'), JSON.stringify(rec, null, 2));
    console.log(`[${bv}] ${rec.verdict || '?'} · ${rec.gist}`);
    if (rec.bullets && rec.bullets.length) rec.bullets.forEach(b => console.log('   - ' + b));
    results.push(rec);
  } catch (e) {
    console.log('[' + bv + '] 失败:', e.message);
  }
}
console.log('\nRESULTS ' + JSON.stringify({ model: MODEL, endpoint: BASE, count: results.length, items: results.map(r => ({ bv: r.bv, verdict: r.verdict, mark: r.mark })) }));
