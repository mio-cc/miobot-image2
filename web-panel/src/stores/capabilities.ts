import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import client, { errorMessage } from '../api/client';

/**
 * 能力体检结果。
 * 后端按「用户覆盖 → 按模型 ID 推断」解析出每项能力实际可不可用，
 * 这里只负责缓存与展示。
 */

export interface Binding {
    key: string;
    label: string;
    trigger: string;
    operation: string;
    nodeIndex: number;
    nodeName: string;
    model: string;
    enabled: boolean;
    operations: string[];
    source: 'override' | 'inferred';
    ok: boolean;
    reason?: string;
    learned?: { dropped: string[]; renamed: Record<string, string> };
}

export const useCapabilityStore = defineStore('capabilities', () => {
    const bindings = ref<Binding[]>([]);
    const labels = ref<Record<string, string>>({});
    const loading = ref(false);
    const error = ref('');
    const lastCheckedAt = ref('');
    /** 单个「节点+模型」的解析缓存，用户在下拉里改模型时即时出徽标。 */
    const resolved = ref<Record<string, string[]>>({});

    const brokenCount = computed(() => bindings.value.filter(item => item.enabled && !item.ok).length);
    const okCount = computed(() => bindings.value.filter(item => item.ok).length);

    /** 模型 ID → 能力。体检结果与按需解析结果合并；没查过就是空。 */
    const modelCapabilityMap = computed(() => {
        const map: Record<string, string[]> = {};
        for (const item of bindings.value) {
            if (item.model) map[item.model] = item.operations || [];
        }
        return { ...map, ...resolved.value };
    });

    function capabilitiesOf(model: string) {
        return modelCapabilityMap.value[String(model || '').trim()] || [];
    }

    async function refresh() {
        loading.value = true;
        error.value = '';
        try {
            const res = await client.get('/capabilities');
            bindings.value = res.data.bindings || [];
            labels.value = res.data.labels || {};
            lastCheckedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        } catch (e: any) {
            error.value = errorMessage(e, '能力体检失败');
        } finally {
            loading.value = false;
        }
    }

    /**
     * 查任意「节点 + 模型」组合的能力。结果写进缓存，下拉徽标随之更新。
     * 注意后端这条是 POST（body 里带 nodeIndex/model），不是 query 参数。
     */
    async function resolve(nodeIndex: number, model: string) {
        const key = String(model || '').trim();
        if (!key || resolved.value[key]) return resolved.value[key];
        try {
            const res = await client.post('/capabilities/resolve', { nodeIndex, model: key });
            const ops = res.data?.resolved?.operations || [];
            resolved.value = { ...resolved.value, [key]: ops };
            return ops;
        } catch {
            return undefined;
        }
    }

    function reset() {
        bindings.value = [];
        resolved.value = {};
        error.value = '';
        lastCheckedAt.value = '';
    }

    return { bindings, labels, loading, error, lastCheckedAt, brokenCount, okCount, capabilitiesOf, refresh, resolve, reset };
});
