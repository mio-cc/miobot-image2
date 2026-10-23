<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);
const plannerCapabilityDescriptionsJson = computed({
    get: () => JSON.stringify(orch.value?.planner?.capabilityDescriptions || {}, null, 2),
    set: (text: string) => {
        try {
            const parsed = JSON.parse(text || '{}');
            if (orch.value?.planner) orch.value.planner.capabilityDescriptions = parsed;
        } catch { /* keep previous valid JSON while editing */ }
    },
});

const adminText = ref('');
const groupText = ref('');
const hardDenyText = ref('');
const externalProvidersText = ref('');
const sunoKeyVisible = ref(false);
const roleKeys = ['planner', 'retriever', 'specialist', 'critic', 'safety', 'composer'] as const;
const capabilities = ref<any[]>([]);
const traces = ref<any[]>([]);
const approvals = ref<any[]>([]);
const pendingJobs = ref<any[]>([]);
const configVersions = ref<any[]>([]);
const auditRecords = ref<any[]>([]);
const memoryActionType = ref<'list' | 'search' | 'clear_group' | 'clear_user' | 'prune'>('list');
const memoryBotId = ref('');
const memoryChatType = ref<'group' | 'private'>('group');
const memoryGroupId = ref('');
const memoryUserId = ref('');
const memoryQuery = ref('');
const memoryActionResult = ref<any>(null);
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
const promptDiff = ref<any[]>([]);
const traceReplay = ref<any>(null);
const capabilityTestResults = ref<Record<string, any>>({});
const promptDiffId = ref('');
const evalVersionId = ref('');
const evalSamples = ref(50);
const evalSuccessRate = ref(0.95);
const evalAverageScore = ref(0.9);
const evalSafetyFailures = ref(0);
const evalOwnerApproved = ref(false);
const evalResult = ref<any>(null);
const permissionScopes = ['global', 'provider', 'capability', 'role', 'group', 'user'] as const;
const permissionModes = ['allow', 'ask_admin', 'deny'] as const;
const previewUserQq = ref('');
const previewRole = ref('user');
const previewGroupId = ref('');
const previewCapability = ref('image.generate');
const previewProvider = ref('comfyui');
const previewRisk = ref('medium');
const permissionPreview = ref<any>(null);

function addPermissionRule() {
    if (!orch.value?.permissions) return;
    orch.value.permissions.rules ||= [];
    orch.value.permissions.rules.push({
        id: 'matrix_rule_' + Date.now(),
        scope: 'global',
        mode: 'allow',
        priority: 0,
        hard: false,
        reason: '后台权限矩阵规则',
    });
}

function removePermissionRule(index: number | string) {
    orch.value?.permissions?.rules?.splice(Number(index), 1);
}

function ruleTarget(rule: any): string {
    if (rule.scope === 'user') return rule.qq || '';
    if (rule.scope === 'group') return rule.groupId || '';
    if (rule.scope === 'role') return (rule.roles || []).join(',');
    if (rule.scope === 'capability') return rule.capability || '';
    if (rule.scope === 'provider') return rule.provider || '';
    return '*';
}

function setRuleTarget(rule: any, value: string) {
    delete rule.qq;
    delete rule.groupId;
    delete rule.roles;
    delete rule.capability;
    delete rule.provider;
    const target = String(value || '').trim();
    if (rule.scope === 'user') rule.qq = target;
    else if (rule.scope === 'group') rule.groupId = target;
    else if (rule.scope === 'role') rule.roles = target.split(/[,，\s]+/).filter(Boolean);
    else if (rule.scope === 'capability') rule.capability = target;
    else if (rule.scope === 'provider') rule.provider = target;
}

function onRuleScopeChange(rule: any) {
    setRuleTarget(rule, '');
}

function onRuleTargetInput(rule: any, event: Event) {
    const target = event.target as HTMLInputElement;
    setRuleTarget(rule, target.value);
}

function onRuleRiskBlur(rule: any, event: Event) {
    const target = event.target as HTMLInputElement;
    setRuleRisks(rule, target.value);
}
function ruleRiskText(rule: any): string {
    return (rule.riskLevels || []).join(',');
}

function setRuleRisks(rule: any, value: string) {
    const allowed = ['low', 'medium', 'high', 'critical'];
    const levels = value.split(/[,，\s]+/).map((item: string) => item.trim()).filter((item: string) => allowed.includes(item));
    if (levels.length) rule.riskLevels = levels;
    else delete rule.riskLevels;
}

function syncPreviewCapability(capabilityId: string) {
    const item = capabilities.value.find((cap) => cap.id === capabilityId);
    if (!item) return;
    previewProvider.value = item.provider || '';
    previewRisk.value = item.riskLevel || 'medium';
}

async function previewPermission() {
    try {
        const res = await client.post('/orchestration/permissions/preview', {
            capability: previewCapability.value,
            userQq: previewUserQq.value,
            role: previewRole.value,
            groupId: previewGroupId.value,
            provider: previewProvider.value,
            riskLevel: previewRisk.value,
        });
        permissionPreview.value = res.data?.preview || null;
    } catch (error: any) {
        permissionPreview.value = { decision: 'error', reason: error?.response?.data?.error || '预览请求失败' };
    }
}

function toggleCapability(item: any, field: 'enabled' | 'approvalRequired') {
    if (!orch.value) return;
    orch.value.capabilityOverrides ||= {};
    const current = orch.value.capabilityOverrides[item.id] || {};
    const next = !item[field];
    orch.value.capabilityOverrides[item.id] = { ...current, [field]: next };
    item[field] = next;
}

function addPromptVersion() {
    if (!orch.value?.promptOptimization) return;
    orch.value.promptOptimization.versions ||= [];
    const id = 'prompt_v_' + Date.now();
    orch.value.promptOptimization.versions.push({
        id,
        name: '候选提示词 ' + id.slice(-6),
        content: '你是 Miobot 的意图理解与任务规划器。只输出严格 JSON IntentPlan，不执行工具，不使用固定关键词路由。',
        status: 'draft',
        createdAt: new Date().toISOString(),
    });
}

async function applyPromptVersion(item: any, mode: 'active' | 'canary' | 'rollback') {
    if (!item?.id) return;
    const saved = await configStore.save();
    if (!saved.ok) return;
    try {
        const endpoint = mode === 'rollback' ? '/orchestration/prompts/rollback' : '/orchestration/prompts/activate';
        await client.post(endpoint, { versionId: item.id, mode: mode === 'canary' ? 'canary' : 'active' });
        await configStore.fetchConfig();
        await loadCapabilities();
    } catch { /* 版本切换失败时保留当前生效版本 */ }
}

async function loadTraceReplay(trace: any) {
    if (!trace?.requestId) return;
    try {
        const res = await client.get('/orchestration/traces/' + encodeURIComponent(trace.requestId));
        traceReplay.value = res.data || null;
    } catch { traceReplay.value = { traces: [], timeline: [] }; }
}

async function runMemoryAction() {
    try {
        memoryActionResult.value = { status: 'queued' };
        const res = await client.post('/orchestration/memory/actions', {
            type: memoryActionType.value,
            botId: memoryBotId.value || undefined,
            chatType: memoryChatType.value,
            groupId: memoryGroupId.value || undefined,
            userId: memoryUserId.value || undefined,
            query: memoryQuery.value || undefined,
        });
        const actionId = String(res.data?.actionId || '');
        if (!actionId) throw new Error('memory action id missing');
        for (let attempt = 0; attempt < 30; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                const result = await client.get('/orchestration/memory/actions/' + encodeURIComponent(actionId));
                if (result.data?.result) { memoryActionResult.value = result.data.result; return; }
            } catch { /* keep polling */ }
        }
        memoryActionResult.value = { status: 'timeout' };
    } catch (error: any) {
        memoryActionResult.value = { status: 'error', error: error?.response?.data?.error || String(error?.message || error) };
    }
}
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
async function testCapability(item: any, mode: 'validate' | 'dry_run' | 'live' = 'validate') {
    try {
        if (mode === 'live' && !window.confirm(`将真实执行能力 ${item.id}，可能产生费用，且测试结果不会发送到 QQ。继续？`)) return;
        capabilityTestResults.value[item.id] = { status: 'queued', detail: `${mode} 已提交` };
        const res = await client.post('/orchestration/capabilities/test', { id: item.id, mode, allowLive: mode === 'live' });
        const testId = String(res.data?.testId || '');
        if (!testId) {
            capabilityTestResults.value[item.id] = res.data?.capability?.health || { status: 'queued', detail: '已提交' };
            return;
        }
        for (let attempt = 0; attempt < 20; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                const result = await client.get(`/orchestration/capabilities/test/${encodeURIComponent(testId)}`);
                const value = result.data?.result;
                if (value) {
                    capabilityTestResults.value[item.id] = {
                        status: value.ok ? 'ok' : 'error',
                        detail: `${value.stage}/${value.result?.status || value.error || ''} (${value.durationMs}ms)`,
                    };
                    return;
                }
            } catch { /* keep polling */ }
        }
        capabilityTestResults.value[item.id] = { status: 'timeout', detail: '测试任务尚未返回' };
    } catch (error: any) {
        capabilityTestResults.value[item.id] = { status: 'error', detail: error?.response?.data?.error || '测试失败' };
    }
}
async function evaluatePromptVersion() {
    if (!evalVersionId.value) return;
    try {
        const res = await client.post('/orchestration/prompts/evaluate', {
            versionId: evalVersionId.value,
            samples: evalSamples.value,
            successRate: evalSuccessRate.value,
            averageScore: evalAverageScore.value,
            safetyFailures: evalSafetyFailures.value,
            ownerApproved: evalOwnerApproved.value,
        });
        evalResult.value = res.data?.decision || null;
        await configStore.fetchConfig();
    } catch { evalResult.value = { promote: false, reason: 'evaluate_failed' }; }
}
async function loadPromptDiff(item: any) {
    if (!item?.id) return;
    try {
        const res = await client.get('/orchestration/prompts/' + encodeURIComponent(item.id) + '/diff');
        promptDiff.value = res.data?.diff || [];
        promptDiffId.value = item.id;
    } catch { promptDiff.value = []; promptDiffId.value = ''; }
}
async function rollbackConfigVersion(version: number) {
    try {
        await client.post('/config/rollback', { version });
        await configStore.fetchConfig();
        await loadCapabilities();
    } catch { /* 回滚失败由后端审计日志记录，保留当前配置 */ }
}
async function decideApproval(item: any, decision: 'approve' | 'reject' | 'cancel') {
    try {
        await client.post('/orchestration/approvals', { code: item.code, decision });
        await loadCapabilities();
    } catch { /* 错误由后端审计日志记录 */ }
}

async function loadCapabilities() {
    try {
        const [capRes, traceRes, approvalRes, jobRes, versionRes, auditRes] = await Promise.all([
            client.get('/orchestration/capabilities'),
            client.get('/orchestration/traces'),
            client.get('/orchestration/approvals'),
            client.get('/orchestration/jobs'),
            client.get('/config/versions'),
            client.get('/orchestration/audit'),
        ]);
        capabilities.value = capRes.data?.capabilities || [];
        syncPreviewCapability(previewCapability.value);
        traces.value = traceRes.data?.traces || [];
        approvals.value = approvalRes.data?.approvals || [];
        pendingJobs.value = jobRes.data?.jobs || [];
        configVersions.value = versionRes.data?.versions || [];
        auditRecords.value = auditRes.data?.audit || [];
    } catch { capabilities.value = []; traces.value = []; approvals.value = []; pendingJobs.value = []; configVersions.value = []; auditRecords.value = []; }
}

onMounted(loadCapabilities);
onMounted(loadComfyWorkflows);

watch(previewCapability, syncPreviewCapability);

watch(orch, value => {
    adminText.value = (value?.approval?.adminQqIds || []).join(', ');
    groupText.value = (value?.approval?.allowedGroupIds || []).join(', ');
    hardDenyText.value = (value?.permissions?.hardDenyCapabilities || []).join(', ');
    externalProvidersText.value = (value?.externalProviders?.allowlist || []).join(', ');
}, { immediate: true, deep: true });

function commitList(field: 'adminQqIds' | 'allowedGroupIds', text: string) {
    if (!orch.value?.approval) return;
    orch.value.approval[field] = text.split(/[,，\s]+/).map((x: string) => x.trim()).filter(Boolean);
}

function commitExternalProviders(text: string) {
    if (!orch.value) return;
    orch.value.externalProviders ||= {};
    orch.value.externalProviders.allowlist = text.split(/[,，\s]+/).map((x: string) => x.trim()).filter(Boolean);
}
function commitHardDeny(text: string) {
    if (!orch.value?.permissions) return;
    orch.value.permissions.hardDenyCapabilities = text.split(/[,，\s]+/).map((x: string) => x.trim()).filter(Boolean);
}
</script>

<template>
  <div v-if="config && orch">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">智能编排</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        三层架构：用户层 → 模型层 → 功能层。默认影子模式，不影响现有消息链路。
      </p>
    </header>

    <SectionCard title="运行模式" hint="先影子比对，再切换到执行模式" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="md:col-span-2">
          <ToggleField v-model="orch.enabled" label="启用智能编排" hint="关闭时继续使用现有 v2 路由" />
        </div>
        <FormField label="模式">
          <select v-model="orch.mode" class="input-field">
            <option value="shadow">shadow 影子模式（只规划，不执行）</option>
            <option value="enforce">enforce 执行模式</option>
          </select>
        </FormField>
        <div class="flex items-end"><ToggleField v-model="orch.externalProviders.enabled" label="启用外部 Provider" hint="默认关闭；仅允许白名单 provider" /></div>
        <FormField label="外部 Provider 白名单" hint="逗号分隔；为空表示允许全部已启用外部 provider">
          <textarea v-model="externalProvidersText" @blur="commitExternalProviders(externalProvidersText)" class="input-field font-mono min-h-[56px]" placeholder="suno-official"></textarea>
        </FormField>        <FormField label="Planner 节点索引">
          <input v-model.number="orch.planner.nodeIndex" type="number" min="0" class="input-field" />
        </FormField>
        <FormField label="Planner 模型">
          <input v-model="orch.planner.model" class="input-field font-mono" placeholder="留空使用节点默认模型" />
        </FormField>
        <div class="flex items-end">
          <ToggleField v-model="orch.planner.enabled" label="启用 Planner" />
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div class="flex items-end"><ToggleField v-model="orch.planner.actionAlignmentGuardEnabled" label="启用意图-行动一致性复核" hint="按能力 effect 检查副作用，不按关键词判断" /></div>
        <FormField label="复核触发置信度阈值" hint="低于该置信度也触发通用复核"><input v-model.number="orch.planner.alignmentGuardConfidenceThreshold" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
          <FormField label="一致性复核 maxTokens" hint="复核模型输出 JSON 的上限；推理模型建议 1200 到 2000"><input v-model.number="orch.planner.alignmentReviewMaxTokens" type="number" min="1" max="200000" step="100" class="input-field" /></FormField>
        <FormField label="Planner 系统提示词" hint="enforce Planner 使用；能力清单自动附加">
          <textarea v-model="orch.planner.systemPromptTemplate" rows="8" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="Planner 用户提示词模板" hint="支持 {{userText}}、{{capabilityManifest}}（兼容 {{capabilityCatalog}}）、{{outputSchema}} 等占位符">
          <textarea v-model="orch.planner.userPromptTemplate" rows="8" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="Help 追加说明" hint="追加到完整帮助文本末尾，可写本实例专属能力" class="md:col-span-2">
          <textarea v-model="orch.help.extraText" rows="4" class="input-field"></textarea>
        </FormField>        <FormField label="能力描述覆盖（JSON）" hint="只覆盖正向说明文字；不要写 notFor 或路由规则，effect、requiredContext、sideEffects 由能力注册表自动生成" class="md:col-span-2">
          <textarea v-model="plannerCapabilityDescriptionsJson" rows="8" class="input-field font-mono text-xs"></textarea>
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="多模型协作" hint="每个角色独立配置节点和模型；未启用时由主 Planner 承担" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <div v-for="role in roleKeys" :key="role" class="border border-[color:var(--hairline-2)] rounded-xl p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold">{{ role }}</span>
            <ToggleField v-model="orch.roles[role].enabled" label="启用" />
          </div>
          <FormField label="节点索引"><input v-model.number="orch.roles[role].nodeIndex" type="number" min="0" class="input-field" /></FormField>
            <FormField label="模型"><input v-model="orch.roles[role].model" class="input-field font-mono" placeholder="留空使用节点默认" /></FormField>
            <FormField label="超时 (ms)" hint="留空使用模型默认"><input v-model.number="orch.roles[role].timeoutMs" type="number" min="1000" step="1000" class="input-field" /></FormField>
            <FormField label="温度" hint="留空使用模型默认；建议 0 到 1"><input v-model.number="orch.roles[role].temperature" type="number" min="0" max="2" step="0.05" class="input-field" /></FormField>
            <FormField label="maxTokens" hint="留空使用模型默认"><input v-model.number="orch.roles[role].maxTokens" type="number" min="1" max="200000" step="100" class="input-field" /></FormField>
            <FormField label="Fallback 节点索引"><input v-model.number="orch.roles[role].fallbackNodeIndex" type="number" min="0" class="input-field" /></FormField>
            <FormField label="Fallback 模型"><input v-model="orch.roles[role].fallbackModel" class="input-field font-mono" placeholder="留空使用同角色模型" /></FormField>
            <FormField label="角色提示词覆盖" hint="留空用内置；支持 {{request}}、{{catalog}}、{{plan}}、{{outputs}}、{{question}}、{{answer}}">
            <textarea v-model="orch.roles[role].promptTemplate" rows="4" class="input-field font-mono text-xs"></textarea>
          </FormField>
        </div>
      </div>
    </SectionCard>

    <SectionCard title="执行预算" hint="防止多步骤、多模型和外部能力失控" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
        <FormField label="最大步骤"><input v-model.number="orch.execution.maxSteps" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大并行步骤"><input v-model.number="orch.execution.maxParallelSteps" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大 DAG 深度"><input v-model.number="orch.execution.maxDepth" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最大时长 (ms)"><input v-model.number="orch.execution.maxDurationMs" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="最大成本"><input v-model.number="orch.execution.maxCost" type="number" min="0" step="0.1" class="input-field" /></FormField>
        <FormField label="最大模型轮数"><input v-model.number="orch.execution.maxModelRounds" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大候选能力 TopK"><input v-model.number="orch.planner.capabilityTopK" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最低置信度"><input v-model.number="orch.planner.minConfidence" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
        <FormField label="失败策略">
          <select v-model="orch.execution.failurePolicy" class="input-field">
            <option value="stop">停止</option><option value="continue">继续</option><option value="ask">询问用户</option>
          </select>
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="三态权限默认值" hint="owner 全权限、admin 高风险审批、普通用户高风险拒绝" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <FormField label="低风险"><select v-model="orch.permissions.defaultLow" class="input-field"><option value="allow">allow</option><option value="ask_admin">ask_admin</option><option value="deny">deny</option></select></FormField>
        <FormField label="中风险"><select v-model="orch.permissions.defaultMedium" class="input-field"><option value="allow">allow</option><option value="ask_admin">ask_admin</option><option value="deny">deny</option></select></FormField>
        <FormField label="高风险"><select v-model="orch.permissions.defaultHigh" class="input-field"><option value="allow">allow</option><option value="ask_admin">ask_admin</option><option value="deny">deny</option></select></FormField>
        <FormField label="严重风险"><select v-model="orch.permissions.defaultCritical" class="input-field"><option value="allow">allow</option><option value="ask_admin">ask_admin</option><option value="deny">deny</option></select></FormField>
      </div>
      <div class="mt-3">
        <ToggleField v-model="orch.permissions.hardDenyEnabled" label="启用系统硬拒绝" hint="保护密钥、审计关闭等不可逆安全操作" />
      </div>
      <div class="mt-3">
        <FormField label="硬拒绝能力 ID" hint="逗号分隔；启用硬拒绝后，这些能力即使 owner allow 也会被拒绝">
          <textarea v-model="hardDenyText" @blur="commitHardDeny(hardDenyText)" class="input-field font-mono min-h-[60px]" placeholder="config.update, permission.update"></textarea>
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="权限规则矩阵" hint="具体用户 > 群 > 角色 > 能力 > provider > 全局；硬拒绝优先于 owner allow，且仅在总开关启用时生效" class="mb-4">
      <div class="flex items-center justify-between mb-3 gap-3">
        <p class="text-xs text-[color:var(--ink-3)]">保存配置后，用下方预览器检查最终命中的三态策略。</p>
        <button class="btn-outline !px-3 !py-1" type="button" @click="addPermissionRule">新增规则</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr>
              <th class="text-left py-2 pr-2">作用域</th>
              <th class="text-left py-2 pr-2">目标</th>
              <th class="text-left py-2 pr-2">三态</th>
              <th class="text-left py-2 pr-2">风险级别</th>
              <th class="text-left py-2 pr-2">优先级</th>
              <th class="text-left py-2 pr-2">硬拒绝</th>
              <th class="text-left py-2 pr-2">原因</th>
              <th class="text-left py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(rule, index) in (orch.permissions.rules || [])" :key="rule.id || index" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-2">
                <select v-model="rule.scope" class="input-field !py-1" @change="onRuleScopeChange(rule)">
                  <option v-for="scope in permissionScopes" :key="scope" :value="scope">{{ scope }}</option>
                </select>
              </td>
              <td class="py-2 pr-2 min-w-[150px]">
                <span v-if="rule.scope === 'global'" class="mono text-[color:var(--ink-3)]">*</span>
                <input v-else :value="ruleTarget(rule)" class="input-field !py-1 font-mono" :placeholder="rule.scope === 'role' ? 'user,admin,owner' : rule.scope + ' ID'" @input="onRuleTargetInput(rule, $event)" />
              </td>
              <td class="py-2 pr-2">
                <select v-model="rule.mode" class="input-field !py-1">
                  <option v-for="mode in permissionModes" :key="mode" :value="mode">{{ mode }}</option>
                </select>
              </td>
              <td class="py-2 pr-2 min-w-[130px]">
                <input :value="ruleRiskText(rule)" class="input-field !py-1 font-mono" placeholder="low,high" @blur="onRuleRiskBlur(rule, $event)" />
              </td>
              <td class="py-2 pr-2 w-[90px]"><input v-model.number="rule.priority" type="number" class="input-field !py-1" /></td>
              <td class="py-2 pr-2">
                <input v-model="rule.hard" type="checkbox" :disabled="!orch.permissions.hardDenyEnabled" />
              </td>
              <td class="py-2 pr-2 min-w-[180px]"><input v-model="rule.reason" class="input-field !py-1" placeholder="命中原因" /></td>
              <td class="py-2"><button class="btn-outline !px-2 !py-1" type="button" @click="removePermissionRule(index)">删除</button></td>
            </tr>
            <tr v-if="!(orch.permissions.rules || []).length"><td colspan="8" class="py-3 text-[color:var(--ink-3)]">暂无自定义权限规则，使用上方默认三态基线。</td></tr>
          </tbody>
        </table>
      </div>
      <div class="mt-4 border-t border-[color:var(--hairline-2)] pt-4">
        <h3 class="text-sm font-semibold mb-3">最终策略预览</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <FormField label="用户 QQ"><input v-model="previewUserQq" class="input-field font-mono" placeholder="可选" /></FormField>
          <FormField label="角色"><select v-model="previewRole" class="input-field"><option value="guest">guest</option><option value="user">user</option><option value="admin">admin</option><option value="owner">owner</option></select></FormField>
          <FormField label="群 ID"><input v-model="previewGroupId" class="input-field font-mono" placeholder="私聊留空" /></FormField>
          <FormField label="能力"><select v-model="previewCapability" class="input-field"><option v-for="cap in capabilities" :key="cap.id" :value="cap.id">{{ cap.id }}</option></select></FormField>
          <FormField label="Provider"><input v-model="previewProvider" class="input-field font-mono" /></FormField>
          <FormField label="风险级别"><select v-model="previewRisk" class="input-field"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="critical">critical</option></select></FormField>
        </div>
        <div class="flex items-center gap-3 mt-3">
          <button class="btn-primary !px-3 !py-1" type="button" @click="previewPermission">预览最终策略</button>
          <span v-if="permissionPreview" class="text-xs">
            结果：<strong class="mono">{{ permissionPreview.decision }}</strong>
            <span class="text-[color:var(--ink-3)]">命中 {{ permissionPreview.matchedRule || 'fallback' }}；{{ permissionPreview.reason }}</span>
            <span v-if="permissionPreview.hardDenied" class="text-rose-500 ml-2">硬拒绝优先</span>
          </span>
        </div>
      </div>
    </SectionCard>
    <SectionCard title="管理员审批" hint="高风险动作私聊或群内发送给管理员，超时默认拒绝" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.approval.enabled" label="启用审批" /></div>
        <FormField label="Quorum">
          <select v-model="orch.approval.quorum" class="input-field">
            <option value="any">任一管理员</option><option value="all">全部管理员</option><option value="owner">仅 owner</option>
          </select>
        </FormField>
        <FormField label="超时 (ms)"><input v-model.number="orch.approval.timeoutMs" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="超时处理">
          <select v-model="orch.approval.fallback" class="input-field"><option value="deny">拒绝</option><option value="cancel">取消</option></select>
        </FormField>
        <FormField label="最大待审批/用户"><input v-model.number="orch.approval.maxPendingPerUser" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大待审批/全局"><input v-model.number="orch.approval.maxPendingGlobal" type="number" min="1" class="input-field" /></FormField>
        <FormField label="审批重发间隔 (ms)"><input v-model.number="orch.approval.resendIntervalMs" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="最大重发次数"><input v-model.number="orch.approval.maxResend" type="number" min="0" class="input-field" /></FormField>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.approval.allowGroupReply" label="允许群内审批回复" /></div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <FormField label="审批/异常通知管理员 QQ" hint="逗号分隔；审批和所有运行异常都私聊这些管理员，不再回复用户；留空时回退 owner">
          <textarea v-model="adminText" @blur="commitList('adminQqIds', adminText)" class="input-field font-mono min-h-[70px]" placeholder="10001, 10002"></textarea>
        </FormField>
        <FormField label="允许审批的群 ID" hint="逗号分隔；为空表示不限制群，仅校验管理员和审批码">
          <textarea v-model="groupText" @blur="commitList('allowedGroupIds', groupText)" class="input-field font-mono min-h-[70px]" placeholder="1098867961"></textarea>
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="结果与消息预算" hint="优先嵌套合并转发；文件和语音按不可合并处理；默认最多 3 条" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <FormField label="最大结果数"><input v-model.number="orch.reply.maxResultItems" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大消息数"><input v-model.number="orch.reply.maxMessages" type="number" min="1" max="20" class="input-field" /></FormField>
        <FormField label="嵌套最大节点数"><input v-model.number="orch.reply.nestedMaxNodes" type="number" min="1" class="input-field" /></FormField>
        <FormField label="嵌套最大深度"><input v-model.number="orch.reply.nestedMaxDepth" type="number" min="1" max="5" class="input-field" /></FormField>
        <FormField label="超出预算">
          <select v-model="orch.reply.overflowPolicy" class="input-field">
            <option value="truncate">截断</option><option value="link">链接</option><option value="zip">ZIP</option><option value="reject">拒绝</option>
          </select>
        </FormField>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.reply.preferNestedForward" label="优先嵌套合并转发" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.reply.countProgressInBudget" label="进度消息计入预算" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.reply.includeTruncationNotice" label="显示截断说明" /></div>
      </div>
    </SectionCard>

    <SectionCard title="ComfyUI 工作流" hint="模型只增强画面提示词；steps、CFG、采样器、尺寸、LoRA 等全部由这里保存的 workflow/defaults 决定" class="mb-4">
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
        <FormField label="输出节点 ID"><input v-model="comfyOutputNodeId" class="input-field font-mono" placeholder="16" /></FormField>        <FormField label="Fallback Profile"><input v-model="comfyFallbackProfileId" class="input-field font-mono" placeholder="同 id 使用内置 baseline" /></FormField>
        <div class="flex items-end"><ToggleField v-model="comfyFallbackEnabled" label="失败自动切 baseline" /></div>
        <div class="flex items-end"><ToggleField v-model="comfySkipFaceDetailer" label="跳过 FaceDetailer 脸修" hint="仍保留放大，直接接 VAEDecode 输出" /></div>
        <FormField label="正向提示词节点 ID"><input v-model="comfyPromptNodeIds" class="input-field font-mono" placeholder="5, 13" /></FormField>
        <FormField label="负向提示词节点 ID"><input v-model="comfyNegativePromptNodeIds" class="input-field font-mono" placeholder="6" /></FormField>
        <div class="flex items-end gap-2 xl:col-span-3">
          <button class="btn-outline" type="button" @click="loadComfyWorkflowProfile()">加载</button>
          <button class="btn-outline" type="button" @click="newComfyWorkflowProfile">新建</button>
          <button class="btn-primary" type="button" @click="saveComfyWorkflowProfile">校验并保存</button>          <button class="btn-outline" type="button" @click="restoreComfyBaseline">恢复内置基线</button>
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
      </div>      <div v-if="comfyWorkflowValidation" class="mt-3 text-xs">
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
    <SectionCard title="记忆管理" hint="管理员检索、清理和压缩 Orama 物理索引；清理群会同时删除该群的 personal 索引" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <FormField label="操作">
          <select v-model="memoryActionType" class="input-field"><option value="list">列出 namespace</option><option value="search">检索测试</option><option value="clear_group">清理群记忆</option><option value="clear_user">清理用户记忆</option><option value="prune">执行 retention 清理</option></select>
        </FormField>
        <FormField label="Bot QQ"><input v-model="memoryBotId" class="input-field font-mono" placeholder="默认当前 bot" /></FormField>
        <FormField label="会话类型"><select v-model="memoryChatType" class="input-field"><option value="group">群聊</option><option value="private">私聊</option></select></FormField>
        <FormField label="群号"><input v-model="memoryGroupId" class="input-field font-mono" /></FormField>
        <FormField label="用户 QQ"><input v-model="memoryUserId" class="input-field font-mono" /></FormField>
        <FormField label="检索语义"><input v-model="memoryQuery" class="input-field" placeholder="例如：和泉纱雾海报" /></FormField>
        <div class="flex items-end"><button class="btn-primary" type="button" @click="runMemoryAction">执行</button></div>
      </div>
      <pre v-if="memoryActionResult" class="mt-3 text-xs bg-black/20 p-3 rounded max-h-[260px] overflow-auto">{{ JSON.stringify(memoryActionResult, null, 2) }}</pre>
    </SectionCard>
    <SectionCard title="FishAudio 音色自助" hint="用户候选短期保存；个人偏好按群/私聊隔离" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.voice.enabled" label="启用音色管理" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.voice.userCanChange" label="允许用户修改音色" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.voice.licensedOnly" label="只展示已授权音色" /></div>
        <FormField label="允许场景">
          <select v-model="orch.voice.allowedScopes" class="input-field"><option value="both">私聊和群聊</option><option value="private">仅私聊</option><option value="group">仅群聊</option></select>
        </FormField>
        <FormField label="最大候选数"><input v-model.number="orch.voice.maxCandidates" type="number" min="1" max="10" class="input-field" /></FormField>
        <FormField label="候选有效期 (ms)"><input v-model.number="orch.voice.candidateTtlMs" type="number" min="60000" class="input-field" /></FormField>
        <FormField label="试听冷却 (ms)"><input v-model.number="orch.voice.previewCooldownMs" type="number" min="0" class="input-field" /></FormField>
        <FormField label="每日试听上限"><input v-model.number="orch.voice.previewDailyLimit" type="number" min="0" class="input-field" /></FormField>
        <FormField label="试听文本上限"><input v-model.number="orch.voice.previewMaxChars" type="number" min="1" max="200" class="input-field" /></FormField>
        <FormField label="FishAudio 音色 API"><input v-model="orch.voice.voicesApiUrl" class="input-field font-mono" placeholder="https://api.fish.audio/model" /></FormField>
      </div>
    </SectionCard>
    <SectionCard title="向量记忆" hint="Orama 本地索引；群聊、私聊、用户按物理 namespace 隔离" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.enabled" label="启用长期记忆" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.autoIngest" label="自动写入消息" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.hybridSearch" label="向量 + 全文混合检索" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.userGlobalProfileEnabled" label="允许跨群用户画像" hint="默认关闭，保持群隔离" /></div>
        <FormField label="Embedding 节点索引"><input v-model.number="orch.memory.embeddingNodeIndex" type="number" min="0" class="input-field" /></FormField>
        <FormField label="Embedding 模型"><input v-model="orch.memory.embeddingModel" class="input-field font-mono" placeholder="text-embedding-3-small" /></FormField>
        <FormField label="向量维度"><input v-model.number="orch.memory.embeddingDimensions" type="number" min="1" class="input-field" /></FormField>
        <FormField label="语义 TopK"><input v-model.number="orch.memory.topK" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最低分数"><input v-model.number="orch.memory.minScore" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
        <FormField label="最近工作集条数"><input v-model.number="orch.memory.recentTurns" type="number" min="0" max="20" class="input-field" /></FormField>
        <FormField label="最大上下文字符"><input v-model.number="orch.memory.maxContextChars" type="number" min="200" class="input-field" /></FormField>
        <FormField label="保留天数"><input v-model.number="orch.memory.retentionDays" type="number" min="1" class="input-field" /></FormField>
        <FormField label="摘要间隔" hint="预留滚动摘要阈值"><input v-model.number="orch.memory.summarizeEvery" type="number" min="2" class="input-field" /></FormField>
        <FormField label="数据目录" hint="留空使用 bot dataDir/memory"><input v-model="orch.memory.dataDir" class="input-field font-mono" /></FormField>
      </div>
    </SectionCard>
    <SectionCard title="Suno 官方 API" hint="不内置计费；保留超时、队列、配额和停用开关" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.suno.enabled" label="启用 Suno" /></div>
        <FormField label="Provider"><input v-model="orch.suno.provider" class="input-field font-mono" readonly /></FormField>
        <FormField label="API 版本"><select v-model="orch.suno.requestMode" class="input-field"><option value="v6">SunoAPI V6</option><option value="legacy">Legacy Poll API</option></select></FormField>
        <FormField label="Callback URL" hint="V6 创建任务必填；完整地址需包含 /api/orchestration/suno/callback/&lt;Callback Secret&gt;"><input v-model="orch.suno.callbackUrl" class="input-field font-mono" placeholder="https://bot.example/api/orchestration/suno/callback/&lt;secret&gt;" /></FormField>
        <FormField label="Callback Secret" hint="用于校验回调；留空则 V6 回调不可用"><input v-model="orch.suno.callbackSecret" type="password" class="input-field font-mono" /></FormField>
        <FormField label="Composer 节点"><input v-model.number="orch.suno.composerNodeIndex" type="number" min="0" class="input-field" /></FormField>
        <FormField label="Composer 模型"><input v-model="orch.suno.composerModel" class="input-field font-mono" placeholder="deepseek-flash" /></FormField>
        <FormField label="Composer 温度" hint="建议 0.3 到 0.8"><input v-model.number="orch.suno.composerTemperature" type="number" min="0" max="2" step="0.05" class="input-field" /></FormField>
        <FormField label="Composer maxTokens" hint="生成歌词和 JSON 的上限；复杂完整歌词建议 6000 以上"><input v-model.number="orch.suno.composerMaxTokens" type="number" min="1" max="200000" step="100" class="input-field" /></FormField>
        <FormField label="Composer 覆盖提示词" hint="留空使用内置 Suno V2；可用 {{userText}}、{{supplied}}、{{schema}}、{{model}}、{{defaultVocalGender}}、{{defaultLanguage}}">
          <textarea v-model="orch.suno.composerPromptTemplate" rows="5" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="默认人声性别" hint="auto 由模型决定；m/f 仅在 customMode 下传给 Suno，且官方说明只是偏好、不保证命中"><select v-model="orch.suno.defaultVocalGender" class="input-field"><option value="auto">auto / 不指定</option><option value="m">男声 m</option><option value="f">女声 f</option></select></FormField>
        <FormField label="默认歌词语言" hint="留空或 auto 跟随用户；例如 中文、日语、English。Suno 没有独立 language 字段，会写入 prompt/style/lyrics"><input v-model="orch.suno.defaultLanguage" class="input-field" placeholder="auto" /></FormField>
        <div class="flex items-end"><ToggleField v-model="orch.suno.sendLyricsWithMusic" label="同步发送歌词" hint="使用 Suno 返回的真实 lyrics，走合并转发；需要 reply.maxMessages ≥ 2" /></div>
        <FormField label="歌曲历史保留" hint="每个会话/用户最多保留多少首"><input v-model.number="orch.suno.historyMaxRecords" type="number" min="1" max="1000" class="input-field" /></FormField>
        <FormField label="Planner 注入历史" hint="每次规划注入最近多少首歌曲摘要"><input v-model.number="orch.suno.historyPromptLimit" type="number" min="1" max="50" class="input-field" /></FormField>
        <FormField label="Base URL"><input v-model="orch.suno.baseUrl" class="input-field font-mono" placeholder="https://官方 API 地址" /></FormField>
        <FormField label="模型"><input v-model="orch.suno.model" class="input-field font-mono" /></FormField>
        <FormField label="创建路径"><input v-model="orch.suno.createPath" class="input-field font-mono" placeholder="/api/v1/generate" /></FormField>
        <FormField label="状态路径"><input v-model="orch.suno.statusPath" class="input-field font-mono" placeholder="/api/v1/generate/record-info?taskId={id}" /></FormField>
        <FormField label="鉴权 Header"><input v-model="orch.suno.authHeader" class="input-field font-mono" placeholder="Authorization" /></FormField>
        <FormField label="鉴权前缀"><input v-model="orch.suno.authPrefix" class="input-field font-mono" placeholder="Bearer " /></FormField>
        <FormField label="API Key" hint="留遮罩值表示不修改">
          <div class="flex gap-2">
            <input v-model="orch.suno.apiKey" :type="sunoKeyVisible ? 'text' : 'password'" class="input-field font-mono" />
            <button class="btn-outline !px-2" type="button" @click="sunoKeyVisible = !sunoKeyVisible">{{ sunoKeyVisible ? '隐藏' : '显示' }}</button>
          </div>
        </FormField>
        <FormField label="超时 (ms)"><input v-model.number="orch.suno.timeoutMs" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="轮询间隔 (ms)"><input v-model.number="orch.suno.pollIntervalMs" type="number" min="500" class="input-field" /></FormField>
        <FormField label="最大时长 (秒)"><input v-model.number="orch.suno.maxDurationSeconds" type="number" min="5" class="input-field" /></FormField>
        <FormField label="格式"><select v-model="orch.suno.format" class="input-field"><option value="mp3">mp3</option><option value="wav">wav</option><option value="flac">flac</option></select></FormField>
        <FormField label="最大并发"><input v-model.number="orch.suno.maxConcurrent" type="number" min="1" class="input-field" /></FormField>
        <FormField label="队列上限"><input v-model.number="orch.suno.maxQueue" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大重试"><input v-model.number="orch.suno.maxRetries" type="number" min="0" max="10" class="input-field" /></FormField>
        <FormField label="每日配额"><input v-model.number="orch.suno.quotaPerUserPerDay" type="number" min="0" class="input-field" /></FormField>
      </div>
    </SectionCard>

    <SectionCard title="提示词优化与审计" hint="系统提示词修改必须评估、灰度和审批" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="xl:col-span-1"><ToggleField v-model="orch.promptOptimization.enabled" label="启用自动优化" /></div>
        <FormField label="优化范围"><select v-model="orch.promptOptimization.scope" class="input-field"><option value="task">任务级</option><option value="all">全部</option></select></FormField>
        <FormField label="Canary 百分比"><input v-model.number="orch.promptOptimization.canaryPercent" type="number" min="0" max="100" class="input-field" /></FormField>
        <FormField label="最低样本数"><input v-model.number="orch.promptOptimization.minSamples" type="number" min="1" class="input-field" /></FormField>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.promptOptimization.requireOwnerApproval" label="系统提示词需要 owner 审批" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.audit.enabled" label="启用审计" /></div>
        <FormField label="审计保留天数"><input v-model.number="orch.audit.retentionDays" type="number" min="1" class="input-field" /></FormField>
      </div>
    </SectionCard>
    <SectionCard title="提示词版本 / 差异 / 回滚" hint="保存版本后可设置 active 或 canary；切换会写入配置版本审计并热重载" class="mb-4">
      <div class="flex items-center justify-between mb-3 gap-3">
        <p class="text-xs text-[color:var(--ink-3)]">Active: <span class="mono">{{ orch.promptOptimization.activeVersionId || '未设置' }}</span>；Canary: <span class="mono">{{ orch.promptOptimization.canaryVersionId || '未设置' }}</span></p>
        <button class="btn-outline !px-3 !py-1" type="button" @click="addPromptVersion">新增候选版本</button>
      </div>
      <div class="space-y-3">
        <div v-for="item in (orch.promptOptimization.versions || [])" :key="item.id" class="border border-[color:var(--hairline-2)] rounded-xl p-3 space-y-2">
          <div class="grid grid-cols-1 md:grid-cols-4 gap-2">
            <FormField label="版本 ID"><input v-model="item.id" class="input-field font-mono !py-1" /></FormField>
            <FormField label="名称"><input v-model="item.name" class="input-field !py-1" /></FormField>
            <FormField label="状态"><select v-model="item.status" class="input-field !py-1"><option value="draft">draft</option><option value="canary">canary</option><option value="active">active</option><option value="retired">retired</option></select></FormField>
            <div class="flex items-end gap-2">
              <button class="btn-outline !px-2 !py-1" type="button" @click="loadPromptDiff(item)">查看差异</button>
              <button class="btn-outline !px-2 !py-1" type="button" @click="applyPromptVersion(item, 'canary')">保存并设为 Canary</button>
              <button class="btn-outline !px-2 !py-1" type="button" @click="applyPromptVersion(item, 'active')">保存并启用</button>
              <button class="btn-outline !px-2 !py-1" type="button" @click="applyPromptVersion(item, 'rollback')">回滚到此版本</button>
            </div>
          </div>
          <textarea v-model="item.content" class="input-field font-mono min-h-[120px]" placeholder="Planner 系统提示词内容"></textarea>
          <div v-if="promptDiffId === item.id" class="mt-2 rounded-lg bg-[color:var(--surface-2)] p-2 max-h-[260px] overflow-auto">
            <div v-for="(line, index) in promptDiff" :key="index" :class="line.type === 'add' ? 'text-emerald-500' : line.type === 'remove' ? 'text-rose-500' : 'text-[color:var(--ink-3)]'" class="font-mono text-xs whitespace-pre-wrap">{{ line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ' }}{{ line.text }}</div>
          </div>
        </div>
        <p v-if="!(orch.promptOptimization.versions || []).length" class="text-xs text-[color:var(--ink-3)]">暂无提示词版本；新增后先保存配置，再启用或设置 Canary。</p>        <div class="border-t border-[color:var(--hairline-2)] pt-3 mt-3">
          <h3 class="text-sm font-semibold mb-2">候选版本评估</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-2">
            <FormField label="版本"><select v-model="evalVersionId" class="input-field"><option value="">请选择</option><option v-for="item in (orch.promptOptimization.versions || [])" :key="item.id" :value="item.id">{{ item.id }}</option></select></FormField>
            <FormField label="样本数"><input v-model.number="evalSamples" type="number" min="0" class="input-field" /></FormField>
            <FormField label="成功率"><input v-model.number="evalSuccessRate" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
            <FormField label="平均分"><input v-model.number="evalAverageScore" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
            <FormField label="安全失败数"><input v-model.number="evalSafetyFailures" type="number" min="0" class="input-field" /></FormField>
            <div class="flex items-end gap-2"><ToggleField v-model="evalOwnerApproved" label="owner 已确认" /><button class="btn-primary !px-2 !py-1" type="button" @click="evaluatePromptVersion">评估</button></div>
          </div>
          <p v-if="evalResult" class="text-xs mt-2">评估结果：<strong>{{ evalResult.promote ? '通过' : '未通过' }}</strong>，{{ evalResult.reason }}</p>
        </div>
      </div>
    </SectionCard>
    <SectionCard title="待补全任务" hint="规划器追问后保存的 pendingJob；用户下一条消息会自动合并补充信息并重新规划" class="mb-4">
      <div class="overflow-x-auto max-h-[280px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">会话</th><th class="text-left py-2 pr-3">原始请求</th><th class="text-left py-2 pr-3">提问</th><th class="text-left py-2 pr-3">过期时间</th><th class="text-left py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="job in pendingJobs" :key="job.key" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono">{{ job.key }}</td>
              <td class="py-2 pr-3 max-w-[360px] truncate">{{ job.originalText }}</td>
              <td class="py-2 pr-3 max-w-[360px] truncate">{{ job.question }}</td>
              <td class="py-2">{{ String(job.expiresAt || '').slice(0, 19).replace('T', ' ') }}</td>
            </tr>
            <tr v-if="!pendingJobs.length"><td colspan="4" class="py-3 text-[color:var(--ink-3)]">暂无待补全任务</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>

    <SectionCard title="审批中心" hint="最近审批请求；持久化在 bot 数据目录，重启后可恢复查看" class="mb-4">
      <div class="overflow-x-auto max-h-[300px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">审批码</th><th class="text-left py-2 pr-3">能力</th><th class="text-left py-2 pr-3">请求者</th><th class="text-left py-2 pr-3">状态</th><th class="text-left py-2">过期时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in [...approvals].reverse().slice(0, 30)" :key="item.approvalId" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono">{{ item.code }}</td>
              <td class="py-2 pr-3 mono">{{ item.capability }}</td>
              <td class="py-2 pr-3">{{ item.requesterQq }}</td>
              <td class="py-2 pr-3">{{ item.status }}</td>
              <td class="py-2 pr-3">{{ String(item.expiresAt || '').slice(0, 19).replace('T', ' ') }}</td>
              <td class="py-2 space-x-1 whitespace-nowrap">
                <template v-if="item.status === 'pending'">
                  <button class="btn-outline !px-2 !py-1" type="button" @click="decideApproval(item, 'approve')">同意</button>
                  <button class="btn-outline !px-2 !py-1" type="button" @click="decideApproval(item, 'reject')">拒绝</button>
                  <button class="btn-outline !px-2 !py-1" type="button" @click="decideApproval(item, 'cancel')">取消</button>
                </template>
                <span v-else class="text-[color:var(--ink-3)]">{{ item.status }}</span>
              </td>
            </tr>
            <tr v-if="!approvals.length"><td colspan="6" class="py-3 text-[color:var(--ink-3)]">暂无审批记录</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>

    <SectionCard title="审计记录" hint="审批、文件删除、配置和能力测试；密钥已脱敏" class="mb-4">
      <div class="overflow-x-auto max-h-[320px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">时间</th><th class="text-left py-2 pr-3">类型</th><th class="text-left py-2 pr-3">操作者</th><th class="text-left py-2 pr-3">能力</th><th class="text-left py-2 pr-3">结果</th><th class="text-left py-2 pr-3">原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in [...auditRecords].reverse()" :key="item.id || item.timestamp" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono whitespace-nowrap">{{ String(item.timestamp || '').slice(11, 19) }}</td>
              <td class="py-2 pr-3 mono">{{ item.type }}</td>
              <td class="py-2 pr-3">{{ item.actor || '-' }}</td>
              <td class="py-2 pr-3">{{ item.capability || '-' }}</td>
              <td class="py-2 pr-3">{{ item.decision || '-' }}</td>
              <td class="py-2 pr-3 text-[color:var(--ink-3)]">{{ item.reason || '-' }}</td>
            </tr>
            <tr v-if="!auditRecords.length"><td colspan="6" class="py-3 text-[color:var(--ink-3)]">暂无审计记录</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>
    <SectionCard title="配置版本与回滚" hint="每次保存记录变更路径与版本快照；回滚会重新校验、热重载并写入审计" class="mb-4">
      <div class="overflow-x-auto max-h-[280px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">版本</th><th class="text-left py-2 pr-3">保存时间</th><th class="text-left py-2 pr-3">变更路径</th><th class="text-left py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in [...configVersions].reverse()" :key="item.version" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono">v{{ item.version }} / rev {{ item.revision }}</td>
              <td class="py-2 pr-3">{{ String(item.savedAt || '').slice(0, 19).replace('T', ' ') }}</td>
              <td class="py-2 pr-3 max-w-[520px] truncate">{{ (item.changedPaths || []).join(', ') || '初始配置' }}</td>
              <td class="py-2">
                <span v-if="item.current" class="text-[color:var(--ink-3)]">当前</span>
                <button v-else class="btn-outline !px-2 !py-1" type="button" @click="rollbackConfigVersion(item.version)">回滚</button>
              </td>
            </tr>
            <tr v-if="!configVersions.length"><td colspan="4" class="py-3 text-[color:var(--ink-3)]">暂无版本记录</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>
    <SectionCard title="最近编排追踪" hint="来自 bot 进程写入的 JSONL trace；用于定位规划、权限、执行和回复问题" class="mb-4">
      <div class="overflow-x-auto max-h-[360px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">时间</th><th class="text-left py-2 pr-3">请求</th><th class="text-left py-2 pr-3">阶段</th><th class="text-left py-2 pr-3">摘要</th><th class="text-left py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="trace in [...traces].reverse()" :key="trace.id" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono whitespace-nowrap">{{ String(trace.timestamp || '').slice(11, 19) }}</td>
              <td class="py-2 pr-3 mono">{{ trace.requestId }}</td>
              <td class="py-2 pr-3">{{ trace.stage }}</td>
              <td class="py-2 pr-3">{{ trace.summary }}</td>
              <td class="py-2"><button class="btn-outline !px-2 !py-1" type="button" @click="loadTraceReplay(trace)">回放</button></td>
            </tr>
            <tr v-if="!traces.length"><td colspan="5" class="py-3 text-[color:var(--ink-3)]">暂无编排追踪</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="traceReplay" class="mt-3 border-t border-[color:var(--hairline-2)] pt-3 max-h-[320px] overflow-auto">
        <p class="text-xs mb-2">Trace 回放：<span class="mono">{{ traceReplay.requestId }}</span>（只读，不重新执行）</p>
        <div v-for="(item, index) in traceReplay.timeline || []" :key="index" class="text-xs py-1 border-b border-[color:var(--hairline-2)]/40">
          <span class="mono text-[color:var(--ink-3)]">{{ String(item.at || '').slice(11, 19) }}</span>
          <strong class="mx-2">{{ item.stage }}</strong>{{ item.summary }}
        </div>
      </div>
    </SectionCard>

    <SectionCard title="内置能力目录" hint="来自服务端能力注册表；后续可在此接入启用、健康检查和市场安装" class="mb-4">
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">能力</th><th class="text-left py-2 pr-3">Effect</th><th class="text-left py-2 pr-3">前置上下文</th><th class="text-left py-2 pr-3">副作用</th><th class="text-left py-2 pr-3">Provider</th><th class="text-left py-2 pr-3">版本</th><th class="text-left py-2 pr-3">风险</th><th class="text-left py-2 pr-3">模式</th><th class="text-left py-2 pr-3">健康</th><th class="text-left py-2">审批</th><th class="text-left py-2">状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in capabilities" :key="item.id" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3"><span class="mono">{{ item.id }}</span><div class="text-[color:var(--ink-3)]">{{ item.name }}</div></td>
              <td class="py-2 pr-3 mono">{{ item.effect || 'unknown' }}</td>
              <td class="py-2 pr-3 mono">{{ (item.requiredContext || []).join('/') || '-' }}</td>
              <td class="py-2 pr-3 mono">{{ (item.sideEffects || []).join('/') || '-' }}</td>
              <td class="py-2 pr-3 mono">{{ item.provider }}</td>
              <td class="py-2 pr-3 mono">{{ item.version || '-' }}</td>
              <td class="py-2 pr-3">{{ item.riskLevel || 'medium' }}</td>
              <td class="py-2 pr-3">{{ item.mode || 'sync' }}</td>
              <td class="py-2 pr-3"><span :class="item.health?.status === 'ok' ? 'text-emerald-500' : item.health?.status === 'disabled' ? 'text-amber-500' : 'text-rose-500'">{{ item.health?.status || 'unknown' }}</span><div class="text-[color:var(--ink-3)]">{{ item.health?.detail }}</div></td>
              <td class="py-2"><button class="btn-outline !px-2 !py-1" type="button" @click="toggleCapability(item, 'approvalRequired')">{{ item.approvalRequired ? '需要' : '否' }}</button></td>
              <td class="py-2 space-y-1"><button class="btn-outline !px-2 !py-1" type="button" @click="toggleCapability(item, 'enabled')">{{ item.enabled ? '启用' : '停用' }}</button><div class="flex flex-wrap gap-1"><button class="btn-outline !px-2 !py-1" type="button" @click="testCapability(item, 'validate')">校验</button><button class="btn-outline !px-2 !py-1" type="button" @click="testCapability(item, 'dry_run')">干跑</button><button class="btn-outline !px-2 !py-1" type="button" @click="testCapability(item, 'live')">实跑</button></div><div v-if="capabilityTestResults[item.id]" class="text-[color:var(--ink-3)]">{{ capabilityTestResults[item.id].status }}: {{ capabilityTestResults[item.id].detail }}</div></td>
            </tr>
            <tr v-if="!capabilities.length"><td colspan="11" class="py-3 text-[color:var(--ink-3)]">暂无能力目录数据</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>
  </div>
</template>
