# R9 验收与 Soak 清单

本阶段目标：在不丢失 NapCat、Suno、ComfyUI、搜索、文件、记忆、TTS、审批、审计、异步任务与 ReplyPlan 的前提下，完成 AgentRuntime enforce 单 owner 的验收。

## 1. 自动化门禁

```powershell
npm test
npm --prefix web-panel run build
npm run check:r9
npm run check:r9:externals
npm run soak:r9                 # dry-run，不联网、不消耗额度
npm run soak:r9:spend           # 显式真实生成，会消耗外部额度
```

- `npm test`：全量回归，必须 0 fail。
- `web-panel build`：后台类型检查与生产构建，必须 0 error。
- `check:r9`：核心配置/持久化/外部能力配置就绪检查。
- `check:r9:externals`：要求 ComfyUI、Suno、视频三类外部能力均已配置；未配置时退出码为 1。
- `soak:r9`：默认 dry-run，仅打印外部目标与配置，不提交生成。
- `soak:r9:spend`：显式提交真实生成；必须由人工执行并承担额度。

## 2. 自动 soak

`tests/freemode-soak-r9.test.mjs`：

- 同一群 10 个用户并发，每轮 10 条消息。
- 连续 3 轮，共 30 条带 @bot 的 freeMode 请求。
- Agent enforce 下要求：
  - 30/30 `handled`
  - AgentRuntime 调用 30/30
  - 旧 BotEngine 调用 0
  - 30 条回复均回到正确用户上下文
  - 无跨用户文本串线

说明：同一用户同一时刻并发多条消息时，运行时采用 latest-wins 策略，较早消息返回 `chat-superseded`。soak 按轮次串行、轮内用户并发，符合线上防积压策略。

## 3. 真实外部能力 soak（需人工执行）

以下项目需要真实可达的网络、有效密钥与预算，CI 环境不伪造成功。

### ComfyUI

- 使用真实 ComfyUI profile 完成：
  - 图片生成 10 次
  - 图片编辑 5 次
  - 图库同步 5 次
- 记录：
  - 成功率、p50/p95 耗时
  - 重复发送数必须为 0
  - 重启恢复时外部 promptId probe 正常
  - 已完成任务不得重复计费/重复执行

### Suno

- 创建音乐 5 次，覆盖：
  - 创建成功并回调
  - 轮询完成
  - 超时/失败
- 记录：
  - 音频输出可播放
  - 重启后未完成任务只 reconcile，不重放创建
  - 重复回调查询命中幂等

### 视频

- 提交视频 3 次，覆盖 pending → done。
- 验证：
  - `probeVideo` 单次查询能返回 running/success/failed
  - `probeAttempts` 跨重启持久化
  - base64 与 URL 两种产物都能回投递
  - 不产生重复视频发送

## 4. 恢复与幂等

- 重启后检查：
  - `agent-sessions.json`
  - `agent-tool-jobs.json`
  - `orchestration-approvals.json`
  - `tool-idempotency.json`
  - `reply-preferences.json`
- 未完成外部任务只能 probe/reconcile，不能自动重放创建请求。
- `probeAttempts` 必须有上限，不能因重启无限探测。
- 审批恢复必须校验 payloadHash。

## 5. 回复与偏好

- ReplyPolicy enforce：
  - hardMaxMessages / hardMaxChars 生效
  - forcedForwardThreshold 生效
  - voice=off 不自动 TTS
  - reference=none 不带引用
- session/user preference 跨轮次/跨会话语义正确。
- 后台删除/清空偏好必须进入 audit。

## 6. 回滚

- 保持 `agent.mode=shadow` 与 `off` 可切回旧链，直到外部 soak 全部通过。
- 不在 R9 验收完成前物理删除旧 Planner/IntentRouter/FreeMode/BotEngine。
- 不修改 `/canvas-api/*`、`web-canvas/`、`apps/canvas` 的冻结契约。
