import { CapabilityRegistry, createCapabilityRegistry } from './capability/registry.js';
import { anthropicDialect } from './dialects/anthropic.js';
import { customDialect } from './dialects/custom.js';
import { geminiDialect } from './dialects/gemini.js';
import { huggingFaceDialect } from './dialects/huggingface.js';
import { openAiDialect } from './dialects/openai.js';
import { defaultFetchTransport } from './transport.js';
import {
  ModelError,
  type ChatRequest,
  type Dialect,
  type HttpResponse,
  type ImageEditRequest,
  type ImageGenerationRequest,
  type ImageResult,
  type ModelNode,
  type ModelOperation,
  type ProviderDialect,
  type RequestPlan,
  type TextResult,
  type Transport,
  type VisionRequest,
} from './ports.js';

const DIALECTS: Record<ProviderDialect, Dialect> = {
  openai: openAiDialect,
  anthropic: anthropicDialect,
  gemini: geminiDialect,
  huggingface: huggingFaceDialect,
  custom: customDialect,
};

export function dialectFor(node: ModelNode): Dialect {
  return DIALECTS[node.dialect || 'openai'] || openAiDialect;
}

export interface ModelClientLogger {
  warn?: (message: string, meta?: unknown) => void;
  info?: (message: string, meta?: unknown) => void;
  error?: (message: string, meta?: unknown) => void;
}

export interface ModelClientOptions {
  nodes: ModelNode[];
  registry?: CapabilityRegistry;
  transport?: Transport;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  failover?: boolean;
  /** failover 选中其它节点后是否回调（用于上层记录，但不强制持久化）。 */
  onFailover?: (info: { op: ModelOperation; model: string; fromIndex: number; toIndex: number; error: unknown }) => void;
  logger?: ModelClientLogger;
}

export interface InterrogateRequest {
  model: string;
  imageUrls: string[];
  prompt?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

const DEFAULT_INTERROGATE_PROMPT = '请分析这张图片，并反推一段适合图像生成模型复现它的提示词。';

export class ModelClient {
  private readonly nodes: ModelNode[];
  private readonly registry: CapabilityRegistry;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly failover: boolean;
  private readonly onFailover?: ModelClientOptions['onFailover'];
  private readonly logger?: ModelClientLogger;

  constructor(options: ModelClientOptions) {
    this.nodes = options.nodes || [];
    this.registry = options.registry || createCapabilityRegistry();
    this.transport = options.transport || defaultFetchTransport;
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 60000));
    this.retries = Math.max(0, Math.trunc(options.retries ?? 0));
    this.retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? 0));
    this.failover = options.failover !== false;
    this.onFailover = options.onFailover;
    this.logger = options.logger;
  }

  capabilitiesOf(model: string): ModelOperation[] {
    return this.registry.operationsOf(model);
  }
  can(model: string, op: ModelOperation): boolean {
    return this.registry.can(model, op);
  }

  async chat(nodeIndex: number, req: ChatRequest): Promise<TextResult> {
    return this.run('chat', nodeIndex, req.model, req.timeoutMs, (d, n) => d.buildChat(n, req), (d, data) => d.parseChat(data));
  }
  async vision(nodeIndex: number, req: VisionRequest): Promise<TextResult> {
    const resolved = await this.resolveImageUrls(nodeIndex, req.imageUrls);
    const r = resolved !== req.imageUrls ? { ...req, imageUrls: resolved } : req;
    return this.run('vision', nodeIndex, r.model, r.timeoutMs,
      (d, n) => requireBuilder(d, 'buildVision', n, r), (d, data) => d.parseChat(data));
  }
  async interrogate(nodeIndex: number, req: InterrogateRequest): Promise<TextResult> {
    const resolved = await this.resolveImageUrls(nodeIndex, req.imageUrls);
    const r = resolved !== req.imageUrls ? { ...req, imageUrls: resolved } : req;
    return this.run('interrogate', nodeIndex, r.model, r.timeoutMs,
      (d, n) => requireBuilder(d, 'buildVision', n, { model: r.model, prompt: r.prompt || DEFAULT_INTERROGATE_PROMPT, imageUrls: r.imageUrls, maxTokens: r.maxTokens, timeoutMs: r.timeoutMs }),
      (d, data) => d.parseChat(data));
  }
  async generateImages(nodeIndex: number, req: ImageGenerationRequest): Promise<ImageResult> {
    const shaped = this.shapeImageGeneration(req);
    return this.run('image.generate', nodeIndex, shaped.model, shaped.timeoutMs,
      (d, n) => requireBuilder(d, 'buildImageGeneration', n, shaped), (d, data) => requireImageParser(d, data));
  }
  async editImage(nodeIndex: number, req: ImageEditRequest): Promise<ImageResult> {
    const shaped = this.shapeImageEdit(req);
    return this.run('image.edit', nodeIndex, shaped.model, shaped.timeoutMs,
      (d, n) => requireBuilder(d, 'buildImageEdit', n, shaped), (d, data) => requireImageParser(d, data));
  }

  /** 按模型能力档案规整生图参数：不支持的 size/quality 剔除、count 钳到上限，避免对上游盲发导致 4xx。 */
  private shapeImageGeneration(req: ImageGenerationRequest): ImageGenerationRequest {
    const profile = this.registry.profileOf(req.model);
    const out: ImageGenerationRequest = { ...req };
    out.count = profile.supportsCount === false ? 1 : clampImageCount(req.count, profile.maxImagesPerRequest);
    if (profile.supportsQuality === false) delete out.quality;
    applySizeProfile(out, profile);
    return out;
  }

  /** 按模型能力档案规整改图参数：不支持的 size/quality/mask 剔除。 */
  private shapeImageEdit(req: ImageEditRequest): ImageEditRequest {
    const profile = this.registry.profileOf(req.model);
    const out: ImageEditRequest = { ...req };
    if (profile.supportsQuality === false) delete out.quality;
    if (profile.supportsMask === false) delete out.mask;
    applySizeProfile(out, profile);
    return out;
  }

  private async run<T>(
    op: ModelOperation,
    nodeIndex: number,
    model: string,
    timeoutMs: number | undefined,
    build: (dialect: Dialect, node: ModelNode) => RequestPlan,
    parse: (dialect: Dialect, data: unknown) => T,
  ): Promise<T> {
    // 能力校验：模型档案不支持该操作直接报错（不盲发）。
    if (!this.registry.can(model, op)) {
      throw new ModelError(`模型 "${model}" 不具备能力 ${op}`, { category: 'validation', retryable: false, code: 'capability_unsupported' });
    }
    const primary = this.resolveIndex(nodeIndex);
    try {
      return await this.execute(op, primary, model, timeoutMs, build, parse);
    } catch (error) {
      if (!this.failover || !shouldFailover(error)) throw error;
      const candidates = this.failoverCandidates(primary, model);
      let lastError = error;
      for (const idx of candidates) {
        try {
          const result = await this.execute(op, idx, model, timeoutMs, build, parse);
          this.onFailover?.({ op, model, fromIndex: primary, toIndex: idx, error });
          this.logger?.warn?.('model failover succeeded', { op, model, fromIndex: primary, toIndex: idx });
          return result;
        } catch (candidateError) {
          lastError = candidateError;
        }
      }
      throw lastError;
    }
  }

  private async execute<T>(
    op: ModelOperation,
    nodeIndex: number,
    model: string,
    timeoutMs: number | undefined,
    build: (dialect: Dialect, node: ModelNode) => RequestPlan,
    parse: (dialect: Dialect, data: unknown) => T,
  ): Promise<T> {
    const node = this.nodes[nodeIndex];
    if (!node) throw new ModelError(`节点索引 ${nodeIndex} 不存在`, { category: 'validation', retryable: false });
    const dialect = dialectFor(node);
    if (!dialect.supports(op)) {
      throw new ModelError(`方言 ${dialect.id} 不支持操作 ${op}`, { category: 'validation', retryable: false, code: 'dialect_unsupported' });
    }
    const plan = build(dialect, node);
    const resolvedTimeout = Math.max(1, Math.trunc(timeoutMs ?? this.timeoutMs));
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.transport({ ...plan, timeoutMs: resolvedTimeout });
        if (response.status >= 400) throw errorFromResponse(response);
        return parse(dialect, response.data);
      } catch (error) {
        if (attempt < this.retries && shouldFailover(error)) {
          attempt += 1;
          if (this.retryDelayMs) await delay(this.retryDelayMs);
          continue;
        }
        throw error;
      }
    }
  }

  private resolveIndex(index: number): number {
    const i = Math.trunc(Number(index) || 0);
    const node = this.nodes[i];
    if (node && node.enabled !== false && String(node.baseUrl || '').trim()) return i;
    const fallback = this.nodes.findIndex((n) => n.enabled !== false && String(n.baseUrl || '').trim());
    return fallback >= 0 ? fallback : i;
  }

  /**
   * Gemini 方言不收 http(s) 图片 URL(只认 fileUri/gs://),需下载转 base64 data URL。
   * 其它方言(OpenAI/Anthropic/custom)直接收 http URL,无需下载。
   * 下载失败时保留原 URL(让上游报错,至少有明确错误信息)。
   */
  private async resolveImageUrls(nodeIndex: number, imageUrls: string[] | undefined): Promise<string[]> {
    if (!Array.isArray(imageUrls) || !imageUrls.length) return imageUrls || [];
    const idx = this.resolveIndex(nodeIndex);
    const node = this.nodes[idx];
    if (!node) return imageUrls;
    const dialect = dialectFor(node);
    if (dialect.id !== 'gemini') return imageUrls;
    // Gemini: 把 http(s):// URL 下载为 data: base64,非 http 的(data:/base64:/file:)原样保留。
    const needsDownload = imageUrls.some((u) => /^https?:\/\//i.test(String(u || '')));
    if (!needsDownload) return imageUrls;
    const resolved: string[] = [];
    for (const url of imageUrls) {
      const u = String(url || '').trim();
      if (!u) continue;
      if (!/^https?:\/\//i.test(u)) { resolved.push(u); continue; }
      try {
        const res = await fetch(u);
        if (!res.ok) { resolved.push(u); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get('content-type') || 'image/png';
        resolved.push(`data:${mime};base64,${buf.toString('base64')}`);
      } catch {
        // 下载失败保留原 URL,上游会报错(比静默丢图好)
        resolved.push(u);
      }
    }
    return resolved;
  }

  /** 方言感知 failover：其它启用节点中、声明了同名模型的，按顺序作为候选（各自用自己的方言）。 */
  private failoverCandidates(currentIndex: number, model: string): number[] {
    const expected = String(model || '').trim().toLowerCase();
    if (!expected) return [];
    return this.nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node, index }) => index !== currentIndex
        && node.enabled !== false
        && String(node.baseUrl || '').trim()
        && Array.isArray(node.models)
        && node.models.some((m) => String(m || '').trim().toLowerCase() === expected))
      .map(({ index }) => index);
  }
}

export function createModelClient(options: ModelClientOptions): ModelClient {
  return new ModelClient(options);
}

function clampImageCount(count: number | undefined, max?: number): number {
  const ceiling = Math.max(1, Math.trunc(max ?? 16));
  return Math.min(ceiling, Math.max(1, Math.trunc(count ?? 1)));
}

function applySizeProfile(req: { size?: string }, profile: { supportsSize?: boolean; sizes?: string[] }): void {
  if (profile.supportsSize === false) { delete req.size; return; }
  if (req.size && profile.sizes && profile.sizes.length) {
    const ok = profile.sizes.some((s) => s.toLowerCase() === String(req.size).toLowerCase());
    if (!ok) delete req.size; // 未列入档案的尺寸交给上游默认，避免报错
  }
}

function requireBuilder(dialect: Dialect, method: 'buildVision' | 'buildImageGeneration' | 'buildImageEdit', node: ModelNode, req: any): RequestPlan {
  const fn = (dialect as any)[method] as ((n: ModelNode, r: any) => RequestPlan) | undefined;
  if (typeof fn !== 'function') throw new ModelError(`方言 ${dialect.id} 未实现 ${method}`, { category: 'validation', retryable: false, code: 'dialect_unsupported' });
  return fn.call(dialect, node, req);
}

function requireImageParser(dialect: Dialect, data: unknown): ImageResult {
  if (typeof dialect.parseImage !== 'function') throw new ModelError(`方言 ${dialect.id} 未实现 parseImage`, { category: 'validation', retryable: false });
  return dialect.parseImage(data);
}

function shouldFailover(error: unknown): boolean {
  if (error instanceof ModelError) {
    if (error.category === 'validation') return false;
    if (error.retryable) return true;
    const s = error.status || 0;
    return [408, 409, 429, 500, 502, 503, 504, 401, 403, 404].includes(s) || ['network', 'timeout', 'upstream'].includes(error.category);
  }
  return true; // 未知错误（网络等）默认可转移
}

function errorFromResponse(response: HttpResponse): ModelError {
  const data: any = response.data;
  const err = data && typeof data === 'object' ? (data.error ?? data) : data;
  const message = typeof err === 'string' ? err : String(err?.message || `HTTP ${response.status}`);
  return new ModelError(message, { category: 'upstream', retryable: response.status >= 500 || response.status === 429, status: response.status });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
