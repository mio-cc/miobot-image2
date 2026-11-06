<script setup lang="ts">
import { computed } from 'vue';

/**
 * 用途模型绑定只读镜像 + 「模型与节点」跳转。
 * 用途绑定（节点+模型）统一在 ModelsPage 用途表编辑（与此前模型选项收敛同一原则）；
 * 能力页用本组件展示当前绑定并给跳转，不保留第二个可编辑入口。
 */
const props = defineProps<{
    /** 当前绑定的节点索引（原样展示，0 = 第一个节点） */
    nodeIndex: number | string;
    /** 当前绑定的模型名；空串 = 继承主对话 */
    model: string;
    /** 用途说明（展示在未配置提示里，如「朗读前改写」） */
    purpose?: string;
}>();

const nodeText = computed(() => `节点 ${Number(props.nodeIndex) || 0}`);
const modelText = computed(() => String(props.model || '').trim() ? props.model : `未配置（${props.purpose || '该用途'}跟随主对话模型）`);
</script>

<template>
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <span class="text-xs text-[color:var(--ink-2)] font-mono">{{ nodeText }} · {{ modelText }}</span>
    <RouterLink to="/models" class="text-xs hover:underline whitespace-nowrap">到「模型与节点」用途表调整</RouterLink>
  </div>
</template>
