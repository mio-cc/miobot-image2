<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import SectionCard from '../components/SectionCard.vue';
import ModelPicker from '../components/ModelPicker.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 能力分工——本次重构的核心页。
 *
 * 这些配置散在十几个字段里（chatNodeIndex / imageNodeIndex / editNodeIndex /
 * interrogateNodeIndex / templateNodeIndex / referencedTemplateNodeIndex /
 * templateConvertNodeIndex / translationNodeIndex / videoNodeIndex /
 * freeMode.nodeIndex / promptsChat.smartNodeIndex / canvas.* / bot.tts.preprocess.* …），
 * 分散在各个页面时用户根本无法一眼看出"我这台机器人现在谁在干什么活"。
 * 现在收成一张表：一行一项能力，展开才是详细配置。
 *
 * row.key 必须与后端 admin-service/capabilities.ts 的 SPECS 对齐，
 * 否则体检结果（徽标 / 状态点 / 失败原因）匹配不上。
 */

const configStore = useConfigStore();
const capabilities = useCapabilityStore();
const config = computed(() => configStore.config);

const expanded = ref<string | null>(null);
const imageTestPrompt = ref('一只柴犬');
const imageTestLoading = ref(false);
const imageTestResult = ref<any>(null);

interface Row {
    key: string;
    label: string;
    trigger: string;
    capability: string;
    node: string;
    model: string;
    toggle?: string;
    /** 详细配置在别的页面时给个跳转，不在这里重复一遍。 */
    detailLink?: { to: string; text: string };
}

const rows: Row[] = [
    { key: 'chat', label: '日常对话', trigger: '@bot / 私聊', capability: 'chat',
      node: 'llm.chatNodeIndex', model: 'llm.chatModel', toggle: 'llm.chatEnabled' },
    { key: 'image', label: '文生图', trigger: '画 / 生图 / draw', capability: 'image.generate',
      node: 'llm.imageNodeIndex', model: 'llm.imageModel', toggle: 'llm.imageEnabled' },
    { key: 'edit', label: '改图 / 图生图', trigger: '改图 / i2i', capability: 'image.edit',
      node: 'llm.editNodeIndex', model: 'llm.editModel' },
    { key: 'video', label: '视频生成', trigger: '视频 / video', capability: 'video.generate',
      node: 'llm.videoNodeIndex', model: 'llm.videoModel', toggle: 'llm.videoEnabled' },
    { key: 'interrogate', label: '图片反推', trigger: '反推 / 看图', capability: 'interrogate',
      node: 'llm.interrogateNodeIndex', model: 'llm.interrogateModel' },
    { key: 'enhance', label: '提示词润色', trigger: '画 润色 …', capability: 'chat',
      node: 'llm.enhanceNodeIndex', model: 'llm.enhanceModel', toggle: 'llm.enhanceEnabled' },
    { key: 'template', label: '本地模板填充', trigger: 'mb_1!', capability: 'chat',
      node: 'llm.templateNodeIndex', model: 'llm.templateModel' },
    { key: 'referencedTemplate', label: '引用模板填充', trigger: '套模板 / rt', capability: 'chat',
      node: 'llm.referencedTemplateNodeIndex', model: 'llm.referencedTemplateModel' },
    { key: 'templateConvert', label: 'AI 转模板', trigger: '后台模板库', capability: 'chat',
      node: 'llm.templateConvertNodeIndex', model: 'llm.templateConvertModel',
      detailLink: { to: '/templates', text: '模板库页' } },
    { key: 'translation', label: '远程库翻译', trigger: 'pp / spp', capability: 'chat',
      node: 'llm.translationNodeIndex', model: 'llm.translationModel' },
    { key: 'freeMode', label: '自由模式规划', trigger: '@bot 直接说话', capability: 'chat',
      node: 'freeMode.nodeIndex', model: 'freeMode.model', toggle: 'freeMode.enabled' },
    { key: 'promptsChat', label: '远程库智能选模板', trigger: 'spp', capability: 'chat',
      node: 'promptsChat.smartNodeIndex', model: 'promptsChat.smartModel', toggle: 'promptsChat.enabled',
      detailLink: { to: '/templates', text: '模板库页' } },
    { key: 'tts', label: '语音文本前处理', trigger: '自动朗读前改写', capability: 'chat',
      node: 'bot.tts.preprocess.nodeIndex', model: 'bot.tts.preprocess.model', toggle: 'bot.tts.enabled',
      detailLink: { to: '/voice', text: '语音页' } },
    { key: 'canvasImage', label: '画布文生图', trigger: '画布前台', capability: 'image.generate',
      node: 'canvas.imageNodeIndex', model: 'canvas.imageModel', toggle: 'canvas.enabled',
      detailLink: { to: '/canvas', text: '画布页' } },
    { key: 'canvasEdit', label: '画布改图', trigger: '画布前台', capability: 'image.edit',
      node: 'canvas.editNodeIndex', model: 'canvas.editModel', toggle: 'canvas.enabled',
      detailLink: { to: '/canvas', text: '画布页' } },
    { key: 'canvasInterrogate', label: '画布反推', trigger: '画布前台', capability: 'interrogate',
      node: 'canvas.interrogateNodeIndex', model: 'canvas.interrogateModel', toggle: 'canvas.enabled',
      detailLink: { to: '/canvas', text: '画布页' } },
];

const get = (path: string) => configStore.get(path);
const set = (path: string, value: any) => configStore.set(path, value);

function bindingFor(key: string) {
    return capabilities.bindings.find(item => item.key === key);
}

function toggleRow(key: string) {
    expanded.value = expanded.value === key ? null : key;
}

function learnedOf(key: string) {
    const learned = bindingFor(key)?.learned;
    if (!learned) return '';
    const parts: string[] = [];
    if (learned.dropped?.length) parts.push(`剔除 ${learned.dropped.join('、')}`);
    for (const [from, to] of Object.entries(learned.renamed || {})) parts.push(`${from} → ${to}`);
    return parts.join('；');
}

/* ── 能力覆盖 ───────────────────────────────────────────────
   按模型名推断对中转/反代不一定准。覆盖以模型为键，支持 /正则/i，
   因为一个中转上常常是一整批同前缀的模型都要同样的修正。            */

const OVERRIDABLE = ['chat', 'vision', 'interrogate', 'image.generate', 'image.edit', 'video.generate'];
const overrideModel = ref('');
const overrideOps = ref<string[]>([]);

const overrides = computed(() => config.value?.llm?.capabilityOverrides || []);

function openOverride(row: Row) {
    const model = String(get(row.model) || '');
    overrideModel.value = model;
    const existing = overrides.value.find((item: any) => String(item.model) === model);
    overrideOps.value = existing?.operations ? [...existing.operations] : [...(bindingFor(row.key)?.operations || [])];
}

function saveOverride() {
    const model = overrideModel.value.trim();
    if (!model) return;
    const list = config.value.llm.capabilityOverrides ||= [];
    const idx = list.findIndex((item: any) => String(item.model) === model);
    const entry = { model, operations: [...overrideOps.value] };
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    configStore.saveStatus = '能力覆盖已记录，保存后生效';
    overrideModel.value = '';
}

function removeOverride(model: string) {
    config.value.llm.capabilityOverrides = overrides.value.filter((item: any) => String(item.model) !== model);
    configStore.saveStatus = '已清除该覆盖，保存后生效';
}

async function testImage() {
    imageTestLoading.value = true;
    imageTestResult.value = null;
    try {
        const res = await client.post('/test-image', {
            prompt: imageTestPrompt.value,
            nodeIndex: config.value.llm.imageNodeIndex,
            model: config.value.llm.imageModel,
        });
        imageTestResult.value = res.data;
    } catch (error: any) {
        imageTestResult.value = error?.response?.data || { success: false, error: errorMessage(error) };
    } finally {
        imageTestLoading.value = false;
    }
}

/* ── 并发限制 ─────────────────────────────────────────────── */

const limitRows = computed(() => {
    const llm = config.value?.llm;
    if (!llm) return [];
    return (llm.apiKeys || []).flatMap((node: any, idx: number) => {
        const models = new Set<string>(node.models || []);
        for (const row of rows) {
            if (Number(get(row.node)) === idx && get(row.model)) models.add(String(get(row.model)));
        }
        return [...models].map(model => ({ node, idx, model }));
    });
});

function findLimit(idx: number, model: string) {
    return (config.value?.llm?.modelLimits || []).find((rule: any) =>
        Number(rule.nodeIndex) === Number(idx) && rule.model === model);
}

function ensureLimit(idx: number, model: string) {
    config.value.llm.modelLimits ||= [];
    let rule = findLimit(idx, model);
    if (!rule) {
        rule = { nodeIndex: Number(idx), model, enabled: false, concurrency: 0 };
        config.value.llm.modelLimits.push(rule);
    }
    return rule;
}

function setLimitConcurrency(idx: number, model: string, value: number) {
    const rule = ensureLimit(idx, model);
    rule.concurrency = Math.max(0, Number(value || 0));
    rule.enabled = rule.concurrency > 0;
}

onMounted(() => {
    if (!capabilities.bindings.length) capabilities.refresh();
});
</script>

<template>
  <div v-if="config">
    <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="page-title mb-0.5">能力分工</h1>
        <p class="text-[color:var(--ink-3)] text-xs">
          每项能力用哪个节点、哪个模型。能力徽标由模型 ID 自动识别，中转/反代识别不准时可以手动覆盖。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="capabilities.lastCheckedAt" class="text-[color:var(--ink-3)] text-xs">
          上次检查 {{ capabilities.lastCheckedAt }}
        </span>
        <button class="btn-outline" :disabled="capabilities.loading" @click="capabilities.refresh()">
          {{ capabilities.loading ? '检查中...' : '重新体检' }}
        </button>
      </div>
    </header>

    <p v-if="capabilities.error" class="status-crit text-xs mb-3">{{ capabilities.error }}</p>

    <SectionCard no-padding class="mb-4">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th w-[22%]">能力</th>
            <th class="th w-[16%]">节点</th>
            <th class="th">模型</th>
            <th class="th w-[70px] text-right">状态</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.key">
            <tr class="border-b border-[color:var(--hairline-2)] cursor-pointer hover:bg-[color:var(--surface-2)]"
              @click="toggleRow(row.key)">
              <td class="px-4 py-3">
                <div class="font-semibold">{{ row.label }}</div>
                <div class="mono text-[11px] text-[color:var(--ink-3)]">{{ row.trigger }}</div>
              </td>
              <td class="px-4 py-3 truncate">
                {{ bindingFor(row.key)?.nodeName || config.llm.apiKeys?.[get(row.node)]?.name || '—' }}
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="mono font-medium">{{ get(row.model) || '—' }}</span>
                  <span v-for="cap in bindingFor(row.key)?.operations || []" :key="cap" class="tag">
                    {{ capabilities.labels[cap] || cap }}
                  </span>
                  <span v-if="bindingFor(row.key)?.source === 'override'" class="tag">人工指定</span>
                </div>
                <div v-if="bindingFor(row.key) && !bindingFor(row.key)!.ok" class="status-crit text-[11px] mt-1">
                  {{ bindingFor(row.key)!.reason }}
                </div>
              </td>
              <td class="px-4 py-3 text-right">
                <span class="dot"
                  :class="row.toggle && get(row.toggle) === false ? 'dot-warn' : (bindingFor(row.key)?.ok ? 'dot-good' : 'dot-crit')"></span>
              </td>
            </tr>

            <tr v-if="expanded === row.key" class="bg-[color:var(--surface-2)] border-b border-[color:var(--hairline-2)]">
              <td colspan="4" class="px-4 py-4">
                <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_260px] gap-4">
                  <FormField label="节点与模型"
                    :hint="row.capability === 'video.generate'
                      ? '视频走异步任务制：先提交拿 id，再轮询取结果。已适配 xAI request_id、OpenAI videos、智谱 async-result 三种轮询协议。'
                      : '下拉已按该能力过滤；识别不出能力的模型仍会保留。'">
                    <ModelPicker
                      :node-index="Number(get(row.node)) || 0"
                      :model="String(get(row.model) || '')"
                      :capability="row.capability"
                      :extra-models="['none']"
                      @update:node-index="set(row.node, $event)"
                      @update:model="set(row.model, $event)" />
                  </FormField>

                  <div class="flex flex-col gap-2">
                    <ToggleField v-if="row.toggle" label="启用该能力"
                      :model-value="get(row.toggle) !== false"
                      @update:model-value="set(row.toggle!, $event)" />
                    <button class="btn-outline text-xs" @click.stop="openOverride(row)">能力不对？手动指定</button>
                    <RouterLink v-if="row.detailLink" :to="row.detailLink.to" class="btn-outline text-xs text-center">
                      详细设置在{{ row.detailLink.text }}
                    </RouterLink>
                  </div>
                </div>

                <!-- 各能力的专属参数 -->
                <div v-if="row.key === 'chat'" class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
                  <FormField label="推理强度" hint="仅推理模型生效；不支持的模型会自动不发送该参数">
                    <select v-model="config.llm.reasoningEffort" class="input-field">
                      <option value="low">low</option><option value="medium">medium</option>
                      <option value="high">high</option><option value="xhigh">xhigh</option>
                    </select>
                  </FormField>
                  <FormField label="最大轮数" hint="按用户发言轮数计，建议 6-12">
                    <input v-model.number="config.llm.maxConversationRounds" type="number" min="1" max="100" class="input-field" />
                  </FormField>
                  <FormField label="最大字符数" hint="总上下文达到阈值也会自动开新会话">
                    <input v-model.number="config.llm.maxConversationChars" type="number" min="100" step="100" class="input-field" />
                  </FormField>
                  <FormField label="会话保留（分钟）" hint="超过这个时间没说话就当新会话">
                    <input v-model.number="config.llm.sessionTtlMinutes" type="number" min="1" max="1440" class="input-field" />
                  </FormField>
                  <div class="md:col-span-2">
                    <ToggleField v-model="config.llm.autoNewConversation" label="超限自动开新会话"
                      hint="关掉的话会一直堆上下文，直到模型报超长" />
                  </div>
                </div>

                <div v-if="row.key === 'image'" class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
                  <FormField label="一次生成张数" hint="大于 1 时会合成编号预览图">
                    <input v-model.number="config.llm.imageCount" type="number" min="1" max="4" class="input-field" />
                  </FormField>
                  <FormField label="超时 (ms)"><input v-model.number="config.llm.imageTimeoutMs" type="number" min="30000" step="30000" class="input-field" /></FormField>
                  <FormField label="失败重试"><input v-model.number="config.llm.imageRetryCount" type="number" min="0" max="5" class="input-field" /></FormField>
                  <FormField label="重试间隔 (ms)"><input v-model.number="config.llm.imageRetryDelayMs" type="number" min="0" step="500" class="input-field" /></FormField>
                  <div class="md:col-span-2">
                    <ToggleField v-model="config.llm.safeRewriteOnFailure" label="失败后合规改写重试"
                      hint="被内容策略拒了就让模型换个说法再试一次" />
                  </div>
                  <div class="md:col-span-2 flex gap-2 items-end">
                    <FormField label="测试生图" class="flex-1">
                      <input v-model="imageTestPrompt" class="input-field" placeholder="测试提示词" />
                    </FormField>
                    <button class="btn-outline text-xs whitespace-nowrap" :disabled="imageTestLoading" @click.stop="testImage">
                      {{ imageTestLoading ? '测试中...' : '发起测试' }}
                    </button>
                  </div>
                  <div v-if="imageTestResult" class="md:col-span-4 text-xs rounded-lg border border-[color:var(--hairline-2)] px-3 py-2"
                    :class="imageTestResult.success ? 'status-good' : 'status-crit'">
                    {{ imageTestResult.success ? `生图 API 正常 · 返回 ${imageTestResult.count} 张` : `生图 API 异常：${imageTestResult.error}` }}
                    <img v-if="imageTestResult.image" :src="imageTestResult.image" alt="测试生成结果"
                      class="mt-2 rounded-md max-h-40 border border-[color:var(--hairline-2)]" />
                  </div>
                </div>

                <div v-if="row.key === 'edit'" class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  <FormField label="改图请求格式"
                    hint="auto 会按模型自动排序：官方 gpt-image 只认 multipart，xAI 只认 JSON，多数中转认 json-images">
                    <select v-model="config.llm.imageEditRequestMode" class="input-field">
                      <option value="auto">auto（按模型自动选择）</option>
                      <option value="json-images">json-images</option>
                      <option value="json-image">json-image</option>
                      <option value="multipart">multipart</option>
                    </select>
                  </FormField>
                </div>

                <div v-if="row.key === 'video'" class="mt-4">
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <FormField label="单次请求超时 (ms)" hint="提交任务与每次轮询各自的 HTTP 超时">
                      <input v-model.number="config.llm.videoTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
                    </FormField>
                    <FormField label="轮询总上限 (ms)" hint="含排队，生成通常 1-5 分钟">
                      <input v-model.number="config.llm.videoPollTimeoutMs" type="number" min="60000" step="60000" class="input-field" />
                    </FormField>
                    <FormField label="轮询间隔 (ms)">
                      <input v-model.number="config.llm.videoPollIntervalMs" type="number" min="1000" step="1000" class="input-field" />
                    </FormField>
                  </div>
                  <p class="text-[color:var(--ink-3)] text-[11px] mt-3 leading-relaxed">
                    QQ 侧的限制：WebSocket 帧上限 50MB，base64 会把体积撑大约 1.34 倍，
                    因此超过 ~37MB 的视频走 base64 会直接把连接顶断。系统会先检查大小，
                    超限时改用文件路径发送或提示改走文件；配置里填好「Docker 路径映射」可以完全避开 base64。
                  </p>
                </div>

                <div v-if="row.key === 'interrogate'" class="grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] gap-4 mt-4">
                  <FormField label="超时 (ms)">
                    <input v-model.number="config.llm.interrogateTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
                  </FormField>
                  <FormField label="反推提示词" hint="只影响 Bot 的反推命令；画布反推库在画布页单独配置">
                    <textarea v-model="config.llm.interrogatePromptTemplate" rows="4" class="input-field font-mono text-xs"></textarea>
                  </FormField>
                </div>

                <div v-if="row.key === 'enhance'" class="mt-4">
                  <FormField label="润色提示词" hint="可用占位符 {{rawPrompt}}">
                    <textarea v-model="config.llm.enhancePromptTemplate" rows="5" class="input-field font-mono text-xs"></textarea>
                  </FormField>
                </div>

                <div v-if="row.key === 'template'" class="mt-4">
                  <FormField label="本地模板填充提示词" hint="占位符 {{templatePrompt}}、{{rawPrompt}}">
                    <textarea v-model="config.llm.templatePromptTemplate" rows="5" class="input-field font-mono text-xs"></textarea>
                  </FormField>
                </div>

                <div v-if="row.key === 'referencedTemplate'" class="grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] gap-4 mt-4">
                  <FormField label="超时 (ms)">
                    <input v-model.number="config.llm.referencedTemplateTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
                  </FormField>
                  <FormField label="引用模板填充提示词" hint="占位符 {{templatePrompt}}、{{rawPrompt}}">
                    <textarea v-model="config.llm.referencedTemplatePromptTemplate" rows="4" class="input-field font-mono text-xs"></textarea>
                  </FormField>
                </div>

                <div v-if="row.key === 'translation'" class="mt-4">
                  <FormField label="翻译提示词" hint="占位符 {{mode}}、{{input}}">
                    <textarea v-model="config.llm.translationPromptTemplate" rows="4" class="input-field font-mono text-xs"></textarea>
                  </FormField>
                </div>

                <div v-if="row.key === 'freeMode'" class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
                  <FormField label="规划超时 (ms)"><input v-model.number="config.freeMode.timeoutMs" type="number" min="30000" step="30000" class="input-field" /></FormField>
                  <FormField label="最多输入图"><input v-model.number="config.freeMode.maxInputImages" type="number" min="0" max="12" class="input-field" /></FormField>
                  <FormField label="最多引用消息"><input v-model.number="config.freeMode.maxReferencedMessages" type="number" min="0" max="80" class="input-field" /></FormField>
                  <FormField label="最多输出图"><input v-model.number="config.freeMode.maxOutputImages" type="number" min="1" max="4" class="input-field" /></FormField>
                  <div class="md:col-span-2"><ToggleField v-model="config.freeMode.includeQuotedMessage" label="读取被引用的消息" /></div>
                  <div class="md:col-span-2"><ToggleField v-model="config.freeMode.preferEditWhenImagePresent" label="有图时优先按改图处理" /></div>
                  <div class="md:col-span-4">
                    <FormField label="规划提示词" hint="占位符 {{userContent}}；规划器必须输出 JSON">
                      <textarea v-model="config.freeMode.plannerPromptTemplate" rows="6" class="input-field font-mono text-xs"></textarea>
                    </FormField>
                  </div>
                </div>

                <div v-if="learnedOf(row.key)" class="mt-3 text-xs text-[color:var(--ink-3)]">
                  运行中已自动适配：{{ learnedOf(row.key) }}
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </SectionCard>

    <!-- 能力覆盖 -->
    <SectionCard title="手动指定能力" class="mb-4"
      hint="按模型名推断对中转和反代不一定准。这里指定的结果优先级最高，模型名支持 /正则/i。">
      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] gap-3 items-end">
        <FormField label="模型（或正则）">
          <input v-model="overrideModel" class="input-field font-mono" placeholder="claude-sonnet-4 或 /^my-relay-/i" />
        </FormField>
        <FormField label="具备的能力">
          <div class="flex flex-wrap gap-3 pt-1">
            <label v-for="cap in OVERRIDABLE" :key="cap" class="flex items-center gap-1.5 text-xs">
              <input type="checkbox" :value="cap" v-model="overrideOps" class="h-4 w-4" />
              {{ capabilities.labels[cap] || cap }}
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
              <span v-for="cap in item.operations || []" :key="cap" class="tag mr-1">
                {{ capabilities.labels[cap] || cap }}
              </span>
              <span v-if="!(item.operations || []).length" class="text-[color:var(--ink-3)]">（未勾选任何能力 = 全部禁用）</span>
            </td>
            <td class="py-2.5 text-right">
              <button class="btn-danger text-xs" @click="removeOverride(item.model)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-[color:var(--ink-3)] text-xs mt-4">还没有任何覆盖，所有能力都按模型 ID 自动推断。</p>
    </SectionCard>

    <SectionCard title="并发限制" hint="对慢模型排队，避免打爆上游。并发 0 表示不限制" no-padding>
      <table v-if="limitRows.length" class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th">节点 / 模型</th>
            <th class="th w-[140px]">并发数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in limitRows" :key="`${item.idx}-${item.model}`" class="border-b border-[color:var(--hairline-2)] last:border-b-0">
            <td class="px-4 py-2.5">
              <div class="text-[color:var(--ink-3)] text-[11px]">{{ item.node.name || `节点 ${item.idx + 1}` }}</div>
              <div class="mono">{{ item.model }}</div>
            </td>
            <td class="px-4 py-2.5">
              <input type="number" min="0" step="1" class="input-field"
                :value="findLimit(item.idx, item.model)?.concurrency || 0"
                @input="setLimitConcurrency(item.idx, item.model, Number(($event.target as HTMLInputElement).value))" />
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="p-4 text-[color:var(--ink-3)] text-sm">
        还没有已保存模型。先去「API 节点」页点「获取模型」。
      </p>
    </SectionCard>
  </div>
</template>
