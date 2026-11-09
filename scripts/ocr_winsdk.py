"""批量 Windows OCR（winsdk 路径）
用法: python ocr_winsdk.py <listfile> [lang]
输出: 每行一个 JSON {"path","w","h","ms","lines":[{"t","y","h"}]}

说明：全程走内存流，不用 StorageFile —— 在 DSH 沙箱里 StorageFile.GetFileFromPathAsync
会因 AppContainer 文件代理限制直接 UnauthorizedAccessException。
"""
import asyncio
import json
import os
import sys
import time


def _data_root():
    """数据根：与 scripts/lib/paths.mjs 同一套解析顺序
    1) $VD_DATA  2) $DSH_HOME/video-digest（有台账时）  3) 旧布局（包根有台账时）  4) 默认 ~/.dsh/video-digest
    pylibs 装在数据根下，所以这里不能写死包路径（否则发布到别处就找不到）。
    """

    def has_data(d):
        return bool(d) and os.path.exists(os.path.join(d, 'logs', 'library.db'))

    env = (os.environ.get('VD_DATA') or '').strip().strip('"').strip("'")
    if env:
        return os.path.abspath(env)

    home = (os.environ.get('DSH_HOME') or '').strip().strip('"').strip("'")
    home = home or os.path.join(os.path.expanduser('~'), '.dsh')
    default_root = os.path.join(home, 'video-digest')
    if has_data(default_root):
        return default_root

    legacy_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # <包根>/scripts/.. = 包根
    if has_data(legacy_root) and os.path.abspath(legacy_root) != os.path.abspath(default_root):
        return legacy_root

    return default_root


sys.path.insert(0, os.path.join(_data_root(), 'runtime', 'pylibs'))

from winsdk.windows.globalization import Language  # noqa: E402
from winsdk.windows.graphics.imaging import BitmapDecoder  # noqa: E402
from winsdk.windows.media.ocr import OcrEngine  # noqa: E402
from winsdk.windows.storage.streams import DataWriter, InMemoryRandomAccessStream  # noqa: E402


async def ocr_one(engine, path):
    with open(path, 'rb') as fh:
        data = fh.read()
    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream)
    writer.write_bytes(data)
    await writer.store_async()
    await writer.flush_async()
    writer.detach_stream()
    stream.seek(0)
    dec = await BitmapDecoder.create_async(stream)
    bmp = await dec.get_software_bitmap_async()
    t0 = time.perf_counter()
    res = await engine.recognize_async(bmp)
    ms = int((time.perf_counter() - t0) * 1000)
    lines = []
    for line in res.lines:
        words = list(line.words)
        y = h = 0
        if words:
            r = words[0].bounding_rect
            y, h = int(r.y), int(r.height)
        lines.append({'t': line.text, 'y': y, 'h': h})
    return {'path': path, 'w': dec.pixel_width, 'h': dec.pixel_height, 'ms': ms, 'lines': lines}


async def main():
    listfile = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else 'zh-Hans-CN'
    engine = OcrEngine.try_create_from_language(Language(lang))
    if engine is None:
        print(json.dumps({'error': 'no engine for ' + lang}))
        return 2
    with open(listfile, 'r', encoding='utf-8-sig') as fh:
        paths = [ln.strip() for ln in fh if ln.strip()]
    for p in paths:
        try:
            print(json.dumps(await ocr_one(engine, p), ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({'path': p, 'error': repr(exc)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
