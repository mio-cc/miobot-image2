<script setup lang="ts">
/**
 * UiRadioGroup —— 互斥单选的容器。
 * 提供 roving tabindex 与方向键组内移动（WAI-ARIA radiogroup 模式）。
 */
import { provide, ref } from 'vue';

const props = withDefaults(defineProps<{
    disabled?: boolean;
    /** 列数；不传则按内容自动换行 */
    columns?: number;
    label?: string;
}>(), {
    disabled: false,
    columns: undefined,
    label: '选项',
});

const model = defineModel<string | number>({ default: '' });

const items = ref<Array<{ value: string | number; disabled: boolean }>>([]);
const containerEl = ref<HTMLElement | null>(null);

function register(value: string | number, disabled: boolean) {
    items.value.push({ value, disabled });
}

function move(dir: 1 | -1, from: string | number) {
    const enabled = items.value.filter(i => !i.disabled && !props.disabled);
    if (!enabled.length) return;
    const idx = enabled.findIndex(i => String(i.value) === String(from));
    const next = enabled[(idx + dir + enabled.length) % enabled.length];
    if (next) {
        model.value = next.value;
        // 焦点跟到新选中项
        const el = containerEl.value?.querySelector<HTMLElement>(`[data-radio-value="${CSS.escape(String(next.value))}"]`);
        el?.focus();
    }
}

provide('uiRadioGroup', { model, register, move, groupDisabled: () => props.disabled });
</script>

<template>
  <div
    ref="containerEl"
    class="rgroup"
    role="radiogroup"
    :aria-label="label"
    :style="columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined"
  >
    <slot />
  </div>
</template>

<style scoped>
.rgroup {
  display: grid;
  gap: 8px;
  min-width: 0;
}
</style>
