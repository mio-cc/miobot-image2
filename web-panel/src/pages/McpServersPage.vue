<script setup lang="ts">
/**
 * P4-MCP 重做：MCP 服务器列表页（/mcp）——能力中心「MCP」分类的管理页（新增/删除/状态总览）。
 * 面包屑：能力中心 › MCP（AppShell）；移动端页顶「‹ 返回能力中心」→ /capabilities?cat=MCP。
 * - 列表：显示名（capabilityOverrides['mcp.<id>'].name）、传输、地址、三态徽章
 *   （已停用 / 未连接·待授权 / 已连接——已连接但根能力关闭时明确标注，默认 deny 语义可见）、
 *   子项数、进入配置、删除。
 * - 新增（默认路径）：预置服务模板——地址/传输/鉴权全部预填（Suno 官方值取方案 §5.4 Phase 0 实测：
 *   https://api.suno.com/mcp · streamable HTTP · OAuth，AS/DCR/PKCE 由客户端发现链自动完成），
 *   用户只选模板、给显示名；id 由模板自动生成（如 suno-official），不暴露 mcp.<id> 内部标识。
 *   添加成功即跳转 /mcp/<id> 引导账号授权（「然后去授权」闭环）。
 * - 新增（高级选项，默认收起）：自定义服务器——手填 id/传输/地址/鉴权的原表单原样保留。
 * - 删除：二次确认 + 移除条目 + 清孤儿覆盖（mcp.<id> 与 mcp.<id>.*）+ disconnect 端点清凭据并
 *   触发 bot 即时热重载。
 */
import { computed, onMounted, reactive, ref } from 'vue';
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

/* ── 新增（默认路径）：预置服务模板 ── */
/** 模板预填值来源：方案 §5.4 Phase 0 实测（2026-11-06，经代理完成协议探测）——不凭记忆编造。
 *  OAuth 发现链（RFC 9728 资源元数据 → RFC 8414 AS 元数据 → RFC 7591 DCR → PKCE S256）
 *  由 bot 客户端按端点自动完成，模板只需端点/传输/鉴权三要素。 */
const TEMPLATES = [
  {
    id: 'suno-official',
    name: 'Suno 官方',
    defaultName: 'Suno 官方',
    description: '音乐生成/续写/人声等官方工具（约 32 个，授权后以实际清单为准）· 浏览器账号授权，凭据存独立 secret 文件 · 默认 model=v6-mini（账号当前仅可用此模型，可在配置页「参数默认值」按账号可用模型调整）',
    transport: 'http',
    url: 'https://api.suno.com/mcp',
    auth: 'oauth',
    /** 参数默认值（2026-11-07 用户拍板）：账号目前只能使用 v6-mini——仅作默认（不锁死），模型可显式覆盖。 */
    paramDefaults: { model: { value: 'v6-mini' } },
    /** 流程编排（2026-11-07 拍板）：模板预置默认链——创作规范（承载于根工具描述的歌词结构规范注入）→ 生成 → 查询确认。 */
    flow: {
      steps: [
        { capability: 'mcp.suno-official', hint: '按工具说明中的歌词结构规范（[Intro]/[Verse]/[Chorus] 等）创作歌词并提交生成，歌名必须原创' },
        { capability: 'audio.music.history', hint: '查询歌曲历史确认结果', when: '生成成功且用户想查结果' },
      ],
    },
  },
];
const selectedTemplateId = ref(TEMPLATES[0].id);
const selectedTemplate = computed(() => TEMPLATES.find((item) => item.id === selectedTemplateId.value) || TEMPLATES[0]);
const templateName = ref('');
const templateError = ref('');

function templateExists(id: string): boolean {
  return servers.value.some((item) => String(item.id) === id);
}

async function addFromTemplate() {
  templateError.value = '';
  actionMessage.value = '';
  actionError.value = '';
  const template = selectedTemplate.value;
  if (templateExists(template.id)) {
    templateError.value = `「${template.name}」已接入——直接进入配置页管理即可`;
    return;
  }
  saving.value = true;
  try {
    const orch = orchestration.value;
    orch.mcpServers = orch.mcpServers || [];
    orch.mcpServers.push({
      id: template.id,
      enabled: true,
      transport: template.transport,
      url: template.url,
      ...(template.auth ? { auth: template.auth } : {}),
      ...(template.paramDefaults ? { paramDefaults: structuredClone(template.paramDefaults) } : {}),
    });
    orch.capabilityOverrides ||= {};
    orch.capabilityOverrides[`mcp.${template.id}`] = {
      ...(orch.capabilityOverrides[`mcp.${template.id}`] || {}),
      name: templateName.value.trim() || template.defaultName,
    };
    // 流程编排：模板预置默认链（用户已配置过则不覆盖）。
    if (template.flow) {
      orch.capabilityFlows ||= {};
      orch.capabilityFlows[`mcp.${template.id}`] ??= template.flow;
    }
    const result = await configStore.save();
    if (!result.ok) {
      actionError.value = configStore.saveStatus || '保存失败';
      return;
    }
    actionMessage.value = `已添加 ${template.name}（bot 即时热重载）——进入配置页完成账号授权`;
    templateName.value = '';
    window.setTimeout(refreshStatus, 2000);
    // 添加即引导：「然后去授权」闭环——配置页就是 OAuth 连接账号的落点。
    await router.push(`/mcp/${encodeURIComponent(template.id)}`);
  } finally {
    saving.value = false;
  }
}

/* ── 新增（高级选项，默认收起）：自定义服务器——手填 id/地址/传输/鉴权 ── */
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
    <!-- 移动端返回（<640px 面包屑隐藏）：确定性层级返回——上级是能力中心 MCP 分类视图 -->
    <div>
      <div class="sm:hidden -mb-1 flex items-center gap-2">
        <router-link to="/capabilities?cat=MCP" class="btn-outline !px-2.5 !py-1 !text-xs">‹ 返回能力中心</router-link>
      </div>
      <h1 class="page-title mb-0.5 mt-2 sm:mt-0">MCP 服务器</h1>
      <p class="text-[color:var(--ink-3)] text-xs">外部 MCP 能力接入——能力中心「MCP」分类的卡片来自这里 · 一个服务器 = 一个树形根工具（预算按 1 个工具计，默认 deny）</p>
    </div>

    <SectionCard title="服务器列表" hint="接入状态总览；点击「配置」进入该服务器的专属配置页">
      <!-- 实测障碍 #2（2026-11-07）：检索关闭 = MCP 对模型完全不可见（loadout/目录双缺席）——最后一公里引导。 -->
      <div v-if="servers.length && toolSearchDisabled" class="mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-400/40 flex flex-wrap items-center gap-3">
        <span class="text-xs text-amber-600">工具检索（toolRegistry.toolSearchEnabled）当前关闭——MCP 根能力默认 searchable，关闭时模型既看不到工具也搜不到能力目录，接入后无法使用</span>
        <button class="btn !px-3 !py-1 !text-xs ml-auto" :disabled="saving || configStore.saving" @click="enableToolSearch">开启工具检索</button>
      </div>
      <div v-if="!servers.length" class="empty-state !py-6">
        <div class="empty-title">还没有接入任何 MCP 服务器</div>
        <div class="empty-sub">在下方选一个预置模板即可接入（如 Suno 官方）；接入后能力中心「MCP」分类会出现对应卡片，模型经能力目录可检索其子项</div>
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

    <SectionCard title="新增 MCP 服务器" hint="选一个预置服务，起个名字就能用——地址/传输/鉴权已预填，添加后去授权">
      <!-- 模板选择卡（默认路径）：id 自动生成，用户不面对 mcp.<id> 内部标识 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button v-for="t in TEMPLATES" :key="t.id" type="button" class="text-left rounded-lg border p-3 transition-colors"
          :class="selectedTemplateId === t.id && !templateExists(t.id)
            ? 'border-[color:var(--accent-line)] bg-[color:var(--surface-2)]'
            : 'border-[color:var(--hairline-2)] hover:border-[color:var(--accent-line)]'"
          :disabled="templateExists(t.id)"
          @click="selectedTemplateId = t.id">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-sm">{{ t.name }}</span>
            <span class="tag">{{ t.transport }}</span>
            <span class="tag">{{ t.auth }}</span>
            <span v-if="templateExists(t.id)" class="tag !bg-green-500/15 !text-green-600">已接入</span>
          </div>
          <div class="text-xs text-[color:var(--ink-3)] mt-1.5">{{ t.description }}</div>
          <div class="text-[10.5px] font-mono text-[color:var(--ink-3)] mt-1.5 truncate" :title="t.url">{{ t.url }}</div>
          <div v-if="templateExists(t.id)" class="mt-2 text-xs">
            <router-link :to="`/mcp/${encodeURIComponent(t.id)}`" class="text-[color:var(--accent)] hover:underline" @click.stop>已接入过 → 进入配置页</router-link>
          </div>
        </button>
      </div>
      <div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="显示名（可选）" hint="能力中心与模型目录的展示名；不填用模板默认名，配置页随时可改">
          <input v-model="templateName" class="input-field" :placeholder="selectedTemplate.defaultName" />
        </FormField>
      </div>
      <div v-if="templateError" class="mt-3 text-xs text-red-500">{{ templateError }}</div>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <button class="btn !px-4" :disabled="saving || configStore.saving || templateExists(selectedTemplate.id)" @click="addFromTemplate">
          {{ saving || configStore.saving ? '保存中…' : `添加「${selectedTemplate.name}」并去授权` }}
        </button>
        <span class="text-xs text-[color:var(--ink-3)]">添加后进入配置页点「连接账号」完成浏览器 OAuth 授权</span>
      </div>

      <!-- 高级选项：自定义服务器（手填地址）——默认收起，默认路径永远是选模板 -->
      <div class="mt-5 pt-4 border-t border-[color:var(--hairline-2)]">
        <button type="button" class="btn-outline !px-3 !py-1 !text-xs" @click="showCustom = !showCustom">
          {{ showCustom ? '收起自定义表单' : '高级：自定义服务器（手填地址）' }}
        </button>
        <p v-if="!showCustom" class="mt-2 text-xs text-[color:var(--ink-3)]">接预置模板未收录的 MCP 服务、本地 stdio 子进程或静态 token 服务时展开填写。</p>

        <div v-if="showCustom" class="mt-4">
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
        </div>
      </div>
    </SectionCard>
  </div>
</template>
