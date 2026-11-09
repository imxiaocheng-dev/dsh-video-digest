/**
 * dsh-video-digest —— 「一起看视频」的 DSH 薄壳插件。
 *
 * 设计原则（与 docs/fusion-spec.md 一致）：
 *   1. 业务逻辑一行都不进插件。看片、记账、队列、门禁、投递全在包根的 scripts\*.mjs 里，
 *      插件只做三件事：注册工具、贴链接时给模型一句旁白、每 5 分钟催一次入站轮询。
 *   2. 因此改文案 / 改阈值 / 改档位 / 改人设，都不需要重载插件。
 *   3. 任何一个能力缺失（没有 @deepseek-ai/dsh-tools、没有 dsh-llm、面板服务没开）都只降级，
 *      绝不让插件加载失败——插件加载失败在桌面版里是致命条目。
 *
 * 工具面：
 *   video_digest        看一条视频（BV 号 / B 站链接），产出宫格 + 清单 + 成本，返回文本摘要
 *   video_queue         排队情况 / 归档情况 / 待写总结 / 把一条加入队列
 *   video_write_summary 写「云端正式版」总结（写完由服务端自动私信投递给推送账号）
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ---------- 代码根 / 数据根：唯一真源是 <代码根>/scripts/lib/paths.mjs ----------
 * 发布后插件会被装进 node_modules 或 DSH 插件目录（只读、随包升级被覆盖），所以「代码在哪」和
 * 「数据写哪」必须拆开：
 *   CODE_ROOT —— 随包走的只读资源：scripts/、panel/、vendor/、默认 config/
 *   DATA_ROOT —— 用户数据：out/、logs/、cache/、config/（首次运行从包里播种）、secrets/ 等
 * 代码根在这里自己探测（不直接用 paths.mjs 算出来的 CODE_ROOT，因为 plugin/ 的布局以后可能变）：
 * 从本文件所在目录开始最多上溯 4 层，找第一个含 scripts/lib/paths.mjs 的目录 —— 同时兼容
 * 「plugin/ 是包根的子目录」和「scripts/ 跟 plugin/ 一起打进包」两种布局；都找不到就退回旧行为
 * （HERE 的上一级）。本机是旧布局，paths.mjs 解析出的 DATA_ROOT 仍是包根，所以本地行为不变。 */
function detectCodeRoot() {
  let dir = HERE
  for (let i = 0; i <= 4; i++) {
    try { if (existsSync(join(dir, 'scripts', 'lib', 'paths.mjs'))) return dir } catch (e) { /* ignore */ }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return dirname(HERE)
}
const CODE_ROOT = detectCodeRoot().replace(/\\/g, '/')
// 动态 import 路径唯一真源：index.js 本身是 ESM 且下面已经用了顶层 await（optionalImport），
// 所以这里也能顶层 await。解析失败只降级到旧布局（代码根即数据根），绝不让插件加载失败。
let PATHS = null
let PATHS_ERR = ''
try {
  PATHS = await import(pathToFileURL(join(CODE_ROOT, 'scripts', 'lib', 'paths.mjs')).href)
} catch (e) { PATHS_ERR = String(e?.message || e) }
const DATA_ROOT = String((PATHS && PATHS.DATA_ROOT) || dirname(HERE)).replace(/\\/g, '/')
const DATA_SOURCE = String((PATHS && PATHS.DATA_SOURCE) || 'fallback')
/* 首次运行准备：自建数据目录 + 从包里播种缺失的配置（幂等，已有文件一律不覆盖）。
   失败不致命（真写不进去会在用时暴露），但必须放在任何写日志之前 —— 日志本身就在数据根里。 */
try { if (PATHS && typeof PATHS.ensureData === 'function') PATHS.ensureData() } catch (e) { /* ignore */ }

/* ---------- 配置：默认指向数据根；config/plugin.json 可以覆盖 ----------
 * 配置项名仍叫 root（保持旧 config/plugin.json 向后兼容），默认值已从「工作区」改成 DATA_ROOT。 */
const DSH_HOME = String(process.env.DSH_HOME || '').replace(/\\/g, '/') || join(homedir(), '.dsh').replace(/\\/g, '/')
const DEFAULTS = {
  root: DATA_ROOT,
  /* 面板访问方式：
     'inproc'（默认，2026-10-31 起）—— 直接在宿主进程里调 panel_server.mjs 的 handler，
        不需要任何端口、不需要计划任务、不需要看门狗；DSH 起来它就在。
     'http'  —— 老的独立进程模式（node scripts/panel_server.mjs 8791），只在"不开 DSH 也想看面板"时用。 */
  serverMode: 'inproc',
  server: 'http://127.0.0.1:8791',
  pollMs: 5 * 60 * 1000,
  textCap: 1800,
  preStepHint: true,
  /* 「叫醒」守候（全自动写总结）：本地每 60s 敲一次钟，纯查本地接口 0 token；
     只有当「有待写 + 今日额度没满 + 这条没催过 + 距上次叫醒超过 cooldown」才真的投一条消息进会话。 */
  watchEnabled: true,          // 自动写总结总开关（config/plugin.json 可关）
  watchMs: 60 * 1000,
  watchCooldownMs: 3 * 60 * 1000,
  watchPerHour: 12,
  watchRotateTurns: 6,
  // 入站守候：频率由服务端 config/pacing.json 的 inbound 决定，这里只做兜底
  inboxActiveSec: 20,
  inboxIdleSec: 60,
  inboxNightSec: 180,
  inboxActiveWindowMin: 10,
  inboxEnabled: true,
}
function loadConfig() {
  const cfg = { ...DEFAULTS }
  try {
    /* 配置文件优先读数据根（用户自己的），没有就回落到随包的默认 config/（只读、不复制）。
       走 paths.mjs 的 configFile()，这样发布包装进只读目录、首次运行还没播种时也能读到默认配置。 */
    const f = PATHS && typeof PATHS.configFile === 'function'
      ? PATHS.configFile('plugin.json')
      : join(DEFAULTS.root, 'config', 'plugin.json')
    if (existsSync(f)) Object.assign(cfg, JSON.parse(readFileSync(f, 'utf8')))
  } catch (e) { /* 配置坏了就用默认 */ }
  return cfg
}

const CFG = loadConfig()
const ROOT = String(CFG.root || DEFAULTS.root).replace(/\\/g, '/')
const SERVER = String(CFG.server || DEFAULTS.server).replace(/\/$/, '')
const SERVER_MODE = String(CFG.serverMode || DEFAULTS.serverMode)
/* 代码类路径 → CODE_ROOT（随包资源）；数据类路径 → ROOT（= CFG.root，默认就是 DATA_ROOT） */
const PANEL_JS = join(CODE_ROOT, 'scripts', 'panel_server.mjs')
const NAME = 'dsh-video-digest'
const LOG = join(ROOT, 'logs', 'plugin.log')

function log(line) {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), line: String(line) }) + '\n')
  } catch (e) { /* 日志失败不打扰宿主 */ }
}

/* ---------- 可选依赖：拿不到就降级 ----------
 * 注意：本插件在 profile 的 node_modules 里是一个 junction（真实路径在工作区），
 * 所以裸 import '@deepseek-ai/dsh-tools' 可能解析不到 —— 再退一步，用 profile 目录做基址
 * 走 createRequire.resolve 找一次。两条路都失败就只降级，不抛。 */
const PROFILE_DIR = String(CFG.profileDir || (DSH_HOME + '/profiles/desktop')).replace(/\\/g, '/')
async function optionalImport(pkg) {
  try { return await import(pkg) } catch (e) { /* fallthrough */ }
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const bases = [
    PROFILE_DIR + '/package.json',
    'D:/App/deepseekhss/resources/app.asar/package.json',
  ]
  for (const base of bases) {
    try {
      const req = createRequire(base)
      return await import(pathToFileURL(req.resolve(pkg)).href)
    } catch (e) { /* try next */ }
  }
  return null
}
let defineTool = null
const toolsMod = await optionalImport('@deepseek-ai/dsh-tools')
try { defineTool = toolsMod?.defineTool || null } catch { defineTool = null }
let createUserMessage = null
let boundContextSummary = null
const llmMod = await optionalImport('@deepseek-ai/dsh-llm')
try {
  createUserMessage = llmMod?.createUserMessage || null
  boundContextSummary = llmMod?.boundContextSummary || null
} catch { createUserMessage = null; boundContextSummary = null }

/* ---------- 进程内小工具 ---------- */
function runNode(argv, { timeoutMs = 15 * 60 * 1000, signal } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    /* 脚本一律用绝对路径（CODE_ROOT 下）启动，cwd 只影响脚本里的相对写入，
       所以给数据根 ROOT —— 产物/缓存才会落在用户数据目录。 */
    const child = spawn(process.execPath, argv, { cwd: ROOT, windowsHide: true })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill('SIGKILL') } catch (e) { /* ignore */ }
      resolve({ code: -1, out: out + '\n[超时]' })
    }, timeoutMs)
    const onAbort = () => { try { child.kill('SIGKILL') } catch (e) { /* ignore */ } }
    try { signal?.addEventListener?.('abort', onAbort, { once: true }) } catch (e) { /* ignore */ }
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('error', (e) => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve({ code: -1, out: out + '\n[spawn 失败] ' + (e?.message || e) })
    })
    child.on('close', (code) => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve({ code: code ?? 0, out })
    })
  })
}

/* ---------- 面板 API：默认走进程内（0 端口），失败才退回 HTTP ----------
 * 为什么改：原来是"插件 → HTTP → 127.0.0.1:8791 的独立面板进程"。这条路带出三件套的维护成本
 * （端口占用、计划任务、看门狗拉起、DSH 退出把子进程带走）。其实面板 handler 是纯函数，
 * 同进程直接调就行 —— 走的是**同一段代码**，所以 HTTP 和进程内返回的 JSON 必然一致。
 * 独立 HTTP 模式保留给"不开 DSH 也想看面板"的场景，config/plugin.json 里 serverMode:'http' 切回。 */
let INPROC = null
async function inprocLib() {
  if (INPROC !== null) return INPROC
  try {
    INPROC = await import(pathToFileURL(join(CODE_ROOT, 'scripts', 'lib', 'inproc-api.mjs')).href)
  } catch (e) {
    log('进程内 API 不可用，退回 HTTP：' + (e?.message || e))
    INPROC = false
  }
  return INPROC
}

async function apiHttp(pathname, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(SERVER + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { error: 'non-json', status: res.status, text: text.slice(0, 200) } }
  } catch (e) {
    return { error: String(e?.message || e), offline: true }
  } finally { clearTimeout(t) }
}

async function api(pathname, opts = {}) {
  if (SERVER_MODE !== 'http') {
    const lib = await inprocLib()
    if (lib) {
      try {
        const r = await lib.call(PANEL_JS, pathname, { method: opts.method, body: opts.body, timeoutMs: opts.timeoutMs })
        if (r.json) return r.json
        if (!r.ok) return { error: 'http ' + r.status, status: r.status, text: String(r.text || '').slice(0, 200) }
        return { text: r.text }
      } catch (e) {
        log('进程内调用失败（改走 HTTP）：' + pathname + ' · ' + (e?.message || e))
      }
    }
  }
  return await apiHttp(pathname, opts)
}

/* ---------- 面板自愈：DSH 重启后面板进程会停，这里顺手把它拉起来 ----------
   所有业务都在 scripts\*.mjs 里，插件只负责"何时叫醒"；面板一停，叫醒后模型读不到
   /api/summary/queue、也写不了总结，整条链路就哑了，所以每次叫醒前先确认面板活着。 */
const NODE_CANDIDATES = [
  DSH_HOME + '/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe',
  DSH_HOME + '/dsh-runtimes/dsh-primary-runtime/dependencies/node/node.exe',
]
function realNode() {
  for (const p of NODE_CANDIDATES) { try { if (existsSync(p)) return p } catch (e) {} }
  return 'node'
}
let serverStartingAt = 0
const SERVER_PORT = 8791

async function waitHealth(ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const h = await api('/api/health', { timeoutMs: 2000 })
    if (h && h.ok) return h
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

async function ensureServer() {
  const h = await api('/api/health', { timeoutMs: 3000 })
  if (h && h.ok) return true
  /* 进程内模式下"面板活着"= 模块能加载，这里的 health 已经验证过；不通只可能是脚本被删，
     拉起独立进程也救不了 → 直接返回，不再 spawn 任何东西。 */
  if (SERVER_MODE !== 'http') {
    log('进程内面板不可用（panel_server.mjs 是否还在？）：' + JSON.stringify(h).slice(0, 160))
    return false
  }
  if (Date.now() - serverStartingAt < 20000) return false   // 20 秒内只拉一次，避免反复起进程
  serverStartingAt = Date.now()
  const script = join(CODE_ROOT, 'scripts', 'panel_server.mjs')
  const node = realNode()
  /* 为什么绕一层 cmd /c start：
     2026-10-31 实测——直接 spawn(node, detached:true) 起的进程仍会在 DSH 退出时被杀（Electron 的 Job Object
     会连带杀子进程），于是每次重启面板都消失、要等下一次 tick 才回来（最长 60 秒）。
     经 `cmd /c start` 由 shell 创建，进程脱离宿主作业树；参数顺序：start "" /B <exe> <args…>。 */
  try {
    const comspec = process.env.ComSpec || 'C:/Windows/System32/cmd.exe'
    const child = spawn(comspec, ['/c', 'start', '', '/B', node, script, String(SERVER_PORT)], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    })
    if (child && typeof child.unref === 'function') child.unref()
  } catch (e) {
    /* cmd 不可用时退回直接 spawn */
    try {
      const child = spawn(node, [script, String(SERVER_PORT)], {
        cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      })
      if (child && typeof child.unref === 'function') child.unref()
    } catch (e2) { log('拉起面板失败：' + (e2?.message || e2)); return false }
  }
  const up = await waitHealth(10000)
  if (up) { log(`面板已就绪（${String(up.version || '?').replace(/^v/, 'v')} · ${SERVER_PORT}）`); return true }
  log('面板拉起后 10 秒仍不通（下次 tick 再试）')
  return false
}

function clip(s, n) {
  const str = String(s ?? '')
  if (str.length <= n) return str
  return str.slice(0, n) + `\n…（已截断，全文 ${str.length} 字；要完整版用 read 打开产物文件）`
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/* ── v36：本插件自己的花费账 logs/llm-cost.jsonl ────────────────────
   DSH 的 .dshw-usage.json 只有按日总额 + 没有会话归属的 events，回答不了「看视频花了多少」。
   所以这里自己记账，一行一次花钱动作（面板「账本 → 本站花费」读它）：
     · kind='preview'   面板预览的直连调用 —— 有真实 usage，精确
     · kind='summarize' 投递给摘要工人的一次 —— 拿不到 usage，用「投递时间窗内 DSH events」归因，标 source:'window'
     · kind='why'       本地判否说明（0 元也记一行，便于核对）
   字段：{at, kind, bv, target, model, input, output, yuan, source, events?} */
function spendFile() { return join(ROOT, 'logs', 'llm-cost.jsonl') }
function priceCfg() {
  return readJson(join(ROOT, 'config', 'pricing.json')) || { inMiss: 1, inHit: 0.02, out: 4 }
}
/** 按 token 算钱：输入按「未命中」上限（真实大多有缓存命中，只会更便宜），输出按 out 价 */
function spendYuan(inTok, outTok) {
  const p = priceCfg()
  const y = ((Number(inTok) || 0) * (Number(p.inMiss) || 1) + (Number(outTok) || 0) * (Number(p.out) || 4)) / 1e6
  return +y.toFixed(6)
}
function appendSpend(rec) {
  try {
    mkdirSync(dirname(spendFile()), { recursive: true })
    appendFileSync(spendFile(), JSON.stringify({ at: new Date().toISOString(), ...(rec || {}) }) + '\n')
  } catch (e) { try { log('花费账写入失败（已忽略）：' + (e?.message || e)) } catch (e2) {} }
}
/** 读 DSH 计费事件（用于把「一次投递」的成本按时间窗归因） */
function dshUsageEvents() {
  const j = readJson(join(DSH_HOME, '.dshw-usage.json'))
  return j && Array.isArray(j.events) ? j.events : []
}
/** 时间窗内的 DSH 扣款（含边界前后 3 秒；events 会被裁剪，所以只当近似） */
function windowCost(t0, t1) {
  try {
    let yuan = 0, tokens = 0, events = 0
    for (const e of dshUsageEvents()) {
      const ts = Number(e && e.ts) || 0
      if (ts >= t0 - 3000 && ts <= t1 + 3000) {
        yuan += Number(e.cost) || 0
        tokens += Number(e.tokens) || 0
        events++
      }
    }
    return { yuan: +yuan.toFixed(6), tokens, events }
  } catch (e) { return { yuan: 0, tokens: 0, events: 0 } }
}
/** 投递形态（总结字数上限）：与 scripts/lib/persona-text.mjs 的 readShape 同规则 */
function readShapeLocal() {
  const j = readJson(join(ROOT, 'config', 'push.json')) || {}
  const s = j.shape || {}
  const clamp = (x, lo, hi, d) => {
    const n = Number(x)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
  }
  return {
    commentMax: clamp(s.commentMax, 20, 200, 40),
    dmMax: clamp(s.dmMax, 200, 860, 860),
    summaryMax: clamp(s.summaryMax, 200, 2000, 900),
  }
}

/** v50：推送账号名（评论开头 @ 它）——与 panel_server 同口径，读 config/push.json 的 accounts[0].name */
function readTargetName() {
  try {
    const j = readJson(join(ROOT, 'config', 'push.json')) || {}
    const a = Array.isArray(j.accounts) ? j.accounts[0] : null
    return String((a && a.name) || '').trim()
  } catch (e) { return '' }
}

/* 篇幅契约：与 scripts/lib/persona-text.mjs 的 lengthContract 逐字一致，改一处必须改两处
   （插件里不能静态 import，故本地一份）。 */
function lenContract(kind, max) {
  const n = Math.round(Number(max) || 0)
  if (!n) return ''
  const soft = Math.max(1, Math.round(n * 0.75))
  const what = kind === 'comment' ? '评论正文（不含 @昵称）' : kind === 'dm' ? '私信正文（含称呼）' : '总结正文'
  return [
    `篇幅契约（${what}）：硬上限 ${n} 字——超过就删次要细节，结论和关键数字不许删；`,
    `软目标约 ${soft} 字——低于它先补具体细节（时间码 / 参数 / 画面里的字 / 弹幕争议），补完仍不够就停；`,
    '结构按上面「结构」那一条写，不要另立小标题；',
    '禁止凑字数：不许重复、不许形容词堆料、不许复述标题、不许「总的来说」收尾。字数不足不算失败，宁短勿凑。',
  ].join('\n')
}

/* v26（P4）：人设与总结模板在「调用时」读取 —— 面板改完人设，下一次写总结就按新口吻，不用重启 DSH。
   唯一真源仍是 scripts/lib/persona-text.mjs 与 scripts/lib/templates.mjs（加 ?v=mtime 绕开 ESM 缓存）。 */
async function personaGuide(opts) {
  try {
    const base = pathToFileURL(join(CODE_ROOT, 'scripts', 'lib', 'persona-text.mjs')).href + '?v=' + Date.now()
    const pt = await import(base)
    const persona = pt.readPersona()
    const key = pt.personaKey(persona)
    /* v36：总结字数上限来自「投递形态」（config/push.json → shape.summaryMax），
       所以 personaPromptBlock 里的「篇幅」行会跟着面板设置走（改完下一次就生效）。 */
    const shape = readShapeLocal()
    /* v56：结构 auto → 按本条标题/材料解析成具体一档（技术审阅式 / 拆解复算式）再拼 prompt；
       面板显式选了某一档时原样用。只改内存对象，不写配置。 */
    const o = opts && typeof opts === 'object' ? opts : {}
    const info0 = pt.formatInfo(persona, shape)
    const structure = pt.resolveStructure(info0.structure, String(o.title || ''), String(o.material || ''))
    const pp = pt.withStructure(persona, structure)
    const block = pt.personaPromptBlock(pp, shape)
    /* v33：面板「个性化 → 总结模板」里的硬规矩也要真的进摘要工人的 prompt
       （以前这套模板只在本地模型预览里用到，云端写手完全没读它 → 面板改模板等于没改）。 */
    let rules = ''
    try {
      const tplUrl = pathToFileURL(join(CODE_ROOT, 'scripts', 'lib', 'templates.mjs')).href + '?v=' + Date.now()
      const tpl = await import(tplUrl)
      rules = String(tpl.summaryRulesText(block) || '')
    } catch (e) { rules = '' }
    /* v40（C4-6）：写盘前也在插件侧兜一道语气词清洗 —— 宿主模型不一定每次都听 prompt，
       把人设白名单与清洗函数一起交给 writeTool（复用 persona-text.mjs 的唯一真源）。 */
    const allowed = pt.particleWhitelist(persona)
    const clean = (t) => pt.enforceParticles(String(t == null ? '' : t), allowed)
    /* v50：评论开头固定 @ 推送账号（正式账号名，不是人设里的称呼） */
    const targetName = readTargetName()
    return { key, block, summary: pt.personaSummary(persona), rules, shape, allowed, clean, targetName, structure }
  } catch (e) {
    return { key: 'none', block: '', summary: '人设读取失败：' + (e?.message || e), rules: '' }
  }
}

function fmtMin(sec) {  const s = Number(sec) || 0
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`
}

/* 分（人民币）—— 面板里统一用「分」，0.43 分就是 4 厘钱，比 0.0043 元好读 */
function fen(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n >= 10 ? n.toFixed(1) : n.toFixed(2)
}

/* ---------- 一条视频的关键事实（不调模型） ---------- */
function digestResultText(bv, depth, job) {
  const dir = join(ROOT, 'out', bv)
  const cost = readJson(join(dir, 'cost.json')) || {}
  const manifest = existsSync(join(dir, 'manifest.txt')) ? readFileSync(join(dir, 'manifest.txt'), 'utf8') : ''
  const gate = readJson(join(dir, 'gate.json'))
  const cloud = readJson(join(dir, 'summary.cloud.json'))
  const tokens = (cost.tokens && (cost.tokens.total ?? cost.tokens)) || cost.total || 0
  const min = Number(cost.minutes || 0)
  const head = [
    `${cost.title || bv} · ${bv}`,
    `${fmtMin(cost.duration_sec || min * 60)} · 档位 ${depth} · ${tokens} token${min ? ` · ${Math.round(tokens / min)}/分钟` : ''}`,
    `宫格 out/${bv}/sheet.png · 清单 out/${bv}/manifest.txt · 成本 out/${bv}/cost.json`,
    gate ? `门禁 ${gate.route}${gate.reasons ? '（' + String(gate.reasons).slice(0, 80) + '）' : ''}` : '门禁 未跑',
    cloud ? '正式版总结 已有（detail 页可读）' : '正式版总结 还没有（video_write_summary 可写）',
  ].join('\n')
  const tail = job && job.code !== 0 ? `\n[digest 退出码 ${job.code}]\n${clip(job.out.split('\n').slice(-6).join('\n'), 400)}` : ''
  return `${head}\n\n---- 清单（每行一格：时间码 + 该格在讲什么）----\n${clip(manifest, CFG.textCap)}${tail}`
}

/* ---------- 工具 1：video_digest ---------- */
const digestTool = () => defineTool && defineTool({
  name: 'video_digest',
  description: '看一条 B 站视频的内容（本地流水线，一次跑完宫格 + 台词 + 弹幕 + 画面文字）。用户给出 BV 号或 B 站链接、要你「看看这条讲什么 / 值不值得看 / 总结一下」时用。返回：时长、花的钱与 token、宫格图路径、逐格清单（每格时间码与它讲什么）、门禁结论。默认 T3（宫格+台词+弹幕+画面文字）；只想粗看用 T2，想再看两张原始比例特写用 T4。跑完在 out/<BV>/ 下有 sheet.png / manifest.txt / cost.json，细节可以再读文件。',
  parameters: {
    source: { type: 'string', required: true, description: 'BV 号（如 BV1ksWw6TEeQ）或 B 站视频链接' },
    depth: { type: 'string', enum: ['T2', 'T3', 'T4'], description: '默认 T3。T2 只有宫格+台词+弹幕；T3 加画面文字；T4 再补 2 张定点特写（最贵）' },
    cells: { type: 'integer', description: '宫格数量，0=自动（自动会在静态讲解片上偏粗，快剪片建议 12–16）' },
  },
  output: {
    /* 注意：output.schema 不能写 required（宿主编译时 allowRequired=false，会抛 JsonSchemaError） */
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: '给模型看的文本' } } },
    render: (_a, v) => [{ type: 'text', text: String(v && v.text ? v.text : '') }],
  },
  isConcurrencySafe: () => false,
  timeoutMs: 16 * 60 * 1000,
  async execute(args, exec) {
    const source = String(args.source || '').trim()
    if (!source) return { text: '没给视频：需要 BV 号或 B 站视频链接' }
    const depth = String(args.depth || 'T3').toUpperCase()
    const cells = Number(args.cells || 0)
    const argv = [join(CODE_ROOT, 'scripts', 'digest.mjs'), source, '--depth=' + depth]
    if (cells > 0) argv.push('--cells=' + cells)
    log(`digest start ${source} ${depth}${cells ? ' cells=' + cells : ''}`)
    const job = await runNode(argv, { signal: exec?.signal })
    const m = job.out.match(/BV[0-9A-Za-z]{6,14}/)
    const bv = (m && m[0]) || (/^BV[0-9A-Za-z]{6,14}$/.test(source) ? source : '')
    log(`digest done ${bv || source} code=${job.code}`)
    if (!bv) return { text: `看不出是哪条视频（可能链接没解析成 BV）。digest 输出尾部：\n${clip(job.out.slice(-800), 700)}` }
    const guide = await personaGuide()
    return { text: digestResultText(bv, depth, job) + (guide.block ? `\n\n---- 写总结时按这个人设口吻（只影响"怎么说"）----${guide.block}` : '') }
  },
})

/* ---------- 工具 2：video_queue ---------- */
const queueTool = () => defineTool && defineTool({
  name: 'video_queue',
  description: '查「一起看视频」的队列与归档，或者把一条视频加进队列。op=list 看排队中/进行中/候选中（含今日入列进度）；op=archive 看最近跑完的（含总结状态、是否已投递）；op=pending 看待写正式版总结的视频（按优先级排，写完会自动私信投递）；op=enqueue 需要 bvid，把手动/入站的片子直接插到排队最前。这些都是本地只读/本地状态，不花 token。',
  parameters: {
    op: { type: 'string', enum: ['list', 'archive', 'pending', 'enqueue'], description: '默认 list' },
    bvid: { type: 'string', description: 'op=enqueue 时必填' },
    limit: { type: 'integer', description: '条数，默认 8' },
  },
  output: {
    /* 注意：output.schema 不能写 required（宿主编译时 allowRequired=false，会抛 JsonSchemaError） */
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: '给模型看的文本' } } },
    render: (_a, v) => [{ type: 'text', text: String(v && v.text ? v.text : '') }],
  },
  isConcurrencySafe: () => true,
  timeoutMs: 30000,
  async execute(args) {
    const op = String(args.op || 'list')
    const limit = Math.max(1, Math.min(30, Number(args.limit || 8)))
    const health = await api('/api/health')
    if (health.error) return { text: `面板服务没起来（${SERVER}）：先启动 ${PANEL_JS} 8791。错误：${health.error}` }
    if (op === 'enqueue') {
      const bvid = String(args.bvid || '').trim()
      if (!/^BV[0-9A-Za-z]{6,14}$/.test(bvid)) return { text: 'op=enqueue 需要一个合法 BV 号' }
      const r = await api('/api/enqueue', { method: 'POST', body: { items: [{ bvid, via: 'manual', depth: 'T3' }] } })
      const q = await api('/api/queue')
      return { text: `已加入队列：${bvid}（${r && r.ok ? '成功' : JSON.stringify(r).slice(0, 120)}）\n当前：${queueLine(q)}` }
    }
    if (op === 'archive') {
      const a = await api(`/api/archive?page=1&size=${limit}`)
      const rows = (a && a.rows) || []
      const lines = rows.map((r, i) => {
        const tag = r.sum_state === 'formal' ? '正式版' : r.sum_state === 'pending' ? '待写' : r.sum_state === 'worthless' ? '不值得写' : r.sum_state === 'optional' ? '灰区可选' : '未评估'
        const mins = r.minutes ? Number(r.minutes).toFixed(1) + 'min' : fmtMin(r.duration_sec)
        return `${i + 1}. [${r.day || ''} ${r.at_short || ''}] ${r.title || r.bvid}（${mins}）· ${r.depth} · ${r.tokens || r.total_tokens || 0} tok · ${fen(r.fen)}分 · ${tag}${r.dm_sent ? ' · 📨已投递' : ''}`
      })
      return { text: `归档共 ${a.total || rows.length} 条，最近 ${rows.length} 条：\n${lines.join('\n')}` }
    }
    if (op === 'pending') {
      const p = await api(`/api/summary/queue?limit=${limit}`)
      const rows = (p && p.rows) || []
      if (!rows.length) return { text: '没有待写正式版总结的视频。' }
      const lines = rows.map((r, i) => `${i + 1}. ${r.title || r.bv}（${Number(r.minutes || 0).toFixed(1)}min）· 密度 ${r.density} · 事实 ${r.facts} · 争议 ${r.disputes} · 门禁 ${r.route} · 优先级 ${r.priority}`)
      const guide = await personaGuide()
      return { text: `待写 ${p.total || rows.length} 条 · 今日已写 ${p.writtenToday}/${p.cap}（模式 ${p.mode}）：\n${lines.join('\n')}\n写完调用 video_write_summary（会自动私信投递）。${guide.block ? `\n\n按这个人设口吻写（只影响"怎么说"，结论/数字/时间码不许改）：${guide.block}` : ''}` }
    }
    const q = await api('/api/queue')
    const running = (q.running || []).map(r => `进行中 ${r.bvid} ${r.title || ''}（已跑 ${r.last_seen || ''}）`)
    const queued = (q.queue || []).map(r => `排队中 ${r.bvid} ${r.title || ''}`)
    const cand = (q.candidates || []).slice(0, limit).map(r => `候选中 ${r.bvid} 分 ${r.score} ${r.title || ''}`)
    return { text: `${queueLine(q)}\n${[...running, ...queued, ...cand].join('\n') || '（空）'}` }
  },
})

function queueLine(q) {
  const s = (q && q.stats) || {}
  const d = s.dispatch || {}
  return `进行中 ${s.running || 0} · 排队中 ${s.queued || 0} · 候选中 ${s.candidate || 0} · 异常 ${s.failed || 0}；自动投递 ${d.enabled === false ? '关' : '开'} · 今日入列 ${s.enlistedToday || 0}/${d.dailyEnlist || '?'} · 待处理 ${s.pending || 0}/${d.autoMaxPending || '?'}`
}

/* ---------- 工具 3：video_write_summary ---------- */
const writeTool = () => defineTool && defineTool({
  name: 'video_write_summary',
  description: '给一条已看过的视频写「云端正式版总结」并落盘（这一步由你写，不要用本地小模型）。写完服务端会立刻私信投递给推送账号（评论通道被压审时只走私信）。写法要求：gist ≤120 字讲清谁做的、做了什么、结论，最多带 1–2 个数字；bullets 3–6 条，每条 ≤90 字，一条只说一件事，按本次结构写（默认技术审阅式：手段 → 机制/参数 → 代价；拆解/教程类：先/再/最后），时间码写在句末；take ≤180 字评估：证据强度 + 可复现性 + 有没有越界，末句明确「值得看 / 一般 / 不值得看 + 一句为什么」，不加「我的评估：」前缀；mark 写最值得看的那个时间码；caveat ≤60 字，只写视频本身没交代的地方（没给型号 / 没说结论 / 没给数据出处），绝对不写我们是怎么看这条片的（画面文字 / 台词 / 字幕 / OCR / 转录 / 材料 / 素材 / 样本 / 核对），没有就留空；comment 开头固定写 @推送账号。正文不许取证腔（画面写着 / 台词里说 / 来自画面文字 / 材料 / 素材 / 我核对过）；只写这条视频里有的，不要编，结尾只写 BV 号。',
  parameters: {
    bv: { type: 'string', required: true, description: 'BV 号' },
    gist: { type: 'string', required: true, description: '谁做的 + 做了什么 + 结论（≤120 字），最多带 1–2 个关键数字' },
    bullets: { type: 'array', items: { type: 'string' }, description: '要点 3–6 条，每条 ≤90 字，一条只说一件事；时间码写在句末' },
    mark: { type: 'string', description: '最值得看的时间码，如 14:18' },
    verdict: { type: 'string', description: '值得看 / 一般 / 不值得看' },
    caveat: { type: 'string', description: '只写视频本身没交代的地方（没给型号 / 没说结论 / 没给数据出处）≤60 字；不写我们是怎么看的（画面文字 / 台词 / 字幕 / OCR / 转录 / 材料 / 素材 / 样本 / 核对），没有就留空' },
    take: { type: 'string', description: '我的评估（≤180 字）：证据强度（实测/演示/公式/引用）+ 方法可不可复现 + 结论有没有越界；末句必须明确「值得看 / 一般 / 不值得看 + 一句为什么」。不加「我的评估：」前缀，不写过程括注。型号/数字/单位只能引自材料，不换算、不补尾号' },
    comment: { type: 'string', description: '（可选，v37）投递用的评论区那一句：开头 @ 推送账号，按面板「评论上限」字写，只写一句信息核，不注水。不填或写不合格时服务端会退回规则拼装。' },
  },
  output: {
    /* 注意：output.schema 不能写 required（宿主编译时 allowRequired=false，会抛 JsonSchemaError） */
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: '给模型看的文本' } } },
    render: (_a, v) => [{ type: 'text', text: String(v && v.text ? v.text : '') }],
  },
  isConcurrencySafe: () => false,
  timeoutMs: 60000,
  async execute(args) {
    const rawBv = String(args.bv || '').trim()
    /* v33 预览通道：bv 用 `PREVIEW<token>` 表示「这只是面板要看的样例」，只塞回内存，不写文件、不投递。
       （理由见 installWatch 里的云端预览桥：宿主没给插件拿模型回复的 API，只能借这个工具把正文兜回来。） */
    if (/^PREVIEW[0-9A-Za-z-]{0,60}$/.test(rawBv)) {
      const token = rawBv.slice('PREVIEW'.length)
      let text = String(args.gist || '').trim()
      if (!text) return { text: '预览正文为空' }
      /* v40（C4-6）：预览也要按人设白名单洗一遍，面板看到的 = 写盘后会存的样子（洗空则保留原文） */
      try {
        const g0 = await personaGuide()
        if (typeof g0.clean === 'function') text = g0.clean(text) || text
      } catch (e) { /* 读不到人设就原样预览 */ }
      globalThis.__vdPreviewBox = { token, text, at: Date.now(), persona: String(args.verdict || '') }
      return { text: '预览已生成（只显示在面板，没有写文件、没有投递）' }
    }
    const bv = rawBv
    if (!/^BV[0-9A-Za-z]{6,14}$/.test(bv)) return { text: '需要一个合法 BV 号' }
    const gistRaw = String(args.gist || '').trim()
    if (!gistRaw) return { text: 'gist 不能为空' }
    const guide = await personaGuide()
    /* v40（C4-6）：写盘前按人设白名单清洗正文，别让宿主的旧口癖（嗯/然后/其实…）落到最终稿。
       清洗函数读不到时（人设文件坏了）按原样提交，不阻塞写盘。 */
    const cleanTxt = (x) => (typeof guide.clean === 'function' ? guide.clean(String(x == null ? '' : x)) : String(x == null ? '' : x))
    const gist = cleanTxt(gistRaw)
    if (!gist) return { text: 'gist 清洗后为空（整句都是人设禁用语气词），请换成人话重写' }
    const bullets = (Array.isArray(args.bullets) ? args.bullets : []).map((x) => cleanTxt(x)).filter((x) => String(x || '').trim())
    const caveat = cleanTxt(String(args.caveat || '').trim())
    const take = cleanTxt(String(args.take || '').trim())
    const comment = cleanTxt(String(args.comment || '').trim())
    const r = await api('/api/summary/write', {
      method: 'POST',
      body: {
        bv, gist,
        bullets,
        mark: args.mark || '', verdict: args.verdict || '', caveat, take,
        comment,
        model: 'deepseek-flash (session)', note: 'plugin-tool',
        persona: guide.key && guide.key !== 'none' ? guide.key : '',
      },
    })
    if (!r || r.error) return { text: `写失败：${r && r.error}` }
    const dv = r.deliver || {}
    const dvText = dv.ok ? (dv.queued ? '已排队投递' : '已投递') : `未投递（${dv.error || '未就绪'}）`
    return { text: `已写入 out/${bv}/summary.cloud.json（${gist.length} 字 gist / ${(args.bullets || []).length} 条要点 · 人设 ${guide.key}）· ${dvText}${guide.block ? '' : '\n注意：人设没读到（config/persona.json），这一版是中性口吻。'}` }
  },
})

/* ---------- 贴链接时的一句旁白（不改用户的话） ---------- */
const RE_FULL = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/i
const RE_BARE = /(?<![0-9A-Za-z])(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/

/* 导出给离线测试用（bundle 只消费 apply/name/inject/default，多导出一个无害） */
export function singleVideoLinkIn(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  if (blocks.some(b => b && b.type !== 'text')) return null
  let text = blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n')
  text = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, ' ').replace(/<attached_files[\s\S]*?<\/attached_files>/gi, ' ')
  if (!text.trim()) return null
  const hits = []
  const reF = new RegExp(RE_FULL.source, 'gi')
  let m
  while ((m = reF.exec(text))) hits.push({ bv: m[1] })
  if (!hits.length) {
    const reB = new RegExp(RE_BARE.source, 'g')
    while ((m = reB.exec(text))) hits.push({ bv: m[1] })
  }
  if (hits.length !== 1) return null
  const residual = text.replace(/https?:\/\/\S+/g, '').replace(/BV[0-9A-Za-z]{10}/g, '').replace(/[\s。，、！？!?,.;；:：·…~～—\-"'“”‘’（）()【】\[\]]/g, '')
  if (residual) return null
  return hits[0].bv
}

function installPreStep(ctx) {
  if (!CFG.preStepHint) return
  if (!createUserMessage || typeof ctx.on !== 'function') { log('pre-step 跳过：缺 dsh-llm 或 ctx.on'); return }
  const hinted = new Set()
  const HINT_CAP = 200
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || payload.step !== 1) return decision
      if (payload.signal?.aborted) return decision
      const fresh = []
      for (const msg of decision.messages || []) {
        if (msg?.source?.kind !== 'user') continue
        if (hinted.has(msg.id)) continue
        const bv = singleVideoLinkIn(msg)
        if (!bv) continue
        hinted.add(msg.id)
        if (hinted.size > HINT_CAP) hinted.clear()
        fresh.push(createUserMessage({
          content: [{ type: 'text', text: `[video-digest] 这条消息只有一条 B 站视频链接（BV ${bv}）。要读内容就调 video_digest（source="${bv}"，depth 默认 T3）；用户没说要你看时不要自己跑。跑完的清单与成本都在返回里，宫格在 out/${bv}/sheet.png。` }],
          source: { kind: NAME, form: 'notice', summary: boundContextSummary?.('检测到单条 B 站视频链接') ?? '检测到单条 B 站视频链接' },
        }))
      }
      if (!fresh.length) return decision
      log(`pre-step 插话：${fresh.map(f => String(f?.content?.[0]?.text || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || '?').join(',')}（本轮共 ${(decision.messages || []).length} 条消息）`)
      return { ...decision, messages: [...decision.messages, ...fresh] }
    } catch (e) {
      log('pre-step 出错（已忽略）：' + (e?.message || e))
      return decision
    }
  })
  log('pre-step 已挂：对话里只有一条 B 站链接时会当回合插一句旁白')
}

/* ---------- 定时：每 5 分钟催一次入站轮询（0 token） ---------- */
function installTimer(ctx) {
  const tick = async () => {
    try {
      const h = await api('/api/health', { timeoutMs: 5000 })
      if (h.error) return
      const r = await api('/api/inbox/poll', { timeoutMs: 25000 })
      if (r && (r.enqueued || r.added || r.ok)) log('inbox poll ' + JSON.stringify(r).slice(0, 300))
    } catch (e) { log('timer 出错（已忽略）：' + (e?.message || e)) }
  }
  const ms = Math.max(60 * 1000, Number(CFG.pollMs) || DEFAULTS.pollMs)
  /* 2026-10-31 实测：直接读 ctx.interval 会抛
     `Error: cannot get property "timer" without inject`（cordis 的服务访问守卫，读属性就炸）。
     两种办法：声明 inject=['timer']（拿不到 timer 服务时插件会一直 pending，风险更大），
     或者干脆用全局 setInterval —— bili-watch 自己也是这么干的。这里选后者，并且仍然先礼貌试一下 ctx.interval。 */
  const tryCtx = () => {
    try {
      if (typeof ctx.interval === 'function') { ctx.interval(tick, ms); return true }
      if (typeof ctx.setInterval === 'function') { ctx.setInterval(tick, ms); return true }
    } catch (e) { log('ctx.interval 不可用（改用全局定时器）：' + (e?.message || e)) }
    return false
  }
  if (tryCtx()) { log(`timer 已挂（cordis）：每 ${ms / 1000}s 入站轮询`); return }
  /* 定时器回调里抛错会带走整个宿主进程（bili-watch index.js:1691 记过这个事故），所以 tick 内部全包 try/catch。 */
  try {
    const t = setInterval(() => { tick().catch(e => log('timer 出错（已忽略）：' + (e?.message || e))) }, ms)
    if (t && typeof t.unref === 'function') t.unref()
    log(`timer 已挂（全局 setInterval）：每 ${ms / 1000}s 入站轮询`)
  } catch (e) { log('timer 跳过：' + (e?.message || e)) }
}

/* ---------- 守候：钟每 60s 敲一次，只有「真的有待写」才叫醒会话 ----------
   参考实现：`vendor\dsh-video-storyboard@0.4.5\src\timer.js` + `src\index.js:360-376`。
     · 钟可以敲得很密（纯本地比较，几乎不花钱），但**只有到点才叫醒**——它的注释原话：
       「叫醒一次 = 往会话里投一条消息 = 模型要跑一轮，很贵」。
     · 当前会话 id 从 `ctx.on('session/event', s => s?.header?.id ?? s?.id)` 拿（dsh-fish 的做法）；
       它明确警告过「反射 ctx 会把整个应用搞崩」，所以只走事件。
     · 叫醒用 `ctx.sessionController.prompt({ requestId, sessionId, mode:'queue', content }, signal)`，
       queue 模式入队即返回，不等模型想完。
   为什么插件不自己调模型写总结：扫遍 8 个 vendor 插件，没有一个用 llm 服务写散文——
   bili-scroll 的 `ctx.get('llm')` 只用来 `resolveModelInfo` 查模型能力。写总结只能落到会话模型上。
*/
function installWatch(ctx) {
  /* 取 sessionController 的两条路：
     asar 里查到的服务表（`packages/api/session-controller/src/index.ts`）里 `session/prompt` 的
     `service: "sessionController"`，所以它是个普通服务：既可以用 ctx.get 拿，也可以是 ctx 上的属性。 */
  const resolveSc = () => {
    // inject 已声明，ctx.sessionController 就是注入进来的服务；ctx.get 作为兜底
    try { const s = ctx.sessionController; if (s && typeof s.prompt === 'function') return { sc: s, via: 'ctx.sessionController' } } catch (e) { log('watch 读 ctx.sessionController 失败：' + (e?.message || e)) }
    try { const s = ctx.get?.('sessionController'); if (s && typeof s.prompt === 'function') return { sc: s, via: 'ctx.get' } } catch (e) {}
    return { sc: null, via: null }
  }
  const got = resolveSc()
  const sc = got.sc
  if (!sc) { log('watch 未挂：没有 sessionController（自动写总结不可用）'); return }

  /* ---------- 专用工作会话 ----------
     为什么要专用会话：往「我们正在聊天」的会话里塞消息，会话空闲时不会自己跑一轮（2026-10-31 实测：
     03:56 叫醒过一次，消息进了队列但没人接着跑，最后什么都没发生）。
     whale 的做法（lib/session-delivery.js:38,65）是：固定一个 sessionId → create({sessionId,cwd}) 建/恢复
     → prompt({sessionId})。这样工作会话被真正拉起来跑，跟用户当前会话互不打扰。 */
  const SESS_FILE = join(ROOT, 'logs', 'digest-session.json')
  const loadState = () => {
    try {
      const s = JSON.parse(readFileSync(SESS_FILE, 'utf8'))
      if (typeof s.id === 'string' && s.id) return s
    } catch (e) {}
    return null
  }
  const saveState = (s) => {
    try {
      mkdirSync(dirname(SESS_FILE), { recursive: true })
      const tmp = SESS_FILE + '.' + Math.random().toString(36).slice(2) + '.tmp'
      writeFileSync(tmp, JSON.stringify(s))
      renameSync(tmp, SESS_FILE)
    } catch (e) { log('watch 保存工作会话状态失败：' + (e?.message || e)) }
  }

  const st0 = loadState()
  const state = {
    id: (st0 && st0.id) || randomUUID(),
    createdAt: (st0 && st0.createdAt) || Date.now(),
    lastAt: (st0 && st0.lastAt) || 0,
    recent: (st0 && Array.isArray(st0.recent)) ? st0.recent : [],
    nudged: (st0 && st0.nudged && typeof st0.nudged === 'object') ? st0.nudged : {},
    turns: (st0 && Number(st0.turns)) || 0,
    booted: false,
  }
  const persist = () => saveState({
    id: state.id, createdAt: state.createdAt, lastAt: state.lastAt,
    recent: state.recent.slice(-40), nudged: state.nudged, turns: state.turns,
  })

  /* v34：定期轮换工作会话。
     工作会话的历史只增不减（摘要工人每写一条就多一轮「读文件 + 调工具」的记录），
     实测到 38 MB ≈ 160 万 token —— 之后**每一次**投递都要把这段历史重新计费一遍，
     这才是「一条 2 毛钱」的主因，不只是预览。每写满 N 条就换一个新会话（旧会话留着可查），
     单条成本回落到「首轮系统提示 + 一条材料」的量级。默认 6 条一换，可用 config/plugin.json 的
     watchRotateTurns 调；设 0 表示永不轮换。 */
  const rotateTurns = (() => {
    const v = Number(CFG.watchRotateTurns)
    if (Number.isFinite(v) && v >= 0) return Math.floor(v)
    const d = Number(DEFAULTS.watchRotateTurns)
    return Number.isFinite(d) && d >= 0 ? Math.floor(d) : 6
  })()
  const rotateSession = (whyRotate) => {
    const old = state.id
    state.id = randomUUID()
    state.createdAt = Date.now()
    state.turns = 0
    state.booted = false
    persist()
    log(`watch 轮换工作会话：${old} → ${state.id}（${whyRotate}）`)
  }

  /* 建 / 恢复工作会话。DSH 的 create() 返回 {sessionId,agentPreset}，分不出新建还是复用（whale 注释同款坑），
     所以拿异常当"已存在"处理，直接进 prompt。 */
  const ensureSession = async () => {
    if (state.booted) return
    try {
      const r = await sc.create({ sessionId: state.id, cwd: ROOT })
      log(`watch 工作会话就绪：${(r && (r.sessionId || r.id)) || state.id}`)
    } catch (e) {
      log('watch 工作会话 create 未成功（可能是已存在，继续投递）：' + (e?.message || e))
    }
    state.booted = true
    persist()
  }

  /* ---------- 云端预览桥（v33） ----------
     「个性化的实时预览直接让云端模型跑，就是要最真实的反馈；跑的内容是选取最近归档
     视频中被投递的视频作为模板」。宿主没有给插件「直接拿模型回复」的 API，所以走一条已验证的通路：
       1) 把「写一条样例」的指示投给工作会话（和摘要工人同一条 sc.prompt 通道）；
       2) 指示它用完调用 video_write_summary，bv 用 `PREVIEW<token>` —— 那个工具会把正文塞进
          globalThis.__vdPreviewBox，且**不写文件、不投递**；
       3) 这里轮询那个盒子，拿到正文就返回；超时/失败返回结构化 error，面板据此退回本地 8B。
     为什么挂 globalThis：面板模块会随 mtime 反复重载，只有宿主进程里的全局对象是稳定的。 */
  const PREVIEW_TIMEOUT = 120000
  const previewBox = () => (globalThis.__vdPreviewBox = globalThis.__vdPreviewBox || { at: 0, token: '', text: '' })

  const previewInstruction = (target, bv, token, guide) => {
    const t = target === 'comment' ? 'comment' : target === 'dm' ? 'dm' : 'summary'
    const form = t === 'comment'
      ? '一条评论区回复：开头 @ 推送账号，正文只有一句「信息核」（不超过 40 字，带时间码更好），句尾可以点一下人设口气；不要【】抬头、不要编号清单。'
      : t === 'dm'
        ? '一条私信：自然段落，第一句说清这条视频讲了什么，中间 1–2 个关键点（带时间码），最后一句评价；结尾单独一行写 BV 号；不要【】抬头、不要「1. 2.」编号清单。'
        : '一份总结正文：自然段落（讲了什么 → 值得说的点 → 我的看法），不要【】抬头、不要小标题、不要编号清单、不要「本视频/该视频/值得一看」这类总结腔；最后一行单独写 BV 号。'
    return [
      '【预览样例生成 · 不是正式任务】不要向用户提问、不要等确认，直接做完。',
      '用途：用户在面板里点「生成预览」，只想看**按当前人设口吻写出来是什么样**，不是要发出去。',
      `材料：out/${bv}/summary.cloud.json（这条已投递的总结）与 out/${bv}/factcard.json（事实卡）。先读这两个文件。`,
      `要写的东西：${form}`,
      '人设与写法（照它来，但绝不许改事实）：',
      (guide && guide.block) ? guide.block : '(人设没读到，按中性口吻写)',
      '收尾：只调用一次 `video_write_summary`，参数 bv 填 `PREVIEW' + token + '`，gist 填你写好的整段正文，其它字段留空。不要写文件、不要投递。',
      '规矩：事实/数字/型号/时间码全部沿用 summary.cloud.json，一个都不许新编；写不好就少写，不要硬凑。',
    ].join('\n')
  }

  async function previewViaCloud(opts = {}) {
    const target = String(opts.target || 'summary')
    const t0 = Date.now()
    const token = 'p' + t0.toString(36) + Math.random().toString(36).slice(2, 6)
    try {
      const bv = /^BV[0-9A-Za-z]{10}$/.test(String(opts.bv || '')) ? String(opts.bv) : ''
      if (!bv) return { ok: false, error: { code: 'no-sample', zh: '没拿到样例视频（面板应传最近一条已投递的 bv）' } }
      await ensureSession()
      const guide = await personaGuide()
      const box = previewBox()
      box.at = 0; box.token = ''; box.text = ''
      const ac = new AbortController()
      const kill = setTimeout(() => ac.abort(), 30000)
      try {
        await sc.prompt({
          requestId: 'preview-' + token,
          sessionId: state.id,
          mode: 'queue',
          content: [{ type: 'text', text: previewInstruction(target, bv, token, guide) }],
        }, ac.signal)
      } finally { clearTimeout(kill) }
      while (Date.now() - t0 < PREVIEW_TIMEOUT) {
        const b = previewBox()
        if (b && b.token === token && b.text) {
          return { ok: true, text: String(b.text), engine: 'cloud', bv, token, ms: Date.now() - t0, model: 'dsh-session', personaKey: guide.key }
        }
        await new Promise((r) => setTimeout(r, 400))
      }
      return { ok: false, error: { code: 'timeout', zh: '云端写手 ' + Math.round(PREVIEW_TIMEOUT / 1000) + ' 秒内没交稿（会话可能正忙）' }, bv }
    } catch (e) {
      return { ok: false, error: { code: 'bridge-failed', zh: '云端预览调用失败：' + String((e && e.message) || e) } }
    }
  }

  globalThis.__vdCloud = { version: 'v33', preview: previewViaCloud }
  log('云端预览桥已挂：globalThis.__vdCloud.preview')

  /* ---------- 直连模型桥（v34 起；v35 按 better-sidebar 的范式补齐成本开关） ----------
     「生成一条 2 毛钱太贵了」。病根不是模型贵，是**通路贵**：
       · 预览走 sc.prompt 投给摘要工人会话，而那个会话的历史已经涨到 38 MB（≈160 万 token）；
       · 每问一句，整段历史都要重新计费（缓存命中 0.02 元/百万 token，未命中 1 元/百万）；
       · 再加上「读两个文件 → 调一次工具」的两三轮，一次预览实扣 0.09–0.17 元（DSH 账本对得上）。
     改法：只要「一段短文本」时，直接调 DSH 官方 llm 服务（ctx.get('llm').stream）：
     材料内联进 prompt、单轮、无历史、无工具循环。
     v35 参考 dsh-better-sidebar（本机最规范的直连实现）补了四个「省钱开关」：
       ① 人设/规则放 `system`、材料放 user → 稳定前缀吃提示词缓存（0.02 vs 1 元/百万，差 50 倍）；
       ② `reasoningEffort` 显式取模型声明的最低档（DeepSeek 适配器默认 high，思考 token 另计且很贵，
          还可能把输出预算烧光、最后只回空串）；
       ③ `maxTokens` 硬上限（评论 160 / 私信 520 / 总结 760），不让它自由发挥；
       ④ `AbortSignal.timeout` 兜底，卡住不留僵尸调用。 */
  const REASONING_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const lowestEffortOf = (efforts) => {
    if (!Array.isArray(efforts)) return undefined
    const ids = efforts.map((x) => (x && typeof x === 'object' ? x.id : undefined)).filter((x) => typeof x === 'string' && x)
    let best
    let bestRank = Infinity
    for (const id of ids) {
      const rank = REASONING_LADDER.indexOf(id)
      // 未知档位排在所有已知档位之后，但保留它（适配器可能自定义了档位名）
      const r = rank < 0 ? 100 + ids.indexOf(id) : rank
      if (r < bestRank) { best = id; bestRank = r }
    }
    return best
  }
  let LLM_LIB = null
  const loadLlmLib = async () => {
    if (LLM_LIB !== null) return LLM_LIB
    try { LLM_LIB = await import('@deepseek-ai/dsh-llm') } catch (e) { LLM_LIB = false }
    return LLM_LIB
  }
  const resolveLlm = () => {
    try { const l = ctx.get?.('llm') || ctx.llm; if (l && typeof l.stream === 'function') return l } catch (e) {}
    return null
  }
  const resolveSel = () => {
    try {
      const d = ctx.get?.('agentDefaultModel') || ctx.agentDefaultModel
      const s = d && typeof d.currentSelection === 'function' ? d.currentSelection() : null
      if (s && s.provider && s.model) return { provider: s.provider, model: s.model }
    } catch (e) {}
    return null
  }
  const resolveRoute = async (llm) => {
    const sel = resolveSel()
    if (sel) return sel
    const provs = (typeof llm.listProviders === 'function' && (await llm.listProviders())) || []
    const pid = (provs[0] && (provs[0].id || provs[0].provider)) || ''
    if (!pid) return null
    const models = (typeof llm.listModels === 'function' && (await llm.listModels(pid))) || []
    const mid = (models[0] && (models[0].id || models[0].model)) || ''
    return mid ? { provider: pid, model: mid } : null
  }
  /** 直连生成：单轮、无历史、无工具。system 放稳定规则，user 放这次的材料。 */
  const llmGen = async (opts) => {
    const o = opts || {}
    const llm = resolveLlm()
    if (!llm) return { ok: false, error: { code: 'no-llm', zh: '宿主没有 llm 服务' } }
    const route = await resolveRoute(llm)
    if (!route) return { ok: false, error: { code: 'no-provider', zh: '没有可用的模型 provider' } }
    const lib = await loadLlmLib()
    const maxTokens = Math.max(64, Math.min(4000, Number(o.maxTokens) || 760))
    const temperature = o.temperature === undefined ? 0.35 : Number(o.temperature)
    let effort
    try {
      const info = typeof llm.resolveModelInfo === 'function' && (await llm.resolveModelInfo(route.provider, route.model))
      effort = lowestEffortOf(info && info.reasoning && info.reasoning.efforts)
    } catch (e) {}
    const t0 = Date.now()
    try {
      const mkUser = lib && typeof lib.createUserMessage === 'function'
        ? lib.createUserMessage({
          content: [{ type: 'text', text: String(o.user || '') }],
          source: { kind: 'plugin:dsh-video-digest' },
        })
        : { role: 'user', content: [{ type: 'text', text: String(o.user || '') }] }
      const req = {
        provider: route.provider,
        model: route.model,
        messages: [mkUser],
        ...(o.system ? { system: String(o.system) } : {}),
        temperature,
        maxTokens,
        signal: AbortSignal.timeout(Math.max(5000, Number(o.timeoutMs) || 60000)),
        ...(effort && lib && typeof lib.ReasoningEffortId === 'function' ? { reasoningEffort: lib.ReasoningEffortId(effort) } : {}),
      }
      let text = ''
      let usage = null
      let finish = null
      const assembler = lib && typeof lib.BlockAssembler === 'function' ? new lib.BlockAssembler() : null
      for await (const ch of llm.stream(req)) {
        if (!ch) continue
        if (assembler) { try { assembler.push(ch) } catch (e) {} }
        if (ch.type === 'text-delta') text += ch.text || ''
        else if (ch.type === 'usage') usage = ch.usage || ch
        else if (ch.type === 'finish') finish = ch.reason || ch
      }
      if (assembler) {
        try {
          const joined = assembler.blocks().map((b) => (b && b.type === 'text' ? b.text : '')).join('')
          if (joined) text = joined
        } catch (e) {}
      }
      text = String(text || '').trim()
      if (!text) {
        const fk = finish && finish.kind
        return { ok: false, error: { code: 'empty', zh: '模型没有返回正文' + (fk ? '（finish=' + fk + '）' : '') }, provider: route.provider, model: route.model, effort, maxTokens }
      }
      /* v36：把这次直连调用记进本插件自己的花费账（有真实 usage，精确） */
      const u = usage || {}
      const inTok = Number(u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? 0) || 0
      const outTok = Number(u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? 0) || 0
      const yuan = spendYuan(inTok, outTok)
      /* v36：预览的账由面板侧记（panel_server 的 appendSpend），这里不重复记，避免同一笔算两次。
         v49：直连总结（purpose='summary'）同样由面板 applySummaryWrite 记一笔 kind='summarize'，
         插件这边再记一次会让面板账本虚高一倍（生产实测 14/14 成对）。所以这两类都不在这里记。 */
      if (o.purpose !== 'preview' && o.purpose !== 'summary') appendSpend({ kind: o.purpose || 'direct', bv: o.bv || '', target: o.target || '', model: route.model, input: inTok, output: outTok, yuan, source: 'usage', ms: Date.now() - t0 })
      return { ok: true, text, provider: route.provider, model: route.model, effort, maxTokens, usage, yuan, tokens: { input: inTok, output: outTok }, ms: Date.now() - t0 }
    } catch (e) {
      const msg = String((e && e.message) || e)
      return {
        ok: false,
        error: { code: /abort|timeout/i.test(msg) ? 'timeout' : 'llm-failed', zh: '直连模型调用失败：' + msg },
        provider: route.provider,
        model: route.model,
      }
    }
  }
  const llmQuick = (prompt) => llmGen({ user: prompt })
  globalThis.__vdLlm = {
    version: 'v35',
    gen: llmGen,
    quick: llmQuick,
    sel: resolveSel,
    info: () => {
      const sel = resolveSel()
      return { version: 'v35', hasLlm: !!resolveLlm(), route: sel, libLoaded: !!LLM_LIB }
    },
  }
  log('直连模型桥已挂：globalThis.__vdLlm.gen/quick（system+user 分离、reasoning 最低档、maxTokens 硬上限）')

  const ms = Math.max(30 * 1000, Number(CFG.watchMs) || DEFAULTS.watchMs)
  const cooldown = Math.max(60 * 1000, Number(CFG.watchCooldownMs) || DEFAULTS.watchCooldownMs)
  const perHour = Math.max(1, Math.min(30, Number(CFG.watchPerHour) || DEFAULTS.watchPerHour))
  const why = { v: 'init' }

  /* v34：把材料**内联**进投递内容（省 token）。
     原来让工人在会话里自己 read 5 个文件：每次 read 都是一轮完整的模型调用，
     而会话历史里的每一轮都会在后续请求中重新计费——单条总结因此涨到 0.1–0.2 元。
     现在插件先把材料读出来、按上限截断后拼进 prompt，工人只需要「写 + 调一次工具」两轮。 */
  const readCap = (file, cap) => {
    try {
      const s = readFileSync(file, 'utf8')
      if (!s) return ''
      return s.length > cap ? (s.slice(0, cap) + `\n…（已截断，原文 ${s.length} 字）`) : s
    } catch (e) { return '' }
  }
  /* v50：材料统一走 scripts/lib/material.mjs 的 brief（时间码逐段 + 事实 + 弹幕），
     不再塞 factcard.json / manifest.txt 原文（行首「格」编号会被模型抄进正文）；
     material.mjs 读不到时退回旧行为（裸 factcard.json），降级绝不抛。 */
  const inlineMaterial = async (bv) => {
    const dir = join(ROOT, 'out', bv)
    const parts = []
    let fcObj = null
    try { fcObj = readJson(join(dir, 'factcard.json')) } catch (e) { fcObj = null }
    let brief = ''
    if (fcObj) {
      try {
        const mUrl = pathToFileURL(join(CODE_ROOT, 'scripts', 'lib', 'material.mjs')).href + '?v=' + Date.now()
        const mat = await import(mUrl)
        if (mat && typeof mat.materialBrief === 'function') brief = String(mat.materialBrief(fcObj) || '')
      } catch (e) { brief = '' }
    }
    if (brief) {
      parts.push('#### 这条视频的内容\n' + brief)
    } else {
      const fc = readCap(join(dir, 'factcard.json'), 2600)
      if (fc) parts.push('#### factcard.json（事实卡：密度/事实/弹幕统计）\n' + fc)
      const man = readCap(join(dir, 'manifest.txt'), 6000)
      if (man) parts.push('#### manifest.txt（逐段时间码 + 台词摘录）\n' + man)
    }
    const ocr = readCap(join(dir, 'ocr.txt'), 2000)
    if (ocr) parts.push('#### ocr.txt（画面文字全文，补充用）\n' + ocr)
    return parts.length ? parts.join('\n\n') : ''
  }

  /* v38：正式总结优先「直连模型一次调用」——
     之前每条总结都要叫醒工作会话，会话历史每轮重算（单条 0.1–0.2 元）；直连是单轮、材料内联，
     一条约 0.004–0.01 元。写完直接调面板挂在全局的 __vdSummaryWrite 落盘（同进程，不绕 HTTP/工具）。
     只在内联材料齐、直连可用、配置没关时才走；任何一步失败都原样回落下面的会话通路。 */

  /** 读「总结来源」配置（只看 directSummary 开关；读不到按开） */
  const summCfg = () => {
    try {
      const raw = readJson(join(ROOT, 'config', 'summarize.json')) || {}
      return { directSummary: raw.directSummary !== false }
    } catch (e) { return { directSummary: true } }
  }

  /** 直连总结的 system 段：人设 + 模板硬规矩 + JSON 契约 + 篇幅契约（稳定前缀，吃提示词缓存） */
  const buildDirectParts = (pick, material, guide, dmContract) => {
    const shape = (guide && guide.shape) || {}
    const maxChars = Number(shape.summaryMax) || 900
    /* v56：字段契约复用 scripts/lib/dm-json.mjs（与面板预览「按字段生成 → buildDm 渲染」同一份真源）；
       模块读不到时退回本地副本，降级不炸。 */
    const fallbackContract = '{"gist":"≤120 字（硬上限 240）：第一句说清领域/类型 + 对象 + 核心主张；第二句起再说谁做的 + 做了什么 + 结论","bullets":["3–6 条，每条 ≤90 字；按上面「结构」写，前 4 条会进私信；型号/数字/单位逐字引自材料，不换算、不补尾号"],"mark":"mm:ss","verdict":"值得看 / 一般 / 不值得看","caveat":"≤60 字，只写视频没交代清楚的地方","take":"≤180 字评估：证据强度 + 可复现性 + 有没有越界，末句给「值得看 / 一般 / 不值得看 + 一句为什么」","evidence":["2–4 条，带 [mm:ss]"],"comment":"留空"}'
    const contract = dmContract && dmContract.system ? dmContract.system : fallbackContract
    const system = [
      '你在帮「一起看视频」写一条云端正式版总结。只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
      '',
      '---- 这套总结模板的硬规矩（面板「个性化 → 总结模板」里可改；含人设语气块）----',
      (guide && guide.rules) || '',
      '',
      '---- 输出 JSON 契约（字段名固定，缺字段会被判失败；与面板预览共用同一份）----',
      contract,
      '',
      lenContract('summary', maxChars),
      '',
      '写法人味：bullets 用完整句子写具体内容，不要「1. 参数：…」报菜名；不要「本视频/该视频/综上所述/值得一看/令人印象深刻/首先其次最后」这类总结腔；判断必须有立场，并且能在片子里指到具体一处。',
      '第一句先回答「这条视频讲的是什么」：领域/类型 + 对象 + 结论；只复述标题口号（「讲的是『XX』」）算不合格，读到的人必须不用猜。',
      '片子里没讲到的维度（比如为什么做）就写一句「这条没讲」，不许猜、不许编，也不许解释你是怎么看的。',
      '正文（gist / bullets / take）不许出现「画面写着 / 台词里说 / 来自画面文字 / 材料 / 素材 / 我核对过」这类取证腔；没有弹幕原文不许写观众说。',
      '正文里不许出现「第N格/格号/宫格/事实卡/材料/OCR/台词摘录」这类内部说法；要指位置只用 [MM:SS]；整篇最后一行只写 BV 号，不写别的。',
    ].join('\n')
    const mins = pick.minutes ? Number(pick.minutes).toFixed(1) + ' 分钟' : '时长未知'
    const user = [
      '---- 这条视频 ----',
      `BV 号：${pick.bv}`,
      `标题：${pick.title || pick.bv}`,
      `时长：${mins}｜门禁：${pick.route || '?'}｜信息密度：${pick.density ?? '?'}｜事实条目：${pick.facts ?? '?'}｜争议：${pick.disputes ?? '?'}`,
      '',
      material || '（材料缺失）',
    ].join('\n')
    return { system, user, maxTokens: Math.min(2400, Math.max(800, Math.round(maxChars * 3))) }
  }

  /** 从模型输出里取 JSON（容忍 ```json 围栏 / 前后废话），并做最小校验。
   *  v56：优先用 dm-json.mjs 的健壮解析（模型重写两遍 / 追加解释时也能取到第一个完整对象），
   *  再退回首尾大括号的老办法。 */
  const parseSummaryJson = (text, parseDm) => {
    if (typeof parseDm === 'function') {
      const o = parseDm(text)
      if (o && o.gist) {
        return {
          gist: o.gist, bullets: (o.bullets || []).slice(0, 6), mark: o.mark || '',
          verdict: o.verdict || '', caveat: o.caveat || '', take: o.take || '',
          evidence: (o.evidence || []).slice(0, 4), comment: o.comment || '',
        }
      }
    }
    let s = String(text || '').trim()
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    const i = s.indexOf('{'), j = s.lastIndexOf('}')
    if (i < 0 || j <= i) throw new Error('模型没给 JSON')
    const o = JSON.parse(s.slice(i, j + 1))
    const gist = String(o.gist || '').trim()
    if (!gist) throw new Error('gist 为空')
    const bullets = (Array.isArray(o.bullets) ? o.bullets : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 6)
    const mark = /^\d{1,2}:\d{2}$/.test(String(o.mark || '').trim()) ? String(o.mark).trim() : ''
    const verdict = String(o.verdict || '').trim()
    const caveat = [...String(o.caveat || '').trim()].slice(0, 60).join('')
    const take = [...String(o.take || '').trim()].slice(0, 200).join('')
    const evidence = (Array.isArray(o.evidence) ? o.evidence : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 4)
    const comment = String(o.comment || '').replace(/\s+/g, ' ').trim()
    return { gist: [...gist].length > 240 ? [...gist].slice(0, 240).join('') : gist, bullets, mark, verdict, caveat, take, evidence, comment }
  }

  /* v56：dm-json.mjs 是字段契约与解析的唯一真源；插件动态 import（带 ?v=，改完 lib 也不用重启宿主） */
  let DM_JSON = null
  const loadDmJson = async () => {
    if (DM_JSON) return DM_JSON
    try {
      DM_JSON = await import(pathToFileURL(join(CODE_ROOT, 'scripts', 'lib', 'dm-json.mjs')).href + '?v=' + Date.now())
    } catch (e) { DM_JSON = null }
    return DM_JSON
  }

  /** 直连通路是否就绪：面板桥挂上了 + 直连模型桥在 + 配置没关 */
  const directReady = () => typeof globalThis.__vdSummaryWrite === 'function' && !!globalThis.__vdLlm && summCfg().directSummary

  /** 试着走直连写这条总结；成功返回 {ok:true}，失败返回 {ok:false, reason} 由调用方回落会话 */
  const tryDirectSummary = async (pick, material, guide) => {
    if (!material) return { ok: false, reason: '材料缺失' }
    if (!summCfg().directSummary) return { ok: false, reason: '配置关掉了直连' }
    const bridge = globalThis.__vdSummaryWrite
    if (typeof bridge !== 'function') return { ok: false, reason: '面板没加载/桥没挂上' }
    if (!globalThis.__vdLlm) return { ok: false, reason: '直连模型桥没装载' }
    const dmj = await loadDmJson()
    const dmContract = dmj && typeof dmj.dmJsonContract === 'function'
      ? dmj.dmJsonContract(guide && guide.shape, { targetName: (guide && guide.targetName) || '' })
      : null
    const parts = buildDirectParts(pick, material, guide, dmContract)
    const r = await llmGen({ system: parts.system, user: parts.user, maxTokens: parts.maxTokens, temperature: 0.45, timeoutMs: 120000, purpose: 'summary' })
    if (!r || !r.ok || !r.text) return { ok: false, reason: '模型没返回：' + ((r && r.error && (r.error.zh || r.error.code)) || 'unknown') }
    const doc = parseSummaryJson(r.text, dmj && dmj.parseDmJson)
    /* v40（C4-6）：直连通路同样在落盘前按人设白名单清洗（guide 里带 clean，读不到就原样），
       清空说明整段都是禁用口癖 → 不写，回落到下面的工作会话重写。 */
    if (guide && typeof guide.clean === 'function') {
      doc.gist = guide.clean(doc.gist)
      doc.bullets = (doc.bullets || []).map((x) => guide.clean(x)).filter((x) => String(x || '').trim())
      doc.caveat = guide.clean(doc.caveat)
      doc.comment = guide.clean(doc.comment)
      if (!doc.gist) return { ok: false, reason: '直连稿清洗后为空，回落工作会话' }
    }
    const res = bridge({
      bv: pick.bv, gist: doc.gist, bullets: doc.bullets, mark: doc.mark, verdict: doc.verdict,
      caveat: doc.caveat, take: doc.take, evidence: doc.evidence, comment: doc.comment,
      persona: (guide && guide.key) || '', engine: 'direct', model: r.model || '',
      cost: { yuan: r.yuan || 0, tokens: r.tokens || null }, note: 'plugin-direct',
    })
    if (!res || !res.ok) return { ok: false, reason: '落盘失败：' + ((res && res.error) || 'unknown') }
    return { ok: true, model: r.model, yuan: r.yuan, tokens: r.tokens, ms: r.ms }
  }

  const ask = (r, material, guide) => {
    const shape = (guide && guide.shape) || {}
    /* v50：评论开头固定 @ 推送账号名（正式账号名，不是人设里的称呼） */
    const targetName = String((guide && guide.targetName) || '').trim()
    const atName = targetName ? '@' + targetName : '@推送账号'
    const mins = r.minutes ? Number(r.minutes).toFixed(1) + ' 分钟' : '时长未知'
    const hasMat = !!material
    const maxChars = Number(shape && shape.summaryMax) || 900
    return [
      '【视频摘要工人】你是「一起看视频」的摘要工人，跑在专用会话里，**不要向用户提问、不要等确认，直接做完**。',
      `任务：给 ${r.bv}《${r.title || r.bv}》写云端正式版总结。`,
      `已知：${mins}｜门禁 ${r.route || '?'}｜信息密度 ${r.density ?? '?'}｜事实 ${r.facts ?? '?'} 条｜争议 ${r.disputes ?? '?'} 条。`,
      hasMat
        ? '这条视频的内容：**已经全部附在下面**（时间码逐段 + 事实 + 弹幕 + 画面文字摘录）。不要再 read_file 去读（省 token，读一次就是一轮完整调用）。'
        : `这条视频的文件（本地，相对数据目录 ${ROOT}）：out/${r.bv}/factcard.json、ocr.txt、danmaku.txt（不要读 manifest.txt，它的行首是内部编号）。`,
      /* v50：篇幅来自「投递形态 → 总结字数」；结构只跟随「结构」那一条，不再按字数硬切小段 */
      lenContract('summary', maxChars),
      `评论区那条（同一次调用里一起给，别单独写）：用 comment 字段，${Number(shape && shape.commentMax) || 40} 字以内，开头固定写 ${atName}（推送账号名，照抄），只写一句信息核，不注水、不堆语气词；超了会被截断，写不好我们这边会退回规则拼装。`,
      '做法：用 video_write_summary 提交（gist ≤120 字且第一句必须是人话主题句——领域/类型 + 对象 + 结论，只复述标题口号算不合格；bullets 3–6 条每条 ≤90 字，按本次结构写、前 4 条会进私信；take ≤180 字：证据强度 + 可复现性 + 有没有越界，末句给「值得看 / 一般 / 不值得看 + 一句为什么」；mark 用 mm:ss、caveat ≤60 字只写视频本身没交代的、evidence 2–4 条带时间码、comment 按上面的字数）。写完服务端会自动私信投递给推送账号，你不用再发。',
      '数字与型号：逐字引自材料，不换算、不四舍五入、不补单位、不补型号尾号；材料只给系列名或口播原话时就用原话（口播说「家用电二百二百五顶天了」，不能写成「220V、两千多瓦」）；不写「（口播原意）」这类过程括注。',
      '规矩：只写这条视频里有的东西，不许编；片子里没讲到的维度（比如为什么做）就写一句「这条没讲」，不要解释你是怎么看的；正文不许出现「画面写着 / 台词里说 / 来自画面文字 / 材料 / 素材 / 我核对过」这类取证腔，没有弹幕原文不许写观众说；整条视频确实没讲到具体内容才回一句「' + r.bv + ' 不值得写」然后跳过。',
      '正文里不许出现「第N格/格号/宫格/事实卡/材料/OCR/台词摘录」这类内部说法；要指位置只用 [MM:SS]；整篇最后一行只写 BV 号，不写别的。',
      /* v33：用户明确否掉「机械总结」——「开头是【标题】13:56　值得看，这个完全没有意义」 */
      '写法人味（重要，用户明确否掉了机械总结）：',
      '- gist 第一句必须是「这条视频讲什么」的人话主题句：先点领域/类型（科普、评测、资讯、教程…），再说在讲哪个对象、想说明什么结论；标题里的口号、比喻、书名号不能直接当主题（标题叫《压缩即理解》，不许写「讲的是『压缩即理解』」），让没看过的人不用猜。**不要**用【标题】【时长】这类抬头，不要在开头堆「值得看 / 13:56」这种标签。',
      '- bullets 用完整句子写具体内容（带时间码与数字/型号），不要写成「1. 参数：…」这种报菜名式短语堆叠。',
      '- 不要出现「本视频 / 该视频 / 综上所述 / 值得一看 / 令人印象深刻 / 首先其次最后」这类总结腔。',
      '- 至少要有一句自己的判断（好看 / 一般 / 不值，三选一，别和稀泥），这句要放进 take 的末句，并且能指到片子里的具体一处。',
      material ? '\n' + material : '',
    ].join('\n')
  }

  /* 心跳：每 5 拍记一行 "为什么没干活"，下次排查不用猜（2026-10-31 那次就是没有任何日志可看） */
  let hb = 0
  let lastBv = ''
  /* v40：nudged 只是「刚敲过、别重复敲」的去重，不是「已写完」的证明。
     原来一旦 sc.prompt 返回就无条件记 nudged，会话没写出东西（风控/模型空转/自己判断跳过）就永远不再重试；
     现在：① 去重带 10 分钟 TTL；② 只有 out/<bv>/summary.cloud.json 真的出现了才算写过。 */
  const NUDGE_TTL_MS = 10 * 60 * 1000
  const wroteSummary = (bv) => {
    try { return fs.existsSync(path.join(ROOT, 'out', bv, 'summary.cloud.json')) } catch (e) { return false }
  }
  // 写手心跳：面板的 dispatcher 靠它判断「要不要先等这一条写完再跑下一条」（写优先）
  const beat = async () => {
    try { await api('/api/watch/beat', { method: 'POST', body: { why: why.v, bvid: lastBv, at: Date.now() }, timeoutMs: 5000 }) } catch (e) {}
  }
  const tick = async () => {
    hb++
    try { await tickOnce() } catch (e) { log('watch tick 外层异常：' + (e?.message || e)) }
    await beat()
    if (hb % 5 === 0) log(`watch 心跳 #${hb}：${why.v}`)
  }
  const tickOnce = async () => {
    try {
      if (CFG.watchEnabled === false) { why.v = 'disabled'; return }
      if (!(await ensureServer())) { why.v = 'no-server'; return }
      const now = Date.now()
      if (now - state.lastAt < cooldown) { why.v = 'cooldown'; return }
      state.recent = state.recent.filter(t => now - t < 3600 * 1000)
      if (state.recent.length >= perHour) { why.v = 'hour-cap'; return }

      const q = await api('/api/summary/queue?limit=3', { timeoutMs: 8000 })
      const rows = (q && q.rows) || []
      if (!rows.length) { why.v = 'nothing-pending'; return }
      const cap = Number(q.cap || 0), wrote = Number(q.writtenToday || 0)
      if (cap > 0 && wrote >= cap) { why.v = 'daily-cap'; return }
      const pick = rows.find(r => r && r.bv && (!state.nudged[r.bv] || (now - Number(state.nudged[r.bv]) > NUDGE_TTL_MS)))
      if (!pick) { why.v = 'all-nudged'; return }

      await ensureSession()

      /* v33：把当前人设一起塞进投递内容——以前摘要工人这条路径完全没带人设（所以「人设硬套」），
         只有 video_digest / video_queue 的手动路径带了。人设文本是调用时读文件，改完下一拍就生效。 */
      const material = await inlineMaterial(pick.bv)
      /* v56：结构 auto 需要标题 + 材料才能解析（拆解/教程 → 拆解复算式，其余 → 技术审阅式） */
      const guide = await personaGuide({ title: pick.title, material })

      /* v38：先试直连一次调用（便宜）；不成就走下面的工作会话（贵但能多步/翻文件） */
      if (guide && guide.shape && directReady()) {
        try {
          const d = await tryDirectSummary(pick, material, guide)
          if (d.ok) {
            state.nudged[pick.bv] = now
            state.lastAt = now
            state.recent.push(now)
            state.turns += 1
            if (rotateTurns > 0 && state.turns >= rotateTurns) rotateSession(`已写 ${state.turns} 条，换新会话省钱`)
            else persist()
            why.v = 'direct-written'
            lastBv = pick.bv
            log(`直连写总结完成 ${pick.bv} · ${String(pick.title || '').slice(0, 40)} · ${d.model || ''} ${d.ms ? d.ms + 'ms' : ''} ${d.yuan != null ? '≈' + Number(d.yuan).toFixed(4) + '元' : ''}`)
            return
          }
          log(`直连写总结没成，回落会话：${pick.bv} · ${d.reason || 'unknown'}`)
        } catch (e) {
          log('直连写总结异常，回落会话：' + (e && (e.stack || e.message) || e))
        }
      }

      await ensureSession()
      const promptText = ask(pick, material, guide) + (guide.rules ? `\n\n---- 这套总结模板的硬规矩（面板「个性化 → 总结模板」里可改；含人设语气块）----\n${guide.rules}` : '')
      const ac = new AbortController()
      const kill = setTimeout(() => ac.abort(), 30000)
      const t0 = Date.now()
      try {
        await sc.prompt({
          requestId: `digest-watch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sessionId: state.id,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
        }, ac.signal)
      } finally { clearTimeout(kill) }
      const t1 = Date.now()
      /* v36：这次投递花了多少钱 —— 拿不到会话 usage，就按「投递时间窗内的 DSH events」归因，
         写进本插件自己的花费账（面板账本只统计这一类，不再把别的对话算进来）。 */
      try {
        const w = windowCost(t0, t1)
        appendSpend({ kind: 'summarize', bv: pick.bv, model: 'session', input: 0, output: 0, tokens: w.tokens, events: w.events, yuan: w.yuan, source: 'window', ms: t1 - t0 })
      } catch (e) {}

      state.nudged[pick.bv] = now
      state.lastAt = now
      state.recent.push(now)
      state.turns += 1
      /* v40：会话返回 ≠ 写出来了。没写出 summary.cloud.json 就只给 1 分钟 TTL，别让这条永远卡在「已敲过」 */
      if (!wroteSummary(pick.bv)) {
        state.nudged[pick.bv] = now - NUDGE_TTL_MS + 60 * 1000
        if (rotateTurns > 0 && state.turns >= rotateTurns) rotateSession(`已投递 ${state.turns} 条，换新会话省钱`)
        else persist()
        why.v = 'nudged-no-write'
        lastBv = pick.bv
        log(`会话没写出总结（1 分钟后重试）：${pick.bv} · ${String(pick.title || '').slice(0, 40)}`)
        return
      }
      if (rotateTurns > 0 && state.turns >= rotateTurns) rotateSession(`已写 ${state.turns} 条，换新会话省钱`)
      else persist()
      why.v = 'nudged'
      lastBv = pick.bv
      log(`watch 已投递到工作会话 ${state.id}：${pick.bv} · ${String(pick.title || '').slice(0, 40)}`)
    } catch (e) {
      why.v = 'error'
      log('watch tick 出错（已忽略）：' + (e?.stack || e?.message || e))
    }
  }

  /* 定时器回调里抛错会带走宿主进程（bili-watch index.js:1691 记过这个事故），tick 内部已全包 try/catch；
     unref() 保证它不阻止宿主退出。启动 15s 后先跑一次，不用等满一分钟。 */
  try {
    const first = setTimeout(() => { tick().catch(e => log('watch 首拍异常（已忽略）：' + (e?.message || e))) }, 15000)
    if (first && typeof first.unref === 'function') first.unref()
    const t = setInterval(() => { tick().catch(e => log('watch 定时器异常（已忽略）：' + (e?.message || e))) }, ms)
    if (t && typeof t.unref === 'function') t.unref()
    log(`watch 已挂：每 ${ms / 1000}s 敲一次钟 · 工作会话 ${state.id} · sessionController=${got.via}`)
  } catch (e) { log('watch 定时器挂载失败：' + (e?.message || e)) }
}

/* ---------- 面板：挂到宿主自己的 HTTP 服务上 ----------
   参考 billion-context（node_modules/billion-context/dist/agent/dsh-native.js）：
     ctx.inject(['webServer'], sub => sub.effect(() =>
       sub.webServer.register({ kind: 'prefix', path: '/bili', handler }), 'bili: panel routes'))
   好处（vs 我们原来的独立 node 进程 + 8791 + 计划任务）：
     · 不需要第二个进程/端口 → 不会被 DSH 退出连带杀、不用看门狗、不会僵尸、不会端口冲突
     · 与 GUI 同源同端口 → 继承它的鉴权，不用自己再防护
     · DSH 起来面板就在，DSH 重启时路由自动重挂（ctx.effect 管 dispose）
   独立模式（127.0.0.1:8791）保留：DSH 没开时仍可直接访问，二者共用同一份 handler。 */
function installPanelRoute(ctx) {
  let ws = null
  try { ws = ctx.webServer } catch (e) { log('panel 读 ctx.webServer 失败：' + (e?.message || e)) }
  if (!ws || typeof ws.register !== 'function') { log('panel 路由未挂：宿主没有 webServer 服务（独立模式 8791 仍可用）'); return }
  const BASE = '/video-panel'
  let handler = null
  let loading = null
  /* 动态 import 的模块缓存以「URL 字符串」为键：改完 panel_server.mjs 后同一个 URL 拿到的还是
     旧命名空间（2026-10-31 的 503 就是这个叠加在"忘了 export"之上的坑）。
     所以每次请求前取一次文件 mtime，把它拼进 query：文件一改就换 URL，自动重新求值。
     同时把失败也带上 mtime，避免"失败一次后缓存住失败结果"。 */
  const ensure = () => {
    const file = join(CODE_ROOT, 'scripts', 'panel_server.mjs')
    let tag = '0'
    try { tag = String(statSync(file).mtimeMs) } catch (e) { /* 文件读不到就退回 '0' */ }
    /* 已经加载过、且文件没改过 → 直接复用；文件一改（mtime 变了）就重新 import，
       所以改面板代码不用重启 DSH、也不用重载插件，刷新页面即可。 */
    if (handler && handler.__rev === tag) return Promise.resolve(handler)
    if (!loading || loading.tag !== tag) {
      const href = pathToFileURL(file).href + '?v=' + tag
      const p = import(href)
        .then(m => {
          if (typeof m.createPanelHandler !== 'function') throw new Error('panel_server.mjs 没有导出 createPanelHandler（检查文件末尾的 export）')
          handler = m.createPanelHandler(); handler.__rev = tag
          log('panel handler 已加载（' + BASE + ' 已可访问）· rev ' + tag); return handler
        })
        .catch(e => { log('panel handler 加载失败：' + (e?.stack || e?.message || e)); return null })
      p.tag = tag
      loading = p
    }
    return loading
  }
  const route = {
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        const rest = u.pathname.slice(BASE.length) || '/'
        req.url = (rest.startsWith('/') ? rest : '/' + rest) + (u.search || '')
        req.__panelBase = BASE
      } catch (e) { /* URL 解析失败就按原样交给 handler */ }
      ensure().then(h => {
        if (!h) { try { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('面板模块还没加载好，刷新一下') } catch (e) {} return }
        try { h(req, res) } catch (e) { log('panel handler 抛错：' + (e?.stack || e?.message || e)); try { res.writeHead(500); res.end('panel error') } catch (_) {} }
      })
    },
  }
  const reg = () => ws.register(route)
  try {
    if (typeof ctx.effect === 'function') { ctx.effect(reg, 'video-panel: routes on host webServer'); log('panel 路由已挂到宿主：' + BASE + '（与 GUI 同源同端口，不需要 8791）') }
    else { reg(); log('panel 路由已挂（无 effect）：' + BASE) }
  } catch (e) { log('panel 路由注册失败：' + (e?.stack || e?.message || e)) }
}

/* ---------- 入口 ---------- */
export const name = NAME
/* cordis 的 inject 是"必需的依赖声明"：不写进这里，直接读 ctx.sessionController 会抛
   「cannot get property \"sessionController\" without inject」——2026-10-31 重启后 watch 静默不工作的根因。
   webServer 同理：把面板挂到宿主自己的 HTTP 服务上（参考 billion-context 的做法）。 */
export const inject = ['sessionController', 'webServer']

/* 入站守候：每隔一段时间问一次「有没有新的私信/@」，命中就交给服务端入队。
   为什么 tick 放插件里而不是面板里：面板是独立 node 进程，DSH 一重启就停；
   插件跟着宿主活着，才可能做到"像聊天"。
   频率自适应：刚有互动 → activeSec；平时 → idleSec；深夜 → nightSec。
   tick 本身只花 2 个 B 站读请求（get_sessions + @ 收件箱），命中才去拉正文。 */
function installInbox(ctx) {
  const state = { ticks: 0, lastHit: 0, lastWhy: 'init', lastMs: 0, hits: 0, lastFound: 0 }
  let timer = null
  let stopped = false

  const cfgNow = async () => {
    let ib = {}
    try {
      const p = await api('/api/pacing', { timeoutMs: 5000 })
      ib = (p && (p.inbound || (p.pacing && p.pacing.inbound))) || {}
    } catch (e) { /* 面板没起就用兜底 */ }
    return {
      activeSec: Math.max(5, Number(ib.activeSec) || CFG.inboxActiveSec || DEFAULTS.inboxActiveSec),
      idleSec: Math.max(10, Number(ib.idleSec) || CFG.inboxIdleSec || DEFAULTS.inboxIdleSec),
      nightSec: Math.max(30, Number(ib.nightSec) || CFG.inboxNightSec || DEFAULTS.inboxNightSec),
      activeWindowMin: Math.max(1, Number(ib.activeWindowMin) || CFG.inboxActiveWindowMin || DEFAULTS.inboxActiveWindowMin),
    }
  }

  const loop = async () => {
    if (stopped) return
    let next = 60
    state.ticks++
    try {
      try { await ensureServer() } catch (e) {}   // 面板被 DSH 退出带走时，这里顺手拉回来
      const c = await cfgNow()
      const hour = new Date().getHours()
      const active = state.lastHit && Date.now() - state.lastHit < c.activeWindowMin * 60 * 1000
      next = (hour >= 0 && hour <= 6) ? c.nightSec : (active ? c.activeSec : c.idleSec)
      const t0 = Date.now()
      const r = await api('/api/inbox/tick', { timeoutMs: 25000 })
      state.lastMs = Date.now() - t0
      const found = (r && r.found && r.found.length) || 0
      state.lastFound = found
      if (found) {
        state.lastHit = Date.now()
        state.hits += found
        log('inbox 命中 ' + found + ' 条 · ' + state.lastMs + 'ms · 下一拍 ' + c.activeSec + 's')
      } else {
        state.lastWhy = (r && (r.skipped || 'quiet')) + (r && r.error ? ':' + r.error : '')
      }
    } catch (e) {
      state.lastWhy = 'error:' + (e && e.message || e)
      log('inbox tick 失败（下一拍继续）：' + (e && e.message || e))
    }
    if (!stopped) timer = setTimeout(loop, Math.max(5, next) * 1000)
    try { timer && timer.unref && timer.unref() } catch (e) {}
  }

  timer = setTimeout(loop, 8 * 1000)
  try { timer && timer.unref && timer.unref() } catch (e) {}
  log('inbox 已挂：自适应守候（活跃 ' + DEFAULTS.inboxActiveSec + 's / 空闲 ' + DEFAULTS.inboxIdleSec + 's / 夜间 ' + DEFAULTS.inboxNightSec + 's，以 config/pacing.json 为准）')
  return () => { stopped = true; try { clearTimeout(timer) } catch (e) {} }
}

export function apply(ctx) {
  log(`apply 开始 · root=${ROOT} · code=${CODE_ROOT} · dataSource=${DATA_SOURCE} · server=${SERVER} · defineTool=${!!defineTool}`)
  if (PATHS_ERR) log('paths.mjs 加载失败，已退回旧布局（代码根即数据根）：' + PATHS_ERR)
  try {
    const toolsSvc = (() => { try { return ctx.get?.('tools') } catch { return null } })()
    if (defineTool && toolsSvc && typeof toolsSvc.register === 'function') {
      /* 关键：工具对象的构造也要包在 try 里。
         2026-10-31 首次加载就是这么哑掉的——apply 只写了一行日志就没了，
         因为 defineTool(...) 在 reg() 之前求值，它一抛就直接把 apply 带走，连失败日志都留不下。 */
      const reg = (build, tag) => {
        let tool
        try { tool = build() } catch (e) { log(`构造 ${tag} 失败：${e?.stack || e?.message || e}`); return () => {} }
        if (!tool) { log(`构造 ${tag} 返回空（defineTool 可能是 undefined）`); return () => {} }
        try {
          const dispose = toolsSvc.register(tool)
          log(`已注册 ${tag}`)
          return typeof dispose === 'function' ? dispose : () => {}
        } catch (e) { log(`注册 ${tag} 失败：${e?.stack || e?.message || e}`); return () => {} }
      }
      const wire = (build, tag) => {
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => reg(build, tag))
          else reg(build, tag)
        } catch (e) { log(`挂载 ${tag} 失败：${e?.stack || e?.message || e}`) }
      }
      wire(digestTool, 'video_digest')
      wire(queueTool, 'video_queue')
      wire(writeTool, 'video_write_summary')
      log('工具已注册：video_digest / video_queue / video_write_summary')
    } else {
      log(`工具未注册：defineTool=${!!defineTool} tools=${!!toolsSvc}`)
    }
    try { installPreStep(ctx) } catch (e) { log('pre-step 挂载失败（已忽略）：' + (e?.stack || e?.message || e)) }
    try { installTimer(ctx) } catch (e) { log('timer 挂载失败（已忽略）：' + (e?.stack || e?.message || e)) }
    try { installWatch(ctx) } catch (e) { log('watch 挂载失败（已忽略）：' + (e?.stack || e?.message || e)) }
    try { installInbox(ctx) } catch (e) { log('inbox 挂载失败（已忽略）：' + (e?.stack || e?.message || e)) }
    try { installPanelRoute(ctx) } catch (e) { log('panel 路由挂载失败（已忽略）：' + (e?.stack || e?.message || e)) }
    /* 立即确认面板在跑：不等 8–15 秒后的首拍。
       2026-10-31 反馈「每次重启都要手动唤醒接口」——根因是面板被 DSH 退出连带杀掉，
       而拉起动作原先只挂在 watch tick 里（最长 60 秒才轮到一次）。这里 apply 完就拉。 */
    ensureServer().then(ok => { if (ok) log('apply：面板就绪') }).catch(e => log('apply：拉起面板异常 ' + (e?.message || e)))
    log('apply 结束')
  } catch (e) {
    /* 插件加载失败不该把宿主带走，也不该留下"没有日志"的黑盒 */
    log('apply 异常（已兜住）：' + (e?.stack || e?.message || e))
  }
}

export default { name, inject, apply }
