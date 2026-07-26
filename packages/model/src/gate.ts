/**
 * 按节点的并发闸门。
 *
 * 上游的并发额度是按 key 发的，所以限流的单位是**节点**，不是模型：
 * 同一个 key 上开 8 个 gpt-4o-mini 和开 8 个 gpt-image-2，对上游是一回事。
 * 之前配置里按「节点 + 模型」逐条存限制，一个 12 节点的账号能摊出上百行，
 * 而且没有任何一行对应真实存在的约束。
 *
 * 语义：limit <= 0 表示不限制；否则同一节点最多 limit 个请求在飞。
 * 排队等待不计入请求超时——超时从真正发出请求那一刻才开始算。
 */

interface GateState {
  running: number;
  pending: Array<() => void>;
  /** 现读上限。存解析器而不是数值，用户在后台调整后已排队的请求也能跟着收敛。 */
  getLimit: () => number;
}

export interface GateSnapshotItem {
  nodeIndex: number;
  running: number;
  queued: number;
  limit: number;
}

export type ConcurrencyLimit = number | (() => number);

function capOf(value: unknown): number {
  const n = Math.trunc(Number(value) || 0);
  return n > 0 ? n : 0;
}

export class NodeConcurrencyGate {
  private readonly states = new Map<number, GateState>();

  async run<T>(nodeIndex: number, limit: ConcurrencyLimit, task: () => Promise<T>): Promise<T> {
    const getLimit = typeof limit === 'function' ? limit : () => limit;
    const cap = capOf(getLimit());
    if (cap <= 0) return task();

    const state = this.stateOf(nodeIndex, getLimit);
    // 每次调用都刷新解析器：上限改动要对已经排在队里的请求同样生效。
    state.getLimit = getLimit;

    if (state.running < cap) {
      state.running += 1;
    } else {
      // 等唤醒。注意唤醒方**已经替我把 running 加过了**——
      // 如果改成醒来自己加，唤醒是微任务，在那之前别的调用方会看到 running 偏低而直接放行，于是超额。
      await new Promise<void>((resolve) => state.pending.push(resolve));
    }

    try {
      return await task();
    } finally {
      state.running -= 1;
      this.drain(nodeIndex, state);
    }
  }

  snapshot(): GateSnapshotItem[] {
    return [...this.states.entries()].map(([nodeIndex, state]) => ({
      nodeIndex,
      running: state.running,
      queued: state.pending.length,
      limit: capOf(state.getLimit()),
    }));
  }

  private drain(nodeIndex: number, state: GateState): void {
    const cap = capOf(state.getLimit());
    // cap 为 0 表示用户中途把限制取消了，把积压的全放出去。
    const room = cap <= 0 ? state.pending.length : cap - state.running;
    for (let i = 0; i < room && state.pending.length; i += 1) {
      state.running += 1;
      const next = state.pending.shift();
      if (next) next();
    }
    if (!state.running && !state.pending.length) this.states.delete(nodeIndex);
  }

  private stateOf(nodeIndex: number, getLimit: () => number): GateState {
    let state = this.states.get(nodeIndex);
    if (!state) {
      state = { running: 0, pending: [], getLimit };
      this.states.set(nodeIndex, state);
    }
    return state;
  }
}
