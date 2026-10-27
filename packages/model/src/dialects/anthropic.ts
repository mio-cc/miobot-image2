import { ModelError, type ChatParseContext, type ChatRequest, type Dialect, type ModelNode, type ModelOperation, type RequestPlan, type TextResult, type VisionRequest } from '../ports.js';
import { asRecord, joinUrl } from './shared.js';
import { anthropicToolAdapter, hasToolMessages, toAnthropicMessages, type ProviderToolMessage } from '../../../provider-tools/src/index.js';
import { applyJsonFallbackParse, jsonFallbackRequestMessages, nativeResult, normalizeToolChoice, requestToolNames, resolveToolProtocol } from './tool-support.js';

const OPS: ModelOperation[] = ['chat', 'vision', 'interrogate'];
const ANTHROPIC_VERSION = '2023-06-01';

function headers(node: ModelNode): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...(node.headers || {}) };
  if (node.apiKey && !Object.keys(out).some((key) => key.toLowerCase() === 'x-api-key' || key.toLowerCase() === 'authorization')) out['x-api-key'] = node.apiKey;
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
    const protocol = resolveToolProtocol(req);
    const toolNames = requestToolNames(req);
    const { system, messages } = protocol === 'json-fallback'
      ? splitMessages(jsonFallbackRequestMessages(req))
      : hasToolMessages(req.messages as unknown as Array<Record<string, unknown>>)
        ? toAnthropicMessages(req.messages as ProviderToolMessage[], { toolNames })
        : splitMessages(req.messages);
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? 1024, messages };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (protocol === 'native') {
      body.tools = anthropicToolAdapter.buildTools(req.toolSpecs || [], { toolNames });
      const choice = normalizeToolChoice(req.toolChoice);
      if (choice) body.tool_choice = anthropicToolAdapter.buildToolChoice(choice);
    } else if (!req.toolSpecs?.length && req.tools) {
      body.tools = req.tools;
      if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
    }
    return { method: 'POST', url: joinUrl(node.baseUrl, '/v1/messages'), headers: headers(node), body };
  },
  parseChat(data: unknown, context: ChatParseContext = {}): TextResult {
    return parseAnthropicChat(data, context);
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

function parseAnthropicChat(data: unknown, context: ChatParseContext = {}): TextResult {
  const root = asRecord(data);
  if (root.error !== undefined) {
    const error = asRecord(root.error);
    throw new ModelError(String(error.message || root.error), { category: 'upstream', retryable: false });
  }
  const finishReason = String(root.stop_reason ?? '').trim() || undefined;
  const native = anthropicToolAdapter.parseToolResponse(data, {
    ...context,
    ...(finishReason ? { finishReason } : {}),
  });
  const blocks = Array.isArray(root.content) ? root.content : [];
  const text = blocks.map((block: unknown) => { const item = asRecord(block); return typeof item.text === 'string' ? item.text : ''; }).filter(Boolean).join('\n');
  const base: TextResult = {
    text,
    raw: data,
    ...(native.finishReason ? { finishReason: native.finishReason } : {}),
    ...(native.truncated ? { truncated: true } : {}),
  };
  if (context.toolProtocol === 'json-fallback') return applyJsonFallbackParse(base, context);
  if (!text.trim() && !native.toolCalls.length && !native.issues.length) {
    throw new ModelError('Anthropic response missing content[].text', { category: 'validation', retryable: false });
  }
  return nativeResult(base, native);
}
