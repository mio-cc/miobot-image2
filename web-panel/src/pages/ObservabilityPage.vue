<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 观测中心：日志（主+画布双源，自 LogsPage 迁入）+ 编排 trace 回放 +
 * 配置版本回滚 + 待补全任务 + 画布日志设置（自画布页迁入）+ 每日日报（T3.1）。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);

/* ── 日志（主进程 / 画布双源） ─────────────────────────────── */

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
const logError = ref('');
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
  logError.value = '';
  try {
    const params: Record<string, unknown> = { limit: limit.value };
    if (level.value !== 'all') params.level = level.value;
    if (search.value.trim()) params.contains = search.value.trim();
    const res = await client.get(basePath.value, { params });
    // 后端按时间正序返回；界面要最新的在最上面。
    entries.value = [...(res.data.items || [])].reverse();
    total.value = res.data.total || 0;
  } catch (e: any) {
    logError.value = errorMessage(e, '日志加载失败');
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
    logError.value = errorMessage(e, '清空失败');
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

/* ── 编排 trace / 配置版本 / 待补全任务 ───────────────────── */

const traces = ref<any[]>([]);
const pendingJobs = ref<any[]>([]);
const configVersions = ref<any[]>([]);
const traceReplay = ref<any>(null);
/** T3.6 span 链：按 requestId 过滤，串看 request→plan→execute→reply 全链。 */
const traceRequestIdFilter = ref('');

const filteredTraces = computed(() => {
  const keyword = traceRequestIdFilter.value.trim();
  const list = [...traces.value].reverse();
  return keyword ? list.filter((trace) => String(trace.requestId || '') === keyword) : list;
});

async function loadTraceReplay(trace: any) {
    if (!trace?.requestId) return;
    try {
        const res = await client.get('/orchestration/traces/' + encodeURIComponent(trace.requestId));
        traceReplay.value = res.data || null;
    } catch { traceReplay.value = { traces: [], timeline: [] }; }
}

async function rollbackConfigVersion(version: number) {
    try {
        await client.post('/config/rollback', { version });
        await configStore.fetchConfig();
        await loadObservability();
    } catch { /* 回滚失败由后端审计日志记录，保留当前配置 */ }
}

async function loadObservability() {
    try {
        const [traceRes, jobRes, versionRes] = await Promise.all([
            client.get('/orchestration/traces'),
            client.get('/orchestration/jobs'),
            client.get('/config/versions'),
        ]);
        traces.value = traceRes.data?.traces || [];
        pendingJobs.value = jobRes.data?.jobs || [];
        configVersions.value = versionRes.data?.versions || [];
    } catch { traces.value = []; pendingJobs.value = []; configVersions.value = []; }
}

watch([source, level], () => fetchLogs());
watch(autoRefresh, startTimer);

onMounted(() => { fetchLogs(); startTimer(); loadObservability(); });
onBeforeUnmount(stopTimer);
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">观测中心</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        日志（主进程与画布双源）、编排 trace 回放、配置版本回滚、待补全任务与每日日报。
      </p>
    </header>

    <SectionCard title="运行日志" hint="主进程与画布双日志源，同一次排障不用来回切" class="mb-4">
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

      <p v-if="logError" class="status-crit text-xs mb-2">{{ logError }}</p>
      <p v-if="copyStatus" class="status-good text-xs mb-2">{{ copyStatus }}</p>

      <div v-if="loading && !entries.length" class="py-10 text-center text-[color:var(--ink-3)] text-sm">正在加载...</div>
      <div v-else-if="!entries.length" class="py-10 text-center text-[color:var(--ink-3)] text-sm">暂无日志</div>
      <div v-else class="max-h-[420px] overflow-y-auto mono text-xs">
        <div v-for="entry in entries" :key="keyOf(entry)"
          class="border-b border-[color:var(--hairline-2)] last:border-b-0 px-2 py-2 hover:bg-[color:var(--surface-2)]">
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

    <div v-if="config" class="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
      <SectionCard title="画布日志设置" hint="自画布页迁入；画布前台独立日志源">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ToggleField v-model="config.canvas.logs.enabled" label="记录画布日志" />
          <FormField label="最低级别">
            <select v-model="config.canvas.logs.level" class="input-field">
              <option value="debug">debug</option><option value="info">info</option>
              <option value="warn">warn</option><option value="error">error</option>
            </select>
          </FormField>
          <FormField label="内存上限">
            <input v-model.number="config.canvas.logs.maxMemoryEntries" type="number" min="100" max="5000" step="100" class="input-field" />
          </FormField>
        </div>
      </SectionCard>

      <SectionCard title="每日日报" hint="§11.5 静默观测闭环：每天一条私聊 owner，汇总消息量/回退/静默/限流/成功率">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ToggleField v-model="config.bot.dailyReport.enabled" label="启用日报" />
          <FormField label="发送时刻（时）" hint="0-23">
            <input v-model.number="config.bot.dailyReport.hour" type="number" min="0" max="23" class="input-field" :disabled="!config.bot.dailyReport.enabled" />
          </FormField>
          <FormField label="发送时刻（分）" hint="0-59">
            <input v-model.number="config.bot.dailyReport.minute" type="number" min="0" max="59" class="input-field" :disabled="!config.bot.dailyReport.enabled" />
          </FormField>
        </div>
      </SectionCard>
    </div>

    <SectionCard title="最近编排追踪" hint="来自 bot 进程写入的 JSONL trace；按 requestId 过滤可串看 request→plan→execute→reply 全链 span" class="mb-4">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <input v-model="traceRequestIdFilter" class="input-field !w-auto min-w-[240px]" placeholder="按 requestId 过滤（从任一行的请求列复制）" />
        <button v-if="traceRequestIdFilter" class="btn-outline text-xs" type="button" @click="traceRequestIdFilter = ''">清除</button>
        <span class="text-xs text-[color:var(--ink-3)]">{{ traceRequestIdFilter ? `命中 ${filteredTraces.length} 条` : `共 ${traces.length} 条` }}</span>
      </div>
      <div class="overflow-x-auto max-h-[360px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">时间</th><th class="text-left py-2 pr-3">请求</th><th class="text-left py-2 pr-3">阶段</th><th class="text-left py-2 pr-3">摘要</th><th class="text-left py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="trace in filteredTraces" :key="trace.id" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono whitespace-nowrap">{{ String(trace.timestamp || '').slice(11, 19) }}</td>
              <td class="py-2 pr-3 mono"><button class="hover:underline" type="button" @click="traceRequestIdFilter = String(trace.requestId || '')">{{ trace.requestId }}</button></td>
              <td class="py-2 pr-3">{{ trace.stage }}</td>
              <td class="py-2 pr-3">{{ trace.summary }}</td>
              <td class="py-2"><button class="btn-outline !px-2 !py-1" type="button" @click="loadTraceReplay(trace)">回放</button></td>
            </tr>
            <tr v-if="!filteredTraces.length"><td colspan="5" class="py-3 text-[color:var(--ink-3)]">{{ traceRequestIdFilter ? '该 requestId 没有追踪记录' : '暂无编排追踪' }}</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="traceReplay" class="mt-3 border-t border-[color:var(--hairline-2)] pt-3 max-h-[320px] overflow-auto">
        <p class="text-xs mb-2">Trace 回放：<span class="mono">{{ traceReplay.requestId }}</span>（只读，不重新执行）</p>
        <div v-for="(item, index) in traceReplay.timeline || []" :key="index" class="text-xs py-1 border-b border-[color:var(--hairline-2)]/40">
          <span class="mono text-[color:var(--ink-3)]">{{ String(item.at || '').slice(11, 19) }}</span>
          <strong class="mx-2">{{ item.stage }}</strong>{{ item.summary }}
        </div>
      </div>
    </SectionCard>

    <SectionCard title="配置版本与回滚" hint="每次保存记录变更路径与版本快照；回滚会重新校验、热重载并写入审计" class="mb-4">
      <div class="overflow-x-auto max-h-[280px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">版本</th><th class="text-left py-2 pr-3">保存时间</th><th class="text-left py-2 pr-3">变更路径</th><th class="text-left py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in [...configVersions].reverse()" :key="item.version" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono">v{{ item.version }} / rev {{ item.revision }}</td>
              <td class="py-2 pr-3">{{ String(item.savedAt || '').slice(0, 19).replace('T', ' ') }}</td>
              <td class="py-2 pr-3 max-w-[520px] truncate">{{ (item.changedPaths || []).join(', ') || '初始配置' }}</td>
              <td class="py-2">
                <span v-if="item.current" class="text-[color:var(--ink-3)]">当前</span>
                <button v-else class="btn-outline !px-2 !py-1" type="button" @click="rollbackConfigVersion(item.version)">回滚</button>
              </td>
            </tr>
            <tr v-if="!configVersions.length"><td colspan="4" class="py-3 text-[color:var(--ink-3)]">暂无版本记录</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>

    <SectionCard title="待补全任务" hint="规划器追问后保存的 pendingJob；用户下一条消息会自动合并补充信息并重新规划" class="mb-4">
      <div class="overflow-x-auto max-h-[280px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">会话</th><th class="text-left py-2 pr-3">原始请求</th><th class="text-left py-2 pr-3">提问</th><th class="text-left py-2">过期时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="job in pendingJobs" :key="job.key" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono">{{ job.key }}</td>
              <td class="py-2 pr-3 max-w-[360px] truncate">{{ job.originalText }}</td>
              <td class="py-2 pr-3 max-w-[360px] truncate">{{ job.question }}</td>
              <td class="py-2">{{ String(job.expiresAt || '').slice(0, 19).replace('T', ' ') }}</td>
            </tr>
            <tr v-if="!pendingJobs.length"><td colspan="4" class="py-3 text-[color:var(--ink-3)]">暂无待补全任务</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>
  </div>
</template>
