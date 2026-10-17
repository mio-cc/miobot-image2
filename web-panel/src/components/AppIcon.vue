<script setup lang="ts">
/**
 * 图标集。全部是 1.4 描边的 inline SVG——
 * 控制台不该用 emoji 当图标（尺寸不可控、跨平台字形不一、也是最典型的"AI 味"）。
 */
defineProps<{ name: string; size?: number }>();
</script>

<template>
  <svg :width="size || 15" :height="size || 15" viewBox="0 0 15 15" fill="none"
       stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <template v-if="name === 'search'">
      <circle cx="6.7" cy="6.7" r="4.2" /><path d="M9.8 9.8l3.1 3.1" />
    </template>
    <template v-else-if="name === 'grid'">

      <rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="8.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="8.5" width="5" height="5" rx="1" /><rect x="8.5" y="8.5" width="5" height="5" rx="1" />
    </template>
    <template v-else-if="name === 'route'">
      <path d="M2 3.5h11M2 7.5h11M2 11.5h11" />
      <circle cx="5" cy="3.5" r="1.5" fill="var(--surface)" /><circle cx="10" cy="7.5" r="1.5" fill="var(--surface)" />
      <circle cx="6.5" cy="11.5" r="1.5" fill="var(--surface)" />
    </template>
    <template v-else-if="name === 'server'">
      <rect x="1.5" y="2" width="12" height="4.4" rx="1.2" /><rect x="1.5" y="8.6" width="12" height="4.4" rx="1.2" />
      <circle cx="4.2" cy="4.2" r="0.8" fill="currentColor" stroke="none" /><circle cx="4.2" cy="10.8" r="0.8" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'chat'">
      <path d="M2 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-2.6 2.2V10.5H4a2 2 0 0 1-2-2z" />
    </template>
    <template v-else-if="name === 'voice'">
      <rect x="5.6" y="1.6" width="3.8" height="7.2" rx="1.9" />
      <path d="M3.2 7.2a4.3 4.3 0 0 0 8.6 0M7.5 11.5V13.4M5.4 13.4h4.2" />
    </template>
    <template v-else-if="name === 'template'">
      <rect x="2" y="2" width="11" height="11" rx="1.5" /><path d="M2 5.8h11M5.8 5.8V13" />
    </template>
    <template v-else-if="name === 'canvas'">
      <rect x="1.8" y="2.4" width="11.4" height="8.4" rx="1.2" /><path d="M4.5 13h6M7.5 10.8V13" />
      <path d="M4 8.2l2.2-2.4 1.8 1.7 2.6-3" />
    </template>
    <template v-else-if="name === 'logs'">
      <path d="M2.5 3h10M2.5 6h10M2.5 9h6.5M2.5 12h4" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="7.5" cy="7.5" r="2.2" />
      <path d="M7.5 1.8v1.9M7.5 11.3v1.9M1.8 7.5h1.9M11.3 7.5h1.9M3.5 3.5l1.3 1.3M10.2 10.2l1.3 1.3M11.5 3.5l-1.3 1.3M4.8 10.2l-1.3 1.3" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="M2.5 7.8l3.2 3.2L12.5 4" />
    </template>
    <template v-else-if="name === 'warn'">
      <path d="M7.5 1.8l6 10.4h-12z" /><path d="M7.5 6v2.6M7.5 10.6v.1" />
    </template>
    <template v-else-if="name === 'cross'">
      <circle cx="7.5" cy="7.5" r="5.6" /><path d="M5.3 5.3l4.4 4.4M9.7 5.3l-4.4 4.4" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M12.6 8.9A5.6 5.6 0 1 1 5.8 2a4.5 4.5 0 0 0 6.8 6.9z" />
    </template>
    <template v-else-if="name === 'logout'">
      <path d="M5.8 2.5H3.2a1.2 1.2 0 0 0-1.2 1.2v7.6a1.2 1.2 0 0 0 1.2 1.2h2.6M9.5 10.5L12.5 7.5 9.5 4.5M12.5 7.5H5.5" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M7.5 3v9M3 7.5h9" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M12.5 6.5A5 5 0 1 0 12 10" /><path d="M12.8 2.8v3.7h-3.7" />
    </template>
    <template v-else-if="name === 'chevron'">
      <path d="M5.5 3.5L9.5 7.5 5.5 11.5" />
    </template>
  </svg>
</template>
