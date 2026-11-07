<script setup lang="ts">
/**
 * P3-MCP（方案 §4.7 / D27）：单个 MCP 服务器的专属配置页。
 * 四区块：连接与鉴权状态 / 根工具级设置 / 子项列表（树形、经 capabilityOverrides 覆盖） / 说明与诊断。
 * - 子项开关与改名统一写 orchestration.capabilityOverrides['mcp.<server>.<tool>']（D22，不另起存储）；
 * - 根级设置写 capabilityOverrides['mcp.<server>']；暴露级走 toolRegistry.exposure（提示 + 本页可改）；
 * - OAuth 连接/断开/重连走 /api/mcp/* 端点；保存后 bot 经 config.json watch 即时热重载。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import FlowEditor from '../components/FlowEditor.vue';

const route = useRoute();
const configStore = useConfigStore();
const serverId = computed(() => String(route.params.serverId || ''));

const statusRefreshing = ref(false);
const statusError = ref('');
const actionMessage = ref('');
const actionError = ref('');
const serverStatus = ref<any>(null);
const serverChildren = ref<any[]>([]);

const orchestration = computed(() => configStore.config?.orchestration as any);
const server = computed(() => (orchestration.value?.mcpServers || []).find((item: any) => String(item.id) === serverId.value));

/** capabilityOverrides 的根/子项覆盖（D22：与能力中心同一套字段）。
 * 读侧一律走 overrideValue（optional chaining）——渲染期不物化空 override、不产生脏标记；
 * ensureOverride 仅在写侧（用户实际操作）惰性创建键。 */
function ensureOverride(key: string): any {
    (orchestration.value as any).capabilityOverrides ||= {};
    const all = (orchestration.value as any).capabilityOverrides;
    all[key] ||= {};
    return all[key];
}
function overrideValue(key: string, field: string): any {
    return (orchestration.value as any).capabilityOverrides?.[key]?.[field];
}

/** 开关初值反映「有效状态」而非「覆盖原始值」：未配置时读 bot 侧默认（根=deny、子项=进树即启用），
 *  写入才物化 override——避免一进页面就物化脏改（TR.5「默认开启不物化」同款原则）。走查实测发现。 */
const rootEnabled = computed({
    get: () => (orchestration.value as any).capabilityOverrides?.[`mcp.${serverId.value}`]?.enabled ?? false,
    set: (value: boolean) => { ensureOverride(`mcp.${serverId.value}`).enabled = value; },
});
const rootApproval = computed({
    get: () => (orchestration.value as any).capabilityOverrides?.[`mcp.${serverId.value}`]?.approvalRequired === true,
    set: (value: boolean) => { ensureOverride(`mcp.${serverId.value}`).approvalRequired = value; },
});
/** 根显示名：读侧不物化（未配置显示空串、placeholder 给默认名），用户输入才写 override。 */
const rootName = computed({
    get: (): string => overrideValue(`mcp.${serverId.value}`, 'name') ?? '',
    set: (value: string) => { ensureOverride(`mcp.${serverId.value}`).name = String(value ?? ''); },
});
/** 根风险等级：空 = 未覆盖（根 descriptor 默认 medium）；选回空时写 undefined（JSON 序列化丢键 = 清除覆盖）。 */
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

const exposure = computed(() => configStore.config?.toolRegistry?.exposure?.[`mcp.${serverId.value}`] as string | undefined);
const stateBadge = computed(() => {
    const state = serverStatus.value?.state || (server.value?.enabled === false ? 'disabled' : 'unknown');
    const labels: Record<string, string> = {
        connected: '已连接', 'connected-no-tools': '已连接·无子项', connecting: '连接中',
        'needs-auth': '需要授权', disconnected: '已断开', disabled: '已停用', unknown: '未知（bot 未上报）',
    };
    return { state, label: labels[state] || state };
});
const isOAuth = computed(() => server.value?.auth === 'oauth');

async function refreshStatus() {
    statusRefreshing.value = true;
    statusError.value = '';
    try {
        const res = await client.get('/mcp/status');
        const snapshot = res.data?.status || {};
        serverStatus.value = (snapshot.servers || []).find((item: any) => item.serverId === serverId.value) || null;
        serverChildren.value = (snapshot.children || []).filter((item: any) => item.serverId === serverId.value);
    } catch (error: any) {
        statusError.value = errorMessage(error, '状态获取失败');
    } finally {
        statusRefreshing.value = false;
    }
}

async function doAction(kind: 'connect' | 'disconnect' | 'reconnect') {
    actionError.value = '';
    actionMessage.value = '';
    try {
        if (kind === 'connect') {
            const res = await client.post('/mcp/connect', { serverId: serverId.value });
            const url = String(res.data?.authorizationUrl || '');
            if (url) {
                actionMessage.value = '已发起授权：正在打开 Suno 登录页（若未弹出请复制授权链接手动打开）。';
                window.open(url, '_blank', 'noopener');
            }
            return;
        }
        await client.post(`/mcp/${kind}`, { serverId: serverId.value });
        actionMessage.value = kind === 'disconnect' ? '已断开并清除凭据，bot 正在热重载。' : '已触发重连，稍候刷新状态。';
        window.setTimeout(refreshStatus, 1500);
    } catch (error: any) {
        actionError.value = errorMessage(error, '操作失败');
    }
}

async function save() {
    actionError.value = '';
    const result = await configStore.save();
    if (!result.ok) actionError.value = configStore.saveStatus || '保存失败';
    else actionMessage.value = '已保存；bot 已即时热重载（config watch）。';
}

/* 实测障碍 #2（2026-11-07）：MCP 根默认 searchable，toolSearchEnabled=false（生产默认）时
 * 模型完全不可见（loadout/目录双双缺席）——接入后必须引导开启，否则「接进去等于白接」。
 * 取舍：不改全局默认（开默认会让全部 searchable 工具进每次请求的 loadout，token 成本上升），
 * 改为接入路径上的强引导（横幅 + 一键开启）。 */
const toolSearchDisabled = computed(() => (configStore.config as any)?.toolRegistry?.toolSearchEnabled !== true);
async function enableToolSearch() {
    const toolRegistry = (configStore.config as any)?.toolRegistry;
    if (!toolRegistry) return;
    toolRegistry.toolSearchEnabled = true;
    const result = await configStore.save();
    if (result.ok) actionMessage.value = '工具检索已开启（bot 即时热重载）——MCP 根能力现在对模型可见了';
    else actionError.value = configStore.saveStatus || '保存失败';
}

onMounted(async () => {
    if (!configStore.loaded) await configStore.fetchConfig();
    await refreshStatus();
});
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-4">
    <!-- 移动端返回（<640px 面包屑隐藏）：确定性层级返回——上级是 MCP 列表，不用 history.back（深链后不可靠） -->
    <div class="sm:hidden -mb-2 flex items-center gap-2">
      <router-link to="/mcp" class="btn-outline !px-2.5 !py-1 !text-xs">‹ 返回 MCP 列表</router-link>
    </div>

    <!-- 实测障碍 #2：检索关闭 = MCP 对模型完全不可见——最后一公里引导（说明见 script 注释） -->
    <div v-if="toolSearchDisabled" class="card p-3 flex flex-wrap items-center gap-3">
      <span class="text-xs text-amber-600">工具检索（toolRegistry.toolSearchEnabled）当前关闭——MCP 根能力默认 searchable，关闭时模型既看不到工具也搜不到能力目录，接入后无法使用</span>
      <button class="btn !px-3 !py-1 !text-xs ml-auto" :disabled="configStore.saving" @click="enableToolSearch">开启工具检索</button>
    </div>

    <SectionCard :title="`MCP 服务器：${rootName || serverId}`" :hint="`mcp.${serverId} · 树形根工具（预算按 1 个工具计，默认 deny）`">
      <div class="flex flex-wrap items-center gap-3">
        <span class="tag" :class="stateBadge.state === 'connected' ? '!bg-green-500/15 !text-green-600' : stateBadge.state === 'needs-auth' ? '!bg-amber-500/15 !text-amber-600' : ''">{{ stateBadge.label }}</span>
        <span v-if="serverStatus" class="text-xs text-[color:var(--ink-3)]">子项 {{ serverStatus.toolCount }}（启用 {{ serverStatus.enabledToolCount }}）· 快照时间 {{ String(serverStatus.fetchedAt || '').slice(0, 19).replace('T', ' ') }}</span>
        <span v-else class="text-xs text-[color:var(--ink-3)]">等待 bot 上报状态（未配置或 bot 未运行时此处为空）</span>
        <div class="ml-auto flex gap-2">
            <button class="btn-outline !px-3" :disabled="statusRefreshing" @click="refreshStatus">刷新状态</button>
            <button class="btn-outline !px-3" @click="doAction('reconnect')">重连</button>
        </div>
      </div>
      <div v-if="serverStatus?.lastError" class="mt-2 text-xs text-red-500 font-mono break-all">{{ serverStatus.lastError }}</div>
      <div v-if="statusError" class="mt-2 text-xs text-amber-600">{{ statusError }}</div>

      <!-- 区块 1b：OAuth 连接与鉴权 -->
      <div v-if="isOAuth" class="mt-4 p-3 rounded-lg bg-[color:var(--surface-2)]">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm font-semibold">账号授权（OAuth）</span>
          <span class="text-xs text-[color:var(--ink-3)]">浏览器登录 Suno 账号授权；凭据存独立 secret 文件，不进 config.json</span>
          <div class="ml-auto flex gap-2">
            <button class="btn !px-3" @click="doAction('connect')">连接账号</button>
            <button class="btn-outline !px-3" @click="doAction('disconnect')">断开并清除凭据</button>
          </div>
        </div>
      </div>
      <div v-if="route.query.authorized === '1'" class="mt-2 text-xs text-green-600">授权完成，凭据已保存；bot 正在自动连接。</div>
      <div v-if="actionMessage" class="mt-2 text-xs text-green-600 break-all">{{ actionMessage }}</div>
      <div v-if="actionError" class="mt-2 text-xs text-red-500 break-all">{{ actionError }}</div>
    </SectionCard>

    <!-- B6：serverId 不在配置中（已删除/链接过期）→ 空态页，不做 server.* 直绑（防整页 TypeError） -->
    <SectionCard v-if="!server" title="未找到该 MCP 服务器" :hint="`orchestration.mcpServers 中没有 id 为 ${serverId} 的条目`">
      <p class="text-xs text-[color:var(--ink-3)]">
        该服务器可能已被删除，或链接已过期。请回到
        <router-link to="/mcp" class="text-[color:var(--accent)] hover:underline">MCP 服务器列表</router-link>
        重新进入，或到
        <router-link to="/capabilities?cat=MCP" class="text-[color:var(--accent)] hover:underline">能力中心 · MCP 分类</router-link>
        查看已接入的服务器。
      </p>
    </SectionCard>

    <!-- 区块 2：根工具级设置（capabilityOverrides['mcp.<server>']，D22）。v-if=server：下方直绑 server.url，缺配置时不渲染 -->
    <SectionCard v-if="server" title="根工具设置" :hint="`orchestration.capabilityOverrides['mcp.${serverId}'] · 与能力中心同一套覆盖字段`">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="根工具显示名" hint="能力目录与面板展示名；留空用默认">
          <input v-model="rootName" class="input-field" :placeholder="`${serverId} MCP`" />
        </FormField>
        <FormField label="根风险等级" hint="留空 = 根工具默认 medium">
          <select v-model="rootRiskLevel" class="input-field">
            <option value="">（默认 medium）</option>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="critical">critical</option>
          </select>
        </FormField>
        <ToggleField v-model="rootEnabled" label="根工具启用（总开关，默认 deny）" />
        <ToggleField v-model="rootApproval" label="根级调用需审批" />
        <FormField label="根暴露级（toolRegistry.exposure）" :hint="exposure ? `当前显式配置：${exposure}` : '未配置 → 默认 searchable（需开工具检索才可见）'">
          <select :value="exposure ?? ''" class="input-field" @change="configStore.config.toolRegistry.exposure[`mcp.${serverId}`] = ($event.target as HTMLSelectElement).value || undefined">
            <option value="">（默认 searchable）</option>
            <option value="core">core</option><option value="domain">domain</option><option value="searchable">searchable</option><option value="hidden">hidden</option>
          </select>
        </FormField>
        <FormField label="连接地址"><input v-model="server.url" class="input-field font-mono" placeholder="https://api.suno.com/mcp" /></FormField>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <button class="btn !px-4" :disabled="configStore.saving || !configStore.dirty" @click="save">{{ configStore.saving ? '保存中…' : '保存（即时热重载）' }}</button>
        <span v-if="configStore.dirty" class="text-xs text-amber-600">有未保存改动</span>
        <span v-else class="text-xs text-[color:var(--ink-3)]">{{ configStore.saveStatus }}</span>
      </div>
    </SectionCard>

    <!-- 流程编排（2026-11-07）：MCP 根的默认调用组合（与能力详情页共用 FlowEditor，单一真相源）。 -->
    <FlowEditor v-if="server" :capability-id="`mcp.${serverId}`" />

    <!-- 区块 3：子项列表（树形数据 + 覆盖，capabilityOverrides['mcp.<server>.<tool>']）。v-if=server 与区块 2 同款防直绑 -->
    <SectionCard v-if="server" title="子项工具" :hint="`allowlist 管「进不进树」；这里的开关与改名管「树内待遇」（${serverId} 共 ${serverChildren.length} 个已进树子项）`">
      <div v-if="!serverChildren.length" class="text-xs text-[color:var(--ink-3)]">
        暂无子项数据——未授权/未连接时 bot 无法拉取工具清单（Suno 实测：授权前拿不到）。完成授权并连接后此处显示真实子项；
        也可在此直接预填 allowlist 与覆盖（键为 <code class="font-mono">mcp.{{ serverId }}.&lt;工具名&gt;</code>），授权后自动生效。
      </div>
      <div v-else class="space-y-2">
        <div v-for="child in childModels" :key="child.name" class="field-box">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <span class="font-mono text-sm">{{ child.name }}</span>
            <input v-model="child.nameModel.value" class="input-field !w-40 !py-1 text-sm" placeholder="显示名（可选）" />
            <span class="tag">{{ child.effect }}</span>
            <span class="tag">{{ child.riskLevel }}</span>
            <span class="text-xs text-[color:var(--ink-3)] truncate flex-1">{{ child.summary }}</span>
            <ToggleField v-model="child.enabledModel.value" label="启用" />
          </div>
        </div>
      </div>
      <div class="mt-3 text-xs text-[color:var(--ink-3)]">
        子项覆盖只控制：启停（enabled）、显示名（name）与展示风险等级（riskLevel，仅目录与面板展示，不参与权限门禁）。
        审批（approvalRequired）与超时（timeoutMs）在根级 <code class="font-mono">mcp.{{ serverId }}</code> 上生效——树形根统一门禁，子项级配置这些字段不会生效。
      </div>
    </SectionCard>

    <!-- 区块 4：说明与诊断 -->
    <SectionCard title="调用与诊断" hint="树形根工具的调用约定与观察口径">
      <ul class="text-xs text-[color:var(--ink-3)] space-y-1 list-disc pl-4">
        <li>模型调用 <code class="font-mono">mcp.{{ serverId }}</code>，入参 <code class="font-mono">{ action, params }</code>；<code class="font-mono">action=list_actions</code> 返回子项目录。</li>
        <li>预算按根计：24 工具 / 48KB 只占 1 个工具位；子项经能力目录检索（capability.catalog）按需发现。</li>
        <li>隐私：提示词经此服务器出境（{{ isOAuth ? 'OAuth 账号绑定' : '静态 token' }}）；生成类结果留在 Suno 侧，以链接形式交付。</li>
        <li>诊断：bot 日志中 <code class="font-mono">mcp_*</code> 前缀（含 action 上下文）；状态快照每 30s 巡检/事件驱动更新。</li>
      </ul>
    </SectionCard>
  </div>
</template>
