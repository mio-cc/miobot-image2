<script setup lang="ts">
import { computed, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import AppIcon from '../components/AppIcon.vue';

/**
 * 节点列表。一行一个节点，展开才是详细表单。
 *
 * 之前是一节点一张大卡片：12 个节点就是 12 屏，改个并发要翻半天。
 * 渠道列表本来就该是表格——名称、地址、密钥状态、模型数、并发一眼扫完，
 * 要改哪个再展开哪个。
 */

const configStore = useConfigStore();
const capabilities = useCapabilityStore();
const config = computed(() => configStore.config);

const fetchingNode = ref<number | null>(null);
const fetchError = ref('');
const expanded = ref<number | null>(null);
const search = ref('');
const bulkRunning = ref(false);
const bulkStatus = ref('');

/**
 * 所有能力都用数组下标引用节点，所以删掉中间的节点后必须整体重映射，
 * 否则每一项分工都会静默指向另一个节点——配置看着没动，行为全变了。
 */
const NODE_INDEX_FIELDS: Array<[string, string]> = [
    ['llm', 'activeNodeIndex'], ['llm', 'chatNodeIndex'], ['llm', 'enhanceNodeIndex'],
    ['llm', 'templateNodeIndex'], ['llm', 'referencedTemplateNodeIndex'],
    ['llm', 'translationNodeIndex'], ['llm', 'imageNodeIndex'], ['llm', 'editNodeIndex'],
    ['llm', 'interrogateNodeIndex'], ['llm', 'videoNodeIndex'],
    ['canvas', 'imageNodeIndex'], ['canvas', 'editNodeIndex'],
    ['canvas', 'interrogateNodeIndex'], ['canvas', 'interrogateTemplateNodeIndex'],
    ['freeMode', 'nodeIndex'], ['promptsChat', 'smartNodeIndex'],
    // bot.tts.preprocess.nodeIndex 藏在第三层，这个两级遍历够不到，在下面单独处理。
];

const PROVIDERS = [
    { value: '', label: 'openai' },
    { value: 'anthropic', label: 'anthropic' },
    { value: 'gemini', label: 'gemini' },
    { value: 'huggingface', label: 'huggingface' },
    { value: 'custom', label: 'custom' },
];

const nodes = computed(() => config.value?.llm?.apiKeys || []);

/** 带原始下标的行，过滤后下标才不会错位。 */
const rows = computed(() => {
    const keyword = search.value.trim().toLowerCase();
    const all = nodes.value.map((node: any, idx: number) => ({ node, idx }));
    if (!keyword) return all;
    return all.filter(({ node }: any) =>
        String(node.name || '').toLowerCase().includes(keyword)
        || String(node.baseUrl || '').toLowerCase().includes(keyword)
        || (node.models || []).some((m: string) => m.toLowerCase().includes(keyword)));
});

const summary = computed(() => ({
    total: nodes.value.length,
    enabled: nodes.value.filter((n: any) => n.enabled !== false).length,
    withModels: nodes.value.filter((n: any) => (n.models || []).length).length,
    limited: nodes.value.filter((n: any) => Number(n.concurrency) > 0).length,
}));

function addNode() {
    nodes.value.push({
        name: `节点 ${nodes.value.length + 1}`,
        baseUrl: '', key: '', enabled: true, models: [], modelsFetchedAt: '', concurrency: 0,
    });
    expanded.value = nodes.value.length - 1;
}

function removeNode(index: number) {
    if (nodes.value.length <= 1) return;
    const name = nodes.value[index]?.name || `节点 ${index + 1}`;
    if (!window.confirm(`删除「${name}」？引用它的能力会自动改指向第 1 个节点。`)) return;

    nodes.value.splice(index, 1);
    expanded.value = null;

    for (const [section, field] of NODE_INDEX_FIELDS) {
        const target = config.value[section];
        if (!target || typeof target !== 'object' || target[field] === undefined) continue;
        const value = Number(target[field]);
        if (!Number.isFinite(value)) continue;
        target[field] = value === index ? 0 : (value > index ? value - 1 : value);
    }
    // tts 的节点索引藏在 bot.tts.preprocess 下，上面的两级遍历够不到。
    const tts = config.value?.bot?.tts?.preprocess;
    if (tts && Number.isFinite(Number(tts.nodeIndex))) {
        const value = Number(tts.nodeIndex);
        tts.nodeIndex = value === index ? 0 : (value > index ? value - 1 : value);
    }

    const maxIndex = nodes.value.length - 1;
    if (config.value.llm.activeNodeIndex > maxIndex) config.value.llm.activeNodeIndex = maxIndex;
}

async function fetchModels(index: number) {
    const node = nodes.value[index];
    if (!node?.baseUrl) { fetchError.value = `「${node?.name || index + 1}」还没填 Base URL`; return; }
    fetchingNode.value = index;
    fetchError.value = '';
    try {
        // 后端要明文 key；面板上是打码值，所以只在用户刚改过（不含圆点）时才带上。
        const key = String(node.key || '').includes('••••') ? '' : node.key;
        const res = await client.post('/fetch-models', { baseUrl: node.baseUrl, key, nodeIndex: index });
        node.models = res.data.models || [];
        node.modelsFetchedAt = new Date().toISOString();
        capabilities.refresh();
    } catch (error: any) {
        fetchError.value = `「${node.name || index + 1}」${errorMessage(error, '获取模型列表失败')}`;
    } finally {
        fetchingNode.value = null;
    }
}

/** 逐个拉，不并发——同时打十几个上游最容易被限流，反而更慢。 */
async function fetchAllModels() {
    bulkRunning.value = true;
    fetchError.value = '';
    let ok = 0;
    let failed = 0;
    try {
        for (const { node, idx } of rows.value) {
            if (node.enabled === false || !node.baseUrl) continue;
            bulkStatus.value = `正在获取「${node.name || idx + 1}」…`;
            try {
                await fetchModels(idx);
                if (fetchError.value) { failed += 1; fetchError.value = ''; } else ok += 1;
            } catch { failed += 1; }
        }
        bulkStatus.value = `完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}`;
        window.setTimeout(() => { bulkStatus.value = ''; }, 5000);
    } finally {
        bulkRunning.value = false;
    }
}

function toggleRow(idx: number) {
    expanded.value = expanded.value === idx ? null : idx;
}

function hostOf(url: string) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try { return new URL(raw).host; } catch { return raw.replace(/^https?:\/\//, '').split('/')[0]; }
}

function formatTime(value: string) {
    if (!value) return '';
    try { return new Date(value).toLocaleString('zh-CN', { hour12: false }); } catch { return value; }
}
</script>

<template>
  <div v-if="config">
    <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="page-title mb-0.5">API 节点</h1>
        <p class="text-[color:var(--ink-3)] text-xs">
          共 {{ summary.total }} 个 · {{ summary.enabled }} 启用 · {{ summary.withModels }} 已取模型 · {{ summary.limited }} 设了并发上限
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="search" class="input-field !w-48" placeholder="搜索名称 / 地址 / 模型" />
        <button class="btn-outline" :disabled="bulkRunning" @click="fetchAllModels">
          {{ bulkRunning ? '获取中...' : '批量获取模型' }}
        </button>
        <button class="btn-primary flex items-center gap-1.5" @click="addNode">
          <AppIcon name="plus" :size="13" />添加节点
        </button>
      </div>
    </header>

    <p v-if="fetchError" class="status-crit text-xs mb-2">{{ fetchError }}</p>
    <p v-if="bulkStatus" class="text-xs mb-2 text-[color:var(--ink-2)]">{{ bulkStatus }}</p>

    <SectionCard no-padding class="mb-4">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th w-[44px] text-center" title="设为活跃节点">活跃</th>
            <th class="th">名称</th>
            <th class="th w-[104px]">方言</th>
            <th class="th">地址</th>
            <th class="th w-[76px]">密钥</th>
            <th class="th w-[72px] text-right">模型</th>
            <th class="th w-[96px]">并发</th>
            <th class="th w-[60px] text-center">启用</th>
            <th class="th w-[150px] text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="{ node, idx } in rows" :key="idx">
            <tr class="border-b border-[color:var(--hairline-2)] hover:bg-[color:var(--surface-2)]"
              :class="node.enabled === false ? 'opacity-55' : ''">
              <td class="px-3 py-2 text-center">
                <button class="w-3.5 h-3.5 rounded-full border-2 inline-flex items-center justify-center align-middle"
                  :class="config.llm.activeNodeIndex === idx ? 'border-[color:var(--ink)] bg-[color:var(--ink)]' : 'border-[color:var(--hairline-2)]'"
                  title="设为活跃节点" @click.stop="config.llm.activeNodeIndex = idx">
                  <span v-if="config.llm.activeNodeIndex === idx" class="w-1 h-1 rounded-full bg-[color:var(--surface)]"></span>
                </button>
              </td>
              <td class="px-3 py-2 cursor-pointer font-medium truncate max-w-[160px]" @click="toggleRow(idx)">
                {{ node.name || `节点 ${idx + 1}` }}
              </td>
              <td class="px-3 py-2 cursor-pointer" @click="toggleRow(idx)">
                <span class="tag">{{ node.provider || 'openai' }}</span>
              </td>
              <td class="px-3 py-2 cursor-pointer mono text-[11.5px] text-[color:var(--ink-2)] truncate max-w-[220px]"
                :title="node.baseUrl" @click="toggleRow(idx)">
                {{ hostOf(node.baseUrl) || '— 未填 —' }}
              </td>
              <td class="px-3 py-2 cursor-pointer text-[11.5px]" @click="toggleRow(idx)">
                <span v-if="node.hasKey || (node.key && !String(node.key).includes('••••'))" class="status-good">已设置</span>
                <span v-else class="text-[color:var(--ink-3)]">未设置</span>
              </td>
              <td class="px-3 py-2 cursor-pointer text-right mono" @click="toggleRow(idx)">
                <span :class="(node.models || []).length ? '' : 'text-[color:var(--ink-3)]'">{{ (node.models || []).length }}</span>
              </td>
              <td class="px-3 py-2">
                <input v-model.number="node.concurrency" type="number" min="0" max="256" step="1"
                  class="input-field !py-0.5 !text-[11.5px]" :placeholder="'不限'" title="同时在飞的请求数上限，0 = 不限制" />
              </td>
              <td class="px-3 py-2 text-center">
                <span class="toggle !w-8 !h-[18px]">
                  <input type="checkbox" v-model="node.enabled" />
                  <span class="toggle-slider"></span>
                </span>
              </td>
              <td class="px-3 py-2 text-right whitespace-nowrap">
                <button class="btn-outline !px-2 !py-0.5 text-[11px]" :disabled="fetchingNode === idx" @click.stop="fetchModels(idx)">
                  {{ fetchingNode === idx ? '获取中' : '取模型' }}
                </button>
                <button class="btn-outline !px-2 !py-0.5 text-[11px] ml-1" @click.stop="toggleRow(idx)">
                  {{ expanded === idx ? '收起' : '编辑' }}
                </button>
                <button v-if="nodes.length > 1" class="btn-danger !px-2 !py-0.5 text-[11px] ml-1" @click.stop="removeNode(idx)">删</button>
              </td>
            </tr>

            <tr v-if="expanded === idx" class="bg-[color:var(--surface-2)] border-b border-[color:var(--hairline-2)]">
              <td colspan="9" class="px-4 py-4">
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                  <FormField label="节点名称"><input v-model="node.name" class="input-field" placeholder="My Node" /></FormField>
                  <FormField label="协议方言" hint="决定端点与请求体形态">
                    <select v-model="node.provider" class="input-field">
                      <option v-for="p in PROVIDERS" :key="p.value" :value="p.value">{{ p.label }}</option>
                    </select>
                  </FormField>
                  <div class="md:col-span-2">
                    <FormField label="Base URL" hint="例如 https://api.example.com/v1 或 http://127.0.0.1:8317/v1">
                      <input v-model="node.baseUrl" class="input-field font-mono" placeholder="https://api.example.com/v1" />
                    </FormField>
                  </div>
                  <div class="md:col-span-2">
                    <FormField label="API Key" :hint="node.hasKey ? '已保存密钥；要更换请直接输入新值' : '尚未设置密钥'">
                      <input v-model="node.key" type="password" class="input-field font-mono" placeholder="sk-..." />
                    </FormField>
                  </div>
                  <FormField label="并发上限" hint="0 = 不限制。上游按 key 发额度，所以限流单位是节点">
                    <input v-model.number="node.concurrency" type="number" min="0" max="256" class="input-field" />
                  </FormField>
                  <FormField label="模型列表" :hint="node.modelsFetchedAt ? `更新于 ${formatTime(node.modelsFetchedAt)}` : '还没获取过'">
                    <button class="btn-outline w-full" :disabled="fetchingNode === idx" @click="fetchModels(idx)">
                      {{ fetchingNode === idx ? '获取中...' : `获取模型（当前 ${(node.models || []).length} 个）` }}
                    </button>
                  </FormField>
                </div>

                <div v-if="(node.models || []).length" class="mt-3 flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  <span v-for="m in node.models" :key="m" class="tag">{{ m }}</span>
                </div>
              </td>
            </tr>
          </template>

          <tr v-if="!rows.length">
            <td colspan="9" class="px-4 py-8 text-center text-[color:var(--ink-3)] text-sm">
              {{ search ? '没有匹配的节点' : '还没有节点' }}
            </td>
          </tr>
        </tbody>
      </table>
    </SectionCard>

    <SectionCard title="节点使用说明">
      <ul class="text-xs text-[color:var(--ink-2)] space-y-1.5 leading-relaxed">
        <li>· 节点是「一个模型接入点」，可以是官方直连、NewAPI/One-API 中转，也可以是 CLIProxyAPI 这类把 CLI 订阅包装成 API 的反代。</li>
        <li>· 「OpenAI 兼容」说的是请求体长什么样，不是这个节点有什么能力。同一个 /chat/completions 后面既可能是纯文本模型，也可能是能画图能看图的模型——所以能力单独判定，在「能力分工」页配置。</li>
        <li>· <b>并发上限按节点设</b>：上游的并发额度是跟着 key 发的，同一个 key 上开 8 个对话和开 8 个生图，对上游是一回事。超出上限的请求会排队，不会被丢弃，排队时间不计入请求超时。</li>
        <li>· Bot 和画布各自持有一份连接，因此两边同时打满时上游看到的是 2 倍上限。合成一个全局闸门会让画布的批量生成把群里的对话堵死，所以刻意分开。</li>
        <li>· 上游拒绝某个参数时系统会自动剔除或改名并记住（按节点+模型），换网关无需手工调整。</li>
      </ul>
    </SectionCard>
  </div>
</template>
