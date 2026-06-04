import type { PackageDescriptor, SerializableError } from '@miobot-v2/shared';

export const CORE_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/core',
  phase: 'P4-infrastructure',
};

export type { SerializableError } from '@miobot-v2/shared';

export interface ErrorNormalizeOptions {
  includeStack?: boolean;
  details?: unknown;
}

export function normalizeError(error: unknown, options: ErrorNormalizeOptions = {}): SerializableError {
  const record = isRecord(error) ? error : undefined;
  const message = error instanceof Error ? error.message : record && typeof record.message === 'string' ? record.message : String(error ?? 'Unknown error');
  const code = record && (typeof record.code === 'string' || typeof record.code === 'number') ? String(record.code) : undefined;
  const status = record && typeof record.status === 'number' ? record.status : record && typeof record.statusCode === 'number' ? record.statusCode : undefined;
  const category = classifyError(message, code, status);
  const normalized: SerializableError = {
    name: error instanceof Error ? error.name : record && typeof record.name === 'string' ? record.name : 'Error',
    message,
    category,
    retryable: category === 'timeout' || category === 'network' || (category === 'upstream' && (!status || status >= 500)),
  };
  if (code) normalized.code = code;
  if (status !== undefined) normalized.status = status;
  if (options.includeStack && error instanceof Error && error.stack) normalized.stack = error.stack;
  if (options.details !== undefined) normalized.details = options.details;
  const cause = error instanceof Error ? error.cause : record?.cause;
  if (cause !== undefined) normalized.cause = normalizeError(cause, { includeStack: options.includeStack });
  return normalized;
}

export function classifyError(message: string, code?: string, status?: number): SerializableError['category'] {
  const haystack = `${message} ${code ?? ''}`.toLowerCase();
  if (haystack.includes('timeout') || haystack.includes('econnaborted')) return 'timeout';
  if (['econnreset', 'enetunreach', 'eai_again', 'etimedout'].some((item) => haystack.includes(item)) || haystack.includes('socket hang up') || haystack.includes('stream error')) return 'network';
  if (haystack.includes('internal_error') || haystack.includes('internal server error') || haystack.includes('internal_server_error') || haystack.includes('data[].error')) return 'upstream';
  if (haystack.includes('authentication token') || haystack.includes('invalidated') || haystack.includes('unauthorized') || haystack.includes('invalid api key')) return 'validation';
  if (haystack.includes('missing b64_json') || haystack.includes('missing base64') || haystack.includes('missing url') || haystack.includes('missing b64_json/base64/url')) return 'validation';
  if (status !== undefined && status >= 500) return 'upstream';
  if (status !== undefined && status >= 400) return 'validation';
  return 'unknown';
}

export function isRetryableError(error: unknown): boolean {
  return normalizeError(error).retryable;
}

export interface TimeoutPolicy {
  defaultMs: number;
  byOperation?: Record<string, number>;
  minMs?: number;
  maxMs?: number;
}

export function resolveTimeoutMs(policy: TimeoutPolicy, operation?: string): number {
  const raw = operation && policy.byOperation?.[operation] !== undefined ? policy.byOperation[operation] : policy.defaultMs;
  const min = policy.minMs ?? 1;
  const max = policy.maxMs ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  readonly timeoutMs: number;
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

export async function runWithTimeout<T>(operation: () => Promise<T> | T, options: { operationName?: string; timeoutMs: number }): Promise<T> {
  const operationName = options.operationName || 'operation';
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(operationName, options.timeoutMs)), options.timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  });
}

export interface RetryPolicy {
  retries: number;
  delayMs: number;
  maxDelayMs?: number;
  factor?: number;
  shouldRetry?: (error: SerializableError, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryAttempt {
  attempt: number;
  delayMs: number;
  error: SerializableError;
}

export async function runWithRetry<T>(operation: (attempt: number) => Promise<T> | T, policy: RetryPolicy, attempts: RetryAttempt[] = []): Promise<T> {
  const sleep = policy.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, Math.trunc(policy.retries) + 1);
  const factor = policy.factor ?? 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const normalized = normalizeError(error);
      const canRetry = attempt < maxAttempts && (policy.shouldRetry ? policy.shouldRetry(normalized, attempt) : normalized.retryable);
      if (!canRetry) throw error;
      const delay = Math.min(policy.maxDelayMs ?? Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(policy.delayMs * Math.pow(factor, attempt - 1))));
      attempts.push({ attempt, delayMs: delay, error: normalized });
      if (delay > 0) await sleep(delay);
    }
  }
  throw new Error('Retry loop exhausted unexpectedly');
}

export interface QueueKey {
  provider: string;
  model: string;
}

export interface TaskQueueOptions {
  defaultConcurrency?: number;
  limits?: Record<string, number>;
}

export interface QueueSnapshotItem {
  key: string;
  running: number;
  queued: number;
  limit: number;
}

interface QueueState {
  running: number;
  pending: Array<() => void>;
}

export class TaskQueue {
  private readonly defaultConcurrency: number;
  private readonly limits: Record<string, number>;
  private readonly states = new Map<string, QueueState>();

  constructor(options: TaskQueueOptions = {}) {
    this.defaultConcurrency = Math.max(1, Math.trunc(options.defaultConcurrency ?? 1));
    this.limits = { ...(options.limits || {}) };
  }

  enqueue<T>(key: QueueKey, task: () => Promise<T> | T): Promise<T> {
    const queueKey = createModelQueueKey(key.provider, key.model);
    const state = this.getState(queueKey);
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        state.running += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            state.running -= 1;
            this.drain(queueKey);
          });
      };
      state.pending.push(run);
      this.drain(queueKey);
    });
  }

  snapshot(): QueueSnapshotItem[] {
    return [...this.states.entries()].map(([key, state]) => ({ key, running: state.running, queued: state.pending.length, limit: this.limitForKey(key) }));
  }

  private drain(key: string): void {
    const state = this.getState(key);
    const limit = this.limitForKey(key);
    while (state.running < limit && state.pending.length > 0) {
      const next = state.pending.shift();
      if (next) next();
    }
  }

  private limitForKey(key: string): number {
    return Math.max(1, Math.trunc(this.limits[key] ?? this.defaultConcurrency));
  }

  private getState(key: string): QueueState {
    const current = this.states.get(key);
    if (current) return current;
    const next: QueueState = { running: 0, pending: [] };
    this.states.set(key, next);
    return next;
  }
}

export function createModelQueueKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}::${model.trim().toLowerCase()}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
