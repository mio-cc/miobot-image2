<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import CapabilityPageLayout from '../components/CapabilityPageLayout.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import ModelPicker from '../components/ModelPicker.vue';

/**
 * 图片生成能力页（image.generate）。
 * 生图模型单入口（§2.6.4 动作5）：「机器人生图」（llm.image*，自能力分工页迁入）
 * 与「画布默认值」（canvas.image* 与画布反推，自画布页迁入）同页管理；
 * 高级参数 = ComfyUI 工作流。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);

const imageTestPrompt = ref('一只柴犬');
const imageTestLoading = ref(false);
const imageTestResult = ref<any>(null);

/** 生图命令修饰符（自 BotPage 迁入）：附加在生图描述里的前缀/后缀，不是独立功能命令。 */
const modifierFields = [
    { key: 'toggleEnhance', label: '润色开关', placeholder: '润色, enhance', hint: '写在描述前，例如：画 润色 一只猫' },
    { key: 'forceEnhance', label: '强制润色', placeholder: '润色, enhance', hint: '' },
    { key: 'disableEnhance', label: '禁用润色', placeholder: '原文, raw, 不润色', hint: '' },
    { key: 'imageCount', label: '张数后缀', placeholder: 's', hint: '例如 2s! 生成 2 张；张数仍受模型能力与功能上限约束' },
];

async function testImage() {
    imageTestLoading.value = true;
    imageTestResult.value = null;
    try {
        // keyRef 是打码那一刻写进节点对象的下标，随删除/重排一起走。
        // 发实时下标会漂：删了节点还没保存时，后端会拿别的节点的凭据去测。
        const nodeIndex = config.value.llm.imageNodeIndex;
        const node = config.value.llm.apiKeys?.[nodeIndex] as any;
        const res = await client.post('/test-image', {
            prompt: imageTestPrompt.value,
            nodeIndex,
            keyRef: Number.isInteger(node?.keyRef) ? node.keyRef : nodeIndex,
            model: config.value.llm.imageModel,
        });
        imageTestResult.value = res.data;
    } catch (error: any) {
        imageTestResult.value = error?.response?.data || { success: false, error: errorMessage(error) };
    } finally {
        imageTestLoading.value = false;
    }
}

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
  <CapabilityPageLayout capability-id="image.generate" feature-id="image.generate"
    title="图片生成" advanced-title="ComfyUI 工作流与参数"
    subtitle="生图模型单入口：机器人生图与画布默认值同页管理；模型只增强画面提示词，参数由 workflow/defaults 决定">
    <template #models>
      <div v-if="config">
        <div class="text-xs font-medium mb-2">机器人生图（Bot 命令与编排）</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="文生图" hint="画 / 生图 / draw 走这条链路">
            <ModelPicker capability="image.generate"
              :node-index="Number(config.llm.imageNodeIndex) || 0" :model="config.llm.imageModel || ''"
              @update:node-index="config.llm.imageNodeIndex = $event"
              @update:model="config.llm.imageModel = $event" />
          </FormField>
          <FormField label="改图 / 图生图" hint="改图 / i2i 走这条链路">
            <ModelPicker capability="image.edit"
              :node-index="Number(config.llm.editNodeIndex) || 0" :model="config.llm.editModel || ''"
              @update:node-index="config.llm.editNodeIndex = $event"
              @update:model="config.llm.editModel = $event" />
          </FormField>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
          <div class="flex items-end"><ToggleField v-model="config.llm.imageEnabled" label="启用机器人生图" /></div>
          <FormField label="一次生成张数" hint="大于 1 时会合成编号预览图">
            <input v-model.number="config.llm.imageCount" type="number" min="1" max="4" class="input-field" />
          </FormField>
          <FormField label="改图请求格式" hint="auto 会按模型自动排序：官方 gpt-image 只认 multipart，xAI 只认 JSON，多数中转认 json-images">
            <select v-model="config.llm.imageEditRequestMode" class="input-field">
              <option value="auto">auto（按模型自动选择）</option>
              <option value="json-images">json-images</option>
              <option value="json-image">json-image</option>
              <option value="multipart">multipart</option>
            </select>
          </FormField>
          <FormField label="超时 (ms)"><input v-model.number="config.llm.imageTimeoutMs" type="number" min="30000" step="30000" class="input-field" /></FormField>
          <FormField label="失败重试"><input v-model.number="config.llm.imageRetryCount" type="number" min="0" max="5" class="input-field" /></FormField>
          <FormField label="重试间隔 (ms)"><input v-model.number="config.llm.imageRetryDelayMs" type="number" min="0" step="500" class="input-field" /></FormField>
          <div class="md:col-span-2 flex items-end"><ToggleField v-model="config.llm.safeRewriteOnFailure" label="失败后合规改写重试" hint="被内容策略拒了就让模型换个说法再试一次" /></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
          <FormField label="图片反推模型" hint="只影响 Bot 的反推命令；画布反推库在下方画布分区">
            <ModelPicker capability="interrogate"
              :node-index="Number(config.llm.interrogateNodeIndex) || 0" :model="config.llm.interrogateModel || ''"
              @update:node-index="config.llm.interrogateNodeIndex = $event"
              @update:model="config.llm.interrogateModel = $event" />
          </FormField>
          <FormField label="反推超时 (ms)">
            <input v-model.number="config.llm.interrogateTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
          </FormField>
          <FormField label="反推提示词" class="md:col-span-2">
            <textarea v-model="config.llm.interrogatePromptTemplate" rows="4" class="input-field font-mono text-xs"></textarea>
          </FormField>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-2 mt-4 pt-4 border-t border-[color:var(--hairline-2)] items-end">
          <FormField label="测试生图" hint="用当前文生图节点与模型真实生成一张（走 /test-image，不计入配额）">
            <input v-model="imageTestPrompt" class="input-field" placeholder="测试提示词" />
          </FormField>
          <button class="btn-outline text-xs whitespace-nowrap" :disabled="imageTestLoading" @click="testImage">
            {{ imageTestLoading ? '测试中...' : '发起测试' }}
          </button>
          <div v-if="imageTestResult" class="md:col-span-2 text-xs rounded-lg border border-[color:var(--hairline-2)] px-3 py-2"
            :class="imageTestResult.success ? 'status-good' : 'status-crit'">
            {{ imageTestResult.success ? `生图 API 正常 · 返回 ${imageTestResult.count} 张` : `生图 API 异常：${imageTestResult.error}` }}
            <img v-if="imageTestResult.image" :src="imageTestResult.image" alt="测试生成结果"
              class="mt-2 rounded-md max-h-40 border border-[color:var(--hairline-2)]" />
          </div>
        </div>

        <div class="text-xs font-medium mb-2 mt-6 pt-4 border-t border-[color:var(--hairline-2)]">画布默认值（前台画布生图 / 反推库）</div>
        <p class="text-xs text-[color:var(--ink-3)] mb-3">与 Bot 的生图配置相互独立；画布访问控制、品牌与记录在「画布 / 图库」页。</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="画布文生图">
            <ModelPicker capability="image.generate"
              :node-index="Number(config.canvas.imageNodeIndex) || 0" :model="config.canvas.imageModel || ''"
              @update:node-index="config.canvas.imageNodeIndex = $event"
              @update:model="config.canvas.imageModel = $event" />
          </FormField>
          <FormField label="画布图生图 / 改图">
            <ModelPicker capability="image.edit"
              :node-index="Number(config.canvas.editNodeIndex) || 0" :model="config.canvas.editModel || ''"
              @update:node-index="config.canvas.editNodeIndex = $event"
              @update:model="config.canvas.editModel = $event" />
          </FormField>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
          <FormField label="画布改图请求格式" hint="auto 会按模型自动排序">
            <select v-model="config.canvas.imageEditRequestMode" class="input-field">
              <option value="auto">auto</option><option value="json-images">json-images</option>
              <option value="json-image">json-image</option><option value="multipart">multipart</option>
            </select>
          </FormField>
          <FormField label="请求超时 (ms)">
            <input v-model.number="config.canvas.imageTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
          </FormField>
          <FormField label="重试次数">
            <input v-model.number="config.canvas.imageRetryCount" type="number" min="0" max="5" class="input-field" />
          </FormField>
          <FormField label="重试间隔 (ms)">
            <input v-model.number="config.canvas.imageRetryDelayMs" type="number" min="0" step="500" class="input-field" />
          </FormField>
          <FormField label="默认质量">
            <select v-model="config.canvas.defaultQuality" class="input-field">
              <option value="auto">auto</option><option value="low">low</option>
              <option value="medium">medium</option><option value="high">high</option>
            </select>
          </FormField>
          <FormField label="默认格式">
            <select v-model="config.canvas.defaultOutputFormat" class="input-field">
              <option value="png">png</option><option value="jpeg">jpeg</option><option value="webp">webp</option>
            </select>
          </FormField>
          <FormField label="默认数量">
            <select v-model.number="config.canvas.defaultCount" class="input-field">
              <option :value="1">1 张</option><option :value="2">2 张</option><option :value="4">4 张</option>
              <option :value="8">8 张</option><option :value="16">16 张</option>
            </select>
          </FormField>
          <FormField label="历史上限">
            <input v-model.number="config.canvas.maxHistory" type="number" min="1" max="500" class="input-field" />
          </FormField>
          <FormField label="默认尺寸预设">
            <input v-model="config.canvas.defaultSizePresetId" class="input-field font-mono" placeholder="auto" />
          </FormField>
          <FormField label="默认风格预设">
            <input v-model="config.canvas.defaultStylePresetId" class="input-field font-mono" placeholder="none" />
          </FormField>
        </div>
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-5 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-semibold">画布原图反推</span>
              <button class="text-xs hover:underline"
                @click="configStore.resetPrompt('canvas.interrogatePromptTemplate', 'interrogatePromptTemplate')">恢复默认</button>
            </div>
            <ModelPicker capability="interrogate"
              :node-index="Number(config.canvas.interrogateNodeIndex) || 0" :model="config.canvas.interrogateModel || ''"
              @update:node-index="config.canvas.interrogateNodeIndex = $event"
              @update:model="config.canvas.interrogateModel = $event" />
            <input v-model.number="config.canvas.interrogateTimeoutMs" type="number" min="30000" step="30000"
              class="input-field mt-2" placeholder="超时 (ms)" />
            <textarea v-model="config.canvas.interrogatePromptTemplate" rows="6" class="input-field font-mono text-xs mt-2"></textarea>
          </div>
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-semibold">画布模板化反推</span>
              <button class="text-xs hover:underline"
                @click="configStore.resetPrompt('canvas.interrogateTemplatePromptTemplate', 'interrogateTemplatePromptTemplate')">恢复默认</button>
            </div>
            <ModelPicker capability="chat"
              :node-index="Number(config.canvas.interrogateTemplateNodeIndex) || 0" :model="config.canvas.interrogateTemplateModel || ''"
              @update:node-index="config.canvas.interrogateTemplateNodeIndex = $event"
              @update:model="config.canvas.interrogateTemplateModel = $event" />
            <input v-model.number="config.canvas.interrogateTemplateTimeoutMs" type="number" min="30000" step="30000"
              class="input-field mt-2" placeholder="超时 (ms)" />
            <textarea v-model="config.canvas.interrogateTemplatePromptTemplate" rows="6" class="input-field font-mono text-xs mt-2"></textarea>
          </div>
        </div>
      </div>
    </template>
    <template #advanced>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4 pb-4 border-b border-[color:var(--hairline-2)]">
        <FormField v-for="field in modifierFields" :key="field.key" :label="field.label" :hint="field.hint">
          <input v-model="config.bot.commands[field.key]" class="input-field" :placeholder="field.placeholder" />
        </FormField>
      </div>
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
    </template>
  </CapabilityPageLayout>
</template>
