<script setup lang="ts">
import AppSelect, { type AppSelectOption } from './AppSelect.vue';

/**
 * 节点池卡片（自 ModelsPage 拆出）。
 * 交互语义：卡片主体（状态点/名称/类型徽标/URL/模型区/拉取反馈）点击 → 打开编辑抽屉；
 * 底部操作行（拉取/启停/删除）是独立块，不响应「点主体开抽屉」；
 * 「+N 查看」模型浏览弹层在主体内，用 @click.stop 隔离，两个语义互不冲突。
 * 节点对象由 ModelsPage 持有（config.llm.apiKeys 的元素），启停直接改 node.enabled。
 */
defineProps<{
    node: any;
    idx: number;
    fetching: boolean;
    summary: string;
    error: string;
    modelOptions: AppSelectOption[];
}>();

const emit = defineEmits<{
    open: [idx: number];
    fetch: [idx: number];
    remove: [idx: number];
}>();
</script>

<template>
  <div class="group relative bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[14px] p-4 shadow-[var(--sh-1)] transition-all duration-200 hover:-translate-y-[3px] hover:shadow-[var(--sh-2)] hover:border-[color:var(--accent-line)]">

    <!-- 可点击主体：进入编辑抽屉 -->
    <div class="cursor-pointer" title="点击编辑节点详情" @click="emit('open', idx)">
      <!-- 启用状态点（token 语义色） -->
      <span class="absolute top-[18px] right-4 dot" :class="node.enabled !== false ? 'dot-good' : 'dot-idle'"
        :title="node.enabled !== false ? '已启用' : '已停用'"/>

      <!-- 名称 + 类型徽标 + 悬停编辑提示 -->
      <div class="flex items-center gap-2 mb-1 pr-6">
        <span class="text-[14px] font-bold text-[color:var(--ink)] truncate">{{ node.name || `节点 ${idx + 1}` }}</span>
        <span v-if="node.kind === 'comfyui'" class="text-[10px] font-bold rounded-md px-1.5 py-0.5 bg-[color:var(--accent-soft)] text-[color:var(--accent)] flex-none">comfyui</span>
        <span v-else class="text-[10px] font-bold rounded-md px-1.5 py-0.5 bg-[color:var(--off-soft)] text-[color:var(--ink-3)] flex-none">llm</span>
        <span class="ml-auto hidden sm:inline-flex items-center gap-1 text-[10.5px] font-medium text-[color:var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
          </svg>
          编辑
        </span>
      </div>

      <!-- Base URL -->
      <div class="text-[11px] text-[color:var(--ink-3)] font-mono truncate mb-2.5">{{ node.baseUrl || '（未配置 URL）' }}</div>

      <!-- 模型标签：前 4 个平铺，更多收进「+N 查看」浏览弹层（点击与开抽屉语义隔离） -->
      <div class="flex flex-wrap gap-1 mb-3 min-h-[22px] content-center">
        <span v-for="m in (node.models || []).slice(0, 4)" :key="m" class="text-[10.5px] bg-[color:var(--off-soft)] text-[color:var(--ink-2)] rounded-md px-1.5 py-0.5 font-mono">{{ m }}</span>
        <span v-if="(node.models || []).length > 4" @click.stop>
          <AppSelect browse :options="modelOptions" class="self-center">
            <template #trigger>
              <span class="text-[10.5px] text-[color:var(--ink-2)] bg-[color:var(--off-soft)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--accent)] rounded-md px-1.5 py-0.5 font-medium transition-colors duration-150">
                +{{ (node.models || []).length - 4 }} 查看
              </span>
            </template>
          </AppSelect>
        </span>
        <span v-if="!(node.models || []).length" class="text-[10.5px] text-[color:var(--ink-3)] self-center">（点下方"拉取"获取模型列表）</span>
      </div>

      <!-- 拉取反馈：成功 diff 摘要 / 失败原因 + 重试（重试不触发开抽屉） -->
      <div v-if="summary" class="status-good text-[10.5px] bg-[color:var(--off-soft)] border border-[color:var(--hairline-2)] rounded-md px-2 py-1 mb-2 leading-relaxed">{{ summary }}</div>
      <div v-if="error" class="flex items-start gap-2 text-[10.5px] status-crit bg-[color:var(--critical-soft)] border border-[color:var(--hairline-2)] rounded-md px-2 py-1 mb-2 leading-relaxed">
        <span class="min-w-0 flex-1">{{ error }}</span>
        <button class="flex-none underline underline-offset-2 hover:opacity-70 transition-opacity" :disabled="fetching" @click.stop="emit('fetch', idx)">重试</button>
      </div>
    </div>

    <!-- 操作行：高频操作保持原位，不属于「卡片主体」点击范围 -->
    <div class="flex items-center gap-1.5 text-[11px] text-[color:var(--ink-3)] border-t border-[color:var(--hairline)] pt-2.5">
      <span class="mr-auto">
        {{ (node.models || []).length }} 个模型
        <span v-if="node.modelsFetchedAt" class="ml-1" :title="node.modelsFetchedAt">· 上次拉取 {{ new Date(node.modelsFetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
      </span>
      <button class="border border-[color:var(--hairline-3)] rounded-lg px-2.5 py-1 text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] transition-colors duration-150 disabled:opacity-50" :disabled="fetching"
        @click="emit('fetch', idx)">{{ fetching ? '拉取中…' : '拉取' }}</button>
      <button class="border border-[color:var(--hairline-3)] rounded-lg px-2.5 py-1 text-[color:var(--ink-2)] hover:border-[color:var(--ink-3)] transition-colors duration-150"
        @click="node.enabled = node.enabled === false ? true : false">{{ node.enabled === false ? '启用' : '停用' }}</button>
      <button class="btn-danger !px-2.5 !py-1 !rounded-lg"
        @click="emit('remove', idx)">删除</button>
    </div>
  </div>
</template>
