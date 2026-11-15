<script setup lang="ts">
/** UiEmptyState —— 空态（图标 + 标题 + 说明 + 可选行动按钮）。 */
withDefaults(defineProps<{
    title: string;
    description?: string;
    icon?: string;
}>(), {
    description: '',
    icon: 'box',
});
</script>

<template>
  <div class="empty ui-pop-in">
    <span class="empty__icon" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <template v-if="icon === 'search'">
          <circle cx="14" cy="14" r="8" /><path d="M20 20l6 6" />
        </template>
        <template v-else-if="icon === 'alert'">
          <path d="M16 5l11 20H5z" /><path d="M16 13v6M16 23v.1" />
        </template>
        <template v-else-if="icon === 'inbox'">
          <path d="M4 19l3-11h18l3 11v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M4 19h7l1.5 3h7L21 19h7" />
        </template>
        <template v-else-if="icon === 'image'">
          <rect x="4" y="6" width="24" height="20" rx="2" /><circle cx="11" cy="13" r="2" />
          <path d="M5 24l7-7 5 5 4-4 6 6" />
        </template>
        <template v-else>
          <path d="M4 11l12-7 12 7-12 7z" /><path d="M4 11v10l12 7 12-7V11" /><path d="M16 18v10" />
        </template>
      </svg>
    </span>
    <p class="empty__title">{{ title }}</p>
    <p v-if="description" class="empty__desc">{{ description }}</p>
    <div v-if="$slots.action" class="empty__action"><slot name="action" /></div>
  </div>
</template>

<style scoped>
.empty {
  display: grid;
  justify-items: center;
  gap: 5px;
  padding: 34px 16px;
  text-align: center;
}
.empty__icon {
  display: grid;
  place-items: center;
  width: 46px; height: 46px;
  margin-bottom: 4px;
  border-radius: 13px;
  background: var(--surface-2);
  color: var(--ink-3);
}
.empty__title {
  margin: 0;
  font-family: var(--serif);
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
}
.empty__desc {
  margin: 0;
  max-width: 34ch;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink-3);
}
.empty__action { margin-top: 8px; }
</style>
