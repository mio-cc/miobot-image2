import { normalizeError } from '../../core/src/index.js';
import type { ImageArtifact, ImageResult, LlmProviderError, TextCompletionResult } from '../../llm/src/index.js';
import type { ReplyContext, ReplyDispatchResult, ReplyStrategyEngine } from '../../reply/src/index.js';
import type { PackageDescriptor, SerializableError } from '@miobot-v2/shared';

export const IMAGE_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/image',
  phase: 'P8-image-module',
};

export interface PromptTemplate {
  id: string;
  title: string;
  prompt: string;
}

export interface ParsedImageParams {
  rawInput: string;
  prompt: string;
  size: string;
  count: number;
  quality?: string;
  templateId?: string;
  ratio?: string;
  scale?: string;
  tokens: string[];
  warnings: string[];
}

export interface ImageCommandParseOptions {
  defaultSize?: string;
  defaultCount?: number;
  defaultQuality?: string;
  maxCount?: number;
}

export interface ImageLlmClient {
  generateImages(request: { model: string; prompt: string; size?: string; count?: number; quality?: string; timeoutMs?: number }): Promise<ImageResult>;
  editImage(request: { model: string; prompt: string; images: string[]; mask?: string; size?: string; quality?: string; timeoutMs?: number }): Promise<ImageResult>;
  createVision(request: { model: string; prompt: string; imageUrls: string[]; timeoutMs?: number; maxTokens?: number }): Promise<TextCompletionResult>;
}

export interface ImageModuleOptions {
  llm: ImageLlmClient;
  reply?: ReplyStrategyEngine;
  imageModel: string;
  editModel?: string;
  interrogateModel?: string;
  defaultSize?: string;
  defaultCount?: number;
  defaultQuality?: string;
  imageTimeoutMs?: number;
  editTimeoutMs?: number;
  interrogateTimeoutMs?: number;
  promptTemplates?: PromptTemplate[];
  interrogatePromptTemplate?: string;
}

export interface GenerateImageInput {
  rawPrompt: string;
  context?: ReplyContext;
  model?: string;
  timeoutMs?: number;
}

export interface EditImageInput {
  rawPrompt: string;
  images: string[];
  mask?: string;
  context?: ReplyContext;
  model?: string;
  timeoutMs?: number;
}

export interface InterrogateInput {
  imageUrl: string;
  prompt?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ImageOperationResult {
  prompt: string;
  params: ParsedImageParams;
  images: string[];
  artifacts: ImageArtifact[];
  reply?: ReplyDispatchResult;
}

export interface InterrogateResult {
  text: string;
  prompt: string;
  timeoutMs: number;
  raw: unknown;
}

export class ImageModuleError extends Error {
  readonly normalized: SerializableError;
  readonly operation: 'generate' | 'edit' | 'interrogate';

  constructor(operation: 'generate' | 'edit' | 'interrogate', error: unknown) {
    const normalized = extractSerializableError(error);
    super(normalized.message);
    this.name = 'ImageModuleError';
    this.operation = operation;
    this.normalized = normalized;
  }
}

export class ImageModule {
  private readonly options: Required<Omit<ImageModuleOptions, 'reply' | 'editModel' | 'interrogateModel' | 'defaultQuality' | 'interrogatePromptTemplate'>> & Pick<ImageModuleOptions, 'reply' | 'editModel' | 'interrogateModel' | 'defaultQuality' | 'interrogatePromptTemplate'>;

  constructor(options: ImageModuleOptions) {
    this.options = {
      llm: options.llm,
      reply: options.reply,
      imageModel: options.imageModel,
      editModel: options.editModel,
      interrogateModel: options.interrogateModel,
      defaultSize: options.defaultSize || '1024x1024',
      defaultCount: clampCount(options.defaultCount ?? 1, 4),
      defaultQuality: options.defaultQuality,
      imageTimeoutMs: positiveInt(options.imageTimeoutMs, 300000),
      editTimeoutMs: positiveInt(options.editTimeoutMs, positiveInt(options.imageTimeoutMs, 300000)),
      interrogateTimeoutMs: positiveInt(options.interrogateTimeoutMs, 300000),
      promptTemplates: options.promptTemplates || [],
      interrogatePromptTemplate: options.interrogatePromptTemplate,
    };
  }

  async generate(input: GenerateImageInput): Promise<ImageOperationResult> {
    const params = parseImageCommand(input.rawPrompt, {
      defaultSize: this.options.defaultSize,
      defaultCount: this.options.defaultCount,
      defaultQuality: this.options.defaultQuality,
    });
    const prompt = applyTemplateById(params.prompt, params.templateId, this.options.promptTemplates);
    try {
      const result = await this.options.llm.generateImages({
        model: input.model || this.options.imageModel,
        prompt,
        size: params.size,
        count: params.count,
        quality: params.quality,
        timeoutMs: input.timeoutMs || this.options.imageTimeoutMs,
      });
      const images = artifactsToSendableImages(result.images);
      const reply = input.context && this.options.reply ? await this.options.reply.replyImages(input.context, images) : undefined;
      return { prompt, params: { ...params, prompt }, images, artifacts: result.images, reply };
    } catch (error) {
      throw new ImageModuleError('generate', error);
    }
  }

  async edit(input: EditImageInput): Promise<ImageOperationResult> {
    const params = parseImageCommand(input.rawPrompt, {
      defaultSize: this.options.defaultSize,
      defaultCount: 1,
      defaultQuality: this.options.defaultQuality,
    });
    const prompt = applyTemplateById(params.prompt, params.templateId, this.options.promptTemplates);
    const request = {
      model: input.model || this.options.editModel || this.options.imageModel,
      prompt,
      images: input.images,
      mask: input.mask,
      size: params.size,
      quality: params.quality,
      timeoutMs: input.timeoutMs || this.options.editTimeoutMs,
    };
    try {
      const result = await this.editWithReferenceFallback(request);
      const images = artifactsToSendableImages(result.images);
      const reply = input.context && this.options.reply ? await this.options.reply.replyImages(input.context, images) : undefined;
      return { prompt, params: { ...params, prompt }, images, artifacts: result.images, reply };
    } catch (error) {
      throw new ImageModuleError('edit', error);
    }
  }

  private async editWithReferenceFallback(request: Parameters<ImageLlmClient['editImage']>[0]): Promise<ImageResult> {
    try {
      return await this.options.llm.editImage(request);
    } catch (error) {
      if (!shouldRetrySingleReferenceEdit(error, request.images)) throw error;
      return await this.options.llm.editImage({ ...request, images: [request.images[0]] });
    }
  }

  async interrogate(input: InterrogateInput): Promise<InterrogateResult> {
    const prompt = input.prompt || this.options.interrogatePromptTemplate || '请分析这张图片，并反推一段适合图像生成模型复现它的提示词。';
    const timeoutMs = positiveInt(input.timeoutMs, this.options.interrogateTimeoutMs);
    try {
      const result = await this.options.llm.createVision({
        model: input.model || this.options.interrogateModel || this.options.imageModel,
        prompt,
        imageUrls: [input.imageUrl],
        timeoutMs,
      });
      return { text: result.text, prompt, timeoutMs, raw: result.raw };
    } catch (error) {
      throw new ImageModuleError('interrogate', error);
    }
  }
}

export function createImageModule(options: ImageModuleOptions): ImageModule {
  return new ImageModule(options);
}

export function parseImageCommand(input: string, options: ImageCommandParseOptions = {}): ParsedImageParams {
  const maxCount = Math.max(1, Math.trunc(options.maxCount ?? 4));
  const tokens: string[] = [];
  const warnings: string[] = [];
  let size = options.defaultSize || '1024x1024';
  let count = clampCount(options.defaultCount ?? 1, maxCount);
  let quality = options.defaultQuality;
  let templateId: string | undefined;
  let ratio: string | undefined;
  let scale: string | undefined;
  let explicitSize = false;
  const promptParts: string[] = [];

  for (const part of String(input || '').split(/\s+/)) {
    const token = part.trim();
    if (!token) continue;
    if (!token.endsWith('!')) {
      promptParts.push(token);
      continue;
    }
    const body = token.slice(0, -1).trim();
    if (!body) continue;
    const lower = body.toLowerCase();
    if (/^mb_\d+$/i.test(body)) {
      templateId = body;
      tokens.push(token);
      continue;
    }
    if (/^\d{2,5}x\d{2,5}$/i.test(lower)) {
      size = normalizeSize(lower);
      explicitSize = true;
      tokens.push(token);
      continue;
    }
    if (/^\d{1,2}:\d{1,2}$/.test(lower)) {
      ratio = lower;
      if (!explicitSize) size = sizeFromRatio(lower, scale);
      tokens.push(token);
      continue;
    }
    if (/^[124]k$/.test(lower)) {
      scale = lower;
      if (!explicitSize) size = ratio ? sizeFromRatio(ratio, scale) : sizeFromScale(scale);
      tokens.push(token);
      continue;
    }
    if (/^\d+$/.test(lower)) {
      count = clampCount(Number(lower), maxCount);
      tokens.push(token);
      continue;
    }
    if (/^n=\d+$/.test(lower)) {
      count = clampCount(Number(lower.slice(2)), maxCount);
      tokens.push(token);
      continue;
    }
    if (['low', 'medium', 'high', 'auto', 'standard', 'hd'].includes(lower)) {
      quality = lower;
      tokens.push(token);
      continue;
    }
    warnings.push(`unknown token ignored: ${token}`);
    promptParts.push(token);
  }

  return {
    rawInput: input,
    prompt: promptParts.join(' ').trim(),
    size,
    count,
    quality,
    templateId,
    ratio,
    scale,
    tokens,
    warnings,
  };
}

export function renderPromptTemplate(template: string, values: Record<string, unknown>): string {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  }).trim();
}

export function applyPromptTemplate(rawPrompt: string, template: PromptTemplate | string): string {
  const templateText = typeof template === 'string' ? template : template.prompt;
  const prompt = String(rawPrompt || '').trim();
  const rendered = renderPromptTemplate(templateText, { prompt, rawPrompt: prompt });
  return rendered || prompt;
}

export function applyTemplateById(rawPrompt: string, templateId: string | undefined, templates: PromptTemplate[]): string {
  if (!templateId) return String(rawPrompt || '').trim();
  const template = templates.find((item) => item.id.toLowerCase() === templateId.toLowerCase());
  return template ? applyPromptTemplate(rawPrompt, template) : String(rawPrompt || '').trim();
}

export function artifactsToSendableImages(artifacts: ImageArtifact[]): string[] {
  return artifacts.map((artifact) => artifact.kind === 'base64' ? `base64://${artifact.data}` : artifact.data);
}

export function isUpstreamImageError(error: unknown): boolean {
  return extractSerializableError(error).category === 'upstream';
}

export function shouldRetrySingleReferenceEdit(error: unknown, images: string[]): boolean {
  if (!Array.isArray(images) || images.filter(Boolean).length <= 1) return false;
  const normalized = extractSerializableError(error);
  if (normalized.retryable === false) return false;
  const message = `${normalized.message || ''} ${normalized.code || ''}`.toLowerCase();
  if (normalized.category === 'network' || normalized.category === 'timeout') return true;
  if (normalized.category !== 'upstream') return false;
  return /stream|disconnect|timeout|temporar|internal|overload|gateway|rate/.test(message);
}

function extractSerializableError(error: unknown): SerializableError {
  const maybe = error as { normalized?: SerializableError } | undefined;
  if (maybe?.normalized) return maybe.normalized;
  return normalizeError(error);
}

function sizeFromRatio(ratio: string, scaleToken?: string): string {
  const [w, h] = ratio.split(':').map((item) => Number(item));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '1024x1024';
  if (!scaleToken) {
    const landscape = w / h;
    if (Math.abs(landscape - 1) < 0.08) return '1024x1024';
    return landscape > 1 ? '1536x1024' : '1024x1536';
  }
  const longEdge = scaleLongEdge(scaleToken);
  if (Math.abs(w / h - 1) < 0.08) return `${longEdge}x${longEdge}`;
  if (w > h) return `${longEdge}x${roundToMultiple(longEdge * h / w)}`;
  return `${roundToMultiple(longEdge * w / h)}x${longEdge}`;
}

function sizeFromScale(scaleToken: string): string {
  const edge = scaleLongEdge(scaleToken);
  return `${edge}x${edge}`;
}

function scaleLongEdge(scaleToken = '1k'): number {
  const n = Number(String(scaleToken || '1k').toLowerCase().replace(/k$/, '')) || 1;
  return Math.max(1024, Math.trunc(n) * 1024);
}

function roundToMultiple(value: number, multiple = 64): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function normalizeSize(value: string): string {
  const [w, h] = value.toLowerCase().split('x').map((item) => Math.max(1, Math.trunc(Number(item))));
  return `${w}x${h}`;
}

function clampCount(value: number, maxCount: number): number {
  return Math.min(Math.max(1, Math.trunc(Number(value) || 1)), maxCount);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}
