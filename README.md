# 一起看视频 · dsh-video-digest

把 B 站视频的「看」这件事拆成一条可核实的本地流水线：**字幕 + 画面文字 + 宫格 + 弹幕 → 事实卡 → 门禁 → 总结 → 私信**，接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）。在 DSH 里丢一条 BV 号，几十分钟后收到一条能直接读的私信总结；不想花钱的环节全部在本地完成。

## 它会做什么

1. **选片**：按你的「视频偏好」搜 B 站新片，去重、按热度/时长/发布时间过滤，排进队列。
2. **取流**：拿字幕（B 站 AI 字幕，免费）、抽帧、拼宫格图。
3. **读画面**：Windows 本地 OCR 读画面内文字（可选，缺 Python 就跳过并标注「无画面文字」）。
4. **读观众**：拉弹幕，统计争议点/信息点/提问点。
5. **事实卡**：把逐段台词、画面文字、弹幕压成一份带时间码的材料（不送原始视频给模型）。
6. **门禁**：本地判「这条值不值得花云端算力」，不值就跳过。
7. **总结**：云端模型按模板写总结——先说清讲什么，再给技术手段、证据强弱、我的评估；结构自动选「技术审阅式 / 拆解复算式」。
8. **投递**：拼成私信正文，先 dry run；确认后发给推送账号（前 3 位生效），并复核会话里能不能看到。

## 特性

- **低成本**：字幕 0 元、OCR 0 元、弹幕 0 元；只有「看宫格图 + 写总结」走云端，单条通常几分钱（见 `config/pricing.json` 与面板「花费与预算」）。
- **可回查**：总结里的关键说法都带 `[MM:SS]`；型号、数字、价格逐字取自视频，不换算、不脑补。
- **不碰你的账号密码**：只在本机 `secrets/bili.json` 存 cookie，面板接口永不回显；投递缺省 dry run。
- **数据与代码分离**：包可以放只读目录，所有数据（库、缓存、产物、凭证）都在独立数据目录。
- **面板即文档**：11 个页面全部读写真实数据，没有演示按钮。

## 前置依赖

| 依赖 | 必需性 | 说明 |
|---|---|---|
| Node.js ≥ 20 | **必需** | 插件与脚本都是 ESM |
| DeepSeek Harness ≥ 0.2.0-rc.1 | **必需** | 插件宿主（本包是 DSH bundle） |
| `ffmpeg` + `ffprobe` | **Windows 自动获取** | 抽帧、转封装、取时长。Windows 版不再把 exe 放进仓库：首次运行会从 GitHub Release 下载 `ffmpeg-9.0.2-win64.zip`（约 74 MB）并解压到数据目录 `tools/`（需要联网一次）；下载慢或离线时，也可以手动下载该附件放到 `<数据目录>/tools/`。其它平台请自装到 PATH，或用环境变量 `VD_FFMPEG` / `VD_FFPROBE` 指定绝对路径 |
| Python 3.10+ | 可选 | 只有 OCR 用。装了但缺 `winsdk` 时会跳过画面文字，不影响其它环节 |
| `winsdk`（`pip install winsdk`） | 可选 | Windows 本地 OCR；没有就用 `scripts/ocr_batch.ps1`（PowerShell 5.1 自带引擎，慢一点） |

> OCR 只在 Windows 上可用（Windows.Media.Ocr）。其它平台会自动跳过画面文字。

### 内置工具（GitHub Release 附件）

- `ffmpeg-9.0.2-win64.zip`：ffmpeg + ffprobe（Windows x64，取自 gyan.dev 的 essentials build，版本 `9.0.2-essentials_build-www.gyan.dev`），作为本仓库 **Release 附件**发布，不进 git 仓库（避免 clone 变重）。
- 首次运行缺少 ffmpeg 时，`scripts/lib/tools.mjs` 会按以下来源自动下载：环境变量 `VD_TOOLS_URL` → `config/plugin.json` 的 `toolsZipUrl` → 由 `package.json` 的 `repository` 推导出的本仓库 Release 附件地址。
- 下载/解压失败也不会卡死：把 zip 手动放到 `<数据目录>/tools/` 再重跑即可。
- 该构建启用了 `--enable-gpl --enable-version3`，以 **GPLv3** 分发。许可证全文见 `tools/win64/LICENSE-ffmpeg.txt`，构建配置见 `tools/win64/README-ffmpeg.txt`，来源与源码获取见 `tools/win64/NOTICE.txt`。
- 对应源码：<https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz>（自行构建/替换后，用 `VD_FFMPEG` 指向你的二进制即可）。


## 安装

本包是一个 DSH profile bundle（`cordis.patch.yml` 声明），不是独立服务器。安装方式与普通 DSH 插件一致：

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"    # 换成你的 profile 目录
# 1) 把本目录放到 profile 的 node_modules 下（目录链接即可，改代码即时可见）
cmd /c mklink /J "$prof\node_modules\dsh-video-digest" "D:\path\to\dsh-video-digest"

# 2) 编辑 $prof\package.json：
#    dependencies 里加   "dsh-video-digest": "file:D:/path/to/dsh-video-digest"
#    dsh.profile.bundles 数组里加 "dsh-video-digest"
```

改完 **重启 DSH**。之后在 DSH 里会多出 `video_digest` / `video_queue` / `video_write_summary` 三个工具，右侧栏出现「一起看视频」页签。

发布到 npm 后也可以改为 `npm i dsh-video-digest` + 在 profile 里 `"dsh-video-digest": "^0.2.0"`，步骤相同。

## 首次配置

1. **数据目录**：默认 `~/.dsh/video-digest/`（`$VD_DATA` 可覆盖）。首次启动会自动建目录，并从包内 `config/` 播种一份默认配置（已有文件不覆盖）。
2. **登录 B 站**（扫码，不导出 cookie 到聊天）：
   ```powershell
   python scripts/bili_qrlogin.py login
   ```
   成功后 cookie 写到 `<数据目录>/secrets/bili.json`。校验：`python scripts/bili_cookie.py`（只回昵称/等级，不回显 cookie）。
3. **填推送账号**：编辑 `<数据目录>/config/push.json` 的 `accounts`，填你自己的 B 站 uid 与昵称（`uid` 可从个人空间 URL 看到）。最多前 3 位生效，第 4 位起待命。
4. **选摘要模型**：面板「设置」或 `config/summarize.json`。`mode: "session"` 用 DSH 当前会话模型；`directSummary: true` 走直连（更快、更省）。价目表在 `config/pricing.json`，预算在 `config/budget.json`。
5. **（可选）本地摘要模型**：`config/summarize.json` 的 `baseUrl` 默认指向本机 Ollama（`http://127.0.0.1:11434`），用于「为什么值得看」这类离线预判，不装也能跑。

## 用法

### 面板

```powershell
node scripts/panel_server.mjs 8791
# 独立进程模式：打开 http://127.0.0.1:8791/
# 由 DSH 插件内置（inproc）时：打开 http://127.0.0.1:<DSH端口>/video-panel/
```

DSH 在线时面板由插件内置的 inproc 服务提供，不需要单独起；单独起一个用于调试/无 DSH 时。

11 页：概览 / 队列 / 归档 / 视频偏好 / 账号与推送 / 入站与投递 / 人设与预览 / 花费与预算 / 节奏与择时 / 账本 / 设置。所有写操作是 `POST /api/...`；投递类默认 dry run，真发要显式 `{"mode":"send"}`。

### DSH 工具

- `video_digest`：`op=list / enqueue / pending / archive` 等，看队列、把 BV 号加进队列、看归档。
- `video_queue`：面向「一起看视频」的队列与归档查询。
- `video_write_summary`：把一条已看过的视频写成正式版云端总结并落盘，随后由投递链路发私信。

### CLI（可单独跑）

```powershell
node scripts/pick.mjs --limit=15 --pages=2            # 选片（默认按发布时间取 30 天内新片）
node scripts/runner.mjs --limit=2 --depth=T3          # 跑队列前 2 条
node scripts/digest.mjs BV1xx411c7mD --depth=T2       # 只处理一条（取流/宫格/OCR/事实卡）
node scripts/gate.mjs  --bv=BV1xx411c7mD              # 单看门禁结论
node scripts/summarize.mjs --bv=BV1xx411c7mD          # 生成总结（落 summary.cloud.json）
node scripts/why.mjs  --bv=BV1xx411c7mD               # 「为什么值得看」一句话
node scripts/sender.mjs --bv=BV1xx411c7mD             # 拼投递正文（DRY，不发）
node scripts/sender.mjs --bv=BV1xx411c7mD --send      # 真发（谨慎）
node scripts/cache_sweep.mjs --dry                    # 看缓存占用与清理策略
```

发送前建议先 DRY 看正文。`--send` 会真的发 B 站私信，且受 B 站频率限制与风控影响。

## 数据目录

```
<数据目录>/
  config/      本机配置（从包内 config/ 播种，之后只读这里）
  secrets/     bili.json（cookie），永不入库、永不打印
  logs/        library.db / inbound.db / outbound.db / *.log
  out/         成品：每条的 factcard.json、summary.cloud.json、宫格与报告
  cache/       接口响应、下载视频、抽帧、宫格、OCR 缓存（可随时清）
  derived/     派生物料（可重建，重建要花钱/费时间）
  runtime/     Python 依赖（可选）
  inbox/       丢进来的链接/文件
```

数据目录与代码目录分离：插件按 `scripts/lib/paths.mjs` 解析，顺序是 `$VD_DATA` → `$DSH_HOME/video-digest` → 旧布局（代码目录里已有 `logs/library.db`）→ 默认新目录。**升级/重装插件不会动数据目录。**

## 隐私与风险

- B 站 cookie 等同账号密码：只存本机 `secrets/bili.json`；只调读接口与「发私信/评论」这类用户明确触发的写接口。
- 自动抓取有风控风险：B 站会按频率/时段限流，播放量、评论、私信都可能触发冷却。`config/pacing.json` 里有冷却与节奏，别把频率调太猛。
- 私信/评论有平台限制（长度、频率、审核）。投递默认 dry run；`dispatch.enabled` 默认关闭，自动派工需要你手动打开。
- 本工具不保证内容正确：总结来自模型，可能出错。重要结论请回看视频时间码。

## 目录结构（包内）

```
index.js             DSH 插件入口（工具注册、面板路由、入站轮询）
client.js            浏览器侧（右侧栏页签）
cordis.patch.yml     DSH bundle 声明
panel/index.html     11 页面板（单文件）
scripts/             流水线与面板服务（digest/runner/pick/gate/summarize/sender/why/...）
scripts/lib/         共享库（paths 路径真源、bili、danmaku、inbound、material、copy、persona-text…）
config/              默认配置与模板（templates/summary.md、dm.md、comment.md、why.md）
vendor/              第三方源码（仅 dsh-video-storyboard，MIT，附 LICENSE/NOTICE）
docs/                架构说明
```

## 第三方

`vendor/dsh-video-storyboard/` 是 [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) 0.4.5 的源码拷贝（MIT，Copyright (c) 2026 SAOS-3624），用于宫格图排版，保留其 `LICENSE` 与 `NOTICE`。`scripts/digest.mjs` 优先从 `node_modules/dsh-video-storyboard/src` 加载，找不到才回落 `vendor/`。

## License

MIT。见 `LICENSE`。

## 免责声明

本项目只用于个人学习与自用自动化，与哔哩哔哩无关联。使用它抓取/发送内容前，请自行确认符合 B 站用户协议与当地法律；因账号限流、封禁或内容错误造成的损失由使用者自负。
