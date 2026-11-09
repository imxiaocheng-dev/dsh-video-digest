// 偏好词表：加载 / 编译 / 打分。只用于「选片」，不参与片内事实层打分。
// 设计要点：词内饱和（同一词在一段文本里最多计 cap 次）· 来源折扣（标题是作者写的，字幕/OCR 才是客观内容）· 位置权重（词序越靠前越大）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';

// 数据目录：偏好配置归用户所有（旧布局下就是包根，本机行为不变）
export const ROOT = DATA_ROOT;
export const PREFS = path.join(ROOT, 'config', 'prefs.json');

export function loadPrefs(file = PREFS) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 有符号权重（v23 起统一）：-1.5 ~ +1.5，负数=扣分。
 *
 * 为什么改：旧数据是「正幅值 + polarity:'neg'」两段式，但面板滑杆是负值、
 * 存盘又被 Math.abs 取正，读写折符号不对称 → 负权重显示成正数，
 * 再经 scoreText 乘 -1 变成「负负得正」，标题党反而拿到正分（见 DECISIONS D13）。
 *
 * 兼容：读到旧数据（polarity==='neg' 且 weight>0）时在这里折成负数，
 * 不需要迁移脚本；写盘由面板/服务端保证 weight 已带符号。
 */
export function signedWeight(w = {}) {
  const n = Number(w.weight);
  const base = Number.isFinite(n) ? n : 0;
  const signed = w.polarity === 'neg' ? -Math.abs(base) : base;
  return +Math.max(-1.5, Math.min(1.5, signed)).toFixed(4);
}

/** 原子写：临时文件 + rename，避免面板写一半留下坏 JSON */
export function savePrefs(prefs, file = PREFS) {
  prefs.updatedAt = new Date().toISOString().slice(0, 10);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- v29：UP 白/黑名单（prefs.json 顶层 upWhite / upBlack） ----------
   匹配规则：归一化（去空白/标点/符号、小写）后「包含」。
   实测原因：同一个 UP 在搜索结果里有「何同学」「老师好我叫何同学」两种写法，
   包含匹配一次覆盖，完全一致/正则反而要用户自己维护多条。 */
export function normUpName(s) {
  return String(s == null ? '' : s).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

export function upListOf(prefs, key) {
  const a = prefs && prefs[key];
  return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : [];
}

/** 命中的名单条目（没命中返回 null）；空名单/空名字直接 null */
export function matchUpList(name, list) {
  const n = normUpName(name);
  if (!n || !Array.isArray(list) || !list.length) return null;
  for (const item of list) {
    const k = normUpName(item);
    if (k && n.includes(k)) return item;
  }
  return null;
}

/* v44：树形权重。word.parent 指向父词条的 id（父链最多 3 层）。
   子词条的「方向」永远继承父级，「幅度」= |父有效| × |本地系数|，夹在 1.5 以内；
   即：父有效 < 0 ? -min(1.5, |父有效|×|local|) : min(1.5, |父有效|×|local|)。
   子词条落盘的 weight 只是本地幅度系数（符号仅用于兼容旧数据），不再参与方向计算 ——
   彻底避免旧实现「父负 × 子负 = 正」的负负得正。
   顶层词条没有 parent → 有效权重就是自己的 weight，与旧数据完全一致（生产行为不变）。 */
export function effectiveWeights(words = []) {
  const byId = new Map(words.map((w) => [String(w.id || w.label), w]));
  // 注意：不能按词缓存 —— 同一个词在不同深度下的有效值不同（父链截断依赖 depth），
  // 缓存会让「先算浅层、再算深层」时复用浅层结果，截断就失效了。词表很小，直接递归。
  const calc = (w, depth, seen) => {
    const key = String(w.id || w.label);
    const local = signedWeight(w);
    if (seen.has(key)) return local; // 环保护：父链成环时按根处理
    const pid = String(w.parent || '');
    const parent = pid ? byId.get(pid) : null;
    if (!parent || parent === w || depth >= 3) return local;
    seen.add(key);
    const pe = calc(parent, depth + 1, seen);
    seen.delete(key);
    const mag = Math.min(1.5, Math.abs(pe) * Math.abs(local));
    // 父级为负 → 结果必为负（禁止负负得正）；父级为正时保留本地符号
    return +((pe < 0 || local < 0 ? -mag : mag)).toFixed(4);
  };
  const out = new Map();
  for (const w of words) out.set(String(w.id || w.label), calc(w, 0, new Set()));
  return out;
}

export function compile(prefs = loadPrefs()) {
  const words = prefs.words || [];
  // v44：位置权重默认关闭（enabled=false → mult 恒 1）；只有显式开启才按词序递减
  const { step = 0.08, max = 1.5, enabled = false } = prefs.positionWeight || {};
  const n = words.length;
  const cap = prefs.saturation?.perWordCap ?? 3;
  const discount = { title: 0.6, tag: 0.9, desc: 0.8, subtitle: 1.0, ocr: 1.0, ...(prefs.sourceDiscount || {}) };
  const eff = effectiveWeights(words);
  const compiled = words.map((w, i) => {
    const localWeight = signedWeight(w);
    const weight = eff.get(String(w.id || w.label)) ?? localWeight;
    return {
      ...w,
      weight,
      localWeight,
      polarity: weight < 0 ? 'neg' : 'pos', // 极性由符号反推，保留字段供下游（搜索词过滤/展示）使用
      // v45：terms 为空时回落类目名 —— 只填名字的类目也要能算分（与前端试算口径一致）
      terms: (w.terms && w.terms.length ? w.terms : [w.label]).map((t) => String(t).toLowerCase()).filter(Boolean),
      // 词序权重：第 0 个 ×1.0 起，往后按 step 递减，下限 1 - (n-1)*step，且不超过 max
      mult: enabled ? Math.min(max, Math.max(0.5, 1 - step * i)) : 1,
    };
  });
  const regions = { positive: {}, negative: {}, ...(prefs.regions || {}) };
  return { words: compiled, cap, discount, regions };
}

/* v45：搜索词。pick 用 queries 去 B 站捞片；queries 为空/缺省 → 用类目名。
   负向类目不参与搜索（与 pick 现有的 polarity 过滤语义一致）。
   trim → 去空 → 大小写不敏感去重 → 上限 40 个。 */
export function searchQueries(compiled = {}) {
  const out = [];
  const seen = new Set();
  for (const w of compiled.words || []) {
    if (!w || w.polarity === 'neg') continue;
    const raw = (Array.isArray(w.queries) && w.queries.length ? w.queries : [w.label]);
    for (const x of raw) {
      const s = String(x == null ? '' : x).trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= 40) return out;
    }
  }
  return out;
}

/** 分区加减分：粒度粗，只做小幅修正。tname 形如 "科技·机械" / "知识·科学科普" */
export function regionBoost(c, tname) {
  const t = String(tname || '').toLowerCase();
  if (!t) return 0;
  let s = 0;
  for (const [k, w] of Object.entries(c.regions.positive || {})) if (t.includes(String(k).toLowerCase())) s += Number(w) || 0;
  for (const [k, w] of Object.entries(c.regions.negative || {})) if (t.includes(String(k).toLowerCase())) s += Number(w) || 0;
  return +s.toFixed(2);
}

const countOf = (hay, needle) => {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
};

/**
 * 给一条候选打分。
 * sources: {title, tag, desc, subtitle, ocr}  —— 缺的源按 0 处理
 * 返回 {score, hits:[{id,label,polarity,raw,eff,contrib}]}
 */
export function scoreText(c, sources = {}) {
  const hits = [];
  let score = 0;
  for (const w of c.words) {
    let raw = 0;
    for (const [src, mult] of Object.entries(c.discount)) {
      const hay = String(sources[src] || '').toLowerCase();
      if (!hay) continue;
      for (const t of w.terms) raw += countOf(hay, t) * mult;
    }
    if (raw <= 0) continue;
    const eff = Math.min(raw, c.cap);            // 词内饱和：命中再多也只按 cap 计
    // v23：weight 自带符号（负数=扣分），不再额外乘 polarity，避免负负得正
    const contrib = +(eff * w.weight * w.mult).toFixed(2);
    score += contrib;
    hits.push({ id: w.id, label: w.label, polarity: w.weight < 0 ? 'neg' : 'pos', weight: w.weight, raw: +raw.toFixed(2), eff, contrib });
  }
  hits.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
  return { score: +score.toFixed(2), hits };
}

/** 给下游（模型挑格 / 清单）用的 focus 一行 */
export function focusLine(hits, top = 3) {
  const pos = hits.filter((h) => h.polarity !== 'neg' && h.contrib > 0).slice(0, top).map((h) => h.label);
  const neg = hits.filter((h) => h.polarity === 'neg' && h.contrib < 0).slice(0, top).map((h) => h.label);
  return `focus=${pos.join('/') || '无'}${neg.length ? ` 避开=${neg.join('/')}` : ''}`;
}
