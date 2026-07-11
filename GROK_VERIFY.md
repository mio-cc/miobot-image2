按你的步骤，先读仓库根目录 `GROK.md`，再顺着真实源码梳理调用链和配置扩展点。接下来顺着 `NapcatAdapter` → runtime → bot-router → bot-engine → image/reply 这条链读真实源码。基于 `GROK.md` 与实际源码，结论如下。

---

## 问题1：私聊「生图 一只猫」完整调用链

入口装配在 `apps/bot/src/start.ts` 的 `startBot()`：读配置 → `createBotApp` → `NapcatAdapter` → `createBotMessageRuntime` → `runtime.attach(adapter)` → `adapter.connect()`。

### 总览

```
Napcat WebSocket 消息
  → NapcatAdapter.handleRawMessage / emit('message')
  → createBotMessageRuntime.handleMessageEvent
  → BotRouter.route → routePrivateMessage → matchExplicitCommand(genImage)
  → runCommand → BotEngine.handleExplicit('image.generate')
  → dispatch → deps.generateImages
  → ImagePromptPipeline.prepare（可选）
  → ModelClient.generateImages
  → sendResult → ReplyStrategyEngine.replyImage
  → NapcatAdapter.sendPrivateImage → send_private_msg
```

### 逐步调用链（文件 + 函数）

| 步骤 | 文件 | 关键函数 | 作用 |
|------|------|----------|------|
| 1. 收包 | `packages/napcat/src/index.ts` | `connect` → socket `on('message')` → **`handleRawMessage`** | 解析 OneBot JSON；`post_type === 'message'` 时 **`emit('message', data)`**（及 `message.private`） |
| 2. 订阅 | `apps/bot/src/runtime.ts` | **`createBotMessageRuntime` → `attach`** | `adapter.on('message', …)` → 进入 **`handleMessageEvent`** |
| 3. 入站处理 | `apps/bot/src/runtime.ts` | **`handleMessageEvent`** | 判定 `message_type === 'private'`；取 `raw_message` / segments；`sessionId = private:<userId>`；抽图 `extractImages` |
| 4. 主人命令（本例跳过） | `apps/bot/src/owner.ts` + runtime | `isOwner` / `parseOwnerCommand` | 非主人命令则继续普通路由 |
| 5. 路由配置 | `apps/bot/src/runtime.ts` | **`toRouterConfig`** | `AppConfig.bot` → `BotRouterConfig`（白名单、`commands`、freeMode/chat 开关） |
| 6. 决策 | `packages/bot-router/src/index.ts` | **`createBotRouter` → `route` → `routeBotMessage` → `routePrivateMessage`** | 私聊：白名单 → **`resolvePrivateTrigger`**（私聊恒 triggered）→ **`matchExplicitCommand`** |
| 7. 命中命令 | 同上 | **`commandNameMatch('genImage')` / `matchCommandPrefix`** | 默认别名来自 `packages/config/src/index.ts` 的 `DEFAULT_CONFIG.bot.commands.genImage`：`'生图, 画, draw'`。匹配「生图」，`args = '一只猫'`（经 `stripCommandPrefix` / 可选 `parseEnhanceMode`） |
| 8. 显式分发 | `apps/bot/src/runtime.ts` | **`runCommand`** | `decision.command === 'genImage'` → **`app.engine.handleExplicit('image.generate', input, { prompt: input.text })`**。注意：显式命令**不走** `BotApp.handle`（那是 `handleAuto`） |
| 9. 引擎 | `packages/bot-engine/src/engine.ts` | **`BotEngine.handleExplicit` → `dispatch`** | 构造 `kind: 'image.generate'` 的 decision；`case 'image.generate'` 调 **`this.deps.generateImages`**，模型用 `cfg.imageModel` |
| 10. 依赖实现 | `apps/bot/src/deps.ts` | **`createModelBackedDeps` → `generateImages`** | 先 pipeline，再调 ModelClient |
| 11. 提示词流水线 | `apps/bot/src/image-pipeline.ts` | **`createImagePromptPipeline` → `prepare`** | `applyTemplateById` / `renderPromptTemplate`（`packages/image/src/index.ts`）；若 `llm.enhanceEnabled` 可再 chat 润色 |
| 12. 上游生图 | `packages/model/src/client.ts` | **`ModelClient.generateImages`**（内部 `shapeImageGeneration` + `run('image.generate', …)`） | 按节点方言 HTTP 生图；`artifactToString` 转成可发送 URL/data URL |
| 13. 回传结果 | engine + runtime | `dispatch` 返回 `{ kind: 'image.generate', images }` → **`sendResult`** | 单图走 `replyImage`，多图 `replyImages`，纯文本 `replyText`（可 TTS） |
| 14. 回复策略 | `packages/reply/src/index.ts` | **`createReplyStrategyEngine` → `replyImage` → `replyPrivateImage`** | 私聊单图固定走 **`client.sendPrivateImage`**（不受 `replyStrategies.image` 的 forward/at 影响；那些主要是群聊） |
| 15. 发出去 | `packages/napcat/src/index.ts` | **`sendPrivateImage` → `sendAndReportResult('send_private_msg', …)` → `callAction`/`sendAction`** | OneBot：`send_private_msg` + `[{ type: 'image', data: { file } }]` |

### 装配关系（谁把谁接上）

- **`apps/bot/src/start.ts` · `startBot`**：`createBotApp` + `NapcatAdapter` + `createBotMessageRuntime({ app, reply: adapter, … })`，`runtime.attach(adapter)`。
- **`apps/bot/src/app.ts` · `createBotApp`**：`createModelBackedDeps` + `createImagePromptPipeline` + `createBotEngine`；`handle` 仅绑定 `engine.handleAuto`（自由模式/聊天用）；生图命令用的是 **`engine.handleExplicit`**。

### 本例关键中间状态

对输入「生图 一只猫」：

1. `routePrivateMessage` → `{ kind: 'command', command: 'genImage', args: '一只猫' }`
2. `handleExplicit('image.generate', …, { prompt: '一只猫' })`
3. 有图 → `sendResult` → `ReplyStrategyEngine.replyImage` → `NapcatAdapter.sendPrivateImage`

---

## 问题2：新增 `bot.maxReplyChars`（默认 1800）要改哪里？

### 先说明现状（避免重复造字段）

仓库里**已经有等价能力**，路径不是 `bot.maxReplyChars`，而是：

- **`bot.textReply.maxChars`**，默认 **1800**
- 定义：`packages/config/src/index.ts` 的 `AppConfig`、`DEFAULT_CONFIG.bot.textReply`
- 归一化：`normalizeAppConfig` 内  
  `bot.textReply.maxChars = clamp(..., 1800, 0, 20000, true)`
- 后台 UI：`web-panel/src/pages/ReplyStrategyPage.vue` 绑定 `config.bot.textReply.maxChars`
- 默认补齐：`web-panel/src/composables/usePanelStore.ts`
- **Legacy** 已消费：`scripts/bot-runtime.mjs` 的 `splitReplyText` / 分段转发
- **v2 runtime 尚未消费**：`apps/bot/src/runtime.ts` 的 `sendResult` / `ReplyStrategyEngine.replyText` **没有**读 `textReply.maxChars`

若目标只是「控制文本回复最大字符数」，更合理是：

1. 继续用 **`bot.textReply.maxChars`**
2. 在 v2 **补上消费逻辑**（不必新建 `bot.maxReplyChars`）

### 若坚持新增顶层字段 `bot.maxReplyChars`

按配置系统约定（`GROK.md` §6 / §11），最少改动如下：

| # | 文件 | 做什么 |
|---|------|--------|
| 1 | **`packages/config/src/index.ts`** | 在 `AppConfig.bot` 增加 `maxReplyChars: number`；在 `DEFAULT_CONFIG.bot` 设默认 `1800`；在 **`normalizeAppConfig`** 里 clamp（参考现有 `textReply.maxChars`）；若要兼容旧配置/别名，在 **`CONFIG_MIGRATION_TABLE`** / `importConfig` 登记（例如从 `textReply.maxChars` 迁过去，或双向同步） |
| 2 | **`apps/bot/src/runtime.ts`** | 真正生效点：在 **`sendResult`** 发文本前，或包一层对 `engine.replyText` 的调用，按 `getConfig().bot.maxReplyChars` 截断/分段（legacy 可参考 `scripts/bot-runtime.mjs` 的 `splitReplyText`） |
| 3 | **`packages/reply/src/index.ts`**（可选） | 若希望分段/限长成为通用能力，可扩展 `ReplyStrategyConfig` + `ReplyStrategyEngine.replyText`，而不是只在 runtime 里硬截 |
| 4 | **`web-panel/src/pages/ReplyStrategyPage.vue`** | 后台表单项绑定 `config.bot.maxReplyChars` |
| 5 | **`web-panel/src/composables/usePanelStore.ts`** | 读配置缺省时补 `maxReplyChars ??= 1800`（与现有 `textReply` 默认补齐同一处） |
| 6 | **测试** | `tests/config-regression.test.mjs` / `tests/config-migration.test.mjs` 覆盖默认与 clamp；如改 runtime，补 `tests/app-bot*.test.mjs` 或 reply 相关测试 |

### 一般**不必**改的层

| 层 | 原因 |
|----|------|
| `packages/storage/src/config-store.ts` 的 `ConfigStore` | 只调注入的 `normalize`，无字段白名单 |
| `packages/web-api` 的 `/api/config` | 走 `normalizeConfig`，新字段随 `AppConfig` 自动进出 |
| `packages/napcat` | 只负责发送，不关心业务限长 |
| `apps/bot/src/start.ts` / `config-bridge.ts` | 限长属于回复侧，不进模型路由切片 |

### 推荐落地方式（与现有结构对齐）

1. **不要新建** `bot.maxReplyChars`，直接用 **`bot.textReply.maxChars`**（schema / 默认值 / normalize / 面板已齐）。
2. 在 **`apps/bot/src/runtime.ts` 的 `sendResult`**（或 `packages/reply`）接入分段/截断，对齐 legacy 的 `splitReplyText` + `splitDelayMs` + `showPartPrefix`。
3. 改完后 **`npm run build`**（运行时读 `dist/`）。

---

### 小结

- **生图命令链**：`NapcatAdapter.handleRawMessage` → `runtime.handleMessageEvent` → `bot-router.routePrivateMessage` 命中 **`genImage`** → **`BotEngine.handleExplicit('image.generate')`** → **`deps.generateImages`**（pipeline + **`ModelClient.generateImages`**）→ **`sendResult` → `ReplyStrategyEngine.replyImage` → `NapcatAdapter.sendPrivateImage`**。
- **文本最大字符数**：配置侧已有 **`bot.textReply.maxChars`（默认 1800）**；v2 缺的是 runtime 消费。若硬加 `bot.maxReplyChars`，核心改 **`packages/config`** + **消费处（runtime/reply）** + **web-panel**，storage/web-api 通常不用动。
