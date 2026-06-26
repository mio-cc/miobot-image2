import { DebouncedWriter } from './debounce.js';
import { FileJsonStore, type JsonStore } from './json-store.js';

export interface CanvasStateStoreOptions<T> {
  defaultValue: T;
  /** 防抖落盘延迟（ms）。画布状态高频变更，默认 500ms 合并写。 */
  debounceMs?: number;
  store?: JsonStore<T>;
}

/**
 * 画布状态仓储：内存持有当前状态 + 防抖落盘。
 * 取代 local-verify-server 里手写的画布项目/画廊/反推状态 + 防抖 fs.writeFile。
 */
export class CanvasStateStore<T> {
  private readonly store: JsonStore<T>;
  private readonly writer: DebouncedWriter;
  private state: T;

  constructor(filePathOrStore: string | JsonStore<T>, options: CanvasStateStoreOptions<T>) {
    this.store = typeof filePathOrStore === 'string'
      ? (options.store || new FileJsonStore<T>(filePathOrStore, { defaultValue: options.defaultValue }))
      : filePathOrStore;
    this.state = this.store.exists() ? this.store.load() : options.defaultValue;
    this.writer = new DebouncedWriter(() => this.store.save(this.state), options.debounceMs ?? 500);
  }

  /** 当前内存状态（同步、最新）。 */
  get(): T {
    return this.state;
  }

  /** 整体替换状态并安排防抖落盘。 */
  set(value: T): void {
    this.state = value;
    this.writer.schedule();
  }

  /** 用 mutator 原地/函数式更新状态并安排落盘。 */
  update(mutator: (current: T) => T | void): void {
    const next = mutator(this.state);
    if (next !== undefined) this.state = next;
    this.writer.schedule();
  }

  /** 从磁盘重新载入到内存（丢弃未落盘的内存变更前应先 flush）。 */
  reload(): T {
    this.state = this.store.exists() ? this.store.load() : this.state;
    return this.state;
  }

  /** 立即落盘未决变更。 */
  flush(): void {
    this.writer.flush();
  }

  /** 是否有未落盘变更。 */
  get pending(): boolean {
    return this.writer.pending;
  }

  /** 退出前调用：落盘并清理计时器。 */
  close(): void {
    this.writer.flush();
    this.writer.dispose();
  }
}
