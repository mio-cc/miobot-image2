先读 `GROK.md` 与上一轮 `GROK_TASK_REPORT.md`，再按报告里的视频缺口逐项读真实源码。接着精读 model、intent-router、bot-engine、napcat、reply、runtime 与 config 的真实实现。开始实现：先改 model 层（轮询 + RequestPlan GET），再贯通 intent/engine/napcat/reply/config。修复 `parseOpenAiVideo` 里 `root.error` 的取值，并继续改 intent-router 与 bot-engine。接着实现 Napcat 发视频、reply 策略，以及 config/deps/runtime 接入。Build 已通过，开始跑全量 `npm test`。修复三处失败：识别 video bang、failed 状态在 `assertNoTopLevelError` 之前处理。全量测试 **391/391 通过**。正在写交付报告并更新 `GROK_TASK_REPORT.md`。# 视频端到端交付报告

上一轮缺口已全部接上。全量测试：**391 / 391 通过**（`npm test`）。详细版已写入 `GROK_TASK_REPORT.md`。

---

## 1. 改了哪些文件 / 函数

| 层 | 关键路径与函数 |
|---|---|
| **model 轮询** | `ModelClient.generateVideo` / `pollVideoUntilDone`（`packages/model/src/client.ts`）；`parseOpenAiVideo` / `buildOpenAiVideoStatus`（`dialects/shared.ts`）；`openAiDialect.buildVideoStatus`；`transport` 支持 GET |
| **意图** | `IntentKind` 增 `video.generate`；`hasVideoVerb` / `hasVideoBang` / `detectIntentSignals`；planner `action: "video"`；router 门控与 `duration`/`resolution` bang |
| **引擎** | `BotEngineDeps.generateVideo`；`dispatch` 的 `case 'video.generate'`；`resolveImageCapabilities.videoGenerate` |
| **装配** | `deps.generateVideo`、chat 视频文字降级；`toBotRouting`/`toEngineRoutingConfig` 视频字段 |
| **收发** | `extractVideos`（`runtime.ts`）；`sendGroupVideo`/`sendPrivateVideo`/`buildVideoSegment`（napcat）；`replyVideo`/`replyVideos`（reply） |
| **配置** | `llm.videoNodeIndex/videoModel/videoEnabled/videoTimeoutMs/videoPollTimeoutMs/videoPollIntervalMs` 默认值 + normalize |
| **bang** | `parseImageCommand` 识别 `video!` / `6s!` / `720p!` 等 |

---

## 2. 端到端链路

```
QQ「生成视频 …」(+可选图)
  → Napcat → runtime（extractImages/extractVideos + 引用富化）
  → IntentRouter → video.generate
  → ModelClient.generateVideo
       POST /videos/generations → request_id
       循环 GET /videos/{id} 直到 done
  → replyVideo → type:video → QQ
```

xAI 官方：`POST /v1/videos/generations` + `GET /v1/videos/{request_id}`，状态 `pending|done|failed|expired`，完成字段 `video.url`。

---

## 3. 自由模式视频路由

主路径是 **freeMode → BotEngine → IntentRouter**（非独立 FreeModeEngine）。

- **强词**：生成视频 / 做个视频 / 文生视频 / make a video … → `video.generate`（置信约 0.9，**优先于生图**）
- **弱词**：短句「视频」/ video（排除视频会议等）
- **bang**：`video!` `6s!` `720p!` 等（`parseImageCommand` 收入 tokens）
- **规划器**：`{"action":"video",...}`
- **门控**：无 `video.generate` 能力 → 降级 chat  
- **图生视频**：有图时 `images[0]` → `imageUrl`  
- **用户发视频**：`extractVideos` 纳入输入；chat 不把视频当图喂 vision，文字降级提示，不崩

---

## 4. 异步轮询设计

| 项 | 值 |
|---|---|
| 默认间隔 | 5s（`pollIntervalMs`） |
| 默认总超时 | 10 分钟（`pollTimeoutMs`） |
| 完成 | `status=done` + `video.url` |
| 失败 | `failed`/`expired` → `ModelError(code=video_failed\|video_expired)`，不重试 |
| 瞬时错误 | 404/429/5xx/网络 最多连续 3 次 |
| 调试 | `waitForCompletion: false` 只返回 `request_id` |

---

## 5. 限制与风险

- **QQ 短视频**：时长/大小/编码（多为 MP4+H.264）；超限可能失败，注释已写在 napcat/runtime/ports；后续可改发 file 或压缩。
- **上游 URL 临时**，需尽快转发。
- **生成可达数分钟**，当前同步等待（可后续加「正在生成…」提示）。
- 未做 video edit/extend、web-panel 视频配置 UI。

---

## 6. 仍需人工确认

1. 真 xAI key 下跑通生成 + QQ 收发  
2. 实测 QQ 对时长/码率的拒绝阈值  
3. 可选：进度提示、显式命令「生视频」、面板 UI  

---

## 7. 测试数字（真实）

```
# tests 391
# pass  391
# fail  0
```

部署后务必 `npm run build` 并重启 bot，否则仍用旧 `dist/`。
