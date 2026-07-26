<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import SectionCard from '../components/SectionCard.vue';
import AppIcon from '../components/AppIcon.vue';
import SparkLine from '../components/SparkLine.vue';
import BarChart from '../components/BarChart.vue';

/**
 * 总览页。打开后台第一眼要能回答"这台机器人现在到底好不好"，
 * 而不是先看到一堆 API 节点输入框。
 */

const configStore = useConfigStore();
const capabilities = useCapabilityStore();

const napcatState = ref<any>(null);
const napcatLoading = ref(false);
const recentLogs = ref<any[]>([]);
const logTotal = ref(0);
const logError = ref('');

const config = computed(() => configStore.config);

const nodeSummary = computed(() => {
    const nodes = config.value?.llm?.apiKeys || [];
    return {
        total: nodes.length,
        enabled: nodes.filter((n: any) => n.enabled !== false).length,
        active: nodes[config.value?.llm?.activeNodeIndex ?? 0]?.name || '—',
    };
});

const errorCount = computed(() => recentLogs.value.filter(item => item.level === 'error').length);
const warnCount = computed(() => recentLogs.value.filter(item => item.level === 'warn').length);

const metrics = ref<any>(null);
const chartSeries = ref<'message' | 'image' | 'chat'>('message');
const seriesOptions = [
    { key: 'message', label: '消息' },
    { key: 'chat', label: '对话' },
    { key: 'image', label: '生图' },
] as const;

/** stat tile 用的四项指标；平均耗时来自后端累计的时长统计。 */
const tiles = computed(() => {
    const m = metrics.value;
    if (!m) return [];
    const avgImage = m.averages?.image ? Math.round(m.averages.image / 100) / 10 : 0;
    return [
        { key: 'message', label: '消息处理', value: m.totals?.message ?? 0, trend: m.trends?.message ?? 0, series: m.series?.message },
        { key: 'image', label: '生图', value: m.totals?.image ?? 0, trend: m.trends?.image ?? 0, series: m.series?.image },
        { key: 'avg', label: '平均生图耗时', value: avgImage, suffix: ' s', trend: null, series: m.series?.image },
        { key: 'error', label: '处理失败', value: m.totals?.error ?? 0, trend: m.trends?.error ?? 0, series: m.series?.error, invert: true },
    ];
});

function trendText(trend: number | null, invert = false) {
    if (trend === null) return { text: '', cls: 'text-[color:var(--ink-3)]' };
    if (trend === 0) return { text: '与前 12 小时持平', cls: 'text-[color:var(--ink-3)]' };
    const up = trend > 0;
    const good = invert ? !up : up;
    return {
        text: `${up ? '↑' : '↓'} ${Math.abs(trend)}% 较前 12 小时`,
        cls: good ? 'status-good' : 'status-crit',
    };
}

async function loadMetrics() {
    try {
        const res = await client.get('/metrics');
        metrics.value = res.data;
    } catch { /* 指标拿不到不影响其它内容 */ }
}

async function testNapcat() {
    napcatLoading.value = true;
    try {
        const res = await client.post('/test-napcat', {});
        napcatState.value = res.data;
    } catch (error: any) {
        napcatState.value = error?.response?.data || { success: false, error: errorMessage(error) };
    } finally {
        napcatLoading.value = false;
    }
}

async function loadLogs() {
    try {
        const res = await client.get('/logs', { params: { limit: 60 } });
        recentLogs.value = [...(res.data.items || [])].reverse();
        logTotal.value = res.data.total || 0;
    } catch (error: any) {
        logError.value = errorMessage(error, '日志加载失败');
    }
}

onMounted(async () => {
    if (!capabilities.bindings.length) capabilities.refresh();
    await Promise.all([testNapcat(), loadLogs(), loadMetrics()]);
});
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">总览</h1>
      <p class="text-[color:var(--ink-3)] text-xs">机器人运行状态、能力分工与最近事件</p>
    </header>

    <!-- 状态条 -->
    <div class="flex flex-wrap border border-[color:var(--hairline-2)] rounded-[10px] bg-[color:var(--surface)] mb-4 overflow-hidden">
      <div class="flex-1 min-w-[170px] px-4 py-3 border-r border-[color:var(--hairline-2)]">
        <div class="text-[11px] text-[color:var(--ink-3)] mb-1">NapCat 连接</div>
        <div class="text-[13px] font-semibold flex items-center gap-2">
          <template v-if="napcatLoading"><span class="text-[color:var(--ink-3)]">检测中...</span></template>
          <template v-else-if="napcatState?.success">
            <span class="status-good flex items-center gap-1.5"><AppIcon name="check" :size="12" />已连接</span>
            <span v-if="napcatState.latencyMs !== undefined" class="mono text-[color:var(--ink-3)] text-xs">{{ napcatState.latencyMs }}ms</span>
          </template>
          <template v-else>
            <span class="status-crit flex items-center gap-1.5"><AppIcon name="cross" :size="12" />未连接</span>
          </template>
        </div>
        <div v-if="napcatState?.nickname" class="text-[11px] text-[color:var(--ink-3)] mt-0.5 truncate">
          {{ napcatState.nickname }} · {{ napcatState.selfQqId }}
        </div>
      </div>

      <div class="flex-1 min-w-[170px] px-4 py-3 border-r border-[color:var(--hairline-2)]">
        <div class="text-[11px] text-[color:var(--ink-3)] mb-1">API 节点</div>
        <div class="text-[13px] font-semibold flex items-center gap-2 min-w-0">
          <span class="dot" :class="nodeSummary.enabled ? 'dot-good' : 'dot-crit'"></span>
          <span class="truncate">{{ nodeSummary.active }}</span>
        </div>
        <div class="text-[11px] text-[color:var(--ink-3)] mt-0.5 mono">{{ nodeSummary.enabled }} 启用 / 共 {{ nodeSummary.total }}</div>
      </div>

      <div class="flex-1 min-w-[170px] px-4 py-3 border-r border-[color:var(--hairline-2)]">
        <div class="text-[11px] text-[color:var(--ink-3)] mb-1">能力分工</div>
        <div class="text-[13px] font-semibold">
          <span v-if="capabilities.loading" class="text-[color:var(--ink-3)]">检查中...</span>
          <span v-else-if="capabilities.brokenCount" class="status-crit flex items-center gap-1.5">
            <AppIcon name="warn" :size="12" />{{ capabilities.brokenCount }} 项有问题
          </span>
          <span v-else class="status-good flex items-center gap-1.5"><AppIcon name="check" :size="12" />全部正常</span>
        </div>
        <div class="text-[11px] text-[color:var(--ink-3)] mt-0.5">{{ capabilities.okCount }} / {{ capabilities.bindings.length }} 项可用</div>
      </div>

      <div class="flex-1 min-w-[170px] px-4 py-3 border-r border-[color:var(--hairline-2)]">
        <div class="text-[11px] text-[color:var(--ink-3)] mb-1">视频能力</div>
        <div class="text-[13px] font-semibold truncate">
          <span v-if="config.llm.videoEnabled" class="mono">{{ config.llm.videoModel || '未选模型' }}</span>
          <span v-else class="text-[color:var(--ink-3)]">未启用</span>
        </div>
        <div class="text-[11px] text-[color:var(--ink-3)] mt-0.5">
          {{ config.bot?.tts?.enabled ? '语音已开' : '语音未开' }}
        </div>
      </div>

      <div class="flex-1 min-w-[170px] px-4 py-3">
        <div class="text-[11px] text-[color:var(--ink-3)] mb-1">最近日志</div>
        <div class="text-[13px] font-semibold flex items-center gap-3">
          <span v-if="errorCount" class="status-crit">{{ errorCount }} 错误</span>
          <span v-if="warnCount" class="status-warn">{{ warnCount }} 警告</span>
          <span v-if="!errorCount && !warnCount" class="status-good">无异常</span>
        </div>
        <div class="text-[11px] text-[color:var(--ink-3)] mt-0.5 mono">最近 {{ recentLogs.length }} 条</div>
      </div>
    </div>

    <!-- 指标卡 -->
    <div v-if="tiles.length" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
      <div v-for="tile in tiles" :key="tile.key" class="card px-4 pt-3.5 pb-2.5">
        <div class="text-xs text-[color:var(--ink-2)] mb-1.5 flex items-center justify-between">
          {{ tile.label }}<span class="tag">24h</span>
        </div>
        <div class="text-[26px] font-bold tracking-tight leading-none">
          {{ tile.value }}<span v-if="tile.suffix" class="text-[15px] font-medium text-[color:var(--ink-3)]">{{ tile.suffix }}</span>
        </div>
        <div class="text-[11.5px] mt-1" :class="trendText(tile.trend ?? null, tile.invert).cls">
          {{ trendText(tile.trend ?? null, tile.invert).text || '　' }}
        </div>
        <SparkLine :data="tile.series || []" :labels="metrics?.hourLabels" class="mt-2" />
      </div>
    </div>

    <!-- 24 小时活动 -->
    <SectionCard v-if="metrics" title="24 小时活动" hint="按小时统计" class="mb-4">
      <template #actions>
        <div class="segmented">
          <button v-for="opt in seriesOptions" :key="opt.key"
            :class="chartSeries === opt.key ? 'on' : ''"
            @click="chartSeries = opt.key">{{ opt.label }}</button>
        </div>
      </template>
      <BarChart :data="metrics.series?.[chartSeries] || []" :labels="metrics.hourLabels || []" />
      <p class="text-[color:var(--ink-3)] text-[11px] mt-2">
        指标落盘在运行目录，进程重启不会清零；只保留最近 24 小时。
      </p>
    </SectionCard>

    <div class="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
      <SectionCard title="能力分工速览" hint="每项能力当前绑定的节点与模型" no-padding>
        <template #actions>
          <RouterLink to="/routing" class="btn-outline text-xs">管理</RouterLink>
        </template>
        <table class="w-full text-[12.5px]">
          <tbody>
            <tr v-for="item in capabilities.bindings" :key="item.key"
              class="border-b border-[color:var(--hairline-2)] last:border-b-0">
              <td class="px-4 py-2.5 whitespace-nowrap">{{ item.label }}</td>
              <td class="px-4 py-2.5 mono text-xs min-w-0 truncate">{{ item.model || '—' }}</td>
              <td class="px-4 py-2.5 text-right whitespace-nowrap">
                <span class="dot" :class="!item.enabled ? 'dot-warn' : (item.ok ? 'dot-good' : 'dot-crit')"
                  :title="item.reason || (item.ok ? '正常' : '有问题')"></span>
              </td>
            </tr>
            <tr v-if="!capabilities.bindings.length">
              <td class="px-4 py-6 text-center text-[color:var(--ink-3)]">正在检查…</td>
            </tr>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="最近事件" :hint="logTotal ? `共 ${logTotal} 条` : ''" no-padding>
        <template #actions>
          <RouterLink to="/logs" class="btn-outline text-xs">全部日志</RouterLink>
        </template>
        <div class="max-h-[420px] overflow-y-auto">
          <div v-for="(entry, index) in recentLogs.slice(0, 25)" :key="`${entry.timestamp}-${index}`"
            class="px-4 py-2 border-b border-[color:var(--hairline-2)] last:border-b-0 text-xs">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="mono text-[10px] font-bold uppercase"
                :class="entry.level === 'error' ? 'status-crit' : entry.level === 'warn' ? 'status-warn' : 'text-[color:var(--ink-3)]'">
                {{ entry.level }}
              </span>
              <span class="mono text-[10px] text-[color:var(--ink-3)]">{{ String(entry.timestamp).slice(11, 19) }}</span>
              <span class="mono text-[10px] text-[color:var(--ink-3)]">[{{ entry.scope }}]</span>
            </div>
            <div class="text-[color:var(--ink-2)] truncate">{{ entry.message }}</div>
          </div>
          <div v-if="!recentLogs.length" class="px-4 py-6 text-center text-[color:var(--ink-3)] text-sm">
            {{ logError || '暂无日志' }}
          </div>
        </div>
      </SectionCard>
    </div>
  </div>
</template>
