"""批量 OCR：Xiaomi-OCR-0（Ollama 后端，0.8B 视觉语言模型）
用法: python ocr_xiaomi.py <listfile> [lang]
输出: 每行一个 JSON {"path","w","h","ms","lines":[{"t","y","h"}],"engine":"xiaomi"}

与 ocr_winsdk.py 的输出契约完全一致（digest.mjs 只需按行 JSON 解析），换引擎不改下游。
模型默认 longwayxu/xiaomi-ocr-0:bf16（社区 GGUF，1.6GB）；可用 VD_OCR_MODEL 指定。

提示词策略：让它把文字输出成 JSON {"lines":[...]}。
实测这样最不容易跑偏——直接写「请转录文字」时，模型对着界面截图会改写成
「图像描绘了…包含的文字有…，白色字体，位于顶部中央」这类描述（正文会被污染）。
拿到的 JSON 偶尔括号不配对，所以解析是「先试 json.loads，失败就按顺序抽引号里的字符串」。
Ollama 没起或模型不在时，每行输出 {"path","error"} 并以 3 退出 —— 上层据此降级到 Windows OCR。
"""
import base64
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HOST = (os.environ.get('VD_OCR_HOST') or 'http://127.0.0.1:11434').rstrip('/')
MODEL = os.environ.get('VD_OCR_MODEL') or 'longwayxu/xiaomi-ocr-0:bf16'
NUM_CTX = int(os.environ.get('VD_OCR_NUM_CTX') or '8192')
TIMEOUT = float(os.environ.get('VD_OCR_TIMEOUT') or '180')

PROMPT = os.environ.get('VD_OCR_PROMPT') or (
    '把这张图里出现的所有文字，按从上到下、从左到右的阅读顺序，输出成 JSON：'
    '{"lines":["第一行文字","第二行文字"]}。'
    '每一条只放图里真实出现的文字本身；不要描述画面，不要写字体、颜色、位置，不要解释。'
    '只输出这个 JSON。')

# 模型偶发的「描述式」句子（不是图里的文字，是它在解释画面）
DESC_RE = re.compile(r'(图像中|图片中|图中|画面中|包含的文字|位于|字体|颜色为|背景为|左上|右下|居中|字号)')


def http_json(path, payload=None, timeout=30):
    url = HOST + path
    data = None
    headers = {'Content-Type': 'application/json'}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def strip_think(text):
    t = text or ''
    low = t.lower()
    while True:
        i = low.find('</think')
        if i < 0:
            break
        j = low.find('>', i)
        if j < 0:
            break
        t, low = t[j + 1:], t[j + 1:].lower()
    return t


def unescape(s):
    try:
        return json.loads('"' + s.replace('"', '\\"') + '"')
    except Exception:
        return s


def parse_lines(raw):
    """从模型输出里恢复「一行一条文字」的列表。

    1. 去掉 think 块与 ``` 围栏
    2. 优先按 JSON 解（lines 数组）
    3. JSON 坏了就按顺序抽引号里的字符串（模型最常见的坏法：括号不配对）
    4. 都没有就按行切（并丢掉描述式句子）
    """
    t = strip_think(raw).strip()
    t = re.sub(r'^\s*```[a-zA-Z]*\s*', '', t)
    t = re.sub(r'\s*```\s*$', '', t)
    out = []

    # 2) 正常 JSON
    try:
        obj = json.loads(t)
        for k in ('lines', 'texts', 'items'):
            if isinstance(obj, dict) and isinstance(obj.get(k), list):
                for x in obj[k]:
                    if isinstance(x, str):
                        out.append(x)
                    elif isinstance(x, dict):
                        for kk in ('text', 'line', 'content'):
                            if isinstance(x.get(kk), str):
                                out.append(x[kk])
                                break
                if out:
                    break
    except Exception:
        pass

    # 3) 抽引号里的字符串（单双引号都认）
    if not out:
        for m in re.finditer(r'"([^"\n]{1,200})"|\'([^\'\n]{1,200})\'', t):
            s = m.group(1) or m.group(2) or ''
            if s:
                out.append(s)

    # 4) 按行兜底
    if not out:
        for ln in t.splitlines():
            s = ln.strip().strip(',').strip()
            if s and not DESC_RE.search(s):
                out.append(s)

    # 清理：去描述句、去空、去重（保序）
    clean, seen = [], set()
    for s in out:
        s = re.sub(r'\s+', ' ', s).strip().strip('"').strip()
        if not s or len(s) < 1:
            continue
        if DESC_RE.search(s) and not re.search(r'[\u4e00-\u9fff]{4,}', re.sub(DESC_RE, '', s)):
            continue
        if s in seen:
            continue
        seen.add(s)
        clean.append(s)
    return clean


def image_size(raw):
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as im:
            return im.size
    except Exception:
        return 0, 0


def ocr_one(path):
    with open(path, 'rb') as fh:
        raw = fh.read()
    b64 = base64.b64encode(raw).decode('ascii')
    t0 = time.perf_counter()
    res = http_json('/api/generate', {
        'model': MODEL,
        'prompt': PROMPT,
        'images': [b64],
        'stream': False,
        'options': {'temperature': 0, 'num_predict': 2048, 'num_ctx': NUM_CTX},
    }, timeout=TIMEOUT)
    ms = int((time.perf_counter() - t0) * 1000)
    text = res.get('response') or ''
    w, h = image_size(raw)
    lines = [{'t': s, 'y': i * 20, 'h': 20} for i, s in enumerate(parse_lines(text))]
    return {'path': path, 'w': w, 'h': h, 'ms': ms, 'lines': lines, 'engine': 'xiaomi'}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'usage: ocr_xiaomi.py <listfile>'}, ensure_ascii=False))
        return 2
    with open(sys.argv[1], 'r', encoding='utf-8-sig') as fh:
        paths = [ln.strip() for ln in fh if ln.strip()]

    try:
        tags = http_json('/api/tags', timeout=5).get('models') or []
    except Exception as exc:  # noqa: BLE001
        for p in paths:
            print(json.dumps({'path': p, 'error': 'ollama unreachable: %r' % (exc,)}, ensure_ascii=False))
        return 3
    names = {m.get('name') or m.get('model') for m in tags}
    if MODEL not in names:
        have = ', '.join(sorted(n for n in names if n)) or '(none)'
        for p in paths:
            print(json.dumps({'path': p, 'error': 'model missing: %s (have: %s)' % (MODEL, have)}, ensure_ascii=False))
        return 3

    ok = 0
    for p in paths:
        try:
            print(json.dumps(ocr_one(p), ensure_ascii=False), flush=True)
            ok += 1
        except urllib.error.URLError as exc:
            print(json.dumps({'path': p, 'error': 'http: %r' % (exc,)}, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({'path': p, 'error': repr(exc)}, ensure_ascii=False), flush=True)
    return 0 if ok else 3


if __name__ == '__main__':
    sys.exit(main())
