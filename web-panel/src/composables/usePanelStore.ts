// P7: 全局面板状态 —— 从 App.vue <script setup> 抽出的全部逻辑，
// App.vue 调用一次并 provide('panelStore', store)；各页组件 inject 后
// 通过 setup() return { ...store } 暴露全部绑定(ref 自动解包)。
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

type CodexChatMessage = {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'error';
  text: string;
  timestamp: string;
  meta?: string;
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

export function usePanelStore() {
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
  const codexStatus = ref<any>(null);
  const codexStatusLoading = ref(false);
  const codexStatusError = ref('');
  const codexLoginLoading = ref(false);
  const codexCallbackUrl = ref('');
  const codexCallbackSubmitting = ref(false);
  const codexLoginSuccessNotified = ref(false);
  const codexMessages = ref<CodexChatMessage[]>([]);
  const codexInput = ref('');
  const codexThreadId = ref(localStorage.getItem('np_codex_thread_id') || '');
  const codexSandbox = ref('workspace_write');
  const codexModel = ref('');
  const codexSending = ref(false);
  const codexGitStatus = ref<any>(null);
  const codexGitLoading = ref(false);
  const codexGitPushLoading = ref(false);
  const codexGitError = ref('');
  const codexCommitMessage = ref('Codex remote update');
  let codexMessageId = 0;
  let codexLoginTimer: number | null = null;
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
    { id: 'codex', icon: '码', label: 'Codex 助手' },
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
  onBeforeUnmount(() => {
    stopLogTimer();
    stopCodexLoginTimer();
  });

  watch([currentPage, logAutoRefresh], async ([page]) => {
    if (page === 'logs') {
      await fetchLogs();
      startLogTimer();
    } else if (page === 'canvas') {
      stopLogTimer();
      ensureCanvasConfig();
      await fetchCanvasCards();
      await fetchCanvasLogs();
    } else if (page === 'codex') {
      stopLogTimer();
      await refreshCodexPanel();
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
        // 后端登录返回 { auth: { token, ... } }；兼容旧单体顶层 token 字段。
        token.value = res.data.auth?.token || res.data.token;
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
      const nextToken = res.data?.token || res.data?.auth?.token;
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
      // 仅当后端返回新 auth.token(seed 变更)时刷新；seed 本身不是 token，不可直接当 token 用。
      const nextToken = res.data?.auth?.token;
      if (nextToken && token.value !== nextToken) {
        token.value = nextToken;
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
      logEntries.value = res.data.items || res.data.entries || [];
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
      logEntries.value = res.data.items || res.data.entries || [];
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
      canvasLogEntries.value = res.data.items || res.data.entries || [];
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
      canvasLogEntries.value = res.data.items || res.data.entries || [];
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
    const details = formatLogDetails(entry.details || entry.data);
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
    const details = formatLogDetails(entry.details || entry.data);
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

  function addCodexMessage(role: CodexChatMessage['role'], text: string, meta = '') {
    codexMessages.value.push({
      id: codexMessageId++,
      role,
      text,
      meta,
      timestamp: new Date().toLocaleString(),
    });
  }

  function codexReady() {
    return Boolean(
      codexStatus.value?.enabled &&
      codexStatus.value?.python?.sdkAvailable &&
      codexStatus.value?.account?.signedIn &&
      codexStatus.value?.workspace?.ok &&
      !codexStatus.value?.busy
    );
  }

  function codexStatusText() {
    if (codexStatusLoading.value) return '检测中';
    if (codexStatusError.value) return '状态异常';
    if (!codexStatus.value) return '未检测';
    if (!codexStatus.value.enabled) return '已关闭';
    if (!codexStatus.value.workspace?.ok) return '工作区异常';
    if (!codexStatus.value.python?.sdkAvailable) return 'SDK 未安装';
    if (!codexStatus.value.account?.signedIn) return codexStatus.value.login?.running ? '等待登录' : '未登录';
    if (codexStatus.value.busy) return '处理中';
    return '可用';
  }

  function codexStatusTone() {
    if (codexReady()) return 'success';
    if (codexStatus.value?.busy) return 'info';
    return 'error';
  }

  function codexMessageClass(role: CodexChatMessage['role']) {
    if (role === 'user') return 'codex-message codex-message--user';
    if (role === 'error') return 'codex-message codex-message--error';
    if (role === 'system') return 'codex-message codex-message--system';
    return 'codex-message codex-message--assistant';
  }

  async function fetchCodexStatus() {
    codexStatusLoading.value = true;
    codexStatusError.value = '';
    try {
      const res = await axios.get(`${API_BASE}/codex/status`, { headers: authHeaders() });
      codexStatus.value = res.data;
      const presets = res.data?.sandboxPresets || [];
      if (presets.length && !presets.includes(codexSandbox.value)) codexSandbox.value = presets[0];
      if (!codexModel.value && res.data?.model) codexModel.value = res.data.model;
    } catch (e: any) {
      codexStatusError.value = e.response?.data?.error || e.message || 'Codex 状态读取失败';
    } finally {
      codexStatusLoading.value = false;
    }
  }

  async function fetchCodexGitStatus() {
    codexGitLoading.value = true;
    codexGitError.value = '';
    try {
      const res = await axios.get(`${API_BASE}/codex/git/status`, { headers: authHeaders() });
      codexGitStatus.value = res.data;
    } catch (e: any) {
      codexGitError.value = e.response?.data?.error || e.message || 'Git 状态读取失败';
    } finally {
      codexGitLoading.value = false;
    }
  }

  async function refreshCodexPanel() {
    await Promise.all([fetchCodexStatus(), fetchCodexGitStatus()]);
    if (codexStatus.value?.login?.running) startCodexLoginTimer();
  }

  function resetCodexThread() {
    codexThreadId.value = '';
    localStorage.removeItem('np_codex_thread_id');
    addCodexMessage('system', '已切换为新 Codex 线程。下一条消息会创建新的远程修改会话。');
  }

  function startCodexLoginTimer() {
    stopCodexLoginTimer();
    codexLoginTimer = window.setInterval(() => pollCodexLoginStatus(), 2500);
  }

  function stopCodexLoginTimer() {
    if (codexLoginTimer !== null) {
      window.clearInterval(codexLoginTimer);
      codexLoginTimer = null;
    }
  }

  function notifyCodexLoginSuccessOnce() {
    if (codexLoginSuccessNotified.value) return;
    codexLoginSuccessNotified.value = true;
    showToast('服务器 Codex 已登录', 'success');
  }

  async function pollCodexLoginStatus() {
    if (currentPage.value !== 'codex') {
      stopCodexLoginTimer();
      return;
    }
    try {
      const res = await axios.get(`${API_BASE}/codex/login/status`, { headers: authHeaders() });
      if (!codexStatus.value) codexStatus.value = {};
      codexStatus.value.login = res.data.login;
      codexStatus.value.account = res.data.account;
      if (res.data.account?.signedIn || !res.data.login?.running) {
        stopCodexLoginTimer();
        await fetchCodexStatus();
        if (res.data.account?.signedIn) {
          notifyCodexLoginSuccessOnce();
        }
      }
    } catch {
      stopCodexLoginTimer();
    }
  }

  async function startCodexWebLogin() {
    if (codexLoginLoading.value) return;
    codexLoginLoading.value = true;
    codexLoginSuccessNotified.value = false;
    try {
      const res = await axios.post(`${API_BASE}/codex/login/web/start`, {}, { headers: authHeaders() });
      if (!codexStatus.value) codexStatus.value = {};
      codexStatus.value.login = res.data.login;
      addCodexMessage('system', `Codex 网页登录已开始，请打开 ${res.data.login.authUrl} 完成授权。`);
      showToast('Codex 网页登录链接已生成', 'success');
      startCodexLoginTimer();
    } catch (e: any) {
      const error = e.response?.data?.error || e.message || 'Codex 登录启动失败';
      addCodexMessage('error', error);
      showToast(error, 'error');
    } finally {
      codexLoginLoading.value = false;
      await fetchCodexStatus();
    }
  }

  async function cancelCodexWebLogin() {
    try {
      const res = await axios.post(`${API_BASE}/codex/login/web/cancel`, {}, { headers: authHeaders() });
      if (!codexStatus.value) codexStatus.value = {};
      codexStatus.value.login = res.data.login;
      codexCallbackUrl.value = '';
      codexLoginSuccessNotified.value = false;
      stopCodexLoginTimer();
      showToast('已取消 Codex 登录流程', 'info');
    } catch (e: any) {
      showToast(e.response?.data?.error || e.message || '取消失败', 'error');
    } finally {
      await fetchCodexStatus();
    }
  }

  async function submitCodexCallbackUrl() {
    const callbackUrl = codexCallbackUrl.value.trim();
    if (!callbackUrl || codexCallbackSubmitting.value) {
      if (!callbackUrl) showToast('请先粘贴浏览器跳转后的完整 callback 地址', 'error');
      return;
    }
    codexCallbackSubmitting.value = true;
    try {
      const res = await axios.post(`${API_BASE}/codex/login/web/callback`, { callbackUrl }, { headers: authHeaders() });
      if (!codexStatus.value) codexStatus.value = {};
      codexStatus.value.login = res.data.login;
      codexStatus.value.account = res.data.account;
      codexCallbackUrl.value = '';
      addCodexMessage('system', '已把网页登录回调提交给服务器 Codex，正在刷新登录状态。');
      if (res.data.account?.signedIn) {
        stopCodexLoginTimer();
        notifyCodexLoginSuccessOnce();
      } else {
        startCodexLoginTimer();
        showToast('回调已提交，等待 Codex 确认登录', 'success');
      }
    } catch (e: any) {
      const error = e.response?.data?.error || e.message || '回调提交失败';
      addCodexMessage('error', error);
      showToast(error, 'error');
    } finally {
      codexCallbackSubmitting.value = false;
      await fetchCodexStatus();
    }
  }

  async function sendCodexMessage() {
    const message = codexInput.value.trim();
    if (!message || codexSending.value) return;
    if (!codexReady()) {
      showToast(`Codex 当前不可用：${codexStatusText()}`, 'error');
      await fetchCodexStatus();
      return;
    }
    codexInput.value = '';
    codexSending.value = true;
    addCodexMessage('user', message, codexSandbox.value);
    try {
      const res = await axios.post(`${API_BASE}/codex/chat`, {
        message,
        threadId: codexThreadId.value,
        sandbox: codexSandbox.value,
        model: codexModel.value.trim(),
      }, { headers: authHeaders() });
      if (res.data.threadId) {
        codexThreadId.value = res.data.threadId;
        localStorage.setItem('np_codex_thread_id', res.data.threadId);
      }
      const answer = res.data.finalResponse || `Codex 已完成，状态：${res.data.status || 'unknown'}`;
      addCodexMessage('assistant', answer, `thread ${res.data.threadId || codexThreadId.value || '-'} · ${Math.round((res.data.durationMs || 0) / 1000)}s`);
      showToast('Codex 已完成本轮任务', 'success');
      await fetchCodexGitStatus();
    } catch (e: any) {
      const error = e.response?.data?.error || e.message || 'Codex 调用失败';
      addCodexMessage('error', error);
      showToast(`Codex 调用失败: ${error}`, 'error');
    } finally {
      codexSending.value = false;
      await fetchCodexStatus();
    }
  }

  function codexGitFilesSummary() {
    const files = codexGitStatus.value?.files || [];
    if (!files.length) return '服务器工作区干净';
    return `${files.length} 个文件有变更`;
  }

  async function pushCodexGitChanges() {
    if (codexGitPushLoading.value) return;
    if (!codexGitStatus.value?.dirty) {
      showToast('服务器当前没有可推送的变更', 'info');
      return;
    }
    if (!window.confirm('确认把服务器当前 git 变更提交并推送到远端仓库吗？')) return;
    codexGitPushLoading.value = true;
    codexGitError.value = '';
    try {
      const res = await axios.post(`${API_BASE}/codex/git/push`, {
        confirm: true,
        message: codexCommitMessage.value,
      }, { headers: authHeaders() });
      codexGitStatus.value = res.data.status;
      addCodexMessage('system', `Git 已提交并推送：${res.data.message}`, res.data.status?.branch || '');
      showToast('服务器变更已推送到 Git', 'success');
    } catch (e: any) {
      codexGitError.value = e.response?.data?.error || e.message || 'Git 推送失败';
      showToast(`Git 推送失败: ${codexGitError.value}`, 'error');
    } finally {
      codexGitPushLoading.value = false;
      await fetchCodexGitStatus();
    }
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

  return {
    // 常量
    menuItems,
    // 认证 / 全局
    isAuthenticated, password, loginError, token, config, savedConfigSnapshot,
    savingConfig, saveStatus, currentPage, isMobileSidebarOpen,
    configImportInput, copyFallbackText, copyFallbackTitle, copyFallbackTextarea,
    // 模型 / 节点
    fetchedModels, modelLoading, modelError,
    // Hugging Face
    hfModelsLoading, hfModelsError, hfFetchStatus,
    // 测试
    napcatTestLoading, napcatTestResult, imageTestLoading, imageTestPrompt, imageTestResult,
    // 默认提示词
    defaultPrompts,
    // 系统日志
    logEntries, logLoading, logError, logLevel, logSearch, logLimit, logStats,
    logAutoRefresh, logTimer, logCopyStatus,
    // 画布日志 / 卡片
    canvasLogEntries, canvasLogLoading, canvasLogError, canvasLogLevel, canvasLogSearch,
    canvasLogLimit, canvasLogStats, canvasLogCopyStatus,
    canvasCards, canvasCardsLoading, canvasCardsError,
    // Codex
    codexStatus, codexStatusLoading, codexStatusError, codexLoginLoading, codexCallbackUrl,
    codexCallbackSubmitting, codexLoginSuccessNotified, codexMessages, codexInput, codexThreadId,
    codexSandbox, codexModel, codexSending, codexGitStatus, codexGitLoading, codexGitPushLoading,
    codexGitError, codexCommitMessage,
    // 模板
    templateConvertSource, templateConvertLoading, templateConvertStatus,
    templateTitleLoading, collapsedTemplates,
    // Toast
    toasts,
    // —— 函数 ——
    showToast, clampLogLimit, readSavedLogLimit, pageLabel, toggleMobileSidebar, closeMobileSidebar,
    authHeaders, login, fetchConfig, ensureCanvasConfig, fetchDefaultPrompts, handleLogout,
    saveConfig, applyServerConfig, rememberSavedConfigSnapshot, buildConfigSavePayload,
    sanitizeConfigForSave, diffConfigPatch, isEmptyPatch, countPatchChanges, clonePlain,
    isPlainObject, stableJson, exportConfig, triggerImportConfig, importConfigFromFile,
    testNapcatConnection, testImageApi, addNode, normalizeIndex, removeNode, setActiveNode,
    parseNodeConnectionInput, applyAnyRouterPreset, applyChatGpt2ApiPreset, fetchModels,
    hfConfig, hfModels, applyHfPreset, clearHfCache, selectHfModel, fetchHuggingFaceModels, hfFormatDate,
    applySystemLogLimit, applyCanvasLogLimit, fetchLogs, clearLogs, fetchCanvasLogs, clearCanvasLogs,
    fetchCanvasCards, deleteCanvasCard, canvasCardPreviewUrl, canvasCardDownloadUrl, canvasCardKindText,
    copyCanvasVisibleLogs, startLogTimer, stopLogTimer, formatLogDetails, formatLogEntry,
    writeClipboardText, openManualCopyFallback, selectCopyFallbackText, closeCopyFallback, copyText,
    copyLogEntry, copyLogDetails, copyVisibleLogs, levelBadgeClass, logLevelText,
    addCodexMessage, codexReady, codexStatusText, codexStatusTone, codexMessageClass,
    fetchCodexStatus, fetchCodexGitStatus, refreshCodexPanel, resetCodexThread,
    startCodexLoginTimer, stopCodexLoginTimer, notifyCodexLoginSuccessOnce, pollCodexLoginStatus,
    startCodexWebLogin, cancelCodexWebLogin, submitCodexCallbackUrl, sendCodexMessage,
    codexGitFilesSummary, pushCodexGitChanges,
    nodeOptions, modelsForNode, modelRouteGroups, getConfigPath, setConfigPath, updateModelRoute,
    routeNodeIndex, routeNodeOptions, routeModelValue, routeModelOptions, routeDatalistId,
    nodeDisplayName, routeEnabled, routeSummary, routeFailoverCount, modelLimitRows, findModelLimit,
    ensureModelLimit, modelLimitEnabled, modelLimitConcurrency, setModelLimitEnabled, setModelLimitConcurrency,
    resetEnhancePrompt, resetInterrogatePrompt, resetCanvasInterrogatePrompt, resetCanvasInterrogateTemplatePrompt,
    resetSafeRewritePrompt, resetTemplatePrompt, resetReferencedTemplatePrompt, resetTemplateConvertPrompt,
    resetTemplateTitlePrompt, resetTranslationPrompt, resetPromptsChatSearchPrompt, resetPromptsChatSmartPrompt,
    promptTemplates, templateKey, isTemplateCollapsed, toggleTemplateCollapsed, normalizePromptTemplateIds,
    addPromptTemplate, removePromptTemplate, normalizeTtsVoiceIds, addTtsVoiceId, removeTtsVoiceId,
    selectTtsVoiceId, onTtsVoiceIdInput, convertPromptToTemplate, generateTemplateTitle,
  };
}

export type PanelStore = ReturnType<typeof usePanelStore>;
