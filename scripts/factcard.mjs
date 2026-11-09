// 事实卡：0 token，把一次 digest 的产物压成"可核对的结构化事实"
// 用法：node scripts/factcard.mjs BV1xxx [BV2 ...]   |  --all
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT } from './lib/paths.mjs';

// 数据目录：产物读写都走这里（旧布局下就是包根，本机行为不变）
const ROOT = DATA_ROOT;
const OUT = path.join(ROOT, 'out');

const mmss = s => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const secs = t => { const p = String(t).split(':'); return p.length === 2 ? +p[0] * 60 + +p[1] : +p[0] * 3600 + +p[1] * 60 + +p[2]; };

function readLines(f) { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { return []; } }
function readJson(f, d = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }

// 从一段中文里抽"可核实的事实"：参数/型号/价格/指标
const FACT_PATTERNS = [
  [/\b\d+(?:\.\d+)?\s*(?:mm|cm|mAh|W|V|A|Hz|kHz|MHz|GHz|GB|TB|MB|℃|°C|nm|bit|fps|kg|g|寸|英寸|米|度|瓦|伏|欧姆|Ω)\b/gi, 'param'],
  [/\b[A-Z]{2,}[- ]?\d{2,}[A-Z0-9-]*\b/g, 'model'],
  [/(?:¥|￥|\bRMB\s*)\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|块钱|块|美元|刀)/g, 'price'],
  [/\b\d+(?:\.\d+)?\s*(?:倍|%|个百分点)\b/g, 'ratio'],
  [/\d{4}年|\d+月\d+日/, 'date'],
];
function extractFacts(text) {
  const out = [];
  for (const [re, kind] of FACT_PATTERNS) {
    const m = String(text || '').match(re);
    if (m) for (const x of m) out.push({ kind, text: x.trim() });
  }
  return out;
}

function parseManifest(txt) {
  const cells = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^(\d+)\.\s*\[([\d:.]+)-([\d:.]+)\]\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let rest = m[4] || '';
    let dupOf = null;
    const dm = /^＝同第(\d+)格/.exec(rest);
    if (dm) { dupOf = +dm[1]; rest = rest.slice(dm[0].length).trim(); }
    let cuts = null;
    const cm = /刀(\d+)/.exec(rest);
    if (cm) { cuts = +cm[1]; rest = (rest.slice(0, cm.index) + rest.slice(cm.index + cm[0].length)).trim(); }
    let frameAt = null;
    const fm = /frame@([\d:.]*)/.exec(rest);
    if (fm) { frameAt = fm[1] ? secs(fm[1]) : null; rest = (rest.slice(0, fm.index) + rest.slice(fm.index + fm[0].length)).trim(); }
    rest = rest.replace(/^[\s：:]+/, '').replace(/＄\{.*$/, '').trim();
    cells.push({ n: +m[1], from: secs(m[2]), to: secs(m[3]), frameAt, cuts, dupOf, text: rest });
  }
  return cells;
}

// OCR 行清洗：水印/乱码不算字
function cleanOcrLine(t) {
  const s = String(t || '').replace(/\s+/g, '');
  if ([...s].length < 4) return '';
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk < 3) return '';
  const ratio = cjk / [...s].length;
  if (ratio < 0.45) return '';
  if (/(.)\1{2,}/.test(s)) return '';        // 同字连打
  if (/我是张小|bilibili|Lili/i.test(s)) return '';
  return t;
}

function parseOcr(txt) {
  const rows = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\[(\d+):(\d+)\]\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    rows.push({ t: +m[1] * 60 + +m[2], text: m[3].trim(), lines: m[3].split('/').map(s => s.trim()).filter(Boolean) });
  }
  return rows;
}

function parseDanmaku(txt) {
  const disputes = [], infos = [], questions = [];
  let total = 0, kept = 0, hotPeakLine = '';
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^弹幕（观众观点·可能说错）\s*(\d+)·有效\s*(\d+)/.exec(line);
    if (m) { total = +m[1]; kept = +m[2]; continue; }
    if (/^热点/.test(line)) { hotPeakLine = line; continue; }
    m = /^争\s+(\d+):(\d+)\s+(.*)$/.exec(line);
    if (m) { disputes.push({ t: +m[1] * 60 + +m[2], text: m[3] }); continue; }
    m = /^干\s+(\d+):(\d+)\s+(.*)$/.exec(line);
    if (m) { infos.push({ t: +m[1] * 60 + +m[2], text: m[3] }); continue; }
    m = /^问\s+(\d+):(\d+)\s+(.*)$/.exec(line);
    if (m) { questions.push({ t: +m[1] * 60 + +m[2], text: m[3] }); continue; }
  }
  return { total, kept, disputes, infos, questions, hotPeakLine };
}

// 可读索引句：从该格台词里取最短的有实义分句（0 token，不做评价）
const FILLER = /^(好的|那么|然后|接下来|所以|这个|那个|就是|其实|我们|大家|今天|现在|hello|我们先)/i;
function indexPhrase(cellText) {
  const parts = String(cellText || '').split(/[，。、；,;!?！？]/).map(s => s.trim()).filter(s => s.length >= 4 && !FILLER.test(s));
  if (!parts.length) return '';
  parts.sort((a, b) => Math.abs(a.length - 12) - Math.abs(b.length - 12));
  return [...parts[0]].slice(0, 14).join('');
}

export function buildFactcard(bv) {
  const dir = path.join(OUT, bv);
  const cost = readJson(path.join(dir, 'cost.json'), {});
  const title = cost.title || bv;  const minutes = cost.minutes || null;
  const duration = minutes ? Math.round(minutes * 60) : null;
  const cuts = cost.cuts || null;
  const cells = parseManifest(readLines(path.join(dir, 'manifest.txt')).join('\n'));
  const ocrRaw = parseOcr(readLines(path.join(dir, 'ocr.txt')).join('\n'));
  const ocr = ocrRaw.map(o => ({ ...o, lines: o.lines.map(cleanOcrLine).filter(Boolean) })).filter(o => o.lines.length);
  const dm = parseDanmaku(readLines(path.join(dir, 'danmaku.txt')).join('\n'));
  const summary = readJson(path.join(dir, 'summary.json'), null);

  // 哪些格有 OCR 文字（±4s 窗口）
  const cellOcrText = cells.map(c => {
    const hits = ocr.filter(o => o.t >= c.from - 4 && o.t <= c.to + 4);
    return hits.flatMap(h => h.lines).join(' / ');
  });
  const cellsWithText = cellOcrText.filter(t => [...t.replace(/[\s\/]/g, '')].length >= 4).length;
  const infoDensity = cells.length ? +(cellsWithText / cells.length).toFixed(2) : 0;

  const allText = cells.map(c => c.text).join(' ') + ' ' + ocr.map(o => o.text).join(' ');
  const facts = extractFacts(allText);
  // 去重（同文只算一条）
  const bad = /^\d+[a-z]$/i;
  const seen = new Set(); const factList = [];
  for (const f of facts) {
    const t = f.text.trim();
    if (!t || bad.test(t)) continue;
    const k = f.kind + ':' + t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); factList.push(f);
  }

  const factcard = {
    at: new Date().toISOString(),
    bv, title,
    up: cost.up || '',
    upMid: cost.up_mid || null,
    duration, minutes: minutes ? +minutes.toFixed(2) : null,
    cells: cells.length, cellsWithText, infoDensity,
    cuts, cutRate: duration && cuts ? +(cuts / duration).toFixed(2) : null,
    ocrLines: ocr.reduce((n, o) => n + o.lines.length, 0),
    danmaku: { total: dm.total, kept: dm.kept, disputes: dm.disputes.length, infos: dm.infos.length, questions: dm.questions.length },
    facts: factList.slice(0, 24),
    factCount: factList.length,
    cellIndex: cells.map((c, i) => ({
      n: c.n, from: c.from, to: c.to, frameAt: c.frameAt, cuts: c.cuts,
      index: indexPhrase(c.text),
      ocr: cellOcrText[i] ? [...cellOcrText[i]].slice(0, 60).join('') : '',
    })),
    signals: {
      hotPeak: dm.hotPeakLine || '',
      disputePeaks: dm.disputes.map(d => ({ t: d.t, hhmm: mmss(d.t), text: d.text })),
      infoPeaks: dm.infos.map(d => ({ t: d.t, hhmm: mmss(d.t), text: d.text })),
    },
    localSummary: summary ? { verdict: summary.verdict, gist: summary.gist, mark: summary.mark, model: summary.model } : null,
    tokens: (cost.tokens && cost.tokens.total) || null,
  };
  fs.writeFileSync(path.join(dir, 'factcard.json'), JSON.stringify(factcard, null, 2));
  return factcard;
}

export function factcardText(f) {
  const L = [];
  L.push(`${f.bv} ${f.title}`);
  L.push(`${f.minutes ?? '?'} 分钟 · ${f.cells} 格（${f.cellsWithText} 格有字，密度 ${f.infoDensity}）· ${f.cuts ?? '?'} 刀（${f.cutRate ?? '?'}/s）· OCR ${f.ocrLines} 行 · 弹幕 ${f.danmaku.total ?? 0} 条（争议 ${f.danmaku.disputes}）· 事实 ${f.factCount} 条 · ${f.tokens ?? '?'} token`);
  if (f.localSummary) L.push(`本地初判：${f.localSummary.verdict || '—'}${f.localSummary.mark ? ' · 值得看 ' + f.localSummary.mark : ''}（未复核）`);
  for (const c of f.cellIndex.slice(0, 12)) {
    L.push(`  格${c.n} ${mmss(c.from)}-${mmss(c.to)}　${c.index || '（无台词）'}${c.ocr ? '　[OCR]' + c.ocr.slice(0, 34) : ''}`);
  }
  if (f.signals.disputePeaks.length) L.push('争议峰：' + f.signals.disputePeaks.slice(0, 3).map(d => `${d.hhmm}「${d.text.slice(0, 18)}」`).join('　'));
  if (f.signals.infoPeaks.length) L.push('干货峰：' + f.signals.infoPeaks.slice(0, 3).map(d => `${d.hhmm}「${d.text.slice(0, 18)}」`).join('　'));
  if (f.facts.length) L.push('事实：' + f.facts.slice(0, 10).map(x => x.text).join(' · '));
  return L.join('\n');
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let bvs = args.filter(a => /^BV[0-9A-Za-z]{6,14}$/.test(a));
  if (args.includes('--all') || !bvs.length) {
    bvs = fs.readdirSync(OUT).filter(d => /^BV[0-9A-Za-z]{6,14}$/.test(d) && fs.existsSync(path.join(OUT, d, 'manifest.txt')));
  }
  for (const bv of bvs) {
    const f = buildFactcard(bv);
    console.log('─'.repeat(72));
    console.log(factcardText(f));
  }
}
