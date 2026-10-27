# GROK.md — Miobot / Napcat-OmniBot-v2 项目上下文

> 给 grok（或任何编码代理）的项目导航文件。读代码前先读这份，能少走很多弯路。
> 父目录 `miobot/` 是工作台根（含重构文档 `REWRITE_*.md`、`docs/`、旧 zip），**真正的代码在本目录 `Napcat-OmniBot-v2/`**。
>
> **活文档原则（2026-10-24 起）**：本文中的测试数量、阶段状态、面板结构等数字性描述可能滞后——
> 一律以 `git log`、`npm test` 实际输出和代码为准；REBUILD_STATUS.md 已过期勿引用。
> 新增/修改能力先读 `docs/CAPABILITY-SPEC.md`（能力开发规范：descriptor 字段、handler 契约、
> 交互约定、限流映射、防刷屏策略表、新增能力 checklist）。

---

## 0. 一句话定位

面向 **Napcat / QQ** 场景的**图像机器人 + Web 管理面板**项目。把后台配置、画布生成、模板库反推、Bot 消息处理、Linux 运维整合到一个 TS monorepo 里。HTTP 服务默认端口 `3018`，路径 `/admin/`（管理后台）、`/canvas/`（画布）。

---

## 1. 必知事实（任何代理第一件事）

1. **先 `npm run build` 再跑** —— 所有 TS 编译到 `dist/`，运行时（bot / web）从 `dist/` 导入，**不**直接跑 `src/`。改了 `src/` 不重新 build 不会生效。
2. **包解析靠 npm workspaces 的 symlink**：源码里写 `import ... from '@miobot-v2/shared'`，运行时由 `node_modules/@miobot-v2/*` 软链解析到各 `packages/*`，每个包的 `package.json` 的 `main` 指向 `../../dist/packages/<x>/src/index.js`。`tsconfig.json` 里的 `paths` 仅供 tsc/编辑器用。
3. **两套运行时并存（v2 新架构 + legacy 旧脚本）**：
   - `scripts/miobot-service.mjs` 是总编排，默认同时拉起 web(v2) + bot(v2)。
   - 回退：`MIOBOT_WEB_RUNTIME=legacy` 改用 `scripts/local-verify-server.mjs`；bot 旧运行时（`scripts/bot-runtime.mjs`）已随 R9/R10 旧链路删除移除，`MIOBOT_BOT_RUNTIME=legacy` 不再受支持。
   - 新架构在 `apps/` + `packages/`；旧脚本在 `scripts/*.mjs`（legacy）。
4. **配置文件位置**：`MIOBOT_CONFIG_PATH` 或 `.runtime/config.json`。Linux 默认 `/var/lib/miobot-v2/config.json`。缺省时用 `createDefaultConfig()`。
5. **绝对不要把真实密钥/Token/服务器 IP/Cookie 写进代码或提交 Git**（见根 `README.md` 安全段）。

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript（strict、ES2022、NodeNext、ESM） |
| 后端 | Node.js（原生 `node:` + `ws`），npm workspaces monorepo |
| 包管理 | npm（后端）；web-canvas 用 pnpm@9.14.2 |
| 管理面板前端 | Vue 3 + Vite 8 + Tailwind v4（`web-panel/`） |
| 画布前端 | React + Tldraw + Tailwind（`web-canvas/`，二开自 `CookSleep/gpt_image_playground`，MIT） |
| 运维 | `deploy-linux.sh` 中文一体化菜单（root-only，systemd 服务 `miobot-v2`） |
| 测试 | `node --test tests/*.test.mjs` |

---

## 3. 仓库地图

```text
Napcat-OmniBot-v2/
├── apps/                 # 装配层（把 packages 拼装成可执行服务）
│   ├── bot/src/          # Bot 运行时：start.ts / runtime.ts / app.ts / deps.ts / group-context.ts / message-enrichment.ts / tts.ts / owner.ts / image-pipeline.ts / config-bridge.ts / main.ts
│   ├── admin/src/        # 管理后台 API 装配：main.ts / adapters.ts
│   ├── canvas/src/       # 画布服务装配
│   └── panel/src/        # 面板静态资源装配
├── packages/             # 18 个核心包（见 §5）
├── scripts/              # 编排/旧运行时/验证服务
│   ├── miobot-service.mjs        # 总编排（拉起 web+bot）
│   ├── bot-runtime-v2.mjs        # 新 bot 启动器（import dist/apps/bot）
│   ├── local-verify-server-v2.mjs# 新 web 启动器
│   ├── local-verify-server.mjs  # legacy web 旧单体（bot 旧脚本已删除）
│   └── trace-canvas-generation.mjs
├── tests/                # Node 测试（*.test.mjs），数量以 npm test 实际输出为准（908+，见活文档原则）
├── web-panel/            # Vue 管理面板源码（独立 vite 工程）
├── web-canvas/           # React 画布前端（独立 pnpm 工程，自带 AGENTS.md）
├── docs/                 # DEPLOYMENT.md 等
├── deploy-linux.sh       # 一体化运维脚本
├── tsconfig.json / package.json
└── dist/                 # 编译产物（build 生成，gitignore）
```

---

## 4. 后端核心链路（v2 新架构）

一条消息从 QQ 到回复的流向：

```
Napcat (WebSocket)
  → NapcatAdapter (packages/napcat)             # 收发、断线重连、action 调用、多图合并转发
  → createBotMessageRuntime (apps/bot/src/runtime.ts)   # 消息事件循环、@bot/回复判定、群上下文拉取、引用/转发富化
  → bot-router (packages/bot-router)            # 显式命令优先；否则自由模式 fallback；群/私聊权限
  → BotEngine (packages/bot-engine)             # 自动路由：chat/生图/改图/反推
       → IntentRouter (packages/intent-router) # planner + 能力门控（基于模型实际档案）
       → 分发到 deps: chat / generateImages / editImage / interrogate
  → ModelClient (packages/model)                # OpenAI 兼容适配、方言、能力注册表、限流 TaskQueue
  → ReplyStrategy (packages/reply)              # text/单图/多图 forward/at/quote/plain 策略
  → NapcatAdapter.send(...)
```

关键文件：
- `apps/bot/src/start.ts` —— `startBot()`：装配 config → ModelClient → BotEngine → runtime → NapcatAdapter，连 WebSocket。含 owner 命令处理（切模型/TTS/黑白名单）。
- `apps/bot/src/runtime.ts` —— 消息运行时主循环（最大文件，~21KB）。
- `packages/bot-engine/src/engine.ts` —— `BotEngine.handleAuto()`（意图路由）/ `handleExplicit()`（显式命令直达）。

---

## 5. 包职责一览（`packages/*`）

| 包 | 职责 |
|---|---|
| `@miobot-v2/shared` | 跨包共享类型/常量/错误类型（`SerializableError`、`PackageDescriptor`） |
| `@miobot-v2/core` | 基础设施：错误归一化 `normalizeError`/`classifyError`、超时策略 `TimeoutPolicy`/`runWithTimeout`、重试 `RetryPolicy`/`runWithRetry`、按 `provider::model` 并发限流的 `TaskQueue`、会话记忆 `SessionStore`（轮数+字符双上限+TTL 清理） |
| `@miobot-v2/config` | **配置系统核心**（`config/src/index.ts`）：`AppConfig` 全量 schema、`DEFAULT_CONFIG`、旧→新迁移表 `CONFIG_MIGRATION_TABLE`(v1→v2)、`importConfig`/`normalizeConfig`/`exportConfig`、默认提示词模板 |
| `@miobot-v2/logger` | `createLogger` + `ConsoleLogSink`/`JsonFileLogSink`/`MemoryLogSink`，结构化日志 |
| `@miobot-v2/model` | `createModelClient`（OpenAI 兼容 LLM 适配）、`createCapabilityRegistry`（模型能力档案/覆盖）、dialects/transport/ports/client |
| `@miobot-v2/napcat` | `NapcatAdapter`：WebSocket/action 适配、action timeout、断线重连、多图合并转发去重 |
| `@miobot-v2/llm` | LLM Provider Adapter（文本/视觉/生图/改图/反推，data[].error 与多图顺序解析） |
| `@miobot-v2/image` | ImageModule：参数解析、模板替换、生图、改图、反推、timeout、upstream 错误识别 |
| `@miobot-v2/reply` | ReplyStrategyEngine：text/单图/多图 forward/at/quote/plain，去重保序，forward 失败 fallback |
| `@miobot-v2/free-mode` | FreeModeEngine：文本/生图/图文混合 planner、bang 参数覆盖、多图 planner |
| `@miobot-v2/intent-router` | 意图路由：`router.ts`(IntentRouter) / `planner.ts`(PlannerClient) / `signals.ts` / `types.ts` |
| `@miobot-v2/bot-router` | BotRouter 纯决策层：显式命令优先、自由模式 fallback、引用归属注入、群/私聊权限 |
| `@miobot-v2/bot-engine` | 自动/显式意图分发到 chat/生图/改图/反推（见 §4） |
| `@miobot-v2/storage` | `ConfigStore`(原子读写+normalize)、`json-store`、`log-store`、`canvas-state`、`debounce` |
| `@miobot-v2/web-api` | `WebApi` + `ConfigRepository`：登录、`/api/config` 读写导入导出、热重载事件、token 派生（SHA256） |
| `@miobot-v2/admin-service` | 后台服务（节点/模型/Bot/模板/画布日志/卡片管理） |
| `@miobot-v2/canvas-service` | 画布服务（assets/state/service） |
| `@miobot-v2/web-panel` | 面板相关后端装配/类型 |

---

## 6. 配置系统（最常改动的部分）

- 全量类型在 `packages/config/src/index.ts`：`AppConfig` 是根配置对象，含 `panel / napcat / promptsChat / canvas / freeMode / huggingFace / llm / bot`。
- 默认值：`DEFAULT_CONFIG`；读取时 `normalizeConfig()` 做字段补齐、越界 clamp、枚举 pick、节点索引对齐。
- **旧配置兼容**：`importConfig()` 识别旧导出格式（v1 wrapper、裸配置）并按 `CONFIG_MIGRATION_TABLE` 做字段改名/move（如 `napcat.websocketUrl→wsUrl`、`llm.nodes→apiKeys`、`bot.replyFormat→replyStrategies`）。
- 加新配置字段：在 `DEFAULT_CONFIG` 加默认值 + 在 `normalizeAppConfig()` 加 clamp/pick/merge 规则；如需旧配置迁移，在 `CONFIG_MIGRATION_TABLE` 登记。

---

## 7. Web API 表面（`packages/web-api`）

`WebApi.handle({method, path, headers, body})` 路由：
- `POST /api/login` → 密码校验（与 `panel.passwordSeed` 比较）
- 其余 `/api/*` 需 `Authorization: Bearer <token>`（token = `sha256("miobot-v2-panel:"+passwordSeed)`）
- `GET /api/config`、`POST /api/config`（热重载，返回 diff 的 `changedPaths` + `napcatReconnectRequired`）、`POST /api/config/import`、`POST /api/config/import/preview`、`GET /api/config/export`、`GET /api/auth/status`

---

## 8. 前端

- **`web-panel/`**：Vue 3 管理后台。`npm --prefix web-panel install && npm --prefix web-panel run build` → 产物在 `web-panel/dist`，由 `apps/panel` 挂载到 `/admin/`。
- **`web-canvas/`**：React+Tldraw 画布（二开自 gpt_image_playground）。用 **pnpm**：`pnpm --dir web-canvas install --no-frozen-lockfile` 然后 `pnpm --dir web-canvas build`，产物由 `apps/canvas` 挂载到 `/canvas/`。该目录已有自己的 `AGENTS.md`（含 pnpm 约定、Ralph 工作流等），改画布前端前先读它。

---

## 9. 命令速查

```bash
# 后端
npm install
npm run build                 # tsc → dist/（必须先于运行）
npm test                      # build + node --test tests/*.test.mjs
npm start                     # miobot-service：web(v2)+bot(v2)
npm run start:bot             # 仅 bot(v2)
npm run start:verify          # 仅 web(v2)
MIOBOT_WEB_RUNTIME=legacy npm start  # web 回退旧单体（bot 无 legacy）
MIOBOT_ENABLE_BOT=0 npm start         # 只起 web，不起 bot

# 前端
npm --prefix web-panel install && npm --prefix web-panel run build
pnpm --dir web-canvas install --no-frozen-lockfile && pnpm --dir web-canvas build

# Linux 运维
bash deploy-linux.sh install|git-update|rebuild|start|stop|restart|status|logs|doctor|health
```

常用环境变量：`MIOBOT_CONFIG_PATH`、`MIOBOT_RUNTIME_DIR`（默认 `.runtime`）、`MIOBOT_ENABLE_BOT`、`MIOBOT_BOT_RUNTIME`、`MIOBOT_WEB_RUNTIME`、`PORT`、`HOST`。

---

## 10. 代码约定

- 全 ESM、TypeScript strict。import 一律用 `@miobot-v2/<pkg>` 别名（不要相对路径跨包）。
- 日志统一走 `createLogger({scope, level, sinks})`，不要用裸 `console.log`（除 `scripts/miobot-service.mjs` 的编排前缀）。
- 错误用 `core` 的 `normalizeError`/`classifyError` 归一化，便于重试判定。
- 耗时外部调用套 `runWithTimeout`/`runWithRetry`；按模型并发用 `TaskQueue`。
- 会话记忆走 `SessionStore`（按 `group:<id>` / `private:<id>` 键），不要自建 Map。
- 每个 package 的 `index.ts` 是公开出口；内部实现按需拆分（如 `intent-router` 拆 `router/planner/signals/types`）。

---

## 11. 常见任务落点

| 想做的事 | 去哪 |
|---|---|
| 加一个 QQ 命令（如 `生图`/`反推`） | `config` 的 `bot.commands` 默认别名 + `apps/bot/src/runtime.ts` 的命令解析分支 + `bot-engine` 的 `handleExplicit` 分发 |
| 加一个配置项 | `config/src/index.ts` 的 `DEFAULT_CONFIG` + `normalizeAppConfig` |
| 改生图/改图/反推后端逻辑 | `packages/image` + `packages/llm` + `packages/model` |
| 改回复样式（at/forward/quote） | `packages/reply`（ReplyStrategyEngine） |
| 改意图判定（何时生图 vs 聊天 vs 视频） | `packages/intent-router`（`signals.ts`/`router.ts`/`planner.ts`）+ `packages/bot-engine`（`engine.ts` dispatch） |
| 改视频生成/收发 | model 层 `packages/model/src/client.ts` 的 `generateVideo`+`pollVideoUntilDone`、dialects；意图 `video.generate`；Napcat `sendGroupVideo`/`sendPrivateVideo`/`extractVideos`；reply `replyVideo`；配置 `llm.videoNodeIndex/videoModel/videoEnabled/videoTimeoutMs/videoPollTimeoutMs/videoPollIntervalMs` |
| 改 Napcat 收发/重连/转发 | `packages/napcat`（NapcatAdapter） |
| 改后台 API/登录 | `packages/web-api` |
| 改群聊上下文/引用/转发富化 | `apps/bot/src/group-context.ts`、`message-enrichment.ts` |
| 改画布前端 | `web-canvas/`（先读其 `AGENTS.md`） |
| 改管理后台 UI | `web-panel/src` |

---

## 12. 坑点 / 注意

- **改完必须 `npm run build`**，否则 dist 不更新，运行时跑旧代码。
- legacy web 脚本（`scripts/local-verify-server.mjs`）是旧单体；bot 旧脚本已删除，`MIOBOT_BOT_RUNTIME=legacy` 不再受支持。
- 旧项目 `C:\Users\Administrator\Desktop\GPT_Image2_napcat_bot-main\Napcat-OmniBot` 是**只读**参考，禁止修改或覆盖（见 `REWRITE_STATE.md` 的 `blocked_scope`）。
- `web-canvas` 与根工程用不同包管理器（pnpm vs npm），不要混。
- 配置 `normalize` 很严格：越界/非法值会被 clamp 或回退默认值，排查"配置没生效"先看 `normalizeAppConfig`。
- **视频已端到端打通**（model 异步轮询 `GET /videos/{id}` + intent `video.generate` + Napcat 收发 `type:video` + reply 视频策略 + 自由模式视频自动路由）。注意：grok/Imagine 视频是异步生成（默认轮询间隔 5s、总超时 10min）；QQ 对短视频有时长/大小/编码（MP4+H.264）限制；上游视频 URL 临时，需尽快转发；生成可达数分钟，目前同步等待。详见 `GROK_VIDEO_REPORT.md`。
- 测试依赖 `dist/`，跑 `npm test` 会先 `npm run build`。

---

## 13. 父目录参考文档（工作台上层）

- `miobot/REWRITE_GOAL.md`、`REWRITE_PHASES.md`、`REWRITE_STATE.md` —— 重构目标/阶段/当前状态（当前 `current_phase: done`，P0–P14 已完成）。
- `miobot/PROJECT_MANIFEST.md` —— Web 面板/画布 UI 重构计划（TASK-001 已完成，TASK-002 进行中）。
- `miobot/docs/` —— `MIGRATION_GUIDE.md`、`DEPLOYMENT.md`、`CONFIG_REFERENCE.md`、`TROUBLESHOOTING.md`。
