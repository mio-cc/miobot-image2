<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const password = ref('');
const submitting = ref(false);

const emit = defineEmits<{ success: [done: () => void] }>();

async function submit() {
    if (!password.value || submitting.value) return;
    submitting.value = true;
    try {
        if (await auth.login(password.value)) {
            password.value = '';
            // login 只负责拿会话，加载配置由父组件做完再切换界面，
            // 所以这里 emit 时本组件仍然挂载着，事件不会丢。
            await new Promise<void>(resolve => { emit('success', resolve); });
        }
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="card p-7 w-full max-w-sm">
      <div class="mono font-bold text-base tracking-wide mb-1">
        MIOBOT<span class="text-[color:var(--ink-3)] font-normal">·console</span>
      </div>
      <p class="text-[color:var(--ink-3)] text-xs mb-6">NapCat 多模型机器人控制台</p>

      <label class="label-sm">管理密码</label>
      <input v-model="password" type="password" class="input-field" autocomplete="current-password"
        placeholder="输入管理密码" @keyup.enter="submit" />

      <button class="btn-primary w-full mt-4" :disabled="submitting || !password" @click="submit">
        {{ submitting ? '登录中...' : '登录' }}
      </button>

      <p v-if="auth.loginError" class="status-crit text-xs text-center mt-3">{{ auth.loginError }}</p>
    </div>
  </div>
</template>
