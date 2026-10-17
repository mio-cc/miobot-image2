<script setup lang="ts">
import { computed, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const testing = ref(false);
const testQuery = ref('DeepSeek V4 最新发布信息');
const testError = ref('');
const testResponse = ref<any>(null);

const providers = [
  { value: 'deepseek', label: 'DeepSeek 自研搜索（推荐）', url: 'https://api.deepseek.com' },
  { value: 'tavily', label: 'Tavily', url: 'https://api.tavily.com/search' },
  { value: 'brave', label: 'Brave Search', url: 'https://api.search.brave.com/res/v1/web/search' },
  { value: 'serper', label: 'Serper.dev / Google', url: 'https://google.serper.dev/search' },
  { value: 'bing', label: 'Bing Web Search', url: 'https://api.bing.microsoft.com/v7.0/search' },
  { value: 'google', label: 'Google Custom Search', url: 'https://www.googleapis.com/customsearch/v1' },
  { value: 'searxng', label: 'SearXNG', url: 'http://127.0.0.1:8080/search' },
  { value: 'exa', label: 'Exa', url: 'https://api.exa.ai/search' },
];

const fetchProviders = [
  { value: 'provider', label: '使用搜索服务自带正文' },
  { value: 'jina', label: 'Jina Reader 抓取正文' },
  { value: 'deepseek', label: 'DeepSeek Fetch 抓取正文' },
  { value: 'none', label: '只使用摘要，不抓正文' },
];

const autoModes = [
  { value: 'auto', label: '自动判断：只在时效/事实类问题搜索' },
  { value: 'always', label: '每次都搜索' },
  { value: 'off', label: '关闭自动搜索（只执行显式搜索命令）' },
];

function providerChanged() {
  const current = providers.find((item) => item.value === config.value?.search?.provider);
  if (!current) return;
  const currentUrl = String(config.value?.search?.apiUrl || '').trim();
  const isKnownDefault = providers.some((item) => item.url === currentUrl);
  if (!currentUrl || isKnownDefault) config.value.search.apiUrl = current.url;
}

async function runTest() {
  const query = testQuery.value.trim();
  if (!query) { testError.value = '请填写测试搜索内容'; return; }
  testing.value = true;
  testError.value = '';
  testResponse.value = null;
  try {
    const res = await client.post('/search/test', { query });
    testResponse.value = res.data;
  } catch (error: any) {
    testError.value = errorMessage(error, '测试搜索失败');
  } finally {
    testing.value = false;
  }
}

function formatDate(value?: string) {
  if (!value) return '';
  try { return new Date(value).toLocaleString(); } catch { return value; }
}
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">联网搜索</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        为聊天/文件问答注入实时网页结果。DeepSeek 使用自研 Search/Fetch API；也支持 Tavily、Brave、Serper、Bing、Google、SearXNG、Exa。
      </p>
    </header>

    <SectionCard title="搜索服务" hint="保存后立即热重载" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ToggleField v-model="config.search.enabled" label="启用联网搜索" hint="关闭后不会自动搜索，也不执行搜索命令" />
        <FormField label="服务商">
          <select v-model="config.search.provider" class="input-field" @change="providerChanged">
            <option v-for="item in providers" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </FormField>
        <FormField label="自动搜索">
          <select v-model="config.search.autoMode" class="input-field">
            <option v-for="item in autoModes" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </FormField>
        <FormField label="API 地址" hint="DeepSeek 填 https://api.deepseek.com；其他服务可填自定义代理地址">
          <input v-model="config.search.apiUrl" class="input-field font-mono" placeholder="https://api.deepseek.com" />
        </FormField>
        <FormField label="API Key" hint="留空时 DeepSeek 会尝试复用聊天节点的 DeepSeek 官方 Key">
          <input v-model="config.search.apiKey" type="password" class="input-field font-mono" placeholder="sk-..." />
        </FormField>
        <FormField v-if="config.search.provider === 'google'" label="Google CX" hint="Google Custom Search Engine ID">
          <input v-model="config.search.googleCx" class="input-field font-mono" placeholder="xxxxxxxxxxxx:yyyyyyyy" />
        </FormField>
        <FormField label="结果数量" hint="1-50；最终注入模型的内容还会受总字符限制">
          <input v-model.number="config.search.maxResults" type="number" min="1" max="50" class="input-field" />
        </FormField>
        <FormField label="搜索语言">
          <input v-model="config.search.language" class="input-field" placeholder="zh-CN" />
        </FormField>
        <FormField label="搜索地区" hint="部分服务商使用，例如 cn、us">
          <input v-model="config.search.region" class="input-field" placeholder="cn" />
        </FormField>
        <FormField label="本地化 IP" hint="DeepSeek localization 参数，可选；用于按 IP 本地化搜索结果">
          <input v-model="config.search.localization" class="input-field font-mono" placeholder="例如 1.2.3.4" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="正文抓取" hint="搜索摘要通常不够回答细节问题；正文抓取会增加延迟和外部请求" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ToggleField v-model="config.search.needContent" label="搜索时请求正文" hint="DeepSeek/Tavily/Exa 可直接在搜索结果返回正文" />
        <ToggleField v-model="config.search.fetchContent" label="对缺失正文的结果再抓取" />
        <FormField label="正文抓取方式">
          <select v-model="config.search.fetchProvider" class="input-field">
            <option v-for="item in fetchProviders" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </FormField>
        <FormField label="Jina Reader 地址">
          <input v-model="config.search.jinaBaseUrl" class="input-field font-mono" placeholder="https://r.jina.ai" />
        </FormField>
        <FormField label="Jina API Key" hint="可留空；免费额度可能有限速">
          <input v-model="config.search.jinaApiKey" type="password" class="input-field font-mono" placeholder="可选" />
        </FormField>
        <FormField label="单条正文上限">
          <input v-model.number="config.search.maxContentChars" type="number" min="500" max="20000" step="500" class="input-field" />
        </FormField>
        <FormField label="注入总字符上限">
          <input v-model.number="config.search.maxTotalChars" type="number" min="2000" max="100000" step="1000" class="input-field" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="性能与重试" hint="DeepSeek Search/Fetch 官方限制为每账号 5 QPS" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <FormField label="超时（毫秒）">
          <input v-model.number="config.search.timeoutMs" type="number" min="3000" max="120000" step="1000" class="input-field" />
        </FormField>
        <FormField label="重试次数">
          <input v-model.number="config.search.retryCount" type="number" min="0" max="5" class="input-field" />
        </FormField>
        <FormField label="缓存 TTL（秒）" hint="0 = 不缓存">
          <input v-model.number="config.search.cacheTtlSeconds" type="number" min="0" max="86400" class="input-field" />
        </FormField>
        <FormField label="QPS 上限">
          <input v-model.number="config.search.qps" type="number" min="1" max="20" class="input-field" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="搜索测试" hint="使用已保存配置；修改后请先点右上角保存再测试" class="mb-4">
      <template #actions>
        <button class="btn-primary text-xs" :disabled="testing" @click="runTest">{{ testing ? '搜索中...' : '测试搜索' }}</button>
      </template>
      <div class="flex flex-wrap gap-2 mb-3">
        <input v-model="testQuery" class="input-field flex-1 min-w-[260px]" placeholder="输入测试搜索内容" @keyup.enter="runTest" />
      </div>
      <p v-if="testError" class="status-crit text-xs whitespace-pre-wrap">{{ testError }}</p>
      <div v-if="testResponse" class="space-y-3">
        <p class="text-xs status-good">
          服务商 {{ testResponse.response?.provider }} · {{ testResponse.response?.results?.length || 0 }} 条结果 · {{ testResponse.response?.durationMs || 0 }}ms
          <span v-if="testResponse.response?.cached">（缓存）</span>
        </p>
        <div v-for="(item, idx) in testResponse.response?.results || []" :key="item.url + idx"
          class="rounded-lg border border-[color:var(--hairline-2)] p-3">
          <div class="flex flex-wrap items-center gap-2 mb-1">
            <span class="tag">{{ Number(idx) + 1 }}</span>
            <a :href="item.url" target="_blank" rel="noreferrer" class="font-medium text-sm underline">{{ item.title }}</a>
            <span v-if="item.rerankScore !== undefined" class="tag">score {{ item.rerankScore }}</span>
            <span v-if="item.authority !== undefined" class="tag">auth {{ item.authority }}</span>
            <span v-if="item.date" class="text-[color:var(--ink-3)] text-xs">{{ formatDate(item.date) }}</span>
          </div>
          <p class="text-xs text-[color:var(--ink-3)] whitespace-pre-wrap">{{ item.summary || item.snippet }}</p>
        </div>
        <p v-if="!(testResponse.response?.results || []).length" class="text-xs text-[color:var(--ink-3)]">搜索成功，但没有返回结果。</p>
      </div>
    </SectionCard>

    <SectionCard title="使用说明" class="mb-4">
      <ul class="text-xs text-[color:var(--ink-3)] space-y-1 list-disc pl-5">
        <li>显式命令「搜索 关键词」「联网搜索 关键词」会强制搜索。</li>
        <li>自动搜索只对新闻、实时信息、价格、版本、官网、文档等时效/事实类问题触发。</li>
        <li>搜索结果会作为不可信外部资料注入，网页中的指令不会被执行。</li>
        <li>DeepSeek Search/Fetch 按成功请求计费，无结果不计费；失败会自动重试并记录日志。</li>
      </ul>
    </SectionCard>
  </div>
</template>
