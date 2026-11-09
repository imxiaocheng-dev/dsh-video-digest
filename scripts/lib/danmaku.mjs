// 弹幕：抓取 + 解析 + 去噪 + 只留"关键弹幕"（0 token，本地全算）
// 定位：不是"看弹幕"，而是回答两个问题——哪一刻观众有反应、哪一刻观众在吵什么。
// 压缩原则：宁少勿滥。复读/水词/情绪/艺术字/引流一律不进文本；
// 每条进文本的弹幕都必须带信号（争议 / 干货 / 疑问），且长度够（短句不可信）。
import zlib from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 拿 XML：comment.bilibili.com/<cid>.xml 最省事，服务器按 deflate 返回（实测 body 被自动解压，也兼容手动兜底） */
export async function fetchDanmakuXml(cid, { timeout = 20000 } = {}) {
  const url = `https://comment.bilibili.com/${cid}.xml`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`弹幕 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const head = buf.subarray(0, 2).toString('hex');
  if (head === '1f8b') return zlib.gunzipSync(buf).toString('utf8');
  if (head === '789c' || head === '78da' || head === '7801') return zlib.inflateSync(buf).toString('utf8');
  return buf.toString('utf8');
}

/** <d p="时间,模式,字号,颜色,发送时间戳,池,uidhash,dmid,权重">文本</d> */
export function parseXml(xml) {
  const out = [];
  for (const m of xml.matchAll(/<d p="([^"]*)">([\s\S]*?)<\/d>/g)) {
    const p = m[1].split(',');
    const text = m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    if (!text) continue;
    out.push({ t: Number(p[0]) || 0, mode: Number(p[1]) || 1, size: Number(p[2]) || 25, text });
  }
  return out;
}

// ── 归一化：去空白/标点/符号/表情，折叠 3+ 重复字符。只用于"同句判定"，不用于展示。
const norm = (s) =>
  s.replace(/[\s\p{P}\p{S}\p{Extended_Pictographic}]/gu, '')
    .toLowerCase()
    .replace(/(.)\1{2,}/gu, '$1');

// 正常字符集（汉字/字母/数字/空白/常见标点与比较符）。艺术字、方块字符、乱码基本不在这个集合里
const ALLOWED = /[\s\u4e00-\u9fffA-Za-z0-9，。！？、：；“”‘’（）()《》【】…—\-+*/=%~≠<>|]/;

// 纯水弹幕：整句就是这些（不做"包含即丢"，否则会误杀"这个原理图求一下"）
const WATER = new Set(['打卡', '签到', '前排', '沙发', '第一', '来了', '围观', '火钳', 'awsl', '泪目', '破防',
  'xswl', '笑死', '233', '好耶', '开香槟', '每日', '考古', '舒服了', '有点东西', '一起看', '我来看',
  '来了来了', '前排围观', '沙发是我的', '第一第一', '哈哈', '哈哈哈', '哈哈哈哈', 'hhh', '咳咳', '来了老弟',
  '催更', '牛', '好活', '就这', '离谱', '天才', '老婆', '别闹', '你等着', 'oi']);

// 引流/自我推广：不带信息词时整句丢
const SPAM_WORDS = ['加v', '加微', '微信', 'vx', '公众号', '私信我', '加群', '代购', '三连', '投币', '点赞',
  '关注我', '求关注', '一键三连', '恰饭'];

// 争议/纠错：用正则而非"包含错字"，否则"不错""有没有误"全变争议
const NEG_RE = [
  /说错|写错|标错|讲错|搞错|弄错|算错|有误(?!解)|勘误|纠错|自相矛盾/,
  /错了|错的|错了吧|错得|是错的|就错在/,
  /不对(?!起)/,
  /离谱|翻车|骗子|假的|误导|退钱|拉胯|胡说|矛盾|误导|假的吧/,
  /没错/, // "这里没错"是在反驳别人的指控，本身是有信息的争议
];
// 干货：作者给的可核对信息。注意别把"价格/教程/淘宝"这类泛词算干货——
// 实测"价格是你的问题"被判成干货（那是个梗，不是信息）。
const INFO_WORDS = ['手册', '数据手册', '原理图', '源码', '文档', '公式', '参数', '型号', '型号是',
  '链接', '规格书', 'datasheet', 'bom', '封装', 'pdf', '代码'];
// 疑问
const Q_WORDS = ['为什么', '为啥', '是不是', '咋', '真的吗', '有没有', '怎么', '能吗', '对吗', '哪里', '如何', '什么'];
// 高能（最弱，只计数不引用）
const HYPE_WORDS = ['高能', '名场面', '伏笔'];

const QMARK = /[?？]/;
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);
const cjkLen = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/** 噪声判定：超长 / 字符集异常 / 复读 / 无汉字短句 */
export function isNoise(text) {
  if (!text || text.length < 2) return true;
  if (text.length > 70) return true;
  if (!hasCJK(text) && text.length < 8) return true; // 纯数字/纯字母短句（"666""hhh"）
  let bad = 0;
  for (const ch of text) if (!ALLOWED.test(ch)) bad++;
  if (bad / text.length > 0.3) return true;
  const f = new Map();
  for (const ch of text) f.set(ch, (f.get(ch) || 0) + 1);
  const max = Math.max(...f.values());
  if (text.length >= 4 && max / text.length > 0.5) return true;
  // 整段自我复读（"文字都删除了，手机的01代码还能用文字都删除了手机…"）——原文被刷的时候常见
  if (norm(text).length >= 12 && /(.{5,})\1/.test(norm(text))) return true;
  // 复制粘贴留下的标点残渣（"…还能用吗。？吗？"）；注意"？？"是正常强调，只有 3 连才算残渣
  if (/[。，、；][？?]|[？?]{3,}|[。，、]{2,}/.test(text)) return true;
  return false;
}

/** 分类：junk / plain / 信号组合（neg+info+question+hype） */
export function classify(text) {
  if (isNoise(text)) return 'junk';
  const n = norm(text);
  if (!n) return 'junk';
  if (WATER.has(n)) return 'junk';
  const t = text.toLowerCase();
  const tags = [];
  if (NEG_RE.some((re) => re.test(text))) tags.push('neg');
  if (INFO_WORDS.some((w) => t.includes(w))) tags.push('info');
  if (Q_WORDS.some((w) => t.includes(w)) || (QMARK.test(text) && cjkLen(text) >= 3)) tags.push('question');
  if (HYPE_WORDS.some((w) => t.includes(w))) tags.push('hype');
  if (SPAM_WORDS.some((w) => t.includes(w)) && !tags.includes('info')) return 'junk';
  if (!tags.length && n.length <= 3) return 'junk'; // 极短且无信号（"牛""好活""就这"）
  return tags.length ? tags.join('+') : 'plain';
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sig = (c) => (c.includes('neg') ? 3 : 0) + (c.includes('info') ? 2 : 0) + (c.includes('question') ? 2 : 0) + (c.includes('hype') ? 1 : 0);

/** 截断到 n 字，优先在标点处断，别把句子切成两半（"…还能用文字都删除了…"这种） */
const clip = (s, n = 26) => {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const i = Math.max(head.lastIndexOf('，'), head.lastIndexOf('。'), head.lastIndexOf('？'), head.lastIndexOf('！'),
    head.lastIndexOf('？'), head.lastIndexOf('；'), head.lastIndexOf('、'));
  return i >= 8 ? head.slice(0, i) : head.slice(0, n - 1) + '…';
};

/**
 * 聚合：刷屏剔除 → 去噪 → 分类 → 按窗统计 → 热峰 / 争议句 / 干货句 / 疑问句。
 * 只有"带信号且够长（≥5 汉字）"的句子才有资格被引用。
 */
export function analyze(items, { duration = 0, windowSec = 60, topWindows = 8, perWindow = 3 } = {}) {
  const total = items.length;
  // 同句判定用激进归一（"666666"→"6"），否则复读变体会漏
  const freq = new Map();
  for (const it of items) {
    const n = norm(it.text);
    if (!n) continue;
    freq.set(n, (freq.get(n) || 0) + 1);
  }
  const spamCut = Math.max(4, Math.floor(total * 0.08));

  const kept = [];
  const junkTexts = [];
  let junk = 0, spam = 0;
  const spamList = [];
  const spamSeen = new Set();

  for (const it of items) {
    const n = norm(it.text);
    if (!n) { junk++; continue; }
    if (total >= 20 && (freq.get(n) || 0) >= spamCut) {
      spam++;
      if (!spamSeen.has(n)) { spamSeen.add(n); spamList.push(`${it.text.slice(0, 12)}×${freq.get(n)}`); }
      continue;
    }
    const c = classify(it.text);
    if (c === 'junk') { junk++; if (junkTexts.length < 12) junkTexts.push(it.text.slice(0, 16)); continue; }
    kept.push({ ...it, c: c });
  }

  // 分窗统计
  const win = new Map();
  const marks = { neg: 0, question: 0, info: 0, hype: 0 };
  for (const it of kept) {
    const k = Math.floor(it.t / windowSec) * windowSec;
    if (!win.has(k)) win.set(k, { t0: k, n: 0, marks: { neg: 0, question: 0, info: 0, hype: 0 }, items: [] });
    const w = win.get(k);
    w.n++;
    w.items.push(it);
    for (const tag of it.c.split('+')) if (tag in w.marks) { w.marks[tag]++; marks[tag]++; }
  }

  const quotable = (x) => x.c !== 'plain' && cjkLen(x.raw) >= 5 && sig(x.c) >= 2;
  const windows = [...win.values()].map((w) => {
    const byText = new Map();
    for (const it of w.items) {
      const n = norm(it.text);
      if (!byText.has(n)) byText.set(n, { raw: it.text, n: 0, c: it.c, t: it.t });
      byText.get(n).n++;
    }
    const top = [...byText.values()]
      .filter(quotable)
      .sort((a, b) => sig(b.c) - sig(a.c) || b.n - a.n || a.raw.length - b.raw.length)
      .slice(0, perWindow)
      .map((x) => ({ raw: x.raw, text: clip(x.raw), n: x.n, c: x.c, t: x.t }));
    const weight = w.marks.neg * 3 + w.marks.question * 2 + w.marks.info * 2 + w.marks.hype;
    return { t0: w.t0, count: w.n, marks: w.marks, top, weight };
  });

  const hotPeaks = [...windows].sort((a, b) => b.count - a.count).slice(0, topWindows);
  const signalPeaks = [...windows].filter((w) => w.weight >= 2).sort((a, b) => b.weight - a.weight).slice(0, 5);

  // 跨窗挑"最好的争议句/干货句/疑问句"，同一句只进一个池
  const used = new Set();
  const usedText = new Set();
  const pick = (tag, limit, extra = () => true) => {
    const out = [];
    for (const w of signalPeaks.concat(windows)) {
      for (const q of w.top) {
        if (!q.c.includes(tag)) continue;
        const key = norm(q.raw || q.text);
        if (used.has(key) || usedText.has(q.text) || !extra(q)) continue;
        used.add(key);
        usedText.add(q.text);
        out.push(q);
        if (out.length >= limit) return out;
      }
    }
    return out;
  };
  const disputes = pick('neg', 3);
  const infos = pick('info', 2, (q) => !QMARK.test(q.raw || q.text)); // 带问号的是"提问"，不算作者给的干货
  const questions = pick('question', 2);

  return {
    total, kept: kept.length, junk, spam, spamCut, spamList, junkTexts,
    sample: kept.slice(0, 5).map((i) => i.text),
    duration, windowSec, windows: windows.length,
    hotPeaks, signalPeaks, disputes, infos, questions, marks,
  };
}

/**
 * 压成给模型看的短文本。硬预算：≤ 7 行、≤ 300 字（≈180 token）。
 * 结构：标注行（观众观点非事实）→ 统计 → 热点时间戳 → 争议（≤2）→ 干货（≤1）→ 疑问（≤1）→ 核对提示。
 * 关键：弹幕是"观众说法"，可能本身就是错的。它只用来定位"哪一刻值得细看"，
 * 不能当结论证据——所以标题里就写明性质，并在末尾要求核对。
 */
export function formatDense(a, { maxPeaks = 4, maxDisputes = 2, maxInfos = 1, maxQuestions = 1, maxChars = 300 } = {}) {
  if (!a.total) return '弹幕：该片无弹幕';
  if (a.total < 20) return `弹幕：仅 ${a.total} 条（无统计意义）`;
  const m = a.marks;
  const L = [];
  const cnt = [];
  if (m.neg) cnt.push(`争议${m.neg}`);
  if (m.question) cnt.push(`疑问${m.question}`);
  if (m.info) cnt.push(`干货${m.info}`);
  L.push(`弹幕（观众观点·可能说错）${a.total}·有效 ${a.kept}${cnt.length ? '｜' + cnt.join(' ') : ''}`);
  const peaks = a.hotPeaks.slice(0, maxPeaks).map((w) => `${mmss(w.t0)}(+${w.count})`).join(' ');
  if (peaks) L.push(`热点 ${peaks}`);

  const tagName = (c) => (c.includes('neg') ? '争' : c.includes('info') ? '干' : c.includes('question') ? '问' : '·');
  const quoted = [];
  for (const q of a.disputes.slice(0, maxDisputes)) { L.push(`${tagName(q.c)} ${mmss(q.t)} ${q.text}`); quoted.push(q); }
  for (const q of a.infos.slice(0, maxInfos)) { L.push(`${tagName(q.c)} ${mmss(q.t)} ${q.text}`); quoted.push(q); }
  for (const q of a.questions.slice(0, maxQuestions)) { L.push(`${tagName(q.c)} ${mmss(q.t)} ${q.text}`); quoted.push(q); }
  // 有引用才提示核对：这些是线索，不是事实
  if (quoted.length) L.push('↑观众说法，引用前用字幕/画面核对，别当结论');

  // 超预算：先砍疑问，再砍干货，最后砍到只剩统计+热点+1 条争议
  let out = L.join('\n');
  while (L.length > 3 && out.length > maxChars) { L.splice(L.length - 2, 1); out = L.join('\n'); }
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}
