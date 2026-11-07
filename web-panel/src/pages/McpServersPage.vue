<script setup lang="ts">
/**
 * P4-MCP：MCP 服务器列表页（/mcp）——新增/删除/连接状态总入口。
 * 修正「鸡生蛋」：此前专属配置页 /mcp/<serverId> 必须先有 config 条目才能打开，界面上没有新增入口。
 * - 列表：显示名（capabilityOverrides['mcp.<id>'].name）、传输、地址、三态徽章
 *   （已停用 / 未连接·待授权 / 已连接——已连接但根能力关闭时明确标注，默认 deny 语义可见）、
 *   子项数、进入配置、删除。
 * - 新增表单：字段对齐 orchestration.mcpServers schema（id 唯一且创建后不可改——id 即能力标识
 *   mcp.<id>，改名等于换能力 id；transport stdio/http；url 或 command/args；auth none/static/oauth；
 *   token 仅 static；proxyUrl 本地调试可选项默认直连；reconnect）。保存走 config store 现有通道
 *   （revision 锁与打码校验不绕过）。
 * - 删除：二次确认 + 移除条目 + 清孤儿覆盖（mcp.<id> 与 mcp.<id>.*）+ disconnect 端点清凭据并
 *   触发 bot 即时热重载。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';

const configStore = useConfigStore();
const statusError = ref('');
const actionMessage = ref('');
const actionError = ref('');
const saving = ref(false);
const statusMap = ref<Record<string, any>>({});
const childCountMap = ref<Record<string, number>>({});

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
  if (!status) return { label: '未连接', ok: false };
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

/* ── 新增表单 ── */
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
    formError.value = `id「${id}」已存在——id 即能力标识 mcp.${id}，创建后不可修改，请删除后重建`;
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
    actionMessage.value = `已添加 ${id}（bot 即时热重载；OAuth 服务器请进入配置页完成账号授权）`;
    form.id = '';
    form.name = '';
    form.url = '';
    form.command = '';
    form.args = '';
    form.token = '';
    form.proxyUrl = '';
    window.setTimeout(refreshStatus, 2000);
  } finally {
    saving.value = false;
  }
}

/* ── 删除：确认 + 移除条目 + 清孤儿覆盖 + 清凭据（disconnect 端点顺带 trigger 热重载）── */
async function removeServer(id: string) {
  actionMessage.value = '';
  actionError.value = '';
  const confirmed = window.confirm(`删除 MCP 服务器「${displayName(id)}」？\n\n将同时清除：配置条目、能力覆盖（mcp.${id} 与 mcp.${id}.*）与已保存的授权凭据。\n此操作不可撤销。`);
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
});
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-4">
    <SectionCard title="MCP 服务器" hint="外部 MCP 能力的接入入口——一个服务器 = 一个树形根工具（预算按 1 个工具计，默认 deny）">
      <div v-if="!servers.length" class="empty-state !py-6">
        <div class="empty-title">还没有接入任何 MCP 服务器</div>
        <div class="empty-sub">在下方「新增服务器」填一条即可（例如 Suno 官方：HTTP + OAuth）；接入后能力中心会显示对应卡片，模型经能力目录可检索其子项</div>
      </div>
      <div v-else class="space-y-2">
        <div v-for="server in servers" :key="server.id" class="field-box">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <span class="font-semibold text-sm">{{ displayName(server.id) }}</span>
            <span class="font-mono text-[11px] text-[color:var(--ink-3)]">mcp.{{ server.id }}</span>
            <span class="tag">{{ server.transport }}</span>
            <span class="tag" :class="stateOf(server.id).ok ? '!bg-green-500/15 !text-green-600' : stateOf(server.id).label === '待授权' ? '!bg-amber-500/15 !text-amber-600' : ''">{{ stateOf(server.id).label }}</span>
            <span v-if="stateOf(server.id).ok && !rootEnabled(server.id)" class="tag !bg-amber-500/15 !text-amber-600" title="根能力默认 deny——进入配置页开启后模型才可调用">根能力关闭</span>
            <span class="text-xs text-[color:var(--ink-3)] truncate flex-1 font-mono">{{ server.url || server.command }}</span>
            <span class="text-xs text-[color:var(--ink-3)] flex-none">{{ childCountMap[server.id] || 0 }} 子项</span>
            <div class="flex gap-2 flex-none">
              <router-link class="btn-outline !px-2" :to="`/mcp/${encodeURIComponent(server.id)}`">配置</router-link>
              <button class="btn-outline !px-2 !text-red-500" :disabled="saving" @click="removeServer(server.id)">删除</button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="statusError" class="mt-2 text-xs text-amber-600">{{ statusError }}</div>
      <div v-if="actionMessage" class="mt-2 text-xs text-green-600 break-all">{{ actionMessage }}</div>
      <div v-if="actionError" class="mt-2 text-xs text-red-500 break-all">{{ actionError }}</div>
    </SectionCard>

    <SectionCard title="新增服务器" hint="保存即写配置并热重载；OAuth 服务器添加后进入配置页完成账号授权">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="服务器 id" hint="能力标识 mcp.<id> 的组成部分——创建后不可修改（改名等于换能力 id）">
          <input v-model="form.id" class="input-field font-mono" placeholder="suno-official" />
        </FormField>
        <FormField label="显示名（可选）" hint="能力中心与目录展示名，可在配置页随时改">
          <input v-model="form.name" class="input-field" placeholder="Suno 官方" />
        </FormField>
        <FormField label="传输类型">
          <select v-model="form.transport" class="input-field">
            <option value="http">http（streamable HTTP，推荐）</option>
            <option value="stdio">stdio（本地子进程）</option>
          </select>
        </FormField>
        <FormField v-if="form.transport === 'http'" label="端点地址">
          <input v-model="form.url" class="input-field font-mono" placeholder="https://api.suno.com/mcp" />
        </FormField>
        <FormField v-if="form.transport === 'stdio'" label="启动命令">
          <input v-model="form.command" class="input-field font-mono" placeholder="node" />
        </FormField>
        <FormField v-if="form.transport === 'stdio'" label="参数（空格分隔）" hint="如 server.mjs --port 3987">
          <input v-model="form.args" class="input-field font-mono" placeholder="server.mjs" />
        </FormField>
        <FormField label="鉴权方式">
          <select v-model="form.auth" class="input-field">
            <option value="oauth">oauth（浏览器账号授权，如 Suno 官方）</option>
            <option value="static">static（静态 token）</option>
            <option value="none">none（免鉴权）</option>
          </select>
        </FormField>
        <FormField v-if="form.auth === 'static'" label="Bearer Token">
          <input v-model="form.token" class="input-field font-mono" type="password" placeholder="静态访问令牌" />
        </FormField>
        <FormField label="代理（可选·本地调试）" hint="默认不填即直连；生产部署不需要配置">
          <input v-model="form.proxyUrl" class="input-field font-mono" placeholder="http://127.0.0.1:7890" />
        </FormField>
        <FormField label="崩溃重启上限（stdio）">
          <input v-model.number="form.maxAttempts" class="input-field" type="number" min="1" />
        </FormField>
        <FormField label="重启间隔 ms（stdio）">
          <input v-model.number="form.delayMs" class="input-field" type="number" min="0" />
        </FormField>
      </div>
      <div v-if="formError" class="mt-3 text-xs text-red-500">{{ formError }}</div>
      <div class="mt-3 flex items-center gap-3">
        <button class="btn !px-4" :disabled="saving || configStore.saving" @click="addServer">{{ saving || configStore.saving ? '保存中…' : '添加并热重载' }}</button>
        <span class="text-xs text-[color:var(--ink-3)]">保存走配置版本锁通道；已存在的 id 会被拒绝</span>
      </div>
    </SectionCard>
  </div>
</template>
