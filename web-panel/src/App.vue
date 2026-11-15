<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { configureApi } from './api/client';
import { useAuthStore } from './stores/auth';
import { useConfigStore } from './stores/config';
import { useCapabilityStore } from './stores/capabilities';
import AppShell from './components/AppShell.vue';
import LoginView from './components/LoginView.vue';
import UiEmptyState from './components/ui/UiEmptyState.vue';

const auth = useAuthStore();
const configStore = useConfigStore();
const capabilities = useCapabilityStore();
const booting = ref(true);
const bootError = ref('');

// 会话失效时统一落到登录页，而不是把一个 401 甩给用户。
configureApi({
    getToken: () => auth.token,
    onSessionExpired: reason => {
        auth.sessionExpired(reason);
        configStore.reset();
        capabilities.reset();
    },
});

/**
 * 加载工作区。「已登录」的定义是"有会话且配置已加载"——
 * 配置没到手就切界面，用户看到的会是一个没有内容的空壳。
 */
async function loadWorkspace(done?: () => void) {
    bootError.value = '';
    try {
        await configStore.fetchConfig();
        auth.isAuthenticated = true;
        capabilities.refresh();
    } catch (error: any) {
        // 401 由拦截器统一处理；其余错误必须显示出来——
        // 静默吞掉的话界面就只剩一个空壳，没人知道发生了什么。
        if (error?.response?.status !== 401) {
            bootError.value = error?.response?.data?.error || error?.message || '加载配置失败';
            console.error('[panel] 加载配置失败', error);
        }
    } finally {
        done?.();
    }
}

onMounted(async () => {
    if (auth.token) await loadWorkspace();
    booting.value = false;
});

// 有未保存改动时关页面提醒一下
window.addEventListener('beforeunload', event => {
    if (configStore.dirty) {
        event.preventDefault();
        event.returnValue = '';
    }
});
</script>

<template>
  <!-- 启动屏：品牌标记 + 呼吸微光进度，替代原来的纯文字「加载中...」 -->
  <div v-if="booting" class="boot" role="status" aria-live="polite" aria-label="正在启动控制台">
    <div class="boot__card ui-pop-in">
      <div class="boot__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h4M13 5h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-6z" />
          <path d="M4 18h3a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3H4z" />
        </svg>
      </div>
      <p class="boot__name">Miobot Console</p>
      <p class="boot__hint">正在装载配置与能力清单…</p>
      <div class="boot__track" aria-hidden="true"><span class="boot__bar" /></div>
    </div>
  </div>

  <LoginView v-else-if="!auth.isAuthenticated" @success="loadWorkspace" />

  <div v-else-if="bootError" class="boot">
    <div class="card max-w-md p-5 ui-pop-in">
      <UiEmptyState
        icon="alert"
        title="加载配置失败"
        :description="bootError"
      >
        <template #action>
          <button type="button" class="btn-primary" @click="loadWorkspace()">重试</button>
        </template>
      </UiEmptyState>
    </div>
  </div>

  <AppShell v-else />
</template>

<style scoped>
.boot {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--page);
}

.boot__card {
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 30px 40px 26px;
  border: 1px solid var(--hairline-2);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: var(--sh-1);
}

.boot__mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 3px;
  border-radius: 13px;
  background: var(--accent);
  color: var(--accent-ink);
  box-shadow: 0 3px 14px color-mix(in srgb, var(--accent) 30%, transparent);
}

.boot__name {
  margin: 0;
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
}
.boot__hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--ink-3);
}

.boot__track {
  position: relative;
  width: 156px;
  height: 3px;
  margin-top: 9px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--hairline-2);
}
.boot__bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 42%;
  border-radius: 999px;
  background: var(--accent);
  animation: boot-slide 1.15s var(--ease-swift) infinite;
}
@keyframes boot-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(340%); }
}

@media (prefers-reduced-motion: reduce) {
  .boot__bar { animation: none; width: 100%; opacity: .45; }
}
</style>
