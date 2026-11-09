# 内置工具（Windows x64，Release 附件）

Windows 版 ffmpeg / ffprobe 以 **GitHub Release 附件** 形式发布，不进 git 仓库：

- 附件名：`ffmpeg-9.0.2-win64.zip`（ffmpeg.exe + ffprobe.exe，约 74 MB）
- 本目录保留：`win64/LICENSE-ffmpeg.txt`（GPLv3 全文）、`win64/README-ffmpeg.txt`（构建参数）、`win64/NOTICE.txt`（来源与源码获取）

## 首次运行怎么拿到它

脚本需要 ffmpeg 时（`scripts/lib/tools.mjs` 的 `ensureFfmpegTools()`）会按以下顺序处理：

1. 先找现成的 ffmpeg：`VD_FFMPEG` / `VD_FFPROBE` → `<数据目录>/tools/ffmpeg.exe` → 包内 `tools/` → PATH → 常见安装位置
2. 找不到，就找本地 zip：`VD_TOOLS_ZIP` → `<数据目录>/tools/*.zip` → 包内 `tools/win64/*.zip`
3. 还没有，就下载：`VD_TOOLS_URL` → `config/plugin.json` 的 `toolsZipUrl` → 由 `package.json` 的 `repository` 推导出的 Release 地址（本仓库：imxiaocheng-dev/dsh-video-digest）
4. 解压到 `<数据目录>/tools/`（优先系统 `tar`，失败退 PowerShell `Expand-Archive`）

离线安装：手动下载 Release 里的 `ffmpeg-9.0.2-win64.zip`，放到 `<数据目录>/tools/`，下次运行直接解压。

## 替换成你自己的版本

设置 `VD_FFMPEG` / `VD_FFPROBE` 指向你信任的 ffmpeg 即可，内置包不会被使用。

## 其它平台

macOS / Linux 不内置可执行文件（体积与 glibc 兼容问题），请用系统包管理器安装 ffmpeg，或用环境变量指定。

## 发布者：上传 Release 附件

1. `package.json` 的 `repository` / `homepage` 已填为 `imxiaocheng-dev/dsh-video-digest`（换账号/仓库时改这里；`tools.mjs` 靠它推导下载地址）。
2. 生成或复用 `ffmpeg-9.0.2-win64.zip`，上传到对应 tag 的 Release（tag 必须是 `v` + `package.json` 的 `version`，例如 `v0.2.0`）：

   ```powershell
   gh release create v0.2.0 "路径\ffmpeg-9.0.2-win64.zip" --title "v0.2.0" --notes "首次发布"
   ```

   也可以网页上传，附件名保持 `ffmpeg-9.0.2-win64.zip`。
3. 想换版本就同时改 `ZIP_NAME`/`version`，或让用户用 `VD_TOOLS_URL` 指向别的 zip。
