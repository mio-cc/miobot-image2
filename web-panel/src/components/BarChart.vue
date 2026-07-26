<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * 24 小时柱状图。单系列、细柱、圆角柱顶贴基线，
 * 网格线与坐标轴保持弱化，精确读数靠 hover。
 */
const props = defineProps<{ data: number[]; labels: string[]; unit?: string }>();

const width = 720;
const height = 180;
const padLeft = 32;
const padBottom = 20;
const padTop = 8;
const hoverIndex = ref<number | null>(null);

const series = computed(() => props.data || []);
const max = computed(() => Math.max(...(series.value.length ? series.value : [0]), 1));
const innerWidth = computed(() => width - padLeft - 6);
const innerHeight = computed(() => height - padTop - padBottom);
const barWidth = computed(() => innerWidth.value / Math.max(1, series.value.length));

const bars = computed(() => series.value.map((value, index) => {
    const h = Math.max(2, (innerHeight.value * value) / max.value);
    return {
        index,
        value,
        x: padLeft + index * barWidth.value + barWidth.value * 0.18,
        w: barWidth.value * 0.64,
        y: padTop + innerHeight.value - h,
        h,
    };
}));

const gridLines = computed(() => [0, 0.5, 1].map(fraction => ({
    y: padTop + innerHeight.value * (1 - fraction),
    label: Math.round(max.value * fraction),
})));

/** 柱顶圆角、柱底贴基线的路径。 */
function barPath(bar: { x: number; y: number; w: number; h: number }) {
    const r = Math.min(3, bar.w / 2, bar.h);
    const bottom = bar.y + bar.h;
    return `M${bar.x},${bottom} L${bar.x},${bar.y + r} Q${bar.x},${bar.y} ${bar.x + r},${bar.y}`
        + ` L${bar.x + bar.w - r},${bar.y} Q${bar.x + bar.w},${bar.y} ${bar.x + bar.w},${bar.y + r}`
        + ` L${bar.x + bar.w},${bottom} Z`;
}
</script>

<template>
  <div class="relative">
    <svg :viewBox="`0 0 ${width} ${height}`" class="w-full block" style="height: 180px">
      <g>
        <line v-for="line in gridLines" :key="line.y" :x1="padLeft" :y1="line.y" :x2="width - 6" :y2="line.y"
          stroke="var(--hairline-2)" stroke-width="1" />
        <text v-for="line in gridLines" :key="`t-${line.y}`" :x="padLeft - 6" :y="line.y + 3.5"
          text-anchor="end" font-size="10" fill="var(--ink-3)">{{ line.label }}</text>
      </g>

      <path v-for="bar in bars" :key="bar.index" :d="barPath(bar)"
        fill="var(--series-1)" :opacity="hoverIndex === null || hoverIndex === bar.index ? 1 : 0.45"
        @mouseenter="hoverIndex = bar.index" @mouseleave="hoverIndex = null" />

      <text v-for="(label, index) in labels" :key="`x-${index}`" v-show="index % 4 === 0"
        :x="padLeft + index * barWidth + barWidth / 2" :y="height - 5"
        text-anchor="middle" font-size="10" fill="var(--ink-3)">{{ label }}</text>

      <line :x1="padLeft" :y1="padTop + innerHeight" :x2="width - 6" :y2="padTop + innerHeight"
        stroke="var(--hairline-2)" stroke-width="1" />
    </svg>

    <div v-if="hoverIndex !== null"
      class="absolute top-0 px-2 py-1 rounded text-[11px] mono whitespace-nowrap pointer-events-none"
      style="background: var(--ink); color: var(--page)"
      :style="{ left: `${((padLeft + hoverIndex * barWidth + barWidth / 2) / width) * 100}%`, transform: 'translateX(-50%)' }">
      {{ labels[hoverIndex] }}:00 · {{ data[hoverIndex] }}{{ unit || '' }}
    </div>
  </div>
</template>
