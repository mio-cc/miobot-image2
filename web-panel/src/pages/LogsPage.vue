<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import client, { errorMessage } from '../api/client';
import SectionCard from '../components/SectionCard.vue';

/**
 * 日志页。主进程日志和画布日志放在一个来源开关下——
 * 分成两个页面时，同一次排障要来回切。
 */

interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    scope: string;
    message: string;
    data?: unknown;
    error?: unknown;
}

const source = ref<'main' | 'canvas'>('main');
const level = ref('all');
const search = ref('');
const savedLogLimit = Number(window.localStorage.getItem('miobot.logLimit') || 300);
const limit = ref(Number.isFinite(savedLogLimit) ? Math.min(10000, Math.max(1, Math.trunc(savedLogLimit))) : 300);
const entries = ref<LogEntry[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const autoRefresh = ref(true);
const copyStatus = ref('');
/**
 * 展开状态按日志**身份**记，不能用数组下标。
 * 5 秒自动刷新会在头部插入新日志，下标全体后移——
 * 用户展开的那条会突然变成另一条，看着像日志在乱跳。
 */
const expanded = ref<Record<string, boolean>>({});
function keyOf(entry: LogEntry) {
    return `${entry.timestamp}|${entry.scope}|${entry.level}|${entry.message}`;
}
let timer: number | undefined;

const basePath = computed(() => (source.value === 'canvas' ? '/canvas/logs' : '/logs'));

function applyLogLimit() {
  const value = Number(limit.value);
  limit.value = Number.isFinite(value) ? Math.min(10000, Math.max(1, Math.trunc(value))) : 300;
  window.localStorage.setItem('miobot.logLimit', String(limit.value));
  void fetchLogs();
}

async function fetchLogs(showLoading = true) {
    if (showLoading) loading.value = true;
    error.value = '';
    try {
        const params: Record<string, unknown> = { limit: limit.value };
        if (level.value !== 'all') params.level = level.value;
        if (search.value.trim()) params.contains = search.value.trim();
        const res = await client.get(basePath.value, { params });
        // 后端按时间正序返回；界面要最新的在最上面。
        entries.value = [...(res.data.items || [])].reverse();
        total.value = res.data.total || 0;
    } catch (e: any) {
        error.value = errorMessage(e, '日志加载失败');
    } finally {
        if (showLoading) loading.value = false;
    }
}

async function clearLogs() {
    if (!window.confirm(`确定清空${source.value === 'canvas' ? '画布' : '运行'}日志吗？`)) return;
    loading.value = true;
    try {
        const res = await client.post(`${basePath.value}/clear`, {});
        entries.value = [...(res.data.items || [])].reverse();
        total.value = res.data.total || 0;
    } catch (e: any) {
        error.value = errorMessage(e, '清空失败');
    } finally {
        loading.value = false;
    }
}

function startTimer() {
    stopTimer();
    if (!autoRefresh.value) return;
    timer = window.setInterval(() => fetchLogs(false), 5000);
}
function stopTimer() {
    if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
}

function detailsOf(entry: LogEntry) {
    const payload: Record<string, unknown> = {};
    if (entry.data !== undefined && entry.data !== null) payload.data = entry.data;
    if (entry.error !== undefined && entry.error !== null) payload.error = entry.error;
    if (!Object.keys(payload).length) return '';
    try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}

function formatEntry(entry: LogEntry) {
    const details = detailsOf(entry);
    return [
        `${entry.timestamp} [${String(entry.level).toUpperCase()}] [${entry.scope}] ${entry.message}`,
        details ? `details:\n${details}` : '',
    ].filter(Boolean).join('\n');
}

async function copyText(text: string, label: string) {
    try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
            // 非 HTTPS 下 clipboard API 不可用，面板经常就是 http://内网:3018。
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        copyStatus.value = label;
        window.setTimeout(() => { if (copyStatus.value === label) copyStatus.value = ''; }, 1800);
    } catch (e: any) {
        copyStatus.value = `复制失败：${e?.message || e}`;
    }
}

function levelClass(value: string) {
    if (value === 'error') return 'status-crit';
    if (value === 'warn') return 'status-warn';
    if (value === 'debug') return 'text-[color:var(--ink-3)]';
    return 'status-good';
}

watch([source, level], () => fetchLogs());
watch(autoRefresh, startTimer);

onMounted(() => { fetchLogs(); startTimer(); });
onBeforeUnmount(stopTimer);
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">运行日志</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        {{ total ? `当前条件命中 ${total} 条` : '主进程与画布双日志源' }}
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-2 mb-3">
      <div class="segmented">
        <button v-for="opt in [{ v: 'main', t: '主进程' }, { v: 'canvas', t: '画布' }]" :key="opt.v"
          :class="source === opt.v ? 'on' : ''" @click="source = opt.v as any">{{ opt.t }}</button>
      </div>

      <div class="segmented">
        <button v-for="opt in ['all', 'info', 'warn', 'error', 'debug']" :key="opt"
          :class="level === opt ? 'on' : ''" @click="level = opt">{{ opt === 'all' ? '全部' : opt }}</button>
      </div>

      <input v-model="search" @keyup.enter="fetchLogs()" class="input-field !w-auto flex-1 min-w-[200px]"
        placeholder="搜索 scope / 关键字，回车生效" />

      <label class="flex items-center gap-1.5 text-xs text-[color:var(--ink-3)]">
        显示
        <input v-model.number="limit" @change="applyLogLimit" @keyup.enter="applyLogLimit" type="number" min="1" max="10000" step="100" class="input-field !w-[110px]" />
        条
      </label>

      <label class="flex items-center gap-1.5 text-xs text-[color:var(--ink-3)]">
        <input type="checkbox" v-model="autoRefresh" />自动刷新
      </label>
      <button class="btn-outline text-xs" :disabled="loading" @click="fetchLogs()">{{ loading ? '刷新中...' : '刷新' }}</button>
      <button class="btn-outline text-xs" :disabled="!entries.length"
        @click="copyText(entries.map(formatEntry).join('\n\n'), `已复制 ${entries.length} 条`)">复制当前</button>
      <button class="btn-danger text-xs" :disabled="loading" @click="clearLogs">清空</button>
    </div>

    <p v-if="error" class="status-crit text-xs mb-2">{{ error }}</p>
    <p v-if="copyStatus" class="status-good text-xs mb-2">{{ copyStatus }}</p>

    <SectionCard no-padding>
      <div v-if="loading && !entries.length" class="px-4 py-10 text-center text-[color:var(--ink-3)] text-sm">正在加载...</div>
      <div v-else-if="!entries.length" class="px-4 py-10 text-center text-[color:var(--ink-3)] text-sm">暂无日志</div>
      <div v-else class="max-h-[calc(100vh-260px)] overflow-y-auto mono text-xs">
        <div v-for="entry in entries" :key="keyOf(entry)"
          class="border-b border-[color:var(--hairline-2)] last:border-b-0 px-4 py-2 hover:bg-[color:var(--surface-2)]">
          <div class="grid grid-cols-[64px_46px_auto_1fr_auto] gap-3 items-baseline">
            <span class="text-[color:var(--ink-3)] text-[10.5px]">{{ String(entry.timestamp).slice(11, 19) }}</span>
            <span class="text-[10px] font-bold uppercase" :class="levelClass(entry.level)">{{ entry.level }}</span>
            <span class="text-[10.5px]" style="color: var(--series-1)">[{{ entry.scope }}]</span>
            <span class="min-w-0 truncate text-[color:var(--ink-2)]" style="font-family: var(--sans); font-size: 12.5px">{{ entry.message }}</span>
            <button v-if="detailsOf(entry)" class="text-[10.5px] text-[color:var(--ink-3)] hover:underline whitespace-nowrap"
              @click="expanded[keyOf(entry)] = !expanded[keyOf(entry)]">
              {{ expanded[keyOf(entry)] ? '收起' : '详情' }}
            </button>
            <span v-else></span>
          </div>
          <div v-if="expanded[keyOf(entry)]" class="mt-2 rounded-md bg-[color:var(--surface-2)] p-3">
            <div class="flex justify-end mb-1">
              <button class="text-[10.5px] text-[color:var(--ink-3)] hover:underline"
                @click="copyText(formatEntry(entry), '已复制该条')">复制整条</button>
            </div>
            <pre class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[color:var(--ink-2)] max-h-72 overflow-auto">{{ detailsOf(entry) }}</pre>
          </div>
        </div>
      </div>
    </SectionCard>
  </div>
</template>
