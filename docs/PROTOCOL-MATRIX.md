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

## 9. 已知缺口

| 项目 | 现状 | 建议 |
|---|---|---|
| QQ 语音输入 | 不支持 ASR | 增加 voice 下载与 STT 节点 |
| QQ 文件输入 | 不读取内容 | get_file + 文档解析白名单 |
| 视频理解 | 只给引用提示 | 视频模型或抽帧+音频转写 |
| 嵌套转发 | 深度 3 | 提高需防环和限流 |
| JSON/XML 卡片 | 只扫转发 ID | 按卡片类型解析正文 |
| 未知视觉模型 | 名称推断不到会回退文本 | 手动能力覆盖 |
| 大媒体 base64 | 有 WS 护栏 | 优先 URL 或共享目录 |
| 本地图片 | 依赖 get_image/enableLocalFile2Url | 开启并在日志核对 |
| 图片压缩设置 | UI 有开关，v2 未接线 | 实现图片压缩或标记 legacy-only |
| 发图后自动撤回 | UI 有开关，v2 未接线 | 发送成功后 delete_msg |
| 长文本分段 | UI 有配置，v2 未接线 | reply 层按 maxChars 拆分 |
| TTS 发送前延迟 | UI 有配置，v2 未接线 | voice 回调中 sleep |
| 其他 segment | poke/dice/rps 等未处理 | 按业务逐个接入 |

## 10. 后台信息架构

- 总览
- 模型：能力分工、API 节点
- 对话：对话与触发、提示词模板
- 媒体：语音/TTS、画布/图库
- 系统：运行日志、系统设置

## 11. 排查清单

- 无消息：检查 WS、@/回复触发、白名单、stale-message、Napcat retcode。
- 图片：看日志 imageRefs 是 http/data-url/local；local 需 get_image 成功。
- 生图：看 gallery sync 日志、MIOBOT_PUBLIC_BASE_URL、Napcat 图片 URL。
- 语音：看 TTS request 的 model、Fish API 200、Napcat silk 转码和 send retcode。

## 12. 参考

- 源码：apps/bot/src/runtime.ts、image-input.ts、message-enrichment.ts、group-context.ts、apps/bot/src/tts.ts。
- 源码：packages/reply、packages/napcat、packages/model/dialects、packages/model/capability/profiles.ts。
- DeepSeek Vision: https://api-docs.deepseek.com/guides/vision
- Fish Audio TTS: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
- Napcat OneBot 11 segment/action 定义。
