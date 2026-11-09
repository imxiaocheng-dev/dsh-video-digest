// 门禁档位 + 入队来源的「显示名」唯一真源（2026-11-02 用户拍板改名）
//
// 设计：JSON / 日志 / 代码里只存英文码（机器可读、稳定、可 grep），
//      面板与 CLI 只显示中文（人读）。旧数据里的老值（pass / gray-sampled / gray）
//      永远不改写，读取时通过 normalizeRoute() 映射到新码。
//
// 改名前后：
//   pass        → pass-final    推荐看   （硬通过，直接上云）
//   gray-sampled→ pass-sampled  可以看   （灰区抽中，上云）
//   gray        → local-hold    一般般   （灰区没抽中，留本地、不写）
//   skip        → skip          没意思   （硬否决，自动选片不再看）

export const ROUTES = [
  {
    code: 'pass-final', zh: '推荐看', legacy: ['pass'], spend: true, write: true,
    cond: '规则直接通过（事实够多 / 密度高 / 争议多 / 偏好强 / 白名单 / 入站点名）',
  },
  {
    code: 'pass-sampled', zh: '可以看', legacy: ['gray-sampled'], spend: true, write: true,
    cond: '灰区里按 bvid 哈希抽中（同一片结果可复现）',
  },
  {
    code: 'local-hold', zh: '一般般', legacy: ['gray'], spend: false, write: false,
    cond: '灰区但没抽中：不花钱、不写；手动点播仍可跑',
  },
  {
    code: 'skip', zh: '没意思', legacy: [], spend: false, write: false,
    cond: '硬否决（密度/事实/争议都不够，或时长太短且事实少）',
  },
];

const BY_CODE = new Map(ROUTES.map(r => [r.code, r]));
const ALIAS = new Map();
for (const r of ROUTES) for (const old of r.legacy) ALIAS.set(old, r.code);

/** 老值 → 新码；未知值原样返回（容错，不炸） */
export function normalizeRoute(v) {
  if (!v) return v;
  const s = String(v);
  return ALIAS.get(s) || s;
}

/** 新码（或老值）→ 中文显示名；不认识就回原值 */
export function zhOf(v) {
  const code = normalizeRoute(v);
  const r = BY_CODE.get(code);
  return r ? r.zh : String(v ?? '');
}

export function routeMeta(v) {
  const code = normalizeRoute(v);
  return BY_CODE.get(code) || null;
}

/** 会不会花钱（未知值当不花钱，保守） */
export function spendsMoney(v) {
  const r = routeMeta(v);
  return !!(r && r.spend);
}

/** 给 /api/meta 下发给面板用的纯数据（面板不再硬编码中文） */
export function routeTable() {
  return ROUTES.map(r => ({
    code: r.code, zh: r.zh, legacy: r.legacy, spend: r.spend, write: r.write, cond: r.cond,
  }));
}

/** 面板/CLI 的短徽章：中文 + emoji（不含后缀，用户 2026-11-02 要求不加后缀） */
const BADGE = {
  'pass-final': '✅ 推荐看',
  'pass-sampled': '🎲 可以看',
  'local-hold': '⏸ 一般般',
  'skip': '⛔ 没意思',
};
export function badgeOf(v) {
  const code = normalizeRoute(v);
  return BADGE[code] || String(v ?? '');
}

// ── 入队来源（via）：用户点播直通，不进门禁 ─────────────────────────────
// inbound = 私信/@ 送进来的；manual/panel = 面板手动加；gray = 灰区里你手动捞起来的。
// 三者对门禁是同一件事：用户点播 → prio=1 强制跑。面板统一显示「点播源」，
// 底层 via 值保持不变（改了要迁移 videos 表 + 改 3 处判断，不值得）。
export const VOD_PASS = { code: 'vod-pass', zh: '点播源' };

const VOD_VIA = new Set(['inbound', 'manual', 'panel', 'gray']);

/** via → 来源显示；自动搜索来的（search:xxx）返回 null，交给调用方拼「自动 · xxx」 */
export function entryOf(via) {
  if (!via) return null;
  const v = String(via);
  if (VOD_VIA.has(v)) return { ...VOD_PASS };
  return null;
}

/** 是否属于"用户点播"（面板/CLI 统一判断，别再散落字符串数组） */
export function isVodVia(via) {
  return VOD_VIA.has(String(via || ''));
}
