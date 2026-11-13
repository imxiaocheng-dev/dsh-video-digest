// 画面文字 OCR 引擎调度：xiaomi（Xiaomi-OCR-0 / Ollama）优先，失败降级 winsdk（Windows 自带）
// 两个引擎的输出契约一致：stdout 每行一个 JSON {path,w,h,ms,lines:[{t,y,h}]}，错误行形如 {path,error}
// 这里负责「选引擎 / 选解释器 / 传环境 / 解析 / 降级」，不做行清洗（那部分在 digest.mjs）。
//
// 为什么要选解释器：xiaomi 只用标准库，任何 Python 3.8+ 都行；winsdk 依赖编译期 ABI
// （实测 3.10 里 import winsdk → _winrt DLL load failed，3.12 正常）。所以 py 是一个候选
// 数组，同一引擎会逐个解释器重试，谁跑通算谁的。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ENGINES = { xiaomi: 'ocr_xiaomi.py', winsdk: 'ocr_winsdk.py' };

/**
 * 默认解释器候选：VD_PYTHON → DSH 托管运行时 → PATH 上的 python/python3/py。
 * winsdk 的 _winrt 是编译产物，只在与它 ABI 一致的解释器里能导入（3.10 报 DLL load failed，3.12 正常），
 * 所以要给一串候选，而不是一个值。
 */
export function defaultPys(primary) {
  const list = [process.env.VD_PYTHON];
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    for (const d of fs.readdirSync(path.join(home, 'dsh-runtimes'))) {
      list.push(path.join(home, 'dsh-runtimes', d, 'dependencies', 'python', 'python.exe'));
    }
  } catch { /* 没有 DSH 运行时就算了 */ }
  list.push(primary, 'python', 'python3', 'py');
  const ok = [];
  for (const c of list) {
    if (!c || ok.includes(c)) continue;
    const isPath = c.includes('/') || c.includes('\\');
    // 绝对路径必须存在；裸命令名交给 spawn 去 PATH 里找
    if (isPath && !fs.existsSync(c)) continue;
    ok.push(c);
  }
  return ok.length ? ok : [primary || 'python'];
}

export function loadOcrConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'config', 'ocr.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 引擎顺序：auto = xiaomi → winsdk；显式指定 = 先它自己，再其余（保证总有兜底） */
export function engineOrder(pref) {
  const all = Object.keys(ENGINES);
  if (!pref || pref === 'auto') return ['xiaomi', 'winsdk'];
  return [pref, ...all.filter((e) => e !== pref)];
}

function engineEnv(base, eng, cfg) {
  const env = { ...base, PYTHONIOENCODING: 'utf-8' };
  // 优先级：环境变量（临时调试）> config/ocr.json > 脚本默认值
  const setIf = (k, v) => { if (v !== undefined && v !== null && v !== '' && !env[k]) env[k] = String(v); };
  if (eng === 'xiaomi' && cfg && cfg.xiaomi) {
    const x = cfg.xiaomi;
    setIf('VD_OCR_MODEL', x.model);
    setIf('VD_OCR_HOST', x.host);
    setIf('VD_OCR_NUM_CTX', x.num_ctx);
    if (x.timeout_ms) setIf('VD_OCR_TIMEOUT', Math.min(600, Math.max(5, Math.round(Number(x.timeout_ms) / 1000))));
  }
  return env;
}

/**
 * @param {object} o
 * @param {string} o.py             首选 python
 * @param {string[]} [o.pys]        python 候选解释器（按顺序试）
 * @param {string} o.codeRoot       代码根（找 scripts/*.py）
 * @param {string} o.root           数据根（找 config/ocr.json）
 * @param {string} o.listFile       帧列表文件（每行一个绝对路径）
 * @param {number} o.framesCount    帧总数（只用于日志）
 * @param {string[]} [o.args]       原始 CLI 参数（解析 --ocr-engine=）
 * @param {object} [o.cfg]          已加载的 config/ocr.json；不传则从 root 读
 * @param {(bin:string, argv:string[], opts?:object)=>Promise<{out:string,err:string}>} o.run
 * @param {(...a:any[])=>void} [o.log]
 * @returns {Promise<{byPath:Map<string,object>, engine:string|null, py:string|null, tried:string[]}>}
 */
export async function runOcrStage(o) {
  const { codeRoot, root, listFile, framesCount, args = [], run, log = () => {} } = o;
  const pys = [...new Set((o.pys && o.pys.length ? o.pys : [o.py]).filter(Boolean))];
  const cfg = o.cfg || loadOcrConfig(root);
  const cliPref = (args.find((a) => a.startsWith('--ocr-engine=')) || '').split('=')[1] || '';
  const pref = cliPref || process.env.VD_OCR_ENGINE || cfg.engine || 'auto';
  const order = engineOrder(pref);
  const tried = [];
  for (let k = 0; k < order.length; k++) {
    const eng = order[k];
    if (!ENGINES[eng]) { tried.push(`${eng}:unknown`); continue; }
    for (let i = 0; i < pys.length; i++) {
      const py = pys[i];
      const t0 = Date.now();
      try {
        const { out } = await run(py, [path.join(codeRoot, 'scripts', ENGINES[eng]), listFile], {
          env: engineEnv(process.env, eng, cfg),
        });
        const m = new Map();
        for (const line of out.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try { const j = JSON.parse(line); if (!j.error) m.set(j.path, j); } catch { /* 跳过坏行 */ }
        }
        if (!m.size) throw new Error('no lines parsed');
        const pyName = path.basename(py);
        log(`[S3.5] OCR 引擎 ${eng}${i ? `（${pyName}）` : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${m.size}/${framesCount} 帧`);
        return { byPath: m, engine: eng, py, tried };
      } catch (exc) {
        const msg = String((exc && exc.message) || exc);
        tried.push(`${eng}@${path.basename(py)}:${msg.slice(0, 120)}`);
        // 同一引擎换解释器只在「可能是解释器问题」时重试：没输出/import 失败
        const pyRelated = /ImportError|ModuleNotFoundError|DLL load failed|no lines parsed/.test(msg);
        if (i < pys.length - 1 && pyRelated) continue;
        break;
      }
    }
    if (k < order.length - 1) log(`[S3.5] OCR 引擎 ${eng} 不可用，降级下一档：${tried[tried.length - 1]}`);
  }
  log(`[S3.5] OCR 无可用引擎（${tried.join(' | ')}），本次跳过画面文字`);
  return { byPath: new Map(), engine: null, py: null, tried };
}
