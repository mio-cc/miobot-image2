<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore } from '../stores/config';

/**
 * 提示词只读镜像 + 注册表跳转。
 * 提示词文本统一只在「提示词注册表」编辑（同一功能不分散多个入口）；
 * 能力页用本组件展示当前生效值并给跳转，不保留第二个可编辑入口。
 * 内容读共享 config store：注册表保存后会回刷 store，这里不会显示陈旧值。
 */
const props = defineProps<{
    /** 注册表条目 id（跳转 ?focus= 定位用） */
    promptId: string;
    /** config 点分路径，用于读取当前生效值 */
    configPath: string;
    /** 展示标签（如「改写提示词」） */
    label: string;
}>();

const configStore = useConfigStore();
const content = computed(() => String(configStore.get(props.configPath) || ''));
const length = computed(() => content.value.length);
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-1">
      <span class="label-sm !mb-0">{{ label }}</span>
      <RouterLink :to="`/prompts?focus=${promptId}`" class="text-xs hover:underline">到提示词注册表编辑</RouterLink>
    </div>
    <details class="group">
      <summary class="cursor-pointer text-xs text-[color:var(--ink-3)] hover:text-[color:var(--ink)] transition-colors select-none">
        {{ content ? (length > 120 ? `展开查看（${length} 字符）` : '展开') : '（使用出厂默认——到提示词注册表自定义）' }}
        <span class="group-open:hidden">▸</span><span class="hidden group-open:inline">▾</span>
      </summary>
      <pre v-if="content" class="font-mono text-[11px] leading-relaxed overflow-auto max-h-48 p-3 mt-2 rounded-lg bg-[color:var(--page)] border border-[color:var(--hairline)] whitespace-pre-wrap">{{ content }}</pre>
    </details>
  </div>
</template>
