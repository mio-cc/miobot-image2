<script setup lang="ts">
/**
 * 一行「说明 + 开关」。
 * 这个组合在配置页里出现几十次，抽出来省掉重复的 flex 样板。
 * Phase-UI：内部改用自研 UiSwitch（不再有裸 input[type=checkbox]）。
 */
import UiSwitch from './ui/UiSwitch.vue';

withDefaults(defineProps<{
    label: string;
    hint?: string;
    disabled?: boolean;
    tone?: 'accent' | 'good' | 'warning';
}>(), {
    hint: '',
    disabled: false,
    tone: 'accent',
});

const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="field-box" :class="disabled ? 'opacity-50' : ''">
    <span class="min-w-0">
      <span class="block">{{ label }}</span>
      <span v-if="hint" class="block text-[color:var(--ink-3)] text-[11px] mt-0.5">{{ hint }}</span>
    </span>
    <UiSwitch
      v-model="model"
      :disabled="disabled"
      :tone="tone"
      :label="label"
    />
  </label>
</template>
