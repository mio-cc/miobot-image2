# 站点配方（site-recipes）

这里是 `packages/site-recipe` 的种子配方。**默认全部不启用**——生产仍走
`plugins/novel-platform.mjs`，直到 feature flag 打开并且等价性核对完成。

## 当前状态

| 配方 | 站点 | 数据位置 | 真实站点实跑 | 状态 |
|---|---|---|---|---|
| `qidian-sanjiang.json` | m.qidian.com | `<script type="application/json">` → `pageData.records` | ✅ 17 条 | 可用 |
| `fanqie-rank.json` | fanqienovel.com | `window.__INITIAL_STATE__` → `rank.book_list` | ✅ 10 条 | 可用（书名带 PUA，见下） |
| qimao | www.qimao.com | `window.__NUXT__` → `fetch.*.listData` | ❌ 拿不到 | **阻塞**，见下 |

## qimao 为什么没做成配方

`https://www.qimao.com/paihang/boy/hot/date` 返回的 HTTP 响应头不合法：

```
content-security-policy: upgrade-insecure-requests; frame-ancestors zuozhe.qimao.com
```

`frame-ancestors` 里有空格，是无效的 CSP 语法。Node 的 undici（`fetch`）按规范
直接拒绝解析整条响应：

```
HTTPParserError: Response does not match the HTTP/1.1 protocol
(Unexpected whitespace after header value)
```

旧插件用自己实现的 `qimaoGet`（自带解压与容错）才能拿到内容。要迁 qimao，得让
recipe 执行器支持「容错 HTTP 客户端」——那等于把站点特例塞回执行器，
和「配方是通用格式」的定位冲突。

**结论**：qimao 继续走旧插件。这是取舍，不是遗漏。

## 起点的 list 接口榜单为什么不做配方

起点 `webcommon/rank/{api}list` 需要 `_csrfToken` + `cookie` + `referer` 三件套，
属于会话握手。配方引擎不支持，**也不该支持**——那等于把登录态内置进抓取层。
这类榜单（月票/畅销/阅读指数/收藏/免费…）继续走旧插件。

只有 SSR 型（`/strongrec/`、`/sanjiang/`）能纯 HTTP 抓，才做成配方。

## 番茄书名的 PUA 字符

`rank.book_list` 里的 `bookName` / `author` 混了私用区字符（U+E000–U+F8FF），
直接输出是乱码。`normalizeRecords` 会统一替换成 `□`（对齐旧插件的 `cleanPua`）。

旧插件还会对每本书额外请求 `fanqieBookMeta` 拿干净书名与作者；配方只做一次请求，
所以书名可能带 `□`。要不要为配方加「二次请求取详情」是后续决定（会让单次抓取
从 1 个请求变成 1+N 个）。

## 加新配方的流程

```text
1. 用 site.probe（或 browser.render + recordNetwork）拿到真实接口与结构
2. 抄 URL 模板（数字/uuid/日期会自动变 {param}）
3. 用真实数据核对 JSONPath——**不要凭印象写**（我第一版把起点写成 .list[*]，实跑 0 条）
4. 设 verify：minRecords / requiredFieldsNonEmpty / uniqueBy
5. validateRecipe 通过 + 真实站点跑通，才允许进仓库
```

## 安全边界（执行器保证，配方无法绕过）

- 只允许 GET/HEAD；POST 必须 `readOnly: true`
- host 锁定在 `match.host`，跨 host 一律拒绝（拒绝时不发请求）
- 私网/环回/云元数据地址拒绝
- 3xx 不跟随（防跨 host 逃逸）
- 401/403 直接回报「需要登录，不支持」
- 每域名速率限制（默认 1 req/2s）、单次页数上限（默认 20）
