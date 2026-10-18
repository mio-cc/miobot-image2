/**
 * ComfyUI 任务队列：同一 ComfyUI 服务默认只允许一个任务真正进入 /prompt。
 * 这样多个 QQ 请求不会同时堆进 ComfyUI，也不会因为一个 GPU 被多任务抢占而卡死。
 */
export interface ComfyUiQueueOptions {
  maxConcurrent: number;
  maxQueue: number;
  queueTimeoutMs: number;
  label?: string;
  logger?: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
}

interface QueueEntry {
  run: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface QueueState {
  running: number;
  pending: QueueEntry[];
  limit: number;
}

const queues = new Map<string, QueueState>();

export class ComfyUiQueueError extends Error {
  readonly code: 'queue_full' | 'queue_timeout';
  constructor(message: string, code: 'queue_full' | 'queue_timeout') {
    super(message);
    this.name = 'ComfyUiQueueError';
    this.code = code;
  }
}

function stateOf(key: string, limit: number): QueueState {
  let state = queues.get(key);
  if (!state) {
    state = { running: 0, pending: [], limit };
    queues.set(key, state);
  } else {
    state.limit = Math.min(state.limit, limit);
  }
  return state;
}

function drain(key: string, state: QueueState): void {
  while (state.running < state.limit && state.pending.length) {
    const entry = state.pending.shift();
    if (!entry) break;
    if (entry.timer) clearTimeout(entry.timer);
    entry.run();
  }
  if (!state.running && !state.pending.length) queues.delete(key);
}

function runTask<T>(key: string, state: QueueState, task: () => Promise<T>): Promise<T> {
  state.running += 1;
  return (async () => {
    try {
      return await task();
    } finally {
      state.running = Math.max(0, state.running - 1);
      drain(key, state);
    }
  })();
}

export function runInComfyUiQueue<T>(key: string, options: ComfyUiQueueOptions, task: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, Math.trunc(Number(options.maxConcurrent) || 1));
  const maxQueue = Math.max(0, Math.trunc(Number(options.maxQueue) || 0));
  const queueTimeoutMs = Math.max(0, Math.trunc(Number(options.queueTimeoutMs) || 0));
  const state = stateOf(key, limit);
  if (state.running < state.limit) return runTask(key, state, task);

  if (state.pending.length >= maxQueue) {
    return Promise.reject(new ComfyUiQueueError('ComfyUI 当前排队任务过多，请稍后再试。', 'queue_full'));
  }

  options.logger?.info('ComfyUI 任务进入队列', {
    queue: key,
    label: options.label || '',
    running: state.running,
    queued: state.pending.length,
    limit: state.limit,
  });

  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry = {
      run: () => {
        resolve(runTask(key, state, task));
      },
      reject,
    };
    if (queueTimeoutMs > 0) {
      entry.timer = setTimeout(() => {
        const index = state.pending.indexOf(entry);
        if (index >= 0) state.pending.splice(index, 1);
        reject(new ComfyUiQueueError('ComfyUI 排队超时，请稍后再试。', 'queue_timeout'));
        drain(key, state);
      }, queueTimeoutMs);
      entry.timer.unref?.();
    }
    state.pending.push(entry);
  });
}

export function comfyUiQueueSnapshot(): Array<{ queue: string; running: number; queued: number; limit: number }> {
  return [...queues.entries()].map(([queue, state]) => ({
    queue,
    running: state.running,
    queued: state.pending.length,
    limit: state.limit,
  }));
}

export function resetComfyUiQueuesForTest(): void {
  for (const state of queues.values()) {
    for (const entry of state.pending) {
      if (entry.timer) clearTimeout(entry.timer);
    }
  }
  queues.clear();
}
