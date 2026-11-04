<script setup lang="ts">
import { computed, ref } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from './SectionCard.vue';
import FormField from './FormField.vue';
import ToggleField from './ToggleField.vue';
import ModelPicker from './ModelPicker.vue';
import AppSelect from './AppSelect.vue';

/**
 * 编排规划器面板（编排执行限制 / 编排模式与规划器 / 多模型协作 / 提示词优化 / 提示词版本差异回滚）。
 * 自 AgentPage 拆出（纯模板搬移）：orchestration 由父页传入同一对象引用，v-model 直写成员，
 * 绑定表达式与拆分前完全一致；提示词版本操作（保存/激活/评估）走 configStore 与 API，逻辑未动。
 */
const props = defineProps<{ orchestration: any }>();
/* 桥接转发：让模板/script 内的 orchestration 引用与拆分前逐字一致。 */
const orchestration = computed(() => props.orchestration);
const configStore = useConfigStore();

/* ═══ 编排模式与规划器等 orchestration 子段（唯一编辑入口）═══
   消费证据：orch.mode → runtime.ts:1159/1659/1817、orchestration-enforce.ts:585/629；
   planner.* → :774/:916/:955/:1133/:1405；roles → :377/:941；
   promptOptimization → :892-901；help.extraText → help-text.ts:81；
   capabilityDescriptions → orchestration-enforce.ts:918。 */

const orchModeOptions = [
    { value: 'shadow', label: 'shadow 影子模式（只规划，不执行）' },
    { value: 'enforce', label: 'enforce 执行模式' },
];
const failurePolicyOptions = [
    { value: 'stop', label: '停止' },
    { value: 'continue', label: '继续' },
    { value: 'ask', label: '询问用户' },
];
const optimizationScopeOptions = [
    { value: 'task', label: '任务级' },
    { value: 'all', label: '全部' },
];
const promptStatusOptions = [
    { value: 'draft', label: 'draft' },
    { value: 'canary', label: 'canary' },
    { value: 'active', label: 'active' },
    { value: 'retired', label: 'retired' },
];
/** 评估版本下拉：空值「请选择」+ 动态候选（提示词版本数组）。 */
const evalVersionOptions = computed(() => [
    { value: '', label: '请选择' },
    ...(orchestration.value?.promptOptimization?.versions || []).map((item: any) => ({ value: item.id, label: item.id })),
]);

const plannerCapabilityDescriptionsJson = computed({
    get: () => JSON.stringify(orchestration.value?.planner?.capabilityDescriptions || {}, null, 2),
    set: (text: string) => {
        try {
            const parsed = JSON.parse(text || '{}');
            if (orchestration.value?.planner) orchestration.value.planner.capabilityDescriptions = parsed;
        } catch { /* keep previous valid JSON while editing */ }
    },
});

const roleKeys = ['planner', 'retriever', 'specialist', 'critic', 'safety', 'composer'] as const;

const promptDiff = ref<any[]>([]);
const promptDiffId = ref('');
const evalVersionId = ref('');
const evalSamples = ref(50);
const evalSuccessRate = ref(0.95);
const evalAverageScore = ref(0.9);
const evalSafetyFailures = ref(0);
const evalOwnerApproved = ref(false);
const evalResult = ref<any>(null);

function addPromptVersion() {
    if (!orchestration.value?.promptOptimization) return;
    orchestration.value.promptOptimization.versions ||= [];
    const id = 'prompt_v_' + Date.now();
    orchestration.value.promptOptimization.versions.push({
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
    } catch { /* 版本切换失败时保留当前生效版本 */ }
}

async function loadPromptDiff(item: any) {
    if (!item?.id) return;
    try {
        const res = await client.get('/orchestration/prompts/' + encodeURIComponent(item.id) + '/diff');
        promptDiff.value = res.data?.diff || [];
        promptDiffId.value = item.id;
    } catch { promptDiff.value = []; promptDiffId.value = ''; }
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
</script>

<template>
  <!-- 多根挂载：与拆分前在父页内的 DOM 结构逐层一致，不引入额外包装节点 -->
  <!-- ═══ R21 审计补缺 + P1 技术债收敛（「执行预算」四项）═══ -->
  <SectionCard v-if="orchestration?.execution" title="编排执行限制" hint="orchestration.execution · 防止多步骤、多模型和外部能力失控" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
        <FormField label="最大步数"><input v-model.number="orchestration.execution.maxSteps" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大并行步"><input v-model.number="orchestration.execution.maxParallelSteps" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大深度"><input v-model.number="orchestration.execution.maxDepth" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最大时长 (ms)"><input v-model.number="orchestration.execution.maxDurationMs" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="最大开销"><input v-model.number="orchestration.execution.maxCost" type="number" min="0" step="0.1" class="input-field" /></FormField>
        <FormField label="最大模型轮次"><input v-model.number="orchestration.execution.maxModelRounds" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大候选能力 TopK"><input v-model.number="orchestration.planner.capabilityTopK" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最低置信度"><input v-model.number="orchestration.planner.minConfidence" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
        <FormField label="失败策略">
          <AppSelect v-model="orchestration.execution.failurePolicy" :options="failurePolicyOptions" />
        </FormField>
        <div class="flex items-end"><ToggleField v-model="orchestration.execution.loopDetection" label="环路检测" hint="检测步骤间循环依赖并提前终止" /></div>
      </div>
    </SectionCard>

    <!-- ═══ P1 技术债收敛：编排模式与规划器（消费见 script 注释）═══ -->
    <SectionCard v-if="orchestration" title="编排模式与规划器" hint="orchestration.mode / planner · 先影子比对，再切换执行模式" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="md:col-span-2"><ToggleField v-model="orchestration.enabled" label="启用智能编排" hint="关闭时继续使用现有 v2 路由" /></div>
        <FormField label="模式">
          <AppSelect v-model="orchestration.mode" :options="orchModeOptions" />
        </FormField>
        <FormField label="Planner 节点与模型" hint="留空使用节点默认模型">
          <ModelPicker capability="chat"
            :node-index="Number(orchestration.planner.nodeIndex) || 0" :model="orchestration.planner.model || ''"
            @update:node-index="orchestration.planner.nodeIndex = $event"
            @update:model="orchestration.planner.model = $event" />
        </FormField>
        <div class="flex items-end"><ToggleField v-model="orchestration.planner.enabled" label="启用 Planner" /></div>
        <div class="flex items-end"><ToggleField v-model="orchestration.planner.actionAlignmentGuardEnabled" label="启用意图-行动一致性复核" hint="按能力 effect 检查副作用，不按关键词判断" /></div>
        <FormField label="复核触发置信度阈值" hint="低于该置信度也触发通用复核"><input v-model.number="orchestration.planner.alignmentGuardConfidenceThreshold" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
        <FormField label="一致性复核 maxTokens" hint="复核模型输出 JSON 的上限；推理模型建议 1200 到 2000"><input v-model.number="orchestration.planner.alignmentReviewMaxTokens" type="number" min="1" max="200000" step="100" class="input-field" /></FormField>
        <FormField label="Planner 系统提示词" hint="enforce Planner 使用；能力清单自动附加">
          <textarea v-model="orchestration.planner.systemPromptTemplate" rows="8" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="Planner 用户提示词模板" hint="支持 {{userText}}、{{capabilityManifest}}（兼容 {{capabilityCatalog}}）、{{outputSchema}} 等占位符">
          <textarea v-model="orchestration.planner.userPromptTemplate" rows="8" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="Help 追加说明" hint="追加到完整帮助文本末尾，可写本实例专属能力">
          <textarea v-model="orchestration.help.extraText" rows="4" class="input-field"></textarea>
        </FormField>
        <FormField label="能力描述覆盖（JSON）" hint="只覆盖正向说明文字；不要写 notFor 或路由规则，effect、requiredContext、sideEffects 由能力注册表自动生成">
          <textarea v-model="plannerCapabilityDescriptionsJson" rows="8" class="input-field font-mono text-xs"></textarea>
        </FormField>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 border-t border-[color:var(--hairline-2)] pt-4">
        <FormField label="最大追问轮数" hint="0-5；规划与执行各自独立计算"><input v-model.number="orchestration.planner.maxClarifications" type="number" min="0" max="5" class="input-field" /></FormField>
        <FormField label="追问等待超时 (ms)" hint="超时未回复按放弃处理"><input v-model.number="orchestration.planner.clarificationTimeoutMs" type="number" min="1000" step="1000" class="input-field" /></FormField>
        <FormField label="计划修复轮数" hint="计划校验失败后交给模型修复的最大次数"><input v-model.number="orchestration.planner.maxRepairAttempts" type="number" min="0" max="10" class="input-field" /></FormField>
      </div>
    </SectionCard>

    <SectionCard v-if="orchestration" title="多模型协作" hint="每个角色独立配置节点和模型；未启用时由主 Planner 承担" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <div v-for="role in roleKeys" :key="role" class="border border-[color:var(--hairline-2)] rounded-xl p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold">{{ role }}</span>
            <ToggleField v-model="orchestration.roles[role].enabled" label="启用" />
          </div>
          <FormField label="节点与模型" hint="留空使用节点默认">
            <ModelPicker capability="chat"
              :node-index="Number(orchestration.roles[role].nodeIndex) || 0" :model="orchestration.roles[role].model || ''"
              @update:node-index="orchestration.roles[role].nodeIndex = $event"
              @update:model="orchestration.roles[role].model = $event" />
          </FormField>
          <FormField label="超时 (ms)" hint="留空使用模型默认"><input v-model.number="orchestration.roles[role].timeoutMs" type="number" min="1000" step="1000" class="input-field" /></FormField>
          <FormField label="温度" hint="留空使用模型默认；建议 0 到 1"><input v-model.number="orchestration.roles[role].temperature" type="number" min="0" max="2" step="0.05" class="input-field" /></FormField>
          <FormField label="maxTokens" hint="留空使用模型默认"><input v-model.number="orchestration.roles[role].maxTokens" type="number" min="1" max="200000" step="100" class="input-field" /></FormField>
          <FormField label="Fallback 节点与模型" hint="主模型失败时切换；留空模型用同角色模型">
            <ModelPicker capability="chat"
              :node-index="Number(orchestration.roles[role].fallbackNodeIndex) || 0" :model="orchestration.roles[role].fallbackModel || ''"
              @update:node-index="orchestration.roles[role].fallbackNodeIndex = $event"
              @update:model="orchestration.roles[role].fallbackModel = $event" />
          </FormField>
          <FormField label="角色提示词覆盖" hint="留空用内置；支持 {{request}}、{{catalog}}、{{plan}}、{{outputs}}、{{question}}、{{answer}}">
            <textarea v-model="orchestration.roles[role].promptTemplate" rows="4" class="input-field font-mono text-xs"></textarea>
          </FormField>
        </div>
      </div>
    </SectionCard>

    <SectionCard v-if="orchestration" title="提示词优化" hint="系统提示词修改必须评估、灰度和审批" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="xl:col-span-1"><ToggleField v-model="orchestration.promptOptimization.enabled" label="启用自动优化" /></div>
        <FormField label="优化范围"><AppSelect v-model="orchestration.promptOptimization.scope" :options="optimizationScopeOptions" /></FormField>
        <FormField label="Canary 百分比"><input v-model.number="orchestration.promptOptimization.canaryPercent" type="number" min="0" max="100" class="input-field" /></FormField>
        <FormField label="最低样本数"><input v-model.number="orchestration.promptOptimization.minSamples" type="number" min="1" class="input-field" /></FormField>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orchestration.promptOptimization.requireOwnerApproval" label="系统提示词需要 owner 审批" /></div>
      </div>
    </SectionCard>

    <SectionCard v-if="orchestration" title="提示词版本 / 差异 / 回滚" hint="保存版本后可设置 active 或 canary；切换会写入配置版本审计并热重载" class="mb-4">
      <div class="flex items-center justify-between mb-3 gap-3">
        <p class="text-xs text-[color:var(--ink-3)]">Active: <span class="mono">{{ orchestration.promptOptimization.activeVersionId || '未设置' }}</span>；Canary: <span class="mono">{{ orchestration.promptOptimization.canaryVersionId || '未设置' }}</span></p>
        <button class="btn-outline !px-3 !py-1" type="button" @click="addPromptVersion">新增候选版本</button>
      </div>
      <div class="space-y-3">
        <div v-for="item in (orchestration.promptOptimization.versions || [])" :key="item.id" class="border border-[color:var(--hairline-2)] rounded-xl p-3 space-y-2">
          <div class="grid grid-cols-1 md:grid-cols-4 gap-2">
            <FormField label="版本 ID"><input v-model="item.id" class="input-field font-mono !py-1" /></FormField>
            <FormField label="名称"><input v-model="item.name" class="input-field !py-1" /></FormField>
            <FormField label="状态"><AppSelect v-model="item.status" :options="promptStatusOptions" trigger-class="!py-1" /></FormField>
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
        <p v-if="!(orchestration.promptOptimization.versions || []).length" class="text-xs text-[color:var(--ink-3)]">暂无提示词版本；新增后先保存配置，再启用或设置 Canary。</p>
        <div class="border-t border-[color:var(--hairline-2)] pt-3 mt-3">
          <h3 class="text-sm font-semibold mb-2">候选版本评估</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-2">
            <FormField label="版本"><AppSelect v-model="evalVersionId" :options="evalVersionOptions" /></FormField>
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
</template>
