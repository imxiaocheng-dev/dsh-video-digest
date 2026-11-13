# 更新日志

## v0.2.1 — 2026-11-13

**画面文字 OCR 双引擎：默认 Xiaomi-OCR-0，Windows OCR 兜底。**

- 新增 `scripts/ocr_xiaomi.py`：走本机 Ollama 的 `xiaomi-ocr-0`（0.8B 视觉语言模型，Apache-2.0 权重），
  输出契约与 `scripts/ocr_winsdk.py` 完全一致（每行 `{path,w,h,ms,lines:[{t}]}`），下游清洗逻辑零改动。
- 新增 `scripts/lib/ocr-engine.mjs`：引擎选择与降级调度。顺序由 `config/ocr.json` 的 `engine` 决定
  （`auto` = xiaomi → winsdk），也支持 `--ocr-engine=xiaomi|winsdk` 与 `VD_OCR_ENGINE` 临时覆盖。
  某个引擎起不来（Ollama 没起、模型没拉、Python 缺依赖）时自动降级并在日志里写明原因。
- 新增 `config/ocr.json`：`engine`、模型名、Ollama 地址、上下文长度、超时（毫秒）。
- `scripts/lib/tools.mjs`：Release 附件地址改为「先按当前版本 tag，再退回 `releases/latest`」。
  这样先推 tag、后传附件（或忘了传）时，首次运行仍能拉到 ffmpeg，而不是直接失败。
- README 增加「常见问题」：TLS 拦截导致下载失败（`NODE_OPTIONS=--use-system-ca`）、OCR 降级原因、数据目录位置。
- `scripts/digest.mjs`：S3.5 阶段改为调用调度模块；日志与 `ocrStats` 增加 `engine` 字段，
  失败时记录 `engines_tried`。
- 提示词经验：让模型输出 `{"lines":[...]}` 而不是「请转录文字」——后者对着界面截图会改写成
  「图像描绘了…白色字体，位于顶部中央」这类描述，污染正文；脚本内置了 JSON 提示词，
  并用「先 json.loads、失败按顺序抽引号字符串」的容错解析接住它偶尔写坏的 JSON。

实测（同一批 1080p 帧）：

| 引擎 | 体积 | 单帧 | 表现 |
|---|---|---|---|
| Xiaomi-OCR-0 | 1.6 GB | 0.4–1.4 s | `VIDEO DIGEST · CASE FILE 052`、`值得看 28 / 一般 22 / 别看了 2`、`¥0.004` 全对 |
| Windows OCR | 系统自带 | 36–50 ms | `V I D E 0`、金额读成 `0 0 0 0` |

单条 12 格视频：OCR 段 11 s（旧引擎 0.9 s），OCR 进 prompt 的字数从 1071 token 降到 181 token。

## v0.2.0 — 2026-11-09

首个对外发布包（脱敏）：流水线、面板、插件入口、`vendor/dsh-video-storyboard` 与默认配置。
