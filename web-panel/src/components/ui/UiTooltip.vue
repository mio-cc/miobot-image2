<script setup lang="ts">
/**
 * UiTooltip —— 轻量气泡提示（替代大量 title= 原生浏览器气泡）。
 * Teleport 到 body + fixed 定位（避免被 overflow/transform 容器裁剪）+ 箭头 + 200ms 淡入。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
    content: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number;
    disabled?: boolean;
}>(), {
    placement: 'top',
    delay: 120,
    disabled: false,
});

const anchorEl = ref<HTMLElement | null>(null);
const visible = ref(false);
const pos = ref({ x: 0, y: 0 });
let timer: number | null = null;

const resolvedPlacement = ref(props.placement);

function show() {
    if (props.disabled || !props.content) return;
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
        measure();
        visible.value = true;
    }, props.delay);
}

function hide() {
    if (timer != null) { window.clearTimeout(timer); timer = null; }
    visible.value = false;
}

/** 依据锚点矩形与视口空间决定实际朝向，并夹取到视口内。 */
function measure() {
    const el = anchorEl.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 7;
    const gapY = 8;
    let place = props.placement;

    if (place === 'top' && r.top < 34) place = 'bottom';
    else if (place === 'bottom' && window.innerHeight - r.bottom < 34) place = 'top';
    else if (place === 'left' && r.left < 90) place = 'right';
    else if (place === 'right' && window.innerWidth - r.right < 90) place = 'left';
    resolvedPlacement.value = place;

    let x = 0;
    let y = 0;
    if (place === 'top') { x = r.left + r.width / 2; y = r.top - gapY; }
    else if (place === 'bottom') { x = r.left + r.width / 2; y = r.bottom + gapY; }
    else if (place === 'left') { x = r.left - gapY; y = r.top + r.height / 2; }
    else { x = r.right + gapY; y = r.top + r.height / 2; }

    // 夹到视口内，避免长文案顶出屏幕
    const halfW = 90;
    x = Math.min(window.innerWidth - halfW, Math.max(halfW, x));
    pos.value = { x, y };
    void gap;
}

const placementClass = computed(() => `tt--${resolvedPlacement.value}`);

watch(() => props.placement, () => { if (visible.value) measure(); });

onBeforeUnmount(() => { if (timer != null) window.clearTimeout(timer); });
</script>

<template>
  <span
    ref="anchorEl"
    class="tt-anchor"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
    @pointerdown="hide"
  >
    <slot />
  </span>

  <Teleport to="body">
    <Transition name="tt">
      <span
        v-if="visible"
        class="tt"
        :class="placementClass"
        role="tooltip"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      >{{ content }}</span>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tt-anchor { display: inline-flex; min-width: 0; }

.tt {
  position: fixed;
  z-index: 300;
  max-width: 260px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--ink);
  color: var(--page);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.45;
  white-space: pre-line;
  pointer-events: none;
  box-shadow: var(--sh-2);
}

.tt--top { transform: translate(-50%, -100%); }
.tt--bottom { transform: translate(-50%, 0); }
.tt--left { transform: translate(-100%, -50%); }
.tt--right { transform: translate(0, -50%); }

.tt-enter-active { transition: opacity var(--dur-1) var(--ease-out-expo); }
.tt-leave-active { transition: opacity var(--dur-1) var(--ease-swift); }
.tt-enter-from, .tt-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .tt-enter-active, .tt-leave-active { transition: none; }
}
</style>
