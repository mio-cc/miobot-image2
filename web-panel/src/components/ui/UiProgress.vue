<script setup lang="ts">
/** UiProgress —— 线性进度条（确定态 / 不确定态）。 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{
    value?: number;
    indeterminate?: boolean;
    tone?: 'accent' | 'good' | 'warning';
    height?: number;
    label?: string;
}>(), {
    value: 0,
    indeterminate: false,
    tone: 'accent',
    height: 3,
    label: '进度',
});

const pct = computed(() => Math.min(100, Math.max(0, props.value)));
</script>

<template>
  <div
    class="prog"
    :class="[`prog--${tone}`, { 'is-indet': indeterminate }]"
    :style="{ height: `${height}px` }"
    role="progressbar"
    :aria-label="label"
    :aria-valuenow="indeterminate ? undefined : Math.round(pct)"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <span v-if="indeterminate" class="prog__bar prog__bar--indet" />
    <span v-else class="prog__bar" :style="{ width: `${pct}%` }" />
  </div>
</template>

<style scoped>
.prog {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 999px;
  background: var(--hairline-2);
}

.prog__bar {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width var(--dur-3) var(--ease-out-expo);
}
.prog--good .prog__bar { background: var(--good); }
.prog--warning .prog__bar { background: var(--warning); }

.prog__bar--indet {
  width: 40%;
  animation: prog-slide 1.15s var(--ease-swift) infinite;
}
@keyframes prog-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}

@media (prefers-reduced-motion: reduce) {
  .prog__bar { transition: none; }
  .prog__bar--indet { animation: none; width: 100%; opacity: .5; }
}
</style>
