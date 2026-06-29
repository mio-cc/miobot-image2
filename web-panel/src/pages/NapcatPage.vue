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
              <h1 class="page-head__title">客户端连接</h1>
              <p class="page-head__desc">建立与 QQ 客户端的直接长连接，收发和转发多图消息。配置长连接地址、访问令牌与各类行为超时。</p>
              <div class="page-head__actions">
                <button @click="testNapcatConnection" :disabled="napcatTestLoading" class="btn-primary text-sm">
                  {{ napcatTestLoading ? '测试中...' : '测试长连接' }}
                </button>
              </div>
            </header>

            <div class="card p-5">
              <h3 class="section-title mb-4">长连接配置</h3>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">长连接地址</label>
                  <input v-model="config.napcat.wsUrl" class="input-field font-mono" placeholder="Napcat WebSocket 地址（可留空）" />
                </div>
                <div>
                  <label class="label-sm">接口访问令牌</label>
                  <input v-model="config.napcat.token" type="password" class="input-field font-mono" placeholder="若无访问密码则留空..." />
                </div>
              </div>
            </div>

            <div class="card p-5">
              <h3 class="section-title mb-4">行为超时设定（毫秒）</h3>
              <div class="group-grid group-grid--3" style="grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));">
                <div>
                  <label class="label-sm">通用操作超时</label>
                  <input v-model.number="config.napcat.actionTimeoutMs" type="number" min="3000" step="1000" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">文本发送超时</label>
                  <input v-model.number="config.napcat.textSendTimeoutMs" type="number" min="3000" step="1000" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">图片上传超时</label>
                  <input v-model.number="config.napcat.imageSendTimeoutMs" type="number" min="10000" step="5000" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">文件发送超时</label>
                  <input v-model.number="config.napcat.fileSendTimeoutMs" type="number" min="10000" step="5000" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">文件重试次数</label>
                  <input v-model.number="config.napcat.fileSendRetryCount" type="number" min="0" max="10" step="1" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">文件重试间隔</label>
                  <input v-model.number="config.napcat.fileSendRetryDelayMs" type="number" min="0" step="500" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">合并转发超时</label>
                  <input v-model.number="config.napcat.forwardSendTimeoutMs" type="number" min="10000" step="5000" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">引用取消息超时</label>
                  <input v-model.number="config.napcat.getMessageTimeoutMs" type="number" min="3000" step="1000" class="input-field font-mono" />
                </div>
              </div>
            </div>

            <div v-if="napcatTestResult" class="card p-5" :style="napcatTestResult.success ? 'border-color: var(--success-line); background: var(--success-soft);' : 'border-color: var(--danger-line); background: var(--danger-soft);'">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
                <span style="font-size: 0.92rem; font-weight: 700;" :style="{ color: napcatTestResult.success ? 'var(--success)' : 'var(--danger)' }">
                  {{ napcatTestResult.success ? '测试连接正常' : '无法与长连接握手' }}
                </span>
              </div>
              <div style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-soft); line-height: 1.6;">{{ napcatTestResult.message }}</div>
              <div style="display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; font-family: var(--font-mono); font-size: 0.7rem; color: var(--muted);">
                <span v-if="napcatTestResult.selfQqId">QQ: {{ napcatTestResult.selfQqId }}</span>
                <span v-if="napcatTestResult.nickname">昵称: {{ napcatTestResult.nickname }}</span>
                <span v-if="napcatTestResult.latencyMs !== undefined">延时: {{ napcatTestResult.latencyMs }}ms</span>
                <span v-if="napcatTestResult.currentBot">状态: {{ napcatTestResult.currentBot.readyStateText }}</span>
              </div>
            </div>

            <div class="card p-5">
              <h3 class="section-title mb-2">容器内挂载目录映射</h3>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 12px;">若客户端在本地或容器内运行，可以配置其生成的输出绝对目录。留空则走编码传输。</p>
              <input v-model="config.napcat.mountOutputDir" class="input-field font-mono" style="max-width: 560px;" placeholder="例如: /app/napcat/output" />
            </div>

            <div class="card p-5" style="border-color: var(--warn-line);">
              <h3 class="section-title mb-2" style="color: var(--warn);">重设管理密码</h3>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 12px;">修改管理面板密码。保存并热重载后，当前令牌自动失效，需要用新密码重登。</p>
              <input v-model="config.panel.passwordSeed" class="input-field font-mono" style="max-width: 360px;" placeholder="输入您的新密码..." />
            </div>

          </div>
</template>
