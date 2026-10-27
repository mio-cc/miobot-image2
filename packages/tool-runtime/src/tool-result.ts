import type { ToolError } from './tool-errors.js';
import type { ToolExecutionMeta, ToolOutput, ToolResult } from './tool-spec.js';

export function toolSuccess(
  callId: string,
  toolName?: string,
  data: { content?: string; outputs?: ToolOutput[]; jobId?: string; pending?: boolean; meta?: ToolExecutionMeta } = {},
): ToolResult {
  return {
    callId,
    ...(toolName ? { toolName } : {}),
    ok: true,
    ...(data.content !== undefined ? { content: data.content } : {}),
    ...(data.outputs ? { outputs: data.outputs } : {}),
    ...(data.jobId ? { jobId: data.jobId } : {}),
    ...(data.pending ? { pending: true } : {}),
    ...(data.meta ? { meta: data.meta } : {}),
  };
}

export function toolFailure(callId: string, error: ToolError, data: { toolName?: string; content?: string; meta?: ToolExecutionMeta } = {}): ToolResult {
  return {
    callId,
    ...(data.toolName || error.toolName ? { toolName: data.toolName || error.toolName } : {}),
    ok: false,
    error,
    ...(data.content !== undefined ? { content: data.content } : {}),
    ...(data.meta ? { meta: data.meta } : {}),
  };
}

export function toolPending(callId: string, jobId: string, data: { toolName?: string; content?: string; outputs?: ToolOutput[]; meta?: ToolExecutionMeta } = {}): ToolResult {
  return {
    callId,
    ...(data.toolName ? { toolName: data.toolName } : {}),
    ok: true,
    jobId,
    pending: true,
    ...(data.content !== undefined ? { content: data.content } : {}),
    ...(data.outputs ? { outputs: data.outputs } : {}),
    ...(data.meta ? { meta: data.meta } : {}),
  };
}

export function isToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.callId === 'string' && typeof record.ok === 'boolean';
}
