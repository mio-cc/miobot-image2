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

    /* ── 短 TTL 缓存（阶段5性能优化）：体检/注册表被多页复用，
       60s 内重复进入页面不再重拉；保存配置后走 force 强刷。 ── */
    const FRESH_MS = 60_000;
    const bindingsFetchedAt = ref(0);
    /** 能力注册表（/orchestration/capabilities，~64KB 大 payload）：permissions/tools/capabilities 三页共用。 */
    const registry = ref<any[]>([]);
    const registryLoading = ref(false);
    const registryError = ref('');
    const registryFetchedAt = ref(0);
    /** 上次响应的内容指纹（ETag）。TTL 过期后带着它协商，未变化则 304 空体、复用内存缓存。 */
    const registryEtag = ref('');

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

    async function refresh(force = false) {
        if (!force && bindings.value.length && Date.now() - bindingsFetchedAt.value < FRESH_MS) return;
        loading.value = true;
        error.value = '';
        try {
            const res = await client.get('/capabilities');
            bindings.value = res.data.bindings || [];
            labels.value = res.data.labels || {};
            bindingsFetchedAt.value = Date.now();
            lastCheckedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        } catch (e: any) {
            error.value = errorMessage(e, '能力体检失败');
        } finally {
            loading.value = false;
        }
    }

    /** 能力注册表（TTL 同上）：force 用于保存/导入配置后强刷。
     *  60s TTL 期内不发请求；过期后带 If-None-Match 协商，命中 304 时复用内存数据（与 TTL 两级缓存不打架：
     *  TTL 负责"不发请求"，ETag 负责"发了请求也只回空体"）。 */
    async function refreshRegistry(force = false) {
        if (!force && registry.value.length && Date.now() - registryFetchedAt.value < FRESH_MS) return;
        registryLoading.value = true;
        registryError.value = '';
        try {
            const res = await client.get('/orchestration/capabilities', {
                // axios 默认把 304 当错误拒掉，这里显式放行再手动处理。
                headers: registryEtag.value ? { 'If-None-Match': registryEtag.value } : undefined,
                validateStatus: (status: number) => (status >= 200 && status < 300) || status === 304,
            });
            if (res.status === 304) {
                // 内容未变：保留现有数据，TTL 重新计时。
                registryFetchedAt.value = Date.now();
                return;
            }
            registryEtag.value = String(res.headers?.etag || '');
            // MCP roots are appended by the API. Pin them to the front so 18-card pagination cannot hide them.
            registry.value = [...(Array.isArray(res.data.capabilities) ? res.data.capabilities : [])]
                .sort((a: any, b: any) => {
                    const rank = (item: any) => String(item?.id || '').startsWith('mcp.') ? 0 : 1;
                    return rank(a) - rank(b);
                });
            registryFetchedAt.value = Date.now();
        } catch (e: any) {
            registryError.value = e?.response?.data?.error || e?.message || '读取能力注册表失败';
        } finally {
            registryLoading.value = false;
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
        bindingsFetchedAt.value = 0;
        registry.value = [];
        registryError.value = '';
        registryFetchedAt.value = 0;
        registryEtag.value = '';
    }

    return { bindings, labels, loading, error, lastCheckedAt, brokenCount, okCount, capabilitiesOf, refresh, refreshRegistry, registry, registryLoading, registryError, resolve, reset };
});
