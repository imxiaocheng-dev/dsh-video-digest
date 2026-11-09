# 架构

一句话：**能本地判的都在本地判，只把「必须看画面」和「必须写文章」两件事交给云端模型。**

## 流水线

```
pick ──▶ queue ──▶ runner ──▶ digest ──▶ factcard ──▶ gate ──▶ summarize ──▶ sender
 选片      入列      调度        取流/宫格    事实卡       门禁       总结          投递
```

| 阶段 | 脚本 | 产物 | 花不花钱 |
|---|---|---|---|
| 选片 | `scripts/pick.mjs` | `out/pick/cand-*.json`、library 队列表 | 0 |
| 调度 | `scripts/runner.mjs` | 队列状态、失败重试、深度档位 T2/T3/T4 | 0 |
| 取流 | `scripts/digest.mjs` | `cache/`（视频/帧/宫格）、`derived/`（时间轴） | 0 |
| 事实卡 | `scripts/factcard.mjs` | `out/<BV>/factcard.json`（逐段台词/画面文字/弹幕/信号） | 0 |
| 门禁 | `scripts/gate.mjs` | `gate` 结论（pass/skip）、`out/<BV>/gate.json` | 0（可选本地模型） |
| 总结 | `scripts/summarize.mjs` + `scripts/lib/persona-text.mjs`、`dm-json.mjs`、`copy.mjs` | `out/<BV>/summary.cloud.json`、私信正文 | 按 token 计费 |
| 投递 | `scripts/sender.mjs` + `scripts/lib/dm.mjs` | `logs/outbound.db`、`logs/deliver.log` | 0（B 站接口） |
| 入站 | `scripts/lib/inbound-tick.mjs` | `logs/inbound.db`（谁发了什么，入列） | 0 |

## 关键设计

1. **数据与代码分离**：`scripts/lib/paths.mjs` 是唯一路径真源。代码目录可只读；数据目录用 `VD_DATA`/`DSH_HOME` 解析，首次运行 `ensureData()` 建目录并从包内 `config/` 播种缺失配置。
2. **材料最小化**：模型只看 `materialBrief()` 生成的「这条视频 / 逐段（台词+画面文字）/ 事实 / 弹幕」，看不到原始帧与完整视频。总结里要求 `[MM:SS]` 可回查。
3. **结构是生成契约，不是 UI**：`STRUCTURE_WORD` 定义新闻/技术审阅/拆解复算/结论·证据·边界等写法；`auto` 由 `resolveStructure()` 按标题信号选档（拆解/教程→teardown，其余→tech），生成时解析成具体档位。
4. **私信版式单独实现**：`buildDm()` 决定用户真正看到的正文（称呼 + gist + 最多 4 条要点 + 值得看的一段 + 我的评估 + BV），与总结 JSON 字段解耦；`dm-json.mjs` 的契约约束字段长度与「数字逐字照材料」。
5. **写盘前清洗**：`scrubInternalWords()` / `scrubAnalysisLeak()` / `enforceParticles()` 兜底，防止「第N格、材料、OCR」这类内部词漏到正文。
6. **幂等与可重入**：门禁、总结、投递都按 BV 记录状态，重复运行走缓存/旧结论，不重复花钱。
7. **热加载**：面板侧 `panel_server.mjs` 与其 import 的 `scripts/lib/*.mjs` 按文件 mtime 重新 import；插件侧 `index.js` 改动需要重启 DSH。

## 配置

| 文件 | 作用 |
|---|---|
| `config/persona.json` | 人设（怎么说）、表达格式、长度上限 |
| `config/push.json` | 推送账号（最多前 3 位生效）、投递形态上限、防打扰 guard |
| `config/prefs.json` | 视频偏好（类目/词条/权重/搜索词） |
| `config/pacing.json` | 节奏、可跑时段、风控冷却、入站策略、派工开关 |
| `config/pricing.json` | 模型价目（高峰/低谷） |
| `config/budget.json` | 日/周/月预算与降级策略 |
| `config/summarize.json` | 摘要模型（session 或直连）、本地模型地址 |
| `config/gate.json` | 门禁阈值与抽样比例 |
| `config/storage.json` | 缓存保留天数 |
| `config/plugin.json` | 插件服务模式、轮询间隔、入站节奏 |

模板在 `config/templates/`：`summary.md`（长总结）、`dm.md`（私信）、`comment.md`（评论）、`why.md`（一句话理由）。

## 数据流与「不做什么」

- 不把视频上传到任何服务器；只把压缩后的文本材料发给配置的模型。
- 不主动点赞/关注/收藏；评论与私信只在用户触发的投递路径里发生，默认 dry run。
- 不读取陌生人私信正文：陌生人只计数（`logs/inbound.db` 的 `strangers`），用于「要不要理」判断。
- 不把 cookie 写日志、不回显、不进 git。

## 已知限制

- OCR 仅 Windows（Windows.Media.Ocr）。
- B 站接口会限流，`pacing.json` 的冷却/时段是硬约束，绕不过去。
- 私信/评论有平台长度与审核限制；`config/push.json` 的 `shape` 上限是最保守的默认值。
- 总结质量取决于材料质量：没有字幕、没有画面文字、弹幕又少时，模型只能基于很薄的上下文写，容易空泛。门禁会把这类片挡掉。
