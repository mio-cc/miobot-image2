/**
 * 键控并发闸（2026-11-19）。
 *
 * 为什么抽出来：原来仓库里同一件事写了四份手搓实现——
 *   - runtime.ts 的 agent turn 信号量（数组唤醒，无超时、无观测，改上限不生效于已排队者）
 *   - feature-gate.ts 的 active Map（轮询 sleep，固定 30s 超时）
 *   - suno 的 queue 数组 + maxQueue
 *   - comfyui-queue.ts（唯一做对了的：按主机键、有上限、有排队超时）
 * 四份的语义各不相同，面板也没法统一展示。这里给一份带账本的单实现：
 *   - limit <= 0 表示不限流（仍然计数，供观测）
 *   - 排队 FIFO，可选超时（超时后必须把自己从队列摘掉，否则会占着位子不放）
 *   - 释放时把名额直接转交队首（先在账上加再 resolve），避免微任务窗口里超额放行
 *   - snapshot() 给面板/日志用：每个键的 running / queued / limit
 *
 * 关键不变量：running 恒等于「已发出去但还没释放的名额数」。
 * 转交名额时不先减后加，而是「保持 running 不变、把 release 交给队首」。
 */

export interface QueueGateSnapshot {
  key: string;
  running: number;
  queued: number;
  /** 0 = 不限流。 */
  limit: number;
}

export class QueueGateTimeoutError extends Error {
  readonly code = 'queue_timeout';
  constructor(readonly key: string, readonly timeoutMs: number) {
    super('排队超时：' + key + ' 在 ' + timeoutMs + 'ms 内没有拿到执行名额。');
    this.name = 'QueueGateTimeoutError';
  }
}

export interface AcquireOptions {
  /** 0/缺省 = 无限等。 */
  timeoutMs?: number;
  /** 真正进入排队时回调（用于把 job 标记成 queued、打日志）。 */
  onQueued?: () => void;
  /** 拿到名额时回调（排队结束）。 */
  onStarted?: () => void;
  /** 超时前的安全检查：返回 false 表示调用方已取消，直接失败而不是继续等。 */
  isCancelled?: () => boolean;
}

export type ReleaseSlot = () => void;

interface Waiter {
  grant: (release: ReleaseSlot) => void;
  fail: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  cancellable?: () => boolean;
}

interface GateState {
  running: number;
  limit: number;
  pending: Waiter[];
}

export class KeyedConcurrencyGate {
  private readonly states = new Map<string, GateState>();

  constructor(private readonly label = 'gate') {}

  async acquire(key: string, limit: number, options: AcquireOptions = {}): Promise<ReleaseSlot> {
    const cap = normalizeLimit(limit);
    const state = this.stateOf(key, cap);
    state.limit = cap;

    if (cap <= 0 || state.running < cap) {
      state.running += 1;
      options.onStarted?.();
      return this.makeRelease(key, state);
    }

    options.onQueued?.();
    return await new Promise<ReleaseSlot>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        fail: reject,
        ...(options.isCancelled ? { cancellable: options.isCancelled } : {}),
      };
      const timeoutMs = Math.max(0, Math.trunc(Number(options.timeoutMs) || 0));
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = state.pending.indexOf(waiter);
          // 已经不在队列里说明名额刚好转交给我了（或用别的方式结束了），不要再 reject。
          if (index < 0) return;
          state.pending.splice(index, 1);
          reject(new QueueGateTimeoutError(key, timeoutMs));
          this.collect(key, state);
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      state.pending.push(waiter);
    });
  }

  snapshot(): QueueGateSnapshot[] {
    return [...this.states.entries()].map(([key, state]) => ({
      key,
      running: state.running,
      queued: state.pending.length,
      limit: state.limit,
    }));
  }

  /** 只读某个键（不存在返回零值），供观测接口用。 */
  peek(key: string): QueueGateSnapshot {
    const state = this.states.get(key);
    return { key, running: state?.running ?? 0, queued: state?.pending.length ?? 0, limit: state?.limit ?? 0 };
  }

  reset(): void {
    for (const [key, state] of this.states) {
      for (const waiter of state.pending) {
        if (waiter.timer) clearTimeout(waiter.timer);
      }
      this.states.delete(key);
    }
  }

  private stateOf(key: string, limit: number): GateState {
    let state = this.states.get(key);
    if (!state) {
      state = { running: 0, limit, pending: [] };
      this.states.set(key, state);
    }
    return state;
  }

  private makeRelease(key: string, state: GateState): ReleaseSlot {
    let released = false;
    return () => {
      // 幂等：调用方可能 try/finally 加 catch 双重释放，重复减会把账算成负数。
      if (released) return;
      released = true;
      state.running = Math.max(0, state.running - 1);
      this.dispatch(key, state);
    };
  }

  /**
   * 把空出来的名额交给队首。
   * 注意这里**不先减再加**：running 保持不变，直接把 release 交出去，
   * 于是在 resolve 之前名额已经被算进 running，不会出现「微任务窗口超额放行」。
   */
  private dispatch(key: string, state: GateState): void {
    const cap = state.limit;
    while (state.pending.length) {
      if (cap > 0 && state.running >= cap) break;
      const waiter = state.pending.shift();
      if (!waiter) break;
      if (waiter.timer) clearTimeout(waiter.timer);
      // 排队期间调用方取消了：跳过它，名额继续给下一个。
      if (waiter.cancellable?.()) {
        waiter.fail(new Error('排队期间请求已取消。'));
        continue;
      }
      state.running += 1;
      waiter.grant(this.makeRelease(key, state));
    }
    this.collect(key, state);
  }

  /** 空键回收：否则大量一次性键会把 Map 撑大（比如 per-chat 的发送队列）。 */
  private collect(key: string, state: GateState): void {
    if (state.running <= 0 && state.pending.length === 0) this.states.delete(key);
  }
}

function normalizeLimit(value: number): number {
  const n = Math.trunc(Number(value) || 0);
  return n > 0 ? n : 0;
}

/** 进程级共享：Agent turn、异步工具队列、出站发送都用它，面板只读一份快照。 */
export const runtimeQueues = {
  turns: new KeyedConcurrencyGate('agent-turns'),
  toolQueues: new KeyedConcurrencyGate('tool-queues'),
  outbound: new KeyedConcurrencyGate('outbound-sends'),
};