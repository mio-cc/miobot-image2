import { normalizeError, runWithRetry, runWithTimeout, TaskQueue, type RetryPolicy } from '../../core/src/index.js';
import type { StructuredLogger } from '../../logger/src/index.js';
import type { PackageDescriptor, SerializableError } from '@miobot-v2/shared';

export const LLM_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/llm',
  phase: 'P5-llm-adapter',
};

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | string;
export type ImageArtifactKind = 'base64' | 'url';
export type ImageEditRequestMode = 'auto' | 'json-images' | 'json-image' | 'multipart';

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
export type ProviderOperation = 'text' | 'vision' | 'image-generation' | 'image-edit' | 'editable-file';

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
  requestMode?: ImageEditRequestMode;
}

export type EditableFileKind = 'ppt' | 'psd';

export interface EditableFileTaskRequest {
  kind: EditableFileKind;
  prompt: string;
  model?: string;
  base64Images?: string[];
  clientTaskId?: string;
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

export interface EditableFileTaskResult {
  id?: string;
  taskId?: string;
  status?: string;
  kind?: string;
  result?: Record<string, unknown>;
  error?: string;
  raw: unknown;
  statusCode?: number;
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
    return { ...this.parseImageResponseWithLog(response.data, 'image-generation', request.model, response.status), status: response.status };
  }

  async editImage(request: ImageEditRequest): Promise<ImageResult> {
    const requestMode = resolveImageEditRequestMode(request.requestMode);
    const inputImages = request.images.map((image) => String(image || '').trim()).filter(Boolean);
    if (!inputImages.length) {
      throw new LlmProviderError('Image edit requires at least one input image', { category: 'validation', retryable: false, code: 'missing_input_image' });
    }
    const payload: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      size: request.size || '1024x1024',
      response_format: 'b64_json',
    };
    if (request.quality) payload.quality = request.quality;
    if (requestMode === 'json-image') {
      payload.image = inputImages.length === 1 ? inputImages[0] : inputImages;
      if (request.mask) payload.mask = request.mask;
    } else if (requestMode === 'multipart') {
      const form = createImageEditMultipartForm(payload, inputImages, request.mask);
      const response = await this.postMultipart('/images/edits', form, 'image-edit', request.model, request.timeoutMs);
      return { ...this.parseImageResponseWithLog(response.data, 'image-edit', request.model, response.status), status: response.status };
    } else {
      payload.images = inputImages.map((image) => imageReferenceForJson(image));
      if (request.mask) payload.mask = imageReferenceForJson(request.mask);
    }
    const response = await this.postJson('/images/edits', payload, 'image-edit', request.model, request.timeoutMs);
    return { ...this.parseImageResponseWithLog(response.data, 'image-edit', request.model, response.status), status: response.status };
  }

  async createEditableFileTask(request: EditableFileTaskRequest): Promise<EditableFileTaskResult> {
    const kind = request.kind === 'psd' ? 'psd' : 'ppt';
    const model = request.model || 'gpt-5-5-thinking';
    const payload: Record<string, unknown> = {
      prompt: String(request.prompt || ''),
      base64_images: Array.isArray(request.base64Images) ? request.base64Images : [],
    };
    if (request.clientTaskId) payload.client_task_id = request.clientTaskId;
    const response = await this.postJson(`/${kind}/generations`, payload, 'editable-file', model, request.timeoutMs);
    return { ...parseEditableFileTaskResponse(response.data), statusCode: response.status };
  }

  private parseImageResponseWithLog(data: unknown, operation: ProviderOperation, model: string, status: number): ImageResult {
    try {
      return parseImageResponse(data);
    } catch (error) {
      const provider = this.node.provider || this.node.name || 'openai-compatible';
      const normalized = error instanceof LlmProviderError ? error.normalized : normalizeError(error);
      this.logger?.error('llm image response parse failed', {
        operation,
        provider,
        model,
        status,
        error: normalized,
        responsePreview: previewProviderData(data),
      });
      throw error;
    }
  }

  private async postJson(endpoint: string, body: unknown, operation: ProviderOperation, model: string, timeoutMs?: number): Promise<ProviderHttpResponse> {
    return this.post(endpoint, body, operation, model, timeoutMs, { 'Content-Type': 'application/json' });
  }

  private async postMultipart(endpoint: string, body: FormData, operation: ProviderOperation, model: string, timeoutMs?: number): Promise<ProviderHttpResponse> {
    return this.post(endpoint, body, operation, model, timeoutMs, {});
  }

  private async post(endpoint: string, body: unknown, operation: ProviderOperation, model: string, timeoutMs: number | undefined, contentHeaders: Record<string, string>): Promise<ProviderHttpResponse> {
    const requestId = this.requestIdFactory(operation);
    const resolvedTimeoutMs = Math.max(1, Math.trunc(timeoutMs ?? this.defaultTimeoutMs));
    const provider = this.node.provider || this.node.name || 'openai-compatible';
    const url = `${trimTrailingSlash(this.node.baseUrl)}${endpoint}`;
    const headers: Record<string, string> = {
      ...contentHeaders,
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

export function parseEditableFileTaskResponse(data: unknown): EditableFileTaskResult {
  assertNoTopLevelError(data);
  const root = asRecord(data);
  const id = stringValue(root.id ?? root.taskId ?? root.task_id);
  const taskId = stringValue(root.taskId ?? root.task_id ?? root.id);
  return {
    id,
    taskId,
    status: stringValue(root.status),
    kind: stringValue(root.kind),
    result: asRecord(root.result),
    error: stringValue(root.error),
    raw: data,
  };
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
  const isFormDataBody = typeof FormData !== 'undefined' && request.body instanceof FormData;
  const body = isFormDataBody ? request.body as BodyInit : JSON.stringify(request.body);
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
}

function resolveImageEditRequestMode(value: unknown): Exclude<ImageEditRequestMode, 'auto'> {
  if (value === 'json-image' || value === 'multipart') return value;
  return 'json-images';
}

function imageReferenceForJson(value: string): { image_url: string } | { file_id: string } {
  const text = String(value || '').trim();
  const fileId = text.match(/^file_id:(.+)$/i)?.[1]?.trim() || (/^file-[A-Za-z0-9_-]+$/.test(text) ? text : '');
  if (fileId) return { file_id: fileId };
  if (/^base64:\/\//i.test(text)) return { image_url: `data:image/png;base64,${text.slice('base64://'.length)}` };
  return { image_url: text };
}

function createImageEditMultipartForm(payload: Record<string, unknown>, images: string[], mask?: string): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  const cleanedImages = images.map((image) => String(image || '').trim()).filter(Boolean);
  cleanedImages.forEach((image, index) => {
    const { blob, fileName } = imageStringToBlob(image, `image_${index + 1}`);
    form.append(cleanedImages.length > 1 ? 'image[]' : 'image', blob, fileName);
  });
  if (mask) {
    const { blob, fileName } = imageStringToBlob(mask, 'mask');
    form.append('mask', blob, fileName);
  }
  return form;
}

function imageStringToBlob(value: string, baseName: string): { blob: Blob; fileName: string } {
  const text = String(value || '').trim();
  if (/^data:image\//i.test(text)) {
    const parsed = parseImageDataUrl(text);
    return { blob: blobFromBuffer(parsed.bytes, parsed.mimeType), fileName: `${baseName}.${extensionFromImageMime(parsed.mimeType)}` };
  }
  if (/^base64:\/\//i.test(text)) {
    const bytes = Buffer.from(text.slice('base64://'.length), 'base64');
    return { blob: blobFromBuffer(bytes, 'image/png'), fileName: `${baseName}.png` };
  }
  throw new LlmProviderError(
    'multipart image edits require data:image/* or base64:// image inputs',
    { category: 'validation', retryable: false, code: 'unsupported_multipart_image_reference' },
  );
}

function blobFromBuffer(bytes: Buffer, type: string): Blob {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([arrayBuffer], { type });
}

function parseImageDataUrl(value: string): { mimeType: string; bytes: Buffer } {
  const match = String(value || '').match(/^data:([^;,]+)(;base64)?,(.*)$/is);
  if (!match) {
    throw new LlmProviderError('Invalid image data URL', { category: 'validation', retryable: false, code: 'invalid_image_data_url' });
  }
  const mimeType = match[1] || 'image/png';
  const raw = match[3] || '';
  const bytes = match[2] ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8');
  if (!bytes.length) {
    throw new LlmProviderError('Empty image data URL', { category: 'validation', retryable: false, code: 'empty_image_data_url' });
  }
  return { mimeType, bytes };
}

function extensionFromImageMime(value: string): string {
  const mime = String(value || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
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

function stringValue(value: unknown): string | undefined {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || undefined;
}

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function previewProviderData(data: unknown): unknown {
  const seen = new WeakSet<object>();
  const sanitized = JSON.stringify(data, (_key, value) => {
    if (typeof value === 'string') {
      if (value.length > 240 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return `${value.slice(0, 32)}…<${value.length} chars>`;
      return value.length > 500 ? `${value.slice(0, 500)}…<${value.length} chars>` : value;
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
  if (!sanitized) return data;
  return sanitized.length > 1600 ? `${sanitized.slice(0, 1600)}…<${sanitized.length} chars>` : sanitized;
}

