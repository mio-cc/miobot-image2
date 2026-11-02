<script setup lang="ts">
import { computed } from 'vue';

/**
 * 能力健康环（宣纸版 donut）。纯展示组件：
 * 数据来自能力体检（bindings 的 ok/broken/enabled 聚合），
 * 中心衬线数字 + 三段环 + 图例。reduced-motion 下 CSS 降级为静态。
 */
const props = defineProps<{
  ok: number;
  warn: number;
  off: number;
  label?: string;
}>();

const total = computed(() => props.ok + props.warn + props.off);
const R = 54;
const C = 2 * Math.PI * R;

const segs = computed(() => {
  const t = total.value || 1;
  const okLen = (props.ok / t) * C;
  const warnLen = (props.warn / t) * C;
  const offLen = (props.off / t) * C;
  return [
    { key: 'ok', color: 'var(--good)', len: okLen, offset: 0 },
    { key: 'warn', color: 'var(--warning)', len: warnLen, offset: -okLen },
    { key: 'off', color: 'var(--off)', len: offLen, offset: -(okLen + warnLen) },
  ];
});
</script>

<template>
  <div class="flex flex-col items-center">
    <svg width="148" height="148" viewBox="0 0 148 148" role="img"
      :aria-label="`${label || '健康'}：正常 ${ok}，需处理 ${warn}，停用 ${off}`">
      <g transform="rotate(-90 74 74)">
        <circle cx="74" cy="74" :r="R" fill="none" stroke="var(--hairline-2)" stroke-width="13" />
        <circle v-for="seg in segs" :key="seg.key" cx="74" cy="74" :r="R" fill="none"
          :stroke="seg.color" stroke-width="13" stroke-linecap="round"
          :stroke-dasharray="`${Math.max(0, seg.len - 2)} ${C}`" :stroke-dashoffset="seg.offset" />
      </g>
      <text x="74" y="70" text-anchor="middle" class="stat-value" fill="var(--ink)" font-size="24">{{ ok }}<tspan font-size="13" fill="var(--ink-3)"> / {{ total }}</tspan></text>
      <text x="74" y="90" text-anchor="middle" font-size="11" fill="var(--ink-3)">{{ label || '能力正常' }}</text>
    </svg>
    <div class="w-full mt-2">
      <div class="flex items-center gap-2.5 px-1 py-1.5 text-[12.5px] border-b border-dashed border-[color:var(--hairline-2)] last:border-b-0">
        <span class="dot dot-good"></span><span class="flex-1 text-[color:var(--ink-2)]">正常</span><b class="mono">{{ ok }}</b>
      </div>
      <div class="flex items-center gap-2.5 px-1 py-1.5 text-[12.5px] border-b border-dashed border-[color:var(--hairline-2)] last:border-b-0">
        <span class="dot dot-warn"></span><span class="flex-1 text-[color:var(--ink-2)]">需处理</span><b class="mono">{{ warn }}</b>
      </div>
      <div class="flex items-center gap-2.5 px-1 py-1.5 text-[12.5px] border-b border-dashed border-[color:var(--hairline-2)] last:border-b-0">
        <span class="dot" style="background: var(--off); box-shadow: none;"></span><span class="flex-1 text-[color:var(--ink-2)]">已停用</span><b class="mono">{{ off }}</b>
      </div>
    </div>
  </div>
</template>
