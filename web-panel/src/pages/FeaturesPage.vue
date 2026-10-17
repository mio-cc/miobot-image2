<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

interface FeatureDefinition {
  id: string;
  label: string;
  description?: string;
  category: string;
  implemented: boolean;
  intentKind?: string;
  defaultAliases: string[];
  defaultScopes: string[];
  defaultGroupActivation: string;
  limitFields?: Array<{ key: string; label: string; min: number; max: number; default: number; unit?: string }>;
}

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const definitions = ref<FeatureDefinition[]>([]);
const commonLimitFields = ref<Array<{ key: string; label: string; min: number; max: number; default: number; unit?: string }>>([]);
const loading = ref(false);
const loadError = ref('');

const CATEGORY_LABELS: Record<string, string> = {
  basic: '基础命令',
  image: '图片',
  file: '文件',
  video: '视频',
  template: '模板',
  web: '联网搜索',
  system: '系统',
};

const ACTIVATION_OPTIONS = [
  { value: 'direct', label: '群里直接触发' },
  { value: 'mention', label: '必须 @机器人' },
  { value: 'reply', label: '必须回复机器人' },
  { value: 'mention-or-reply', label: '@ 或回复机器人' },
];

const settings = computed<Record<string, any>>(() => config.value?.bot?.features || {});

function ensureSetting(def: FeatureDefinition): any {
  const store = settings.value;
  if (!store[def.id]) {
    store[def.id] = {
      enabled: Boolean(def.implemented),
      aliases: [...def.defaultAliases],
      scopes: [...def.defaultScopes],
      groupActivation: def.defaultGroupActivation,
      naturalLanguage: Boolean(def.intentKind),
      limits: {},
    };
  }
  return store[def.id];
}

const grouped = computed(() => {
  const out: Array<{ category: string; label: string; items: Array<{ def: FeatureDefinition; setting: any }> }> = [];
  for (const category of ['basic', 'image', 'file', 'video', 'template', 'web', 'system']) {
    const items = definitions.value
      .filter((def) => def.category === category)
      .map((def) => ({ def, setting: ensureSetting(def) }));
    if (items.length) out.push({ category, label: CATEGORY_LABELS[category] || category, items });
  }
  return out;
});

const collisions = computed(() => {
  const owners = new Map<string, string[]>();
  for (const def of definitions.value) {
    const setting = ensureSetting(def);
    if (!setting.enabled) continue;
    for (const alias of setting.aliases || []) {
      const key = String(alias).trim().toLowerCase();
      if (!key) continue;
      owners.set(key, [...(owners.get(key) || []), def.label]);
    }
  }
  return [...owners.entries()].filter(([, names]) => names.length > 1);
});

function aliasesText(setting: any): string {
  return (setting.aliases || []).join(', ');
}
const fileFormatHelp = [
  { ext: '.md', how: '生成一份 Markdown 介绍文档 / 生成 md 文档', note: 'Markdown 纯文本' },
  { ext: '.docx', how: '生成一份 Word 项目周报 / 生成 docx 文档', note: '支持封面、主题配色、表格、提示框' },
  { ext: '.xlsx', how: '生成一个 Excel 销售表格 / 生成 xlsx 表格', note: '工作表与行列数据' },
  { ext: '.pptx', how: '生成一份 PPT 项目汇报 / 生成 pptx 幻灯片', note: '封面与多页内容' },
  { ext: '.pdf', how: '生成一份 PDF 报告', note: 'A4 文档' },
  { ext: '.txt', how: '生成一个 txt 文件', note: '纯文本' },
  { ext: '.csv', how: '生成 csv 数据文件', note: '一行一个记录' },
  { ext: '.json', how: '生成 json 文件', note: '结构化数据' },
  { ext: '.zip', how: '生成一个 zip 压缩包', note: '多个文件打包' },
];

const quickCommands = computed(() => definitions.value
  .filter((def) => def.implemented)
  .map((def) => {
    const setting = ensureSetting(def);
    return {
      id: def.id,
      label: def.label,
      aliases: (setting.aliases || []).slice(0, 8),
      enabled: Boolean(setting.enabled),
    };
  }));


function updateAliases(setting: any, event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  setting.aliases = Array.from(new Set(raw.split(/[,，、;；|\n]/).map((item) => item.trim()).filter(Boolean)));
}

function hasScope(setting: any, scope: 'private' | 'group'): boolean {
  return (setting.scopes || []).includes(scope);
}

function toggleScope(setting: any, scope: 'private' | 'group') {
  const current = new Set(setting.scopes || []);
  if (current.has(scope)) current.delete(scope); else current.add(scope);
  if (!current.size) current.add(scope);
  setting.scopes = [...current];
}

function fieldsFor(def: FeatureDefinition) {
  return [...commonLimitFields.value, ...(def.limitFields || [])];
}

async function loadFeatures() {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await client.get('/features');
    definitions.value = res.data?.definitions || [];
    commonLimitFields.value = res.data?.commonLimitFields || [];
    for (const def of definitions.value) {
      const setting = ensureSetting(def);
      if (!Array.isArray(setting.aliases)) setting.aliases = [...def.defaultAliases];
      if (!Array.isArray(setting.scopes) || !setting.scopes.length) setting.scopes = [...def.defaultScopes];
      if (!setting.groupActivation) setting.groupActivation = def.defaultGroupActivation;
      if (typeof setting.naturalLanguage !== 'boolean') setting.naturalLanguage = Boolean(def.intentKind);
      if (!setting.limits || typeof setting.limits !== 'object') setting.limits = {};
      for (const field of fieldsFor(def)) {
        if (typeof setting.limits[field.key] !== 'number') setting.limits[field.key] = field.default;
      }
    }
  } catch (error: any) {
    loadError.value = errorMessage(error, '加载功能目录失败');
  } finally {
    loading.value = false;
  }
}

onMounted(loadFeatures);
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">命令与意图</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        功能目录由后端统一提供；这里修改命令别名、触发方式、私聊/群聊范围和 FreeMode 自然语言识别。保存使用右上角全局保存。
      </p>
    </header>

    <div v-if="loading" class="text-sm text-[color:var(--ink-3)] mb-4">正在加载功能目录...</div>
    <div v-if="loadError" class="status-crit text-sm mb-4">{{ loadError }}</div>
    <div v-if="collisions.length" class="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs status-crit mb-4">
      <div class="font-medium mb-1">命令别名冲突：</div>
      <div v-for="[alias, names] in collisions" :key="alias">
        {{ alias }} 同时属于 {{ names.join(' / ') }}
      </div>
    </div>

    <SectionCard title="命令速查" hint="这里展示当前已登记的命令别名；实际别名可在下方逐项修改" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <div v-for="cmd in quickCommands" :key="cmd.id" class="rounded-lg border border-[color:var(--hairline-2)] p-3">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xs font-medium">{{ cmd.label }}</span>
            <span class="tag">{{ cmd.enabled ? '已启用' : '已关闭' }}</span>
          </div>
          <div class="flex flex-wrap gap-1">
            <code v-for="alias in cmd.aliases" :key="alias" class="text-[11px] px-1.5 py-0.5 rounded bg-[color:var(--surface-2)]">{{ alias }}</code>
            <span v-if="!cmd.aliases.length" class="text-xs text-[color:var(--ink-3)]">尚未配置别名</span>
          </div>
        </div>
      </div>
    </SectionCard>

    <SectionCard title="文件生成格式怎么指定" hint="自然语言和显式命令都可以；模型会先判断是不是文件生成请求" class="mb-4">
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead><tr class="border-b border-[color:var(--hairline-2)]"><th class="text-left py-2 pr-4">格式</th><th class="text-left py-2 pr-4">这样说</th><th class="text-left py-2">说明</th></tr></thead>
          <tbody>
            <tr v-for="item in fileFormatHelp" :key="item.ext" class="border-b border-[color:var(--hairline-2)]">
              <td class="py-2 pr-4 font-mono font-semibold">{{ item.ext }}</td>
              <td class="py-2 pr-4">{{ item.how }}</td>
              <td class="py-2 text-[color:var(--ink-3)]">{{ item.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-3 text-xs text-[color:var(--ink-3)] leading-5">
        <p>也可以使用显式命令：<code class="font-mono">生成文件 ...</code>、<code class="font-mono">生成文档 ...</code>、<code class="font-mono">导出文件 ...</code>。</p>
        <p>没有明确格式时：提到「Word / 文档」默认生成 docx，提到「Excel / 表格」默认生成 xlsx，提到「PPT / 幻灯片」默认生成 pptx，提到「md / Markdown」优先生成 md；都没有则默认 txt。</p>
        <p>文件生成意图可以在「能力分工 → 文件生成意图」选择独立模型；模型失败或低置信度时自动回退正则。</p>
      </div>
    </SectionCard>

    <SectionCard v-for="group in grouped" :key="group.category" :title="group.label" class="mb-4">
      <div class="space-y-3">
        <div v-for="{ def, setting } in group.items" :key="def.id"
          class="rounded-lg border border-[color:var(--hairline-2)] p-3"
          :class="def.implemented ? '' : 'opacity-60'">
          <div class="flex flex-wrap items-center gap-2 mb-3">
            <span class="tag">{{ def.id }}</span>
            <span class="font-medium text-sm">{{ def.label }}</span>
            <span v-if="!def.implemented" class="tag">未实现</span>
            <span class="flex-1"></span>
            <ToggleField v-model="setting.enabled" label="启用" :disabled="!def.implemented" />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="命令别名" hint="逗号分隔；最长别名优先匹配">
              <input :value="aliasesText(setting)" @change="updateAliases(setting, $event)"
                class="input-field font-mono text-xs" :disabled="!def.implemented"
                placeholder="例如：生图, 画, draw" />
            </FormField>

            <FormField label="生效范围" hint="至少选择一个">
              <div class="flex gap-2">
                <button type="button" class="btn-outline text-xs"
                  :class="hasScope(setting, 'private') ? '!border-[color:var(--accent)] !text-[color:var(--accent)]' : ''"
                  :disabled="!def.implemented" @click="toggleScope(setting, 'private')">私聊</button>
                <button type="button" class="btn-outline text-xs"
                  :class="hasScope(setting, 'group') ? '!border-[color:var(--accent)] !text-[color:var(--accent)]' : ''"
                  :disabled="!def.implemented" @click="toggleScope(setting, 'group')">群聊</button>
              </div>
            </FormField>

            <FormField label="群聊触发方式" hint="只影响显式命令；自然语言仍受 FreeMode 开关控制">
              <select v-model="setting.groupActivation" class="input-field" :disabled="!def.implemented || !hasScope(setting, 'group')">
                <option v-for="opt in ACTIVATION_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </FormField>

            <FormField v-if="def.intentKind" label="自然语言识别" hint="关闭后 FreeMode 不再自动路由到该功能，显式命令仍然可用">
              <ToggleField v-model="setting.naturalLanguage" label="允许 FreeMode 识别" :disabled="!def.implemented || !setting.enabled" />
            </FormField>
          </div>

          <div v-if="def.implemented && fieldsFor(def).length" class="mt-4 pt-3 border-t border-[color:var(--hairline-2)]">
            <div class="text-xs font-medium mb-2">限额与频率</div>
            <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              <label v-for="field in fieldsFor(def)" :key="field.key" class="block">
                <span class="block text-[11px] text-[color:var(--ink-3)] mb-1">{{ field.label }}<template v-if="field.unit">（{{ field.unit }}）</template></span>
                <input type="number" v-model.number="setting.limits[field.key]" :min="field.min" :max="field.max"
                  class="input-field !py-1.5 text-xs" />
              </label>
            </div>
          </div>

          <p v-if="!def.implemented" class="text-[color:var(--ink-3)] text-xs mt-3">
            该功能已登记但 handler 尚未完成；可以保留默认别名，但不能启用。
          </p>
        </div>
      </div>
    </SectionCard>
  </div>
</template>
