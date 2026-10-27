# R10 Tool Topology

## 原则

Miobot 的工具组合不是固定工作流，也不是关键词路由。

模型负责：

- 看懂用户目标；
- 判断缺少哪些事实或中间产物；
- 根据工具 schema 和描述自主选择工具；
- 判断哪些调用可并行、哪些必须等待上一轮 tool result；
- 在工具结果回填后继续推理，必要时继续调用。

Harness 负责：

- 暴露真实工具 schema/描述；
- 校验参数、权限、审批和上下文；
- 执行工具；
- 把 tool result 原样回填给同一个模型；
- 处理超时、重试、幂等、异步 job、结果落盘和输出修复；
- 只在模型给出可交付结果后执行 ReplyPlan。

禁止：

- 关键词到工具名的硬编码路由；
- 测试脚本替模型写死完整工具顺序并冒充自主性；
- 能力问卷、固定澄清模板、固定兜底话术。

## 工具类别

### 事实/读取类

- `web.search`：外部事实、歌词、网页、最新信息、URL。
- `image.interrogate`：理解已有图片，产出可复用的描述/提示词。
- `file.read`：读取用户文件，产出可继续加工的文本/图片/文件。
- `audio.music.history`：查询 Miobot 已生成歌曲历史，产出 `recordId/globalSeq`。

### 产物类

- `image.generate`、`image.edit`、`image.stitch`
- `video.generate`
- `file.generate`
- `code.render`、`browser.render`
- `audio.music.generate`
- `audio.music.replay`
- `audio.music.variant`
- `audio.music.replace_section`
- `tts.speak`

### 状态/交互类

- `ask_user`：只在缺少用户必须提供、无法从工具获得的具体参数时使用。
- 审批、配置更新、权限更新、撤回、定时任务、音色选择等。

## 典型依赖拓扑

这些是**能力依赖示例**，不是固定路由规则；模型可根据上下文选择、跳过或组合。

| 上游结果 | 可作为下游输入 | 依赖关系 |
|---|---|---|
| `web.search` 文本 | 最终回答、`audio.music.generate.lyrics`、`image.generate.prompt`、`browser.render.url` | 搜索结果是外部事实，不能伪造 |
| `image.interrogate` 文本 | `image.generate.prompt`、`image.edit.prompt` | 先理解参考图，再生成/编辑 |
| `file.read` 文本 | 最终回答、`file.generate`、其他文本工具 | 先读取，再加工 |
| `audio.music.history` 记录 | `audio.music.lyrics`、`audio.music.replay`、`audio.music.variant`、`audio.music.replace_section` | 先取 `recordId/globalSeq`，再引用历史歌曲 |
| `web.search` URL | `browser.render.url` | 先找 URL，再截图 |
| `image.generate` 产物 | ReplyPlan 图片发送、图库同步 | 产物由 Runtime 交给发送层 |

## 调度模型

- 同一轮内，相互独立的只读工具可以并行。
- 依赖上游结果的下游工具必须等 tool result 回填后再发起。
- 副作用工具串行执行；需要审批时挂起，不执行未批准的动作。
- 异步 job 可恢复；恢复时不能重复产生副作用。
- 工具结果超过上限可截断，启用 spill 时完整结果落盘。
- 模型输出协议/schema 错误回给同一模型修复，不交给固定模板。

## 验收矩阵

离线：

```text
npm test
node --test tests/napcat-agent-comprehensive-r10.test.mjs
```

真实模型：

```text
MIOBOT_LIVE_CONFIG=/path/to/exported-config.json npm run check:r10:topology
```

`scripts/r10-live-topology.mjs` 只提供每类场景可用工具，不规定模型调用顺序；它记录模型自主产生的 tool call，用于检查：

- 歌词搜索 → Suno；
- 搜索 → 网页截图；
- 图片反推 → 图片生成；
- 历史查询 → 歌词；
- 搜索与历史并行；
- 缺少文件时正确追问而不是编造。

真实模型结果中如果缺少必要搜索，应改系统提示词、工具描述、结果回填或权限，而不是加关键词路由。

## 歌词意图对照测试

同一真实模型、同一工具集合，只改变用户意图。

### A：现有歌词

用户：来一首《青花瓷》，就要周杰伦那一版的感觉，词别给我乱改

模型自主行为：

- 调用 web.search，query 包含 周杰伦 青花瓷 歌词 完整版 方文山；
- 搜索结果回填后调用 audio.music.generate；
- lyrics 使用检索到的原词。

### B：原创歌词

用户：来一首《青花瓷》，但我想听点全新的，歌词要你自己写，别用现成原词

模型自主行为：

- 没有调用歌词搜索；
- 直接调用 audio.music.generate；
- lyrics 是全新原创内容。

结论：工具顺序不是由运行时或关键词决定，而是模型根据用户意图和工具 schema 自主决定。

复跑命令：npm run check:r10:intent。
