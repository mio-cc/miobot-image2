<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client from '../api/client';
import { useCapabilityStore } from '../stores/capabilities';

/**
 * R16/4.1 契约（恢复）：能力中心主数据源 = 能力注册表（/orchestration/capabilities
 * 的 60 个描述符——含 audio.music.generate「Suno 音乐生成」、tts.speak、web.fetch、
 * 文件、搜索、20 个 HTTP 三方 API……）。注册进注册表 → 卡片自动出现，零代码。
 * 有专属完整配置页的能力（生图/音乐/语音/文件/模板）卡片直达专属页，其余走
 * /capabilities/<id> 通用详情页（CapabilityPageLayout 自动成页）。
 * R21-h 新增「模型体检」辅助视图（18 个绑定：日常对话/文生图……的节点+模型体检）。
 */

const store = useCapabilityStore();
const keyword = ref('');
const category = ref('全部');
const view = ref<'registry' | 'health'>('registry');

const CATEGORIES: Array<{ id: string; label: string; count: string; match: (key: string) => boolean }> = [
  { id: '全部', label: '全部', count: '', match: () => true },
  { id: '生成', label: '生成', count: '', match: (key) => /^(image|video|audio|code)/.test(key) },
  { id: '解析', label: '解析', count: '', match: (key) => /^(file|memory|ocr|interrogate)/.test(key) },
  { id: '信息', label: '信息', count: '', match: (key) => /^(web|search|render|browser|http)/.test(key) },
  { id: '输入', label: '输入', count: '', match: (key) => /^(session|reply|voice|tts|job|capability|prompt|owner|template|task|canvas)/.test(key) },
];

function categoryOf(key: string): string {
  for (const cat of CATEGORIES) {
    if (cat.id !== '全部' && cat.match(key)) return cat.id;
  }
  return '其他';
}

/** 分类 → CSS 类 + SVG 图标 path（C2 手绘线性） */
const CATEGORY_META: Record<string, { tagClass: string; svg: string }> = {
  '生成': { tagClass: 'tag-gen', svg: 'M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8.5z|M13.5 3.5V8.5H18.5|M9 13h6M9 16h4' },
  '信息': { tagClass: 'tag-info', svg: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' },
  '解析': { tagClass: 'tag-parse', svg: 'M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8.5z|M13.5 3.5V8.5H18.5' },
  '输入': { tagClass: 'tag-input', svg: 'M8 2.5H5.5A2.5 2.5 0 0 0 3 5v3M16 2.5h2.5A2.5 2.5 0 0 1 21 5v3M21 16v3a2.5 2.5 0 0 1-2.5 2.5H16M3 16v3a2.5 2.5 0 0 0 2.5 2.5H8' },
  '其他': { tagClass: '', svg: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' },
};

function catTag(key: string): string {
  return CATEGORY_META[categoryOf(key)]?.tagClass || '';
}
function catSvg(key: string): string {
  return CATEGORY_META[categoryOf(key)]?.svg || CATEGORY_META['其他'].svg;
}

// 专属完整配置页：单击直达；未列出的走 /capabilities/<id> 通用详情页。
const DEDICATED: Record<string, string> = {
  'image.generate': '/cap-image',
  'image.edit': '/cap-image',
  'image.interrogate': '/cap-image',
  'audio.music.generate': '/cap-music',
  'tts.speak': '/cap-voice',
  'file.read': '/cap-file',
  'file.list': '/cap-file',
  'file.generate': '/cap-file',
  'template.use': '/templates',
  'template.list': '/templates',
};

/* ── 主视图：注册表描述符卡（R16 契约数据源） ── */

interface RegItem {
  id: string;
  name: string;
  provider: string;
  riskLevel?: string;
  health?: { status?: string; detail?: string };
}
const registry = ref<RegItem[]>([]);
const registryLoading = ref(false);
const registryError = ref('');

async function refreshRegistry() {
  registryLoading.value = true;
  registryError.value = '';
  try {
    const res = await client.get('/orchestration/capabilities');
    registry.value = res.data.capabilities || [];
  } catch (e: any) {
    registryError.value = e?.response?.data?.error || e?.message || '读取能力注册表失败';
  } finally { registryLoading.value = false; }
}

/** 体检绑定 → 注册表 id 的模型/节点信息映射（能对上的卡片显示节点·模型）。 */
const BIND_TO_DESC: Record<string, string> = {
  chat: 'chat.reply',
  image: 'image.generate',
  edit: 'image.edit',
  interrogate: 'image.interrogate',
  video: 'video.generate',
  enhance: 'prompt.enhance',
  template: 'template.use',
  translation: 'prompt.translate',
};

const descBinding = computed(() => {
  const map: Record<string, { node: string; model: string; ok: boolean; reason?: string; enabled: boolean }> = {};
  for (const b of store.bindings) {
    const descId = BIND_TO_DESC[b.key];
    if (descId) map[descId] = { node: b.nodeName, model: b.model, ok: b.ok, reason: b.reason, enabled: b.enabled };
  }
  return map;
});

interface Card {
  id: string;
  label: string;
  category: string;
  sub: string;
  ok: boolean;
  enabled: boolean;
  reason: string;
  href: string;
}

const registryCards = computed<Card[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  return registry.value
    .filter((item) => category.value === '全部' ? true : categoryOf(item.id) === category.value)
    .filter((item) => !kw || `${item.id} ${item.name}`.toLowerCase().includes(kw))
    .map((item) => {
      const bound = descBinding.value[item.id];
      const status = String(item.health?.status || '');
      return {
        id: item.id,
        label: item.name || item.id,
        category: categoryOf(item.id),
        sub: bound ? `${bound.node}${bound.model ? ' · ' + bound.model : ''}` : item.provider,
        ok: status !== 'disabled' && status !== 'unconfigured',
        enabled: status !== 'disabled',
        reason: item.health?.detail || status || '',
        href: DEDICATED[item.id] || `/capabilities/${encodeURIComponent(item.id)}`,
      };
    });
});

/* ── 辅视图：模型体检绑定卡（节点+模型可用性） ── */
const healthCards = computed<Card[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  return store.bindings
    .filter((b) => category.value === '全部' ? true : categoryOf(b.key) === category.value)
    .filter((b) => !kw || `${b.key} ${b.label}`.toLowerCase().includes(kw))
    .map((b) => ({
      id: b.key,
      label: b.label || b.key,
      category: categoryOf(b.key),
      sub: b.nodeName + (b.model ? ' · ' + b.model : ''),
      ok: b.ok,
      enabled: b.enabled,
      reason: b.reason || '',
      href: DEDICATED[BIND_TO_DESC[b.key] || ''] || `/capabilities/${encodeURIComponent(b.key)}`,
    }));
});

const cards = computed<Card[]>(() => (view.value === 'registry' ? registryCards.value : healthCards.value));

// 按分类计数（当前视图）
const countByCat = (cat: string) => {
  const source = view.value === 'registry' ? registry.value.map((r) => ({ key: r.id })) : store.bindings.map((b) => ({ key: b.key }));
  if (cat === '全部') return source.length;
  return source.filter((item) => categoryOf(item.key) === cat).length;
};

onMounted(() => {
  void store.refresh();
  void refreshRegistry();
});
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">能力中心</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        全部已注册能力一页平铺（含 Suno 音乐生成、语音、文件、网页与 {{ registry.filter((r: any) => r.provider === 'http-generic').length }} 个 HTTP API）· 点卡片进配置/详情 · 新能力注册即自动出现
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-2.5 mb-5">
      <!-- 视图切换：注册表（R16 主契约） / 模型体检（辅助） -->
      <div class="segmented">
        <button :class="view === 'registry' ? 'on' : ''" @click="view = 'registry'">能力注册表（{{ registry.length }}）</button>
        <button :class="view === 'health' ? 'on' : ''" @click="view = 'health'">模型体检（{{ store.bindings.length }}）</button>
      </div>
      <input v-model="keyword" placeholder="搜索能力…" class="input-field !w-auto flex-1 min-w-[140px]" />
      <div class="flex flex-wrap gap-2">
        <button v-for="cat in CATEGORIES" :key="cat.id"
          class="text-xs rounded-full border px-4 py-1.5 transition-all"
          :class="category === cat.id
            ? 'bg-[color:var(--ink)] text-white border-transparent font-semibold'
            : 'bg-[color:var(--surface)] text-[color:var(--ink-2)] border-[color:var(--hairline-3)] hover:border-[color:var(--ink-3)]'"
          @click="category = cat.id">
          {{ cat.label }} <span class="opacity-60 ml-0.5">{{ countByCat(cat.id) }}</span>
        </button>
      </div>
      <span class="text-xs text-[color:var(--ink-3)] ml-auto flex items-center gap-1.5">
        <span v-if="view === 'health' && store.brokenCount" class="dot dot-warn"></span>
        <span v-if="view === 'registry' && registryLoading">读取中…</span>
        <span v-else-if="view === 'health' && store.loading">体检中…</span>
        <span v-else-if="registryError" class="status-crit">{{ registryError }}</span>
        <span v-else-if="view === 'health'">{{ store.brokenCount ? `${store.brokenCount} 项需处理` : '全部正常' }}</span>
      </span>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-3.5">
      <router-link v-for="card in cards" :key="view + ':' + card.id" :to="card.href" class="block group">
        <div class="relative bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[14px] p-4 shadow-[var(--sh-1)] transition-all duration-200 group-hover:-translate-y-[3px] group-hover:shadow-[var(--sh-2)] group-hover:border-[color:var(--accent-line)] cursor-pointer">
          <!-- 健康状态点（C2 光晕） -->
          <span class="absolute top-4 right-4 w-2 h-2 rounded-full"
            :class="!card.enabled
              ? 'bg-[color:var(--off)] shadow-none'
              : card.ok
                ? 'bg-emerald-500 shadow-[0_0_0_3.5px_rgba(16,185,129,0.12)]'
                : 'bg-amber-500 shadow-[0_0_0_3.5px_rgba(245,158,11,0.12)]'"
            :title="!card.enabled ? '已停用' : card.ok ? '正常' : (card.reason || '不可用')" />

          <!-- 分类图标（C2 线性 SVG） -->
          <div class="w-[38px] h-[38px] rounded-[11px] grid place-items-center mb-3 transition-transform duration-200 group-hover:scale-[1.06]"
            :class="{
              'bg-[color:var(--c-gen-soft)] text-[color:var(--c-gen)]': card.category === '生成',
              'bg-[color:var(--c-info-soft)] text-[color:var(--c-info)]': card.category === '信息',
              'bg-[color:var(--c-parse-soft)] text-[color:var(--c-parse)]': card.category === '解析',
              'bg-[color:var(--c-input-soft)] text-[color:var(--c-input)]': card.category === '输入',
              'bg-[color:var(--off-soft)] text-[color:var(--ink-3)]': !['生成','信息','解析','输入'].includes(card.category),
            }">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="(seg, i) in catSvg(card.id).split('|')" :key="i" :d="seg" />
            </svg>
          </div>

          <div class="text-[14.5px] font-bold tracking-[-0.01em]">{{ card.label }}</div>
          <div class="text-[11.5px] text-[color:var(--ink-3)] mt-0.5 mb-3 font-mono truncate">{{ card.id }}</div>

          <div class="flex items-center gap-2 text-xs text-[color:var(--ink-2)]">
            <span class="text-[11.5px] font-semibold rounded-md px-2 py-0.5" :class="catTag(card.id)">{{ card.category }}</span>
            <span class="truncate">{{ card.sub || '—' }}</span>
          </div>

          <!-- hover 时滑入箭头（C2 微交互） -->
          <span class="absolute right-3.5 bottom-3.5 text-[color:var(--accent)] opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0">→</span>
        </div>
      </router-link>
    </div>

    <p v-if="!registryLoading && !store.loading && !cards.length" class="text-sm text-[color:var(--ink-3)] mt-8 text-center">
      没有匹配的能力。换个关键词或分类试试。
    </p>
  </div>
</template>
