import { ref } from 'vue';

export type ToastType = 'success' | 'error' | 'info';
export interface Toast { id: number; message: string; type: ToastType }

/**
 * 全局通知。抽自 App.vue 的 showToast/toasts。
 * 纯叠加：现有 App.vue 不受影响；逐页迁移时各页改用 useToast() 即可。
 */
export function useToast(timeoutMs = 4000) {
  const toasts = ref<Toast[]>([]);
  let counter = 0;

  function show(message: string, type: ToastType = 'info'): number {
    const id = counter++;
    toasts.value.push({ id, message, type });
    if (timeoutMs > 0) {
      setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, timeoutMs);
    }
    return id;
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function clear(): void { toasts.value = []; }

  return { toasts, show, dismiss, clear };
}
