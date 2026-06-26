import { ModelError, type ChatRequest, type Dialect, type ImageGenerationRequest, type ModelNode, type ModelOperation, type RequestPlan, type TextResult, type VisionRequest } from '../ports.js';
import { asRecord, flattenTextContent, getByPath, joinUrl, parseOpenAiImages } from './shared.js';

const OPS: ModelOperation[] = ['chat', 'vision', 'image.generate', 'interrogate'];

/** 自定义方言：默认按 OpenAI 形状，但 endpoint/鉴权头/取值路径均可由 node.custom 覆盖。 */
export const customDialect: Dialect = {
  id: 'custom',
  supports: (op) => OPS.includes(op),
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan {
    const spec = node.custom || {};
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(node.headers || {}) };
    if (node.apiKey) headers[spec.authHeader || 'Authorization'] = `${spec.authPrefix ?? 'Bearer '}${node.apiKey}`;
    const body: Record<string, unknown> = { model: req.model, messages: req.messages };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return { method: 'POST', url: joinUrl(node.baseUrl, spec.chatPath || '/chat/completions'), headers, body };
  },
  parseChat(data: unknown): TextResult {
    // 这里无法拿到 node.custom（解析与节点解耦），故按通用顺序取值。
    const root = asRecord(data);
    if (root.error !== undefined) { const e = asRecord(root.error); throw new ModelError(String(e.message || root.error), { category: 'upstream', retryable: false }); }
    const fromChoices = flattenTextContent(asRecord(asRecord((root.choices || [])[0]).message).content);
    const text = fromChoices || (typeof root.output_text === 'string' ? root.output_text : '') || String(getByPath(root, 'data.text') || '');
    if (text.trim()) return { text, raw: data };
    throw new ModelError('Custom dialect: 无法从响应解析文本（可在节点 custom.textPath 指定路径）', { category: 'validation', retryable: false });
  },
  buildVision(node: ModelNode, req: VisionRequest): RequestPlan {
    const content = [{ type: 'text', text: req.prompt }, ...req.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))];
    return this.buildChat!(node, { model: req.model, messages: [{ role: 'user', content }], maxTokens: req.maxTokens });
  },
  buildImageGeneration(node: ModelNode, req: ImageGenerationRequest): RequestPlan {
    const spec = node.custom || {};
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(node.headers || {}) };
    if (node.apiKey) headers[spec.authHeader || 'Authorization'] = `${spec.authPrefix ?? 'Bearer '}${node.apiKey}`;
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, n: Math.max(1, req.count || 1), response_format: 'b64_json' };
    if (req.size) body.size = req.size;
    return { method: 'POST', url: joinUrl(node.baseUrl, spec.imagePath || '/images/generations'), headers, body };
  },
  parseImage: parseOpenAiImages,
};
