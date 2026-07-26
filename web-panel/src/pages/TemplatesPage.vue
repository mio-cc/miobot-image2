<script setup lang="ts">
import { computed, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import AppIcon from '../components/AppIcon.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);

const convertSource = ref('');
const convertLoading = ref(false);
const convertStatus = ref('');
const titleLoading = ref<Record<string, boolean>>({});
const collapsed = ref<Record<string, boolean>>({});
const search = ref('');

const templates = computed(() => config.value?.bot?.promptTemplates || []);
const filteredTemplates = computed(() => {
    const keyword = search.value.trim().toLowerCase();
    const all = templates.value.map((tpl: any, idx: number) => ({ tpl, idx }));
    if (!keyword) return all;
    return all.filter(({ tpl }: any) =>
        String(tpl.title || '').toLowerCase().includes(keyword)
        || String(tpl.prompt || '').toLowerCase().includes(keyword));
});

function addTemplate() {
    templates.value.push({
        id: `mb_${templates.value.length + 1}`,
        title: `模板 ${templates.value.length + 1}`,
        prompt: '{{prompt}}',
    });
}

function removeTemplate(idx: number) {
    if (!window.confirm('删除这个模板？删除后其它模板的编号会顺移，历史消息里的 mb_n! 可能指向别的模板。')) return;
    templates.value.splice(idx, 1);
    normalizeIds();
}

/** 编号是用户在 QQ 里唯一的引用方式（mb_3!），必须始终连续。 */
function normalizeIds() {
    templates.value.forEach((item: any, idx: number) => {
        item.id = `mb_${idx + 1}`;
        if (!item.title) item.title = `模板 ${idx + 1}`;
    });
}

async function convertToTemplate() {
    const rawPrompt = convertSource.value.trim();
    if (!rawPrompt) { convertStatus.value = '请先粘贴要转化的提示词'; return; }
    convertLoading.value = true;
    convertStatus.value = '正在转化模板...';
    try {
        const res = await client.post('/templates/convert', { rawPrompt });
        if (res.data.config) configStore.applyServerConfig(res.data);
        convertSource.value = '';
        convertStatus.value = `已新增模板 ${res.data.template?.id || ''} ${res.data.template?.title || ''}`.trim();
    } catch (error: any) {
        convertStatus.value = `转化失败：${errorMessage(error)}`;
    } finally {
        convertLoading.value = false;
    }
}

async function generateTitle(tpl: any, idx: number) {
    if (!tpl?.prompt?.trim()) { convertStatus.value = '模板内容为空，无法命名'; return; }
    const key = tpl.id || `mb_${idx + 1}`;
    titleLoading.value = { ...titleLoading.value, [key]: true };
    try {
        const res = await client.post('/templates/title', { templatePrompt: tpl.prompt });
        tpl.title = res.data.title || tpl.title;
    } catch (error: any) {
        convertStatus.value = `命名失败：${errorMessage(error)}`;
    } finally {
        titleLoading.value = { ...titleLoading.value, [key]: false };
    }
}

const statusIsError = computed(() => /失败|为空|请先/.test(convertStatus.value));
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">模板库</h1>
      <p class="text-[color:var(--ink-3)] text-xs">本地模板、AI 转模板与 prompts.chat 远程库。模型分工在「能力分工」页配置。</p>
    </header>

    <SectionCard title="本地提示词模板" :hint="`共 ${templates.length} 个。用户在 QQ 里用 mb_1! 这样的编号套用`" class="mb-4">
      <template #actions>
        <input v-model="search" class="input-field !w-44" placeholder="搜索模板..." />
        <button class="btn-outline text-xs flex items-center gap-1" @click="addTemplate">
          <AppIcon name="plus" :size="12" />添加
        </button>
      </template>

      <div v-if="filteredTemplates.length" class="space-y-3 max-h-[620px] overflow-y-auto pr-1">
        <div v-for="{ tpl, idx } in filteredTemplates" :key="tpl.id || idx"
          class="rounded-lg border border-[color:var(--hairline-2)] p-3">
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <span class="tag">{{ tpl.id || `mb_${idx + 1}` }}</span>
            <input v-model="tpl.title" @blur="normalizeIds" class="input-field !w-auto md:!w-64" placeholder="模板标题" />
            <button class="btn-outline text-xs" :disabled="titleLoading[tpl.id || `mb_${idx + 1}`]" @click="generateTitle(tpl, idx)">
              {{ titleLoading[tpl.id || `mb_${idx + 1}`] ? '命名中...' : 'AI 命名' }}
            </button>
            <span class="flex-1"></span>
            <button class="btn-outline text-xs" @click="collapsed[tpl.id || idx] = !collapsed[tpl.id || idx]">
              {{ collapsed[tpl.id || idx] ? '展开' : '折叠' }}
            </button>
            <button class="btn-danger text-xs" @click="removeTemplate(idx)">删除</button>
          </div>
          <textarea v-if="!collapsed[tpl.id || idx]" v-model="tpl.prompt" @blur="normalizeIds" rows="5"
            class="input-field font-mono text-xs"
            placeholder="支持 {{prompt}} 占位用户描述；不写占位符时会把用户描述追加到模板后"></textarea>
          <div v-else class="rounded-lg border border-[color:var(--hairline-2)] px-3 py-2 text-xs text-[color:var(--ink-3)] max-h-12 overflow-hidden whitespace-pre-wrap">
            {{ tpl.prompt }}
          </div>
        </div>
      </div>
      <p v-else class="text-[color:var(--ink-3)] text-sm py-6 text-center">
        {{ search ? '没有匹配的模板' : '暂无模板，添加后用户就能用 mb_1! 调用' }}
      </p>
    </SectionCard>

    <SectionCard title="提示词转模板" hint="把现成提示词粘进来，抽象成可复用模板并存入模板库" class="mb-4">
      <template #actions>
        <button class="btn-primary text-xs" :disabled="convertLoading" @click="convertToTemplate">
          {{ convertLoading ? '转化中...' : '转化并存入' }}
        </button>
      </template>
      <textarea v-model="convertSource" rows="5" class="input-field font-mono text-xs mb-3"
        placeholder="粘贴一段完整提示词，一次性的主体、场景会被抽象成含 {{prompt}} 的模板"></textarea>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FormField label="转化提示词" hint="可用占位符 {{rawPrompt}}">
          <div class="flex justify-end mb-1">
            <button class="text-xs hover:underline" @click="configStore.resetPrompt('llm.templateConvertPromptTemplate', 'templateConvertPromptTemplate')">恢复默认</button>
          </div>
          <textarea v-model="config.llm.templateConvertPromptTemplate" rows="6" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="自动命名提示词" hint="可用占位符 {{templatePrompt}}">
          <div class="flex justify-end mb-1">
            <button class="text-xs hover:underline" @click="configStore.resetPrompt('llm.templateTitlePromptTemplate', 'templateTitlePromptTemplate')">恢复默认</button>
          </div>
          <textarea v-model="config.llm.templateTitlePromptTemplate" rows="6" class="input-field font-mono text-xs"></textarea>
        </FormField>
      </div>
      <p v-if="convertStatus" class="text-xs mt-3" :class="statusIsError ? 'status-crit' : 'status-good'">
        {{ convertStatus }}
      </p>
    </SectionCard>

    <SectionCard title="模板填充提示词" hint="决定用户提示词怎么填进模板" class="mb-4">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FormField label="本地模板填充" hint="占位符 {{templatePrompt}}、{{rawPrompt}}">
          <div class="flex justify-end mb-1">
            <button class="text-xs hover:underline" @click="configStore.resetPrompt('llm.templatePromptTemplate', 'templatePromptTemplate')">恢复默认</button>
          </div>
          <textarea v-model="config.llm.templatePromptTemplate" rows="7" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="引用模板填充" hint="rt / 套模板 用这套">
          <div class="flex justify-end mb-1">
            <button class="text-xs hover:underline" @click="configStore.resetPrompt('llm.referencedTemplatePromptTemplate', 'referencedTemplatePromptTemplate')">恢复默认</button>
          </div>
          <textarea v-model="config.llm.referencedTemplatePromptTemplate" rows="7" class="input-field font-mono text-xs"></textarea>
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="prompts.chat 远程库" hint="pp 负责中文友好的远程搜索；spp 会先取候选再让模型融合">
      <template #actions>
        <ToggleField v-model="config.promptsChat.enabled" label="启用" />
      </template>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <FormField label="MCP Endpoint">
          <input v-model="config.promptsChat.endpoint" class="input-field font-mono" placeholder="https://prompts.chat/api/mcp" />
        </FormField>
        <FormField label="API Key" hint="可留空">
          <input v-model="config.promptsChat.apiKey" type="password" class="input-field font-mono" />
        </FormField>
        <FormField label="搜索类型">
          <select v-model="config.promptsChat.searchType" class="input-field">
            <option value="">全部</option><option value="IMAGE">IMAGE</option><option value="TEXT">TEXT</option>
            <option value="STRUCTURED">STRUCTURED</option><option value="VIDEO">VIDEO</option><option value="AUDIO">AUDIO</option>
          </select>
        </FormField>
        <FormField label="QQ 展示条数">
          <input v-model.number="config.promptsChat.displayLimit" type="number" min="1" max="10" class="input-field" />
        </FormField>
        <FormField label="搜索拉取上限">
          <input v-model.number="config.promptsChat.searchLimit" type="number" min="1" max="50" class="input-field" />
        </FormField>
        <FormField label="智能搜索上限">
          <input v-model.number="config.promptsChat.smartSearchLimit" type="number" min="3" max="50" class="input-field" />
        </FormField>
        <FormField label="候选模板数">
          <input v-model.number="config.promptsChat.smartCandidateLimit" type="number" min="1" max="10" class="input-field" />
        </FormField>
        <FormField label="请求超时 (ms)">
          <input v-model.number="config.promptsChat.requestTimeoutMs" type="number" min="5000" step="1000" class="input-field" />
        </FormField>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
        <ToggleField v-model="config.promptsChat.translateSearchQuery" label="中文转英文搜索" />
        <ToggleField v-model="config.promptsChat.translateResults" label="结果说明翻译中文" />
        <ToggleField v-model="config.promptsChat.queryRewriteEnabled" label="启用查询词改写" />
        <ToggleField v-model="config.promptsChat.fallbackToRawPrompt" label="选不出模板时用原文" />
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FormField label="搜索词生成提示词" hint="占位符 {{rawPrompt}}">
          <div class="flex justify-end mb-1">
            <button class="text-xs hover:underline" @click="configStore.resetPrompt('promptsChat.searchQueryPromptTemplate', 'promptsChatSearchQueryPromptTemplate')">恢复默认</button>
          </div>
          <textarea v-model="config.promptsChat.searchQueryPromptTemplate" rows="6" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="智能选择融合提示词" hint="占位符 {{rawPrompt}}、{{candidates}}">
          <div class="flex justify-end mb-1">
            <button class="text-xs hover:underline" @click="configStore.resetPrompt('promptsChat.smartPromptTemplate', 'promptsChatSmartPromptTemplate')">恢复默认</button>
          </div>
          <textarea v-model="config.promptsChat.smartPromptTemplate" rows="6" class="input-field font-mono text-xs"></textarea>
        </FormField>
      </div>
    </SectionCard>
  </div>
</template>
