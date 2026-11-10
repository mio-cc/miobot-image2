# Box MCP 接入方案

服务：`https://mcp.box.simular.ai/mcp`（streamable HTTP + OAuth 2.1），一台可远程操作的 Linux 云桌面。
目标：让 miobot 的主脑在**成本可控、上下文不被撑爆**的前提下正确使用它。

---

## 0. 前提结论

项目已自带完整 MCP 客户端栈（`apps/bot/src/mcp-client.ts` / `mcp-server-manager.ts` / `mcp-root-tool.ts` / `mcp-oauth.ts`），且 OAuth 链路与内置 Suno 服务器同路径。**接入 = 配置 + 4 处小补丁**，不是新功能开发。本方案的事实依据见文末「实测附录」。

---

## 1. 信息三级架构（核心设计：防上下文爆炸）

| 层 | 内容 | 何时进入上下文 | 载体 |
|---|---|---|---|
| **L0 存在性提示** | 2–3 行：有一台云桌面可用、什么时候想起它 | 每轮常驻（约 150 字符成本） | `agent-host.ts` 的系统提示段 |
| **L1 简介型目录** | 根工具 description + `action=list_actions` 目录（已有，tiered 60 行） | 工具检索/选型时（自动） | 根工具描述 + 已有 `formatChildCatalog` |
| **L2 完整指南** | `docs/BOX-MCP-GUIDE.md` 全文 | **仅当模型主动 `action=guide` 时**（一次工具调用的输出） | 根工具 handler 特判 |

模型检索期只付 L0+L1 的成本；真正要用 box 时由 L1 里的提示引导它 `action=guide` 取全文。`mcpServers[].allowlist` 可进一步把冷门工具（`box_create`/`box_delete`/`box_upgrade`/`box_restore_paths`/`billing` 等）排出注册表，目录再瘦一圈。

### L0 文案（系统提示注入）

> 远程能力「box」（action 入口 `mcp.box`）：一台可远程操作的 Linux 云桌面，能跑命令/脚本、读写文件、浏览并操作网页、操作桌面软件、装软件。当任务需要真实运行环境、GUI 交互或安装依赖时用它；查资料优先用搜索。使用前 `action=list_actions` 看目录，复杂任务先 `action=guide` 读指南。

### L1 文案（根工具 description 覆写）

> Box 云桌面：可远程操作的 Linux（Ubuntu 24.04，Chrome + LibreOffice，联网，可装软件）。能力：跑 shell/脚本、读写文件、浏览器浏览与交互、桌面 GUI 自动化、截图。入口：`action`=工具名、`params`=参数。先 `list_actions` 看清单；深度使用前先 `guide` 取使用指南。注意：截图原图不会回传，视觉判断请用文本层工具或 desk 的 ask/decide？

—— 上面是草稿，落地时把 `？` 那句改为正式措辞；L1 控制在 ~300 字符内。

---

## 2. 配置（零代码部分）

```jsonc
"orchestration": {
  "mcpServers": [{
    "id": "box",
    "enabled": true,
    "transport": "http",
    "url": "https://mcp.box.simular.ai/mcp",
    "auth": "oauth",
    "allowlist": [
      "shell", "script_run", "usage",
      "list_dir", "read_file", "write_file", "edit_file",
      "browser_fetch", "browser_navigate", "browser_snapshot", "browser_click",
      "browser_type", "browser_fill", "browser_read", "browser_tabs",
      "desk", "gui_plan", "computer_state", "computer_act", "screenshot",
      "box_status", "box_save", "box_snapshots", "box_view", "box_ensure", "box_hibernate"
    ],
    "paramDefaults": { },
    "childParamDefaults": { }
  }],
  "capabilityOverrides": {
    "mcp.box":            { "enabled": true,  "riskLevel": "medium", "timeoutMs": 180000 },
    "mcp.box.shell":      { "riskLevel": "high" },
    "mcp.box.script_run": { "riskLevel": "high" },
    "mcp.box.computer_act": { "riskLevel": "high" },
    "mcp.box.box_save":   { "riskLevel": "medium", "timeoutMs": 300000 },
    "mcp.box.box_delete": { "riskLevel": "critical" },
    "mcp.box.box_upgrade":{ "riskLevel": "critical" }
  }
},
"toolRegistry": {
  "exposure": { "mcp.box": "domain" }
}
```

要点：
- `auth: "oauth"` 走项目已有的 RFC 9728→8414→7591→PKCE 链；授权在面板 `/mcp/box` 点一下完成，token 落 `data/mcp-credentials.json`（不进 config.json）。
- 根能力默认 **deny**（`enabled:false`），必须显式开 `mcp.box`；`mcp.*` 子项默认 exposure `searchable`，提级 `domain` 让它稳定进 loadout（24 工具预算内只算 1 个根工具）。
- `timeoutMs`：shell/script_run 内部已有自己的超时（120/90s），项目侧 180s 兜底；`box_save` 实测 >60s，单独给 300s。
- 高危动作（shell/script_run/computer_act）走 `high` → `ask_admin`；危险生命周周期（box_delete/upgrade，未在 allowlist 内）`critical` → 拒绝兜底。

---

## 3. 代码补丁

### ✅ 补丁 A：结构化输出兜底（已落地）
**文件**：`apps/bot/src/mcp-client.ts`（新增 `mcpContentToTexts()` 助手）、`apps/bot/src/mcp-root-tool.ts`（成功与 isError 两处消费）。
**行为**：`content` 无 text 块时，把 `structuredContent` 序列化为缩进 JSON 作为文本输出；两者皆空才判 `mcp_tool_empty_output`。
**收益**：`usage`/`box_list`/`box_status`/`box_ensure`/`box_view` 等纯结构化工具不再失败（实测它们没有 text 块）。

### ✅ 补丁 B：`action=guide` 按需递送指南（已落地）
- `packages/orchestration/src/config.ts`：`mcpServers[]` 新增 `rootDescription`（L1，≤600 字符）与 `guide`（L2，≤64KB）字段，normalizer 透传截断。
- `apps/bot/src/mcp-root-tool.ts`：`buildMcpRootDescriptor` 支持 L1 覆写（自动判断是否需追加 guide 提示）；`formatChildCatalog` 目录末尾追加 hint；`McpRootToolHandler` 特判 `action=guide`——返回 `[mcp.box/guide] <全文>`，未配置指南时回退目录（不报错）。
- `apps/bot/src/mcp-server-manager.ts`：新增 `guideResolver` 选项；`registerRoot` 组装 L1/L2；`mcpServerConfigSummary` 纳入 rootDescription 与 guide 哈希（变更即热重载重建根工具）。
- `apps/bot/src/start.ts`：注入 `resolveMcpGuide`——按 `dataDir/mcp-guides/<id>.md` → 仓库 `docs/` 顺序同步读取（后者兜底命中 `docs/BOX-MCP-GUIDE.md`）。
- **已内置 box 预设**（`BUILTIN_MCP_SERVERS`）：`https://mcp.box.simular.ai/mcp` + OAuth + L1 文案，默认停用（默认 deny 纪律），面板可见。

### ⏳ 补丁 C：截图通路（未落地，二期）
**现状**：image 块（webp）被丢弃，主脑与用户都看不到截图。
**方案**（按成本递增）：
1. （已落地，零成本）指南引导主脑用文本层 + desk `ask/decide/ground` 做视觉判断；
2. 待办：`mcp-client` 保留 image 块 → 落盘 → 上传 Canvas 图库 → 输出文本附 URL → `ReplyPlan` 发图。
**注意**：走 (2) 之前指南不承诺「截图会给用户看」（已按此口径撰写）。

### ✅ 补丁 D：L0 系统提示（已落地）
**文件**：`apps/bot/src/agent-host.ts`——导出纯函数 `buildMcpRootPromptSection(specs)`，按已注册的 `mcp.*` 根工具生成一行存在性提示，注入 `mcp-remote-hint` prompt 段；无 mcp 根工具时返回 null（零成本）。

---

## 4. 验证与灰度

**已完成的验证**：
- `node scripts/mcp-box-dry-run.mjs flow`：36/36 通过，全程 0 网络请求（globalThis.fetch 哨兵未被绕过）。覆盖 L0/L1/L2、structured 兜底、isError 结构化透传、参数校验、未知 action、image-only 已知缺口。
- `tests/mcp-box-dry-run.test.mjs`：8 个测试纳入 `npm test` 门禁。
- 全量套件 **1507/1507 通过**（含原有 1499 + 新增 8）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 离线 dry-run** | `scripts/mcp-box-dry-run.mjs flow` + 正式测试文件 | ✅ 完成 |
| **P0.5 真实只读探测** | 面板授权后 `node scripts/mcp-box-dry-run.mjs probe` 抓真实 tools/schema 与 annotations → `tests/fixtures/box-mcp-tools.json` | ⏳ 待授权 |
| **P1 只读联线** | `mcp.box` 根能力 enabled + OAuth 授权；allowlist 先只开 `browser_fetch`/`browser_read`/`list_dir`/`read_file`/`desk`/`box_status` | ⏳ 待授权 |
| **P2 写入开放** | 开 `shell`/`script_run`/`write_file`/`edit_file`（high → ask_admin） | ⏳ |
| **P3 截图闭环** | 补丁 C(2)：image → Canvas URL → QQ 回图 | ⏳ |

每个阶段的验收脚本沿用 `tests/fixtures/mcp-echo-server.mjs` 与 `capability-usability-live.mjs` 的模式（隔离 dataDir、只读白名单单写）。

---

## 5. 已知风险与未决

1. **box 工具的 `annotations` 未验证**：本机 token 加密存储，无法直接 curl `tools/list` 拿原始 annotations；`mcp_*` 的风险推断依赖它。已用 `capabilityOverrides` 显式指定 riskLevel 规避，但对接后应先抓一次真实 `tools/list` 核对。
2. **并发与配额**：box 侧并发上限未知；项目侧 `maxParallelTools:4`、每会话串行已有限流。`usage`/`billing` 在无付费计划账号上语义有限（billing 直接报 "box plans are not enabled"）。
3. **持久化语义**：apt 安装的包跨休眠保留（磁盘层），跨 `box_upgrade` 不保证；指南已按保守口径写。
4. **两层 URL**：全局 `/mcp` 路由默认 box；如未来多 box，`mcpServers[]` 可配多条指向各自 `…/mcp/cb-<id>`（box 级 URL 见实测附录）。

---

## 6. 实测附录（2026-11-09/10，box `main` / `cb-5299d1143840`）

**协议**：无 token → 401 + `WWW-Authenticate: Bearer resource_metadata=…`（RFC 9728）；AS 元数据含 authorization/token/registration 端点，S256，scopes `boxes connect`；initialize 协商 `2025-06-18`。
**环境**：Ubuntu 24.04 + XFCE 1280×800；user `user`，**免密 sudo**；Node 24（shell 里 v24.21.0，script_run 里 v24.22.0），python3 无 pip；git/curl/wget；2C/4G/20G；apt(noble)/npmjs/pypi 网络通（经 HTTP 代理）；docker 不可用；`/opt/node` root 所有（全局 npm 需 sudo）；`/workspace`、`/home/user` 跨休眠保留；`/workspace/flows` 跨 box 跟随用户。
**返回格式实测**：见 `BOX-MCP-GUIDE.md` §12 表（纯文本 / 文本+图片 / 纯结构化 三类都存在，且同族工具不一致，须逐工具对待）。
**超时实测**：`box_save` > 60s 被客户端超时掐断且未生成快照；shell 默认 120s；script_run/gui_plan 默认 90s（上限 110/110）。
**自动唤醒**：状态 `hibernated` 时 shell/list_dir/browser 等照常工作（自动唤醒，秒级延迟）；`box_hibernate` → `box_ensure` 后文件仍在。
