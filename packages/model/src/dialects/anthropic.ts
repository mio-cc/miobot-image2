import { ModelError, type ChatRequest, type Dialect, type ModelNode, type ModelOperation, type RequestPlan, type TextResult, type VisionRequest } from '../ports.js';
import { asRecord, joinUrl } from './shared.js';

const OPS: ModelOperation[] = ['chat', 'vision', 'interrogate'];
const ANTHROPIC_VERSION = '2023-06-01';

function headers(node: ModelNode): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...(node.headers || {}) };
  if (node.apiKey) out['x-api-key'] = node.apiKey;
  return out;
}

/** OpenAI 风格 messages → Anthropic system + messages。 */
function splitMessages(messages: Array<{ role: string; content: unknown }>): { system?: string; messages: Array<{ role: string; content: unknown }> } {
  const systemParts: string[] = [];
  const out: Array<{ role: string; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === 'system') { systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)); continue; }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: toAnthropicContent(m.content) });
  }
  return { system: systemParts.join('\n\n') || undefined, messages: out };
}

function toAnthropicContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = asRecord(part);
      if (p.type === 'text') return { type: 'text', text: String(p.text || '') };
      if (p.type === 'image_url') {
        const url = String(asRecord(p.image_url).url || '');
        const m = url.match(/^data:([^;]+);base64,(.*)$/i);
        if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
        return { type: 'image', source: { type: 'url', url } };
      }
      return { type: 'text', text: '' };
    });
  }
  return String(content ?? '');
}

export const anthropicDialect: Dialect = {
  id: 'anthropic',
  supports: (op) => OPS.includes(op),
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan {
    const { system, messages } = splitMessages(req.messages);
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? 1024, messages };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return { method: 'POST', url: joinUrl(node.baseUrl, '/v1/messages'), headers: headers(node), body };
  },
  parseChat(data: unknown): TextResult {
    const root = asRecord(data);
    if (root.error !== undefined) { const e = asRecord(root.error); throw new ModelError(String(e.message || root.error), { category: 'upstream', retryable: false }); }
    const blocks = Array.isArray(root.content) ? root.content : [];
    const text = blocks.map((b: unknown) => { const r = asRecord(b); return typeof r.text === 'string' ? r.text : ''; }).filter(Boolean).join('\n');
    if (text.trim()) return { text, raw: data };
    throw new ModelError('Anthropic response missing content[].text', { category: 'validation', retryable: false });
  },
  buildVision(node: ModelNode, req: VisionRequest): RequestPlan {
    const content = [
      { type: 'text', text: req.prompt },
      ...req.imageUrls.map((url) => {
        const m = url.match(/^data:([^;]+);base64,(.*)$/i);
        return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } };
      }),
    ];
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? 1024, messages: [{ role: 'user', content }] };
    return { method: 'POST', url: joinUrl(node.baseUrl, '/v1/messages'), headers: headers(node), body };
  },
};
