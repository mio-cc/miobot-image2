<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 权限与审批页（治理平面）。
 * 由原 OrchestrationPage 拆出：三态默认值 / 规则矩阵与预览 / 审批中心 / 审计 /
 * 能力目录（逐能力启用与审批开关，写 orch.capabilityOverrides）。
 */

/** 有专属配置页的能力 → 专属路由；其余能力走 /capabilities/:id 自动成页。 */
const CAPABILITY_PAGES: Record<string, string> = {
    'image.generate': '/cap-image',
    'image.edit': '/cap-image',
    'image.interrogate': '/cap-image',
    'image.stitch': '/cap-image',
    'audio.music.generate': '/cap-music',
    'audio.music.history': '/cap-music',
    'audio.music.replay': '/cap-music',
    'audio.music.replace_section': '/cap-music',
    'tts.speak': '/cap-voice',
    'voice.current': '/cap-voice',
    'voice.search': '/cap-voice',
    'voice.preview': '/cap-voice',
    'voice.select': '/cap-voice',
};

function capabilityLink(id: string): string {
    return CAPABILITY_PAGES[id] || `/capabilities/${encodeURIComponent(id)}`;
}

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);

const groupText = ref('');
const hardDenyText = ref('');
const capabilities = ref<any[]>([]);
const approvals = ref<any[]>([]);
const auditRecords = ref<any[]>([]);
const capabilityTestResults = ref<Record<string, any>>({});
const permissionScopes = ['global', 'provider', 'capability', 'role', 'group', 'user'] as const;
const permissionModes = ['allow', 'ask_admin', 'deny'] as const;
const previewUserQq = ref('');
const previewRole = ref('user');
const previewGroupId = ref('');
const previewCapability = ref('image.generate');
const previewProvider = ref('comfyui');
const previewRisk = ref('medium');
const permissionPreview = ref<any>(null);

watch(orch, value => {
    groupText.value = (value?.approval?.allowedGroupIds || []).join(', ');
    hardDenyText.value = (value?.permissions?.hardDenyCapabilities || []).join(', ');
}, { immediate: true, deep: true });

function commitList(field: 'allowedGroupIds', text: string) {
    if (!orch.value?.approval) return;
    orch.value.approval[field] = text.split(/[,，\s]+/).map((x: string) => x.trim()).filter(Boolean);
}

function commitHardDeny(text: string) {
    if (!orch.value?.permissions) return;
    orch.value.permissions.hardDenyCapabilities = text.split(/[,，\s]+/).map((x: string) => x.trim()).filter(Boolean);
}

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

async function decideApproval(item: any, decision: 'approve' | 'reject' | 'cancel') {
    try {
        await client.post('/orchestration/approvals', { code: item.code, decision });
        await loadCapabilities();
    } catch { /* 错误由后端审计日志记录 */ }
}

async function loadCapabilities() {
    try {
        const [capRes, approvalRes, auditRes] = await Promise.all([
            client.get('/orchestration/capabilities'),
            client.get('/orchestration/approvals'),
            client.get('/orchestration/audit'),
        ]);
        capabilities.value = capRes.data?.capabilities || [];
        syncPreviewCapability(previewCapability.value);
        approvals.value = approvalRes.data?.approvals || [];
        auditRecords.value = auditRes.data?.audit || [];
    } catch { capabilities.value = []; approvals.value = []; auditRecords.value = []; }
}

onMounted(loadCapabilities);

watch(previewCapability, syncPreviewCapability);
</script>

<template>
  <div v-if="config && orch">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">权限与审批</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        治理平面：三态默认值、规则矩阵、审批中心、审计记录与能力启停。
      </p>
    </header>

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
    <p class="text-xs text-[color:var(--ink-3)] mb-3 leading-relaxed">审批候选人会排除发起人：单管理员部署时，由该管理员本人发起的高风险操作无人可审。请至少配置两名管理员，或改由 owner 发起。</p>
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
        <FormField label="审批/异常通知管理员 QQ" hint="已与 owner 名单合一，在「对话与触发 → 身份」编辑，保存时双写两处">
          <p class="text-xs text-[color:var(--ink-3)] leading-relaxed pt-1">
            当前：<span class="mono">{{ (orch.approval.adminQqIds || []).join(', ') || '（未设置，回退 owner）' }}</span>
          </p>
        </FormField>
        <FormField label="允许审批的群 ID" hint="逗号分隔；为空表示不限制群，仅校验管理员和审批码">
          <textarea v-model="groupText" @blur="commitList('allowedGroupIds', groupText)" class="input-field font-mono min-h-[70px]" placeholder="1098867961"></textarea>
        </FormField>
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

    <SectionCard title="内置能力目录" hint="来自服务端能力注册表；逐能力启用/审批开关写入 orch.capabilityOverrides" class="mb-4">
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">能力</th><th class="text-left py-2 pr-3">Effect</th><th class="text-left py-2 pr-3">前置上下文</th><th class="text-left py-2 pr-3">副作用</th><th class="text-left py-2 pr-3">Provider</th><th class="text-left py-2 pr-3">版本</th><th class="text-left py-2 pr-3">风险</th><th class="text-left py-2 pr-3">模式</th><th class="text-left py-2 pr-3">健康</th><th class="text-left py-2">审批</th><th class="text-left py-2">状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in capabilities" :key="item.id" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3"><RouterLink :to="capabilityLink(item.id)" class="mono hover:underline">{{ item.id }}</RouterLink><div class="text-[color:var(--ink-3)]">{{ item.name }}</div></td>
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

    <SectionCard title="审计" hint="审批、文件删除、配置和能力测试；密钥已脱敏" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
        <div class="flex items-end"><ToggleField v-model="orch.audit.enabled" label="启用审计" /></div>
        <FormField label="审计保留天数"><input v-model.number="orch.audit.retentionDays" type="number" min="1" class="input-field" /></FormField>
      </div>
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
  </div>
</template>
