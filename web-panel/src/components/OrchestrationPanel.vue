<script setup lang="ts">
import { computed } from 'vue';
import SectionCard from './SectionCard.vue';
import FormField from './FormField.vue';
import ToggleField from './ToggleField.vue';
import ModelPicker from './ModelPicker.vue';
import AppSelect from './AppSelect.vue';

/**
 * 编排面板（编排执行限制 / 编排模式与规划器 / planner 角色卡）。
 * 2026-11-06 清理：自然语言规划分支（planner 模型规划、提示词模板、一致性复核、promptOptimization）
 * 生产不可达（唯一入口 commandOrchestration 恒带确定性 plan），配置字段与控件已删。
 * 保留字段的消费点：planner.nodeIndex/model → capability-suno-library.ts:192-193（suno 局部编辑推理）
 * 与 capability-basic.ts:181（help 文案）；maxClarifications/clarificationTimeoutMs → enforce 执行期追问；
 * alignmentReviewMaxTokens / roles.planner.maxTokens/timeoutMs → suno 推理与执行期追问生成的预算兜底；
 * help.extraText → help-text.ts:81。
 */
const props = defineProps<{ orchestration: any }>();
/* 桥接转发：让模板/script 内的 orchestration 引用与拆分前逐字一致。 */
const orchestration = computed(() => props.orchestration);

const orchModeOptions = [
    { value: 'shadow', label: 'shadow 影子模式（只规划，不执行）' },
    { value: 'enforce', label: 'enforce 执行模式' },
];
const failurePolicyOptions = [
    { value: 'stop', label: '停止' },
    { value: 'continue', label: '继续' },
    { value: 'ask', label: '询问用户' },
];

const roleKeys = ['planner'] as const;
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
        <FormField label="推理 maxTokens 兜底" hint="suno 局部编辑推理等模型调用的 maxTokens 兜底"><input v-model.number="orchestration.planner.alignmentReviewMaxTokens" type="number" min="1" max="200000" step="100" class="input-field" /></FormField>
        <FormField label="Help 追加说明" hint="追加到完整帮助文本末尾，可写本实例专属能力">
          <textarea v-model="orchestration.help.extraText" rows="4" class="input-field"></textarea>
        </FormField>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 border-t border-[color:var(--hairline-2)] pt-4">
        <FormField label="执行期追问次数上限" hint="执行中缺信息时向用户追问的次数预算（0=不追问）"><input v-model.number="orchestration.planner.maxClarifications" type="number" min="0" max="5" class="input-field" /></FormField>
        <FormField label="追问等待超时 (ms)" hint="超时未回复按放弃处理"><input v-model.number="orchestration.planner.clarificationTimeoutMs" type="number" min="1000" step="1000" class="input-field" /></FormField>
      </div>
    </SectionCard>

    <SectionCard v-if="orchestration" title="Planner 角色" hint="执行期追问生成与 suno 局部编辑推理的模型来源；留空回落「编排模式与规划器」的 planner 节点" class="mb-4">
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
</template>
