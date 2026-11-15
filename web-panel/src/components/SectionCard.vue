<script setup lang="ts">
/**
 * SectionCard —— 内容区分组卡片的统一外壳。
 *
 * Phase-UI 2 视觉层次：
 * - 头部左侧加一条 2px 语义色竖条（默认松绿 accent），给满屏米白一点「定位色」，
 *   让每组卡片有稳定的视觉锚点，而不是一片灰。
 * - 头部底色用 accent 的 3% 极淡混色（不是渐变，是一层平涂），把「标题区」和
 *   「表单区」在层次上分开，靠明度差而不是靠粗边框。
 * - tone 可按语义换色（accent / good / warn / crit / info / parse），
 *   对应项目里已有的能力分类色 token。
 */
withDefaults(defineProps<{
    title?: string;
    hint?: string;
    noPadding?: boolean;
    /** 头部语义色：默认 accent（松绿） */
    tone?: 'accent' | 'good' | 'warn' | 'crit' | 'info' | 'parse' | 'plain';
}>(), {
    title: '',
    hint: '',
    noPadding: false,
    tone: 'accent',
});
</script>

<template>
  <section class="card sc" :data-tone="tone">
    <header
      v-if="title || $slots.actions"
      class="sc__head flex flex-wrap items-center gap-3 px-4 py-3 border-b border-[color:var(--hairline-2)]"
    >
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

<style scoped>
/* 语义色映射：全部走既有 token，深色主题自动跟随 */
.sc {
    --sc-tone: var(--accent);
    --sc-tone-soft: var(--accent-soft);
}
.sc[data-tone='good'] { --sc-tone: var(--good); --sc-tone-soft: var(--good-soft); }
.sc[data-tone='warn'] { --sc-tone: var(--warning); --sc-tone-soft: var(--warning-soft); }
.sc[data-tone='crit'] { --sc-tone: var(--critical); --sc-tone-soft: var(--critical-soft); }
.sc[data-tone='info'] { --sc-tone: var(--c-info); --sc-tone-soft: var(--c-info-soft); }
.sc[data-tone='parse'] { --sc-tone: var(--c-parse); --sc-tone-soft: var(--c-parse-soft); }
.sc[data-tone='plain'] { --sc-tone: var(--hairline-3); --sc-tone-soft: var(--surface-2); }

.sc__head {
    position: relative;
    border-radius: 12px 12px 0 0;
    /* 平涂极淡底色（不是渐变）：把标题区从表单区里「抬」出来 */
    background: color-mix(in srgb, var(--sc-tone-soft) 55%, var(--surface));
}
/* 左侧 2px 语义竖条：卡片组的定位色 */
.sc__head::before {
    content: '';
    position: absolute;
    left: 0;
    top: 10px;
    bottom: 10px;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: var(--sc-tone);
    opacity: .75;
}
</style>
