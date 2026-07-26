<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { configureApi } from './api/client';
import { useAuthStore } from './stores/auth';
import { useConfigStore } from './stores/config';
import { useCapabilityStore } from './stores/capabilities';
import AppShell from './components/AppShell.vue';
import LoginView from './components/LoginView.vue';

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
  <div v-if="booting" class="min-h-screen flex items-center justify-center text-[color:var(--ink-3)] text-sm">
    加载中...
  </div>
  <LoginView v-else-if="!auth.isAuthenticated" @success="loadWorkspace" />
  <div v-else-if="bootError" class="min-h-screen flex items-center justify-center p-4">
    <div class="card p-6 max-w-md">
      <div class="status-crit font-semibold text-sm mb-2">加载配置失败</div>
      <p class="text-xs text-[color:var(--ink-2)] mb-4">{{ bootError }}</p>
      <button class="btn-primary" @click="loadWorkspace()">重试</button>
    </div>
  </div>
  <AppShell v-else />
</template>
