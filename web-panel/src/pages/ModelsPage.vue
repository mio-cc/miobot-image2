<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import client from '../api/client';
import ModelPicker from '../components/ModelPicker.vue';
import FormField from '../components/FormField.vue';

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
const probing = ref(false);

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
async function fetchModels(idx: number) {
    const node = nodes.value[idx] as any;
    if (!node?.baseUrl) return;
    probing.value = true;
    try {
        const res = await client.post('/fetch-models', { baseUrl: node.baseUrl, key: node.key, keyRef: idx, headers: node.headers || {}, nodeIndex: idx });
        if (res.data?.models) { node.models = res.data.models; node.modelsFetchedAt = new Date().toISOString(); }
    } catch { /* 错误已在 client 层展示 */ } finally { probing.value = false; }
}

/* ── 用途分配 ── */

interface RoleDef {
    key: string;
    title: string;
    desc: string;
    /** config 路径（section + nodeField + modelField）；null=跟随主对话（无独立字段）。 */
    section: string | null;
    nodeField: string | null;
    modelField: string | null;
    /** 该用途推荐的能力过滤 */
    capability?: string;
    /** 是否允许退回继承（主对话不允许） */
    inheritable: boolean;
}

const ROLES: RoleDef[] = [
    { key: 'main', title: 'Agent 主对话', desc: '全站默认 · 所有"跟随"的用途继承它', section: 'agent', nodeField: 'mainNodeIndex', modelField: 'mainModel', capability: 'chat', inheritable: false },
    { key: 'image', title: '图片生成', desc: 'image.generate · ComfyUI 工作流或多模态直生', section: 'llm', nodeField: 'imageNodeIndex', modelField: 'imageModel', capability: 'image.generate', inheritable: true },
    { key: 'edit', title: '图片编辑', desc: 'image.edit · 多模态原生理解', section: 'llm', nodeField: 'editNodeIndex', modelField: 'editModel', capability: 'image.edit', inheritable: true },
    { key: 'interrogate', title: '图片反推', desc: 'image.interrogate', section: 'llm', nodeField: 'interrogateNodeIndex', modelField: 'interrogateModel', capability: 'image.interrogate', inheritable: true },
    { key: 'suno', title: 'Suno 作曲', desc: '歌词与参数规划（Composer）', section: 'orchestration.suno', nodeField: 'composerNodeIndex', modelField: 'composerModel', capability: 'chat', inheritable: true },
    { key: 'video', title: '视频生成', desc: 'video.generate', section: 'llm', nodeField: 'videoNodeIndex', modelField: 'videoModel', capability: 'video.generate', inheritable: true },
    { key: 'codeRender', title: '代码渲染', desc: 'code.render · HTML/SVG/Canvas/Three', section: 'codeRender', nodeField: 'nodeIndex', modelField: 'model', capability: 'chat', inheritable: true },
    { key: 'comfyui', title: 'ComfyUI 参数转化', desc: '自然语言 → workflow JSON', section: 'comfyuiTransform', nodeField: 'nodeIndex', modelField: 'model', capability: 'chat', inheritable: true },
    { key: 'tts', title: 'TTS 前处理', desc: '朗读前改写', section: 'bot.tts.preprocess', nodeField: 'nodeIndex', modelField: 'model', capability: 'chat', inheritable: true },
    { key: 'trigger', title: '触发 / 续话判定', desc: '轻量判定 · 建议选快模型', section: null, nodeField: null, modelField: null, capability: 'chat', inheritable: true },
    { key: 'memory', title: '记忆摘要 / 评分', desc: 'memory.* 二级任务', section: 'orchestration.memory', nodeField: 'embeddingNodeIndex', modelField: 'embeddingModel', capability: 'chat', inheritable: true },
];

/** 判断某用途当前是否在"继承"态（字段为空/未设置）。 */
function isInherit(role: RoleDef): boolean {
    if (!role.inheritable || !role.section) return false;
    const cfg: any = config.value;
    const parts = role.section.split('.');
    let obj = cfg;
    for (const part of parts) { if (!obj) return true; obj = obj[part]; }
    if (!obj || !role.modelField) return true;
    const model = String(obj[role.modelField] || '').trim();
    return !model;
}
/** 获取某用途的 nodeIndex / model 值。 */
function getRoleNode(role: RoleDef): number {
    if (!role.section || !role.nodeField) return 0;
    const cfg: any = config.value;
    const parts = role.section.split('.');
    let obj = cfg;
    for (const part of parts) { if (!obj) return 0; obj = obj[part]; }
    return Number(obj?.[role.nodeField]) || 0;
}
function getRoleModel(role: RoleDef): string {
    if (!role.section || !role.modelField) return '';
    const cfg: any = config.value;
    const parts = role.section.split('.');
    let obj = cfg;
    for (const part of parts) { if (!obj) return ''; obj = obj[part]; }
    return String(obj?.[role.modelField] || '');
}
function setRoleValue(role: RoleDef, nodeIndex: number, model: string) {
    if (!role.section || !role.nodeField || !role.modelField) return;
    const cfg: any = config.value;
    const parts = role.section.split('.');
    let obj = cfg;
    for (const part of parts) {
        if (!obj[part]) obj[part] = {};
        obj = obj[part];
    }
    obj[role.nodeField] = nodeIndex;
    obj[role.modelField] = model;
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
          <div class="w-10 h-10 rounded-[12px] grid place-items-center flex-none bg-[color:var(--accent)] text-white">
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
            <!-- 继承态（虚线框 · 点击自定义） -->
            <div v-if="isInherit(role) && editingRole !== role.key"
              class="inline-flex items-center gap-2.5 px-3.5 py-2 border border-dashed border-[color:var(--hairline-3)] rounded-[10px] bg-[color:var(--page)] text-[13px] cursor-pointer transition-colors duration-150 group hover:border-[color:var(--ink-3)] max-w-full"
              @click="makeCustom(role); editingRole = role.key">
              <span class="text-[10px] font-bold tracking-wide bg-[color:var(--off-soft)] text-[color:var(--ink-3)] rounded-md px-1.5 py-0.5 flex-none">跟随</span>
              <span class="font-medium text-[color:var(--ink-2)] truncate">{{ mainModel.model || '（未设置）' }}</span>
              <span class="text-[color:var(--accent)] text-[11px] font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">自定义 →</span>
            </div>

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

      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        <div v-for="{ node, idx } in rows" :key="idx"
          class="group relative bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[14px] p-4 shadow-[var(--sh-1)] transition-all duration-200 hover:-translate-y-[3px] hover:shadow-[var(--sh-2)] hover:border-[color:var(--accent-line)]">

          <!-- 启用状态点 -->
          <span class="absolute top-[18px] right-4 w-2 h-2 rounded-full transition-shadow"
            :class="node.enabled !== false
              ? 'bg-emerald-500 shadow-[0_0_0_3.5px_rgba(16,185,129,0.15)]'
              : 'bg-slate-400 shadow-[0_0_0_3.5px_rgba(148,163,184,0.15)]'"/>

          <!-- 名称 + 类型标签 -->
          <div class="flex items-center gap-2 mb-1 pr-6">
            <span class="text-[14px] font-bold text-[color:var(--ink)] truncate">{{ node.name || `节点 ${idx + 1}` }}</span>
            <span v-if="node.kind === 'comfyui'" class="text-[10px] font-bold rounded-md px-1.5 py-0.5 bg-[color:var(--accent-soft)] text-[color:var(--accent)] flex-none">comfyui</span>
            <span v-else class="text-[10px] font-bold rounded-md px-1.5 py-0.5 bg-[color:var(--off-soft)] text-[color:var(--ink-3)] flex-none">openai</span>
          </div>

          <!-- Base URL -->
          <div class="text-[11px] text-[color:var(--ink-3)] font-mono truncate mb-2.5">{{ node.baseUrl || '（未配置 URL）' }}</div>

          <!-- 模型标签 -->
          <div class="flex flex-wrap gap-1 mb-3 min-h-[22px] content-center">
            <span v-for="m in (node.models || []).slice(0, 4)" :key="m" class="text-[10.5px] bg-[color:var(--off-soft)] text-[color:var(--ink-2)] rounded-md px-1.5 py-0.5 font-mono">{{ m }}</span>
            <span v-if="(node.models || []).length > 4" class="text-[10.5px] text-[color:var(--ink-3)] self-center">+{{ (node.models || []).length - 4 }}</span>
            <span v-if="!(node.models || []).length" class="text-[10.5px] text-[color:var(--ink-3)] self-center">（点下方"拉取"获取模型列表）</span>
          </div>

          <!-- 操作行 -->
          <div class="flex items-center gap-1.5 text-[11px] text-[color:var(--ink-3)] border-t border-[color:var(--hairline)] pt-2.5">
            <span class="mr-auto">{{ (node.models || []).length }} 个模型</span>
            <button class="border border-[color:var(--hairline-3)] rounded-lg px-2.5 py-1 text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] transition-colors duration-150 disabled:opacity-50" :disabled="probing"
              @click="fetchModels(idx)">拉取</button>
            <button class="border border-[color:var(--hairline-3)] rounded-lg px-2.5 py-1 text-[color:var(--ink-2)] hover:border-[color:var(--ink-3)] transition-colors duration-150"
              @click="node.enabled = node.enabled === false ? true : false">{{ node.enabled === false ? '启用' : '停用' }}</button>
            <button class="border border-[color:var(--hairline-3)] rounded-lg px-2.5 py-1 text-red-500 hover:border-red-300 transition-colors duration-150"
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
