<script setup lang="ts">
import { computed } from 'vue';

/**
 * 24 小时面积图（宣纸版，对应原型 area-line/area-fill）。
 * 与 BarChart 同 props 契约（data/labels/unit），可平替；
 * 差异：渐变填充 + 首屏描线动画 + 峰值标注。reduced-motion 由全局 CSS 降级。
 */
const props = defineProps<{ data: number[]; labels: string[]; unit?: string }>();

const width = 720;
const height = 190;
const padLeft = 32;
const padBottom = 20;
const padTop = 10;

const series = computed(() => props.data || []);
const max = computed(() => Math.max(...(series.value.length ? series.value : [0]), 1));
const innerWidth = computed(() => width - padLeft - 6);
const innerHeight = computed(() => height - padTop - padBottom);
const step = computed(() => innerWidth.value / Math.max(1, series.value.length - 1));

const points = computed(() => series.value.map((value, index) => ({
  x: padLeft + index * step.value,
  y: padTop + innerHeight.value - (innerHeight.value * value) / max.value,
  value,
})));

/** 平滑折线（Catmull-Rom 近似）：足够趋势图用，不必上 d3。 */
const linePath = computed(() => {
  const pts = points.value;
  if (!pts.length) return '';
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const cx = (prev.x + cur.x) / 2;
    d += ` C${cx},${prev.y} ${cx},${cur.y} ${cur.x},${cur.y}`;
  }
  return d;
});

const areaPath = computed(() => {
  const pts = points.value;
  if (!pts.length) return '';
  const base = padTop + innerHeight.value;
  return `${linePath.value} L${pts[pts.length - 1].x},${base} L${pts[0].x},${base} Z`;
});

/** 峰值点：值最大的第一个点（原型峰值标注语义）。 */
const peak = computed(() => {
  const pts = points.value;
  if (!pts.length) return null;
  let best = pts[0];
  for (const p of pts) if (p.value > best.value) best = p;
  return best.value > 0 ? best : null;
});

const gridLines = computed(() => [0, 0.5, 1].map(fraction => ({
  y: padTop + innerHeight.value * (1 - fraction),
  label: Math.round(max.value * fraction),
})));
</script>

<template>
  <div class="relative">
    <svg :viewBox="`0 0 ${width} ${height}`" class="w-full block" style="height: 190px" role="img" aria-label="24 小时趋势面积图">
      <defs>
        <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--series-1)" stop-opacity=".22" />
          <stop offset="1" stop-color="var(--series-1)" stop-opacity="0" />
        </linearGradient>
      </defs>

      <g>
        <line v-for="line in gridLines" :key="line.y" :x1="padLeft" :y1="line.y" :x2="width - 6" :y2="line.y"
          stroke="var(--hairline-2)" stroke-width="1" />
        <text v-for="line in gridLines" :key="`t-${line.y}`" :x="padLeft - 6" :y="line.y + 3.5"
          text-anchor="end" font-size="10" fill="var(--ink-3)">{{ line.label }}</text>
      </g>

      <path :d="areaPath" fill="url(#area-grad)" />
      <path :d="linePath" fill="none" stroke="var(--series-1)" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round" />

      <template v-if="peak">
        <circle :cx="peak.x" :cy="peak.y" r="3.5" fill="var(--series-1)" />
        <circle :cx="peak.x" :cy="peak.y" r="7" fill="var(--series-1)" opacity=".18" />
        <text :x="Math.min(peak.x + 10, width - 90)" :y="Math.max(peak.y - 6, 12)"
          font-size="11" fill="var(--ink)" font-family="var(--mono)">峰值 {{ peak.value }}{{ unit || '' }}</text>
      </template>

      <text v-for="(label, index) in labels" :key="`x-${index}`" v-show="index % 4 === 0"
        :x="padLeft + index * step" :y="height - 5"
        text-anchor="middle" font-size="10" fill="var(--ink-3)">{{ label }}</text>

      <line :x1="padLeft" :y1="padTop + innerHeight" :x2="width - 6" :y2="padTop + innerHeight"
        stroke="var(--hairline-2)" stroke-width="1" />
    </svg>
  </div>
</template>
