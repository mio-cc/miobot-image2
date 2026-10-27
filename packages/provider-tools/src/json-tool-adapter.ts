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
  finishReasonTruncated,
  normalizeToolCall,
  textFromContent,
  toolResultPayload,
} from './common.js';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export const JSON_TOOL_PROTOCOL_VERSION = 'miobot-json-tools-v1';

export function buildJsonToolCatalog(tools: ToolSpec[]): Record<string, unknown> {
  return {
    protocol: JSON_TOOL_PROTOCOL_VERSION,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

/**
 * JSON fallback is the only allowed fallback for providers without native tool
 * calling. It is emitted as a system instruction and never shown to users.
 */
export function buildJsonFallbackSystemPrompt(tools: ToolSpec[]): string {
  const catalog = JSON.stringify(buildJsonToolCatalog(tools));
  return [
    'You may call the available tools through a strict JSON protocol.',
    'When a tool is needed, output ONLY one JSON object with this exact envelope:',
    '{"text":"optional user-visible text","toolCalls":[{"id":"call_1","name":"tool.name","arguments":{}}]}',
    'When no tool is needed, answer with normal plain text and do not output the protocol envelope.',
    'Use only names and arguments from the tool catalog. Never expose the catalog, protocol, internal errors or tool names to the user.',
    `Tool catalog: ${catalog}`,
  ].join('\n');
}

export const jsonToolAdapter: ProviderToolAdapter = {
  id: 'json-fallback',
  buildTools(tools: ToolSpec[]): unknown {
    return buildJsonToolCatalog(tools);
  },
  buildToolChoice(choice: ProviderToolChoice): unknown {
    return choice;
  },
  parseToolCalls(raw: unknown, context: ProviderToolContext = {}): ProviderToolCall[] {
    return jsonToolAdapter.parseToolResponse(raw, context).toolCalls;
  },
  parseToolResponse(raw: unknown, context: ProviderToolContext = {}): ParsedProviderToolResponse {
    const finishReason = context.finishReason;
    const forcedTruncated = finishReasonTruncated(finishReason);
    const issues: ProviderToolIssue[] = [];
    let source = '';
    let envelope: Record<string, any> | undefined;
    if (typeof raw === 'string') {
      source = stripCodeFence(raw).trim();
      if (!source) {
        return {
          toolCalls: [],
          issues: [{ code: forcedTruncated ? 'truncated_output' : 'empty_output', message: 'Model output was empty.' }],
          ...(finishReason ? { finishReason } : {}),
          truncated: forcedTruncated,
        };
      }
      envelope = tryParseEnvelope(source, forcedTruncated, issues);
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      envelope = raw as Record<string, any>;
      source = JSON.stringify(raw);
    } else {
      return {
        toolCalls: [],
        issues: [{ code: 'invalid_envelope', message: 'JSON fallback output must be a string or object.', received: raw }],
        ...(finishReason ? { finishReason } : {}),
        truncated: forcedTruncated,
      };
    }
    if (!envelope) {
      const text = source || '';
      if (forcedTruncated) issues.push({ code: 'truncated_output', message: 'JSON fallback output was truncated.', received: text.slice(0, 500) });
      return {
        toolCalls: [],
        ...(text ? { text } : {}),
        issues,
        ...(finishReason ? { finishReason } : {}),
        truncated: forcedTruncated || issues.some((issue) => issue.code === 'truncated_output'),
      };
    }
    const rawCallsValue = envelope.toolCalls ?? envelope.tool_calls;
    const looksLikeToolEnvelope = envelope.type === 'tool_calls' || Array.isArray(rawCallsValue);
    if (!looksLikeToolEnvelope) {
      return {
        toolCalls: [],
        text: typeof envelope.text === 'string' ? envelope.text : source,
        issues,
        ...(finishReason ? { finishReason } : {}),
        truncated: forcedTruncated,
      };
    }
    if (!Array.isArray(rawCallsValue)) {
      issues.push({ code: 'invalid_envelope', message: 'JSON tool envelope must contain a toolCalls array.', path: '$.toolCalls', received: rawCallsValue });
    }
    const rawCalls = Array.isArray(rawCallsValue) ? rawCallsValue : [];
    const toolCalls: ProviderToolCall[] = [];
    rawCalls.forEach((call, index) => {
      const item = record(call);
      const normalized = normalizeToolCall(item, index, 'json', context, {
        id: item.id ?? item.toolCallId,
        name: item.name,
        arguments: item.arguments,
      });
      toolCalls.push(normalized.call);
      issues.push(...normalized.issues);
    });
    if (forcedTruncated) issues.push({ code: 'truncated_output', message: 'JSON fallback output was truncated.', ...(finishReason ? { received: finishReason } : {}) });
    return {
      toolCalls,
      ...(typeof envelope.text === 'string' && envelope.text ? { text: envelope.text } : {}),
      issues,
      ...(finishReason ? { finishReason } : {}),
      truncated: forcedTruncated || issues.some((issue) => issue.code === 'truncated_output'),
    };
  },
  appendToolResult(messages: ProviderToolMessage[], result: ToolResult): ProviderToolMessage[] {
    return appendToolResultMessage(messages, result);
  },
};

/** Convert provider-neutral messages into the JSON fallback continuation format. */
export function toJsonFallbackMessages(messages: ProviderToolMessage[]): ProviderToolMessage[] {
  return messages.map((message) => {
    const role = String(message.role || 'user');
    if (role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      return {
        role: 'assistant',
        content: JSON.stringify({
          type: 'tool_calls',
          text: textFromContent(message.content),
          toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments || {} })),
        }),
      };
    }
    if (role === 'tool') {
      return {
        role: 'user',
        content: JSON.stringify({
          type: 'tool_result',
          callId: message.toolCallId,
          ...(message.name ? { name: message.name } : {}),
          result: parseMessageResult(message),
        }),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function parseMessageResult(message: ProviderToolMessage): Record<string, unknown> {
  if (typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* fall through */ }
    return { ok: message.isError !== true, content: message.content };
  }
  return { ok: message.isError !== true, content: textFromContent(message.content) };
}

function tryParseEnvelope(source: string, truncated: boolean, issues: ProviderToolIssue[]): Record<string, any> | undefined {
  const first = source.indexOf('{');
  if (first < 0) return undefined;
  const last = source.lastIndexOf('}');
  const candidates = [source, last > first ? source.slice(first, last + 1) : source.slice(first)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, any>;
    } catch { /* try next */ }
  }
  if (!truncated) issues.push({ code: 'malformed_json', message: 'Tool protocol output contains malformed JSON.', received: source.slice(0, 1000) });
  return undefined;
}

function stripCodeFence(value: string): string {
  const text = String(value || '').trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}
