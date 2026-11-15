<script setup lang="ts">
/**
 * UiSlider —— 自研滑动条（替代 input[type=range]）。
 * 自绘轨道 + 已填充段 + 手柄；pointer 捕获拖动；拖动时手柄上方浮出数值气泡。
 */
import { computed, onBeforeUnmount, ref } from 'vue';

const props = withDefaults(defineProps<{
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    showValue?: boolean;
    tone?: 'accent' | 'good' | 'warning';
    format?: (v: number) => string;
    label?: string;
}>(), {
    min: 0,
    max: 100,
    step: 1,
    disabled: false,
    showValue: false,
    tone: 'accent',
    format: undefined,
    label: '滑块',
});

const model = defineModel<number>({ default: 0 });
const emit = defineEmits<{ change: [value: number] }>();

const trackEl = ref<HTMLDivElement | null>(null);
const dragging = ref(false);

const percent = computed(() => {
    const span = props.max - props.min;
    if (span <= 0) return 0;
    return Math.min(100, Math.max(0, ((model.value - props.min) / span) * 100));
});

const display = computed(() => (props.format ? props.format(model.value) : String(model.value)));

function snap(raw: number): number {
    const step = props.step || 1;
    const steps = Math.round((raw - props.min) / step);
    const v = props.min + steps * step;
    const clamped = Math.min(props.max, Math.max(props.min, v));
    // 消除 0.30000000000000004 这类浮点尾巴
    const digits = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    return Number(clamped.toFixed(digits));
}

function valueFromClientX(clientX: number): number {
    const el = trackEl.value;
    if (!el) return model.value;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return model.value;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snap(props.min + ratio * (props.max - props.min));
}

function apply(v: number) {
    if (v === model.value) return;
    model.value = v;
}

function onPointerDown(e: PointerEvent) {
    if (props.disabled) return;
    dragging.value = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    apply(valueFromClientX(e.clientX));
}

function onPointerMove(e: PointerEvent) {
    if (!dragging.value || props.disabled) return;
    apply(valueFromClientX(e.clientX));
}

function onPointerUp(e: PointerEvent) {
    if (!dragging.value) return;
    dragging.value = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    emit('change', model.value);
}

function onKeydown(e: KeyboardEvent) {
    if (props.disabled) return;
    const big = props.step * 10;
    let next: number | null = null;
    switch (e.key) {
        case 'ArrowRight': case 'ArrowUp': next = model.value + props.step; break;
        case 'ArrowLeft': case 'ArrowDown': next = model.value - props.step; break;
        case 'PageUp': next = model.value + big; break;
        case 'PageDown': next = model.value - big; break;
        case 'Home': next = props.min; break;
        case 'End': next = props.max; break;
    }
    if (next == null) return;
    e.preventDefault();
    const v = snap(next);
    apply(v);
    emit('change', v);
}

onBeforeUnmount(() => { dragging.value = false; });
</script>

<template>
  <div class="slider" :class="[`slider--${tone}`, { 'is-disabled': disabled, 'is-dragging': dragging }]">
    <div
      ref="trackEl"
      class="slider__track"
      :class="{ 'slider__track--ro': disabled }"
      role="slider"
      :aria-label="label"
      :aria-valuenow="model"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuetext="display"
      :aria-disabled="disabled || undefined"
      :tabindex="disabled ? -1 : 0"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    >
      <span class="slider__fill" :style="{ width: `${percent}%` }" />
      <span class="slider__thumb" :style="{ left: `${percent}%` }">
        <span v-if="dragging || showValue" class="slider__bubble">{{ display }}</span>
      </span>
    </div>
    <span v-if="showValue && !dragging" class="slider__value">{{ display }}</span>
  </div>
</template>

<style scoped>
.slider {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
}

.slider__track {
  position: relative;
  flex: 1 1 auto;
  height: 22px;
  display: flex;
  align-items: center;
  cursor: pointer;
  outline: none;
  touch-action: none;
}
.slider__track::before {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--hairline-3);
}
.slider__track:focus-visible::before { box-shadow: var(--focus-ring); }
.slider__track--ro { cursor: not-allowed; }

.slider__fill {
  position: absolute;
  left: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--accent);
  transition: width var(--dur-1) var(--ease-swift);
}
.slider--good .slider__fill { background: var(--good); }
.slider--warning .slider__fill { background: var(--warning); }
.slider.is-dragging .slider__fill { transition: none; }

.slider__thumb {
  position: absolute;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px solid var(--accent);
  box-shadow: 0 1px 3px rgba(30, 28, 20, .2);
  transition: transform var(--dur-1) var(--ease-out-expo), box-shadow var(--dur-1) var(--ease);
}
.slider--good .slider__thumb { border-color: var(--good); }
.slider--warning .slider__thumb { border-color: var(--warning); }

.slider:not(.is-disabled) .slider__track:hover .slider__thumb { transform: scale(1.15); }
.slider.is-dragging .slider__thumb {
  transform: scale(1.2);
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 16%, transparent), 0 1px 3px rgba(30, 28, 20, .2);
}
.slider.is-disabled .slider__thumb { border-color: var(--ink-3); opacity: .55; }
.slider.is-disabled .slider__fill { background: var(--ink-3); }

.slider__bubble {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--ink);
  color: var(--page);
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  animation: ui-pop-in var(--dur-1) var(--ease-out-expo) both;
}

.slider__value {
  flex: none;
  min-width: 34px;
  text-align: right;
  font-family: var(--mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}

@media (prefers-reduced-motion: reduce) {
  .slider__fill, .slider__thumb { transition: none; }
}
</style>
