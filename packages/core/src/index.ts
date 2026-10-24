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
  // 实测事故 2026-10-24：错误若自带 normalized（LlmProviderError 等约定），
  // 尊重抛错方已判定的分类——上游 429/busy 是否可重试只有抛错方知道，
  // 通用分类器会把它们洗成不可重试，导致 runWithRetry 永不重试。
  const prenormalized = record && isRecord(record.normalized) ? record.normalized as Partial<SerializableError> : undefined;
  if (prenormalized) {
    if (prenormalized.category) normalized.category = prenormalized.category;
    if (typeof prenormalized.retryable === 'boolean') normalized.retryable = prenormalized.retryable;
    if (prenormalized.code !== undefined) normalized.code = prenormalized.code;
    if (prenormalized.status !== undefined) normalized.status = prenormalized.status;
    if (prenormalized.details !== undefined) normalized.details = prenormalized.details;
  }
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

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

/**
 * 三个上限都可以传函数。
 *
 * 传数字的话就是构造那一刻冻住：用户在面板上把「对话轮数」从 8 改成 30、
 * 面板明确提示「已热重载生效」，可 bot 进程里的会话仍然只留 8 轮，
 * 要重启才认——而且从头到尾没有任何提示。
 */
export type SessionLimit = number | (() => number | undefined);

export interface SessionStoreOptions {
  /** 保留的最大对话轮数(1 轮 = user+assistant)。 */
  maxRounds?: SessionLimit;
  /** 历史 JSON 序列化后的最大字符数,超出则从最旧丢弃。 */
  maxChars?: SessionLimit;
  /** 会话空闲超时(毫秒)，超时未访问的会话在 cleanup() 时删除。0 = 永不超时。 */
  ttlMs?: SessionLimit;
  /** 时钟注入(测试用)。 */
  clock?: () => number;
}

/**
 * 会话记忆:按会话键保存对话历史,按轮数 + 字符数双上限裁剪。
 * 取代旧 bot-runtime 里的全局 `sessions` Map + `pruneHistory`,做成可注入、可测的内核组件。
 * 支持空闲 TTL 清理:超时未访问的会话由 cleanup() 删除，避免长期运行内存堆积。
 */
export class SessionStore {
  private readonly getMaxRounds: () => number;
  private readonly getMaxChars: () => number;
  private readonly getTtlMs: () => number;
  private readonly clock: () => number;
  private readonly store = new Map<string, SessionMessage[]>();
  private readonly accessedAt = new Map<string, number>();

  constructor(options: SessionStoreOptions = {}) {
    // 每次用的时候现算，所以面板改了上限立刻生效，不必重启 bot。
    const resolver = (limit: SessionLimit | undefined, fallback: number, floor: number) => () => {
      const raw = typeof limit === 'function' ? limit() : limit;
      const value = Math.trunc(Number(raw));
      return Number.isFinite(value) ? Math.max(floor, value) : fallback;
    };
    this.getMaxRounds = resolver(options.maxRounds, 8, 1);
    this.getMaxChars = resolver(options.maxChars, 12000, 1000);
    this.getTtlMs = resolver(options.ttlMs, 0, 0);
    this.clock = options.clock || (() => Date.now());
  }

  /** 取某会话的历史副本(不含 system)。 */
  get(key: string): SessionMessage[] {
    this.accessedAt.set(key, this.clock());
    return [...(this.store.get(key) || [])];
  }

  /** 追加一轮(user + assistant)并裁剪,返回裁剪后的历史。 */
  append(key: string, user: SessionMessage, assistant: SessionMessage): SessionMessage[] {
    const next = this.prune([...(this.store.get(key) || []), user, assistant]);
    this.store.set(key, next);
    this.accessedAt.set(key, this.clock());
    return next;
  }

  /** 清空某会话(新开对话)。 */
  clear(key: string): boolean {
    this.accessedAt.delete(key);
    return this.store.delete(key);
  }

  clearAll(): void {
    this.store.clear();
    this.accessedAt.clear();
  }

  /** 删除空闲超时的会话，返回清理数量。ttlMs=0 时直接返回 0。 */
  cleanup(now?: number): number {
    const ttlMs = this.getTtlMs();
    if (ttlMs <= 0) return 0;
    const t = now ?? this.clock();
    let removed = 0;
    for (const [key, at] of this.accessedAt) {
      if (t - at > ttlMs) {
        this.store.delete(key);
        this.accessedAt.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** T2.3：可持久化快照（仅活跃会话；TTL>0 时排除已过期项）。 */
  dump(): Record<string, SessionMessage[]> {
    const out: Record<string, SessionMessage[]> = {};
    const ttlMs = this.getTtlMs();
    const t = this.clock();
    for (const [key, messages] of this.store) {
      if (ttlMs > 0 && t - (this.accessedAt.get(key) ?? 0) > ttlMs) continue;
      out[key] = [...messages];
    }
    return out;
  }

  /** T2.3：从快照恢复（每会话重走裁剪，防御损坏/超限数据）。 */
  restore(snapshot: unknown): number {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 0;
    let restored = 0;
    for (const [key, value] of Object.entries(snapshot as Record<string, unknown>)) {
      if (!key || !Array.isArray(value)) continue;
      const messages = value.filter((item): item is SessionMessage =>
        Boolean(item) && typeof item === 'object' && typeof (item as SessionMessage).role === 'string' && typeof (item as SessionMessage).content === 'string');
      if (!messages.length) continue;
      this.store.set(key, this.prune(messages));
      this.accessedAt.set(key, this.clock());
      restored += 1;
    }
    return restored;
  }

  private prune(messages: SessionMessage[]): SessionMessage[] {
    let items = messages.slice(-this.getMaxRounds() * 2);
    const maxChars = this.getMaxChars();
    while (JSON.stringify(items).length > maxChars && items.length > 2) items = items.slice(2);
    return items;
  }
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  return new SessionStore(options);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export * from './metrics.js';
