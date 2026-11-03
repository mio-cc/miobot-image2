<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import client, { errorMessage } from '../api/client';
import ModelPicker from '../components/ModelPicker.vue';
import FormField from '../components/FormField.vue';
import AppSelect, { type AppSelectOption } from '../components/AppSelect.vue';
import { ROLES, isRoleInherit, getRoleNode as getRoleNodeOf, getRoleModel as getRoleModelOf, setRoleValue as setRoleValueOf, roleUsageHint } from '../shared/roles';

/**
 * R19 模型与节点 · 统一管理（R21-f 视觉精化）。
 * 三层结构：节点池 → Agent 主对话（全站默认）→ 用途分配（继承/显式覆盖）。
 * 继承语义：未显式指定的用途自动跟随主对话（bridge toMainModelSelection）。
 * 视觉：统一 C2 令牌（--surface / --hairline-2 / --sh-1 / --accent），修复旧版失效令牌。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const capabilityStore = useCapabilityStore();

/* ── 视图切换 ── */
const view = ref<'nodes' | 'roles'>('roles');

/* ── 节点池 ── */
const search = ref('');

const nodes = computed(() => config.value?.llm?.apiKeys || []);
const rows = computed(() => {
    const kw = search.value.trim().toLowerCase();
    const all = nodes.value.map((node: any, idx: number) => ({ node, idx }));
    if (!kw) return all;
    return all.filter(({ node }: any) =>
        String(node.name || '').toLowerCase().includes(kw)
        || String(node.baseUrl || '').toLowerCase().includes(kw)
        || (node.models || []).some((m: string) => m.toLowerCase().includes(kw)));
});
const stats = computed(() => ({
    total: nodes.value.length,
    enabled: nodes.value.filter((n: any) => n.enabled !== false).length,
}));

function addNode() {
    const next: any = { name: `节点 ${nodes.value.length + 1}`, baseUrl: '', key: '', enabled: true, models: [], modelsFetchedAt: '', concurrency: 0 };
    nodes.value.push(next);
}
function removeNode(idx: number) {
    if (!window.confirm('删除节点后，引用它的用途会自动落到节点 0（主对话）。确认？')) return;
    nodes.value.splice(idx, 1);
    // 同步修正所有 nodeIndex（与 NodesPage 的 NODE_INDEX_FIELDS 重映射一致）
    const fields: Array<[string, string]> = [
        ['llm', 'activeNodeIndex'], ['llm', 'chatNodeIndex'], ['llm', 'imageNodeIndex'],
        ['llm', 'editNodeIndex'], ['llm', 'interrogateNodeIndex'], ['llm', 'videoNodeIndex'],
        ['canvas', 'imageNodeIndex'], ['canvas', 'editNodeIndex'],
        ['canvas', 'interrogateNodeIndex'], ['canvas', 'interrogateTemplateNodeIndex'],
        ['freeMode', 'nodeIndex'], ['codeRender', 'nodeIndex'], ['comfyuiTransform', 'nodeIndex'],
        ['agent', 'mainNodeIndex'], ['agent', 'fallbackNodeIndex'],
    ];
    const nestedFields: string[][] = [
        ['bot', 'keywordTrigger', 'intentNodeIndex'],
        ['orchestration', 'planner', 'nodeIndex'],
        ['orchestration', 'suno', 'composerNodeIndex'],
        ['orchestration', 'memory', 'embeddingNodeIndex'],
        ['orchestration', 'memory', 'summarizeNodeIndex'],
        ['promptsChat', 'smartNodeIndex'],
        ['bot', 'tts', 'preprocess', 'nodeIndex'],
    ];
    const cfg: any = config.value;
    for (const [section, field] of fields) {
        if (cfg?.[section] && Number.isFinite(Number(cfg[section][field]))) {
            const value = Number(cfg[section][field]);
            cfg[section][field] = value === idx ? 0 : (value > idx ? value - 1 : value);
        }
    }
    for (const path of nestedFields) {
        let parent = cfg;
        for (const key of path.slice(0, -1)) {
            if (!parent || typeof parent !== 'object') { parent = null; break; }
            parent = parent[key];
        }
        const field = path[path.length - 1];
        if (parent && Number.isFinite(Number(parent[field]))) {
            const value = Number(parent[field]);
            parent[field] = value === idx ? 0 : (value > idx ? value - 1 : value);
        }
    }
}
/* 拉取模型列表：P0 修复静默失败——per-node 状态、错误翻译（限流/鉴权/超时/协议错）、
   成功带 diff 摘要；上游 200 但解析不出模型时保留原列表（与 NodesPage 同语义）。 */
const fetchingNode = ref<number | null>(null);
const fetchErrors = ref<Record<number, string>>({});
const fetchSummaries = ref<Record<number, string>>({});

function translateFetchError(error: any): string {
    const raw = errorMessage(error, '获取模型列表失败');
    if (/HTTP 429|tpm|rpm|限流/i.test(raw)) return `${raw}（上游限流，稍等片刻再试）`;
    if (/HTTP 401|HTTP 403|鉴权|密钥/i.test(raw)) return `${raw}（密钥无效或缺失，检查节点 API Key）`;
    if (/timeout|超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(raw)) return `${raw}（网络不通或上游无响应）`;
    if (/HTTP 5\d\d/.test(raw)) return `${raw}（上游服务错误）`;
    return raw;
}

async function fetchModels(idx: number) {
    const node = nodes.value[idx] as any;
    if (!node?.baseUrl) {
        fetchErrors.value = { ...fetchErrors.value, [idx]: `「${node?.name || idx + 1}」还没填 Base URL` };
        return;
    }
    fetchingNode.value = idx;
    const startedAt = Date.now();
    // 后端要明文 key；面板上是打码值，仅在用户刚改过（不含圆点）时才带上（与 NodesPage 同语义）。
    const key = String(node.key || '').includes('••••') ? '' : node.key;
    const keyRef = Number.isInteger((node as any).keyRef) ? (node as any).keyRef : idx;
    try {
        const res = await client.post('/fetch-models', { baseUrl: node.baseUrl, key, keyRef, nodeIndex: keyRef, headers: node.headers || {} });
        const fetched: string[] = res.data?.models || [];
        if (!fetched.length && res.data?.warning) {
            // 上游 200 但解析不出：保留原列表，提示 warning，不当成功。
            fetchErrors.value = { ...fetchErrors.value, [idx]: `「${node.name || idx + 1}」${res.data.warning}` };
            return;
        }
        const previous = node.models || [];
        const added = fetched.filter((m) => !previous.includes(m));
        const removed = previous.filter((m: string) => !fetched.includes(m));
        node.models = fetched;
        node.modelsFetchedAt = new Date().toISOString();
        const parts = [`新增 ${added.length}`, `消失 ${removed.length}`, `未变 ${fetched.length - added.length}`];
        fetchSummaries.value = { ...fetchSummaries.value, [idx]: `拉取成功 · ${parts.join(' · ')} · 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s` };
        fetchErrors.value = { ...fetchErrors.value, [idx]: '' };
        capabilityStore.refresh();
    } catch (error: any) {
        fetchErrors.value = { ...fetchErrors.value, [idx]: `「${node.name || idx + 1}」${translateFetchError(error)}` };
    } finally {
        fetchingNode.value = null;
    }
}

/* ── 用途分配 ── */
/* ROLES 表与反查已抽到 shared/roles.ts（节点模型展开的「当前用于」提示共用同一份）。 */

type RoleDef = (typeof ROLES)[number];

/** 判断某用途当前是否在"继承"态（字段为空/未设置）。 */
function isInherit(role: RoleDef): boolean {
    return isRoleInherit(config.value, role);
}
/** 获取某用途的 nodeIndex / model 值。 */
function getRoleNode(role: RoleDef): number {
    return getRoleNodeOf(config.value, role);
}
function getRoleModel(role: RoleDef): string {
    return getRoleModelOf(config.value, role);
}
function setRoleValue(role: RoleDef, nodeIndex: number, model: string) {
    setRoleValueOf(config.value, role, nodeIndex, model);
}
/** 自定义→继承切换。 */
function makeInherit(role: RoleDef) {
    if (!role.section || !role.modelField) return;
    const cfg: any = config.value;
    const parts = role.section.split('.');
    let obj = cfg;
    for (const part of parts) { if (!obj) return; obj = obj[part]; }
    obj[role.modelField] = '';
}
/** 继承→自定义。 */
function makeCustom(role: RoleDef) {
    if (!role.section || !role.modelField) return;
    const mainNode = Number((config.value as any)?.agent?.mainNodeIndex) || 0;
    const mainModel = String((config.value as any)?.agent?.mainModel || '');
    setRoleValue(role, mainNode, mainModel);
}
/** 角色行点击自定义展开。 */
const editingRole = ref<string | null>(null);

/** 节点模型浏览（问题四）：卡片「+N 查看」打开 AppSelect 浏览模式，复用同一套搜索。 */
function nodeModelOptions(node: any): AppSelectOption[] {
    return (node.models || []).map((m: string) => ({
        value: m,
        label: m,
        badges: capabilityStore.capabilitiesOf(m).slice(0, 3).map(c => capabilityStore.labels[c] || c),
        hint: roleUsageHint(config.value, m),
    }));
}

/* 主对话模型（继承源显示用） */
const mainModel = computed(() => {
    const cfg: any = config.value;
    const nodeIndex = Number(cfg?.agent?.mainNodeIndex ?? cfg?.llm?.chatNodeIndex ?? 0);
    const model = String(cfg?.agent?.mainModel || cfg?.llm?.chatModel || '');
    const nodeName = cfg?.llm?.apiKeys?.[nodeIndex]?.name || `节点 ${nodeIndex}`;
    return { nodeIndex, model, nodeName };
});

/* ── 保存 ── */
const saving = ref(false);
const savedFlash = ref('');
async function saveAll() {
    saving.value = true;
    try {
        await configStore.save();
        savedFlash.value = '已保存 · 下一轮对话热重载';
        window.setTimeout(() => { savedFlash.value = ''; }, 3000);
    } finally { saving.value = false; }
}

onMounted(() => { void capabilityStore.refresh(); });
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">模型与节点</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        节点池 → 主对话（全站默认）→ 用途继承或覆盖 · 改主对话一处，继承用途全站生效
      </p>
    </header>

    <div class="flex items-center gap-2.5 mb-4">
      <div class="segmented">
        <button :class="view === 'roles' ? 'on' : ''" @click="view = 'roles'">用途分配</button>
        <button :class="view === 'nodes' ? 'on' : ''" @click="view = 'nodes'">节点池（{{ stats.total }}）</button>
      </div>
      <span v-if="savedFlash" class="status-good text-xs font-medium">{{ savedFlash }}</span>
      <button class="btn-primary text-xs ml-auto" @click="saveAll" :disabled="saving">
        {{ saving ? '保存中…' : '保存全部' }}
      </button>
    </div>

    <!-- ═══ 用途分配视图 ═══ -->
    <section v-if="view === 'roles'">
      <!-- 继承语义提示 -->
      <div class="bg-[color:var(--accent-soft)] border border-[color:var(--accent-line)] rounded-xl px-4 py-2.5 mb-4 text-xs text-[color:var(--ink-2)] leading-relaxed">
        <strong class="text-[color:var(--ink)]">未显式指定的用途自动跟随主对话</strong>——
        改一处主对话，所有继承用途一起换模型；显式覆盖的用途不受影响。点击虚线框可切换为独立选择。
      </div>

      <!-- 主对话（继承源头 · 首卡强调） -->
      <div class="relative bg-[color:var(--surface)] border-2 border-[color:var(--accent-line)] rounded-[16px] shadow-[var(--sh-1)] overflow-hidden mb-3">
        <div class="flex items-center gap-4 px-5 py-4 flex-wrap">
          <div class="w-10 h-10 rounded-[12px] grid place-items-center flex-none bg-[color:var(--accent)] text-[color:var(--accent-ink)]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.2 0-2.4-.25-3.4-.7L3.5 20.5l1.2-4.4A8.5 8.5 0 1 1 21 11.5z"/>
            </svg>
          </div>
          <div class="min-w-0">
            <div class="text-[15px] font-bold text-[color:var(--ink)] leading-tight">Agent 主对话</div>
            <div class="text-[11px] text-[color:var(--ink-3)]">全站默认 · 所有"跟随"的用途继承它</div>
          </div>
          <div class="ml-auto flex items-center gap-3 flex-wrap">
            <span class="hidden sm:inline text-[11px] text-[color:var(--ink-3)] truncate max-w-[160px]">{{ mainModel.nodeName }}</span>
            <ModelPicker
              :node-index="mainModel.nodeIndex"
              :model="mainModel.model"
              capability="chat"
              @update:node-index="(v: number) => { if (config) { (config as any).agent.mainNodeIndex = v; } }"
              @update:model="(v: string) => { if (config) { (config as any).agent.mainModel = v; } }"
            />
          </div>
        </div>
      </div>

      <!-- 用途行（继承 / 覆盖） -->
      <div class="bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[16px] shadow-[var(--sh-1)] overflow-hidden">
        <div v-for="role in ROLES.filter(r => r.key !== 'main')" :key="role.key"
          class="flex items-center gap-4 px-5 py-3 border-b border-[color:var(--hairline)] last:border-b-0 hover:bg-[color:var(--page)] transition-colors duration-150 flex-wrap">

          <!-- 角色名 + 描述 -->
          <div class="w-[200px] flex-none">
            <div class="text-[13px] font-semibold text-[color:var(--ink)] leading-tight">{{ role.title }}</div>
            <div class="text-[11px] text-[color:var(--ink-3)] mt-0.5 truncate">{{ role.desc }}</div>
          </div>

          <!-- 选择器区域 -->
          <div class="flex-1 min-w-[240px]">
            <!-- 继承态（虚线框 · 点击自定义）：P1 修复双重误导——明确"未选择 → 回落"关系，
                 而不是看起来像自动选了主对话模型（用户刚清空的值瞬间变回一个模型名）。 -->
            <button v-if="isInherit(role) && editingRole !== role.key" type="button"
              class="inline-flex items-center gap-2.5 px-3.5 py-2 border border-dashed border-[color:var(--hairline-3)] rounded-[10px] bg-[color:var(--page)] text-[13px] text-left cursor-pointer transition-colors duration-150 group hover:border-[color:var(--ink-3)] max-w-full"
              :title="`未单独选择，回落使用主对话模型（${mainModel.model || '未设置'}），点击自定义`"
              @click="makeCustom(role); editingRole = role.key">
              <span class="text-[10px] font-bold tracking-wide bg-[color:var(--off-soft)] text-[color:var(--ink-3)] rounded-md px-1.5 py-0.5 flex-none">未选择</span>
              <span class="font-medium text-[color:var(--ink-3)] truncate">回落主对话：{{ mainModel.model || '（未设置）' }}</span>
              <span class="text-[color:var(--accent)] text-[11px] font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">自定义 →</span>
            </button>

            <!-- 覆盖态（选择器） -->
            <div v-else class="flex items-center gap-3 flex-wrap">
              <ModelPicker
                :node-index="getRoleNode(role)"
                :model="getRoleModel(role)"
                :capability="role.capability"
                @update:node-index="(v: number) => setRoleValue(role, v, getRoleModel(role))"
                @update:model="(v: string) => setRoleValue(role, getRoleNode(role), v)"
              />
              <button v-if="role.inheritable" class="text-[11px] text-[color:var(--ink-3)] hover:text-[color:var(--accent)] transition-colors duration-150 whitespace-nowrap" @click="makeInherit(role); editingRole = null;">
                ↩ 恢复跟随
              </button>
            </div>
          </div>
        </div>
      </div>

      <p class="mt-3 text-[11px] text-[color:var(--ink-3)] leading-relaxed">
        旧字段（llm.enhance/template/translation 等 6 处已无消费者的模型位）不在此页显示——由 config-lint "无消费者键不可编辑"规则隐藏。保存后下一轮对话热重载。
      </p>
    </section>

    <!-- ═══ 节点池视图 ═══ -->
    <section v-if="view === 'nodes'">
      <div class="flex flex-wrap items-center gap-2.5 mb-4">
        <input v-model="search" placeholder="搜索节点名、URL 或模型…" class="input-field !w-auto flex-1 min-w-[220px]" />
        <span class="text-xs text-[color:var(--ink-3)]">{{ stats.enabled }} / {{ stats.total }} 启用</span>
        <button class="btn-outline text-xs" @click="addNode">＋ 添加节点</button>
      </div>

      <div v-if="!rows.length" class="empty-state">
        <div class="empty-title">没有匹配的节点</div>
        <div class="empty-sub">换个关键词，或清空搜索查看全部 {{ stats.total }} 个节点</div>
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        <div v-for="{ node, idx } in rows" :key="idx"
          class="group relative bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[14px] p-4 shadow-[var(--sh-1)] transition-all duration-200 hover:-translate-y-[3px] hover:shadow-[var(--sh-2)] hover:border-[color:var(--accent-line)]">

          <!-- 启用状态点（token 语义色） -->
          <span class="absolute top-[18px] right-4 dot" :class="node.enabled !== false ? 'dot-good' : 'dot-idle'"
            :title="node.enabled !== false ? '已启用' : '已停用'"/>

          <!-- 名称 + 类型标签 -->
          <div class="flex items-center gap-2 mb-1 pr-6">
            <span class="text-[14px] font-bold text-[color:var(--ink)] truncate">{{ node.name || `节点 ${idx + 1}` }}</span>
            <span v-if="node.kind === 'comfyui'" class="text-[10px] font-bold rounded-md px-1.5 py-0.5 bg-[color:var(--accent-soft)] text-[color:var(--accent)] flex-none">comfyui</span>
            <span v-else class="text-[10px] font-bold rounded-md px-1.5 py-0.5 bg-[color:var(--off-soft)] text-[color:var(--ink-3)] flex-none">openai</span>
          </div>

          <!-- Base URL -->
          <div class="text-[11px] text-[color:var(--ink-3)] font-mono truncate mb-2.5">{{ node.baseUrl || '（未配置 URL）' }}</div>

          <!-- 模型标签（问题四：+N 可点击，展开浏览该节点全部模型，复用同一套搜索） -->
          <div class="flex flex-wrap gap-1 mb-3 min-h-[22px] content-center">
            <span v-for="m in (node.models || []).slice(0, 4)" :key="m" class="text-[10.5px] bg-[color:var(--off-soft)] text-[color:var(--ink-2)] rounded-md px-1.5 py-0.5 font-mono">{{ m }}</span>
            <AppSelect v-if="(node.models || []).length > 4" browse :options="nodeModelOptions(node)" class="self-center">
              <template #trigger>
                <span class="text-[10.5px] text-[color:var(--ink-2)] bg-[color:var(--off-soft)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--accent)] rounded-md px-1.5 py-0.5 font-medium transition-colors duration-150">
                  +{{ (node.models || []).length - 4 }} 查看
                </span>
              </template>
            </AppSelect>
            <span v-if="!(node.models || []).length" class="text-[10.5px] text-[color:var(--ink-3)] self-center">（点下方"拉取"获取模型列表）</span>
          </div>

          <!-- 拉取反馈：P0 修复静默失败——成功 diff 摘要 / 失败原因 + 重试（宣纸 token） -->
          <div v-if="fetchSummaries[idx]" class="status-good text-[10.5px] bg-[color:var(--off-soft)] border border-[color:var(--hairline-2)] rounded-md px-2 py-1 mb-2 leading-relaxed">{{ fetchSummaries[idx] }}</div>
          <div v-if="fetchErrors[idx]" class="flex items-start gap-2 text-[10.5px] status-crit bg-[color:var(--critical-soft)] border border-[color:var(--hairline-2)] rounded-md px-2 py-1 mb-2 leading-relaxed">
            <span class="min-w-0 flex-1">{{ fetchErrors[idx] }}</span>
            <button class="flex-none underline underline-offset-2 hover:opacity-70 transition-opacity" :disabled="fetchingNode === idx" @click="fetchModels(idx)">重试</button>
          </div>

          <!-- 操作行 -->
          <div class="flex items-center gap-1.5 text-[11px] text-[color:var(--ink-3)] border-t border-[color:var(--hairline)] pt-2.5">
            <span class="mr-auto">
              {{ (node.models || []).length }} 个模型
              <span v-if="node.modelsFetchedAt" class="ml-1" :title="node.modelsFetchedAt">· 上次拉取 {{ new Date(node.modelsFetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
            </span>
            <button class="border border-[color:var(--hairline-3)] rounded-lg px-2.5 py-1 text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] transition-colors duration-150 disabled:opacity-50" :disabled="fetchingNode === idx"
              @click="fetchModels(idx)">{{ fetchingNode === idx ? '拉取中…' : '拉取' }}</button>
            <button class="border border-[color:var(--hairline-3)] rounded-lg px-2.5 py-1 text-[color:var(--ink-2)] hover:border-[color:var(--ink-3)] transition-colors duration-150"
              @click="node.enabled = node.enabled === false ? true : false">{{ node.enabled === false ? '启用' : '停用' }}</button>
            <button class="btn-danger !px-2.5 !py-1 !rounded-lg"
              @click="removeNode(idx)">删除</button>
          </div>
        </div>
      </div>

      <!-- 节点详情编辑（折叠） -->
      <details class="mt-4">
        <summary class="cursor-pointer text-[13px] text-[color:var(--ink-3)] hover:text-[color:var(--ink)] select-none transition-colors">展开编辑节点详情（BaseURL / Key / 并发）</summary>
        <div class="mt-3 space-y-3">
          <div v-for="{ node, idx } in rows" :key="'edit-' + idx"
            class="bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[14px] p-4 shadow-[var(--sh-1)]">
            <div class="text-[13px] font-bold text-[color:var(--ink)] mb-3">{{ node.name || `节点 ${idx + 1}` }}</div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <FormField label="Base URL">
                <input v-model="node.baseUrl" class="input-field font-mono text-xs" placeholder="https://api.example.com/v1" />
              </FormField>
              <FormField label="API Key">
                <input v-model="node.key" type="password" class="input-field font-mono text-xs" placeholder="sk-…" />
              </FormField>
              <FormField label="并发上限" hint="0 = 不限">
                <input v-model.number="node.concurrency" type="number" min="0" class="input-field" />
              </FormField>
            </div>
          </div>
        </div>
      </details>
    </section>
  </div>
</template>
