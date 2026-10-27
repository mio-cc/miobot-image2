<script setup lang="ts">
import { onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import SectionCard from '../components/SectionCard.vue';
import ToggleField from '../components/ToggleField.vue';

interface PromptVersion {
    id?: string;
    versionId?: string;
    label?: string;
    content?: string;
    createdAt?: string;
    status?: string;
}

interface PromptSettings {
    enabled: boolean;
    canaryPercent: number;
    activeVersionId: string;
    canaryVersionId: string;
    versions: PromptVersion[];
}

const prompts = ref<PromptSettings | null>(null);
const loading = ref(false);
const error = ref('');
const saved = ref(false);

async function refresh() {
    loading.value = true;
    error.value = '';
    try {
        const res = await client.get('/orchestration/prompts');
        prompts.value = res.data.prompts || null;
    } catch (e: any) {
        error.value = errorMessage(e, '读取提示词注册表失败');
    } finally {
        loading.value = false;
    }
}

async function save() {
    if (!prompts.value) return;
    saved.value = false;
    try {
        const res = await client.get('/config');
        const config = res.data?.config || {};
        config.orchestration = config.orchestration || {};
        config.orchestration.promptOptimization = {
            ...(config.orchestration.promptOptimization || {}),
            ...prompts.value,
        };
        await client.post('/config', config);
        saved.value = true;
        await refresh();
    } catch (e: any) {
        error.value = errorMessage(e, '保存提示词设置失败');
    }
}

function versionKey(v: PromptVersion): string {
    return String(v.id || v.versionId || '');
}

onMounted(() => { void refresh(); });
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">提示词注册表</h1>
      <p class="text-[color:var(--ink-3)] text-xs">系统提示词分段版本管理：激活、灰度与回滚（orchestration.promptOptimization）。</p>
    </header>

    <p v-if="error" class="text-xs status-crit mb-3">{{ error }}</p>
    <p v-if="loading" class="text-xs text-[color:var(--ink-3)]">读取中…</p>

    <template v-if="prompts">
      <SectionCard title="注册表设置" hint="canaryPercent 控制灰度比例；激活/灰度版本可切换回滚" class="mb-4">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="self-end"><ToggleField v-model="prompts.enabled" label="启用版本管理" @update:model-value="saved = false" /></div>
          <label class="field-box items-start">
            <span class="text-xs font-semibold text-[color:var(--ink)]">灰度比例（%）</span>
            <input
              v-model.number="prompts.canaryPercent"
              type="number" min="0" max="100" class="input-field"
              @change="saved = false"
            />
          </label>
          <label class="field-box items-start">
            <span class="text-xs font-semibold text-[color:var(--ink)]">激活版本</span>
            <select v-model="prompts.activeVersionId" class="input-field" @change="saved = false">
              <option value="">（无）</option>
              <option v-for="v in prompts.versions" :key="`active-${versionKey(v)}`" :value="versionKey(v)">
                {{ versionKey(v) || '(未命名)' }}
              </option>
            </select>
          </label>
          <label class="field-box items-start">
            <span class="text-xs font-semibold text-[color:var(--ink)]">灰度版本</span>
            <select v-model="prompts.canaryVersionId" class="input-field" @change="saved = false">
              <option value="">（无）</option>
              <option v-for="v in prompts.versions" :key="`canary-${versionKey(v)}`" :value="versionKey(v)">
                {{ versionKey(v) || '(未命名)' }}
              </option>
            </select>
          </label>
          <div class="flex items-end gap-3 md:col-span-3">
            <button class="btn-primary" @click="save">保存设置</button>
            <button class="btn-outline" @click="refresh">刷新</button>
            <span v-if="saved" class="tag status-good">已保存</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="版本列表" hint="历史版本只读；激活与灰度可切换" class="mb-4">
        <p v-if="!prompts.versions?.length" class="text-xs text-[color:var(--ink-3)]">暂无注册的提示词版本。</p>
        <div v-else class="space-y-2">
          <details v-for="v in prompts.versions" :key="versionKey(v)" class="field-box items-start">
            <summary class="cursor-pointer min-w-0 flex flex-wrap items-center gap-2">
              <span class="font-mono text-xs">{{ versionKey(v) || '(未命名)' }}</span>
              <span v-if="versionKey(v) === prompts.activeVersionId" class="tag status-good">激活</span>
              <span v-else-if="versionKey(v) === prompts.canaryVersionId" class="tag status-warn">灰度</span>
              <span v-if="v.status" class="tag">{{ v.status }}</span>
              <span class="text-[11px] text-[color:var(--ink-3)] ml-auto">{{ v.createdAt || '' }}</span>
            </summary>
            <pre class="font-mono text-[11px] leading-relaxed overflow-auto max-h-64 p-3 mt-2 rounded bg-[color:var(--surface-2)] whitespace-pre-wrap">{{ v.content || '（空）' }}</pre>
          </details>
        </div>
      </SectionCard>
    </template>
  </div>
</template>