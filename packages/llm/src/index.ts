import { normalizeError, runWithRetry, runWithTimeout, TaskQueue, type RetryPolicy } from '../../core/src/index.js';
import type { StructuredLogger } from '../../logger/src/index.js';
import type { PackageDescriptor, SerializableError } from '@miobot-v2/shared';

export const LLM_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/llm',
  phase: 'P5-llm-adapter',
};

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | string;
export type ImageArtifactKind = 'base64' | 'url';

export interface ProviderNode {
  name?: string;
  provider?: string;
  baseUrl: string;
  apiKey?: string;
  key?: string;
  headers?: Record<string, string>;
}

export interface ChatMessage {
  role: ChatRole;
  content: unknown;
}

export interface ProviderHttpRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  requestId: string;
  operation: ProviderOperation;
  model: string;
}

export interface ProviderHttpResponse<T = unknown> {
  status: number;
  data: T;
  headers?: Record<string, string>;
}

export type ProviderTransport = (request: ProviderHttpRequest) => Promise<ProviderHttpResponse>;
export type ProviderOperation = 'text' | 'vision' | 'image-generation' | 'image-edit';

export interface LlmAdapterOptions {
  node: ProviderNode;
  transport?: ProviderTransport;
  queue?: TaskQueue;
  logger?: StructuredLogger;
  timeoutMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
  requestIdFactory?: (operation: ProviderOperation) => string;
}

export interface TextCompletionRequest {
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface VisionRequest {
  model: string;
  prompt: string;
  imageUrls: string[];
  timeoutMs?: number;
  maxTokens?: number;
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

export interface TextCompletionResult {
  text: string;
  raw: unknown;
  status?: number;
}

export interface ImageArtifact {
  kind: ImageArtifactKind;
  data: string;
  mimeType?: string;
  revisedPrompt?: string;
  index: number;
}

export interface ImageResult {
  images: ImageArtifact[];
  raw: unknown;
  status?: number;
}

export class LlmProviderError extends Error {
  readonly normalized: SerializableError;
  readonly responseData?: unknown;

  constructor(message: string, normalized?: Partial<SerializableError>, responseData?: unknown) {
    super(message);
    this.name = 'LlmProviderError';
    this.normalized = {
      name: 'LlmProviderError',
      message,
      category: normalized?.category || 'upstream',
      retryable: normalized?.retryable ?? false,
      code: normalized?.code,
      status: normalized?.status,
      details: normalized?.details,
    };
    this.responseData = responseData;
  }
}

export class OpenAICompatibleAdapter {
  private readonly node: ProviderNode;
  private readonly transport: ProviderTransport;
  private readonly queue: TaskQueue;
  private readonly logger?: StructuredLogger;
  private readonly defaultTimeoutMs: number;
  private readonly retryPolicy: Partial<RetryPolicy>;
  private readonly requestIdFactory: (operation: ProviderOperation) => string;

  constructor(options: LlmAdapterOptions) {
    this.node = options.node;
    this.transport = options.transport || defaultFetchTransport;
    this.queue = options.queue || new TaskQueue({ defaultConcurrency: 1 });
    this.logger = options.logger;
    this.defaultTimeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 60000));
    this.retryPolicy = options.retryPolicy || { retries: 0, delayMs: 0 };
    this.requestIdFactory = options.requestIdFactory || ((operation) => `${operation}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
  }

  async createText(request: TextCompletionRequest): Promise<TextCompletionResult> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    };
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.reasoningEffort !== undefined) payload.reasoning_effort = request.reasoningEffort;
    const response = await this.postJson('/chat/completions', payload, 'text', request.model, request.timeoutMs);
    return { ...parseTextCompletionResponse(response.data), status: response.status };
  }

  async createVision(request: VisionRequest): Promise<TextCompletionResult> {
    const content = [
      { type: 'text', text: request.prompt },
      ...request.imageUrls.map((imageUrl) => ({ type: 'image_url', image_url: { url: imageUrl } })),
    ];
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: [{ role: 'user', content }],
    };
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
    const response = await this.postJson('/chat/completions', payload, 'vision', request.model, request.timeoutMs);
    return { ...parseTextCompletionResponse(response.data), status: response.status };
  }

  async generateImages(request: ImageGenerationRequest): Promise<ImageResult> {
    const count = Math.min(16, Math.max(1, Math.trunc(request.count ?? 1)));
    const payload: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      n: count,
      size: request.size || '1024x1024',
      response_format: 'b64_json',
    };
    if (request.quality) payload.quality = request.quality;
    const response = await this.postJson('/images/generations', payload, 'image-generation', request.model, request.timeoutMs);
    return { ...parseImageResponse(response.data), status: response.status };
  }

  async editImage(request: ImageEditRequest): Promise<ImageResult> {
    const payload: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      image: request.images.length === 1 ? request.images[0] : request.images,
      size: request.size || '1024x1024',
      response_format: 'b64_json',
    };
    if (request.mask) payload.mask = request.mask;
    if (request.quality) payload.quality = request.quality;
    const response = await this.postJson('/images/edits', payload, 'image-edit', request.model, request.timeoutMs);
    return { ...parseImageResponse(response.data), status: response.status };
  }

  private async postJson(endpoint: string, body: unknown, operation: ProviderOperation, model: string, timeoutMs?: number): Promise<ProviderHttpResponse> {
    const requestId = this.requestIdFactory(operation);
    const resolvedTimeoutMs = Math.max(1, Math.trunc(timeoutMs ?? this.defaultTimeoutMs));
    const provider = this.node.provider || this.node.name || 'openai-compatible';
    const url = `${trimTrailingSlash(this.node.baseUrl)}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.node.headers || {}),
    };
    const key = this.node.apiKey ?? this.node.key;
    if (key) headers.Authorization = `Bearer ${key}`;

    this.logger?.info('llm request start', { requestId, operation, provider, model, url, timeoutMs: resolvedTimeoutMs });
    try {
      const response = await this.queue.enqueue({ provider, model }, () => runWithRetry(
        () => runWithTimeout(
          () => this.transport({ method: 'POST', url, headers, body, timeoutMs: resolvedTimeoutMs, requestId, operation, model }),
          { operationName: operation, timeoutMs: resolvedTimeoutMs },
        ),
        {
          retries: Math.max(0, Math.trunc(this.retryPolicy.retries ?? 0)),
          delayMs: Math.max(0, Math.trunc(this.retryPolicy.delayMs ?? 0)),
          maxDelayMs: this.retryPolicy.maxDelayMs,
          factor: this.retryPolicy.factor,
          shouldRetry: this.retryPolicy.shouldRetry,
          sleep: this.retryPolicy.sleep,
        },
      ));
      if (response.status >= 400) throw errorFromUpstreamResponse(response.data, response.status);
      this.logger?.info('llm request complete', { requestId, operation, provider, model, status: response.status });
      return response;
    } catch (error) {
      const normalized = error instanceof LlmProviderError ? error.normalized : normalizeError(error);
      this.logger?.error('llm request failed', { requestId, operation, provider, model, error: normalized });
      throw error;
    }
  }
}

export function parseTextCompletionResponse(data: unknown): TextCompletionResult {
  assertNoTopLevelError(data);
  const root = asRecord(data);
  if (typeof root.output_text === 'string' && root.output_text.trim()) return { text: root.output_text, raw: data };
  const choices = Array.isArray(root.choices) ? root.choices : [];
  for (const choice of choices) {
    const item = asRecord(choice);
    const message = asRecord(item.message);
    const content = message.content ?? item.text;
    const parsed = flattenTextContent(content);
    if (parsed.trim()) return { text: parsed, raw: data };
  }
  throw new LlmProviderError('Text response missing choices[].message.content/output_text', { category: 'validation', retryable: false }, data);
}

export function parseImageResponse(data: unknown): ImageResult {
  assertNoTopLevelError(data);
  const root = asRecord(data);
  const items = Array.isArray(root.data) ? root.data : [];
  if (items.length === 0) throw new LlmProviderError('Image response missing data[]', { category: 'validation', retryable: false }, data);
  const images = items.map((item, index) => parseImageItem(item, index, data));
  return { images, raw: data };
}

export function parseImageItem(item: unknown, index: number, root?: unknown): ImageArtifact {
  const record = asRecord(item);
  if (record.error !== undefined) throw errorFromDataItemError(record.error, index, root ?? item);
  const revisedPrompt = typeof record.revised_prompt === 'string' ? record.revised_prompt : undefined;
  const mimeType = typeof record.mime_type === 'string'
    ? record.mime_type
    : typeof record.mimeType === 'string'
      ? record.mimeType
      : undefined;
  if (typeof record.b64_json === 'string' && record.b64_json) return { kind: 'base64', data: record.b64_json, mimeType, revisedPrompt, index };
  if (typeof record.base64 === 'string' && record.base64) return { kind: 'base64', data: record.base64, mimeType, revisedPrompt, index };
  if (typeof record.url === 'string' && record.url) return { kind: 'url', data: record.url, mimeType, revisedPrompt, index };
  throw new LlmProviderError(`Image response data[${index}] missing b64_json/base64/url`, { category: 'validation', retryable: false }, root ?? item);
}

export function extractBase64Images(data: unknown): string[] {
  return parseImageResponse(data).images
    .filter((image) => image.kind === 'base64')
    .map((image) => image.data);
}

export function createOpenAICompatibleAdapter(options: LlmAdapterOptions): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter(options);
}

export async function defaultFetchTransport(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
}

function assertNoTopLevelError(data: unknown): void {
  const root = asRecord(data);
  if (root.error !== undefined) throw errorFromUpstreamPayload(root.error, data);
}

function errorFromUpstreamResponse(data: unknown, status: number): LlmProviderError {
  const err = errorFromUpstreamPayload(asRecord(data).error ?? data, data);
  return new LlmProviderError(err.message, { ...err.normalized, status, retryable: status >= 500 }, data);
}

function errorFromUpstreamPayload(payload: unknown, responseData: unknown): LlmProviderError {
  const record = asRecord(payload);
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.error === 'string'
      ? record.error
      : typeof payload === 'string'
        ? payload
        : 'Upstream provider error';
  const code = typeof record.code === 'string' ? record.code : typeof record.type === 'string' ? record.type : undefined;
  const status = typeof record.status === 'number' ? record.status : undefined;
  const category = normalizeError({ message, code, status }).category === 'unknown' ? 'upstream' : normalizeError({ message, code, status }).category;
  return new LlmProviderError(message, { category, retryable: status ? status >= 500 : category !== 'validation', code, status, details: record }, responseData);
}

function errorFromDataItemError(payload: unknown, index: number, responseData: unknown): LlmProviderError {
  const base = errorFromUpstreamPayload(payload, responseData);
  return new LlmProviderError(`data[${index}].error: ${base.message}`, { ...base.normalized, category: 'upstream', retryable: true }, responseData);
}

function flattenTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const record = asRecord(part);
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      if (typeof record.output_text === 'string') return record.output_text;
      return '';
    }).filter(Boolean).join('\n');
  }
  const record = asRecord(content);
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  return '';
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

