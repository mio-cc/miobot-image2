<script setup lang="ts">
/** 一行「说明 + 开关」。这个组合在配置页里出现几十次，抽出来省掉重复的 flex 样板。 */
defineProps<{ label: string; hint?: string; disabled?: boolean }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="field-box" :class="disabled ? 'opacity-50' : ''">
    <span class="min-w-0">
      <span class="block">{{ label }}</span>
      <span v-if="hint" class="block text-[color:var(--ink-3)] text-[11px] mt-0.5">{{ hint }}</span>
    </span>
    <span class="toggle">
      <input type="checkbox" v-model="model" :disabled="disabled" />
      <span class="toggle-slider"></span>
    </span>
  </label>
</template>
