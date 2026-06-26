import { onBeforeUnmount, ref } from 'vue';
import type { ApiClient } from './useApi';

export type LogChannel = 'system' | 'canvas';
export interface LogQueryParams { level?: string; scope?: string; contains?: string; limit?: number }

/**
 * 运行日志：拉取/清空/自动刷新。抽自 App.vue 的 fetchLogs/clearLogs/log timer。
 * system → /logs；canvas → /canvas/logs。
 */
export function useLogs(client: ApiClient, channel: LogChannel = 'system') {
  const path = channel === 'canvas' ? '/canvas/logs' : '/logs';
  const entries = ref<any[]>([]);
  const total = ref(0);
  const autoRefresh = ref(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastParams: LogQueryParams = {};

  async function fetchLogs(params: LogQueryParams = lastParams): Promise<any[]> {
    lastParams = params;
    const { data } = await client.get(path, { params });
    entries.value = data?.items ?? (Array.isArray(data) ? data : []);
    total.value = Number(data?.total ?? entries.value.length);
    return entries.value;
  }

  async function clear(): Promise<void> {
    await client.post(`${path}/clear`);
    await fetchLogs();
  }

  function startAuto(intervalMs = 4000): void {
    stopAuto();
    autoRefresh.value = true;
    timer = setInterval(() => { void fetchLogs(); }, Math.max(1000, intervalMs));
  }

  function stopAuto(): void {
    autoRefresh.value = false;
    if (timer) { clearInterval(timer); timer = undefined; }
  }

  onBeforeUnmount(stopAuto);

  return { entries, total, autoRefresh, fetchLogs, clear, startAuto, stopAuto };
}
