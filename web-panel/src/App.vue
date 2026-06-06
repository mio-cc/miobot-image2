// @START [TASK-001]: 顶级暗色玻璃拟态UI与丝滑响应式交互重构
<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount, nextTick } from 'vue';
import axios from 'axios';

const API_BASE = `${window.location.origin}/api`;

type LogEntry = {
  id: number;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  details?: unknown;
};

type CanvasManagedCard = {
  kind: 'gallery' | 'interrogation';
  id: string;
  title: string;
  subtitle: string;
  createdAt: string;
  favorite?: boolean;
  status?: string;
  asset?: {
    id: string;
    url?: string;
    fileName?: string;
    width?: number;
    height?: number;
  };
};

type ModelRouteItem = {
  id: string;
  title: string;
  description: string;
  badge?: string;
  nodePath: string[];
  modelPath: string[];
  placeholder?: string;
  extraModels?: string[];
  enabledPath?: string[];
};

type ModelRouteGroup = {
  id: string;
  title: string;
  subtitle: string;
  items: ModelRouteItem[];
};

type ModelRoutePathTarget = 'node' | 'model';

// ─── Toasts 通知系统 ───
type Toast = {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
};
const toasts = ref<Toast[]>([]);
let toastIdCounter = 0;
function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const id = toastIdCounter++;
  toasts.value.push({ id, message, type });
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id);
  }, 4000);
}

function clampLogLimit(value: unknown, fallback = 300) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(5000, parsed)) : fallback;
}

function readSavedLogLimit(key: string, fallback = 300) {
  return clampLogLimit(localStorage.getItem(key), fallback);
}

const isAuthenticated = ref(false);
const password = ref('');
const loginError = ref('');
const token = ref(localStorage.getItem('np_token') || '');
const config = ref<any>(null);
const savedConfigSnapshot = ref<any>(null);
const savingConfig = ref(false);
const saveStatus = ref('');
const currentPage = ref('about');
const fetchedModels = ref<string[]>([]);
const modelLoading = ref(false);
const modelError = ref('');
const hfModelsLoading = ref(false);
const hfModelsError = ref('');
const hfFetchStatus = ref('');
const napcatTestLoading = ref(false);
const napcatTestResult = ref<any>(null);
const imageTestLoading = ref(false);
const imageTestPrompt = ref('小狗');
const imageTestResult = ref<any>(null);
const defaultPrompts = ref<any>(null);
const logEntries = ref<LogEntry[]>([]);
const logLoading = ref(false);
const logError = ref('');
const logLevel = ref('all');
const logSearch = ref('');
const logLimit = ref(readSavedLogLimit('np_system_log_limit', 300));
const logStats = ref<any>(null);
const logAutoRefresh = ref(true);
const logTimer = ref<number | null>(null);
const logCopyStatus = ref('');
const copyFallbackText = ref('');
const copyFallbackTitle = ref('');
const copyFallbackTextarea = ref<HTMLTextAreaElement | null>(null);
const canvasLogEntries = ref<LogEntry[]>([]);
const canvasLogLoading = ref(false);
const canvasLogError = ref('');
const canvasLogLevel = ref('all');
const canvasLogSearch = ref('');
const canvasLogLimit = ref(readSavedLogLimit('np_canvas_log_limit', 300));
const canvasLogStats = ref<any>(null);
const canvasLogCopyStatus = ref('');
const canvasCards = ref<CanvasManagedCard[]>([]);
const canvasCardsLoading = ref(false);
const canvasCardsError = ref('');
const configImportInput = ref<HTMLInputElement | null>(null);
const templateConvertSource = ref('');
const templateConvertLoading = ref(false);
const templateConvertStatus = ref('');
const templateTitleLoading = ref<Record<string, boolean>>({});
const collapsedTemplates = ref<Record<string, boolean>>({});

const menuItems = [
  { id: 'about', icon: '总', label: '控制台概览' },
  { id: 'llm', icon: '模', label: '模型与节点' },
  { id: 'modelRoutes', icon: '路', label: '模型路由' },
  { id: 'huggingFace', icon: 'HF', label: 'Hugging Face 接口' },
  { id: 'bot', icon: '复', label: '回复策略' },
  { id: 'freeMode', icon: '自', label: '自由模式' },
  { id: 'templates', icon: '词', label: '提示词模板' },
  { id: 'canvas', icon: '画', label: '画布配置' },
  { id: 'napcat', icon: '连', label: '客户端连接' },
  { id: 'logs', icon: '志', label: '运行日志' },
];
function pageLabel() {
  return menuItems.find((item) => item.id === currentPage.value)?.label || '配置中心';
}

// ─── 移动端侧栏控制 ───
const isMobileSidebarOpen = ref(false);
function toggleMobileSidebar() {
  isMobileSidebarOpen.value = !isMobileSidebarOpen.value;
}
function closeMobileSidebar() {
  isMobileSidebarOpen.value = false;
}

onMounted(async () => { 
  if (token.value) await fetchConfig(); 
});
onBeforeUnmount(stopLogTimer);

watch([currentPage, logAutoRefresh], async ([page]) => {
  if (page === 'logs') {
    await fetchLogs();
    startLogTimer();
  } else if (page === 'canvas') {
    stopLogTimer();
    ensureCanvasConfig();
    await fetchCanvasCards();
    await fetchCanvasLogs();
  } else {
    stopLogTimer();
  }
});

function authHeaders() {
  return { Authorization: `Bearer ${token.value}` };
}

async function login() {
  if (!password.value) {
    showToast('请输入密码', 'error');
    return;
  }
  try {
    const res = await axios.post(`${API_BASE}/login`, { password: password.value });
    if (res.data.success) {
      token.value = res.data.token;
      localStorage.setItem('np_token', token.value);
      loginError.value = '';
      showToast('登录成功！欢迎回来', 'success');
      await fetchConfig();
    }
  } catch (e: any) { 
    loginError.value = e.response?.data?.error || '登录失败'; 
    showToast(loginError.value, 'error');
  }
}

async function fetchConfig() {
  try {
    const res = await axios.get(`${API_BASE}/config`, { headers: authHeaders() });
    applyServerConfig(res.data?.config || res.data);
    isAuthenticated.value = true;
    await fetchDefaultPrompts();
  } catch (e: any) {
    if (e.response?.status === 401) { 
      isAuthenticated.value = false; 
      localStorage.removeItem('np_token'); 
      showToast('认证已过期，请重新登录', 'error');
    }
  }
}

function ensureCanvasConfig() {
  if (!config.value) return;
  if (!config.value.canvas) {
    config.value.canvas = {
      enabled: true,
      imageNodeIndex: config.value.llm?.imageNodeIndex || 0,
      imageModel: config.value.llm?.imageModel || 'gpt-image-2',
      editNodeIndex: config.value.llm?.editNodeIndex || config.value.llm?.imageNodeIndex || 0,
      editModel: config.value.llm?.editModel || config.value.llm?.imageModel || 'gpt-image-2',
      imageEditRequestMode: config.value.llm?.imageEditRequestMode || 'auto',
      imageTimeoutMs: config.value.llm?.imageTimeoutMs || 300000,
      imageRetryCount: config.value.llm?.imageRetryCount ?? 1,
      imageRetryDelayMs: config.value.llm?.imageRetryDelayMs ?? 2500,
      defaultQuality: 'auto',
      defaultOutputFormat: 'png',
      defaultCount: 1,
      defaultSizePresetId: 'auto',
      defaultStylePresetId: 'none',
      interrogateNodeIndex: config.value.llm?.interrogateNodeIndex || config.value.llm?.chatNodeIndex || 0,
      interrogateModel: config.value.llm?.interrogateModel || config.value.llm?.chatModel || 'gpt-4o-mini',
      interrogatePromptTemplate: config.value.llm?.interrogatePromptTemplate || '请分析这张图片，并反推一段适合图像生成模型复现它的提示词。',
      interrogateTemplateNodeIndex: config.value.llm?.interrogateNodeIndex || config.value.llm?.chatNodeIndex || 0,
      interrogateTemplateModel: config.value.llm?.interrogateModel || config.value.llm?.chatModel || 'gpt-4o-mini',
      interrogateTemplatePromptTemplate: defaultPrompts.value?.interrogateTemplatePromptTemplate || '请分析这张图片，并把它反推成可复用的图像生成提示词模板。输出中文纯文本，不要解释，不要 Markdown。模板中必须至少出现一次 {{prompt}}。',
      interrogateTimeoutMs: 300000,
      interrogateTemplateTimeoutMs: 300000,
      maxHistory: 50,
      dataDir: '',
      brand: { logoText: 'Mio', pageTitle: 'Mio 图像画布', faviconUrl: '/canvas/favicon.ico' },
      logs: { enabled: true, level: 'info', maxMemoryEntries: 1000 },
    };
  }
  config.value.canvas.defaultQuality ||= 'auto';
  config.value.canvas.defaultOutputFormat ||= 'png';
  config.value.canvas.defaultCount ??= 1;
  config.value.canvas.defaultSizePresetId ||= 'auto';
  config.value.canvas.defaultStylePresetId ||= 'none';
  if (!config.value.canvas.brand) config.value.canvas.brand = {};
  config.value.canvas.brand.logoText ||= 'Mio';
  config.value.canvas.brand.pageTitle ||= 'Mio 图像画布';
  config.value.canvas.brand.faviconUrl ||= '/canvas/favicon.ico';
  config.value.canvas.interrogateNodeIndex ??= config.value.llm?.interrogateNodeIndex ?? config.value.llm?.chatNodeIndex ?? 0;
  config.value.canvas.interrogateModel ||= config.value.llm?.interrogateModel || config.value.llm?.chatModel || 'gpt-4o-mini';
  config.value.canvas.interrogatePromptTemplate ||= config.value.llm?.interrogatePromptTemplate || defaultPrompts.value?.interrogatePromptTemplate || '请分析这张图片，并反推一段适合图像生成模型复现它的提示词。';
  config.value.canvas.interrogateTemplateNodeIndex ??= config.value.canvas.interrogateNodeIndex;
  config.value.canvas.interrogateTemplateModel ||= config.value.canvas.interrogateModel || 'gpt-4o-mini';
  config.value.canvas.interrogateTemplatePromptTemplate ||= defaultPrompts.value?.interrogateTemplatePromptTemplate || '请分析这张图片，并把它反推成可复用的图像生成提示词模板。输出中文纯文本，不要解释，不要 Markdown。模板中必须至少出现一次 {{prompt}}。';
  config.value.canvas.interrogateTimeoutMs ??= config.value.llm?.interrogateTimeoutMs || 300000;
  config.value.canvas.interrogateTemplateTimeoutMs ??= config.value.canvas.interrogateTimeoutMs || 300000;
  if (!config.value.canvas.logs) {
    config.value.canvas.logs = { enabled: true, level: 'info', maxMemoryEntries: 1000 };
  }
  if (!config.value.napcat) config.value.napcat = {};
  config.value.napcat.actionTimeoutMs ??= 15000;
  config.value.napcat.textSendTimeoutMs ??= 15000;
  config.value.napcat.imageSendTimeoutMs ??= 120000;
  config.value.napcat.fileSendTimeoutMs ??= 300000;
  config.value.napcat.fileSendRetryCount ??= 1;
  config.value.napcat.fileSendRetryDelayMs ??= 1200;
  config.value.napcat.forwardSendTimeoutMs ??= 300000;
  config.value.napcat.getMessageTimeoutMs ??= 10000;
  if (!config.value.bot) config.value.bot = {};
  config.value.bot.botQqId ||= '';
  if (!Array.isArray(config.value.bot.ownerQQs)) config.value.bot.ownerQQs = [];
  if (!config.value.bot.replyStrategies) {
    config.value.bot.replyStrategies = {
      text: config.value.bot.replyFormat || 'forward',
      image: config.value.bot.replyFormat || 'forward',
      multiImage: 'forward',
    };
  }
  config.value.bot.replyStrategies.text ||= 'forward';
  config.value.bot.replyStrategies.image ||= config.value.bot.replyFormat || 'forward';
  config.value.bot.replyStrategies.multiImage ||= 'forward';
  if (!config.value.bot.commands) config.value.bot.commands = {};
  config.value.bot.commands.imageCount ||= 's';
  config.value.bot.commands.referencedTemplateImage ||= '套模板, 引用模板生图, 模板填充生图';
  if (!config.value.bot.textReply) config.value.bot.textReply = {};
  config.value.bot.textReply.maxChars ??= 1800;
  config.value.bot.textReply.splitDelayMs ??= 800;
  config.value.bot.textReply.showPartPrefix ??= true;
  if (!config.value.bot.tts) {
    config.value.bot.tts = {
      enabled: false,
      provider: 'fish-audio',
      apiUrl: 'https://api.fish.audio/v1/tts',
      apiKey: '',
      model: 's2-pro',
      voiceId: '',
      voiceIds: [],
      voice: 'alloy',
      format: 'mp3',
      autoTextMaxChars: 180,
      timeoutMs: 60000,
      speed: 1,
      volume: 0,
      latency: 'normal',
      preprocess: {
        enabled: false,
        nodeIndex: config.value.llm?.chatNodeIndex ?? 0,
        model: config.value.llm?.chatModel || 'gpt-4o-mini',
        timeoutMs: 60000,
        delayMs: 0,
        maxOutputChars: 1000,
        promptTemplate: defaultPrompts.value?.ttsPreprocessPromptTemplate || '你是文本转语音前置处理助手。请把机器人回复翻译/改写成适合语音合成的文本，并按需要穿插语音标签。只输出最终要送入语音 API 的文本，不要解释，不要 Markdown。待处理文本：{{text}}',
        fallbackToOriginal: true,
      },
    };
  }
  config.value.bot.tts.provider ||= 'fish-audio';
  config.value.bot.tts.apiUrl ||= config.value.bot.tts.provider === 'openai-compatible' ? 'https://api.openai.com/v1/audio/speech' : 'https://api.fish.audio/v1/tts';
  config.value.bot.tts.model ||= config.value.bot.tts.provider === 'openai-compatible' ? 'tts-1' : 's2-pro';
  normalizeTtsVoiceIds();
  config.value.bot.tts.voice ||= 'alloy';
  config.value.bot.tts.format ||= 'mp3';
  config.value.bot.tts.autoTextMaxChars ??= 180;
  config.value.bot.tts.timeoutMs ??= 60000;
  config.value.bot.tts.speed ??= 1;
  config.value.bot.tts.volume ??= 0;
  config.value.bot.tts.latency ||= 'normal';
  if (!config.value.bot.tts.preprocess) config.value.bot.tts.preprocess = {};
  config.value.bot.tts.preprocess.enabled ??= false;
  config.value.bot.tts.preprocess.nodeIndex ??= config.value.llm?.chatNodeIndex ?? 0;
  config.value.bot.tts.preprocess.model ||= config.value.llm?.chatModel || 'gpt-4o-mini';
  config.value.bot.tts.preprocess.timeoutMs ??= 60000;
  config.value.bot.tts.preprocess.delayMs ??= 0;
  config.value.bot.tts.preprocess.maxOutputChars ??= 1000;
  config.value.bot.tts.preprocess.promptTemplate ||= defaultPrompts.value?.ttsPreprocessPromptTemplate || '你是文本转语音前置处理助手。请把机器人回复翻译/改写成适合语音合成的文本，并按需要穿插语音标签。只输出最终要送入语音 API 的文本，不要解释，不要 Markdown。待处理文本：{{text}}';
  config.value.bot.tts.preprocess.fallbackToOriginal ??= true;
  if (!config.value.bot.imageCompression) {
    config.value.bot.imageCompression = { enabled: true, scale: 0.65, quality: 82 };
  }
  config.value.bot.imageCompression.mergedPreviewEnabled ??= true;
  config.value.bot.imageCompression.mergedPreviewScale ??= 0.7;
  config.value.bot.imageCompression.mergedPreviewQuality ??= 82;
  config.value.bot.imageCompression.mergedPreviewMaxWidth ??= 1800;
  if (!config.value.llm) config.value.llm = {};
  config.value.llm.referencedTemplateNodeIndex ??= config.value.llm.chatNodeIndex ?? 0;
  config.value.llm.referencedTemplateModel ||= config.value.llm.chatModel || 'gpt-4o-mini';
  config.value.llm.referencedTemplatePromptTemplate ||= defaultPrompts.value?.referencedTemplatePromptTemplate || '你是 GPT-Image 图像提示词引用模板填充助手。请根据用户主体把引用的通用模板填充成最终图像生成提示词。只输出最终提示词纯文本，不要解释，不要 Markdown。用户主体：{{rawPrompt}}\n\n引用的模板消息：{{templatePrompt}}';
  config.value.llm.referencedTemplateTimeoutMs ??= 300000;
  config.value.llm.interrogateNodeIndex ??= config.value.llm.chatNodeIndex ?? 0;
  config.value.llm.interrogateModel ||= config.value.llm.chatModel || 'gpt-4o-mini';
  config.value.llm.interrogatePromptTemplate ||= defaultPrompts.value?.interrogatePromptTemplate || '请分析这张图片，并反推一段适合图像生成模型复现它的提示词。';
  config.value.llm.interrogateTimeoutMs ??= 300000;
  if (!config.value.freeMode) {
    config.value.freeMode = {
      enabled: false,
      nodeIndex: config.value.llm.chatNodeIndex ?? 0,
      model: config.value.llm.chatModel || 'gpt-4o-mini',
      timeoutMs: 120000,
      maxInputImages: 6,
      maxReferencedMessages: 20,
      maxOutputImages: 4,
      includeQuotedMessage: true,
      preferEditWhenImagePresent: true,
      plannerPromptTemplate: defaultPrompts.value?.freeModePromptTemplate || '你是自由模式规划器。判断应该文本回复，还是创建或编辑图片。只返回结构化结果。用户内容：{{userContent}}',
    };
  }
  config.value.freeMode.nodeIndex ??= config.value.llm.chatNodeIndex ?? 0;
  config.value.freeMode.model ||= config.value.llm.chatModel || 'gpt-4o-mini';
  config.value.freeMode.timeoutMs ??= 120000;
  config.value.freeMode.maxInputImages ??= 6;
  config.value.freeMode.maxReferencedMessages ??= 20;
  config.value.freeMode.maxOutputImages ??= 4;
  config.value.freeMode.includeQuotedMessage ??= true;
  config.value.freeMode.preferEditWhenImagePresent ??= true;
  config.value.freeMode.plannerPromptTemplate ||= defaultPrompts.value?.freeModePromptTemplate || '你是自由模式规划器。判断应该文本回复，还是创建或编辑图片。只返回结构化结果。用户内容：{{userContent}}';
  if (!config.value.huggingFace) {
    config.value.huggingFace = {
      enabled: false,
      useForChat: false,
      token: '',
      baseUrl: 'https://router.huggingface.co/v1',
      hubApiUrl: 'https://huggingface.co/api/models',
      selectedModelId: '',
      selectedProvider: '',
      selectedModelCode: '',
      requestMode: 'openai-chat',
      timeoutMs: 120000,
      cacheTtlSeconds: 3600,
      cachedAt: '',
      cacheQueryHash: '',
      cachedModels: [],
      filters: {},
    };
  }
  config.value.huggingFace.baseUrl ||= 'https://router.huggingface.co/v1';
  config.value.huggingFace.hubApiUrl ||= 'https://huggingface.co/api/models';
  config.value.huggingFace.requestMode ||= 'openai-chat';
  config.value.huggingFace.timeoutMs ??= 120000;
  config.value.huggingFace.cacheTtlSeconds ??= 3600;
  if (!Array.isArray(config.value.huggingFace.cachedModels)) config.value.huggingFace.cachedModels = [];
  if (!config.value.huggingFace.filters) config.value.huggingFace.filters = {};
  config.value.huggingFace.filters.search ??= '';
  config.value.huggingFace.filters.author ??= '';
  config.value.huggingFace.filters.pipelineTag ||= 'text-generation';
  config.value.huggingFace.filters.tags ??= '';
  config.value.huggingFace.filters.library ??= '';
  config.value.huggingFace.filters.inference ??= 'warm';
  config.value.huggingFace.filters.gated ??= 'false';
  config.value.huggingFace.filters.sort ||= 'downloads';
  config.value.huggingFace.filters.direction ||= '-1';
  config.value.huggingFace.filters.limit ??= 50;
  config.value.huggingFace.filters.includePrivate ??= true;
  config.value.huggingFace.filters.onlyChatCompatible ??= true;
  config.value.huggingFace.filters.provider ??= '';
}

async function fetchDefaultPrompts() {
  if (defaultPrompts.value) return;
  try {
    const res = await axios.get(`${API_BASE}/default-prompts`, { headers: authHeaders() });
    defaultPrompts.value = res.data;
  } catch {}
}

function handleLogout() {
  stopLogTimer();
  isAuthenticated.value = false;
  token.value = '';
  localStorage.removeItem('np_token');
  showToast('已安全登出控制台', 'info');
}

async function saveConfig() {
  if (savingConfig.value) return;
  ensureCanvasConfig();
  const payload = buildConfigSavePayload(config.value, savedConfigSnapshot.value);
  if (isEmptyPatch(payload)) {
    saveStatus.value = '✅ 没有检测到配置变更';
    showToast('没有需要保存的变更', 'info');
    return;
  }
  savingConfig.value = true;
  saveStatus.value = '⏳ 保存中...';
  showToast(`正在提交 ${countPatchChanges(payload)} 项配置变更...`, 'info');
  try {
    const res = await axios.post(`${API_BASE}/config?compact=1`, payload, { headers: authHeaders() });
    const nextToken = res.data?.token || res.data?.auth?.token || config.value?.panel?.passwordSeed;
    if (nextToken && token.value !== nextToken) {
      token.value = nextToken;
      localStorage.setItem('np_token', token.value);
    }
    if (res.data?.config) {
      applyServerConfig(res.data.config);
    } else {
      rememberSavedConfigSnapshot();
    }
    saveStatus.value = '✅ 配置已热重载生效！';
    showToast('配置保存并热重载成功！', 'success');
  } catch (e: any) { 
    saveStatus.value = `❌ 失败: ${e.message}`; 
    showToast(`保存失败: ${e.message}`, 'error');
  } finally {
    savingConfig.value = false;
  }
}

function applyServerConfig(nextConfig: any) {
  config.value = nextConfig;
  ensureCanvasConfig();
  rememberSavedConfigSnapshot();
}

function rememberSavedConfigSnapshot() {
  savedConfigSnapshot.value = sanitizeConfigForSave(config.value);
}

function buildConfigSavePayload(source: any, previous?: any) {
  const current = sanitizeConfigForSave(source);
  const baseline = previous ? sanitizeConfigForSave(previous) : {};
  return diffConfigPatch(baseline, current) || {};
}

function sanitizeConfigForSave(source: any) {
  const payload = clonePlain(source || {});
  // Do not echo large Hugging Face cache fields on ordinary settings save.
  // The backend merges this as a patch, so omitted cache fields stay unchanged.
  if (payload.huggingFace && typeof payload.huggingFace === 'object') {
    delete payload.huggingFace.cachedModels;
    delete payload.huggingFace.cachedAt;
    delete payload.huggingFace.cacheQueryHash;
  }
  return payload;
}

function diffConfigPatch(previous: any, current: any): any {
  if (stableJson(previous) === stableJson(current)) return undefined;
  if (Array.isArray(previous) || Array.isArray(current)) return clonePlain(current);
  if (!isPlainObject(previous) || !isPlainObject(current)) return clonePlain(current);
  const patch: Record<string, any> = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of keys) {
    if (!(key in current)) {
      patch[key] = null;
      continue;
    }
    const child = diffConfigPatch(previous[key], current[key]);
    if (child !== undefined) patch[key] = child;
  }
  return Object.keys(patch).length ? patch : undefined;
}

function isEmptyPatch(value: any) {
  return !value || (isPlainObject(value) && Object.keys(value).length === 0);
}

function countPatchChanges(value: any): number {
  if (isEmptyPatch(value)) return 0;
  if (!isPlainObject(value) || Array.isArray(value)) return 1;
  return Object.values(value).reduce((sum, item) => sum + countPatchChanges(item), 0);
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isPlainObject(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: any): string {
  return JSON.stringify(value, (_key, item) => {
    if (!isPlainObject(item)) return item;
    return Object.keys(item).sort().reduce((acc: Record<string, any>, key) => {
      acc[key] = item[key];
      return acc;
    }, {});
  });
}

async function exportConfig() {
  try {
    const res = await axios.get(`${API_BASE}/config/export`, { headers: authHeaders() });
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `napcat-miobot-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    saveStatus.value = '✅ 配置已导出';
    showToast('配置导出成功！文件已开始下载', 'success');
  } catch (e: any) {
    saveStatus.value = `❌ 导出失败: ${e.message}`;
    showToast(`导出失败: ${e.message}`, 'error');
  }
}

function triggerImportConfig() {
  configImportInput.value?.click();
}

async function importConfigFromFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  saveStatus.value = '⏳ 导入中...';
  showToast('正在解析配置文件...', 'info');
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const res = await axios.post(`${API_BASE}/config/import`, parsed, { headers: authHeaders() });
    applyServerConfig(res.data.config || parsed.config || parsed);
    if (config.value?.panel?.passwordSeed && token.value !== config.value.panel.passwordSeed) {
      token.value = config.value.panel.passwordSeed;
      localStorage.setItem('np_token', token.value);
    }
    defaultPrompts.value = null;
    await fetchDefaultPrompts();
    saveStatus.value = '✅ 配置已导入并热重载';
    showToast('配置导入并热重载成功！', 'success');
  } catch (e: any) {
    saveStatus.value = `❌ 导入失败: ${e.response?.data?.error || e.message}`;
    showToast(`导入失败: ${e.response?.data?.error || e.message}`, 'error');
  }
}

async function testNapcatConnection() {
  napcatTestLoading.value = true;
  napcatTestResult.value = null;
  showToast('正在测试与 Napcat 客户端的 WebSocket 连接...', 'info');
  try {
    const res = await axios.post(`${API_BASE}/test-napcat`, {
      wsUrl: config.value.napcat.wsUrl,
      token: config.value.napcat.token,
    }, { headers: authHeaders() });
    napcatTestResult.value = res.data;
    if (res.data.success) {
      showToast('Napcat 连接状态测试成功！', 'success');
    } else {
      showToast('测试返回异常：连接未能成功建立', 'error');
    }
  } catch (e: any) {
    napcatTestResult.value = e.response?.data || { success: false, message: e.message || '测试失败' };
    showToast(`测试失败: ${napcatTestResult.value.message}`, 'error');
  } finally {
    napcatTestLoading.value = false;
  }
}

async function testImageApi() {
  imageTestLoading.value = true;
  imageTestResult.value = null;
  showToast('正在调用图像大模型 API，请耐心等待...', 'info');
  try {
    const res = await axios.post(`${API_BASE}/test-image`, {
      prompt: imageTestPrompt.value,
      resolution: '1024x1024',
    }, { headers: authHeaders() });
    imageTestResult.value = res.data;
    if (res.data.success) {
      showToast('模型生图测试成功！已真实调用上游接口', 'success');
    } else {
      showToast('模型生图返回失败', 'error');
    }
  } catch (e: any) {
    imageTestResult.value = e.response?.data || { success: false, message: e.message || '测试失败' };
    showToast(`测试失败: ${imageTestResult.value.message}`, 'error');
  } finally {
    imageTestLoading.value = false;
  }
}

function addNode() {
  config.value.llm.apiKeys.push({
    name: `节点 ${config.value.llm.apiKeys.length + 1}`,
    provider: '',
    baseUrl: '',
    key: '',
    enabled: true,
    models: [],
    modelsFetchedAt: '',
  });
  showToast('已添加空节点，请输入 API 信息并点击获取模型', 'info');
}

function normalizeIndex(idx: number | string) {
  return Number(idx);
}

function removeNode(idx: number | string) {
  const index = normalizeIndex(idx);
  if (config.value.llm.apiKeys.length <= 1) {
    showToast('必须保留至少一个 API 节点', 'error');
    return;
  }
  config.value.llm.apiKeys.splice(index, 1);
  if (config.value.llm.activeNodeIndex >= config.value.llm.apiKeys.length) {
    config.value.llm.activeNodeIndex = config.value.llm.apiKeys.length - 1;
  }
  showToast('节点已成功移除', 'info');
}

function setActiveNode(idx: number | string) { 
  config.value.llm.activeNodeIndex = normalizeIndex(idx); 
  showToast(`已激活节点：${config.value.llm.apiKeys[config.value.llm.activeNodeIndex].name || '未命名'}`, 'success');
}

function parseNodeConnectionInput(baseUrl = '', key = '') {
  const rawBase = String(baseUrl || '').trim();
  const rawKey = String(key || '').trim();
  const combined = `${rawBase} ${rawKey}`.trim();
  const match = combined.match(/(https?:\/\/[^\s，,；;]+?)(?:\s*[-—–]\s*|\s+)?(?:密钥|key|api[_\s-]*key|token)[:：=\s-]*([^\s,;]+)/i);
  let nextBase = match ? match[1] : rawBase;
  let nextKey = rawKey || (match ? match[2] : '');
  nextBase = nextBase
    .replace(/[\s,，;；]+$/g, '')
    .replace(/\/(?:chat\/completions|images\/generations|images\/edits|models)$/i, '')
    .replace(/\/+$/, '');
  nextKey = nextKey.replace(/^[\s:：=,-]+|[\s,，;；]+$/g, '');
  return { baseUrl: nextBase, key: nextKey, keyDetected: Boolean(match?.[2]) };
}

function applyAnyRouterPreset(idx: number | string) {
  const node = config.value.llm.apiKeys[normalizeIndex(idx)];
  if (!node) return;
  node.name ||= 'Any Router';
  node.provider = 'anyrouter';
  node.baseUrl = 'https://anyrouter.top/v1';
  showToast('已填入 Any Router Base URL，请补充接口密钥后获取模型', 'info');
}

function applyChatGpt2ApiPreset(idx: number | string) {
  const node = config.value.llm.apiKeys[normalizeIndex(idx)];
  if (!node) return;
  node.name = node.name && node.name !== `节点 ${Number(idx) + 1}` ? node.name : 'ChatGPT Web (chatgpt2api)';
  node.provider = 'chatgpt2api';
  node.baseUrl ||= 'http://localhost:8000/v1';
  node.models = Array.from(new Set([
    ...(Array.isArray(node.models) ? node.models : []),
    'gpt-image-2',
    'codex-gpt-image-2',
    'auto',
    'gpt-5',
    'gpt-5-1',
    'gpt-5-2',
    'gpt-5-3',
    'gpt-5-3-mini',
    'gpt-5-mini',
    'gpt-5-5-thinking',
  ]));
  showToast('已填入 chatgpt2api 预设：按部署地址修正 Base URL，并填写 auth-key 后获取模型', 'info');
}

async function fetchModels(idx: number | string) {
  const index = normalizeIndex(idx);
  const node = config.value.llm.apiKeys[index];
  const parsed = parseNodeConnectionInput(node?.baseUrl, node?.key);
  if (node) {
    if (parsed.baseUrl && parsed.baseUrl !== node.baseUrl) node.baseUrl = parsed.baseUrl;
    if (parsed.key && parsed.key !== node.key) node.key = parsed.key;
    if (parsed.keyDetected) showToast('已自动拆分粘贴内容中的 Base URL 和密钥', 'info');
  }
  if (!node?.baseUrl) {
    showToast('请先填写基础 URL', 'error');
    return;
  }
  modelLoading.value = true; 
  modelError.value = ''; 
  fetchedModels.value = [];
  showToast(`正在获取 [${node.name || '未命名'}] 的可用模型列表...`, 'info');
  try {
    const res = await axios.post(`${API_BASE}/fetch-models`, { 
      baseUrl: node.baseUrl, 
      key: node.key, 
      nodeIndex: index 
    }, { headers: authHeaders() });
    fetchedModels.value = res.data.models || [];
    if (res.data.normalized?.baseUrl) node.baseUrl = res.data.normalized.baseUrl;
    if (res.data.normalized?.providerHint) node.provider = res.data.normalized.providerHint;
    node.models = fetchedModels.value;
    node.modelsFetchedAt = new Date().toISOString();
    showToast(`获取成功！共发现 ${fetchedModels.value.length} 个模型`, 'success');
  } catch (e: any) { 
    modelError.value = e.response?.data?.error || '获取失败'; 
    showToast(`获取模型列表失败: ${modelError.value}`, 'error');
  } finally { 
    modelLoading.value = false; 
  }
}

function hfConfig() {
  ensureCanvasConfig();
  return config.value.huggingFace;
}

function hfModels() {
  return Array.isArray(config.value?.huggingFace?.cachedModels) ? config.value.huggingFace.cachedModels : [];
}

function applyHfPreset(kind: string) {
  const hf = hfConfig();
  const f = hf.filters;
  if (kind === 'chat') {
    Object.assign(f, { pipelineTag: 'text-generation', inference: 'warm', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: true });
  } else if (kind === 'vision') {
    Object.assign(f, { pipelineTag: 'image-text-to-text', inference: '', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: true });
  } else if (kind === 'image') {
    Object.assign(f, { pipelineTag: 'text-to-image', inference: '', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: false });
  } else if (kind === 'textVideo') {
    Object.assign(f, { pipelineTag: 'text-to-video', inference: '', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: false });
  } else if (kind === 'imageVideo') {
    Object.assign(f, { pipelineTag: 'image-to-video', inference: '', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: false });
  } else if (kind === 'videoVideo') {
    Object.assign(f, { pipelineTag: 'video-to-video', inference: '', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: false });
  } else if (kind === 'anyAny') {
    Object.assign(f, { pipelineTag: 'any-to-any', inference: '', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: false });
  } else if (kind === 'asr') {
    Object.assign(f, { pipelineTag: 'automatic-speech-recognition', inference: '', gated: 'false', sort: 'downloads', direction: '-1', onlyChatCompatible: false });
  } else if (kind === 'private') {
    Object.assign(f, { includePrivate: true, gated: '', inference: '', sort: 'lastModified', direction: '-1' });
  } else if (kind === 'hot') {
    Object.assign(f, { inference: 'warm', sort: 'downloads', direction: '-1', limit: 100 });
  }
  showToast('已套用 Hugging Face 筛选预设，点击“查询模型”即可刷新列表', 'info');
}

function clearHfCache() {
  const hf = hfConfig();
  hf.cachedModels = [];
  hf.cachedAt = '';
  hf.cacheQueryHash = '';
  hfFetchStatus.value = '缓存已清空，保存配置后生效';
  showToast('已清空 Hugging Face 模型缓存', 'info');
}

function selectHfModel(model: any) {
  const hf = hfConfig();
  hf.selectedModelId = model.id;
  hf.selectedProvider = model.provider || '';
  hf.selectedModelCode = model.code || '';
  hf.requestMode = model.requestMode || hf.requestMode || 'openai-chat';
  hf.useForChat = true;
  hf.enabled = true;
  showToast(`已选择 ${model.code}：${model.id}，保存后 bot 可用 /q ${model.code} 切换`, 'success');
}

async function fetchHuggingFaceModels(force = false) {
  const hf = hfConfig();
  hfModelsLoading.value = true;
  hfModelsError.value = '';
  hfFetchStatus.value = '正在查询 Hugging Face 模型列表...';
  try {
    const res = await axios.post(`${API_BASE}/huggingface/models`, {
      force,
      huggingFace: hf,
      filters: hf.filters,
    }, { headers: authHeaders() });
    if (res.data.config) applyServerConfig(res.data.config);
    hfFetchStatus.value = `${res.data.fromCache ? '已使用缓存' : '已刷新'}：共 ${res.data.models?.length || 0} 个模型，缓存时间 ${res.data.cachedAt || '-'}`;
    showToast(`Hugging Face 模型查询完成：${res.data.models?.length || 0} 个`, 'success');
  } catch (e: any) {
    hfModelsError.value = e.response?.data?.error || e.message || '查询失败';
    hfFetchStatus.value = '';
    showToast(`Hugging Face 查询失败: ${hfModelsError.value}`, 'error');
  } finally {
    hfModelsLoading.value = false;
  }
}

function hfFormatDate(value: string) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : value;
}

function applySystemLogLimit() {
  logLimit.value = clampLogLimit(logLimit.value);
  localStorage.setItem('np_system_log_limit', String(logLimit.value));
  fetchLogs();
}

function applyCanvasLogLimit() {
  canvasLogLimit.value = clampLogLimit(canvasLogLimit.value);
  localStorage.setItem('np_canvas_log_limit', String(canvasLogLimit.value));
  fetchCanvasLogs();
}

async function fetchLogs(showLoading = true) {
  if (!isAuthenticated.value) return;
  logLimit.value = clampLogLimit(logLimit.value);
  if (showLoading) logLoading.value = true;
  logError.value = '';
  try {
    const res = await axios.get(`${API_BASE}/logs`, {
      headers: authHeaders(),
      params: {
        level: logLevel.value,
        search: logSearch.value.trim(),
        limit: logLimit.value,
      },
    });
    logEntries.value = res.data.entries || [];
    logStats.value = res.data.stats || null;
  } catch (e: any) {
    logError.value = e.response?.data?.error || e.message || '日志加载失败';
  } finally {
    if (showLoading) logLoading.value = false;
  }
}

async function clearLogs() {
  if (!window.confirm('确定清空当前运行日志吗？')) return;
  logLoading.value = true;
  logError.value = '';
  try {
    const res = await axios.post(`${API_BASE}/logs/clear`, {}, { headers: authHeaders() });
    logEntries.value = res.data.entries || [];
    logStats.value = res.data.stats || null;
    showToast('日志已清空！', 'success');
  } catch (e: any) {
    logError.value = e.response?.data?.error || e.message || '清空失败';
    showToast(`清空失败: ${logError.value}`, 'error');
  } finally {
    logLoading.value = false;
  }
}

async function fetchCanvasLogs(showLoading = true) {
  if (!isAuthenticated.value) return;
  canvasLogLimit.value = clampLogLimit(canvasLogLimit.value);
  if (showLoading) canvasLogLoading.value = true;
  canvasLogError.value = '';
  try {
    const res = await axios.get(`${API_BASE}/canvas/logs`, {
      headers: authHeaders(),
      params: {
        level: canvasLogLevel.value,
        search: canvasLogSearch.value.trim(),
        limit: canvasLogLimit.value,
      },
    });
    canvasLogEntries.value = res.data.entries || [];
    canvasLogStats.value = res.data.stats || null;
  } catch (e: any) {
    canvasLogError.value = e.response?.data?.error || e.message || '画布日志加载失败';
  } finally {
    if (showLoading) canvasLogLoading.value = false;
  }
}

async function clearCanvasLogs() {
  if (!window.confirm('确定清空画布日志吗？')) return;
  canvasLogLoading.value = true;
  canvasLogError.value = '';
  try {
    const res = await axios.post(`${API_BASE}/canvas/logs/clear`, {}, { headers: authHeaders() });
    canvasLogEntries.value = res.data.entries || [];
    canvasLogStats.value = res.data.stats || null;
    showToast('画布日志已清空', 'success');
  } catch (e: any) {
    canvasLogError.value = e.response?.data?.error || e.message || '清空失败';
    showToast(`清空失败: ${canvasLogError.value}`, 'error');
  } finally {
    canvasLogLoading.value = false;
  }
}

async function fetchCanvasCards(showLoading = true) {
  if (!isAuthenticated.value) return;
  if (showLoading) canvasCardsLoading.value = true;
  canvasCardsError.value = '';
  try {
    const res = await axios.get(`${API_BASE}/canvas/cards`, { headers: authHeaders() });
    canvasCards.value = res.data.items || [];
  } catch (e: any) {
    canvasCardsError.value = e.response?.data?.error || e.message || '卡片列表加载失败';
  } finally {
    if (showLoading) canvasCardsLoading.value = false;
  }
}

async function deleteCanvasCard(card: CanvasManagedCard) {
  const label = card.kind === 'gallery' ? '画廊作品' : '模板卡片';
  if (!window.confirm(`确定删除这个${label}吗？`)) return;
  canvasCardsError.value = '';
  try {
    await axios.delete(`${API_BASE}/canvas/cards/${card.kind}/${encodeURIComponent(card.id)}`, { headers: authHeaders() });
    canvasCards.value = canvasCards.value.filter((item) => !(item.kind === card.kind && item.id === card.id));
    showToast(`${label}已删除`, 'success');
    await fetchCanvasLogs(false);
  } catch (e: any) {
    canvasCardsError.value = e.response?.data?.error || e.message || '删除失败';
    showToast(`删除失败: ${canvasCardsError.value}`, 'error');
  }
}

function canvasCardPreviewUrl(card: CanvasManagedCard) {
  const asset = card.asset;
  if (!asset) return '';
  if (asset.url?.startsWith('data:image/')) return asset.url;
  return `${window.location.origin}/canvas-api/assets/${encodeURIComponent(asset.id)}/preview?width=256`;
}

function canvasCardDownloadUrl(card: CanvasManagedCard) {
  return card.asset?.id ? `${window.location.origin}/canvas-api/assets/${encodeURIComponent(card.asset.id)}/download` : '#';
}

function canvasCardKindText(kind: CanvasManagedCard['kind']) {
  return kind === 'gallery' ? '画廊' : '模板库';
}

function copyCanvasVisibleLogs() {
  copyText(canvasLogEntries.value.map(formatLogEntry).join('\n\n'), `已复制 ${canvasLogEntries.value.length} 条画布日志`);
}

function startLogTimer() {
  stopLogTimer();
  if (!logAutoRefresh.value || currentPage.value !== 'logs') return;
  logTimer.value = window.setInterval(() => fetchLogs(false), 5000);
}

function stopLogTimer() {
  if (logTimer.value !== null) {
    window.clearInterval(logTimer.value);
    logTimer.value = null;
  }
}

function formatLogDetails(details: unknown) {
  if (details === undefined || details === null) return '';
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function formatLogEntry(entry: LogEntry) {
  const details = formatLogDetails(entry.details);
  return [
    `#${entry.id} ${entry.timestamp} [${logLevelText(entry.level)}] [${entry.scope}] ${entry.message}`,
    details ? `details:\n${details}` : '',
  ].filter(Boolean).join('\n');
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.opacity = '0.01';
  textarea.style.pointerEvents = 'none';
  textarea.style.zIndex = '-1';
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('当前浏览器拦截了自动复制');
}

async function openManualCopyFallback(text: string, label: string) {
  copyFallbackTitle.value = label;
  copyFallbackText.value = text;
  await nextTick();
  selectCopyFallbackText();
}

function selectCopyFallbackText() {
  const textarea = copyFallbackTextarea.value;
  if (!textarea) return;
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
}

function closeCopyFallback() {
  copyFallbackText.value = '';
  copyFallbackTitle.value = '';
}

async function copyText(text: string, label = '已复制') {
  const value = String(text || '');
  if (!value.trim()) {
    showToast('没有可复制的日志内容', 'info');
    return;
  }
  try {
    await writeClipboardText(value);
    closeCopyFallback();
    logCopyStatus.value = label;
    showToast(label, 'success');
    window.setTimeout(() => {
      if (logCopyStatus.value === label) logCopyStatus.value = '';
    }, 1800);
  } catch (e: any) {
    await openManualCopyFallback(value, label);
    logCopyStatus.value = '浏览器禁止自动复制，已打开手动复制框';
    showToast('浏览器禁止自动复制，长按/全选手动复制', 'info');
  }
}

function copyLogEntry(entry: LogEntry) {
  copyText(formatLogEntry(entry), `已复制 #${entry.id}`);
}

function copyLogDetails(entry: LogEntry) {
  const details = formatLogDetails(entry.details);
  copyText(details || entry.message, `已复制详情 #${entry.id}`);
}

function copyVisibleLogs() {
  copyText(logEntries.value.map(formatLogEntry).join('\n\n'), `已复制 ${logEntries.value.length} 条日志`);
}

function levelBadgeClass(level: string) {
  if (level === 'error') return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
  if (level === 'warn') return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
  if (level === 'debug') return 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20';
  return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
}

function logLevelText(level: string) {
  if (level === 'error') return '错误';
  if (level === 'warn') return '警告';
  if (level === 'debug') return '调试';
  if (level === 'info') return '信息';
  return level;
}

function nodeOptions() {
  return (config.value?.llm?.apiKeys || []).map((node: any, idx: number) => ({ node, idx })).filter((item: any) => item.node.enabled !== false);
}

function modelsForNode(idx: number | string, currentVal = '', extra: string[] = []) {
  const node = config.value?.llm?.apiKeys?.[normalizeIndex(idx)];
  const list = [...extra, ...(node?.models || [])];
  if (currentVal && !list.includes(currentVal)) list.unshift(currentVal);
  return list;
}

function modelRouteGroups(): ModelRouteGroup[] {
  return [
    {
      id: 'core',
      title: '核心对话',
      subtitle: 'Bot 文本回复、自由模式规划和语音前置处理都在这里指定模型。',
      items: [
        { id: 'chat', title: '日常对话', badge: 'Bot', description: '群聊 @机器人 / 私聊的普通文本回复。', nodePath: ['llm', 'chatNodeIndex'], modelPath: ['llm', 'chatModel'], placeholder: 'gpt-4o-mini', enabledPath: ['llm', 'chatEnabled'] },
        { id: 'free-mode', title: '自由模式规划', badge: 'Bot', description: '判断未命中指令的 @ 消息应该文本回复、生图还是改图。', nodePath: ['freeMode', 'nodeIndex'], modelPath: ['freeMode', 'model'], placeholder: 'gpt-4o-mini', enabledPath: ['freeMode', 'enabled'] },
        { id: 'tts-preprocess', title: '语音前置处理', badge: 'TTS', description: '把文本回复翻译/改写成适合语音合成的文本。', nodePath: ['bot', 'tts', 'preprocess', 'nodeIndex'], modelPath: ['bot', 'tts', 'preprocess', 'model'], placeholder: 'gpt-4o-mini', enabledPath: ['bot', 'tts', 'preprocess', 'enabled'] },
      ],
    },
    {
      id: 'image',
      title: '图像与多模态',
      subtitle: '区分 Bot 与前台画布的生图、改图、反推模型，避免互相影响。',
      items: [
        { id: 'bot-image', title: 'Bot 文生图', badge: 'Bot', description: 'QQ群/私聊生图命令使用的图像生成模型。', nodePath: ['llm', 'imageNodeIndex'], modelPath: ['llm', 'imageModel'], placeholder: 'gpt-image-2', enabledPath: ['llm', 'imageEnabled'] },
        { id: 'bot-edit', title: 'Bot 图生图 / 改图', badge: 'Bot', description: '回复图片后执行图生图、改图命令。', nodePath: ['llm', 'editNodeIndex'], modelPath: ['llm', 'editModel'], placeholder: 'gpt-image-2' },
        { id: 'bot-interrogate', title: 'Bot 图片反推', badge: 'Bot', description: '机器人收到图片后执行反推、看图、描述命令。', nodePath: ['llm', 'interrogateNodeIndex'], modelPath: ['llm', 'interrogateModel'], placeholder: 'gpt-4o-mini' },
        { id: 'canvas-image', title: '画布文生图', badge: 'Canvas', description: '前台画布提交文生图任务时使用，独立于 Bot 生图。', nodePath: ['canvas', 'imageNodeIndex'], modelPath: ['canvas', 'imageModel'], placeholder: 'gpt-image-2', enabledPath: ['canvas', 'enabled'] },
        { id: 'canvas-edit', title: '画布图生图 / 改图', badge: 'Canvas', description: '前台画布上传参考图或编辑图片时使用。', nodePath: ['canvas', 'editNodeIndex'], modelPath: ['canvas', 'editModel'], placeholder: 'gpt-image-2', enabledPath: ['canvas', 'enabled'] },
        { id: 'canvas-interrogate', title: '画布原图反推', badge: 'Canvas', description: '画布反推库第一阶段：分析原图并生成描述。', nodePath: ['canvas', 'interrogateNodeIndex'], modelPath: ['canvas', 'interrogateModel'], placeholder: 'gpt-4o-mini', enabledPath: ['canvas', 'enabled'] },
        { id: 'canvas-interrogate-template', title: '画布模板化反推', badge: 'Canvas', description: '画布反推库第二阶段：把原图描述抽象成可复用模板。', nodePath: ['canvas', 'interrogateTemplateNodeIndex'], modelPath: ['canvas', 'interrogateTemplateModel'], placeholder: 'gpt-4o-mini', enabledPath: ['canvas', 'enabled'] },
      ],
    },
    {
      id: 'prompting',
      title: '提示词与模板',
      subtitle: '润色、模板填充、远程模板搜索和转模板都集中在同一处调度。',
      items: [
        { id: 'enhance', title: '提示词润色', badge: 'Prompt', description: '用户在生图命令后加“润色”时调用；模型填 none 表示关闭。', nodePath: ['llm', 'enhanceNodeIndex'], modelPath: ['llm', 'enhanceModel'], placeholder: 'claude-3-5-sonnet', extraModels: ['none'] },
        { id: 'template-fill', title: '本地模板填充', badge: 'Template', description: '把用户主体填入 mb_1 这类本地模板；none 表示直接替换。', nodePath: ['llm', 'templateNodeIndex'], modelPath: ['llm', 'templateModel'], placeholder: 'gpt-4o-mini', extraModels: ['none'] },
        { id: 'referenced-template', title: '引用模板填充', badge: 'Template', description: '引用文件/消息作为模板时单独使用的填充模型；none 表示不调用。', nodePath: ['llm', 'referencedTemplateNodeIndex'], modelPath: ['llm', 'referencedTemplateModel'], placeholder: 'gpt-4o-mini', extraModels: ['none'] },
        { id: 'prompts-chat', title: '远程模板智能匹配', badge: 'Remote', description: '从远程提示词库取候选后，选择并融合模板。', nodePath: ['promptsChat', 'smartNodeIndex'], modelPath: ['promptsChat', 'smartModel'], placeholder: 'gpt-4o-mini', extraModels: ['none'], enabledPath: ['promptsChat', 'enabled'] },
        { id: 'translation', title: '远程库翻译 / 本地化', badge: 'Remote', description: '把中文检索词转英文，并把远程结果说明翻译回中文；none 表示关闭。', nodePath: ['llm', 'translationNodeIndex'], modelPath: ['llm', 'translationModel'], placeholder: 'gpt-4o-mini', extraModels: ['none'] },
        { id: 'template-convert', title: '智能提示词转模板', badge: 'Template', description: '把现成提示词抽象成可复用模板并自动命名。', nodePath: ['llm', 'templateConvertNodeIndex'], modelPath: ['llm', 'templateConvertModel'], placeholder: 'gpt-4o-mini' },
      ],
    },
  ];
}

function getConfigPath(path: string[]) {
  return path.reduce((target: any, key) => target?.[key], config.value);
}

function setConfigPath(path: string[], value: unknown) {
  if (!config.value || !path.length) return;
  let target = config.value;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(target[key])) target[key] = {};
    target = target[key];
  }
  target[path[path.length - 1]] = value;
}

function updateModelRoute(item: ModelRouteItem, target: ModelRoutePathTarget, event: Event) {
  const el = event.target as HTMLInputElement | HTMLSelectElement | null;
  if (!el) return;
  if (target === 'node') {
    setConfigPath(item.nodePath, Number(el.value));
  } else {
    setConfigPath(item.modelPath, el.value);
  }
}

function routeNodeIndex(item: ModelRouteItem) {
  const idx = normalizeIndex(getConfigPath(item.nodePath) ?? 0);
  return Number.isFinite(idx) ? idx : 0;
}

function routeNodeOptions(item: ModelRouteItem) {
  const current = routeNodeIndex(item);
  return (config.value?.llm?.apiKeys || [])
    .map((node: any, idx: number) => ({ node, idx }))
    .filter((entry: any) => entry.node.enabled !== false || entry.idx === current);
}

function routeModelValue(item: ModelRouteItem) {
  return String(getConfigPath(item.modelPath) ?? '');
}

function routeModelOptions(item: ModelRouteItem) {
  return modelsForNode(routeNodeIndex(item), routeModelValue(item), item.extraModels || []);
}

function routeDatalistId(item: ModelRouteItem) {
  return `dl-route-${item.id}`;
}

function nodeDisplayName(idx: number | string) {
  const index = normalizeIndex(idx);
  const node = config.value?.llm?.apiKeys?.[index];
  const suffix = node?.enabled === false ? '（已禁用）' : '';
  return `${node?.name || `节点 ${index + 1}`}${suffix}`;
}

function routeEnabled(item: ModelRouteItem) {
  if (!item.enabledPath) return true;
  return getConfigPath(item.enabledPath) !== false;
}

function routeSummary(nodePath: string[], modelPath: string[]) {
  const idx = normalizeIndex(getConfigPath(nodePath) ?? 0);
  const model = String(getConfigPath(modelPath) || '未设置');
  return `${nodeDisplayName(idx)} / ${model}`;
}

function routeFailoverCount(item: ModelRouteItem) {
  const model = routeModelValue(item).trim();
  if (!model || model === 'none') return 0;
  const current = routeNodeIndex(item);
  return (config.value?.llm?.apiKeys || []).filter((node: any, idx: number) =>
    idx !== current && node.enabled !== false && Array.isArray(node.models) && node.models.includes(model)
  ).length;
}

function modelLimitRows() {
  const llm = config.value?.llm;
  const routedModels = modelRouteGroups()
    .flatMap((group) => group.items)
    .map((item) => [getConfigPath(item.nodePath), getConfigPath(item.modelPath)]);
  return (llm?.apiKeys || []).flatMap((node: any, idx: number) => {
    const models = new Set<string>(node.models || []);
    routedModels.forEach(([nodeIndex, model]: any[]) => {
      if (normalizeIndex(nodeIndex) === idx && model && model !== 'none') models.add(model);
    });
    return [...models].map((model: string) => ({ node, idx, model }));
  });
}

function findModelLimit(idx: number | string, model: string) {
  return (config.value?.llm?.modelLimits || []).find((rule: any) =>
    Number(rule.nodeIndex) === normalizeIndex(idx) && rule.model === model
  );
}

function ensureModelLimit(idx: number | string, model: string) {
  if (!config.value.llm.modelLimits) config.value.llm.modelLimits = [];
  let rule = findModelLimit(idx, model);
  if (!rule) {
    rule = { nodeIndex: normalizeIndex(idx), model, enabled: false, concurrency: 0 };
    config.value.llm.modelLimits.push(rule);
  }
  return rule;
}

function modelLimitEnabled(idx: number | string, model: string) {
  return findModelLimit(idx, model)?.enabled === true;
}

function modelLimitConcurrency(idx: number | string, model: string) {
  return findModelLimit(idx, model)?.concurrency || 0;
}

function setModelLimitEnabled(idx: number | string, model: string, enabled: boolean) {
  const rule = ensureModelLimit(idx, model);
  rule.enabled = enabled;
  if (enabled && !rule.concurrency) rule.concurrency = 1;
  showToast(`${enabled ? '启用' : '禁用'}了 ${model} 的排队限制`, 'info');
}

function setModelLimitConcurrency(idx: number | string, model: string, value: number) {
  const rule = ensureModelLimit(idx, model);
  rule.concurrency = Math.max(0, Number(value || 0));
  rule.enabled = rule.concurrency > 0;
}

function resetEnhancePrompt() {
  if (defaultPrompts.value?.enhancePromptTemplate) {
    config.value.llm.enhancePromptTemplate = defaultPrompts.value.enhancePromptTemplate;
    showToast('已重置润色提示词模板', 'success');
  }
}

function resetInterrogatePrompt() {
  if (defaultPrompts.value?.interrogatePromptTemplate) {
    config.value.llm.interrogatePromptTemplate = defaultPrompts.value.interrogatePromptTemplate;
    showToast('已重置 Bot 反推提示词模板', 'success');
  }
}

function resetCanvasInterrogatePrompt() {
  if (defaultPrompts.value?.interrogatePromptTemplate) {
    config.value.canvas.interrogatePromptTemplate = defaultPrompts.value.interrogatePromptTemplate;
    showToast('已重置画布反推提示词模板', 'success');
  }
}

function resetCanvasInterrogateTemplatePrompt() {
  if (defaultPrompts.value?.interrogateTemplatePromptTemplate) {
    config.value.canvas.interrogateTemplatePromptTemplate = defaultPrompts.value.interrogateTemplatePromptTemplate;
    showToast('已重置模板化反推提示词模板', 'success');
  }
}

function resetSafeRewritePrompt() {
  if (defaultPrompts.value?.safeRewritePromptTemplate) {
    config.value.llm.safeRewritePromptTemplate = defaultPrompts.value.safeRewritePromptTemplate;
    showToast('已重置合规改写提示词模板', 'success');
  }
}

function resetTemplatePrompt() {
  if (defaultPrompts.value?.templatePromptTemplate) {
    config.value.llm.templatePromptTemplate = defaultPrompts.value.templatePromptTemplate;
    showToast('已重置通用模板提示词', 'success');
  }
}

function resetReferencedTemplatePrompt() {
  if (defaultPrompts.value?.referencedTemplatePromptTemplate) {
    config.value.llm.referencedTemplatePromptTemplate = defaultPrompts.value.referencedTemplatePromptTemplate;
    showToast('已重置引用模板提示词', 'success');
  }
}

function resetTemplateConvertPrompt() {
  if (defaultPrompts.value?.templateConvertPromptTemplate) {
    config.value.llm.templateConvertPromptTemplate = defaultPrompts.value.templateConvertPromptTemplate;
    showToast('已重置转化提示词模板', 'success');
  }
}

function resetTemplateTitlePrompt() {
  if (defaultPrompts.value?.templateTitlePromptTemplate) {
    config.value.llm.templateTitlePromptTemplate = defaultPrompts.value.templateTitlePromptTemplate;
  }
}

function resetTranslationPrompt() {
  if (defaultPrompts.value?.translationPromptTemplate) {
    config.value.llm.translationPromptTemplate = defaultPrompts.value.translationPromptTemplate;
  }
}

function resetPromptsChatSearchPrompt() {
  if (defaultPrompts.value?.promptsChatSearchQueryPromptTemplate) {
    config.value.promptsChat.searchQueryPromptTemplate = defaultPrompts.value.promptsChatSearchQueryPromptTemplate;
  }
}

function resetPromptsChatSmartPrompt() {
  if (defaultPrompts.value?.promptsChatSmartPromptTemplate) {
    config.value.promptsChat.smartPromptTemplate = defaultPrompts.value.promptsChatSmartPromptTemplate;
  }
}

function promptTemplates() {
  if (!config.value.bot.promptTemplates) config.value.bot.promptTemplates = [];
  return config.value.bot.promptTemplates;
}

function templateKey(tpl: any, idx: number) {
  return tpl?.id || `mb_${idx + 1}`;
}

function isTemplateCollapsed(tpl: any, idx: number) {
  return collapsedTemplates.value[templateKey(tpl, idx)] === true;
}

function toggleTemplateCollapsed(tpl: any, idx: number) {
  const key = templateKey(tpl, idx);
  collapsedTemplates.value = { ...collapsedTemplates.value, [key]: !collapsedTemplates.value[key] };
}

function normalizePromptTemplateIds() {
  promptTemplates().forEach((item: any, idx: number) => {
    item.id = `mb_${idx + 1}`;
    if (!item.title) item.title = `模板 ${idx + 1}`;
  });
}

function addPromptTemplate() {
  const rows = promptTemplates();
  rows.push({
    id: `mb_${rows.length + 1}`,
    title: `模板 ${rows.length + 1}`,
    prompt: '{{prompt}}',
  });
}

function removePromptTemplate(idx: number) {
  promptTemplates().splice(idx, 1);
  normalizePromptTemplateIds();
}

function normalizeTtsVoiceIds() {
  const tts = config.value?.bot?.tts;
  if (!tts) return [];
  const source = Array.isArray(tts.voiceIds) ? tts.voiceIds : [];
  const active = String(tts.voiceId || '').trim();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of [active, ...source]) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  tts.voiceIds = ids;
  if (!tts.voiceId && ids.length) tts.voiceId = ids[0];
  return ids;
}

function addTtsVoiceId() {
  const tts = config.value?.bot?.tts;
  if (!tts) return;
  if (!Array.isArray(tts.voiceIds)) tts.voiceIds = [];
  tts.voiceIds.push('');
}

function removeTtsVoiceId(index: number) {
  const tts = config.value?.bot?.tts;
  if (!tts || !Array.isArray(tts.voiceIds)) return;
  const removed = String(tts.voiceIds[index] || '').trim();
  tts.voiceIds.splice(index, 1);
  if (removed && tts.voiceId === removed) tts.voiceId = tts.voiceIds.map((item: string) => String(item || '').trim()).find(Boolean) || '';
  normalizeTtsVoiceIds();
}

function selectTtsVoiceId(index: number) {
  const tts = config.value?.bot?.tts;
  if (!tts || !Array.isArray(tts.voiceIds)) return;
  const id = String(tts.voiceIds[index] || '').trim();
  if (id) tts.voiceId = id;
}

function onTtsVoiceIdInput(index: number) {
  const tts = config.value?.bot?.tts;
  if (!tts || !Array.isArray(tts.voiceIds)) return;
  const current = String(tts.voiceIds[index] || '').trim();
  if (!tts.voiceId && current) tts.voiceId = current;
  if (tts.voiceId === current) tts.voiceId = current;
}

async function convertPromptToTemplate() {
  const rawPrompt = templateConvertSource.value.trim();
  if (!rawPrompt) {
    templateConvertStatus.value = '请先粘贴要转化的提示词';
    return;
  }
  templateConvertLoading.value = true;
  templateConvertStatus.value = 'AI 正在转化模板...';
  try {
    const res = await axios.post(`${API_BASE}/templates/convert`, { rawPrompt }, { headers: authHeaders() });
    if (res.data.config) applyServerConfig(res.data.config);
    templateConvertSource.value = '';
    const tpl = res.data.template;
    templateConvertStatus.value = `已新增模板 ${tpl?.id || ''} ${tpl?.title || ''}`.trim();
  } catch (e: any) {
    templateConvertStatus.value = `转化失败: ${e.response?.data?.error || e.message}`;
  } finally {
    templateConvertLoading.value = false;
  }
}

async function generateTemplateTitle(tpl: any, idx: number) {
  if (!tpl?.prompt?.trim()) {
    templateConvertStatus.value = '模板内容为空，无法命名';
    return;
  }
  const key = templateKey(tpl, idx);
  templateTitleLoading.value = { ...templateTitleLoading.value, [key]: true };
  try {
    const res = await axios.post(`${API_BASE}/templates/title`, { templatePrompt: tpl.prompt }, { headers: authHeaders() });
    tpl.title = res.data.title || tpl.title;
  } catch (e: any) {
    templateConvertStatus.value = `命名失败: ${e.response?.data?.error || e.message}`;
  } finally {
    templateTitleLoading.value = { ...templateTitleLoading.value, [key]: false };
  }
}
</script>

<template>
  <div class="app-root">

    <!-- Login -->
    <div v-if="!isAuthenticated" class="admin-login-page">
      <section class="login-shell" aria-label="智能机器人平台登录">
        <div class="login-visual">
          <div class="brand-lockup">
            <span class="brand-mark">智</span>
            <div>
              <strong>智能机器人平台</strong>
              <span>智能、连接、无阻碍</span>
            </div>
          </div>
          <div class="login-visual__copy">
            <span class="eyebrow">管理控制台</span>
            <h1>后台管理控制台</h1>
            <p>集中管理模型节点、回复策略、画布任务与运行日志。</p>
          </div>
        </div>

        <div class="login-card card">
          <div class="login-card__header">
            <span class="brand-mark brand-mark--small">智</span>
            <div>
              <h2>欢迎回来</h2>
              <p>请登录以继续管理控制台</p>
            </div>
          </div>
          <div class="space-y-4">
            <div>
              <label class="label-sm">管理密码 / 访问令牌</label>
              <input v-model="password" @keyup.enter="login" type="password" placeholder="输入管理密码" class="input-field" />
            </div>
            <button @click="login" class="btn-primary w-full">登录</button>
            <p v-if="loginError" class="form-error">{{ loginError }}</p>
          </div>
        </div>
      </section>
    </div>

    <!-- Dashboard -->
    <div v-else class="admin-shell">
      <button class="sidebar-scrim" :data-open="isMobileSidebarOpen" type="button" aria-label="关闭导航" @click="closeMobileSidebar"></button>

      <aside :class="['sidebar', isMobileSidebarOpen ? 'mobile-open' : '']">
        <div class="sidebar-brand">
          <span class="brand-mark brand-mark--small">智</span>
          <div>
            <h1>智能机器人平台</h1>
            <span>v2.0 管理台</span>
          </div>
        </div>
        <nav class="sidebar-nav" aria-label="主导航">
          <button v-for="item in menuItems" :key="item.id" @click="currentPage = item.id; closeMobileSidebar()"
            :class="['sidebar-item', currentPage === item.id ? 'sidebar-item-active' : 'sidebar-item-inactive']">
            <span class="sidebar-item__icon">{{ item.icon }}</span><span>{{ item.label }}</span>
          </button>
        </nav>
        <div class="sidebar-footer">
          <button @click="handleLogout" class="sidebar-item sidebar-item-inactive w-full danger-link">
            <span class="sidebar-item__icon">退</span><span>退出登录</span>
          </button>
        </div>
      </aside>

      <main class="admin-main">

        <!-- Top Bar -->
        <div class="admin-topbar" v-if="config">
          <div class="admin-topbar__title">
            <button class="mobile-menu-button" type="button" aria-label="打开导航" @click="toggleMobileSidebar">&#9776;</button>
            <div>
              <p>{{ currentPage === 'logs' ? '系统日志与诊断' : '配置中心' }}</p>
              <h2>{{ pageLabel() }}</h2>
            </div>
          </div>
          <div class="admin-topbar__actions">
            <span class="status-pill" :data-tone="saveStatus.includes('失败') ? 'error' : 'success'">
              {{ saveStatus || '已保存' }}
            </span>
            <input ref="configImportInput" type="file" accept="application/json,.json" class="hidden" @change="importConfigFromFile" />
            <button @click="exportConfig" class="btn-outline text-sm">导出</button>
            <button @click="triggerImportConfig" class="btn-outline text-sm">导入</button>
            <button @click="saveConfig" :disabled="savingConfig" class="btn-primary text-sm disabled:opacity-60 disabled:cursor-not-allowed">{{ savingConfig ? '保存中...' : '保存配置' }}</button>
          </div>
        </div>

        <div v-if="config" class="admin-content">

          <!-- ═══ PAGE: 大模型管理 ═══ -->
          <div v-show="currentPage === 'llm'" class="space-y-4 animate-fadein">

            <!-- API 节点列表 -->
            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="section-title">🌐 接口节点管理</h2>
                <button @click="addNode" class="btn-outline text-sm">＋ 添加节点</button>
              </div>

              <div class="space-y-3">
                <div v-for="(node, idx) in config.llm.apiKeys" :key="idx"
                  :class="['node-card', config.llm.activeNodeIndex === idx ? 'node-card-active' : '']">
                  <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center gap-2">
                      <button @click="setActiveNode(idx)"
                        :class="['w-5 h-5 rounded-full border-2 transition-all flex items-center justify-center',
                          config.llm.activeNodeIndex === idx ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300']">
                        <span v-if="config.llm.activeNodeIndex === idx" class="w-2 h-2 rounded-full bg-white"></span>
                      </button>
                      <span class="text-sm font-semibold text-slate-700">{{ node.name || '未命名' }}</span>
                      <span v-if="config.llm.activeNodeIndex === idx" class="tag text-indigo-600 bg-indigo-50 border-indigo-200">活跃</span>
                      <label class="flex items-center gap-1 text-xs text-slate-500">
                        <input type="checkbox" v-model="node.enabled" class="accent-indigo-500" />
                        启用
                      </label>
                    </div>
                    <div class="flex gap-2">
                      <button @click="applyAnyRouterPreset(idx)" class="btn-outline text-xs py-1 px-3">
                        Any Router
                      </button>
                      <button @click="applyChatGpt2ApiPreset(idx)" class="btn-outline text-xs py-1 px-3">
                        chatgpt2api
                      </button>
                      <button @click="fetchModels(idx)" :disabled="modelLoading" class="btn-outline text-xs py-1 px-3">
                        {{ modelLoading ? '⏳' : '🔄' }} 获取模型
                      </button>
                      <button v-if="config.llm.apiKeys.length > 1" @click="removeNode(idx)" class="btn-danger text-xs">删除</button>
                    </div>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label class="label-sm">节点名称</label>
                      <input v-model="node.name" class="input-field" placeholder="我的节点" />
                    </div>
                    <div>
                      <label class="label-sm">基础地址</label>
                      <input v-model="node.baseUrl" class="input-field" placeholder="OpenAI 兼容 Base URL，例如 https://anyrouter.top/v1" />
                      <span class="text-slate-400 text-xs mt-1 block">也可直接粘贴 “https://anyrouter.top/v1-密钥sk-...” ，点击获取模型时会自动拆分。</span>
                    </div>
                    <div>
                      <label class="label-sm">接口密钥</label>
                      <input v-model="node.key" type="password" class="input-field" placeholder="API Key（留空不保存）" />
                    </div>
                  </div>
                  <div v-if="node.models?.length" class="mt-3 rounded-lg border border-slate-200 bg-white/70 p-3">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-xs font-semibold text-slate-500">已保存模型 {{ node.models.length }}</span>
                      <span v-if="node.modelsFetchedAt" class="text-[11px] text-slate-400">{{ node.modelsFetchedAt }}</span>
                    </div>
                    <div class="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                      <span v-for="m in node.models" :key="`${idx}-${m}`" class="tag">{{ m }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <p v-if="modelError" class="text-red-500 text-xs mt-3">{{ modelError }}</p>
              <p v-if="fetchedModels.length" class="text-emerald-600 text-xs mt-3">✅ 已获取 {{ fetchedModels.length }} 个模型</p>
            </div>

            <!-- 模型分工 -->
            <div class="card p-5">
              <h2 class="section-title mb-4">📋 能力开关与参数</h2>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-5">

                <!-- Chat -->
                <div class="p-4 rounded-xl border" :class="config.llm.chatEnabled ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200 bg-gray-50 opacity-60'">
                  <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold">🤖 日常对话</span>
                    <label class="toggle"><input type="checkbox" v-model="config.llm.chatEnabled"><span class="toggle-slider"></span></label>
                  </div>
                  <div class="rounded-lg border border-emerald-100 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'chatNodeIndex'], ['llm', 'chatModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <div class="mt-3">
                    <label class="label-sm">智能推理等级</label>
                    <select v-model="config.llm.reasoningEffort" class="input-field" :disabled="!config.llm.chatEnabled">
                      <option value="low">低</option>
                      <option value="medium">标准</option>
                      <option value="high">高</option>
                      <option value="xhigh">超高</option>
                    </select>
                  </div>
                  <span class="text-slate-400 text-xs mt-1 block">仅对推理类模型生效，默认高</span>
                  <span class="text-slate-400 text-xs mt-1 block">群聊 @机器人 / 私聊对话</span>
                </div>

                <!-- Enhance -->
                <div class="p-4 rounded-xl border border-amber-200 bg-amber-50/30">
                  <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold">🧠 提示词润色</span>
                    <span class="tag text-amber-700 bg-amber-50 border-amber-200">关键词触发</span>
                  </div>
                  <div class="rounded-lg border border-amber-100 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'enhanceNodeIndex'], ['llm', 'enhanceModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <span class="text-slate-400 text-xs mt-1 block">用户在生图命令后加“润色”才会调用</span>
                </div>

                <!-- Translation -->
                <div class="p-4 rounded-xl border border-teal-200 bg-teal-50/30">
                  <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold">🌐 翻译 / 本地化</span>
                    <span class="tag text-teal-700 bg-teal-50 border-teal-200">远程库搜索</span>
                  </div>
                  <div class="rounded-lg border border-teal-100 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'translationNodeIndex'], ['llm', 'translationModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <span class="text-slate-400 text-xs mt-1 block">将中文关键词转为英文检索，并把结果标题、简介等说明翻译成中文；填空值则关闭模型翻译。</span>
                </div>

                <!-- Image -->
                <div class="p-4 rounded-xl border" :class="config.llm.imageEnabled ? 'border-purple-200 bg-purple-50/30' : 'border-gray-200 bg-gray-50 opacity-60'">
                  <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold">🎨 图像生成</span>
                    <label class="toggle"><input type="checkbox" v-model="config.llm.imageEnabled"><span class="toggle-slider"></span></label>
                  </div>
                  <div class="rounded-lg border border-purple-100 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'imageNodeIndex'], ['llm', 'imageModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <span class="text-slate-400 text-xs mt-1 block">各类图像生成模型</span>
                  <div class="mt-3">
                    <label class="label-sm">一次生成张数</label>
                    <input v-model.number="config.llm.imageCount" type="number" min="1" max="4" step="1"
                      class="input-field" :disabled="!config.llm.imageEnabled" />
                    <span class="text-slate-400 text-xs mt-1 block">大于 1 时会合成编号预览图返回。</span>
                  </div>
                  <div class="mt-3">
                    <label class="label-sm">生图超时（毫秒）</label>
                    <input v-model.number="config.llm.imageTimeoutMs" type="number" min="30000" step="30000"
                      class="input-field" :disabled="!config.llm.imageEnabled" />
                    <span class="text-slate-400 text-xs mt-1 block">默认 300000，复杂图可调到 600000。</span>
                  </div>
                  <div class="mt-3 grid grid-cols-2 gap-2">
                    <div>
                      <label class="label-sm">失败重试次数</label>
                      <input v-model.number="config.llm.imageRetryCount" type="number" min="0" max="5" step="1"
                        class="input-field" :disabled="!config.llm.imageEnabled" />
                    </div>
                    <div>
                      <label class="label-sm">重试间隔（毫秒）</label>
                      <input v-model.number="config.llm.imageRetryDelayMs" type="number" min="0" step="500"
                        class="input-field" :disabled="!config.llm.imageEnabled" />
                    </div>
                  </div>
                  <label class="mt-3 flex items-center justify-between gap-3 rounded-lg border border-purple-100 bg-white/70 px-3 py-2">
                    <span class="text-xs text-slate-600">失败后合规改写重试</span>
                    <input type="checkbox" v-model="config.llm.safeRewriteOnFailure" class="h-4 w-4 accent-purple-500" />
                  </label>
                  <div class="mt-3 flex gap-2">
                    <input v-model="imageTestPrompt" class="input-field" placeholder="测试提示词" :disabled="imageTestLoading || !config.llm.imageEnabled" />
                    <button @click="testImageApi" :disabled="imageTestLoading || !config.llm.imageEnabled" class="btn-outline text-xs whitespace-nowrap">
                      {{ imageTestLoading ? '测试中...' : '测试生图' }}
                    </button>
                  </div>
                  <div v-if="imageTestResult" class="mt-3 rounded-lg border px-3 py-2 text-xs"
                    :class="imageTestResult.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-600'">
                    <div class="font-semibold">{{ imageTestResult.success ? '生图接口正常' : '生图接口异常' }}</div>
                    <div class="mt-1 break-words">{{ imageTestResult.message }}</div>
                    <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 opacity-80">
                      <span v-if="imageTestResult.durationMs !== undefined">耗时：{{ imageTestResult.durationMs }} 毫秒</span>
                      <span v-if="imageTestResult.base64Chars">编码长度：{{ imageTestResult.base64Chars }} 字符</span>
                    </div>
                  </div>
                </div>

                <!-- Edit -->
                <div class="p-4 rounded-xl border border-cyan-200 bg-cyan-50/30">
                  <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold">🖼️ 图生图 / 改图</span>
                  </div>
                  <div class="rounded-lg border border-cyan-100 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'editNodeIndex'], ['llm', 'editModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <span class="text-slate-400 text-xs mt-1 block">回复图片后使用图生图/改图命令</span>
                </div>

                <!-- Bot Interrogate -->
                <div class="p-4 rounded-xl border border-rose-200 bg-rose-50/30">
                  <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold">🔍 机器人图片反推</span>
                  </div>
                  <div class="rounded-lg border border-rose-100 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'interrogateNodeIndex'], ['llm', 'interrogateModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <label class="label-sm mt-3">机器人反推超时（毫秒）</label>
                  <input v-model.number="config.llm.interrogateTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
                  <span class="text-slate-400 text-xs mt-1 block">仅用于机器人回复图片后的反推命令；前台反推库在画布管理中单独配置。</span>
                </div>

              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
                <h2 class="section-title">🚦 模型请求限制</h2>
                <span class="text-slate-400 text-xs">并发数 0 表示不限制；设置为 1 时按顺序排队。</span>
              </div>
              <div v-if="modelLimitRows().length" class="space-y-2 max-h-80 overflow-y-auto">
                <div v-for="item in modelLimitRows()" :key="`${item.idx}-${item.model}`"
                  class="grid grid-cols-1 lg:grid-cols-[1fr_160px_120px] gap-3 items-center rounded-lg border border-slate-200 bg-white/70 p-3">
                  <div class="min-w-0">
                    <div class="text-xs text-slate-400">{{ item.node.name || `节点 ${item.idx + 1}` }}</div>
                    <div class="text-sm font-semibold text-slate-700 break-all">{{ item.model }}</div>
                  </div>
                  <label class="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" class="h-4 w-4 accent-cyan-500"
                      :checked="modelLimitEnabled(item.idx, item.model)"
                      @change="setModelLimitEnabled(item.idx, item.model, ($event.target as HTMLInputElement).checked)" />
                    启用排队限制
                  </label>
                  <div>
                    <label class="label-sm">并发数</label>
                    <input type="number" min="0" step="1" class="input-field"
                      :value="modelLimitConcurrency(item.idx, item.model)"
                      @input="setModelLimitConcurrency(item.idx, item.model, Number(($event.target as HTMLInputElement).value))" />
                  </div>
                </div>
              </div>
              <p v-else class="text-slate-400 text-sm">还没有已保存模型。先在接口节点里点击“获取模型”，这里会自动列出可限制的模型。</p>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="section-title">🧩 提示词模板</h2>
                <div class="flex flex-wrap gap-2">
                  <button @click="resetEnhancePrompt" class="btn-outline text-xs">默认润色</button>
                  <button @click="resetInterrogatePrompt" class="btn-outline text-xs">默认机器人反推</button>
                  <button @click="resetSafeRewritePrompt" class="btn-outline text-xs">默认合规改写</button>
                  <button @click="resetTranslationPrompt" class="btn-outline text-xs">默认翻译</button>
                </div>
              </div>
              <div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
                <div>
                  <label class="label-sm">润色模板</label>
                  <textarea v-model="config.llm.enhancePromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可使用 <code v-pre>{{rawPrompt}}</code> 占位用户原始提示词。</span>
                </div>
                <div>
                  <label class="label-sm">机器人图片反推模板</label>
                  <textarea v-model="config.llm.interrogatePromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">只影响机器人的图片反推命令，不影响前台反推库。</span>
                </div>
                <div>
                  <label class="label-sm">合规改写模板</label>
                  <textarea v-model="config.llm.safeRewritePromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">生图失败后用于保留意图、移除风险内容。</span>
                </div>
                <div>
                  <label class="label-sm">远程库翻译模板</label>
                  <textarea v-model="config.llm.translationPromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code v-pre>{{mode}}</code>、<code v-pre>{{input}}</code>。不要要求翻译模板正文。</span>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <h2 class="section-title mb-4">🧵 会话策略</h2>
              <div class="grid grid-cols-1 lg:grid-cols-[220px_1fr_1fr] gap-4 items-end">
                <div class="p-4 rounded-xl border border-sky-200 bg-sky-50/40">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-semibold text-slate-700">自动新会话</span>
                    <label class="toggle"><input type="checkbox" v-model="config.llm.autoNewConversation"><span class="toggle-slider"></span></label>
                  </div>
                  <span class="text-slate-400 text-xs block">达到阈值后丢弃旧上下文，从下一句开始全新对话。</span>
                </div>
                <div>
                  <label class="label-sm">最大轮数</label>
                  <input v-model.number="config.llm.maxConversationRounds" type="number" min="1" max="100" class="input-field"
                    :disabled="!config.llm.autoNewConversation" />
                  <span class="text-slate-400 text-xs mt-1 block">按用户发言轮数计数，建议 6-12。</span>
                </div>
                <div>
                  <label class="label-sm">最大字符数</label>
                  <input v-model.number="config.llm.maxConversationChars" type="number" min="100" step="100" class="input-field"
                    :disabled="!config.llm.autoNewConversation" />
                  <span class="text-slate-400 text-xs mt-1 block">总上下文字符达到阈值也会自动开新会话。</span>
                </div>
              </div>
            </div>

            <!-- 已探测模型 -->
            <div v-if="fetchedModels.length" class="card p-5">
              <h2 class="section-title mb-3">📦 已探测模型 ({{ fetchedModels.length }})</h2>
              <div class="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                <span v-for="m in fetchedModels" :key="m" class="tag">{{ m }}</span>
              </div>
            </div>
          </div>

          <!-- PAGE: 模型路由中心 -->
          <div v-show="currentPage === 'modelRoutes'" class="space-y-4 animate-fadein">
            <div class="card p-5 overflow-hidden">
              <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <span class="eyebrow">MODEL ROUTING</span>
                  <h2 class="section-title mt-1">模型路由中心</h2>
                  <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                    所有“选择节点 / 选择模型”的后台入口统一移动到这里。Bot、前台画布、模板、反推、自由模式互不混用；当某节点的某模型失效时，运行时会按同名模型自动轮询其它可用节点，这里会显示当前保存的可见路由状态。
                  </p>
                </div>
                <div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                  <div class="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-3">
                    <div class="text-slate-400">可用节点</div>
                    <div class="mt-1 text-xl font-black text-white">{{ nodeOptions().length }}</div>
                  </div>
                  <div class="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                    <div class="text-slate-400">路由场景</div>
                    <div class="mt-1 text-xl font-black text-white">{{ modelRouteGroups().reduce((sum, group) => sum + group.items.length, 0) }}</div>
                  </div>
                  <div class="rounded-2xl border border-violet-500/20 bg-violet-500/10 px-4 py-3 col-span-2 sm:col-span-1">
                    <div class="text-slate-400">保存方式</div>
                    <div class="mt-1 text-sm font-bold text-white">仅提交变更</div>
                  </div>
                </div>
              </div>
            </div>

            <div v-for="group in modelRouteGroups()" :key="group.id" class="card p-5">
              <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 class="text-base font-black text-slate-100">{{ group.title }}</h3>
                  <p class="text-xs text-slate-400 mt-1">{{ group.subtitle }}</p>
                </div>
                <span class="tag text-indigo-200 bg-indigo-500/10 border-indigo-500/20">{{ group.items.length }} 条路由</span>
              </div>

              <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div v-for="route in group.items" :key="route.id"
                  class="rounded-2xl border border-slate-800 bg-slate-950/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-sm font-bold text-slate-100">{{ route.title }}</span>
                        <span class="tag">{{ route.badge || 'Model' }}</span>
                        <span :class="['tag', routeEnabled(route) ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' : 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20']">
                          {{ routeEnabled(route) ? '启用中' : '未启用' }}
                        </span>
                      </div>
                      <p class="mt-2 text-xs leading-5 text-slate-400">{{ route.description }}</p>
                    </div>
                    <span v-if="routeFailoverCount(route)" class="shrink-0 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[10px] font-bold text-cyan-200">
                      备援 {{ routeFailoverCount(route) }}
                    </span>
                  </div>

                  <div class="mt-3 rounded-xl border border-slate-800 bg-black/20 px-3 py-2 text-[11px] text-slate-400">
                    当前：<span class="font-mono text-slate-200">{{ routeSummary(route.nodePath, route.modelPath) }}</span>
                  </div>

                  <div class="mt-3 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3">
                    <div>
                      <label class="label-sm">节点</label>
                      <select :value="routeNodeIndex(route)" @change="updateModelRoute(route, 'node', $event)" class="input-field font-mono">
                        <option v-for="item in routeNodeOptions(route)" :key="`${route.id}-node-${item.idx}`" :value="item.idx">
                          {{ item.node.name || `节点 ${item.idx + 1}` }}{{ item.node.enabled === false ? '（已禁用）' : '' }}
                        </option>
                      </select>
                    </div>
                    <div>
                      <label class="label-sm">模型</label>
                      <input :value="routeModelValue(route)" :list="routeDatalistId(route)" @input="updateModelRoute(route, 'model', $event)" class="input-field font-mono" :placeholder="route.placeholder || 'gpt-4o-mini'" />
                      <datalist :id="routeDatalistId(route)">
                        <option v-for="m in routeModelOptions(route)" :key="`${route.id}-${m}`" :value="m" />
                      </datalist>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ═══ PAGE: Hugging Face 免费接口 ═══ -->
          <div v-show="currentPage === 'huggingFace'" class="space-y-4 animate-fadein">
            <div class="card p-5">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-5">
                <div>
                  <h2 class="section-title">🤗 Hugging Face 免费接口</h2>
                  <p class="text-slate-500 text-sm mt-1">单独管理 Hugging Face Router / Hub 模型。密钥只保存在本地配置，bot 列表中永远排在普通接口后面。</p>
                  <p class="text-slate-400 text-xs mt-1">bot 命令示例：<code>@bot /模型</code> 查看编码，<code>@bot /q hf.1</code> 切换到 HF 第 1 个缓存模型。</p>
                </div>
                <div class="flex flex-wrap gap-3">
                  <label class="flex items-center gap-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm font-semibold text-slate-700">
                    <input type="checkbox" v-model="config.huggingFace.enabled" class="h-4 w-4 accent-amber-500" />
                    启用 HF 接口
                  </label>
                  <label class="flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-sm font-semibold text-indigo-700">
                    <input type="checkbox" v-model="config.huggingFace.useForChat" class="h-4 w-4 accent-indigo-500" />
                    当前作为 bot 文本模型
                  </label>
                </div>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
                <div>
                  <label class="label-sm">Hugging Face Token</label>
                  <input v-model="config.huggingFace.token" type="password" class="input-field font-mono" placeholder="hf_...（查询私有/可见模型时填写）" />
                  <span class="text-slate-400 text-xs mt-1 block">用于查询 token 可见模型与 Router 调用；不会显示在日志里。</span>
                </div>
                <div>
                  <label class="label-sm">Router/OpenAI 兼容地址</label>
                  <input v-model="config.huggingFace.baseUrl" class="input-field font-mono" placeholder="https://router.huggingface.co/v1" />
                  <span class="text-slate-400 text-xs mt-1 block">对话类默认走 OpenAI-compatible chat/completions。</span>
                </div>
                <div>
                  <label class="label-sm">Hub 模型列表 API</label>
                  <input v-model="config.huggingFace.hubApiUrl" class="input-field font-mono" placeholder="https://huggingface.co/api/models" />
                  <span class="text-slate-400 text-xs mt-1 block">查询模型表用，可改为镜像地址。</span>
                </div>
                <div>
                  <label class="label-sm">请求模式备用方案</label>
                  <select v-model="config.huggingFace.requestMode" class="input-field font-mono">
                    <option value="openai-chat">OpenAI 聊天兼容（默认）</option>
                    <option value="router-chat">HF Router Chat</option>
                    <option value="legacy-inference">旧 Inference API</option>
                    <option value="provider-task">按任务 Provider API</option>
                  </select>
                  <span class="text-slate-400 text-xs mt-1 block">当前 bot 文本优先使用 OpenAI 聊天兼容；其它模式先保存备用。</span>
                </div>
                <div>
                  <label class="label-sm">接口超时（毫秒）</label>
                  <input v-model.number="config.huggingFace.timeoutMs" type="number" min="5000" step="5000" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">缓存有效期（秒）</label>
                  <input v-model.number="config.huggingFace.cacheTtlSeconds" type="number" min="60" step="60" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">当前选中编码</label>
                  <input v-model="config.huggingFace.selectedModelCode" class="input-field font-mono" placeholder="hf.1" readonly />
                </div>
                <div>
                  <label class="label-sm">当前选中模型</label>
                  <input v-model="config.huggingFace.selectedModelId" class="input-field font-mono" placeholder="未选择" readonly />
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between mb-4">
                <div>
                  <h2 class="section-title">🔎 傻瓜式筛选面板</h2>
                  <p class="text-slate-400 text-sm mt-1">先选预设，再按需补充关键词/作者/标签。点击查询后会保存结果缓存，避免重复请求 Hugging Face。</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button @click="applyHfPreset('chat')" class="btn-outline text-xs">对话/LLM</button>
                  <button @click="applyHfPreset('vision')" class="btn-outline text-xs">视觉理解/VLM</button>
                  <button @click="applyHfPreset('image')" class="btn-outline text-xs">文生图</button>
                  <button @click="applyHfPreset('textVideo')" class="btn-outline text-xs">文生视频</button>
                  <button @click="applyHfPreset('imageVideo')" class="btn-outline text-xs">图生视频</button>
                  <button @click="applyHfPreset('videoVideo')" class="btn-outline text-xs">视频改视频</button>
                  <button @click="applyHfPreset('anyAny')" class="btn-outline text-xs">多模态/任意转任意</button>
                  <button @click="applyHfPreset('asr')" class="btn-outline text-xs">语音识别</button>
                  <button @click="applyHfPreset('private')" class="btn-outline text-xs">我的可见模型</button>
                  <button @click="applyHfPreset('hot')" class="btn-outline text-xs">热门可推理</button>
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <div>
                  <label class="label-sm">关键词搜索</label>
                  <input v-model="config.huggingFace.filters.search" class="input-field" placeholder="例如 Qwen、Llama、SDXL" />
                  <span class="text-slate-400 text-xs mt-1 block">按模型名/描述模糊搜索。</span>
                </div>
                <div>
                  <label class="label-sm">作者/组织</label>
                  <input v-model="config.huggingFace.filters.author" class="input-field" placeholder="例如 Qwen、meta-llama" />
                  <span class="text-slate-400 text-xs mt-1 block">只看某个组织或作者发布的模型。</span>
                </div>
                <div>
                  <label class="label-sm">任务类型 pipeline_tag</label>
                  <select v-model="config.huggingFace.filters.pipelineTag" class="input-field font-mono">
                    <option value="">全部任务</option>
                    <option value="text-generation">文本生成 / 对话模型</option>
                    <option value="image-text-to-text">图文转文本 / VLM</option>
                    <option value="text-to-image">文生图</option>
                    <option value="image-to-image">图生图</option>
                    <option value="text-to-video">文生视频</option>
                    <option value="image-to-video">图生视频</option>
                    <option value="video-to-video">视频改视频</option>
                    <option value="image-text-to-video">图文生视频 / TI2V</option>
                    <option value="video-text-to-text">视频理解 / 视频转文本</option>
                    <option value="any-to-any">多模态任意转任意</option>
                    <option value="automatic-speech-recognition">语音识别</option>
                    <option value="text-to-speech">文本转语音</option>
                    <option value="text-to-audio">文本转音频</option>
                    <option value="audio-to-audio">音频转音频</option>
                    <option value="translation">翻译</option>
                    <option value="summarization">摘要</option>
                    <option value="question-answering">问答</option>
                    <option value="token-classification">Token 分类 / NER</option>
                    <option value="text-classification">文本分类</option>
                    <option value="zero-shot-classification">零样本分类</option>
                    <option value="sentence-similarity">向量/相似度</option>
                    <option value="feature-extraction">特征提取 / Embedding</option>
                    <option value="fill-mask">填空/掩码</option>
                    <option value="object-detection">目标检测</option>
                    <option value="image-classification">图像分类</option>
                    <option value="image-segmentation">图像分割</option>
                    <option value="depth-estimation">深度估计</option>
                    <option value="mask-generation">遮罩生成</option>
                  </select>
                  <span class="text-slate-400 text-xs mt-1 block">这是 HF 最重要的任务筛选字段；视频类通常需要关闭“仅显示聊天可切换模型”。</span>
                </div>
                <div>
                  <label class="label-sm">标签 filter</label>
                  <input v-model="config.huggingFace.filters.tags" class="input-field" placeholder="多个用逗号分隔，如 chat,gguf" />
                  <span class="text-slate-400 text-xs mt-1 block">对应 HF tags/filter 参数，可叠加多个。</span>
                </div>
                <div>
                  <label class="label-sm">框架/库 library</label>
                  <input v-model="config.huggingFace.filters.library" class="input-field" placeholder="transformers / diffusers / mlx" />
                </div>
                <div>
                  <label class="label-sm">推理状态 inference</label>
                  <select v-model="config.huggingFace.filters.inference" class="input-field">
                    <option value="">不限</option>
                    <option value="warm">可直接推理 warm</option>
                    <option value="cold">冷启动 cold</option>
                    <option value="frozen">不可用 frozen</option>
                  </select>
                  <span class="text-slate-400 text-xs mt-1 block">免费接口优先选 warm，成功率更高。</span>
                </div>
                <div>
                  <label class="label-sm">门禁 gated</label>
                  <select v-model="config.huggingFace.filters.gated" class="input-field">
                    <option value="">不限</option>
                    <option value="false">非门禁</option>
                    <option value="true">门禁模型</option>
                  </select>
                  <span class="text-slate-400 text-xs mt-1 block">门禁模型可能需要你在 HF 页面先同意协议。</span>
                </div>
                <div>
                  <label class="label-sm">Provider 名称</label>
                  <input v-model="config.huggingFace.filters.provider" class="input-field" placeholder="hf-inference / fal-ai 等" />
                  <span class="text-slate-400 text-xs mt-1 block">留空自动取模型映射里的第一个 provider。</span>
                </div>
                <div>
                  <label class="label-sm">排序字段</label>
                  <select v-model="config.huggingFace.filters.sort" class="input-field">
                    <option value="downloads">下载量</option>
                    <option value="likes">点赞数</option>
                    <option value="lastModified">最近更新</option>
                    <option value="createdAt">创建时间</option>
                    <option value="trendingScore">趋势热度</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">排序方向</label>
                  <select v-model="config.huggingFace.filters.direction" class="input-field">
                    <option value="-1">降序：大到小/新到旧</option>
                    <option value="1">升序：小到大/旧到新</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">返回上限</label>
                  <input v-model.number="config.huggingFace.filters.limit" type="number" min="1" max="200" class="input-field font-mono" />
                  <span class="text-slate-400 text-xs mt-1 block">最多 200，越大请求越慢。</span>
                </div>
                <div class="space-y-2">
                  <label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm text-slate-600">
                    查询 token 可见私有模型
                    <input type="checkbox" v-model="config.huggingFace.filters.includePrivate" class="h-4 w-4 accent-amber-500" />
                  </label>
                  <label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm text-slate-600">
                    仅显示聊天可切换模型
                    <input type="checkbox" v-model="config.huggingFace.filters.onlyChatCompatible" class="h-4 w-4 accent-indigo-500" />
                  </label>
                </div>
              </div>

              <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                <button @click="fetchHuggingFaceModels(false)" :disabled="hfModelsLoading" class="btn-primary text-sm">
                  {{ hfModelsLoading ? '查询中...' : '查询模型（优先缓存）' }}
                </button>
                <button @click="fetchHuggingFaceModels(true)" :disabled="hfModelsLoading" class="btn-outline text-sm">强制刷新</button>
                <button @click="clearHfCache" :disabled="hfModelsLoading" class="btn-outline text-sm">清空缓存</button>
                <span class="text-xs text-slate-400">{{ hfFetchStatus || (config.huggingFace.cachedAt ? ('缓存时间：' + hfFormatDate(config.huggingFace.cachedAt)) : '暂无缓存') }}</span>
              </div>
              <p v-if="hfModelsError" class="mt-3 text-sm text-red-500">{{ hfModelsError }}</p>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="section-title">📋 Hugging Face 结果表（{{ hfModels().length }}）</h2>
                <span class="tag text-amber-700 bg-amber-50 border-amber-200">接口编码固定：hf-1；模型编码：hf.1 / hf.2 ...</span>
              </div>
              <div v-if="hfModels().length" class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-left text-sm">
                  <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th class="px-3 py-2">编码</th>
                      <th class="px-3 py-2">模型</th>
                      <th class="px-3 py-2">任务</th>
                      <th class="px-3 py-2">Provider</th>
                      <th class="px-3 py-2">状态</th>
                      <th class="px-3 py-2">热度</th>
                      <th class="px-3 py-2">更新时间</th>
                      <th class="px-3 py-2">操作</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 bg-white/70">
                    <tr v-for="model in hfModels()" :key="model.id + model.code" :class="config.huggingFace.selectedModelId === model.id ? 'bg-indigo-50/70' : ''">
                      <td class="px-3 py-2 font-mono font-bold text-indigo-600">{{ model.code }}</td>
                      <td class="px-3 py-2">
                        <div class="font-semibold text-slate-700 break-all">{{ model.id }}</div>
                        <div class="text-xs text-slate-400 break-all">{{ (model.tags || []).slice(0, 5).join(' · ') }}</div>
                      </td>
                      <td class="px-3 py-2 font-mono text-xs">{{ model.pipelineTag || '-' }}</td>
                      <td class="px-3 py-2 font-mono text-xs">{{ model.provider || '-' }}</td>
                      <td class="px-3 py-2 text-xs">
                        <span class="tag">{{ model.inference || 'unknown' }}</span>
                        <span v-if="model.gated === 'true'" class="tag text-amber-700 bg-amber-50 border-amber-200 ml-1">gated</span>
                        <span v-if="model.private" class="tag text-rose-700 bg-rose-50 border-rose-200 ml-1">private</span>
                      </td>
                      <td class="px-3 py-2 text-xs">⬇ {{ model.downloads || 0 }} / ♥ {{ model.likes || 0 }}</td>
                      <td class="px-3 py-2 text-xs text-slate-500">{{ hfFormatDate(model.lastModified) }}</td>
                      <td class="px-3 py-2">
                        <button @click="selectHfModel(model)" class="btn-outline text-xs">选择</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="text-slate-400 text-sm">还没有模型缓存。填写 Token/筛选条件后点击“查询模型”。</p>
            </div>
          </div>

          <!-- ═══ PAGE: Bot 行为设定 ═══ -->

          <!-- PAGE: 自由模式 -->
          <div v-show="currentPage === 'freeMode'" class="space-y-4 animate-fadein">
            <div class="card p-5">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
                <div>
                  <h2 class="section-title">自由模式</h2>
                  <p class="text-slate-400 text-sm mt-1">启用后，未命中明确指令的 @机器人 消息会交给智能规划器判断是文本回复还是图像任务。</p>
                  <p class="text-slate-400 text-xs mt-1">这里同样支持感叹号快捷参数：<code>mb_1!</code>、<code>9:16!</code>、<code>2k!</code>、<code>4s!</code>、<code>high!</code>。</p>
                </div>
                <label class="toggle"><input type="checkbox" v-model="config.freeMode.enabled"><span class="toggle-slider"></span></label>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div class="p-4 rounded-xl border border-indigo-100 bg-indigo-50/30">
                  <div class="text-sm font-semibold text-slate-700 mb-3">规划路由</div>
                  <div class="rounded-lg border border-indigo-100 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['freeMode', 'nodeIndex'], ['freeMode', 'model']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <div class="mt-3">
                    <label class="label-sm">规划超时（毫秒）</label>
                    <input v-model.number="config.freeMode.timeoutMs" type="number" min="30000" step="30000" class="input-field" :disabled="!config.freeMode.enabled" />
                  </div>
                </div>

                <div class="p-4 rounded-xl border border-emerald-100 bg-emerald-50/30">
                  <div class="text-sm font-semibold text-slate-700 mb-3">规划选项</div>
                  <label class="flex items-center justify-between gap-4 p-3 rounded-lg bg-white/70 border border-emerald-100">
                    <div>
                      <div class="font-semibold text-sm text-slate-700">读取引用消息</div>
                      <div class="text-slate-400 text-xs mt-1">支持引用文本、图片与合并转发摘要。</div>
                    </div>
                    <input type="checkbox" v-model="config.freeMode.includeQuotedMessage" class="h-5 w-5 accent-emerald-500" />
                  </label>
                  <label class="mt-3 flex items-center justify-between gap-4 p-3 rounded-lg bg-white/70 border border-emerald-100">
                    <div>
                      <div class="font-semibold text-sm text-slate-700">有图时优先改图</div>
                      <div class="text-slate-400 text-xs mt-1">用户发图并要求修改时，规划器优先选择改图任务。</div>
                    </div>
                    <input type="checkbox" v-model="config.freeMode.preferEditWhenImagePresent" class="h-5 w-5 accent-emerald-500" />
                  </label>
                </div>

                <div class="p-4 rounded-xl border border-amber-100 bg-amber-50/30">
                  <div class="text-sm font-semibold text-slate-700 mb-3">限制</div>
                  <div class="grid grid-cols-1 gap-3">
                    <div>
                      <label class="label-sm">最多输入图片数</label>
                      <input v-model.number="config.freeMode.maxInputImages" type="number" min="0" max="12" step="1" class="input-field" :disabled="!config.freeMode.enabled" />
                    </div>
                    <div>
                      <label class="label-sm">最多引用/转发消息数</label>
                      <input v-model.number="config.freeMode.maxReferencedMessages" type="number" min="0" max="80" step="1" class="input-field" :disabled="!config.freeMode.enabled" />
                    </div>
                    <div>
                      <label class="label-sm">最多输入图片数</label>
                      <input v-model.number="config.freeMode.maxOutputImages" type="number" min="1" max="4" step="1" class="input-field" :disabled="!config.freeMode.enabled" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-3">
                <h2 class="section-title">规划提示词</h2>
              </div>
              <textarea v-model="config.freeMode.plannerPromptTemplate" rows="16" class="input-field font-mono text-xs" :disabled="!config.freeMode.enabled" />
              <p class="text-slate-400 text-xs mt-2">占位符：<code v-pre>{{userContent}}</code>。规划器必须输出结构化结果；若动作为图片，将只发送图片结果。</p>
            </div>
          </div>

          <div v-show="currentPage === 'bot'" class="space-y-4 animate-fadein">

            <div class="card p-5">
              <h2 class="section-title mb-4">💬 回复策略</h2>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label v-for="opt in [
                  { value: 'forward', icon: '📦', title: '合并转发', desc: '纯净无打扰，仅发送图片' },
                  { value: 'at',      icon: '🔔', title: '@提问者',  desc: '回复时@发送者并附图' },
                  { value: 'quote',   icon: '💬', title: '引用消息',  desc: '引用原消息并附图' },
                ]" :key="opt.value" :class="['reply-card', config.bot.replyFormat === opt.value ? 'reply-card-active' : '']">
                  <input type="radio" v-model="config.bot.replyFormat" :value="opt.value" class="hidden" />
                  <div class="text-2xl mb-1">{{ opt.icon }}</div>
                  <div class="font-semibold text-sm">{{ opt.title }}</div>
                  <div class="text-slate-400 text-xs mt-1">{{ opt.desc }}</div>
                </label>
              </div>

              <div class="mt-5 pt-4 border-t border-slate-800">
                <div class="font-semibold text-sm text-slate-100 mb-3">按内容类型设置回复策略</div>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label class="label-sm">纯文本回复</label>
                    <select v-model="config.bot.replyStrategies.text" class="input-field">
                      <option value="forward">合并转发</option>
                      <option value="quote">引用原消息</option>
                      <option value="at">@ 提问者</option>
                      <option value="plain">普通消息</option>
                    </select>
                    <span class="text-slate-400 text-xs mt-1 block">自由模式文本通常建议使用合并转发。</span>
                  </div>
                  <div>
                    <label class="label-sm">单图回复</label>
                    <select v-model="config.bot.replyStrategies.image" class="input-field">
                      <option value="forward">合并转发</option>
                      <option value="quote">引用原消息</option>
                      <option value="at">@ 提问者</option>
                      <option value="plain">普通消息</option>
                    </select>
                    <span class="text-slate-400 text-xs mt-1 block">若智能模型输出包含图片，将丢弃文本只发送图片。</span>
                  </div>
                  <div>
                    <label class="label-sm">多图回复</label>
                    <select v-model="config.bot.replyStrategies.multiImage" class="input-field">
                      <option value="forward">多图合并转发</option>
                      <option value="quote">逐条引用</option>
                      <option value="at">@ 提问者（逐条）</option>
                      <option value="plain">普通消息（逐条）</option>
                    </select>
                    <span class="text-slate-400 text-xs mt-1 block">建议使用合并转发，避免刷屏。</span>
                  </div>
                </div>
              </div>
              <div class="mt-5 pt-4 border-t border-slate-800">
                <div class="font-semibold text-sm text-slate-100 mb-3">长文本分段</div>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label class="label-sm">每段最多字数</label>
                    <input type="number" min="0" max="20000" step="100" v-model.number="config.bot.textReply.maxChars"
                      class="input-field" placeholder="1800" />
                    <span class="text-slate-400 text-xs mt-1 block">0 表示不拆分；建议 1200-2500，避免 QQ 长文本掉线</span>
                  </div>
                  <div>
                    <label class="label-sm">分段间隔（毫秒）</label>
                    <input type="number" min="0" max="10000" step="100" v-model.number="config.bot.textReply.splitDelayMs"
                      class="input-field" placeholder="800" />
                    <span class="text-slate-400 text-xs mt-1 block">多段连续发送时的等待时间</span>
                  </div>
                  <label class="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
                    <div>
                      <div class="font-semibold text-sm text-slate-100">显示分段序号</div>
                      <div class="text-slate-400 text-xs mt-1">例如 (1/3)，方便用户按顺序阅读</div>
                    </div>
                    <input type="checkbox" v-model="config.bot.textReply.showPartPrefix" class="h-5 w-5 accent-cyan-500" />
                  </label>
                </div>
              </div>
              <div class="mt-5 pt-4 border-t border-slate-800">
                <div class="font-semibold text-sm text-slate-100 mb-3">触发入口</div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label class="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
                    <div>
                      <div class="font-semibold text-sm text-slate-100">@机器人 + 关键字</div>
                      <div class="text-slate-400 text-xs mt-1">例如 @机器人 画 小狗；无关键字时只在日常对话开启后回复</div>
                    </div>
                    <input type="checkbox" v-model="config.bot.triggerModes.mention" class="h-5 w-5 accent-cyan-500" />
                  </label>
                  <label class="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
                    <div>
                      <div class="font-semibold text-sm text-slate-100">引用机器人消息 + 关键字</div>
                      <div class="text-slate-400 text-xs mt-1">例如引用机器人的消息后发送 反推；无关键字不会进入日常对话</div>
                    </div>
                    <input type="checkbox" v-model="config.bot.triggerModes.replyToBot" class="h-5 w-5 accent-cyan-500" />
                  </label>
                </div>
              </div>
              <div class="mt-5 pt-4 border-t border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-4">
                <label class="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
                  <div>
                    <div class="font-semibold text-sm text-slate-100">发图后自动撤回</div>
                    <div class="text-slate-400 text-xs mt-1">默认关闭，只撤回群聊中机器人发出的图片消息</div>
                  </div>
                  <input type="checkbox" v-model="config.bot.autoRecallImages" class="h-5 w-5 accent-cyan-500" />
                </label>
                <div>
                  <label class="label-sm">撤回延迟（秒）</label>
                  <input type="number" min="1" step="1" v-model.number="config.bot.autoRecallDelaySeconds"
                    :disabled="!config.bot.autoRecallImages"
                    class="input-field disabled:opacity-50 disabled:cursor-not-allowed" placeholder="60" />
                </div>
              </div>
              <div class="mt-5 pt-4 border-t border-slate-800">
                <div class="font-semibold text-sm text-slate-100 mb-3">图片压缩与原图</div>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <label class="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
                    <div>
                      <div class="font-semibold text-sm text-slate-100">默认发送压缩图</div>
                      <div class="text-slate-400 text-xs mt-1">保留原图索引，可引用后发送“原图”取回</div>
                    </div>
                    <input type="checkbox" v-model="config.bot.imageCompression.enabled" class="h-5 w-5 accent-cyan-500" />
                  </label>
                  <div>
                    <label class="label-sm">压缩倍率</label>
                    <input type="number" min="0.1" max="1" step="0.05" v-model.number="config.bot.imageCompression.scale"
                      :disabled="!config.bot.imageCompression.enabled"
                      class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span class="text-slate-400 text-xs mt-1 block">0.65 表示宽高压到 65%</span>
                  </div>
                  <div>
                    <label class="label-sm">图片质量</label>
                    <input type="number" min="1" max="100" step="1" v-model.number="config.bot.imageCompression.quality"
                      :disabled="!config.bot.imageCompression.enabled"
                      class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span class="text-slate-400 text-xs mt-1 block">单图压缩质量，透明图仍会保留原始透明格式</span>
                    <span class="text-slate-400 text-xs mt-1 block">默认 82，透明图会保留原始透明格式</span>
                  </div>
                </div>
                <div class="mt-4 grid grid-cols-1 md:grid-cols-4 gap-4">
                  <label class="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
                    <div>
                      <div class="font-semibold text-sm text-slate-100">多图合并预览压缩</div>
                      <div class="text-slate-400 text-xs mt-1">合并成带编号的压缩预览，原图仍可回复数字取回</div>
                    </div>
                    <input type="checkbox" v-model="config.bot.imageCompression.mergedPreviewEnabled" class="h-5 w-5 accent-cyan-500" />
                  </label>
                  <div>
                    <label class="label-sm">预览缩放</label>
                    <input type="number" min="0.1" max="1" step="0.05" v-model.number="config.bot.imageCompression.mergedPreviewScale"
                      :disabled="!config.bot.imageCompression.mergedPreviewEnabled"
                      class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                  </div>
                  <div>
                    <label class="label-sm">预览压缩质量</label>
                    <input type="number" min="1" max="100" step="1" v-model.number="config.bot.imageCompression.mergedPreviewQuality"
                      :disabled="!config.bot.imageCompression.mergedPreviewEnabled"
                      class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                  </div>
                  <div>
                    <label class="label-sm">预览最大宽度</label>
                    <input type="number" min="512" max="4096" step="64" v-model.number="config.bot.imageCompression.mergedPreviewMaxWidth"
                      :disabled="!config.bot.imageCompression.mergedPreviewEnabled"
                      class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span class="text-slate-400 text-xs mt-1 block">用于降低 Napcat 上传耗时</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">👑 Bot 主人管理</h2>
                  <p class="text-slate-400 text-xs">主人指令只允许下方主人 QQ 调用；主人无法被拉黑，撤回只撤回机器人最近发出的整条消息。</p>
                </div>
                <span class="px-3 py-1 rounded-full bg-cyan-500/10 text-cyan-200 text-xs border border-cyan-500/20">权限敏感</span>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="label-sm">机器人 QQ 号</label>
                  <input v-model="config.bot.botQqId" class="input-field" placeholder="用于识别 @bot 主人指令，例如 123456789" />
                  <span class="text-slate-400 text-xs mt-1 block">建议填写，避免 Napcat 未上报 self_id 时 @bot 指令无法识别。</span>
                </div>
                <div>
                  <label class="label-sm">主人 QQ 号</label>
                  <input :value="config.bot.ownerQQs?.join(', ')"
                    @input="config.bot.ownerQQs = ($event.target as HTMLInputElement).value.split(/[\n,，；;]+/).map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field" placeholder="多个 QQ 用逗号或换行分隔" />
                  <span class="text-slate-400 text-xs mt-1 block">只有这里的 QQ 可以执行 /拉黑、/拉白、/撤回、/ttsk、/ttsg、/tts.N。</span>
                </div>
              </div>
              <div class="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div class="font-semibold text-sm text-slate-100 mb-2">可用主人指令</div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-300 leading-6">
                  <div><code>@某人 /拉黑</code>：禁止该群内该 QQ 使用 Bot</div>
                  <div><code>@某人 /拉白</code>：解除该群内该 QQ 黑名单</div>
                  <div><code>@bot /撤回</code> 或 <code>@bot /c3</code>：撤回最近 1/3 条可撤回消息</div>
                  <div><code>@bot /ttsk</code> / <code>@bot /ttsg</code>：开启/关闭自动语音回复</div>
                  <div><code>@bot /tts.1</code> / <code>@bot /tts.2</code>：切换 Fish Voice 编号</div>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">🔊 文本转语音 / TTS</h2>
                  <p class="text-slate-400 text-xs">当机器人回复文本不超过设定字数时，自动调用语音 API 并用 Napcat 语音消息发送；失败会降级为普通文本。</p>
                </div>
                <label class="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800 min-w-[180px]">
                  <span class="font-semibold text-sm text-slate-100">启用 TTS</span>
                  <input type="checkbox" v-model="config.bot.tts.enabled" class="h-5 w-5 accent-cyan-500" />
                </label>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label class="label-sm">语音服务</label>
                  <select v-model="config.bot.tts.provider" class="input-field">
                    <option value="fish-audio">Fish Audio</option>
                    <option value="openai-compatible">OpenAI 兼容语音</option>
                  </select>
                  <span class="text-slate-400 text-xs mt-1 block">默认 Fish Audio，兼容模式适配常见 /audio/speech 服务。</span>
                </div>
                <div class="lg:col-span-2">
                  <label class="label-sm">API 地址</label>
                  <input v-model="config.bot.tts.apiUrl" class="input-field" placeholder="https://api.fish.audio/v1/tts" />
                </div>
                <div>
                  <label class="label-sm">API 密钥</label>
                  <input v-model="config.bot.tts.apiKey" type="password" autocomplete="off" class="input-field" placeholder="Bearer Token / API Key" />
                </div>
                <div>
                  <label class="label-sm">模型 ID / 后端</label>
                  <input v-model="config.bot.tts.model" class="input-field" placeholder="Fish: s2-pro；兼容模式: tts-1" />
                </div>
                <div v-if="config.bot.tts.provider === 'fish-audio'" class="lg:col-span-3">
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-2">
                    <div>
                      <label class="label-sm mb-1">Fish Voice / Reference ID 列表</label>
                      <span class="text-slate-400 text-xs">按编号保存，主人可发送 <code>@bot /tts.1</code>、<code>@bot /tts.2</code> 快速切换。</span>
                    </div>
                    <button type="button" @click="addTtsVoiceId" class="btn-outline text-xs px-3 py-1.5">＋ 添加 Voice ID</button>
                  </div>
                  <div class="space-y-2">
                    <div v-if="!config.bot.tts.voiceIds?.length" class="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 p-3 text-xs text-slate-400">
                      还没有添加 Reference ID。点击“添加 Voice ID”后粘贴 Fish Audio 的 reference_id。
                    </div>
                    <div v-for="(_voiceId, idx) in config.bot.tts.voiceIds" :key="`tts-voice-${idx}`" class="tts-voice-row">
                      <button type="button" @click="selectTtsVoiceId(idx)" :class="['tts-voice-index', config.bot.tts.voiceId === String(config.bot.tts.voiceIds[idx] || '').trim() ? 'tts-voice-index--active' : '']">
                        #{{ idx + 1 }}
                      </button>
                      <input v-model="config.bot.tts.voiceIds[idx]" @input="onTtsVoiceIdInput(idx)" class="input-field font-mono" placeholder="Fish reference_id / voice model id" />
                      <button type="button" @click="selectTtsVoiceId(idx)" class="btn-outline text-xs px-3">设为当前</button>
                      <button type="button" @click="removeTtsVoiceId(idx)" class="btn-danger text-xs px-3">删除</button>
                    </div>
                  </div>
                  <input v-model="config.bot.tts.voiceId" class="input-field font-mono mt-3" placeholder="当前启用的 Reference ID，可由 /tts.N 切换" />
                  <span class="text-slate-400 text-xs mt-1 block">当前启用：<code>{{ config.bot.tts.voiceId || '未选择' }}</code></span>
                </div>
                <div v-else>
                  <label class="label-sm">兼容模式 Voice</label>
                  <input v-model="config.bot.tts.voice" class="input-field" placeholder="alloy / shimmer / 自定义 voice" />
                </div>
                <div>
                  <label class="label-sm">多少字以内转语音</label>
                  <input type="number" min="1" max="4000" step="10" v-model.number="config.bot.tts.autoTextMaxChars" class="input-field" placeholder="180" />
                  <span class="text-slate-400 text-xs mt-1 block">超过该长度仍按长文本分段发送，避免长语音等待过久。</span>
                </div>
                <div>
                  <label class="label-sm">输出格式</label>
                  <select v-model="config.bot.tts.format" class="input-field">
                    <option value="mp3">MP3</option>
                    <option value="wav">WAV</option>
                    <option value="opus">Opus</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">超时（毫秒）</label>
                  <input type="number" min="5000" max="300000" step="1000" v-model.number="config.bot.tts.timeoutMs" class="input-field" placeholder="60000" />
                </div>
                <div>
                  <label class="label-sm">延迟档位</label>
                  <select v-model="config.bot.tts.latency" class="input-field">
                    <option value="normal">normal：质量优先</option>
                    <option value="balanced">balanced：均衡</option>
                    <option value="low">low：低延迟</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">语速</label>
                  <input type="number" min="0.5" max="2" step="0.05" v-model.number="config.bot.tts.speed" class="input-field" />
                </div>
                <div>
                  <label class="label-sm">音量</label>
                  <input type="number" min="-20" max="20" step="1" v-model.number="config.bot.tts.volume" class="input-field" />
                </div>
              </div>
              <div class="mt-5 rounded-2xl border border-violet-400/20 bg-violet-500/5 p-4">
                <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h3 class="font-bold text-slate-100">🎛️ 语音前置翻译 / 标签模型</h3>
                    <p class="text-slate-400 text-xs mt-1">AI 文本回复命中“多少字以内转语音”后，先经过这里的模型翻译、改写并穿插语音标签，再送入语音 API。</p>
                  </div>
                  <label class="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/60 border border-violet-400/20 min-w-[190px]">
                    <span class="font-semibold text-sm text-slate-100">启用前置处理</span>
                    <input type="checkbox" v-model="config.bot.tts.preprocess.enabled" class="h-5 w-5 accent-violet-500" />
                  </label>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                  <div class="md:col-span-2">
                    <label class="label-sm">前置模型路由</label>
                    <div class="rounded-lg border border-violet-400/20 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
                      当前路由：<span class="font-mono text-slate-100">{{ routeSummary(['bot', 'tts', 'preprocess', 'nodeIndex'], ['bot', 'tts', 'preprocess', 'model']) }}</span>
                      <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-300 hover:underline">去模型路由修改</button>
                    </div>
                    <span class="text-slate-400 text-xs mt-1 block">回复进入语音模式前的 LLM 前置处理，节点/模型集中到模型路由页维护。</span>
                  </div>
                  <div>
                    <label class="label-sm">前置超时（毫秒）</label>
                    <input type="number" min="5000" max="300000" step="1000" v-model.number="config.bot.tts.preprocess.timeoutMs" :disabled="!config.bot.tts.preprocess.enabled" class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                  </div>
                  <div>
                    <label class="label-sm">送入语音前延迟（毫秒）</label>
                    <input type="number" min="0" max="30000" step="100" v-model.number="config.bot.tts.preprocess.delayMs" :disabled="!config.bot.tts.preprocess.enabled" class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span class="text-slate-400 text-xs mt-1 block">用于等待上游、模拟停顿或控制发语音节奏。</span>
                  </div>
                  <div>
                    <label class="label-sm">前置输出最多字符</label>
                    <input type="number" min="1" max="8000" step="50" v-model.number="config.bot.tts.preprocess.maxOutputChars" :disabled="!config.bot.tts.preprocess.enabled" class="input-field disabled:opacity-50 disabled:cursor-not-allowed" />
                  </div>
                  <label class="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                    <span>
                      <span class="font-semibold text-sm text-slate-100 block">失败降级原文</span>
                      <span class="text-slate-400 text-xs">前置模型异常时仍用原回复发语音。</span>
                    </span>
                    <input type="checkbox" v-model="config.bot.tts.preprocess.fallbackToOriginal" :disabled="!config.bot.tts.preprocess.enabled" class="h-5 w-5 accent-violet-500 disabled:opacity-50" />
                  </label>
                </div>
                <div class="mt-4">
                  <label class="label-sm">前置提示词模板</label>
                  <textarea v-model="config.bot.tts.preprocess.promptTemplate" :disabled="!config.bot.tts.preprocess.enabled" rows="7" class="input-field font-mono text-sm disabled:opacity-50 disabled:cursor-not-allowed"></textarea>
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code>{{text}}</code> / <code>{{rawText}}</code> / <code>{{input}}</code> / <code>{{replyText}}</code>。模型只应输出最终送入语音 API 的文本。</span>
                </div>
              </div>
              <div class="mt-4 text-xs text-slate-400 leading-6 rounded-xl border border-cyan-500/10 bg-cyan-500/5 p-3">
                Fish Audio 需要填写 <code>API 密钥</code>、<code>模型 ID</code>（如 s2-pro）和 <code>Voice / Reference ID</code>；发送给 QQ 时会转换为 <code>record</code> 语音消息段。
              </div>
            </div>

            <div class="card p-5">
              <h2 class="section-title mb-2">⌨️ 触发词自定义</h2>
              <p class="text-slate-400 text-xs mb-4">多个关键词用英文逗号分隔；关键字只匹配清理掉 @/引用后的开头位置。</p>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label class="label-sm">🎨 文生图</label>
                  <input v-model="config.bot.commands.genImage" class="input-field" placeholder="生图, 画" />
                  <label class="label-sm mt-3 block">图片数量指令后缀</label>
                  <input v-model="config.bot.commands.imageCount" class="input-field" placeholder="s" />
                  <span class="text-slate-400 text-xs mt-1 block">例如 2s! 生成 2 张，最高 4 张</span>
                </div>
                <div>
                  <label class="label-sm">🖼️ 图生图 / 参考图</label>
                  <input v-model="config.bot.commands.img2Img" class="input-field" placeholder="图生图, 参考图, i2i" />
                </div>
                <div>
                  <label class="label-sm">✏️ 改图 / 编辑</label>
                  <input v-model="config.bot.commands.editImage" class="input-field" placeholder="改图, 编辑" />
                </div>
                <div>
                  <label class="label-sm">🔍 反推提示词</label>
                  <input v-model="config.bot.commands.interrogate" class="input-field" placeholder="反推, 看图, 描述" />
                </div>
                <div>
                  <label class="label-sm">🖼️ 获取原图</label>
                  <input v-model="config.bot.commands.originalImage" class="input-field" placeholder="原图" />
                  <span class="text-slate-400 text-xs mt-1 block">引用机器人发出的压缩图后使用</span>
                </div>
                <div>
                  <label class="label-sm">🧩 本地模板库</label>
                  <input v-model="config.bot.commands.templateLibrary" class="input-field" placeholder="本地模板库, 本地模板, 模板库, mb" />
                  <span class="text-slate-400 text-xs mt-1 block">@机器人 本地模板库 会用合并转发列出本地模板</span>
                </div>
                <div>
                  <label class="label-sm">🧬 引用模板填充生图</label>
                  <input v-model="config.bot.commands.referencedTemplateImage" class="input-field" placeholder="套模板, 引用模板生图, 模板填充生图" />
                  <span class="text-slate-400 text-xs mt-1 block">引用含【通用模板提示词】的消息后使用，例如：@机器人 套模板 和泉纱雾</span>
                </div>
                <div>
                  <label class="label-sm">🌐 远程模板库搜索</label>
                  <input v-model="config.bot.commands.remotePromptSearch" class="input-field" placeholder="pp, 远程模板库, 远程模板" />
                  <span class="text-slate-400 text-xs mt-1 block">例如：@机器人 远程模板 电影感头像；会先转英文搜索远程模板库。</span>
                </div>
                <div>
                  <label class="label-sm">✨ 远程智能套模板生图</label>
                  <input v-model="config.bot.commands.remotePromptSmartImage" class="input-field" placeholder="spp, 远程模板生图, 智能远程模板" />
                  <span class="text-slate-400 text-xs mt-1 block">例如：@机器人 智能远程模板! 画面描述；感叹号、空格、冒号都可分隔。</span>
                </div>
                <div>
                  <label class="label-sm">🧠 润色开关</label>
                  <input v-model="config.bot.commands.toggleEnhance" class="input-field" placeholder="润色" />
                  <span class="text-slate-400 text-xs mt-1 block">例如：画 润色 小狗；不带此词则不润色</span>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <h2 class="section-title mb-2">🛡️ 白名单 / 黑名单</h2>
              <p class="text-slate-400 text-xs mb-3">白名单留空允许所有；群内黑名单每行一个，格式为 群号:QQ，也支持 *:QQ。</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="label-sm">允许的群号</label>
                  <input :value="config.bot.whitelistGroups?.join(', ')"
                    @input="config.bot.whitelistGroups = ($event.target as HTMLInputElement).value.split(',').map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field" placeholder="留空 = 全部放行" />
                </div>
                <div>
                  <label class="label-sm">允许的私聊 QQ</label>
                  <input :value="config.bot.whitelistPrivate?.join(', ')"
                    @input="config.bot.whitelistPrivate = ($event.target as HTMLInputElement).value.split(',').map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field" placeholder="留空 = 全部放行" />
                </div>
                <div class="md:col-span-2">
                  <label class="label-sm">群内用户黑名单</label>
                  <textarea :value="config.bot.blacklistGroupUsers?.join('\n')"
                    @input="config.bot.blacklistGroupUsers = ($event.target as HTMLTextAreaElement).value.split(/[\n,]/).map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field min-h-[112px] resize-y" placeholder="1098867961:2238639363&#10;*:123456789"></textarea>
                </div>
              </div>
            </div>
          </div>

          <!-- ═══ PAGE: 本地 / 远程提示词模板库 ═══ -->
          <div v-show="currentPage === 'templates'" class="space-y-4 animate-fadein">
            <div class="card p-5">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">🧩 本地模板分工</h2>
                  <p class="text-slate-400 text-xs">用户使用 mb_1！ 这类模板编号时，会先让这里配置的模型把用户提示词填进模板，再提交给生图/改图模型；模型填充失败时会自动降级为直接套模板。</p>
                </div>
                <button @click="resetTemplatePrompt" class="btn-outline text-sm">默认模板填充提示词</button>
              </div>
              <div class="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
                <div>
                  <label class="label-sm">模板填充路由</label>
                  <div class="rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'templateNodeIndex'], ['llm', 'templateModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="mt-2 block text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <span class="text-slate-400 text-xs mt-1 block">填空值时不调用模型，直接替换 {{ '{' }}{{ '{' }}prompt{{ '}' }}{{ '}' }}。</span>
                </div>
                <div>
                  <label class="label-sm">模板填充提示词</label>
                  <textarea v-model="config.llm.templatePromptTemplate" rows="9" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code v-pre>{{templateTitle}}</code>、<code v-pre>{{templatePrompt}}</code>、<code v-pre>{{rawPrompt}}</code>。</span>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">🧬 引用模板分工</h2>
                  <p class="text-slate-400 text-xs">引用模板生图会单独使用这里的节点、模型和填充提示词，不再复用本地模板填充配置。</p>
                </div>
                <button @click="resetReferencedTemplatePrompt" class="btn-outline text-sm">默认引用模板提示词</button>
              </div>
              <div class="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
                <div>
                  <label class="label-sm">引用模板填充路由</label>
                  <div class="rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'referencedTemplateNodeIndex'], ['llm', 'referencedTemplateModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="mt-2 block text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                  <label class="label-sm mt-3">超时（毫秒）</label>
                  <input v-model.number="config.llm.referencedTemplateTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
                  <span class="text-slate-400 text-xs mt-1 block">填空值时引用模板生图会提示未配置填充模型。</span>
                </div>
                <div>
                  <label class="label-sm">引用模板填充提示词</label>
                  <textarea v-model="config.llm.referencedTemplatePromptTemplate" rows="9" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code v-pre>{{templateTitle}}</code>、<code v-pre>{{templatePrompt}}</code>、<code v-pre>{{rawPrompt}}</code>。</span>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">🌐 远程提示词库</h2>
                  <p class="text-slate-400 text-xs">远程搜索负责中文友好的模板检索，智能检索会先从远程库取少量候选，再用这里配置的模型选择并融合模板；远程失败时不影响本地模板库。</p>
                </div>
                <label class="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <input type="checkbox" v-model="config.promptsChat.enabled" class="accent-indigo-500" />
                  启用远程库
                </label>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
                <div>
                  <label class="label-sm">远程库接入地址</label>
                  <input v-model="config.promptsChat.endpoint" class="input-field" placeholder="远程提示词 MCP 地址（可留空）" />
                </div>
                <div>
                  <label class="label-sm">接口密钥</label>
                  <input v-model="config.promptsChat.apiKey" type="password" class="input-field" placeholder="可留空，或使用环境变量" />
                </div>
                <div class="md:col-span-2">
                  <label class="label-sm">智能匹配路由</label>
                  <div class="rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['promptsChat', 'smartNodeIndex'], ['promptsChat', 'smartModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                </div>
                <div>
                  <label class="label-sm">搜索类型</label>
                  <select v-model="config.promptsChat.searchType" class="input-field">
                    <option value="">全部</option>
                    <option value="IMAGE">图像</option>
                    <option value="TEXT">文本</option>
                    <option value="STRUCTURED">结构化</option>
                    <option value="VIDEO">视频</option>
                    <option value="AUDIO">音频</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">搜索拉取上限</label>
                  <input v-model.number="config.promptsChat.searchLimit" type="number" min="1" max="50" class="input-field" />
                </div>
                <div>
                  <label class="label-sm">QQ 展示条数</label>
                  <input v-model.number="config.promptsChat.displayLimit" type="number" min="1" max="10" class="input-field" />
                </div>
                <label class="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white/70 px-3 py-2">
                  <span class="text-xs text-slate-600">中文转英文搜索</span>
                  <input type="checkbox" v-model="config.promptsChat.translateSearchQuery" class="h-4 w-4 accent-indigo-500" />
                </label>
                <label class="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white/70 px-3 py-2">
                  <span class="text-xs text-slate-600">结果说明翻译中文</span>
                  <input type="checkbox" v-model="config.promptsChat.translateResults" class="h-4 w-4 accent-indigo-500" />
                </label>
                <div>
                  <label class="label-sm">智能搜索上限</label>
                  <input v-model.number="config.promptsChat.smartSearchLimit" type="number" min="3" max="50" class="input-field" />
                </div>
                <div>
                  <label class="label-sm">候选模板数</label>
                  <input v-model.number="config.promptsChat.smartCandidateLimit" type="number" min="1" max="10" class="input-field" />
                </div>
              </div>
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">搜索词生成提示词</label>
                    <button @click="resetPromptsChatSearchPrompt" class="text-xs text-indigo-600 hover:underline">恢复默认</button>
                  </div>
                  <textarea v-model="config.promptsChat.searchQueryPromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code v-pre>{{rawPrompt}}</code>。</span>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">智能选择融合提示词</label>
                    <button @click="resetPromptsChatSmartPrompt" class="text-xs text-indigo-600 hover:underline">恢复默认</button>
                  </div>
                  <textarea v-model="config.promptsChat.smartPromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code v-pre>{{rawPrompt}}</code>、<code v-pre>{{candidates}}</code>。</span>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">✨ 智能提示词转模板</h2>
                  <p class="text-slate-400 text-xs">把现成提示词粘贴进来，智能模型会抽象成可复用模板并自动存入下方模板库；转化和命名提示词都可以按你的习惯改。</p>
                </div>
                <button @click="convertPromptToTemplate" :disabled="templateConvertLoading" class="btn-primary text-sm">
                  {{ templateConvertLoading ? '转化中...' : '转化并存入模板库' }}
                </button>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div class="md:col-span-2">
                  <label class="label-sm">转模板路由</label>
                  <div class="rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-xs text-slate-500">
                    当前路由：<span class="font-mono text-slate-700">{{ routeSummary(['llm', 'templateConvertNodeIndex'], ['llm', 'templateConvertModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-600 hover:underline">去模型路由修改</button>
                  </div>
                </div>
              </div>
              <textarea v-model="templateConvertSource" rows="5" class="input-field font-mono text-xs mb-4"
                placeholder="粘贴一段完整提示词，智能模型会把一次性的主体、场景、风格等抽象成含 {{prompt}} 的模板。"></textarea>
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">转化提示词</label>
                    <button @click="resetTemplateConvertPrompt" class="text-xs text-indigo-600 hover:underline">恢复默认</button>
                  </div>
                  <textarea v-model="config.llm.templateConvertPromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code v-pre>{{rawPrompt}}</code>。</span>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">自动命名提示词</label>
                    <button @click="resetTemplateTitlePrompt" class="text-xs text-indigo-600 hover:underline">恢复默认</button>
                  </div>
                  <textarea v-model="config.llm.templateTitlePromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <span class="text-slate-400 text-xs mt-1 block">可用占位符：<code v-pre>{{templatePrompt}}</code>。</span>
                </div>
              </div>
              <p v-if="templateConvertStatus" class="text-xs mt-3"
                :class="templateConvertStatus.includes('失败') || templateConvertStatus.includes('为空') || templateConvertStatus.includes('先粘贴') ? 'text-red-500' : 'text-emerald-600'">
                {{ templateConvertStatus }}
              </p>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">🧩 本地提示词模板库</h2>
                  <p class="text-slate-400 text-xs">编号按顺序自动生成 mb_1 / mb_2。用户可用 <code>mb_1！</code> 套用模板；尺寸参数同样用感叹号，例如 <code>9:16！</code>、<code>2048x2048！</code>，超出限制会自动校正到最接近的可用尺寸。</p>
                </div>
                <button @click="addPromptTemplate" class="btn-outline text-sm">＋ 添加模板</button>
              </div>

              <div v-if="promptTemplates().length" class="space-y-3 max-h-[640px] overflow-y-auto pr-2">
                <div v-for="(tpl, idx) in promptTemplates()" :key="tpl.id || idx"
                  class="rounded-lg border border-slate-200 bg-white/70 p-4">
                  <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-3">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="tag text-indigo-600 bg-indigo-50 border-indigo-200">{{ tpl.id || `mb_${Number(idx) + 1}` }}</span>
                      <input v-model="tpl.title" @blur="normalizePromptTemplateIds" class="input-field md:w-72" placeholder="模板标题" />
                      <button @click="generateTemplateTitle(tpl, Number(idx))" :disabled="templateTitleLoading[templateKey(tpl, Number(idx))]" class="btn-outline text-xs">
                        {{ templateTitleLoading[templateKey(tpl, Number(idx))] ? '命名中...' : '智能命名' }}
                      </button>
                    </div>
                    <div class="flex items-center gap-2">
                      <button @click="toggleTemplateCollapsed(tpl, Number(idx))" class="btn-outline text-xs">
                        {{ isTemplateCollapsed(tpl, Number(idx)) ? '展开' : '折叠' }}
                      </button>
                      <button @click="removePromptTemplate(Number(idx))" class="btn-danger text-xs">删除</button>
                    </div>
                  </div>
                  <textarea v-if="!isTemplateCollapsed(tpl, Number(idx))" v-model="tpl.prompt" @blur="normalizePromptTemplateIds" rows="5" class="input-field font-mono text-xs"
                    placeholder="支持 {{prompt}} 或 {{rawPrompt}} 占位用户描述；不写占位符时会自动把用户描述追加到模板后。"></textarea>
                  <div v-else class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 max-h-12 overflow-hidden whitespace-pre-wrap">
                    {{ tpl.prompt }}
                  </div>
                </div>
              </div>
              <div v-else class="rounded-lg border border-dashed border-slate-300 bg-white/60 px-4 py-6 text-sm text-slate-400 text-center">
                暂无模板，添加后用户就能用 mb_1！ 调用。
              </div>
            </div>
          </div>

          <!-- ═══ PAGE: Napcat 连接 ═══ -->
          
          <!-- PAGE: Canvas -->
          <div v-show="currentPage === 'canvas'" class="space-y-4 animate-fadein">
            <div class="card p-5">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
                <div>
                  <h2 class="section-title mb-1">画布管理</h2>
                  <p class="text-slate-400 text-xs">画布前台使用独立配置与独立日志；仅复用模型接口节点列表，不与机器人生图配置混用。</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <a href="/" target="_blank" class="btn-outline text-xs py-1.5 px-3">打开前台</a>
                  <a href="/canvas" target="_blank" class="btn-outline text-xs py-1.5 px-3">打开画布</a>
                </div>
              </div>

              <div class="mb-4 rounded-2xl border border-indigo-500/10 bg-indigo-500/5 p-4">
                <div class="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 class="text-sm font-bold text-white">前台品牌显示</h3>
                    <p class="text-[11px] text-zinc-500">控制画布页左上角 Logo 文案、浏览器标签标题和 Favicon / ICO。</p>
                  </div>
                  <span class="rounded-full border border-indigo-400/20 bg-indigo-400/10 px-2.5 py-1 text-[10px] font-bold text-indigo-200">保存配置后刷新画布生效</span>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                  <div>
                    <label class="label-sm">Logo 字</label>
                    <input v-model="config.canvas.brand.logoText" class="input-field font-mono" placeholder="Mio" />
                  </div>
                  <div>
                    <label class="label-sm">浏览器标签</label>
                    <input v-model="config.canvas.brand.pageTitle" class="input-field" placeholder="Mio 图像画布" />
                  </div>
                  <div class="md:col-span-2">
                    <label class="label-sm">ICO / Favicon URL</label>
                    <input v-model="config.canvas.brand.faviconUrl" class="input-field font-mono" placeholder="/canvas/favicon.ico 或 https://.../favicon.ico" />
                    <p class="mt-1 text-[10px] text-zinc-500">支持站内路径、HTTPS 图片地址或 data:image/...；留空会回退到默认图标。</p>
                  </div>
                </div>
              </div>
              
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <label class="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-zinc-900/40 px-3.5 py-2.5 cursor-pointer">
                  <span class="text-xs font-semibold text-zinc-300">启用画布前台</span>
                  <input type="checkbox" v-model="config.canvas.enabled" class="rounded border-white/10 bg-zinc-900 text-indigo-600 focus:ring-0 w-4 h-4 cursor-pointer" />
                </label>
                
                <div class="md:col-span-2">
                  <label class="label-sm">文生图模型路由</label>
                  <div class="rounded-xl border border-indigo-500/10 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
                    当前路由：<span class="font-mono text-zinc-100">{{ routeSummary(['canvas', 'imageNodeIndex'], ['canvas', 'imageModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-300 hover:underline">去模型路由修改</button>
                  </div>
                </div>
                
                <div>
                  <label class="label-sm">请求超时（毫秒）</label>
                  <input v-model.number="config.canvas.imageTimeoutMs" type="number" min="30000" step="30000" class="input-field font-mono" />
                </div>
                
                <div class="md:col-span-2">
                  <label class="label-sm">图生图 / 改图模型路由</label>
                  <div class="rounded-xl border border-cyan-500/10 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
                    当前路由：<span class="font-mono text-zinc-100">{{ routeSummary(['canvas', 'editNodeIndex'], ['canvas', 'editModel']) }}</span>
                    <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-300 hover:underline">去模型路由修改</button>
                  </div>
                </div>
                
                <div>
                  <label class="label-sm">图生图请求格式</label>
                  <select v-model="config.canvas.imageEditRequestMode" class="input-field font-mono">
                    <option value="auto">自动探测</option>
                    <option value="json-images">结构化多图</option>
                    <option value="json-image">结构化单图</option>
                    <option value="multipart">表单上传</option>
                  </select>
                </div>
                
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="label-sm">重试次数</label>
                    <input v-model.number="config.canvas.imageRetryCount" type="number" min="0" max="5" step="1" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm">重试间隔</label>
                    <input v-model.number="config.canvas.imageRetryDelayMs" type="number" min="0" step="500" class="input-field font-mono text-center" />
                  </div>
                </div>
                
                <div>
                  <label class="label-sm">默认质量</label>
                  <select v-model="config.canvas.defaultQuality" class="input-field font-mono">
                    <option value="auto">自动</option>
                    <option value="low">低</option>
                    <option value="medium">标准</option>
                    <option value="high">高</option>
                  </select>
                </div>
                
                <div>
                  <label class="label-sm">默认输出格式</label>
                  <select v-model="config.canvas.defaultOutputFormat" class="input-field font-mono">
                    <option value="png">PNG 图片</option>
                    <option value="jpeg">JPEG 图片</option>
                    <option value="webp">WebP 图片</option>
                  </select>
                </div>
                
                <div>
                  <label class="label-sm">默认数量</label>
                  <select v-model.number="config.canvas.defaultCount" class="input-field font-mono">
                    <option :value="1">1 张</option>
                    <option :value="2">2 张</option>
                    <option :value="4">4 张</option>
                    <option :value="8">8 张</option>
                    <option :value="16">16 张</option>
                  </select>
                </div>
                
                <div>
                  <label class="label-sm">默认尺寸</label>
                  <select v-model="config.canvas.defaultSizePresetId" class="input-field font-mono">
                    <option value="auto">自动（模型决定）</option>
                    <option value="square-1k">1:1 方图 1024×1024</option>
                    <option value="poster-portrait">2:3 竖版海报 1024×1536</option>
                    <option value="portrait-2k">3:4 竖图 1152×1536</option>
                    <option value="wide-4k">4:5 社交竖图 1024×1280</option>
                    <option value="story-9-16">9:16 竖屏故事 1152×2048</option>
                    <option value="video-16-9">16:9 视频封面 2048×1152</option>
                    <option value="poster-landscape">3:2 横版海报 1536×1024</option>
                    <option value="square-2k">4:3 横图 1536×1152</option>
                    <option value="landscape-5-4">5:4 横图 1280×1024</option>
                    <option value="wide-2k">21:9 超宽屏 2688×1152</option>
                  </select>
                </div>
                
                <div>
                  <label class="label-sm">默认风格</label>
                  <select v-model="config.canvas.defaultStylePresetId" class="input-field font-mono">
                    <option value="none">无风格</option>
                    <option value="photoreal">真实摄影</option>
                    <option value="product">产品</option>
                    <option value="illustration">插画</option>
                    <option value="poster">海报</option>
                    <option value="avatar">头像</option>
                  </select>
                </div>
                
                <div>
                  <label class="label-sm">历史记录上限</label>
                  <input v-model.number="config.canvas.maxHistory" type="number" min="1" max="500" step="1" class="input-field font-mono" />
                </div>
                
                <div class="md:col-span-2">
                  <label class="label-sm">数据存储目录</label>
                  <input v-model="config.canvas.dataDir" class="input-field font-mono" placeholder="默认：画布数据目录" />
                </div>
              </div>
            </div>
            
            <div class="card p-5">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
                <div>
                  <h3 class="text-base font-bold text-white">🔍 画布多模态反推参数</h3>
                  <p class="text-zinc-500 text-xs mt-0.5">专门供画布前端上传图片后分析并反推提取出提示词的规则设定</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button @click="resetCanvasInterrogatePrompt" class="btn-outline text-[11px] py-1.5 px-3">默认原图反推</button>
                  <button @click="resetCanvasInterrogateTemplatePrompt" class="btn-outline text-[11px] py-1.5 px-3">默认模板化反推</button>
                </div>
              </div>
              
              <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <!-- Interrogate -->
                <div class="p-4 rounded-xl border border-amber-500/20 bg-amber-950/5">
                  <span class="text-sm font-semibold text-white block mb-3">① 原图反推分析 (第一阶段)</span>
                  
                  <div class="mb-3">
                    <label class="label-sm">反推模型路由</label>
                    <div class="rounded-xl border border-amber-500/20 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
                      当前路由：<span class="font-mono text-zinc-100">{{ routeSummary(['canvas', 'interrogateNodeIndex'], ['canvas', 'interrogateModel']) }}</span>
                      <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-300 hover:underline">去模型路由修改</button>
                    </div>
                  </div>
                  <div class="mb-3">
                    <label class="label-sm">接口超时时间（毫秒）</label>
                    <input v-model.number="config.canvas.interrogateTimeoutMs" type="number" min="30000" step="30000" class="input-field font-mono" />
                  </div>
                  <label class="label-sm">第一阶段视觉分析系统提示词</label>
                  <textarea v-model="config.canvas.interrogatePromptTemplate" rows="8" class="input-field font-mono text-xs leading-relaxed" />
                </div>
                
                <!-- Interrogate Template -->
                <div class="p-4 rounded-xl border border-emerald-500/20 bg-emerald-950/5">
                  <span class="text-sm font-semibold text-white block mb-3">② 模板抽象生成 (第二阶段)</span>
                  
                  <div class="mb-3">
                    <label class="label-sm">模板化反推模型路由</label>
                    <div class="rounded-xl border border-emerald-500/20 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
                      当前路由：<span class="font-mono text-zinc-100">{{ routeSummary(['canvas', 'interrogateTemplateNodeIndex'], ['canvas', 'interrogateTemplateModel']) }}</span>
                      <button @click="currentPage = 'modelRoutes'" class="ml-2 text-indigo-300 hover:underline">去模型路由修改</button>
                    </div>
                  </div>
                  <div class="mb-3">
                    <label class="label-sm">接口超时时间（毫秒）</label>
                    <input v-model.number="config.canvas.interrogateTemplateTimeoutMs" type="number" min="30000" step="30000" class="input-field font-mono" />
                  </div>
                  <label class="label-sm">第二阶段变量提取系统提示词</label>
                  <textarea v-model="config.canvas.interrogateTemplatePromptTemplate" rows="8" class="input-field font-mono text-xs leading-relaxed" />
                  <span class="text-zinc-500 text-[10px] mt-1.5 block font-mono">占位符：<code class="text-indigo-400" v-pre>{{rawPrompt}}</code> 代表上一步原图分析得出的描述。</span>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                <div>
                  <h3 class="text-base font-bold text-white">🗂 画布卡片管理</h3>
                  <p class="text-zinc-500 text-xs mt-0.5">管理画廊与模板库卡片，左侧使用压缩缩略图方便快速预览。</p>
                </div>
                <button @click="fetchCanvasCards()" :disabled="canvasCardsLoading" class="btn-outline text-xs py-1.5 px-3">
                  {{ canvasCardsLoading ? '刷新中...' : '刷新卡片' }}
                </button>
              </div>

              <div v-if="canvasCardsError" class="mb-3 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {{ canvasCardsError }}
              </div>

              <div v-if="canvasCardsLoading && !canvasCards.length" class="rounded-2xl border border-white/5 bg-zinc-950/30 p-6 text-center text-xs text-zinc-500">
                正在读取卡片列表...
              </div>
              <div v-else-if="!canvasCards.length" class="rounded-2xl border border-white/5 bg-zinc-950/30 p-6 text-center text-xs text-zinc-500">
                暂无可管理卡片。生成图片或完成模板反推后会显示在这里。
              </div>
              <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div v-for="card in canvasCards" :key="card.kind + ':' + card.id" class="flex gap-3 rounded-2xl border border-white/5 bg-zinc-950/30 p-3">
                  <div class="w-24 h-24 shrink-0 overflow-hidden rounded-xl border border-white/5 bg-zinc-900">
                    <img v-if="canvasCardPreviewUrl(card)" :src="canvasCardPreviewUrl(card)" :alt="card.title" class="w-full h-full object-cover" loading="lazy" />
                    <div v-else class="w-full h-full grid place-items-center text-[10px] text-zinc-600">无预览</div>
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300">{{ canvasCardKindText(card.kind) }}</span>
                      <span v-if="card.favorite" class="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">已收藏</span>
                    </div>
                    <div class="line-clamp-2 text-sm font-semibold text-zinc-100">{{ card.title || '未命名卡片' }}</div>
                    <div class="mt-1 text-[11px] text-zinc-500">{{ card.subtitle }}</div>
                    <div class="mt-1 text-[10px] text-zinc-600 font-mono">{{ card.createdAt }}</div>
                    <div class="mt-3 flex flex-wrap gap-2">
                      <a v-if="card.asset?.id" class="btn-outline text-[11px] py-1 px-2" :href="canvasCardDownloadUrl(card)" target="_blank" rel="noreferrer">预览原图</a>
                      <button @click="deleteCanvasCard(card)" class="btn-danger text-[11px] py-1 px-2">删除卡片</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Canvas log configuration -->
            <div class="card p-5 canvas-log-card log-panel-card log-panel-card--canvas">
              <div class="log-panel-head">
                <div class="log-panel-title">
                  <span class="log-panel-icon">画</span>
                  <div>
                    <h3>独立画布日志管理器</h3>
                    <p v-if="canvasLogStats">
                      <span>内存 <code>{{ canvasLogStats.memoryTotal ?? canvasLogStats.total }}/{{ canvasLogStats.maxMemoryEntries }}</code></span>
                      <span>总数 <code>{{ canvasLogStats.total }}</code></span>
                      <span class="log-file-path">文件 <code>{{ canvasLogStats.logFile }}</code></span>
                    </p>
                    <p v-else>记录画布接口通信、生图渲染、反推调用与图库同步状态。</p>
                  </div>
                </div>

                <div class="log-controls canvas-log-controls">
                  <div>
                    <label class="label-sm">级别</label>
                    <select v-model="canvasLogLevel" @change="fetchCanvasLogs()" class="input-field font-mono">
                      <option value="all">全部</option>
                      <option value="debug">调试</option>
                      <option value="info">信息</option>
                      <option value="warn">警告</option>
                      <option value="error">错误</option>
                    </select>
                  </div>
                  <div class="log-limit-field">
                    <label class="label-sm">显示条数</label>
                    <input
                      v-model.number="canvasLogLimit"
                      @change="applyCanvasLogLimit"
                      @keyup.enter="applyCanvasLogLimit"
                      type="number"
                      min="1"
                      max="5000"
                      step="50"
                      class="input-field font-mono"
                      placeholder="300"
                    />
                    <span class="log-limit-hint">1-5000</span>
                  </div>
                  <div class="log-search-field">
                    <label class="label-sm">搜索关键字</label>
                    <input v-model="canvasLogSearch" @keyup.enter="fetchCanvasLogs()" class="input-field" placeholder="输入范围或错误信息..." />
                  </div>
                  <button @click="fetchCanvasLogs()" :disabled="canvasLogLoading" class="btn-outline log-touch-button">
                    {{ canvasLogLoading ? '读取中' : '刷新' }}
                  </button>
                  <button @click="copyCanvasVisibleLogs" :disabled="!canvasLogEntries.length" class="btn-outline log-touch-button log-touch-button--copy">
                    复制当前
                  </button>
                  <button @click="clearCanvasLogs" :disabled="canvasLogLoading" class="btn-danger log-touch-button">
                    清空
                  </button>
                </div>
              </div>

              <!-- Canvas log switch -->
              <div class="log-settings-grid">
                <label class="log-toggle-card">
                  <span>
                    <strong>画布日志记录</strong>
                    <em>{{ config.canvas.logs.enabled ? '正在写入' : '已暂停' }}</em>
                  </span>
                  <input type="checkbox" v-model="config.canvas.logs.enabled" class="rounded accent-indigo-500 h-4.5 w-4.5" />
                </label>
                <div>
                  <label class="label-sm">最低写入级别</label>
                  <select v-model="config.canvas.logs.level" class="input-field">
                    <option value="debug">调试</option>
                    <option value="info">信息</option>
                    <option value="warn">警告</option>
                    <option value="error">错误</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">内存保留上限条数</label>
                  <input v-model.number="config.canvas.logs.maxMemoryEntries" type="number" min="100" max="5000" step="100" class="input-field font-mono" />
                </div>
              </div>

              <!-- Canvas Log List Terminal -->
              <div class="log-terminal log-terminal--compact">
                <div class="log-terminal__bar">
                  <div>
                    <span class="log-terminal__title">画布日志输出</span>
                    <small>{{ canvasLogEntries.length }} 条符合过滤条件</small>
                  </div>
                  <button @click="copyCanvasVisibleLogs" :disabled="!canvasLogEntries.length" class="log-copy-button log-copy-button--bar">复制全部</button>
                </div>

                <div v-if="canvasLogLoading && !canvasLogEntries.length" class="log-empty-state animate-pulse">
                  正在读取日志缓冲区...
                </div>
                <div v-else-if="!canvasLogEntries.length" class="log-empty-state">
                  当前没有画布日志记录。
                </div>
                <div v-else class="log-terminal__list log-terminal__list--compact">
                  <article v-for="entry in canvasLogEntries" :key="entry.id" class="log-entry log-entry--compact">
                    <header class="log-entry__meta">
                      <span :class="['log-level-badge', levelBadgeClass(entry.level)]">{{ logLevelText(entry.level) }}</span>
                      <time>{{ entry.timestamp }}</time>
                      <span class="log-entry__scope">{{ entry.scope }}</span>
                      <span class="log-entry__id">#{{ entry.id }}</span>
                      <button @click="copyLogEntry(entry)" class="log-copy-button">复制本条</button>
                    </header>
                    <p class="log-entry__message selectable-log-text">{{ entry.message }}</p>
                    <pre v-if="formatLogDetails(entry.details)" class="log-entry__details selectable-log-text">{{ formatLogDetails(entry.details) }}</pre>
                  </article>
                </div>
              </div>

            </div>
          </div>

          <!-- ═══ Tab: Napcat (Napcat 连接) ═══ -->
          <div v-show="currentPage === 'napcat'" class="space-y-6 animate-fadein">
            <div class="card p-5">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
                <div>
                  <h3 class="text-base font-bold text-white">🔌 机器人长连接适配器</h3>
                  <p class="text-zinc-500 text-xs mt-0.5">建立与 QQ 客户端的直接长连接，收发和转发多图消息</p>
                </div>
                <button @click="testNapcatConnection" :disabled="napcatTestLoading" class="btn-primary text-xs py-1.5 px-3">
                  {{ napcatTestLoading ? '⏳ 连接测试中...' : '🔌 立即测试长连接' }}
                </button>
              </div>
              
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="label-sm">长连接地址</label>
                  <input v-model="config.napcat.wsUrl" class="input-field font-mono" placeholder="Napcat WebSocket 地址（可留空）" />
                </div>
                <div>
                  <label class="label-sm">接口访问令牌</label>
                  <input v-model="config.napcat.token" type="password" class="input-field font-mono" placeholder="若无访问密码则留空..." />
                </div>
              </div>
              
              <div class="mt-5 pt-4 border-t border-white/5">
                <div class="font-bold text-xs text-zinc-300 mb-3">各类行为超时时间设定（毫秒）</div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3.5">
                  <div>
                    <label class="label-sm text-[10px]">通用操作超时</label>
                    <input v-model.number="config.napcat.actionTimeoutMs" type="number" min="3000" step="1000" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm text-[10px]">文本发送超时</label>
                    <input v-model.number="config.napcat.textSendTimeoutMs" type="number" min="3000" step="1000" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm text-[10px]">图片上传超时</label>
                    <input v-model.number="config.napcat.imageSendTimeoutMs" type="number" min="10000" step="5000" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm text-[10px]">文件发送超时</label>
                    <input v-model.number="config.napcat.fileSendTimeoutMs" type="number" min="10000" step="5000" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm text-[10px]">文件重试次数</label>
                    <input v-model.number="config.napcat.fileSendRetryCount" type="number" min="0" max="10" step="1" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm text-[10px]">文件重试间隔</label>
                    <input v-model.number="config.napcat.fileSendRetryDelayMs" type="number" min="0" step="500" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm text-[10px]">合并转发超时</label>
                    <input v-model.number="config.napcat.forwardSendTimeoutMs" type="number" min="10000" step="5000" class="input-field font-mono text-center" />
                  </div>
                  <div>
                    <label class="label-sm text-[10px]">引用取消息超时</label>
                    <input v-model.number="config.napcat.getMessageTimeoutMs" type="number" min="3000" step="1000" class="input-field font-mono text-center" />
                  </div>
                </div>
              </div>

              <!-- Test connection result alert -->
              <div v-if="napcatTestResult" class="mt-5 rounded-xl border p-4 text-xs animate-fadein"
                :class="napcatTestResult.success ? 'border-emerald-500/20 bg-emerald-950/10 text-emerald-300' : 'border-rose-500/20 bg-rose-950/10 text-rose-300'">
                <div class="font-bold text-sm flex items-center gap-1.5">
                  <span>{{ napcatTestResult.success ? '🟢 测试连接正常' : '🔴 无法与长连接握手' }}</span>
                </div>
                <div class="mt-2 font-mono text-zinc-300 leading-normal">{{ napcatTestResult.message }}</div>
                <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-400">
                  <span v-if="napcatTestResult.selfQqId">自身 QQ 号: {{ napcatTestResult.selfQqId }}</span>
                  <span v-if="napcatTestResult.nickname">QQ 昵称: {{ napcatTestResult.nickname }}</span>
                  <span v-if="napcatTestResult.latencyMs !== undefined">网络延时：{{ napcatTestResult.latencyMs }} 毫秒</span>
                  <span v-if="napcatTestResult.currentBot">长连接状态: {{ napcatTestResult.currentBot.readyStateText }}</span>
                </div>
              </div>
            </div>

            <!-- Volume paths mapping -->
            <div class="card p-5">
              <h3 class="text-base font-bold text-white mb-2">📂 容器内挂载目录映射</h3>
              <p class="text-zinc-500 text-xs mb-3">若客户端在本地或容器内运行，可以配置其生成的输出绝对目录。留空则走编码传输。</p>
              <input v-model="config.napcat.mountOutputDir" class="input-field font-mono max-w-xl" placeholder="例如: /app/napcat/output" />
            </div>

            <!-- Panel Password -->
            <div class="card p-5">
              <h3 class="text-base font-bold text-white mb-2">🔑 重设控制台管理密码</h3>
              <p class="text-zinc-500 text-xs mb-3">修改管理面板密码。保存并热重载后，当前令牌自动失效，需要用新密码重登。</p>
              <input v-model="config.panel.passwordSeed" class="input-field font-mono max-w-sm" placeholder="输入您的新密码..." />
            </div>
          </div>

          <!-- ═══ Tab: Logs (运行日志) ═══ -->
          <div v-show="currentPage === 'logs'" class="space-y-6 animate-fadein">
            <div class="card p-5 log-panel-card log-panel-card--system">
              <div class="log-panel-head">
                <div class="log-panel-title">
                  <span class="log-panel-icon">志</span>
                  <div>
                    <h3>机器人运行系统日志</h3>
                    <p v-if="logStats">
                      <span>内存 <code>{{ logStats.memoryTotal ?? logStats.total }}/{{ logStats.maxMemoryEntries }}</code></span>
                      <span>总数 <code>{{ logStats.total }}</code></span>
                      <span class="log-file-path">文件 <code>{{ logStats.logFile }}</code></span>
                    </p>
                    <p v-else>正在监控实时系统运行日志与机器人消息处理链路。</p>
                  </div>
                </div>

                <div class="log-controls log-controls--system">
                  <div>
                    <label class="label-sm">级别</label>
                    <select v-model="logLevel" @change="fetchLogs()" class="input-field font-mono">
                      <option value="all">全部</option>
                      <option value="debug">调试</option>
                      <option value="info">信息</option>
                      <option value="warn">警告</option>
                      <option value="error">错误</option>
                    </select>
                  </div>
                  <div class="log-limit-field">
                    <label class="label-sm">显示条数</label>
                    <input
                      v-model.number="logLimit"
                      @change="applySystemLogLimit"
                      @keyup.enter="applySystemLogLimit"
                      type="number"
                      min="1"
                      max="5000"
                      step="50"
                      class="input-field font-mono"
                      placeholder="300"
                    />
                    <span class="log-limit-hint">1-5000</span>
                  </div>
                  <div class="log-search-field">
                    <label class="label-sm">全文匹配检索</label>
                    <input v-model="logSearch" @keyup.enter="fetchLogs()" class="input-field" placeholder="模糊检索范围 / 报错词..." />
                  </div>
                  
                  <label class="log-auto-refresh">
                    <input type="checkbox" v-model="logAutoRefresh" class="rounded accent-indigo-500 h-4.5 w-4.5" />
                    <span>自动刷新</span>
                  </label>
                  
                  <button @click="fetchLogs()" :disabled="logLoading" class="btn-outline log-touch-button">
                    {{ logLoading ? '读取中' : '刷新' }}
                  </button>
                  <button @click="copyVisibleLogs" :disabled="!logEntries.length" class="btn-outline log-touch-button log-touch-button--copy">
                    复制当前
                  </button>
                  <button @click="clearLogs" :disabled="logLoading" class="btn-danger log-touch-button">
                    清空
                  </button>
                </div>
              </div>
              <p v-if="logError" class="log-inline-status log-inline-status--error animate-fadein">{{ logError }}</p>
              <p v-if="logCopyStatus" class="log-inline-status log-inline-status--success animate-fadein">{{ logCopyStatus }}</p>
            </div>

            <!-- Terminal block for System logs -->
            <div class="card log-terminal log-terminal--system">
              <div class="log-terminal__bar">
                <div>
                  <span class="log-terminal__title">系统日志输出</span>
                  <small>{{ logEntries.length }} 条级别记录</small>
                </div>
                <button @click="copyVisibleLogs" :disabled="!logEntries.length" class="log-copy-button log-copy-button--bar">复制全部</button>
              </div>
              
              <div v-if="logLoading && !logEntries.length" class="log-empty-state animate-pulse">
                正在连接系统日志缓冲区...
              </div>
              <div v-else-if="!logEntries.length" class="log-empty-state">
                当前日志流为空，等待机器人交互。
              </div>
              <div v-else class="log-terminal__list">
                <article v-for="entry in logEntries" :key="entry.id" class="log-entry">
                  <div class="log-entry__main">
                    <header class="log-entry__meta">
                      <span :class="['log-level-badge', levelBadgeClass(entry.level)]">{{ logLevelText(entry.level) }}</span>
                      <time>{{ entry.timestamp }}</time>
                      <span class="log-entry__scope">{{ entry.scope }}</span>
                      <span class="log-entry__id">#{{ entry.id }}</span>
                      <button @click="copyLogEntry(entry)" class="log-copy-button">复制本条</button>
                    </header>
                    <p class="log-entry__message selectable-log-text">{{ entry.message }}</p>
                  </div>

                  <!-- Details panel -->
                  <div v-if="formatLogDetails(entry.details)" class="log-entry__details-panel">
                    <div class="log-entry__details-head">
                      <span>原始堆栈 / 结构化数据</span>
                      <button @click="copyLogDetails(entry)" class="log-copy-button">复制详情</button>
                    </div>
                    <pre class="log-entry__details selectable-log-text">{{ formatLogDetails(entry.details) }}</pre>
                  </div>
                </article>
              </div>
            </div>
          </div>

          <!-- ═══ Tab: About (关于 Console) ═══ -->
          <div v-show="currentPage === 'about'" class="animate-fadein">
            <div class="card p-8 text-center max-w-xl mx-auto relative overflow-hidden">
              <div class="absolute -top-24 -left-24 w-48 h-48 bg-indigo-500/5 rounded-full blur-3xl"></div>
              
              <div class="text-6xl mb-4 animate-bounce">🌟</div>
              <h2 class="text-2xl font-black bg-gradient-to-r from-indigo-200 via-zinc-100 to-cyan-200 bg-clip-text text-transparent mb-1">机器人控制台</h2>
              <p class="text-zinc-500 text-xs font-mono">新一代多模型 QQ 机器人平台</p>
              
              <div class="w-16 h-0.5 bg-zinc-800 mx-auto my-6"></div>
              
              <p class="text-zinc-400 text-sm leading-relaxed max-w-md mx-auto">
                基于类型化脚本精确重构的第二代智能 QQ 机器人管理平台。无缝衔接各类主流大语言模型，并具备独立的图像交互创作画布（画布工作室）。
              </p>
              
              <div class="mt-8 text-zinc-500 text-xs space-y-2 max-w-xs mx-auto border border-white/5 rounded-xl bg-zinc-950/40 p-4">
                <div class="flex justify-between"><span class="text-zinc-600">系统内核</span><span class="text-zinc-300 font-mono">v2.0.0 稳定版</span></div>
                <div class="flex justify-between"><span class="text-zinc-600">技术选型</span><span class="text-zinc-300 font-mono">前端工程化架构</span></div>
                <div class="flex justify-between"><span class="text-zinc-600">设计规范</span><span class="text-zinc-300 font-mono">浅色玻璃风格</span></div>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>

    <div v-if="copyFallbackText" class="copy-fallback-overlay" role="dialog" aria-modal="true" aria-labelledby="manual-copy-title" @click.self="closeCopyFallback">
      <section class="copy-fallback-card">
        <div class="copy-fallback-card__header">
          <div>
            <p class="copy-fallback-kicker">移动端手动复制</p>
            <h3 id="manual-copy-title">自动复制被浏览器拦截</h3>
          </div>
          <button type="button" class="copy-fallback-close" aria-label="关闭手动复制窗口" @click="closeCopyFallback">×</button>
        </div>
        <p class="copy-fallback-help">
          {{ copyFallbackTitle }}。已为你选中日志文本。手机端如果按钮复制无效，请长按下方内容，选择全选并复制。
        </p>
        <textarea
          ref="copyFallbackTextarea"
          class="copy-fallback-textarea"
          :value="copyFallbackText"
          readonly
          @focus="selectCopyFallbackText"
          @click="selectCopyFallbackText"
        ></textarea>
        <div class="copy-fallback-actions">
          <button type="button" class="btn-outline" @click="selectCopyFallbackText">重新选中</button>
          <button type="button" class="btn-primary" @click="closeCopyFallback">完成</button>
        </div>
      </section>
    </div>

    <div v-if="toasts.length" class="toast-container" aria-live="polite">
      <div v-for="toast in toasts" :key="toast.id" :class="['custom-toast', `custom-toast--${toast.type}`]">
        <span>{{ toast.message }}</span>
        <div class="toast-progress"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Page transition custom smoothing */
.animate-fadein {
  animation: fadein 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.log-limit-field {
  min-width: 112px;
}

.log-limit-field .input-field {
  width: 112px;
}

.log-limit-hint {
  display: block;
  margin-top: 4px;
  color: rgba(148, 163, 184, 0.82);
  font-size: 11px;
  line-height: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
// @END [TASK-001]
