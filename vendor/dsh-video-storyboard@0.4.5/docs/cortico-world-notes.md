# 接 Coopanion（Cortico World）的笔记

2026-10-28 写过一版完整的适配层，本地验证通过后**删掉了**。这里留下契约和结论——
下次真要重做，照着这份笔记半小时能写回来，不用重新读别人的源码。

## 为什么删

1. **已经有人做了**：[`cortico-world-video-storyboard`](https://www.npmjs.com/package/cortico-world-video-storyboard)
   （作者 huahuahuaze，思路源自本项目），而且功能更全：Windows 自动下载 ffmpeg / yt-dlp、
   配置页、长片多图分段、可选本地语音识别。
2. **它不在任何自动检查里**：`scripts/check-syntax.mjs` 的 `DIRS = ['src','bin','scripts']` 不含它，
   `node --test` 只扫 `test/`，它也**没有测试**。
3. **它不发布**（不在 `files` 里），所以没人用；主包 API 一变它就悄悄坏掉，谁都不会发现。

结论：留着是死代码 + 隐形成本。知识留下就够，代码不必。

## Cortico World 的契约（api: 6）

`package.json`：

```json
"cortico": {
  "kind": "world",
  "api": 6,
  "displayName": "视频分镜",
  "describe": "describe.json",
  "webUiClient": "dist/webui.js"
}
```

- `webUiClient` 可选（有控制台页面才需要）
- **`keywords` 必须含 `cortico-world`** —— Coopanion 的 Extensions 页就是按这个关键词扫 npm 的
- 装法：Extensions 页搜到 → 安装 → **重启进程** → World Overview 里启用

入口默认导出：

```js
export default { id, label, defaults, describe: { tools, events }, preflight, create }
```

- `create(ctx)` 收到 `cfg / dataDir / botDir / packageDir / secret / storeSecret`
- **`create()` 会被装配层给所有可用定义跑一遍，必须纯**：不建目录、不发请求、不读密钥
- 实例实现 `tools()`，返回 `[{ name, description, parameters, tags, handler }]`
- handler 返回 `{ text, blobs?, failed? }`：
  ```js
  { text: '给人读和给模型读的文本',
    blobs: [{ bytes: Buffer, mime: 'image/png', name: 'x.png', fallbackText: '[图片 x.png]' }] }
  ```
  `blobs` 就是"图片进模型上下文"的通道——参考实现的注释原话是"blob 交给 Core 进上下文与日志"。
- `describe.json` 形状：`{ tools: [...], events: [], prompts: [{ key, title, role: 'envPrompt', content }] }`，
  其中 `tools[].parameters` 用**标准 JSON Schema**。

## 已本地验证（不经过 Coopanion）

直接 `import` 定义并调 handler：

```
id: video-storyboard | preflight: ok | tools(): ['video_storyboard[read]']
空参数 → failed（不会静默出一张黑图）
真实 90 秒视频 → 1.8 s
blobs → mime=image/png, 701496 bytes, Buffer=true, PNG 魔数校验通过
```

也就是说业务层是通的：参数清洗 → 调 `runStoryboard` → 拼清单 → 把真 PNG 塞进 `blobs`。

## 未验证的（这就是不发、不留的理由）

1. **handler 签名**是否真是 `(args)`，还是带 `(args, ctx)`
2. **`blobs` 的字段要求**：`bytes` 要不要 Uint8Array、`mime` 的写法
3. **`prompts[].key` 的命名**是否按 `worlds.<id>.envPrompt` 匹配（我们的 id 带横线）
4. **`api: 6` 的版本差异**（旧版 Coopanion 可能不认）

第 1、2 条如果猜错，症状是**工具能调、但看不到图**。

## 依赖主包的方式（关键：不复制代码）

`dsh-video-storyboard` 的 `exports` 已经暴露了子路径，所以适配层可以直接：

```js
import { runStoryboard, formatManifest, DETAIL_CHARS } from 'dsh-video-storyboard/pipeline';
import { DEFAULT_FFMPEG } from 'dsh-video-storyboard/probe';
```

主包**零改动**，也不会有"复制出去就分叉"的问题——主包修了什么，这边跟着变。
这正是自己做一个"壳"的唯一理由；如果只是想尽快用，装那个现成的就行。

## 参考实现

[`Lostdegree/cortico-world-image`](https://github.com/Lostdegree/cortico-world-image)
（npm 包 `cortico-world-image`）——上面所有契约细节都是从它的源码读出来的，是目前最完整的范例。

## 如果将来要发

1. 换一个没被占用的包名（`cortico-world-*` 前缀），`keywords` 加 `cortico-world`
2. 至少找一个人**真的在 Coopanion 里跑通**再发
3. 发之前把适配层塞进某套自动检查里，否则它又会变成"在仓库里但没人管"的代码
