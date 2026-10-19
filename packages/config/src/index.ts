import type { ConfigSourceFormat, LegacyReplyFormat, MigrationNotice, PackageDescriptor, ReplyStrategy } from '@miobot-v2/shared';
import { defaultFeatureSettings, normalizeFeatureSettings, type FeatureSettings } from '../../shared/src/features.js';

export const CONFIG_PACKAGE: PackageDescriptor = { name: '@miobot-v2/config', phase: 'P12-config-regression' };
export const CONFIG_SCHEMA_VERSION = 2;
export const LEGACY_EXPORT_VERSION = 1;

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type PromptsChatPromptType = '' | 'TEXT' | 'STRUCTURED' | 'IMAGE' | 'VIDEO' | 'AUDIO';
export type ImageEditRequestMode = 'auto' | 'json-images' | 'json-image' | 'multipart';
export type CanvasImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type CanvasOutputFormat = 'png' | 'jpeg' | 'webp';
export type CanvasLogLevel = 'debug' | 'info' | 'warn' | 'error';
/** 画布前台没有登录态，这里决定谁能调它的生图接口（会直接消耗上游额度）。 */
export type CanvasAccessMode = 'public' | 'local-only' | 'admin';

/** concurrency: 该节点同时在跑的请求上限；0 = 不限制。上游额度是按 key 发的，所以限流的单位是节点而不是模型。 */
export interface ComfyUiParamConstraint { type?: 'number' | 'string' | 'boolean'; min?: number; max?: number; enum?: string[] }
export interface ComfyUiStitchConfig { enabled?: boolean; quality?: number; columns?: number; gap?: number; label?: boolean; scale?: number; maxWidth?: number; maxHeight?: number; background?: string }
export type ComfyUiModelFamily = 'moss-image' | 'krea-2' | 'z-image' | 'sdxl' | 'flux' | 'sd15' | 'generic';
export type ComfyUiPromptSyntax = 'natural' | 'a1111' | 'sdxl' | 'moss' | 'krea';
export type ComfyUiPromptFormat = 'caption' | 'tags' | 'layout';
export type ComfyUiVariant = 'base' | 'sft' | 'raw' | 'turbo' | 'unknown';
export interface ComfyUiPromptPolicy {
  modelFamily: ComfyUiModelFamily;
  variant: ComfyUiVariant;
  promptSyntax: ComfyUiPromptSyntax;
  language: 'en' | 'zh' | 'auto';
  preferredFormat: ComfyUiPromptFormat;
  supportsWeights: boolean;
  supportsNegativePrompt: boolean;
  supportsBreak: boolean;
  supportsEmbeddings: boolean;
  supportsDynamicPrompts: boolean;
  supportsLoraTags: boolean;
  maxPromptChars: number;
  maxWeights: number;
  weightMin: number;
  weightMax: number;
  defaultNegativePrompt: string;
  loraTriggers: string[];
}
export interface ComfyUiLoraOption {
  id: string;
  file: string;
  description?: string;
  triggers?: string[];
  defaultStrength?: number;
  minStrength?: number;
  maxStrength?: number;
}
export interface ComfyUiLoraConfig {
  /** workflow 里 LoraLoaderModelOnly 的节点 ID。 */
  nodeId: string;
  /** 去掉 LoRA 时，把该节点输出替换成的上游模型连接，例如 ["1", 0]。 */
  baseModel?: [string, number];
  catalog: ComfyUiLoraOption[];
}
export interface ComfyUiProfile {
  id: string;
  name: string;
  workflow: Record<string, unknown>;
  parameterMap: Record<string, string>;
  defaults: Record<string, unknown>;
  constraints?: Record<string, ComfyUiParamConstraint>;
  outputNodeId?: string;
  stitch?: ComfyUiStitchConfig;
  promptPolicy?: ComfyUiPromptPolicy;
  transform?: Partial<ComfyUiTransformConfig>;
  /** 可选 LoRA 目录；由提示词转化模型选择是否启用及强度。 */
  lora?: ComfyUiLoraConfig;
}
export interface ComfyUiNodeConfig { profiles: ComfyUiProfile[]; pollTimeoutMs: number; pollIntervalMs: number; maxBatchSize: number; maxConcurrent: number; maxQueue: number; queueTimeoutMs: number }
export interface ComfyUiTransformConfig { enabled: boolean; nodeIndex: number; model: string; timeoutMs: number; maxTokens: number; promptTemplate: string }

export interface ApiNode { name: string; baseUrl: string; key: string; enabled: boolean; models: string[]; modelsFetchedAt: string; provider?: string; kind?: 'llm' | 'comfyui'; comfyui?: ComfyUiNodeConfig; headers?: Record<string, string>; concurrency: number }
/** 用户覆盖模型能力(配置层):把模型名/正则映射到自定义 operations,用于补 vision 等能力。 */
export interface ConfigCapabilityOverride { model: string; operations?: string[] }
export interface PromptTemplate { id: string; title: string; prompt: string }
export interface PromptsChatConfig { enabled: boolean; endpoint: string; apiKey: string; requestTimeoutMs: number; cacheTtlSeconds: number; searchLimit: number; displayLimit: number; searchType: PromptsChatPromptType; smartSearchLimit: number; smartCandidateLimit: number; smartCandidateContentChars: number; queryRewriteEnabled: boolean; smartNodeIndex: number; smartModel: string; searchQueryPromptTemplate: string; smartPromptTemplate: string; fallbackToRawPrompt: boolean }
export interface CanvasBrandConfig { logoText: string; pageTitle: string; faviconUrl: string }
export interface CanvasConfig { enabled: boolean; access: CanvasAccessMode; /** 每来源每分钟生成次数上限；0 表示不限制。 */ rateLimitPerMinute: number; imageNodeIndex: number; imageModel: string; editNodeIndex: number; editModel: string; imageEditRequestMode: ImageEditRequestMode; imageTimeoutMs: number; imageRetryCount: number; imageRetryDelayMs: number; defaultQuality: CanvasImageQuality; defaultOutputFormat: CanvasOutputFormat; defaultCount: number; defaultSizePresetId: string; defaultStylePresetId: string; interrogateNodeIndex: number; interrogateModel: string; interrogatePromptTemplate: string; interrogateTemplateNodeIndex: number; interrogateTemplateModel: string; interrogateTemplatePromptTemplate: string; interrogateTimeoutMs: number; interrogateTemplateTimeoutMs: number; maxHistory: number; brand: CanvasBrandConfig; logs: { enabled: boolean; level: CanvasLogLevel; maxMemoryEntries: number } }
export interface FreeModeConfig { enabled: boolean; nodeIndex: number; model: string; timeoutMs: number; maxInputImages: number; maxOutputImages: number; includeQuotedMessage: boolean; preferEditWhenImagePresent: boolean; plannerPromptTemplate: string }
export type HuggingFaceRequestMode = 'openai-chat' | 'router-chat' | 'legacy-inference' | 'provider-task';
export type HuggingFaceDirection = '-1' | '1';
export interface HuggingFaceModelItem { id: string; code: string; author: string; pipelineTag: string; task: string; provider: string; inference: string; gated: string; private: boolean; downloads: number; likes: number; tags: string[]; lastModified: string; requestMode: HuggingFaceRequestMode }
export interface HuggingFaceConfig { enabled: boolean; useForChat: boolean; token: string; baseUrl: string; hubApiUrl: string; selectedModelId: string; selectedProvider: string; selectedModelCode: string; requestMode: HuggingFaceRequestMode; timeoutMs: number; cacheTtlSeconds: number; cachedAt: string; cacheQueryHash: string; cachedModels: HuggingFaceModelItem[]; filters: { search: string; author: string; pipelineTag: string; tags: string; library: string; inference: string; gated: string; sort: string; direction: HuggingFaceDirection; limit: number; onlyChatCompatible: boolean; provider: string } }
export type BotTtsProvider = 'fish-audio' | 'openai-compatible';
export type BotTtsFormat = 'mp3' | 'wav' | 'opus';
export type BotTtsLatency = 'normal' | 'balanced' | 'low';
export interface BotTtsPreprocessConfig { enabled: boolean; nodeIndex: number; model: string; timeoutMs: number; delayMs: number; maxOutputChars: number; promptTemplate: string; fallbackToOriginal: boolean }
export interface BotTtsConfig { enabled: boolean; provider: BotTtsProvider; apiUrl: string; apiKey: string; model: string; voiceId: string; voiceIds: string[]; voice: string; format: BotTtsFormat; autoTextMaxChars: number; timeoutMs: number; speed: number; volume: number; latency: BotTtsLatency; preprocess: BotTtsPreprocessConfig }
/** 群聊上下文配置：@bot 时自动拉取最近群聊记录作为上下文注入 chat 模型。 */
export interface BotGroupContextConfig { enabled: boolean; messageCount: number; skipForward: boolean; includeImages: boolean; maxChars: number }
export interface BotProgressConfig {
  enabled: boolean;
  imageText: string;
  editText: string;
  interrogateText: string;
  videoText: string;
  showEta: boolean;
}

export interface BotTextImageConfig {
  enabled: boolean;
  width: number;
  minHeight: number;
  maxHeight: number;
  padding: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  background: string;
  foreground: string;
  accent: string;
  quality: number;
  maxChars: number;
}

export interface BotFilesConfig {
  enabled: boolean;
  indexTtlMinutes: number;
  maxIndexPerChat: number;
  maxFileSizeMB: number;
  maxTextChars: number;
  maxPdfPages: number;
  maxSpreadsheetRows: number;
  maxSlideCount: number;
  maxArchiveEntries: number;
  maxArchiveUncompressedMB: number;
}
export type WebSearchProvider = 'deepseek' | 'tavily' | 'brave' | 'serper' | 'bing' | 'google' | 'searxng' | 'exa';
export type WebSearchAutoMode = 'off' | 'auto' | 'always';
export type WebSearchFetchProvider = 'provider' | 'deepseek' | 'jina' | 'none';
export interface IntentRecognitionConfig { enabled: boolean; nodeIndex: number; model: string; timeoutMs: number; minConfidence: number; promptTemplate: string }

export interface BrowserRenderConfig {
  enabled: boolean;
  executablePath: string;
  noSandbox: boolean;
  enableWebgl: boolean;
  timeoutMs: number;
  launchTimeoutMs: number;
  idleCloseMs: number;
  maxConcurrency: number;
  maxQueue: number;
  maxCodeChars: number;
  maxWidth: number;
  maxHeight: number;
  defaultWidth: number;
  defaultHeight: number;
  maxScreenshotBytes: number;
  allowPrivateHosts: boolean;
}
export interface CodeRenderConfig { enabled: boolean; nodeIndex: number; model: string; timeoutMs: number; maxTokens: number; promptTemplate: string }

export interface WebSearchConfig {
  enabled: boolean;
  provider: WebSearchProvider;
  apiUrl: string;
  apiKey: string;
  googleCx: string;
  language: string;
  region: string;
  localization: string;
  autoMode: WebSearchAutoMode;
  maxResults: number;
  needContent: boolean;
  fetchContent: boolean;
  fetchProvider: WebSearchFetchProvider;
  jinaBaseUrl: string;
  jinaApiKey: string;
  timeoutMs: number;
  retryCount: number;
  cacheTtlSeconds: number;
  maxContentChars: number;
  maxTotalChars: number;
  qps: number;
}

export interface AppConfig { panel: { port: number; passwordSeed: string }; napcat: { wsUrl: string; token: string; actionTimeoutMs: number; textSendTimeoutMs: number; imageSendTimeoutMs: number; fileSendTimeoutMs: number; fileSendRetryCount: number; fileSendRetryDelayMs: number; forwardSendTimeoutMs: number; getMessageTimeoutMs: number }; promptsChat: PromptsChatConfig; canvas: CanvasConfig; freeMode: FreeModeConfig; intentRecognition: IntentRecognitionConfig; browserRender: BrowserRenderConfig; codeRender: CodeRenderConfig; comfyuiTransform: ComfyUiTransformConfig; huggingFace: HuggingFaceConfig; search: WebSearchConfig; llm: { activeNodeIndex: number; apiKeys: ApiNode[]; chatNodeIndex: number; chatModel: string; chatEnabled: boolean; reasoningEffort: ReasoningEffort; maxConversationRounds: number; maxConversationChars: number; sessionTtlMinutes: number; enhanceNodeIndex: number; enhanceModel: string; enhanceEnabled: boolean; enhancePromptTemplate: string; templateNodeIndex: number; templateModel: string; referencedTemplateNodeIndex: number; referencedTemplateModel: string; translationNodeIndex: number; translationModel: string; imageNodeIndex: number; imageModel: string; imageEnabled: boolean; imageCount: number; imageTimeoutMs: number; imageRetryCount: number; imageRetryDelayMs: number; safeRewriteOnFailure: boolean; safeRewritePromptTemplate: string; editNodeIndex: number; editModel: string; imageEditRequestMode: ImageEditRequestMode; interrogateNodeIndex: number; interrogateModel: string; interrogateTimeoutMs: number; interrogatePromptTemplate: string; /** 视频生成节点索引（grok-imagine-video 等）。 */ videoNodeIndex: number; videoModel: string; videoEnabled: boolean; /** 单次视频 HTTP 超时。 */ videoTimeoutMs: number; /** 异步轮询总等待上限（默认 10 分钟）。 */ videoPollTimeoutMs: number; /** 轮询间隔（默认 5 秒）。 */ videoPollIntervalMs: number; capabilityOverrides: ConfigCapabilityOverride[] }; bot: { botQqId: string; ownerQQs: string[]; whitelistGroups: string[]; whitelistPrivate: string[]; blacklistGroupUsers: string[]; features: FeatureSettings; files: BotFilesConfig; tts: BotTtsConfig; replyFormat: LegacyReplyFormat; replyStrategies: { text: ReplyStrategy; image: ReplyStrategy; multiImage: ReplyStrategy; video: ReplyStrategy; multiVideo: ReplyStrategy; file: ReplyStrategy; multiFile: ReplyStrategy; mixed: ReplyStrategy }; triggerModes: { mention: boolean; replyToBot: boolean }; /** 消息事件超过此秒数直接丢弃不回复（0=不限），避免积压/重连后迟到回复扎堆。 */ staleMessageMaxAgeSeconds: number; groupContext: BotGroupContextConfig; textReply: { maxChars: number; splitDelayMs: number; showPartPrefix: boolean }; progress: BotProgressConfig; textImage: BotTextImageConfig; autoRecallImages: boolean; autoRecallDelaySeconds: number; imageCompression: { enabled: boolean; scale: number; quality: number; }; promptTemplates: PromptTemplate[]; commands: { genImage: string; img2Img: string; editImage: string; interrogate: string; originalImage: string; imageCount: string; referencedTemplateImage: string; templateLibrary: string; help: string; remotePromptSearch: string; remotePromptSmartImage: string; toggleEnhance: string; forceEnhance: string; disableEnhance: string } } }
export interface ExportedConfigFile<TConfig = AppConfig> { version: number; exportedAt: string; config: TConfig }
export interface ConfigMigrationDefinition { id: string; from: string; to: string; reason: string; introducedIn: number }
export interface ConfigImportResult { config: AppConfig; sourceFormat: ConfigSourceFormat; sourceVersion?: number; migrations: MigrationNotice[]; warnings: string[] }
export interface ExportConfigOptions { exportedAt?: string | Date }

type R = Record<string, any>;

const P = {
  enhance: '请把用户原始提示词改写为适合图像生成模型的结构化 JSON。必须保留用户原始语言；如果原始提示词是中文，最终提示词必须包含中文，不要翻译成英文，除非用户明确要求英文。用户原始提示词：{{rawPrompt}}',
  fill: '请把用户提示词自然填入选中的模板，只输出最终提示词。必须保留用户原始语言；如果用户提示词是中文，最终提示词必须包含中文，不要翻译成英文，除非用户明确要求英文。模板：{{templatePrompt}} 用户提示词：{{rawPrompt}}',
  convert: '请把用户粘贴的一段普通提示词转化为可复用模板，并只输出 JSON。用户原始提示词：{{rawPrompt}}',
  title: '请根据下面的提示词模板生成一个简短中文模板名称，只输出名称。模板：{{templatePrompt}}',
  refFill: '请根据用户主体把引用的通用模板填充成最终图像生成提示词，只输出纯文本。必须保留用户主体的原始语言；如果用户主体是中文，最终提示词必须包含中文，不要翻译成英文，除非用户明确要求英文。用户主体：{{rawPrompt}} 引用模板：{{templatePrompt}}',
  translate: 'Return JSON only. Mode: {{mode}} Input: {{input}}.',
  interrogate: '请分析这张图片，并反推一段适合图像生成模型复现它的提示词。',
  interrogateTpl: '请分析这张图片，并把它反推成可复用的图像生成提示词模板，至少包含一次 {{prompt}}。',
  safe: '请把用户提示词改写为合规、温和、可生成的图片提示词，只输出最终提示词。必须保留用户原始语言；如果用户提示词是中文，最终提示词必须包含中文，不要翻译成英文，除非用户明确要求英文。用户提示词：{{rawPrompt}}',
  pcQuery: 'Return JSON only: {"queries":["query 1","query 2"]}. User request: {{rawPrompt}}',
  pcSmart: 'Return JSON only: {"selectedId":"id or none","selectedTitle":"title or none","reason":"brief Chinese reason","finalPrompt":"ready-to-use image prompt"}. Preserve the user request language in finalPrompt; if the request is Chinese, finalPrompt must contain Chinese and must not be translated into English unless the user explicitly asks for English. User request: {{rawPrompt}}\n\nCandidate prompts:\n{{candidates}}',
  codeRender: '你是代码画图生成器。用户要求用代码画图时，生成一个自包含的 HTML/SVG/Canvas/Three.js 作品。只输出 JSON，不要 Markdown，不要解释：{"format":"html|svg|canvas|three","title":"作品标题","width":1080,"height":1080,"html":"可选 HTML 片段","css":"可选 CSS","js":"可选 JavaScript","svg":"当 format=svg 时的 SVG 源码","sendSource":false}。代码必须自包含，不得访问网络、不得引用 CDN、不得读写本地文件、不能使用 cookie/localStorage。Three.js 使用页面内注入的 THREE 全局变量，不使用 import。canvas/three 请绘制完成后设置 window.__MIOBOT_READY__ = true。用户要求：{{userContent}}',
  comfyuiTransform: `【Miobot-ComfyUI-Transform-v4】你是 Miobot 的 ComfyUI 提示词工程师和生成参数规划器。你的任务不是聊天，而是把用户的自然语言请求转换成可直接提交给已配置 ComfyUI workflow 的严格 JSON。

【本次输入】
用户请求：{{userRequest}}
Profile 名称：{{profileName}}
模型家族：{{modelFamily}}
模型变体：{{variant}}
提示词策略：{{promptPolicy}}
允许参数键：{{parameterKeys}}
允许枚举：{{allowedEnums}}
默认参数：{{defaults}}
参数约束：{{constraints}}
最大批量：{{maxBatchSize}}

【最高优先级】
1. 只输出一个 JSON object，不要 Markdown、代码块、注释、解释。
2. 不要输出 workflow JSON、节点 ID、执行命令或思考过程。
3. 只输出 parameterKeys 中允许的键，不要发明字段。
4. 用户没有指定的参数使用 defaults；用户明确指定时优先，但必须遵守 constraints 和 allowedEnums。
5. width/height 必须保持用户要求的方向，并遵守尺寸约束。
6. 用户没指定 seed 时输出 0；指定时原样输出。
7. 用户没指定数量时 batchSize 为 1；不要为了多出图重复提交。
8. prompt 必须能直接放入工作流文本编码节点。

【提示词结构】
按需组织下列信息，能自然融合就用自然语言，不要机械堆砌：
主体与数量 -> 外观与服装 -> 动作与互动 -> 场景与环境 -> 构图与镜头 -> 光线与色彩 -> 材质与媒介 -> 必要细节。
用户明确要求显示的文字必须用引号括起来，并保持原文，不要翻译、改写或臆造文字。用户没有要求的内容不要大量添加。

【提示词增强、保真与防漂移规则】
把用户请求当作硬约束，增强只负责补齐用户没有说、但画面成立所需的视觉细节；不要重写主题，不要把角色替换成泛化人物。
- 内部按 KEEP / LOCK / BIND / LIMIT / FORBID 做一次自检，不要把这些标记写进最终 prompt。
- 锁定 3 到 7 个最影响画面的特征：主体类型与数量、身份/外观、关键服装或结构、动作、画幅和主体占比、主色与光线、媒介完成度；次要细节不要抢占主体篇幅。
- 主体是第一视觉焦点，背景只承担环境、尺度、氛围和构图支撑；不要把背景细节写得比主体更清楚。
- 细节密度按区域分配：脸部/主体表面、头发/轮廓、服装/物体表面、背景、前景、文字/图形层分别控制；不要全图平均堆细节。
- 简单背景保持 simple / clean / plain / large negative space；不要为了丰富填满纹理、装饰、光斑、花瓣或额外人物。
- 背景语义必须绑定区域：花只在花丛/背景，星光只在天空/光效层，草地只在地面；禁止把背景图案迁移成服装印花、皮肤纹理或头发纹理，除非用户明确要求。
- 用户没有指定构图时，方图默认半身或中景，竖图才优先全身，横图优先环境或远景；不要默认 full-body。
- 用户没有指定镜头时，只选一个清晰镜头，例如 medium shot、upper-body portrait、waist-up、50mm lens；不要同时写多个冲突镜头。
- 用户没有指定风格时，用具体可观察的媒介和造型语言补足，例如 clean cel-shaded anime illustration、detailed line art、soft anime key visual；少用 masterpiece、best quality、8k、ultra detailed、award winning 等空泛质量词。
- 用户没有指定服装时，使用完整、得体、符合场景的日常服装；不得主动添加 C-string、内衣、暴露服装、性化姿势或恋物化描写，也不得将未成年人或幼态角色性化。
- 不要添加用户未要求的额外人物、可读文字、logo、水印、签名、边框、分屏、对话气泡或剧情关系。
- 对脸部、眼睛、手、四肢、牙齿、耳朵等高风险结构，写清可见/不可见范围；不可见部位用构图或负面约束防止自动补全。负面约束只针对真实漂移风险，不要堆叠泛化负面词。
- 提示词出现容易扩散的词，例如 texture、pattern、flower、star、cloud、water、particles 时，必须绑定出现区域、面积和密度，并说明是否接触主体。
- 提交前做一次提示词回放：只看 prompt 能否还原用户要求的主体、数量、服装、动作、画幅和风格；不能则补关键约束，不要继续堆形容词。

【画幅与构图理解】
- 从用户自然语言中的画幅、方向、比例、构图意图进行语义理解，不要依赖固定关键词或固定说法。
- 用户明确指定的方向、比例或尺寸是硬约束；保证 width/height 与最终 prompt 的构图一致。
- 电影感、超清、大片、摄影等词只描述质量、风格或媒介，不得用它们推断横版或竖版。
- 用户没有明确画幅时，根据 defaults 和画面主体自行选择，不要固定成某一方向。
- 如果最终 prompt 与 width/height 冲突，修正 prompt 或参数使其一致。

【模型家族专项：MOSS-Image】
当 modelFamily = moss-image：
- 优先输出一段连贯、具体的英文 caption；标点自然，避免 SD 式重复质量词。
- 如果 preferredFormat = tags，使用标签顺序：Quality -> Score -> Meta -> Year -> Character -> Series -> Artist -> General；标签之间用逗号分隔。
- 支持中文，但默认英文描述；用户要求中文或文字内容本身是中文时保留中文。
- 不支持 prompt 权重语法，禁止输出 (word:1.2)、BREAK、AND、<lora:...> 或编造 embedding。
- 需要换行或精确文字时，可以使用实际换行或 \n；不要编造文字位置。
- negativePrompt 只在 supportsNegativePrompt=true 时输出；默认使用 defaults.negativePrompt，通常为：nsfw, worst quality, bad anatomy, watermark, jpeg artifact。
- MOSS 推荐参数：50 步以上、CFG 约 3.0、shift 约 5.0、Euler、sgm_uniform；具体以 defaults 和 constraints 为准。
- 分辨率使用 1M、1.5M 或 2M 总像素附近，宽高为 16 的正整数倍；不要随意改成非 16 倍数。

【模型家族专项：Z-Image Turbo】
当 modelFamily = z-image：
- 使用自然语言 caption，具体描述主体、动作、场景、构图、光线、材质和风格。
- 不要堆叠 SD 式质量词，不要输出权重、BREAK、AND、<lora:...>；不要默认输出 negativePrompt。
- Z-Image Turbo 工作流通常使用较少采样步数和较低 CFG；以 defaults 和 constraints 为准，不要套用 MOSS 的 50 步参数。
- 目标约 50 到 140 个英文词，通常不超过 180 个英文词；用连贯自然语言，不要写成标签堆砌。
- 必须保留用户指定的角色名、发色、瞳色、服装和动作；增强只补充缺失的外观、材质、姿势、构图、镜头、光线和风格细节。
- 方图默认半身或中景，不要默认全身；竖图才优先考虑全身或 9:16 构图。
- 服装和姿势保持得体，不要添加性化内衣、C-string、暴露服装或恋物化描写。
- 用户要求文字时用引号保留原文。

【模型家族专项：Krea 2】
当 modelFamily = krea-2：
- 使用一段连贯、详细的自然语言 caption，描述主体、动作、可见细节、环境、构图、镜头、光线、媒介和风格。
- 长而具体的自然语言优于标签堆砌；不要写 masterpiece、best quality、8k、ultra detailed 等空泛质量词。
- 用户要求文字时，用引号包住要显示的文字；不要臆造文字。
- 不支持 prompt 权重语法，禁止输出 (word:1.2)、BREAK、AND、<lora:...> 或编造 embedding。
- Krea 2 Turbo：本地 KSampler workflow 固定使用 8 步、CFG 1；如果 workflow 使用官方 CFGGuider/API，则严格按 defaults 和 constraints，不要猜。如果 parameterKeys 包含 mu，默认约 1.15；支持 1K 到 2K 输出。
- Krea 2 Raw：默认约 52 步、CFG 3.5；以 defaults 和 constraints 为准。
- 默认不输出 negativePrompt；只有 supportsNegativePrompt=true 时才允许。
- 不要为了「更精细」擅自提高 steps、CFG 或分辨率。

【其他模型家族】
- sd15/sd2：简洁逗号标签，质量词最多 1 到 2 个，权重谨慎。
- sdxl：完整 prompt；若 parameterKeys 包含 promptG/promptL，则分别输出全局场景与主体细节。
- flux：自然语言长句，具体对象关系和动作；不要堆 SD 质量词，默认不要 negativePrompt。
- 其他模型：严格服从 promptPolicy，不要套用不适用的模板。

【权重规则】
只有 supportsWeights=true 且 promptSyntax 为 a1111 或 sdxl 时才允许权重。
允许：(important detail:1.2)、(silver hair:1.15)、(neon lighting:0.9)。
限制：权重范围使用 promptPolicy.weightMin 到 weightMax；最多 maxWeights 处；不要嵌套；不要包住整段 prompt；不要用 (((word)))；正文不要每个词都加权重。
supportsWeights=false 时，禁止所有权重语法、BREAK、AND、[word] 和 <lora:...>；用词序、具体名词和自然语言强调。
supportsBreak=false 时禁止 BREAK；supportsLoraTags=false 时禁止 LoRA 标签；supportsEmbeddings=false 时禁止写 embedding:name。
supportsDynamicPrompts=false 时禁止 {a|b} 随机语法。

【负向提示词规则】
只有 supportsNegativePrompt=true 时才输出 negativePrompt。默认继承 defaults.negativePrompt，仅补充与画面相关的少量约束，不要写和正向提示词冲突的内容。FLUX 和 Krea 2 Turbo 默认不输出负向提示词。

【参数规则】
- steps、cfg、shift、mu 等可以是小数；width、height、steps、seed、batchSize 使用合法整数。
- sampler、scheduler 只能从 allowedEnums 中选择；没有枚举则使用 defaults。
- 用户说横图时 width > height；竖图时 height > width；方图时相等。
- 用户要求超出范围的参数时收敛到最接近的合法值，不要报错。
- parameterKeys 之外的字段一律省略。

【输出格式】
{
  "prompt": "最终正向提示词",
  "negativePrompt": "最终负向提示词",
  "width": 1024,
  "height": 1024,
  "steps": 20,
  "cfg": 3.5,
  "sampler": "euler",
  "scheduler": "sgm_uniform",
  "seed": 0,
  "batchSize": 1,
  "confidence": 0.92
}
以上仅为字段示例；实际只输出 parameterKeys 允许的键。若 parameterKeys 包含 promptG、promptL、clipLPrompt、t5Prompt，则按相应模型规则增加这些字段；不需要的字段省略。`,
  naturalIntent: '你是 Miobot 的自然语言意图识别器。用户会用普通说话方式提出需求，不需要使用命令格式。请从可用功能中选择一个最合适的 intent，并提取必要参数。只输出 JSON，不要 Markdown，不要解释：{"intent":"功能ID","args":"提取出的用户需求/提示词/查询词","fileType":"md|docx|xlsx|pptx|pdf|txt|csv|json|zip或null","confidence":0到1,"reason":"简短原因"}。如果只是普通聊天、问答、解释、写作但不要求生成文件/图片/视频/搜索，返回 chat。只有用户明确要求生成可下载文件时才返回 file.generate。可用功能：{{intents}}。上下文：{{context}}。用户消息：{{userContent}}',
  free: 'Return JSON only. Use {"action":"text","text":"..."} or {"action":"image","mode":"generate|edit","prompt":"...","size":"1024x1024","count":1} or {"action":"video","prompt":"...","duration":6,"resolution":"720p"}. Use video when the user asks to generate/make a video. Preserve the user content language in image/video prompt; if the user content is Chinese, prompt must contain Chinese and must not be translated into English unless the user explicitly asks for English. User content: {{userContent}}',
  ttsPreprocess: '你是文本转语音前置处理助手。请把机器人回复改写成适合语音合成的文本，并按需要穿插语音标签。要求：1. 保留原意和主要语言，不额外扩写，不要无故翻译成英文；2. 标签必须是语音模型可直接识别的文本；3. 只输出最终要送入语音 API 的文本，不要解释，不要 Markdown。待处理文本：{{text}}',
};

const DEFAULT_CONFIG: AppConfig = {
  panel: { port: 3018, passwordSeed: 'change-me-on-first-login' },
  napcat: { wsUrl: 'ws://localhost:3001', token: '', actionTimeoutMs: 15000, textSendTimeoutMs: 15000, imageSendTimeoutMs: 120000, fileSendTimeoutMs: 300000, fileSendRetryCount: 1, fileSendRetryDelayMs: 1200, forwardSendTimeoutMs: 300000, getMessageTimeoutMs: 10000 },
  promptsChat: { enabled: false, endpoint: '', apiKey: '', requestTimeoutMs: 20000, cacheTtlSeconds: 600, searchLimit: 20, displayLimit: 5, searchType: '', smartSearchLimit: 24, smartCandidateLimit: 6, smartCandidateContentChars: 1800, queryRewriteEnabled: true, smartNodeIndex: 0, smartModel: 'gpt-4o-mini', searchQueryPromptTemplate: P.pcQuery, smartPromptTemplate: P.pcSmart, fallbackToRawPrompt: true },
  canvas: { enabled: true, access: 'public', rateLimitPerMinute: 20, imageNodeIndex: 0, imageModel: 'gpt-image-2', editNodeIndex: 0, editModel: 'gpt-image-2', imageEditRequestMode: 'auto', imageTimeoutMs: 300000, imageRetryCount: 1, imageRetryDelayMs: 2500, defaultQuality: 'auto', defaultOutputFormat: 'png', defaultCount: 1, defaultSizePresetId: 'auto', defaultStylePresetId: 'none', interrogateNodeIndex: 0, interrogateModel: 'gpt-4o-mini', interrogatePromptTemplate: P.interrogate, interrogateTemplateNodeIndex: 0, interrogateTemplateModel: 'gpt-4o-mini', interrogateTemplatePromptTemplate: P.interrogateTpl, interrogateTimeoutMs: 300000, interrogateTemplateTimeoutMs: 300000, maxHistory: 50, brand: { logoText: 'Mio', pageTitle: 'Mio \u56fe\u50cf\u753b\u5e03', faviconUrl: '/canvas/favicon.ico' }, logs: { enabled: true, level: 'info', maxMemoryEntries: 1000 } },
  freeMode: { enabled: false, nodeIndex: 0, model: 'gpt-4o-mini', timeoutMs: 120000, maxInputImages: 6, maxOutputImages: 4, includeQuotedMessage: true, preferEditWhenImagePresent: true, plannerPromptTemplate: P.free },
  intentRecognition: { enabled: true, nodeIndex: 0, model: '', timeoutMs: 12000, minConfidence: 0.65, promptTemplate: P.naturalIntent },
  browserRender: { enabled: true, executablePath: '', noSandbox: true, enableWebgl: true, timeoutMs: 45000, launchTimeoutMs: 20000, idleCloseMs: 60000, maxConcurrency: 1, maxQueue: 3, maxCodeChars: 200000, maxWidth: 4096, maxHeight: 4096, defaultWidth: 1080, defaultHeight: 1080, maxScreenshotBytes: 20971520, allowPrivateHosts: false },
  codeRender: { enabled: true, nodeIndex: 0, model: '', timeoutMs: 30000, maxTokens: 4096, promptTemplate: P.codeRender },
  comfyuiTransform: { enabled: true, nodeIndex: 0, model: '', timeoutMs: 20000, maxTokens: 2400, promptTemplate: P.comfyuiTransform },
  huggingFace: { enabled: false, useForChat: false, token: '', baseUrl: 'https://router.huggingface.co/v1', hubApiUrl: 'https://huggingface.co/api/models', selectedModelId: '', selectedProvider: '', selectedModelCode: '', requestMode: 'openai-chat', timeoutMs: 120000, cacheTtlSeconds: 3600, cachedAt: '', cacheQueryHash: '', cachedModels: [], filters: { search: '', author: '', pipelineTag: 'text-generation', tags: '', library: '', inference: 'warm', gated: 'false', sort: 'downloads', direction: '-1', limit: 50, onlyChatCompatible: true, provider: '' } },
  search: { enabled: true, provider: 'deepseek', apiUrl: 'https://api.deepseek.com', apiKey: '', googleCx: '', language: 'zh-CN', region: '', localization: '', autoMode: 'auto', maxResults: 5, needContent: true, fetchContent: true, fetchProvider: 'provider', jinaBaseUrl: 'https://r.jina.ai', jinaApiKey: '', timeoutMs: 20000, retryCount: 1, cacheTtlSeconds: 300, maxContentChars: 6000, maxTotalChars: 20000, qps: 5 },
  llm: { activeNodeIndex: 0, apiKeys: [{ name: '默认节点', baseUrl: '', key: '', enabled: true, kind: 'llm', models: [], modelsFetchedAt: '', concurrency: 0 }], chatNodeIndex: 0, chatModel: 'gpt-4o-mini', chatEnabled: true, reasoningEffort: 'high', maxConversationRounds: 8, maxConversationChars: 12000, sessionTtlMinutes: 30, enhanceNodeIndex: 0, enhanceModel: 'claude-3-5-sonnet-20240620', enhanceEnabled: false, enhancePromptTemplate: P.enhance, templateNodeIndex: 0, templateModel: 'gpt-4o-mini', referencedTemplateNodeIndex: 0, referencedTemplateModel: 'gpt-4o-mini', translationNodeIndex: 0, translationModel: 'gpt-4o-mini', imageNodeIndex: 0, imageModel: 'gpt-image-2', imageEnabled: true, imageCount: 1, imageTimeoutMs: 300000, imageRetryCount: 1, imageRetryDelayMs: 2500, safeRewriteOnFailure: true, safeRewritePromptTemplate: P.safe, editNodeIndex: 0, editModel: 'gpt-image-2', imageEditRequestMode: 'auto', interrogateNodeIndex: 0, interrogateModel: 'gpt-4o-mini', interrogateTimeoutMs: 300000, interrogatePromptTemplate: P.interrogate, videoNodeIndex: 0, videoModel: 'grok-imagine-video', videoEnabled: true, videoTimeoutMs: 120000, videoPollTimeoutMs: 600000, videoPollIntervalMs: 5000, capabilityOverrides: [] },
  bot: { botQqId: '', ownerQQs: [], whitelistGroups: [], whitelistPrivate: [], blacklistGroupUsers: [], features: defaultFeatureSettings(), files: { enabled: true, indexTtlMinutes: 1440, maxIndexPerChat: 200, maxFileSizeMB: 20, maxTextChars: 100000, maxPdfPages: 50, maxSpreadsheetRows: 200, maxSlideCount: 40, maxArchiveEntries: 500, maxArchiveUncompressedMB: 50 }, tts: { enabled: false, provider: 'fish-audio', apiUrl: 'https://api.fish.audio/v1/tts', apiKey: '', model: '', voiceId: '', voiceIds: [], voice: 'alloy', format: 'mp3', autoTextMaxChars: 180, timeoutMs: 60000, speed: 1, volume: 0, latency: 'normal', preprocess: { enabled: false, nodeIndex: 0, model: 'gpt-4o-mini', timeoutMs: 60000, delayMs: 0, maxOutputChars: 1000, promptTemplate: P.ttsPreprocess, fallbackToOriginal: true } }, replyFormat: 'forward', replyStrategies: { text: 'forward', image: 'forward', multiImage: 'forward', video: 'plain', multiVideo: 'forward', file: 'forward', multiFile: 'forward', mixed: 'forward' }, triggerModes: { mention: true, replyToBot: true }, staleMessageMaxAgeSeconds: 90, groupContext: { enabled: false, messageCount: 30, skipForward: true, includeImages: true, maxChars: 4000 }, textReply: { maxChars: 1800, splitDelayMs: 800, showPartPrefix: true }, progress: { enabled: true, imageText: '收到，正在生成图片{eta}，请稍候…', editText: '收到，正在处理图片{eta}，请稍候…', interrogateText: '收到，正在分析图片{eta}，请稍候…', videoText: '收到，正在生成视频{eta}，请稍候…', showEta: true }, textImage: { enabled: false, width: 1080, minHeight: 240, maxHeight: 4096, padding: 64, fontSize: 32, lineHeight: 1.7, fontFamily: 'Noto Sans CJK SC', background: '#0F172A', foreground: '#E5E7EB', accent: '#38BDF8', quality: 70, maxChars: 4000 }, autoRecallImages: false, autoRecallDelaySeconds: 60, imageCompression: { enabled: true, scale: 0.65, quality: 82, }, promptTemplates: [{ id: 'mb_1', title: '通用高质量插画', prompt: '以高质量插画风格生成：{{prompt}}。画面主体明确，构图干净，光影自然，细节丰富。' }, { id: 'mb_2', title: '电影感写实', prompt: 'cinematic realistic photo of {{prompt}}, natural lighting, detailed texture, balanced composition, high quality' }], commands: { genImage: '生图, 画, draw', img2Img: '图生图, 参考图, 垫图, i2i', editImage: '改图, 编辑, edit', interrogate: '反推, 看图, 描述, prompt', originalImage: '原图, original, rawpic', imageCount: 's', referencedTemplateImage: '套模板, 引用模板生图, 模板填充生图, rt', templateLibrary: '本地模板库, 本地模板, 模板库, 模板, mb', help: '/help, help, 帮助, 使用方法', remotePromptSearch: 'pp, 远程模板库, 远程模板', remotePromptSmartImage: 'spp, 远程模板生图, 智能远程模板', toggleEnhance: '润色, enhance', forceEnhance: '润色, enhance', disableEnhance: '原文, raw, 不润色' } },
};

export const CONFIG_MIGRATION_TABLE: ConfigMigrationDefinition[] = [
  { id: 'export-wrapper-v1.config-to-root', from: '$.config', to: '$', reason: '旧后台导出格式导入时解包为裸配置对象。', introducedIn: 2 },
  { id: 'panel.password-to-passwordSeed', from: 'panel.password', to: 'panel.passwordSeed', reason: '统一面板登录种子字段名。', introducedIn: 2 },
  { id: 'napcat.websocketUrl-to-wsUrl', from: 'napcat.websocketUrl', to: 'napcat.wsUrl', reason: '统一 Napcat WebSocket 地址字段名。', introducedIn: 2 },
  { id: 'llm.nodes-to-apiKeys', from: 'llm.nodes', to: 'llm.apiKeys', reason: '兼容通用节点列表命名。', introducedIn: 2 },
  { id: 'llm.apiNodes-to-apiKeys', from: 'llm.apiNodes', to: 'llm.apiKeys', reason: '兼容早期 apiNodes 字段。', introducedIn: 2 },
  { id: 'llm.modelLimits-to-apiKeys.concurrency', from: 'llm.modelLimits[]', to: 'llm.apiKeys[].concurrency', reason: '并发限制从「节点 + 模型」逐条改为节点级：上游额度按 key 发放，按模型限流没有对应的真实约束。', introducedIn: 2 },
  { id: 'llm.image-to-canvas.image', from: 'llm.image* / llm.edit*', to: 'canvas.image* / canvas.edit*', reason: 'Backfill canvas image settings from legacy LLM image fields.', introducedIn: 2 },
  { id: 'llm.interrogate-to-canvas.interrogate', from: 'llm.interrogate*', to: 'canvas.interrogate*', reason: '图片反推能力从 LLM 分区迁入 Canvas 分区。', introducedIn: 2 },
  { id: 'bot.replyFormat-to-replyStrategies', from: 'bot.replyFormat', to: 'bot.replyStrategies.{text,image,multiImage}', reason: '全局回复格式升级为分策略回复。', introducedIn: 2 },
  { id: 'bot.groupWhitelist-to-whitelistGroups', from: 'bot.groupWhitelist', to: 'bot.whitelistGroups', reason: '群白名单字段统一命名。', introducedIn: 2 },
  { id: 'bot.privateWhitelist-to-whitelistPrivate', from: 'bot.privateWhitelist', to: 'bot.whitelistPrivate', reason: '私聊白名单字段统一命名。', introducedIn: 2 },
  { id: 'bot.blacklistUsers-to-blacklistGroupUsers', from: 'bot.blacklistUsers', to: 'bot.blacklistGroupUsers', reason: '黑名单字段明确为群用户维度。', introducedIn: 2 },
  { id: 'bot.commands.draw-to-genImage', from: 'bot.commands.draw', to: 'bot.commands.genImage', reason: '显式生图命令归一到 genImage。', introducedIn: 2 },
  { id: 'bot.commands.imageCount-default', from: 'missing bot.commands.imageCount', to: 'bot.commands.imageCount', reason: '补齐多图张数 bang 参数命令入口。', introducedIn: 2 },
  { id: 'bot.commands-to-features', from: 'bot.commands.{genImage,...}', to: 'bot.features', reason: '命令别名迁移到统一功能注册表，后台按功能目录动态渲染。', introducedIn: 2 },
];

export function createDefaultConfig(): AppConfig { return clone(DEFAULT_CONFIG); }
export function getDefaultPrompts() { return { enhancePromptTemplate: P.enhance, interrogatePromptTemplate: P.interrogate, interrogateTemplatePromptTemplate: P.interrogateTpl, safeRewritePromptTemplate: P.safe, promptsChatSearchQueryPromptTemplate: P.pcQuery, promptsChatSmartPromptTemplate: P.pcSmart, freeModePromptTemplate: P.free, ttsPreprocessPromptTemplate: P.ttsPreprocess }; }
/**
 * 已退役的配置字段。
 *
 * llm / canvas / bot 这几段是 `{ ...默认值, ...用户对象 }` 展开出来的，
 * 未知键会原样漏进结果并被写回 config.json——删掉字段还不够，
 * 老配置里的残留会一直躺在文件里，导出、导入、比对时继续冒出来。
 *
 * 这些字段在 v2 和 legacy 两条运行时里都没有任何读取方，
 * 面板上也已经没有对应的输入框。
 */
const RETIRED_FIELDS: Record<string, readonly string[]> = {
  napcat: ['mountOutputDir'],
  canvas: ['dataDir'],
  freeMode: ['maxReferencedMessages'],
  promptsChat: ['translateSearchQuery', 'translateResults'],
  llm: ['autoNewConversation', 'templateConvertNodeIndex', 'templateConvertModel', 'templatePromptTemplate',
    'templateConvertPromptTemplate', 'templateTitlePromptTemplate', 'referencedTemplatePromptTemplate',
    'referencedTemplateTimeoutMs', 'translationPromptTemplate'],
};

function dropRetired(target: Record<string, any>): void {
  for (const [section, keys] of Object.entries(RETIRED_FIELDS)) {
    const node = target[section];
    if (!node || typeof node !== 'object') continue;
    for (const key of keys) delete node[key];
  }
  const compression = target.bot?.imageCompression;
  if (compression && typeof compression === 'object') {
    for (const key of ['mergedPreviewEnabled', 'mergedPreviewScale', 'mergedPreviewQuality', 'mergedPreviewMaxWidth']) delete compression[key];
  }
  const filters = target.huggingFace?.filters;
  if (filters && typeof filters === 'object') delete filters.includePrivate;
}

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
  foldModelLimitsIntoNodes(obj(c.llm), m);
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
  if (bot.commands && bot.features === undefined) m.push(notice('bot.commands-to-features'));
}

function normalizeAppConfig(input: R, warnings: string[]): AppConfig {
  const cfg = deepMerge(createDefaultConfig() as unknown as R, input) as unknown as AppConfig;
  const panel = { ...DEFAULT_CONFIG.panel, ...obj((cfg as any).panel) };
  const nap = { ...DEFAULT_CONFIG.napcat, ...obj((cfg as any).napcat) };
  const llm = { ...DEFAULT_CONFIG.llm, ...obj((cfg as any).llm) };
  llm.apiKeys = normNodes(llm.apiKeys, warnings);
  const clampNode = (v: unknown, fb = 0) => clamp(v, fb, 0, Math.max(0, llm.apiKeys.length - 1), true);
  llm.activeNodeIndex = clampNode(llm.activeNodeIndex); llm.chatNodeIndex = clampNode(llm.chatNodeIndex, llm.activeNodeIndex); llm.sessionTtlMinutes = clamp(llm.sessionTtlMinutes, 30, 0, 1440, true); llm.enhanceNodeIndex = clampNode(llm.enhanceNodeIndex, llm.activeNodeIndex); llm.templateNodeIndex = clampNode(llm.templateNodeIndex, llm.enhanceNodeIndex); llm.referencedTemplateNodeIndex = clampNode(llm.referencedTemplateNodeIndex); llm.translationNodeIndex = clampNode(llm.translationNodeIndex, llm.chatNodeIndex); llm.imageNodeIndex = clampNode(llm.imageNodeIndex); llm.editNodeIndex = clampNode(llm.editNodeIndex, llm.imageNodeIndex); llm.interrogateNodeIndex = clampNode(llm.interrogateNodeIndex, llm.chatNodeIndex); llm.videoNodeIndex = clampNode(llm.videoNodeIndex, llm.imageNodeIndex);
  llm.reasoningEffort = pick(llm.reasoningEffort, ['low', 'medium', 'high', 'xhigh'] as const, DEFAULT_CONFIG.llm.reasoningEffort); llm.imageEditRequestMode = pick(llm.imageEditRequestMode, ['auto', 'json-images', 'json-image', 'multipart'] as const, DEFAULT_CONFIG.llm.imageEditRequestMode); llm.imageCount = clamp(llm.imageCount, 1, 1, 4, true); llm.imageTimeoutMs = clamp(llm.imageTimeoutMs, 300000, 30000); llm.imageRetryCount = clamp(llm.imageRetryCount, 1, 0, 10, true); llm.imageRetryDelayMs = clamp(llm.imageRetryDelayMs, 2500, 0); llm.interrogateTimeoutMs = clamp(llm.interrogateTimeoutMs, 300000, 30000); llm.videoEnabled = bool(llm.videoEnabled, DEFAULT_CONFIG.llm.videoEnabled); llm.videoModel = str(llm.videoModel, DEFAULT_CONFIG.llm.videoModel, false).trim() || DEFAULT_CONFIG.llm.videoModel; llm.videoTimeoutMs = clamp(llm.videoTimeoutMs, DEFAULT_CONFIG.llm.videoTimeoutMs, 10000); llm.videoPollTimeoutMs = clamp(llm.videoPollTimeoutMs, DEFAULT_CONFIG.llm.videoPollTimeoutMs, 30000); llm.videoPollIntervalMs = clamp(llm.videoPollIntervalMs, DEFAULT_CONFIG.llm.videoPollIntervalMs, 200, 60000, true); llm.capabilityOverrides = normCapabilityOverrides(llm.capabilityOverrides);
  const pc = { ...DEFAULT_CONFIG.promptsChat, ...obj((cfg as any).promptsChat) }; pc.searchType = pick(String(pc.searchType ?? '').toUpperCase(), ['', 'TEXT', 'STRUCTURED', 'IMAGE', 'VIDEO', 'AUDIO'] as const, ''); pc.requestTimeoutMs = clamp(pc.requestTimeoutMs, 20000, 5000); pc.searchLimit = clamp(pc.searchLimit, 20, 1, 50, true); pc.displayLimit = clamp(pc.displayLimit, 5, 1, 10, true); pc.smartSearchLimit = clamp(pc.smartSearchLimit, 24, 3, 50, true); pc.smartCandidateLimit = clamp(pc.smartCandidateLimit, 6, 1, 10, true); pc.smartCandidateContentChars = clamp(pc.smartCandidateContentChars, 1800, 400, 5000, true); pc.smartNodeIndex = clampNode(pc.smartNodeIndex, llm.templateNodeIndex);
  const canvas = { ...DEFAULT_CONFIG.canvas, ...obj((cfg as any).canvas), brand: { ...DEFAULT_CONFIG.canvas.brand, ...obj((cfg as any).canvas?.brand) }, logs: { ...DEFAULT_CONFIG.canvas.logs, ...obj((cfg as any).canvas?.logs) } }; canvas.imageNodeIndex = clampNode(canvas.imageNodeIndex, llm.imageNodeIndex); canvas.editNodeIndex = clampNode(canvas.editNodeIndex, llm.editNodeIndex); canvas.interrogateNodeIndex = clampNode(canvas.interrogateNodeIndex, llm.interrogateNodeIndex); canvas.interrogateTemplateNodeIndex = clampNode(canvas.interrogateTemplateNodeIndex, canvas.interrogateNodeIndex); canvas.access = pick(canvas.access, ['public', 'local-only', 'admin'] as const, 'public'); canvas.rateLimitPerMinute = clamp(canvas.rateLimitPerMinute, 20, 0, 10000, true); canvas.imageEditRequestMode = pick(canvas.imageEditRequestMode, ['auto', 'json-images', 'json-image', 'multipart'] as const, 'auto'); canvas.defaultQuality = imageQuality(canvas.defaultQuality, 'auto'); canvas.defaultOutputFormat = pick(canvas.defaultOutputFormat, ['png', 'jpeg', 'webp'] as const, 'png'); canvas.defaultCount = pick(num(canvas.defaultCount), [1, 2, 4, 8, 16] as const, 1); canvas.imageTimeoutMs = clamp(canvas.imageTimeoutMs, llm.imageTimeoutMs, 30000); canvas.interrogateTimeoutMs = clamp(canvas.interrogateTimeoutMs, llm.interrogateTimeoutMs, 30000); canvas.interrogateTemplateTimeoutMs = clamp(canvas.interrogateTemplateTimeoutMs, canvas.interrogateTimeoutMs, 30000); canvas.brand.logoText = str(canvas.brand.logoText, DEFAULT_CONFIG.canvas.brand.logoText, false).trim() || DEFAULT_CONFIG.canvas.brand.logoText; canvas.brand.pageTitle = str(canvas.brand.pageTitle, DEFAULT_CONFIG.canvas.brand.pageTitle, false).trim() || DEFAULT_CONFIG.canvas.brand.pageTitle; canvas.brand.faviconUrl = str(canvas.brand.faviconUrl, DEFAULT_CONFIG.canvas.brand.faviconUrl, false).trim() || DEFAULT_CONFIG.canvas.brand.faviconUrl; canvas.logs.level = pick(canvas.logs.level, ['debug', 'info', 'warn', 'error'] as const, 'info'); canvas.logs.maxMemoryEntries = clamp(canvas.logs.maxMemoryEntries, 1000, 100, 5000, true); canvas.maxHistory = clamp(canvas.maxHistory, 50, 1, 500, true);   const bot = { ...DEFAULT_CONFIG.bot, ...obj((cfg as any).bot), triggerModes: { ...DEFAULT_CONFIG.bot.triggerModes, ...obj((cfg as any).bot?.triggerModes) }, groupContext: { ...DEFAULT_CONFIG.bot.groupContext, ...obj((cfg as any).bot?.groupContext) }, textReply: { ...DEFAULT_CONFIG.bot.textReply, ...obj((cfg as any).bot?.textReply) }, progress: { ...DEFAULT_CONFIG.bot.progress, ...obj((cfg as any).bot?.progress) }, imageCompression: { ...DEFAULT_CONFIG.bot.imageCompression, ...obj((cfg as any).bot?.imageCompression) }, commands: { ...DEFAULT_CONFIG.bot.commands, ...obj((cfg as any).bot?.commands) }, tts: { ...DEFAULT_CONFIG.bot.tts, ...obj((cfg as any).bot?.tts), preprocess: { ...DEFAULT_CONFIG.bot.tts.preprocess, ...obj((cfg as any).bot?.tts?.preprocess) } } };
  const rf = pick(bot.replyFormat, ['at', 'forward', 'quote', 'plain'] as const, 'forward'); bot.replyFormat = (rf === 'plain' ? 'forward' : rf) as LegacyReplyFormat; const rs = obj(bot.replyStrategies); bot.replyStrategies = { text: strategy(rs.text, rf), image: strategy(rs.image, rf), multiImage: strategy(rs.multiImage, strategy(rs.image, rf)), video: strategy(rs.video, 'plain'), multiVideo: strategy(rs.multiVideo, 'forward'), file: strategy(rs.file, 'forward'), multiFile: strategy(rs.multiFile, 'forward'), mixed: strategy(rs.mixed, 'forward') }; bot.botQqId = str(bot.botQqId, '', false).trim(); bot.ownerQQs = list(bot.ownerQQs); bot.whitelistGroups = list(bot.whitelistGroups); bot.whitelistPrivate = list(bot.whitelistPrivate); bot.blacklistGroupUsers = list(bot.blacklistGroupUsers); bot.tts.enabled = bool(bot.tts.enabled, false); bot.tts.provider = pick(bot.tts.provider, ['fish-audio', 'openai-compatible'] as const, 'fish-audio'); bot.tts.apiUrl = str(bot.tts.apiUrl, DEFAULT_CONFIG.bot.tts.apiUrl, false).trim(); bot.tts.apiKey = str(bot.tts.apiKey, '', false).trim(); bot.tts.model = str(bot.tts.model, bot.tts.provider === 'fish-audio' ? 's2.1-pro-free' : 'tts-1', false).trim(); bot.tts.voiceId = str(bot.tts.voiceId, '', false).trim(); bot.tts.voiceIds = normTtsVoiceIds(bot.tts.voiceIds, bot.tts.voiceId); if (!bot.tts.voiceId && bot.tts.voiceIds.length) bot.tts.voiceId = bot.tts.voiceIds[0]; bot.tts.voice = str(bot.tts.voice, 'alloy', false).trim(); bot.tts.format = pick(String(bot.tts.format || '').toLowerCase(), ['mp3', 'wav', 'opus'] as const, 'mp3'); bot.tts.autoTextMaxChars = clamp(bot.tts.autoTextMaxChars, 180, 1, 4000, true); bot.tts.timeoutMs = clamp(bot.tts.timeoutMs, 60000, 5000, 300000, true); bot.tts.speed = clamp(bot.tts.speed, 1, 0.5, 2); bot.tts.volume = clamp(bot.tts.volume, 0, -20, 20); bot.tts.latency = pick(bot.tts.latency, ['normal', 'balanced', 'low'] as const, 'normal'); bot.tts.preprocess = { ...DEFAULT_CONFIG.bot.tts.preprocess, ...obj(bot.tts.preprocess) }; bot.tts.preprocess.enabled = bool(bot.tts.preprocess.enabled, false); bot.tts.preprocess.nodeIndex = clampNode(bot.tts.preprocess.nodeIndex, llm.chatNodeIndex); bot.tts.preprocess.model = str(bot.tts.preprocess.model, llm.chatModel || 'gpt-4o-mini', false).trim(); bot.tts.preprocess.timeoutMs = clamp(bot.tts.preprocess.timeoutMs, 60000, 5000, 300000, true); bot.tts.preprocess.delayMs = clamp(bot.tts.preprocess.delayMs, 0, 0, 30000, true); bot.tts.preprocess.maxOutputChars = clamp(bot.tts.preprocess.maxOutputChars, 1000, 1, 8000, true); bot.tts.preprocess.promptTemplate = str(bot.tts.preprocess.promptTemplate, P.ttsPreprocess, false); bot.tts.preprocess.fallbackToOriginal = bool(bot.tts.preprocess.fallbackToOriginal, true); bot.textReply.maxChars = clamp(bot.textReply.maxChars, 1800, 0, 20000, true); bot.textReply.splitDelayMs = clamp(bot.textReply.splitDelayMs, 800, 0, 10000, true); bot.progress.enabled = bool(bot.progress.enabled, true); bot.progress.imageText = str(bot.progress.imageText, DEFAULT_CONFIG.bot.progress.imageText, false).trim() || DEFAULT_CONFIG.bot.progress.imageText; bot.progress.editText = str(bot.progress.editText, DEFAULT_CONFIG.bot.progress.editText, false).trim() || DEFAULT_CONFIG.bot.progress.editText; bot.progress.interrogateText = str(bot.progress.interrogateText, DEFAULT_CONFIG.bot.progress.interrogateText, false).trim() || DEFAULT_CONFIG.bot.progress.interrogateText; bot.progress.videoText = str(bot.progress.videoText, DEFAULT_CONFIG.bot.progress.videoText, false).trim() || DEFAULT_CONFIG.bot.progress.videoText; bot.progress.showEta = bool(bot.progress.showEta, true); bot.textImage = { ...DEFAULT_CONFIG.bot.textImage, ...obj(bot.textImage) }; bot.textImage.enabled = bool(bot.textImage.enabled, false); bot.textImage.width = clamp(bot.textImage.width, 1080, 320, 4096, true); bot.textImage.minHeight = clamp(bot.textImage.minHeight, 240, 80, 4096, true); bot.textImage.maxHeight = clamp(bot.textImage.maxHeight, 4096, bot.textImage.minHeight, 8192, true); bot.textImage.padding = clamp(bot.textImage.padding, 64, 8, 256, true); bot.textImage.fontSize = clamp(bot.textImage.fontSize, 32, 12, 96, true); bot.textImage.lineHeight = clamp(bot.textImage.lineHeight, 1.7, 1.1, 3); bot.textImage.fontFamily = str(bot.textImage.fontFamily, 'Noto Sans CJK SC', false).trim() || 'Noto Sans CJK SC'; bot.textImage.background = str(bot.textImage.background, '#0F172A', false).trim() || '#0F172A'; bot.textImage.foreground = str(bot.textImage.foreground, '#E5E7EB', false).trim() || '#E5E7EB'; bot.textImage.accent = str(bot.textImage.accent, '#38BDF8', false).trim() || '#38BDF8'; bot.textImage.quality = clamp(bot.textImage.quality, 70, 1, 100, true); bot.textImage.maxChars = clamp(bot.textImage.maxChars, 4000, 100, 20000, true); bot.staleMessageMaxAgeSeconds = clamp(bot.staleMessageMaxAgeSeconds, 90, 0, 3600, true); bot.groupContext.enabled = bool(bot.groupContext.enabled, false); bot.groupContext.messageCount = clamp(bot.groupContext.messageCount, 30, 5, 50, true); bot.groupContext.skipForward = bool(bot.groupContext.skipForward, true); bot.groupContext.includeImages = bool(bot.groupContext.includeImages, true); bot.groupContext.maxChars = clamp(bot.groupContext.maxChars, 4000, 500, 20000, true); bot.autoRecallDelaySeconds = clamp(bot.autoRecallDelaySeconds, 60, 1, undefined, true); bot.imageCompression.scale = clamp(bot.imageCompression.scale, 0.65, 0.1, 1); bot.imageCompression.quality = clamp(bot.imageCompression.quality, 82, 1, 100, true); bot.promptTemplates = normTemplates(bot.promptTemplates); const botCommands = bot.commands as Record<string, string>; for (const k of Object.keys(botCommands)) botCommands[k] = aliases(botCommands[k], (DEFAULT_CONFIG.bot.commands as any)[k] ?? ''); bot.features = normalizeFeatureSettings((input as any)?.bot?.features, botCommands); bot.files = { ...DEFAULT_CONFIG.bot.files, ...obj(bot.files) }; bot.files.enabled = bool(bot.files.enabled, true); bot.files.indexTtlMinutes = clamp(bot.files.indexTtlMinutes, 1440, 1, 10080, true); bot.files.maxIndexPerChat = clamp(bot.files.maxIndexPerChat, 200, 10, 1000, true); bot.files.maxFileSizeMB = clamp(bot.files.maxFileSizeMB, 20, 1, 50, true); bot.files.maxTextChars = clamp(bot.files.maxTextChars, 100000, 1000, 200000, true); bot.files.maxPdfPages = clamp(bot.files.maxPdfPages, 50, 1, 200, true); bot.files.maxSpreadsheetRows = clamp(bot.files.maxSpreadsheetRows, 200, 10, 2000, true); bot.files.maxSlideCount = clamp(bot.files.maxSlideCount, 40, 1, 200, true); bot.files.maxArchiveEntries = clamp(bot.files.maxArchiveEntries, 500, 10, 2000, true); bot.files.maxArchiveUncompressedMB = clamp(bot.files.maxArchiveUncompressedMB, 50, 1, 200, true);
  const hf = { ...DEFAULT_CONFIG.huggingFace, ...obj((cfg as any).huggingFace), filters: { ...DEFAULT_CONFIG.huggingFace.filters, ...obj((cfg as any).huggingFace?.filters) } };
  hf.enabled = bool(hf.enabled, false); hf.useForChat = bool(hf.useForChat, false); hf.token = str(hf.token, '', false).trim(); hf.baseUrl = cleanupApiBaseUrl(str(hf.baseUrl, DEFAULT_CONFIG.huggingFace.baseUrl, false)); hf.hubApiUrl = cleanupHubApiUrl(str(hf.hubApiUrl, DEFAULT_CONFIG.huggingFace.hubApiUrl, false)); hf.selectedModelId = str(hf.selectedModelId, '', false).trim(); hf.selectedProvider = str(hf.selectedProvider, '', false).trim(); hf.selectedModelCode = str(hf.selectedModelCode, '', false).trim(); hf.requestMode = pick(hf.requestMode, ['openai-chat', 'router-chat', 'legacy-inference', 'provider-task'] as const, 'openai-chat'); hf.timeoutMs = clamp(hf.timeoutMs, 120000, 5000, 600000, true); hf.cacheTtlSeconds = clamp(hf.cacheTtlSeconds, 3600, 60, 604800, true); hf.cachedAt = str(hf.cachedAt, '', false).trim(); hf.cacheQueryHash = str(hf.cacheQueryHash, '', false).trim(); hf.cachedModels = normHuggingFaceModels(hf.cachedModels);
  hf.filters.search = str(hf.filters.search, '', false).trim(); hf.filters.author = str(hf.filters.author, '', false).trim(); hf.filters.pipelineTag = str(hf.filters.pipelineTag, 'text-generation', false).trim(); hf.filters.tags = str(hf.filters.tags, '', false).trim(); hf.filters.library = str(hf.filters.library, '', false).trim(); hf.filters.inference = pick(hf.filters.inference, ['', 'warm', 'cold', 'frozen'] as const, 'warm'); hf.filters.gated = pick(hf.filters.gated, ['', 'false', 'true'] as const, 'false'); hf.filters.sort = normalizeHfSort(hf.filters.sort); hf.filters.direction = pick(String(hf.filters.direction), ['-1', '1'] as const, '-1'); hf.filters.limit = clamp(hf.filters.limit, 50, 1, 200, true); hf.filters.onlyChatCompatible = bool(hf.filters.onlyChatCompatible, true); hf.filters.provider = str(hf.filters.provider, '', false).trim();
  const search = { ...DEFAULT_CONFIG.search, ...obj((cfg as any).search) };
  search.enabled = bool(search.enabled, true);
  search.provider = pick(search.provider, ['deepseek', 'tavily', 'brave', 'serper', 'bing', 'google', 'searxng', 'exa'] as const, 'deepseek');
  search.apiUrl = str(search.apiUrl, DEFAULT_CONFIG.search.apiUrl, false).trim() || DEFAULT_CONFIG.search.apiUrl;
  search.apiKey = str(search.apiKey, '', false).trim();
  search.googleCx = str(search.googleCx, '', false).trim();
  search.language = str(search.language, 'zh-CN', false).trim();
  search.region = str(search.region, '', false).trim();
  search.localization = str(search.localization, '', false).trim();
  search.autoMode = pick(search.autoMode, ['off', 'auto', 'always'] as const, 'auto');
  search.maxResults = clamp(search.maxResults, 5, 1, 50, true);
  search.needContent = bool(search.needContent, true);
  search.fetchContent = bool(search.fetchContent, true);
  search.fetchProvider = pick(search.fetchProvider, ['provider', 'deepseek', 'jina', 'none'] as const, 'provider');
  search.jinaBaseUrl = str(search.jinaBaseUrl, 'https://r.jina.ai', false).trim() || 'https://r.jina.ai';
  search.jinaApiKey = str(search.jinaApiKey, '', false).trim();
  search.timeoutMs = clamp(search.timeoutMs, 20000, 3000, 120000, true);
  search.retryCount = clamp(search.retryCount, 1, 0, 5, true);
  search.cacheTtlSeconds = clamp(search.cacheTtlSeconds, 300, 0, 86400, true);
  search.maxContentChars = clamp(search.maxContentChars, 6000, 500, 20000, true);
  search.maxTotalChars = clamp(search.maxTotalChars, 20000, 2000, 100000, true);
  search.qps = clamp(search.qps, 5, 1, 20, true);
  const free = { ...DEFAULT_CONFIG.freeMode, ...obj((cfg as any).freeMode) }; free.nodeIndex = clampNode(free.nodeIndex, llm.chatNodeIndex); free.timeoutMs = clamp(free.timeoutMs, 120000, 30000); free.maxInputImages = clamp(free.maxInputImages, 6, 0, 12, true); free.maxOutputImages = clamp(free.maxOutputImages, 4, 1, 4, true);
  const intentRecognition = { ...DEFAULT_CONFIG.intentRecognition, ...obj((cfg as any).intentRecognition) };
  intentRecognition.enabled = bool(intentRecognition.enabled, true);
  intentRecognition.nodeIndex = clampNode(intentRecognition.nodeIndex, free.nodeIndex);
  intentRecognition.model = str(intentRecognition.model, free.model || llm.chatModel, false).trim() || free.model || llm.chatModel;
  intentRecognition.timeoutMs = clamp(intentRecognition.timeoutMs, 12000, 3000, 60000, true);
  intentRecognition.minConfidence = clamp(intentRecognition.minConfidence, 0.65, 0, 1);
  intentRecognition.promptTemplate = str(intentRecognition.promptTemplate, P.naturalIntent, false) || P.naturalIntent;
  const browserRender = { ...DEFAULT_CONFIG.browserRender, ...obj((cfg as any).browserRender) };
  browserRender.enabled = bool(browserRender.enabled, true);
  browserRender.executablePath = str(browserRender.executablePath, '', false).trim();
  browserRender.noSandbox = bool(browserRender.noSandbox, true);
  browserRender.enableWebgl = bool(browserRender.enableWebgl, true);
  browserRender.timeoutMs = clamp(browserRender.timeoutMs, 45000, 5000, 120000, true);
  browserRender.launchTimeoutMs = clamp(browserRender.launchTimeoutMs, 20000, 3000, 60000, true);
  browserRender.idleCloseMs = clamp(browserRender.idleCloseMs, 60000, 0, 600000, true);
  browserRender.maxConcurrency = clamp(browserRender.maxConcurrency, 1, 1, 4, true);
  browserRender.maxQueue = clamp(browserRender.maxQueue, 3, 0, 20, true);
  browserRender.maxCodeChars = clamp(browserRender.maxCodeChars, 200000, 1000, 1000000, true);
  browserRender.maxWidth = clamp(browserRender.maxWidth, 4096, 128, 8192, true);
  browserRender.maxHeight = clamp(browserRender.maxHeight, 4096, 128, 8192, true);
  browserRender.defaultWidth = clamp(browserRender.defaultWidth, 1080, 128, browserRender.maxWidth, true);
  browserRender.defaultHeight = clamp(browserRender.defaultHeight, 1080, 128, browserRender.maxHeight, true);
  browserRender.maxScreenshotBytes = clamp(browserRender.maxScreenshotBytes, 20971520, 1024, 104857600, true);
  browserRender.allowPrivateHosts = bool(browserRender.allowPrivateHosts, false);
  const codeRender = { ...DEFAULT_CONFIG.codeRender, ...obj((cfg as any).codeRender) };
  codeRender.enabled = bool(codeRender.enabled, true);
  codeRender.nodeIndex = clampNode(codeRender.nodeIndex, free.nodeIndex);
  codeRender.model = str(codeRender.model, free.model || llm.chatModel, false).trim() || free.model || llm.chatModel;
  codeRender.timeoutMs = clamp(codeRender.timeoutMs, 30000, 5000, 120000, true);
  codeRender.maxTokens = clamp(codeRender.maxTokens, 4096, 256, 32768, true);
  codeRender.promptTemplate = str(codeRender.promptTemplate, P.codeRender, false) || P.codeRender;
  const comfyuiTransform = { ...DEFAULT_CONFIG.comfyuiTransform, ...obj((cfg as any).comfyuiTransform) };
  comfyuiTransform.enabled = bool(comfyuiTransform.enabled, true);
  comfyuiTransform.nodeIndex = clampNode(comfyuiTransform.nodeIndex, free.nodeIndex);
  comfyuiTransform.model = str(comfyuiTransform.model, free.model || llm.chatModel, false).trim() || free.model || llm.chatModel;
  comfyuiTransform.timeoutMs = clamp(comfyuiTransform.timeoutMs, 20000, 3000, 120000, true);
  comfyuiTransform.maxTokens = clamp(comfyuiTransform.maxTokens, 2400, 256, 8192, true);
  comfyuiTransform.promptTemplate = str(comfyuiTransform.promptTemplate, P.comfyuiTransform, false) || P.comfyuiTransform;
  if (comfyuiTransform.promptTemplate.startsWith('你是 ComfyUI 生图参数转换器。') && comfyuiTransform.promptTemplate.includes('最大批量：{{maxBatchSize}}')) {
    comfyuiTransform.promptTemplate = P.comfyuiTransform;
    comfyuiTransform.maxTokens = Math.max(comfyuiTransform.maxTokens, 2400);
  } else if (
    comfyuiTransform.promptTemplate.startsWith('你是 Miobot 的 ComfyUI 提示词工程师和生成参数规划器。')
    && comfyuiTransform.promptTemplate.includes('【提示词结构】')
    && comfyuiTransform.promptTemplate.includes('【模型家族专项：Z-Image Turbo】')
    && !comfyuiTransform.promptTemplate.includes('【Miobot-ComfyUI-Transform-v4】')
  ) {
    // 旧内置模板没有保真、增强和防漂移规则；升级一次，用户自定义模板不会被误改。
    comfyuiTransform.promptTemplate = P.comfyuiTransform;
    comfyuiTransform.maxTokens = Math.max(comfyuiTransform.maxTokens, 2400);
  }
  dropRetired({ napcat: nap, llm, promptsChat: pc, canvas, bot, huggingFace: hf, freeMode: free });
  return { panel: { port: clamp(panel.port, 3018, 1, 65535, true), passwordSeed: str(panel.passwordSeed, 'change-me-on-first-login', false) }, napcat: { wsUrl: str(nap.wsUrl, DEFAULT_CONFIG.napcat.wsUrl), token: str(nap.token, ''), actionTimeoutMs: clamp(nap.actionTimeoutMs, 15000, 3000, 60000), textSendTimeoutMs: clamp(nap.textSendTimeoutMs, 15000, 3000, 180000), imageSendTimeoutMs: clamp(nap.imageSendTimeoutMs, 120000, 10000, 300000), fileSendTimeoutMs: clamp(nap.fileSendTimeoutMs, nap.forwardSendTimeoutMs || 300000, 10000, 600000), fileSendRetryCount: clamp(nap.fileSendRetryCount, 1, 0, 10, true), fileSendRetryDelayMs: clamp(nap.fileSendRetryDelayMs, 1200, 0, 30000, true), forwardSendTimeoutMs: clamp(nap.forwardSendTimeoutMs, 300000, 10000, 600000), getMessageTimeoutMs: clamp(nap.getMessageTimeoutMs, 10000, 3000, 60000) }, promptsChat: pc, canvas, freeMode: free, intentRecognition, browserRender, codeRender, comfyuiTransform, huggingFace: hf, search, llm, bot };
}

function notice(id: string): MigrationNotice { const r = CONFIG_MIGRATION_TABLE.find(x => x.id === id); return r ? { id: r.id, from: r.from, to: r.to, reason: r.reason } : { id, from: 'unknown', to: 'unknown', reason: '未登记迁移规则。' }; }
function move(o: R, from: string, to: string, m: MigrationNotice[], id: string) { if (o[from] !== undefined && o[to] === undefined) { o[to] = o[from]; m.push(notice(id)); } }
function dedupe(m: MigrationNotice[]) { const seen = new Set<string>(); return m.filter(x => seen.has(x.id) ? false : (seen.add(x.id), true)); }
function isObj(v: unknown): v is R { return !!v && typeof v === 'object' && !Array.isArray(v); }
function obj(v: unknown): R { return isObj(v) ? v : {}; }
function ensure(o: R, k: string): R { if (!isObj(o[k])) o[k] = {}; return o[k]; }
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
/** 配置来自 HTTP 请求体与磁盘文件，合并时必须挡掉原型链注入。 */
const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(a: R, b: R): R { const r: R = { ...a }; for (const [k, v] of Object.entries(b)) { if (FORBIDDEN_MERGE_KEYS.has(k)) continue; r[k] = isObj(v) && isObj(r[k]) ? deepMerge(r[k], v) : v; } return r; }
function num(v: unknown): number | undefined { if (v === undefined || v === null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function clamp(v: unknown, fb: number, min?: number, max?: number, int = false): number { let n = num(v) ?? fb; if (int) n = Math.trunc(n); if (min !== undefined) n = Math.max(min, n); if (max !== undefined) n = Math.min(max, n); return n; }
function str(v: unknown, fb: string, trim = true): string { if (v === undefined || v === null) return fb; const s = String(v); const out = trim ? s.trim() : s; return out || fb; }
function bool(v: unknown, fb: boolean): boolean { if (typeof v === 'boolean') return v; if (typeof v === 'number' && Number.isFinite(v)) return v !== 0; if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (['true', '1', 'yes', 'on'].includes(s)) return true; if (['false', '0', 'no', 'off'].includes(s)) return false; } return fb; }
function pick<const T extends readonly (string | number)[]>(v: unknown, allowed: T, fb: T[number]): T[number] { return (allowed as readonly unknown[]).includes(v) ? v as T[number] : fb; }
function list(v: unknown): string[] { const src = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\uFF0C\u3001\uFF1B;\n]+/) : []; const seen = new Set<string>(); const out: string[] = []; for (const x of src) { const s = String(x ?? '').trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } } return out; }
function normHeaders(v: unknown): Record<string, string> { const source = obj(v); const out: Record<string, string> = {}; for (const [key, value] of Object.entries(source)) { const name = String(key || '').trim(); const text = String(value ?? '').trim(); if (name && text) out[name] = text; } return out; }
function normTtsVoiceIds(v: unknown, active: string): string[] { const source = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\uFF0C\u3001\uFF1B;\n]+/) : []; const seen = new Set<string>(); const out: string[] = []; for (const x of [active, ...source]) { const s = String(x ?? '').trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } } return out; }
/**
 * \u547D\u4EE4\u522B\u540D\uFF1A\u7528\u6237\u503C\u4E0E\u9ED8\u8BA4\u503C\u53D6\u5E76\u96C6\uFF08\u89C1 tests/config-regression\u300Ckeep default fallbacks\u300D\uFF09\u3002
 *
 * \u5DF2\u77E5\u53D6\u820D\uFF1A\u8FD9\u6837\u7528\u6237\u5220\u4E0D\u6389\u5185\u7F6E\u522B\u540D\u3002\u9ED8\u8BA4\u7684 genImage \u542B\u5355\u5B57\u300C\u753B\u300D\uFF0C\u89E6\u53D1\u9762\u504F\u5927\uFF0C
 * \u60F3\u6536\u7D27\u7684\u7528\u6237\u76EE\u524D\u53EA\u80FD\u6539\u9ED8\u8BA4\u503C\u800C\u4E0D\u80FD\u5220\u3002\u82E5\u8981\u6539\u6210\u300C\u7528\u6237\u4E3A\u7A7A\u624D\u56DE\u843D\u9ED8\u8BA4\u300D\uFF0C
 * \u9700\u540C\u6B65\u6539\u4E0A\u9762\u90A3\u6761\u56DE\u5F52\u6D4B\u8BD5\u3002
 */
function aliases(v: unknown, fb: string): string { const raw = Array.isArray(v) ? v : String(v ?? fb).split(/[,\uFF0C\u3001\uFF1B;\n]+/); const def = String(fb).split(/[,\uFF0C\u3001\uFF1B;\n]+/); const seen = new Set<string>(); const out: string[] = []; for (const x of [...raw, ...def]) { const s = String(x ?? '').replace(/\s+/g, ' ').trim(); const key = s.toLowerCase(); if (s && !seen.has(key)) { seen.add(key); out.push(s); } } return out.join(', '); }
function strategy(v: unknown, fb: ReplyStrategy): ReplyStrategy { return pick(v, ['at', 'forward', 'quote', 'plain', 'text-image'] as const, fb); }
function imageQuality(v: unknown, fb: CanvasImageQuality): CanvasImageQuality { const s = String(v ?? '').trim().toLowerCase(); return pick(s === 'hd' ? 'high' : s, ['auto', 'low', 'medium', 'high'] as const, fb); }
function normalizeHfSort(v: unknown): string {
  const raw = String(v ?? '').trim();
  const mapped = ({ last_modified: 'lastModified', created_at: 'createdAt', trending_score: 'trendingScore' } as Record<string, string>)[raw] || raw;
  return pick(mapped, ['downloads', 'likes', 'lastModified', 'createdAt', 'trendingScore'] as const, 'downloads');
}
const COMFYUI_MODEL_FAMILIES = ['moss-image', 'krea-2', 'z-image', 'sdxl', 'flux', 'sd15', 'generic'] as const;
const COMFYUI_PROMPT_SYNTAXES = ['natural', 'a1111', 'sdxl', 'moss', 'krea'] as const;
const COMFYUI_PROMPT_FORMATS = ['caption', 'tags', 'layout'] as const;
const COMFYUI_VARIANTS = ['base', 'sft', 'raw', 'turbo', 'unknown'] as const;

export function defaultComfyUiPromptPolicy(family: ComfyUiModelFamily = 'generic'): ComfyUiPromptPolicy {
  const base: ComfyUiPromptPolicy = {
    modelFamily: family, variant: 'unknown', promptSyntax: 'a1111', language: 'en', preferredFormat: 'caption',
    supportsWeights: true, supportsNegativePrompt: true, supportsBreak: false, supportsEmbeddings: true,
    supportsDynamicPrompts: false, supportsLoraTags: false,
    maxPromptChars: 4000, maxWeights: 10, weightMin: 0.5, weightMax: 2,
    defaultNegativePrompt: '', loraTriggers: [],
  };
  if (family === 'moss-image') return {
    ...base, promptSyntax: 'moss', preferredFormat: 'caption', supportsWeights: false,
    supportsNegativePrompt: true, supportsEmbeddings: false, maxWeights: 0, weightMin: 1, weightMax: 1,
    maxPromptChars: 4000, defaultNegativePrompt: 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact',
  };
  if (family === 'krea-2') return {
    ...base, variant: 'turbo', promptSyntax: 'krea', preferredFormat: 'caption', supportsWeights: false,
    supportsNegativePrompt: false, supportsEmbeddings: false, maxWeights: 0, weightMin: 1, weightMax: 1,
    maxPromptChars: 2000,
  };
  if (family === 'z-image') return {
    ...base, variant: 'turbo', promptSyntax: 'natural', preferredFormat: 'caption', supportsWeights: false,
    supportsNegativePrompt: false, supportsEmbeddings: false, maxWeights: 0, weightMin: 1, weightMax: 1,
    maxPromptChars: 2000,
  };
  if (family === 'sdxl') return {
    ...base, promptSyntax: 'sdxl', supportsWeights: true, supportsNegativePrompt: true, supportsEmbeddings: true,
    maxPromptChars: 900, maxWeights: 5, weightMin: 0.8, weightMax: 1.3,
    defaultNegativePrompt: 'low quality, blurry, jpeg artifacts, deformed hands, extra fingers, watermark, text, logo',
  };
  if (family === 'flux') return {
    ...base, promptSyntax: 'natural', preferredFormat: 'caption', supportsWeights: false,
    supportsNegativePrompt: false, supportsEmbeddings: false, maxWeights: 0, weightMin: 1, weightMax: 1,
    maxPromptChars: 1200,
  };
  if (family === 'sd15') return {
    ...base, promptSyntax: 'a1111', supportsWeights: true, supportsNegativePrompt: true, supportsEmbeddings: true,
    maxPromptChars: 500, maxWeights: 4, weightMin: 0.8, weightMax: 1.3,
    defaultNegativePrompt: 'low quality, worst quality, blurry, jpeg artifacts, bad anatomy, watermark, text',
  };
  return base;
}

function normalizeComfyUiFamilyAlias(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (raw === 'moss' || raw === 'moss-image') return 'moss-image';
  if (raw === 'krea' || raw === 'krea2' || raw === 'krea-2') return 'krea-2';
  if (raw === 'sd-15' || raw === 'sd1-5') return 'sd15';
  return raw;
}

function inferComfyUiModelFamily(id: unknown, name: unknown, explicit?: unknown): ComfyUiModelFamily {
  const explicitValue = normalizeComfyUiFamilyAlias(explicit);
  if ((COMFYUI_MODEL_FAMILIES as readonly string[]).includes(explicitValue)) return explicitValue as ComfyUiModelFamily;
  const text = `${String(id || '')} ${String(name || '')}`.toLowerCase();
  if (/moss|openmoss/.test(text)) return 'moss-image';
  if (/krea[-\s]?2|krea2/.test(text)) return 'krea-2';
  if (/z[-\s]?image|zimage/.test(text)) return 'z-image';
  if (/sdxl|sd[-\s]?xl/.test(text)) return 'sdxl';
  if (/flux/.test(text)) return 'flux';
  if (/sd[-\s]?1[._-]?5|sd15/.test(text)) return 'sd15';
  return 'generic';
}

function inferComfyUiVariant(id: unknown, name: unknown): ComfyUiVariant {
  const text = `${String(id || '')} ${String(name || '')}`.toLowerCase();
  if (/turbo/.test(text)) return 'turbo';
  if (/\braw\b/.test(text)) return 'raw';
  if (/sft/.test(text)) return 'sft';
  if (/\bbase\b/.test(text)) return 'base';
  return 'unknown';
}

export function normalizeComfyUiPromptPolicy(value: unknown, fallback: ComfyUiPromptPolicy = defaultComfyUiPromptPolicy()): ComfyUiPromptPolicy {
  const raw = isObj(value) ? value as R : {};
  const explicitFamily = normalizeComfyUiFamilyAlias(raw.modelFamily);
  const family = (COMFYUI_MODEL_FAMILIES as readonly string[]).includes(explicitFamily)
    ? explicitFamily as ComfyUiModelFamily
    : fallback.modelFamily;
  const base = defaultComfyUiPromptPolicy(family);
  const weightMin = clamp(raw.weightMin, fallback.weightMin ?? base.weightMin, 0, 3);
  const weightMax = clamp(raw.weightMax, fallback.weightMax ?? base.weightMax, weightMin, 3);
  return {
    modelFamily: family,
    variant: (COMFYUI_VARIANTS as readonly string[]).includes(String(raw.variant || '').trim().toLowerCase())
      ? String(raw.variant).trim().toLowerCase() as ComfyUiVariant
      : (fallback.variant !== 'unknown' ? fallback.variant : base.variant),
    promptSyntax: (COMFYUI_PROMPT_SYNTAXES as readonly string[]).includes(String(raw.promptSyntax || '').trim().toLowerCase())
      ? String(raw.promptSyntax).trim().toLowerCase() as ComfyUiPromptSyntax
      : (fallback.promptSyntax || base.promptSyntax),
    language: (['en', 'zh', 'auto'] as readonly string[]).includes(String(raw.language || '').trim().toLowerCase())
      ? String(raw.language).trim().toLowerCase() as 'en' | 'zh' | 'auto'
      : (fallback.language || base.language),
    preferredFormat: (COMFYUI_PROMPT_FORMATS as readonly string[]).includes(String(raw.preferredFormat || '').trim().toLowerCase())
      ? String(raw.preferredFormat).trim().toLowerCase() as ComfyUiPromptFormat
      : (fallback.preferredFormat || base.preferredFormat),
    supportsWeights: bool(raw.supportsWeights, fallback.supportsWeights ?? base.supportsWeights),
    supportsNegativePrompt: bool(raw.supportsNegativePrompt, fallback.supportsNegativePrompt ?? base.supportsNegativePrompt),
    supportsBreak: bool(raw.supportsBreak, fallback.supportsBreak ?? base.supportsBreak),
    supportsEmbeddings: bool(raw.supportsEmbeddings, fallback.supportsEmbeddings ?? base.supportsEmbeddings),
    supportsDynamicPrompts: bool(raw.supportsDynamicPrompts, fallback.supportsDynamicPrompts ?? base.supportsDynamicPrompts),
    supportsLoraTags: bool(raw.supportsLoraTags, fallback.supportsLoraTags ?? base.supportsLoraTags),
    maxPromptChars: clamp(raw.maxPromptChars, fallback.maxPromptChars ?? base.maxPromptChars, 200, 20000, true),
    maxWeights: clamp(raw.maxWeights, fallback.maxWeights ?? base.maxWeights, 0, 20, true),
    weightMin,
    weightMax,
    defaultNegativePrompt: str(raw.defaultNegativePrompt, fallback.defaultNegativePrompt ?? base.defaultNegativePrompt, false),
    loraTriggers: list(raw.loraTriggers).map((x) => String(x || '').trim()).filter(Boolean),
  };
}

export function inferComfyUiPromptPolicy(id: unknown, name: unknown, value?: unknown): ComfyUiPromptPolicy {
  const explicitFamily = isObj(value) ? String((value as R).modelFamily || '').trim() : '';
  const family = inferComfyUiModelFamily(id, name, explicitFamily);
  const base = defaultComfyUiPromptPolicy(family);
  base.variant = inferComfyUiVariant(id, name);
  return normalizeComfyUiPromptPolicy(value, base);
}

function normComfyLora(v: unknown): ComfyUiLoraConfig | undefined {
  if (!isObj(v)) return undefined;
  const raw = v as R;
  const nodeId = str(raw.nodeId, '', false).trim();
  const catalog = (Array.isArray(raw.catalog) ? raw.catalog : [])
    .filter(isObj)
    .map((item: R) => ({
      id: str(item.id, '', false).trim(),
      file: str(item.file, '', false).trim(),
      description: str(item.description, '', false).trim() || undefined,
      triggers: list(item.triggers),
      defaultStrength: clamp(item.defaultStrength, 0.6, 0, 2),
      minStrength: clamp(item.minStrength, 0, 0, 2),
      maxStrength: clamp(item.maxStrength, 2, 0, 2),
    }))
    .filter((item) => item.id && item.file);
  if (!nodeId || !catalog.length) return undefined;
  const base = Array.isArray(raw.baseModel) && raw.baseModel.length >= 2
    ? [String(raw.baseModel[0]), clamp(raw.baseModel[1], 0, 0, 999, true)] as [string, number]
    : undefined;
  return { nodeId, baseModel: base, catalog };
}

function normComfyui(v: unknown, warnings: string[]): ComfyUiNodeConfig | undefined {
  if (!isObj(v)) return undefined;
  const raw = v as R;
  let profiles = Array.isArray(raw.profiles) ? raw.profiles.filter(isObj).map((item: R, index: number) => ({
    id: str(item.id, `profile-${index + 1}`, false).trim() || `profile-${index + 1}`,
    name: str(item.name, `Profile ${index + 1}`, false).trim() || `Profile ${index + 1}`,
    workflow: isObj(item.workflow) ? clone(item.workflow) : {},
    parameterMap: Object.fromEntries(Object.entries(isObj(item.parameterMap) ? item.parameterMap : {}).map(([key, path]) => [key, str(path, '', false).trim()]).filter(([, path]) => path)),
    defaults: isObj(item.defaults) ? clone(item.defaults) : {},
    constraints: isObj(item.constraints) ? clone(item.constraints) : {},
    outputNodeId: str(item.outputNodeId, '', false).trim() || undefined,
    stitch: isObj(item.stitch) ? {
      enabled: bool((item.stitch as R).enabled, true),
      quality: clamp((item.stitch as R).quality, 70, 1, 100, true),
      columns: clamp((item.stitch as R).columns, 0, 0, 8, true),
      gap: clamp((item.stitch as R).gap, 16, 0, 128, true),
      label: bool((item.stitch as R).label, true),
      scale: clamp((item.stitch as R).scale, 1, 0.1, 2),
      maxWidth: clamp((item.stitch as R).maxWidth, 4096, 128, 8192, true),
      maxHeight: clamp((item.stitch as R).maxHeight, 4096, 128, 8192, true),
      background: str((item.stitch as R).background, '#111827', false).trim() || '#111827',
    } : undefined,
    transform: isObj(item.transform) ? {
      enabled: bool((item.transform as R).enabled, true),
      nodeIndex: clamp((item.transform as R).nodeIndex, 0, 0, 999, true),
      model: str((item.transform as R).model, '', false).trim(),
      timeoutMs: clamp((item.transform as R).timeoutMs, 20000, 3000, 120000, true),
      maxTokens: clamp((item.transform as R).maxTokens, 1200, 256, 8192, true),
      promptTemplate: str((item.transform as R).promptTemplate, '', false),
    } : undefined,
    lora: normComfyLora(item.lora),
    promptPolicy: inferComfyUiPromptPolicy(item.id, item.name, item.promptPolicy),
  })) : [];
  if (!profiles.length) {
    warnings.push('ComfyUI 节点没有 profiles，已补入空 profile。');
    profiles = [{ id: 'default', name: '默认工作流', workflow: {}, parameterMap: {}, defaults: {}, constraints: {}, outputNodeId: undefined, stitch: undefined, promptPolicy: defaultComfyUiPromptPolicy(), transform: undefined, lora: undefined }];
  }
  return {
    profiles,
    pollTimeoutMs: clamp(raw.pollTimeoutMs, 600000, 10000, 1800000, true),
    pollIntervalMs: clamp(raw.pollIntervalMs, 2000, 250, 30000, true),
    maxBatchSize: clamp(raw.maxBatchSize, 4, 1, 16, true),
    maxConcurrent: clamp(raw.maxConcurrent, 1, 1, 8, true),
    maxQueue: clamp(raw.maxQueue, 10, 0, 100, true),
    queueTimeoutMs: clamp(raw.queueTimeoutMs, 900000, 10000, 3600000, true),
  };
}

function normNodes(v: unknown, warnings: string[]): ApiNode[] { const src = Array.isArray(v) ? v : DEFAULT_CONFIG.llm.apiKeys; const out = src.filter(isObj).map((n, i) => { const credentials = normalizeApiNodeCredentials(str(n.baseUrl, ''), str(n.key, '')); const kind: 'llm' | 'comfyui' = n.kind === 'comfyui' ? 'comfyui' : 'llm'; return { name: str(n.name, `节点 ${i + 1}`, false), provider: str(n.provider, '', false).trim(), kind, comfyui: kind === 'comfyui' ? normComfyui(n.comfyui, warnings) : undefined, baseUrl: credentials.baseUrl, key: credentials.key, enabled: bool(n.enabled, true), models: list(n.models), modelsFetchedAt: str(n.modelsFetchedAt, ''), headers: normHeaders(n.headers), concurrency: clamp(n.concurrency, 0, 0, 256, true) }; }); if (!out.length) { warnings.push('llm.apiKeys 为空或格式错误，已补入默认节点。'); return clone(DEFAULT_CONFIG.llm.apiKeys); } return out; }
/**
 * 旧配置把并发限制按「节点 + 模型」逐条存。实际运维里没人真按模型限流——
 * 上游的并发额度是按 key（也就是节点）发的，按模型拆只会让一张表摊出几十行还谁都不敢填。
 * 折叠成节点级：取该节点下最大的那条，然后把旧字段丢掉。
 */
function foldModelLimitsIntoNodes(llm: R, m: MigrationNotice[]): void {
  const limits = Array.isArray(llm.modelLimits) ? llm.modelLimits : undefined;
  if (!limits) return;
  const nodes = Array.isArray(llm.apiKeys) ? llm.apiKeys : [];
  for (const rule of limits) {
    if (!isObj(rule) || rule.enabled === false) continue;
    const idx = Number(rule.nodeIndex);
    const value = Number(rule.concurrency);
    if (!Number.isFinite(idx) || !Number.isFinite(value) || value <= 0) continue;
    const node = nodes[idx];
    if (!isObj(node)) continue;
    const current = Number(node.concurrency);
    node.concurrency = Number.isFinite(current) && current > 0 ? Math.max(current, value) : value;
  }
  delete llm.modelLimits;
  if (limits.length) m.push(notice('llm.modelLimits-to-apiKeys.concurrency'));
}
function normCapabilityOverrides(v: unknown): ConfigCapabilityOverride[] { const ALLOWED = ['chat', 'vision', 'interrogate', 'image.generate', 'image.edit', 'video.generate']; return Array.isArray(v) ? v.filter(isObj).map(r => ({ model: str(r.model, ''), operations: Array.isArray(r.operations) ? r.operations.map(o => String(o || '').trim()).filter(o => ALLOWED.includes(o)) : undefined })).filter(r => r.model && (!r.operations || r.operations.length)) : []; }
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
  const match = combined.match(/(https?:\/\/[^\s，,；;]+?)(?:\s*[-—–]\s*|\s+)?(?:密钥|key|api[_\s-]*key|token)[:：=\s-]*([^\s,;]+)/i);
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

