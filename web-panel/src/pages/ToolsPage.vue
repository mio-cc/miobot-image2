<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import client, { errorMessage } from '../api/client';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import { useConfigStore } from '../stores/config';

interface CapabilityItem {
    id: string;
    name: string;
    description: string;
    category?: string;
    effect?: string;
    riskLevel?: string;
    enabled?: boolean;
    health?: { ok?: boolean; reason?: string };
}

const router = useRouter();
const configStore = useConfigStore();
const capabilities = ref<CapabilityItem[]>([]);
const loading = ref(false);
const error = ref('');
const exposure = computed(() => configStore.config?.toolRegistry?.exposure || {});
const tools = computed(() => configStore.config?.toolRegistry);

const EXPOSURE_LABEL: Record<string, string> = { core: '核心', domain: '领域', searchable: '可检索', hidden: '隐藏' };

async function loadExposure() {
    if (!configStore.config) await configStore.fetchConfig();
}

function effectiveExposure(cap: CapabilityItem): string {
    return exposure.value?.[cap.id] || (cap as any).exposure || '推导';
}

async function refresh() {
    loading.value = true;
    error.value = '';
    try {
        const res = await client.get('/orchestration/capabilities');
        capabilities.value = res.data.capabilities || [];
    } catch (e: any) {
        error.value = errorMessage(e, '读取工具目录失败');
    } finally {
        loading.value = false;
    }
}

function openDetail(id: string) {
    void router.push(`/tools/${encodeURIComponent(id)}`);
}

onMounted(() => { void Promise.all([refresh(), loadExposure()]); });
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">工具目录</h1>
      <p class="text-[color:var(--ink-3)] text-xs">Agent 工具注册表全集：能力、暴露级别与健康状态。点击查看详情与参数。</p>
    </header>

    <SectionCard v-if="tools" title="工具加载预算" hint="toolRegistry · 修改后请点右上角「保存并热重载」；HTTP/插件/MCP 动态工具已默认 core，不会被 24 上限裁掉" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <FormField label="每轮最多工具" hint="模型每轮最多看到的 schema 数量；范围 1-128。"><input v-model.number="tools.maxToolsPerTurn" type="number" min="1" max="128" class="input-field" /></FormField>
        <FormField label="Schema 字节上限"><input v-model.number="tools.maxToolSchemaBytes" type="number" min="1024" max="1000000" class="input-field" /></FormField>
        <FormField label="默认并发"><input v-model.number="tools.defaultMaxConcurrency" type="number" min="1" max="64" class="input-field" /></FormField>
        <FormField label="默认超时 (ms)"><input v-model.number="tools.defaultTimeoutMs" type="number" min="1000" class="input-field" /></FormField>
        <div class="self-end flex items-center gap-2 text-xs text-[color:var(--ink-3)]">
          <input id="tool-search-enabled" v-model="tools.toolSearchEnabled" type="checkbox" />
          <label for="tool-search-enabled">启用 searchable 工具</label>
        </div>
      </div>
    </SectionCard>

    <SectionCard title="已注册工具" hint="来自能力注册表的动态 ToolSpec；hidden 不进入 loadout" class="mb-4">
      <template #action>
        <button class="btn-outline" :disabled="loading" @click="refresh">刷新</button>
      </template>
      <p v-if="error" class="text-xs status-crit mb-2">{{ error }}</p>
      <p v-if="loading" class="text-xs text-[color:var(--ink-3)]">读取中…</p>
      <p v-else-if="!capabilities.length" class="text-xs text-[color:var(--ink-3)]">暂无已注册工具。</p>
      <div v-else class="space-y-2">
        <button
          v-for="cap in capabilities"
          :key="cap.id"
          class="field-box w-full text-left"
          @click="openDetail(cap.id)"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="font-mono text-xs truncate">{{ cap.id }}</span>
            <span class="tag">{{ EXPOSURE_LABEL[effectiveExposure(cap)] || effectiveExposure(cap) }}</span>
            <span v-if="cap.riskLevel" class="tag">{{ cap.riskLevel }}</span>
            <span v-if="cap.health?.ok === false" class="tag status-crit">异常</span>
            <span v-else-if="cap.health?.ok" class="tag status-good">健康</span>
          </div>
          <div class="text-xs text-[color:var(--ink-3)] truncate mt-1">{{ cap.name }} — {{ cap.description }}</div>
        </button>
      </div>
    </SectionCard>
  </div>
</template>