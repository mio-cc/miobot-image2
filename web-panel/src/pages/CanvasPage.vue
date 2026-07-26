<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import ModelPicker from '../components/ModelPicker.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);

const cards = ref<any[]>([]);
const cardsError = ref('');
const cardsLoading = ref(false);
const cardFilter = ref<'all' | 'gallery' | 'interrogation'>('all');

const visibleCards = computed(() =>
    cardFilter.value === 'all' ? cards.value : cards.value.filter(item => item.kind === cardFilter.value));

async function loadCards() {
    cardsLoading.value = true;
    cardsError.value = '';
    try {
        const res = await client.get('/canvas/cards');
        cards.value = res.data.items || [];
    } catch (error: any) {
        cardsError.value = errorMessage(error, '画布记录加载失败');
    } finally {
        cardsLoading.value = false;
    }
}

async function deleteCard(card: any) {
    if (!window.confirm(`删除这条${card.kind === 'gallery' ? '生成' : '反推'}记录？`)) return;
    try {
        const res = await client.delete(`/canvas/cards/${card.kind}/${encodeURIComponent(card.id)}`);
        cards.value = res.data.items || [];
    } catch (error: any) {
        cardsError.value = errorMessage(error, '删除失败');
    }
}

function formatTime(value: string) {
    if (!value) return '';
    try { return new Date(value).toLocaleString('zh-CN', { hour12: false }); } catch { return value; }
}

onMounted(loadCards);
</script>

<template>
  <div v-if="config">
    <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="page-title mb-0.5">画布</h1>
        <p class="text-[color:var(--ink-3)] text-xs">前台画布使用独立配置与独立日志，只复用节点列表，不与 Bot 生图配置混用。</p>
      </div>
      <a href="/canvas/" target="_blank" rel="noopener" class="btn-outline text-xs">打开前台</a>
    </header>

    <SectionCard title="访问控制" hint="画布前台没有登录态，这里决定谁能调它的生图接口" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FormField label="访问模式" hint="公开模式下任何能访问端口的人都能消耗你的额度">
          <select v-model="config.canvas.access" class="input-field">
            <option value="public">公开（任何人可用）</option>
            <option value="local-only">仅本机 / 内网</option>
            <option value="admin">仅管理员（需登录后台）</option>
          </select>
        </FormField>
        <FormField label="每来源每分钟上限" hint="0 表示不限制；管理员不受限流约束">
          <input v-model.number="config.canvas.rateLimitPerMinute" type="number" min="0" step="5" class="input-field" />
        </FormField>
        <div class="self-end">
          <ToggleField v-model="config.canvas.enabled" label="启用画布前台" />
        </div>
      </div>
      <p class="text-[color:var(--ink-3)] text-[11px] mt-3 leading-relaxed">
        所有会改变状态的请求都受此约束（生图/改图/反推、删记录、改项目）；看画廊、取图片不受影响。
        其中只有生图、改图、反推这三条计入每分钟配额——删条记录不该消耗你的生成额度。
        「仅本机 / 内网」按 TCP 连接的实际来源地址判定，不看 X-Forwarded-For——那个头客户端可以随便写。
        如果你把画布挂在反向代理后面，请在反代那一层限制来源。
      </p>
    </SectionCard>

    <SectionCard title="画布生图模型" hint="与 Bot 的生图配置相互独立" class="mb-4">
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <FormField label="文生图">
          <ModelPicker capability="image.generate"
            :node-index="config.canvas.imageNodeIndex" :model="config.canvas.imageModel"
            @update:node-index="config.canvas.imageNodeIndex = $event"
            @update:model="config.canvas.imageModel = $event" />
        </FormField>
        <FormField label="图生图 / 改图">
          <ModelPicker capability="image.edit"
            :node-index="config.canvas.editNodeIndex" :model="config.canvas.editModel"
            @update:node-index="config.canvas.editNodeIndex = $event"
            @update:model="config.canvas.editModel = $event" />
        </FormField>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
        <FormField label="图生图请求格式" hint="auto 会按模型自动排序">
          <select v-model="config.canvas.imageEditRequestMode" class="input-field">
            <option value="auto">auto</option><option value="json-images">json-images</option>
            <option value="json-image">json-image</option><option value="multipart">multipart</option>
          </select>
        </FormField>
        <FormField label="请求超时 (ms)">
          <input v-model.number="config.canvas.imageTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
        </FormField>
        <FormField label="重试次数">
          <input v-model.number="config.canvas.imageRetryCount" type="number" min="0" max="5" class="input-field" />
        </FormField>
        <FormField label="重试间隔 (ms)">
          <input v-model.number="config.canvas.imageRetryDelayMs" type="number" min="0" step="500" class="input-field" />
        </FormField>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <FormField label="默认质量">
          <select v-model="config.canvas.defaultQuality" class="input-field">
            <option value="auto">auto</option><option value="low">low</option>
            <option value="medium">medium</option><option value="high">high</option>
          </select>
        </FormField>
        <FormField label="默认格式">
          <select v-model="config.canvas.defaultOutputFormat" class="input-field">
            <option value="png">png</option><option value="jpeg">jpeg</option><option value="webp">webp</option>
          </select>
        </FormField>
        <FormField label="默认数量">
          <select v-model.number="config.canvas.defaultCount" class="input-field">
            <option :value="1">1 张</option><option :value="2">2 张</option><option :value="4">4 张</option>
            <option :value="8">8 张</option><option :value="16">16 张</option>
          </select>
        </FormField>
        <FormField label="默认尺寸预设">
          <input v-model="config.canvas.defaultSizePresetId" class="input-field font-mono" placeholder="auto" />
        </FormField>
        <FormField label="默认风格预设">
          <input v-model="config.canvas.defaultStylePresetId" class="input-field font-mono" placeholder="none" />
        </FormField>
        <FormField label="历史上限">
          <input v-model.number="config.canvas.maxHistory" type="number" min="1" max="500" class="input-field" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="画布反推库" hint="只用于前台反推库，不与 Bot 的反推命令混用" class="mb-4">
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-semibold">原图反推</span>
            <button class="text-xs hover:underline"
              @click="configStore.resetPrompt('canvas.interrogatePromptTemplate', 'interrogatePromptTemplate')">恢复默认</button>
          </div>
          <ModelPicker capability="interrogate"
            :node-index="config.canvas.interrogateNodeIndex" :model="config.canvas.interrogateModel"
            @update:node-index="config.canvas.interrogateNodeIndex = $event"
            @update:model="config.canvas.interrogateModel = $event" />
          <input v-model.number="config.canvas.interrogateTimeoutMs" type="number" min="30000" step="30000"
            class="input-field mt-2" placeholder="超时 (ms)" />
          <textarea v-model="config.canvas.interrogatePromptTemplate" rows="6" class="input-field font-mono text-xs mt-2"></textarea>
        </div>
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-semibold">模板化反推</span>
            <button class="text-xs hover:underline"
              @click="configStore.resetPrompt('canvas.interrogateTemplatePromptTemplate', 'interrogateTemplatePromptTemplate')">恢复默认</button>
          </div>
          <ModelPicker capability="chat"
            :node-index="config.canvas.interrogateTemplateNodeIndex" :model="config.canvas.interrogateTemplateModel"
            @update:node-index="config.canvas.interrogateTemplateNodeIndex = $event"
            @update:model="config.canvas.interrogateTemplateModel = $event" />
          <input v-model.number="config.canvas.interrogateTemplateTimeoutMs" type="number" min="30000" step="30000"
            class="input-field mt-2" placeholder="超时 (ms)" />
          <textarea v-model="config.canvas.interrogateTemplatePromptTemplate" rows="6" class="input-field font-mono text-xs mt-2"></textarea>
        </div>
      </div>
    </SectionCard>

    <SectionCard title="品牌与存储" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FormField label="前台标题"><input v-model="config.canvas.brand.pageTitle" class="input-field" /></FormField>
        <FormField label="前台 Logo 文字"><input v-model="config.canvas.brand.logoText" class="input-field" /></FormField>
        <FormField label="Favicon 地址"><input v-model="config.canvas.brand.faviconUrl" class="input-field font-mono" /></FormField>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <ToggleField v-model="config.canvas.logs.enabled" label="记录画布日志" />
        <FormField label="最低级别">
          <select v-model="config.canvas.logs.level" class="input-field">
            <option value="debug">debug</option><option value="info">info</option>
            <option value="warn">warn</option><option value="error">error</option>
          </select>
        </FormField>
        <FormField label="内存上限">
          <input v-model.number="config.canvas.logs.maxMemoryEntries" type="number" min="100" max="5000" step="100" class="input-field" />
        </FormField>
        <FormField label="数据目录" hint="留空使用运行时默认目录">
          <input v-model="config.canvas.dataDir" class="input-field font-mono" placeholder="留空使用默认" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="画布记录" :hint="`共 ${cards.length} 条生成与反推记录`" no-padding>
      <template #actions>
        <div class="segmented">
          <button :class="cardFilter === 'all' ? 'on' : ''" @click="cardFilter = 'all'">全部</button>
          <button :class="cardFilter === 'gallery' ? 'on' : ''" @click="cardFilter = 'gallery'">生成</button>
          <button :class="cardFilter === 'interrogation' ? 'on' : ''" @click="cardFilter = 'interrogation'">反推</button>
        </div>
        <button class="btn-outline text-xs" :disabled="cardsLoading" @click="loadCards">
          {{ cardsLoading ? '加载中...' : '刷新' }}
        </button>
      </template>

      <p v-if="cardsError" class="px-4 py-3 status-crit text-xs">{{ cardsError }}</p>
      <div v-else-if="!visibleCards.length" class="px-4 py-8 text-center text-[color:var(--ink-3)] text-sm">
        {{ cardsLoading ? '加载中...' : '还没有记录' }}
      </div>
      <div v-else class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 p-4">
        <div v-for="card in visibleCards" :key="`${card.kind}-${card.id}`"
          class="rounded-lg border border-[color:var(--hairline-2)] overflow-hidden bg-[color:var(--surface)]">
          <img v-if="card.asset?.url" :src="card.asset.url" :alt="card.title"
            class="w-full aspect-square object-cover bg-[color:var(--surface-2)]" loading="lazy" />
          <div v-else class="w-full aspect-square bg-[color:var(--surface-2)] flex items-center justify-center text-[color:var(--ink-3)] text-xs">
            无图
          </div>
          <div class="p-2">
            <div class="text-[11px] text-[color:var(--ink-2)] line-clamp-2 min-h-[2.4em]">{{ card.title || '（无提示词）' }}</div>
            <div class="flex items-center justify-between gap-1 mt-1.5">
              <span class="text-[10px] text-[color:var(--ink-3)] mono truncate">{{ formatTime(card.createdAt) }}</span>
              <button class="btn-danger !px-1.5 !py-0 text-[10px]" @click="deleteCard(card)">删除</button>
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  </div>
</template>
