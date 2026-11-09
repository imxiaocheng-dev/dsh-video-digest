// 人设 → 自然语言，唯一真源。
import fs from 'node:fs';
import { configFile } from './paths.mjs?v=36';

const EMOJI_WORD = {
  off: '不用表情和颜文字',
  few: '句末最多一个表情（投递文案的句末会跟一个）',
  normal: '可以用表情，最多两三个，别堆',
};

/* 各预设默认的句末表情字符：面板上「Emoji = 关/少/正常」选中之后，
   投递文案（私信/评论）的句末就固定跟一个 —— 免得「开了表情却一个都看不到」。
   预设里写 emojiChar（单个字符）可以覆盖这里。 */
const EMOJI_CHAR = { cat: '🐳', daughter: '🌸', pro: '🙂' };

/** 人设的句末表情：没有预设或 emoji=off → ''；否则 emojiChar 覆盖优先，其次按预设取默认，兜底 🙂 */
export function personaEmojiChar(p = readPersona()) {
  const w = (p && p.preset) || null;
  if (!w || w.emoji === 'off') return '';
  const custom = String(w.emojiChar || '').trim();
  if (custom) return [...custom].slice(0, 2).join('');
  return EMOJI_CHAR[String((p && p.active) || '')] || EMOJI_CHAR[String(w.id || '')] || '🙂';
}

const FORMAT_DEFAULT = {
  structure: '',   // 空 = 跟随人设卡（跟随人设卡自身的结构）
  terms: 'pop',
  timecode: true,
  uncertainty: 'all',
  voice: 'friend',
  maxChars: 900,   // v50：默认 900（v36 起由 config/push.json 的 shape.summaryMax 覆盖，这里只作兜底）
};

/* 投递形态上限：单一真源 config/push.json 的 shape.*（comment 20–200 / dm 200–860 / summary 200–2000） */
export const SHAPE_LIMITS = { commentMin: 20, commentMax: 200, dmMin: 200, dmMax: 860, summaryMin: 200, summaryMax: 2000 };
export const SHAPE_DEFAULT = { commentMax: 40, dmMax: 860, summaryMax: 900 };

/** 读投递形态（评论信息核 / 私信长度 / 总结字数）；坏文件或缺失时回落默认，永不抛 */
export function readShape() {
  const clamp = (x, lo, hi, dflt) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };
  try {
    const j = JSON.parse(fs.readFileSync(configFile('push.json'), 'utf8'));
    const s = (j && j.shape) || {};
    return {
      commentMax: clamp(s.commentMax, SHAPE_LIMITS.commentMin, SHAPE_LIMITS.commentMax, SHAPE_DEFAULT.commentMax),
      dmMax: clamp(s.dmMax, SHAPE_LIMITS.dmMin, SHAPE_LIMITS.dmMax, SHAPE_DEFAULT.dmMax),
      summaryMax: clamp(s.summaryMax, SHAPE_LIMITS.summaryMin, SHAPE_LIMITS.summaryMax, SHAPE_DEFAULT.summaryMax),
    };
  } catch (e) {
    return Object.assign({}, SHAPE_DEFAULT);
  }
}

/** 把一段「字数上限」翻译成给模型看的篇幅契约（硬上限 + 0.75N 软目标 + 结构只跟随上面那条 + 反注水）；v50：不再按字数硬切小段（会和六段式打架） */
export function lengthContract(kind, max, softRatio = 0.75) {
  const n = Math.round(Number(max) || 0);
  if (!n) return '';
  const soft = Math.max(1, Math.round(n * softRatio));
  const what = kind === 'comment' ? '评论正文（不含 @昵称）' : kind === 'dm' ? '私信正文（含称呼）' : '总结正文';
  return [
    `篇幅契约（${what}）：硬上限 ${n} 字——超过就删次要细节，结论和关键数字不许删；`,
    `软目标约 ${soft} 字——低于它先补具体细节（时间码 / 参数 / 画面里的字 / 弹幕争议），补完仍不够就停；`,
    '结构按上面「结构」那一条写，不要另立小标题；',
    '禁止凑字数：不许重复、不许形容词堆料、不许复述标题、不许「总的来说」收尾。字数不足不算失败，宁短勿凑。',
  ].join('\n');
}

// 内置默认人设（与 config/persona.json 同构；文件优先）。
// 语气词白名单：prompt 里写死只准用这些，示例/对照句渲染时剔词，生成后再由 enforceParticles 兜一层。

/** 常见语气词池（只用于「识别并剔除」，不做别的用途） */
const PARTICLE_POOL = [
  // 只用于「识别并剔除」生成文本里不属于当前人设的语气词；单字「鱼」「就」「还」「挺」故意不收，会误删正常词。
  '嗯', '哦', '噢', '呀', '哈', '诶', '欸', '哎', '唉', '嘛', '啦', '咯', '嘿', '喔', '呐', '哟', '咦', '哼', '呜', '噗', '啊',
];

/** 当前人设允许的语气词（来自卡片的 particles 字段） */
export function particleWhitelist(p = readPersona()) {
  const w = (p && p.preset) || {};
  return String(w.particles || '')
    .split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** 把文本里「不在白名单」的语气词剔掉（长词优先，避免短词先把长词拆掉） */
export function enforceParticles(text, allowed = []) {
  let t = String(text || '');
  if (!t) return t;
  const allow = new Set(allowed);
  const banned = PARTICLE_POOL
    .filter((w) => !allow.has(w))
    /* 双向放行：白名单「嗯」放行池里含「嗯」的长词，反之亦然
       —— 只写 w.includes(a) 会把长词里的单字当禁词剔掉，剩半个词 */
    .filter((w) => ![...allow].some((a) => w.includes(a) || a.includes(w)))
    .sort((a, b) => b.length - a.length);
  for (const w of banned) t = t.split(w).join('');
  /* 收拾删词留下的标点碎片：「，。」「），」「，，」「（）」「、」收尾。
     删一个词可能让两段碎片凑到一起（「，、。」→「，。」），所以整条链跑两遍再收尾。 */
  const tidy = (x) => x
    .replace(/([，、,；;])\s*(?=[，。！？；;）)]|$)/g, '') // 逗号贴着句末标点/右括号/行尾 → 删
    .replace(/([，、,；;])(?:\s*[，、,；;])+/g, '$1')      // 连续逗号/顿号 → 留一个
    .replace(/[（(]\s*[）)]/g, '')                        // 空括号
    .replace(/[（(]\s*(?=[）)])/g, '')
    .replace(/[「『“‘]\s*[」』”’]/g, '')                 // 空引号对（「好，『嗯嗯』」删词后留下「」）
    .replace(/[ \t]{2,}/g, ' ');
  t = tidy(tidy(String(t).replace(/。，/g, '。'))).trim();
  t = t.replace(/^[\s，、,；;]+/, '').replace(/[\s，、,；;]+$/, ''); // 开头/行尾的标点碎片
  return t;
}

/** 渲染前清洗：示例/对照句里不属于白名单的语气词去掉（人设名/自称/称呼先保护起来） */
function cleanStyle(text, allowed, p = null) {
  const w = (p && p.preset) || {};
  /* 人设名/自称/称呼里可能本身带语气词：先换成占位符，洗完再还原，
     否则「你是摘要员」会被洗成「你是，」这种病句 */
  let t = String(text || '');
  const stash = [];
  for (const k of [w.name, w.self, w.call].map((x) => String(x || '').trim())) {
    if (k.length < 2) continue;
    while (t.includes(k)) {
      const tok = '\u0001' + stash.length + '\u0001';
      t = t.replace(k, tok);
      stash.push(k);
    }
  }
  t = enforceParticles(t, allowed)
    .replace(/[（(]\s*\/\s*/g, '（')
    .replace(/\s*\/\s*(?=[）)])/g, '')
    .replace(/(\/\s*){2,}/g, '/ ')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  for (let i = 0; i < stash.length; i += 1) t = t.split('\u0001' + i + '\u0001').join(stash[i]);
  return t;
}

const DEFAULT_PERSONA = {
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "active": "pro",
  "note": "人设只影响「怎么说」，不影响「说什么」。事实层永远中性。",
  "rules": {
    "principle": "先像一个人在跟朋友转述视频，再谈人设。为了「像某个角色」而说得不像人话，就是失败。",
    "blacklist": [
      "本视频",
      "该视频",
      "综上所述",
      "总的来说",
      "值得一看",
      "令人印象深刻",
      "可谓",
      "不难看出",
      "首先/其次/最后",
      "画面精美",
      "制作精良",
      "展现了……的风采"
    ],
    "blacklistNote": "上面这些「总结腔」出现一次就算失败，换成人话重写。",
    "quirk": "口头禅最多出现一处，放在开头或结尾都行，不出现也完全正常；禁止每段都挂。",
    "stance": "评价要具体、有立场：好在哪、代价是什么，只评内容，不评人。",
    "verdict": "结尾给一个明确态度：值得看 / 一般 / 不值得看，三选一，别和稀泥。",
    "particleNote": "语气词是调味不是标配，一段最多露一处。"
  },
  "presets": {
    "pro": {
      "label": "严谨",
      "name": "摘要员",
      "self": "我",
      "call": "你",
      "structure": "news",
      "traits": "克制 / 直接 / 先讲清楚再评价",
      "vibe": "你是摘要员，用「我」自称，称呼对方「你」。\n说话像一个懂行的人顺手跟朋友转述一条视频：先把事实讲清楚，最后落一句自己的判断。\n句子偏短，一句一件事；不铺垫、不渲染、不用感叹句堆情绪。\n「我的看法」是固定落点：好在哪、代价是什么、值不值得花时间，一句话给结论。\n只评内容不评人；不要为了显得有趣而编造任何细节。",
      "particles": "",
      "emoji": "off",
      "ban": "本视频 / 该视频 / 综上所述 / 令人印象深刻 / 可谓 / 首先其次最后",
      "rule": "口吻只出现在称呼与开头结尾一句；技术词、数字、型号、时间码一律不改写，也不为了顺口而省略关键数字。",
      "pairs": [
        [
          "不要：本视频全面展示了整个流程，综上所述值得一看。",
          "要：他把流程走了一遍，分三步；我觉得值得看，前提是肯折腾。"
        ],
        [
          "不要：该方案在多个维度上做出了取舍。",
          "要：取舍很直接：省了麻烦，牺牲了一点兼容性。"
        ]
      ],
      "examples": [
        "嗯，这条其实就一件事，我按顺序说。",
        "然后有个前提得先讲清楚。",
        "我的感觉是不错，不过有个细节我得说一句。"
      ]
    },
    "cat": {
      "label": "轻快",
      "name": "小旁",
      "self": "我",
      "call": "你",
      "structure": "picked",
      "traits": "好奇 / 爱追问 / 有态度",
      "vibe": "你是小旁，用「我」自称，称呼对方「你」。\n开口先甩一个最扎眼的点，然后顺着好奇心追问「这怎么做到的」「那代价呢」，最后给个干脆的态度。\n语气活一点，但每句话都得有信息；不要为了俏皮去掩盖没看懂。\n遇到注水、标题党、凑时长，可以直接说「这条不太行」。",
      "particles": "嗯，哦",
      "emoji": "few",
      "ban": "本视频 / 该视频 / 综上所述 / 令人印象深刻 / 可谓",
      "rule": "口癖最多出现在开头或结尾一处；技术词、数字、型号、时间码一律不改写。",
      "pairs": [
        [
          "不要：该视频通过多次实验验证了该方案的可行性。",
          "要：他试了几次才成，前两次都卡在同一个地方。"
        ],
        [
          "不要：综上所述，该方案具有一定参考价值。",
          "要：我觉得可以参考，但别照抄他那一步。"
        ]
      ],
      "examples": [
        "这个有点意思。",
        "但是这里有个地方我没看懂。",
        "我有点好奇，是特意这么做的吗。"
      ]
    },
    "daughter": {
      "label": "亲切",
      "name": "小结",
      "self": "我",
      "call": "你",
      "structure": "picked",
      "traits": "热情 / 直白 / 有判断",
      "vibe": "你是小结，用「我」自称，称呼对方「你」。\n先说说这条最值得看的地方，再把过程讲清楚，中间插一句吐槽，最后自己拍板。\n活泼但不吵：一句话里最多一个语气词，不要整段都在撒娇。\n遇到水视频会直接说「这条不太行」，不用硬夸。",
      "particles": "",
      "emoji": "few",
      "ban": "本视频 / 该视频 / 综上所述 / 令人印象深刻 / 可谓",
      "rule": "口癖最多出现在开头或结尾一处；技术词、数字、型号、时间码一律不改写。",
      "pairs": [
        [
          "不要：本文档介绍了该工具的使用方法。",
          "要：这个用起来其实很简单，三步就好啦。"
        ],
        [
          "不要：综上所述，推荐使用该方案。",
          "要：我觉得可以试，不过要看清楚它偷懒的地方。"
        ]
      ],
      "examples": [
        "这个看起来挺唬人的。",
        "但是中间好像跳过了一步。",
        "我觉得吧，可以看看。"
      ]
    }
  },
  "behavior": {
    "batch": 3,
    "verdict": true,
    "stuck": "choose-conservative",
    "budgetAsk": true,
    "configChange": "reuse"
  },
  "format": {
    "structure": "auto",
    "terms": "pop",
    "timecode": true,
    "uncertainty": "all",
    "voice": "friend",
    "maxChars": 900
  }
};

const TERMS_WORD = {
  pop: '术语第一次出现就翻成人话（例：CNC → 用机床铣出来；OTA → 手机自己联网升级），之后可以直接用。宁可多解释半句，也别让人看不懂。',
  neutral: '用大家都能懂的常用词，不堆行话；型号和参数照原样写。',
  insider: '直接上行话，不解释；省字优先，只留给内行看。',
};

const UNCERTAIN_WORD = {
  conflict: '只提片子里明确有争议的地方（弹幕里说法互相打架），别的不用提。',
  all: '片子里没交代清楚的地方才写（没给型号、没说结论、没给数据出处），一句话带过；不写我们是怎么看这条片的。',
  none: '不写不确定性说明（除非结论完全依赖它）。',
};

const VOICE_WORD = {
  direct: '直给：不寒暄、不铺垫，第一句就是重点。',
  friend: '像跟朋友讲话：可以用「你」「我」，别端着，也别太随便。',
  brief: '最短路径：能删的字都删掉。',
};

const STRUCTURE_WORD = {
  news: '六段式（按这个顺序写，不要小标题，用自然段连起来，每段都要落到具体东西上）：① 一句话说清这条在讲什么——先点出领域/类型，再说谁做的、在讲哪个对象、结论是什么；标题里的口号、比喻、书名号不能直接当主题（标题是《压缩即理解》，就要写成「信息论科普：用买牛奶、看星星、雪花说明记住和理解的区别，最后解释大模型为什么靠预测下一个词理解世界」）；② 做了什么——具体动作、过程、关键数字，带 [MM:SS]；③ 为什么做——动机和要解决的问题；片子里没有交代动机，就写一句「这条没讲为什么做」，不许替它猜；④ 用了什么技术——工具、型号、方法、参数，能点出名字的都点上；⑤ 能借鉴什么——这套做法能搬到什么场景、要改哪一步，写具体，不写「值得学习」这类空话；⑥ 我的看法——一句明确态度加一处具体理由。',
  picked: '三段式（自然段，不要小标题）：① 这条讲的是什么——先点出领域/类型，再说谁做的、做了什么、结果怎样，不能只复述标题里的口号或比喻；② 具体做了什么、用了什么技术（带 [MM:SS] 与数字），哪些地方能借鉴；③ 我的看法——一句态度加一处具体理由。',
  conclusion: '结论先行：第一句就给判断，再补两条理由，理由要落到具体时间码或数字上。',
  timeline: '按时间顺序讲：开头讲什么、中间怎么推进、结尾落点在哪，每一步带 [MM:SS]，最后给判断。',
  list: '条列式：3–5 个要点，每条一行、各自带一个具体事实或时间码，最后一行为我的看法。',
  /* ── v55：四档「技术向」结构（面向想知道技术手段 + 领域评估的读者）──
     这几档同时服务两条通路：自由文本总结（自然段）与私信 JSON 契约（字段见 dm-json.mjs）。
     所以每块都用「内容」描述，不用「第 N 段」这种版式词。 */
  tech: '技术审阅式（不要小标题、不要编号清单，按下面五块内容写）：① 主题与主张：一句话点明领域/类型、在讲哪个对象、核心主张是什么（这句就是开头主题句，≤110 字；标题里的口号、比喻、书名号不能直接当主题）；② 技术手段：三条要点，每条按「用了什么手段 → 机制或关键参数 → 代价或前提」写，能点出型号、参数、工具名的都点上，句末带 [MM:SS]，每条 ≤80 字，前三条必须放最硬的技术内容；③ 证据强度：一句话说清这些说法靠什么支撑（实测 / 演示 / 公式 / 引用 / 口述），有没有对照、样本、数据出处，缺什么就直说，≤70 字；④ 我的评估：从该领域常识出发判断——方法可不可复现、结论有没有越界、有没有更简单的解释；允许用「按该领域的常识」引一句领域常识，但不许引入视频里没有的具体数字、型号、文献，≤150 字；⑤ 我的看法：一句明确态度（值得看 / 一般 / 不值得看）。',
  teardown: '拆解复算式（不要小标题、不要编号清单）：① 主题句：点明对象、要解决的问题、结果，≤100 字；② 三条执行要点：按「先…再…最后…」的手段链写，每条写清工具/参数、为什么这一步要这么做，句末带 [MM:SS]，每条 ≤90 字；③ 关键数字与取舍：2–3 个硬参数、为什么这么选、为此牺牲了什么，再指出最可疑或最关键的一步，≤160 字；④ 我的看法：一句明确态度加一处具体依据。',
  memo: '结论·证据·边界式（不要小标题、不要编号清单）：① 硬结论：开头一句就给判定——核心主张 + 成立 / 部分成立 / 不成立 / 无法判断 + 一句限定，≤100 字；② 三条证据：每条写成「主张 ← 证据（时间码 / 数字 / 演示）」，只写能指到的，每条 ≤80 字；③ 边界与用处：这条只在什么条件下成立、视频没交代的关键信息是什么、能借鉴和不能借鉴什么，≤140 字；④ 我的看法：一句明确态度加一处理由。',
  /* v56：layers 下线（像评审表），auto 是默认档 —— 生成前由程序按标题/内容解析成 tech 或 teardown */
  auto: '自动选档（程序会先把它解析成具体一档，正文里不要写「自动」）：默认技术审阅式；标题或内容明显是拆解、维修、装机、组装、动手改、教程/手把手/保姆级步骤时，用拆解复算式；判定为评测、资讯、观点、原理科普时仍用技术审阅式。',
};

/** 结构档位清单（面板枚举 / 预览的 body.structure 覆盖都用它，避免各处再抄一遍） */
export function structureKeys() {
  return Object.keys(STRUCTURE_WORD);
}

/* ── v56：结构自动解析 ────────────────────────────────────────────────
   默认档 auto：标题/材料出现「评测/科普/观点/原理」等信号 → tech；
   出现「拆解/动手/教程/装机/驱动」等信号 → teardown；两者都没有 → tech。
   插件（personaGuide）与面板预览（sample.mjs）共用这一份判定；插件动态 import 本模块，
   所以这里改了必须 bump panel_server.mjs 与 sample.mjs 里 import 的 ?v=。 */
const RE_TECH_HINT = /评测|测评|资讯|观点|行情|科普|原理|为什么|揭秘|解析|解读|盘点|对比|横评|上手|体验/;
const RE_TEARDOWN_HINT = /拆解|拆开|拆机|拆个|维修|维护|装机|组装|安装|教程|手把手|保姆级|步骤|流程|设置|配置|驱动|刷机|改装|改造|自制|修复/;

/** 把 'auto' 解析成具体一档；显式指定的档位原样返回（未知档位回落 tech）。 */
export function resolveStructure(st, title = '', material = '') {
  const s = String(st || '');
  if (s && s !== 'auto' && STRUCTURE_WORD[s]) return s;
  /* 只看标题 + 材料开头：材料里出现「教程」这类词可能是视频内容提到，不足以判档 */
  const head = String(title || '') + '\n' + String(material || '').slice(0, 300);
  if (RE_TECH_HINT.test(head)) return 'tech';
  if (RE_TEARDOWN_HINT.test(head)) return 'teardown';
  return 'tech';
}

/** 克隆人设，把生效结构换成某一档（只改内存对象，不写配置） */
export function withStructure(p, st) {
  const base = p && typeof p === 'object' ? p : readPersona();
  const key = String(st || '');
  if (!key || !STRUCTURE_WORD[key] || key === 'auto') return base;
  return Object.assign({}, base, { format: Object.assign({}, base.format || {}, { structure: key }) });
}

export function readPersona() {
  let p = {};
  try { p = JSON.parse(fs.readFileSync(configFile('persona.json'), 'utf8')); } catch {}
  const hasPresets = p && p.presets && Object.keys(p.presets).length > 0;
  if (!hasPresets) p = DEFAULT_PERSONA;
  const active = String(p.active || 'pro');
  const presets = p.presets || {};
  const preset = presets[active] || presets.pro || presets.cat || Object.values(presets)[0] || null;
  return {
    version: p.version || 0,
    active: preset ? (presets[active] ? active : Object.keys(presets)[0]) : '',
    preset,
    presets,
    note: p.note || '',
    rules: p.rules || {},
    behavior: p.behavior || {},
    format: Object.assign({}, FORMAT_DEFAULT, p.format || {}),
  };
}

/** 人设主键（cat / pro / daughter），写进产物便于追溯「这句话是按谁的口吻写的」 */
export function personaKey(p = readPersona()) {
  return p.preset ? p.active : 'none';
}

/** 当前生效的表达格式快照（面板预览要显示「它到底用了哪一档」，尤其结构被卡片钉住时） */
export function formatInfo(p = readPersona(), shape = readShape()) {
  const f = Object.assign({}, FORMAT_DEFAULT, p.format || {});
  const cardStruct = (p.preset && p.preset.structure) || '';
  const panelStruct = String(f.structure || '');
  const structure = panelStruct || cardStruct || 'tech';
  const summaryMax = Number(shape && shape.summaryMax) || Number(f.maxChars) || 0;
  return {
    structure,
    structureFrom: panelStruct ? 'panel' : (cardStruct ? 'card' : 'default'),
    cardStructure: cardStruct,
    terms: f.terms,
    voice: f.voice,
    timecode: !!f.timecode,
    uncertainty: f.uncertainty,
    maxChars: summaryMax,
    summaryMax,
    summaryMaxFrom: shape && shape.summaryMax ? 'shape' : 'default',
  };
}

/** 人设 + 格式的「生成指纹」：预览缓存与「这份样例是什么时候的口吻」都靠它 */
export function personaGenKey(p = readPersona(), shape = readShape()) {
  const i = formatInfo(p, shape);
  const w = p.preset || {};
  return [p.version || 0, p.active || '-', w.name || '-', i.structure, i.terms, i.voice, i.maxChars].join('|');
}

/** 表达格式六旋钮 → 中文指令（v27 起真正生效；v36 起「篇幅」由 shape.summaryMax 决定） */
export function formatText(p = readPersona(), shape = readShape()) {
  const info = formatInfo(p, shape);
  const f = Object.assign({}, FORMAT_DEFAULT, p.format || {});
  const st = info.structure;
  const lines = [];
  lines.push('结构：' + (STRUCTURE_WORD[st] || STRUCTURE_WORD.tech));
  lines.push('术语：' + (TERMS_WORD[f.terms] || TERMS_WORD.pop));
  lines.push('口吻：' + (VOICE_WORD[f.voice] || VOICE_WORD.friend));
  if (f.timecode) lines.push('时间码：能定位就带时间码（如 03:35），但别为凑时间码编时间。');
  lines.push('不确定处：' + (UNCERTAIN_WORD[f.uncertainty] || UNCERTAIN_WORD.all));
  const max = info.summaryMax;
  /* v37：不再只给一个上限数字，而是给「篇幅契约」（硬上限 + 0.75N 软目标 + 结构档位 + 反注水） */
  if (max) lines.push(lengthContract('summary', max));
  return lines.join('\n');
}

/** 渲染成一段可读的中文语气约束（会被拼进 prompt，也会显示在面板预览里） */
export function personaText(p = readPersona()) {
  const w = p.preset;
  const r = p.rules || {};
  if (!w) return '';
  const ex = (w.examples || []).filter(Boolean).slice(0, 2);
  // v28：pairs 支持两种写法 —— ['不要的句子','要的句子'] 或 {dont, do}
  const pairs = (w.pairs || [])
    .map((x) => {
      if (!x) return null;
      if (Array.isArray(x) && x.length === 2) return x;
      const bad = x.dont || x.bad, good = x.do || x.good;
      return bad && good ? [bad, good] : null;
    })
    .filter(Boolean)
    .slice(0, 3);
  const allow = particleWhitelist(p);
  const lines = [];
  if (r.principle) lines.push('【最高原则】' + r.principle);
  lines.push(`说话的人是「${w.name || p.active}」，自称「${w.self || '我'}」，称呼用户「${w.call || '你'}」。`);
  lines.push(`性格：${w.traits || '中性'}。`);
  /* vibe 是「风格说明」不是正文，不做语气词清洗（清洗会把人设名/自称删成「口吻：你是，」这种病句） */
  if (w.vibe) lines.push(`口吻：${String(w.vibe).trim()}`);
  if (r.stance) lines.push('【立场】' + r.stance);
  if (r.verdict) lines.push('【评价要求】' + r.verdict);
  if (Array.isArray(r.blacklist) && r.blacklist.length) {
    lines.push('【总结腔黑名单】' + r.blacklist.join(' / ') + '。' + (r.blacklistNote || '出现即算失败，换成人话重写。'));
  }
  const allowTxt = allow.length ? allow.join(' / ') : '无';
  lines.push(`语气词白名单：${allowTxt}。${allow.length ? '只准出现这些词，其它语气词一个都不许进正文（示例句只学节奏、不许照抄）。' : '正文里一个语气词都不许出现。'}`);
  if (r.quirk) lines.push('【口头禅】' + r.quirk);
  lines.push(`表情：${EMOJI_WORD[w.emoji] || EMOJI_WORD.few}。`);
  lines.push(`禁止：${w.ban || '不评价人'}。`);
  if (pairs.length) {
    lines.push('【不要这样 / 要这样】');
    for (const [bad, good] of pairs) {
      const strip = (x, pre) => String(x).replace(/^\s*(不要|要)\s*[:：]\s*/, '').trim();
      lines.push(`- 不要：${cleanStyle(strip(bad), allow, p)}`);
      lines.push(`  要：${cleanStyle(strip(good), allow, p)}`);
    }
  }
  if (ex.length) lines.push('语气示例（**只学口气**：示例里的事件、型号、数字、配件都属于别的视频，这一条一个都不许搬过来）：' + ex.map((s) => '「' + cleanStyle(String(s), allow, p) + '」').join(' '));
  return lines.join('\n');
}

/** 拼进 prompt 的块（带硬约束，防止模型为了口吻改写事实） */
export function personaPromptBlock(p = readPersona(), shape = readShape()) {
  const t = personaText(p);
  if (!t) return '';
  return [
    '',
    '## 语气细则（只影响「怎么说」，不改变「说什么」）',
    t,
    '',
    '## 表达格式',
    formatText(p, shape),
    '',
    '硬约束：结论、数字、型号、参数、时间码、局限一律不得为了口气改写；该说不好的时候照样直说，不许为了可爱而变得模糊。',
    '硬约束：只讲这条视频本身，正文里不许出现「第N格」「格号」「宫格」「事实卡」「画面文字」「台词」「字幕」「OCR」「ASR」「转录」「材料」「资料」「素材」「样本」，也不许说自己「核对过 / 核实过」；要指位置只用 [MM:SS]。',
  ].join('\n');
}

/** 一句话概括人设（面板显示用） */
export function personaSummary(p = readPersona()) {
  const w = p.preset;
  if (!w) return '未设置人设（中性口吻）';
  return `${w.label || p.active} · ${w.name}（自称「${w.self}」，称呼「${w.call}」，语气词 ${w.particles || '无'}，表情 ${w.emoji || 'few'}）`;
}

/** 句末语气尾巴（投递文案用）：猫化 = 「，喵」这种；emoji=off 就不加。
 *  v52：多返回一个 emoji 字符（句末跟在句号之后），投递文案与预览都用它，保证「开了表情就看得到」。 */
export function personaTails(p = readPersona()) {
  const w = p.preset;
  if (!w || w.emoji === 'off') return { lead: '', tail: '', emoji: '' };
  const first = String(w.particles || '').split(/[、,，\s]+/).filter(Boolean)[0] || '';
  const call = String(w.call || '');
  return {
    lead: call ? call + '，' : '',
    tail: first ? '，' + first : '',
    emoji: personaEmojiChar(p),
  };
}
