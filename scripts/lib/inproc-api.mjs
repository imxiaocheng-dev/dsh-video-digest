/**
 * 进程内调用面板 API —— 不需要任何端口。
 *
 * 背景：面板本来是个独立 HTTP 服务（127.0.0.1:8791）。插件要读队列/写总结/触发 tick，
 * 就一直在打这个端口，于是"端口 + 计划任务 + 看门狗"三件套成了必须品。
 * 但面板 handler 本身就是个纯函数 `createPanelHandler()`，完全可以同进程直接调。
 *
 * 做法：用最小 req/res 假对象跑同一个 handler——**不复制业务逻辑**，
 * 面板走 HTTP 和走这里得到的 JSON 一定一致（因为就是同一段代码）。
 * 独立 HTTP 模式（node scripts/panel_server.mjs 8791）仍保留，用于不开 DSH 时调试。
 *
 * 2026-10-31 起插件默认走这条路径；`config/plugin.json` 的 `serverMode` 可切回 'http'。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

let cache = { file: '', rev: 0, handler: null, error: null };

/** 取（并按 mtime 换新的）面板 handler —— 改完 panel_server.mjs 刷新页面/下一拍即生效 */
async function getHandler(file) {
  const abs = path.resolve(file);
  let rev = 0;
  try { rev = fs.statSync(abs).mtimeMs } catch (e) {
    cache = { file: abs, rev: 0, handler: null, error: 'no-file' };
    return null;
  }
  if (cache.handler && cache.file === abs && cache.rev === rev) return cache.handler;
  try {
    // 带版本查询串，避开 ESM 模块缓存
    const mod = await import(pathToFileURL(abs).href + '?v=' + rev);
    const make = mod.createPanelHandler || mod.default?.createPanelHandler;
    if (typeof make !== 'function') throw new Error('createPanelHandler 未导出');
    cache = { file: abs, rev, handler: make(), error: null };
    return cache.handler;
  } catch (e) {
    cache = { file: abs, rev, handler: null, error: String(e?.message || e) };
    return null;
  }
}

/**
 * call(handlerFile, '/api/queue?limit=3', { method:'POST', body:{...} })
 * → { ok, status, headers, text, json }
 */
export async function call(handlerFile, pathname, opts = {}) {
  const { method = 'GET', body = null } = opts || {};
  const handler = await getHandler(handlerFile);
  if (!handler) throw new Error('面板 handler 不可用：' + (cache.error || 'unknown'));

  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = String(method).toUpperCase();
  req.url = pathname;
  req.headers = {
    host: '127.0.0.1',
    'content-type': 'application/json',
    'content-length': payload ? String(payload.length) : '0',
    'user-agent': 'dsh-video-digest/inproc',
  };
  req.socket = { remoteAddress: '127.0.0.1', remotePort: 0 };
  req.connection = req.socket;

  return await new Promise((resolve, reject) => {
    const headers = {};
    const chunks = [];
    let status = 200;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text) } catch { /* 非 JSON（HTML/PNG）时为 null */ }
      resolve({ ok: status >= 200 && status < 300, status, headers, text, json });
    };
    const res = {
      get statusCode() { return status },
      set statusCode(v) { status = Number(v) || 200 },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v },
      getHeader(k) { return headers[String(k).toLowerCase()] },
      removeHeader(k) { delete headers[String(k).toLowerCase()] },
      writeHead(code, hdrs) {
        status = Number(code) || status;
        if (hdrs && typeof hdrs === 'object') for (const k of Object.keys(hdrs)) headers[k.toLowerCase()] = hdrs[k];
        return res;
      },
      write(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true },
      end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); finish(); return res },
      on() { return res },
      once() { return res },
      emit() { return true },
      get writableEnded() { return finished },
      get headersSent() { return false },
    };
    try {
      const r = handler(req, res);
      if (r && typeof r.then === 'function') r.catch(reject);
    } catch (e) { reject(e) }
    // 有些路由（如 304/静态）可能不 end；给个兜底
    setTimeout(finish, opts.timeoutMs || 60000).unref?.();
  });
}

/** 诊断用：现在能不能用进程内模式 */
export async function health(handlerFile) {
  try {
    const r = await call(handlerFile, '/api/health', { timeoutMs: 5000 });
    return { ok: Boolean(r.json && r.json.ok), status: r.status, version: r.json?.version, error: null };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}
