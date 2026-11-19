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
                    </tr>
                    <tr v-if="expanded">
                        <td colspan="8">
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
</template>