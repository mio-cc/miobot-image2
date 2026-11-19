/**
 * fal.ai 方言（2026-11-19）。
 *
 * 为什么需要它：fal 的 REST 形态和 OpenAI 完全不同——
 *   - URL 是「模型 id 即路径」：POST {baseUrl}/{model_id}，不是 /images/generations；
 *   - 鉴权是 `Authorization: Key <key>`，不是 Bearer；
 *   - 出参是 { images: [{ url, content_type }] } / { video: { url } }，不是 data[]。
 *
 * 线上时测的翻车：节点 https://fal.ai/api（模型 openai/gpt-image-2.6/sunburst/text-to-image）
 * 被当成 OpenAI 兼容网关，请求打到 {baseUrl}/images/generations，1.5 秒内被拒，
 * 而 job 失败又没写日志，看起来就成了「超时无返回」。
 *
 * 这里按 fal 的公开 REST 形状实现；model id 原样保留（fal 的 id 本身带斜杠）。
 */
import { ModelError, type ChatParseContext, type ChatRequest, type Dialect, type ImageArtifact, type ImageEditRequest, type ImageGenerationRequest, type ImageResult, type ModelNode, type ModelOperation, type RequestPlan, type TextResult, type VideoGenerationRequest, type VideoResult, type VisionRequest } from '../ports.js';
import { asRecord, bearerHeaders, flattenTextContent, joinUrl, parseOpenAiText } from './shared.js';
import { requestToolNames, resolveToolProtocol, normalizeToolChoice, nativeResult } from './tool-support.js';
import { openAiToolAdapter } from '../../../provider-tools/src/index.js';

const OPS: ModelOperation[] = ['chat', 'vision', 'image.generate', 'image.edit', 'video.generate'];

/** fal 用 `Key <apiKey>`，但允许节点 headers 自带 Authorization 覆盖（代理网关常用 Bearer）。 */
function falHeaders(node: ModelNode): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(node.headers || {}) };
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (node.apiKey && !hasAuth) headers.Authorization = `Key ${node.apiKey}`;
  return headers;
}

/**
 * fal 的模型 id 就是路径。baseUrl 既可以是 https://fal.run，也可以是代理前缀
 * （例如 https://fal.ai/api）——两种情况都只是把 id 拼在后面。
 */
function modelUrl(node: ModelNode, model: string): string {
  const id = String(model || '').trim().replace(/^\/+/, '');
  if (!id) throw new ModelError('fal: 模型 id 为空', { category: 'validation', retryable: false, code: 'missing_model' });
  return joinUrl(node.baseUrl, '/' + id.split('/').map(encodeURIComponent).join('/'));
}

function pickImages(data: unknown): ImageArtifact[] {
  const root = asRecord(data);
  if (root.error !== undefined) {
    const err = asRecord(root.error);
    throw new ModelError(String(err.message || root.error), { category: 'upstream', retryable: false, code: 'fal_error' });
  }
  const candidates: unknown[] = [];
  if (Array.isArray(root.images)) candidates.push(...root.images);
  if (root.image) candidates.push(root.image);
  if (Array.isArray(root.data)) candidates.push(...root.data);
  if (typeof root.url === 'string') candidates.push(root);
  const images: ImageArtifact[] = [];
  candidates.forEach((item, index) => {
    const record = asRecord(item);
    const mimeType = typeof record.content_type === 'string' ? record.content_type : typeof record.mime_type === 'string' ? record.mime_type : undefined;
    if (typeof record.url === 'string' && record.url) {
      images.push({ kind: 'url', data: record.url, ...(mimeType ? { mimeType } : {}), index });
      return;
    }
    if (typeof record.b64_json === 'string' && record.b64_json) {
      images.push({ kind: 'base64', data: record.b64_json, ...(mimeType ? { mimeType } : {}), index });
    }
  });
  if (!images.length) {
    throw new ModelError(`fal: 响应里没有图片（可能是排队中或字段变了）：${JSON.stringify(data).slice(0, 300)}`, {
      category: 'upstream', retryable: false, code: 'fal_no_images',
    });
  }
  return images;
}

function pickVideo(data: unknown): VideoResult {
  const root = asRecord(data);
  if (root.error !== undefined) {
    const err = asRecord(root.error);
    throw new ModelError(String(err.message || root.error), { category: 'upstream', retryable: false, code: 'fal_error' });
  }
  const video = asRecord(root.video);
  const url = typeof video.url === 'string' ? video.url : typeof root.url === 'string' ? root.url : '';
  const requestId = typeof root.request_id === 'string' ? root.request_id : typeof root.requestId === 'string' ? root.requestId : undefined;
  if (!url) {
    // 队列形态：还没出结果。request_id 交给上层登记外部任务并轮询。
    return {
      videos: requestId ? [{ kind: 'url' as const, data: '', requestId, index: 0 }] : [],
      pending: true,
      raw: data,
    };
  }
  return { videos: [{ kind: 'url' as const, data: url, ...(requestId ? { requestId } : {}), index: 0 }], pending: false, raw: data };
}

export const falDialect: Dialect = {
  id: 'fal',
  supports: (op) => OPS.includes(op),
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan {
    const protocol = resolveToolProtocol(req);
    const toolNames = requestToolNames(req);
    const body: Record<string, unknown> = { messages: req.messages };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (protocol === 'native') {
      body.tools = openAiToolAdapter.buildTools(req.toolSpecs || [], { toolNames });
      const choice = normalizeToolChoice(req.toolChoice);
      if (choice) body.tool_choice = openAiToolAdapter.buildToolChoice(choice);
    }
    return { method: 'POST', url: modelUrl(node, req.model), headers: falHeaders(node), body };
  },
  parseChat(data: unknown, context: ChatParseContext = {}): TextResult {
    // fal 转发的 OpenAI 形状优先按 OpenAI 解析；失败再按纯文本字段兜底。
    try {
      return parseOpenAiText(data);
    } catch (error) {
      const root = asRecord(data);
      const text = flattenTextContent(root.output) || flattenTextContent(root.text) || flattenTextContent(root.output_text);
      if (text.trim()) {
        const native = openAiToolAdapter.parseToolResponse(data, context);
        return nativeResult({ text, raw: data }, native);
      }
      throw error;
    }
  },
  buildVision(node: ModelNode, req: VisionRequest): RequestPlan {
    return this.buildChat!(node, {
      model: req.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: req.prompt },
          ...req.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      }],
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    });
  },
  buildImageGeneration(node: ModelNode, req: ImageGenerationRequest): RequestPlan {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      num_images: Math.max(1, Math.min(4, Math.trunc(req.count || 1))),
      // fal 出参给 URL；个别代理只回 base64 时由 pickImages 兼容。
      sync_mode: false,
    };
    // fal 用 image_size（枚举或 {width,height}），不接受 OpenAI 的像素 size 字符串。
    if (req.size && /^\d{2,4}x\d{2,4}$/.test(req.size)) {
      const [width, height] = req.size.split('x').map((value) => Math.trunc(Number(value)));
      if (width && height) body.image_size = { width, height };
    }
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    return { method: 'POST', url: modelUrl(node, req.model), headers: falHeaders(node), body };
  },
  buildImageEdit(node: ModelNode, req: ImageEditRequest): RequestPlan {
    const images = req.images.map((item) => String(item || '').trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      ...(images.length ? { image_url: images[0] } : {}),
      ...(images.length > 1 ? { image_urls: images } : {}),
      num_images: 1,
    };
    if (req.size && /^\d{2,4}x\d{2,4}$/.test(req.size)) {
      const [width, height] = req.size.split('x').map((value) => Math.trunc(Number(value)));
      if (width && height) body.image_size = { width, height };
    }
    return { method: 'POST', url: modelUrl(node, req.model), headers: falHeaders(node), body };
  },
  parseImage(data: unknown): ImageResult {
    return { images: pickImages(data), raw: data };
  },
  buildVideoGeneration(node: ModelNode, req: VideoGenerationRequest): RequestPlan {
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (req.duration !== undefined) body.duration = req.duration;
    if (req.imageUrl) body.image_url = req.imageUrl;
    return { method: 'POST', url: modelUrl(node, req.model), headers: falHeaders(node), body };
  },
  parseVideo(data: unknown): VideoResult {
    return pickVideo(data);
  },
};