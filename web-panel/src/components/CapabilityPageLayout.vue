<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from './SectionCard.vue';
import FormField from './FormField.vue';
import ToggleField from './ToggleField.vue';

/**
 * 能力页统一骨架（§2.6.3）：状态头 / 启用与配额 / 模型与节点 / 提示词 /
 * 高级参数 / 能力测试。新增能力 = 挂路由 + 按骨架填卡，与能力注册表同构。
 *
 * - 状态头总开关写 orch.capabilityOverrides（能力注册表），与 /permissions
 *   目录页是同一份配置；
 * - 卡1 编辑 bot.features[featureId]（FeatureGate 消息入口配额，C6）；
 * - 卡5 复用 /orchestration/capabilities/test 三档测试；
 * - 模型/提示词/高级参数三个槽位由各能力页填充，未填的卡自动隐藏。
 */

const props = withDefaults(defineProps<{
    /** 能力注册表 id，如 image.generate；状态头与测试卡绑定它。 */
    capabilityId: string;
    /** 页面标题；留空用注册表 name/id。 */
    title?: string;
    subtitle?: string;
    /** bot.features 键；不传则不渲染配额卡。 */
    featureId?: string;
    modelsTitle?: string;
    promptsTitle?: string;
    advancedTitle?: string;
}>(), {
    title: '',
    subtitle: '',
    featureId: '',
    modelsTitle: '模型与节点',
    promptsTitle: '提示词',
    advancedTitle: '高级参数',
});

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);

/** 注册表里该能力的实时状态（含 override 解析结果与健康度）。 */
const capability = ref<any>(null);

const pageTitle = computed(() => props.title || capability.value?.name || props.capabilityId);

/* ── 状态头：总开关（orch.capabilityOverrides） ─────────────── */

const healthClass = computed(() => {
    const status = String(capability.value?.health?.status || '');
    return status === 'ok' ? 'dot-good' : status === 'disabled' ? 'dot-warn' : 'dot-crit';
});

function toggleRegistryEnabled() {
    if (!orch.value) return;
    orch.value.capabilityOverrides ||= {};
    const current = orch.value.capabilityOverrides[props.capabilityId] || {};
    const next = !(capability.value?.enabled ?? true);
    orch.value.capabilityOverrides[props.capabilityId] = { ...current, enabled: next };
    if (capability.value) capability.value.enabled = next;
}

function toggleRegistryApproval() {
    if (!orch.value) return;
    orch.value.capabilityOverrides ||= {};
    const current = orch.value.capabilityOverrides[props.capabilityId] || {};
    const next = !(capability.value?.approvalRequired ?? false);
    orch.value.capabilityOverrides[props.capabilityId] = { ...current, approvalRequired: next };
    if (capability.value) capability.value.approvalRequired = next;
}

/* ── 卡1：启用与配额（bot.features，FeatureGate） ───────────── */

interface LimitField { key: string; label: string; min: number; max: number; default: number; unit?: string }

const featureDef = ref<any>(null);
const commonLimitFields = ref<LimitField[]>([]);

const ACTIVATION_OPTIONS = [
    { value: 'direct', label: '群里直接触发' },
    { value: 'mention', label: '必须 @机器人' },
    { value: 'reply', label: '必须回复机器人' },
    { value: 'mention-or-reply', label: '@ 或回复机器人' },
];

/** bot.features 里该功能的设置；配置由后端 normalize 补全，这里只兜底形状。 */
const featureSetting = computed<Record<string, any> | null>(() => {
    if (!props.featureId) return null;
    const store = config.value?.bot?.features;
    if (!store) return null;
    const setting = store[props.featureId];
    if (!setting) return null;
    return setting;
});

const limitFields = computed<LimitField[]>(() =>
    [...commonLimitFields.value, ...(featureDef.value?.limitFields || [])]);

function aliasesText(setting: any): string {
    return (setting.aliases || []).join(', ');
}

function updateAliases(setting: any, event: Event) {
    const raw = (event.target as HTMLInputElement).value;
    setting.aliases = Array.from(new Set(raw.split(/[,，、;；|\n]/).map((item) => item.trim()).filter(Boolean)));
}

function hasScope(setting: any, scope: 'private' | 'group'): boolean {
    return (setting.scopes || []).includes(scope);
}

function toggleScope(setting: any, scope: 'private' | 'group') {
    const current = new Set(setting.scopes || []);
    if (current.has(scope)) current.delete(scope); else current.add(scope);
    if (!current.size) current.add(scope);
    setting.scopes = [...current];
}

/** 状态头里的配额摘要：只读，展示已配置的非零限额。 */
const quotaSummary = computed(() => {
    const limits = featureSetting.value?.limits || {};
    const parts: string[] = [];
    if (Number(limits.cooldownSec) > 0) parts.push(`冷却 ${limits.cooldownSec}s`);
    if (Number(limits.userDailyLimit) > 0) parts.push(`用户日限 ${limits.userDailyLimit}`);
    if (Number(limits.groupDailyLimit) > 0) parts.push(`群日限 ${limits.groupDailyLimit}`);
    if (Number(limits.concurrency) > 0) parts.push(`并发 ${limits.concurrency}`);
    return parts.join(' · ');
});

/* ── 卡5：能力测试三档 ──────────────────────────────────────── */

const testResult = ref<{ status: string; detail: string } | null>(null);

async function runTest(mode: 'validate' | 'dry_run' | 'live') {
    testResult.value = { status: 'queued', detail: `${mode} 已提交` };
    try {
        if (mode === 'live' && !window.confirm(`将真实执行能力 ${props.capabilityId}，可能产生费用，且测试结果不会发送到 QQ。继续？`)) {
            testResult.value = null;
            return;
        }
        const res = await client.post('/orchestration/capabilities/test', { id: props.capabilityId, mode, allowLive: mode === 'live' });
        const testId = String(res.data?.testId || '');
        if (!testId) {
            testResult.value = { status: res.data?.capability?.health?.status || 'ok', detail: res.data?.capability?.health?.detail || '已提交' };
            return;
        }
        for (let attempt = 0; attempt < 20; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                const result = await client.get(`/orchestration/capabilities/test/${encodeURIComponent(testId)}`);
                const value = result.data?.result;
                if (value) {
                    testResult.value = {
                        status: value.ok ? 'ok' : 'error',
                        detail: `${value.stage}/${value.result?.status || value.error || ''} (${value.durationMs}ms)`,
                    };
                    return;
                }
            } catch { /* keep polling */ }
        }
        testResult.value = { status: 'timeout', detail: '测试任务尚未返回' };
    } catch (error: any) {
        testResult.value = { status: 'error', detail: error?.response?.data?.error || '测试失败' };
    }
}

/* ── 数据加载 ───────────────────────────────────────────────── */

async function loadCapability() {
    try {
        const res = await client.get('/orchestration/capabilities');
        capability.value = (res.data?.capabilities || []).find((item: any) => item.id === props.capabilityId) || null;
    } catch { capability.value = null; }
}

async function loadFeatureDef() {
    if (!props.featureId) return;
    try {
        const res = await client.get('/features');
        commonLimitFields.value = res.data?.commonLimitFields || [];
        featureDef.value = (res.data?.definitions || []).find((item: any) => item.id === props.featureId) || null;
    } catch { /* 配额卡拿不到定义时仍可用 common 字段兜底为空 */ }
}

onMounted(() => {
    loadCapability();
    loadFeatureDef();
});
</script>

<template>
  <div v-if="config && orch">
    <header class="mb-4">
      <div class="flex flex-wrap items-center gap-3 mb-0.5">
        <h1 class="page-title mb-0">{{ pageTitle }}</h1>
        <span v-if="capability" class="dot" :class="healthClass"
          :title="capability.health?.detail || capability.health?.status"></span>
        <span class="tag mono">{{ capabilityId }}</span>
        <span v-if="capability" class="tag">{{ capability.provider }}</span>
        <span v-if="capability" class="tag">风险 {{ capability.riskLevel || 'medium' }}</span>
        <span class="flex-1"></span>
        <ToggleField :model-value="capability?.enabled ?? true" label="启用能力" @update:model-value="toggleRegistryEnabled" />
      </div>
      <p class="text-[color:var(--ink-3)] text-xs">
        {{ subtitle || capability?.description }}
        <template v-if="quotaSummary">；配额：{{ quotaSummary }}</template>
      </p>
    </header>

    <slot name="intro" />

    <SectionCard v-if="featureSetting" title="启用与配额" hint="消息入口的 FeatureGate 配额（C6）：冷却、每日上限、并发与触发方式；启停跟随页顶「启用能力」开关（单源）" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="命令别名" hint="逗号分隔；最长别名优先匹配">
          <input :value="aliasesText(featureSetting)" @change="updateAliases(featureSetting, $event)" class="input-field font-mono text-xs" placeholder="例如：生图, 画, draw" />
        </FormField>
        <FormField label="生效范围" hint="至少选择一个">
          <div class="flex gap-2">
            <button type="button" class="btn-outline text-xs"
              :class="hasScope(featureSetting, 'private') ? '!border-[color:var(--accent)] !text-[color:var(--accent)]' : ''"
              @click="toggleScope(featureSetting, 'private')">私聊</button>
            <button type="button" class="btn-outline text-xs"
              :class="hasScope(featureSetting, 'group') ? '!border-[color:var(--accent)] !text-[color:var(--accent)]' : ''"
              @click="toggleScope(featureSetting, 'group')">群聊</button>
          </div>
        </FormField>
        <FormField label="群聊触发方式" hint="只影响显式命令">
          <select v-model="featureSetting.groupActivation" class="input-field" :disabled="!hasScope(featureSetting, 'group')">
            <option v-for="opt in ACTIVATION_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
      </div>
      <div v-if="limitFields.length" class="mt-4 pt-3 border-t border-[color:var(--hairline-2)]">
        <div class="text-xs font-medium mb-2">限额与频率</div>
        <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <label v-for="field in limitFields" :key="field.key" class="block">
            <span class="block text-[11px] text-[color:var(--ink-3)] mb-1">{{ field.label }}<template v-if="field.unit">（{{ field.unit }}）</template></span>
            <input type="number" v-model.number="featureSetting.limits[field.key]" :min="field.min" :max="field.max"
              class="input-field !py-1.5 text-xs" />
          </label>
        </div>
      </div>
    </SectionCard>
    <SectionCard v-else-if="featureId" title="启用与配额" class="mb-4">
      <p class="text-xs text-[color:var(--ink-3)]">
        该能力没有独立的消息入口配置，使用按风险等级的默认配额；如需覆盖可在「命令与意图」页按功能配置。
      </p>
    </SectionCard>

    <SectionCard v-if="$slots.models" :title="modelsTitle" class="mb-4">
      <slot name="models" />
    </SectionCard>

    <SectionCard v-if="$slots.prompts" :title="promptsTitle" class="mb-4">
      <slot name="prompts" />
    </SectionCard>

    <SectionCard v-if="$slots.advanced" :title="advancedTitle" class="mb-4">
      <slot name="advanced" />
    </SectionCard>

    <!-- 能力专属整卡（如语音页的 FishAudio 音色自助）：插在高级参数与测试之间。 -->
    <slot name="extra" />

    <SectionCard title="能力测试" hint="三档：validate 只校验描述符 / dry_run 干跑 handler / live 真实执行（可能产生费用）" class="mb-4">
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn-outline !px-3 !py-1" type="button" @click="runTest('validate')">校验</button>
        <button class="btn-outline !px-3 !py-1" type="button" @click="runTest('dry_run')">干跑</button>
        <button class="btn-outline !px-3 !py-1" type="button" @click="runTest('live')">实跑</button>
        <ToggleField :model-value="capability?.approvalRequired ?? false" label="高风险需审批" @update:model-value="toggleRegistryApproval" />
        <span v-if="capability?.health" class="text-xs text-[color:var(--ink-3)]">
          健康：<span :class="capability.health.status === 'ok' ? 'text-emerald-500' : capability.health.status === 'disabled' ? 'text-amber-500' : 'text-rose-500'">{{ capability.health.status }}</span>
          {{ capability.health.detail }}
        </span>
      </div>
      <p v-if="testResult" class="text-xs mt-3" :class="testResult.status === 'ok' ? 'status-good' : testResult.status === 'error' || testResult.status === 'timeout' ? 'status-crit' : 'text-[color:var(--ink-3)]'">
        {{ testResult.status }}：{{ testResult.detail }}
      </p>
      <p v-if="capability" class="text-xs text-[color:var(--ink-3)] mt-3">
        effect <span class="mono">{{ capability.effect || 'unknown' }}</span>；
        前置上下文 <span class="mono">{{ (capability.requiredContext || []).join('/') || '-' }}</span>；
        副作用 <span class="mono">{{ (capability.sideEffects || []).join('/') || '-' }}</span>；
        模式 <span class="mono">{{ capability.mode || 'sync' }}</span>；
        版本 <span class="mono">{{ capability.version || '-' }}</span>
      </p>
    </SectionCard>
  </div>
</template>
