// 选片：按偏好词表给候选排序（纯本地计算，0 token），并剔除已看库里的视频。
// 用法：
//   node scripts/pick.mjs                     # 用 prefs 里的正向词去搜索
//   node scripts/pick.mjs --query=示波器,AI    # 临时指定查询词
//   node scripts/pick.mjs --limit=15 --pages=2
//   node scripts/pick.mjs --order=pubdate --max-age-days=30   # 按发布时间取最近 30 天（默认）
//   node scripts/pick.mjs --mark=BV1xx,BV1yy   # 把指定候选标记为已看
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, CODE_ROOT, ensureData } from './lib/paths.mjs';

// 数据目录：产物/配置写这里（旧布局下就是包根，本机行为不变）
ensureData();
const ROOT = DATA_ROOT;
const bili = await import(pathToFileURL(path.join(CODE_ROOT, 'scripts', 'lib', 'bili.mjs')).href);
const prefsLib = await import(pathToFileURL(path.join(CODE_ROOT, 'scripts', 'lib', 'prefs.mjs')).href);
const lib = await import(pathToFileURL(path.join(CODE_ROOT, 'scripts', 'lib', 'library.mjs')).href);

const arg = (k, d = '') => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const limit = Number(arg('limit', '12'));
const pages = Number(arg('pages', '1'));
const markArg = arg('mark');
// 时长窗：默认 3–40 分钟（宫格方案对超长片单位成本高、对超短片信息量不足）
const minSec = Number(arg('min', '180'));
const maxSec = Number(arg('max', '2400'));
const perUp = Number(arg('per-up', '2'));
/* v46：搜索排序默认按发布时间（原来写死 click=按播放量，返回的都是几年前的老片，
   候选集合几天就与已看库全重合 → 每轮 pick 0 条）。--order= 仍可覆盖。 */
const order = String(arg('order', 'pubdate') || 'pubdate');
/* v46：发布时间窗（天）。pubdate>0 且超龄 → 剔除并计入 ageFiltered；pubdate 缺失不拦。 */
const maxAgeDays = Number(arg('max-age-days', '30'));

const prefs = prefsLib.loadPrefs();
const c = prefsLib.compile(prefs);
// v45：优先用类目的搜索词 queries；没有 queries 的类目回落类目名（见 prefs.searchQueries）
/* v46：搜索词清洗 —— `/ + | 、 ，` 换成空格 → 压空格/trim → 去空 → 大小写不敏感去重 → 最多 3 个；
   生产类目名里的「DIY/拆解」直接当搜索词恒 0 结果，必须切开。超出的记进 queriesDropped。 */
function cleanSearchQueries(raw) {
  const src = (Array.isArray(raw) ? raw : []).map(x => String(x == null ? '' : x));
  const out = [];
  const seen = new Set();
  for (const s0 of src) {
    const s = s0.replace(/[\/+|、，]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  const kept = out.slice(0, 3);
  return { queries: kept, queriesDropped: src.length - kept.length };
}
const _rawQueries = arg('query') ? arg('query').split(',') : prefsLib.searchQueries(c);
const { queries, queriesDropped } = cleanSearchQueries(_rawQueries);

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '');
const cands = new Map();
let fetched = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let searched = 0;
const failed = [];
/* 一次搜索请求；失败最多重试 2 次。
   412 时 bili.mjs 会回「风控冷却中，还需 Ns」——按它给的秒数等（上限 60+1s），别硬撞冷却；
   解析不出来再等 8s。词/页之间的 6s+抖动放在下面循环里。 */
async function searchOnce(q, p) {
  const r = await bili.api('/x/web-interface/search/type',
    { search_type: 'video', keyword: q, page: p, page_size: 20, order }, { sign: true });
  return r?.data?.result || [];
}
async function searchWithRetry(q, p) {
  let err = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return { ok: true, items: await searchOnce(q, p) };
    } catch (e) {
      err = String((e && e.message) || e);
      if (attempt === 2) break;
      const m = err.match(/还需\s*(\d+)\s*s/i);
      const waitMs = m ? (Math.min(Number(m[1]), 60) + 1) * 1000 : 8000;
      console.log(`[搜索] "${q}" p${p} 失败：${err} → ${Math.round(waitMs / 1000)}s 后重试（${attempt + 1}/2）`);
      await sleep(waitMs);
    }
  }
  return { ok: false, items: [], err };
}

let reqIdx = 0;
const totalReq = queries.length * pages;
for (const q of queries) {
  for (let p = 1; p <= pages; p++) {
    reqIdx++;
    const res = await searchWithRetry(q, p);
    let items = [];
    if (res.ok) {
      searched++;
      items = res.items;
      console.log(`[搜索] "${q}" p${p} → ${items.length} 条`);
    } else {
      failed.push({ q, err: res.err });
      console.log(`[搜索] "${q}" p${p} 失败：${res.err}`);
    }
    for (const it of items) {
      if (it?.type && it.type !== 'video') continue;
      const bvid = it.bvid;
      if (!bvid) continue;
      fetched++;
      if (cands.has(bvid)) continue;
      cands.set(bvid, {
        bvid,
        title: strip(it.title),
        author: it.author || '',
        tag: strip(it.tag || ''),
        tname: strip(it.tname || it.typename || ''),
        tid: it.tid ?? null,
        tid_v2: it.tid_v2 ?? null,
        desc: strip(it.description || ''),
        dur: bili.dur2sec(it.duration),
        play: Number(it.play) || 0,
        danmaku: Number(it.video_review) || 0,
        like: Number(it.like) || 0,
        pubdate: Number(it.pubdate) || 0,
        via: `search:${q}`,
      });
    }
    /* 词/页之间 6000ms + 0–1500ms 抖动；最后一个请求后不再等 */
    if (reqIdx < totalReq) await sleep(6000 + Math.floor(Math.random() * 1501));
  }
}

// 剔已看库 + 时长窗 + 发布时间窗
let seenFiltered = 0, durFiltered = 0, ageFiltered = 0;
const list = [];
for (const v of cands.values()) {
  if (lib.isKnown(v.bvid)) { seenFiltered++; continue; }
  if (v.dur < minSec || v.dur > maxSec) { durFiltered++; continue; }
  /* v46：pubdate>0 且年龄 > maxAgeDays 天 → 剔除；pubdate 缺失不拦（有些条目没给发布时间） */
  if (v.pubdate > 0 && (Date.now() / 1000 - v.pubdate) > maxAgeDays * 86400) { ageFiltered++; continue; }
  // 两个分：标题/标签分（作者自己写的，最能代表"这片是什么"）与全量分（含简介）；外加分区小幅加减
  const t = prefsLib.scoreText(c, { title: v.title, tag: v.tag });
  const a = prefsLib.scoreText(c, { title: v.title, tag: v.tag, desc: v.desc });
  const rBoost = prefsLib.regionBoost(c, v.tname);
  // 弹幕密度：对数刻度，封顶 +0.4（线性封顶会让所有候选都吃到满加成=等于没有）
  const dmPerMin = v.dur ? v.danmaku / (v.dur / 60) : 0;
  const dmBoost = +Math.min(0.4, 0.12 * Math.log10(1 + dmPerMin)).toFixed(2);
  list.push({ ...v, dmPerMin, dmBoost, scoreTitle: t.score, scoreAll: a.score, rBoost, total: +(t.score + rBoost + dmBoost).toFixed(2), hits: a.hits, focus: prefsLib.focusLine(a.hits) });
}
// 排序：先看标题分+分区修正（避免简介里的词把一堆无关片子顶上来），再看全量分，最后看互动率
const engage = (v) => (v.play ? (v.like + v.danmaku * 2) / v.play : 0);
list.sort((x, y) => y.total - x.total || y.scoreAll - x.scoreAll || engage(y) - engage(x));

// 同一 UP 最多 perUp 条（避免一个号刷屏）
const upCount = new Map();
const picked = [];
for (const v of list) {
  const k = v.author || v.bvid;
  const n = upCount.get(k) || 0;
  if (n >= perUp) continue;
  upCount.set(k, n + 1);
  picked.push(v);
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
console.log(`\n查询 ${queries.length} 个词 × ${pages} 页 → 抓到 ${fetched} 条 · 去重后 ${cands.size} 条 · 已看库剔除 ${seenFiltered} · 时长窗外剔除 ${durFiltered} · 发布时间窗外剔除 ${ageFiltered} · 参与排序 ${list.length} 条\n`);
console.log('总分 标题 全量 分区修正 时长   播放    互动率 分区 / 匹配词                    标题');
console.log('─'.repeat(126));
for (const v of picked.slice(0, limit)) {
  const m = v.hits.map((h) => `${h.polarity === 'neg' ? '−' : ''}${h.label}(${h.contrib})`).join(' ');
  const e = v.play ? ((v.like + v.danmaku * 2) / v.play) * 100 : 0;
  const rg = v.rBoost ? `${v.tname || '?'}${v.rBoost > 0 ? '+' : ''}${v.rBoost}` : (v.tname || '—');
  console.log(`${String(v.total).padStart(5)} ${String(v.scoreTitle).padStart(4)} ${String(v.scoreAll).padStart(5)} ${String(v.rBoost).padStart(5)} ${mmss(v.dur).padStart(6)} ${String(v.play).padStart(7)} ${e.toFixed(2).padStart(5)}%  ${rg.slice(0, 12).padEnd(12)} ${v.title.slice(0, 26)}`);
  console.log(`      ↑ ${v.author} · ${v.bvid} · 弹幕${v.dmPerMin.toFixed(0)}/分(+${v.dmBoost}) · tags[${(v.tag || '').split(',').filter(Boolean).slice(0, 4).join('/')}] · ${v.focus}`);
}

// ── 入列：写进 videos 表（status=candidate），队列页读库不再读文件 ──
const pacing = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pacing.json'), 'utf8')); } catch { return {}; } })();
const D = Object.assign(
  { enabled: true, candidateWatermark: 10, dailyEnlist: 10, dailyEnlistMax: 20, autoMaxPending: 30 },
  pacing.dispatch || {},
);
D.dailyEnlist = Math.min(D.dailyEnlist, D.dailyEnlistMax);
const auto = process.argv.includes('--auto');
const dry = process.argv.includes('--dry');

const cnt = lib.counts();
const enlistedToday = lib.enlistedToday();
const candNow = cnt.by.candidate || 0;
let room = picked.length;
let capReason = '';
if (auto) {
  const byQuota = D.dailyEnlist - enlistedToday;
  const byWater = D.candidateWatermark - candNow;
  const byTotal = D.autoMaxPending - (cnt.pending || 0);
  room = Math.min(byQuota, byWater, byTotal);
  if (room <= 0) {
    capReason = byQuota <= 0 ? `今日入列配额已满 ${enlistedToday}/${D.dailyEnlist}`
      : byWater <= 0 ? `候选已达水位 ${candNow}/${D.candidateWatermark}`
      : `待处理已达上限 ${cnt.pending}/${D.autoMaxPending}`;
  }
}
const take = Math.max(0, Math.min(picked.length, room));
console.log(`[入列] 候选 ${picked.length} 条 · 本次入列 ${take} 条 · 今日已入列 ${enlistedToday}/${D.dailyEnlist} · 候选 ${candNow}/${D.candidateWatermark} · 待处理 ${cnt.pending || 0}/${D.autoMaxPending}${capReason ? ' → ' + capReason : ''}${auto ? '（自动）' : '（手动，不受 30 条限）'}`);

/* v46 观测：cand 文件顶层 stats 与最后一行 [搜集汇总] 同结构 */
const stats = {
  order, maxAgeDays, queries, queriesDropped,
  searched, failed,
  fetched, unique: cands.size,
  seenFiltered, durFiltered, ageFiltered,
  ranked: list.length, picked: picked.length,
  enlisted: dry ? 0 : take, took: take,
};
const outDir = path.join(ROOT, 'out', 'pick');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `cand-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), queries, count: picked.length, stats, list: picked.slice(0, 50) }, null, 1), 'utf8');
console.log(`\n候选证据已存 ${outFile}`);

if (dry) {
  console.log('[入列] --dry：不写库');
} else {
  for (const v of picked.slice(0, take)) {
    lib.mark({
      bvid: v.bvid,
      status: 'candidate',
      score: v.total,
      via: v.via,
      title: v.title,
      up: v.author,
      dur_sec: v.dur,
      play: v.play,
      danmaku: v.danmaku,
      tname: v.tname,
      extra: {
        tag: v.tag, desc: v.desc, like: v.like, pubdate: v.pubdate,
        dmPerMin: +v.dmPerMin.toFixed(1), dmBoost: v.dmBoost,
        scoreTitle: v.scoreTitle, scoreAll: v.scoreAll, rBoost: v.rBoost, total: v.total,
        hits: v.hits.map(h => ({ label: h.label, polarity: h.polarity, contrib: h.contrib })),
        focus: v.focus,
      },
    });
  }
  console.log(`[入列] 已写库 ${take} 条 → logs/library.db（status=candidate）`);
}

if (markArg) {
  for (const bvid of markArg.split(',').filter(Boolean)) {
    const v = cands.get(bvid);
    lib.mark({ bvid, status: 'seen', score: v?.score ?? null, via: 'pick:mark', title: v?.title || '', up: v?.author || '' });
    console.log(`[已看库] 标记 ${bvid}`);
  }
}

/* v46 契约：最后一行固定为 [搜集汇总] + 单行 JSON（panel_server 解析后写 logs/pick-last.json） */
console.log(`[搜集汇总] ${JSON.stringify(stats)}`);
