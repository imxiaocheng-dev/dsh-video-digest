// 人设「实时样例」生成器（v30）
//
// 背景：v26–v29 的面板预览只是把「它会读到的规则」贴出来，用户看到的是一堆提示词，
// 所以永远显得生硬、而且改了「表达格式」只改到规则文本，样例一个字都不动。
// v30 起预览改成**真跑一次本地模型**：用与正式生成同一套 prompt（模板规则 + 人设语气块 +
// 表达格式六旋钮），对一条内置样例（或指定 bvid 的真实产物）现写一份，让你直接看到成品口吻。
//
// 设计约束：
//  - 只读：不写 config、不写 out、不碰台账；失败一定返回结构化 error，不抛。
//  - 便宜：样例材料固定，一次 500 token 上下；ollama 不可用时回退到「规则拼装版」并标明。
//  - 一致：人设与格式每次都从磁盘现读（改完面板立刻生效，不用重启）。

import fs from 'node:fs';
import path from 'node:path';
import { configFile, dataPath, DATA_ROOT } from './paths.mjs?v=36';
import { readPersona, personaPromptBlock, personaGenKey , enforceParticles, particleWhitelist, readShape, lengthContract, personaTails, formatInfo, resolveStructure, withStructure } from './persona-text.mjs?v=56';
import { summaryRulesText } from './templates.mjs?v=54';
import { buildDm, withTail } from './copy.mjs?v=56';
import { materialBrief } from './material.mjs?v=54';
import { dmJsonContract } from './dm-json.mjs?v=5';

/** 内置样例：一条「把旧笔记本装上系统」的短视频。事实层写死，保证每次预览只变口吻不变事实。 */
export const SAMPLE = {
  bv: 'BV1xx411c7mD',
  title: '5 分 43 秒把旧笔记本装上系统',
  dur: '05:43',
  seconds: 343,
  up: '演示样例',
  /* v50：逐段 demo（时间码 + 这一段在讲什么 + 画面上的字）；正式预览优先用真实产物 */
  cells: [],
  cellIndex: [
    { from: 0, to: 56, index: '先说要装的是哪台旧笔记本', ocr: '旧笔记本 · 4G 内存 · 装系统前先备份' },
    { from: 56, to: 136, index: '下载微软官方媒体创建工具', ocr: 'Media Creation Tool（微软官方）' },
    { from: 136, to: 196, index: '插上 U 盘，提醒这一步会清空', ocr: '制作过程会清空 U 盘，先备份' },
    { from: 196, to: 343, index: '装完进桌面，全程没跳步', ocr: 'Windows 已就绪' },
  ],
  mark: '02:56',
  facts: [
    '02:16 用微软官方媒体创建工具做系统 U 盘，不用 PE 镜像站',
    '03:16 提醒这一步会把 U 盘清空，先备份',
    '准备一个 ≥16G 的 U 盘就够',
    '整条流程 5 分 43 秒走完，中间没有跳步',
  ],
  /* 只给数量、不给原文：模型容易把「观众说…」编出来，提示里明确禁止 */
  danmaku: { total: 6, kept: 6, disputes: 2, infos: 1, questions: 1, hasText: false },
  ocrLines: 3,
  gist: '不用 PE，改用微软官方工具做干净 U 盘。',
  bullets: ['用微软官方的媒体创建工具做系统 U 盘，而不是网上那些 PE 镜像站。', '准备一个 ≥16G 的 U 盘，制作过程会清空资料。'],
  verdict: '值得看',
  caveat: '未复测官网入口位置。',
};

/** 读本地模型配置（与 scripts/why.mjs、scripts/summarize.mjs 同一份 config/summarize.json） */
export function readLocalCfg() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configFile('summarize.json'), 'utf8')) || {}; } catch (e) { cfg = {}; }
  const baseUrl = String(cfg.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = String(cfg.model || 'qwen3:8b');
  const apiKey = String(cfg.apiKey || '');
  return { baseUrl, model, apiKey, openai: /\/v1(\/|$)/.test(baseUrl) };
}

/** 默认素材：最近一条「已投递」的归档视频——有 summary.cloud.json 且最新写入的那一条。 */
export function pickRecentDelivered() {
  const outDir = dataPath('out');
  let best = null;
  try {
    for (const name of fs.readdirSync(outDir)) {
      if (!/^BV[0-9A-Za-z]{10}$/.test(name)) continue;
      let st = null;
      try { st = fs.statSync(path.join(outDir, name, 'summary.cloud.json')); } catch (e) { continue; }
      if (!st || st.size < 50) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { bv: name, mtimeMs: st.mtimeMs };
    }
  } catch (e) {}
  return best ? best.bv : '';
}

/** 优先用指定 bvid 的真实产物当材料（factcard + 云端总结）；不给 bv 就用「最近已投递」那条；都没有才退回内置样例 */
export function sampleMaterial(bv) {
  let raw = String(bv || '').trim();
  if (!raw || raw === 'recent') raw = pickRecentDelivered();
  const b = /^BV[0-9A-Za-z]{10}$/.test(raw) ? raw : '';
  if (!b) return { facts: SAMPLE, real: false };
  const dir = dataPath('out', b);
  let fc = null, sm = null;
  try { fc = JSON.parse(fs.readFileSync(path.join(dir, 'factcard.json'), 'utf8')); } catch (e) { fc = null; }
  try { sm = JSON.parse(fs.readFileSync(path.join(dir, 'summary.cloud.json'), 'utf8')); } catch (e) { sm = null; }
  if (!fc && !sm) return { facts: SAMPLE, real: false };
  const sec = Number(fc && fc.duration) || 0;
  const dur = sec > 0 ? String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0') : SAMPLE.dur;
  return {
    real: true,
    facts: {
      ...SAMPLE,
      bv: b,
      title: (fc && fc.title) || SAMPLE.title,
      dur,
      duration: sec || SAMPLE.seconds,
      up: (fc && fc.up) || SAMPLE.up,
      /* v50：逐段材料（时间码 + 台词 + 画面文字）改由 material.mjs 统一渲染 */
      cells: (fc && Array.isArray(fc.cellIndex)) ? fc.cellIndex : [],
      cellIndex: (fc && Array.isArray(fc.cellIndex)) ? fc.cellIndex : [],
      signals: (fc && fc.signals) || null,
      facts: (fc && Array.isArray(fc.facts) && fc.facts.length) ? fc.facts.slice(0, 6) : SAMPLE.facts,
      danmaku: (fc && fc.danmaku) || SAMPLE.danmaku,
      ocrLines: (fc && fc.ocrLines) || SAMPLE.ocrLines,
      gist: (sm && sm.gist) || SAMPLE.gist,
      bullets: (sm && Array.isArray(sm.bullets) && sm.bullets.length) ? sm.bullets : SAMPLE.bullets,
      verdict: (sm && sm.verdict) || SAMPLE.verdict,
      caveat: (sm && sm.caveat) || SAMPLE.caveat,
      mark: (sm && sm.mark) || SAMPLE.mark,
    },
  };
}

/* v50：材料统一走 material.mjs 的 brief（时间码逐段 + 事实 + 弹幕），不再出现「宫格 N 格」这类内部口径 */
function materialBlock(f) {
  const brief = materialBrief({
    bv: f.bv,
    title: f.title,
    up: f.up,
    duration: f.duration,
    dur: f.dur,
    cellIndex: (Array.isArray(f.cells) && f.cells.length) ? f.cells : (Array.isArray(f.cellIndex) ? f.cellIndex : []),
    facts: (f.facts || []).map((x) => (typeof x === 'string' ? { text: x } : x)),
    danmaku: f.danmaku,
    signals: f.signals,
  });
  return [
    brief,
    '',
    `门禁结论（既成事实，不许推翻）：${f.verdict || '值得看'}；重点 ${f.mark}。`,
    '**没有弹幕原文，不许编「观众说……」的具体说法**',
  ].join('\n');
}

/* 三种样例统一追加：不要抬头 / 不要编号清单 / 不要总结腔 / BV 号最后。 */
const SHAPE_RULES = [
  '## 形态',
  '- 开头直接说人话，**不要**出现【标题】【时长】这类抬头，也不要在开头堆「值得看 / 13:56」这种标签式的词。',
  '- **不要**用「1. 2. 3.」编号清单，也不要小标题、不要 Markdown 加粗；用自然句子把话说清楚。',
  '- 评价（我的看法）放在正文后半段，用一句自然的判断，不要单独立个「结论：」标题。',
  '- 最后面单独起一行写 BV 号（原文照抄，不要加「BV 号：」前缀）。',
].join('\n');

/* system 段只放稳定规则（可吃提示词缓存），user 段放本次材料。
   本地 8B 仍然用两段拼起来的单串（ollama 的 prompt 只有一段）。 */
export function buildSampleParts(target, facts, p, shape = null, opts = {}) {
  const sh = shape || (typeof readShape === 'function' ? readShape() : null);
  /* C-EXTRA-2：推送账号名由后端传入（/api/persona/preview 的 targetName），评论开头直接 @ 它 */
  const o = opts && typeof opts === 'object' ? opts : (opts ? { targetName: String(opts) } : {});
  const targetName = String(o.targetName || (sh && sh.targetName) || '').trim();
  /* v56：结构 auto 先解析成具体一档（tech / teardown），prompt 里给的是真要写的那档，不是「自动」 */
  const info0 = formatInfo(p, sh || undefined);
  const st = resolveStructure(info0.structure, String((facts && facts.title) || ''), '');
  const pp = withStructure(p, st);
  const block = personaPromptBlock(pp, sh || undefined);
  const summaryMax = Number(sh && sh.summaryMax) || 900;
  const mat = materialBlock(facts);
  const HARD = [
    '## 铁律（比口吻优先）',
    '- 只能写下面这条视频里出现的内容；没出现的型号、接口、配件、温度、电压、功率、时间码，一个都不许出现。',
    '- 数字与型号逐字照材料写：不换算、不四舍五入、不补单位、不补型号尾号。材料里是「家用电二百二百五顶天了」这种口播原话，就不能自己写成「220V / 两千多瓦」或「3000W 除以 220V」推出来的电流。',
    '- 人设语气示例 / 对照句只示范「语气词与句子节奏」；它们说到的事件、型号、配件，以及「偷懒 / 水 / 不值」这类判断，都属于**别的视频**，这一条一个都不许搬。',
    '- 门禁结论已经定了（见最后一行），不要重新判断值不值得看，只按它写。',
    '- 第一句先回答「这条视频讲的是什么」：点出领域/类型（科普、评测、资讯、教程…）+ 在讲哪个对象 + 想说明什么结论，让没看过的人不用猜；标题里的口号、比喻、书名号不能直接当主题（标题叫《压缩即理解》，不能写「讲的是『压缩即理解』」）。',
    '- 态度与理由必须一致：说「值得看/还行」配一个具体优点，说「水/不值」指出具体一处，不要既夸又说水。',
    '- 评价要狠但有据：缺点必须能指到片子里的具体东西（某处在念参数、时长与信息量不匹配、某步没解释），指不出来就老实写「没看出明显问题」，不许为了显得犀利硬扣帽子。',
    '- 正文里不许出现「第N格」「格号」「宫格」「事实卡」「材料」「资料」「OCR」「台词摘录」这类内部说法；要指位置只用 [MM:SS]。',
    '- 不许写我们是怎么看这条片的（画面文字 / 台词 / 字幕 / OCR / 转录 / 材料 / 素材 / 样本 / 核对）；观众反应只在有弹幕原文时写。',
  ].join('\n');
  /* system 段：只放「稳定的写作规则」，同一个人设/格式下逐字不变 → 云端可缓存 */
  const commentMax = Number(sh && sh.commentMax) || 40;
  const dmMax = Number(sh && sh.dmMax) || 860;
  /* v55：私信「结构化 JSON」通路 —— 与正式投递共用 dm-json.mjs 的契约，
     预览时先按字段生成，再由 buildDm 渲染成真正会发出去的那条私信。 */
  if (target === 'dm' && o.json === true) {
    const c = dmJsonContract(sh, { targetName });
    return {
      json: true,
      system: [block, '', HARD, '', c.system].join('\n'),
      user: [mat, '', c.tail()].join('\n'),
      summaryMax, commentMax, dmMax,
      /* 字段之和（gist 240 + 6×120 + take 200 + 其余）≈ 1100 字，中文 1 字≈1.4 token */
      maxTokens: 1800,
    };
  }
  let system;
  let user;
  if (target === 'summary') {
    system = [summaryRulesText(block), '', HARD, '', SHAPE_RULES].join('\n');
    user = [
      '## 这次要总结的视频（下面每一行都来自这条视频本身）',
      mat,
      '',
      `篇幅（面板「投递形态 → 总结字数」设定，改完下一次就按新值写）：`,
      lengthContract('summary', summaryMax),
      `现在直接写出这一条总结的正文（中文，纯文本，不要 JSON、不要小标题、不要复述规则、不要说明你在做什么），最后一行写 ${facts.bv}：`,
    ].join('\n');
  } else if (target === 'comment') {
    system = [
      block,
      '',
      '## 你要写的是一条**评论区**回复（公开场合，短）',
      '',
      HARD,
      '',
      SHAPE_RULES,
      '',
      targetName
        ? `要求：开头必须写 @${targetName}（推送账号名，照抄这个账号名，不要写别人的名字）；人设语气只在句尾点一下，不要堆语气词；不要出现【】抬头、不要写「本视频 / 该视频 / 值得一看」。`
        : `要求：开头 @ 对方；人设语气只在句尾点一下，不要堆语气词；不要出现【】抬头、不要写「本视频 / 该视频 / 值得一看」。`,
      lengthContract('comment', commentMax),
    ].join('\n');
    user = [mat, '', '只输出这一条评论本身（评论里不用写 BV 号，是回流到同一楼层里的）。'].join('\n');
  } else {
    system = [
      block,
      '',
      '## 你要写的是一条**私信**（发给推送账号，比评论长一点）',
      '',
      HARD,
      '',
      SHAPE_RULES,
      '',
      `要求：第一句就说清这条视频讲了什么（自然句，不要抬头）；中间 1–2 个关键点（带时间码）；然后一句评价与代价；人设语气自然，最多一处口头禅。`,
      lengthContract('dm', dmMax),
    ].join('\n');
    user = [mat, '', `只输出私信正文，最后一行写 ${facts.bv}。`].join('\n');
  }
  return {
    system, user,
    summaryMax, commentMax, dmMax,
    /* v37：输出上限按各自字数上限换算（中文 1 字≈1.4 token，再留 1.5 倍余量） */
    maxTokens: target === 'comment' ? clampTok(commentMax * 3, 120, 900)
      : target === 'dm' ? clampTok(dmMax * 2, 300, 2000)
        : clampTok(summaryMax * 2, 200, 2600),
  };
}
function clampTok(n, lo, hi) { const v = Math.round(Number(n) || 0); return Math.min(hi, Math.max(lo, v)); }

/** 本地 8B（ollama / OpenAI 兼容）用：两段拼成单串即可（它没有独立的 system 通道） */
export function buildSamplePrompt(target, facts, p, shape = null, opts = {}) {
  const parts = buildSampleParts(target, facts, p, shape, opts);
  return parts.system + '\n\n' + parts.user;
}

async function callLocal(prompt, cfg) {
  const t0 = Date.now();
  const timeout = 120000;
  const body = cfg.openai
    ? { model: cfg.model, temperature: 0.35, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }
    : { model: cfg.model, prompt, stream: false, think: false, options: { temperature: 0.35, num_predict: 700 } };
  const url = cfg.openai ? cfg.baseUrl + '/chat/completions' : cfg.baseUrl + '/api/generate';
  const headers = { 'content-type': 'application/json' };
  if (cfg.openai && cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw Object.assign(new Error(String((e && e.message) || e)), { code: /abort|timeout/i.test(String(e)) ? 'timeout' : 'ollama-unreachable' });
  }
  if (res.status === 404) throw Object.assign(new Error('model not found'), { code: 'model-not-found' });
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { code: 'ollama-unreachable' });
  const j = await res.json();
  const text = cfg.openai
    ? String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
    : String(j.response || '');
  const toks = cfg.openai
    ? { prompt: (j.usage && j.usage.prompt_tokens) || 0, eval: (j.usage && j.usage.completion_tokens) || 0 }
    : { prompt: j.prompt_eval_count || 0, eval: j.eval_count || 0 };
  return { text, endpoint: cfg.openai ? 'openai' : 'ollama', ms: Date.now() - t0, tokens: toks };
}

const ERR_ZH = {
  'ollama-unreachable': '连不上本地模型（' + '检查 ollama 是否在跑，或「总结来源」里的地址）',
  'model-not-found': '本地没有这个模型（换一个已下载的模型）',
  timeout: '本地模型超时（模型太大或机器忙）',
  'empty': '模型返回空内容（换小一点的问题再试）',
};

/** 模型不可用时的「规则拼装版」：至少让用户看到格式长什么样，明确标注不是模型输出 */
function fallbackText(target, f, p, opts = {}) {
  const w = (p && p.preset) || {};
  /* v52：预览=投递 —— 句末语气词与表情都走 personaTails，免得预览里看到的和真发出去的不一样 */
  const { tail, emoji } = personaTails(p || { preset: null });
  if (target === 'comment') {
    /* v53：规则拼装版也不许带取证腔（画面写着 / 台词里说 / 来自画面文字…） */
    const rawCore = f.gist.replace(/^不用/, '不用') + '，重点 ' + f.mark;
    const core = String(rawCore)
      .replace(/^\s*(?:画面(?:文字|上)?(?:写|标|显示)(?:着|的是)?|台词(?:里|中)?(?:说|讲|写)(?:着|的是)?)[：:，,]?\s*/, '')
      .replace(/(?:来自|根据|据)(?:画面文字|台词|字幕|OCR|转录|转写)/g, '')
      .replace(/画面(?:文字|上)?(?:写|标|显示)(?:着|的是)?/g, '')
      .replace(/台词(?:里|中)?(?:说|讲|写)(?:着|的是)?/g, '');
    /* C-EXTRA-2：有推送账号名就 @ 它，没有则回退到人设卡里的「怎么叫我」 */
    const at = opts.targetName ? '@' + opts.targetName + ' ' : (w.call ? '@' + w.call + ' ' : '');
    return at + withTail(core.length > 40 ? core.slice(0, 40) : core, tail, emoji);
  }
  if (target === 'dm') {
    return buildDm(
      {
        bv: f.bv,
        title: f.title,
        dur: f.dur,
        cells: f.cells,
        mark: f.mark,
        facts: f.facts,
        summary: { gist: f.gist, bullets: f.bullets, verdict: f.verdict, mark: f.mark },
      },
      { persona: p },
    );
  }
  return [
    withTail((w.call ? w.call + '，' : '') + String(f.gist || f.title || '').replace(/[。！？!?…]+$/, ''), tail, emoji),
    '',
    ((f.bullets || []).slice(0, 2).map((b) => String(b).replace(/[。！？!?…]+$/, '')).join('；') || f.title || '') + '。',
    '',
    '我的看法：' + (f.verdict || '值得看') + (f.mark ? '，重点 ' + f.mark : '') + '。',
    '',
    String(f.bv || ''),
  ].filter((x) => x !== null).join('\n');
}

/**
 * 生成一份样例。
 * @param {{target?:'summary'|'comment'|'dm', bv?:string, useModel?:boolean, targetName?:string}} opts
 * @returns {Promise<{ok:boolean,text:string,source:'model'|'fallback',model?:string,endpoint?:string,ms?:number,tokens?:object,real?:boolean,bv?:string,personaKey?:string,gen?:string,error?:{code:string,zh:string}}>}
 */
export async function generateSample(opts = {}) {
  const target = ['summary', 'comment', 'dm'].includes(String(opts.target)) ? String(opts.target) : 'summary';
  const p = readPersona();
  const { facts, real } = sampleMaterial(opts.bv);
  const allowed = particleWhitelist(p);
  /* C-EXTRA-2：推送账号名（后端 /api/persona/preview 传进来），只影响 comment 的开头 @ */
  const targetName = String(opts.targetName || '').trim();
  const clean = (t) => enforceParticles(String(t || ''), allowed);
  const base = { ok: true, target, real: !!real, bv: facts.bv, targetName, personaKey: p.active || 'none', gen: personaGenKey(p), particles: allowed };
  if (opts.useModel === false) {
    return { ...base, source: 'fallback', text: clean(fallbackText(target, facts, p, { targetName })), note: '未调用模型（规则拼装示例）' };
  }
  const cfg = readLocalCfg();
  try {
    const r = await callLocal(buildSamplePrompt(target, facts, p, null, { targetName }), cfg);
    const text = String(r.text || '').trim();
    if (!text) throw Object.assign(new Error('empty'), { code: 'empty' });
    return { ...base, source: 'model', text: clean(text), model: cfg.model, endpoint: r.endpoint, ms: r.ms, tokens: r.tokens };
  } catch (e) {
    const code = (e && e.code) || 'ollama-unreachable';
    return {
      ok: false, ...base, source: 'fallback', text: clean(fallbackText(target, facts, p, { targetName })),
      error: { code, zh: ERR_ZH[code] || String((e && e.message) || e) },
      note: '模型没跑起来，下面是规则拼装示例（不代表真实生成效果）',
    };
  }
}
