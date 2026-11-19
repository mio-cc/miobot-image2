<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import SectionCard from '../components/SectionCard.vue';

/**
 * 模型参数（2026-11-19）。
 *
 * 数据来源：bot 进程把抓到的 OpenAPI/文档参数面写到 data/model-contracts.json，
 * 面板只读。这里回答三个问题：
 *   1. 这个模型到底支持哪些参数（enum / 数值约束）
 *   2. 这份契约是怎么来的（schema > docs > probe > learned）
 *   3. 学到过哪些修正（transforms）
 */
interface ContractRow {
    key: string;
    model: string;
    op: string;
    source: string;
    fetchedAt: string;
    required: string[];
    paramNames: string[];
    sizeEnum: string[];
    sizeLimits: null | { multipleOf?: number; maxEdge?: number; aspectMax?: number; pixels?: { min?: number; max?: number } };
    qualityEnum: string[];
    transforms: Record<string, Record<string, string>>;
    notes: string[];
}

const entries = ref<ContractRow[]>([]);
const updatedAt = ref('');
const loading = ref(false);
const loadError = ref('');
const expanded = ref<string>('');

const sourceLabel = (source: string) => {
    if (source === 'schema') return '文档 schema（最可靠）';
    if (source === 'docs') return '文档正文';
    if (source === 'probe') return '422 探测';
    if (source === 'learned') return '运行时学到';
    return source || '未知';
};

const sourceTone = (source: string) => {
    if (source === 'schema') return 'text-[color:var(--ok)]';
    if (source === 'learned') return 'text-[color:var(--warn)]';
    return 'text-[color:var(--ink-3)]';
};

const limitsText = (row: ContractRow) => {
    const limits = row.sizeLimits;
    if (!limits) return '';
    const parts: string[] = [];
    if (limits.multipleOf) parts.push('边长 ' + limits.multipleOf + ' 的倍数');
    if (limits.maxEdge) parts.push('最大边 ' + limits.maxEdge);
    if (limits.aspectMax) parts.push('比例 ≤' + limits.aspectMax + ':1');
    if (limits.pixels?.min || limits.pixels?.max) {
        parts.push('像素 ' + (limits.pixels.min ?? '?') + '~' + (limits.pixels.max ?? '?'));
    }
    return parts.join(' · ');
};

const transformCount = (row: ContractRow) =>
    Object.values(row.transforms || {}).reduce((sum, map) => sum + Object.keys(map || {}).length, 0);

const updatedLabel = computed(() => {
    if (!updatedAt.value) return '';
    const time = Date.parse(updatedAt.value);
    if (!Number.isFinite(time)) return '';
    return new Date(time).toLocaleString();
});

async function refresh() {
    loading.value = true;
    try {
        const res = await client.get('/models/contracts');
        entries.value = Array.isArray(res.data?.entries) ? res.data.entries : [];
        updatedAt.value = String(res.data?.updatedAt || '');
        loadError.value = '';
    } catch (e: any) {
        loadError.value = errorMessage(e);
    } finally {
        loading.value = false;
    }
}

function toggle(key: string) {
    expanded.value = expanded.value === key ? '' : key;
}

/* ── 契约维护（2026-11-19）：面板只写动作文件，由 bot 轮询执行 ── */
const busyKey = ref('');
const actionMessage = ref('');

async function refreshContract(row: ContractRow) {
    busyKey.value = row.key;
    actionMessage.value = '';
    try {
        const res = await client.post('/models/contracts/refresh', { key: row.key, model: row.model });
        actionMessage.value = String(res.data?.note || '已排队');
    } catch (e: any) {
        actionMessage.value = errorMessage(e);
    } finally {
        busyKey.value = '';
    }
}

async function deleteContract(row: ContractRow) {
    if (!window.confirm('删除「' + row.model + '」的参数契约？\n删除后该模型会退回保守模式（只发 prompt），直到重新抓取。')) return;
    busyKey.value = row.key;
    actionMessage.value = '';
    try {
        const res = await client.delete('/models/contracts?key=' + encodeURIComponent(row.key));
        actionMessage.value = String(res.data?.note || '已排队');
        await refresh();
    } catch (e: any) {
        actionMessage.value = errorMessage(e);
    } finally {
        busyKey.value = '';
    }
}

/* ── 试算：给定参数，看最终会发什么（纯函数，不联网） ── */
const trial = ref({ model: '', size: '4k-square', quality: '', count: '' });
const trialResult = ref<null | {
    hasContract: boolean;
    conservative: boolean;
    requestedSize: string;
    sentSize: string;
    snapped: boolean;
    snapReason: string;
    dropped: string[];
    summary: string;
}>(null);
const trialLoading = ref(false);

async function runTrial() {
    trialLoading.value = true;
    try {
        const res = await client.post('/models/contracts/explain', {
            model: trial.value.model,
            ...(trial.value.size ? { size: trial.value.size } : {}),
            ...(trial.value.quality ? { quality: trial.value.quality } : {}),
            ...(trial.value.count ? { count: Number(trial.value.count) } : {}),
        });
        trialResult.value = res.data || null;
    } catch (e: any) {
        actionMessage.value = errorMessage(e);
        trialResult.value = null;
    } finally {
        trialLoading.value = false;
    }
}

function useRowForTrial(row: ContractRow) {
    trial.value.model = row.model;
    void runTrial();
}

onMounted(() => { void refresh(); });
</script>

<template>
    <SectionCard title="模型参数契约" hint="来源优先级：文档 schema > 文档正文 > 422 探测 > 运行时学到">
        <div class="flex items-center gap-3 mb-3 text-xs">
            <button class="ui-btn" :disabled="loading" @click="refresh">{{ loading ? '读取中…' : '刷新' }}</button>
            <span v-if="updatedLabel" class="text-[color:var(--ink-3)]">文件更新于 {{ updatedLabel }}</span>
            <span v-if="loadError" class="text-[color:var(--danger)]">{{ loadError }}</span>
        </div>

        <div v-if="!entries.length" class="text-xs text-[color:var(--ink-3)]">
            还没有契约。bot 启动后抓取模型文档会写到这里；也可以先给某个模型发一次生图请求，
            失败时自愈层会把结论记成 learned 契约。
        </div>

        <div v-else class="overflow-x-auto">
            <table class="ui-table text-xs w-full">
                <thead>
                    <tr>
                        <th class="text-left">模型</th>
                        <th class="text-left">操作</th>
                        <th class="text-left">来源</th>
                        <th class="text-left">尺寸</th>
                        <th class="text-left">质量</th>
                        <th class="text-left">参数数</th>
                        <th class="text-left">修正</th>
                        <th class="text-left">抓取时间</th>
                        <th class="text-left">操作</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in entries" :key="row.key" class="cursor-pointer" @click="toggle(row.key)">
                        <td>
                            <div class="font-medium">{{ row.model }}</div>
                            <div v-if="row.key" class="text-[color:var(--ink-3)] break-all">{{ row.key }}</div>
                        </td>
                        <td>{{ row.op }}</td>
                        <td :class="sourceTone(row.source)">{{ sourceLabel(row.source) }}</td>
                        <td>
                            <div v-if="row.sizeEnum.length">{{ row.sizeEnum.join(' / ') }}</div>
                            <div v-if="limitsText(row)" class="text-[color:var(--ink-3)]">{{ limitsText(row) }}</div>
                            <span v-if="!row.sizeEnum.length && !row.sizeLimits" class="text-[color:var(--ink-3)]">—</span>
                        </td>
                        <td>{{ row.qualityEnum.length ? row.qualityEnum.join(' / ') : '—' }}</td>
                        <td>{{ row.paramNames.length }}</td>
                        <td>{{ transformCount(row) || '—' }}</td>
                        <td class="text-[color:var(--ink-3)]">{{ row.fetchedAt ? new Date(row.fetchedAt).toLocaleString() : '—' }}</td>
                        <td @click.stop>
                            <div class="flex gap-2">
                                <button class="ui-btn" :disabled="busyKey === row.key" @click="refreshContract(row)">重新抓取</button>
                                <button class="ui-btn" :disabled="busyKey === row.key" @click="deleteContract(row)">删除</button>
                                <button class="ui-btn" @click="useRowForTrial(row)">试算</button>
                            </div>
                        </td>
                    </tr>
                    <tr v-if="expanded">
                        <td colspan="9">
                            <div class="text-xs space-y-1 py-2">
                                <div><span class="text-[color:var(--ink-3)]">必填：</span>{{ entries.find((item) => item.key === expanded)?.required.join(', ') || '无' }}</div>
                                <div><span class="text-[color:var(--ink-3)]">参数：</span>{{ entries.find((item) => item.key === expanded)?.paramNames.join(', ') }}</div>
                                <div v-if="entries.find((item) => item.key === expanded)?.notes.length">
                                    <span class="text-[color:var(--ink-3)]">备注：</span>{{ entries.find((item) => item.key === expanded)?.notes.join('；') }}
                                </div>
                                <pre class="text-[color:var(--ink-3)] whitespace-pre-wrap break-all">{{ JSON.stringify(entries.find((item) => item.key === expanded)?.transforms || {}, null, 1) }}</pre>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </SectionCard>

    <SectionCard title="参数试算" hint="纯函数计算，不联网；回答「我选 4k-square，最后到底会发什么」" class="mt-4">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs mb-3">
            <label class="flex flex-col gap-1">
                <span class="text-[color:var(--ink-3)]">模型</span>
                <input v-model="trial.model" class="ui-input" placeholder="openai/gpt-image-2.6/sunburst/text-to-image" />
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-[color:var(--ink-3)]">画幅</span>
                <input v-model="trial.size" class="ui-input" placeholder="4k-square / 1152x1536 / auto" />
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-[color:var(--ink-3)]">质量</span>
                <input v-model="trial.quality" class="ui-input" placeholder="max / high / auto" />
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-[color:var(--ink-3)]">张数</span>
                <input v-model="trial.count" class="ui-input" placeholder="1" />
            </label>
        </div>
        <div class="flex items-center gap-3 text-xs">
            <button class="ui-btn" :disabled="trialLoading || !trial.model" @click="runTrial">{{ trialLoading ? '计算中…' : '试算' }}</button>
            <span v-if="actionMessage" class="text-[color:var(--ink-3)]">{{ actionMessage }}</span>
        </div>
        <div v-if="trialResult" class="text-xs mt-3 space-y-1">
            <div v-if="!trialResult.hasContract" class="text-[color:var(--warn)]">
                没有该模型的契约：会走保守模式（{{ trialResult.conservative ? '只发 prompt' : '按内置档案' }}）
            </div>
            <div>
                <span class="text-[color:var(--ink-3)]">将发送：</span>
                <span>{{ trialResult.summary }}</span>
            </div>
            <div v-if="trialResult.snapped" class="text-[color:var(--warn)]">
                已调整：请求 {{ trialResult.requestedSize }} → 实际 {{ trialResult.sentSize }}（{{ trialResult.snapReason }}）
            </div>
            <div v-if="trialResult.dropped.length" class="text-[color:var(--ink-3)]">
                未下发：{{ trialResult.dropped.join('、') }}
            </div>
        </div>
    </SectionCard>
</template>