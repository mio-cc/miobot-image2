# report.render：模型直接设计 HTML 页面

`report.render` 现在是一个**模型驱动的 HTML 页面渲染能力**，不是固定数据报告模板。

模型负责：

- 理解用户意图和上下文；
- 从上游工具结果中取得真实数据；
- 设计完整 HTML、CSS、SVG 或内联 JS；
- 把标题、数据、图表、表格和视觉风格直接写进页面。

后端只负责：

- 校验输入尺寸和大小；
- 用 Chromium 打开自包含 HTML；
- 截图并返回图片产物；
- 检查空白内容、页面高度和超时。

**不存在默认报告模板、默认示例数据或占位数据。** 如果既没有 `html`，也没有旧版 `rows/data`，工具会明确返回缺少页面内容，而不是生成示例看板。

## 新接口（推荐）

```json
{
  "html": "<!doctype html><html><head><style>...</style></head><body>...</body></html>",
  "css": "body { background: #f3f0e8; }",
  "js": "",
  "title": "本周网文热度榜",
  "width": 1080,
  "height": 1000,
  "fullPage": true
}
```

字段说明：

- `html`：完整、自包含的页面源码。外部网络请求会被 Chromium 拦截，因此样式、脚本、数据和字体引用应内联。
- `css` / `js`：可选追加内容；也可以直接全部写进 `html`。
- `width`：320-1600，默认 1080。
- `height`：320-12000，默认 1000。
- `fullPage`：默认 `true`；页面底部背景会自动填满截图视口，横向溢出会被裁剪，避免半屏黑/白块。
- `title`：图片标题，仅用于渲染服务日志和产物命名。

## Agent/Harness 契约

1. 先完成数据获取。`report.render` 不替模型查询、补全或编造数据。
2. 模型把上游工具返回的真实数据嵌入 HTML；禁止使用 `2024 年度经营数据看板` 之类的示例内容。
3. 数据表、榜单、KPI、趋势图和数据看板优先走 `report.render`，由模型设计页面；`code.render` 只做自由视觉、艺术海报、Canvas/Three.js 等。
4. 如果 `report.render` 返回缺少内容或页面渲染失败，模型应先补数据或修正 HTML，再重试一次；不要把内部失败说明直接当成用户结果。
5. 渲染产物标记为 `readOnlyArtifact`，只发送给 QQ，不同步 Canvas 图库。

## 旧版兼容

旧的 `spec/rows/columns/blocks` 结构化接口仍保留用于兼容历史任务，但新请求不应再依赖固定模板。结构化模式只在明确传入数据行时工作，缺少数据会返回错误，不会回退到示例内容。

## 诊断

- `report.render 请求快照`：`keys`、`htmlChars`、`rowsCount`、`blocksCount`、`blockKinds`、`dataKeys`。
- `HTML 页面渲染完成`：`width`、`height`、`bytes`、`htmlChars`。
- `代码渲染布局快照`：`rows`、`bodyHeight`、`documentHeight`。
- 生成的图片元数据包含 `page`、`pages`、`pageHeight`、`warnings`、`readOnlyArtifact`。

## 本地 Napcat 全链路测试

`tests/agent-e2e-html-napcat-r24.test.mjs` 使用本地 WebSocket 模拟 Napcat：

```text
QQ 群消息
  -> NapcatAdapter
  -> AgentRuntime
  -> report.render(html) 异步任务
  -> 本地 Chromium 截图
  -> 异步 job resume
  -> ReplyPlan
  -> 模拟 Napcat send_group_msg
```

测试同时断言：

- 页面由模型提供，不出现默认示例数据；
- 图片宽度为请求宽度，中文正常；
- 异步挂起期间不发送任何 QQ 消息；
- resume 后图片和文本到达 QQ；
- 渲染截图不会调用 Canvas 图库同步。