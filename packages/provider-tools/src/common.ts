import type { ToolResult } from '../../tool-runtime/src/index.js';
import type {
  ParsedProviderToolResponse,
  ProviderToolCall,
  ProviderToolContext,
  ProviderToolIssue,
  ProviderToolMessage,
} from './types.js';

export interface ToolNameMap {
  canonicalToWire: Record<string, string>;
  wireToCanonical: Record<string, string>;
}

export function createToolNameMap(names: string[]): ToolNameMap {
  const canonicalToWire: Record<string, string> = {};
  const wireToCanonical: Record<string, string> = {};
  for (const raw of names) {
    const canonical = String(raw || '').trim();
    if (!canonical || canonicalToWire[canonical]) continue;
    const base = sanitizeProviderToolName(canonical);
    let wire = base;
    let suffix = 2;
    while (wireToCanonical[wire] && wireToCanonical[wire] !== canonical) {
      const marker = `_${suffix}`;
      wire = `${base.slice(0, Math.max(1, 64 - marker.length))}${marker}`;
      suffix += 1;
    }
    canonicalToWire[canonical] = wire;
    wireToCanonical[wire] = canonical;
  }
  return { canonicalToWire, wireToCanonical };
}

export function mapProviderToolName(name: string, context: ProviderToolContext = {}): string {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  const map = createToolNameMap(context.toolNames || []);
  return map.wireToCanonical[raw] || raw;
}

export function wireToolName(name: string, context: ProviderToolContext = {}): string {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  const map = createToolNameMap(context.toolNames || []);
  return map.canonicalToWire[raw] || sanitizeProviderToolName(raw);
}

export function sanitizeProviderToolName(name: string): string {
  const raw = String(name || '').trim();
  let safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  if (!safe) safe = 'tool';
  if (!/^[a-zA-Z_]/.test(safe)) safe = `tool_${safe}`;
  if (safe.length > 64) safe = `${safe.slice(0, 55)}_${hash36(raw).slice(0, 8)}`;
  return safe;
}

export function parseArguments(
  value: unknown,
  callId: string,
  toolName: string,
): { arguments: Record<string, unknown>; rawArguments?: string; issue?: ProviderToolIssue } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { arguments: value as Record<string, unknown> };
  }
  if (typeof value === 'string') {
    const rawArguments = value;
    if (!value.trim()) return { arguments: {}, rawArguments };
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { arguments: parsed as Record<string, unknown>, rawArguments };
      }
      return {
        arguments: {},
        rawArguments,
        issue: { code: 'invalid_envelope', message: 'Tool arguments must parse to a JSON object.', callId, toolName, path: '$.arguments', received: parsed },
      };
    } catch {
      return {
        arguments: {},
        rawArguments,
        issue: { code: 'malformed_json', message: 'Tool arguments contain malformed JSON.', callId, toolName, path: '$.arguments', received: value.slice(0, 500) },
      };
    }
  }
  if (value === undefined) return { arguments: {} };
  return {
    arguments: {},
    issue: { code: 'invalid_envelope', message: 'Tool arguments must be a JSON object.', callId, toolName, path: '$.arguments', received: value },
  };
}

export function normalizeToolCall(
  raw: unknown,
  index: number,
  fallbackPrefix: string,
  context: ProviderToolContext = {},
  explicit?: { id?: unknown; name?: unknown; arguments?: unknown; rawArguments?: unknown; allowMissingId?: boolean },
): { call: ProviderToolCall; issues: ProviderToolIssue[] } {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const issues: ProviderToolIssue[] = [];
  const idText = String(explicit?.id ?? record.id ?? record.tool_call_id ?? record.toolUseId ?? '').trim();
  const id = idText || `${fallbackPrefix}_call_${index + 1}`;
  if (!idText && explicit?.allowMissingId !== true) {
    issues.push({ code: 'missing_tool_call_id', message: 'Provider tool call is missing id; runtime synthesized a non-refillable id.', callId: id, path: '$.id' });
  }
  const rawName = String(explicit?.name ?? record.name ?? record.tool ?? '').trim();
  const name = mapProviderToolName(rawName, context);
  if (!name) {
    issues.push({ code: 'invalid_envelope', message: 'Provider tool call is missing a tool name.', callId: id, path: '$.name' });
  }
  const argsValue = explicit?.arguments ?? record.arguments ?? record.args ?? record.input ?? {};
  const parsed = parseArguments(argsValue, id, name);
  if (parsed.issue) issues.push(parsed.issue);
  return {
    call: {
      id,
      name,
      arguments: parsed.arguments,
      ...(parsed.rawArguments !== undefined || explicit?.rawArguments !== undefined
        ? { rawArguments: String(explicit?.rawArguments ?? parsed.rawArguments) }
        : {}),
      ...(parsed.issue ? { parseError: parsed.issue.code } : {}),
    },
    issues,
  };
}

export function finishReasonTruncated(reason: unknown): boolean {
  const value = String(reason || '').trim().toLowerCase();
  return value === 'length' || value === 'max_tokens' || value === 'max_output_tokens' || value === 'token_limit';
}

export function toolResultPayload(result: ToolResult): Record<string, unknown> {
  return {
    callId: result.callId,
    ...(result.toolName ? { toolName: result.toolName } : {}),
    ok: result.ok,
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(result.outputs ? { outputs: result.outputs } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.jobId ? { jobId: result.jobId } : {}),
    ...(result.pending ? { pending: true } : {}),
  };
}

export function toolResultContent(result: ToolResult): string {
  try {
    return JSON.stringify(toolResultPayload(result));
  } catch {
    return JSON.stringify({ callId: result.callId, ok: result.ok, error: { code: 'tool_execution_failed', message: 'Tool result was not serializable.' } });
  }
}

export function createToolResultMessage(result: ToolResult): ProviderToolMessage {
  return {
    role: 'tool',
    toolCallId: result.callId,
    ...(result.toolName ? { name: result.toolName } : {}),
    content: toolResultContent(result),
    isError: result.ok === false,
  };
}

export function appendToolResultMessage(messages: ProviderToolMessage[], result: ToolResult): ProviderToolMessage[] {
  return [
    ...(Array.isArray(messages) ? messages : []),
    createToolResultMessage(result),
  ];
}

export function hasToolMessages(messages: Array<Record<string, unknown>>): boolean {
  return messages.some((message) => message.role === 'tool' || Array.isArray(message.toolCalls) || Array.isArray(message.tool_calls));
}

export function emptyParsedResponse(context: ProviderToolContext = {}): ParsedProviderToolResponse {
  const truncated = finishReasonTruncated(context.finishReason);
  return {
    toolCalls: [],
    issues: truncated ? [{ code: 'truncated_output', message: 'Model output reached the token limit.' }] : [],
    ...(context.finishReason ? { finishReason: context.finishReason } : {}),
    truncated,
  };
}

export function textFromContent(content: unknown, fallback = ''): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const record = part && typeof part === 'object' ? part as Record<string, unknown> : {};
      return typeof record.text === 'string' ? record.text : '';
    }).filter(Boolean).join('\n');
  }
  if (content === undefined || content === null) return fallback;
  try { return JSON.stringify(content); } catch { return fallback; }
}

function hash36(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return Math.abs(hash >>> 0).toString(36);
}
