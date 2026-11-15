# Phase-UI 交付报告

> 项目：`D:\整理\miobot-v2\online-repo`（Web 管理面板 `online-repo/web-panel`）
> 主题：宣纸 / 松绿（**未改动配色体系**，全部走既有 token）
> 日期：2026-11-15

---

## 1. 一句话结论

原生低质量控件从 **164 个（渲染态）/ 198 个（源码态）清零**，替换为 16 个自研控件；
侧边栏改造成仿 SnowLuma 的「图标栏 + 悬停展开 + 钉住」三段式；
`vue-tsc` 零错误、`vite build` 通过、21 条路由静态核查全绿、22 项交互断言全绿。

---

## 2. 证据（可复现）

### 2.1 类型与构建

```powershell
cd D:\整理\miobot-v2\online-repo\web-panel
node node_modules\vue-tsc\bin\vue-tsc.js --noEmit -p tsconfig.app.json   # exit 0
node node_modules\vite\bin\vite.js build                                  # ✓ built
```

> 注意：本机 `node_modules\.bin\vite` 不可用（rolldown 的 win32 binding 缺失），
> 必须用 `node node_modules/vite/bin/vite.js`。构建产物输出到
> `online-repo/apps/panel/static/admin/`（该目录已 gitignore）。

### 2.2 静态核查（21 条路由 × 4 个闸门）

```powershell
$env:MIOBOT_PANEL_PASSWORD='verify-seed'
node tools\verify-ui.mjs
```

```
闸门合计: {"totalNativeControls":0,"totalConsoleErrors":0,"totalOverflow":0,"totalA11y":0,"navErrors":0}
[PASS] 原生控件 0 / 控制台错误 0 / 导航错误 0
```

闸门含义：

| 字段 | 判定 |
|---|---|
| `totalNativeControls` | 最终 DOM 里可见的原生 select/number/checkbox/radio/range 数量 |
| `totalConsoleErrors` | JS 异常与 console.error（网络 4xx/5xx 单列 `networkWarnings`，不算缺陷） |
| `totalOverflow` | 横向溢出视口的元素（浮层豁免） |
| `totalA11y` | 可交互元素缺可访问名 |
| `navErrors` | 路由打不开 / 截图失败 |

### 2.3 交互核查（22 项断言）

```powershell
$env:MIOBOT_PANEL_PASSWORD='verify-seed'
node tools\verify-interactions.mjs
```

```
合计 22 项断言，失败 0 项
[PASS] 全部交互断言通过
```

覆盖：

| 组 | 断言 |
|---|---|
| 侧栏 | 收起 64px → 悬停 248px → 移开回缩 → 钉住常驻 → 取消钉住 |
| 数字步进器 | ▲ 递增 / ▼ 回退 / ↓ 键 / 越界 clamp |
| 开关 | 点击切换 `aria-checked` |
| 滑动条 | 方向键改值 / 与数字输入联动 |
| 下拉 | 点击开面板 / Esc 关闭 / 焦点归还 |
| 分段 | 切换 `aria-selected` / 指示块位移 |
| Toast | 宿主挂载 / 导出触发 / 手动关闭 |
| 主题 | 深色切换后 body 背景变化 |

### 2.4 视觉取证

```powershell
node tools\verify-screenshots.mjs           # 21 张浅色整页
node tools\verify-screenshots.mjs --dark    # 21 张深色整页
```

输出到 `.verify/shots-full/`，共 **42 张**。整页图高度示例：
`agent` 4607px、`cap-image` 3424px、`access` 3340px、`prompts` 2838px。

> 截图脚本的关键处理：控制台的滚动发生在内层 `.main-scroll`（`overflow-y:auto`），
> 文档本身不滚动，所以直接 `fullPage:true` 只能截一屏。脚本从 `.main-scroll`
> 往上逐级解除 height/overflow 约束后再截，才拿到真正的整页。

---

## 3. 控件库（16 个，`web-panel/src/components/ui/`）

| 控件 | 作用 | 关键交互 |
|---|---|---|
| `UiNumberField` | 数字步进器（替代 `input[type=number]`） | 内部 `input[type=text][inputmode=decimal]`；上下 chevron、长按 400ms 连发并加速、`↑↓`/`Shift+↑↓`/`PageUp/Down`/`Home`/`End`、blur 时 clamp+对齐 step+固定精度、越界抖动 |
| `UiSlider` | 滑动条（替代 `input[type=range]`） | 自绘轨道+手柄、`setPointerCapture` 拖动、拖动浮出数值气泡、方向键/PageUp/Home/End、`role=slider` 全套 aria |
| `UiSwitch` | 开关（替代单项 checkbox） | `--ease-out-expo` 位移、tone 三档、`role=switch` |
| `UiCheckbox` | 复选（成组多选） | SVG 对勾描边动画、`indeterminate` 半选态 |
| `UiRadioGroup` + `UiRadio` | 带描述的互斥选择 | roving tabindex、方向键组内移动、圆点缩放入场 |
| `UiSegmented` | 分段控件 | 指示块 transform 平滑过渡、`role=tablist/tab` |
| `UiTextField` | 文本/密码/多行 | 密码眼睛 morph、clearable、maxlength 计数、autoresize 上限 400px |
| `UiFilePicker` | 文件选择（替代 `input[type=file]`） | 内部封装隐藏 input、dropzone 拖放、文件名+大小回显+移除 |
| `UiModal` | 模态 | Teleport、遮罩 blur、焦点陷阱、Esc、锁 body 滚动并补偿滚动条 |
| `UiTooltip` | 气泡提示（替代 `title=`） | Teleport + fixed 定位（不被 overflow 裁剪）、自动翻转、200ms 淡入 |
| `UiSkeleton` | 骨架占位 | 微光扫过 1.4s，`prefers-reduced-motion` 降级 |
| `UiSpinner` | 加载指示 | SVG 圆弧旋转 |
| `UiEmptyState` | 空态 | 5 种内置图标 + action 插槽 |
| `UiProgress` | 进度条 | 确定态 / 不确定态 |
| `UiToastHost` + `useToast` | 全局 toast | 右滑入、倒计时条、悬停暂停、可手动关闭、`aria-live=polite` |

另有 `ToggleField.vue` 重写为内部使用 `UiSwitch`，props/`defineModel` 契约不变。

**统一设计约束**：只用 `style.css` 的既有 token（`--accent` / `--ink*` / `--hairline*` /
`--surface*` / `--ease` / `--dur-*` / `--focus-ring` / `--sh-1|2`），**零硬编码颜色**，
深色主题自动跟随；禁止 `transition: all`；全部尊重 `prefers-reduced-motion`。

---

## 4. 侧边栏（仿 SnowLuma）

参考：`D:\整理\nc\sources\SnowLuma\packages\webui\src\components\layout\{main-layout,sidebar}.tsx`

| 机制 | 实现 |
|---|---|
| 默认收起 | 64px 图标栏（`--sidebar-w-rail`），不再是常驻 224px |
| 悬停/焦点展开 | 248px（`--sidebar-w-open`），`peeking = hovered \|\| focused` |
| **固定内层 + 外层裁剪** | 内层永远按 248px 布局，`<aside>` 只动画 `width` → 图标不位移、文字不折行，只是被 reveal/clip（丝滑关键） |
| 动画 | `width` 用 `--dur-3`(260ms) + `cubic-bezier(.4,0,.1,1)`；文字 opacity 同步 |
| 键盘焦点 | `focusin` 只在 `:focus-visible` 时 peek，避免鼠标点击导航后焦点残留卡在展开态 |
| 活动项 | 全宽胶囊（展开）↔ 居中圆角方块（收起），绝对定位 morph 不 reflow |
| 分组标题 | 收起时 `opacity:0` 保留占位（不 `display:none`，否则布局跳动） |
| 钉住 | 顶栏按钮切换，持久化 `localStorage.miobot_sidebar_pinned`；钉住后常驻展开 |
| 移动端 | ≤860px 改抽屉 + 遮罩，遮罩点击 / Esc 关闭 |
| 收起时导航名 | `UiTooltip` 右侧浮出，替代浏览器原生 `title` |

实测（`verify-interactions.mjs`）：`64 → 248 → 64 → 钉住 248 → 取消钉住 64`，全部通过。

---

## 5. 页面加载与过渡

| 项 | 实现 |
|---|---|
| 启动屏 | 品牌标记 + 呼吸微光进度条，替代原纯文字「加载中...」 |
| 路由进度 | 顶栏下沿 2px 不确定态进度条，`router.beforeEach/afterEach` 驱动，4s 兜底防挂死 |
| 路由过渡 | `<Transition name="route" mode="out-in">`：进入上浮淡入 260ms，离开上飘淡出 120ms |
| 骨架/空态 | `UiSkeleton` / `UiEmptyState` 已接入 JobsPage 等页 |
| 加载失败 | 用 `UiEmptyState` + 重试按钮，替代裸文字 |

---

## 6. 逐控件替换台账

| 类型 | 数量 | 替换为 |
|---|---|---|
| `input[type=number]` | **198** | `UiNumberField`（其中 7 处 0–1 / 0–2 归一化字段升级为 `UiSlider` + `UiNumberField` 组合） |
| `<select>` | **5** | `AppSelect`（项目已有自绘下拉，未重写） |
| `input[type=checkbox]` | **8** | `UiSwitch`（单项）/ `UiCheckbox`（成组） |
| `input[type=file]` | **1** | `UiFilePicker` |
| `input[type=range]` | 0 | — |
| `input[type=radio]` | 0 | — |

涉及文件 29 个（21 个页面 + 8 个组件）。

**数据契约零变更**：只换控件形态，`v-model` 字段路径、`@click`/`@change` 处理函数、
store 调用一字未改。`<select>` → `AppSelect` 时原 `@change` 里读
`$event.target.value` 的写法改为 `AppSelect` 的 `@change="(v) => ..."`，行为保持一致。

---

## 7. 工具链

| 脚本 | 用途 |
|---|---|
| `tools/verify-ui.mjs` | 21 路由静态闸门（原生控件/报错/溢出/a11y）+ 视口截图 |
| `tools/verify-interactions.mjs` | 22 项交互断言，带单步超时与硬看门狗 |
| `tools/verify-screenshots.mjs` | 整页截图（`--dark` 出深色），自动解除内层滚动约束 |
| `tools/codemod-number-inputs.mjs` | 198 处 number → `UiNumberField` 的保守 codemod（含 dry-run 与跳过报告） |
| `tools/patch-slider-fields.mjs` | 7 处归一化字段升级为 slider 组合 |
| `tools/serve-verify.cmd` | 隔离 runtime + 固定登录种子（`verify-seed`）的验证服务 |

---

## 8. 踩过的坑（给后续维护）

1. **PowerShell 读写源码会破坏 UTF-8 中文**。本次 `Get-Content -Raw | Set-Content -Encoding UTF8`
   把 4 个文件的中文与引号吃成 `?`。**改源码一律用 edit/write 工具或 Node `fs`（显式 utf8）**。
   已加检测方法：搜 `[\u4e00-\u9fff]\?` 与 `锛/鐨/涓` 乱码簇。
2. **`node_modules\.bin\vite` 在本机不可用**，必须 `node node_modules/vite/bin/vite.js`。
3. **整页截图要先解除内层滚动容器**，否则只有一屏。
4. **路由就绪判据不能只看 `.rail`**：它在整个 AppShell 生命周期都存在，
   切页时 `.rail` 立刻命中但路由组件还在懒加载 → 必须等该页特有的选择器。
5. **不要用「没有 password 输入框」判断是否登录页**：配置页的 API Key 字段本身就是
   `type=password`，判据永远为假。
6. 子会话在本环境不可用（4 次尝试均在启动阶段失败），本次全部由主会话直接完成。

---

## 9. Phase-UI 2（第二轮深化）

### 9.1 滚动条：滚动时出现，静止自动消失

CSS 只能做「悬停显示」，做不到「停滚 N 秒后隐藏」，所以加了
`src/utils/auto-hide-scrollbar.ts`（切 `is-scrolling` class，静止 1.2s 移除，卸载自动清理）。

- 侧栏导航：静止 1.1s 隐藏；内容区：静止 1.2s 隐藏
- 容器悬停时保持可见（用户可能想拖滚动条）
- `scrollbar-gutter: stable` + `overscroll-behavior: contain`，切页不横向跳动、滚到底不带动外层

实测（断言）：初始不可见 → 滚动中出现 → 静止后消失，三条全过。

### 9.2 控件尺寸按语义分级

**数字框（`UiNumberField`）**：新增 `width` prop，默认 `auto` ——
按 `min`/`max`/**当前值**/`placeholder` 的字符数算宽度（tabular-nums 下 1ch = 1 位数字），
最少 4 位，额外补内距与步进器。另有 `xs/sm/md/lg/fill` 五档。

> 踩坑：第一版没把「当前值」算进去，导致没声明 `max` 的字段（如超时 120000）
> 被算成 2 字符宽，末尾被裁掉。已修。

**下拉 / 单行文本**：全局默认封顶，杜绝「只显示 high 的下拉占 1200px」：

```css
input.input-field   { max-width: 320px; }
.app-select-trigger { max-width: 300px; }
/* 需要整行的用 .w-fill 或 textarea */
```

新增档位工具类 `.w-xs / .w-sm / .w-md / .w-lg / .w-xl / .w-fill`。

**数据驱动审计**：`tools/audit-control-widths.mjs` 用无头浏览器量
「实际渲染宽度 ÷ 内容需要宽度」，找出过宽控件。修复前后：

| 页面 | 修复前过宽数 | 修复后 |
|---|---|---|
| agent | 12（最大 1200px，×14.5） | 0 |
| access | 13（最大 609px） | 8（均 ≤320px） |
| reply | 14（最大 607px） | 9（均 ≤296px） |
| settings | 1 | 1（320px） |

剩下的都是 296–320px、内容约 100–140px 的表单合理余量。

### 9.3 视觉层次与配色（不用渐变）

`SectionCard` 增加 `tone` prop（accent / good / warn / crit / info / parse / plain）：

- 头部左侧 **2px 语义竖条** —— 给每组卡片一个稳定的定位色
- 头部**平涂**极淡语义色底（`color-mix`，不是渐变），把「标题区」和「表单区」分层
- 全部走既有 token，深色主题自动跟随

### 9.4 信息架构：MCP / 记忆归入能力中心

- `router/index.ts`：`/mcp` 与 `/cap-memory` **移除 meta**（不再进侧栏）
- `CapabilitiesPage`：新增**常驻**「MCP 服务器」管理卡片（原来只有未配置时才出现的虚线卡，
  已配置时无处进入管理页 = 死胡同）；移除重复的「添加 MCP 服务器」虚线卡
- 记忆/Qdrant 的常驻卡片原本就有，保留

### 9.5 导航与返回：消除死胡同

- 面包屑：`/mcp` → 能力中心 / MCP 服务器；`/mcp/:id` → 能力中心 / MCP 服务器 / 名称；
  `/cap-*`、`/search`、`/render` 全部挂回「能力中心」
- **顶栏返回按钮**：有父级层级时出现（面包屑之外的第二条退路）
- 原来 `/search`、`/render` 没有标题 → 面包屑为空 → 进去只能靠侧栏出去。
  现由 `OFF_NAV_TITLES` 兜底

### 9.6 移除山雾装饰

`decor-mist`（185KB SVG 山水）假设的是「整页长滚动、大图落在分页下方空白带」的老布局。
现在外壳是固定视口 + 内层滚动，那幅图会被裁成一大片糊在内容上的水印，
在能力中心这类留白多的页面上尤其脏。已移除挂载，保留纯 CSS 光斑 + 纸纹给纸感。

### 9.7 验证

```powershell
node tools\verify-all.mjs --ui     # 21 路由分 3 批，4 项闸门全 0
node tools\verify-all.mjs --inter  # 35 项交互断言全过
```

> `verify-all.mjs` 会在同一进程里拉起/收尾验证服务 —— 本机的后台进程在工具调用
> 边界会被回收，分次调用会拿到 `ERR_CONNECTION_REFUSED`。
> 另外 21 条路由一次跑完会让 Chromium 内存持续增长挤掉服务，所以静态核查分 3 批。

预览服务（自助启动，不随对话结束）：`web-panel\tools\start-panel-preview.cmd`

---

## 9.8 无感自动保存（Phase-UI 3）

参考 SnowLuma 的 `config-page.tsx`：`dirty` → 防抖 → `save()`，状态 `idle/saving/success/warning/error`，
成功态 3s 后自动清除。本次按同样思路改造，但补了参考项目没有的几个正确性保护。

### 行为

- 改动 → 防抖 **650ms** → 自动 POST `/config` → 热重载。无需点任何按钮。
- 顶栏不再是「保存并热重载」大按钮，而是一个**状态胶囊**：
  `保存中… / 未保存 / 已保存 / 保存冲突`，带语义色。
- 顶栏新增**自动保存开关**（持久化到 `localStorage.miobot_autosave`）。
  关闭后恢复原来的手动「保存并热重载」按钮。
- 切路由、页面转入后台（切标签/最小化）时 `flushSave()`，避免改完立刻离开丢改动。
- 增删改类操作（MCP 新建、模型节点编辑等）仍走 `save()` 立即落盘。

### 正确性保护（参考项目没有、但这里必须有）

| 风险 | 处理 |
|---|---|
| **并发保存** | `inFlight` 互斥，飞行中的改动排入 `pendingSave`，结束后补一轮；同一时刻只有一个请求 |
| **编辑期间被覆盖** | 发请求前记一份区块快照；响应回来若本地又被改过，**只吸收 revision/鉴权，不替换 config**，并补交一轮 |
| **409 版本冲突** | 先 `refreshRevision()` 对齐再重试一次（多数 409 是 revision 起点不对，不是真冲突）；仍失败才进入冲突态并**停止自动重试**，顶栏给「重试保存」 |
| **persisted:false** | 保持脏状态 + 明确报错，不显示「已保存」 |
| **敏感操作** | 导入配置覆盖、改密码等仍走显式确认与手动提交，不纳入自动保存 |

### 顺带修掉一个既有隐患

`GET /api/config` 原本**不返回 revision**，客户端 `revision` 永远是 0。
只要服务端被别的入口保存过一次（revision 变了），面板下一次保存必然 409 ——
手动保存时表现为「偶尔保存失败」，自动保存会把它放大成「一直保存冲突」。

修法：服务端支持 `GET /api/config?meta=1` 返回 `{ config, revision }`（向后兼容），
客户端 `fetchConfig` 用它取初始 revision；`applyServerConfig` 对裸 config 仍然兼容。

### 验证

```powershell
node tools\verify-all.mjs --autosave   # 9 项专项断言
node tools\verify-all.mjs --inter      # 42 项交互断言（含 5 项自动保存）
node tools\verify-all.mjs --ui         # 21 路由分 3 批
```

专项断言覆盖：改动即落盘 / 开关确实被改 / 连续改动被合并（请求数 < 改动数）/
状态胶囊显示已保存 / **飞行期间继续编辑不丢改动** / 关闭自动保存出现手动按钮 / 重新开启按钮消失。

### 验证环境自身的两个坑

1. 验证会真的 POST `/config`，服务端把规范化后的整份配置写回 `config.json`，
   包含 `panel.passwordSeed`。一旦这个文件被非 UTF-8 安全的工具碰过（PowerShell
   `Get-Content`/`Set-Content` 往返），种子变乱码 → 所有登录 401 → 表现为「整站挂掉」。
   `verify-all.mjs` 现在每轮用 Node `fs` 以 utf8 重置 runtime。
2. 长套件在 8G 机器上会把浏览器/服务挤崩，所以：静态核查分 3 批、自动保存专项独立成
   `verify-autosave.mjs`（`page.route` 延迟只设 800ms，太长会拖崩浏览器）。

### 9.9 自动保存开关的两处修正（用户反馈后）

**问题 1：关掉再打开后保存失效**

`setAutoSave(true)` 原来只调 `scheduleAutoSave()`，而 `scheduleAutoSave()` 开头有
`if (saveConflict.value) return;`。于是只要之前撞过一次 409，关掉再打开后自动保存就
**静默失效**（用户以为开了，其实一直没在存）。

修法：重新开启时先清 `saveConflict`，再 `flushSave()` 立刻把关闭期间积累的改动存掉
（而不是只排一个防抖等下一次编辑）。

**问题 2：开关是图标按钮，没有状态感和交互反馈**

原来是一个 `.btn-outline` 图标按钮，只有 `is-on` 的淡色背景差异，滑块不动、用户感知不到。
改成真正的开关控件：

```
[●——] 自动保存     ← 关：灰滑块、灰字、白底
[——●] 自动保存     ← 开：绿滑块、绿字、松绿淡底
```

- 用 `UiSwitch`（`role=switch` + `aria-checked` + Space/Enter 可操作 + 滑块 `--ease-out-expo` 动画）
- 外层胶囊：开态背景 `--accent-soft`、边框 `--accent-line`、文字 `--accent`
- 悬停有反馈；≤1240px 只留开关本体、隐藏文字（语义由 tooltip + aria 保留）

**新增回归断言（自动保存专项共 28 项）**

| 断言 | 覆盖的验收点 |
|---|---|
| 改动后无需点击即落盘 | 无感保存 |
| 连续改动被合并（请求数 < 改动数） | 防抖 |
| 飞行期间继续编辑不丢改动 | 编辑期间不丢改动 |
| 409 后进入冲突态 / 出现重试入口 / 冲突后停止自动重试 | 冲突不刷屏 |
| 手动重试后恢复为已保存 | 冲突可恢复 |
| persisted:false 时不显示「已保存」/ 仍显示未保存 | 落盘失败不骗用户 |
| 未保存时离开页面会被拦（beforeunload） | 离开保护 |
| 重新开启后立刻补存关闭期间的改动 | 开关修复 ① |
| 冲突后关掉再开启，自动保存恢复工作 | 开关修复 ② |
| 开关状态有可见变化（aria-checked 翻转） | 开关可感知 |
| 关闭/开启状态刷新后仍保持 | localStorage 持久化 |
| 导入配置前弹出确认 / 导入被取消时不自动落盘 | 敏感操作不走自动保存 |

> 顺带修了测试自身的两个坑：
> 1. 顶栏新增的自动保存开关也是 `role=switch`，而测试用 `[role=switch]').first()`
>    取「页面里的业务开关」——DOM 顺序上顶栏在前，结果点的是自动保存开关而不是业务开关。
>    选择器已限定为 `.main-scroll [role=switch]`。
> 2. `addInitScript` 每次导航都把 `miobot_autosave` 强行写回 `'1'`，会覆盖用户「关闭」
>    的持久化值，让「刷新后仍保持关闭」永远失败。改成「仅当键不存在时初始化」。

### 最终验证结果

```
vue-tsc --noEmit                exit 0
vite build                      ✓ built
静态核查（21 路由 / 3 批）        4 项闸门全 0
交互核查                        43 项断言全绿
自动保存专项                    28 项断言全绿
```

---

## 10. 未做 / 后续可做

- `UiModal`、`UiRadioGroup`+`UiRadio`、`UiTextField` 已实现但尚未在页面中大规模接入
  （当前页面没有对应的原生控件可替换，属于「能力储备」）。
  `AppShell` 的导入二次确认仍是 `window.confirm`，为保持行为一致未改动。
- 文本输入仍使用既有 `.input-field` 样式（未强制包 `UiTextField`）——
  它们不属于「原生低质量控件」，且全站数量大，贸然替换收益低于风险。
- 深色主题下个别页面的图表配色未逐一目检（截图已产出，可人工核对）。
