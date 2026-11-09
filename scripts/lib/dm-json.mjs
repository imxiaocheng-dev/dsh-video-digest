// 私信总结的「结构化 JSON」契约（v55）
//
// 背景：投递正文由 copy.mjs 的 buildDm 拼装（一段主题 + 最多 4 条要点 + 评估 + BV）。
// 生成侧如果只写自然段，技术细节常被压成 3 条、评估没有落点、「我的看法」只剩一个词。
// 所以新增一条 JSON 契约：模型按字段写（gist / bullets / mark / verdict / caveat / take / evidence），
// 再由 buildDm 统一渲染 —— 预览与正式生成共用同一份契约文本，避免「预览一套、投递另一套」。
//
// 只做两件事：产契约文本、解析模型返回的 JSON（带硬上限裁剪）。不读配置、不写文件。

const LIMIT = {
  gist: 240,     // 硬顶（prompt 目标 120）
  bullet: 120,   // 单条硬顶（prompt 目标 90）
  bullets: 6,    // 最多 6 条，但前 4 条才会进私信
  caveat: 60,
  take: 200,     // prompt 目标 180
  evidence: 4,
  comment: 200,
  mark: 12,
  verdict: 8,
};

/** 契约正文：system 段（稳定，可吃提示词缓存）。structure 由 personaPromptBlock 提供。 */
export function dmJsonContract(shape = null, opts = {}) {
  const sh = shape || {};
  const targetName = String((opts && opts.targetName) || '').trim() || '推送账号';
  const commentMax = Number(sh.commentMax) || 60;
  const dmMax = Number(sh.dmMax) || 860;
  const system = [
    '## 输出格式（必须是一个 JSON 对象，不是自然段）',
    '只输出一个 JSON 对象：不要 Markdown 代码块、不要解释、不要复述规则、不要写 BV 号。字段与硬上限：',
    '- gist：开头主题句（人话主题句），≤120 字（硬顶 240）。第一句必须说清领域/类型 + 讲哪个对象 + 核心主张；标题里的口号、比喻、书名号不能直接当主题（例如标题叫《压缩即理解》，要写成「这是信息论科普，讲的是…」，而不是复述标题）。',
    '- bullets：3–6 条字符串数组，每条 ≤90 字（硬顶 120）。内容与顺序按上面「结构」的要求写，不要套用固定的「做了什么→为什么→用了什么技术→能借鉴」顺序，不要小标题、不要编号。注意：**前 4 条会被直接发进私信**，所以最硬的技术内容必须放在前 4 条。型号、数字、单位只能逐字引自材料：不换算、不四舍五入、不补单位、不补型号尾号；材料只给系列名或模糊原话时就用系列名或原话，拿不准的细节宁可不写。绝对不许写我们是怎么看的（那由 take 与 verdict 承担）。',
    '- mark：一个时间码（mm:ss），照抄门禁结论里的重点时间。',
    '- verdict：照抄门禁结论（值得看 / 一般 / 不值得看），不要自己改判。',
    '- caveat：≤60 字，视频没交代清楚的地方（这条不进私信，只给面板看）。',
    '- take：≤180 字（硬顶 200），我的评估，**末句必须收在判断上**：先写判断依据（证据强度：实测/演示/公式/引用/口述；方法可不可复现；结论有没有越界；有没有更简单的解释），最后一句必须出现「值得看 / 一般 / 不值得看」三个词之一，并跟半句为什么。直接写正文，不要加「证据强度：」「我的评估：」这类标签，也不要小标题。允许写「按该领域的常识」，但不许出现视频里没有的具体数字、型号、文献，也不许把模糊原话换算成具体功率/电压/价格（例如原话没说「220V 两千多瓦」，就不能自己补）。',
    '- evidence：2–4 条字符串数组，每条带 [mm:ss] 的具体证据。',
    '- comment：固定留空字符串 ""（这条只生成私信，不发评论）。',
    '',
    '结构里各块与字段的对应：「主题与主张 / 主题句 / 硬结论 / 事实层」→ gist；「技术手段 / 执行要点 / 三条证据 / 三条技术细节」→ bullets；「证据强度 / 我的评估 / 关键数字与取舍 / 边界与用处 / 评估层」→ take；「我的看法」→ verdict。',
    `私信正文最终会由程序按字段拼装（称呼 + gist + 最多 4 条要点 + 值得看的一段 + 我的评估（末句就是判断）+ BV，≤${dmMax} 字），所以字段之间不要重复同一句话；判断只写在 take 的末句，不要再单独写一行「我的看法」。`,
    '过程说明一律不写：不要括注「（口播原意）」「（原话）」「（大意）」，不要写「视频里说」「画面写着」这类取证腔；直接给内容。',
    `评论这条这次不写；如果写也别超过 ${commentMax} 字、开头必须是 @${targetName}。`,
  ].join('\n');
  const tail = () => '现在按上面的结构与字段要求，只输出这一个 JSON 对象。';
  return { system, tail, targetName, commentMax, dmMax };
}

/** 从模型输出里抠出 JSON 并裁剪。失败返回 null（由调用方决定重试/报错）。
 *  v55b：模型偶尔会写两遍 / 追加解释（「等等，我需要输出纯 JSON」），所以不取首尾大括号，
 *  而是扫出所有「括号闭合的完整对象」，取第一个能解析且带 gist/bullets 的。 */
export function parseDmJson(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) { candidates.push(s.slice(start, i + 1)); start = -1; }
      }
    }
  }
  let o = null;
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v) && (v.gist || Array.isArray(v.bullets))) { o = v; break; }
    } catch (e) { /* 下一个候选 */ }
  }
  if (!o) {
    /* 兜底：剥掉 ``` 围栏后按首尾大括号再试一次（兼容带尾逗号之类的轻伤 JSON） */
    const t = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { o = JSON.parse(t.slice(a, b + 1)); } catch (e) { o = null; } }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const clip = (v, n) => {
    const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t;
  };
  const arr = (v, n, cap) => (Array.isArray(v) ? v.map((x) => clip(x, cap)).filter(Boolean).slice(0, n) : []);
  const markRaw = String(o.mark || '');
  const mm = /(\d{1,2}:\d{2})/.exec(markRaw);
  const out = {
    gist: clip(o.gist, LIMIT.gist),
    bullets: arr(o.bullets, LIMIT.bullets, LIMIT.bullet),
    mark: mm ? mm[1] : clip(markRaw, LIMIT.mark),
    verdict: clip(o.verdict, LIMIT.verdict),
    caveat: clip(o.caveat, LIMIT.caveat),
    take: clip(o.take, LIMIT.take),
    evidence: arr(o.evidence, LIMIT.evidence, LIMIT.bullet),
    comment: clip(o.comment, LIMIT.comment),
  };
  if (!out.gist && !out.bullets.length) return null;
  return out;
}

export function dmFieldLimits() {
  return Object.assign({}, LIMIT);
}
