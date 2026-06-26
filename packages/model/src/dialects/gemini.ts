import { ModelError, type ChatRequest, type Dialect, type ImageArtifact, type ImageEditRequest, type ImageGenerationRequest, type ImageResult, type ModelNode, type ModelOperation, type RequestPlan, type TextResult, type VisionRequest } from '../ports.js';
import { asRecord, joinUrl } from './shared.js';

const OPS: ModelOperation[] = ['chat', 'vision', 'interrogate', 'image.generate', 'image.edit'];

function headers(node: ModelNode): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json', ...(node.headers || {}) };
  if (node.apiKey) out['x-goog-api-key'] = node.apiKey;
  return out;
}

function imageToPart(url: string): unknown {
  const raw = String(url || '');
  const m = raw.match(/^data:([^;]+);base64,(.*)$/i);
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
  return { fileData: { fileUri: raw } };
}

function toParts(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = asRecord(part);
      if (p.type === 'image_url') return imageToPart(String(asRecord(p.image_url).url || ''));
      return { text: String(p.text || '') };
    });
  }
  return [{ text: String(content ?? '') }];
}

function buildContents(messages: Array<{ role: string; content: unknown }>): { systemInstruction?: unknown; contents: unknown[] } {
  const systemParts: string[] = [];
  const contents: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') { systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)); continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: toParts(m.content) });
  }
  return { systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined, contents };
}

function generateContentUrl(node: ModelNode, model: string): string {
  return joinUrl(node.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
}

export const geminiDialect: Dialect = {
  id: 'gemini',
  supports: (op) => OPS.includes(op),
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan {
    const { systemInstruction, contents } = buildContents(req.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    const generationConfig: Record<string, unknown> = {};
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return { method: 'POST', url: generateContentUrl(node, req.model), headers: headers(node), body };
  },
  parseChat(data: unknown): TextResult {
    const root = asRecord(data);
    if (root.error !== undefined) { const e = asRecord(root.error); throw new ModelError(String(e.message || root.error), { category: 'upstream', retryable: false, status: typeof e.code === 'number' ? e.code : undefined }); }
    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    for (const c of candidates) {
      const parts = Array.isArray(asRecord(asRecord(c).content).parts) ? asRecord(asRecord(c).content).parts : [];
      const text = parts.map((p: unknown) => String(asRecord(p).text || '')).filter(Boolean).join('\n');
      if (text.trim()) return { text, raw: data };
    }
    throw new ModelError('Gemini response missing candidates[].content.parts[].text', { category: 'validation', retryable: false });
  },
  buildVision(node: ModelNode, req: VisionRequest): RequestPlan {
    return this.buildChat!(node, { model: req.model, messages: [{ role: 'user', content: [{ type: 'text', text: req.prompt }, ...req.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))] }], maxTokens: req.maxTokens });
  },
  // Gemini 原生生图：generateContent + responseModalities，输出在 candidates[].content.parts[].inlineData。
  buildImageGeneration(node: ModelNode, req: ImageGenerationRequest): RequestPlan {
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    };
    return { method: 'POST', url: generateContentUrl(node, req.model), headers: headers(node), body };
  },
  // 图生图/改图：把参考图作为 inlineData 一并送入。
  buildImageEdit(node: ModelNode, req: ImageEditRequest): RequestPlan {
    const parts: unknown[] = [{ text: req.prompt }, ...req.images.map((url) => imageToPart(url))];
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    };
    return { method: 'POST', url: generateContentUrl(node, req.model), headers: headers(node), body };
  },
  parseImage(data: unknown): ImageResult {
    const root = asRecord(data);
    if (root.error !== undefined) { const e = asRecord(root.error); throw new ModelError(String(e.message || root.error), { category: 'upstream', retryable: false, status: typeof e.code === 'number' ? e.code : undefined }); }
    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    const images: ImageArtifact[] = [];
    let index = 0;
    for (const c of candidates) {
      const parts = Array.isArray(asRecord(asRecord(c).content).parts) ? asRecord(asRecord(c).content).parts : [];
      for (const p of parts) {
        const pr = asRecord(p);
        const inline = asRecord(pr.inlineData ?? pr.inline_data);
        const payload = typeof inline.data === 'string' ? inline.data : '';
        if (payload) images.push({ kind: 'base64', data: payload, mimeType: String(inline.mimeType ?? inline.mime_type ?? 'image/png'), index: index++ });
      }
    }
    if (!images.length) throw new ModelError('Gemini image response missing candidates[].content.parts[].inlineData', { category: 'validation', retryable: false });
    return { images, raw: data };
  },
};
