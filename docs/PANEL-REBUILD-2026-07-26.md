# 后台面板重构 + 画布访问控制（2026-07-26）

接着 `HARDENING-2026-07-26.md`，同一分支。测试 454 → 465。

---

## 一、后台面板整体重做

`web-panel/` 下原来的实现（`composables/` + 11 个按配置分区切的页面）整体替换。
不是换皮，是换了组织方式：

**原来按「配置文件的分区」组织页面** —— LlmPage、NapcatPage、CanvasConfigPage、ReplyStrategyPage…
每个页面对应 config 的一个 key。问题是用户的问题从来不按 config 的结构提出。
「我这台机器人现在谁在干什么活」这个问题，答案散在 `llm.chatNodeIndex`、`llm.imageNodeIndex`、
`llm.videoNodeIndex`、`canvas.imageNodeIndex`、`freeMode.nodeIndex`、`bot.tts.preprocess.nodeIndex`
十几个字段里，横跨四个页面。

**现在按「用户要做的事」组织**，核心是一张能力分工表：一行一项能力，
左边是这项能力干什么、QQ 里怎么触发，右边是它用哪个节点、哪个模型、当前能不能用。
展开才是这项能力的详细参数。

### 页面

| 页面 | 回答的问题 |
|---|---|
| 总览 | 这台机器人现在好不好？ |
| **能力分工** | 谁在干什么活？哪项配错了？ |
| API 节点 | 模型从哪来？ |
| Bot 行为 | 什么时候响应、怎么回复？ |
| 语音 | 语音怎么发？ |
| 模板库 | 提示词模板 |
| 画布 | 画布前台的独立配置 |
| 运行日志 | 出问题时看什么？ |
| 系统设置 | NapCat 连接、面板密码 |

### 设计

定位是运维控制台，不是营销页。据此排除了几类东西：

- **无渐变**（已在浏览器里核对，全页 0 个 gradient）
- **无 emoji 图标** —— 尺寸不可控、跨平台字形不一。全部换成 1.4 描边的 inline SVG
- **无彩色主按钮** —— 主按钮是墨色，语义色只留四个（good/warning/serious/critical）
- **颜色不单独承载状态** —— 状态点旁边永远有文字，色盲用户同样能读
- **不外链字体** —— 面板常跑在无外网的服务器上，外链 Google Fonts 会在加载时白等一轮超时

浅色 / 深色双主题，令牌成对定义（`--page` `#f9f9f7` ↔ `#0d0d0d`，
数据系列色 `#2a78d6` ↔ `#3987e5`——深色下要提亮才够对比度，不是简单反色）。
主题按钮在「跟随系统 / 浅色 / 深色」三档循环。

### 结构

```
src/
  api/client.ts        统一注入 token、统一处理 401、统一归一化错误文案
  stores/auth.ts       会话（token 由面板密码派生）
  stores/config.ts     配置唯一数据源 + 脏标记
  stores/capabilities.ts 能力体检结果缓存
  router/index.ts      hash 路由（面板是静态托管，history 模式要后端兜底）
  components/          AppShell / ModelPicker / BarChart / SparkLine / ...
  pages/               9 个页面
```

几个刻意的决定：

- **前端不补配置默认值。** 后端 `normalizeConfig` 已经把整份配置补全了，
  前端再补一遍就是两份会各自漂移的真相。`config.ts` 里只对「模板要遍历的数组」兜底。
- **「已登录」= 有会话且配置已加载。** 拿到 token 就切界面的话，
  配置还没到手，用户看到的是一个没有内容的空壳。
- **改密码后自动换令牌。** 令牌由密码派生，保存响应里带了新的，直接换上，
  不用把刚保存完的用户踢回登录页。
- **vite outDir 直接指向 `apps/panel/static/admin`。** 少一步 rsync，
  也就少一个「构建了但线上还是旧版」的坑（`deploy-linux.sh` 已同步调整）。

### 密钥打码的往返

面板拿到的配置里密钥是打码的（`sk-•••••••1234`）。原样提交回来时后端认得出
「这一项没被改过」并保留原值。在用户真实的 12 节点配置上验证过一次完整往返：
12 个 API Key、面板密码、NapCat token、TTS Key 的哈希保存前后逐一相同，
被改的字段正常落盘。

---

## 二、画布访问控制与限流（`packages/canvas-service/src/access.ts`）

**这是本次唯一的安全性修复。**

画布前台没有登录态——它就是一个静态页面加一组 `/canvas-api/*`。
其中生图、改图、反推三条路由每次调用都真金白银打到上游。
在此之前这三条完全不设防：任何能访问这个端口的人都能消耗用户的额度。

现在：

- `canvas.access`：`public`（默认，本机自用方便）/ `local-only` / `admin`
- `canvas.rateLimitPerMinute`：默认 20，0 表示不限制
- 管理员不受限流约束——他就是额度的主人，被自己的限流挡住只会莫名其妙

两个实现上的注意点：

1. **只保护花钱的路由。** 读画廊、取资产、查任务状态一律不拦，
   否则前台刷新列表都会被限流打断。
2. **不信任 `X-Forwarded-For`。** 那个头是客户端可以随便写的，
   拿它做「仅本机可用」的判定等于没做。来源地址由传输层从 socket 取，
   写进 `x-client-ip` 后覆盖掉客户端送来的同名头。反代场景请在反代那层限制来源。

> 前台画布 UI 一行未动，这是纯后端 + 后台配置项。

---

## 三、顺带修的两处

- **能力覆盖漏了 `video.generate`**（`apps/admin/src/adapters.ts`）。
  白名单里没有它，等于覆盖功能对视频不生效——而视频模型名（Veo / CogVideoX / Vidu…）
  恰恰最没规律，是最需要手动指定能力的一类。
- **`/api/test-napcat` 只测握手。** 握手成功只说明端口通了，鉴权失败的连接同样会 open，
  随后才被服务端关掉。现在补一次 `get_login_info`，顺带把登录账号和耗时报给面板。

---

## 四、验证

- `npm test` 465 项全过（新增 canvas-access 11 项、model-multipart 11 项）
- `vue-tsc --noEmit` 无错
- 本地起 `scripts/local-verify-server-v2.mjs`，9 条路由逐个打开，控制台零报错
- `/api/config`、`/api/capabilities`、`/api/metrics`、`/api/logs`、
  `/api/default-prompts`、`/api/canvas/cards` 均 200
- 能力体检在用户真实配置上跑出 5 项不匹配（如 `gpt-5.5` 绑给文生图、
  `gpt-image-2` 绑给自由模式对话）——功能按预期工作

### 尚未验证

- **登录表单的实际点击流程。** 我没有把用户密码输入到表单里。
  `POST /api/login` 已用 curl 验证可返回可用令牌，登录竞态的修法在代码里是结构性的
  （`auth.login()` 刻意不置 `isAuthenticated`，由 App 在配置加载成功后置位），
  但「点一下登录按钮」这一步需要用户自己确认。
- 视频、语音的真实发送需要连上 NapCat 才能测；本地没有跑 NapCat。
