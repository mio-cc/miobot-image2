import type { ProviderToolChoice, ProviderToolProtocol } from '../../../provider-tools/src/index.js';
import { buildJsonFallbackSystemPrompt, jsonToolAdapter, toJsonFallbackMessages, type ProviderToolMessage } from '../../../provider-tools/src/index.js';
import type { ChatMessage, ChatParseContext, ChatRequest, TextResult, ToolCall } from '../ports.js';

export function resolveToolProtocol(req: ChatRequest): ProviderToolProtocol {
  if (!Array.isArray(req.toolSpecs) || req.toolSpecs.length === 0) return 'none';
  if (req.toolProtocol === 'none') return 'none';
  if (req.toolProtocol === 'json-fallback') return 'json-fallback';
  return 'native';
}

export function normalizeToolChoice(value: unknown): ProviderToolChoice | undefined {
  return value === 'auto' || value === 'required' || value === 'none' ? value : undefined;
}

export function requestToolNames(req: ChatRequest): string[] {
  const names = (req.toolSpecs || []).map((tool) => tool.name);
  for (const message of req.messages || []) {
    for (const call of message.toolCalls || []) if (call.name) names.push(call.name);
    if (typeof message.name === 'string' && message.name) names.push(message.name);
  }
  return Array.from(new Set(names.filter(Boolean)));
}

export function parseContextForRequest(req: ChatRequest): ChatParseContext {
  return {
    toolProtocol: resolveToolProtocol(req),
    toolNames: requestToolNames(req),
  };
}

export function toModelToolCalls(calls: Array<{ id: string; name: string; arguments: Record<string, unknown>; rawArguments?: string; parseError?: string }>): ToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    ...(call.rawArguments !== undefined ? { rawArguments: call.rawArguments } : {}),
    ...(call.parseError ? { parseError: call.parseError } : {}),
  }));
}

/** Apply the JSON envelope parser after a dialect has extracted visible text. */
export function applyJsonFallbackParse(base: TextResult, context: ChatParseContext = {}): TextResult {
  if (context.toolProtocol !== 'json-fallback') return base;
  const parsed = jsonToolAdapter.parseToolResponse(base.text, {
    ...(context.toolNames ? { toolNames: context.toolNames } : {}),
    ...(base.finishReason ? { finishReason: base.finishReason } : {}),
  });
  if (!parsed.toolCalls.length && !parsed.issues.length) return { ...base, ...(parsed.text !== undefined ? { text: parsed.text } : {}) };
  return {
    ...base,
    text: parsed.text ?? '',
    toolCalls: toModelToolCalls(parsed.toolCalls),
    toolCallIssues: parsed.issues,
    ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
    truncated: parsed.truncated || base.truncated === true,
  };
}

export function nativeResult(base: TextResult, parsed: {
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; rawArguments?: string; parseError?: string }>;
  text?: string;
  issues: TextResult['toolCallIssues'];
  finishReason?: string;
  truncated: boolean;
}): TextResult {
  if (!parsed.toolCalls.length && !parsed.issues?.length) {
    return {
      ...base,
      ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
      ...(parsed.truncated ? { truncated: true } : {}),
    };
  }
  return {
    ...base,
    text: parsed.text ?? base.text ?? '',
    ...(parsed.toolCalls.length ? { toolCalls: toModelToolCalls(parsed.toolCalls) } : {}),
    ...(parsed.issues?.length ? { toolCallIssues: parsed.issues } : {}),
    ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
    ...(parsed.truncated ? { truncated: true } : {}),
  };
}

/** Build provider-neutral messages for the JSON fallback protocol. */
export function jsonFallbackRequestMessages(req: ChatRequest): ChatMessage[] {
  const tools = req.toolSpecs || [];
  const normalized = toJsonFallbackMessages(req.messages as ProviderToolMessage[]) as ChatMessage[];
  if (!tools.length) return normalized;
  return [{ role: 'system', content: buildJsonFallbackSystemPrompt(tools) }, ...normalized];
}