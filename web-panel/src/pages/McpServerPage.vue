<script setup lang="ts">
/**
 * P3-MCP（方案 §4.7 / D27）：单个 MCP 服务器的专属配置页。
 * 区块：连接与鉴权状态 / 根工具设置 / 参数默认值 / 子项工具 / 调用与诊断。
 * - 子项开关与改名统一写 orchestration.capabilityOverrides['mcp.<server>.<tool>']（D22，不另起存储）；
 * - 根级设置写 capabilityOverrides['mcp.<server>']；暴露级走 toolRegistry.exposure（提示 + 本页可改）；
 * - OAuth 连接/断开/重连走 /api/mcp/* 端点；bot 经 mcp-trigger.json 执行真实动作并写状态快照，
 *   本页轮询快照显示阶段与结果（双进程无法直接调用，轮询是唯一可靠的完成信号）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import FlowEditor from '../components/FlowEditor.vue';
import ParamDefaultsEditor from '../components/ParamDefaultsEditor.vue';

const route = useRoute();
const configStore = useConfigStore();
const serverId = computed(() => String(route.params.serverId || ''));

const statusRefreshing = ref(false);
const statusError = ref('');
const configError = ref('');
const busyAction = ref<'' | 'connect' | 'reconnect' | 'disconnect'>('');
const actionPhase = ref('');
const confirmingDisconnect = ref(false);
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null);
const authUrl = ref('');
const serverStatus = ref<any>(null);
const serverChildren = ref<any[]>([]);

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let disposed = false;

const orchestration = computed(() => configStore.config?.orchestration as any);
const server = computed(() => (orchestration.value?.mcpServers || []).find((item: any) => String(item.id) === serverId.value));

const busy = computed(() => busyAction.value !== '');
/** 连接端点是否已填写：HTTP 看 url，stdio 看启动命令。 */
const serverHasEndpoint = computed(() => {
    const config = server.value as any;
    if (!config) return false;
    return config.transport === 'stdio'
        ? Boolean(String(config.command || '').trim())
        : Boolean(String(config.url || '').trim());
});
const serverDisabled = computed(() => server.value?.enabled === false);
const serverEnabled = computed({
    get: () => server.value?.enabled !== false,
    set: (value: boolean) => { if (server.value) server.value.enabled = value; },
});
/* ── 提示与文案 ── */

function showToast(kind: 'success' | 'error', message: string) {
    toast.value = { kind, message };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.value = null; }, 5000);
}

/** 把 bot/后端抛出的英文错误码翻译成「下一步该做什么」。取不到映射时原样显示，不吞信息。 */
function friendlyError(raw: unknown): string {
    const text = String(raw || '').trim();
    if (!text) return '操作失败，但没有拿到具体原因；请稍后重试或查看 bot 日志。';
    const lower = text.toLowerCase();
    if (lower.includes('mcp_http_401')) return '授权已失效：请点「连接账号」重新授权（自动刷新令牌也没能换到可用凭据）。';
    if (lower.includes('mcp_http_403') || lower.includes('insufficient_scope')) return '当前授权缺少必要权限（scope 不足），刷新令牌无法扩权：请点「连接账号」重新授权。';
    if (lower.includes('invalid_grant')) return '刷新令牌已失效（可能被对方撤销）：请点「连接账号」重新授权。';
    if (lower.includes('invalid_scope')) return '授权范围不足且刷新令牌不支持扩权：请点「连接账号」重新授权。';
    if (lower.includes('mcp_server_not_found')) return '配置里找不到这个服务器，可能已被删除：请回 MCP 列表重新进入。';
    if (lower.includes('mcp_server_disabled')) return '该服务器已停用：点「连接账号」会自动启用并保存，也可以在下方「根工具设置」手动启用后保存。';
    if (lower.includes('mcp_no_resource_metadata')) return '这个地址没有声明 OAuth 资源信息：请核对连接地址；如果对方本来就不需要登录，请把鉴权方式改掉。';
    if (lower.includes('mcp_dcr_unsupported')) return '对方授权服务器不支持自动注册应用：需要先在对方平台手动注册 client_id。';
    if (lower.includes('econnrefused') || lower.includes('etimedout') || lower.includes('fetch failed') || lower.includes('enotfound')) return '连不上服务器：请检查网络/代理与连接地址后重试。';
    if (lower.includes('mcp_stdio')) return '本地进程启动失败：请检查启动命令、参数与运行环境。';
    if (lower.includes('unauthorized')) return '面板登录已过期，请重新登录后再操作。';
    if (lower.includes('502') || lower.includes('bad gateway')) return '面板后端暂时不可用（502 Bad Gateway）：通常是 Miobot web 服务正在重启，或 nginx 的上游连接失败。请确认服务恢复后再重试。';
    if (lower.includes('503') || lower.includes('504') || lower.includes('gateway timeout')) return '面板后端暂时不可用（503/504）：请检查 Miobot web 服务与反向代理是否正常。';
    if (lower.includes('network error') || lower.includes('failed to fetch')) return '请求没有到达面板后端：请检查网络、反向代理与 Miobot web 服务是否运行。';
    return text;
}

/** 鉴权类错误才提示「重新授权」；普通网络错误给「重试」。 */
const isAuthError = computed(() => {
    const text = String(serverStatus.value?.lastError || '').toLowerCase();
    return text.includes('mcp_http_401') || text.includes('mcp_http_403') || text.includes('insufficient_scope')
        || text.includes('invalid_grant') || text.includes('invalid_scope');
});

/* ── 覆盖配置（与能力中心同一套字段） ── */

function ensureOverride(key: string): any {
    (orchestration.value as any).capabilityOverrides ||= {};
    const all = (orchestration.value as any).capabilityOverrides;
    all[key] ||= {};
    return all[key];
}
function overrideValue(key: string, field: string): any {
    return (orchestration.value as any).capabilityOverrides?.[key]?.[field];
}

/** 开关初值反映「有效状态」而非「覆盖原始值」：未配置时读 bot 侧默认（根=默认限制、子项=进树即启用），
 *  写入才物化 override——避免一进页面就物化脏改。 */
const rootEnabled = computed({
    get: () => (orchestration.value as any).capabilityOverrides?.[`mcp.${serverId.value}`]?.enabled ?? false,
    set: (value: boolean) => { ensureOverride(`mcp.${serverId.value}`).enabled = value; },
});
const rootApproval = computed({
    get: () => (orchestration.value as any).capabilityOverrides?.[`mcp.${serverId.value}`]?.approvalRequired === true,
    set: (value: boolean) => { ensureOverride(`mcp.${serverId.value}`).approvalRequired = value; },
});
const rootName = computed({
    get: (): string => overrideValue(`mcp.${serverId.value}`, 'name') ?? '',
    set: (value: string) => { ensureOverride(`mcp.${serverId.value}`).name = String(value ?? ''); },
});
const rootRiskLevel = computed({
    get: (): string => overrideValue(`mcp.${serverId.value}`, 'riskLevel') ?? '',
    set: (value: string) => { ensureOverride(`mcp.${serverId.value}`).riskLevel = value || undefined; },
});
const childModels = computed(() => serverChildren.value.map((child: any) => ({
    ...child,
    enabledModel: computed({
        get: () => (orchestration.value as any).capabilityOverrides?.[`mcp.${serverId.value}.${child.name}`]?.enabled ?? true,
        set: (value: boolean) => { ensureOverride(`mcp.${serverId.value}.${child.name}`).enabled = value; },
    }),
    nameModel: computed({
        get: (): string => overrideValue(`mcp.${serverId.value}.${child.name}`, 'name') ?? '',
        set: (value: string) => { ensureOverride(`mcp.${serverId.value}.${child.name}`).name = String(value ?? ''); },
    }),
})));

/* ── 参数默认值：根级作用于全部子项；子项级同键整条覆盖根级。 ── */
const rootParamDefaults = computed<Record<string, { value: string | number | boolean; locked?: boolean }>>(() => (server.value as any)?.paramDefaults || {});
function setRootParamDefaults(next: Record<string, { value: string | number | boolean; locked?: boolean }>) {
    if (!server.value) return;
    (server.value as any).paramDefaults = next;
}
const expandedChildDefaults = ref<string>('');
function childParamDefaultsOf(toolName: string): Record<string, { value: string | number | boolean; locked?: boolean }> {
    return (server.value as any)?.childParamDefaults?.[toolName] || {};
}
function setChildParamDefaults(toolName: string, next: Record<string, { value: string | number | boolean; locked?: boolean }>) {
    if (!server.value) return;
    (server.value as any).childParamDefaults ||= {};
    if (Object.keys(next).length) (server.value as any).childParamDefaults[toolName] = next;
    else delete (server.value as any).childParamDefaults[toolName];
}
function childDefaultsSummary(toolName: string): string {
    const rules = childParamDefaultsOf(toolName);
    const text = Object.entries(rules)
        .slice(0, 3)
        .map(([key, rule]) => `${key}=${String(rule.value)}${rule.locked ? '🔒' : ''}`)
        .join('、');
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
const paramKeySuggestions = computed<string[]>(() => {
    const keys = new Set<string>();
    for (const child of serverChildren.value as any[]) {
        const props = child?.inputSchema?.properties;
        if (props && typeof props === 'object') for (const key of Object.keys(props)) keys.add(key);
    }
    return [...keys].slice(0, 50);
});

/* ── 术语中文化（只在展示层翻译，取值保持原样，避免写坏配置） ── */
const effectLabels: Record<string, string> = {
    read: '只读', readOnly: '只读', write: '会写入/有副作用', external: '外部调用', network: '联网', unknown: '未知',
};
const riskLabels: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险', critical: '极高风险' };
const stateLabels: Record<string, string> = {
    connected: '已连接', 'connected-no-tools': '已连接 · 没有可用工具', connecting: '连接中',
    'needs-auth': '需要授权', disconnected: '已断开', disabled: '已停用', unknown: '未知（bot 未上报）',
};
function effectLabel(value: unknown): string {
    const key = String(value || 'unknown');
    return effectLabels[key] || key;
}
function riskLabel(value: unknown): string {
    const key = String(value || 'medium');
    return riskLabels[key] || key;
}
const exposure = computed(() => configStore.config?.toolRegistry?.exposure?.[`mcp.${serverId.value}`] as string | undefined);
const stateBadge = computed(() => {
    // 停用优先于旧快照：后端热重载后快照可能滞后一拍，不能把已停用显示成已连接。
    const state = server.value?.enabled === false
        ? 'disabled'
        : (serverStatus.value?.state || (server.value?.auth === 'oauth' ? 'needs-auth' : 'unknown'));
    return { state, label: stateLabels[state] || state };
});
const isOAuth = computed(() => server.value?.auth === 'oauth');
/** 授权回调瞬间（popup 落到本页）与主面板轮询都能看到的结果。 */
const authorizedViaCallback = computed(() => route.query.authorized === '1');

/* ── 状态刷新与轮询 ── */

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function refreshStatus(options: { silent?: boolean } = {}) {
    if (!options.silent) {
        statusRefreshing.value = true;
        statusError.value = '';
    }
    try {
        const res = await client.get('/mcp/status', { timeout: 20_000 });
        const snapshot = res.data?.status || {};
        const found = (snapshot.servers || []).find((item: any) => item.serverId === serverId.value) || null;
        serverStatus.value = found;
        serverChildren.value = (snapshot.children || []).filter((item: any) => item.serverId === serverId.value);
        statusError.value = '';
        return found;
    } catch (error: any) {
        // 静默轮询失败也要显示原因：后端 502/重启时不能只留一个无反应的按钮。
        statusError.value = friendlyError(errorMessage(error, '状态获取失败'));
        return serverStatus.value;
    } finally {
        if (!options.silent) statusRefreshing.value = false;
    }
}

/** 配置加载失败会阻断整页渲染；单独兜住并允许恢复后重试。 */
async function loadConfig(force = false): Promise<boolean> {
    if (!force && configStore.loaded) return true;
    configError.value = '';
    try {
        await configStore.fetchConfig();
        return true;
    } catch (error: any) {
        configError.value = friendlyError(errorMessage(error, '配置加载失败'));
        return false;
    }
}

async function retryLoad() {
    await loadConfig(true);
    await refreshStatus();
}

/** 连接账号/重连是明确用户动作：若服务器还是内置预置的停用状态，先自动启用并落盘。 */
async function ensureServerEnabled(): Promise<void> {
    if (!server.value || server.value.enabled !== false) return;
    const previous = server.value.enabled;
    actionPhase.value = '服务器当前停用，正在启用并保存配置…';
    server.value.enabled = true;
    const result = await configStore.save();
    if (!result.ok) {
        server.value.enabled = previous;
        throw new Error(configStore.saveStatus || '启用服务器失败');
    }
    actionPhase.value = '服务器已启用，正在发起连接…';
}

/** 轮询直到条件成立；onTick 用来更新阶段文案。超时返回最后一次状态（不抛错）。 */
async function waitForStatus(
    predicate: (status: any) => boolean,
    timeoutMs: number,
    onTick?: (status: any) => void,
): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let last = serverStatus.value;
    while (!disposed && Date.now() < deadline) {
        const status = await refreshStatus({ silent: true });
        if (status) last = status;
        onTick?.(last);
        if (predicate(last)) return last;
        await sleep(700);
    }
    return last;
}

const terminalState = (state: string) => state === 'connected' || state === 'connected-no-tools'
    || state === 'needs-auth' || state === 'disconnected' || state === 'disabled';

/* ── 三个动作：连接账号 / 重连 / 断开 ── */

async function doConnect() {
    if (!server.value) return showToast('error', '配置里找不到这个服务器，无法连接。');
    if (!serverHasEndpoint.value) return showToast('error', '请先在下方「根工具设置」填写连接地址并保存后再连接。');
    busyAction.value = 'connect';
    try {
        await ensureServerEnabled();
        actionPhase.value = isOAuth.value ? '正在向对方服务器发起授权…' : '正在建立连接…';
        if (isOAuth.value) {
            const res = await client.post('/mcp/connect', { serverId: serverId.value });
            const url = String(res.data?.authorizationUrl || '');
            if (!url) throw new Error('没有拿到授权链接，请稍后重试或检查连接地址。');
            actionPhase.value = '等待你在浏览器完成授权…（完成后本页会自动更新，无需刷新）';
            authUrl.value = url;
            // 不用 noopener：需要拿返回值判断是否被浏览器拦截（noopener 下 window.open 恒返回 null）。
            const opened = window.open(url, '_blank');
            if (!opened) {
                showToast('error', '浏览器拦截了授权窗口：请允许弹窗后重试，或点下方「手动打开授权页面」。');
            }
            const baseline = serverStatus.value?.state;
            const baselineChangedAt = serverStatus.value?.lastChangedAt ?? '';
            const status = await waitForStatus(
                // 必须看到状态时间戳变化才算完成——否则已连接时点「重新授权」会立刻误报成功。
                (s) => Boolean(s) && (s.state === 'connected' || s.state === 'connected-no-tools')
                    && (!baselineChangedAt || s.lastChangedAt !== baselineChangedAt),
                120_000,
                (s) => {
                    if (!s) return;
                    if (s.state === 'connecting') actionPhase.value = '授权已返回，正在握手并拉取工具清单…';
                    else if (s.state === 'needs-auth' && baseline !== 'needs-auth') actionPhase.value = '已收到授权结果，正在核对权限…';
                },
            );
            if (status?.state === 'connected' || status?.state === 'connected-no-tools') {
                actionPhase.value = '';
                authUrl.value = '';
                showToast('success', `授权完成，已连接（${status.toolCount ?? 0} 个工具可用）。`);
                await refreshStatus({ silent: true });
                return;
            }
            if (status?.state === 'needs-auth' && status?.lastError) {
                throw new Error(status.lastError);
            }
            throw new Error('等待授权超时：如果浏览器里已完成授权，请点「重连」；如果没完成，请重新点「连接账号」。');
        }
        // 非 OAuth：直接触发重连（拉起本地进程 / 静态 token 连接）。
        const res = await client.post('/mcp/reconnect', { serverId: serverId.value });
        if (!res.data?.success) throw new Error(res.data?.error || '重连请求失败');
        const status = await waitForStatus(
            (s) => Boolean(s) && (s.state === 'connected' || s.state === 'connected-no-tools' || s.state === 'needs-auth' || s.state === 'disconnected'),
            30_000,
            (s) => { if (s?.state === 'connecting') actionPhase.value = '正在握手并拉取工具清单…'; },
        );
        if (status?.state === 'connected' || status?.state === 'connected-no-tools') {
            actionPhase.value = '';
            showToast('success', `连接完成（${status.toolCount ?? 0} 个工具可用）。`);
            return;
        }
        throw new Error(status?.lastError || '连接没有成功，请查看状态或稍后重试。');
    } catch (error: any) {
        actionPhase.value = '';
        showToast('error', friendlyError(error?.response?.data?.error || error?.message || error));
    } finally {
        busyAction.value = '';
    }
}

async function doReconnect(forceTokenRefresh = false) {
    if (!server.value) return showToast('error', '配置里找不到这个服务器，无法重连。');
    if (!serverHasEndpoint.value) return showToast('error', '请先在下方「根工具设置」填写连接地址并保存后再重连。');
    busyAction.value = 'reconnect';
    try {
        await ensureServerEnabled();
        actionPhase.value = forceTokenRefresh ? '正在请求强制刷新令牌并重连…' : '正在请求重连…';
        const res = await client.post('/mcp/reconnect', { serverId: serverId.value, forceTokenRefresh });
        if (!res.data?.success) throw new Error(res.data?.error || '重连请求失败');
        actionPhase.value = '正在断开旧连接…';
        const baseline = serverStatus.value?.lastChangedAt;
        let sawConnecting = false;
        const status = await waitForStatus(
            (s) => {
                if (!s) return false;
                if (s.state === 'connecting') { sawConnecting = true; return false; }
                return (sawConnecting || s.lastChangedAt !== baseline) && terminalState(s.state);
            },
            30_000,
            (s) => {
                if (!s) { actionPhase.value = '正在等待 bot 执行重连…'; return; }
                if (s.state === 'connecting') actionPhase.value = '正在握手（initialize）并拉取工具清单…';
                else if (!sawConnecting && s.lastChangedAt === baseline) actionPhase.value = '正在等待 bot 执行重连…';
            },
        );
        if (status?.state === 'connected' || status?.state === 'connected-no-tools') {
            actionPhase.value = '';
            showToast('success', `重连成功，已拉取 ${status.toolCount ?? 0} 个工具。`);
            return;
        }
        actionPhase.value = '';
        throw new Error(status?.lastError || '重连没有生效：请确认 bot 服务正在运行，或查看下方错误。');
    } catch (error: any) {
        actionPhase.value = '';
        showToast('error', friendlyError(error?.response?.data?.error || error?.message || error));
        await refreshStatus({ silent: true });
    } finally {
        busyAction.value = '';
    }
}

async function doDisconnect() {
    if (busy.value) return;
    if (!confirmingDisconnect.value) {
        confirmingDisconnect.value = true;
        setTimeout(() => { confirmingDisconnect.value = false; }, 5000);
        return;
    }
    confirmingDisconnect.value = false;
    busyAction.value = 'disconnect';
    actionPhase.value = '正在清除本机凭据并断开连接…';
    try {
        const res = await client.post('/mcp/disconnect', { serverId: serverId.value });
        if (!res.data?.success) throw new Error(res.data?.error || '断开请求失败');
        const baseline = serverStatus.value?.lastChangedAt;
        const status = await waitForStatus(
            (s) => !s || (s.lastChangedAt !== baseline && terminalState(s.state)),
            15_000,
        );
        actionPhase.value = '';
        if (status?.state === 'connected' || status?.state === 'connecting') {
            throw new Error('断开请求已发出，但连接仍未停止；请稍后再试或检查 bot 日志。');
        }
        showToast('success', '已断开并清除本机凭据。需要再次使用请点「连接账号」。');
    } catch (error: any) {
        actionPhase.value = '';
        showToast('error', friendlyError(error?.response?.data?.error || error?.message || error));
    } finally {
        busyAction.value = '';
        await refreshStatus({ silent: true });
    }
}

async function save() {
    statusError.value = '';
    configError.value = '';
    const result = await configStore.save();
    if (!result.ok) showToast('error', configStore.saveStatus || '保存失败');
    else showToast('success', '已保存，bot 会即时热重载。');
}

/* 实测障碍 #2（2026-11-07）：MCP 根默认 searchable，toolSearchEnabled=false（生产默认）时
 * 模型完全不可见——接入后必须引导开启，否则「接进去等于白接」。 */
const toolSearchDisabled = computed(() => (configStore.config as any)?.toolRegistry?.toolSearchEnabled !== true);
async function enableToolSearch() {
    const toolRegistry = (configStore.config as any)?.toolRegistry;
    if (!toolRegistry) return;
    toolRegistry.toolSearchEnabled = true;
    const result = await configStore.save();
    if (result.ok) showToast('success', '已开启工具检索：模型现在能发现并使用这些 MCP 工具了。');
    else showToast('error', configStore.saveStatus || '保存失败');
}

onMounted(async () => {
    await loadConfig();
    await refreshStatus();
    // 页面停留期间每 10 秒静默刷新：授权回调、bot 巡检、别的标签页操作都能自己反映出来。
    // 首次配置加载遇到 502 时也继续轮询，后端恢复后页面可自愈，不需要用户手动刷新。
    autoRefreshTimer = setInterval(() => {
        void (async () => {
            if (!configStore.loaded) await loadConfig();
            await refreshStatus({ silent: true });
        })();
    }, 10_000);
    if (authorizedViaCallback.value) {
        showToast('success', '授权结果已返回，正在自动连接…');
        const status = await waitForStatus(
            (s) => Boolean(s) && (s.state === 'connected' || s.state === 'connected-no-tools' || s.state === 'needs-auth'),
            60_000,
            (s) => { if (s?.state === 'connecting') actionPhase.value = '授权已返回，正在握手并拉取工具清单…'; },
        );
        actionPhase.value = '';
        if (status?.state === 'connected' || status?.state === 'connected-no-tools') showToast('success', `已连接（${status.toolCount ?? 0} 个工具可用）。`);
        else if (status?.lastError) showToast('error', friendlyError(status.lastError));
    }
});

onUnmounted(() => {
    disposed = true;
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-4">
    <!-- 移动端返回（<640px 面包屑隐藏）：确定性层级返回——上级是 MCP 列表 -->
    <div class="sm:hidden -mb-2 flex items-center gap-2">
      <router-link to="/mcp" class="btn-outline !px-2.5 !py-1 !text-xs">‹ 返回 MCP 列表</router-link>
    </div>

    <div v-if="configError" class="card p-3 flex flex-wrap items-center gap-3">
      <span class="text-xs text-red-600">配置加载失败：{{ configError }}</span>
      <button class="btn-outline !px-3 !py-1 !text-xs ml-auto" :disabled="configStore.saving" @click="retryLoad">重试加载</button>
    </div>

    <!-- 检索关闭 = MCP 对模型完全不可见——最后一公里引导 -->
    <div v-if="toolSearchDisabled" class="card p-3 flex flex-wrap items-center gap-3">
      <span class="text-xs text-amber-600">「工具检索」当前关闭：MCP 工具默认按需检索，关闭时模型既看不到也搜不到它们，接进来等于没用。</span>
      <button class="btn !px-3 !py-1 !text-xs ml-auto" :disabled="configStore.saving" @click="enableToolSearch">开启工具检索</button>
    </div>

    <SectionCard :title="`MCP 服务器：${rootName || serverId}`" :hint="isOAuth ? '远程 MCP 服务 · 用账号授权接入 · 模型只看到一个入口，具体工具有需要时再检索' : '远程/本地 MCP 服务 · 模型只看到一个入口，具体工具有需要时再检索'">
      <template #actions>
        <button class="btn-outline !px-3" :disabled="statusRefreshing || busy" @click="refreshStatus()">
          {{ statusRefreshing ? '刷新中…' : '刷新状态' }}
        </button>
        <button class="btn-outline !px-3" :disabled="!serverHasEndpoint || busy" :title="serverHasEndpoint ? (serverDisabled ? '服务器已停用，点击会自动启用并保存后重连' : '') : '需要先填写连接地址'" @click="doReconnect(false)">
          {{ busyAction === 'reconnect' ? '重连中…' : '重连' }}
        </button>
      </template>

      <p class="text-xs text-[color:var(--ink-3)] mb-3">
        这一块决定「面板能不能连上这个 MCP 服务器」。连接成功后，下方子项工具清单才会出现；连接失败时模型也调不到任何工具。
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <span class="tag" :class="stateBadge.state === 'connected' || stateBadge.state === 'connected-no-tools' ? '!bg-green-500/15 !text-green-600' : stateBadge.state === 'needs-auth' ? '!bg-amber-500/15 !text-amber-600' : stateBadge.state === 'connecting' ? '!bg-sky-500/15 !text-sky-600' : ''">{{ stateBadge.label }}</span>
        <span v-if="serverStatus" class="text-xs text-[color:var(--ink-3)]">
          已接入工具 {{ serverStatus.toolCount ?? 0 }} 个（其中启用 {{ serverStatus.enabledToolCount ?? 0 }} 个）
          <template v-if="serverStatus.fetchedAt"> · 清单更新于 {{ String(serverStatus.fetchedAt).slice(0, 19).replace('T', ' ') }}</template>
        </span>
        <span v-else class="text-xs text-[color:var(--ink-3)]">
          {{ isOAuth ? '该服务尚未授权：点下方「连接账号」完成登录授权，不会消耗额度。' : '还没有状态：可能未配置、bot 未运行，或正在第一次连接。' }}
        </span>
        <span v-if="serverStatus?.lastChangedAt" class="text-xs text-[color:var(--ink-3)]">状态变化于 {{ String(serverStatus.lastChangedAt).slice(0, 19).replace('T', ' ') }}</span>
      </div>

      <!-- 进行中：阶段文案 + 细进度条，按钮不会「点了没反应」 -->
      <div v-if="busy || actionPhase" class="mt-3 rounded-lg bg-[color:var(--surface-2)] p-3">
        <div class="flex items-center gap-2 text-xs text-[color:var(--ink-2)]">
          <span class="inline-block h-2 w-2 rounded-full bg-sky-500 animate-pulse"></span>
          <span>{{ actionPhase || (busyAction === 'connect' ? '正在连接…' : busyAction === 'reconnect' ? '正在重连…' : '正在断开…') }}</span>
        </div>
        <div class="mt-2 h-1 rounded bg-[color:var(--hairline-2)] overflow-hidden">
          <div class="h-full w-1/3 bg-sky-500 animate-pulse"></div>
        </div>
      </div>

      <!-- 失败原因：中文可操作提示 + 重试入口 -->
      <div v-if="serverStatus?.lastError" class="mt-3 rounded-lg border border-red-300/50 bg-red-500/5 p-3">
        <p class="text-xs text-red-600">{{ friendlyError(serverStatus.lastError) }}</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button v-if="isAuthError && isOAuth" class="btn !px-3 !py-1 !text-xs" :disabled="busy" @click="doConnect">重新授权</button>
          <button v-if="isOAuth && serverStatus.lastError" class="btn-outline !px-3 !py-1 !text-xs" :disabled="busy" @click="doReconnect(true)">强制刷新令牌后重连</button>
          <button class="btn-outline !px-3 !py-1 !text-xs" :disabled="statusRefreshing || busy" @click="refreshStatus()">重试读取状态</button>
          <details class="w-full mt-1">
            <summary class="text-[11px] text-[color:var(--ink-3)] cursor-pointer">查看原始错误（排查用）</summary>
            <div class="mt-1 text-[11px] text-[color:var(--ink-3)] font-mono break-all">{{ serverStatus.lastError }}</div>
          </details>
        </div>
      </div>
      <div v-if="statusError" class="mt-2 text-xs text-amber-600 flex flex-wrap items-center gap-2">
        <span>{{ statusError }}</span>
        <button class="btn-outline !px-2 !py-0.5 !text-xs" @click="refreshStatus()">重试</button>
      </div>

      <!-- OAuth 连接与鉴权 -->
      <div v-if="isOAuth" class="mt-4 rounded-lg bg-[color:var(--surface-2)] p-3">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold">账号授权（OAuth）</div>
            <p class="text-xs text-[color:var(--ink-3)] mt-1">
              点「连接账号」会打开对方的登录页；授权完成后对方会回调本机，凭据只保存在本机凭据文件里（不会写进 config.json）。
              「断开」会清掉这份凭据，下次使用需要重新授权。
            </p>
          </div>
          <div class="flex flex-wrap gap-2 w-full sm:w-auto">
            <button class="btn !px-3 w-full sm:w-auto" :disabled="!serverHasEndpoint || busy" :title="serverHasEndpoint ? (serverDisabled ? '服务器已停用，点击会自动启用并保存后授权' : '') : '需要先填写连接地址'" @click="doConnect">
              {{ busyAction === 'connect' ? '授权中…' : '连接账号' }}
            </button>
            <button class="btn-outline !px-3 w-full sm:w-auto" :class="confirmingDisconnect ? '!text-red-600 !border-red-400/60' : ''" :disabled="busy" @click="doDisconnect">
              {{ busyAction === 'disconnect' ? '断开中…' : confirmingDisconnect ? '再点一次确认断开' : '断开并清除凭据' }}
            </button>
          </div>
        </div>
        <p v-if="!serverHasEndpoint" class="mt-2 text-[11px] text-amber-600">当前不可连接：请先在下方「根工具设置」填写连接地址并保存。</p>
        <p v-else-if="serverDisabled" class="mt-2 text-[11px] text-amber-600">服务器当前已停用：点「连接账号」会自动启用并保存；也可以在下方「根工具设置」手动启用后保存。</p>
        <p v-if="authUrl" class="mt-2 text-[11px] text-[color:var(--ink-3)]">
          授权页面没有自动打开？
          <a :href="authUrl" target="_blank" rel="noopener noreferrer" class="text-[color:var(--accent)] hover:underline">手动打开授权页面</a>
          （本页会继续自动检测授权结果）。
        </p>
      </div>
      <div v-if="authorizedViaCallback" class="mt-2 text-xs text-green-600">已检测到授权回调，正在自动更新状态（本页无需刷新）。</div>
    </SectionCard>

    <!-- serverId 不在配置中（已删除/链接过期）→ 空态页，不做 server.* 直绑（防整页 TypeError） -->
    <SectionCard v-if="!server" title="未找到这个 MCP 服务器" hint="配置里没有对应条目，页面不会显示任何可操作项">
      <p class="text-xs text-[color:var(--ink-3)]">
        该服务器可能已被删除，或链接已过期。请回到
        <router-link to="/mcp" class="text-[color:var(--accent)] hover:underline">MCP 服务器列表</router-link>
        重新进入，或到
        <router-link to="/capabilities?cat=MCP" class="text-[color:var(--accent)] hover:underline">能力中心 · MCP 分类</router-link>
        查看已接入的服务器。
      </p>
    </SectionCard>

    <!-- 根工具级设置 -->
    <SectionCard v-if="server" title="根工具设置" hint="模型实际看到的是一个叫 mcp.<服务器 id> 的入口工具，这里改它的显示名、开放开关和风险等级">
      <p class="text-xs text-[color:var(--ink-3)] mb-3">
        所有子项工具都通过这个入口调用。默认<strong>不开放给模型</strong>；需要先在下面打开「根工具启用」，模型才会看到它。
        风险等级只用于展示和审批判断，不会改变实际权限。
      </p>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToggleField v-model="serverEnabled" label="启用服务器（bot 接入开关）" hint="关闭后 bot 不再连接，本页也无法发起授权；修改后点下方「保存」生效" />
        <FormField label="入口工具显示名" hint="能力目录与面板里展示的名字；留空用默认名">
          <input v-model="rootName" class="input-field" :placeholder="`${serverId} MCP`" />
        </FormField>
        <FormField label="风险等级" hint="留空 = 按中风险（medium）处理">
          <select v-model="rootRiskLevel" class="input-field">
            <option value="">（默认：中风险）</option>
            <option value="low">低风险</option>
            <option value="medium">中风险</option>
            <option value="high">高风险</option>
            <option value="critical">极高风险</option>
          </select>
        </FormField>
        <ToggleField v-model="rootEnabled" label="入口工具启用（开放给模型调用）" />
        <ToggleField v-model="rootApproval" label="每次调用都需要审批" />
        <FormField label="模型可见方式" :hint="exposure ? `当前显式设置为「${exposure === 'searchable' ? '按需检索' : exposure === 'core' ? '核心常驻' : exposure === 'domain' ? '领域常驻' : '完全隐藏'}」` : '未配置 → 默认「按需检索」，需要开启工具检索才可见'">
          <select :value="exposure ?? ''" class="input-field" @change="configStore.config.toolRegistry.exposure[`mcp.${serverId}`] = ($event.target as HTMLSelectElement).value || undefined">
            <option value="">（默认：按需检索）</option>
            <option value="core">核心常驻（每次对话都带上）</option>
            <option value="domain">领域常驻（相关话题时带上）</option>
            <option value="searchable">按需检索（模型搜索后使用）</option>
            <option value="hidden">完全隐藏（模型不可见）</option>
          </select>
        </FormField>
        <FormField v-if="server.transport === 'stdio'" label="启动命令" hint="本地 MCP 进程的启动命令；改动后需要点「重连」才生效">
          <input v-model="server.command" class="input-field font-mono" placeholder="node" />
        </FormField>
        <FormField v-else label="连接地址" hint="对方 MCP 服务的地址；改动后需要点「重连」才生效">
          <input v-model="server.url" class="input-field font-mono" placeholder="https://api.suno.com/mcp" />
        </FormField>
      </div>
      <p class="mt-2 text-[11px] text-[color:var(--ink-3)]">
        连接方式：<span class="font-mono">{{ server.transport === 'http' ? 'HTTP（远程服务）' : server.transport === 'stdio' ? 'stdio（本机子进程）' : server.transport }}</span>
        <template v-if="server.auth === 'oauth'"> · 鉴权：OAuth 账号授权（建议，凭据不写进配置）</template>
        <template v-else> · 鉴权：静态令牌或无需鉴权</template>
      </p>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <button class="btn !px-4" :disabled="configStore.saving || !configStore.dirty" @click="save">{{ configStore.saving ? '保存中…' : '保存（即时生效）' }}</button>
        <span v-if="configStore.dirty" class="text-xs text-amber-600">有未保存改动</span>
        <span v-else class="text-xs text-[color:var(--ink-3)]">{{ configStore.saveStatus }}</span>
      </div>
    </SectionCard>

    <!-- 流程编排 -->
    <FlowEditor v-if="server" :capability-id="`mcp.${serverId}`" />

    <!-- 参数默认值·根级 -->
    <SectionCard v-if="server" title="参数默认值（根级 · 作用于全部子项）" hint="给工具参数预设默认值，避免每次调用都靠模型自己想；这里配的会作用于所有子项">
      <p class="text-xs text-[color:var(--ink-3)] mb-3">
        「非锁定」= 只有模型没传这个参数时才填入默认值（模型可以显式覆盖）；「锁定」= 不管模型传什么，都以这里的值为准。
        典型用法：账号只支持某个模型时，给 <code class="font-mono">model</code> 配一个默认值，先不锁定，确认稳定后再锁。
      </p>
      <ParamDefaultsEditor :model-value="rootParamDefaults" :key-suggestions="paramKeySuggestions" @update:model-value="setRootParamDefaults" />
    </SectionCard>

    <!-- 子项工具 -->
    <SectionCard v-if="server" title="子项工具" :hint="`对方服务器提供的具体工具（当前已进树 ${serverChildren.length} 个）；这里控制它们是否启用、显示名与参数默认值`">
      <p class="text-xs text-[color:var(--ink-3)] mb-3">
        这一块是「这个服务器到底有哪些工具、各自能干什么」。工具清单由对方服务器返回，必须先连接成功才能拿到。
        「启用」决定模型能否单独调用该工具；「进树」由后端配置里的白名单决定（未配置 = 全部进树）。
      </p>
      <div v-if="!serverChildren.length" class="rounded-lg bg-[color:var(--surface-2)] p-4">
        <div class="text-sm font-semibold mb-1">还没有拿到工具清单</div>
        <p class="text-xs text-[color:var(--ink-3)]">
          子项清单要在连接成功后由对方服务器返回。请按顺序：① 填好连接地址并保存 → ② 点上方「连接账号」完成授权 → ③ 等待状态变成「已连接」。
          未连接时也可以先预设白名单与显示名，连接后会自动套用。
        </p>
      </div>
      <div v-else class="space-y-2">
        <div v-for="child in childModels" :key="child.name" class="field-box">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <span class="font-mono text-sm break-all">{{ child.name }}</span>
            <input v-model="child.nameModel.value" class="input-field !w-40 !py-1 text-sm" placeholder="显示名（可选）" />
            <span class="tag">{{ effectLabel(child.effect) }}</span>
            <span class="tag">{{ riskLabel(child.riskLevel) }}</span>
            <span class="text-xs text-[color:var(--ink-3)] truncate flex-1">{{ child.summary || '对方未提供说明' }}</span>
            <button type="button" class="btn-outline !px-2 !py-0.5 !text-xs"
              :class="Object.keys(childParamDefaultsOf(child.name)).length ? '!text-amber-600 !border-amber-400/60' : ''"
              @click="expandedChildDefaults = expandedChildDefaults === child.name ? '' : child.name">
              参数默认{{ Object.keys(childParamDefaultsOf(child.name)).length ? `：${childDefaultsSummary(child.name)}` : '' }}
            </button>
            <ToggleField v-model="child.enabledModel.value" label="启用" />
          </div>
          <div v-if="expandedChildDefaults === child.name" class="mt-2 pt-2 border-t border-[color:var(--hairline-2)]">
            <ParamDefaultsEditor :model-value="childParamDefaultsOf(child.name)" :key-suggestions="paramKeySuggestions"
              empty-text="未配置——该子项继承根级默认值，其余参数完全按模型传参"
              @update:model-value="setChildParamDefaults(child.name, $event)" />
          </div>
        </div>
      </div>
      <div class="mt-3 text-xs text-[color:var(--ink-3)]">
        子项级配置只影响三件事：是否启用、显示名、展示用的风险等级（不参与真正的权限判断）。
        审批与超时是<strong>整台服务器统一</strong>的，需要在根工具上配置，子项里配了也不会生效。
      </div>
    </SectionCard>

    <!-- 调用与诊断 -->
    <SectionCard title="调用与诊断" hint="模型怎么用这些工具，以及出问题时从哪里看">
      <ul class="text-xs text-[color:var(--ink-3)] space-y-1 list-disc pl-4">
        <li>模型调用的是入口工具 <code class="font-mono">mcp.{{ serverId }}</code>，参数形如 <code class="font-mono">{ action, params }</code>；<code class="font-mono">action=list_actions</code> 会返回可用的子项清单。</li>
        <li>预算按入口算：几十个工具只占 1 个工具位，具体子项通过「工具检索」按需发现。</li>
        <li>隐私：提示词会经这台服务器出境（{{ isOAuth ? 'OAuth 账号授权' : '静态令牌' }}）；生成类结果留在对方平台，以链接形式返回。</li>
        <li>诊断：bot 日志里搜 <code class="font-mono">mcp_*</code> 前缀；状态快照每 30 秒巡检一次，页面停留时每 10 秒自动刷新。</li>
        <li>如果重连后仍失败，先看上方红色错误提示的「下一步」建议；需要原始错误码时展开「查看原始错误」。</li>
      </ul>
    </SectionCard>

    <!-- 轻量 toast：操作完成/失败都在右下角给出明确结果 -->
    <transition name="fade">
      <div v-if="toast" class="fixed bottom-4 right-4 z-50 max-w-[min(92vw,26rem)] rounded-lg px-4 py-3 text-xs shadow-lg"
        :class="toast.kind === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'">
        <div class="flex items-start gap-2">
          <span class="font-semibold">{{ toast.kind === 'success' ? '成功' : '失败' }}</span>
          <span class="flex-1 break-words">{{ toast.message }}</span>
          <button class="opacity-80 hover:opacity-100" @click="toast = null">✕</button>
        </div>
      </div>
    </transition>
  </div>
</template>
