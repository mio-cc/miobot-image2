# report.render 数据报告渲染

`report.render` 把结构化数据渲染成图片报告，适合榜单、表格、KPI、趋势和对比图。模型只提供数据与视觉意图，系统负责字体测量、列宽、分页、页头和页码。

## 基本结构

```json
{
  "title": "本周热门话题 TOP 80",
  "subtitle": "统计时间：2026-10-28 · 共 80 条",
  "source": "数据来源：示例平台",
  "theme": "dark",
  "pageSize": 30,
  "rows": [{"rank":1,"name":"话题 A","heat":100000,"trend":"+1.2%"}],
  "columns": [{"key":"rank","label":"排名","width":64,"align":"right"},{"key":"name","label":"话题","weight":2},{"key":"heat","label":"热度","width":120,"align":"right"}],
  "blocks": [
    {"kind":"kpi","items":[{"label":"总条目","value":"80"}]},
    {"kind":"chart","title":"热度 TOP 10","chart":{"type":"horizontal-bar","x":"name","y":"heat","topN":10,"unit":"指数"}},
    {"kind":"table","title":"完整榜单"}
  ]
}
```

## 图表类型

- `bar`：纵向柱状图
- `horizontal-bar`：横向排行榜
- `line`：趋势折线图
- `area`：面积趋势图
- `pie` / `donut`：构成占比
- `scatter`：相关性散点图

图表由本地 ECharts 生成 SVG，再由 Chromium 截图，不依赖外部 CDN。

## 分页规则

- 表格默认每页 30 行，可由 `pageSize` 或 table block 单独覆盖，范围 5-60。
- 图表和 KPI 优先放在第一页，表格从后续页开始。
- 每页重复标题、表头、页脚和页码。
- 最多 8 页；超过时返回明确错误，避免无限刷屏。
- 需要更多数据时减少字段、提高每页行数或只输出 TOP N。

## 与 code.render 的分工

- `report.render`：结构化数据、榜单、表格、KPI、图表、自动分页。
- `code.render`：自定义 HTML/SVG/Canvas/Three.js 和艺术化视觉。

## 诊断

每一页的图片输出会带 `page`、`pages`、`pageHeight`、`warnings` 元数据，便于模型或运维判断是否需要调整 `pageSize`、拆分图表或减少数据。
