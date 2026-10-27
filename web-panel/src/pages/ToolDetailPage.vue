<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import client, { errorMessage } from '../api/client';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

const route = useRoute();
const toolId = computed(() => decodeURIComponent(String(route.params.id || '')));

interface CapabilityItem {
    id: string;
    name: string;
    description: string;
    category?: string;
    effect?: string;
    riskLevel?: string;
    enabled?: boolean;
    approvalRequired?: boolean;
    aliases?: string[];
    inputSchema?: Record<string, unknown>;
    outputKinds?: string[];
    sideEffects?: string[];
    mode?: string;
    health?: { ok?: boolean; reason?: string };
}

const capability = ref<CapabilityItem | null>(null);
const exposure = ref<Record<string, string>>({});
const loading = ref(false);
const error = ref('');
const saved = ref(false);

async function loadTool() {
    loading.value = true;
    error.value = '';
    try {
        const res = await client.get('/orchestration/capabilities');
        const list: CapabilityItem[] = res.data.capabilities || [];
        capability.value = list.find((item) => item.id === toolId.value) || null;
        if (!capability.value) error.value = `未找到工具 ${toolId.value}`;
    } catch (e: any) {
        error.value = errorMessage(e, '读取工具详情失败');
    } finally {
        loading.value = false;
    }
}

async function loadExposure() {
    try {
        const res = await client.get('/config');
        exposure.value = res.data?.config?.toolRegistry?.exposure || {};
    } catch { exposure.value = {}; }
}

async function saveExposure(value: string | undefined) {
    saved.value = false;
    try {
        const res = await client.get('/config');
        const config = res.data?.config || {};
        config.toolRegistry = config.toolRegistry || {};
        config.toolRegistry.exposure = config.toolRegistry.exposure || {};
        if (value) config.toolRegistry.exposure[toolId.value] = value;
        else delete config.toolRegistry.exposure[toolId.value];
        await client.post('/config', config);
        saved.value = true;
        await loadExposure();
    } catch (e: any) {
        error.value = errorMessage(e, '保存暴露级别失败');
    }
}

const schemaText = computed(() => {
    const schema = capability.value?.inputSchema;
    return schema ? JSON.stringify(schema, null, 2) : '（未声明 schema）';
});

onMounted(() => { void loadTool(); void loadExposure(); });
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5 font-mono">{{ toolId }}</h1>
      <p class="text-[color:var(--ink-3)] text-xs">工具详情：参数 schema、暴露级别、副作用与健康状态。</p>
    </header>

    <p v-if="error" class="text-xs status-crit mb-3">{{ error }}</p>
    <p v-if="loading" class="text-xs text-[color:var(--ink-3)]">读取中…</p>

    <template v-if="capability">
      <SectionCard title="基本信息" class="mb-4">
        <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
          <FormField label="名称"><span class="text-xs">{{ capability.name }}</span></FormField>
          <FormField label="效果类型"><span class="tag">{{ capability.effect || '—' }}</span></FormField>
          <FormField label="风险级别"><span class="tag">{{ capability.riskLevel || 'low' }}</span></FormField>
          <FormField label="执行模式"><span class="tag">{{ capability.mode || 'sync' }}</span></FormField>
          <FormField label="需要审批" class="self-end"><ToggleField :model-value="Boolean(capability.approvalRequired)" label="该工具执行前需管理员审批" disabled /></FormField>
          <div class="md:col-span-3 xl:col-span-4 text-xs text-[color:var(--ink-3)]">{{ capability.description }}</div>
          <div v-if="capability.aliases?.length" class="md:col-span-3 xl:col-span-4 flex flex-wrap gap-2">
            <span v-for="alias in capability.aliases" :key="alias" class="tag font-mono">{{ alias }}</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="暴露级别（toolRegistry.exposure）" hint="后台覆盖优先于推导；hidden 不进入 Agent loadout" class="mb-4">
        <div class="flex flex-wrap gap-3 items-center">
          <select
            class="input-field !w-auto"
            :value="exposure[toolId] || ''"
            @change="saveExposure(($event.target as HTMLSelectElement).value || undefined)"
          >
            <option value="">跟随推导（默认）</option>
            <option value="core">core（核心）</option>
            <option value="domain">domain（领域）</option>
            <option value="searchable">searchable（可检索）</option>
            <option value="hidden">hidden（隐藏）</option>
          </select>
          <span v-if="saved" class="tag status-good">已保存</span>
        </div>
      </SectionCard>

      <SectionCard title="参数 Schema" class="mb-4">
        <pre class="font-mono text-[11px] leading-relaxed overflow-auto max-h-72 p-3 rounded bg-[color:var(--surface-2)]">{{ schemaText }}</pre>
      </SectionCard>

      <SectionCard title="输出与副作用" class="mb-4">
        <div class="flex flex-wrap gap-2">
          <span v-for="kind in capability.outputKinds || []" :key="kind" class="tag">{{ kind }}</span>
          <span v-if="!capability.outputKinds?.length" class="text-xs text-[color:var(--ink-3)]">（未声明输出类型）</span>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">
          <span v-for="effect in capability.sideEffects || []" :key="effect" class="tag status-warn">{{ effect }}</span>
          <span v-if="!capability.sideEffects?.length" class="text-xs text-[color:var(--ink-3)]">无副作用（只读）</span>
        </div>
      </SectionCard>

      <SectionCard title="健康状态" class="mb-4">
        <div class="flex items-center gap-2">
          <span :class="['tag', capability.health?.ok ? 'status-good' : 'status-crit']">
            {{ capability.health?.ok ? '健康' : '异常' }}
          </span>
          <span class="text-xs text-[color:var(--ink-2)]">{{ capability.health?.reason || '（未体检）' }}</span>
        </div>
      </SectionCard>
    </template>
  </div>
</template>