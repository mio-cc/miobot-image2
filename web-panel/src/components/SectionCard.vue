<script setup lang="ts">
defineProps<{ title?: string; hint?: string; noPadding?: boolean }>();
</script>

<template>
  <section class="card">
    <header v-if="title || $slots.actions" class="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-[color:var(--hairline-2)]">
      <div class="min-w-0">
        <h2 class="section-title">{{ title }}</h2>
        <p v-if="hint" class="text-[color:var(--ink-3)] text-xs mt-0.5">{{ hint }}</p>
      </div>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <div :class="noPadding ? '' : 'p-4'">
      <slot />
    </div>
  </section>
</template>
