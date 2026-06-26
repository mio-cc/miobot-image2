# 重建交付状态（2026-06-25 会话）

> 本会话沙箱(Linux 构建 VM)一直无法启动,**所有新代码未经 build/test**。
> 验证方式:`cd Napcat-OmniBot-v2 && npm test`(= `tsc -p tsconfig.json` + `node --test tests/*.test.mjs`)。
> 设计原则:**纯叠加,不改动线上 `scripts/bot-runtime.mjs` 与 `scripts/local-verify-server.mjs`**——新包与旧路径并行,可分阶段切换。

## 阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | storage 仓储包 | ✅ 写完 + 测试 |
| P2 | model 多模态兼容加固 | ✅ 写完 + 测试 |
| P4 | apps/bot 装配核心 | ✅ 写完 + 测试(实时 napcat 收发环待补,需实连) |
| P5 | admin-service + apps/admin | ✅ 写完 + 测试(外部集成待 apps/admin 注入) |
| P6 | canvas-service + apps/canvas | ✅ 写完 + 测试(二进制资产层简化) |
| P7 | web-panel 组件化 | 🟡 composables 基础已落地;逐页拆分需配合构建(见 composables/P7_MIGRATION.md) |

## 新增/改动文件

**新包**
- `packages/storage/`(atomic / json-store / debounce / config-store / canvas-state / log-store)
- `packages/admin-service/`(service / logs / types)
- `packages/canvas-service/`(service / state)
- `apps/admin/`、`apps/canvas/`(薄装配入口);`apps/bot/`(config-bridge / deps / app / main 真实装配)

**model 兼容加固**
- `packages/model/src/capability/profiles.ts`(新增 DALLE2 / GROK_IMAGE / GEMINI_IMAGE 档案 + supportsSize + 规则重排)
- `packages/model/src/capability/registry.ts`(override 带 supportsSize)
- `packages/model/src/client.ts`(shapeImageGeneration/shapeImageEdit 参数规整)
- `packages/model/src/dialects/gemini.ts`(原生生图 generateContent + inlineData)
- `packages/model/src/dialects/openai.ts`、`custom.ts`(size 仅按需发)

**web-panel(P7 基础,纯叠加)**
- `web-panel/src/composables/`(useToast / useApi / useConfig / useLogs + 迁移地图)

**登记**
- `packages/shared/src/index.ts`(PackagePhase 加 P4-storage / P5-admin-service / P6-canvas-service)
- `tsconfig.json`(paths 加 storage / admin-service / canvas-service)

**新增测试**
- `tests/storage.test.mjs`、`tests/app-bot.test.mjs`、`tests/model-compat.test.mjs`、`tests/admin-service.test.mjs`、`tests/canvas-service.test.mjs`

## 已知简化 / 待补（需运行环境或实连验证）

1. **apps/bot 实时环**:napcat 连接 → bot-engine.handleAuto → reply 发送的事件循环 + `bot-runtime.mjs` 退化,需 Napcat 实连验证。
2. **admin-service 外部集成**:`fetch-models / test-napcat / test-image / huggingface / codex` 是注入接口,真实实现(Node fetch / WS / Codex CLI)待 apps/admin 提供;未注入时返回 501。
3. **canvas-service 资产层**:二进制资产存储 / 缩略图 / `/assets/:id/download` / 异步 job / SQLite 未实现,产物以内联 data URL 存。
4. **P7 逐页拆分**:见 `web-panel/src/composables/P7_MIGRATION.md`,建议配合 `npm run dev` 逐页验证。

## 多模态兼容性（应重点要求）

能力档案区分生图/多模态/纯文本,生图名优先命中;ModelClient 按档案规整参数(不支持的 size/quality/mask 剔除、count 钳上限)。覆盖:gpt-image / dall-e-3 / dall-e-2 / grok-2-image(不发 size/quality) / gemini-*-image(generateContent 原生生图) / imagen / qwen-image / flux 等;以及 grok-vision / qwen-vl 等多模态识别与 deepseek/qwen-plus 等纯文本拦截。未知模型默认宽松(可对话+多模态),可在面板覆盖。
