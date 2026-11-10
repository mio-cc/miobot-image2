# Box 云桌面 · MCP 工具指南（给主脑读）

> 你正通过 `mcp.box` 根工具读这份指南。下面所有「工具名」都是根工具入参 `action` 的值，工具参数放在 `params` 里，例如 `{"action": "shell", "params": {"command": "ls"}}`。参数的权威 schema 以 `action=list_actions` 返回为准；本指南讲的是选型、边界和坑。

## 0. 这是什么

box 是一台始终为你在线的 **Linux 云桌面**：Ubuntu 24.04 + XFCE，1280×800，预装 Chrome、LibreOffice 24.2（Calc/Writer/Impress）、Node 24、python3、git，联网，有免密 sudo，能装软件。它有状态、有寿命：可以休眠/唤醒、存盘、打快照。

**该用它**：需要真实运行环境（跑代码/装包/编译）、操作网页里的交互（登录后的页面、点击、填表）、操作桌面软件（LibreOffice、Thunar 等）、较长或较重的计算、需要 Linux 环境验证的东西。
**不该用它**：单纯查资料（搜索能力更快更便宜）、生成图片/文档（项目自己的生图/文件能力更好）、任何一句话能回答的问题。box 操作成本明显高于本地能力，动它之前先问自己「有没有更便宜的路」。

## 1. 黄金规则（先记住这七条）

1. **你看不到截图。** `screenshot` / `computer_state` / `computer_act` 的图片以 image 块返回，**不会回传给你**。需要视觉判断时用：`browser_snapshot`（网页结构+refs，纯文本）、`desk` 的 snapshot/outline（桌面元素树，纯文本）、或在 `script_run` 里调 `desk.ask()` / `desk.decide()` / `desk.ground()`——让 box 侧的视觉模型替你看，文本回结论。
2. **文本输出有上限。** `browser_fetch` / `browser_read` ≤ 20000 字符；`read_file` 单行 ≤ 2000 字符；`shell` 输出 > 30KB 只保留首尾。量大就分页：`read_file` 支持 `offset`/`limit`，`browser_read` 支持 `offset`，shell 里自己 `head`/`tail`/分段 grep。
3. **引用符是一次性的。** 浏览器的 `[ref=eN]`、桌面的元素 id / `ref`，在页面或窗口一旦变化即失效。**每一步操作后重新取 snapshot，不要存着旧引用复用**；这一条是绝大多数「找不到元素」错误的根源。
4. **超时是硬的。** `shell` 默认 120s（传 `timeout_s` 最大 600）；`script_run` / `gui_plan` 默认 90s（最大 110）；`box_save` 是分钟级慢操作。长任务要么分步、要么交给 `script_run` 自己轮询。
5. **重要的东西要主动持久化。** 文件写 `/workspace`（其中 `/workspace/flows` 跨 box 跟随用户）或 `/home/user`——它们跨休眠/唤醒保留。重大变更后调 `box_save` 存盘；装软件或大改前先 `box_snapshots` 留回滚点；要删 box 前必须 `box_save`。
6. **休眠态照常可用。** `box_status` 显示 `hibernated` 时，工具调用会自动唤醒 box（数秒延迟），不要因为状态而等待或重试。
7. **先轻后重。** 能 `browser_fetch`（不渲染页面）就别 `browser_navigate`；能用 `desk`/`gui_plan` 文本层就别 `computer_*` 视觉层；能用一次 `gui_plan` 跑完整流程就别逐步 `desk` 探探看。

## 2. 选型表

| 任务 | action | 关键参数 | 备注 |
|---|---|---|---|
| 跑命令 / 装软件 | `shell` | `command`, `timeout_s` | 免密 sudo；cwd 不跨调用持久 |
| 复杂多步逻辑 / 轮询 | `script_run` | `code` 或 `script`, `params` | Node24 TS；可调 desk API |
| 看目录 | `list_dir` | `path` | 相对路径在 /workspace 下 |
| 读 / 写 / 改文件 | `read_file` / `write_file` / `edit_file` | `offset`,`limit` / `old_string`,`replace_all` | edit 精确匹配唯一串 |
| 抓网页正文 | `browser_fetch` | `url` | 隐藏标签拉取，≤20000 字符 |
| 浏览器交互 | `browser_navigate` → `browser_snapshot` → `browser_click` / `browser_type` / `browser_fill` | `tab` | refs 来自最近一次 snapshot |
| 读浏览器已开页面 | `browser_read` / `browser_tabs` | `ref`, `offset` | |
| 操作桌面软件 | `gui_plan`（可保存复用）或 `desk` | `steps` / `op` | 文本元素树，无需视觉 |
| 看桌面窗口/元素 | `desk`（`op=windows`/`snapshot`/`outline`） | `window`, `pid`, `query` | 纯文本 |
| 截图（给用户看的） | `screenshot` / `computer_state` | `max_edge`, `region` | 你自己看不到图 |
| 看用 / 存盘 / 快照 | `usage` / `box_save` / `box_snapshots` | | 见 §3 |

## 3. 生命周期工具（box_* / 计费）

- `box_status` / `box_list`：查状态。可用工具调用自动唤醒，见规则 6。
- `box_ensure` / `box_wake`：主动唤醒并等到 running；`box_hibernate`：休眠，**保留内存和运行中的程序**。
- `box_save`：把文件、登录态、agent 历史存到long storage。**很慢（分钟级）**，且桌面 box 存盘时浏览器会被关闭——调用前给足超时，别在浏览器任务中途调。
- `box_snapshots` / `box_restore_paths`：快照与恢复。恢复是把快照里的**文件**复制到 `~/Restored/<保存时间>/`，路径只允许 `~` 或 `/workspace` 下；恢复不是回滚系统。
- `box_view`：返回 `view_url`——**给用户**在浏览器里看 box 实时画面的地址，需要人在旁边操作（登录/验证码）时把它交给用户。
- `box_upgrade`：升级到最新镜像，**文件/登录/历史保留，但你自己装的系统包不保证保留**；升级前务必 `box_save`。`box_delete`：删除 box（含快照），不可恢复，调前必须 `box_save` 并确认。
- `billing` / `usage`：计费与模型用量查询；它们只返回结构化 JSON（无文本），只有在项目的结构化输出补丁上线后你才看得到内容。`billing` 在无付费计划的账号上会返回 "box plans are not enabled"，这不是错误。

## 4. shell

- 命令在 `/workspace` 执行，**cwd 不跨调用持久**（每次都从 `/workspace` 开始）——需要目录上下文就写绝对路径，别指望上一次的 `cd`。
- 超时默认 120s，传 `timeout_s`（≤600）给长安装/构建；超时会重置 shell 会话。
- 免密 sudo；apt 源（Ubuntu 24.04 noble）全通；网络经 HTTP 代理，npmjs / pypi / github 都可达。
- 输出 > 30KB 只留首尾——重定向到文件再分段读，别指望一次吐完。

## 5. 文件工具

相对路径一律解析到 `/workspace`。`read_file` 带行号、可分页（`offset`/`limit`）。`edit_file` 要求 `old_string` 在文件中唯一（除非 `replace_all`）。`write_file` 全量覆盖。读写 box 外的路径用绝对路径（`/home/user`、`/tmp`）。

## 6. 浏览器（browser_*）

- **两套窗口语义**：默认所有操作发生在「agent 自己的 Chrome 窗口」；要操作用户已经打开的标签页，传 `tab`（`"active"` 或 `browser_tabs` 返回的 id）。你通常用默认即可。
- 标准回路：`browser_navigate` 打开页面（返回带 `[ref=eN]` 的结构快照）→ 需要交互时 `browser_click` / `browser_type` / `browser_fill`（fill 可填完整表单并点提交）→ 页面变化后引用全部失效，用返回的新快照或重新 `browser_snapshot`。
- `browser_fetch` 不渲染、不开标签，直接拿页面文本（≤20000 字符）——查资料首选。
- `browser_read` 读当前可见文本或单个 ref 的文本。refs 是一次性的（规则 3）。

## 7. 桌面文本层：desk 与 gui_plan

`desk` 是单 op 调用（`{"op": "snapshot", "window": "..."}`），`gui_plan` 是多步计划一次跑完。**两者都基于无障碍树（accessibility tree），纯文本，不需要视觉**——这是你操作桌面软件的主战场。

desk 常用 op：
- `windows`：顶层窗口清单（pid/id/标题/是否激活）。先调它建立地图。
- `snapshot`：某窗口的元素树（`ref`/`role`/`name`/`states`），可带 `query` 过滤；`outline` 是它的纯文本版。
- `find`：按名字/角色找元素（忽略大小写与标点）；`read`：重读单个元素（`text:true` 取全文）。
- `press`：**像用户一样按**一个元素（点可见控件、打开菜单、切 tab）；`act` 指定具体方式（click/action/select/focus）。
- `key`（如 `"ctrl+s"`）/ `type`（输入文本）/ `click`（屏幕坐标点）。
- `focus` / `close` / `launch` / `at`（坐标→元素）。
- `shot` / `screen`：截图（image 块，你看不到，可转交用户）。

gui_plan：一次提交 `steps`（每步一个 op：`app` 启动、`menu` 菜单路径、`click`、`check` 勾选、`set` 填值、`type`、`key`、`wait` 等窗口、`verify` 校验、`close`）。每步在无障碍树上解析并校验，**遇到意外就停下并上报 escalate**。成功的计划会存成 `/workspace/flows/<name>.json`（跨 box 跟随你），之后 `{"flow": "name", "params": {...}` 可以**无模型调用**复用。escalate 后：处理原因，然后**从失败步继续**（趁那个画面还在），修正后的运行会被保存。

## 8. 桌面视觉层：computer_state / computer_act / screenshot

- 用途：元素树里没有的信息（图形、位置关系），以及需要截图给人看的时候。**你自己看不到返回的图**（规则 1）。
- `computer_state`：返回窗口清单 + 前台窗口的元素树（每个元素带 `[index]` 和中心坐标，**坐标是缩放后截图的像素**，受 `max_edge` 影响）+ 一张截图。
- `computer_act`：执行一步输入（click/type/key/hotkey/scroll/drag/wait/locate…）后返回新截图。可以传 `actions` 数组一次跑多步（一步失败即停）。
- `wait` 最多 10 秒；`locate` 按无障碍名称/文本定位元素，不点击。
- 坐标系陷阱：`x,y` 必须是你**最近一次拿到的截图**里的整数像素，且受当时 `max_edge` 缩放影响；换缩放或换截图就要重新定位。

## 9. script_run 进阶（能写代码就写代码）

```ts
import * as desk from '/opt/desk/lib/desk.mts'
export const main = async (p: { path?: string } = {}) => {
  const { windows, find, press, key } = desk
  // 所有调用都是 async，记得 await
  return { ok: true }
}
```

- 传 `code`（ES module 字符串）或 `script`（box 内文件，相对 `/workspace`）；`main(params)` 的返回值就是 `result`；`console.log` 进 `logs`；设 `globalThis.$snapshot` 回传一段大纲文本。
- **脚本内 cwd 是 `/home/user`**（不是 /workspace）；runs 之间无状态。
- 超时默认 90s（最大 110）。返回含 `screenshot_path`；`screenshot: false` 可省图。
- desk API 比单 op 的 `desk` 工具更强，尤其这三个 **服务端模型** 调用：
  - `decide(state, {key: yes(q) | choice(q, options)})`：0.3s 级快速判断（概率/选项），用来做「这条路对不对」「按钮是不是 enabled」的分支。
  - `ask(prompt, png | [png])`：视觉模型看截图回答问题——**这是你「看」画面的官方途径**。
  - `ground(png, target, {width, height})`：在截图里定位被描述元素的位置，拿到坐标再配合 `computer_act` 点击。
- Linux 桌面陷阱（实战摘要）：模态对话框会卡住应用——用 `press` 点可见控件或快捷键，别盲目 `key`；应用无响应时无障碍调用 3s 超时、应用被跳过 10s，**超时的动作可能仍然生效**，先检查再重发；GTK 文件对话框要打绝对路径（`~` 不展开，第一个 Return 可能只关补全弹窗，再按一次）；LibreOffice 的对话框被读取 6~9 次后会崩——优先用快捷键、少读对话框、先存盘。

## 10. 环境与可安装性

- **预装**：Ubuntu 24.04 + XFCE 桌面、Chrome、LibreOffice 24.2、Mousepad、Thunar、Node 24（node/npm/npx）、python3（**无 pip**）、git、curl、wget、apt/dpkg。
- **资源**：2 核 / 4G 内存 / 20G 磁盘（初始仅用约 230M）。
- **装包**：`sudo apt-get install -y <包>`（noble 源全通：ffmpeg、gimp、inkscape、vim、sqlite3、python3-pip…）；全局 npm 包目录 `/opt/node` 是 root 所有，用 `sudo npm i -g` 或 `npx`；go / rust 用官方脚本装。**docker / podman 不可用**（容器内无特权）。
- **持久化边界**：磁盘文件（含 apt 装的包）跨休眠/唤醒保留；跨 `box_upgrade` 只保证文件/登录/历史，系统包不保证；box 被删除后一切清零（只能从快照恢复文件）。装了关键软件后建议 `box_save`。

## 11. 常见失败与恢复

| 现象 | 原因 | 处理 |
|---|---|---|
| `mcp_unknown_action` | action 名拼错或本服务未注册 | 看返回里的可用清单与建议 |
| `mcp_action_params_invalid` | 参数不合 schema | 以 `list_actions` 返回的 required/enum 为准 |
| `mcp_tool_error` | 上游工具自己报错（isError） | 读透传的错误文本，多数是路径不存在 / 命令失败 |
| `mcp_tool_empty_output` | 该工具只返回了结构化数据或图片，没有文本 | 项目侧已知缺口；换等价的文本层工具 |
| shell 超时 | 默认 120s | 传 `timeout_s`（≤600）或拆步 |
| browser 报「ref 无效」 | 页面变了 | 重新 `browser_snapshot` |
| desk 报 `UnknownObject` / `bad element id` | 元素消失（列表刷新、菜单关闭） | 重新 `find` / 取新 snapshot |
| `AT-SPI peer … is not responding` | 应用卡死 | 等 10s；先检查动作是否已生效再重发；必要时 `close` 重开 |

## 12. 返回值形态（你实际拿到什么）

MCP 的 `tools/call` 原始返回由 `content[]`（text 或 image 块）、`structuredContent`（JSON）、`isError` 标志组成。项目当前只把 **text 块**回传给你（带 `[mcp.box/<action>]` 前缀），**image 块被丢弃**、`structuredContent` 在结构化补丁上线前也被丢弃。实测分类：

- **纯文本**：`shell`、`list_dir`、`read_file`、`write_file`、`edit_file`、`browser_*` 全家、`desk`、`gui_plan`、`script_run`（JSON 文本）。
- **文本 + 图片**：`screenshot`、`computer_state`、`computer_act`、`script_run`（`screenshot:true`）、`gui_plan`（escalate 时）、desk 的 `shot`/`screen`。
- **只有结构化 JSON（无文本）**：`usage`、`box_list`、`box_status`、`box_ensure`、`box_view`；`box_snapshots` 是文本+结构化都有。
- 错误（`isError`）→ `mcp_tool_error` + 错误文本前 200 字符，不可重试；网络/超时异常 → 可重试失败。
