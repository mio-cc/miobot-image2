# 加固与适配层改动（2026-07-26）

分支 `refactor/hardening-and-adapters`，三个提交，测试 391 → 443。

做法是先把 v2 现有实现逐项读过一遍，只补 v2 确实缺的，**不用另一套实现覆盖 v2 已经做得更好的地方**。

---

## 一、改了什么

### 1. 模型请求参数按模型分流（`packages/model`）

同一个 OpenAI 兼容协议，各家对**参数本身**的接受度并不一致。原来的 `buildChat` 恒发 `max_tokens`、生图恒发 `response_format`，这两条在官方直连下都是必然 400，且错误里不带任何可自动降级的提示：

| 场景 | 原来 | 现在 |
|---|---|---|
| o 系列 / gpt-5 系列对话 | 恒发 `max_tokens` → 官方直接 400 | 按模型发 `max_completion_tokens` |
| 推理模型的 `temperature` | 照发 → 400 | 不发 |
| `o1-mini` / `o1-preview` / `gpt-5-chat` | 照发 `reasoning_effort` → 400 | 不发 |
| `gpt-image` 系列生图/改图 | 恒发 `response_format` → 400 Unknown parameter | 不发 |
| `openai/gpt-5`、`gpt-5(high)` | 前缀/档位后缀让判断全部失效 | 先归一化再判断 |

新增 `capability/params.ts`。这些是「请求体该长什么样」的协议事实，只依赖模型名，所以是纯函数，方言直接调用，不需要拿 registry。

### 2. 参数自愈（`packages/model/src/capability/healing.ts`）

静态规则只能覆盖已知模型。用户随时会接一个没见过的中转、一个刚发布的模型、一个把参数改名的反代。

现在上游因某参数报 400 时，按其提示改名（`Use 'max_completion_tokens' instead`）或直接剔除，重发一次，并按「节点 + 模型」记住结论。换任何网关，第一次多花一轮，之后自动收敛。

只在**参数问题**上重试——503、401、429 立即上抛，把服务故障当参数问题重试只会放大故障。单次请求最多自愈 3 轮。

### 3. 响应校验（`packages/model/src/dialects/shared.ts`）

`parseOpenAiText` 原来对取不到正文的情况只报一句 `missing choices[].message.content`。现在分开：

- 空 `choices` + `prompt_feedback` → `content_filtered`，带上真实原因（Gemini 经兼容层做安全拦截时就是这个形态）
- `finish_reason=length` → `output_truncated`，提示调大输出预算（推理模型的推理 token 与正文共用额度）
- 正文在 `reasoning_content` 里 → 兜底取到。注意 `content` 常常是空字符串而非 null，`??` 串联取不到这个兜底

### 4. config.json 损坏保护（`packages/storage`）

原来 `readJsonSync` 解析失败会静默返回默认值。后果是：语法错一个逗号 → 内存里跑默认配置 → **下一次保存把用户全部节点与密钥用默认值永久覆盖**，且没有任何提示。

现在 `FileJsonStore` 支持 `guardCorruptedFile`：文件存在但解析不了时，备份为 `config.json.broken-<时间戳>`、标记损坏状态、**让 `save()` 直接报错**。`ConfigStore` 默认开启；缓存/日志类文件不开，保持原行为（损坏了重建即可）。

### 5. 原型链注入（`packages/config`）

`deepMerge` 现在跳过 `__proto__` / `constructor` / `prototype`。配置来自 HTTP 请求体与磁盘文件，两个都是不可信输入。

### 6. 面板不再明文回传密钥（`packages/web-api`）

原来 `GET /api/config`、登录响应、保存响应都会把全部节点 API Key、Napcat token、prompts.chat key 以及**面板密码本身**明文发给浏览器。任何一次 XSS、一次共享的浏览器会话、甚至一次带 devtools 的截屏都会连带泄露全部凭据。

现在读时打码（`sk-••••••••1234`），写回时按「值恰好等于当前值的打码结果」还原。打码值由真实值确定性推导，所以**前端无需任何改动**：

- 用户只改了别的字段 → 密钥原样保留
- 用户真的输入新密钥 → 值对不上打码结果，按新值保存
- 用户清空密钥 → 意图被保留

关键细节：打码只加在 HTTP 边界（`getMaskedConfig`），`getConfig()` 仍返回真实配置——热重载监听器（bot 运行时）消费的是同一个方法，它需要真实密钥调上游。导出端点也保留真实密钥，那是备份用途，打码会让备份无法还原。

登录改用 `timingSafeEqual`（原来是逐字符短路比较真实密码）。

### 7. 媒体体积护栏（`packages/napcat`）

Napcat 的正/反向 WS 都是 `maxPayload = 50MB`，base64 编码让体积涨约 1.34 倍，因此经 WS 传 `base64://` 的文件实际只能到约 37MB。**超了是直接断开连接**，不是返回错误——机器人掉线重连，用户看不到任何原因。原来只有注释提醒，没有实际防护。

现在发送前过护栏，被拦下时返回 `oversized` 标记与中文原因，不会真的发出去。视频另有 100MB 硬上限（highway 通道），超限时返回 `suggestFileSend` 建议改用文件发送。

本地路径与远程 URL 只传字符串、不经 WS 传内容，不做体积拦截。

---

## 二、查过但**没有**动的（v2 已经做得对，或更好）

| 项目 | v2 现状 |
|---|---|
| 能力档案与注册表 | `capability/profiles.ts` + `registry.ts`，按家族分档 + 正则覆盖，比 v1 的扁平实现更好 |
| 生图参数规整 | `shapeImageGeneration` / `shapeImageEdit` 已按档案剔除不支持的 size/quality/mask、钳 count |
| 视频异步轮询 | `pollVideoUntilDone` 已实现，含终态判定、瞬时错误重试、超时 |
| 节点 failover | 方言感知，按声明了同名模型的节点顺序转移 |
| 原子写入 | `writeFileAtomicSync` 先写临时文件再 rename，比 v1 好 |
| 白名单归一化 | `list()` 已做 `String(x).trim()`，数字群号不会匹配不上 |
| CQ 段剥离 | 群聊私聊共用同一套，且剥离的段类型比 v1 更全（含 mface/marketface/poke/share 等） |
| 纯数字取图 | 已有 `originalChoiceAvailable` 门控，不会无条件劫持数字 |
| 配置迁移 | 有带 id 与 reason 的迁移记录系统，比 v1 完善 |

---

## 三、一处**没改**的已知取舍

`packages/config` 的 `aliases()` 对用户值与默认值取**并集**，`tests/config-regression` 里有一条测试明确写着「keep default fallbacks」，说明是有意设计。

代价是：用户删不掉内置别名。默认 `genImage` 含单字「画」，触发面偏大，想收紧的用户目前只能改默认值而不能删。

我在 v1 上把它改成了「用户为空才回落默认」，但那属于产品取舍而不是 bug，**没有单方面改 v2**。要改的话需要同步改那条回归测试，代码里已留注释说明。

---

## 四、验证

```bash
npm test    # 443 条全过（含新增 52 条）
```

新增测试：

| 文件 | 覆盖 |
|---|---|
| `model-params.test.mjs` | 13 条。参数分流的每条断言都对应一个上游会直接 400 的真实场景 |
| `model-healing.test.mjs` | 15 条。改名/剔除/学到后一轮直达/503 与 401 不重试/轮数上限/响应校验 |
| `config-safety.test.mjs` | 7 条。损坏备份与拒绝写盘、修好后恢复、空文件不算损坏、未开保护的仓储行为不变、原型注入 |
| `web-api-secrets.test.mjs` | 9 条。打码往返、内部消费者仍拿真实密钥、导出保留真实值、导入打码配置不写坏 |
| `napcat-media-limits.test.mjs` | 8 条。载荷形态识别、WS 阈值、100MB 视频降级建议 |

另外用一段脚本跑过面板完整往返（登录 → 读配置 → 改无关字段 → 保存 → 再读），确认面板全程只看到打码值而磁盘上的真实密钥完好。

---

## 五、还没做的

1. **改图 multipart**：官方 `/images/edits` 要求 `multipart/form-data`，v2 目前只发 JSON。`params.ts` 里已给出 `imageEditTransportsFor()` 的顺序（官方 multipart 优先、xAI JSON 优先），但真正实现 multipart 需要在发请求前把图片取成字节，涉及异步，方言层是同步纯函数，需要像 `resolveImageUrls` 那样在 client 里预解析。参数自愈至少能剔掉 `response_format` 这类字段，但形态本身仍需补。
2. **指标采集**：v2 没有按小时分桶的运行指标，面板也没有趋势图。
3. **画布访问控制与限流**：未查证 v2 画布端点的鉴权现状，本轮没碰。
