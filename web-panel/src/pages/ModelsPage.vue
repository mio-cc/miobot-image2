<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import client, { errorMessage } from '../api/client';
import ModelPicker from '../components/ModelPicker.vue';
import FormField from '../components/FormField.vue';
import { type AppSelectOption } from '../components/AppSelect.vue';
import NodeCard from '../components/NodeCard.vue';
import NodeEditDrawer from '../components/NodeEditDrawer.vue';
import { ROLES, isRoleInherit, getRoleNode as getRoleNodeOf, getRoleModel as getRoleModelOf, setRoleValue as setRoleValueOf, getRoleFallback as getRoleFallbackOf, setRoleFallbackValue as setRoleFallbackValueOf, clearRoleFallbackValue as clearRoleFallbackValueOf, setMainBinding, roleUsageHint, type RoleDef } from '../shared/roles';

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

/** 正在编辑抽屉里查看/修改的节点下标（null = 抽屉关闭）。抽屉字段直写节点对象，关闭不丢改动。 */
const editingNode = ref<number | null>(null);

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
    editingNode.value = null; // 删除会引起下标重映射，先关抽屉避免引用漂移
    nodes.value.splice(idx, 1);
    // 同步修正所有 nodeIndex 引用：被删节点若被引用则回落 0（主对话），高位索引前移。
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

/* ═══ 节点级字段（kind/provider/headers/comfyui 六参/延迟）已随抽屉批落进
   NodeEditDrawer.vue——点卡片主体打开右侧编辑抽屉，抽屉即唯一编辑入口。═══ */

/** 节点延迟：被动统计（bot 每次真实调用记录）+ 主动「测延迟」（逐节点发最小请求计时）。 */
const latencyStats = ref<Record<string, any>>({});
const latencyTesting = ref(false);
const latencyStatus = ref('');
const latencyResults = ref<Array<any> | null>(null);

async function loadLatencyStats() {
    try {
        const res = await client.get('/nodes/latency');
        latencyStats.value = res.data?.nodes || {};
    } catch { /* bot 进程未运行时静默 */ }
}
onMounted(loadLatencyStats);

function latencyOf(idx: number) {
    return latencyStats.value[String(idx)] || null;
}

function latencyLabel(idx: number): string {
    const stat = latencyOf(idx);
    if (!stat || !stat.count) return '—';
    const fails = stat.failCount ? ` · 失败${stat.failCount}` : '';
    return `均值 ${stat.avgMs}ms / 最近 ${stat.lastMs}ms${fails}`;
}

async function runLatencyTest() {
    latencyTesting.value = true;
    latencyResults.value = null;
    latencyStatus.value = '已提交检测：逐启用节点发最小请求计时（每个最多 10 秒）…';
    try {
        const res = await client.post('/nodes/latency-test');
        const testId = res.data?.testId;
        for (let i = 0; i < 90; i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
                const r2 = await client.get(`/nodes/latency-test/${testId}`);
                if (r2.data?.result) {
                    const results = r2.data.result.results || [];
                    latencyResults.value = results;
                    const okCount = results.filter((r: any) => r.ok).length;
                    latencyStatus.value = `完成：${okCount}/${results.length} 个节点可用，耗时 ${Math.round((r2.data.result.durationMs || 0) / 100) / 10}s`;
                    loadLatencyStats();
                    latencyTesting.value = false;
                    return;
                }
            } catch { /* pending → 继续轮询 */ }
        }
        latencyStatus.value = '检测超时（bot 进程可能未运行或节点全部无响应）';
    } catch (error: any) {
        latencyStatus.value = errorMessage(error, '提交检测失败');
    }
    latencyTesting.value = false;
}

/** 批量拉取：逐个拉，不并发——同时打十几个上游最容易被限流，反而更慢。 */
const bulkRunning = ref(false);
const bulkStatus = ref('');

async function fetchAllModels() {
    bulkRunning.value = true;
    try {
        let ok = 0;
        let failed = 0;
        for (const { idx } of rows.value) {
            const node = nodes.value[idx];
            if (node?.enabled === false || !node?.baseUrl) continue;
            bulkStatus.value = `正在获取「${node.name || idx + 1}」…`;
            try {
                await fetchModels(idx);
                if (fetchErrors.value[idx]) { failed += 1; fetchErrors.value[idx] = ''; } else ok += 1;
            } catch { failed += 1; }
        }
        bulkStatus.value = `完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}`;
        window.setTimeout(() => { bulkStatus.value = ''; }, 5000);
    } finally {
        bulkRunning.value = false;
    }
}

/* ═══ 手动指定能力（llm.capabilityOverrides 唯一编辑入口）═══
   llm.capabilityOverrides 消费：app.ts:65 / start.ts:359（createReloadableRegistry）。 */
const OVERRIDABLE = ['chat', 'vision', 'interrogate', 'image.generate', 'image.edit', 'video.generate'];
const overrideModel = ref('');
const overrideOps = ref<string[]>([]);

const overrides = computed(() => config.value?.llm?.capabilityOverrides || []);

function saveOverride() {
    const model = overrideModel.value.trim();
    if (!model) return;
    const list = (config.value as any).llm.capabilityOverrides ||= [];
    const idx = list.findIndex((item: any) => String(item.model) === model);
    const entry = { model, operations: [...overrideOps.value] };
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    configStore.saveStatus = '能力覆盖已记录，保存后生效';
    overrideModel.value = '';
}

function removeOverride(model: string) {
    (config.value as any).llm.capabilityOverrides = overrides.value.filter((item: any) => String(item.model) !== model);
    configStore.saveStatus = '已清除该覆盖，保存后生效';
}
/* 拉取模型列表：P0 修复静默失败——per-node 状态、错误翻译（限流/鉴权/超时/协议错）、
   成功带 diff 摘要；上游 200 但解析不出模型时保留原列表。 */
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
    // 后端要明文 key；面板上是打码值，仅在用户刚改过（不含圆点）时才带上。
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

/* ═══ 第二模型（备用）· P2 全用途折叠胶囊（方案 6-P2）═══
   12 用途（含主对话）统一交互：行尾胶囊（未配灰 / 已配松绿）一眼可辨，点击展开编辑层，
   默认全部收起；展开状态是本地 UI 态（Set），不写 config、不触发脏标记。
   字段落点：各用途同容器内的 fallback* 字段（roles.ts 表 ↔ bot 侧 MODEL_BINDING_PURPOSES 同源）。
   语义红线（防跨用途继承）：某用途备用为空 = 该用途关闭回退（状态机 bypass），
   绝不回落到主对话的备用。清除时 model 置空串 → normalize 剔键，nodeIndex 置 0
   （保存链路 deepMerge 数字删键无法传播）。触发口径：主模型连续失败 2 次切备，
   一次成功即回切；档位锁定（modelOverride）仅主对话支持。 */

/** 展开中的备用编辑层（role.key 集合）。纯 UI 状态：不写配置、不影响脏标记。 */
const expandedFallbacks = ref(new Set<string>());

function isFallbackExpanded(key: string): boolean {
    return expandedFallbacks.value.has(key);
}
/** 胶囊点击：切换展开/收起（多行可同时展开）。 */
function toggleFallback(key: string) {
    const next = new Set(expandedFallbacks.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    expandedFallbacks.value = next;
}
function collapseAllFallbacks() {
    expandedFallbacks.value = new Set();
}

/** 读某用途备用绑定；mainRole 让主对话首卡共用同一套胶囊。 */
const mainRole = ROLES.find(r => r.key === 'main')!;

function getFallback(role: RoleDef): { nodeIndex: number; model: string } {
    return getRoleFallbackOf(config.value, role);
}
function setFallbackBinding(role: RoleDef, nodeIndex: number, model: string) {
    setRoleFallbackValueOf(config.value, role, nodeIndex, model);
    configStore.saveStatus = `已更新「${role.title}」备用模型，保存后生效`;
}
function clearFallbackBinding(role: RoleDef) {
    clearRoleFallbackValueOf(config.value, role);
    configStore.saveStatus = `已清除「${role.title}」备用模型，保存后生效`;
}

/** 展开层 hint：未配写明不跨用途继承；已配写触发/回切口径（档位锁定仅主对话）。 */
function fallbackHint(role: RoleDef): string {
    const binding = getFallback(role);
    if (!binding.model) return '未配置备用模型时不会自动回退（也不会拿主对话备用顶替）。';
    return role.key === 'main'
        ? '主模型连续失败 2 次切到备用，一次成功即回切；/切换 命令可手动锁定主/备档位。'
        : '主模型连续失败 2 次切到备用，一次成功即回切；备用可用「/切换」命令改绑（档位锁定仅主对话支持）。';
}

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
              @update:node-index="(v: number) => setMainBinding(config, v, mainModel.model)"
              @update:model="(v: string) => setMainBinding(config, mainModel.nodeIndex, v)"
            />
          </div>
        </div>

        <!-- 第二模型（备用）胶囊（P2 折叠化）：与用途行同款交互，12 行视觉一致。
             字段直写 agent.fallback*（roles 表 main 行），保存后热重载即生效；默认收起。 -->
        <div class="border-t border-[color:var(--accent-line)] bg-[color:var(--page)]">
          <div class="flex items-center gap-3 px-5 py-2 flex-wrap">
            <span class="text-[11px] text-[color:var(--ink-3)] flex-none">备用模型</span>
            <button type="button"
              :class="getFallback(mainRole).model
                ? 'fb-pill fb-pill-on'
                : 'fb-pill'"
              :title="getFallback(mainRole).model ? `备用：${getFallback(mainRole).model}（点击收起/展开）` : '未配置备用（点击展开配置）'"
              @click="toggleFallback(mainRole.key)">
              <span class="font-bold">备</span><span class="opacity-40">·</span>
              <span v-if="getFallback(mainRole).model" class="truncate max-w-[260px] font-medium">{{ getFallback(mainRole).model }}</span>
              <span v-else class="font-medium">未配置</span>
            </button>
          </div>
          <!-- 展开层：单列堆叠，无横向溢出 -->
          <div v-if="isFallbackExpanded(mainRole.key)" class="px-5 pb-3.5">
            <div class="rounded-[10px] border border-[color:var(--hairline-2)] bg-[color:var(--surface)] px-3.5 py-3">
              <ModelPicker capability="chat"
                :node-index="getFallback(mainRole).nodeIndex" :model="getFallback(mainRole).model"
                placeholder="留空 = 不启用备用"
                @update:node-index="(v: number) => setFallbackBinding(mainRole, v, getFallback(mainRole).model)"
                @update:model="(v: string) => setFallbackBinding(mainRole, getFallback(mainRole).nodeIndex, v)" />
              <div class="flex items-center gap-2.5 mt-2.5 flex-wrap">
                <button v-if="getFallback(mainRole).model" class="btn-outline text-xs" @click="clearFallbackBinding(mainRole)">清除备用</button>
                <p class="text-[11px] text-[color:var(--ink-3)] leading-relaxed flex-1 min-w-[200px]">{{ fallbackHint(mainRole) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 用途行（继承 / 覆盖 + 备用胶囊） -->
      <div class="bg-[color:var(--surface)] border border-[color:var(--hairline-2)] rounded-[16px] shadow-[var(--sh-1)] overflow-hidden">
        <!-- 表头：备用胶囊说明 + 全部收起（仅在存在展开行时出现） -->
        <div class="flex items-center gap-3 px-5 py-2 border-b border-[color:var(--hairline-2)] bg-[color:var(--page)] flex-wrap">
          <span class="text-[11px] text-[color:var(--ink-3)] leading-relaxed flex-1 min-w-[200px]">
            行尾「备」胶囊配置各用途独立的备用模型（主模型故障时切备救场；未配 = 该用途不自动回退，也不会拿主对话备用顶替）。
          </span>
          <button v-if="expandedFallbacks.size > 0" type="button"
            class="text-[11px] text-[color:var(--ink-3)] hover:text-[color:var(--ink)] border border-[color:var(--hairline-2)] rounded-md px-2 py-1 transition-colors"
            @click="collapseAllFallbacks">全部收起</button>
        </div>

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

          <!-- 备用胶囊（P2）：折叠态一眼可辨已配/未配；点击展开行内编辑层。默认收起。 -->
          <button type="button"
            :class="getFallback(role).model ? 'fb-pill fb-pill-on' : 'fb-pill'"
            :title="getFallback(role).model ? `备用：${getFallback(role).model}（点击收起/展开）` : '未配置备用（点击展开配置）'"
            @click="toggleFallback(role.key)">
            <span class="font-bold">备</span><span class="opacity-40">·</span>
            <span v-if="getFallback(role).model" class="truncate max-w-[180px] sm:max-w-[220px] font-medium">{{ getFallback(role).model }}</span>
            <span v-else class="font-medium">未配置</span>
          </button>

          <!-- 备用展开层：单列堆叠、无横向溢出（w-full 占据 wrap 后整行）。 -->
          <div v-if="isFallbackExpanded(role.key)" class="w-full">
            <div class="rounded-[10px] border border-[color:var(--hairline-2)] bg-[color:var(--page)] px-3.5 py-3 mt-1">
              <ModelPicker
                :node-index="getFallback(role).nodeIndex"
                :model="getFallback(role).model"
                :capability="role.capability"
                :placeholder="'留空 = 不启用备用'"
                @update:node-index="(v: number) => setFallbackBinding(role, v, getFallback(role).model)"
                @update:model="(v: string) => setFallbackBinding(role, getFallback(role).nodeIndex, v)"
              />
              <div class="flex items-center gap-2.5 mt-2.5 flex-wrap">
                <button v-if="getFallback(role).model" class="btn-outline text-xs" @click="clearFallbackBinding(role)">清除备用</button>
                <p class="text-[11px] text-[color:var(--ink-3)] leading-relaxed flex-1 min-w-[200px]">{{ fallbackHint(role) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p class="mt-3 text-[11px] text-[color:var(--ink-3)] leading-relaxed">
        提示词润色（llm.enhance*，image-pipeline 消费）已入上方用途表。
      </p>
    </section>

    <!-- ═══ 节点池视图（节点级配置唯一编辑入口：点卡片主体打开编辑抽屉）═══ -->
    <section v-if="view === 'nodes'">
      <div class="flex flex-wrap items-center gap-2.5 mb-4">
        <input v-model="search" placeholder="搜索节点名、URL 或模型…" class="input-field !w-auto flex-1 min-w-[220px]" />
        <span class="text-xs text-[color:var(--ink-3)]">{{ stats.enabled }} / {{ stats.total }} 启用</span>
        <button class="btn-outline text-xs" :disabled="latencyTesting" @click="runLatencyTest">{{ latencyTesting ? '检测中…' : '测延迟' }}</button>
        <button class="btn-outline text-xs" :disabled="bulkRunning" @click="fetchAllModels">{{ bulkRunning ? '获取中…' : '批量拉取' }}</button>
        <button class="btn-outline text-xs" @click="addNode">＋ 添加节点</button>
      </div>

      <p v-if="latencyStatus" class="text-xs mb-2 text-[color:var(--ink-2)]">{{ latencyStatus }}</p>
      <div v-if="latencyResults" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 mb-4">
        <div v-for="r in latencyResults" :key="r.nodeIndex"
          class="text-xs px-3 py-2 rounded border border-[color:var(--hairline-2)]"
          :class="r.ok ? 'bg-[color:var(--surface)]' : 'bg-[color:var(--surface-2)]'">
          <span :class="r.ok ? 'status-good' : 'status-crit'">{{ r.ok ? `✔ ${r.latencyMs}ms` : '✘ 不可用' }}</span>
          <span class="ml-2 font-medium">{{ r.name || `节点 ${r.nodeIndex + 1}` }}</span>
          <span class="ml-2 text-[color:var(--ink-3)] mono">{{ r.model }}</span>
          <span v-if="r.error" class="block text-[11px] text-[color:var(--ink-3)] truncate" :title="r.error">{{ r.error }}</span>
        </div>
      </div>
      <p v-if="bulkStatus" class="text-xs mb-2 text-[color:var(--ink-2)]">{{ bulkStatus }}</p>

      <div v-if="!rows.length" class="empty-state">
        <div class="empty-title">没有匹配的节点</div>
        <div class="empty-sub">换个关键词，或清空搜索查看全部 {{ stats.total }} 个节点</div>
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        <NodeCard v-for="{ node, idx } in rows" :key="idx"
          :node="node" :idx="idx"
          :fetching="fetchingNode === idx"
          :summary="fetchSummaries[idx] || ''"
          :error="fetchErrors[idx] || ''"
          :model-options="nodeModelOptions(node)"
          @open="editingNode = idx"
          @fetch="fetchModels(idx)"
          @remove="removeNode(idx)" />
      </div>

      <!-- 节点编辑抽屉：点卡片主体打开；字段直写节点对象，关闭不丢改动，顶栏「保存并热重载」生效 -->
      <NodeEditDrawer
        :open="editingNode !== null"
        :node="editingNode !== null ? nodes[editingNode] : null"
        :idx="editingNode ?? 0"
        :fetching="editingNode !== null && fetchingNode === editingNode"
        :summary="editingNode !== null ? (fetchSummaries[editingNode] || '') : ''"
        :error="editingNode !== null ? (fetchErrors[editingNode] || '') : ''"
        :latency-label="editingNode !== null ? latencyLabel(editingNode) : ''"
        @close="editingNode = null"
        @fetch="editingNode !== null && fetchModels(editingNode)" />

      <!-- 手动指定能力（llm.capabilityOverrides 唯一编辑入口） -->
      <details class="mt-4">
        <summary class="cursor-pointer text-[13px] text-[color:var(--ink-3)] hover:text-[color:var(--ink)] select-none transition-colors">手动指定能力（模型名或正则 → 能力，中转/反代识别不准时覆盖）</summary>
        <div class="mt-3 grid grid-cols-1 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] gap-3 items-end">
          <FormField label="模型（或正则）">
            <input v-model="overrideModel" class="input-field font-mono" placeholder="claude-sonnet-4 或 /^my-relay-/i" />
          </FormField>
          <FormField label="具备的能力" hint="指定的结果优先级最高；未勾选任何能力 = 全部禁用">
            <div class="flex flex-wrap gap-3 pt-1">
              <label v-for="cap in OVERRIDABLE" :key="cap" class="flex items-center gap-1.5 text-xs">
                <input type="checkbox" :value="cap" v-model="overrideOps" class="h-4 w-4" />
                {{ capabilityStore.labels[cap] || cap }}
              </label>
            </div>
          </FormField>
          <button class="btn-primary" :disabled="!overrideModel.trim()" @click="saveOverride">记录覆盖</button>
        </div>
        <table v-if="overrides.length" class="w-full text-[12.5px] mt-4 border-t border-[color:var(--hairline-2)]">
          <tbody>
            <tr v-for="item in overrides" :key="item.model" class="border-b border-[color:var(--hairline-2)] last:border-b-0">
              <td class="py-2.5 pr-4 mono">{{ item.model }}</td>
              <td class="py-2.5 pr-4">
                <span v-for="cap in item.operations || []" :key="cap" class="tag mr-1">{{ capabilityStore.labels[cap] || cap }}</span>
                <span v-if="!(item.operations || []).length" class="text-[color:var(--ink-3)]">（未勾选任何能力 = 全部禁用）</span>
              </td>
              <td class="py-2.5 text-right">
                <button class="btn-danger text-xs" @click="removeOverride(item.model)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="text-[color:var(--ink-3)] text-xs mt-4">还没有任何覆盖，所有能力都按模型 ID 自动推断。</p>
      </details>
    </section>
  </div>
</template>
