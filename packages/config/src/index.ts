import type { ConfigSourceFormat, LegacyReplyFormat, MigrationNotice, PackageDescriptor, ReplyStrategy } from '@miobot-v2/shared';

export const CONFIG_PACKAGE: PackageDescriptor = { name: '@miobot-v2/config', phase: 'P12-config-regression' };
export const CONFIG_SCHEMA_VERSION = 2;
export const LEGACY_EXPORT_VERSION = 1;

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type PromptsChatPromptType = '' | 'TEXT' | 'STRUCTURED' | 'IMAGE' | 'VIDEO' | 'AUDIO';
export type ImageEditRequestMode = 'auto' | 'json-images' | 'json-image' | 'multipart';
export type CanvasImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type CanvasOutputFormat = 'png' | 'jpeg' | 'webp';
export type CanvasLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ApiNode { name: string; baseUrl: string; key: string; enabled: boolean; models: string[]; modelsFetchedAt: string }
export interface ModelLimitRule { nodeIndex: number; model: string; enabled: boolean; concurrency: number }
export interface PromptTemplate { id: string; title: string; prompt: string }
export interface PromptsChatConfig { enabled: boolean; endpoint: string; apiKey: string; requestTimeoutMs: number; cacheTtlSeconds: number; searchLimit: number; displayLimit: number; searchType: PromptsChatPromptType; smartSearchLimit: number; smartCandidateLimit: number; smartCandidateContentChars: number; translateSearchQuery: boolean; translateResults: boolean; queryRewriteEnabled: boolean; smartNodeIndex: number; smartModel: string; searchQueryPromptTemplate: string; smartPromptTemplate: string; fallbackToRawPrompt: boolean }
export interface CanvasConfig { enabled: boolean; imageNodeIndex: number; imageModel: string; editNodeIndex: number; editModel: string; imageEditRequestMode: ImageEditRequestMode; imageTimeoutMs: number; imageRetryCount: number; imageRetryDelayMs: number; defaultQuality: CanvasImageQuality; defaultOutputFormat: CanvasOutputFormat; defaultCount: number; defaultSizePresetId: string; defaultStylePresetId: string; interrogateNodeIndex: number; interrogateModel: string; interrogatePromptTemplate: string; interrogateTemplateNodeIndex: number; interrogateTemplateModel: string; interrogateTemplatePromptTemplate: string; interrogateTimeoutMs: number; interrogateTemplateTimeoutMs: number; maxHistory: number; dataDir: string; logs: { enabled: boolean; level: CanvasLogLevel; maxMemoryEntries: number } }
export interface FreeModeConfig { enabled: boolean; nodeIndex: number; model: string; timeoutMs: number; maxInputImages: number; maxReferencedMessages: number; maxOutputImages: number; includeQuotedMessage: boolean; preferEditWhenImagePresent: boolean; plannerPromptTemplate: string }
export type HuggingFaceRequestMode = 'openai-chat' | 'router-chat' | 'legacy-inference' | 'provider-task';
export type HuggingFaceDirection = '-1' | '1';
export interface HuggingFaceModelItem { id: string; code: string; author: string; pipelineTag: string; task: string; provider: string; inference: string; gated: string; private: boolean; downloads: number; likes: number; tags: string[]; lastModified: string; requestMode: HuggingFaceRequestMode }
export interface HuggingFaceConfig { enabled: boolean; useForChat: boolean; token: string; baseUrl: string; hubApiUrl: string; selectedModelId: string; selectedProvider: string; selectedModelCode: string; requestMode: HuggingFaceRequestMode; timeoutMs: number; cacheTtlSeconds: number; cachedAt: string; cacheQueryHash: string; cachedModels: HuggingFaceModelItem[]; filters: { search: string; author: string; pipelineTag: string; tags: string; library: string; inference: string; gated: string; sort: string; direction: HuggingFaceDirection; limit: number; includePrivate: boolean; onlyChatCompatible: boolean; provider: string } }
export type BotTtsProvider = 'fish-audio' | 'openai-compatible';
export type BotTtsFormat = 'mp3' | 'wav' | 'opus';
export type BotTtsLatency = 'normal' | 'balanced' | 'low';
export interface BotTtsPreprocessConfig { enabled: boolean; nodeIndex: number; model: string; timeoutMs: number; delayMs: number; maxOutputChars: number; promptTemplate: string; fallbackToOriginal: boolean }
export interface BotTtsConfig { enabled: boolean; provider: BotTtsProvider; apiUrl: string; apiKey: string; model: string; voiceId: string; voice: string; format: BotTtsFormat; autoTextMaxChars: number; timeoutMs: number; speed: number; volume: number; latency: BotTtsLatency; preprocess: BotTtsPreprocessConfig }
export interface AppConfig { panel: { port: number; passwordSeed: string }; napcat: { wsUrl: string; token: string; mountOutputDir: string; actionTimeoutMs: number; textSendTimeoutMs: number; imageSendTimeoutMs: number; forwardSendTimeoutMs: number; getMessageTimeoutMs: number }; promptsChat: PromptsChatConfig; canvas: CanvasConfig; freeMode: FreeModeConfig; huggingFace: HuggingFaceConfig; llm: { activeNodeIndex: number; apiKeys: ApiNode[]; chatNodeIndex: number; chatModel: string; chatEnabled: boolean; reasoningEffort: ReasoningEffort; autoNewConversation: boolean; maxConversationRounds: number; maxConversationChars: number; enhanceNodeIndex: number; enhanceModel: string; enhanceEnabled: boolean; enhancePromptTemplate: string; templateNodeIndex: number; templateModel: string; templateConvertNodeIndex: number; templateConvertModel: string; templatePromptTemplate: string; templateConvertPromptTemplate: string; templateTitlePromptTemplate: string; referencedTemplateNodeIndex: number; referencedTemplateModel: string; referencedTemplatePromptTemplate: string; referencedTemplateTimeoutMs: number; translationNodeIndex: number; translationModel: string; translationPromptTemplate: string; imageNodeIndex: number; imageModel: string; imageEnabled: boolean; imageCount: number; imageTimeoutMs: number; imageRetryCount: number; imageRetryDelayMs: number; safeRewriteOnFailure: boolean; safeRewritePromptTemplate: string; editNodeIndex: number; editModel: string; imageEditRequestMode: ImageEditRequestMode; interrogateNodeIndex: number; interrogateModel: string; interrogateTimeoutMs: number; interrogatePromptTemplate: string; modelLimits: ModelLimitRule[] }; bot: { botQqId: string; ownerQQs: string[]; whitelistGroups: string[]; whitelistPrivate: string[]; blacklistGroupUsers: string[]; tts: BotTtsConfig; replyFormat: LegacyReplyFormat; replyStrategies: { text: ReplyStrategy; image: ReplyStrategy; multiImage: ReplyStrategy }; triggerModes: { mention: boolean; replyToBot: boolean }; textReply: { maxChars: number; splitDelayMs: number; showPartPrefix: boolean }; autoRecallImages: boolean; autoRecallDelaySeconds: number; imageCompression: { enabled: boolean; scale: number; quality: number; mergedPreviewEnabled: boolean; mergedPreviewScale: number; mergedPreviewQuality: number; mergedPreviewMaxWidth: number }; promptTemplates: PromptTemplate[]; commands: { genImage: string; img2Img: string; editImage: string; interrogate: string; originalImage: string; imageCount: string; referencedTemplateImage: string; templateLibrary: string; help: string; remotePromptSearch: string; remotePromptSmartImage: string; toggleEnhance: string; forceEnhance: string; disableEnhance: string } } }
export interface ExportedConfigFile<TConfig = AppConfig> { version: number; exportedAt: string; config: TConfig }
export interface ConfigMigrationDefinition { id: string; from: string; to: string; reason: string; introducedIn: number }
export interface ConfigImportResult { config: AppConfig; sourceFormat: ConfigSourceFormat; sourceVersion?: number; migrations: MigrationNotice[]; warnings: string[] }
export interface ExportConfigOptions { exportedAt?: string | Date }

type R = Record<string, any>;

const P = {
  enhance: '请把用户原始提示词改写为适合图像生成模型的结构化 JSON。用户原始提示词：{{rawPrompt}}',
  fill: '请把用户提示词自然填入选中的模板，只输出最终提示词。模板：{{templatePrompt}} 用户提示词：{{rawPrompt}}',
  convert: '请把用户粘贴的一段普通提示词转化为可复用模板，并只输出 JSON。用户原始提示词：{{rawPrompt}}',
  title: '请根据下面的提示词模板生成一个简短中文模板名称，只输出名称。模板：{{templatePrompt}}',
  refFill: '请根据用户主体把引用的通用模板填充成最终图像生成提示词，只输出纯文本。用户主体：{{rawPrompt}} 引用模板：{{templatePrompt}}',
  translate: 'Return JSON only. Mode: {{mode}} Input: {{input}}.',
  interrogate: '请分析这张图片，并反推一段适合图像生成模型复现它的提示词。',
  interrogateTpl: '请分析这张图片，并把它反推成可复用的图像生成提示词模板，至少包含一次 {{prompt}}。',
  safe: '请把用户提示词改写为合规、温和、可生成的图片提示词，只输出最终提示词。用户提示词：{{rawPrompt}}',
  pcQuery: 'Return JSON only: {"queries":["query 1","query 2"]}. User request: {{rawPrompt}}',
  pcSmart: 'Return JSON only: {"selectedId":"id or none","selectedTitle":"title or none","reason":"brief Chinese reason","finalPrompt":"ready-to-use image prompt"}. User request: {{rawPrompt}}\n\nCandidate prompts:\n{{candidates}}',
  free: 'Return JSON only. Use {"action":"text","text":"..."} or {"action":"image","mode":"generate|edit","prompt":"...","size":"1024x1024","count":1}. User content: {{userContent}}',
  ttsPreprocess: '你是文本转语音前置处理助手。请把机器人回复翻译/改写成适合语音合成的文本，并按需要穿插语音标签。要求：1. 保留原意，不额外扩写；2. 标签必须是语音模型可直接识别的文本；3. 只输出最终要送入语音 API 的文本，不要解释，不要 Markdown。待处理文本：{{text}}',
};

const DEFAULT_CONFIG: AppConfig = {
  panel: { port: 3018, passwordSeed: 'change-me-on-first-login' },
  napcat: { wsUrl: 'ws://localhost:3001', token: '', mountOutputDir: '', actionTimeoutMs: 15000, textSendTimeoutMs: 15000, imageSendTimeoutMs: 120000, forwardSendTimeoutMs: 300000, getMessageTimeoutMs: 10000 },
  promptsChat: { enabled: false, endpoint: '', apiKey: '', requestTimeoutMs: 20000, cacheTtlSeconds: 600, searchLimit: 20, displayLimit: 5, searchType: '', smartSearchLimit: 24, smartCandidateLimit: 6, smartCandidateContentChars: 1800, translateSearchQuery: true, translateResults: true, queryRewriteEnabled: true, smartNodeIndex: 0, smartModel: 'gpt-4o-mini', searchQueryPromptTemplate: P.pcQuery, smartPromptTemplate: P.pcSmart, fallbackToRawPrompt: true },
  canvas: { enabled: true, imageNodeIndex: 0, imageModel: 'gpt-image-2', editNodeIndex: 0, editModel: 'gpt-image-2', imageEditRequestMode: 'auto', imageTimeoutMs: 300000, imageRetryCount: 1, imageRetryDelayMs: 2500, defaultQuality: 'auto', defaultOutputFormat: 'png', defaultCount: 1, defaultSizePresetId: 'square-1k', defaultStylePresetId: 'none', interrogateNodeIndex: 0, interrogateModel: 'gpt-4o-mini', interrogatePromptTemplate: P.interrogate, interrogateTemplateNodeIndex: 0, interrogateTemplateModel: 'gpt-4o-mini', interrogateTemplatePromptTemplate: P.interrogateTpl, interrogateTimeoutMs: 300000, interrogateTemplateTimeoutMs: 300000, maxHistory: 50, dataDir: '', logs: { enabled: true, level: 'info', maxMemoryEntries: 1000 } },
  freeMode: { enabled: false, nodeIndex: 0, model: 'gpt-4o-mini', timeoutMs: 120000, maxInputImages: 6, maxReferencedMessages: 20, maxOutputImages: 4, includeQuotedMessage: true, preferEditWhenImagePresent: true, plannerPromptTemplate: P.free },
  huggingFace: { enabled: false, useForChat: false, token: '', baseUrl: 'https://router.huggingface.co/v1', hubApiUrl: 'https://huggingface.co/api/models', selectedModelId: '', selectedProvider: '', selectedModelCode: '', requestMode: 'openai-chat', timeoutMs: 120000, cacheTtlSeconds: 3600, cachedAt: '', cacheQueryHash: '', cachedModels: [], filters: { search: '', author: '', pipelineTag: 'text-generation', tags: '', library: '', inference: 'warm', gated: 'false', sort: 'downloads', direction: '-1', limit: 50, includePrivate: true, onlyChatCompatible: true, provider: '' } },
  llm: { activeNodeIndex: 0, apiKeys: [{ name: '默认节点', baseUrl: '', key: '', enabled: true, models: [], modelsFetchedAt: '' }], chatNodeIndex: 0, chatModel: 'gpt-4o-mini', chatEnabled: true, reasoningEffort: 'high', autoNewConversation: true, maxConversationRounds: 8, maxConversationChars: 12000, enhanceNodeIndex: 0, enhanceModel: 'claude-3-5-sonnet-20240620', enhanceEnabled: false, enhancePromptTemplate: P.enhance, templateNodeIndex: 0, templateModel: 'gpt-4o-mini', templateConvertNodeIndex: 0, templateConvertModel: 'gpt-4o-mini', templatePromptTemplate: P.fill, templateConvertPromptTemplate: P.convert, templateTitlePromptTemplate: P.title, referencedTemplateNodeIndex: 0, referencedTemplateModel: 'gpt-4o-mini', referencedTemplatePromptTemplate: P.refFill, referencedTemplateTimeoutMs: 300000, translationNodeIndex: 0, translationModel: 'gpt-4o-mini', translationPromptTemplate: P.translate, imageNodeIndex: 0, imageModel: 'gpt-image-2', imageEnabled: true, imageCount: 1, imageTimeoutMs: 300000, imageRetryCount: 1, imageRetryDelayMs: 2500, safeRewriteOnFailure: true, safeRewritePromptTemplate: P.safe, editNodeIndex: 0, editModel: 'gpt-image-2', imageEditRequestMode: 'auto', interrogateNodeIndex: 0, interrogateModel: 'gpt-4o-mini', interrogateTimeoutMs: 300000, interrogatePromptTemplate: P.interrogate, modelLimits: [] },
  bot: { botQqId: '', ownerQQs: [], whitelistGroups: [], whitelistPrivate: [], blacklistGroupUsers: [], tts: { enabled: false, provider: 'fish-audio', apiUrl: 'https://api.fish.audio/v1/tts', apiKey: '', model: 's2-pro', voiceId: '', voice: 'alloy', format: 'mp3', autoTextMaxChars: 180, timeoutMs: 60000, speed: 1, volume: 0, latency: 'normal', preprocess: { enabled: false, nodeIndex: 0, model: 'gpt-4o-mini', timeoutMs: 60000, delayMs: 0, maxOutputChars: 1000, promptTemplate: P.ttsPreprocess, fallbackToOriginal: true } }, replyFormat: 'forward', replyStrategies: { text: 'forward', image: 'forward', multiImage: 'forward' }, triggerModes: { mention: true, replyToBot: true }, textReply: { maxChars: 1800, splitDelayMs: 800, showPartPrefix: true }, autoRecallImages: false, autoRecallDelaySeconds: 60, imageCompression: { enabled: true, scale: 0.65, quality: 82, mergedPreviewEnabled: true, mergedPreviewScale: 0.7, mergedPreviewQuality: 82, mergedPreviewMaxWidth: 1800 }, promptTemplates: [{ id: 'mb_1', title: '通用高质量插画', prompt: '以高质量插画风格生成：{{prompt}}。画面主体明确，构图干净，光影自然，细节丰富。' }, { id: 'mb_2', title: '电影感写实', prompt: 'cinematic realistic photo of {{prompt}}, natural lighting, detailed texture, balanced composition, high quality' }], commands: { genImage: '生图, 画, draw', img2Img: '图生图, 参考图, 垫图, i2i', editImage: '改图, 编辑, edit', interrogate: '反推, 看图, 描述, prompt', originalImage: '原图, original, rawpic', imageCount: 's', referencedTemplateImage: '套模板, 引用模板生图, 模板填充生图, rt', templateLibrary: '本地模板库, 本地模板, 模板库, 模板, mb', help: '/help, help, 帮助, 使用方法', remotePromptSearch: 'pp, 远程模板库, 远程模板', remotePromptSmartImage: 'spp, 远程模板生图, 智能远程模板', toggleEnhance: '润色, enhance', forceEnhance: '润色, enhance', disableEnhance: '原文, raw, 不润色' } },
};

export const CONFIG_MIGRATION_TABLE: ConfigMigrationDefinition[] = [
  { id: 'export-wrapper-v1.config-to-root', from: '$.config', to: '$', reason: '旧后台导出格式导入时解包为裸配置对象。', introducedIn: 2 },
  { id: 'panel.password-to-passwordSeed', from: 'panel.password', to: 'panel.passwordSeed', reason: '统一面板登录种子字段名。', introducedIn: 2 },
  { id: 'napcat.websocketUrl-to-wsUrl', from: 'napcat.websocketUrl', to: 'napcat.wsUrl', reason: '统一 Napcat WebSocket 地址字段名。', introducedIn: 2 },
  { id: 'llm.nodes-to-apiKeys', from: 'llm.nodes', to: 'llm.apiKeys', reason: '兼容通用节点列表命名。', introducedIn: 2 },
  { id: 'llm.apiNodes-to-apiKeys', from: 'llm.apiNodes', to: 'llm.apiKeys', reason: '兼容早期 apiNodes 字段。', introducedIn: 2 },
  { id: 'llm.image-to-canvas.image', from: 'llm.image* / llm.edit*', to: 'canvas.image* / canvas.edit*', reason: 'Backfill canvas image settings from legacy LLM image fields.', introducedIn: 2 },
  { id: 'llm.interrogate-to-canvas.interrogate', from: 'llm.interrogate*', to: 'canvas.interrogate*', reason: '图片反推能力从 LLM 分区迁入 Canvas 分区。', introducedIn: 2 },
  { id: 'bot.replyFormat-to-replyStrategies', from: 'bot.replyFormat', to: 'bot.replyStrategies.{text,image,multiImage}', reason: '全局回复格式升级为分策略回复。', introducedIn: 2 },
  { id: 'bot.groupWhitelist-to-whitelistGroups', from: 'bot.groupWhitelist', to: 'bot.whitelistGroups', reason: '群白名单字段统一命名。', introducedIn: 2 },
  { id: 'bot.privateWhitelist-to-whitelistPrivate', from: 'bot.privateWhitelist', to: 'bot.whitelistPrivate', reason: '私聊白名单字段统一命名。', introducedIn: 2 },
  { id: 'bot.blacklistUsers-to-blacklistGroupUsers', from: 'bot.blacklistUsers', to: 'bot.blacklistGroupUsers', reason: '黑名单字段明确为群用户维度。', introducedIn: 2 },
  { id: 'bot.commands.draw-to-genImage', from: 'bot.commands.draw', to: 'bot.commands.genImage', reason: '显式生图命令归一到 genImage。', introducedIn: 2 },
  { id: 'bot.commands.imageCount-default', from: 'missing bot.commands.imageCount', to: 'bot.commands.imageCount', reason: '补齐多图张数 bang 参数命令入口。', introducedIn: 2 },
];

export function createDefaultConfig(): AppConfig { return clone(DEFAULT_CONFIG); }
export function getDefaultPrompts() { return { enhancePromptTemplate: P.enhance, templatePromptTemplate: P.fill, referencedTemplatePromptTemplate: P.refFill, templateConvertPromptTemplate: P.convert, templateTitlePromptTemplate: P.title, translationPromptTemplate: P.translate, interrogatePromptTemplate: P.interrogate, interrogateTemplatePromptTemplate: P.interrogateTpl, safeRewritePromptTemplate: P.safe, promptsChatSearchQueryPromptTemplate: P.pcQuery, promptsChatSmartPromptTemplate: P.pcSmart, freeModePromptTemplate: P.free, ttsPreprocessPromptTemplate: P.ttsPreprocess }; }
export function normalizeConfig(input: unknown): AppConfig { return importConfig(input).config; }
export function exportConfig(input: unknown, options: ExportConfigOptions = {}): ExportedConfigFile { const exportedAt = options.exportedAt instanceof Date ? options.exportedAt.toISOString() : options.exportedAt || new Date().toISOString(); return { version: CONFIG_SCHEMA_VERSION, exportedAt, config: normalizeConfig(input) }; }

export function importConfig(input: unknown): ConfigImportResult {
  const warnings: string[] = [];
  const migrations: MigrationNotice[] = [];
  let payload: R;
  let sourceFormat: ConfigSourceFormat = 'bare-config';
  let sourceVersion: number | undefined;
  if (!isObj(input)) {
    warnings.push('配置根节点不是对象，已使用默认配置。');
    payload = {}; sourceFormat = 'invalid';
  } else if (isObj(input.config)) {
    sourceVersion = typeof input.version === 'number' ? input.version : undefined;
    sourceFormat = sourceVersion === 1 ? 'export-wrapper-v1' : sourceVersion === CONFIG_SCHEMA_VERSION ? 'export-wrapper-v2' : 'unknown-wrapper';
    payload = clone(input.config); migrations.push(notice('export-wrapper-v1.config-to-root'));
  } else {
    payload = clone(input); sourceVersion = typeof input.version === 'number' ? input.version : undefined;
  }
  applyMigrations(payload, migrations);
  return { config: normalizeAppConfig(payload, warnings), sourceFormat, sourceVersion, migrations: dedupe(migrations), warnings };
}

function applyMigrations(c: R, m: MigrationNotice[]) {
  move(obj(c.panel), 'password', 'passwordSeed', m, 'panel.password-to-passwordSeed');
  move(obj(c.napcat), 'websocketUrl', 'wsUrl', m, 'napcat.websocketUrl-to-wsUrl');
  move(obj(c.llm), 'nodes', 'apiKeys', m, 'llm.nodes-to-apiKeys');
  move(obj(c.llm), 'apiNodes', 'apiKeys', m, 'llm.apiNodes-to-apiKeys');
  const llm = obj(c.llm); const canvas = ensure(c, 'canvas'); let imageChanged = false;
  for (const k of ['imageNodeIndex', 'imageModel', 'editNodeIndex', 'editModel', 'imageEditRequestMode', 'imageTimeoutMs', 'imageRetryCount', 'imageRetryDelayMs']) if (llm[k] !== undefined && canvas[k] === undefined) { canvas[k] = llm[k]; imageChanged = true; }
  if (llm.imageCount !== undefined && canvas.defaultCount === undefined) { canvas.defaultCount = llm.imageCount; imageChanged = true; }
  if (imageChanged) m.push(notice('llm.image-to-canvas.image'));
  let changed = false;
  for (const k of ['interrogateNodeIndex', 'interrogateModel', 'interrogatePromptTemplate', 'interrogateTemplatePromptTemplate', 'interrogateTimeoutMs']) if (llm[k] !== undefined && canvas[k] === undefined) { canvas[k] = llm[k]; changed = true; }
  if (llm.interrogateTimeoutMs !== undefined && canvas.interrogateTemplateTimeoutMs === undefined) { canvas.interrogateTemplateTimeoutMs = llm.interrogateTimeoutMs; changed = true; }
  if (changed) m.push(notice('llm.interrogate-to-canvas.interrogate'));
  const bot = obj(c.bot);
  if (bot.replyFormat !== undefined && bot.replyStrategies === undefined) { bot.replyStrategies = { text: bot.replyFormat, image: bot.replyFormat, multiImage: bot.replyFormat }; m.push(notice('bot.replyFormat-to-replyStrategies')); }
  move(bot, 'groupWhitelist', 'whitelistGroups', m, 'bot.groupWhitelist-to-whitelistGroups');
  move(bot, 'privateWhitelist', 'whitelistPrivate', m, 'bot.privateWhitelist-to-whitelistPrivate');
  move(bot, 'blacklistUsers', 'blacklistGroupUsers', m, 'bot.blacklistUsers-to-blacklistGroupUsers');
  const commands = obj(bot.commands);
  move(commands, 'draw', 'genImage', m, 'bot.commands.draw-to-genImage');
  if (bot.commands && commands.imageCount === undefined) { commands.imageCount = DEFAULT_CONFIG.bot.commands.imageCount; m.push(notice('bot.commands.imageCount-default')); }
}

function normalizeAppConfig(input: R, warnings: string[]): AppConfig {
  const cfg = deepMerge(createDefaultConfig() as unknown as R, input) as unknown as AppConfig;
  const panel = { ...DEFAULT_CONFIG.panel, ...obj((cfg as any).panel) };
  const nap = { ...DEFAULT_CONFIG.napcat, ...obj((cfg as any).napcat) };
  const llm = { ...DEFAULT_CONFIG.llm, ...obj((cfg as any).llm) };
  llm.apiKeys = normNodes(llm.apiKeys, warnings);
  const clampNode = (v: unknown, fb = 0) => clamp(v, fb, 0, Math.max(0, llm.apiKeys.length - 1), true);
  llm.activeNodeIndex = clampNode(llm.activeNodeIndex); llm.chatNodeIndex = clampNode(llm.chatNodeIndex, llm.activeNodeIndex); llm.enhanceNodeIndex = clampNode(llm.enhanceNodeIndex, llm.activeNodeIndex); llm.templateNodeIndex = clampNode(llm.templateNodeIndex, llm.enhanceNodeIndex); llm.templateConvertNodeIndex = clampNode(llm.templateConvertNodeIndex, llm.templateNodeIndex); llm.referencedTemplateNodeIndex = clampNode(llm.referencedTemplateNodeIndex); llm.translationNodeIndex = clampNode(llm.translationNodeIndex, llm.chatNodeIndex); llm.imageNodeIndex = clampNode(llm.imageNodeIndex); llm.editNodeIndex = clampNode(llm.editNodeIndex, llm.imageNodeIndex); llm.interrogateNodeIndex = clampNode(llm.interrogateNodeIndex, llm.chatNodeIndex);
  llm.reasoningEffort = pick(llm.reasoningEffort, ['low', 'medium', 'high', 'xhigh'] as const, DEFAULT_CONFIG.llm.reasoningEffort); llm.imageEditRequestMode = pick(llm.imageEditRequestMode, ['auto', 'json-images', 'json-image', 'multipart'] as const, DEFAULT_CONFIG.llm.imageEditRequestMode); llm.imageCount = clamp(llm.imageCount, 1, 1, 4, true); llm.imageTimeoutMs = clamp(llm.imageTimeoutMs, 300000, 30000); llm.imageRetryCount = clamp(llm.imageRetryCount, 1, 0, 10, true); llm.imageRetryDelayMs = clamp(llm.imageRetryDelayMs, 2500, 0); llm.interrogateTimeoutMs = clamp(llm.interrogateTimeoutMs, 300000, 30000); llm.referencedTemplateTimeoutMs = clamp(llm.referencedTemplateTimeoutMs, 300000, 30000); llm.modelLimits = normModelLimits(llm.modelLimits, clampNode);
  const pc = { ...DEFAULT_CONFIG.promptsChat, ...obj((cfg as any).promptsChat) }; pc.searchType = pick(String(pc.searchType ?? '').toUpperCase(), ['', 'TEXT', 'STRUCTURED', 'IMAGE', 'VIDEO', 'AUDIO'] as const, ''); pc.requestTimeoutMs = clamp(pc.requestTimeoutMs, 20000, 5000); pc.searchLimit = clamp(pc.searchLimit, 20, 1, 50, true); pc.displayLimit = clamp(pc.displayLimit, 5, 1, 10, true); pc.smartSearchLimit = clamp(pc.smartSearchLimit, 24, 3, 50, true); pc.smartCandidateLimit = clamp(pc.smartCandidateLimit, 6, 1, 10, true); pc.smartCandidateContentChars = clamp(pc.smartCandidateContentChars, 1800, 400, 5000, true); pc.smartNodeIndex = clampNode(pc.smartNodeIndex, llm.templateNodeIndex);
  const canvas = { ...DEFAULT_CONFIG.canvas, ...obj((cfg as any).canvas), logs: { ...DEFAULT_CONFIG.canvas.logs, ...obj((cfg as any).canvas?.logs) } }; canvas.imageNodeIndex = clampNode(canvas.imageNodeIndex, llm.imageNodeIndex); canvas.editNodeIndex = clampNode(canvas.editNodeIndex, llm.editNodeIndex); canvas.interrogateNodeIndex = clampNode(canvas.interrogateNodeIndex, llm.interrogateNodeIndex); canvas.interrogateTemplateNodeIndex = clampNode(canvas.interrogateTemplateNodeIndex, canvas.interrogateNodeIndex); canvas.imageEditRequestMode = pick(canvas.imageEditRequestMode, ['auto', 'json-images', 'json-image', 'multipart'] as const, 'auto'); canvas.defaultQuality = imageQuality(canvas.defaultQuality, 'auto'); canvas.defaultOutputFormat = pick(canvas.defaultOutputFormat, ['png', 'jpeg', 'webp'] as const, 'png'); canvas.defaultCount = pick(num(canvas.defaultCount), [1, 2, 4, 8, 16] as const, 1); canvas.imageTimeoutMs = clamp(canvas.imageTimeoutMs, llm.imageTimeoutMs, 30000); canvas.interrogateTimeoutMs = clamp(canvas.interrogateTimeoutMs, llm.interrogateTimeoutMs, 30000); canvas.interrogateTemplateTimeoutMs = clamp(canvas.interrogateTemplateTimeoutMs, canvas.interrogateTimeoutMs, 30000); canvas.logs.level = pick(canvas.logs.level, ['debug', 'info', 'warn', 'error'] as const, 'info'); canvas.logs.maxMemoryEntries = clamp(canvas.logs.maxMemoryEntries, 1000, 100, 5000, true); canvas.maxHistory = clamp(canvas.maxHistory, 50, 1, 500, true); canvas.dataDir = str(canvas.dataDir, '', false).trim();
  const bot = { ...DEFAULT_CONFIG.bot, ...obj((cfg as any).bot), triggerModes: { ...DEFAULT_CONFIG.bot.triggerModes, ...obj((cfg as any).bot?.triggerModes) }, textReply: { ...DEFAULT_CONFIG.bot.textReply, ...obj((cfg as any).bot?.textReply) }, imageCompression: { ...DEFAULT_CONFIG.bot.imageCompression, ...obj((cfg as any).bot?.imageCompression) }, commands: { ...DEFAULT_CONFIG.bot.commands, ...obj((cfg as any).bot?.commands) }, tts: { ...DEFAULT_CONFIG.bot.tts, ...obj((cfg as any).bot?.tts), preprocess: { ...DEFAULT_CONFIG.bot.tts.preprocess, ...obj((cfg as any).bot?.tts?.preprocess) } } };
  const rf = pick(bot.replyFormat, ['at', 'forward', 'quote', 'plain'] as const, 'forward'); bot.replyFormat = (rf === 'plain' ? 'forward' : rf) as LegacyReplyFormat; const rs = obj(bot.replyStrategies); bot.replyStrategies = { text: strategy(rs.text, rf), image: strategy(rs.image, rf), multiImage: strategy(rs.multiImage, strategy(rs.image, rf)) }; bot.botQqId = str(bot.botQqId, '', false).trim(); bot.ownerQQs = list(bot.ownerQQs); bot.whitelistGroups = list(bot.whitelistGroups); bot.whitelistPrivate = list(bot.whitelistPrivate); bot.blacklistGroupUsers = list(bot.blacklistGroupUsers); bot.tts.enabled = bool(bot.tts.enabled, false); bot.tts.provider = pick(bot.tts.provider, ['fish-audio', 'openai-compatible'] as const, 'fish-audio'); bot.tts.apiUrl = str(bot.tts.apiUrl, DEFAULT_CONFIG.bot.tts.apiUrl, false).trim(); bot.tts.apiKey = str(bot.tts.apiKey, '', false).trim(); bot.tts.model = str(bot.tts.model, bot.tts.provider === 'fish-audio' ? 's2-pro' : 'tts-1', false).trim(); bot.tts.voiceId = str(bot.tts.voiceId, '', false).trim(); bot.tts.voice = str(bot.tts.voice, 'alloy', false).trim(); bot.tts.format = pick(String(bot.tts.format || '').toLowerCase(), ['mp3', 'wav', 'opus'] as const, 'mp3'); bot.tts.autoTextMaxChars = clamp(bot.tts.autoTextMaxChars, 180, 1, 4000, true); bot.tts.timeoutMs = clamp(bot.tts.timeoutMs, 60000, 5000, 300000, true); bot.tts.speed = clamp(bot.tts.speed, 1, 0.5, 2); bot.tts.volume = clamp(bot.tts.volume, 0, -20, 20); bot.tts.latency = pick(bot.tts.latency, ['normal', 'balanced', 'low'] as const, 'normal'); bot.tts.preprocess = { ...DEFAULT_CONFIG.bot.tts.preprocess, ...obj(bot.tts.preprocess) }; bot.tts.preprocess.enabled = bool(bot.tts.preprocess.enabled, false); bot.tts.preprocess.nodeIndex = clampNode(bot.tts.preprocess.nodeIndex, llm.chatNodeIndex); bot.tts.preprocess.model = str(bot.tts.preprocess.model, llm.chatModel || 'gpt-4o-mini', false).trim(); bot.tts.preprocess.timeoutMs = clamp(bot.tts.preprocess.timeoutMs, 60000, 5000, 300000, true); bot.tts.preprocess.delayMs = clamp(bot.tts.preprocess.delayMs, 0, 0, 30000, true); bot.tts.preprocess.maxOutputChars = clamp(bot.tts.preprocess.maxOutputChars, 1000, 1, 8000, true); bot.tts.preprocess.promptTemplate = str(bot.tts.preprocess.promptTemplate, P.ttsPreprocess, false); bot.tts.preprocess.fallbackToOriginal = bool(bot.tts.preprocess.fallbackToOriginal, true); bot.textReply.maxChars = clamp(bot.textReply.maxChars, 1800, 0, 20000, true); bot.textReply.splitDelayMs = clamp(bot.textReply.splitDelayMs, 800, 0, 10000, true); bot.autoRecallDelaySeconds = clamp(bot.autoRecallDelaySeconds, 60, 1, undefined, true); bot.imageCompression.scale = clamp(bot.imageCompression.scale, 0.65, 0.1, 1); bot.imageCompression.quality = clamp(bot.imageCompression.quality, 82, 1, 100, true); bot.imageCompression.mergedPreviewScale = clamp(bot.imageCompression.mergedPreviewScale, 0.7, 0.1, 1); bot.imageCompression.mergedPreviewQuality = clamp(bot.imageCompression.mergedPreviewQuality, 82, 1, 100, true); bot.imageCompression.mergedPreviewMaxWidth = clamp(bot.imageCompression.mergedPreviewMaxWidth, 1800, 512, undefined, true); bot.promptTemplates = normTemplates(bot.promptTemplates); const botCommands = bot.commands as Record<string, string>; for (const k of Object.keys(botCommands)) botCommands[k] = aliases(botCommands[k], (DEFAULT_CONFIG.bot.commands as any)[k] ?? '');
  const hf = { ...DEFAULT_CONFIG.huggingFace, ...obj((cfg as any).huggingFace), filters: { ...DEFAULT_CONFIG.huggingFace.filters, ...obj((cfg as any).huggingFace?.filters) } };
  hf.enabled = bool(hf.enabled, false); hf.useForChat = bool(hf.useForChat, false); hf.token = str(hf.token, '', false).trim(); hf.baseUrl = cleanupApiBaseUrl(str(hf.baseUrl, DEFAULT_CONFIG.huggingFace.baseUrl, false)); hf.hubApiUrl = cleanupHubApiUrl(str(hf.hubApiUrl, DEFAULT_CONFIG.huggingFace.hubApiUrl, false)); hf.selectedModelId = str(hf.selectedModelId, '', false).trim(); hf.selectedProvider = str(hf.selectedProvider, '', false).trim(); hf.selectedModelCode = str(hf.selectedModelCode, '', false).trim(); hf.requestMode = pick(hf.requestMode, ['openai-chat', 'router-chat', 'legacy-inference', 'provider-task'] as const, 'openai-chat'); hf.timeoutMs = clamp(hf.timeoutMs, 120000, 5000, 600000, true); hf.cacheTtlSeconds = clamp(hf.cacheTtlSeconds, 3600, 60, 604800, true); hf.cachedAt = str(hf.cachedAt, '', false).trim(); hf.cacheQueryHash = str(hf.cacheQueryHash, '', false).trim(); hf.cachedModels = normHuggingFaceModels(hf.cachedModels);
  hf.filters.search = str(hf.filters.search, '', false).trim(); hf.filters.author = str(hf.filters.author, '', false).trim(); hf.filters.pipelineTag = str(hf.filters.pipelineTag, 'text-generation', false).trim(); hf.filters.tags = str(hf.filters.tags, '', false).trim(); hf.filters.library = str(hf.filters.library, '', false).trim(); hf.filters.inference = pick(hf.filters.inference, ['', 'warm', 'cold', 'frozen'] as const, 'warm'); hf.filters.gated = pick(hf.filters.gated, ['', 'false', 'true'] as const, 'false'); hf.filters.sort = normalizeHfSort(hf.filters.sort); hf.filters.direction = pick(String(hf.filters.direction), ['-1', '1'] as const, '-1'); hf.filters.limit = clamp(hf.filters.limit, 50, 1, 200, true); hf.filters.includePrivate = bool(hf.filters.includePrivate, true); hf.filters.onlyChatCompatible = bool(hf.filters.onlyChatCompatible, true); hf.filters.provider = str(hf.filters.provider, '', false).trim();
  const free = { ...DEFAULT_CONFIG.freeMode, ...obj((cfg as any).freeMode) }; free.nodeIndex = clampNode(free.nodeIndex, llm.chatNodeIndex); free.timeoutMs = clamp(free.timeoutMs, 120000, 30000); free.maxInputImages = clamp(free.maxInputImages, 6, 0, 12, true); free.maxReferencedMessages = clamp(free.maxReferencedMessages, 20, 0, 80, true); free.maxOutputImages = clamp(free.maxOutputImages, 4, 1, 4, true);
  return { panel: { port: clamp(panel.port, 3018, 1, 65535, true), passwordSeed: str(panel.passwordSeed, 'change-me-on-first-login', false) }, napcat: { wsUrl: str(nap.wsUrl, DEFAULT_CONFIG.napcat.wsUrl), token: str(nap.token, ''), mountOutputDir: str(nap.mountOutputDir, ''), actionTimeoutMs: clamp(nap.actionTimeoutMs, 15000, 3000), textSendTimeoutMs: clamp(nap.textSendTimeoutMs, 15000, 3000), imageSendTimeoutMs: clamp(nap.imageSendTimeoutMs, 120000, 10000), forwardSendTimeoutMs: clamp(nap.forwardSendTimeoutMs, 300000, 10000), getMessageTimeoutMs: clamp(nap.getMessageTimeoutMs, 10000, 3000) }, promptsChat: pc, canvas, freeMode: free, huggingFace: hf, llm, bot };
}

function notice(id: string): MigrationNotice { const r = CONFIG_MIGRATION_TABLE.find(x => x.id === id); return r ? { id: r.id, from: r.from, to: r.to, reason: r.reason } : { id, from: 'unknown', to: 'unknown', reason: '未登记迁移规则。' }; }
function move(o: R, from: string, to: string, m: MigrationNotice[], id: string) { if (o[from] !== undefined && o[to] === undefined) { o[to] = o[from]; m.push(notice(id)); } }
function dedupe(m: MigrationNotice[]) { const seen = new Set<string>(); return m.filter(x => seen.has(x.id) ? false : (seen.add(x.id), true)); }
function isObj(v: unknown): v is R { return !!v && typeof v === 'object' && !Array.isArray(v); }
function obj(v: unknown): R { return isObj(v) ? v : {}; }
function ensure(o: R, k: string): R { if (!isObj(o[k])) o[k] = {}; return o[k]; }
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function deepMerge(a: R, b: R): R { const r: R = { ...a }; for (const [k, v] of Object.entries(b)) r[k] = isObj(v) && isObj(r[k]) ? deepMerge(r[k], v) : v; return r; }
function num(v: unknown): number | undefined { if (v === undefined || v === null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function clamp(v: unknown, fb: number, min?: number, max?: number, int = false): number { let n = num(v) ?? fb; if (int) n = Math.trunc(n); if (min !== undefined) n = Math.max(min, n); if (max !== undefined) n = Math.min(max, n); return n; }
function str(v: unknown, fb: string, trim = true): string { if (v === undefined || v === null) return fb; const s = String(v); const out = trim ? s.trim() : s; return out || fb; }
function bool(v: unknown, fb: boolean): boolean { if (typeof v === 'boolean') return v; if (typeof v === 'number' && Number.isFinite(v)) return v !== 0; if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (['true', '1', 'yes', 'on'].includes(s)) return true; if (['false', '0', 'no', 'off'].includes(s)) return false; } return fb; }
function pick<const T extends readonly (string | number)[]>(v: unknown, allowed: T, fb: T[number]): T[number] { return (allowed as readonly unknown[]).includes(v) ? v as T[number] : fb; }
function list(v: unknown): string[] { const src = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\uFF0C\u3001\uFF1B;\n]+/) : []; const seen = new Set<string>(); const out: string[] = []; for (const x of src) { const s = String(x ?? '').trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } } return out; }
function aliases(v: unknown, fb: string): string { const raw = Array.isArray(v) ? v : String(v ?? fb).split(/[,\uFF0C\u3001\uFF1B;\n]+/); const def = String(fb).split(/[,\uFF0C\u3001\uFF1B;\n]+/); const seen = new Set<string>(); const out: string[] = []; for (const x of [...raw, ...def]) { const s = String(x ?? '').replace(/\s+/g, ' ').trim(); const key = s.toLowerCase(); if (s && !seen.has(key)) { seen.add(key); out.push(s); } } return out.join(', '); }
function strategy(v: unknown, fb: ReplyStrategy): ReplyStrategy { return pick(v, ['at', 'forward', 'quote', 'plain'] as const, fb); }
function imageQuality(v: unknown, fb: CanvasImageQuality): CanvasImageQuality { const s = String(v ?? '').trim().toLowerCase(); return pick(s === 'hd' ? 'high' : s, ['auto', 'low', 'medium', 'high'] as const, fb); }
function normalizeHfSort(v: unknown): string {
  const raw = String(v ?? '').trim();
  const mapped = ({ last_modified: 'lastModified', created_at: 'createdAt', trending_score: 'trendingScore' } as Record<string, string>)[raw] || raw;
  return pick(mapped, ['downloads', 'likes', 'lastModified', 'createdAt', 'trendingScore'] as const, 'downloads');
}
function normNodes(v: unknown, warnings: string[]): ApiNode[] { const src = Array.isArray(v) ? v : DEFAULT_CONFIG.llm.apiKeys; const out = src.filter(isObj).map((n, i) => { const credentials = normalizeApiNodeCredentials(str(n.baseUrl, ''), str(n.key, '')); return { name: str(n.name, `节点 ${i + 1}`, false), baseUrl: credentials.baseUrl, key: credentials.key, enabled: bool(n.enabled, true), models: list(n.models), modelsFetchedAt: str(n.modelsFetchedAt, '') }; }); if (!out.length) { warnings.push('llm.apiKeys 为空或格式错误，已补入默认节点。'); return clone(DEFAULT_CONFIG.llm.apiKeys); } return out; }
function normModelLimits(v: unknown, clampNode: (v: unknown, fb?: number) => number): ModelLimitRule[] { return Array.isArray(v) ? v.filter(isObj).map(r => ({ nodeIndex: clampNode(r.nodeIndex), model: str(r.model, ''), enabled: bool(r.enabled, false), concurrency: clamp(r.concurrency, 0, 0, undefined, true) })).filter(r => r.model) : []; }
function normTemplates(v: unknown): PromptTemplate[] { const src = Array.isArray(v) ? v : DEFAULT_CONFIG.bot.promptTemplates; return src.filter(isObj).map((t, i) => ({ id: str(t.id, `mb_${i + 1}`), title: str(t.title, `模板 ${i + 1}`, false), prompt: str(t.prompt, '', false) })).filter(t => t.prompt); }

function normHuggingFaceModels(v: unknown): HuggingFaceModelItem[] {
  const src = Array.isArray(v) ? v : [];
  return src.filter(isObj).map((m, i) => ({
    id: str(m.id, '', false).trim(),
    code: str(m.code, `hf.${i + 1}`, false).trim(),
    author: str(m.author, '', false).trim(),
    pipelineTag: str(m.pipelineTag ?? m.pipeline_tag, '', false).trim(),
    task: str(m.task, '', false).trim(),
    provider: str(m.provider, '', false).trim(),
    inference: str(m.inference, '', false).trim(),
    gated: str(m.gated, '', false).trim(),
    private: bool(m.private, false),
    downloads: clamp(m.downloads, 0, 0, undefined, true),
    likes: clamp(m.likes, 0, 0, undefined, true),
    tags: list(m.tags),
    lastModified: str(m.lastModified ?? m.last_modified, '', false).trim(),
    requestMode: pick(m.requestMode, ['openai-chat', 'router-chat', 'legacy-inference', 'provider-task'] as const, 'openai-chat'),
  })).filter(m => m.id);
}

function normalizeApiNodeCredentials(baseUrlInput: string, keyInput: string): { baseUrl: string; key: string } {
  const rawBase = String(baseUrlInput || '').trim();
  const rawKey = String(keyInput || '').trim();
  const combined = `${rawBase} ${rawKey}`.trim();
  const match = combined.match(/(https?:\/\/[^\s，,；;]+?)(?:\s*[-—–]\s*|\s+)?(?:密钥|key|api[_\s-]*key|token)[:：=\s-]*(sk-[A-Za-z0-9._-]+)/i);
  let baseUrl = match ? match[1] : rawBase;
  let key = rawKey || (match ? match[2] : '');
  baseUrl = cleanupApiBaseUrl(baseUrl);
  key = key.replace(/^[\s:：=,-]+|[\s,，;；]+$/g, '');
  return { baseUrl, key };
}

function cleanupHubApiUrl(value: string): string {
  const out = String(value || '').trim().replace(/[\s,;\uFF0C\uFF1B]+$/g, '').replace(/\/+$/, '');
  return out || DEFAULT_CONFIG.huggingFace.hubApiUrl;
}

function cleanupApiBaseUrl(value: string): string {
  let out = String(value || '').trim().replace(/[\s,，;；]+$/g, '');
  out = out.replace(/\/(?:chat\/completions|images\/generations|images\/edits|models)$/i, '');
  out = out.replace(/\/+$/, '');
  return out;
}

