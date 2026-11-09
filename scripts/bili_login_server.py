"""B 站扫码登录的本地网页版：浏览器打开 http://127.0.0.1:8790 永远看到**当前有效**的二维码。

为什么要有它：二维码本身只有约 3 分钟寿命，聊天窗口里的图片是一次性快照，
等你看到再拿手机扫，往往已经过期。这个页面自己轮换二维码，页面每 3 秒拉一张新的，
所以你什么时候扫都行。

只绑 127.0.0.1，只暴露二维码和登录状态，不暴露任何 cookie 值。

用法：python scripts/bili_login_server.py [端口] [总时长秒]
"""
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _data_root():
    """数据根：$VD_DATA > 旧布局（代码目录有 logs/library.db）> <DSH_HOME>/video-digest。与 scripts/lib/paths.mjs 同口径。"""
    env = os.environ.get('VD_DATA')
    if env:
        return os.path.abspath(env)
    if os.path.exists(os.path.join(ROOT, 'logs', 'library.db')):
        return ROOT
    home = os.environ.get('DSH_HOME') or os.path.join(os.path.expanduser('~'), '.dsh')
    return os.path.join(home, 'video-digest')


DATA_ROOT = _data_root()
Pylibs = os.path.join(DATA_ROOT, 'runtime', 'pylibs')
if os.path.isdir(Pylibs):
    sys.path.insert(0, Pylibs)
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from bili_qrlogin import gen, poll, save, COOKIE_FILE  # noqa: E402

STATE = {
    'png': None,          # 当前二维码 PNG 字节
    'round': 0,
    'at': 0.0,
    'status': 'starting',  # starting | ready | scanned | ok | failed
    'detail': '',
    'result': None,
    'done': False,
}
LOCK = threading.Lock()


def render_png(url):
    import io

    import qrcode
    qr = qrcode.QRCode(border=2, box_size=10)
    qr.add_data(url)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(fill_color='black', back_color='white').save(buf, format='PNG')
    return buf.getvalue()


def worker(total_sec):
    deadline = time.time() + total_sec
    rnd = 0
    while time.time() < deadline:
        try:
            key, url = gen()
        except Exception as e:
            with LOCK:
                STATE['status'] = 'failed'
                STATE['detail'] = f'gen: {type(e).__name__}'
            time.sleep(3)
            continue
        rnd += 1
        png = render_png(url)
        with LOCK:
            STATE.update(png=png, round=rnd, at=time.time(), status='ready', detail='')
        left = max(30.0, min(150.0, deadline - time.time()))
        r = poll(key, left)
        if r['ok']:
            res = save(r['cookies'])
            with LOCK:
                STATE.update(status='ok' if res['ok'] else 'failed',
                             result=res, done=True,
                             detail='登录成功' if res['ok'] else 'cookie 写入失败')
            print(json.dumps({'ok': res['ok'], 'file': COOKIE_FILE,
                              'state': STATE['status']}, ensure_ascii=False), flush=True)
            return
        with LOCK:
            STATE['status'] = 'rotating'
            STATE['detail'] = str(r.get('why'))
        time.sleep(1)
    with LOCK:
        STATE.update(status='timeout', detail='值守结束', done=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype='text/plain; charset=utf-8', extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        with LOCK:
            png = STATE['png']
            snap = {k: STATE[k] for k in ('round', 'at', 'status', 'detail', 'result', 'done')}
        if path == '/':
            html = PAGE.format(port=self.server.server_address[1])
            self._send(200, html.encode('utf-8'), 'text/html; charset=utf-8')
        elif path == '/qr.png':
            if png is None:
                self._send(503, b'not ready')
            else:
                self._send(200, png, 'image/png')
        elif path == '/state':
            snap['age'] = round(time.time() - snap['at'], 1) if snap['at'] else None
            self._send(200, json.dumps(snap, ensure_ascii=False).encode('utf-8'),
                       'application/json; charset=utf-8')
        else:
            self._send(404, b'not found')

    def do_POST(self):
        self._send(404, b'not found')


PAGE = """<!doctype html><meta charset="utf-8">
<title>B 站扫码登录</title>
<style>
 body{{font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif;background:#111;color:#eee;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      min-height:100vh;margin:0;gap:14px}}
 #box{{background:#fff;padding:12px;border-radius:12px}}
 img{{width:340px;height:340px;display:block}}
 #st{{font-size:15px;letter-spacing:.5px}}
 .ok{{color:#4ade80}} .wait{{color:#fbbf24}} .err{{color:#f87171}}
</style>
<div id="box"><img id="q" src="/qr.png" alt="二维码"></div>
<div id="st">加载中…</div>
<div style="font-size:12px;opacity:.5">B 站 App → 我的 → 扫一扫　·　二维码自动刷新，随时可扫</div>
<script>
const q=document.getElementById('q'), st=document.getElementById('st');
const LABEL={{ready:'请用 B 站 App 扫码',rotating:'正在换新二维码…',scanned:'已扫码，请在手机上确认',
             ok:'登录成功，可以关闭此页面',failed:'失败',timeout:'值守结束',starting:'启动中…'}};
let tick=0;
async function loop(){{
  try{{
    const r=await fetch('/state',{{cache:'no-store'}});
    const s=await r.json();
    st.textContent=(LABEL[s.status]||s.status)+(s.detail?(' · '+s.detail):'');
    st.className=s.status==='ok'?'ok':(s.status==='failed'||s.status==='timeout')?'err':'wait';
    if(s.status==='ok'){{q.style.opacity=.25;return}}
  }}catch(e){{}}
  tick++;
  q.src='/qr.png?t='+Date.now();
  setTimeout(loop,2500);
}}
loop();
</script>
"""


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    total = float(sys.argv[2]) if len(sys.argv) > 2 else 1800
    t = threading.Thread(target=worker, args=(total,), daemon=True)
    t.start()
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(json.dumps({'listening': f'http://127.0.0.1:{port}', 'total_sec': total},
                     ensure_ascii=False), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
