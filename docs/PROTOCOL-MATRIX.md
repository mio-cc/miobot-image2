# Miobot v2 消息协议、模型接口与端到端流程矩阵

> 基线：2026-10-17，仓库 `mio-cc/miobot-image2`。  
> 本文以 Napcat OneBot 11 暴露的 segment/action、Miobot 当前源码，以及 DeepSeek / Fish Audio 官方文档为准。  
> 目标：把 QQ ↔ Napcat ↔ Miobot ↔ 大模型 ↔ Napcat ↔ QQ 的完整闭环、当前支持范围、格式差异和已知缺口集中到一处。

## 1. 端到端总览

```text
QQ 用户
  │ 文本 / 图片 / 语音 / 视频 / 文件 / 引用 / 合并转发 / 表情 / 卡片
  ▼
Napcat（QQ 协议端，容器或宿主机）
  │ OneBot 11 WebSocket 正向事件
  ▼
Miobot Bot v2（apps/bot）
  ├─ 自身消息/陈旧消息过滤
  ├─ Bot 路由：私聊 / 群聊 / 白名单 / @ / 回复 Bot / 显式命令 / 自由模式
  ├─ 引用消息 get_msg 富化
  ├─ 合并转发 get_forward_msg 富化（含有限深度嵌套）
  ├─ 输入图片解析：URL / base64 / Napcat get_image → data URL
  ├─ 意图路由：显式命令、信号、自由模式 planner、普通 chat
  └─ BotEngine → ModelClient
        ▼
模型 API（OpenAI / Anthropic / Gemini / xAI / DeepSeek / GLM / Custom）
  │ 文本 / 图片理解 / 生图 / 改图 / 反推 / 视频 / TTS
  ▼
Miobot 回复编排
  ├─ 生图结果同步 Canvas 图库
  ├─ 图库资产 URL 转换
  ├─ ReplyStrategyEngine 选择 plain / at / quote / forward
  └─ NapcatAdapter 发 OneBot action
        ▼
Napcat → QQ
  文本 / 图片 / 视频 / 语音 record / 文件 / 合并转发
```

### 1.1 入站处理顺序

1. Napcat 推送 `post_type=message`。
2. `runtime.ts` 提取 `message[]` / `raw_message` / CQ 字符串。
3. 过滤 Bot 自己发送的消息、超时旧消息。
4. owner 命令优先处理。
5. 若存在 `reply` 段：调用 `get_msg` 拉取被引用消息。
6. 若存在 `forward` 段或 JSON 里的转发 ID：调用 `get_forward_msg` 展开。
7. 合并当前图、引用图、转发图；合并文本上下文。
8. BotRouter 决定 `ignored / command / freeMode / chat`。
9. 输入图片准备：本地文件通过 `get_image`，远程图片下载，最终统一为 data URL。
10. `BotEngine` 调用模型；结果包含 text / images / videos。
11. 生图/改图结果先同步 Canvas 图库，再把图库 URL 交给回复层。
12. `ReplyStrategyEngine` 选择发送方式。
13. `NapcatAdapter` 发送 action，Napcat 回 `retcode` / message_id。

### 1.2 出站回复策略

- `plain`：直接发送消息。
- `at`：群聊中先 @ 发送者。
- `quote`：引用触发消息。
- `forward`：把文本/图片/视频/文件包装成合并转发节点。
- 多图 forward 失败时：图片支持逐张降级普通发送。
- 文件发送失败：按配置重试。
- 视频超限：有 100MB 通道上限与 WS base64 安全阈值保护。

## 2. QQ / Napcat 入站消息格式矩阵

以下列表以 Napcat 当前 OneBot 11 message segment 类型为准。

| 段类型 | 含义 | Miibot 当前处理 | 说明 |
|---|---|---|---|
| `text` | 文本 | 完整支持 | 用于命令、聊天、上下文、合并转发文本 |
| `at` | @某人 / @全体 | 支持触发和清理 | BotRouter 用 `qq` 判断是否 @ Bot |
| `reply` | 引用消息 | 支持 | 调用 `get_msg`，可带出被引用消息的文字、图片、视频和转发 ID |
| `image` | 图片 | 支持 | 当前图、引用图、合并转发图均可进入视觉模型；本地 file 会调用 `get_image` |
| `mface` | 商城表情 | 部分支持 | 可能带图片引用；否则只在历史上下文显示占位 |
| `face` | QQ 原生表情 | 仅占位 | 不送模型理解 |
| `record` / `voice` | 语音消息 | 未做语音识别 | 历史上下文中显示 `[语音]`，不会自动 ASR 成文字 |
| `video` | 视频消息 | 部分支持 | 当前/引用/转发视频引用可提取，但聊天模型只看到视频引用提示，不能直接理解视频内容 |
| `file` | 文件 | 未读取内容 | 历史上下文显示 `[文件:name]`，不会下载/解析文件内容 |
| `onlinefile` | 在线文件/文件夹 | 未支持 | 当前提取链路不处理 |
| `flashtransfer` | QQ 闪传 | 未支持 | 当前提取链路不处理 |
| `forward` | 合并转发 | 支持展开 | `get_forward_msg` 后提取文本、图片、视频引用；嵌套最多继续拉取 3 层 |
| `node` | 合并转发节点 | 支持 | 作为 forward 内部节点处理；出站也可生成 node |
| `json` | JSON 卡片 / 小程序 | 部分支持 | 只尝试从中深扫合并转发 ID；卡片正文不解析 |
| `miniapp` | 小程序卡片 | 未支持 | 不解析、不送模型 |
| `xml` | XML 卡片 | 未支持 | 不解析卡片内容 |
| `markdown` | Markdown 消息 | 未支持 | 当前收发链路未使用 |
| `poke` | 戳一戳 | 未支持 | 不响应 |
| `dice` | 骰子 | 未支持 | 不响应 |
| `rps` | 猜拳 | 未支持 | 不响应 |
| `music` | 音乐分享 | 未支持 | 不解析 |
| `contact` | 名片 | 未支持 | 不解析 |
| `location` | 位置 | 未支持 | 不解析 |

> 结论：Napcat 能上报的消息类型远多于 Miobot 当前真正理解的类型。文本、图片、引用、合并转发是主链路；语音输入、文件输入、视频理解仍是缺口。
## 3. 会话与触发格式

### 3.1 私聊

- 私聊默认直接触发。
- 显式命令直接走 `handleExplicit`。
- 非命令文本：`freeMode.enabled=true` 时进入自由模式；否则 `chatEnabled=true` 时进入普通聊天。
- 私聊会话键：`private:<userId>`。

### 3.2 群聊

- 必须满足以下之一才会进入处理：
  - `@Bot`；
  - 回复 Bot（`replyToBot=true` 且回复内容有效）；
  - 命中群聊直触发命令（如帮助、清空、改图等部分命令）；
  - 白名单/黑名单允许。
- 普通群聊图片如果没有 @Bot 或回复 Bot，会被 `group-not-triggered` 忽略。
- 群会话键：`group:<groupId>:<userId>`。

### 3.3 引用消息

- 当前消息带 reply 段时，使用 get_msg 拉取引用消息。
- 引用消息中的文本作为引用上下文；图片合并进视觉输入；视频提取引用并作为文字提示；转发 ID 继续展开。
- 引用 Bot 的消息可触发回复 Bot 路径。

### 3.4 合并转发与嵌套

- forward / node 通过 get_forward_msg 展开。
- 文本按发送者与内容格式化；图片走同一输入图片管线。
- 嵌套转发最多继续拉取 3 层；JSON 卡片转发 ID 深扫上限 6。

### 3.5 会话记忆

- SessionStore 按 group:groupId:userId 或 private:userId 保存历史。
- 受轮数、字符数和 TTL 限制；带图 vision 调用不写入会话记忆。
- get_group_msg_history 是另一条短期上下文链，不替代 SessionStore。

## 4. 输入图片解析

- 提取优先级：data.url > data.file > data.path。
- data:image 或 base64：统一转 data URL。
- http(s)：下载后转 data URL。
- 本地 file/path：调用 Napcat get_image，优先 base64，其次 http/data URL。
- Napcat 建议开启 enableLocalFile2Url。
- 默认下载上限 20 MiB、超时 15 秒；失败保留原引用并告警。
- DeepSeek deepseek-flash 支持标准 image_url data URL，或不超过 8192 字符的公开 URL。

## 5. 模型能力与 API 格式

能力：chat / vision / image.generate / image.edit / interrogate / video.generate。

能力判定：用户覆盖 -> 模型名推断 -> 未识别回退纯文本。未知视觉模型需手动勾选 vision。
### OpenAI 兼容
- POST /chat/completions，messages 为 role/content。
- 视觉 content 块：text + image_url: { url: data URL }。
- 生图 /images/generations；改图 /images/edits；TTS /audio/speech。

### Anthropic Claude
- POST /v1/messages，x-api-key 与 anthropic-version。
- system 独立字段；图片为 image source base64/url。
### Gemini
- POST /v1beta/models/{model}:generateContent。
- contents[].parts[]；图片用 inlineData 或 fileData。

### xAI Grok
- 文本/视觉走 OpenAI 兼容 chat。
- 生图 /images/generations；视频 /videos/generations + 轮询。
### DeepSeek 官方
- POST https://api.deepseek.com/chat/completions。
- deepseek-flash 支持图片，标准 image_url data URL。
- 公开 URL 最长 8192 字符；请求体上限 48 MiB。

### 自定义中转
- 默认 OpenAI 形状，可覆盖路径、鉴权头、取值路径。
- 图片最好先内联为 data URL，避免上游不抓远程 URL。

## 6. 出站消息与文件格式

| 输出 | 回复层 | Napcat action |
|---|---|---|
| 文本 | replyText | send_group_msg / send_private_msg |
| 图片 | replyImage(s) | image 段，可普通或合并转发 |
| 视频 | replyVideo(s) | video 段，MP4/H.264 最稳 |
| 语音 | TTS -> record | record 段，依赖 Napcat silk 转码 |
| 文件 | replyFiles | file 段 |
| 混合 | replyMixed | 合并转发 node |
- 图片：JPEG/PNG/GIF/WebP 最稳。
- 语音：TTS 产出 mp3/wav/opus，QQ 语音通常需 silk，依赖 Napcat Native Addon。
- 视频：优先 MP4 + H.264 + AAC，注意时长/大小/码率。
- WS base64 安全阈值 8 MiB；单帧安全上限 40 MiB；视频通道约 100 MiB。
- 大文件优先 URL 或共享本地路径，不要塞 base64。

## 7. 生图入库与 URL 回传

流程：模型返回图片 -> POST /canvas-api/bot/gallery -> canvas-assets 落盘 -> 图库记录 -> 图片下载 URL -> MIOBOT_PUBLIC_BASE_URL 转绝对地址 -> Napcat 发送。
- 未配置 MIOBOT_PUBLIC_BASE_URL：仍入库，但回复回退原 base64。
- Napcat 容器可用 host.docker.internal + extra_hosts: host-gateway。
- 图库同步失败不会阻断 QQ 回复；会回退原图。

## 8. 语音 / TTS

### Fish Audio
- POST https://api.fish.audio/v1/tts。
- 模型 ID 放在 HTTP 请求头 model，不在 JSON body。
- s2.1-pro-free 官方文档为 2026-11-30 前免费。
- 空白模型现在默认 s2.1-pro-free；主音色失败会尝试 voiceIds 备用音色。
- 日志 TTS request 会记录实际 model / modelHeader，可直接核对 Fish 后台账单。
- 若日志 model=s2.1-pro-free 但后台收费，核对账单行的模型 ID；免费模型也可能记录调用量但金额应为 0。
- 语音发送依赖 Napcat 将音频转成 QQ 可播放格式；失败会回退文本。

### 语音输入
- 当前没有 STT：QQ 语音只在历史上下文显示占位，不会自动转文字。
- 需要新增 Napcat 语音下载 + ASR + 文本注入链路。

## 8.5 文件输入与文件生成

### 文件输入

- 文件消息到达时只登记 `message_id / file_id / name / size / mime`，不主动下载。
- 用户引用文件消息发送「读取文件」、同条消息带文件发命令，或发送「读取文件 Fxxxxx」时才下载。
- 索引持久化在 `MIOBOT_RUNTIME_DIR/pending-files.json`，默认保留 24 小时。
- 小于 8 MiB 走 `get_file`；大文件优先 `download_file_stream`，失败回退 `get_file`。
- 支持：
  - txt/md/csv/tsv/json/jsonl/yaml/yml/xml/log/源码：文本读取，GB18030 回退。
  - PDF：pdfjs-dist 提取文本，限制页数。
  - DOCX：OOXML 正文/表格文本。
  - XLSX：sharedStrings + 工作表行，输出 Markdown 表格。
  - PPTX：按 slide 顺序提取文本。
  - ZIP：文件树 + 小型文本文件读取。
  - APK：app-info-parser 解析包名、版本、权限、Activity，并列出 ZIP 条目；不执行、不反编译。
- 解析上限由 `bot.files.*` 配置，默认单文件 20 MiB、提取文本 100k 字符、压缩包解压 50 MiB。
- 文件解析在单任务队列中执行，避免 1C2G 机器被多文件并发拖垮。

### 文件生成

- 自然语言主路由：能力分工里的「自然语言意图识别」模型读取当前启用功能清单，把普通语言映射到 chat/help/clear/file.list/file.read/file.generate/search.web/image.*/video.generate/template.library；模型输出 intent、args、fileType、confidence，后端校验后分发。
- 意图模型不可用、超时、返回非法 JSON 或置信度不足时，回退到文件/文件读取正则，再回退到原 FreeMode planner；显式命令始终优先且不经过意图模型。
- 自然语言文件生成：文件生成只是 file.generate 意图之一，模型可以直接识别用户要生成 Word/Markdown/Excel/PPT/PDF 等文件，不要求用户知道命令别名。
- 用户使用「生成文件 / 生成文档 / 导出文件」命令，例如：
  - `生成文件 一份 Word 周报`
  - `生成文件 一个 Excel 销售表`
  - `生成文件 一份 PPT 项目汇报`
- 模型只输出结构化 JSON，本地渲染器负责生成真实文件，避免要求聊天模型返回 Office 二进制。
- 支持 txt/md/json/csv/docx/xlsx/pptx/pdf/zip。
- 指定格式：可以在自然语言里带扩展名或格式名，例如 `生成一份 Markdown 介绍文档`、`生成一个 Word 周报`、`生成一份 Excel 表格`、`生成一份 PPT 汇报`、`生成 PDF 报告`、`生成一个 zip 压缩包`。
- 未明确格式时的默认规则：提到 Word/文档 -> docx，提到 Excel/表格 -> xlsx，提到 PPT/幻灯片 -> pptx，提到 md/Markdown 优先 md，其余默认 txt。
- DOCX 不再使用固定单一排版。模型会输出 `style` 和结构化 `sections`，支持：
  - 主题：business / modern / academic / minimal / report / tech
  - 封面、标题、副标题、作者、日期
  - 字体、主题色、正文字号、行距、页边距
  - 页眉、页脚、页码
  - 章节、正文、项目符号、表格、提示框
  - 模型会根据内容类型选择版式和主题；模型没给 style 时使用 business 默认样式。
- 生成后上传到 Canvas 的 `/canvas-api/bot/files`，Napcat 通过公开 URL 以 file 段发送。
- APK 只支持输入分析，不支持从自然语言直接构建可安装 APK。

## 9. 已知缺口

| 项目 | 现状 | 建议 |
|---|---|---|
| QQ 语音输入 | 不支持 ASR | 增加 voice 下载与 STT 节点 |
| QQ 文件输入 | 已支持按需下载与解析 txt/md/csv/json/yaml/xml、PDF 文本、DOCX、XLSX、PPTX、ZIP、APK 元数据 | 扫描 PDF/旧版 Office 可选 OCR/LibreOffice |
| 视频理解 | 只给引用提示 | 视频模型或抽帧+音频转写 |
| 嵌套转发 | 深度 3 | 提高需防环和限流 |
| JSON/XML 卡片 | 只扫转发 ID | 按卡片类型解析正文 |
| 未知视觉模型 | 名称推断不到会回退文本 | 手动能力覆盖 |
| 大媒体 base64 | 有 WS 护栏 | 优先 URL 或共享目录 |
| 本地图片 | 依赖 get_image/enableLocalFile2Url | 开启并在日志核对 |
| 命令与意图配置 | 已统一为 Feature Registry，后台动态渲染 | 后续接入冷却、每日上限和并发限制 |
| 文件生成 | 已支持 txt/md/json/csv/docx/xlsx/pptx/pdf/zip，上传 Canvas 后走 file 段发送 | APK 仅分析输入，不自动构建 |
| API 节点请求头 | 已支持自定义请求头、apiKey/env 模板、敏感头打码 | 动态 session/project 变量可后续扩展 |
| 功能限额 | 已支持冷却、用户/群每日上限、最大输入字符、并发、发送延迟 | 计数为进程内状态，重启清零 |
| OpenCode 绕过式接入 | 未实现 | 不实现伪造 CLI 指纹、工具注入或 FreeTier 绕过 |
| 其他 segment | poke/dice/rps 等未处理 | 按业务逐个接入 |

## 10. 后台信息架构

- 总览
- 模型：能力分工、API 节点
- 对话：对话与触发、提示词模板
- 对话：命令与意图（别名、私聊/群聊、群聊触发方式、FreeMode 自然语言开关）
- 对话：命令与意图（限额、冷却、并发、发送延迟）
- 对话：文件读取（索引保留、大小、文本/PDF/表格/PPT/压缩包上限）
- 工具：联网搜索（服务商、自动触发、抓取、限额、测试）
- 媒体：语音/TTS、画布/图库
- 系统：运行日志、系统设置

## 11. 排查清单

- 无消息：检查 WS、@/回复触发、白名单、stale-message、Napcat retcode。
- 图片：看日志 imageRefs 是 http/data-url/local；local 需 get_image 成功。
- 生图：看 gallery sync 日志、MIOBOT_PUBLIC_BASE_URL、Napcat 图片 URL。
- 语音：看 TTS request 的 model、Fish API 200、Napcat silk 转码和 send retcode。
- 文件：确认 `enableLocalFile2Url`、`download_file_stream` 是否可用、`pending-files.json` 是否有记录、临时目录权限和 MIOBOT_PUBLIC_BASE_URL。
- 生成文件：确认 Canvas 服务可达、`/canvas-api/bot/files` 返回 200、MIOBOT_PUBLIC_BASE_URL 能被 Napcat 容器访问。

## 12. 参考

- 源码：apps/bot/src/runtime.ts、image-input.ts、message-enrichment.ts、group-context.ts、apps/bot/src/tts.ts。
- 源码：packages/reply、packages/napcat、packages/model/dialects、packages/model/capability/profiles.ts。
- DeepSeek Vision: https://api-docs.deepseek.com/guides/vision
- Fish Audio TTS: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
- Napcat OneBot 11 segment/action 定义。


## 13. 联网搜索

### 支持的服务

- DeepSeek 自研 Search / Fetch：`POST /v1/tools/search`、`POST /v1/tools/fetch`
- Tavily
- Brave Search
- Serper.dev
- Bing Web Search
- Google Custom Search JSON API
- SearXNG
- Exa

### 触发方式

- 自动模式：新闻、实时信息、价格、版本、官网、文档、天气、比赛、政策等关键词触发；普通闲聊不搜索
- 每次聊天都搜索
- 关闭自动搜索，只执行显式命令：搜索、联网搜索、查一下
- 文件内容分析默认不自动联网，避免把整份文件内容当搜索词

### DeepSeek Search / Fetch

- Search 参数：query、count(1~50)、ori_question、localization、need_content
- 返回字段：rerank_score、title、url、snippet、summary、content、site_name、site_icon、date、authority
- 支持 site:、-site:、-短语、精确短语、lang:、before:、after:
- 官方 QPS：Search 和 Fetch 各自 5 QPS
- 408/429/5xx 会重试
- 计费按成功请求，空结果不计费；count 不影响单价
- 后台 DeepSeek Key 留空时，会尝试复用聊天节点的 DeepSeek 官方 Key

### 安全与注入

- 搜索结果作为不可信外部资料注入，网页中的指令不能被执行
- 网页正文会做 HTML 清洗、长度截断和总字符预算
- 抓取 URL 禁止 localhost、私有 IP、内网域名、file://、带用户名密码的 URL
- 搜索查询不包含聊天历史、系统提示词或密钥
- 搜索失败不会让主聊天失败，而是注入搜索失败提示，避免编造来源
- 结果缓存默认 300 秒，只按服务商和查询缓存，不按用户身份

### 后台

工具 -> 联网搜索：服务商、API 地址、API Key、自动模式、结果数量、正文请求、Jina/DeepSeek 抓取、超时、重试、QPS、缓存、正文和总注入字符上限、测试搜索。


## 14. 代码画图与网页截屏

### 意图

自然语言意图模型新增：

```text
code.render       代码画图
web.screenshot    网页截屏
```

显式命令：

```text
代码画图 <需求>
网页截屏 <URL>
```

示例：

```text
用 HTML 画一个...
用 SVG 画一个...
用 Canvas 画一个...
用 Three.js 画一个...
截一下 https://example.com
网页截图 https://example.com 1200x800
```

### 代码画图

代码画图使用独立模型（能力分工 → 代码画图），模型输出 JSON：

```json
{
  "format": "html|svg|canvas|three",
  "title": "作品标题",
  "width": 1080,
  "height": 1080,
  "html": "...",
  "css": "...",
  "js": "...",
  "svg": "...",
  "sendSource": false
}
```

渲染器：

- HTML/CSS/JS：`page.setContent`
- SVG：包装成 HTML 后截图
- Canvas 2D：等待绘制并截图
- Three.js：注入本地 `packages/browser-render/vendor/three.min.js`
- 代码画图完全阻断 http/https/ws 网络，只允许 data/blob/about 和内联内容

### 网页截屏

- 只接受 `http://` / `https://`
- 默认禁止 localhost、私有 IP、内网域名、云元数据地址
- 导航前做 DNS 解析检查
- 每个任务独立 BrowserContext
- 不登录、不填表单、不自动点击
- 支持 `1200x800`、`全页` 等自然语言参数

### Chromium 限制

启动参数包括：

```text
--headless=new
--disable-dev-shm-usage
--disable-background-networking
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-breakpad
--disable-extensions
--disable-sync
--disable-translate
--disable-default-apps
--disable-component-update
--disable-domain-reliability
--disable-client-side-phishing-detection
--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints
--disable-notifications
--deny-permission-prompts
--mute-audio
--hide-scrollbars
--metrics-recording-only
--no-first-run
--no-default-browser-check
--renderer-process-limit=1
--js-flags=--max-old-space-size=512
```

WebGL 额外使用：

```text
--use-gl=angle
--use-angle=swiftshader
--enable-unsafe-swiftshader
--ignore-gpu-blocklist
```

明确不使用：

```text
--disable-web-security
--allow-file-access-from-files
--single-process
```

`--no-sandbox` 默认由配置开启，仅建议在隔离环境使用。

### 资源限制

后台「工具 → 代码与网页渲染」可配置：

- Chromium 路径
- 最大并发，默认 1
- 最大排队，默认 3
- 单任务超时，默认 45 秒
- 启动超时
- 空闲关闭，默认 60 秒
- 最大代码字符数
- 最大画布尺寸
- 截图大小上限
- 是否启用 Three.js/WebGL
- 是否允许内网 URL

任务结束必须关闭 `page` 和 `context`；空闲关闭浏览器；排队满时直接拒绝。

### 部署

```bash
# 只在需要此功能时安装 Chromium
INSTALL_CHROMIUM=1 bash deploy-linux.sh rebuild

# 检查 Chromium / WebGL
npm run build
npm run check:chromium
```

如果使用自定义 Chromium 路径：

```bash
MIOBOT_CHROMIUM_PATH=/usr/bin/chromium bash deploy-linux.sh rebuild
```

1C2G 机器建议保持最大并发 1；不建议开启多任务并发。


## 15. ComfyUI 生图与文本转图片

### ComfyUI

ComfyUI 使用独立 API 节点类型：

```text
kind: comfyui
```

节点配置包含：

- Base URL
- API Key / 自定义 Headers
- Profiles
- API 格式 workflow JSON
- parameterMap
- defaults
- constraints
- outputNodeId
- pollTimeoutMs / pollIntervalMs
- maxBatchSize
- stitch 配置
- profile 级参数转化模型覆盖

每个 Profile 示例：

```json
{
  "id": "anime",
  "name": "动漫文生图",
  "workflow": {},
  "parameterMap": {
    "prompt": "6.inputs.text",
    "negativePrompt": "7.inputs.text",
    "width": "5.inputs.width",
    "height": "5.inputs.height",
    "steps": "3.inputs.steps",
    "cfg": "3.inputs.cfg",
    "sampler": "3.inputs.sampler_name",
    "scheduler": "3.inputs.scheduler",
    "seed": "3.inputs.seed",
    "batchSize": "5.inputs.batch_size"
  },
  "defaults": {},
  "constraints": {},
  "stitch": { "enabled": true, "quality": 70, "gap": 16, "label": true }
}
```

后台默认参数只用于兜底：参数转化模型失败、返回非法 JSON、参数超范围或字段缺失时，仍使用默认参数生成。

### 参数转化模型

能力分工：

```text
ComfyUI 参数转化
```

可配置节点、模型、超时、最大 Token 和提示词。模型输出：

```json
{
  "prompt": "...",
  "negativePrompt": "...",
  "width": 1024,
  "height": 1024,
  "steps": 20,
  "cfg": 7,
  "sampler": "euler",
  "scheduler": "normal",
  "seed": 0,
  "batchSize": 1,
  "denoise": 1
}
```

后端只接受已声明参数，数值会按 constraints clamp；未知字段丢弃。

### 多图拼接

- sharp 读取 ComfyUI 输出
- 1 张不拼接
- 2 张横向
- 3～4 张 2×2
- 其他按配置列数
- 默认 JPEG quality 70
- 可选 label、gap、scale、maxWidth、maxHeight
- 拼接失败回退第一张图

### 文本转图片回复

ReplyStrategy 新增：

```text
text-image
```

后台：

```text
对话与触发 → 回复策略 → 纯文本回复
```

配置 `bot.textImage`：

- width
- minHeight / maxHeight
- padding
- fontSize
- lineHeight
- fontFamily
- background / foreground / accent
- quality
- maxChars

实现为 SVG 排版 + sharp 转 JPEG，不启动 Chromium。渲染失败回退普通文本。服务器需安装中文字体，例如 `fonts-noto-cjk`。

### QQ 端模型列表

主人命令：

```text
/模型
/模型列表
/models
```

普通节点列出后台已保存的模型；ComfyUI 节点会额外请求 `GET /object_info`，从 `ckpt_name`、`unet_name`、`lora_name` 枚举中读取实时模型名，同时列出已配置的 Profiles。请求失败时仍会显示节点已保存的 Profile，不会阻塞整个列表。

### 提示词策略

ComfyUI Profile 可以配置 `promptPolicy`。未配置时按 Profile 的 id/name 自动推断：

- `moss-image-*`：MOSS-Image 自然语言 caption，关闭权重/BREAK/LoRA 标签，保留官方负向提示词和 50 步、CFG 3、Euler、sgm_uniform 等默认值。
- `krea-2-*`：Krea 2 自然语言长描述，关闭权重和负向提示词；Turbo 默认 8 步、CFG 0、mu 1.15。
- 其他 Profile：保持通用兼容策略，避免破坏已有自定义工作流。

参数转化模型会收到 `modelFamily`、`variant`、`promptPolicy`、`parameterKeys` 和 `allowedEnums`，输出后再经过语法清洗、长度限制和参数范围收敛。详见 `docs/COMFYUI-MOSS-KREA.md`。

### 第一版边界

- 支持 ComfyUI 文生图
- 支持 batchSize
- 支持多图拼接
- 图生图 / ControlNet / LoRA / 局部重绘仅预留配置接口，暂不执行
- 不支持 ComfyUI 队列全局 interrupt，避免影响其他客户端任务
