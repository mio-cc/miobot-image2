<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useConfigStore } from '../stores/config';
import FormField from './FormField.vue';
import ToggleField from './ToggleField.vue';
import AppSelect from './AppSelect.vue';

/**
 * 节点编辑抽屉（节点级字段的唯一编辑入口，替代旧折叠区）。
 * 字段直写 config.llm.apiKeys[idx] 的节点对象（无本地副本）——切换 kind 只是
 * 显隐切换，字段值不丢；关闭抽屉改动保留，统一走顶栏「保存并热重载」。
 * 消费证据：kind→apps/bot/src/start.ts / deps.ts / capability-basic.ts（comfyui 节点
 * 走独立管线）；provider/headers→packages/model/src/dialects/*（13 处方言适配）；
 * concurrency 0=不限（0-256）；comfyui 六参→ComfyUiNodeConfig + ComfyUI 管线。
 */
const props = defineProps<{
    open: boolean;
    node: any;
    idx: number;
    fetching: boolean;
    summary: string;
    error: string;
    latencyLabel: string;
}>();

const emit = defineEmits<{
    close: [];
    fetch: [idx: number];
}>();

const configStore = useConfigStore();

const NODE_KINDS = [
    { value: 'llm', label: 'LLM / 图像模型节点' },
    { value: 'comfyui', label: 'ComfyUI 独立节点' },
];
const PROVIDERS = [
    { value: '', label: 'openai' },
    { value: 'anthropic', label: 'anthropic' },
    { value: 'gemini', label: 'gemini' },
    { value: 'huggingface', label: 'huggingface' },
    { value: 'custom', label: 'custom' },
];

const isComfyui = computed(() => props.node?.kind === 'comfyui');

/* 显示值兜底：老节点未写 kind 按 llm 呈现；comfyui 方言在显示层锁定 custom——
   仅呈现口径，不回写配置，避免「只是打开看看」就产生脏标记。 */
const kindValue = computed(() => (isComfyui.value ? 'comfyui' : 'llm'));
const providerValue = computed(() => (isComfyui.value ? 'custom' : String(props.node?.provider ?? '')));

/* enabled 未写 = 启用（与卡片状态点同一口径），开关写入时才落 true/false。 */
const enabledModel = computed({
    get: () => props.node?.enabled !== false,
    set: (value: boolean) => { if (props.node) props.node.enabled = value; },
});

function ensureComfyui() {
    const node = props.node;
    if (node && !node.comfyui) {
        node.comfyui = { pollTimeoutMs: 600000, pollIntervalMs: 2000, maxBatchSize: 4, maxConcurrent: 1, maxQueue: 10, queueTimeoutMs: 900000, profiles: [] };
    }
    return node?.comfyui;
}

function headersText(): string {
    return Object.entries(props.node?.headers || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
}

function commitHeaders(event: Event) {
    const raw = (event.target as HTMLTextAreaElement).value;
    const headers: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key) headers[key] = value;
    }
    if (props.node) props.node.headers = headers;
}

/* 与顶栏同一套保存态语义：保存流程文案优先（失败红），否则有未保存修改时挂徽标。 */
const saveBadge = computed(() => {
    if (configStore.saveStatus) {
        return { text: configStore.saveStatus, crit: configStore.saveStatus.includes('失败') };
    }
    return configStore.dirty ? { text: '有未保存修改', crit: false } : null;
});

const models = computed<string[]>(() => props.node?.models || []);
const fetchedAt = computed(() => (props.node?.modelsFetchedAt
    ? new Date(props.node.modelsFetchedAt).toLocaleString('zh-CN', { hour12: false })
    : ''));

/* Esc 关抽屉：AppSelect 面板自己处理过的 Esc（defaultPrevented）不再冒泡语义；
   IME 拼字中的 Esc 是取消输入，也不当「关闭抽屉」。 */
function onKeydown(e: KeyboardEvent) {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.key === 'Escape') emit('close');
}

const panelRef = ref<HTMLElement | null>(null);
watch(() => props.open, (open) => {
    if (typeof document === 'undefined') return;
    if (open) {
        document.addEventListener('keydown', onKeydown);
        nextTick(() => panelRef.value?.focus());
    } else {
        document.removeEventListener('keydown', onKeydown);
    }
});
onBeforeUnmount(() => {
    if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="node-drawer">
      <div v-if="open && node" class="node-drawer-root">
        <div class="node-drawer-backdrop" @click="emit('close')"/>
        <section ref="panelRef" class="node-drawer-panel" tabindex="-1" role="dialog" aria-modal="true"
          :aria-label="`编辑节点：${node.name || `节点 ${idx + 1}`}`">
          <!-- 顶部：节点名 + 保存态徽标 + 关闭 -->
          <header class="node-drawer-head">
            <div class="min-w-0 flex-1">
              <div class="text-[15px] font-bold text-[color:var(--ink)] truncate">{{ node.name || `节点 ${idx + 1}` }}</div>
              <div v-if="latencyLabel && latencyLabel !== '—'" class="text-[11px] text-[color:var(--ink-3)] mono truncate">{{ latencyLabel }}</div>
            </div>
            <span v-if="saveBadge" class="flex-none text-xs" :class="saveBadge.crit ? 'status-crit' : 'status-good'">{{ saveBadge.text }}</span>
            <button class="node-drawer-close" type="button" aria-label="关闭抽屉（改动保留）" title="关闭（改动保留）" @click="emit('close')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </header>

          <!-- 字段区：直写节点对象，切 kind 只切显隐，值不丢 -->
          <div class="node-drawer-body">
            <div class="grid grid-cols-2 max-[680px]:grid-cols-1 gap-3">
              <FormField label="节点名称">
                <input v-model="node.name" class="input-field text-xs" placeholder="My Node" />
              </FormField>
              <FormField label="节点类型" hint="llm=模型节点（参与分工）；comfyui=独立出图节点（不参与分工）">
                <AppSelect :model-value="kindValue" :options="NODE_KINDS" @update:model-value="node.kind = String($event)" />
              </FormField>
            </div>

            <FormField label="协议方言"
              :hint="isComfyui ? 'ComfyUI 节点固定使用 custom 方言' : '决定端点/请求体形态与原生 tool calling 适配：openai/anthropic/gemini 用原生工具调用，其余自动 JSON fallback'">
              <AppSelect :model-value="providerValue" :options="PROVIDERS" :disabled="isComfyui" @update:model-value="!isComfyui && (node.provider = String($event))" />
            </FormField>

            <FormField label="Base URL">
              <input v-model="node.baseUrl" class="input-field font-mono text-xs" placeholder="https://api.example.com/v1" />
            </FormField>

            <FormField label="API Key" :hint="node.hasKey ? '已保存密钥；要更换请直接输入新值（面板上的打码值不会被保存覆盖）' : '尚未设置密钥'">
              <input v-model="node.key" type="password" class="input-field font-mono text-xs" placeholder="sk-…" />
            </FormField>

            <div class="grid grid-cols-2 max-[680px]:grid-cols-1 gap-3 items-end">
              <FormField label="并发上限" hint="0 = 不限。上游按 key 发额度，所以限流单位是节点">
                <input v-model.number="node.concurrency" type="number" min="0" max="256" class="input-field" />
              </FormField>
              <ToggleField v-model="enabledModel" label="启用节点" class="w-full" />
            </div>

            <FormField label="自定义请求头" hint="每行 Name: value；支持 apiKey、env:ENV_NAME 和 $ENV:ENV_NAME 占位符">
              <textarea :value="headersText()" @change="commitHeaders" rows="3"
                class="input-field font-mono text-xs" placeholder="X-Custom-Header: value"></textarea>
            </FormField>

            <!-- llm：模型列表（拉取 + 标签 + 时间戳） -->
            <div v-if="!isComfyui" class="node-drawer-section">
              <div class="flex items-center gap-2 mb-2">
                <span class="label-sm !mb-0 flex-1">模型列表（{{ models.length }}）</span>
                <button class="btn-outline text-xs" :disabled="fetching" @click="emit('fetch', idx)">{{ fetching ? '拉取中…' : '拉取模型列表' }}</button>
              </div>
              <p v-if="fetchedAt" class="text-[11px] text-[color:var(--ink-3)] mb-1.5">上次拉取：{{ fetchedAt }}</p>
              <p v-if="summary" class="status-good text-[10.5px] bg-[color:var(--off-soft)] border border-[color:var(--hairline-2)] rounded-md px-2 py-1 mb-1.5 leading-relaxed">{{ summary }}</p>
              <p v-if="error" class="flex items-start gap-2 text-[10.5px] status-crit bg-[color:var(--critical-soft)] border border-[color:var(--hairline-2)] rounded-md px-2 py-1 mb-1.5 leading-relaxed">
                <span class="min-w-0 flex-1">{{ error }}</span>
                <button class="flex-none underline underline-offset-2" :disabled="fetching" @click="emit('fetch', idx)">重试</button>
              </p>
              <div v-if="models.length" class="flex flex-wrap gap-1 max-h-[168px] overflow-y-auto content-center">
                <span v-for="m in models" :key="m" class="text-[10.5px] bg-[color:var(--off-soft)] text-[color:var(--ink-2)] rounded-md px-1.5 py-0.5 font-mono">{{ m }}</span>
              </div>
              <p v-else class="text-[11px] text-[color:var(--ink-3)]">填好 Base URL 与 API Key 后点「拉取模型列表」。</p>
            </div>

            <!-- comfyui：Profiles 跳转提示 + ComfyUI 六参 -->
            <template v-else>
              <div class="bg-[color:var(--accent-soft)] border border-[color:var(--accent-line)] rounded-lg px-3 py-2.5 text-xs text-[color:var(--ink-2)] leading-relaxed">
                ComfyUI 节点不使用模型列表——工作流与 Profiles 在「图片生成」页编辑。
                <RouterLink to="/cap-image" class="font-medium text-[color:var(--accent)] hover:underline ml-1">前往图片生成页 →</RouterLink>
              </div>
              <div class="node-drawer-section grid grid-cols-2 max-[680px]:grid-cols-1 gap-3">
                <FormField label="最大并发" hint="默认 1"><input v-model.number="ensureComfyui().maxConcurrent" type="number" min="1" class="input-field" /></FormField>
                <FormField label="队列上限" hint="默认 10"><input v-model.number="ensureComfyui().maxQueue" type="number" min="1" class="input-field" /></FormField>
                <FormField label="排队超时 (ms)" hint="默认 900000"><input v-model.number="ensureComfyui().queueTimeoutMs" type="number" min="1000" step="1000" class="input-field" /></FormField>
                <FormField label="轮询超时 (ms)" hint="默认 600000"><input v-model.number="ensureComfyui().pollTimeoutMs" type="number" min="1000" step="1000" class="input-field" /></FormField>
                <FormField label="轮询间隔 (ms)" hint="默认 2000"><input v-model.number="ensureComfyui().pollIntervalMs" type="number" min="500" step="500" class="input-field" /></FormField>
                <FormField label="最大批量" hint="默认 4"><input v-model.number="ensureComfyui().maxBatchSize" type="number" min="1" class="input-field" /></FormField>
              </div>
            </template>
          </div>

          <footer class="node-drawer-foot">
            改动即时写入配置，关闭抽屉不丢失；顶部「保存并热重载」后生效。
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.node-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9980;
  background: color-mix(in srgb, var(--ink) 32%, transparent);
}
/* 桌面：右侧 520px 抽屉（z-index 低于 AppSelect 的 9990/9991，抽屉内的下拉能盖住抽屉） */
.node-drawer-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 9981;
  width: 520px;
  max-width: calc(100vw - 24px);
  background: var(--surface);
  border-left: 1px solid var(--hairline-2);
  box-shadow: var(--sh-2);
  display: flex;
  flex-direction: column;
  outline: none;
}
.node-drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--hairline-2);
  flex: none;
}
.node-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.node-drawer-section {
  border-top: 1px dashed var(--hairline-2);
  padding-top: 12px;
}
.node-drawer-foot {
  flex: none;
  padding: 10px 18px;
  border-top: 1px solid var(--hairline-2);
  background: var(--page);
  color: var(--ink-3);
  font-size: 11px;
}
.node-drawer-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--hairline-3);
  border-radius: 9px;
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
  transition: color 0.15s var(--ease), border-color 0.15s var(--ease);
  flex: none;
}
.node-drawer-close:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* 进出场：遮罩淡入 + 面板滑入（桌面右滑 / 移动端上滑） */
.node-drawer-enter-active .node-drawer-backdrop,
.node-drawer-leave-active .node-drawer-backdrop { transition: opacity 0.22s var(--ease); }
.node-drawer-enter-from .node-drawer-backdrop,
.node-drawer-leave-to .node-drawer-backdrop { opacity: 0; }
.node-drawer-enter-active .node-drawer-panel,
.node-drawer-leave-active .node-drawer-panel { transition: transform 0.3s var(--ease); }
.node-drawer-enter-from .node-drawer-panel,
.node-drawer-leave-to .node-drawer-panel { transform: translateX(100%); }

/* ── 移动端（≤680px）：底部全宽 sheet，与 AppSelect 同规范 ── */
@media (max-width: 680px) {
  .node-drawer-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-width: none;
    max-height: min(88dvh, 760px);
    border-left: none;
    border-top: 1px solid var(--hairline-2);
    border-radius: 16px 16px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .node-drawer-enter-from .node-drawer-panel,
  .node-drawer-leave-to .node-drawer-panel { transform: translateY(100%); }
  .node-drawer-body { padding: 14px 16px; gap: 12px; }
  /* 44px 触控目标 */
  .node-drawer-body :deep(input.input-field),
  .node-drawer-body :deep(textarea.input-field),
  .node-drawer-body :deep(.app-select-trigger) { min-height: 44px; }
  .node-drawer-close { width: 44px; height: 44px; }
}
</style>
