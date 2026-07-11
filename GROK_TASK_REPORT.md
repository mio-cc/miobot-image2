# Miobot / Napcat-OmniBot-v2 视频端到端交付报告

> 延续上一轮「grok 渠道适配」。本轮补齐视频闭环。  
> 全量测试：**391 / 391 通过**（`npm test` = build + `tests/*.test.mjs`）。

---

## 1. 改了哪些文件 / 函数

### model 层（异步轮询）
| 路径 | 函数 / 类型 | 改动 |
|---|---|---|
| `packages/model/src/ports.ts` | `VideoGenerationRequest`, `RequestPlan.method`, `VideoJobStatus`, `Dialect.buildVideoStatus` | poll 参数、GET 计划、视频任务状态 |
| `packages/model/src/client.ts` | `ModelClient.generateVideo`, `pollVideoUntilDone` | 提交后自动 `GET /videos/{id}` 轮询至 done |
| `packages/model/src/dialects/openai.ts` | `buildVideoGeneration`, `buildVideoStatus` | POST 生成 + GET 状态 |
| `packages/model/src/dialects/shared.ts` | `parseOpenAiVideo`, `buildOpenAiVideoStatus`, `normalizeVideoJobStatus` | 解析 pending/done/failed/expired |
| `packages/model/src/transport.ts` | `defaultFetchTransport` | GET 不带 body |
| `packages/model/src/capability/profiles.ts` | `GROK_VIDEO_PROFILE` | 注释更新（已具备 bot 闭环） |

### intent-router
| 路径 | 函数 | 改动 |
|---|---|---|
| `packages/intent-router/src/types.ts` | `IntentKind`, `IntentCapabilities`, `IntentParams` | `video.generate` / `videoGenerate` / duration/resolution |
| `packages/intent-router/src/signals.ts` | `hasVideoVerb`, `hasVideoBang`, `detectIntentSignals` | 视频词与 bang 信号，优先于生图 |
| `packages/intent-router/src/planner.ts` | `PlannerAction`, `DEFAULT_PLANNER_TEMPLATE`, `plannerActionToIntentKind` | action=`video` |
| `packages/intent-router/src/router.ts` | `gate`/`isCapable`/`degradeKind`/`buildParams` | 视频门控与 bang 时长/分辨率 |

### bot-engine / apps/bot
| 路径 | 函数 | 改动 |
|---|---|---|
| `packages/bot-engine/src/capabilities.ts` | `EngineRoutingConfig`, `resolveImageCapabilities` | `videoEnabled`/`videoModel` → `videoGenerate` |
| `packages/bot-engine/src/engine.ts` | `BotEngineDeps.generateVideo`, `dispatch` | `case 'video.generate'` |
| `apps/bot/src/deps.ts` | `createModelBackedDeps.generateVideo`, chat 视频降级 | 调 client + 轮询参数；视频理解文字降级 |
| `apps/bot/src/config-bridge.ts` | `toEngineRoutingConfig`, `toBotRouting` | video 节点/超时/轮询 |
| `apps/bot/src/runtime.ts` | `extractVideos`, `sendResult`, 富化 | 收 `type:video`；发视频优先 |
| `apps/bot/src/main.ts` | 导出 | `extractVideos` / `videoArtifactToString` 等 |

### napcat / reply
| 路径 | 函数 | 改动 |
|---|---|---|
| `packages/napcat/src/index.ts` | `sendGroupVideo`/`sendPrivateVideo`/`buildVideoSegment`/`buildVideoForwardNodes` | type:video 收发构造 |
| `packages/reply/src/index.ts` | `replyVideo`/`replyVideos` | 单视频直发；多视频合并转发 |

### config / free-mode / image
| 路径 | 改动 |
|---|---|
| `packages/config/src/index.ts` | `llm.videoNodeIndex/videoModel/videoEnabled/videoTimeoutMs/videoPollTimeoutMs/videoPollIntervalMs` 默认值 + normalize clamp；planner 模板含 video |
| `packages/image/src/index.ts` | `parseImageCommand` 识别 `video!`/`6s!`/`720p!` 等 bang |
| `packages/free-mode/src/index.ts` | 默认 planner 文案含 video action |

### 测试
`tests/model-compat.test.mjs`、`intent-router.test.mjs`、`bot-engine.test.mjs`、`napcat-adapter.test.mjs`、`reply-strategy.test.mjs`、`app-bot-runtime.test.mjs`、`config-regression.test.mjs`

---

## 2. 视频端到端链路

```
QQ 用户:「生成视频 火箭升空」(+可选图)
  → Napcat WS message
  → createBotMessageRuntime (apps/bot/src/runtime.ts)
       extractImages / extractVideos (type:video 段)
       引用/转发富化
  → bot-router (freeMode / chat 触发)
  → BotEngine.handleAuto
       IntentRouter.route → kind=video.generate (signals 或 planner)
       dispatch → deps.generateVideo
  → ModelClient.generateVideo
       1) POST {baseUrl}/videos/generations  → { request_id }
       2) 轮询 GET {baseUrl}/videos/{request_id}
          status: pending | done | failed | expired
       3) done → video.url
  → sendResult → ReplyStrategyEngine.replyVideo
  → NapcatAdapter.sendPrivateVideo / sendGroupVideo
       message: [{ type: 'video', data: { file: url } }]
  → QQ 短视频消息
```

官方依据（xAI docs）：
- `POST https://api.x.ai/v1/videos/generations` → `request_id`
- `GET https://api.x.ai/v1/videos/{request_id}` → `status` + `video.url`
- 模型名示例：`grok-imagine-video`；duration 1–15s；resolution 480p/720p/1080p

---

## 3. 自由模式视频自动路由规则

实现于 `packages/intent-router/src/signals.ts` 的 `detectIntentSignals`（主路径是 freeMode → BotEngine → IntentRouter，非独立 FreeModeEngine）。

| 规则 | 置信 | 说明 |
|---|---|---|
| 强词：生成视频 / 做个视频 / 做视频 / 文生视频 / 图生视频 / generate video / make a video … | 0.9 | 优先于生图，避免「生成视频」被当生图 |
| 弱词：短句中的「视频」/ video（排除视频会议/刷视频等） | 0.9 | 长度 ≤40 或与「生成/做/拍」等同现 |
| bang：`video!` / `视频!` / `t2v!` / `i2v!` / `6s!` / `duration=6!` / `480p!` / `720p!` / `1080p!` | 0.8–0.9 | `parseImageCommand` 收入 tokens |
| 规划器 `{"action":"video",...}` | 0.7 | 歧义时 LLM 判定 |
| 能力门控 | — | `videoGenerate` 不可用 → 降级 `chat` |

图生视频：有图 + 视频意图时，`engine.dispatch` 把 `images[0]` 作为 `imageUrl`。

用户发送视频文件并请求处理：
- `extractVideos` 纳入 `input.videos`
- chat 路径不把视频当图片喂 vision；`deps.chat` 注入文字说明并记录日志（优雅降级，不崩）

---

## 4. 异步轮询设计

`ModelClient.generateVideo`（`packages/model/src/client.ts`）：

| 项 | 默认 / 行为 |
|---|---|
| 提交 | dialect `buildVideoGeneration` → POST `/videos/generations` |
| 即时 URL | `parseOpenAiVideo` 若已有 url → 直接返回 `pending=false` |
| 轮询 | `buildVideoStatus` / `buildOpenAiVideoStatus` → GET `/videos/{id}` |
| 间隔 | `pollIntervalMs` 默认 **5000**（对齐官方 REST 示例） |
| 总超时 | `pollTimeoutMs` 默认 **600000**（10 分钟，对齐 xAI SDK） |
| 状态 | `pending` 继续；`done` 返回 URL；`failed`/`expired` 抛 `ModelError(code=video_failed|video_expired)` |
| 瞬时错误 | GET 404/429/5xx 或网络错误最多连续 **3** 次再抛 |
| 可选 | `waitForCompletion: false` 只返回 requestId（单测/自管轮询） |

配置映射：`llm.videoTimeoutMs` / `videoPollTimeoutMs` / `videoPollIntervalMs` → `toBotRouting` → deps。

---

## 5. 限制与风险

### QQ / Napcat 视频
- 短视频消息对**时长、大小、编码**有限制（常见约数十秒内、**MP4 + H.264**）；超限可能发送失败。
- 代码注释：`napcat` 的 `sendGroupVideo`/`sendPrivateVideo`、`runtime.sendResult`、`ports.VideoGenerationRequest`。
- 超限兜底（后续）：可改发 `type:file` 或本地压缩后再发。
- 上游视频 URL 多为**临时链接**，需尽快下载/转发。

### grok / Imagine Video
- 异步为主，生成可达数分钟；bot 在轮询完成前会占用处理时间（注意并发与用户等待提示）。
- 默认模型名 `grok-imagine-video`；需在 `llm.apiKeys[].models` 中声明，并设 `videoNodeIndex` 指向 xAI 节点（`baseUrl: https://api.x.ai/v1`）。
- 本轮未实现 video edit / extend / reference-to-video（官方另有 `/videos/edits` 等）。

### 其它
- 对话模型**不能理解视频内容**；收视频走文字降级。
- 无 URL 的本地缓存文件名可能无法被模型拉取。
- web-panel 视频配置 UI 未做（可选，配置 JSON 已可用）。

---

## 6. 建议配置

```json
{
  "llm": {
    "apiKeys": [{
      "name": "xAI",
      "baseUrl": "https://api.x.ai/v1",
      "key": "<XAI_API_KEY>",
      "enabled": true,
      "models": ["grok-4.5", "grok-imagine-image-quality", "grok-imagine-video"]
    }],
    "chatModel": "grok-4.5",
    "imageModel": "grok-imagine-image-quality",
    "editModel": "grok-imagine-image-quality",
    "videoModel": "grok-imagine-video",
    "videoNodeIndex": 0,
    "videoEnabled": true,
    "videoTimeoutMs": 120000,
    "videoPollTimeoutMs": 600000,
    "videoPollIntervalMs": 5000
  },
  "freeMode": {
    "enabled": true,
    "model": "grok-4.5",
    "includeQuotedMessage": true
  }
}
```

---

## 7. 仍需人工确认 / 后续事项

1. 真实 xAI 密钥下做一次端到端（生成 + QQ 收发）验收。
2. QQ 端实测不同客户端对视频时长/码率的拒绝阈值，必要时加压缩/file 回退。
3. 长轮询期间给用户「正在生成视频…」进度提示（当前同步等待）。
4. 可选：web-panel 增加视频模型/节点表单项。
5. 可选：显式命令别名（如 `生视频`）进 `bot.commands` + `handleExplicit('video.generate')`。
6. 可选：video edit / extend API。

---

## 8. 测试结果（真实数字）

```
npm test
# tests 391
# pass  391
# fail  0
```

**提醒：** 部署机执行 `npm run build` 后重启 bot，否则仍跑旧 `dist/`。
