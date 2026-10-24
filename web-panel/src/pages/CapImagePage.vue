<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 图片生成能力页。
 * 由原 OrchestrationPage 的「ComfyUI 工作流」卡迁入；TR.3 会在此页补齐
 * 「机器人生图 / 画布默认值」分区，成为生图配置单入口。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);

const comfyWorkflowNodes = ref<any[]>([]);
const comfyNodeIndex = ref(0);
const comfyProfileId = ref('');
const comfyProfileName = ref('');
const comfyProfileExists = ref(false);
const comfyWorkflowJson = ref('');
const comfyPromptNodeIds = ref('');
const comfyNegativePromptNodeIds = ref('');
const comfyOutputNodeId = ref('');
const comfyParameterMapJson = ref('{}');
const comfyDefaultsJson = ref('{}');
const comfyWorkflowNodesInfo = ref<any[]>([]);
const comfyWorkflowValidation = ref<any>(null);
const comfyWorkflowMessage = ref('');
const comfyParameterDrafts = ref<Record<string, any>>({});
const comfyFallbackProfileId = ref('');
const comfyFallbackEnabled = ref(true);
const comfyCustomized = ref(false);
const comfySkipFaceDetailer = ref(false);
const comfyBuiltinRevision = ref('');

const comfyCurrentNode = computed(() => comfyWorkflowNodes.value.find((item) => Number(item.nodeIndex) === Number(comfyNodeIndex.value)));
const comfyCurrentProfiles = computed(() => comfyCurrentNode.value?.profiles || []);
const comfyParameterRows = computed(() => {
    try {
        const map = JSON.parse(comfyParameterMapJson.value || '{}');
        return Object.entries(map).map(([key, path]) => ({ key, path: String(path), value: comfyParameterDrafts.value[key] }));
    } catch { return []; }
});
function setComfyParameter(key: string, event: Event) {
    const raw = (event.target as HTMLInputElement).value;
    const n = Number(raw);
    comfyParameterDrafts.value = { ...comfyParameterDrafts.value, [key]: raw !== '' && Number.isFinite(n) ? n : raw };
}

async function loadComfyWorkflows() {
    try {
        const res = await client.get('/orchestration/comfyui/workflows');
        comfyWorkflowNodes.value = res.data?.nodes || [];
        const activeNodeIndex = Number(config.value?.llm?.imageNodeIndex ?? comfyNodeIndex.value);
        if (!comfyWorkflowNodes.value.length) return;
        const preferredNode = comfyWorkflowNodes.value.find((item: any) => Number(item.nodeIndex) === Number(comfyNodeIndex.value))
          || comfyWorkflowNodes.value.find((item: any) => Number(item.nodeIndex) === activeNodeIndex)
          || comfyWorkflowNodes.value[0];
        comfyNodeIndex.value = Number(preferredNode.nodeIndex);
        const activeProfileId = String(config.value?.llm?.imageModel || '');
        const profile = preferredNode.profiles?.find((item: any) => String(item.id) === String(comfyProfileId.value))
          || preferredNode.profiles?.find((item: any) => String(item.id) === activeProfileId)
          || preferredNode.profiles?.[0];
        if (profile) await loadComfyWorkflowProfile(Number(preferredNode.nodeIndex), String(profile.id));
    } catch { comfyWorkflowNodes.value = []; }
}

async function loadComfyWorkflowProfile(nodeIndex = Number(comfyNodeIndex.value), profileId = comfyProfileId.value) {
    const profiles = comfyWorkflowNodes.value.find((item: any) => Number(item.nodeIndex) === Number(nodeIndex))?.profiles || [];
    if (!profileId || !profiles.some((item: any) => String(item.id) === String(profileId))) profileId = String(profiles[0]?.id || '');
    if (!profileId) return;
    try {
        const res = await client.get('/orchestration/comfyui/workflows/' + nodeIndex + '/' + encodeURIComponent(profileId));
        const profile = res.data?.profile;
        if (!profile) return;
        comfyProfileId.value = String(profile.id || '');
        comfyProfileName.value = String(profile.name || '');
        comfyProfileExists.value = true;
        comfyWorkflowJson.value = JSON.stringify(profile.workflow || {}, null, 2);
        comfyPromptNodeIds.value = (profile.promptNodeIds || []).join(', ');
        comfyNegativePromptNodeIds.value = (profile.negativePromptNodeIds || []).join(', ');
        comfyOutputNodeId.value = String(profile.outputNodeId || '');
        comfyFallbackProfileId.value = String(profile.fallbackProfileId || profile.id || '');
        comfyFallbackEnabled.value = profile.fallbackEnabled !== false;
        comfySkipFaceDetailer.value = Boolean(profile.skipFaceDetailer);
        comfyCustomized.value = Boolean(profile.customized);
        comfyBuiltinRevision.value = String(profile.builtinRevision || '');
        comfyParameterMapJson.value = JSON.stringify(profile.parameterMap || {}, null, 2);
        comfyDefaultsJson.value = JSON.stringify(profile.defaults || {}, null, 2);
        comfyParameterDrafts.value = { ...(profile.defaults || {}) };
        comfyWorkflowNodesInfo.value = res.data?.nodes || [];
        comfyWorkflowValidation.value = res.data?.validation || null;
        comfyWorkflowMessage.value = profile.legacyWorkflow ? '检测到旧 10 节点 workflow，已迁移到内置 baseline，原始 workflow 已备份。' : '';
    } catch (error: any) {
        comfyWorkflowMessage.value = error?.response?.data?.error || String(error?.message || error);
    }
}

function newComfyWorkflowProfile() {
    comfyProfileId.value = '';
    comfyProfileName.value = '新工作流';
    comfyProfileExists.value = false;
    comfyWorkflowJson.value = '{}';
    comfyPromptNodeIds.value = '';
    comfyNegativePromptNodeIds.value = '';
    comfyOutputNodeId.value = '';
    comfyParameterMapJson.value = '{}';
    comfyDefaultsJson.value = '{}';
    comfySkipFaceDetailer.value = false;
    comfyParameterDrafts.value = {};
    comfyWorkflowNodesInfo.value = [];
    comfyWorkflowValidation.value = null;
    comfyWorkflowMessage.value = '';
}

async function restoreComfyBaseline() {
    const id = comfyProfileId.value.trim();
    if (!id) {
        comfyWorkflowMessage.value = '请先填写 profile ID';
        return;
    }
    try {
        const res = await client.put('/orchestration/comfyui/workflows/' + comfyNodeIndex.value + '/' + encodeURIComponent(id), { restoreBuiltin: true });
        comfyWorkflowMessage.value = '已恢复内置 baseline';
        comfyWorkflowValidation.value = res.data?.validation || null;
        await loadComfyWorkflows();
        await loadComfyWorkflowProfile(Number(comfyNodeIndex.value), id);
    } catch (error: any) {
        comfyWorkflowMessage.value = error?.response?.data?.error || String(error?.message || error);
    }
}

async function saveComfyWorkflowProfile() {
    comfyWorkflowMessage.value = '';
    try {
        const id = comfyProfileId.value.trim();
        if (!id) throw new Error('请填写 profile ID');
        const workflow = JSON.parse(comfyWorkflowJson.value || '{}');
        const parameterMap = JSON.parse(comfyParameterMapJson.value || '{}');
        const defaults = { ...JSON.parse(comfyDefaultsJson.value || '{}'), ...comfyParameterDrafts.value };
        const res = await client.put('/orchestration/comfyui/workflows/' + comfyNodeIndex.value + '/' + encodeURIComponent(id), {
            name: comfyProfileName.value || id,
            workflow,
            promptNodeIds: comfyPromptNodeIds.value.split(',').map((item) => item.trim()).filter(Boolean),
            negativePromptNodeIds: comfyNegativePromptNodeIds.value.split(',').map((item) => item.trim()).filter(Boolean),
            outputNodeId: comfyOutputNodeId.value.trim(),
            parameterMap,
            defaults,
            fallbackProfileId: comfyFallbackProfileId.value.trim() || id,
            fallbackEnabled: comfyFallbackEnabled.value,
            customized: comfyCustomized.value,
            skipFaceDetailer: comfySkipFaceDetailer.value,
        });
        comfyWorkflowValidation.value = res.data?.validation || null;
        comfyWorkflowMessage.value = '保存成功，配置已热重载';
        comfyProfileExists.value = true;
        await loadComfyWorkflows();
        await loadComfyWorkflowProfile(Number(comfyNodeIndex.value), id);
    } catch (error: any) {
        comfyWorkflowValidation.value = error?.response?.data?.validation || null;
        comfyWorkflowMessage.value = error?.response?.data?.error || String(error?.message || error);
    }
}

onMounted(loadComfyWorkflows);
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">图片生成</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        ComfyUI 工作流与生图参数。模型只增强画面提示词；steps、CFG、采样器、尺寸、LoRA 等全部由这里保存的 workflow/defaults 决定。
      </p>
    </header>

    <SectionCard title="ComfyUI 工作流" hint="节点与 Profile 编辑、校验与基线恢复" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <FormField label="ComfyUI 节点">
          <select v-model.number="comfyNodeIndex" class="input-field" @change="loadComfyWorkflowProfile()">
            <option v-for="node in comfyWorkflowNodes" :key="node.nodeIndex" :value="node.nodeIndex">{{ node.nodeIndex }} · {{ node.name }}</option>
          </select>
        </FormField>
        <FormField label="已有 Profile">
          <select v-model="comfyProfileId" class="input-field" @change="loadComfyWorkflowProfile()">
            <option value="">新建 / 手动 ID</option>
            <option v-for="profile in comfyCurrentProfiles" :key="profile.id" :value="profile.id">{{ profile.id }} · {{ profile.name }}</option>
          </select>
        </FormField>
        <FormField label="Profile ID"><input v-model="comfyProfileId" class="input-field font-mono" placeholder="moss-image-sft" /></FormField>
        <FormField label="显示名称"><input v-model="comfyProfileName" class="input-field" /></FormField>
        <FormField label="输出节点 ID"><input v-model="comfyOutputNodeId" class="input-field font-mono" placeholder="16" /></FormField>
        <FormField label="Fallback Profile"><input v-model="comfyFallbackProfileId" class="input-field font-mono" placeholder="同 id 使用内置 baseline" /></FormField>
        <div class="flex items-end"><ToggleField v-model="comfyFallbackEnabled" label="失败自动切 baseline" /></div>
        <div class="flex items-end"><ToggleField v-model="comfySkipFaceDetailer" label="跳过 FaceDetailer 脸修" hint="仍保留放大，直接接 VAEDecode 输出" /></div>
        <FormField label="正向提示词节点 ID"><input v-model="comfyPromptNodeIds" class="input-field font-mono" placeholder="5, 13" /></FormField>
        <FormField label="负向提示词节点 ID"><input v-model="comfyNegativePromptNodeIds" class="input-field font-mono" placeholder="6" /></FormField>
        <div class="flex items-end gap-2 xl:col-span-3">
          <button class="btn-outline" type="button" @click="loadComfyWorkflowProfile()">加载</button>
          <button class="btn-outline" type="button" @click="newComfyWorkflowProfile">新建</button>
          <button class="btn-primary" type="button" @click="saveComfyWorkflowProfile">校验并保存</button>
          <button class="btn-outline" type="button" @click="restoreComfyBaseline">恢复内置基线</button>
          <span class="text-xs text-[color:var(--ink-3)]">Revision {{ comfyBuiltinRevision || '-' }} · {{ comfyCustomized ? '自定义' : '内置/未改' }}</span>
          <span class="text-xs text-[color:var(--ink-3)]">{{ comfyWorkflowMessage }}</span>
        </div>
      </div>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
        <FormField label="Workflow API JSON" hint="只改文本提示词节点；工作流参数通过下方 defaults + parameterMap 管理">
          <textarea v-model="comfyWorkflowJson" class="input-field font-mono" rows="16" spellcheck="false" />
        </FormField>
        <div class="grid grid-cols-1 gap-4">
          <FormField label="parameterMap" hint="逻辑参数名 -> 节点路径，例如 steps -> 8.inputs.steps">
            <textarea v-model="comfyParameterMapJson" class="input-field font-mono" rows="10" spellcheck="false" />
          </FormField>
          <FormField label="defaults" hint="工作流实际参数值；模型不会修改这些值">
            <textarea v-model="comfyDefaultsJson" class="input-field font-mono" rows="10" spellcheck="false" />
          </FormField>
        </div>
      </div>
      <div v-if="comfyParameterRows.length" class="mt-4">
        <p class="text-xs font-medium mb-2">工作流参数快捷编辑</p>
        <div class="overflow-x-auto max-h-[300px]">
          <table class="w-full text-xs">
            <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
              <tr><th class="text-left py-1 pr-3">参数</th><th class="text-left py-1 pr-3">节点路径</th><th class="text-left py-1">值</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in comfyParameterRows" :key="row.key" class="border-b border-[color:var(--hairline-2)]/50">
                <td class="py-1 pr-3 mono">{{ row.key }}</td>
                <td class="py-1 pr-3 mono text-[color:var(--ink-3)]">{{ row.path }}</td>
                <td class="py-1"><input :value="comfyParameterDrafts[row.key]" class="input-field font-mono" @input="setComfyParameter(String(row.key), $event)" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-if="comfyWorkflowValidation" class="mt-3 text-xs">
        <p>校验：<strong>{{ comfyWorkflowValidation.ok ? '通过' : '失败' }}</strong>；节点数 {{ comfyWorkflowValidation.nodeCount }}</p>
        <p v-if="comfyWorkflowValidation.errors?.length" class="text-red-400">错误：{{ comfyWorkflowValidation.errors.join('；') }}</p>
        <p v-if="comfyWorkflowValidation.warnings?.length" class="text-amber-400">警告：{{ comfyWorkflowValidation.warnings.join('；') }}</p>
      </div>
      <details class="mt-3">
        <summary class="text-xs cursor-pointer text-[color:var(--ink-3)]">查看节点结构（{{ comfyWorkflowNodesInfo.length }}）</summary>
        <div class="overflow-x-auto max-h-[260px] mt-2">
          <table class="w-full text-xs">
            <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]"><tr><th class="text-left py-1 pr-3">ID</th><th class="text-left py-1 pr-3">class_type</th><th class="text-left py-1 pr-3">title</th><th class="text-left py-1">inputs</th></tr></thead>
            <tbody>
              <tr v-for="item in comfyWorkflowNodesInfo" :key="item.id" class="border-b border-[color:var(--hairline-2)]/50">
                <td class="py-1 pr-3 mono">{{ item.id }}</td><td class="py-1 pr-3 mono">{{ item.classType }}</td><td class="py-1 pr-3">{{ item.title }}</td><td class="py-1 mono text-[color:var(--ink-3)]">{{ (item.inputs || []).join(', ') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </SectionCard>
  </div>
</template>
