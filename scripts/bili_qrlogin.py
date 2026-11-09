"""B 站扫码登录：生成二维码 -> 轮询 -> 成功后把 cookie 写进 secrets/bili.json。

用法：
  python scripts/bili_qrlogin.py gen              只生成二维码（out/login_qr.png + 终端 ASCII）
  python scripts/bili_qrlogin.py poll <key> [秒]  轮询指定 qrcode_key
  python scripts/bili_qrlogin.py login [秒]       一条龙：生成 + 轮询 + 落盘（默认 180 秒）

安全：只把 cookie 写进 secrets/bili.json，控制台只打印掩码。
接口：passport.bilibili.com/x/passport-login/web/qrcode/{generate,poll}（匿名，无需 cookie）
轮询状态码：0 成功 / 86038 二维码失效 / 86090 已扫码待确认 / 86101 未扫码
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

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

COOKIE_FILE = os.path.join(DATA_ROOT, 'secrets', 'bili.json')
OUT_DIR = os.path.join(DATA_ROOT, 'out')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
HDRS = {'User-Agent': UA, 'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com'}
QR_GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
QR_POLL = ('https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
           '?qrcode_key={key}&source=main-fe-header')

WANT = ('SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5')


def req(url, timeout=15):
    r = urllib.request.Request(url, headers=HDRS)
    return urllib.request.urlopen(r, timeout=timeout)


def jget(url, timeout=15):
    with req(url, timeout) as resp:
        return json.loads(resp.read().decode('utf-8')), resp.headers


def gen():
    """返回 (qrcode_key, url)；不落盘。"""
    data, _ = jget(QR_GEN)
    d = data.get('data') or {}
    if data.get('code') != 0 or not d.get('qrcode_key'):
        raise RuntimeError(f"生成二维码失败: code={data.get('code')} msg={data.get('message')}")
    return d['qrcode_key'], d['url']


def render(url, png_path):
    import qrcode  # 只在此处依赖，缺库时给明确提示
    qr = qrcode.QRCode(border=2, box_size=10)
    qr.add_data(url)
    qr.make(fit=True)
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    qr.make_image(fill_color='black', back_color='white').save(png_path)
    return png_path


def ascii_qr(url):
    import qrcode
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.make(fit=True)
    qr.print_ascii(invert=True)


def parse_cookies(headers):
    out = {}
    for raw in headers.get_all('Set-Cookie') or []:
        head = raw.split(';', 1)[0]
        if '=' not in head:
            continue
        k, v = head.split('=', 1)
        k = k.strip()
        if k in WANT and v and not v.startswith('deleted'):
            out[k] = v.strip()
    return out


def poll(key, wait_sec):
    url = QR_POLL.format(key=urllib.parse.quote(key))
    deadline = time.time() + wait_sec
    last = None
    while time.time() < deadline:
        try:
            data, headers = jget(url)
        except Exception as e:  # 网络抖动：继续等，不退出
            time.sleep(2)
            last = f'net:{type(e).__name__}'
            continue
        d = data.get('data') or {}
        code = d.get('code')
        if code == 0:
            return {'ok': True, 'cookies': parse_cookies(headers), 'raw': d}
        label = {86038: 'expired', 86090: 'scanned-waiting-confirm', 86101: 'not-scanned'}.get(code, f'code={code}')
        if label != last:
            print(json.dumps({'state': label, 'message': d.get('message')}, ensure_ascii=False), flush=True)
            last = label
        if code == 86038:
            return {'ok': False, 'why': 'expired'}
        time.sleep(2)
    return {'ok': False, 'why': 'timeout'}


def save(cookies):
    # 保持 Set-Cookie 原样（浏览器也是原样回传；URL 编码的 SESSDATA 不要解码，
    # 解码后出现的 , ; 会被服务端 cookie 解析切坏）
    payload = {
        '_readme': '只填 sessdata 与 bili_jct 即可。此文件永不打印、永不进日志、永不进 git。',
        'sessdata': cookies.get('SESSDATA', ''),
        'bili_jct': cookies.get('bili_jct', ''),
        'buvid3': cookies.get('buvid3', ''),
        'dede_user_id': cookies.get('DedeUserID', ''),
        'note': '由 scripts/bili_qrlogin.py 扫码写入',
    }
    tmp = COOKIE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, COOKIE_FILE)
    return {'ok': all(payload[k] for k in ('sessdata', 'bili_jct')),
            'sessdata': payload['sessdata'][:4] + '***',
            'has_jct': bool(payload['bili_jct']),
            'uid': payload['dede_user_id'],
            'file': COOKIE_FILE}


def cmd_gen():
    key, url = gen()
    png = os.path.join(OUT_DIR, 'login_qr.png')
    render(url, png)
    ascii_qr(url)
    print(json.dumps({'ok': True, 'qrcode_key': key, 'png': png, 'url_len': len(url)}, ensure_ascii=False))
    return 0


def cmd_poll(key, wait_sec):
    r = poll(key, wait_sec)
    if not r['ok']:
        print(json.dumps({'ok': False, 'why': r.get('why')}, ensure_ascii=False))
        return 1
    res = save(r['cookies'])
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res['ok'] else 1


def cmd_login(wait_sec):
    key, url = gen()
    png = os.path.join(OUT_DIR, 'login_qr.png')
    render(url, png)
    ascii_qr(url)
    print(json.dumps({'state': 'qr-ready', 'png': png}, ensure_ascii=False), flush=True)
    r = poll(key, wait_sec)
    if not r['ok']:
        print(json.dumps({'ok': False, 'why': r.get('why')}, ensure_ascii=False))
        return 1
    res = save(r['cookies'])
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res['ok'] else 1


def _stamp(text):
    path = os.path.join(OUT_DIR, 'login_state.json')
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'updated': time.strftime('%Y-%m-%d %H:%M:%S'), 'state': text},
                  fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def cmd_watch(total_sec=1800):
    """长时间值守：二维码 3 分钟就失效，失效即自动换新（同一路径覆盖），
    直到扫到或总时长用尽。用户任何时候重新打开 out/login_qr.png 都是当前有效的。"""
    deadline = time.time() + total_sec
    round_no = 0
    while time.time() < deadline:
        round_no += 1
        key, url = gen()
        png = os.path.join(OUT_DIR, 'login_qr.png')
        render(url, png)
        if round_no == 1:
            ascii_qr(url)
        print(json.dumps({'state': 'qr-ready', 'round': round_no,
                          'at': time.strftime('%H:%M:%S'), 'png': png}, ensure_ascii=False), flush=True)
        _stamp(f'qr-ready round={round_no}')
        left = max(45.0, min(160.0, deadline - time.time()))
        r = poll(key, left)
        if r['ok']:
            res = save(r['cookies'])
            _stamp('ok')
            print(json.dumps(res, ensure_ascii=False), flush=True)
            return 0 if res['ok'] else 1
        _stamp(f"rotate({r.get('why')})")
        time.sleep(2)
    _stamp('timeout')
    print(json.dumps({'ok': False, 'why': 'timeout'}, ensure_ascii=False))
    return 1


if __name__ == '__main__':
    argv = sys.argv[1:]
    mode = argv[0] if argv else 'login'
    if mode == 'gen':
        sys.exit(cmd_gen())
    if mode == 'poll' and len(argv) >= 2:
        sys.exit(cmd_poll(argv[1], float(argv[2]) if len(argv) > 2 else 60))
    if mode == 'watch':
        sys.exit(cmd_watch(float(argv[1]) if len(argv) > 1 else 1800))
    sys.exit(cmd_login(float(argv[1]) if len(argv) > 1 else 180))
