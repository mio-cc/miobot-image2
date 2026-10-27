import { createHash } from 'node:crypto';

/**
 * Stable protocol/schema error taxonomy. These codes are part of the
 * model-visible repair contract and must not be replaced by free-form text.
 */
export const TOOL_ERROR_CODES = [
  'empty_output',
  'malformed_json',
  'truncated_output',
  'invalid_envelope',
  'missing_tool_call_id',
  'unknown_tool',
  'unavailable_tool',
  'invalid_arguments',
  'missing_required_argument',
  'invalid_argument_type',
  'invalid_enum_value',
  'too_many_tool_calls',
  'duplicate_tool_call_id',
  'conflicting_tool_calls',
  'tool_call_not_executable',
  'tool_execution_failed',
  'approval_required',
  'permission_denied',
  'timeout',
  'cancelled',
] as const;

export type ToolErrorCode = typeof TOOL_ERROR_CODES[number];

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  callId?: string;
  toolName?: string;
  /** JSON path into tool arguments, e.g. $.prompt. */
  path?: string;
  expected?: unknown;
  received?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
  /** Deterministic fingerprint used by repair-loop repeated-error guards. */
  fingerprint?: string;
}

export interface ToolErrorInput {
  code: ToolErrorCode;
  message?: string;
  callId?: string;
  toolName?: string;
  path?: string;
  expected?: unknown;
  received?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class ToolRuntimeError extends Error {
  readonly code: ToolErrorCode;
  readonly callId?: string;
  readonly toolName?: string;
  readonly path?: string;
  readonly expected?: unknown;
  readonly received?: unknown;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly fingerprint: string;

  constructor(input: ToolErrorInput) {
    super(input.message || defaultMessage(input.code));
    this.name = 'ToolRuntimeError';
    this.code = input.code;
    this.callId = input.callId;
    this.toolName = input.toolName;
    this.path = input.path;
    this.expected = input.expected;
    this.received = input.received;
    this.retryable = input.retryable === true;
    this.details = input.details;
    this.fingerprint = fingerprintToolError(this);
  }

  toToolError(): ToolError {
    return {
      code: this.code,
      message: this.message,
      ...(this.callId ? { callId: this.callId } : {}),
      ...(this.toolName ? { toolName: this.toolName } : {}),
      ...(this.path ? { path: this.path } : {}),
      ...(this.expected !== undefined ? { expected: this.expected } : {}),
      ...(this.received !== undefined ? { received: this.received } : {}),
      ...(this.retryable ? { retryable: true } : {}),
      ...(this.details ? { details: this.details } : {}),
      fingerprint: this.fingerprint,
    };
  }
}

export function makeToolError(input: ToolErrorInput): ToolError {
  const error = new ToolRuntimeError(input);
  return error.toToolError();
}

/**
 * Fingerprint deliberately excludes request-specific payload text. A repeated
 * error means the same code/tool/path/shape, not the same user sentence.
 */
export function fingerprintToolError(error: Pick<ToolError, 'code' | 'toolName' | 'path' | 'message' | 'expected'>): string {
  const shape = stableShape(error.expected);
  const messageShape = normalizeMessage(error.message || defaultMessage(error.code));
  const raw = [error.code, error.toolName || '', error.path || '', shape, messageShape].join('\x1f');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function stableShape(value: unknown, depth = 0): string {
  if (value === undefined) return '';
  if (depth > 3) return '[deep]';
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return `[${value.slice(0, 4).map((item) => stableShape(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).slice(0, 8)
      .map(([key, item]) => `${key}:${stableShape(item, depth + 1)}`).join(',')}}`;
  }
  return typeof value;
}

function defaultMessage(code: ToolErrorCode): string {
  return code.replace(/_/g, ' ');
}

export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(value);
}

export function toolErrorFingerprint(error: Pick<ToolError, 'code' | 'toolName' | 'path' | 'message' | 'expected'>): string {
  return fingerprintToolError(error);
}
