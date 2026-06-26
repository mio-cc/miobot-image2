import { ref } from 'vue';
import type { ApiClient } from './useApi';

/**
 * 配置加载/保存。抽自 App.vue 的 fetchConfig/saveConfig。
 * 消费已 normalize 的配置（后端 config 包负责补字段），前端不再自行补默认值。
 */
export function useConfig(client: ApiClient) {
  const config = ref<any>(null);
  const revision = ref<number>(0);
  const loading = ref(false);
  const saving = ref(false);

  async function load(): Promise<any> {
    loading.value = true;
    try {
      const { data } = await client.get('/config');
      config.value = data?.config ?? data ?? null;
      revision.value = Number(data?.revision ?? 0);
      return config.value;
    } finally {
      loading.value = false;
    }
  }

  async function save(patch: unknown, options: { compact?: boolean } = {}): Promise<any> {
    saving.value = true;
    try {
      const { data } = await client.post(`/config${options.compact ? '?compact=1' : ''}`, patch);
      if (data?.config) config.value = data.config;
      if (data?.revision) revision.value = Number(data.revision);
      return data;
    } finally {
      saving.value = false;
    }
  }

  async function importConfig(payload: unknown): Promise<any> {
    const { data } = await client.post('/config/import', payload);
    if (data?.config) config.value = data.config;
    return data;
  }

  async function exportConfig(): Promise<any> {
    const { data } = await client.get('/config/export');
    return data?.export ?? data;
  }

  async function defaultPrompts(): Promise<any> {
    const { data } = await client.get('/default-prompts');
    return data?.prompts ?? data;
  }

  return { config, revision, loading, saving, load, save, importConfig, exportConfig, defaultPrompts };
}
