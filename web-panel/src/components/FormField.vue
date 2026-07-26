<script setup lang="ts">
defineProps<{ label?: string; hint?: string }>();
</script>

<template>
  <div class="min-w-0">
    <label v-if="label" class="label-sm">{{ label }}</label>
    <slot />
    <p v-if="hint" class="text-[color:var(--ink-3)] text-xs mt-1">{{ hint }}</p>
  </div>
</template>
