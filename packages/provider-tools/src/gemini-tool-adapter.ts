import type { ToolResult, ToolSpec } from '../../tool-runtime/src/index.js';
import type {
  ParsedProviderToolResponse,
  ProviderToolAdapter,
  ProviderToolCall,
  ProviderToolChoice,
  ProviderToolContext,
  ProviderToolIssue,
  ProviderToolMessage,
} from './types.js';
import {
  appendToolResultMessage,
  createToolNameMap,
  finishReasonTruncated,
  normalizeToolCall,
  textFromContent,
  toolResultPayload,
} from './common.js';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function contextForTools(tools: ToolSpec[], context: ProviderToolContext = {}): ProviderToolContext {
  return { ...context, toolNames: Array.from(new Set([...(context.toolNames || []), ...tools.map((tool) => tool.name)])) };
}

function contextForMessages(messages: ProviderToolMessage[], context: ProviderToolContext = {}): ProviderToolContext {
  const names = [...(context.toolNames || [])];
  for (const message of messages) for (const call of message.toolCalls || []) if (call.name) names.push(call.name);
  return { ...context, toolNames: Array.from(new Set(names)) };
}

function toolResponseObject(message: ProviderToolMessage): Record<string, unknown> {
  const content = typeof message.content === 'string' ? message.content : textFromContent(message.content);
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  return { ok: message.isError !== true, content };
}

export const geminiToolAdapter: ProviderToolAdapter = {
  id: 'gemini',
  buildTools(tools: ToolSpec[], context: ProviderToolContext = {}): unknown {
    const ctx = contextForTools(tools, context);
    const map = createToolNameMap(ctx.toolNames || []);
    return [{
      functionDeclarations: tools.map((tool) => ({
        name: map.canonicalToWire[tool.name] || tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    }];
  },
  buildToolChoice(choice: ProviderToolChoice): unknown {
    return { functionCallingConfig: { mode: choice === 'required' ? 'ANY' : choice === 'none' ? 'NONE' : 'AUTO' } };
  },
  parseToolCalls(raw: unknown, context: ProviderToolContext = {}): ProviderToolCall[] {
    return geminiToolAdapter.parseToolResponse(raw, context).toolCalls;
  },
  parseToolResponse(raw: unknown, context: ProviderToolContext = {}): ParsedProviderToolResponse {
    const root = record(raw);
    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    const candidate = record(candidates[0]);
    const parts = Array.isArray(record(candidate.content).parts) ? record(candidate.content).parts as unknown[] : [];
    const finishReason = String(candidate.finishReason ?? candidate.finish_reason ?? context.finishReason ?? '') || undefined;
    const truncated = finishReasonTruncated(finishReason);
    const text = parts.map((part) => { const item = record(part); return typeof item.text === 'string' ? item.text : ''; }).filter(Boolean).join('\n');
    const issues: ProviderToolIssue[] = [];
    const toolCalls: ProviderToolCall[] = [];
    parts.forEach((part, index) => {
      const item = record(part);
      const fn = record(item.functionCall ?? item.function_call);
      if (!fn.name) return;
      const normalized = normalizeToolCall(fn, index, 'gemini', context, {
        id: fn.id,
        name: fn.name,
        arguments: fn.args ?? fn.arguments,
        allowMissingId: true,
      });
      toolCalls.push(normalized.call);
      issues.push(...normalized.issues);
    });
    if (truncated) issues.push({ code: 'truncated_output', message: 'Gemini output reached the token limit.', ...(finishReason ? { received: finishReason } : {}) });
    return {
      toolCalls,
      ...(text ? { text } : {}),
      issues,
      ...(finishReason ? { finishReason } : {}),
      truncated,
    };
  },
  appendToolResult(messages: ProviderToolMessage[], result: ToolResult): ProviderToolMessage[] {
    return appendToolResultMessage(messages, result);
  },
};

/** Convert provider-neutral tool messages into Gemini systemInstruction + contents. */
export function toGeminiContents(messages: ProviderToolMessage[], context: ProviderToolContext = {}): { systemInstruction?: unknown; contents: Array<Record<string, unknown>> } {
  const ctx = contextForMessages(messages, context);
  const map = createToolNameMap(ctx.toolNames || []);
  const systemParts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];
  const callNameById = new Map<string, string>();
  const callNameByName = new Map<string, string>();
  let lastWasToolGroup = false;
  for (const message of messages) {
    const role = String(message.role || 'user');
    if (role === 'system') {
      systemParts.push(textFromContent(message.content, JSON.stringify(message.content ?? '')));
      lastWasToolGroup = false;
      continue;
    }
    if (role === 'tool') {
      const name = message.name || callNameById.get(String(message.toolCallId || '')) || callNameByName.get(String(message.name || '')) || '';
      const part = {
        functionResponse: {
          name: name ? (map.canonicalToWire[name] || name) : String(message.name || ''),
          response: toolResponseObject(message),
        },
      };
      if (lastWasToolGroup && contents.length) {
        const previous = contents[contents.length - 1];
        const parts = Array.isArray(previous.parts) ? previous.parts : [];
        previous.parts = [...parts, part];
      } else {
        contents.push({ role: 'user', parts: [part] });
        lastWasToolGroup = true;
      }
      continue;
    }
    if (role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      const parts: unknown[] = [];
      const text = textFromContent(message.content);
      if (text) parts.push({ text });
      for (const call of message.toolCalls) {
        callNameById.set(call.id, call.name);
        callNameByName.set(call.name, call.name);
        parts.push({
          functionCall: {
            name: map.canonicalToWire[call.name] || call.name,
            args: call.arguments || {},
          },
        });
      }
      contents.push({ role: 'model', parts });
      lastWasToolGroup = false;
      continue;
    }
    contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: Array.isArray(message.content) ? message.content : [{ text: textFromContent(message.content) }] });
    lastWasToolGroup = false;
  }
  return { ...(systemParts.length ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } } : {}), contents };
}
