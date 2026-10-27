import type { ToolCall } from './tool-spec.js';
import type { ToolErrorCode } from './tool-errors.js';

export interface ToolArgumentIssue {
  code: Extract<ToolErrorCode, 'invalid_arguments' | 'missing_required_argument' | 'invalid_argument_type' | 'invalid_enum_value'>;
  message: string;
  path: string;
  expected?: unknown;
  received?: unknown;
}

export interface ToolCallBatchIssue {
  code: Extract<ToolErrorCode, 'invalid_envelope' | 'too_many_tool_calls' | 'duplicate_tool_call_id' | 'conflicting_tool_calls'>;
  message: string;
  callId?: string;
  toolName?: string;
  path?: string;
  expected?: unknown;
  received?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Canonical tool schema shape used by every provider adapter. This function
 * does not invent required fields; it only makes the envelope predictable.
 */
export function normalizeToolInputSchema(input: unknown): Record<string, unknown> {
  const schema = isRecord(input) ? cloneJson(input) : {};
  if (schema.type !== 'object') schema.type = 'object';
  if (!isRecord(schema.properties)) schema.properties = {};
  if (!Array.isArray(schema.required)) schema.required = [];
  else schema.required = schema.required.map((item) => String(item)).filter(Boolean);
  if (schema.additionalProperties === undefined) schema.additionalProperties = false;
  return schema;
}

export function normalizeToolOutputSchema(input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined;
  const schema = cloneJson(input);
  if (schema.type !== 'object') schema.type = 'object';
  if (!isRecord(schema.properties)) schema.properties = {};
  return schema;
}

export function toolSchemaByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Minimal JSON Schema subset needed to reject bad tool arguments before side effects. */
export function validateToolArguments(
  schema: Record<string, unknown>,
  args: unknown,
  options: { maxDepth?: number } = {},
): ToolArgumentIssue[] {
  const issues: ToolArgumentIssue[] = [];
  if (!isRecord(args)) {
    issues.push(issue('invalid_argument_type', '$', 'object', args));
    return issues;
  }
  validateObject(schema, args, '$', issues, 0, Math.max(1, Math.min(20, Math.trunc(options.maxDepth || 8))));
  return issues;
}

export function validateToolCallBatch(calls: unknown[], options: { maxCalls?: number } = {}): ToolCallBatchIssue[] {
  const maxCalls = Math.max(1, Math.trunc(options.maxCalls || 16));
  const issues: ToolCallBatchIssue[] = [];
  if (calls.length > maxCalls) {
    issues.push({
      code: 'too_many_tool_calls',
      message: `Too many tool calls in one model turn (${calls.length} > ${maxCalls}).`,
      expected: maxCalls,
      received: calls.length,
      path: '$',
    });
  }
  const seen = new Map<string, { name: string; args: string }>();
  calls.forEach((raw, index) => {
    if (!isRecord(raw)) {
      issues.push({ code: 'invalid_envelope', message: 'Tool call must be an object.', path: `$[${index}]`, received: raw });
      return;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!id) issues.push({ code: 'invalid_envelope', message: 'Tool call id is required.', path: `$[${index}].id`, expected: 'non-empty string', received: raw.id });
    if (!name) issues.push({ code: 'invalid_envelope', message: 'Tool name is required.', path: `$[${index}].name`, expected: 'non-empty string', received: raw.name });
    if (!('arguments' in raw)) issues.push({ code: 'invalid_envelope', message: 'Tool call arguments are required.', callId: id || undefined, toolName: name || undefined, path: `$[${index}].arguments` });
    if (!id || !name) return;
    const args = stableJson(raw.arguments);
    const prior = seen.get(id);
    if (prior) {
      issues.push({ code: 'duplicate_tool_call_id', message: `Duplicate tool call id: ${id}.`, callId: id, toolName: name, path: `$[${index}].id` });
      if (prior.name !== name || prior.args !== args) {
        issues.push({ code: 'conflicting_tool_calls', message: `Tool call id ${id} is reused with different content.`, callId: id, toolName: name, path: `$[${index}]` });
      }
    } else {
      seen.set(id, { name, args });
    }
  });
  return issues;
}

export function isToolCallEnvelope(value: unknown): value is ToolCall {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.trim().length > 0
    && typeof value.name === 'string' && value.name.trim().length > 0
    && 'arguments' in value;
}

function validateObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  issues: ToolArgumentIssue[],
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth) {
    issues.push(issue('invalid_arguments', path, 'shallow JSON object', value));
    return;
  }
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const key of required) {
    if (!(key in value)) issues.push(issue('missing_required_argument', `${path}.${key}`, 'required argument', undefined));
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const propertySchema = isRecord(properties[key]) ? properties[key] as Record<string, unknown> : undefined;
    if (!propertySchema) {
      if (schema.additionalProperties === false) issues.push(issue('invalid_arguments', childPath, 'declared property', item));
      else if (isRecord(schema.additionalProperties)) validateValue(schema.additionalProperties, item, childPath, issues, depth + 1, maxDepth);
      continue;
    }
    validateValue(propertySchema, item, childPath, issues, depth + 1, maxDepth);
  }
}

function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: ToolArgumentIssue[],
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth) {
    issues.push(issue('invalid_arguments', path, 'shallow JSON value', value));
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    issues.push(issue('invalid_enum_value', path, [...schema.enum], value));
    return;
  }
  const expectedType = typeof schema.type === 'string' ? schema.type : undefined;
  if (expectedType && !matchesType(value, expectedType)) {
    issues.push(issue('invalid_argument_type', path, expectedType, value));
    return;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(issue('invalid_arguments', path, `>= ${schema.minimum}`, value));
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(issue('invalid_arguments', path, `<= ${schema.maximum}`, value));
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push(issue('invalid_arguments', path, `length >= ${schema.minLength}`, value.length));
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push(issue('invalid_arguments', path, `length <= ${schema.maxLength}`, value.length));
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push(issue('invalid_arguments', path, `items >= ${schema.minItems}`, value.length));
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push(issue('invalid_arguments', path, `items <= ${schema.maxItems}`, value.length));
    const items = isRecord(schema.items) ? schema.items as Record<string, unknown> : undefined;
    if (items) value.forEach((item, index) => validateValue(items, item, `${path}[${index}]`, issues, depth + 1, maxDepth));
  }
  if (isRecord(value) && expectedType === 'object') {
    validateObject(schema, value, path, issues, depth + 1, maxDepth);
  }
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return isRecord(value);
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === expected;
}

function issue(code: ToolArgumentIssue['code'], path: string, expected?: unknown, received?: unknown): ToolArgumentIssue {
  const suffix = expected === undefined ? '' : ` (expected ${String(expected).slice(0, 160)})`;
  return { code, path, message: `Invalid tool arguments at ${path}${suffix}.`, expected, received };
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value));
  } catch {
    return String(value);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
  return value;
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])) as T;
  return value;
}
