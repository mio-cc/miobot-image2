import type {
  ChatParseContext,
  ChatRequest,
  Dialect,
  ImageEditRequest,
  ImageGenerationRequest,
  ModelNode,
  ModelOperation,
  RequestPlan,
  TextResult,
  VideoGenerationRequest,
  VisionRequest,
} from '../ports.js';
import { bearerHeaders, buildOpenAiVideoStatus, joinUrl, parseOpenAiImages, parseOpenAiText, parseOpenAiVideo } from './shared.js';
import { hasToolMessages, openAiToolAdapter, toOpenAiMessages, type ProviderToolMessage } from '../../../provider-tools/src/index.js';
import { applyJsonFallbackParse, jsonFallbackRequestMessages, nativeResult, normalizeToolChoice, parseContextForRequest, requestToolNames, resolveToolProtocol } from './tool-support.js';
import {
  supportsReasoningEffort,
  supportsResponseFormat,
  supportsTemperature,
  tokenParamFor,
} from '../capability/params.js';

/** OpenAI 兼容方言协议层能力(含 xAI grok 文本/生图/视频扩展点)。 */
const OPS: ModelOperation[] = ['chat', 'vision', 'image.generate', 'image.edit', 'interrogate', 'video.generate'];

export const openAiDialect: Dialect = {
  id: 'openai',
  supports: (op) => OPS.includes(op),
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan {
    const protocol = resolveToolProtocol(req);
    const toolNames = requestToolNames(req);
    const useToolMessages = hasToolMessages(req.messages as unknown as Array<Record<string, unknown>>);
    const messages = protocol === 'json-fallback'
      ? jsonFallbackRequestMessages(req)
      : useToolMessages
        ? toOpenAiMessages(req.messages as ProviderToolMessage[], { toolNames })
        : req.messages;
    const body: Record<string, unknown> = { model: req.model, messages };
    applyChatParams(body, req);
    if (protocol === 'native') {
      body.tools = openAiToolAdapter.buildTools(req.toolSpecs || [], { toolNames });
      const choice = normalizeToolChoice(req.toolChoice);
      if (choice) body.tool_choice = openAiToolAdapter.buildToolChoice(choice);
    } else if (!req.toolSpecs?.length) {
      if (req.tools) body.tools = req.tools;
      if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
    }
    return { method: 'POST', url: joinUrl(node.baseUrl, '/chat/completions'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  parseChat(data: unknown, context: ChatParseContext = {}): TextResult {
    return parseOpenAiChat(data, context);
  },
  buildVision(node: ModelNode, req: VisionRequest): RequestPlan {
    const content = [
      { type: 'text', text: req.prompt },
      ...req.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
    const body: Record<string, unknown> = { model: req.model, messages: [{ role: 'user', content }] };
    applyChatParams(body, req);
    return { method: 'POST', url: joinUrl(node.baseUrl, '/chat/completions'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  buildImageGeneration(node: ModelNode, req: ImageGenerationRequest): RequestPlan {
    const body: Record<string, unknown> = {
      model: req.model, prompt: req.prompt, n: clampCount(req.count),
    };
    // gpt-image 系列恒定返回 b64_json，传 response_format 会被官方直接 400 Unknown parameter。
    if (supportsResponseFormat(req.model)) body.response_format = 'b64_json';
    if (req.size) body.size = req.size;
    if (req.quality) body.quality = req.quality;
    // xAI Grok Imagine: aspect_ratio / resolution(与 OpenAI size 并存时由能力档案决定是否带 size)
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    else if (req.size && looksLikeAspectRatio(req.size)) body.aspect_ratio = req.size;
    if (req.resolution) body.resolution = req.resolution;
    return { method: 'POST', url: joinUrl(node.baseUrl, '/images/generations'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  buildImageEdit(node: ModelNode, req: ImageEditRequest): RequestPlan {
    const images = req.images.map((s) => String(s || '').trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      model: req.model, prompt: req.prompt,
      images: images.map((img) => ({ image_url: img })),
    };
    if (supportsResponseFormat(req.model)) body.response_format = 'b64_json';
    if (req.size) body.size = req.size;
    if (req.quality) body.quality = req.quality;
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    if (req.resolution) body.resolution = req.resolution;
    if (req.mask) body.mask = { image_url: req.mask };
    return { method: 'POST', url: joinUrl(node.baseUrl, '/images/edits'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  parseImage: parseOpenAiImages,
  /**
   * xAI Grok Imagine Video: POST /videos/generations。
   * 响应多为 { request_id }；ModelClient.generateVideo 会再 GET /videos/{id} 轮询到 done。
   * 字段对齐官方: model, prompt, duration(1-15), aspect_ratio, resolution, image:{url}。
   */
  buildVideoGeneration(node: ModelNode, req: VideoGenerationRequest): RequestPlan {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
    };
    if (req.imageUrl) body.image = { url: req.imageUrl };
    if (req.duration !== undefined) body.duration = req.duration;
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    if (req.resolution) body.resolution = req.resolution;
    return {
      method: 'POST',
      url: joinUrl(node.baseUrl, '/videos/generations'),
      headers: bearerHeaders(node.apiKey, node.headers),
      body,
    };
  },
  buildVideoStatus: buildOpenAiVideoStatus,
  parseVideo: parseOpenAiVideo,
};

/**
 * 按模型分流对话参数。
 *
 * 官方对 o 系列 / gpt-5 系列拒收 max_tokens（必须 max_completion_tokens）、
 * 拒收 temperature，o1-mini 与 gpt-5-chat 还拒收 reasoning_effort。
 * 这些错误都不带可自动降级的提示，不分流就是必然 400。
 */
function applyChatParams(body: Record<string, unknown>, req: { model: string; maxTokens?: number; temperature?: number; reasoningEffort?: string }): void {
  if (req.maxTokens !== undefined) body[tokenParamFor(req.model)] = req.maxTokens;
  if (req.temperature !== undefined && supportsTemperature(req.model)) body.temperature = req.temperature;
  if (req.reasoningEffort !== undefined && supportsReasoningEffort(req.model)) body.reasoning_effort = req.reasoningEffort;
}

function clampCount(count?: number): number {
  return Math.min(16, Math.max(1, Math.trunc(count ?? 1)));
}

/** 16:9 / 1:1 等视为 aspect_ratio 而非 OpenAI 像素 size。 */
function looksLikeAspectRatio(value: string): boolean {
  return /^\d{1,2}:\d{1,2}$/.test(String(value || '').trim());
}

function parseOpenAiChat(data: unknown, context: ChatParseContext = {}): TextResult {
  const native = openAiToolAdapter.parseToolResponse(data, {
    ...context,
    finishReason: openAiFinishReason(data),
  });
  const finishReason = native.finishReason;
  let base: TextResult;
  try {
    base = parseOpenAiText(data);
  } catch (error) {
    const canRepair = context.toolProtocol === 'json-fallback' || native.toolCalls.length > 0 || native.issues.some((issue) => issue.code === 'truncated_output');
    if (!canRepair) throw error;
    base = {
      text: native.text || openAiVisibleText(data),
      raw: data,
      ...(finishReason ? { finishReason } : {}),
      ...(native.truncated ? { truncated: true } : {}),
    };
  }
  const withMeta: TextResult = {
    ...base,
    ...(finishReason ? { finishReason } : {}),
    ...(native.truncated ? { truncated: true } : {}),
  };
  if (context.toolProtocol === 'json-fallback') return applyJsonFallbackParse(withMeta, {
    ...context,
    ...(finishReason ? { toolProtocol: 'json-fallback' as const } : {}),
  });
  return nativeResult(withMeta, native);
}

function openAiFinishReason(data: unknown): string | undefined {
  const root = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, any> : {};
  const choice = Array.isArray(root.choices) ? root.choices[0] : undefined;
  const value = choice && typeof choice === 'object' ? (choice as Record<string, unknown>).finish_reason : undefined;
  const reason = String(value ?? '').trim();
  return reason || undefined;
}

function openAiVisibleText(data: unknown): string {
  const root = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, any> : {};
  const message = root.choices?.[0]?.message;
  const content = message?.content ?? root.output_text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part && typeof part === 'object' && typeof (part as any).text === 'string' ? (part as any).text : '').filter(Boolean).join('\n');
  return '';
}
