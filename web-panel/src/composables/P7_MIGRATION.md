# P7 — web-panel 组件化迁移地图

> 现状：App.vue ≈ 4500 行单文件,11 页全塞在一个 `<script setup>` + 一个 `<template>`。
> 本目录已落地**可复用 composables**(纯叠加,App.vue 未改,照常工作)。
> 下面是逐页拆分计划——**建议配合 `npm run dev` 逐页搬、每页在浏览器验证渲染再进行下一页**,避免大爆炸盲拆。

## 已就绪的 composables（plan §5.1）

- `useToast()` — 全局通知(原 `showToast`/`toasts`)
- `useApi(baseURL?)` — axios 实例 + Bearer 鉴权 + `login()/logout()`(token 取登录响应 `auth.token`)
- `useConfig(client)` — `load/save/importConfig/exportConfig/defaultPrompts`
- `useLogs(client, channel)` — `fetchLogs/clear/startAuto/stopAuto`(system / canvas 双通道)

后续可继续抽:`useModels`(节点/模型列表 + fetch-models)、`useCanvasCards`、`useCodex`。

## 目标结构

```
web-panel/src/
  App.vue                 # 仅:登录态 / 侧栏(menuItems) / <component :is> 路由出口 / 全局 Toast
  composables/            # ← 已建
  pages/
    OverviewPage.vue      (about)        ConfigCenter 概览
    ModelsNodesPage.vue   (llm)          模型与节点(+ 新增 方言/能力 展示)
    ModelRoutesPage.vue   (modelRoutes)
    HuggingFacePage.vue   (huggingFace)
    ReplyStrategyPage.vue (bot)
    FreeModePage.vue      (freeMode)
    TemplatesPage.vue     (templates)
    CanvasConfigPage.vue  (canvas)
    CodexPage.vue         (codex)
    NapcatPage.vue        (napcat)
    LogsPage.vue          (logs)
  components/             # GlassCard / FormField / NodePicker / ModelPicker / Toast / Tag ...
  styles/                 # 拆分 style.css(tokens / glass / responsive)
```

## 逐页迁移步骤（每页一轮，建议顺序：简单→复杂）

1. **LogsPage**(最独立,先练手)→ 用 `useLogs`。
2. **OverviewPage**(只读概览)。
3. **ReplyStrategyPage / FreeModePage / NapcatPage**(表单为主,`useConfig`)。
4. **ModelsNodesPage / ModelRoutesPage / HuggingFacePage**(`useConfig` + `useModels`,新增方言/能力展示)。
5. **TemplatesPage / CanvasConfigPage**。
6. **CodexPage**(最复杂、强外部依赖,放最后)。

每轮:把该页 `<template>` 段落 + 相关 ref/函数搬入新组件,改用 composable 暴露的状态;在 App.vue 用 `<component :is="pages[currentPage]" />` 挂载;`npm run dev` 验证该页渲染与交互;通过后删除 App.vue 里旧的该页代码。

## 清理项

- 删除源码树内的编译产物 `App.vue.js`、`HelloWorld.vue(.js)`、`main.js`。
- 保留现有暗色毛玻璃视觉与响应式断点(TASK-001 成果),只做结构化拆分,不推翻设计。
