import type { ChatRequest, Dialect, ImageEditRequest, ImageGenerationRequest, ModelNode, ModelOperation, RequestPlan, VisionRequest } from '../ports.js';
import { bearerHeaders, joinUrl, parseOpenAiImages, parseOpenAiText } from './shared.js';

const OPS: ModelOperation[] = ['chat', 'vision', 'image.generate', 'image.edit', 'interrogate'];

export const openAiDialect: Dialect = {
  id: 'openai',
  supports: (op) => OPS.includes(op),
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort;
    return { method: 'POST', url: joinUrl(node.baseUrl, '/chat/completions'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  parseChat: parseOpenAiText,
  buildVision(node: ModelNode, req: VisionRequest): RequestPlan {
    const content = [
      { type: 'text', text: req.prompt },
      ...req.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
    const body: Record<string, unknown> = { model: req.model, messages: [{ role: 'user', content }] };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    return { method: 'POST', url: joinUrl(node.baseUrl, '/chat/completions'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  buildImageGeneration(node: ModelNode, req: ImageGenerationRequest): RequestPlan {
    const body: Record<string, unknown> = {
      model: req.model, prompt: req.prompt, n: clampCount(req.count), response_format: 'b64_json',
    };
    if (req.size) body.size = req.size;
    if (req.quality) body.quality = req.quality;
    return { method: 'POST', url: joinUrl(node.baseUrl, '/images/generations'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  buildImageEdit(node: ModelNode, req: ImageEditRequest): RequestPlan {
    const images = req.images.map((s) => String(s || '').trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      model: req.model, prompt: req.prompt, response_format: 'b64_json',
      images: images.map((img) => ({ image_url: img })),
    };
    if (req.size) body.size = req.size;
    if (req.quality) body.quality = req.quality;
    if (req.mask) body.mask = { image_url: req.mask };
    return { method: 'POST', url: joinUrl(node.baseUrl, '/images/edits'), headers: bearerHeaders(node.apiKey, node.headers), body };
  },
  parseImage: parseOpenAiImages,
};

function clampCount(count?: number): number {
  return Math.min(16, Math.max(1, Math.trunc(count ?? 1)));
}
