/**
 * 防抖写出器：把短时间内的多次"请求落盘"合并成一次实际写，降低磁盘抖动。
 * 提供 schedule()（延迟写）、flush()（立即写）、dispose()（取消未决写）。
 */
export class DebouncedWriter {
  private readonly flushFn: () => void;
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(flushFn: () => void, delayMs = 500) {
    this.flushFn = flushFn;
    this.delayMs = Math.max(0, Math.trunc(delayMs));
  }

  /** 标记有变更并安排一次延迟落盘（若已有未决计时则复用）。 */
  schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.delayMs);
    // 不阻止进程退出。
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** 若有未决变更则立刻写出；清除计时器。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.flushFn();
  }

  /** 是否有尚未落盘的变更。 */
  get pending(): boolean {
    return this.dirty;
  }

  /** 丢弃未决写（不落盘），清理计时器。 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dirty = false;
  }
}
