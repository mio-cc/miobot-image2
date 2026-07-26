<script setup lang="ts">
import { computed, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import AppIcon from '../components/AppIcon.vue';

const configStore = useConfigStore();
const capabilities = useCapabilityStore();
const config = computed(() => configStore.config);

const fetchingNode = ref<number | null>(null);
const fetchError = ref('');
const modelFilter = ref<Record<number, string>>({});

/**
 * 所有能力都用数组下标引用节点，所以删掉中间的节点后必须整体重映射，
 * 否则每一项分工都会静默指向另一个节点——配置看着没动，行为全变了。
 */
const NODE_INDEX_FIELDS: Array<[string, string]> = [
    ['llm', 'activeNodeIndex'], ['llm', 'chatNodeIndex'], ['llm', 'enhanceNodeIndex'],
    ['llm', 'templateNodeIndex'], ['llm', 'templateConvertNodeIndex'], ['llm', 'referencedTemplateNodeIndex'],
    ['llm', 'translationNodeIndex'], ['llm', 'imageNodeIndex'], ['llm', 'editNodeIndex'],
    ['llm', 'interrogateNodeIndex'], ['llm', 'videoNodeIndex'],
    ['canvas', 'imageNodeIndex'], ['canvas', 'editNodeIndex'],
    ['canvas', 'interrogateNodeIndex'], ['canvas', 'interrogateTemplateNodeIndex'],
    ['freeMode', 'nodeIndex'], ['promptsChat', 'smartNodeIndex'],
];

const PROVIDERS = [
    { value: '', label: 'openai（默认，OpenAI 兼容）' },
    { value: 'anthropic', label: 'anthropic（/v1/messages）' },
    { value: 'gemini', label: 'gemini（generateContent）' },
    { value: 'huggingface', label: 'huggingface（router）' },
    { value: 'custom', label: 'custom（自定义）' },
];

function addNode() {
    config.value.llm.apiKeys.push({
        name: `节点 ${config.value.llm.apiKeys.length + 1}`,
        baseUrl: '', key: '', enabled: true, models: [], modelsFetchedAt: '',
    });
}

function removeNode(rawIndex: number | string) {
    const index = Number(rawIndex);
    if (config.value.llm.apiKeys.length <= 1) return;
    const name = config.value.llm.apiKeys[index]?.name || `节点 ${index + 1}`;
    if (!window.confirm(`删除「${name}」？引用它的能力会自动改指向第 1 个节点。`)) return;

    config.value.llm.apiKeys.splice(index, 1);

    for (const [section, field] of NODE_INDEX_FIELDS) {
        const target = config.value[section];
        if (!target || typeof target !== 'object' || target[field] === undefined) continue;
        const value = Number(target[field]);
        target[field] = !Number.isFinite(value) || value === index ? 0 : (value > index ? value - 1 : value);
    }

    config.value.llm.modelLimits = (config.value.llm.modelLimits || [])
        .filter((rule: any) => Number(rule.nodeIndex) !== index)
        .map((rule: any) => ({ ...rule, nodeIndex: Number(rule.nodeIndex) > index ? Number(rule.nodeIndex) - 1 : Number(rule.nodeIndex) }));

    const maxIndex = config.value.llm.apiKeys.length - 1;
    if (config.value.llm.activeNodeIndex > maxIndex) config.value.llm.activeNodeIndex = maxIndex;
}

async function fetchModels(rawIndex: number | string) {
    const index = Number(rawIndex);
    const node = config.value.llm.apiKeys[index];
    if (!node?.baseUrl) { fetchError.value = '请先填写 Base URL'; return; }
    fetchingNode.value = index;
    fetchError.value = '';
    try {
        // 后端拿的是明文 key；面板上是打码值，所以只在用户刚改过（不含圆点）时才带上。
        const key = String(node.key || '').includes('••••') ? '' : node.key;
        const res = await client.post('/fetch-models', { baseUrl: node.baseUrl, key, nodeIndex: index });
        node.models = res.data.models || [];
        node.modelsFetchedAt = new Date().toISOString();
        capabilities.refresh();
    } catch (error: any) {
        fetchError.value = errorMessage(error, '获取模型列表失败');
    } finally {
        fetchingNode.value = null;
    }
}

function visibleModels(node: any, rawIdx: number | string) {
    const keyword = String(modelFilter.value[Number(rawIdx)] || '').trim().toLowerCase();
    const list = node.models || [];
    return keyword ? list.filter((m: string) => m.toLowerCase().includes(keyword)) : list;
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
          模型接入点。密钥只回显尾号，要更换直接输入新值；留着打码值表示不修改。
        </p>
      </div>
      <button class="btn-outline flex items-center gap-1.5" @click="addNode">
        <AppIcon name="plus" :size="13" />添加节点
      </button>
    </header>

    <p v-if="fetchError" class="status-crit text-xs mb-3">{{ fetchError }}</p>

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <div v-for="(node, idx) in config.llm.apiKeys" :key="idx"
        class="node-card" :class="config.llm.activeNodeIndex === idx ? 'node-card-active' : ''">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <button class="w-4 h-4 rounded-full border-2 flex items-center justify-center flex-none"
            :class="config.llm.activeNodeIndex === idx ? 'border-[color:var(--ink)] bg-[color:var(--ink)]' : 'border-[color:var(--hairline-2)]'"
            title="设为活跃节点" @click="config.llm.activeNodeIndex = idx">
            <span v-if="config.llm.activeNodeIndex === idx" class="w-1.5 h-1.5 rounded-full bg-[color:var(--surface)]"></span>
          </button>
          <span class="text-sm font-semibold">{{ node.name || '未命名' }}</span>
          <span v-if="config.llm.activeNodeIndex === idx" class="tag">活跃</span>
          <label class="flex items-center gap-1 text-xs text-[color:var(--ink-3)]">
            <input type="checkbox" v-model="node.enabled" />启用
          </label>
          <span class="flex-1"></span>
          <button class="btn-outline text-xs flex items-center gap-1" :disabled="fetchingNode === idx" @click="fetchModels(idx)">
            <AppIcon name="refresh" :size="12" />{{ fetchingNode === idx ? '获取中...' : '获取模型' }}
          </button>
          <button v-if="config.llm.apiKeys.length > 1" class="btn-danger text-xs" @click="removeNode(idx)">删除</button>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField label="节点名称"><input v-model="node.name" class="input-field" placeholder="My Node" /></FormField>
          <FormField label="协议方言" hint="决定端点与请求体形态，不是 OpenAI 兼容时改这里">
            <select v-model="node.provider" class="input-field">
              <option v-for="p in PROVIDERS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </FormField>
          <div class="sm:col-span-2">
            <FormField label="Base URL" hint="例如 https://api.example.com/v1 或 http://127.0.0.1:8317/v1">
              <input v-model="node.baseUrl" class="input-field font-mono" placeholder="https://api.example.com/v1" />
            </FormField>
          </div>
          <div class="sm:col-span-2">
            <FormField label="API Key" :hint="node.hasKey ? '已保存密钥；要更换请直接输入新值' : '尚未设置密钥'">
              <input v-model="node.key" type="password" class="input-field font-mono" placeholder="sk-..." />
            </FormField>
          </div>
        </div>

        <div v-if="node.models?.length" class="mt-3 rounded-lg border border-[color:var(--hairline-2)] p-3">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[11px] font-semibold text-[color:var(--ink-3)]">已保存模型 {{ node.models.length }}</span>
            <input v-model="modelFilter[Number(idx)]" class="input-field !w-32 !py-0.5 !text-[11px] ml-auto" placeholder="筛选" />
            <span v-if="node.modelsFetchedAt" class="text-[11px] text-[color:var(--ink-3)]">{{ formatTime(node.modelsFetchedAt) }}</span>
          </div>
          <div class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
            <span v-for="m in visibleModels(node, idx)" :key="m" class="tag">{{ m }}</span>
          </div>
        </div>
      </div>
    </div>

    <SectionCard title="节点使用说明" class="mt-4">
      <ul class="text-xs text-[color:var(--ink-2)] space-y-1.5 leading-relaxed">
        <li>· 节点是「一个模型接入点」，可以是官方直连、NewAPI/One-API 中转，也可以是 CLIProxyAPI 这类把 CLI 订阅包装成 API 的反代。</li>
        <li>· 「OpenAI 兼容」说的是请求体长什么样，不是这个节点有什么能力。同一个 /chat/completions 后面既可能是纯文本模型，也可能是能画图能看图的模型——所以能力单独判定。</li>
        <li>· 不同能力可以绑不同节点，在「能力分工」页配置；中转和反代的能力无法从模型名推断，识别不准时在那里手动指定。</li>
        <li>· 上游拒绝某个参数时系统会自动剔除或改名并记住（按节点+模型），换网关无需手工调整。</li>
      </ul>
    </SectionCard>
  </div>
</template>
