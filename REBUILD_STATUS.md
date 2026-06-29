# 重建交付状态

> 最近更新：2026-06-28（已实跑 build+test 核实）
> 构建验证：`cd Napcat-OmniBot-v2 && npm test`（= `tsc -p tsconfig.json` + `node --test tests/*.test.mjs`）
> 当前结果：**tsc 零错误 · 309/309 测试通过**
> 设计原则：新包与旧脚本并行，分阶段切换；bot 已默认切 v2，admin/canvas 待切。

## 阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | shared/config/logger/core/storage 内核 | ✅ 完成并通过 |
| P2 | model 多厂商兼容加固（你重点要求的） | ✅ 完成并通过 |
| P3 | napcat/reply/bot-router/image/free-mode 业务包 | ✅ 完成并通过 |
| P4 | bot-engine + apps/bot 装配 | ✅ 完成并**默认上线**（`bot-runtime-v2.mjs` 21 行薄入口→`apps/bot/start`；旧 3194 行脚本降为 `MIOBOT_BOT_RUNTIME=legacy` 备份） |
| P5 | admin-service + apps/admin | 🟡 包+入口+测试已过；**未接线**——线上 web/admin 仍由 `local-verify-server.mjs`（3231 行）承载 |
| P6 | canvas-service + apps/canvas | 🟡 包+入口+测试已过；**未接线**——线上 canvas 仍由 `local-verify-server.mjs` 承载 |
| P7 | web-panel 组件化 | 🟡 仅 composables（useToast/useApi/useConfig/useLogs）；App.vue 仍 4500 行，无 `pages/` |

## 关键架构事实

- `scripts/miobot-service.mjs` 编排：`start('web', 'scripts/local-verify-server.mjs')` + `start('bot', 'scripts/bot-runtime-v2.mjs')`。
  - **bot 走新架构**；**web/admin/canvas 仍走旧单体**。
- `local-verify-server.mjs`（3231 行）当前同时承载：web-panel/web-canvas 静态托管、`/api/*`（admin）、`/canvas-api/*`（canvas）、Codex、日志、模板转换、napcat/生图测试。
- 新包 `packages/admin-service`、`packages/canvas-service` 已实现并测试，但 `apps/admin`、`apps/canvas` 尚未被任何启动脚本拉起——P5/P6 的验收门禁（旧脚本退化为薄装配）未达成。

## 本轮已修（2026-06-28）

- **TTS 默认 model 行为改进**：`DEFAULT_CONFIG.bot.tts.model` 由 `'s2-pro'` 改为 `''`。
  - 原因：默认预填 fish-audio 专属的 `s2-pro`，使 `normalizeConfig` 与 `buildTtsRequest` 里已有的 provider 感知兜底（`fish-audio→s2-pro` / `openai-compatible→tts-1`）永远不触发；用户在面板把 provider 切到 `openai-compatible` 但未改 model 时，运行时盲发 `s2-pro` 给 OpenAI 端点 → 400。
  - 修后：默认空，由 normalize（线上加载必经）按 provider 填回 `s2-pro`/`tts-1`；`buildTtsRequest` 的 `||` 兜底同步生效。对线上零影响（线上跑 normalize）。
  - 修复了自 6/26 提交起一直红的 `tests/tts.test.mjs:25`（上一会话沙箱不可用，从未跑过）。

## 多模态兼容性（重点要求，已落地）

能力档案区分生图/多模态/纯文本，生图名优先命中；`ModelClient` 按档案规整参数（不支持的 size/quality/mask 剔除、count 钳上限）。覆盖：gpt-image / dall-e-3 / dall-e-2 / grok-2-image（不发 size/quality）/ gemini-*-image（generateContent 原生生图）/ imagen / qwen-image / flux；以及 grok-vision / qwen-vl 等多模态识别与 deepseek/qwen-plus 等纯文本拦截。未知模型默认宽松（可对话+多模态），可在面板覆盖。

## 待办（按优先级）

1. **P5 接线**：让 `local-verify-server` 的 `/api/*` 退化走 `admin-service` + `apps/admin`；逐路由回归。
2. **P6 接线**：让 `/canvas-api/*` 退化走 `canvas-service` + `apps/canvas`；画布生成/画廊/反推回归。
3. **P7 拆分**：App.vue 4500 行 → 11 页组件，逐页配合 `npm run dev` 验证（见 `web-panel/src/composables/P7_MIGRATION.md`）。

## 已知简化 / 待补（需运行环境或实连验证）

1. **apps/bot 实时环**：napcat 连接 → bot-engine.handleAuto → reply 发送的事件循环已实现（`apps/bot/src/runtime.ts`），需 Napcat 实连验证。
2. **admin-service 外部集成**：`fetch-models / test-napcat / test-image / huggingface / codex` 是注入接口，真实实现由 `apps/admin/src/adapters.ts` 提供；未注入时返回 501。
3. **canvas-service 资产层**：二进制资产存储 / 缩略图 / `/assets/:id/download` / 异步 job / SQLite 未实现，产物以内联 data URL 存。
