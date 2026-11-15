<script setup lang="ts">
/** UiSpinner —— 加载指示（SVG 圆弧旋转）。 */
withDefaults(defineProps<{
    size?: number;
    tone?: 'accent' | 'muted' | 'current';
}>(), {
    size: 15,
    tone: 'current',
});
</script>

<template>
  <svg
    class="spin"
    :class="`spin--${tone}`"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    role="status"
    aria-label="加载中"
  >
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4" opacity=".18" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.spin { flex: none; animation: spin-rot .7s linear infinite; }
.spin--accent { color: var(--accent); }
.spin--muted { color: var(--ink-3); }
.spin--current { color: currentColor; }
@keyframes spin-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spin { animation-duration: 1.8s; }
}
</style>
