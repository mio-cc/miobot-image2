import type { PackageDescriptor } from '@miobot-v2/shared';

export const MODEL_PACKAGE: PackageDescriptor = { name: '@miobot-v2/model', phase: 'P2-model' };

/** 模型能力维度。 */
export type ModelOperation = 'chat' | 'vision' | 'image.generate' | 'image.edit' | 'interrogate';

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
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
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
  timeoutMs?: number;
}

export interface ImageEditRequest {
  model: string;
  prompt: string;
  images: string[];
  mask?: string;
  size?: string;
  quality?: string;
  timeoutMs?: number;
}

export interface TextResult { text: string; raw: unknown; status?: number }

export type ImageArtifactKind = 'base64' | 'url';
export interface ImageArtifact { kind: ImageArtifactKind; data: string; mimeType?: string; revisedPrompt?: string; index: number }
export interface ImageResult { images: ImageArtifact[]; raw: unknown; status?: number }

/** 方言生成的一次 HTTP 请求计划（纯数据，便于单测）。 */
export interface RequestPlan {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** body 为 FormData 时为 true（multipart，跳过 JSON.stringify）。 */
  multipart?: boolean;
}

export interface HttpRequest extends RequestPlan { timeoutMs: number }
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
  parseChat(data: unknown): TextResult;
  buildVision?(node: ModelNode, req: VisionRequest): RequestPlan;
  buildImageGeneration?(node: ModelNode, req: ImageGenerationRequest): RequestPlan;
  buildImageEdit?(node: ModelNode, req: ImageEditRequest): RequestPlan;
  parseImage?(data: unknown): ImageResult;
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
