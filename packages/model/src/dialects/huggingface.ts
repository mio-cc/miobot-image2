import { ModelError, type ChatParseContext, type ChatRequest, type Dialect, type ModelNode, type ModelOperation, type RequestPlan, type TextResult, type VisionRequest } from '../ports.js';
import { asRecord, bearerHeaders, joinUrl } from './shared.js';
import { openAiDialect } from './openai.js';
import { applyJsonFallbackParse, jsonFallbackRequestMessages, resolveToolProtocol } from './tool-support.js';

const OPS: ModelOperation[] = ['chat', 'vision', 'interrogate'];

/** HuggingFace：openai-chat / router-chat / provider-task 走 OpenAI 兼容；legacy-inference 走 /models/{id} inputs API。 */
export const huggingFaceDialect: Dialect = {
  id: 'huggingface',
  supports: (op) => OPS.includes(op),
  buildChat(node: ModelNode, req: ChatRequest): RequestPlan {
    const mode = node.requestMode || 'openai-chat';
    if (mode === 'legacy-inference') {
      const protocol = resolveToolProtocol(req);
      const messages = protocol === 'json-fallback' || protocol === 'native'
        ? jsonFallbackRequestMessages(req)
        : req.messages;
      const prompt = messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
      const body: Record<string, unknown> = { inputs: prompt, parameters: {} };
      if (req.maxTokens !== undefined) (body.parameters as Record<string, unknown>).max_new_tokens = req.maxTokens;
      return { method: 'POST', url: joinUrl(node.baseUrl, `/models/${req.model}`), headers: bearerHeaders(node.apiKey, node.headers), body };
    }
    return openAiDialect.buildChat(node, req);
  },
  parseChat(data: unknown, context: ChatParseContext = {}): TextResult {
    // legacy-inference: [{generated_text}] 或 {generated_text}
    if (Array.isArray(data)) {
      const first = asRecord(data[0]);
      if (typeof first.generated_text === 'string') return applyJsonFallbackParse({ text: first.generated_text, raw: data }, context);
    }
    const root = asRecord(data);
    if (typeof root.generated_text === 'string') return applyJsonFallbackParse({ text: root.generated_text, raw: data }, context);
    if (root.choices || root.output_text) return openAiDialect.parseChat(data, context);
    throw new ModelError('HuggingFace response missing generated_text/choices', { category: 'validation', retryable: false });
  },
  buildVision(node: ModelNode, req: VisionRequest): RequestPlan {
    return openAiDialect.buildVision!(node, req);
  },
};
