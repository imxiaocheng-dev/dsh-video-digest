#!/usr/bin/env node
// 本地「判否说明」生成器（v26）。
// 只处理门禁判为 local-hold（一般般）/ skip（没意思）的视频：
// 用本地端点（默认 ollama，127.0.0.1:11434 / qwen3:8b）解释「为什么没进云端总结」。
// 云端链路（推荐看/可以看）绝不调用这里；调用方是 runner.mjs（gate 判完之后）与面板「重试」。
//
// 用法：
//   node scripts/why.mjs --bv=BV1xx411c7mD [--force] [--dry]
// 产物：out/<bv>/why.local.json
//   { at, bv, route, routeZh, model, endpoint, personaKey, ms, tokens,
//     reasons:[{zh,evidence,verified}], couldBe:[], material:{...}, error?:{code,zh,message} }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_ROOT, CODE_ROOT, configFile, ensureData } from './lib/paths.mjs';
import { normalizeRoute, zhOf } from './lib/routes.mjs';
import { readPersona, personaKey, personaPromptBlock } from './lib/persona-text.mjs';
import { whyRulesText } from './lib/templates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DATA_ROOT, 'out');
const WHY_STATES = new Set(['local-hold', 'skip']);

const ERR_ZH = {
  'ollama-unreachable': (o) => `连不上本地模型端点（${o.baseUrl}），先确认 ollama 在跑`,
  'model-not-found': (o) => `端点里没有模型 ${o.model}（ollama pull ${o.model}）`,
  timeout: () => '本地模型超时（>180 秒），这条先跳过',
  'bad-json': () => '模型没返回可解析的 JSON，这条先跳过',
  empty: () => '模型返回空内容，这条先跳过',
  'no-material': () => '产物里没有可读材料（manifest/factcard 缺）',
};

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.mkdirSync(path.join(DATA_ROOT, 'logs'), { recursive: true }); fs.appendFileSync(path.join(DATA_ROOT, 'logs', 'why.log'), line + '\n'); } catch {}
  console.log(line);
}

function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }
function readText(fp) { try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; } }

function readLocalCfg() {
  const cfg = readJson(configFile('summarize.json')) || {};
  const baseUrl = String(cfg.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = String(cfg.model || 'qwen3:8b');
  const apiKey = String(cfg.apiKey || '');
  const openai = /\/v1(\/|$)/.test(baseUrl);
  return { baseUrl, model, apiKey, openai };
}

function materialText(mf, fc) {
  const d = (fc && fc.duration) || 0;
  const dm = (fc && fc.danmaku) || {};
  const head = [
    `时长 ${d} 秒（${Math.round(d / 6) / 10} 分钟）`,
    `宫格 ${(fc && fc.cells) || 0} 格，其中有画面文字的格 ${(fc && fc.cellsWithText) || 0}`,
    `信息密度 ${fc && fc.infoDensity}，画面文字 ${(fc && fc.ocrLines) || 0} 行`,
    `弹幕 ${dm.total || 0} 条（有效 ${dm.kept || 0} / 争议 ${dm.disputes || 0} / 信息 ${dm.infos || 0} / 疑问 ${dm.questions || 0}）`,
    `事实条目 ${((fc && fc.facts) || []).length} 条`,
  ].join('\n');
  const facts = (((fc && fc.facts) || []).slice(0, 8)).map((x) => '· ' + x).join('\n');
  return { head, facts, manifest: String(mf || '').slice(0, 12000) };
}

function stripFence(s) {
  return String(s || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
}

function parseModelJson(s) {
  const t = stripFence(s);
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
}

async function callLocal(prompt, cfg) {
  const t0 = Date.now();
  const timeout = 180000;
  if (!cfg.openai) {
    const url = cfg.baseUrl + '/api/generate';
    let res;
    try {
      res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt, stream: false, format: 'json', think: false, options: { temperature: 0.2, num_predict: 420 } }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw Object.assign(new Error(String(e.message || e)), { code: /abort|timeout/i.test(String(e)) ? 'timeout' : 'ollama-unreachable' });
    }
    if (res.status === 404) throw Object.assign(new Error('model not found'), { code: 'model-not-found' });
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { code: 'ollama-unreachable' });
    const j = await res.json();
    return { text: j.response || '', endpoint: 'ollama', ms: Date.now() - t0, tokens: { prompt: j.prompt_eval_count || 0, eval: j.eval_count || 0 } };
  }
  const url = cfg.baseUrl + '/chat/completions';
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: cfg.model, temperature: 0.2, max_tokens: 420, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw Object.assign(new Error(String(e.message || e)), { code: /abort|timeout/i.test(String(e)) ? 'timeout' : 'ollama-unreachable' });
  }
  if (res.status === 404) throw Object.assign(new Error('model not found'), { code: 'model-not-found' });
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { code: 'ollama-unreachable' });
  const j = await res.json();
  const u = j.usage || {};
  return { text: j.choices?.[0]?.message?.content || '', endpoint: 'openai', ms: Date.now() - t0, tokens: { prompt: u.prompt_tokens || 0, eval: u.completion_tokens || 0 } };
}

function ruleWhy(fc, route) {
  const d = (fc && fc.duration) || 0;
  const cells = (fc && fc.cellsWithText) || 0;
  const reasons = [];
  if (d < 20) reasons.push({ zh: `这条只有 ${d} 秒，几乎没有可解释的内容`, evidence: `时长 ${d} 秒` });
  if (cells < 3) reasons.push({ zh: `宫格里只有 ${cells} 格能读到台词，没有可核实的细节`, evidence: `有台词格 ${cells}/${(fc && fc.cells) || 0}` });
  if (!reasons.length) reasons.push({ zh: '材料量太低，规则判定不值得展开解释', evidence: '门禁规则' });
  return {
    reasons,
    couldBe: ['如果是某个系列里的一集，补上下文后可能值得看'],
    rule: true,
  };
}

/** 生成一条判否说明。返回写盘后的对象；不抛（失败写 error 字段）。 */
export async function generateWhy(bv, opts = {}) {
  const { force = false, dry = false } = opts;
  ensureData();
  const dir = path.join(OUT, bv);
  const rec = { at: new Date().toISOString(), bv };
  if (!fs.existsSync(dir)) { log(`skip ${bv}: 没有产物目录`); return null; }
  const gate = readJson(path.join(dir, 'gate.json'));
  if (!gate) { log(`skip ${bv}: 没有 gate.json`); return null; }
  const route = normalizeRoute(gate.route);
  rec.route = route; rec.routeZh = zhOf(route);
  if (!WHY_STATES.has(route)) { if (!dry) log(`skip ${bv}: route=${route} 不在判否名单`); return null; }
  const fp = path.join(dir, 'why.local.json');
  if (!force && !dry && fs.existsSync(fp)) { log(`skip ${bv}: 已有 why.local.json（--force 覆盖）`); return readJson(fp); }

  const mf = readText(path.join(dir, 'manifest.txt'));
  const fc = readJson(path.join(dir, 'factcard.json'));
  const persona = readPersona();
  rec.personaKey = personaKey(persona);
  rec.material = {
    duration: (fc && fc.duration) || 0, cells: (fc && fc.cells) || 0,
    cellsWithText: (fc && fc.cellsWithText) || 0, ocrLines: (fc && fc.ocrLines) || 0,
    infoDensity: fc && fc.infoDensity, facts: ((fc && fc.facts) || []).length,
    danmaku: (fc && fc.danmaku) || null,
  };
  if (!mf && !fc) {
    rec.error = { code: 'no-material', zh: ERR_ZH['no-material']() };
    if (!dry) fs.writeFileSync(fp, JSON.stringify(rec, null, 1));
    log(`fail ${bv}: no-material`);
    return rec;
  }

  /* 材料侧事实（代码算出来的，不经过模型 —— 用来锚住"为什么"的客观部分） */
  {
    const d = rec.material.duration || 0;
    const mm = Math.floor(d / 60), ss = Math.round(d % 60);
    const dm = rec.material.danmaku || {};
    rec.derived = [
      `全片 ${mm > 0 ? mm + ' 分 ' : ''}${ss} 秒，${rec.material.cells} 格里只有 ${rec.material.cellsWithText} 格有画面文字`,
      `画面文字 ${rec.material.ocrLines} 行、事实条目 ${rec.material.facts} 条、信息密度 ${rec.material.infoDensity}`,
      `弹幕 ${dm.total || 0} 条（有效 ${dm.kept || 0}），争议 ${dm.disputes || 0} / 信息 ${dm.infos || 0} / 疑问 ${dm.questions || 0}`,
    ];
  }

  // 太短的废片（<20 秒）：规则直接写，不浪费模型调用。
  // 注意：cellsWithText 只数「画面文字(OCR)」的格，很多口播片 OCR 少但有台词，仍交给模型解释。
  if (rec.material.duration < 20) {
    Object.assign(rec, ruleWhy(fc, route));
    if (!dry) fs.writeFileSync(fp, JSON.stringify(rec, null, 1));
    log(`ok ${bv}: rule-based（${route}，材料过少）`);
    return rec;
  }

  const cfg = readLocalCfg();
  rec.model = cfg.model; rec.endpoint = cfg.openai ? 'openai' : 'ollama';
  const M = materialText(mf, fc);
  const prompt = [
    '你是视频流水线里的「判否解释员」。下面这条视频已经被门禁判为「不进云端总结」，你的任务是解释为什么。',
    '',
    '## 门禁结论（既成事实，不许推翻）',
    `route=${route}（${zhOf(route)}）；门禁判据：${((gate.reasons) || []).join('；') || '无'}`,
    '',
    '## 材料',
    M.head,
    M.facts ? '\n事实条目：\n' + M.facts : '',
    '',
    '## 逐格清单（manifest）',
    M.manifest,
    '',
    '写作要求（必须遵守）：',
    '1. 不许重新判断「值不值得看」，不许给 verdict；你只解释「为什么没进云端总结」。',
    '2. 每条理由必须指向具体材料：格号（如「第4格」）、画面原文、或弹幕里的具体说法；不许只复述门禁判据（「密度低」四个字不算理由）。',
    '3. 只写材料里有的；数字与型号必须能在材料里找到。',
    '4. 最多 3 条，每条 ≤60 字，中文。',
    '5. 严格输出 JSON：{"reasons":[{"zh":"理由","evidence":"材料里的原话或格号"}],"couldBe":["什么情况下可能值得看，最多1条"]}',
    '',
    whyRulesText(personaPromptBlock(persona)),
  ].join('\n');

  try {
    const r = await callLocal(prompt, cfg);
    rec.ms = r.ms; rec.tokens = r.tokens; rec.endpoint = r.endpoint;
    const j = parseModelJson(r.text);
    if (!j || !Array.isArray(j.reasons) || !j.reasons.length) throw Object.assign(new Error('bad json'), { code: 'bad-json' });
    const hay = (M.head + '\n' + M.facts + '\n' + M.manifest + '\n' + JSON.stringify(fc || {})).replace(/\s+/g, '');
    /* 证据校验：把 evidence 切成若干片段，要求每段都能在材料里找到（复合引用如「第4格 时长559秒」也能过）。 */
    const cellRefOk = (s) => {
      const m = /^第?\s*(\d+)\s*格$/.exec(String(s).trim());
      if (!m) return null;
      return new RegExp('(^|\\n)' + m[1] + '\\. \\[').test(M.manifest);
    };
    const verifyEv = (ev) => {
      const s = String(ev || '').replace(/\s+/g, '').trim();
      if (!s) return { ok: false, miss: [''] };
      const direct = cellRefOk(s);
      if (direct != null) return { ok: direct, miss: direct ? [] : [s] };
      /* evidence 里只要提到真实存在的格号，就认为证据成立（「第4格的台词」「第4格 00:12」都算） */
      const cm = /第?\s*(\d+)\s*格/.exec(s);
      if (cm && cellRefOk('第' + cm[1] + '格')) return { ok: true, miss: [] };
      const chunks = s.split(/[，,、；;：:。.！!？?（）()「」【】\-—~～/]+/).filter((c) => c.length >= 2);
      if (!chunks.length) return { ok: false, miss: [s] };
      const miss = chunks.filter((c) => { const r = cellRefOk(c); return r == null ? !hay.includes(c) : !r; });
      return { ok: miss.length === 0, miss };
    };
    rec.reasons = j.reasons.slice(0, 3).map((x) => {
      const zh = String((x && x.zh) || '').trim().slice(0, 120);
      let rawEv = String((x && x.evidence) || '').trim();
      /* 模型常把 evidence 留空或写「无」：退而从理由里提到的格号还原证据 */
      if (!rawEv || /^(无|没有|暂无|n\/a|-|—)$/i.test(rawEv)) {
        const m = /第?\s*(\d+)\s*格/.exec(zh);
        if (m) rawEv = '第' + m[1] + '格';
      }
      const v = verifyEv(rawEv);
      return { zh, evidence: v.ok ? String(rawEv).replace(/\s+/g, '') : '', verified: v.ok, evidenceRaw: v.ok ? '' : String(rawEv).slice(0, 80) };
    }).filter((x) => x.zh);
    if (!rec.reasons.length) throw Object.assign(new Error('no usable reasons'), { code: 'bad-json' });
    rec.couldBe = (Array.isArray(j.couldBe) ? j.couldBe : []).slice(0, 2).map((s) => String(s).trim().slice(0, 60)).filter(Boolean);
    if (!dry) fs.writeFileSync(fp, JSON.stringify(rec, null, 1));
    log(`ok ${bv}: ${route} ${rec.reasons.length} 条理由 (${r.endpoint}/${cfg.model}, ${r.ms}ms)`);
  } catch (e) {
    rec.error = { code: e.code || 'http', zh: (ERR_ZH[e.code] || (() => '本地模型调用失败'))({ baseUrl: cfg.baseUrl, model: cfg.model }), message: String(e.message || e) };
    if (!dry) fs.writeFileSync(fp, JSON.stringify(rec, null, 1));
    log(`fail ${bv}: ${rec.error.code} ${rec.error.message}（已写 error 字段，不影响队列）`);
  }
  return rec;
}

/* ---------- CLI ---------- */
const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const bv = ((argv.find((a) => a.startsWith('--bv=')) || '').split('=')[1] || '').trim();
  if (!/^BV[0-9A-Za-z]{6,14}$/.test(bv)) { console.error('用法：node scripts/why.mjs --bv=BVxxxxxxxxxx [--force] [--dry]'); process.exit(2); }
  const rec = await generateWhy(bv, { force: argv.includes('--force'), dry: argv.includes('--dry') });
  if (!rec) { console.log(`没有生成（route 不在判否名单，或产物缺失）：${bv}`); process.exit(0); }
  if (rec.error) { console.log(`生成失败（已记录原因）：${rec.error.zh}`); process.exit(0); }
  console.log('判否说明：');
  for (const r of rec.reasons || []) console.log(' · ' + r.zh + (r.evidence ? `（证据：${r.evidence}）` : ''));
  if ((rec.couldBe || []).length) console.log(' 可能有价值如果：' + rec.couldBe.join('；'));
}
