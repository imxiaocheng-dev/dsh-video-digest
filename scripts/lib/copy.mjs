// 投递文案（v33）—— 唯一真源。
//
// 投递口径（四条）：
//   · 评论信息核 ≤ commentMax（上限从 config/push.json 的 shape 读；@ 昵称与句末人设尾巴不计入）；
//   · 私信 ≤ dmMax（B 站 21007 硬上限 860，平台硬限，不随设置放开）；
//   · 去腔表：不出现【标题】【时长】抬头、不出现「1. 2. 3.」编号清单、不出现「本视频 / 该视频 / 值得一看」这类总结腔（正文用自然句子讲「讲了什么 → 值得说的点 → 我的看法」）；
//   · 人设只影响口气（称呼 / 句末语气词 / 开头叫法），数字、型号、时间码、结论一律不改写。

import fs from 'node:fs';
import { personaTails } from './persona-text.mjs';
import { configFile } from './paths.mjs';

export const COMMENT_CORE_MAX = 40; // v36 之前的保守默认值（现在只是默认，上限由面板 shape.commentMax 决定）
export const COMMENT_MAX_HARD = 200; // v37：评论上限的天花板（面板填超过它会被自动改成它，并提示）
export const COMMENT_WARN_OVER = 100; // v37：超过这个字数在面板上提示「被举报风险升高」
export const DM_MAX_HARD = 860; // B 站私信 21007「消息过长」的实测安全线（平台硬限，不随设置放开）
export const DM_MAX = DM_MAX_HARD; // 兼容 v32 的导出名

/** 读投递形态（config/push.json 顶层 shape），坏文件/缺字段一律回落默认 */
export function readShape() {
  let p = {};
  try { p = JSON.parse(fs.readFileSync(configFile('push.json'), 'utf8')) || {}; } catch (e) { p = {}; }
  const s = (p && p.shape) || {};
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  return {
    commentMax: clamp(s.commentMax, 20, COMMENT_MAX_HARD, COMMENT_CORE_MAX),
    dmMax: clamp(s.dmMax, 200, DM_MAX_HARD, DM_MAX_HARD),
  };
}

export function firstSentence(t) {
  const s = String(t || '').replace(/\s+/g, '');
  const m = /^(.{6,40}?)[。！？!?]/.exec(s);
  return (m ? m[1] : s).trim();
}

export function cutAtClause(t, max) {
  const c = [...String(t || '')];
  if (c.length <= max) return String(t || '');
  const head = c.slice(0, max).join('');
  const idx = Math.max(
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
    head.lastIndexOf('；'),
    head.lastIndexOf('：'),
    head.lastIndexOf('。'),
    head.lastIndexOf('）'),
    head.lastIndexOf(')'),
  );
  let out = idx >= max * 0.4 ? head.slice(0, idx) : head;
  // 别停在没闭合的引号/括号里（「换气 → 半截）
  for (const [a, b] of [['「', '」'], ['（', '）'], ['(', ')'], ['《', '》']]) {
    const na = (out.match(new RegExp('\\' + a, 'g')) || []).length;
    const nb = (out.match(new RegExp('\\' + b, 'g')) || []).length;
    if (na > nb) {
      const k = out.lastIndexOf(a);
      if (k > 0) out = out.slice(0, k);
    }
  }
  return out.replace(/[，,、；;：:\s]+$/, '');
}

/** 取不超过 n 字的完整句（按句号/感叹号切；切不出来再退回 cutAtClause） */
function clipSentences(t, n) {
  const s = String(t || '').trim();
  if ([...s].length <= n) return s;
  const parts = s.split(/(?<=[。！？!?…])/);
  let acc = '';
  for (const p of parts) {
    if ([...acc + p].length > n) break;
    acc += p;
  }
  if (acc) return acc.replace(/[。！？!?…]+$/, '');
  return cutAtClause(s, n);
}

/* ---------- 去总结腔 ---------- */

// 开头的机械前缀（「本视频讲述了…」「该视频主要讲…」）
const LEAD_NOISE = /^(?:这期|本条|这个|该|本)?(?:条|期)?(?:视频|片子)?(?:主要)?(?:是|讲|讲述|介绍|记录|关于|在讲|说|展示了|分享了)?[:：、，\s]*/;

export function humanLead(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:本视频|该视频|这条视频|本期视频|视频)\s*(?:主要)?(?:讲述|讲了|讲|介绍|记录|关于|是|在讲|说|展示了)?\s*[:：，、]?\s*/, '');
  // 「内容是…」「主要是…」这类也去掉一层
  s = s.replace(/^(?:主要(?:内容|是|讲)?|内容(?:是|为)?)\s*[:：，、]?\s*/, '');
  s = s.replace(LEAD_NOISE, (m) => (m.length <= 2 ? '' : ''));
  return s.replace(/^[，,、。；;：:\s]+/, '').trim();
}

// 总结腔词表：出现在文案里就换掉（语义不变，只去腔）
const CLICHE = [
  [/综上所述|总的来说|总而言之/g, '总之'],
  [/值得一看/g, '值得看'],
  [/令人印象深刻/g, '挺让人记住'],
  [/不难看出|可以看出|可见/g, '能看出来'],
  [/本视频|该视频|本期视频/g, '这条'],
  [/可谓/g, '算是'],
  [/首先[，,]\s*/g, ''],
  [/其次[，,]\s*/g, '然后'],
  [/最后[，,]\s*/g, '最后'],
  [/画面精美|制作精良/g, '做得挺细'],
];

export function deCliche(t) {
  let s = String(t || '');
  for (const [re, to] of CLICHE) s = s.replace(re, to);
  return s.replace(/\s{2,}/g, ' ').trim();
}

// 把「1. 要点」这类编号去掉，改成能读的短句
function stripNumber(t) {
  return String(t || '').replace(/^\s*\d+[.、)]\s*/, '').replace(/\s+/g, ' ').trim();
}

/* ---------- v53：取证腔 / 缺陷说明清洗 ---------- */

/** 命中即整句丢弃的词（契约 §3.1）：这些是「我们怎么分析这条片」的说法，不属于视频内容 */
const LEAK_SENTENCE_RE = /画面文字|画面上的?字|台词摘录|字幕|OCR|ASR|转录|转写|样本量|核实|核对|乱码|清晰度|听不清|大意转述|逐字/;
/* aggressive：只给 caveat / comment 用 —— 「台词 / 材料 / 资料 / 素材」在内容语境里可能是正常词 */
const LEAK_SENTENCE_AGGRESSIVE_RE = /台词|材料|资料|素材|识别不出|转述/;

/**
 * v53（契约 §3.1）：按句丢弃「取证腔 / 缺陷说明」的整句。
 * 句子切分用 /(?<=[。！？；!?\n])/，保留分隔符；只剩空白返回 ''。
 * opts.aggressive=true 时额外丢「台词 / 材料 / 资料 / 素材」这类歧义词（只用于 caveat / comment）。
 */
export function stripLeakSentences(text, opts = {}) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return '';
  const extra = opts && opts.aggressive ? LEAK_SENTENCE_AGGRESSIVE_RE : null;
  const kept = s.split(/(?<=[。！？；!?\n])/).filter((p) => !LEAK_SENTENCE_RE.test(p) && !(extra && extra.test(p)));
  return kept.join('').trim();
}

/** 只做 3.2 的替换、不丢句 —— 给 gist 用（丢一句总结就断了）。
 *  v53b：把 v50 面板那套内部词替换也搬进来（第N格→这一段 / 格号→时间码 / 宫格图→画面 /
 *  事实卡→这条视频 / 资料→内容），并在 strip 之前执行 —— 旧 summary 里的「第1格到第2格」也能被解掉。
 *  注意：这里不碰「材料」（内容词，只有 aggressive 才丢）。 */
export function replaceAnalysisLeak(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/第\s*\d+\s*格(?:到第\s*\d+\s*格)?/g, '这一段');
  s = s.replace(/格号/g, '时间码');
  s = s.replace(/宫格图?/g, '画面');
  s = s.replace(/事实卡/g, '这条视频');
  s = s.replace(/资料里?/g, '内容');
  s = s.replace(/^\s*(?:画面(?:文字|上)?(?:写|标|显示)(?:着|的是)?|台词(?:里|中)?(?:说|讲|写)(?:着|的是)?)[：:，,]?\s*/g, '');
  s = s.replace(/(?:来自|根据|据)(?:画面文字|台词|字幕|OCR|转录|转写)/g, '');
  s = s.replace(/画面(?:文字|上)?(?:写|标|显示)(?:着|的是)?/g, '');
  s = s.replace(/台词(?:里|中)?(?:说|讲|写)(?:着|的是)?/g, '');
  return s;
}

/**
 * v53（契约 §3.2）：先去掉「画面写着 / 台词里说 / 来自画面文字」这类来源前缀，再走 stripLeakSentences。
 * 只做句子级清洗，不改写视频内容本身。
 */
export function scrubAnalysisLeak(text, opts = {}) {
  return stripLeakSentences(replaceAnalysisLeak(text), opts);
}

/* ---------- 评论 ---------- */

/** 评论「信息核」：只有这段受上限约束（不含 @昵称、不含人设尾巴） */
export function commentCore(f, opts = {}) {
  const max = Math.min(COMMENT_MAX_HARD, Math.max(20, Number(opts.max) || COMMENT_CORE_MAX));
  const sm = f.summary || null;
  const verdict = deCliche((sm && sm.verdict) || '');
  const bullets = ((sm && sm.bullets) || []).map((b) => deCliche(stripNumber(b)));
  const hasDig = (t) => /[0-9０-９]|mm|cm|W|V|A|Hz|℃|元/.test(t);
  bullets.sort((a, b) => (hasDig(b) - hasDig(a)) || a.length - b.length);
  const bi = bullets[0] || '';
  const cands = [];
  // 评论优先用「要点」——它具体、带数字/时间码，比 gist 的概述更像一句人话
  if (bi) {
    cands.push((verdict ? verdict + '：' : '') + cutAtClause(bi, max - [...verdict].length - 1));
    cands.push(cutAtClause(bi, max));
  }
  if (sm && sm.gist) {
    const one = firstSentence(deCliche(humanLead(sm.gist)));
    cands.push((verdict ? verdict + '：' : '') + cutAtClause(one, max - [...verdict].length - 1));
    cands.push(cutAtClause(one, max));
  }
  if (sm && sm.mark) cands.push('重点 ' + sm.mark);
  if (!sm) {
    if (f.mark && f.facts && f.facts.length) {
      const fa = String(f.facts[0]).replace(/^\d+:\d+\s*/, '');
      cands.push('这段讲「' + cutAtClause(fa, 22) + '」');
    }
    if (f.mark && f.dmHot) cands.push('热点在 ' + f.dmHot + '，' + f.dur + ' 全片');
    if (f.facts && f.facts.length >= 2) {
      const fa = String(f.facts[1]).replace(/^\d+:\d+\s*/, '');
      cands.push(cutAtClause(fa, 30));
    }
  }
  if (!cands.length) cands.push(f.dur + (verdict ? ' ' + verdict : ''));
  for (const v of cands) {
    const n = [...v].length;
    if (n <= max && n >= 12) return deCliche(v);
  }
  for (const v of cands) if ([...v].length <= max) return deCliche(v);
  return deCliche(cutAtClause(cands[0], max));
}

/** 句末语气：先把正文末尾的标点剥干净，再接尾巴、补一个句号、表情跟在句号之后。
 *  v52：旧实现把末尾标点整段拼回，正文本来就以「。」结尾时会变成重复标点。。（实测踩过）。 */
export function withTail(s, tail, emoji = '') {
  const body = String(s || '').trim().replace(/[。！？!?…，、；：\s]+$/, '');
  const core = body + (tail || '') + '。';
  return emoji ? core + emoji : core;
}

/**
 * 评论全文：@昵称 + 信息核（≤ commentMax）+ 人设尾巴（不计入上限）。
 * opts: { targetName, persona, withAt=true, max }
 */
export function buildComment(f, opts = {}) {
  const { targetName = '', persona = null, withAt = true } = opts;
  const shape = readShape();
  const max = Math.min(COMMENT_MAX_HARD, Math.max(20, Number(opts.max) || shape.commentMax));
  /* v53（契约 §3.4）：评论正文先洗取证腔（aggressive —— 评论可以激进一点）；
     洗空了就回落原 core —— 评论不能空。 */
  let core = commentCore(f, { max });
  const scrubbed = scrubAnalysisLeak(core, { aggressive: true }).trim();
  if (scrubbed) core = scrubbed;
  const { tail, emoji } = personaTails(persona || { preset: null });
  const at = withAt && targetName ? '@' + targetName + ' ' : '';
  return at + withTail(core, tail, emoji);
}

/* ---------- 私信 ---------- */

function dmFit(lines, max = DM_MAX_HARD) {
  const total = (arr) => arr.join('\n').length;
  const out = lines.slice();
  if (total(out) <= max) return out;
  // 1) v53：超长先丢最后一条「· 」要点（不再有「局限：」段）
  while (total(out) > max) {
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].startsWith('· ')) { idx = i; break; }
    }
    if (idx < 0) break;
    out.splice(idx, 1);
  }
  if (total(out) <= max) return out;
  // 2) 最后截最长的那行（先按逗号切；跳过末行 BV 号与「我的评估」——那行末句是判断，剪了就没结论）
  let li = -1;
  for (let i = 0; i < out.length; i += 1) {
    if (/^BV[0-9A-Za-z]+$/.test(out[i])) continue;
    if (out[i].startsWith('我的评估：')) continue;
    if (li < 0 || out[i].length > out[li].length) li = i;
  }
  if (li < 0) li = 0;
  const rest = out.reduce((s, x, i) => s + (i === li ? 0 : x.length + 1), 0);
  const budget = Math.max(60, max - rest - 1);
  out[li] = cutAtClause(out[li], budget) + '…';
  return out;
}

const VERDICT_ZH = {
  值得看: '值得看',
  值得一看: '值得看',
  一般: '一般般，不急着看',
  一般般: '一般般，不急着看',
  不值得看: '不太值得',
  不值: '不太值得',
  没意思: '没什么意思',
};

function verdictPhrase(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return VERDICT_ZH[s] || s;
}

/** 把「讲了什么」写成一句人话：不用标题抬头，直接用正文句（v54：放宽到 160 字，避免把主题句和第二句结论一起切掉；超过按整句截）。
 *  gist 只做来源词替换、不做句子级丢弃 —— 丢一句总结就断了。 */
function whatItIs(f, sm) {
  const gist = sm && sm.gist ? replaceAnalysisLeak(deCliche(humanLead(sm.gist))) : '';
  if (gist) return clipSentences(gist, 160);
  const title = String(f.title || '').trim();
  return title ? '讲的是' + title : '这条';
}

/** v53：一条要点行 —— 去编号 → 洗取证腔（默认 LEAK，非 aggressive）→ 去句末标点 → 整句裁到 60 */
function dmBullet(b) {
  let s = scrubAnalysisLeak(stripNumber(deCliche(String(b == null ? '' : b)))).trim();
  s = s.replace(/[。！？!?…；;]+$/, '').trim();
  if (!s) return '';
  const cut = clipSentences(s, 95).replace(/[。！？!?…；;]+$/, '').trim();
  if (!cut) return '';
  /* v53b：真截断了才补一个「…」，否则「换成粘土」这种结尾会被读成漏字 */
  return [...cut].length < [...s].length ? cut + '…' : cut;
}

/**
 * v55：一段「我的评估」——结构化通路新增的 take 字段（证据强度 + 判断）。
 * 与 dmBullet 同一层清洗；整句裁到 180（硬上限），真截断才补「…」；
 * 去掉模型自己加的前缀（「我的评估：」「评估：」），前缀由 buildDm 统一加，避免出现两遍。
 */
function dmTake(b) {
  let s = scrubAnalysisLeak(String(b == null ? '' : b)).trim();
  s = s.replace(/^(我的评估|评估|证据强度|我的判断|判断)[：:]\s*/, '').trim();
  s = s.replace(/[。！？!?…；;]+$/, '').trim();
  if (!s) return '';
  if ([...s].length <= 200) return s;
  /* v56：超长先退到最近的句末/分句边界，别把词切成半截；退不动再退回整段句界。 */
  const head = [...s].slice(0, 200).join('');
  let cut = '';
  for (const sep of ['。', '！', '？', '；']) {
    const i = head.lastIndexOf(sep);
    if (i >= 80) { cut = head.slice(0, i); break; }
  }
  if (!cut) {
    const i = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','));
    cut = i >= 80 ? head.slice(0, i) : head;
  }
  return cut.replace(/[。！？；，,、\s]+$/, '').trim() + '…';
}

/**
 * 私信正文（v53）：自然段，无抬头、无编号、无「局限」段，BV 号放最后一行。
 * 结构：<称呼><讲了什么 + 一句结论><尾巴>。emoji → · 要点（最多 4 条）→ 值得看的一段 → 我的评估（末句带判断）→ BV 号
 * 契约 §3.3：gist 只做替换不丢句；bullets 用默认 LEAK（命中丢该条，可从后面补到 3 条）；caveat 不进私信。
 * v55：可选 take 字段（技术向结构的「评估」落点）；v56：take 末句承担判断，不再单独渲染「我的看法」，旧总结无 take 时退回那一行。
 * opts: { persona }
 */
export function buildDm(f, opts = {}) {
  const { persona = null } = opts;
  const shape = readShape();
  const { lead, tail, emoji } = personaTails(persona || { preset: null });
  const sm = f.summary || null;
  const L = [];

  // 第 1 段：谁做的 + 讲了什么（人话；不超过 110 字，整句裁）
  const open = (lead ? lead : '') + whatItIs(f, sm) + '。';
  L.push(withTail(open, tail, emoji));

  if (sm) {
    /* 第 2 段：· 要点（按原顺序，最多 3 条；清洗后为空的跳过，后面可补位）。
       不再加「值得说的是：」—— 以前那层机械小标题正是「取证腔」的来源。 */
    const pts = (sm.bullets || []).map((b) => dmBullet(b)).filter(Boolean).slice(0, 4);
    for (const pt of pts) L.push('· ' + pt);
    if (sm.mark) L.push('值得看的一段：' + String(sm.mark).trim() + '。');
    /* v56：我的评估 —— take 的末句就是判断（值不值得看 + 为什么）。
       旧总结没有 take 时，才退回原来的「我的看法」一行；两者不再同时出现。 */
    const take = dmTake(sm.take);
    if (take) {
      let t = take;
      /* v56：模型偶尔漏掉判断词 —— 末句没有「值得看 / 一般 / 不值得看」时补一句门禁判断，保证私信有结论 */
      if (!/值得看|一般|不值得看/.test(t)) {
        const vp = verdictPhrase(sm.verdict);
        if (vp) t = t + '；' + vp;
      }
      const body = t.endsWith('…') ? t : t.replace(/[。；;，,\s]+$/, '');
      L.push('我的评估：' + body + (t.endsWith('…') ? '' : '。'));
    } else {
      const vp = verdictPhrase(sm.verdict);
      if (vp) L.push('我的看法：' + vp + '。');
    }
    /* v53：caveat 不再进私信（「要留意的是」整段删掉），只留在 summary.cloud.json 给面板看 */
  } else {
    // 没有云端总结（临时简报）：同样走 scrub，不再说「画面里能看到」
    if (f.facts && f.facts.length) {
      const pts = f.facts.slice(0, 2)
        .map((x) => scrubAnalysisLeak(String(x).replace(/^\d+:\d+\s*/, '')).trim())
        .filter(Boolean)
        .join('；');
      if (pts) L.push('片子里能看到：' + pts + '。');
    }
    if (f.brief && f.brief.length) {
      L.push('观众在说：' + f.brief.slice(0, 2).map((x) => String(x).replace(/\s+/, ' ').slice(0, 40)).join('；') + '。');
    }
    if (f.dmHot) L.push('弹幕热点在 ' + f.dmHot + '。');
    L.push('这条的正式总结还没写，先给你个临时简报。');
  }

  // 最后一行：BV 号（用户明确要求「只需要在总结最后加上 BV 号」）
  if (f.bv) L.push(String(f.bv));
  return dmFit(L, shape.dmMax).join('\n');
}
