<script setup lang="ts">
/** UiSkeleton —— 骨架占位，微光扫过（1.4s），尊重 reduced-motion。 */
withDefaults(defineProps<{
    width?: string | number;
    height?: string | number;
    radius?: string | number;
    circle?: boolean;
    /** 渲染多行；最后一行 60% 宽 */
    lines?: number;
}>(), {
    width: undefined,
    height: 12,
    radius: 6,
    circle: false,
    lines: undefined,
});

function toCss(v: string | number | undefined): string | undefined {
    if (v == null) return undefined;
    return typeof v === 'number' ? `${v}px` : v;
}
</script>

<template>
  <template v-if="lines">
    <span
      v-for="i in lines"
      :key="i"
      class="sk"
      :style="{
        width: i === lines && lines > 1 ? '60%' : (toCss(width) || '100%'),
        height: toCss(height),
        borderRadius: toCss(radius),
      }"
    />
  </template>
  <span
    v-else
    class="sk"
    :class="{ 'sk--circle': circle }"
    :style="{
      width: circle ? toCss(height) : (toCss(width) || '100%'),
      height: toCss(height),
      borderRadius: circle ? '50%' : toCss(radius),
    }"
  />
</template>

<style scoped>
.sk {
  display: block;
  background: linear-gradient(
    90deg,
    var(--surface-2) 0%,
    color-mix(in srgb, var(--hairline-2) 60%, var(--surface-2)) 40%,
    var(--surface-2) 80%
  );
  background-size: 200% 100%;
  animation: sk-shimmer 1.4s var(--ease-swift) infinite;
  flex: none;
}
@keyframes sk-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
