<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * 迷你趋势线。单系列、无坐标轴——放在数字下面表达"最近的走向"，
 * 不承担精确读数的职责（精确值看上面的数字和 hover 提示）。
 */
const props = defineProps<{ data: number[]; labels?: string[] }>();

const width = 240;
const height = 34;
const hoverIndex = ref<number | null>(null);

const points = computed(() => {
    const data = props.data?.length ? props.data : [0];
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const span = Math.max(1, max - min);
    return data.map((value, index) => ({
        x: data.length === 1 ? width / 2 : 2 + (index * (width - 4)) / (data.length - 1),
        y: 3 + (height - 8) * (1 - (value - min) / span),
        value,
        index,
    }));
});

const linePath = computed(() => points.value.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
const areaPath = computed(() => `2,${height - 2} ${linePath.value} ${width - 2},${height - 2}`);
const last = computed(() => points.value[points.value.length - 1]);

function onMove(event: MouseEvent) {
    const target = event.currentTarget as SVGElement;
    const rect = target.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.round(ratio * ((props.data?.length || 1) - 1));
    hoverIndex.value = Math.max(0, Math.min((props.data?.length || 1) - 1, index));
}
</script>

<template>
  <div class="relative">
    <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none"
      class="w-full h-[34px] block overflow-visible"
      @mousemove="onMove" @mouseleave="hoverIndex = null">
      <polygon :points="areaPath" fill="color-mix(in srgb, var(--series-1) 14%, transparent)" />
      <polyline :points="linePath" fill="none" stroke="var(--series-1)" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      <circle v-if="last" :cx="last.x" :cy="last.y" r="3" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" />
      <line v-if="hoverIndex !== null && points[hoverIndex]" :x1="points[hoverIndex].x" y1="0" :x2="points[hoverIndex].x" :y2="height"
        stroke="var(--hairline-2)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <div v-if="hoverIndex !== null"
      class="absolute -top-6 px-1.5 py-0.5 rounded text-[10px] mono whitespace-nowrap pointer-events-none z-10"
      style="background: var(--ink); color: var(--page)"
      :style="{ left: `${(hoverIndex / Math.max(1, (data?.length || 1) - 1)) * 100}%`, transform: 'translateX(-50%)' }">
      {{ labels?.[hoverIndex] ?? hoverIndex }}:00 · {{ data[hoverIndex] }}
    </div>
  </div>
</template>
