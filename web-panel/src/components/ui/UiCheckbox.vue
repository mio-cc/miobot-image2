<script setup lang="ts">
/**
 * UiCheckbox —— 自研复选（替代裸 input[type=checkbox] 的成组多选场景）。
 * 对勾用 SVG 描边动画入场；支持 indeterminate 半选态。
 */
const props = withDefaults(defineProps<{
    disabled?: boolean;
    indeterminate?: boolean;
    tone?: 'accent' | 'good' | 'warning';
    size?: 'sm' | 'md';
    label?: string;
}>(), {
    disabled: false,
    indeterminate: false,
    tone: 'accent',
    size: 'md',
    label: '',
});

const model = defineModel<boolean>({ default: false });
const emit = defineEmits<{ change: [value: boolean] }>();

function toggle() {
    if (props.disabled) return;
    model.value = !model.value;
    emit('change', model.value);
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggle();
    }
}
</script>

<template>
  <div
    class="cbox"
    :class="[`cbox--${size}`, `cbox--${tone}`, { 'is-on': model, 'is-indet': indeterminate && !model, 'is-disabled': disabled }]"
    role="checkbox"
    :aria-checked="indeterminate && !model ? 'mixed' : model"
    :aria-disabled="disabled || undefined"
    :aria-label="label || undefined"
    :tabindex="disabled ? -1 : 0"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span class="cbox__box">
      <svg v-if="model" class="cbox__tick" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 6.2L4.8 8.5 9.5 3.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-else-if="indeterminate" class="cbox__dash" aria-hidden="true" />
    </span>
    <span v-if="$slots.default || label" class="cbox__label"><slot>{{ label }}</slot></span>
  </div>
</template>

<style scoped>
.cbox {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
  outline: none;
  border-radius: 6px;
  user-select: none;
}
.cbox:focus-visible .cbox__box { box-shadow: var(--focus-ring); }
.cbox.is-disabled { cursor: not-allowed; opacity: .5; }

.cbox__box {
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid var(--hairline-3);
  border-radius: 5px;
  background: var(--surface);
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
}
.cbox--md .cbox__box { width: 16px; height: 16px; margin-top: 1.5px; }
.cbox--sm .cbox__box { width: 14px; height: 14px; margin-top: 2px; }

.cbox:hover:not(.is-disabled) .cbox__box { border-color: var(--accent); }
.cbox.is-on .cbox__box,
.cbox.is-indet .cbox__box {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.cbox--good.is-on .cbox__box,
.cbox--good.is-indet .cbox__box { background: var(--good); border-color: var(--good); }
.cbox--warning.is-on .cbox__box,
.cbox--warning.is-indet .cbox__box { background: var(--warning); border-color: var(--warning); }

.cbox__tick { width: 11px; height: 11px; display: block; }
.cbox__tick path {
  stroke-dasharray: 14;
  stroke-dashoffset: 0;
  animation: cbox-draw var(--dur-2) var(--ease-out-expo) both;
}
@keyframes cbox-draw { from { stroke-dashoffset: 14; } to { stroke-dashoffset: 0; } }

.cbox__dash { width: 8px; height: 2px; border-radius: 1px; background: currentColor; display: block; }

.cbox__label { font-size: 12px; color: var(--ink-2); line-height: 1.5; min-width: 0; }

@media (prefers-reduced-motion: reduce) {
  .cbox__box { transition: none; }
  .cbox__tick path { animation: none; }
}
</style>
