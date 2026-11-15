<script setup lang="ts">
/**
 * UiSegmented —— 分段控件（少量互斥选项，比 radio 卡片更紧凑）。
 * 滑动指示块用 transform 过渡，营造「同一个滑块在移动」的连续感。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';

export interface UiSegmentOption {
    value: string | number;
    label: string;
    icon?: string;
    title?: string;
}

const props = withDefaults(defineProps<{
    options: UiSegmentOption[];
    size?: 'sm' | 'md';
    block?: boolean;
    disabled?: boolean;
    label?: string;
}>(), {
    size: 'md',
    block: false,
    disabled: false,
    label: '分段选择',
});

const model = defineModel<string | number>({ default: '' });
const emit = defineEmits<{ change: [value: string | number] }>();

const wrapEl = ref<HTMLElement | null>(null);
const indicator = ref({ x: 0, w: 0, ready: false });

const activeIndex = computed(() => props.options.findIndex(o => String(o.value) === String(model.value)));

async function measure() {
    await nextTick();
    const wrap = wrapEl.value;
    if (!wrap) return;
    const btns = wrap.querySelectorAll<HTMLElement>('[data-seg]');
    const el = btns[activeIndex.value];
    if (!el) { indicator.value = { ...indicator.value, ready: false }; return; }
    indicator.value = { x: el.offsetLeft, w: el.offsetWidth, ready: true };
}

onMounted(measure);
watch(() => [model.value, props.options.length], measure);
</script>

<template>
  <div
    ref="wrapEl"
    class="seg"
    :class="[`seg--${size}`, { 'seg--block': block, 'is-disabled': disabled }]"
    role="tablist"
    :aria-label="label"
  >
    <span
      v-if="indicator.ready"
      class="seg__indicator"
      :style="{ transform: `translateX(${indicator.x}px)`, width: `${indicator.w}px` }"
      aria-hidden="true"
    />
    <button
      v-for="opt in options"
      :key="String(opt.value)"
      data-seg
      type="button"
      class="seg__btn"
      :class="{ 'is-active': String(opt.value) === String(model) }"
      role="tab"
      :aria-selected="String(opt.value) === String(model)"
      :disabled="disabled"
      :title="opt.title"
      @click="model = opt.value; emit('change', opt.value)"
    >{{ opt.label }}</button>
  </div>
</template>

<style scoped>
.seg {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--hairline-2);
  border-radius: 9px;
  background: var(--surface-2);
  min-width: 0;
}
.seg--block { display: flex; }
.seg--block .seg__btn { flex: 1 1 0; }
.seg.is-disabled { opacity: .5; }

.seg__indicator {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  border-radius: 7px;
  background: var(--surface);
  border: 1px solid var(--hairline-2);
  box-shadow: 0 1px 2px rgba(30, 28, 20, .06);
  transition: transform var(--dur-3) var(--ease-out-expo), width var(--dur-3) var(--ease-out-expo);
  pointer-events: none;
}

.seg__btn {
  position: relative;
  z-index: 1;
  border: 0;
  background: transparent;
  border-radius: 7px;
  color: var(--ink-2);
  cursor: pointer;
  font-weight: 500;
  white-space: nowrap;
  outline: none;
  transition: color var(--dur-1) var(--ease);
}
.seg--md .seg__btn { height: 26px; padding: 0 10px; font-size: 11.5px; }
.seg--sm .seg__btn { height: 22px; padding: 0 8px; font-size: 11px; }

.seg__btn:hover:not(:disabled):not(.is-active) { color: var(--ink); }
.seg__btn.is-active { color: var(--accent); font-weight: 600; }
.seg__btn:focus-visible { box-shadow: var(--focus-ring); }
.seg__btn:disabled { cursor: not-allowed; }

@media (prefers-reduced-motion: reduce) {
  .seg__indicator { transition: none; }
}
</style>
