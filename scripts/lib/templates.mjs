// 文案模板（v26）—— 唯一真源。
// config/templates/{summary,comment,dm}.md 是「规则文本」，以前定义了从不被读；v26 起：
//   · 云端总结：把 summary.md 全文 + 人设块拼进 prompt（改文件即生效，不用重启）；
//   · 判否说明：把 why.md（可缺省）当规则文本；
//   · 投递文案：comment.md / dm.md 当规则参考，实际文本由 lib/copy.mjs 规则拼装。
import fs from 'node:fs';
import path from 'node:path';
import { configFile } from './paths.mjs?v=36';

export const TPL_DIR = configFile('templates');
export const TPL_FILES = { summary: 'summary.md', comment: 'comment.md', dm: 'dm.md', why: 'why.md' };

const FALLBACK = {
  summary: [
    '角色：你在替用户看视频，只写这一条视频本身讲了什么、为什么做、用了什么技术、有什么能借鉴、你怎么看；说话像真看过的人在跟朋友转述，不是写报告。',
    '形态：不要【标题】13:56 值得看这类抬头；不要「1. 2. 3.」编号清单、不要小标题、不要 Markdown 加粗；用自然段写；整篇最后单独一行只写 BV 号（不写「BV 号：」，后面不加别的字）。',
    '只写这条视频里的内容：正文里不许出现「第N格」「格号」「宫格」「事实卡」「材料」「OCR」「画面文字」「台词摘录」这类内部说法；要指位置只用 [MM:SS]；数字/型号/参数与画面或台词字面一致，不换算、不四舍五入。',
    '弹幕只能写成「观众说」并带条数；没有弹幕原文就不许编观众的话；画面文字里的乱码、水印不引用；不评价作者，只评价内容。',
    '总结腔黑名单（出现即失败）：本视频 / 该视频 / 综上所述 / 总的来说 / 值得一看 / 令人印象深刻 / 可谓 / 不难看出 / 首先其次最后 / 画面精美 / 制作精良。',
    '输出结构：按「表达格式」给的那一档写（默认六段式：讲什么 → 做了什么 → 为什么做 → 用了什么技术 → 能借鉴什么 → 我的看法），写成自然段，不要把段名当小标题打出来。',
    '「我的看法」必须狠一点、有立场：先一句明确态度（值得看 / 一般 / 不值得，三选一，别和稀泥），再点一个能在视频里指出来的具体问题或具体优点；指不出来就说「没看出明显问题」；只评价内容，不评价人。态度与理由必须一致。',
  ].join('\n'),
  comment: '一句话结论（≤面板上限，默认 40 字：态度 + 一个可核实事实 + 时间码）；开头 @推送账号；不写链接、不带引流词、不写「第几格」这类内部说法。',
  dm: '第一句说清讲了什么（不要抬头）；2–4 条要点带 [MM:SS]；值得看的时间段；局限只写视频本身的不确定；结尾单独一行只写 BV 号。',
  why: '只解释「为什么没让它上云端写总结」，不许重新判断值不值得看；每条理由必须带证据（格号或原句）。',
};

export function readTemplate(name) {
  const file = TPL_FILES[name] || (String(name).endsWith('.md') ? String(name) : '');
  if (!file) return '';
  try { return fs.readFileSync(path.join(TPL_DIR, file), 'utf8'); } catch { return ''; }
}

/** 模板不存在时返回内置兜底，保证 prompt 永远有规则 */
export function templateOrFallback(name) {
  return readTemplate(name) || FALLBACK[name] || '';
}

/** 简单占位符替换：{key} → vars[key]（未知占位符原样保留） */
export function renderTemplate(text, vars = {}) {
  return String(text || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

export function templateInfo() {
  const out = [];
  for (const [name, file] of Object.entries(TPL_FILES)) {
    const fp = path.join(TPL_DIR, file);
    let st = null;
    try { st = fs.statSync(fp); } catch {}
    out.push({ name, file, exists: !!st, bytes: st ? st.size : 0, mtime: st ? st.mtime.toISOString() : null });
  }
  return out;
}

/** 拼「云端总结」的规则段：模板全文 + 人设块（由调用方再拼素材） */
export function summaryRulesText(personaBlock = '') {
  return [
    '## 写这条总结的规则（模板：config/templates/summary.md）',
    templateOrFallback('summary').trim(),
    personaBlock || '',
  ].filter(Boolean).join('\n\n');
}

/** 拼「判否说明」的规则段 */
export function whyRulesText(personaBlock = '') {
  return [
    '## 判否说明的规则（模板：config/templates/why.md）',
    templateOrFallback('why').trim(),
    '',
    '要求：只解释「为什么这条没进云端总结队列」，不许重新判断值不值得看；不许给整体评价；',
    '输出严格 JSON：{"reasons":[{"zh":"≤60字的原因","evidence":"格号或原句"}],"couldBe":["≤40字，什么情况下可能会有价值"]}',
    personaBlock || '',
  ].filter(Boolean).join('\n');
}
