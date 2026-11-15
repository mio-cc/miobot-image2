<script setup lang="ts">
/**
 * UiRadio —— 单个单选项，必须放在 UiRadioGroup 内。
 * 选中态：accent 边框 + accent-soft 底 + 圆点缩放入场。
 */
import { computed, inject, onMounted } from 'vue';

const props = withDefaults(defineProps<{
    value: string | number;
    label?: string;
    hint?: string;
    disabled?: boolean;
}>(), {
    label: '',
    hint: '',
    disabled: false,
});

interface GroupCtx {
    model: { value: string | number };
    register: (value: string | number, disabled: boolean) => void;
    move: (dir: 1 | -1, from: string | number) => void;
    groupDisabled: () => boolean;
}

const group = inject<GroupCtx | null>('uiRadioGroup', null);

onMounted(() => group?.register(props.value, props.disabled));

const checked = computed(() => group != null && String(group.model.value) === String(props.value));
const isDisabled = computed(() => props.disabled || (group?.groupDisabled() ?? false));

function select() {
    if (isDisabled.value || !group) return;
    group.model.value = props.value;
}

function onKeydown(e: KeyboardEvent) {
    if (isDisabled.value || !group) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); group.move(1, props.value); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); group.move(-1, props.value); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select(); }
}
</script>

<template>
  <div
    class="radio"
    :class="{ 'is-checked': checked, 'is-disabled': isDisabled }"
    :data-radio-value="String(value)"
    role="radio"
    :aria-checked="checked"
    :aria-disabled="isDisabled || undefined"
    :tabindex="isDisabled ? -1 : (checked || !group ? 0 : -1)"
    @click="select"
    @keydown="onKeydown"
  >
    <span class="radio__dot" aria-hidden="true"><span class="radio__dot-inner" /></span>
    <span class="radio__text">
      <span class="radio__label"><slot>{{ label }}</slot></span>
      <span v-if="hint" class="radio__hint">{{ hint }}</span>
    </span>
  </div>
</template>

<style scoped>
.radio {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid var(--hairline-2);
  border-radius: 9px;
  background: var(--surface);
  cursor: pointer;
  outline: none;
  min-width: 0;
  transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
}
.radio:hover:not(.is-disabled) { border-color: var(--hairline-3); background: var(--surface-2); }
.radio:focus-visible { box-shadow: var(--focus-ring); border-color: var(--accent); }
.radio.is-checked { border-color: var(--accent); background: var(--accent-soft); }
.radio.is-disabled { cursor: not-allowed; opacity: .5; }

.radio__dot {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 1.5px solid var(--hairline-3);
  border-radius: 50%;
  background: var(--surface);
  transition: border-color var(--dur-1) var(--ease);
}
.radio.is-checked .radio__dot { border-color: var(--accent); }

.radio__dot-inner {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  transform: scale(0);
  transition: transform var(--dur-2) var(--ease-out-expo);
}
.radio.is-checked .radio__dot-inner { transform: scale(1); }

.radio__text { min-width: 0; display: grid; gap: 1px; }
.radio__label { font-size: 12px; color: var(--ink); line-height: 1.45; }
.radio.is-checked .radio__label { font-weight: 600; }
.radio__hint { font-size: 11px; color: var(--ink-3); line-height: 1.45; }

@media (prefers-reduced-motion: reduce) {
  .radio, .radio__dot, .radio__dot-inner { transition: none; }
}
</style>
