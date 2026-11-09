import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT, ensureData } from './lib/paths.mjs';
import { buildComment as buildCommentCopy, buildDm as buildDmCopy, readShape as readShapeCopy } from './lib/copy.mjs';
import { readPersona, personaKey } from './lib/persona-text.mjs';
// v52：私信发送抽成 lib（sender 与面板「收到后先回一句」共用同一实现；--send 才真发，DRY 行为不变）
import { sendDmText } from './lib/dm.mjs';

// 数据目录：凭证/台账/产物都写这里（旧布局下就是包根，本机行为不变）
ensureData();
const ROOT = DATA_ROOT;
const SECRETS = path.join(ROOT, 'secrets', 'bili.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LB = path.join(ROOT, 'logs', 'library.db');
const OB = path.join(ROOT, 'logs', 'outbound.db');

const args = process.argv.slice(2);
const DRY = !args.includes('--send');
const LIMIT = Number((args.find(a => a.startsWith('--limit=')) || '--limit=3').split('=')[1]) || 3;
const BVARG = (args.find(a => a.startsWith('--bv=')) || '').split('=')[1] || null;

const secret = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
const mid = String(secret.dede_user_id || secret.mid || '');
if (!secret.sessdata || !secret.bili_jct) { console.error('缺 cookie'); process.exit(1); }
const COOKIE = [
  'SESSDATA=' + secret.sessdata,
  'bili_jct=' + secret.bili_jct,
  'DedeUserID=' + mid,
  secret.buvid3 ? 'buvid3=' + secret.buvid3 : null,
].filter(Boolean).join('; ');

function openDb(file, init) {
  const isNew = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (init) init(db, isNew);
  return db;
}
/* ---------- 出站状态：评论压审自动暂停（连续 2 次查不到 → 暂停 24h） ---------- */
const STATE = path.join(ROOT, 'logs', 'outbound-state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (e) { return { consecutiveCommentMiss: 0, commentPausedUntil: null, dmAllowed: true, history: [] }; }
}
function writeState(st) {
  st.at = new Date().toISOString();
  st.history = (st.history || []).slice(-20);
  try { fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n'); } catch (e) {}
}
function commentGate(st) {
  const until = st.commentPausedUntil ? Date.parse(st.commentPausedUntil) : 0;
  if (until && until > Date.now()) return { ok: false, until: st.commentPausedUntil, miss: st.consecutiveCommentMiss || 0 };
  return { ok: true, miss: st.consecutiveCommentMiss || 0 };
}
/* v24（S5）：评论投递权限 —— 面板权限矩阵里可以设「只发私信」（permissions.comment='block'）。
   命中时：不生成评论文本、不调评论接口，只发私信；与原 commentPausedUntil（压审自动暂停）互不影响。 */
function readCommentPermission() {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pacing.json'), 'utf8'));
    const v = pj && pj.permissions && pj.permissions.comment;
    return v === 'block' ? 'block' : 'auto';
  } catch (e) { return 'auto'; }
}

const outbound = openDb(OB, db => {
  db.exec(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, bvid TEXT NOT NULL, aid INTEGER, target_uid TEXT,
    kind TEXT NOT NULL,            -- comment | dm
    text TEXT NOT NULL,
    rpid TEXT, msg_key TEXT,
    sent INTEGER DEFAULT 0,        -- 1 = 接口返回成功
    verified INTEGER DEFAULT 0,    -- 1 = 复核确认公开可见/已到达
    verify_at TEXT, verify_note TEXT
  )`);
  // v24（B1）：旧库补 err 列 —— 接口失败必须把 code/message 落盘，否则"发没发、为什么失败"事后无从查证
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('posts')").all().map(c => String(c.name));
    if (!cols.includes('err')) db.exec('ALTER TABLE posts ADD COLUMN err TEXT');
  } catch (e) { console.error('[sender] posts.err 列迁移失败（忽略）：' + String(e && e.message || e)); }
  db.exec('CREATE INDEX IF NOT EXISTS idx_posts_bv ON posts(bvid)');
});

function wbiTab() {
  const t = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
  return t;
}
async function jget(url, opts = {}) {
  const r = await fetch(url, {
    headers: { cookie: COOKIE, 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const txt = await r.text();
  if (txt.trim().startsWith('<')) throw new Error('被风控（HTML）HTTP ' + r.status);
  return JSON.parse(txt);
}
async function jpost(url, form) {
  const body = new URLSearchParams(form).toString();
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      cookie: COOKIE, 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const txt = await r.text();
  if (txt.trim().startsWith('<')) throw new Error('被风控（HTML）HTTP ' + r.status);
  return JSON.parse(txt);
}

/* ---------- 文本生成：从产物里取事实，生成两种形态 ---------- */
function readOut(bv) {
  const dir = path.join(ROOT, 'out', bv);
  const out = { bv, dir, manifest: '', ocr: '', danmaku: '', cost: null };
  for (const [k, f] of [['manifest', 'manifest.txt'], ['ocr', 'ocr.txt'], ['danmaku', 'danmaku.txt']]) {
    try { out[k] = fs.readFileSync(path.join(dir, f), 'utf8'); } catch {}
  }
  try { out.cost = JSON.parse(fs.readFileSync(path.join(dir, 'cost.json'), 'utf8')); } catch {}
  try { out.summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch { out.summary = null; }
  try { out.cloud = JSON.parse(fs.readFileSync(path.join(dir, 'summary.cloud.json'), 'utf8')); } catch { out.cloud = null; }
  return out;
}
function mmss(sec) {
  const m = Math.floor(sec / 60), ss = Math.round(sec % 60);
  return m + ':' + String(ss).padStart(2, '0');
}
function pickFacts(o) {
  const lines = o.manifest.split('\n');
  const head = lines.find(l => l.startsWith('# ')) || '';
  const cells = lines.filter(l => /^\d+\.\s*\[/.test(l));
  const ocrLines = o.ocr.split('\n').filter(l => l.startsWith('['));
  const dmHot = /热点\s*([0-9:]+)/.exec(o.danmaku || '');
  const total = (o.cost && o.cost.duration_sec) || (o.cost && o.cost.minutes * 60) || 0;
  const title = head.replace(/^#\s*/, '').replace(/\s*·\s*[0-9:]+.*$/, '').trim() || o.bv;
  // 有意义的画面文字：滤水印/乱码，要求汉字>=4 且符号占比<=30%
  const cjk = t => (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const WATER = ['bilibili', 'BiliBili', '哔哩哔哩', '抖音', '快手', '小红书', 'YouTube'];
  const meaningful = txt => {
    if (WATER.some(w => txt.includes(w))) return false;
    if (cjk(txt) < 4) return false;
    const sym = (txt.match(/[^\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
    if (sym / Math.max(1, txt.length) > 0.3) return false;
    if (/^[0-9A-Za-z\s\/\-\.]+$/.test(txt)) return false;   // 纯型号/参数串
    return true;
  };
  let mark = null;
  for (const l of ocrLines) {
    const m = /^\[(\d+):(\d+)\]\s*(.+)/.exec(l);
    if (!m) continue;
    const sec = Number(m[1]) * 60 + Number(m[2]);
    const txt = m[3].trim().replace(/\s+/g, ' ');
    if (total && (sec < total * 0.05 || sec > total * 0.95)) continue;
    if (!meaningful(txt)) continue;
    mark = { t: m[1] + ':' + m[2], text: txt.replace(/^[、，。：\s]+/, '').slice(0, 16) };
    break;
  }
  if (!mark && cells.length) {
    const m = /^\d+\.\s*\[([^\]]+)\]/.exec(cells[0]);
    if (m) mark = { t: String(m[1]).split('-')[0], text: '' };
  }
  const dmN = (o.cost && o.cost.danmaku && o.cost.danmaku.total) || 0;
  const fen = (o.cost && o.cost.tokens && o.cost.tokens.total) ? (o.cost.tokens.total / 1000000).toFixed(4) : null;
  // 要素句：画面文字里挑最能说明"这讲什么"的 3 条（去重、长度 6–40）
  const facts = [];
  const seen = new Set();
  for (const l of ocrLines) {
    const m = /^\[(\d+):(\d+)\]\s*(.+)/.exec(l);
    if (!m) continue;
    const txt = m[3].replace(/\s+/g, ' ').replace(/^[、，。：\s]+/, '').trim();
    if (!meaningful(txt) || txt.length < 6 || txt.length > 40) continue;
    const key = txt.slice(0, 8);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(m[1] + ':' + m[2] + ' ' + txt.slice(0, 26));
    if (facts.length >= 3) break;
  }
  const brief = (o.danmaku || '').split('\n').filter(l => /^[争干问]\s/.test(l)).slice(0, 2);
  const summary = o.cloud || o.summary || null;
  return { title, dur: mmss(total || (o.cost && o.cost.minutes * 60) || 0), cells: cells.length, mark, dmHot: dmHot ? dmHot[1] : null, ocrCount: ocrLines.length, dmN, summary, formal: !!o.cloud, facts, brief };
}
// v26：评论/私信文案已搬到 scripts/lib/copy.mjs（唯一真源：40 字信息核 + 人设口气 + 评论永远 @）。

/* ---------- 发送 ---------- */
async function postComment(aid, text) {
  const j = await jpost('https://api.bilibili.com/x/v2/reply/add', {
    oid: String(aid), type: '1', message: text, plat: '1', csrf: secret.bili_jct,
  });
  return j;
}
/* v52：sendDm 已抽到 scripts/lib/dm.mjs 的 sendDmText（表单字段与 cookie 只维护一份）。 */

async function verifyComment(aid, rpid) {
  const j = await jget(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=0&ps=20&pn=1`);
  const found = (j?.data?.replies || []).some(r => String(r.rpid) === String(rpid));
  return { found, code: j?.code };
}
async function verifyDm(toUid, textKey) {
  const j = await jget(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${toUid}&session_type=1&size=20&build=0&mobi_app=web`);
  const found = (j?.data?.messages || []).some(m => String(m.content || '').includes(textKey));
  return { found, code: j?.code };
}

/* ---------- 主流程 ---------- */
const lib = new DatabaseSync(LB, { readOnly: true });
const VIAARG = (args.find(a => a.startsWith('--via=')) || '').split('=')[1] || null;
const REDO = args.includes('--redo');
const BRIEF_OK = args.includes('--brief');       // 允许投「临时简报」（默认只投云端正式版）
/* v32：不再只认 status='seen'。原来 runner 卡在 running（或 reload 竞态把状态写丢）时，
   即使 summary.cloud.json 已经写好，这里也会 0 行 → deliver.log 记一条 dm:false 的空投递，
   用户什么都收不到。现在 seen / running / queued 都算候选，真正是否可投由下面「必须有云端总结」把关。 */
let rows = lib.prepare("SELECT bvid,title,status,via FROM videos WHERE status IN ('seen','running','queued') ORDER BY last_seen DESC").all();
if (BVARG) rows = rows.filter(r => r.bvid === BVARG);
if (VIAARG) rows = rows.filter(r => String(r.via || '').startsWith(VIAARG));
/* 只投云端正式版：没有 summary.cloud.json 的一律不投（等总结写好再投），--brief 才放行临时简报 */
if (!BRIEF_OK) {
  const before = rows.length;
  rows = rows.filter(r => fs.existsSync(path.join(ROOT, 'out', r.bvid, 'summary.cloud.json')));
  const skipped = before - rows.length;
  if (skipped > 0) console.log(`只投正式总结：跳过 ${skipped} 条还没有云端总结的视频（--brief 可投临时简报）`);
}
/* v57（2026-11-08 用户实测「新添的用户不能推送」）：
   以前这里只取 accounts[0] 当唯一收件人，push.json 里第 2/3 个账号形同摆设，
   与面板「数量不限 · 前 3 位生效」的约定不符。现在把前 3 个启用账号都当收件人：
   - channel=dm      每个账号各发一份私信，按 bvid + target_uid 去重
   - channel=comment 一个视频只发一条公开评论，@ 第一个评论账号
   - channel=panel   只进面板，不发外部消息
   去重也必须按 target_uid：以前只用 bvid，一个账号发过就把整条视频当成已投。 */
const push = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'push.json'), 'utf8'));
const targets = (push.accounts || []).filter(a => a.enabled !== false && Number(a.uid)).slice(0, 3);
if (!targets.length) { console.error('没有推送账号'); process.exit(1); }
const dmTargets = targets.filter(a => String(a.channel || 'dm') === 'dm');
const commentTargets = targets.filter(a => String(a.channel || 'dm') === 'comment');
const panelTargets = targets.filter(a => String(a.channel || 'dm') === 'panel');

const COMMENT_PERM = readCommentPermission();
const COMMENT_BLOCKED = COMMENT_PERM === 'block';
const PERSONA = readPersona();
const CHANNEL = (!COMMENT_BLOCKED && commentTargets.length) ? 'comment' : 'dm';

const dmOk = new Map(), commentOk = new Set();
if (!REDO) {
  try {
    const odb = new DatabaseSync(OB, { readOnly: true });
    for (const x of odb.prepare("SELECT bvid,target_uid FROM posts WHERE kind='dm' AND sent=1").all()) {
      if (!dmOk.has(x.bvid)) dmOk.set(x.bvid, new Set());
      dmOk.get(x.bvid).add(String(x.target_uid || ''));
    }
    for (const x of odb.prepare("SELECT bvid FROM posts WHERE kind='comment' AND sent=1").all()) commentOk.add(x.bvid);
    odb.close();
  } catch (e) {}
  rows = rows.filter(r => {
    const sentTo = dmOk.get(r.bvid) || new Set();
    const dmDone = !dmTargets.length || dmTargets.every(t => sentTo.has(String(t.uid)));
    const cmDone = CHANNEL !== 'comment' || commentOk.has(r.bvid);
    return !(dmDone && cmDone);
  });
}
rows = rows.slice(0, LIMIT);
lib.close();

console.log(`模式 ${DRY ? 'DRY（只看不发送）' : 'SEND（真的发）'} · 私信收件 ${dmTargets.length} 个（${dmTargets.map(a => '@' + a.name).join(' ') || '无'}） · 评论收件 ${CHANNEL === 'comment' ? commentTargets.map(a => '@' + a.name).join(' ') : '无'} · 只面板 ${panelTargets.length} 个${COMMENT_BLOCKED ? ' · 权限矩阵：评论已禁' : ''} · ${rows.length} 条`);
const results = [];

/* v37：评论优先用「云端模型写总结时顺带产出的那条」（summary.cloud.json 的 commentFor.text）。
   校验四条：开头是 @ / 去掉 @ 与尾巴后不超过上限 / 不含总结腔黑名单 / 不是空壳。
   任一条不满足就退回规则拼装（buildCommentCopy），保证永远不会因为模型写得差而发不出去或发出怪话。 */
const COMMENT_BLACKLIST = /本视频|该视频|综上所述|值得一看|令人印象深刻|首先|其次|最后|总的来说/;
function pickCommentText(f, o, name) {
  try {
    const shp = readShapeCopy();
    const cf = o && o.cloud && o.cloud.commentFor;
    const raw = cf && typeof cf.text === 'string' ? cf.text.trim() : '';
    if (raw) {
      const withAt = raw.startsWith('@') ? raw.replace(/^@[^\s]+/, '@' + name) : '@' + name + ' ' + raw;
      const core = withAt.replace(/^@[^\s]+\s*/, '');
      const len = [...core].length;
      const ok = /^@/.test(withAt) && len >= 8 && len <= shp.commentMax + 8 && !COMMENT_BLACKLIST.test(withAt);
      if (ok) return withAt;
      console.log(' 模型评论不合格（' + (len > shp.commentMax + 8 ? '超 ' + len + ' 字' : COMMENT_BLACKLIST.test(withAt) ? '含总结腔' : '太短') + '）→ 退回规则拼装');
    }
  } catch (e) {}
  return buildCommentCopy(f, { targetName: name, persona: PERSONA });
}
for (const r of rows) {
  const bvid = r.bvid;
  const sentTo = dmOk.get(bvid) || new Set();
  const dmDue = dmTargets.filter(t => !sentTo.has(String(t.uid)));
  const cmT = CHANNEL === 'comment' ? commentTargets[0] : null;
  const commentDue = !!(cmT && !commentOk.has(bvid));
  if (!dmDue.length && !commentDue) { console.log(`跳过 ${bvid}：生效账号都已投过`); continue; }
  const o = readOut(bvid);
  if (!o.manifest) { console.log(`跳过 ${bvid}：没有产物`); continue; }
  const f = pickFacts(o);
  f.bv = bvid;
  const dmText = dmDue.length ? buildDmCopy(f, { persona: PERSONA }) : '';
  const commentText = commentDue ? pickCommentText(f, o, cmT.name) : '';
  let aid = (o.cost && o.cost.aid) || null;
  if (!aid) { try { const v = await jget('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid); aid = v?.data?.aid || null; } catch (e) { console.log(' 取 aid 失败:', e.message); } }
  if (!aid) { console.log(' 跳过（拿不到 aid）'); continue; }
  console.log('\n=== ' + bvid + ' ' + f.title.slice(0, 30));
  const st = readState();
  const cg = commentGate(st);
  /* v57：评论暂停时不再整条跳过——私信收件人照发（评论与私信现在可以分属不同账号）。 */
  const commentPaused = !!(commentDue && !cg.ok);
  if (commentPaused) console.log(' 评论通道暂停中（至 ' + cg.until + '，连续未可见 ' + cg.miss + ' 次）→ 评论不发（私信照发）');
  const item = { bvid, dry: DRY, channel: dmDue.length ? 'dm' : 'comment', persona: personaKey(PERSONA) };
  if (dmDue.length) {
    item.dmText = dmText;
    console.log(' 私信版本(' + dmText.length + ' 字 · 人设 ' + personaKey(PERSONA) + ' · 收件 ' + dmDue.map(t => '@' + t.name).join(' ') + '): ' + dmText.split('\n').join(' / '));
  }
  if (commentDue) {
    item.commentText = commentText;
    console.log(' 评论版本(' + commentText.length + ' 字 · 人设 ' + personaKey(PERSONA) + ' · @' + cmT.name + '): ' + commentText);
  }
  if (!DRY) {
    const now = new Date().toISOString();
    /* 通道①：评论 —— 独立 try/catch。一个视频只发一条评论，@ 第一个评论账号。 */
    if (!commentDue) {
      item.comment = false; item.commentSkip = commentTargets.length ? 'already-ok' : 'no-comment-target';
    } else if (commentPaused) {
      item.comment = false; item.commentSkip = 'comment-paused';
    } else {
      try {
        const jc = await postComment(aid, commentText);
        const rpid = jc?.data?.rpid_str || jc?.data?.rpid || null;
        console.log(' 评论接口:', jc.code, jc.message, 'rpid=' + rpid);
        item.comment = jc.code === 0;
        item.commentCode = jc.code;
        item.commentMsg = String(jc.message || '');
        outbound.prepare('INSERT INTO posts (at,bvid,aid,target_uid,kind,text,rpid,sent,err) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(now, bvid, aid, String(cmT.uid), 'comment', commentText, String(rpid || ''), jc.code === 0 ? 1 : 0,
            jc.code === 0 ? null : String(jc.code) + ':' + String(jc.message || ''));
        if (jc.code === 0 && rpid) {
          await new Promise(res => setTimeout(res, 2500));
          const vc = await verifyComment(aid, rpid);
          console.log(' 评论复核:', vc.found ? '✓ 已公开可见' : '✗ 列表里没找到（可能被压审）');
          outbound.prepare('UPDATE posts SET verified=?, verify_at=?, verify_note=? WHERE rpid=?')
            .run(vc.found ? 1 : 0, new Date().toISOString(), vc.found ? 'list-found' : 'not-in-list', String(rpid));
          item.commentVerified = vc.found;
          {
            const st2 = readState();
            if (vc.found) { st2.consecutiveCommentMiss = 0; }
            else {
              st2.consecutiveCommentMiss = Number(st2.consecutiveCommentMiss || 0) + 1;
              if (st2.consecutiveCommentMiss >= 2 && !st2.commentPausedUntil) {
                st2.commentPausedUntil = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
                st2.note = '连续 ' + st2.consecutiveCommentMiss + ' 次评论查不到 → 自动暂停 24h（B站新号压审）';
              }
            }
            writeState(st2);
          }
        }
      } catch (e) {
        item.comment = false;
        item.commentMsg = String(e && e.message || e).slice(0, 300);
        console.log(' 评论失败（不连带丢私信）:', item.commentMsg);
        try {
          outbound.prepare('INSERT INTO posts (at,bvid,aid,target_uid,kind,text,rpid,sent,err) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(now, bvid, aid, String(cmT.uid), 'comment', commentText, '', 0, 'exception:' + item.commentMsg);
        } catch (e2) {}
      }
    }
    /* 通道②：私信 —— v57 每个 dm 账号各一份，独立 try/catch；一个账号失败不影响其他账号。 */
    if (!dmDue.length) {
      item.dm = dmTargets.length > 0; item.dmSkip = 'already-ok';
    } else {
      const sent = [];
      for (const t of dmDue) {
        const tuid = String(t.uid);
        const one = { uid: tuid, name: t.name, ok: false };
        try {
          await new Promise(res => setTimeout(res, 1500));
          const jd = await sendDmText(tuid, dmText);
          console.log(' 私信@' + t.name + ':', jd.code, jd.message);
          one.ok = jd.code === 0;
          one.code = jd.code;
          one.msg = String(jd.message || '');
          const ins = outbound.prepare('INSERT INTO posts (at,bvid,aid,target_uid,kind,text,msg_key,sent,err) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(now, bvid, aid, tuid, 'dm', dmText, dmText.slice(0, 20), jd.code === 0 ? 1 : 0,
              jd.code === 0 ? null : String(jd.code) + ':' + String(jd.message || ''));
          if (jd.code !== 0) console.log(' 私信失败（已落盘 sent=0 err=' + one.code + ':' + one.msg + '）');
          if (jd.code === 0) {
            await new Promise(res => setTimeout(res, 2000));
            const vd = await verifyDm(tuid, dmText.slice(0, 12));
            console.log(' 私信复核@' + t.name + ':', vd.found ? '✓ 会话里能看到' : '✗ 会话里没看到');
            one.verified = vd.found;
            /* v57 修：以前只把复核结果放进内存 item（panel toast 能显示），没写回 posts.verified，
               面板/记录里永远是「未复核」——看起来像没投递。按刚插入那行 id 回写。 */
            try {
              outbound.prepare('UPDATE posts SET verified=?, verify_at=?, verify_note=? WHERE id=?')
                .run(vd.found ? 1 : 0, new Date().toISOString(), vd.found ? 'session-found' : 'not-in-session', ins.lastInsertRowid);
            } catch (e2) {}
          }
        } catch (e) {
          one.msg = String(e && e.message || e).slice(0, 300);
          console.log(' 私信@' + t.name + ' 失败:', one.msg);
          try {
            outbound.prepare('INSERT INTO posts (at,bvid,aid,target_uid,kind,text,msg_key,sent,err) VALUES (?,?,?,?,?,?,?,?,?)')
              .run(now, bvid, aid, tuid, 'dm', dmText, dmText.slice(0, 20), 0, 'exception:' + one.msg);
          } catch (e2) {}
        }
        sent.push(one);
      }
      item.dmTargets = sent;
      item.dm = sent.every(x => x.ok);
      const bad = sent.find(x => !x.ok) || null;
      item.dmCode = bad ? bad.code : 0;
      item.dmMsg = bad ? bad.msg : '';
      item.dmVerified = !bad && sent.every(x => x.verified);
    }
  }
  results.push(item);
  await new Promise(res => setTimeout(res, 2000));
}
outbound.close();
console.log('\nRESULTS ' + JSON.stringify({ dry: DRY, targets: targets.map(t => ({ uid: String(t.uid), name: t.name, channel: String(t.channel || 'dm') })), items: results }));
