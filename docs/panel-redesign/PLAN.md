# 后台面板重设计方案（web-panel）

目标：在现有「宣纸」设计语言上做**结构与一致性优化**——收敛散落模块、统一配置入口、清理新旧糅杂、把视觉节奏规范化。**不做换皮、不引入渐变与装饰、不改变已有品牌色系。**

> 示例原型：[docs/panel-redesign/prototype.html](./panel-redesign/prototype.html)（独立 HTML，直接浏览器打开；用现有 token 1:1 实现）

---

## 0. 核心判断

现有面板的问题**不是颜色与风格**——「宣纸 Edition」的 token 体系（米白纸底 + 墨色文字 + 松绿主色 + 衬线标题 + 语义三态）本身克制且完整。问题集中在四层：

| 层 | 问题 | 严重度 |
|---|---|---|
| **信息架构** | 13 个一级页面塞进「配置/运行/系统」3 组，「配置」组放了 10 项；能力相关入口散落在 4 处 | 高 |
| **配置多源** | 至少 10 组开关/字段在 2–3 处可编辑，其中 2 处有实质 bug | 高 |
| **新旧糅杂** | 旧引擎面板、三套回复系统、三个能力目录视图、双套模型绑定并存 | 高 |
| **视觉方言** | 3 种表格写法、按钮/开关各 2–3 种实现、字号 6 档漂移（10.5/11/11.5/12/12.5/13.5）、`!` 覆盖遍地 | 中 |

全文路径基准：`web-panel/src/`。审计数据来自对 26 个页面文件、`style.css`（593 行）、router（241 行）、config schema（约 2400 行）的逐文件核对。

---

## 1. 信息架构重构

### 现状（13 一级页 / 3 组）

```
[未分组] 总览
配置(10): 接入与准服 · 权限与审批 · MCP服务器 · 模型与节点 · Agent与工具
          工具与权限 · 提示词注册表 · 回复与呈现 · 命令与意图 · 模板
运行(3):  能力中心 · 异步任务 · 观测中心
系统(2):  画布 · 连接与系统
```

问题：「配置」是垃圾桶（MCP 属能力、模型节点属运行拓扑、模板属提示词）；`/tools` 与 `/agent` 同义；「能力」的配置入口在 4 个不同页面；详情页（`/mcp/:id`、`/cap-*`、`/tools/:id`）在侧栏**不高亮父级**；8 条历史重定向仍占着路由表。

### 方案（11 一级页 / 5 组，按「对象」分组）

```
总览        — 总览
接入(1)     — 接入与准入
能力(3)     — 能力中心（含 MCP 服务器区） · 模型与节点 · 提示词与模板（合并 /prompts + /templates）
行为规则(4) — Agent 与工具（合并 /tools） · 权限与审批 · 回复与呈现 · 命令与意图
运行观测(2) — 异步任务 · 观测中心
系统(2)     — 画布与图库 · 系统设置
```

分组原则（与主流后台一致）：**按用户心里的「对象」而不是「技术分层」**——接入是连接，能力是「bot 会什么」，行为是「遇到消息怎么反应」，观测是只读，系统是环境。只读页（任务/观测）与交互页同组时降权为次级标题样式。

**MCP 的归属**：MCP 服务器本质是「外部能力提供方」，与内置能力/插件/HTTP 能力并列——放进**能力中心**的 `MCP 服务器` Section（服务器列表 + 状态 + 配置/授权入口），不再单占一级导航。MCP 详情页（`/mcp/:serverId`）保留为能力中心的子页（面包屑：能力中心 / MCP / box）。

### 路由级动作

| 动作 | 说明 |
|---|---|
| `/tools` 合并入 `/agent` | 全部 `toolRegistry.*` 字段唯一编辑处；`/tools` 重定向到 `/agent` |
| **MCP 并入能力中心** | `/mcp` 一级导航删除；能力中心新增「MCP 服务器」Section（列表/状态/配置/授权）。`/mcp/:serverId` 降为能力中心子页 |
| `/templates` 合并入 `/prompts` | 同一页两 tab：「提示词注册表」「用户模板」；两个后端存储不动，只合并导航 |
| `/permissions` 的「内置能力目录」section 删除 | 能力目录唯一视图在 `/capabilities` |
| `/agent` 的「审批流」卡片删除 | 审批唯一编辑处 `/permissions`（同时修掉 enum bug，见 §2） |
| `/settings` nav title 改「系统设置」 | 与 H1 一致；连接配置确实在 `/access` |
| `/reply` H1 改「回复与呈现」 | 与 nav 一致；同理 `/tools`→`/agent`、`/canvas`→「画布与图库」 |
| 侧栏 active 改前缀匹配 | `route.path.startsWith(item.path)`，详情页高亮父级 |
| 图标去重 | 现状 `grid`/`template`/`route`/`chat` 各被复用 2–3 次；每页一个唯一线性图标（原型已给出） |
| `knownPages` 映射三副本收拢 | 抽到 `web-panel/src/router/capability-routes.ts`，单源 |

### 面包屑

- 删除 `CAP_TITLES` 硬编码——给 `cap-*` 路由补 `meta.title`（代码里就能解决，不用字符串匹配）
- `/capabilities/:id`、`/tools/:id` 的 crumb 用 display name 查询而非裸 id
- `/search`、`/render` 同理补 meta，避免「只有控制台、没有当前页」

---

## 2. 配置单源化矩阵

**原则：一个字段，一个编辑处。** 其它出现的地方要么删，要么降级为只读镜像并标注「在 X 编辑」。

| 配置 | 现状多处 | 唯一归属 | 动作 |
|---|---|---|---|
| `orchestration.approval.*` | AgentPage「审批流」+ PermissionsPage「管理员审批」 | `/permissions` | 删 AgentPage 卡片 |
| **approval.fallback 枚举 bug** | AgentPage 下拉是「拒绝/允许」，schema 只接受 `deny\|cancel` | `/permissions` | 随上一条一并删除（bug 消失） |
| `approval.adminQqIds` | AccessPage（与 ownerQQs 合一写）+ AgentPage + PermissionsPage（只读） | `/access` | 删 AgentPage 独立编辑；PermissionsPage 保持只读+指引 |
| `toolRegistry.*`（maxToolsPerTurn / maxToolSchemaBytes / defaultTimeoutMs / defaultMaxConcurrency / toolSearchEnabled） | AgentPage「工具注册表」+ ToolsPage「工具加载预算」 | `/agent` | 合并 ToolsPage；ToolsPage 里那个裸 `<input type="checkbox">` 一并换成 ToggleField |
| `toolRegistry.exposure` | AgentPage 批量 + ToolDetailPage 单条 | ToolDetailPage 单条为准 | AgentPage 只保留全局开关（toolSearchEnabled）；ToolDetailPage 改走 store 保存（见 §4） |
| 生图总开关 | `llm.imageEnabled` + `features['image.generate'].enabled` + `capabilityOverrides` 三轨 | `capabilityOverrides`（能力中心） | CapImagePage 双开关删一个；store 的 `CAPABILITY_LEGACY_SWITCHES` 迁移链保留但 UI 只暴露一处 |
| 视频总开关 | `llm.videoEnabled`（LegacyEnginePanel）+ feature + override | 同上 | LegacyEnginePanel 删除后自然收敛 |
| `codeRender.enabled` | RenderPage + override | 能力中心 | RenderPage 改为只读镜像 |
| 图像模型绑定 | `llm.image*/edit*/interrogate*` + `canvas.*` 双套 | `canvas.*` | CapImagePage 的 `llm.*` 绑定降级为只读镜像（后端迁移已完成，UI 没跟上） |
| 回复策略 | `bot.replyStrategies`(v2) + `orch.reply` + `replyPolicy`(v3) 三套同页 | `replyPolicy` | v3 为主编辑区；另两套收进折叠「旧版兼容」+ 明确标注版本与生效条件（见 §3） |
| 能力目录视图 | `/capabilities` + `/tools` + PermissionsPage 内置能力目录 | `/capabilities` | 删两处 |
| 全局保存 | AppShell 顶栏 + ModelsPage「保存全部」 | 顶栏 | 删 ModelsPage 私有按钮 |
| canvas 日志设置 | ObservabilityPage 编辑 + CanvasPage 展示 | ObservabilityPage | 保持（编辑/展示分离是合理的） |

---

## 3. 新旧糅杂清理清单

| 产物 | 位置 | 判定 | 动作 |
|---|---|---|---|
| `OrchestrationPanel.vue` | AgentPage 内嵌 | **核实结果**：planner 大部分字段（规划提示词/对齐复核/置信度门）确已删，但 `planner.{nodeIndex, model, alignmentReviewMaxTokens, maxClarifications, clarificationTimeoutMs}` 仍在 schema 且被 enforce 追问与 suno 局部编辑消费；组件仍展示已删字段 | **拆解后删除组件**：已删字段的 UI 行删除；保留字段分发——`planner.nodeIndex/model` 进「模型与节点」roles 表，`maxClarifications/clarificationTimeoutMs` 进「Agent 与工具」追问参数 |
| `LegacyEnginePanel.vue` | AgentPage 内嵌 | 旧引擎参数——`freeMode`/`intentRecognition` **仍在 schema**（agent.mode=off 时生效），不是幽灵字段 | **不删，收纳**：整体降级为折叠「旧引擎兼容（agent.mode=off 时生效）」，默认折叠并标注版本 |
| 三套回复系统 | ReplyPage | v2/orch/v3 并存 | 重构为 v3 主区 + 折叠「旧版兼容（仅旧链路生效）」，折叠头写明版本 |
| `knownPages` ×3 副本 | CapabilityDetailPage / CapabilitiesPage / PermissionsPage | 同一知识三份且已漂移（10 vs 13 条） | 单源 `capability-routes.ts` |
| `ToolDetailPage` 裸 POST 保存 | `ToolDetailPage.vue:65-85` | 绕开 revision 锁的 store，存在覆盖他人改动风险 | 改走 `configStore.save()` |
| 重定向路由 ×8 | router | 历史包袱，半年以上 | 保留一个版本周期后删（低优先） |
| `wall-art.js` / `wall-trace-*.js` | `components/decor/` | AppShell 只引 `decor-mist`，其余未被引用 | 删除 |
| `FeaturesPage`「未实现」徽章 | `image.original` | 后端标记 implemented:false | 保留徽章，但挪到能力详情页而非一级开关页 |
| 后端 `local-verify-server.mjs` 2439 行 | scripts/ | 与 `apps/admin` 同功能两份 | 属后端清理，面板侧本次只确保调用的 API 两端一致（如 `/api/huggingface/models`） |

---

## 4. 缺失编辑器补齐（schema 有、UI 无）

| 字段 | 建议 |
|---|---|
| `bot.errorTriage.*` | 系统设置页新增「错误分诊」区块（原型已含） |
| `napcat` Docker 路径映射（mountOutputDir 等） | `/access` 新增——AccessPage 自己的注释已在指引「配置 Docker 路径映射」，但表单不存在 |
| `mcpServers[].allowlist` | MCP 详情页子工具区改用 allowlist 管理（替代 capabilityOverrides 混用）；capabilityOverrides 只管风险/审批 |
| `mcpServers[].rootDescription` / `guide` | MCP 详情页「工具描述」区新增（本次后端已支持，UI 未跟上） |
| `mcpServers[].toolsCacheTtlMs` | 同上，进「高级」折叠 |
| `mcpServers[].proxyUrl` | 从创建表单挪到详情页（现仅创建时可填） |
| `agent.modelOverride` | Agent 页「模型档位」新增（当前只有 ModelsPage 一句提示文本） |
| `huggingFace` 模型浏览器 | 复用已有 `/api/huggingface/models`，补 `filters.*` 浏览 UI（后端就绪） |
| `llm.sanitizeBisectEnabled` | ModelsPage sanitize 行内补开关 |

---

## 5. 视觉与节奏规范（在现有 token 上增量）

**保留**：全部颜色 token（纸/墨/松绿/语义三态/分类色）、字体三族（sans 正文 / serif 标题 / mono 标识）、`--sh-1/--sh-2` 阴影、`--ease`。**不新增任何颜色，不用渐变。**

### 5.1 配色调整（去灰：底色分层，主区白）

现状通病是「宣纸米白 + 米白卡片」对比不足，整体显灰。调整原则（参考 Codex 的亮色取向，待调研值回来后落定 hex）：

| token | 旧 | 新（Codex 取向，依据见 §9.1） |
|---|---|---|
| `--page`（主区底） | `#f6f5f1` 米白 | **纯白** `#ffffff` |
| `--surface`（卡片） | `#ffffff` | 保持白——靠 `--hairline-2` 描边与 `--sh-1` 分层 |
| `--sidebar-bg` | `#fbfaf7` 暖白 | **白** `#ffffff`（与主区同底，靠 `border-right` 分界；选中项靠描边+阴影浮起） |
| `--desk`（外壳桌面） | 隐式 | **再灰一档** `#e6e6e2`，让圆角纸页浮起 |
| `--ink/2/3` | `#21241f/#5f6459/#7d8273` | `#22241f / #595c55 / #7c7f76`（Codex 灰墨阶梯） |
| `--hairline-2` | `#e8e5dd` | `#e5e5e0`（ChatGPT 边框档） |
| 语义色 / 松绿主色 | — | **不变**（品牌色与可访问性已验证） |

分层从「米白叠米白」改为：`桌面灰 > 页白 > 卡片描边`。原型 `prototype.html` 已按此调好。

**滚动条**（项目 `style.css` 已有规则，本次做轻量化档）：`scrollbar-width: thin` + 6px 宽、透明轨道、`rgba(20,22,18,.16)` 圆角滑块、悬停才加深到 `.32`——接近隐形但不牺牲可滚动的可发现性。全局应用，暗色需把滑块色改为 `rgba(232,230,220,.2)`。

### 5.2 新增节奏 token（style.css 现缺，这是「脏」感的根源）

```css
/* 间距：4px 网格 7 档 */
--s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px;
--s-5: 20px; --s-6: 24px; --s-7: 32px; --s-8: 48px;
/* 页面 padding: --s-6；区块间距: --s-7；卡片内 padding: --s-4；字段行间距: --s-2 */

/* 字号：6 步刻度——干掉 10.5/11/11.5/12/12.5/13.5 六档漂移 */
--fs-cap: 11px;   /* tag、表头、辅助说明 */
--fs-sm: 12px;    /* 表格、次级正文、按钮 */
--fs-base: 13px;  /* 正文、表单（现 13.5 归入 13） */
--fs-sec: 14px;   /* 区块标题（衬线） */
--fs-page: 22px;  /* 页面标题（衬线） */

/* 圆角：3 档语义，禁止再出现任意值 */
--r-sm: 6px;   /* tag / chip */
--r-md: 8px;   /* 输入框 / 按钮 */
--r-lg: 10px;  /* field-box / 节点卡 */
--r-xl: 12px;  /* 卡片 / 侧栏项 */
```

### 5.3 组件方言统一

| 组件 | 规则 |
|---|---|
| 表格 | **一律 `.data-tbl`**（现成类）。删除各页手搓 `<table class="w-full text-xs">`（至少 3 种写法） |
| 按钮 | 只允许 `.btn-primary/.btn-outline/.btn-danger/.btn-quiet`（新增 quiet 档承载「体检/详情」行内动作）。禁止 Tailwind 手搓按钮与 `!` 覆盖（现状 `!px-2 !py-1 !w-auto` 数十处——说明基底类不合适，**修基底类而不是加覆盖**） |
| 开关 | 一律 `ToggleField`。删除 `ToolsPage`/`PermissionsPage`/`ModelsPage` 的裸 checkbox |
| 输入 | 一律 `.input-field`；宽度用固定档（88/120/220px）而非 arbitrary |
| 页面骨架 | `PageHead（标题+一句话定位+操作）→ Section（衬线小标题+一行说明+内容）→ rows/卡片`。每页开头一句话定位「这页管什么」（原型已含），消除「为什么这个设置在这里」的困惑 |
| 设置收纳 | 高级参数一律 `details.fold`（现成零 JS 组件）；危险操作 `.btn-danger` + 二次确认 |
| 状态表达 | 保持现有「颜色+文字+点」三件套（色盲安全），禁止只用颜色 |
| 暗色 | 合并重复 40 行的 dark 块：`@media (prefers-color-scheme: dark):root:not([data-theme="light"])` 与 `:root[data-theme="dark"]` 共用一份变量定义（用 `:where()` 或公共 class） |

### 5.4 氛围层降级

现状 aurora 漂浮光斑默认开（30s drift 动画）——这是最接近「AI 味」的元素，且 12px 模糊光斑在纸面美学里偏脏。建议：**默认关，保留开关**；`paper-grain` 极轻（opacity .05）保留。顶栏「氛围」按钮保留。

### 5.5 反「AI 味」自查清单（评审新页面时逐条过）

- [ ] 无渐变（含按钮 hover 光晕也用实色阴影）
- [ ] 无 emoji、无写实图标；线性 1.8px 描边 SVG，每页唯一
- [ ] 无居中堆叠的「大标题+副标题+两个按钮」开场
- [ ] 无紫色/蓝紫cta；只有松绿主色 + 语义三态
- [ ] 数字一律 `font-variant-numeric: tabular-nums`
- [ ] 圆角用了语义档而非随手值
- [ ] 空态有引导动作，不是一句「暂无数据」

---

## 6. 代码层整改（支撑上面的 UI）

| 项 | 现状 | 动作 |
|---|---|---|
| 保存路径 | 4 条：store（revision 锁）/ ToolDetailPage 裸 GET+POST / PromptRegistryPage POST / ObservabilityPage rollback | 全部走 store；rollback/prompt 类独立接口保留但要触发 store 失效 |
| 轮询循环 ×3 | PermissionsPage 体检、ModelsPage 延迟、McpServerPage 状态各自实现 | 抽 `composables/usePolling(fn, {interval, max})` |
| 字符串数组输入 | 各页手搓「text ref + @blur commit」≥8 处 | 抽 `StringListField.vue` |
| AppSelect 694 行 | 一半是模型浏览器 | 拆 `AppSelect`（通用下拉）+ `ModelBrowser`（浏览模式） |
| `McpServerPage` 639 / `CapImagePage` 495 | 内嵌本应是子组件的大区块（ComfyUI 配置编辑器、MCP 子工具矩阵） | 拆子组件 |
| `useToast/useApi` 等 composables | 已有但未铺开 | 全页面接入，消除各自的手写 fetch 错误处理 |

---

## 7. 迁移路线（每阶段独立可验收、可回滚）

| 阶段 | 内容 | 风险 | 验收 |
|---|---|---|---|
| **P1 结构合并（纯路由/导航）** | `/tools`→`/agent`、`/templates`→`/prompts`、侧栏 5 组、active 前缀匹配、面包屑 meta.ts 修复、图标去重 | 低（页面文件不动） | 12 个一级页可全量点达；旧 URL 重定向有效 |
| **P2 配置单源化** | §2 矩阵逐条执行；删 AgentPage 审批卡 + PermissionsPage 能力目录；CapImage 双开关收敛 | 中（涉及字段归属） | 每个开关 grep 全库只有一处编辑；`approval.fallback` bug 随之消失 |
| **P3 旧物清理** | LegacyEnginePanel / OrchestrationPanel 删除；ReplyPage 三套重构；knownPages 单源；decor 未用文件删除 | 中（需确认 schema 已删字段） | 删除后 build+test 全过；无幽灵字段展示 |
| **P4 视觉一致性** | 节奏 token 落 style.css；表格/按钮/开关/输入统一；去 `!` 覆盖；暗色块合并；氛围层默认关 | 低（纯样式） | 全库 grep 不到 `text-[1`、`!px-`、`!py-`；字号只有 6 档 |
| **P5 缺失编辑器** | §4 清单逐个补 | 低 | 每个 schema 字段都有对应 UI（写个 schema↔UI 对照测试） |
| **P6 组件抽取** | DataTable / usePolling / StringListField / AppSelect 拆分 | 中 | 逐页替换，每替一页回归 |

---

## 8. 示例原型说明

`docs/panel-redesign/prototype.html` 用**现有 token 1:1** 实现了四个代表性视图（右下角切换）：

- **总览**：stat 卡（衬线大数字 + delta 徽章）、接入状态 field-box 行、能力健康度 `.data-tbl` 表
- **能力中心**：筛选 chip + 唯一能力目录（风险等级、开关、审批标注一目了然）
- **Agent 与工具**：合并后的页面——运行参数 / 工具注册表预算（原 `/tools`）/ 已注册工具表，旧引擎参数收进折叠
- **系统设置**：新增「错误分诊」编辑器（补 schema 无 UI 的缺口）+ 配置版本表

原型刻意保持纸面、无渐变、无装饰，所有文字与导航名称与新 IA 一致——它是 P1–P4 的视觉基准。

---

## 9. 设计依据与参考

### 9.1 Codex（用户指定参考）——实测主题值

来自 `openai/codex` 仓库（`codex-rs/tui/src/ui_tree/theme.rs` 解析器 + `assets/themes/*.tmTheme` 六主题）。它只定义三个「设计系统」级槽位：**Primary = 前景色、Surface = 背景色、Accent = `codex.accent`**，其余一律是语法高亮范围。

| 主题 | 模式 | 前景 | 强调 | 注释 | diff 增/删底 |
|---|---|---|---|---|---|
| Davinci | 亮 | `#444444` | `#D75F00` 橙 | `#626262` | 透明 / `#FF5F5F` |
| Babbage | 亮 | `#444444` | `#008700` 绿 | `#626262` | `#DAFBE1` / `#FFEBE9` |
| Cushman | 亮 | `#444444` | `#0087FF` 蓝 | `#626262` | `#DAFBE1` / `#FFEBE9` |
| Ada / Curie / Dali | 暗 | `#D0D0D0` | 蓝/金 | `#808080` | `#213A2B` / `#4A221D` |

**Codex 亮色公式**：三档中性灰阶梯 + **一个**饱和强调色（六主题无一用紫/蓝紫）；颜色只出现在 diff/语义态；暗色靠 diff 底色着色而非渐变。这与宣纸的「无渐变、单品牌色、语义色配文字」完全同构。

ChatGPT 网页家族（广泛流传值，未经官方证实）：亮色背景 `#FFFFFF`、侧栏 `#F9F9F9`、文字 `#0D0D0D`、边框 `#E5E5E5`；暗色侧栏 `#171717`、背景 `#212121`、文字 `#ECECEC`、边框 `#2F2F2F`。

**我们的 token 映射**（§5.1 最终值）：

| miobot token | 取值 | 来源对照 |
|---|---|---|
| `--page` | `#ffffff` | ChatGPT 亮色背景 / Codex Surface 亮 |
| `--sidebar-bg` | `#ffffff` | 侧栏改白（用户要求）；与主区同底，靠边界线与选中浮起分层 |
| `--ink/2/3` | `#22241f / #595c55 / #7c7f76` | Codex 三档灰墨阶梯（`#444` / `#626262` / 第三档） |
| `--hairline-2` | `#e5e5e0` | ChatGPT 边框 `#E5E5E5` |
| 强调色 | 松绿 `#37655a`（不变） | Codex Babbage 绿 `#008700` 同族——单强调色公式 |
| 语义三态 | 不变 | Codex：颜色只承担语义 |

### 9.2 Ant Design 四大价值观（对后台的直接约束）

- **自然**：顺应认知习惯，降低认知与操作成本——模块按用户心理的「对象」分组（我们的五组 IA）。
- **确定性**：克制、模块化、面向对象，跨产品一致——「同一组件只有一种写法」（表格/按钮/开关单一方言）。
- **意义感**：明确目标、即时反馈——每页一句话定位 + 未保存脏标记。
- **生长性**：灵活包容——配置单源后新能力自动出现于能力中心，零代码。

其布局建议（模块化封装、间距抽象成对象）直接支持 §5.2 的 token 化与 §6 的组件抽取。

### 9.3 结论

方向与 Codex/Ant 收敛点一致：**中性灰阶梯 + 单强调色 + 颜色只作语义 + 间距排版对象化**。本次重设计不推翻品牌，只把「米白叠米白」换成「白底 + 灰阶分层」，并把散落方言收敛为单一系统。

