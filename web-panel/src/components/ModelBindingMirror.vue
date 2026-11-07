<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore } from '../stores/config';

/**
 * 用途模型绑定只读镜像 + 「模型与节点」跳转。
 * 用途绑定（节点+模型）统一在 ModelsPage 用途表编辑（与此前模型选项收敛同一原则）；
 * 能力页用本组件展示当前绑定并给跳转，不保留第二个可编辑入口。
 * 空值文案与 ModelsPage 继承态虚线框一致：空 = 「未选择 · 回落主对话：xxx」，
 * 运行时（resolveTtsPreprocessTarget / comfyui.ts 同族解析）按同一语义执行。
 */
const props = defineProps<{
    /** 当前绑定的节点索引（原样展示，0 = 第一个节点） */
    nodeIndex: number | string;
    /** 当前绑定的模型名；空串 = 跟随主对话 */
    model: string;
    /** 用途说明（展示在未配置提示里，如「朗读前改写」） */
    purpose?: string;
}>();

const configStore = useConfigStore();
const mainModel = computed(() => String(configStore.get('agent.mainModel') || configStore.get('llm.chatModel') || '').trim());
const nodeText = computed(() => `节点 ${Number(props.nodeIndex) || 0}`);
const modelText = computed(() => String(props.model || '').trim() ? props.model : `未选择 · 回落主对话：${mainModel.value || '（未设置）'}`);
</script>

<template>
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <span class="text-xs text-[color:var(--ink-2)] font-mono">{{ nodeText }} · {{ modelText }}</span>
    <RouterLink to="/models" class="text-xs hover:underline whitespace-nowrap">到「模型与节点」用途表调整</RouterLink>
  </div>
</template>
