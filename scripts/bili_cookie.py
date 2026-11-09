"""读取 secrets/bili.json 并校验登录态。

契约（插件与脚本共用）：
  load() -> dict|None      读工作区 secrets/bili.json，缺文件或字段为空则返回 None
  header(c) -> str         拼 Cookie 请求头
  verify(c) -> dict        调 nav 接口，返回 {ok, code, uname, level, vip}；永不回显 cookie

用法：python scripts/bili_cookie.py
安全：本文件不打印、不写日志任何 cookie 值。
"""
import json
import os
import sys
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
COOKIE_FILE = os.path.join(DATA_ROOT, 'secrets', 'bili.json')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
REQUIRED_FIELDS = ('sessdata', 'bili_jct')
# cookie 名大小写敏感：必须发 SESSDATA / DedeUserID，发小写 sessdata 会拿到 -101
CANONICAL = {
    'sessdata': 'SESSDATA',
    'bili_jct': 'bili_jct',
    'buvid3': 'buvid3',
    'dede_user_id': 'DedeUserID',
}


def load():
    if not os.path.exists(COOKIE_FILE):
        return None
    with open(COOKIE_FILE, 'r', encoding='utf-8-sig') as fh:
        raw = json.load(fh)
    cookie = {k: (raw.get(k) or '').strip() for k in CANONICAL}
    if not all(cookie.get(k) for k in REQUIRED_FIELDS):
        return None
    return cookie


def header(cookie):
    parts = [f"{CANONICAL[k]}={v}" for k, v in cookie.items() if v and k in CANONICAL]
    return '; '.join(parts)


def verify(cookie):
    url = 'https://api.bilibili.com/x/web-interface/nav'
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com/',
        'Cookie': header(cookie),
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    d = data.get('data') or {}
    return {
        'ok': data.get('code') == 0 and bool(d.get('isLogin')),
        'code': data.get('code'),
        'message': data.get('message'),
        'uname': d.get('uname'),
        'uid': d.get('mid'),
        'level': (d.get('level_info') or {}).get('current_level'),
        'vip': (d.get('vipStatus') or d.get('vip_status')) if isinstance(d.get('vipStatus'), int) else d.get('vipStatus'),
        'wbi_img': bool(d.get('wbi_img')),
    }


def main():
    cookie = load()
    if cookie is None:
        print(json.dumps({'ok': False, 'reason': '未配置', 'file': COOKIE_FILE}, ensure_ascii=False))
        return 2
    print(json.dumps(verify(cookie), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
