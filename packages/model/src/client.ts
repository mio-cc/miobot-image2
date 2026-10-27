import { extractTextUsage } from './usage.js';
import { CapabilityRegistry, createCapabilityRegistry } from './capability/registry.js';
import { applyFix, applyLearned, diagnose, healingKey, rememberFix } from './capability/healing.js';
import { imageEditTransportsFor } from './capability/params.js';
import { NodeConcurrencyGate } from './gate.js';
import { buildMultipartImageEdit, resolveImageBytes } from './dialects/multipart.js';
import { anthropicDialect } from './dialects/anthropic.js';
import { customDialect } from './dialects/custom.js';
import { geminiDialect } from './dialects/gemini.js';
import { huggingFaceDialect } from './dialects/huggingface.js';
import { openAiDialect } from './dialects/openai.js';
import { defaultFetchTransport } from './transport.js';
import { buildOpenAiVideoStatus } from './dialects/shared.js';
import { parseContextForRequest } from './dialects/tool-support.js';
import { classifyProviderResponse } from './provider-errors.js';
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
  type VideoArtifact,
  type VideoGenerationRequest,
  type VideoResult,
  type VisionRequest,
} from './ports.js';

/** 视频异步轮询默认：总等待 10 分钟、间隔 5 秒（对齐 xAI REST 示例 / SDK pollTimeout）。 */
const DEFAULT_VIDEO_POLL_TIMEOUT_MS = 600_000;
const DEFAULT_VIDEO_POLL_INTERVAL_MS = 5_000;
/** 单次请求最多因参数问题自愈几轮，防止上游把参数一个个拒过来时打转。 */
const MAX_PARAM_HEALING_ATTEMPTS = 3;

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
  /**
   * 节点表。传函数则**每次访问都现读**——配置热重载后立刻生效。
   *
   * 传数组等于把装配那一刻的值定死：换 key、改 baseUrl、增删节点后
   * 客户端仍然用旧值发请求，而面板还会显示「配置已热重载生效」。
   * 全新部署最惨——快照下来的是空 baseUrl 和空 key，填完节点保存后依旧必然失败。
   */
  nodes: ModelNode[] | (() => ModelNode[]);
  /** 同理：传函数可让 capabilityOverrides 的改动即时生效。 */
  registry?: CapabilityRegistry | (() => CapabilityRegistry);
  transport?: Transport;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  failover?: boolean;
  /** failover 选中其它节点后是否回调（用于上层记录，但不强制持久化）。 */
  onFailover?: (info: { op: ModelOperation; model: string; fromIndex: number; toIndex: number; error: unknown }) => void;
  logger?: ModelClientLogger;
  /**
   * 实时读取某节点的并发上限（0/undefined = 不限制）。
   * 单独给一个函数而不是只读 node.concurrency：节点表是构造时的快照，
   * 用户在后台把并发从 4 改成 1 后必须立刻生效，不能等到进程重启。
   */
  getNodeConcurrency?: (nodeIndex: number) => number | undefined;
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
  private readonly nodesSource: () => ModelNode[];
  private readonly registrySource: () => CapabilityRegistry;

  // 用 getter 包一层，下面十几处 this.nodes / this.registry 的写法一个字都不用改。
  private get nodes(): ModelNode[] { return this.nodesSource() || []; }
  private get registry(): CapabilityRegistry { return this.registrySource(); }
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly failover: boolean;
  private readonly onFailover?: ModelClientOptions['onFailover'];
  private readonly logger?: ModelClientLogger;
  private readonly getNodeConcurrency?: ModelClientOptions['getNodeConcurrency'];
  private readonly gate = new NodeConcurrencyGate();

  constructor(options: ModelClientOptions) {
    const nodes = options.nodes;
    this.nodesSource = typeof nodes === 'function' ? nodes : () => nodes || [];
    const registry = options.registry;
    if (typeof registry === 'function') {
      this.registrySource = registry;
    } else {
      const fixed = registry || createCapabilityRegistry();
      this.registrySource = () => fixed;
    }
    this.transport = options.transport || defaultFetchTransport;
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 60000));
    this.retries = Math.max(0, Math.trunc(options.retries ?? 0));
    this.retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? 0));
    this.failover = options.failover !== false;
    this.onFailover = options.onFailover;
    this.logger = options.logger;
    this.getNodeConcurrency = options.getNodeConcurrency;
  }

  capabilitiesOf(model: string): ModelOperation[] {
    return this.registry.operationsOf(model);
  }
  can(model: string, op: ModelOperation): boolean {
    return this.registry.can(model, op);
  }

  async chat(nodeIndex: number, req: ChatRequest): Promise<TextResult> {
    const parseContext = parseContextForRequest(req);
    return this.run('chat', nodeIndex, req.model, req.timeoutMs, (d, n) => d.buildChat(n, req), ModelClient.withUsage((d, data) => d.parseChat(data, parseContext)));
  }
  /** T3.6：文本类调用统一在解析后补挂 usage（方言未提取时从原始响应兜底抓取）。 */
  private static withUsage(parse: (dialect: Dialect, data: unknown) => TextResult): (dialect: Dialect, data: unknown) => TextResult {
    return (dialect, data) => {
      const result = parse(dialect, data);
      return result.usage ? result : { ...result, usage: extractTextUsage(data) };
    };
  }
  async vision(nodeIndex: number, req: VisionRequest): Promise<TextResult> {
    const resolved = await this.resolveImageUrls(nodeIndex, req.imageUrls);
    const r = resolved !== req.imageUrls ? { ...req, imageUrls: resolved } : req;
    return this.run('vision', nodeIndex, r.model, r.timeoutMs,
      (d, n) => requireBuilder(d, 'buildVision', n, r), ModelClient.withUsage((d, data) => d.parseChat(data)));
  }
  async interrogate(nodeIndex: number, req: InterrogateRequest): Promise<TextResult> {
    const resolved = await this.resolveImageUrls(nodeIndex, req.imageUrls);
    const r = resolved !== req.imageUrls ? { ...req, imageUrls: resolved } : req;
    return this.run('interrogate', nodeIndex, r.model, r.timeoutMs,
      (d, n) => requireBuilder(d, 'buildVision', n, { model: r.model, prompt: r.prompt || DEFAULT_INTERROGATE_PROMPT, imageUrls: r.imageUrls, maxTokens: r.maxTokens, timeoutMs: r.timeoutMs }),
      ModelClient.withUsage((d, data) => d.parseChat(data)));
  }
  async generateImages(nodeIndex: number, req: ImageGenerationRequest): Promise<ImageResult> {
    const shaped = this.shapeImageGeneration(req);
    return this.run('image.generate', nodeIndex, shaped.model, shaped.timeoutMs,
      (d, n) => requireBuilder(d, 'buildImageGeneration', n, shaped), (d, data) => requireImageParser(d, data));
  }
  /**
   * 改图。请求体形态按模型决定：
   * 官方 /images/edits 只接受 multipart/form-data（JSON 会被直接拒），
   * 而 xAI 官方文档明确说不支持 multipart。顺序排错会让每次改图都先白白失败一轮。
   */
  async editImage(nodeIndex: number, req: ImageEditRequest): Promise<ImageResult> {
    const shaped = this.shapeImageEdit(req);
    // 解析一次并一路用下去：闸门必须记在**真正会发请求的那个节点**上，
    // 否则传进来的下标指向停用节点时，闸门记到了一个根本不发请求的槽上，
    // 目标节点的并发上限被完全绕过。
    const primary = this.resolveIndex(nodeIndex);
    const node = this.nodes[primary];
    const dialect = node ? dialectFor(node) : undefined;

    // 只有 OpenAI 兼容方言存在 JSON / multipart 之分；其它方言（gemini 原生等）走自己的实现。
    // requestMode 是用户在后台的手动挡：面板上那个下拉框以前对这里完全无效，
    // 中转把形态猜错时用户没有任何办法纠正。
    const mode = shaped.requestMode || 'auto';
    const wantsMultipartFirst = dialect?.id === 'openai'
      && (mode === 'multipart' || (mode === 'auto' && imageEditTransportsFor(shaped.model)[0] === 'multipart'));

    if (wantsMultipartFirst && node) {
      try {
        return await this.editImageMultipart(primary, shaped, node);
      } catch (error) {
        // 用户明确点了 multipart 就别自作主张退回——那会让「我就要 multipart」失去意义，
        // 也会把真正的失败原因掩盖在一次 JSON 重试后面。
        if (mode === 'multipart') throw error;
        // multipart 明确不被接受时退回 JSON；其余错误照常上抛。
        if (!looksLikeShapeRejection(error)) throw error;
        this.logger?.warn?.('image edit multipart rejected, falling back to JSON', {
          model: shaped.model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.run('image.edit', nodeIndex, shaped.model, shaped.timeoutMs,
      (d, n) => requireBuilder(d, 'buildImageEdit', n, shaped), (d, data) => requireImageParser(d, data));
  }

  /** multipart 改图：先把图片解析成字节（异步），再交给纯函数拼装请求。 */
  private async editImageMultipart(nodeIndex: number, req: ImageEditRequest, node: ModelNode): Promise<ImageResult> {
    if (!this.registry.can(req.model, 'image.edit')) {
      throw new ModelError(`模型 "${req.model}" 不具备能力 image.edit`, { category: 'validation', retryable: false, code: 'capability_unsupported' });
    }
    const images = await Promise.all(req.images.map((ref) => resolveImageBytes(ref)));
    const mask = req.mask ? await resolveImageBytes(req.mask) : undefined;
    const plan = buildMultipartImageEdit(node, req, images, mask);

    const response = await this.gated(nodeIndex, () => this.transport({ ...plan, timeoutMs: Math.max(1, Math.trunc(req.timeoutMs ?? this.timeoutMs)) }));
    if (response.status >= 400) throw errorFromResponse(response);
    return requireImageParser(dialectFor(node), response.data);
  }

  /**
   * 视频生成(xAI grok-imagine-video 等)。
   * 1) POST /videos/generations 拿 request_id（或即时 url）
   * 2) 若 pending 且 waitForCompletion !== false：GET /videos/{id} 轮询至 done/failed/expired/超时
   * 对调用方默认表现为「拿到可播放 URL 即完成」；设 waitForCompletion=false 可只拿 requestId。
   */
  async generateVideo(nodeIndex: number, req: VideoGenerationRequest): Promise<VideoResult> {
    const initial = await this.run('video.generate', nodeIndex, req.model, req.timeoutMs,
      (d, n) => requireBuilder(d, 'buildVideoGeneration', n, req), (d, data) => requireVideoParser(d, data));
    const requestId = initial.videos.find((v) => v.requestId)?.requestId || initial.videos[0]?.requestId;
    if (requestId) req.onExternalTask?.(requestId);
    if (req.waitForCompletion === false) return initial;
    if (!initial.pending) return initial;
    if (!requestId) {
      throw new ModelError('Video generation pending but missing request_id', { category: 'validation', retryable: false, code: 'video_missing_request_id' });
    }
    return this.pollVideoUntilDone(nodeIndex, req, requestId, initial);
  }

  /**
   * R9：崩溃恢复用的单次视频状态探测，不进入轮询循环。
   * 返回 running/failed/expired 或已完成的可播放产物。
   */
  async probeVideo(nodeIndex: number, requestId: string, timeoutMs = 30_000): Promise<{
    status: 'running' | 'success' | 'failed' | 'expired';
    videos?: VideoArtifact[];
    error?: string;
  }> {
    const primary = this.resolveIndex(nodeIndex);
    const node = this.nodes[primary];
    if (!node) throw new ModelError(`节点索引 ${primary} 不存在`, { category: 'validation', retryable: false });
    const dialect = dialectFor(node);
    const plan = typeof dialect.buildVideoStatus === 'function'
      ? dialect.buildVideoStatus(node, requestId)
      : buildOpenAiVideoStatus(node, requestId);
    const response = await this.gated(primary, () => this.transport({ ...plan, timeoutMs: Math.max(1_000, Math.trunc(timeoutMs)) }));
    if (response.status >= 400) throw errorFromResponse(response);
    try {
      const parsed = requireVideoParser(dialect, response.data);
      if (parsed.pending || !parsed.videos.some((video) => String(video.data || '').trim())) return { status: 'running' as const };
      return { status: 'success' as const, videos: parsed.videos };
    } catch (error) {
      if (error instanceof ModelError && error.code === 'video_expired') return { status: 'expired' as const, error: error.message };
      if (error instanceof ModelError && error.code === 'video_failed') return { status: 'failed' as const, error: error.message };
      throw error;
    }
  }

  /**
   * 轮询 GET /videos/{requestId} 直到完成。
   * - done + url → 返回 VideoResult
   * - failed/expired → 抛 ModelError
   * - 超过 pollTimeoutMs → 抛 timeout
   * 有限重试：单次 GET 网络/5xx 可短暂重试，失败态不重试。
   */
  private async pollVideoUntilDone(
    nodeIndex: number,
    req: VideoGenerationRequest,
    requestId: string,
    initial: VideoResult,
  ): Promise<VideoResult> {
    const pollTimeoutMs = Math.max(1_000, Math.trunc(req.pollTimeoutMs ?? DEFAULT_VIDEO_POLL_TIMEOUT_MS));
    const pollIntervalMs = Math.max(200, Math.trunc(req.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS));
    const httpTimeoutMs = Math.max(1, Math.trunc(req.timeoutMs ?? this.timeoutMs));
    const deadline = Date.now() + pollTimeoutMs;
    const primary = this.resolveIndex(nodeIndex);
    const node = this.nodes[primary];
    if (!node) throw new ModelError(`节点索引 ${primary} 不存在`, { category: 'validation', retryable: false });

    let consecutiveTransportErrors = 0;
    const maxTransportErrors = 3;

    while (Date.now() < deadline) {
      await delay(pollIntervalMs);
      if (Date.now() >= deadline) break;

      const dialect = dialectFor(node);
      const plan = typeof dialect.buildVideoStatus === 'function'
        ? dialect.buildVideoStatus(node, requestId)
        : buildOpenAiVideoStatus(node, requestId);

      try {
        const response = await this.gated(primary, () => this.transport({ ...plan, timeoutMs: httpTimeoutMs }));
        if (response.status >= 400) {
          // 404/429/5xx 短暂可恢复；4xx 其它直接失败。
          const err = errorFromResponse(response);
          if (response.status === 404 || response.status === 429 || response.status >= 500) {
            consecutiveTransportErrors += 1;
            if (consecutiveTransportErrors >= maxTransportErrors) throw err;
            this.logger?.warn?.('video poll transient error', { requestId, status: response.status });
            continue;
          }
          throw err;
        }
        consecutiveTransportErrors = 0;
        const parsed = requireVideoParser(dialect, response.data);
        if (!parsed.pending && parsed.videos.some((v) => String(v.data || '').trim())) {
          // 保留 requestId 便于追踪
          const videos = parsed.videos.map((v, index) => ({
            ...v,
            requestId: v.requestId || requestId,
            index: v.index ?? index,
          }));
          this.logger?.info?.('video poll completed', { requestId, model: req.model });
          return { ...parsed, videos, pending: false };
        }
        // 仍 pending：继续轮询
        this.logger?.info?.('video poll pending', { requestId, jobStatus: parsed.jobStatus });
      } catch (error) {
        // 任务终态 / 不可重试校验错误：立即上抛，勿当瞬时网络错误重试。
        if (error instanceof ModelError) {
          if (error.code === 'video_failed' || error.code === 'video_expired' || error.code === 'video_missing_request_id') {
            throw error;
          }
          if (error.category === 'validation' || error.retryable === false) throw error;
        }
        consecutiveTransportErrors += 1;
        if (consecutiveTransportErrors >= maxTransportErrors) throw error;
        this.logger?.warn?.('video poll error, retrying', {
          requestId,
          attempt: consecutiveTransportErrors,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw new ModelError(`Video generation timed out after ${pollTimeoutMs}ms (request_id=${requestId})`, {
      category: 'timeout',
      retryable: true,
      code: 'video_poll_timeout',
    });
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
      if (isGenerationTimeout(op, error)) throw error;
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
    const healKey = healingKey(node, model);

    // 先套用之前学到的结论：这个「节点 + 模型」已知不认识哪些参数、哪些要改名。
    // multipart 的 body 是 FormData，不参与自愈。
    let body = plan.multipart ? plan.body : applyLearned(healKey, plan.body);
    let attempt = 0;
    let healed = 0;

    for (;;) {
      try {
        const response = await this.gated(nodeIndex, () => this.transport({ ...plan, body, timeoutMs: resolvedTimeout }));
        if (response.status >= 400) {
          // 参数问题：剔除或按上游提示改名后重试，并记住结论，之后不再犯同样的错。
          const fix = plan.multipart ? undefined : diagnose(response.status, response.data, body);
          if (fix && healed < MAX_PARAM_HEALING_ATTEMPTS) {
            healed += 1;
            rememberFix(healKey, fix);
            body = applyFix(body, fix);
            this.logger?.warn?.('model param healing', {
              op, model, nodeIndex,
              action: fix.action,
              param: fix.param,
              to: fix.action === 'rename' ? fix.to : undefined,
            });
            continue;
          }
          throw errorFromResponse(response);
        }
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

  /** 所有真正发出去的请求都从这里过一遍节点并发闸门。 */
  private gated<T>(nodeIndex: number, task: () => Promise<T>): Promise<T> {
    // 传解析器而不是当下的数值：请求可能在队列里等很久，期间用户改了上限也要跟着生效。
    return this.gate.run(nodeIndex, () => this.concurrencyOf(nodeIndex), task);
  }

  private concurrencyOf(nodeIndex: number): number {
    const live = this.getNodeConcurrency?.(nodeIndex);
    if (live !== undefined && live !== null) return Number(live) || 0;
    return Number(this.nodes[nodeIndex]?.concurrency) || 0;
  }

  /** 当前各节点的在飞/排队情况，用于排障。 */
  queueSnapshot() {
    return this.gate.snapshot();
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

function requireBuilder(
  dialect: Dialect,
  method: 'buildVision' | 'buildImageGeneration' | 'buildImageEdit' | 'buildVideoGeneration',
  node: ModelNode,
  req: any,
): RequestPlan {
  const fn = (dialect as any)[method] as ((n: ModelNode, r: any) => RequestPlan) | undefined;
  if (typeof fn !== 'function') throw new ModelError(`方言 ${dialect.id} 未实现 ${method}`, { category: 'validation', retryable: false, code: 'dialect_unsupported' });
  return fn.call(dialect, node, req);
}

function requireImageParser(dialect: Dialect, data: unknown): ImageResult {
  if (typeof dialect.parseImage !== 'function') throw new ModelError(`方言 ${dialect.id} 未实现 parseImage`, { category: 'validation', retryable: false });
  return dialect.parseImage(data);
}

function requireVideoParser(dialect: Dialect, data: unknown): VideoResult {
  if (typeof dialect.parseVideo !== 'function') throw new ModelError(`方言 ${dialect.id} 未实现 parseVideo`, { category: 'validation', retryable: false, code: 'dialect_unsupported' });
  return dialect.parseVideo(data);
}

/**
 * 上游是否在抱怨「请求体形态不对」（而不是别的错误）。
 * 只有这种情况才值得换一种形态重试。
 */
function looksLikeShapeRejection(error: unknown): boolean {
  const status = error instanceof ModelError ? Number(error.status || 0) : 0;
  if (![400, 404, 405, 415, 422].includes(status)) return false;
  const text = error instanceof Error ? error.message : String(error);
  return /multipart|form-?data|content[- ]type|unsupported media|invalid.*image|image.*required|unknown parameter|unsupported parameter/i.test(text);
}

/**
 * 出图类操作超时后**不要**换节点重试。
 *
 * 超时基本意味着上游还在算——它并没有拒绝你，只是比客户端的耐心久。
 * 这时候换个节点重试，只会在另一把 key 上再触发一次真实生成：
 * 用户多等一倍时间，最后还是一句超时，而两边的图都已经生成、都已经计费。
 * 网络类错误（连接被拒、DNS 失败）仍然值得换节点，所以只挡 timeout。
 */
function isGenerationTimeout(op: ModelOperation, error: unknown): boolean {
  if (op !== 'image.generate' && op !== 'image.edit' && op !== 'video.generate') return false;
  return error instanceof ModelError && error.category === 'timeout';
}

function shouldFailover(error: unknown): boolean {
  if (error instanceof ModelError) {
    const s = error.status || 0;
    // Bad credentials / missing models are terminal for the node but still worth
    // trying on another key or endpoint.
    if ([401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 529].includes(s)) return true;
    if (error.category === 'validation') return false;
    if (error.retryable) return true;
    return ['network', 'timeout', 'upstream'].includes(error.category);
  }
  return true; // 未知错误（网络等）默认可转移
}

function errorFromResponse(response: HttpResponse): ModelError {
  const classification = classifyProviderResponse(response.status, response.data);
  return new ModelError(classification.message, {
    category: classification.category,
    retryable: classification.retryable,
    status: response.status,
    code: classification.code || classification.kind,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
