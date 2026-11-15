# MioBot Console — UI 精修契约（Phase-UI，权威规格）

> 项目根：`D:\整理\miobot-v2\online-repo`（**不是** `miobot-v2` 根目录）
> 改动目录：`online-repo/web-panel/`（`npm run build` 会把产物打到 `online-repo/apps/panel/static/admin/`，该目录已 gitignore）
> 参考设计：`D:\整理\nc\sources\SnowLuma\packages\webui`（React + motion，只借鉴**交互与结构**，不搬代码）

本文件是**唯一权威接口契约**。控件库实现者与页面改造者必须严格按此对接；字段/事件名偏差算缺陷。

---

## 0. 铁律（不可协商）

1. **最终渲染 DOM 中不得出现可见的原生低质量控件**：
   - `<select>` → `<UiSelect>`
   - `<input type="checkbox">` → `<UiSwitch>` / `<UiCheckbox>`
   - `<input type="number">` → `<UiNumberField>`（**198 处，本次最大债**）
   - `<input type="range">` → `<UiSlider>`
   - `<input type="file">` → `<UiFilePicker>`（组件内部封装隐藏 input）
   - `<input type="radio">` → `<UiRadioGroup>` / `<UiSegmented>`
2. `<input type="text|password">`、`<textarea>` 允许保留，但必须套在 `<UiTextField>` 内。
3. 所有可交互元素必须有：`:focus-visible` 焦点环、hover、active、disabled、过渡动画。**禁止 `transition: all`**。
4. 所有控件支持 `v-model`（Vue3 `defineModel`），`disabled` 时不触发事件。
5. 键盘可达 + ARIA 正确（Tab / Enter / Space / 方向键 / Esc / Home / End）。
6. **数据契约绝对不变**：只换控件形态，不改 `v-model` 绑定的字段路径、不改 store API、不改业务逻辑、不改 `@click`/`@change` 语义。

---

## 1. 设计令牌（`style.css :root` 已存在，只用这些）

```
--page --surface --surface-2 --ink --ink-2 --ink-3
--hairline --hairline-2 --hairline-3
--accent --accent-ink --accent-soft --accent-line
--good --good-text --good-soft --warning --warning-soft --critical --critical-soft --off --off-soft
--sh-1 --sh-2 --ease   (--ease: cubic-bezier(.22,1,.36,1))
--serif --mono --sans
```

新增令牌（**由 Lead 写入 `style.css`**，其它人只读引用，不要重复定义）：

```
--dur-1: 120ms;  --dur-2: 180ms;  --dur-3: 260ms;  --dur-4: 420ms;
--ease-out-expo: cubic-bezier(.16,1,.3,1);
--ease-swift: cubic-bezier(.4,0,.2,1);
--focus-ring: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
--focus-ring-crit: 0 0 0 3px color-mix(in srgb, var(--critical) 18%, transparent);
--sh-pop: 0 2px 6px rgba(30,28,20,.05), 0 12px 32px rgba(30,28,20,.10), 0 32px 64px rgba(30,28,20,.06);
--ctl-h-sm: 28px; --ctl-h-md: 36px; --ctl-h-lg: 44px;
```

**宣纸风格约束**：圆角 `10px`（小）/`12px`（中），边框用 `--hairline-2`，主色只用 `--accent`（松绿 `#37655a`），阴影只用 `--sh-1/--sh-2`。**不要引入新色相**。深色主题必须自动跟随（全部走 token，禁止硬编码颜色）。

---

## 2. 注册方式

控件放在 `web-panel/src/components/ui/`，由 `web-panel/src/components/ui/index.ts` 统一导出。
页面**显式 import**（项目现有约定是显式 import，不引入全局注册）：

```ts
import UiNumberField from '../components/ui/UiNumberField.vue';
```

---

## 3. 控件清单（Phase-UI 必须实现）

### 3.1 `<UiNumberField>` — **最高优先级**（198 处调用）

| prop | 类型 | 默认 |
|---|---|---|
| `modelValue` | `number \| null` | |
| `min` / `max` / `step` | `number` | `-/∞/1` |
| `precision` | `number` | `0` |
| `disabled` / `readonly` | `boolean` | `false` |
| `suffix` / `prefix` | `string` | |
| `size` | `'sm'\|'md'\|'lg'` | `'md'` |
| `align` | `'left'\|'right'` | `'left'` |
| `placeholder` | `string` | |
| `invalid` | `boolean` | `false` |

- 内部用 `<input type="text" inputmode="decimal">`，**不是** `type=number`。
- 右侧上下 chevron 步进按钮；按住 400ms 后连发（20ms/次，逐步加速）。
- `↑/↓` 步进、`Shift+↑/↓` ×10、`PageUp/PageDown` ×10。
- blur 时 clamp + 对齐 step + 固定 precision；越界时输入框抖一下（keyframes `ui-shake`）。
- 空输入 → `null`；`emit: update:modelValue(number|null)`、`change`。
- chevron 在 `disabled` 时隐藏；hover 整块高亮。

用法：
```vue
<UiNumberField v-model="draft.timeoutMs" :min="1000" :max="600000" :step="1000" suffix="ms" />
<UiNumberField v-model="draft.count" :min="1" :max="10" size="sm" align="right" />
```

### 3.2 `<UiSlider>` — 滑动条（替代裸数字输入中的"范围感"字段）

| prop | 类型 | 默认 |
|---|---|---|
| `modelValue` | `number` | |
| `min` / `max` / `step` | `number` | `0/100/1` |
| `disabled` | `boolean` | `false` |
| `showValue` | `boolean` | `false` |
| `marks` | `Array<{value:number;label?:string}>` | `[]` |
| `tone` | `'accent'\|'good'\|'warning'` | `'accent'` |

自绘轨道 + 已填充段 + 手柄（白圆 + accent 描边，hover 放大 1.15，拖动 `cursor:grabbing` + 外发光）；`pointerdown/move/up` + `setPointerCapture`；键盘方向键/Home/End/PageUp/PageDown；拖动时手柄上方浮出数值气泡。`role="slider"` + `aria-valuenow/min/max`。

### 3.3 `<UiSwitch>` — 开关

props：`modelValue:boolean`、`disabled`、`size:'sm'|'md'`、`tone`、`loading`。
滑块移动 `--ease-out-expo` 220ms；轨道 on 时渐变；`role="switch"` `aria-checked`；Space/Enter 切换。

### 3.4 `<UiCheckbox>` — 复选

props：`modelValue:boolean`、`disabled`、`indeterminate`、`tone`、`size`。slot `default` 放伴随文字。对勾用 SVG `stroke-dashoffset` 描边动画。

### 3.5 `<UiRadioGroup>` + `<UiRadio>`

`<UiRadioGroup v-model="x" :disabled="d">` 内放 `<UiRadio value="a" label="…" hint="…" />`。
选中态：accent 边框 + accent-soft 背景 + 圆点缩放入场。方向键组内移动、Space 选中；`role="radiogroup"/"radio"`。

### 3.6 `<UiSegmented>` — 分段控件

props：`modelValue`、`options:Array<{value,label,icon?}>`、`size`、`block`。
滑动指示块用 transform 平滑过渡（`--ease-out-expo` 260ms）。

### 3.7 `<UiSelect>` — 统一入口（复用现有 `AppSelect.vue`）

**不要重写**。`web-panel/src/components/AppSelect.vue` 已实现完整的自绘下拉（Teleport、模糊搜索、键盘导航、移动端抽屉）。新增的 `<select>` 一律用它：

```vue
<AppSelect v-model="draft.mode" :options="[{value:'a',label:'A'},{value:'b',label:'B'}]" />
```

若发现 AppSelect 有视觉缺陷，**只做视觉增强**（派发给 ui-kit 负责人），不改它的 props/emits。

### 3.8 `<UiTextField>`

props：`modelValue`、`type:'text'|'password'|'url'`、`textarea:boolean`、`rows`、`autoresize`、`label`、`hint`、`error`、`disabled`、`readonly`、`clearable`、`mono`、`size`、`maxlength`。
- `password` 自带眼睛切换（图标 morph）。
- `clearable` 缩放进场。
- `error` 时边框转 critical + 下方文案 + `--focus-ring-crit`。
- `autoresize` textarea 高度随内容增长（上限 400px 后滚动）。
- 有 `maxlength` 时右下角显示计数，接近上限转 warning。

### 3.9 `<UiFilePicker>`

props：`accept`、`disabled`、`label`、`hint`、`multiple`、`variant:'button'|'dropzone'`。
内部隐藏 `<input type="file">`；`dropzone` 支持拖放（drag 时边框变 accent + 图标上浮）。选中后显示文件名 + 大小 + 清除。
`emit: select(File)`、`change(FileList)`、`clear`。

**注意**：`AppShell.vue` 的 `importInput`（`ref<HTMLInputElement>` + `importInput?.click()`）必须改成 `UiFilePicker`，同时保持 `handleImportFile` 逻辑与 `window.confirm` 不变。

### 3.10 `<UiModal>`

props：`modelValue:boolean`、`title`、`description`、`size:'sm'|'md'|'lg'`、`closable`、`persistent`。
Teleport 到 body；遮罩 `backdrop-filter: blur(4px)` 淡入；内容 `translateY(8px) scale(.98)` → `0/1`，`--ease-out-expo` 300ms；`Esc` 关闭；焦点陷阱；锁 body 滚动并补偿滚动条宽度；关闭后焦点回到触发元素。
slot：`default`、`footer`。
（用于替换现有 `window.confirm` 类交互——**但要先确认没有测试依赖原 confirm**；不确定时保留 confirm，仅在新交互里用 Modal。）

### 3.11 `<UiSkeleton>`

props：`width`、`height`、`radius`、`circle`、`lines`。`linear-gradient` 微光扫过 1.4s，尊重 `prefers-reduced-motion`。

### 3.12 `<UiSpinner>`

props：`size:number=15`、`tone:'accent'|'muted'|'current'`。SVG 圆弧旋转 + `stroke-linecap:round`。

### 3.13 `<UiEmptyState>`

props：`title`、`description`、`icon`（复用 `AppIcon` 的 name）。slot `action`。淡入。

### 3.14 `<UiTooltip>`

props：`content`、`placement:'top'|'bottom'|'left'|'right'`、`delay=120`。Teleport + 箭头 + 200ms 淡入。
**用途**：替换现在大量依赖 `title=` 的解释性气泡；侧栏收起时的菜单名也用它。

### 3.15 `<UiProgress>`

props：`value:number`、`indeterminate`、`tone`。

### 3.16 `<UiToastHost>` + `useToast`（实际实现新增）

全局 toast：`UiToastHost` 在 AppShell 挂一次（Teleport 到 body，右上角堆叠）。

```ts
import { pushToast } from '../components/ui/useToast';
pushToast('配置已保存并热重载', 'good');
pushToast('导入失败：格式不合法', 'crit', { duration: 6000 });
```

`ToastTone = 'good' | 'crit' | 'warn' | 'info'`；支持 `duration`（0=不自动消失）、
`actionLabel` + `action`（单行动作）。倒计时条悬停暂停，可手动关闭，`aria-live="polite"`。

---

## 3.17 实现现状（Phase-UI 完成后）

`web-panel/src/components/ui/` 实际交付 16 个 `.vue` + `index.ts` + `useToast.ts`：

`UiNumberField` `UiSlider` `UiSwitch` `UiCheckbox` `UiRadioGroup` `UiRadio`
`UiSegmented` `UiTextField` `UiFilePicker` `UiModal` `UiSkeleton` `UiSpinner`
`UiEmptyState` `UiTooltip` `UiProgress` `UiToastHost`

另：`components/ToggleField.vue` 已重写为内部使用 `UiSwitch`，props 与
`defineModel<boolean>({required:true})` 契约不变。

已接入页面：`UiNumberField`(198 处) / `AppSelect`(5 处) / `UiSwitch` / `UiCheckbox` /
`UiFilePicker` / `UiSlider`(7 处) / `UiSegmented`(JobsPage) / `UiSkeleton`(JobsPage) /
`UiEmptyState`(App.vue + JobsPage) / `UiTooltip`(AppShell) / `UiProgress`(AppShell) /
`UiToastHost`(AppShell)。

尚未大规模接入（能力储备，页面暂无对应原生控件可替换）：`UiModal`、
`UiRadioGroup`+`UiRadio`、`UiTextField`。

详细交付说明与证据见 `PHASE-UI-REPORT.md`。

---

## 4. 侧边栏改造（仿 SnowLuma，Lead 负责）

参考 `D:\整理\nc\sources\SnowLuma\packages\webui\src\components\layout\main-layout.tsx` + `sidebar.tsx` 的**关键机制**：

1. **默认收起为图标栏（64px）**，不是现在常驻展开的 224px。
2. **悬停 / 键盘焦点临时展开**（248px）——`peeking = hovered || focused`。
   - `focusCapture` 只在 `:focus-visible` 时 peek，避免鼠标点击导航后焦点残留导致侧栏卡在展开态。
   - `blur` 时用 `!currentTarget.contains(relatedTarget)` 判断真正离开。
3. **固定宽度内层 + 外层裁剪**：内层永远按展开宽度（248px）布局，外层 `<aside>` 只动画 `width`。这样图标不位移、文字不折行，只是被 reveal/clip —— **这是丝滑的关键**。
4. **动画**：`width` 用 `--dur-3`(260ms) + `cubic-bezier(.4,0,.1,1)`；文字 `opacity` 同步过渡；`prefers-reduced-motion` 下 duration 归零。
5. **活动项指示块**：全宽胶囊（展开）↔ 居中圆角方块（收起），两者都绝对定位，morph 而不 reflow。外加左侧 2px accent 竖条（仅展开时显示）。
6. **分组标题**：收起时 `opacity:0` 并保持占位（不要 `display:none`，否则布局跳动）。
7. **钉住开关**：顶栏按钮切换 `sidebarPinned`（持久化到 localStorage），钉住后常驻展开、悬停不再收起。
8. **移动端**（≤860px）：改为 Sheet 抽屉 + 遮罩，不再显示图标栏。
9. 现有 224px 网格列必须改成动态列宽（`grid-template-columns` 随 aside 宽度走，或改用 flex）。

---

## 5. 页面改造规则

1. 页面**只允许改自己的 `.vue`** 文件（可在文件末尾加 `<style scoped>`）。
2. **不得修改**：`src/style.css`（Lead 独占）、`src/components/ui/**`、`src/components/AppShell.vue`（Lead 独占）、`src/stores/**`、`src/api/**`、`src/router/**`、`src/utils/**`。
3. 逐控件替换 §0 禁止的原生控件，`v-model` 字段路径**一字不改**。
4. 每个交互区要有 loading / empty / error 三态：提交按钮用 `<UiSpinner>`，列表加载用 `<UiSkeleton>`，空列表用 `<UiEmptyState>`。
5. 数量类字段（超时/次数/并发/阈值/长度/权重）优先 `<UiSlider>`；需精确输入时 `<UiSlider>` + `<UiNumberField>` 组合（slider 占满宽度，number 96px 在右）。
6. 长文本/提示词用 `<UiTextField textarea autoresize mono>`。
7. 布尔用 `<UiSwitch>`；成组布尔用 `<UiCheckbox>`；少量互斥用 `<UiSegmented>`；带描述互斥用 `<UiRadioGroup>`+`<UiRadio>`。
8. 保留全部 `:class` 的语义 class 名（如 `.field-box`、`.input-field`、`.btn-*`），避免破坏既有 CSS。

---

## 6. 完成定义

- 页面内不再有 §0 禁止的原生控件；
- 该页所有控件均有 hover/focus/disabled/过渡；
- 空态/加载态齐备；
- `npm run build`（含 `vue-tsc --noEmit`）**零错误**；
- 无头浏览器核查：`nativeControls` 计数为 0、`consoleErrors` 为 0、无横向溢出。

---

## 7. 验证命令（Lead 提供）

```bash
cd D:\整理\miobot-v2\online-repo\web-panel
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.app.json   # 类型
node node_modules/vite/bin/vite.js build                                # 构建 → apps/panel/static/admin
node ../web-panel/tools/verify-ui.mjs                                   # 无头浏览器核查 + 截图
```

> **Windows 注意**：`node_modules/.bin/vite` 在此环境不可用，必须用 `node node_modules/vite/bin/vite.js`。
> 服务端：`cd online-repo && MIOBOT_PORT=3018 node scripts/local-verify-server.mjs`（提供 `/admin/` 静态托管 + `/api/*`）。
