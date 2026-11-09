// 材料 brief（v50）—— 唯一真源：把 factcard.json 渲染成「时间码逐段 + 事实 + 弹幕」的纯文本。
//
// 为什么要这一层：
//   · v50 之前提示词里直接塞 factcard.json / manifest.txt 原文，行首是「格 $N」「格号=…」，
//     模型照着写就成了「第1格到第2格」这种内部说法；用户明确要求正文只讲视频本身。
//   · 这里只输出「[MM:SS] + 这一段在讲什么 + 画面上的字」，任何位置都不许出现「格」字。
// 无依赖、可被 scripts/lib/sample.mjs 静态 import，也可被插件动态 import。

const CLIP = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const chars = [...t];
  return chars.length > n ? chars.slice(0, n).join('') + '…' : t;
};

const MMSS = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

/**
 * 把 factcard 渲染成给模型看的材料 brief。
 * @param {object} fc factcard.json 的对象（字段可缺）
 * @param {{maxChars?:number,maxCells?:number,maxFacts?:number}} [opts]
 * @returns {string}
 */
export function materialBrief(fc, opts = {}) {
  const o = Object.assign({ maxChars: 4500, maxCells: 20, maxFacts: 12 }, opts || {});
  const f = fc && typeof fc === 'object' ? fc : {};

  const bv = String(f.bv || '').trim() || '（BV 未知）';
  const title = String(f.title || '').trim() || '（标题未知）';
  const up = String(f.up || '').trim() || '（UP 未知）';
  const durSec = Number(f.duration) || 0;
  const durZh = durSec > 0 ? MMSS(durSec) : (String(f.dur || '').trim() || '未知');
  const head = '[这条视频] ' + bv + '《' + title + '》 · UP：' + up + ' · 时长 ' + durZh + (durSec > 0 ? '（' + durSec + ' 秒）' : '');

  const cells = Array.isArray(f.cellIndex) ? f.cellIndex : (Array.isArray(f.cells) ? f.cells : []);
  const cellLines = cells.slice(0, o.maxCells).map((c) => {
    const from = MMSS(c && (c.from != null ? c.from : c.start));
    const to = MMSS(c && (c.to != null ? c.to : c.end));
    const say = CLIP(c && (c.index != null ? c.index : (c.text != null ? c.text : '')), 120) || '（这一段没有说话）';
    const ocr = CLIP(c && c.ocr, 60);
    return from + '–' + to + ' 台词：' + say + (ocr ? ' ｜ 画面文字：' + ocr : '');
  });

  const facts = (Array.isArray(f.facts) ? f.facts : [])
    .map((x) => CLIP(x && typeof x === 'object' ? (x.text != null ? x.text : x.zh) : x, 160))
    .filter(Boolean)
    .slice(0, o.maxFacts);

  const dm = f.danmaku || {};
  const total = Number(dm.total) || 0;
  const kept = Number(dm.kept) || 0;
  const sig = f.signals || {};
  const peakText = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 3).map((p) => {
    if (!p) return '';
    const t = String(p.hhmm || '').trim() || (p.t != null ? MMSS(p.t) : '');
    const txt = CLIP(p.text, 24);
    return t ? (txt ? t + '「' + txt + '」' : t) : '';
  }).filter(Boolean).join('、');
  const dis = peakText(sig.disputePeaks);
  const inf = peakText(sig.infoPeaks);
  let dmLine;
  if (!total && !kept && !dis && !inf) {
    dmLine = '[弹幕] 这条没有可用弹幕';
  } else {
    const bits = ['共 ' + total + ' 条（有内容的 ' + kept + '）'];
    if (dis) bits.push('争议峰 ' + dis);
    if (inf) bits.push('干货峰 ' + inf);
    dmLine = '[弹幕] ' + bits.join('；');
  }

  const render = (lines) => {
    const body = lines.length ? lines : ['（材料里没有逐段时间码）'];
    return [
      head,
      '[逐段]（时间码 + 这一段在讲什么 + 画面上的字，按时间顺序）',
      ...body,
      '',
      facts.length ? '[事实]' : '[事实]（材料里没有硬事实，只有台词和画面文字）',
      ...facts.map((x) => '· ' + x),
      '',
      dmLine,
    ].join('\n');
  };

  let n = cellLines.length;
  let out = render(cellLines);
  // 超长：从后往前裁逐段行（前面的时间码更接近开头，保留信息量大的前半段）
  while (out.length > o.maxChars && n > 0) {
    n -= 1;
    out = render(cellLines.slice(0, n));
  }
  if (out.length > o.maxChars) {
    out = out.slice(0, Math.max(0, o.maxChars - 10)).replace(/\s+$/, '') + '\n[已按长度截断]';
  } else if (n < cellLines.length) {
    out += '\n[已按长度截断]';
  }
  return out;
}
