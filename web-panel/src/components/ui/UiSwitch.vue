<script setup lang="ts">
/**
 * UiSwitch —— 自研开关（替代裸 input[type=checkbox] 的单选开关场景）。
 * 滑块位移用 --ease-out-expo，轨道 on 态渐变铺色；键盘 Space/Enter 切换。
 */
const props = withDefaults(defineProps<{
    disabled?: boolean;
    size?: 'sm' | 'md';
    tone?: 'accent' | 'good' | 'warning';
    loading?: boolean;
    /** 无障碍名称；无可见 label 时必填 */
    label?: string;
}>(), {
    disabled: false,
    size: 'md',
    tone: 'accent',
    loading: false,
    label: '切换',
});

const model = defineModel<boolean>({ default: false });
const emit = defineEmits<{ change: [value: boolean] }>();

function toggle() {
    if (props.disabled || props.loading) return;
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
  <button
    type="button"
    class="switch"
    :class="[`switch--${size}`, `switch--${tone}`, { 'is-on': model, 'is-disabled': disabled || loading }]"
    role="switch"
    :aria-checked="model"
    :aria-label="label"
    :aria-busy="loading || undefined"
    :disabled="disabled || loading"
    :tabindex="disabled ? -1 : 0"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span class="switch__track"><span class="switch__thumb" /></span>
  </button>
</template>

<style scoped>
.switch {
  display: inline-flex;
  flex: none;
  align-items: center;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
  border-radius: 999px;
  outline: none;
}
.switch:focus-visible { box-shadow: var(--focus-ring); }
.switch.is-disabled { cursor: not-allowed; opacity: .5; }

.switch__track {
  position: relative;
  display: block;
  border-radius: 999px;
  background: var(--hairline-3);
  transition: background var(--dur-2) var(--ease-out-expo);
}
.switch--md .switch__track { width: 34px; height: 20px; }
.switch--sm .switch__track { width: 28px; height: 17px; }

.switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(30, 28, 20, .22);
  transition: transform var(--dur-2) var(--ease-out-expo);
}
.switch--md .switch__thumb { width: 16px; height: 16px; }
.switch--sm .switch__thumb { width: 13px; height: 13px; }

.switch.is-on .switch__track { background: var(--accent); }
.switch--good.is-on .switch__track { background: var(--good); }
.switch--warning.is-on .switch__track { background: var(--warning); }

.switch--md.is-on .switch__thumb { transform: translateX(14px); }
.switch--sm.is-on .switch__thumb { transform: translateX(11px); }

/* 悬停给轨道一点点提亮，暗示「这是可点的」 */
.switch:hover:not(.is-disabled) .switch__track { background: var(--ink-3); }
.switch.is-on:hover:not(.is-disabled) .switch__track { background: color-mix(in srgb, var(--accent) 86%, #000); }
.switch--good.is-on:hover:not(.is-disabled) .switch__track { background: color-mix(in srgb, var(--good) 86%, #000); }
.switch--warning.is-on:hover:not(.is-disabled) .switch__track { background: color-mix(in srgb, var(--warning) 86%, #000); }

@media (prefers-reduced-motion: reduce) {
  .switch__track, .switch__thumb { transition: none; }
}
</style>
