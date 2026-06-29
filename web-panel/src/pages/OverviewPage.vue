<script lang="ts">
import { defineComponent, inject } from 'vue';
export default defineComponent({
  setup() {
    return { ...(inject('panelStore', {}) as Record<string, any>) };
  },
});
</script>
<template>
          <div class="animate-fadein">

            <header class="page-head">
              <h1 class="page-head__title">控制台概览</h1>
              <p class="page-head__desc">MioBot Console v2 — 新一代多模型 QQ 机器人管理平台。基于类型化脚本精确重构，无缝衔接各类主流大语言模型，并具备独立的图像交互创作画布。</p>
            </header>

            <div class="metric-grid">
              <div class="metric metric--primary">
                <p class="metric__label">系统内核</p>
                <p class="metric__value">v2.0.0</p>
                <p class="metric__hint">稳定版</p>
              </div>
              <div class="metric">
                <p class="metric__label">技术栈</p>
                <p class="metric__value">Vue 3</p>
                <p class="metric__hint">+ Vite + TS</p>
              </div>
              <div class="metric">
                <p class="metric__label">设计规范</p>
                <p class="metric__value">Console DS</p>
                <p class="metric__hint">精致浅色 SaaS</p>
              </div>
            </div>

            <div class="card p-5">
              <h3 class="section-title mb-4">功能模块</h3>
              <div class="group-grid group-grid--2">
                <div class="setting-row">
                  <span class="tag" style="background: var(--primary-soft); border-color: var(--primary-line); color: var(--primary); flex: 0 0 auto;">LLM</span>
                  <div class="setting-row__text" style="flex: 1;">
                    <p class="setting-row__title">多模型路由</p>
                    <p class="setting-row__desc">节点管理 · 能力分工 · 推理等级</p>
                  </div>
                </div>
                <div class="setting-row">
                  <span class="tag" style="background: var(--success-soft); border-color: var(--success-line); color: var(--success); flex: 0 0 auto;">Canvas</span>
                  <div class="setting-row__text" style="flex: 1;">
                    <p class="setting-row__title">画布工作室</p>
                    <p class="setting-row__desc">图像生成 · 意图识别 · 画廊管理</p>
                  </div>
                </div>
                <div class="setting-row">
                  <span class="tag" style="background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn); flex: 0 0 auto;">Bot</span>
                  <div class="setting-row__text" style="flex: 1;">
                    <p class="setting-row__title">回复策略</p>
                    <p class="setting-row__desc">人格设定 · 自由模式 · 模板库</p>
                  </div>
                </div>
                <div class="setting-row">
                  <span class="tag" style="flex: 0 0 auto;">Diag</span>
                  <div class="setting-row__text" style="flex: 1;">
                    <p class="setting-row__title">系统诊断</p>
                    <p class="setting-row__desc">实时日志 · 连接状态 · 运行监控</p>
                  </div>
                </div>
              </div>
            </div>

          </div>
</template>
