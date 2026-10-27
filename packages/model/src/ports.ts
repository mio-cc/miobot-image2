import type { PackageDescriptor } from '@miobot-v2/shared';
import type { ProviderToolChoice, ProviderToolIssue, ProviderToolProtocol } from '../../provider-tools/src/index.js';
import type { ToolSpec } from '../../tool-runtime/src/index.js';

export const MODEL_PACKAGE: PackageDescriptor = { name: '@miobot-v2/model', phase: 'P2-model' };

/**
 * 模型能力维度。
 * `video.generate`：xAI Grok Imagine Video 等（POST /videos/generations + GET /videos/{id} 轮询）。
 */
export type ModelOperation = 'chat' | 'vision' | 'image.generate' | 'image.edit' | 'interrogate' | 'video.generate';

/** 节点说话用的协议方言。 */
export type ProviderDialect = 'openai' | 'anthropic' | 'gemini' | 'huggingface' | 'custom';

export type HuggingFaceRequestMode = 'openai-chat' | 'router-chat' | 'legacy-inference' | 'provider-task';

/** 自定义方言：用模板把统一请求映射到任意 endpoint / 字段。 */
export interface CustomDialectSpec {
  chatPath?: string;            // 相对 baseUrl，默认 /chat/completions
  imagePath?: string;
  editPath?: string;
  authHeader?: string;          // 默认 Authorization
  authPrefix?: string;          // 默认 "Bearer "
  /** 从响应里取文本的 JSON 路径（点分），默认尝试 choices[0].message.content / output_text。 */
  textPath?: string;
  /** 取图片数组的 JSON 路径，默认 data。 */
  imagesPath?: string;
}

/** 一个上游节点（endpoint）。 */
export interface ModelNode {
  name?: string;
  dialect?: ProviderDialect;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  requestMode?: HuggingFaceRequestMode; // huggingface
  custom?: CustomDialectSpec;           // custom
  models?: string[];                    // 该节点声明可用的模型（供 failover 选择同名模型）
  enabled?: boolean;
  /** 该节点同时在飞的请求上限；0/缺省 = 不限制。 */
  concurrency?: number;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ModelToolProtocol = 'auto' | ProviderToolProtocol;
export type ModelToolChoice = ProviderToolChoice;

export interface ChatMessage {
  role: string;
  content: unknown;
  /** Provider-neutral assistant tool calls. */
  toolCalls?: ToolCall[];
  /** Provider-neutral tool result correlation id. */
  toolCallId?: string;
  name?: string;
}

export interface ChatParseContext {
  toolProtocol?: ProviderToolProtocol;
  toolNames?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
  maxTokens?: number;
  /** 上层 turn 超时信号；provider transport 应尽快 abort。 */
  signal?: AbortSignal;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /** Legacy raw provider tools. Kept for compatible callers. */
  tools?: unknown[];
  toolChoice?: unknown;
  /** R2 canonical tool loadout. When present, dialects build provider-native declarations. */
  toolSpecs?: ToolSpec[];
  /** auto selects native where supported; json-fallback never uses native tools. */
  toolProtocol?: ModelToolProtocol;
}

export interface VisionRequest {
  model: string;
  prompt: string;
  imageUrls: string[];
  timeoutMs?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  size?: string;
  count?: number;
  quality?: string;
  /** xAI Grok Imagine 等使用的宽高比(如 16:9),与 OpenAI size 互斥时由方言决定如何发送。 */
  aspectRatio?: string;
  /** xAI Grok Imagine 分辨率:1k / 2k。 */
  resolution?: string;
  timeoutMs?: number;
}

export interface ImageEditRequest {
  model: string;
  prompt: string;
  images: string[];
  mask?: string;
  size?: string;
  quality?: string;
  aspectRatio?: string;
  resolution?: string;
  timeoutMs?: number;
  /**
   * 用户在后台强制指定的请求形态。auto = 按模型自动排序（默认）。
   * 中转的兼容性千奇百怪，自动判断必然有猜错的时候，得给用户一个手动挡。
   */
  requestMode?: 'auto' | 'json-images' | 'json-image' | 'multipart';
}

/**
 * 视频生成请求。
 * xAI: POST /v1/videos/generations → request_id，再 GET /v1/videos/{id} 轮询至 done。
 * ModelClient.generateVideo 内部完成轮询，对调用方表现为拿到视频 URL。
 *
 * QQ/Napcat 注意：短视频消息对时长/大小/编码有限制（常见约数十秒内、MP4/H.264）；
 * 超限时可能需改发文件段，或压缩后再发。
 */
export interface VideoGenerationRequest {
  model: string;
  prompt: string;
  /** 参考图 URL / data URL(image-to-video)。 */
  imageUrl?: string;
  /** 秒数；xAI 允许 1–15。 */
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  /** 单次 HTTP（提交/轮询）超时。 */
  timeoutMs?: number;
  /**
   * 异步轮询总等待上限（默认 600000ms = 10 分钟，对齐 xAI SDK pollTimeout）。
   * 超时抛 ModelError(category=timeout, code=video_poll_timeout)。
   */
  pollTimeoutMs?: number;
  /** 轮询间隔（默认 5000ms，对齐官方 REST 示例）。 */
  pollIntervalMs?: number;
  /** 提交后拿到 request_id 时立即回调，供上层持久化外部任务 ID。 */
  onExternalTask?: (taskId: string) => void;
  /**
   * 为 true 时不自动轮询，直接返回 pending/requestId（单测或上层自管轮询用）。
   * 默认 false：对调用方表现为「拿到视频 URL 即完成」。
   */
  waitForCompletion?: boolean;
}

/** T3.6：一次文本调用的 token 用量与（中转回传时的）成本。 */
export interface TextUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

/** T3.2：FC 出参——message.tool_calls 的规范化形态（arguments 已解析为对象）。 */
/** T3.2：FC 出参——message.tool_calls 的规范化形态（arguments 已解析为对象）。 */
export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Original provider argument JSON, retained for schema repair diagnostics. */
  rawArguments?: string;
  parseError?: string;
}

export interface TextResult {
  text: string;
  raw: unknown;
  status?: number;
  usage?: TextUsage;
  toolCalls?: ToolCall[];
  toolCallIssues?: ProviderToolIssue[];
  finishReason?: string;
  truncated?: boolean;
}

export type ImageArtifactKind = 'base64' | 'url';
export interface ImageArtifact { kind: ImageArtifactKind; data: string; mimeType?: string; revisedPrompt?: string; index: number }
export interface ImageResult { images: ImageArtifact[]; raw: unknown; status?: number }

export type VideoArtifactKind = 'url' | 'base64';
export interface VideoArtifact {
  kind: VideoArtifactKind;
  data: string;
  mimeType?: string;
  /** 异步任务 id(若上游返回 request_id / id 而非即时视频)。 */
  requestId?: string;
  index: number;
}
/** xAI 轮询状态：pending | done | failed | expired（及兼容 processing）。 */
export type VideoJobStatus = 'pending' | 'done' | 'failed' | 'expired' | 'unknown';
export interface VideoResult {
  videos: VideoArtifact[];
  raw: unknown;
  status?: number;
  /** 上游异步:true 表示 videos 可能只有 requestId（waitForCompletion=false 时）。 */
  pending?: boolean;
  /** 轮询响应里的 status 字段（若有）。 */
  jobStatus?: VideoJobStatus;
}

/** 方言生成的一次 HTTP 请求计划（纯数据，便于单测）。 */
export interface RequestPlan {
  /** GET 用于视频状态轮询（xAI GET /videos/{request_id}）。 */
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** body 为 FormData 时为 true（multipart，跳过 JSON.stringify）。 */
  multipart?: boolean;
}

export interface HttpRequest extends RequestPlan { timeoutMs: number; signal?: AbortSignal }
export interface HttpResponse<T = unknown> { status: number; data: T; headers?: Record<string, string> }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * 方言 = 把统一请求构造成 RequestPlan + 把响应解析成统一结果。
 * 不做网络与重试（交给 ModelClient），便于纯函数单测。
 */
export interface Dialect {
  readonly id: ProviderDialect;
  /** 该方言在协议层是否声明支持某操作（与"具体模型能力"不同）。 */
  supports(op: ModelOperation): boolean;
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan;
  parseChat(data: unknown, context?: ChatParseContext): TextResult;
  buildVision?(node: ModelNode, req: VisionRequest): RequestPlan;
  buildImageGeneration?(node: ModelNode, req: ImageGenerationRequest): RequestPlan;
  buildImageEdit?(node: ModelNode, req: ImageEditRequest): RequestPlan;
  parseImage?(data: unknown): ImageResult;
  /** 视频生成：POST /videos/generations（xAI 等）。 */
  buildVideoGeneration?(node: ModelNode, req: VideoGenerationRequest): RequestPlan;
  /** 视频任务状态轮询：GET /videos/{requestId}。未实现时 ModelClient 用 OpenAI 兼容默认。 */
  buildVideoStatus?(node: ModelNode, requestId: string): RequestPlan;
  parseVideo?(data: unknown): VideoResult;
}

export class ModelError extends Error {
  readonly category: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, opts: { category?: string; retryable?: boolean; status?: number; code?: string } = {}) {
    super(message);
    this.name = 'ModelError';
    this.category = opts.category || 'upstream';
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.code = opts.code;
  }
}
