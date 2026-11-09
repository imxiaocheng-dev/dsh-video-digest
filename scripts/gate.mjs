// 门禁：0 token 规则判断"这条值不值得再花 0.36 分钱上云端深度总结"
// 用法：node scripts/gate.mjs [BV...] | --all | --explain
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildFactcard } from './factcard.mjs';
import * as prefs from './lib/prefs.mjs';
import { DATA_ROOT } from './lib/paths.mjs';
import { badgeOf, zhOf, spendsMoney, ROUTES, isVodVia } from './lib/routes.mjs';
import { get as libGet } from './lib/library.mjs';

// 数据目录：产物/日志都走这里（旧布局下就是包根，本机行为不变）
const ROOT = DATA_ROOT;
const OUT = path.join(ROOT, 'out');
const GATE_LOG = path.join(ROOT, 'logs', 'gate.jsonl');

// 阈值集中放这里，方便以后在面板上暴露成可调项
const RULES_DEFAULT = {
  sampleRatio: 0.25,     // 灰区抽样比例
  lowDensity: 0.30,      // 密度低于此 + 事实少 + 无争议 => 否决
  lowFacts: 2,
  passFacts: 6,          // 事实够多 => 直接通过
  passDensity: 0.75,     // 密度很高 且（有争议 或 时长>=5min）=> 通过
  passDensityMinDur: 300,
  passDisputes: 3,       // 观众争议多 => 通过
  passPrefs: 0.8,        // 偏好命中强 => 通过
};

/** 阈值优先读 config/gate.json（面板可改），缺项回默认 */
function loadRules() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'gate.json'), 'utf8'));
    const out = { ...RULES_DEFAULT };
    for (const k of Object.keys(RULES_DEFAULT)) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = raw[k];
    return out;
  } catch { return { ...RULES_DEFAULT }; }
}

export const RULES = loadRules();

function hashRatio(bv) {
  const h = crypto.createHash('sha1').update('gate:' + bv).digest('hex').slice(0, 8);
  return parseInt(h, 16) / 0xffffffff;
}

/* 名单只在「读盘失败」时降级为空，不抛错：门禁不能因为配置坏了就罢工 */
function upLists() {
  try {
    const p = prefs.loadPrefs();
    return { white: prefs.upListOf(p, 'upWhite'), black: prefs.upListOf(p, 'upBlack') };
  } catch (e) {
    return { white: [], black: [] };
  }
}

export function gate(f, ctx = {}) {
  const reasons = [];
  /* v39：「点播源直接跑然后出总结推送」——inbound / manual / 面板点播 / 灰区点播
     是用户点名要看的，门禁只负责「自动选片值不值得花钱」，绝不能把点播片判成一般般/没意思而不写。
     所以点播源在这里直接短路成 pass-final，后面所有规则都不再参与（但 reasons 里写清是直通）。 */
  if (ctx.vod || isVodVia(ctx.via)) {
    reasons.push('点播源直通（不走自动门禁）');
    if (ctx.via) reasons.push(`来源 ${ctx.via}`);
    return { route: 'pass-final', reasons, score: 1, vod: true };
  }
  const d = f.duration || 0;
  const dens = f.infoDensity || 0;
  const facts = f.factCount || 0;
  const disp = (f.danmaku && f.danmaku.disputes) || 0;
  const pref = ctx.prefScore || 0;

  /* v29：UP 黑/白名单（真读 config/prefs.json，原来这两个名单只是面板弹窗里的演示）
     黑名单：判 skip，理由写明命中了谁（连候选都不该进，见名单卡说明）
     白名单：直接判 pass-final —— 用户点名要看的 UP，不再等打分 */
  const lists = upLists();
  const upName = String(f.up || (f.cost && f.cost.up) || '');
  const hitBlack = prefs.matchUpList(upName, lists.black);
  if (hitBlack) {
    reasons.push(`UP 黑名单「${hitBlack}」`);
    return { route: 'skip', reasons, score: 0 };
  }
  const hitWhite = ctx.whitelist ? '白名单' : prefs.matchUpList(upName, lists.white);
  if (hitWhite && !ctx.noWhitelist) {
    reasons.push(`UP 白名单「${hitWhite}」`);
    return { route: 'pass-final', reasons, score: 1 };
  }

  // 硬否决 → 没意思
  if (dens < RULES.lowDensity && facts < RULES.lowFacts && disp === 0) {
    reasons.push(`密度${dens}<${RULES.lowDensity} 且 事实${facts}<${RULES.lowFacts} 且 无争议`);
    return { route: 'skip', reasons, score: 0 };
  }
  if (d && d < 60 && facts < RULES.lowFacts) {
    reasons.push(`时长${Math.round(d)}s<60 且 事实${facts}<${RULES.lowFacts}`);
    return { route: 'skip', reasons, score: 0 };
  }

  // 硬通过 → 推荐看
  if (ctx.inbound) reasons.push('入站有人点名');
  if (ctx.whitelist) reasons.push('UP 白名单');
  if (facts >= RULES.passFacts) reasons.push(`事实${facts}≥${RULES.passFacts}`);
  if (dens >= RULES.passDensity && (disp >= 1 || d >= RULES.passDensityMinDur)) reasons.push(`密度${dens}≥${RULES.passDensity}`);
  if (disp >= RULES.passDisputes) reasons.push(`争议${disp}≥${RULES.passDisputes}`);
  if (pref >= RULES.passPrefs) reasons.push(`偏好命中${pref.toFixed(2)}≥${RULES.passPrefs}`);
  if (reasons.length) return { route: 'pass-final', reasons, score: 1 };

  // 灰区：按 bv 稳定抽样 → 抽中可以看，没抽中一般般
  const r = hashRatio(f.bv);
  const sampled = r < RULES.sampleRatio;
  reasons.push(`灰区(事实${facts} 密度${dens} 争议${disp}) · 抽样位 ${(r * 100).toFixed(0)}% ${sampled ? '→ 抽中上云' : '→ 先留本地'}`);
  return { route: sampled ? 'pass-sampled' : 'local-hold', reasons, score: 0.5 };
}

function prefScore(title, tag) {
  try {
    const c = prefs.compile(prefs.loadPrefs());
    return prefs.scoreText(c, { title: title || '', tag: tag || '' }).score || 0;
  } catch { return 0; }
}

function text(f, g) {
  const badge = badgeOf(g.route);
  const L = [];
  L.push(`${badge}  ${f.bv}  ${f.title}`);
  L.push(`  ${f.minutes ?? '?'}min · 密度 ${f.infoDensity} · 事实 ${f.factCount} · 争议 ${f.danmaku?.disputes ?? 0} · ${f.tokens ?? '?'} tok`);
  L.push(`  判据：${g.reasons.join('；') || '—'}`);
  if (f.localSummary) L.push(`  本地初判（未复核）：${f.localSummary.verdict || '—'}${f.localSummary.mark ? ' · ' + f.localSummary.mark : ''}`);
  return L.join('\n');
}


if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let bvs = args.filter(a => /^BV[0-9A-Za-z]{6,14}$/.test(a));
  const argVia = (args.find(a => a.startsWith('--via=')) || '').slice(6);
  if (args.includes('--all') || !bvs.length) {
    bvs = fs.readdirSync(OUT).filter(d => /^BV[0-9A-Za-z]{6,14}$/.test(d) && fs.existsSync(path.join(OUT, d, 'manifest.txt')));
  }
  const rows = [];
  for (const bv of bvs) {
    const f = buildFactcard(bv);
    /* v39：点播源（inbound/manual/panel/gray）不走自动门禁 —— via 优先取命令行，其次查台账 */
    let via = argVia;
    if (!via) { try { via = (libGet(bv) || {}).via || ''; } catch (e) { via = ''; } }
    const g = gate(f, { prefScore: prefScore(f.title), via });
    rows.push({ bv, route: g.route, reasons: g.reasons });
    try {
      fs.mkdirSync(path.join(OUT, bv), { recursive: true });
      fs.writeFileSync(path.join(OUT, bv, 'gate.json'), JSON.stringify({
        at: new Date().toISOString(), bv, route: g.route, routeZh: zhOf(g.route), reasons: g.reasons,
        score: g.score, vod: !!g.vod, via: via || undefined,
        factCount: f.factCount, infoDensity: f.infoDensity,
        cuts: f.cuts, danmaku: f.danmaku, tokens: f.tokens
      }, null, 2));
    } catch (e) { /* ignore */ }
    console.log('─'.repeat(72));
    console.log(text(f, g));
  }
  const count = rows.reduce((m, r) => (m[r.route] = (m[r.route] || 0) + 1, m), {});
  const zhCount = {};
  for (const [k, n] of Object.entries(count)) zhCount[zhOf(k)] = n;
  console.log('─'.repeat(72));
  console.log('分布：' + JSON.stringify(zhCount) + `　（共 ${rows.length} 条；只有「${ROUTES.filter(r => r.spend).map(r => r.zh).join('」「')}」会花云端的钱）`);
  const est = rows.filter(r => spendsMoney(r.route)).length;
  console.log(`本轮预计上云 ${est} 条 × 0.0036 元 ≈ ${(est * 0.0036).toFixed(4)} 元`);
  fs.mkdirSync(path.dirname(GATE_LOG), { recursive: true });
  fs.appendFileSync(GATE_LOG, rows.map(r => JSON.stringify({ at: new Date().toISOString(), ...r })).join('\n') + '\n');
}
