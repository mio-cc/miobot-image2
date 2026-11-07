<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useCapabilityStore } from '../stores/capabilities';
import { useConfigStore } from '../stores/config';
import client from '../api/client';

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
/* 注册表改为 store 共享缓存（60s TTL）：permissions/tools 页复用同一份数据，不再每页重拉 64KB。 */
const registry = computed<RegItem[]>(() => store.registry as RegItem[]);
const registryLoading = computed(() => store.registryLoading);
const registryError = computed(() => store.registryError);
function refreshRegistry(force = false) { return store.refreshRegistry(force); }

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
    // P4-MCP：mcp.* 根能力由下方「MCP 服务器」专属区块展示（三态 + 根开关 + 子项数），registry 网格去重。
    .filter((item) => !String(item.id).startsWith('mcp.'))
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

/** 卡片分页：原型密度 6×3=18/页（小卡片高密度网格）。 */
const PAGE_SIZE = 18;
const page = ref(1);
const totalPages = computed(() => Math.max(1, Math.ceil(cards.value.length / PAGE_SIZE)));
const pagedCards = computed(() => cards.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
watch([keyword, category, view], () => { page.value = 1; });
watch(cards, () => { if (page.value > totalPages.value) page.value = totalPages.value; });

/** 窗口化页码：1 … 4 5 6 … 12（首尾页 + 当前页前后各一页），页数多时不溢出。 */
const pageWindow = computed<Array<number | '…'>>(() => {
  const t = totalPages.value;
  const cur = page.value;
  if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1);
  const set = new Set<number>([1, t, cur - 1, cur, cur + 1]);
  const nums = [...set].filter(n => n >= 1 && n <= t).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
});

// 按分类计数（当前视图）
const countByCat = (cat: string) => {
  const source = view.value === 'registry' ? registry.value.map((r) => ({ key: r.id })) : store.bindings.map((b) => ({ key: b.key }));
  if (cat === '全部') return source.length;
  return source.filter((item) => categoryOf(item.key) === cat).length;
};

onMounted(() => {
  void store.refresh();
  void refreshRegistry();
  void initMcpSection();
});

/* ── P4-MCP：MCP 服务器区块——能力中心可见的外部能力入口（读 config + 状态快照，未接入显示空态） ── */
const configStore = useConfigStore();
const mcpStatusMap = ref<Record<string, any>>({});
const mcpChildCounts = ref<Record<string, number>>({});
const mcpServers = computed<any[]>(() => ((configStore.config as any)?.orchestration?.mcpServers || []));

async function initMcpSection() {
  if (!configStore.loaded) await configStore.fetchConfig();
  try {
    const res = await client.get('/mcp/status');
    const snapshot = res.data?.status || {};
    const map: Record<string, any> = {};
    const counts: Record<string, number> = {};
    for (const server of snapshot.servers || []) map[server.serverId] = server;
    for (const child of snapshot.children || []) counts[child.serverId] = (counts[child.serverId] || 0) + 1;
    mcpStatusMap.value = map;
    mcpChildCounts.value = counts;
  } catch { /* 状态获取失败按无快照处理（卡片退化为「未连接」） */ }
}

/** MCP 卡片三态：未接入（整块空态）/ 已停用 / 未连接·待授权 / 已连接（根能力开关单独标注，默认 deny 可见）。 */
function mcpStateOf(id: string): { label: string; ok: boolean; warn: boolean } {
  const server = mcpServers.value.find((item) => String(item.id) === id);
  if (!server || server.enabled === false) return { label: '已停用', ok: false, warn: false };
  const status = mcpStatusMap.value[id];
  if (!status) return { label: '未连接', ok: false, warn: false };
  if (status.state === 'connected' || status.state === 'connected-no-tools') return { label: status.state === 'connected' ? '已连接' : '已连接·无子项', ok: true, warn: false };
  if (status.state === 'needs-auth') return { label: '待授权', ok: false, warn: true };
  if (status.state === 'connecting') return { label: '连接中', ok: false, warn: false };
  return { label: '未连接', ok: false, warn: false };
}
function mcpDisplayName(id: string): string {
  const overrides = (configStore.config as any)?.orchestration?.capabilityOverrides || {};
  return overrides[`mcp.${id}`]?.name || `${id} MCP`;
}
function mcpRootEnabled(id: string): boolean {
  const overrides = (configStore.config as any)?.orchestration?.capabilityOverrides || {};
  return overrides[`mcp.${id}`]?.enabled === true;
}
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
        <button v-for="cat in CATEGORIES" :key="cat.id" type="button"
          class="chip" :class="category === cat.id ? 'on' : ''"
          @click="category = cat.id">
          {{ cat.label }} <span class="n">{{ countByCat(cat.id) }}</span>
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

    <!-- 骨架屏：注册表读取中（小卡片密度） -->
    <div v-if="view === 'registry' && registryLoading && !registry.length" class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2.5">
      <div v-for="i in 12" :key="`sk-${i}`" class="card p-2.5">
        <div class="skeleton w-[22px] h-[22px] rounded-md mb-2"></div>
        <div class="skeleton h-3 w-2/3 mb-1.5"></div>
        <div class="skeleton h-2.5 w-1/2 mb-2"></div>
        <div class="skeleton h-2.5 w-3/4"></div>
      </div>
    </div>

    <!-- 能力卡片：原型小卡片高密度网格（6 列 / 每页 18；1240→4 列，680→2 列） -->
    <div v-else class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2.5">
      <router-link v-for="card in pagedCards" :key="view + ':' + card.id" :to="card.href" class="block group">
        <div class="relative bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[10px] px-3 py-2.5 shadow-[var(--sh-1)] transition-all duration-200 group-hover:-translate-y-[2px] group-hover:shadow-[var(--sh-2)] group-hover:border-[color:var(--accent-line)] cursor-pointer h-full">
          <!-- 健康状态点（token 语义色，暗色自动适配） -->
          <span class="absolute top-2.5 right-2.5 dot"
            :class="!card.enabled ? 'dot-idle' : card.ok ? 'dot-good' : 'dot-warn'"
            :title="!card.enabled ? '已停用' : card.ok ? '正常' : (card.reason || '不可用')" />

          <!-- 分类图标（纸面分类色砖，原型 22px） -->
          <div class="w-[22px] h-[22px] rounded-md grid place-items-center mb-1.5 transition-transform duration-200 group-hover:scale-[1.08]"
            :class="{
              'bg-[color:var(--c-gen-soft)] text-[color:var(--c-gen)]': card.category === '生成',
              'bg-[color:var(--c-info-soft)] text-[color:var(--c-info)]': card.category === '信息',
              'bg-[color:var(--c-parse-soft)] text-[color:var(--c-parse)]': card.category === '解析',
              'bg-[color:var(--c-input-soft)] text-[color:var(--c-input)]': card.category === '输入',
              'bg-[color:var(--off-soft)] text-[color:var(--ink-3)]': !['生成','信息','解析','输入'].includes(card.category),
            }">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="(seg, i) in catSvg(card.id).split('|')" :key="i" :d="seg" />
            </svg>
          </div>

          <div class="text-[12.5px] font-semibold tracking-[-0.01em] truncate" :title="card.label">{{ card.label }}</div>
          <div class="text-[10px] text-[color:var(--ink-3)] mt-0.5 mb-1.5 font-mono truncate">{{ card.id }}</div>

          <div class="flex items-center gap-1.5 text-[color:var(--ink-2)] min-w-0">
            <span class="text-[9.5px] font-semibold rounded-[4px] px-1.5 py-px flex-none" :class="catTag(card.id)">{{ card.category }}</span>
            <span class="truncate text-[10.5px]" :title="card.sub">{{ card.sub || '—' }}</span>
          </div>
        </div>
      </router-link>
    </div>

    <!-- 分页（窗口化页码） -->
    <div v-if="totalPages > 1" class="pager mt-5 px-1">
      <span class="pg-info">共 {{ cards.length }} 项 · 每页 {{ PAGE_SIZE }} 项</span>
      <button type="button" class="pg-btn" :disabled="page <= 1" aria-label="上一页" @click="page -= 1">‹</button>
      <template v-for="(p, i) in pageWindow" :key="`pg-${i}`">
        <span v-if="p === '…'" class="pg-gap">…</span>
        <button v-else type="button" class="pg-btn" :class="p === page ? 'on' : ''" @click="page = p">{{ p }}</button>
      </template>
      <button type="button" class="pg-btn" :disabled="page >= totalPages" aria-label="下一页" @click="page += 1">›</button>
    </div>

    <!-- ── P4-MCP：MCP 服务器区块（外部能力入口——未接入也可见，点击去 /mcp 列表管理） ── -->
    <div v-if="view === 'registry'" class="mt-6">
      <div class="flex items-center gap-2 mb-2.5">
        <h2 class="text-sm font-semibold m-0">MCP 服务器</h2>
        <span class="text-[10px] text-[color:var(--ink-3)]">外部能力 · 一个服务器 = 一个树形根工具（默认 deny，预算按 1 个工具计）</span>
        <router-link class="btn-outline !px-2 !py-0.5 !text-xs ml-auto" to="/mcp">管理</router-link>
      </div>
      <div v-if="!mcpServers.length" class="card p-4 flex flex-wrap items-center gap-3">
        <span class="text-xs text-[color:var(--ink-3)]">MCP 未接入——接入 Suno 官方等外部 MCP 后，这里会显示对应能力卡片，模型即可检索其子项</span>
        <router-link class="btn !px-3 !py-1 !text-xs ml-auto" to="/mcp">新增 MCP 服务器</router-link>
      </div>
      <div v-else class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2.5">
        <router-link v-for="server in mcpServers" :key="`mcp-${server.id}`" :to="`/mcp/${encodeURIComponent(server.id)}`" class="block group">
          <div class="relative bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[10px] px-3 py-2.5 shadow-[var(--sh-1)] transition-all duration-200 group-hover:-translate-y-[2px] group-hover:shadow-[var(--sh-2)] group-hover:border-[color:var(--accent-line)] cursor-pointer h-full">
            <span class="absolute top-2.5 right-2.5 dot"
              :class="mcpStateOf(server.id).ok && mcpRootEnabled(server.id) ? 'dot-good' : mcpStateOf(server.id).ok || mcpStateOf(server.id).warn ? 'dot-warn' : 'dot-idle'"
              :title="mcpStateOf(server.id).ok ? (mcpRootEnabled(server.id) ? '已连接·根能力已启用' : '已连接·根能力关闭（默认 deny，进配置页开启）') : mcpStateOf(server.id).label" />
            <div class="w-[22px] h-[22px] rounded-md grid place-items-center mb-1.5 bg-[color:var(--c-input-soft)] text-[color:var(--c-input)]">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7V5a1 1 0 0 1 1-1h2M20 7V5a1 1 0 0 0-1-1h-2M4 17v2a1 1 0 0 0 1 1h2M20 17v2a1 1 0 0 1-1 1h-2M8 12h8" />
              </svg>
            </div>
            <div class="text-[12.5px] font-semibold tracking-[-0.01em] truncate" :title="mcpDisplayName(server.id)">{{ mcpDisplayName(server.id) }}</div>
            <div class="text-[10px] text-[color:var(--ink-3)] mt-0.5 mb-1.5 font-mono truncate">mcp.{{ server.id }}</div>
            <div class="flex items-center gap-1.5 text-[color:var(--ink-2)] min-w-0">
              <span class="text-[9.5px] font-semibold rounded-[4px] px-1.5 py-px flex-none tag-input">MCP</span>
              <span class="truncate text-[10.5px]" :title="mcpStateOf(server.id).label + (mcpStateOf(server.id).ok && !mcpRootEnabled(server.id) ? ' · 根能力关闭' : '')">{{ mcpStateOf(server.id).label }}<template v-if="mcpStateOf(server.id).ok && !mcpRootEnabled(server.id)"> · 根关闭</template> · {{ mcpChildCounts[server.id] || 0 }} 子项</span>
            </div>
          </div>
        </router-link>
      </div>
    </div>

    <div v-if="!registryLoading && !store.loading && !cards.length" class="empty-state">
      <div class="empty-title">没有匹配的能力</div>
      <div class="empty-sub">换个关键词或分类试试；新能力注册后会自动出现在这里</div>
    </div>
  </div>
</template>
