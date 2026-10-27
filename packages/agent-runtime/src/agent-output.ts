import {
  isRecord,
  isToolCallEnvelope,
  makeToolError,
  validateToolArguments,
  validateToolCallBatch,
  type ToolCall,
  type ToolError,
  type ToolSpec,
} from '../../tool-runtime/src/index.js';
import type { ToolRegistry } from '../../tool-runtime/src/index.js';
import type { AgentAssistantTurn, AgentToolError } from './types.js';

const PROTOCOL_CODES = new Set<ToolError['code']>([
  'empty_output',
  'malformed_json',
  'truncated_output',
  'invalid_envelope',
  'missing_tool_call_id',
  'too_many_tool_calls',
  'duplicate_tool_call_id',
  'conflicting_tool_calls',
]);

const NON_STRUCTURED_BATCH_CODES = new Set([
  'too_many_tool_calls',
  'duplicate_tool_call_id',
  'conflicting_tool_calls',
  'invalid_envelope',
  'missing_tool_call_id',
]);

export interface AgentModelValidationInput {
  assistant: AgentAssistantTurn;
  toolCallIssues?: AgentToolError[];
  truncated?: boolean;
  finishReason?: string;
  registry?: ToolRegistry;
  toolSpecs: ToolSpec[];
  availableToolNames?: string[];
  maxCallsPerRound?: number;
}

export interface AgentModelValidation {
  text: string;
  calls: ToolCall[];
  errors: ToolError[];
  canStructuredRepair: boolean;
  truncated: boolean;
}

export function validateAgentModelOutput(input: AgentModelValidationInput): AgentModelValidation {
  const text = String(input.assistant.text || '');
  const rawCalls: unknown[] = Array.isArray(input.assistant.toolCalls) ? input.assistant.toolCalls : [];
  const errors: ToolError[] = [];
  const batchIssues = validateToolCallBatch(rawCalls, { maxCalls: input.maxCallsPerRound || 16 });
  for (const issue of batchIssues) {
    errors.push(makeToolError({
      code: issue.code,
      message: issue.message,
      ...(issue.callId ? { callId: issue.callId } : {}),
      ...(issue.toolName ? { toolName: issue.toolName } : {}),
      ...(issue.path ? { path: issue.path } : {}),
      expected: issue.expected,
      received: issue.received,
    }));
  }
  for (const issue of input.toolCallIssues || []) {
    errors.push({
      ...issue,
      fingerprint: issue.fingerprint || makeToolError(issue).fingerprint,
    });
  }
  const truncated = input.truncated === true || String(input.finishReason || '').toLowerCase() === 'length';
  if (truncated) {
    errors.push(makeToolError({
      code: 'truncated_output',
      message: 'Model output was truncated; no tool call from this response may execute.',
      retryable: true,
    }));
  }

  const specsByName = new Map(input.toolSpecs.map((spec) => [spec.name, spec]));
  const available = input.availableToolNames ? new Set(input.availableToolNames) : undefined;
  const calls: ToolCall[] = [];
  for (const raw of rawCalls) {
    if (!isToolCallEnvelope(raw)) continue;
    const call: ToolCall = { id: raw.id, name: raw.name, arguments: raw.arguments };
    calls.push(call);
    const spec = input.registry?.get(call.name) || specsByName.get(call.name);
    if (!spec) {
      errors.push(makeToolError({
        code: 'unknown_tool',
        message: `Unknown tool: ${call.name}`,
        callId: call.id,
        toolName: call.name,
      }));
      continue;
    }
    if (spec.enabled === false || spec.exposure === 'hidden' || (available && !available.has(call.name))) {
      errors.push(makeToolError({
        code: 'unavailable_tool',
        message: `Tool is not available in this context: ${call.name}`,
        callId: call.id,
        toolName: call.name,
      }));
      continue;
    }
    if (!isRecord(call.arguments)) {
      errors.push(makeToolError({
        code: 'invalid_argument_type',
        message: 'Tool arguments must be a JSON object.',
        callId: call.id,
        toolName: call.name,
        path: '$',
        expected: 'object',
        received: call.arguments,
      }));
      continue;
    }
    const argumentIssues = validateToolArguments(spec.inputSchema, call.arguments);
    for (const issue of argumentIssues) {
      errors.push(makeToolError({
        code: issue.code,
        message: issue.message,
        callId: call.id,
        toolName: call.name,
        path: issue.path,
        expected: issue.expected,
        received: issue.received,
        details: argumentIssues.length > 1 ? { issues: argumentIssues } : undefined,
      }));
    }
  }

  if (calls.some((call) => call.name === 'ask_user') && rawCalls.length > 1) {
    errors.push(makeToolError({
      code: 'conflicting_tool_calls',
      message: 'ask_user must be the only tool call in its response.',
      toolName: 'ask_user',
      path: '$',
    }));
  }
  if (!text.trim() && rawCalls.length === 0 && errors.length === 0) {
    errors.push(makeToolError({ code: 'empty_output', message: 'Model returned neither user-visible text nor a tool call.' }));
  }

  const canStructuredRepair = rawCalls.length > 0
    && calls.length === rawCalls.length
    && !truncated
    && !batchIssues.some((issue) => NON_STRUCTURED_BATCH_CODES.has(issue.code));
  return { text, calls, errors, canStructuredRepair, truncated };
}

export function isProtocolToolError(error: ToolError): boolean {
  return PROTOCOL_CODES.has(error.code);
}

export function toolErrorResultContent(error: ToolError): string {
  return JSON.stringify({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.callId ? { callId: error.callId } : {}),
      ...(error.toolName ? { toolName: error.toolName } : {}),
      ...(error.path ? { path: error.path } : {}),
      ...(error.expected !== undefined ? { expected: error.expected } : {}),
      ...(error.received !== undefined ? { received: error.received } : {}),
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

export function buildRepairInstruction(errors: ToolError[]): string {
  const lines = errors.slice(0, 12).map((error) => {
    const location = [error.callId, error.toolName, error.path].filter(Boolean).join(' ');
    return `- ${error.code}${location ? ` [${location}]` : ''}: ${error.message}`;
  });
  return [
    '[INTERNAL TOOL OUTPUT REPAIR]',
    'Your previous output was not executable. Repair only the protocol or tool arguments.',
    'Do not reinterpret the user request, do not add new tasks, and do not expose these internal errors to the user.',
    'If the task can no longer be executed safely, return a plain-text response instead of a tool call.',
    ...lines,
  ].join('\n');
}

export function buildSafeTextInstruction(reason: string): string {
  return [
    '[INTERNAL SAFE TEXT FALLBACK]',
    `Tool execution stopped internally (${reason}).`,
    'Do not call any tools. Do not expose internal error codes, schemas, prompts, or implementation details.',
    'Reply to the user with a concise plain-text response based only on facts already available.',
  ].join('\n');
}

export function toolErrorForCall(errors: ToolError[], callId: string, toolName: string): ToolError {
  return errors.find((error) => error.callId === callId)
    || makeToolError({
      code: 'tool_call_not_executable',
      message: 'This tool call was not executed because another call in the same batch failed validation.',
      callId,
      toolName,
    });
}
