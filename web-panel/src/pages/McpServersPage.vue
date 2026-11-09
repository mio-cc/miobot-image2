<script setup lang="ts">
/**
 * P4-MCP：MCP 服务器模块（/mcp，主导航一级入口）——内置预置项 + 自定义接入 + 状态总览。
 * - 内置项（server.builtin）随配置默认值注入，打开即见、地址/传输/鉴权已预填，点进详情直接授权；
 *   内置项不可删除，只允许停用/断开。
 * - 自定义服务器入口收为右上角次要操作，展开后才显示手填表单。
 * - 列表：显示名、传输、地址、三态徽章、子项数、进入配置。
 * - 删除（仅自定义）：二次确认 + 移除条目 + 清孤儿覆盖 + disconnect 清凭据。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';

const router = useRouter();
const configStore = useConfigStore();
const statusError = ref('');
const actionMessage = ref('');
const actionError = ref('');
const saving = ref(false);
const statusMap = ref<Record<string, any>>({});
const childCountMap = ref<Record<string, number>>({});
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

const orchestration = computed(() => (configStore.config as any)?.orchestration);
const servers = computed(() => (orchestration.value?.mcpServers || []) as any[]);
const overrides = computed<Record<string, any>>(() => orchestration.value?.capabilityOverrides || {});

function displayName(id: string): string {
  return overrides.value[`mcp.${id}`]?.name || `${id} MCP`;
}
function rootEnabled(id: string): boolean {
  return overrides.value[`mcp.${id}`]?.enabled === true;
}
/** 三态：停用（config enabled:false）/ 未连接（无快照·待授权·断开）/ 已连接（根能力开关单独标注）。 */
function stateOf(id: string): { label: string; ok: boolean } {
  const server = servers.value.find((item) => String(item.id) === id);
  if (!server || server.enabled === false) return { label: '已停用', ok: false };
  const status = statusMap.value[id];
  // 内置 OAuth 项首次出现时没有状态快照（从未连接过）：按待授权展示，而不是笼统的「未连接」。
  if (!status) return { label: server.auth === 'oauth' ? '待授权' : '未连接', ok: false };
  if (status.state === 'connected') return { label: '已连接', ok: true };
  if (status.state === 'connected-no-tools') return { label: '已连接·无子项', ok: true };
  if (status.state === 'needs-auth') return { label: '待授权', ok: false };
  if (status.state === 'connecting') return { label: '连接中', ok: false };
  return { label: '未连接', ok: false };
}

async function refreshStatus() {
  statusError.value = '';
  try {
    const res = await client.get('/mcp/status');
    const snapshot = res.data?.status || {};
    const map: Record<string, any> = {};
    const counts: Record<string, number> = {};
    for (const server of snapshot.servers || []) map[server.serverId] = server;
    for (const child of snapshot.children || []) counts[child.serverId] = (counts[child.serverId] || 0) + 1;
    statusMap.value = map;
    childCountMap.value = counts;
  } catch (error: any) {
    statusError.value = errorMessage(error, '状态获取失败');
  }
}

/** 列表页同样自动更新：授权回调、连接状态变化不需要手动刷新。 */
function transportLabel(value: unknown): string {
  const key = String(value || '');
  return key === 'http' ? 'HTTP 远程' : key === 'stdio' ? '本地进程' : key;
}
/* 实测障碍 #2（2026-11-07）：MCP 根默认 searchable，检索关闭时模型完全不可见——列表页强引导。 */
const toolSearchDisabled = computed(() => (configStore.config as any)?.toolRegistry?.toolSearchEnabled !== true);
async function enableToolSearch() {
  const toolRegistry = (configStore.config as any)?.toolRegistry;
  if (!toolRegistry) return;
  toolRegistry.toolSearchEnabled = true;
  const result = await configStore.save();
  if (result.ok) actionMessage.value = '工具检索已开启（bot 即时热重载）——MCP 根能力现在对模型可见了';
  else actionError.value = configStore.saveStatus || '保存失败';
}

/* ── 自定义服务器（次要入口）：右上角展开后手填 id/地址/传输/鉴权 ── */
const showCustom = ref(false);
const form = reactive({
  id: '',
  name: '',
  transport: 'http' as 'http' | 'stdio',
  url: '',
  command: '',
  args: '',
  auth: 'oauth' as 'none' | 'static' | 'oauth',
  token: '',
  proxyUrl: '',
  maxAttempts: 3,
  delayMs: 1000,
});
const formError = ref('');

async function addServer() {
  formError.value = '';
  actionMessage.value = '';
  actionError.value = '';
  const id = form.id.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    formError.value = 'id 需为字母/数字/下划线/连字符（首字符为字母或数字，≤64 字符）';
    return;
  }
  if (servers.value.some((item) => String(item.id) === id)) {
    formError.value = `标识「${id}」已存在——标识用于生成能力名称，创建后不可修改，请换一个`;
    return;
  }
  if (form.transport === 'http' && !/^https?:\/\//i.test(form.url.trim())) {
    formError.value = 'HTTP 传输需要合法的 http(s):// 端点地址（如 https://api.suno.com/mcp）';
    return;
  }
  if (form.transport === 'stdio' && !form.command.trim()) {
    formError.value = 'stdio 传输需要启动命令';
    return;
  }
  saving.value = true;
  try {
    const orch = orchestration.value;
    orch.mcpServers = orch.mcpServers || [];
    orch.mcpServers = orch.mcpServers.filter((item: any) => String(item.id) !== id);
    orch.mcpServers.push({
      id,
      enabled: true,
      transport: form.transport,
      ...(form.transport === 'http'
        ? { url: form.url.trim() }
        : { command: form.command.trim(), ...(form.args.trim() ? { args: form.args.trim().split(/\s+/) } : {}) }),
      ...(form.auth === 'static' || form.auth === 'oauth' ? { auth: form.auth } : {}),
      ...(form.auth === 'static' && form.token.trim() ? { token: form.token.trim() } : {}),
      ...(form.proxyUrl.trim() && /^https?:\/\//i.test(form.proxyUrl.trim()) ? { proxyUrl: form.proxyUrl.trim() } : {}),
      reconnect: {
        maxAttempts: Math.max(1, Math.trunc(Number(form.maxAttempts)) || 3),
        delayMs: Math.max(0, Math.trunc(Number(form.delayMs)) || 1000),
      },
    });
    if (form.name.trim()) {
      orch.capabilityOverrides ||= {};
      orch.capabilityOverrides[`mcp.${id}`] = { ...(orch.capabilityOverrides[`mcp.${id}`] || {}), name: form.name.trim() };
    }
    const result = await configStore.save();
    if (!result.ok) {
      actionError.value = configStore.saveStatus || '保存失败';
      return;
    }
    actionMessage.value = `已添加 ${id}（bot 即时热重载）——进入配置页完成连接或授权`;
    form.id = '';
    form.name = '';
    form.url = '';
    form.command = '';
    form.args = '';
    form.token = '';
    form.proxyUrl = '';
    window.setTimeout(refreshStatus, 2000);
    await router.push(`/mcp/${encodeURIComponent(id)}`);
  } finally {
    saving.value = false;
  }
}

/* ── 删除：确认 + 移除条目 + 清孤儿覆盖 + 清凭据（disconnect 端点顺带 trigger 热重载）── */
async function removeServer(id: string) {
  actionMessage.value = '';
  actionError.value = '';
  const target = servers.value.find((item) => String(item.id) === id);
  if (target?.builtin) {
    actionError.value = '内置服务不可删除，只允许停用或断开连接。';
    return;
  }
  const confirmed = window.confirm(`删除自定义 MCP 服务器「${displayName(id)}」？\n\n将同时清除配置条目、相关设置与已保存的授权凭据。\n此操作不可撤销。`);
  if (!confirmed) return;
  saving.value = true;
  try {
    const orch = orchestration.value;
    orch.mcpServers = (orch.mcpServers || []).filter((item: any) => String(item.id) !== id);
    const prefix = `mcp.${id}`;
    const all = orch.capabilityOverrides || {};
    for (const key of Object.keys(all)) {
      if (key === prefix || key.startsWith(`${prefix}.`)) delete all[key];
    }
    const result = await configStore.save();
    if (!result.ok) {
      actionError.value = configStore.saveStatus || '保存失败';
      return;
    }
    try { await client.post('/mcp/disconnect', { serverId: id }); } catch { /* 凭据清理失败不阻塞（可能本就无凭据） */ }
    actionMessage.value = `已删除 ${id}（覆盖配置与凭据已清理，bot 已热重载）`;
    await refreshStatus();
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (!configStore.loaded) await configStore.fetchConfig();
  await refreshStatus();
  autoRefreshTimer = setInterval(() => { void refreshStatus(); }, 10_000);
});

onUnmounted(() => {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
});
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-4">
    <!-- 主导航一级页面：无需「返回上级」；详情页才有返回 MCP 列表 -->
    <div>
      <h1 class="page-title mb-0.5">MCP 服务器</h1>
      <p class="text-[color:var(--ink-3)] text-xs">外部工具接入模块——内置服务已经预置好，点进详情直接连接账号；需要接入其他服务时用右上角「添加自定义」。</p>
    </div>

    <SectionCard title="服务器列表" hint="已预置与自定义接入的 MCP 服务；点「配置」进入详情完成授权或调整设置">
      <template #actions>
        <button class="btn-outline !px-3" :disabled="saving || configStore.saving" @click="showCustom = !showCustom">
          {{ showCustom ? '收起添加表单' : '添加自定义' }}
        </button>
      </template>
      <!-- 实测障碍 #2（2026-11-07）：检索关闭 = MCP 工具对模型完全不可见——最后一公里引导。 -->
      <div v-if="servers.length && toolSearchDisabled" class="mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-400/40 flex flex-wrap items-center gap-3">
        <span class="text-xs text-amber-600">工具检索当前关闭：MCP 工具按需检索，关闭后模型既看不到也搜不到它们，接入后无法使用。</span>
        <button class="btn !px-3 !py-1 !text-xs ml-auto" :disabled="saving || configStore.saving" @click="enableToolSearch">开启工具检索</button>
      </div>
      <div v-if="!servers.length" class="empty-state !py-6">
        <div class="empty-title">还没有 MCP 服务器</div>
        <div class="empty-sub">正常情况下内置服务会自动出现；如果这里为空，点右上角「添加自定义」接入一个服务。</div>
        <button class="btn !px-4 mt-2" @click="showCustom = true">添加自定义 MCP 服务器</button>
      </div>
      <div v-else class="space-y-2">
        <div v-for="server in servers" :key="server.id" class="field-box">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <span class="font-semibold text-sm">{{ displayName(server.id) }}</span>
            <span class="font-mono text-[11px] text-[color:var(--ink-3)]">mcp.{{ server.id }}</span>
            <span v-if="server.builtin" class="tag !bg-sky-500/15 !text-sky-600">内置</span>
            <span class="tag">{{ transportLabel(server.transport) }}</span>
            <span class="tag" :class="stateOf(server.id).ok ? '!bg-green-500/15 !text-green-600' : stateOf(server.id).label === '待授权' ? '!bg-amber-500/15 !text-amber-600' : ''">{{ stateOf(server.id).label }}</span>
            <span v-if="stateOf(server.id).ok && !rootEnabled(server.id)" class="tag !bg-amber-500/15 !text-amber-600" title="入口工具默认不开放给模型——进入配置页开启后才可调用">未开放给模型</span>
            <span class="text-xs text-[color:var(--ink-3)] truncate flex-1 font-mono">{{ server.url || server.command }}</span>
            <span class="text-xs text-[color:var(--ink-3)] flex-none">{{ childCountMap[server.id] || 0 }} 个工具</span>
            <div class="flex gap-2 flex-none">
              <router-link class="btn-outline !px-2" :to="`/mcp/${encodeURIComponent(server.id)}`">配置</router-link>
              <span v-if="server.builtin" class="text-[11px] text-[color:var(--ink-3)] self-center" title="内置服务不可删除，可在详情页停用或断开">内置不可删除</span>
              <button v-else class="btn-outline !px-2 !text-red-500" :disabled="saving" @click="removeServer(server.id)">删除</button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="statusError" class="mt-2 text-xs text-amber-600">{{ statusError }}</div>
      <div v-if="actionMessage" class="mt-2 text-xs text-green-600 break-all">{{ actionMessage }}</div>
      <div v-if="actionError" class="mt-2 text-xs text-red-500 break-all">{{ actionError }}</div>
    </SectionCard>

    <!-- 自定义服务器（次要入口）：点右上角「添加自定义」才展开；内置项已预置，不再提供重复新增 -->
    <SectionCard v-if="showCustom" title="添加自定义 MCP 服务器" hint="用于接入内置服务未覆盖的远程服务或本地进程">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="服务器标识" hint="用于生成能力名称，创建后不可修改">
          <input v-model="form.id" class="input-field font-mono" placeholder="my-mcp-server" />
        </FormField>
        <FormField label="显示名（可选）" hint="能力中心与模型目录里的展示名，随时可改">
          <input v-model="form.name" class="input-field" placeholder="我的 MCP 服务" />
        </FormField>
        <FormField label="连接方式">
          <select v-model="form.transport" class="input-field">
            <option value="http">远程 HTTP 服务（推荐）</option>
            <option value="stdio">本机子进程（stdio）</option>
          </select>
        </FormField>
        <FormField v-if="form.transport === 'http'" label="服务地址">
          <input v-model="form.url" class="input-field font-mono" placeholder="https://example.com/mcp" />
        </FormField>
        <FormField v-if="form.transport === 'stdio'" label="启动命令">
          <input v-model="form.command" class="input-field font-mono" placeholder="node" />
        </FormField>
        <FormField v-if="form.transport === 'stdio'" label="启动参数（空格分隔）" hint="如 server.mjs --port 3987">
          <input v-model="form.args" class="input-field font-mono" placeholder="server.mjs" />
        </FormField>
        <FormField label="鉴权方式">
          <select v-model="form.auth" class="input-field">
            <option value="oauth">账号授权（浏览器登录）</option>
            <option value="static">静态令牌</option>
            <option value="none">免鉴权</option>
          </select>
        </FormField>
        <FormField v-if="form.auth === 'static'" label="访问令牌">
          <input v-model="form.token" class="input-field font-mono" type="password" placeholder="静态访问令牌" />
        </FormField>
        <FormField label="网络代理（可选）" hint="仅在需要代理才能访问对方服务时填写">
          <input v-model="form.proxyUrl" class="input-field font-mono" placeholder="http://127.0.0.1:7890" />
        </FormField>
        <FormField v-if="form.transport === 'stdio'" label="崩溃重启次数上限">
          <input v-model.number="form.maxAttempts" class="input-field" type="number" min="1" />
        </FormField>
        <FormField v-if="form.transport === 'stdio'" label="重启间隔（毫秒）">
          <input v-model.number="form.delayMs" class="input-field" type="number" min="0" />
        </FormField>
      </div>
      <div v-if="formError" class="mt-3 text-xs text-red-500">{{ formError }}</div>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <button class="btn !px-4" :disabled="saving || configStore.saving" @click="addServer">{{ saving || configStore.saving ? '保存中…' : '添加并进入配置' }}</button>
        <button class="btn-outline !px-4" :disabled="saving || configStore.saving" @click="showCustom = false">取消</button>
        <span class="text-xs text-[color:var(--ink-3)]">添加后保存配置，并自动进入详情页完成连接或授权</span>
      </div>
    </SectionCard>
  </div>
</template>
