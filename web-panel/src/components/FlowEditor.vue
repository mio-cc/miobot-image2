<script setup lang="ts">
/**
 * 流程编排（2026-11-07 拍板）：能力默认调用组合编辑器——单一真相源
 * orchestration.capabilityFlows[capabilityId]（与 capabilityOverrides 分键空间）。
 * 能力详情页与 /mcp/<id> 配置页共用本组件（不另设统一编排视图，避免第二入口）。
 * 语义：steps 有序，每步 {capability, hint?, when?}；不配置 = 默认链 = 本能力单步；
 * 链是「默认优先，不锁死」的提示（模型侧恒带「可按需调整」后缀），不进执行路径。
 */
import { computed, onMounted } from 'vue';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import SectionCard from './SectionCard.vue';
import AppSelect from './AppSelect.vue';

const props = defineProps<{ capabilityId: string }>();
const configStore = useConfigStore();
const capabilityStore = useCapabilityStore();

const orchestration = computed(() => (configStore.config as any)?.orchestration);
const flows = computed<Record<string, { steps: Array<{ capability: string; hint?: string; when?: string }> }>>(
  () => orchestration.value?.capabilityFlows || {});
const flow = computed(() => flows.value[props.capabilityId]);

/** 备选能力（注册表 id，排除自己）。 */
const capabilityOptions = computed<string[]>(() =>
  ((capabilityStore.registry || []) as Array<{ id?: string }>)
    .map((item) => String(item?.id || ''))
    .filter((id) => id && id !== props.capabilityId));

/** 下拉选项：占位项 + 注册表能力（AppSelect 走自绘面板，替代原生 select）。 */
const capabilitySelectOptions = computed(() => [
  { value: '', label: '（选择能力）' },
  ...capabilityOptions.value.map(id => ({ value: id, label: id })),
]);

/** 当前值不在注册表时补一条标注项，避免打开下拉看到空值以为配置丢了。 */
function stepOptions(current: string) {
  const base = capabilitySelectOptions.value;
  if (current && !base.some(o => o.value === current)) {
    return [...base, { value: current, label: current, hint: '不在注册表' }];
  }
  return base;
}

/** 有效链：steps 非空且不是「单步=自己」。 */
const effectiveSteps = computed(() => {
  const steps = flow.value?.steps || [];
  if (!steps.length) return null;
  if (steps.length === 1 && steps[0].capability === props.capabilityId) return null;
  return steps;
});

function ensureFlow(): { steps: Array<{ capability: string; hint?: string; when?: string }> } {
  const orch = orchestration.value;
  orch.capabilityFlows = { ...(orch.capabilityFlows || {}) };
  orch.capabilityFlows[props.capabilityId] ||= { steps: [] };
  return orch.capabilityFlows[props.capabilityId];
}
function addStep() { ensureFlow().steps.push({ capability: '' }); }
function removeStep(index: number) {
  const steps = flow.value?.steps;
  if (!steps) return;
  steps.splice(index, 1);
  if (!steps.length) clearFlow();
}
function moveStep(index: number, delta: number) {
  const steps = flow.value?.steps;
  if (!steps) return;
  const target = index + delta;
  if (target < 0 || target >= steps.length) return;
  [steps[index], steps[target]] = [steps[target], steps[index]];
}
/** 恢复单步 = 删除链配置（默认链 = 本能力自己，零配置零提示）。 */
function clearFlow() {
  const all = { ...(orchestration.value?.capabilityFlows || {}) };
  delete all[props.capabilityId];
  orchestration.value.capabilityFlows = all;
}

onMounted(() => {
  if (!capabilityStore.registry?.length) void capabilityStore.refreshRegistry();
});
</script>

<template>
  <SectionCard title="默认调用组合" :hint="`默认流程：${capabilityId}（单步）。可配置多能力串联（A → B → C）作为默认路径——只是优先路径，模型可按需调整；改动经顶部「保存并热重载」生效`">
    <div v-if="!effectiveSteps" class="flex flex-wrap items-center gap-3">
      <span class="text-xs text-[color:var(--ink-3)]">未配置默认链——调用流程就是本能力单步执行</span>
      <button class="btn-outline !px-3 !py-1 !text-xs" @click="addStep">配置组合</button>
    </div>
    <div v-else class="space-y-2">
      <div v-for="(step, index) in effectiveSteps" :key="index" class="field-box">
        <div class="grid grid-cols-1 md:grid-cols-[minmax(180px,1fr)_minmax(160px,1.4fr)_minmax(140px,1fr)_auto] gap-2 items-center">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-[10.5px] font-semibold text-[color:var(--ink-3)] flex-none">{{ index + 1 }}.</span>
            <AppSelect
              v-model="step.capability"
              :options="stepOptions(step.capability)"
              placeholder="（选择能力）"
              class="min-w-0 flex-1"
            />
          </div>
          <input v-model="step.hint" class="input-field !py-1 text-xs" placeholder="该步提示（可选，≤120 字符）" maxlength="120" />
          <input v-model="step.when" class="input-field !py-1 text-xs" placeholder="条件（可选，如：上一步成功）" maxlength="200" />
          <div class="flex gap-1 flex-none">
            <button class="btn-outline !px-1.5 !py-0.5 !text-xs" :disabled="index === 0" @click="moveStep(index, -1)">↑</button>
            <button class="btn-outline !px-1.5 !py-0.5 !text-xs" :disabled="index === effectiveSteps.length - 1" @click="moveStep(index, 1)">↓</button>
            <button class="btn-outline !px-1.5 !py-0.5 !text-xs !text-red-500" @click="removeStep(index)">×</button>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button class="btn-outline !px-3 !py-1 !text-xs" @click="addStep">+ 加一步</button>
        <button class="btn-outline !px-3 !py-1 !text-xs !text-red-500" @click="clearFlow">恢复单步（清除链）</button>
        <span class="text-xs text-[color:var(--ink-3)]">悬挂引用（能力不存在/被停用）不拦截保存——链是提示不是依赖，模型调不到会收到该能力自身的既有错误</span>
      </div>
    </div>
  </SectionCard>
</template>
