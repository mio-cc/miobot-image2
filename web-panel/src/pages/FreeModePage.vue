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
              <h1 class="page-head__title">自由模式</h1>
              <p class="page-head__desc">启用后，未命中明确指令的 @机器人 消息会交给智能规划器判断是文本回复还是图像任务。支持感叹号快捷参数：<code style="font-family: var(--font-mono); color: var(--primary);">mb_1!</code>、<code style="font-family: var(--font-mono); color: var(--primary);">9:16!</code>、<code style="font-family: var(--font-mono); color: var(--primary);">2k!</code>。</p>
              <div class="page-head__actions">
                <label class="toggle"><input type="checkbox" v-model="config.freeMode.enabled"><span class="toggle-slider"></span></label>
                <span class="tag" :style="config.freeMode.enabled ? 'background: var(--success-soft); border-color: var(--success-line); color: var(--success);' : ''">
                  {{ config.freeMode.enabled ? '已启用' : '已停用' }}
                </span>
              </div>
            </header>

            <div class="group-grid">
              <div class="card p-5" style="border-color: var(--primary-line); background: var(--primary-soft);">
                <h3 class="section-title mb-3">规划路由</h3>
                <div class="setting-row" style="margin-bottom: 14px;">
                  <span style="color: var(--muted); font-size: 0.76rem; font-weight: 600;">当前</span>
                  <code style="font-family: var(--font-mono); font-size: 0.76rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['freeMode', 'nodeIndex'], ['freeMode', 'model']) }}</code>
                  <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 28px; padding: 0 8px;">去路由</button>
                </div>
                <div>
                  <label class="label-sm">规划超时（毫秒）</label>
                  <input v-model.number="config.freeMode.timeoutMs" type="number" min="30000" step="30000" class="input-field" :disabled="!config.freeMode.enabled" />
                </div>
              </div>

              <div class="card p-5" style="border-color: var(--success-line); background: var(--success-soft);">
                <h3 class="section-title mb-3">规划选项</h3>
                <div class="space-y-3">
                  <label class="setting-row" style="padding: 10px 12px;">
                    <div class="setting-row__text">
                      <p class="setting-row__title">读取引用消息</p>
                      <p class="setting-row__desc">支持引用文本、图片与合并转发摘要</p>
                    </div>
                    <input type="checkbox" v-model="config.freeMode.includeQuotedMessage" class="h-5 w-5" style="accent-color: var(--success);" />
                  </label>
                  <label class="setting-row" style="padding: 10px 12px;">
                    <div class="setting-row__text">
                      <p class="setting-row__title">有图时优先改图</p>
                      <p class="setting-row__desc">用户发图并要求修改时，规划器优先选择改图任务</p>
                    </div>
                    <input type="checkbox" v-model="config.freeMode.preferEditWhenImagePresent" class="h-5 w-5" style="accent-color: var(--success);" />
                  </label>
                </div>
              </div>

              <div class="card p-5" style="border-color: var(--warn-line); background: var(--warn-soft);">
                <h3 class="section-title mb-3">限制</h3>
                <div class="space-y-3">
                  <div>
                    <label class="label-sm">最多输入图片</label>
                    <input v-model.number="config.freeMode.maxInputImages" type="number" min="0" max="12" step="1" class="input-field" :disabled="!config.freeMode.enabled" />
                  </div>
                  <div>
                    <label class="label-sm">最多引用/转发</label>
                    <input v-model.number="config.freeMode.maxReferencedMessages" type="number" min="0" max="80" step="1" class="input-field" :disabled="!config.freeMode.enabled" />
                  </div>
                  <div>
                    <label class="label-sm">最多输出图片</label>
                    <input v-model.number="config.freeMode.maxOutputImages" type="number" min="1" max="4" step="1" class="input-field" :disabled="!config.freeMode.enabled" />
                  </div>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <h3 class="section-title mb-3">规划提示词</h3>
              <textarea v-model="config.freeMode.plannerPromptTemplate" rows="16" class="input-field font-mono text-xs" :disabled="!config.freeMode.enabled" />
              <p style="color: var(--muted); font-size: 0.72rem; margin-top: 8px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{userContent}}</code>。规划器必须输出结构化结果；若动作为图片，将只发送图片结果。</p>
            </div>

          </div>
</template>
