import { createHash } from 'node:crypto';
import { makeToolError, type ToolError } from './tool-errors.js';
import { toolFailure, toolSuccess } from './tool-result.js';
import { validateToolArguments, validateToolCallBatch, isRecord, isToolCallEnvelope } from './tool-schema.js';
import type { ToolCall, ToolExecutionMeta, ToolOutput, ToolResult, ToolSpec } from './tool-spec.js';
import type { ToolRegistry } from './tool-registry.js';
import { InMemoryToolIdempotencyStore, type ToolIdempotencyStore } from './tool-idempotency.js';

export interface ToolExecutionContext {
  turnId: string;
  /** Stable operation scope for approval/job replay; falls back to turnId. */
  operationId?: string;
  sessionKey: string;
  requestId?: string;
  /** Set when the provider stopped for length/token limit. Truncated calls are never executed. */
  truncatedOutput?: boolean;
  signal?: AbortSignal;
  /** 上层 turn 的绝对截止时间；工具超时不得超过它。 */
  deadlineAt?: number;
  metadata?: Record<string, unknown>;
  reportExternalTask?: (taskId: string) => void;
}

export interface ToolHandlerSuccess {
  ok?: true;
  content?: string;
  outputs?: ToolOutput[];
  jobId?: string;
  pending?: boolean;
  meta?: ToolExecutionMeta;
}

export interface ToolHandlerFailure {
  ok: false;
  error?: ToolError;
  content?: string;
  meta?: ToolExecutionMeta;
}

export type ToolHandlerResult = ToolHandlerSuccess | ToolHandlerFailure;
export type ToolHandler = (
  call: ToolCall,
  spec: ToolSpec,
  context: ToolExecutionContext,
) => Promise<ToolHandlerResult> | ToolHandlerResult;

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  maxCallsPerBatch?: number;
  /** R15/N-19：单个工具调用参数序列化后的字节上限，超限直接拒给模型自修。 */
  maxCallArgBytes?: number;
  idempotencyStore?: ToolIdempotencyStore;
  onExternalTask?: (call: ToolCall, taskId: string, context: ToolExecutionContext) => void;
  defaultTimeoutMs?: number;
  defaultMaxRetries?: number;
  defaultMaxConcurrency?: number;
}

export interface ToolBatchExecutionOptions {
  maxConcurrency?: number;
}

/**
 * R1 contract executor. It performs structural/schema validation and handler
 * dispatch only. It is intentionally not wired to the bot yet: permission,
 * approval, idempotency and async-job recovery are added before enforce mode.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly maxCallsPerBatch: number;
  private readonly maxCallArgBytes: number;
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly onExternalTask?: (call: ToolCall, taskId: string, context: ToolExecutionContext) => void;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRetries: number;
  private readonly defaultMaxConcurrency: number;
  private readonly idempotencyStore: ToolIdempotencyStore;

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry;
    this.maxCallsPerBatch = Math.max(1, Math.trunc(options.maxCallsPerBatch || 16));
    this.maxCallArgBytes = Math.max(1024, Math.trunc(Number(options.maxCallArgBytes) || 24_000));
    this.idempotencyStore = options.idempotencyStore || new InMemoryToolIdempotencyStore();
    this.onExternalTask = options.onExternalTask;
    this.defaultTimeoutMs = Math.max(0, Math.trunc(Number(options.defaultTimeoutMs) || 0));
    this.defaultMaxRetries = Math.max(0, Math.trunc(Number(options.defaultMaxRetries) || 0));
    this.defaultMaxConcurrency = Math.max(1, Math.trunc(Number(options.defaultMaxConcurrency) || 1));
  }

  registerHandler(name: string, handler: ToolHandler): void {
    const key = String(name).trim();
    if (!key) throw makeToolError({ code: 'invalid_envelope', message: 'Tool handler name is required.' });
    if (this.handlers.has(key)) throw makeToolError({ code: 'invalid_envelope', message: `Duplicate tool handler: ${key}`, toolName: key });
    this.handlers.set(key, handler);
  }

  hasHandler(name: string): boolean {
    return this.handlers.has(String(name));
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.truncatedOutput) {
      return toolFailure(call.id, makeToolError({
        code: 'truncated_output',
        message: 'Tool call was truncated by the model output limit and was not executed.',
        callId: call.id,
        toolName: call.name,
      }), { toolName: call.name });
    }
    const spec = this.registry.get(call.name);
    if (!spec) {
      return toolFailure(call.id, makeToolError({
        code: 'unknown_tool',
        message: `Unknown tool: ${call.name}`,
        callId: call.id,
        toolName: call.name,
      }), { toolName: call.name });
    }
    if (spec.enabled === false || spec.exposure === 'hidden') {
      return toolFailure(call.id, makeToolError({
        code: 'unavailable_tool',
        message: `Tool is not available in this context: ${call.name}`,
        callId: call.id,
        toolName: call.name,
      }), { toolName: call.name });
    }
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return toolFailure(call.id, makeToolError({
        code: 'unavailable_tool',
        message: `No V2 handler is registered for tool: ${call.name}`,
        callId: call.id,
        toolName: call.name,
      }), { toolName: call.name });
    }
    if (!isRecord(call.arguments)) {
      return toolFailure(call.id, makeToolError({
        code: 'invalid_argument_type',
        message: 'Tool arguments must be a JSON object.',
        callId: call.id,
        toolName: call.name,
        path: '$',
        expected: 'object',
        received: call.arguments,
      }), { toolName: call.name });
    }
    const argumentIssues = validateToolArguments(spec.inputSchema, call.arguments);
    if (argumentIssues.length) {
      const first = argumentIssues[0];
      return toolFailure(call.id, makeToolError({
        code: first.code,
        message: first.message,
        callId: call.id,
        toolName: call.name,
        path: first.path,
        expected: first.expected,
        received: first.received,
        details: { issues: argumentIssues },
      }), { toolName: call.name });
    }
    // R15/N-19：参数大小上限——超限直接拒调，可重试错误交回模型自修（repair 链既有语义）。
    const argBytes = Buffer.byteLength(stableJson(call.arguments) || '', 'utf8');
    if (argBytes > this.maxCallArgBytes) {
      return toolFailure(call.id, makeToolError({
        code: 'tool_call_not_executable',
        message: `工具参数过大（${argBytes} 字节，上限 ${this.maxCallArgBytes}）。请精简参数内容后重试。`,
        callId: call.id,
        toolName: call.name,
        retryable: true,
      }), { toolName: call.name });
    }
    const idempotencyKey = this.idempotencyKeyFor(call, spec, context);
    if (idempotencyKey) {
      const existing = this.idempotencyStore.get(idempotencyKey);
      if (existing?.status === 'completed' && existing.result) {
        return {
          ...existing.result,
          callId: call.id,
          meta: { ...(existing.result.meta || {}), idempotencyReplay: true },
        };
      }
      if (existing?.status === 'started') {
        return toolFailure(call.id, makeToolError({
          code: 'tool_call_not_executable',
          message: 'An identical idempotent tool call is already in flight.',
          callId: call.id,
          toolName: call.name,
          retryable: true,
        }), { toolName: call.name });
      }
      this.idempotencyStore.set({ key: idempotencyKey, status: 'started', updatedAt: new Date().toISOString() });
    }
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const enrichedContext: ToolExecutionContext = {
      ...context,
      ...(context.reportExternalTask || !this.onExternalTask ? {} : {
        reportExternalTask: (taskId: string) => this.onExternalTask?.(call, taskId, context),
      }),
    };
    const requestedTimeoutMs = Math.max(0, Math.trunc(Number(spec.timeoutMs ?? this.defaultTimeoutMs) || 0));
    const remainingDeadlineMs = context.deadlineAt !== undefined
      ? Math.max(0, context.deadlineAt - Date.now())
      : undefined;
    if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0) {
      return toolFailure(call.id, makeToolError({
        code: 'timeout',
        message: 'Turn deadline expired before tool execution.',
        callId: call.id,
        toolName: call.name,
        retryable: false,
      }), { toolName: call.name, meta: { deadlineExpired: true } });
    }
    const timeoutMs = remainingDeadlineMs !== undefined
      ? (requestedTimeoutMs > 0 ? Math.min(requestedTimeoutMs, remainingDeadlineMs) : remainingDeadlineMs)
      : requestedTimeoutMs;
    const maxRetries = Math.max(0, Math.trunc(Number(spec.maxRetries ?? this.defaultMaxRetries) || 0));
    const retrySafe = !spec.sideEffects?.length || spec.idempotency === 'payload' || spec.idempotency === 'turn';
    let attempt = 0;
    try {
      let output: ToolHandlerSuccess | ToolHandlerFailure;
      for (;;) {
        try {
          output = await this.invokeHandler(handler, call, spec, enrichedContext, timeoutMs);
          if (output.ok === false && output.error?.retryable === true && retrySafe && attempt < maxRetries) {
            attempt += 1;
            continue;
          }
          break;
        } catch (error) {
          if (retrySafe && attempt < maxRetries && isRetryable(error)) {
            attempt += 1;
            continue;
          }
          throw error;
        }
      }
      const meta = {
        ...(output.meta || {}),
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        attempts: attempt + 1,
      };
      const result = output.ok === false
        ? toolFailure(call.id, output.error || makeToolError({
          code: 'tool_execution_failed',
          message: `Tool handler failed without a structured error: ${call.name}`,
          callId: call.id,
          toolName: call.name,
        }), { toolName: call.name, content: output.content, meta })
        : toolSuccess(call.id, call.name, {
          content: output.content,
          outputs: output.outputs,
          jobId: output.jobId,
          pending: output.pending,
          meta,
        });
      this.recordIdempotentResult(idempotencyKey, result);
      return result;
    } catch (error) {
      const meta = { startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, attempts: attempt + 1 };
      const result = toolFailure(call.id, makeToolError({
        code: (error as any)?.code === 'timeout' ? 'timeout' : (error as any)?.code === 'cancelled' ? 'cancelled' : 'tool_execution_failed',
        message: safeErrorMessage(error),
        callId: call.id,
        toolName: call.name,
        retryable: isRetryable(error),
        details: { name: error instanceof Error ? error.name : 'Error' },
      }), { toolName: call.name, meta });
      this.recordIdempotentResult(idempotencyKey, result);
      return result;
    }
  }
  private async invokeHandler(
    handler: ToolHandler,
    call: ToolCall,
    spec: ToolSpec,
    context: ToolExecutionContext,
    timeoutMs: number,
  ): Promise<ToolHandlerSuccess | ToolHandlerFailure> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (context.signal?.aborted) controller.abort();
    else context.signal?.addEventListener('abort', onExternalAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handlerPromise = Promise.resolve().then(() => handler(call, spec, { ...context, signal: controller.signal }));
    if (!timeoutMs) {
      try { return await handlerPromise; }
      finally { context.signal?.removeEventListener('abort', onExternalAbort); }
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = Object.assign(new Error(`Tool timed out after ${timeoutMs}ms: ${call.name}`), { retryable: true, code: 'timeout' });
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([handlerPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      context.signal?.removeEventListener('abort', onExternalAbort);
    }
  }


  private idempotencyKeyFor(call: ToolCall, spec: ToolSpec, context: ToolExecutionContext): string | undefined {
    const mode = spec.idempotency || 'none';
    if (mode === 'none') return undefined;
    const payloadHash = createHash('sha256').update(stableJson(call.arguments)).digest('hex').slice(0, 32);
    const scope = String(context.operationId || context.turnId);
    return mode === 'payload'
      ? `payload|${scope}|${call.name}|${payloadHash}`
      : `turn|${scope}|${call.id}|${call.name}|${payloadHash}`;

  }

  private recordIdempotentResult(key: string | undefined, result: ToolResult): void {
    if (!key) return;
    const status = result.ok || result.pending || result.error?.retryable !== true ? 'completed' : 'failed';
    this.idempotencyStore.set({
      key,
      status,
      ...(status === 'completed' ? { result } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  async executeBatch(calls: unknown[], context: ToolExecutionContext, options: ToolBatchExecutionOptions = {}): Promise<ToolResult[]> {
    const batchIssues = validateToolCallBatch(calls, { maxCalls: this.maxCallsPerBatch });
    if (batchIssues.length) {
      return calls.map((raw, index) => {
        const callId = isRecord(raw) && typeof raw.id === 'string' ? raw.id : `invalid_${index + 1}`;
        const toolName = isRecord(raw) && typeof raw.name === 'string' ? raw.name : undefined;
        const direct = batchIssues.find((issue) => issue.callId === callId) || batchIssues[0];
        return toolFailure(callId, makeToolError({
          code: direct.code,
          message: direct.message,
          callId,
          toolName,
          path: direct.path,
          expected: direct.expected,
          received: direct.received,
          details: { batchRejected: true, issues: batchIssues },
        }), { toolName });
      });
    }
    const runnable = calls.filter(isToolCallEnvelope);
    if (!runnable.length) return [];
    // R15/C-3：同批副作用工具强制串行——凡声明 sideEffects 的工具共享单个执行槽位
    // 顺序执行；只读工具照常并行。幂等（payload/turn）只影响重试与去重语义，
    // 不豁免并发隔离：副作用调用交错执行的次序问题与是否幂等无关。
    const hasSideEffects = (call: ToolCall): boolean => {
      const spec = this.registry.get(call.name);
      return Boolean(spec?.sideEffects?.length);
    };
    const sideEffectCalls = runnable.filter(hasSideEffects);
    // 只要同批存在副作用工具，就按模型给出的原始顺序整批串行。
    // 不能把只读工具和副作用工具分成两组并行：副作用可能依赖同一批只读工具的结果，
    // 且副作用工具单独成批时也必须串行，不能落入通用并发池。
    if (sideEffectCalls.length) {
      const results: ToolResult[] = [];
      for (const call of runnable) results.push(await this.execute(call, context));
      return results;
    }
    const concurrency = Math.max(1, Math.min(runnable.length, Math.trunc(options.maxConcurrency || this.defaultMaxConcurrency || 1)));
    if (concurrency === 1) {
      const results: ToolResult[] = [];
      for (const call of runnable) results.push(await this.execute(call, context));
      return results;
    }
    const results = new Array<ToolResult>(runnable.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= runnable.length) return;
        results[index] = await this.execute(runnable[index], context);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }
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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000);
  return String(error || 'tool execution failed').slice(0, 1000);
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as Record<string, unknown>).retryable === true;
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  return new ToolExecutor(options);
}
