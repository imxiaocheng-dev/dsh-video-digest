/**
 * runwindow.mjs —— 可跑时间段（v48）
 *
 * 数据模型（config/pacing.json 的 runWindow）：
 *   { mode: 'week'|'all'|'trough', week: { '0'..'6': [{from,to}] }, note }
 *   - week 键 0=周日，1=周一 …；值是该天的分钟区间数组 [from,to)
 *   - mode='week'：按 week 里的时段跑
 *   - mode='all'：全天可跑
 *   - mode='trough'：按价目表 config/pricing.json 算出的「API 谷时」跑；week 原样保留（切回 week 还在）
 *   - note 是后端自动生成的中文摘要，前端不写
 *
 * 旧的 trough:{on,from,to}（额外允许低谷小时）已删除：读取时若 on=true 且 mode='week'，
 * 把 [from,to) 并入每一天的区间；否则直接丢弃（写盘后不再出现该字段）。
 * 旧形状（mode='blackout' + blockedHours 等）同样在读取时自动迁移，不写盘、不报错。
 * 谷时唯一真源 = config/pricing.json（本文件只做纯计算，不读文件）。
 * panel_server 与 runner 复用同一套判定。
 */

export const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DEFAULT_RANGE = { from: 300, to: 1440 }; // 05:00–24:00（原默认 0–5 点不跑）
const DAY_FULL = { from: 0, to: 1440 };

/* pricing.json 缺失/坏 JSON 时的内置兜底高峰：09:00–12:00、14:00–18:00 + 工作日 */
const FALLBACK_PEAKS = [{ from: 540, to: 720 }, { from: 840, to: 1080 }];
const FALLBACK_DAYS = [1, 2, 3, 4, 5];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');
function hhmm(min) {
  const m = Math.max(0, Math.min(1440, Math.round(Number(min) || 0)));
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}
function int0to24(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(24, Math.round(n)));
}
function emptyWeek() {
  const w = {};
  for (let d = 0; d <= 6; d++) w[String(d)] = [];
  return w;
}
function defaultRunWindow() {
  const week = emptyWeek();
  for (let d = 0; d <= 6; d++) week[String(d)] = [{ ...DEFAULT_RANGE }];
  return { mode: 'week', week };
}

/** 归一化一天的分钟区间：0–1440、from<to、排序+合并相邻/重叠、最多 8 段、非法丢弃 */
function normRanges(arr) {
  const raw = [];
  if (Array.isArray(arr)) {
    for (const x of arr) {
      if (!isObj(x)) continue;
      const from = Math.round(Number(x.from));
      const to = Math.round(Number(x.to));
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const a = Math.max(0, Math.min(1440, from));
      const b = Math.max(0, Math.min(1440, to));
      if (!(a < b)) continue;
      raw.push({ from: a, to: b });
    }
  }
  raw.sort((p, q) => (p.from - q.from) || (p.to - q.to));
  const out = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: r.to });
  }
  return out.slice(0, 8);
}
function normWeek(week) {
  const w = emptyWeek();
  for (let d = 0; d <= 6; d++) {
    const day = Array.isArray(week) ? week[d] : (isObj(week) ? week[d] : undefined);
    w[String(d)] = normRanges(day);
  }
  return w;
}
/** 旧 blockedHours → 允许的整点小时 → 连续小时合并成分钟区间 */
function hoursToRanges(hours) {
  const out = [];
  let start = null, prev = null;
  for (const h of hours) {
    if (start === null) { start = h; prev = h; continue; }
    if (h === prev + 1) { prev = h; continue; }
    out.push({ from: start * 60, to: (prev + 1) * 60 });
    start = h; prev = h;
  }
  if (start !== null) out.push({ from: start * 60, to: (prev + 1) * 60 });
  return out;
}
/** 把旧 trough 的小时段并进每一天（迁移用） */
function mergeRangeIntoWeek(week, from, to) {
  const w = normWeek(week);
  if (!(from < to)) return w;
  for (let d = 0; d <= 6; d++) {
    const arr = (w[String(d)] || []).slice();
    arr.push({ from, to });
    w[String(d)] = normRanges(arr);
  }
  return w;
}

/**
 * 旧形状 → 新形状；新形状原样返回。纯函数，不写盘。
 * - mode 'trough' → 保留 week，丢弃旧 trough 字段
 * - mode 'week' + 旧 trough.on=true → [from,to) 并进每一天（保持行为）
 * - mode 'all-day' / 'whitelist' → mode 'all'
 * - mode 'blackout' + blockedHours → 七天都取「0..23 去掉 blocked」的连续区间
 * - blockedHours 为空 / 缺失 → mode 'all'
 * - 完全缺失 → 默认（week，七天 05:00–24:00）
 */
export function migrateRunWindow(rw) {
  if (!isObj(rw)) return defaultRunWindow();
  const mode = String(rw.mode || '');
  if (mode === 'trough') return { mode: 'trough', week: rw.week };
  if (mode === 'week') {
    let week = rw.week;
    const t = isObj(rw.trough) ? rw.trough : null;
    if (t && t.on === true) {
      const from = int0to24(t.from, 0);
      let to = int0to24(t.to, 8);
      if (to <= from) to = 24;
      week = mergeRangeIntoWeek(week, from * 60, to * 60);
    }
    return { mode: 'week', week };
  }
  if (mode === 'all') return { mode: 'all', week: rw.week };
  if (mode === 'all-day' || mode === 'whitelist') return { mode: 'all', week: emptyWeek() };
  const blocked = Array.isArray(rw.blockedHours)
    ? Array.from(new Set(rw.blockedHours.map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23))).sort((a, b) => a - b)
    : null;
  if (!blocked || blocked.length === 0) return { mode: 'all', week: emptyWeek() };
  const bs = new Set(blocked);
  const allowed = [];
  for (let h = 0; h < 24; h++) if (!bs.has(h)) allowed.push(h);
  const ranges = hoursToRanges(allowed);
  const week = emptyWeek();
  for (let d = 0; d <= 6; d++) week[String(d)] = ranges.map(r => ({ ...r }));
  return { mode: 'week', week };
}

/** 归一化内部形状（先迁移）：mode 合法化 + week 归一；不含 note、不含 trough */
function coreNormalize(rw) {
  const m = migrateRunWindow(rw);
  const mode = m.mode === 'all' ? 'all' : (m.mode === 'trough' ? 'trough' : 'week');
  return { mode, week: normWeek(m.week) };
}

/* ── 价目表 → 谷时（唯一真源 config/pricing.json；这里只算，不读文件） ── */

function parseHm(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 24 || !Number.isInteger(mi) || mi < 0 || mi > 59) return null;
  const v = h * 60 + mi;
  return v >= 0 && v <= 1440 ? v : null;
}

/**
 * 解析价目表的峰谷定义（非法项丢弃；pricing 缺失/坏 → 内置兜底高峰 + 工作日）。
 * 返回 { peaks:[{from,to}], days:[0..6], sourceLabel, updatedAt, noPeak }
 * noPeak=true 表示「全程谷时」（peakMultiplier≤1 或没有有效高峰）。
 */
function pricingInfo(pricing) {
  const src = isObj(pricing) ? pricing : null;
  const sourceLabel = src && typeof src.sourceLabel === 'string' && src.sourceLabel.trim() ? src.sourceLabel.trim() : '';
  const updatedAt = src && typeof src.updatedAt === 'string' ? src.updatedAt : null;
  const mult = src ? Number(src.peakMultiplier) : NaN;
  if (src && (!Number.isFinite(mult) || mult <= 1)) {
    return { peaks: [], days: [], sourceLabel, updatedAt, noPeak: true };
  }
  let peaks = [];
  if (src && Array.isArray(src.peakHours)) {
    for (const pair of src.peakHours) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const a = parseHm(pair[0]), b = parseHm(pair[1]);
      if (a === null || b === null || !(a < b)) continue;
      peaks.push({ from: a, to: b });
    }
  }
  if (!peaks.length) {
    if (src) return { peaks: [], days: [], sourceLabel, updatedAt, noPeak: true };
    peaks = FALLBACK_PEAKS.map(r => ({ ...r }));
  }
  peaks = normRanges(peaks);
  let days = FALLBACK_DAYS.slice();
  if (src && Array.isArray(src.peakDays)) {
    const valid = Array.from(new Set(src.peakDays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6)));
    if (valid.length) days = valid;
    else if (src.peakDays.length === 0) days = [];
  }
  return { peaks, days, sourceLabel, updatedAt, noPeak: false };
}

/** [0,end) 减去 peaks 后的补集（升序、已合并） */
function complementOf(peaks, end = 1440) {
  const out = [];
  let cur = 0;
  for (const r of peaks) {
    if (r.from > cur) out.push({ from: cur, to: r.from });
    if (r.to > cur) cur = r.to;
  }
  if (cur < end) out.push({ from: cur, to: end });
  return out;
}

/** 七天各自的谷时区间（第 2 节算法）；某天不在 peakDays → 全天 */
export function troughWeek(pricing = null) {
  const info = pricingInfo(pricing);
  const w = emptyWeek();
  for (let d = 0; d <= 6; d++) {
    const inPeakDay = !info.noPeak && info.days.includes(d);
    w[String(d)] = inPeakDay ? complementOf(info.peaks) : [{ ...DAY_FULL }];
  }
  return w;
}

function rangesText(ranges) {
  const arr = Array.isArray(ranges) ? ranges : [];
  if (arr.length === 1 && arr[0].from === 0 && arr[0].to === 1440) return '全天';
  if (!arr.length) return '不跑';
  return arr.map(r => hhmm(r.from) + '–' + hhmm(r.to)).join('、');
}
function eqSet(days, target) {
  return days.length === target.length && target.every(d => days.includes(d));
}
function dayLabel(days) {
  if (days.length === 7) return '每天';
  if (eqSet(days, [1, 2, 3, 4, 5])) return '工作日';
  if (eqSet(days, [0, 6])) return '周末';
  return DAY_ORDER.filter(d => days.includes(d)).map(d => WEEK_ZH[d]).join('、');
}
function isAllDayWeek(w) {
  for (let d = 0; d <= 6; d++) {
    const r = w[String(d)] || [];
    if (!(r.length === 1 && r[0].from === 0 && r[0].to === 1440)) return false;
  }
  return true;
}
function groupDays(week) {
  const map = new Map();
  for (const d of DAY_ORDER) {
    const key = JSON.stringify(week[String(d)] || []);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }
  const groups = Array.from(map.entries()).map(([key, days]) => ({ days, ranges: JSON.parse(key) }));
  const rank = (g) => {
    if (eqSet(g.days, [1, 2, 3, 4, 5])) return 0;
    if (eqSet(g.days, [0, 6])) return 1;
    if (g.days.length === 7) return 2;
    return 3 + DAY_ORDER.indexOf(g.days[0]);
  };
  groups.sort((a, b) => rank(a) - rank(b));
  return groups;
}
function troughNote(week) {
  if (isAllDayWeek(week)) return '按 API 低谷：全天（价目表没有高峰时段）';
  return '按 API 低谷：' + groupDays(week).map(g => dayLabel(g.days) + ' ' + rangesText(g.ranges)).join('；');
}

/**
 * 价目表谷时信息（GET /api/pacing 顶层 apiTrough，前端据此渲染/锁定时段）。
 * 返回 { week, peakHours:[[fromMin,toMin]...], peakDays, sourceLabel, updatedAt, note, allDay }
 */
export function apiTroughInfo(pricing = null) {
  const info = pricingInfo(pricing);
  const week = troughWeek(pricing);
  return {
    week,
    peakHours: info.peaks.map(r => [r.from, r.to]),
    peakDays: info.noPeak ? [] : info.days.slice(),
    sourceLabel: info.sourceLabel || '内置兜底（价目表缺失）',
    updatedAt: info.updatedAt || null,
    note: troughNote(week),
    allDay: isAllDayWeek(week),
  };
}

function describeWeekText(n) {
  const fmtRanges = (arr) => (arr || []).map(r => hhmm(r.from) + '–' + hhmm(r.to)).join('、');
  const same = [0, 1, 2, 3, 4, 5, 6].every(d => JSON.stringify(n.week[String(d)]) === JSON.stringify(n.week['0']));
  if (same) {
    const txt = fmtRanges(n.week['0']);
    return txt ? '每天 ' + txt : '全天不跑';
  }
  const dayTexts = DAY_ORDER
    .map(d => ({ d, txt: fmtRanges(n.week[String(d)]) }))
    .filter(x => x.txt);
  if (!dayTexts.length) return '全天不跑';
  return '自定义：' + dayTexts.map(x => WEEK_ZH[x.d] + ' ' + x.txt).join('；');
}
function describeCore(n, pricing) {
  if (n.mode === 'all') return '全天可跑';
  if (n.mode === 'trough') return troughNote(troughWeek(pricing));
  return describeWeekText(n);
}

/** 归一化后的新形状（带自动生成的 note；不含旧 trough 字段） */
export function normalizeRunWindow(rw, pricing = null) {
  const n = coreNormalize(rw);
  n.note = describeCore(n, pricing);
  return n;
}

/** 中文摘要（week：每天 05:00–24:00 / trough：按 API 低谷：工作日 …；周末 全天） */
export function describeRunWindow(rw, pricing = null) {
  return describeCore(coreNormalize(rw), pricing);
}

/**
 * 当前时刻是否允许自动抓取/自动跑片；date 省略=现在。
 * mode='trough' 时用价目表算出的当天谷时判定，其它 mode 逻辑不变。
 */
export function windowAllows(rw, date = new Date(), pricing = null) {
  const n = coreNormalize(rw);
  if (n.mode === 'all') return true;
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return true;
  const mins = dt.getHours() * 60 + dt.getMinutes();
  const week = n.mode === 'trough' ? troughWeek(pricing) : n.week;
  const ranges = week[String(dt.getDay())] || [];
  return ranges.some(r => mins >= r.from && mins < r.to);
}
