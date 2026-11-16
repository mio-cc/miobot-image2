/**
 * 能力记忆落盘。
 *
 * 结论必须跨重启存活：一次上游探测花掉的往返、一次大脑判定花掉的 token，
 * 重启后重来一遍既浪费又会让「第一次调用总是慢」变成常态。
 *
 * 与 memory-service 等落盘件的取舍一致：写入去抖、失败只告警（记忆丢一份不影响主链路）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityMemory, LearnedCapability } from '../../../packages/model/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface ModelCapabilityStoreOptions {
  filePath: string;
  logger?: StructuredLogger;
  /** 写入去抖窗口（毫秒）。 */
  flushDelayMs?: number;
}

export class FileModelCapabilityStore implements CapabilityMemory {
  private readonly filePath: string;
  private readonly logger?: StructuredLogger;
  private readonly flushDelayMs: number;
  private readonly store = new Map<string, LearnedCapability>();
  private timer?: NodeJS.Timeout;
  private dirty = false;

  constructor(options: ModelCapabilityStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.flushDelayMs = Math.max(0, Math.trunc(options.flushDelayMs ?? 800));
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { version?: number; entries?: Record<string, LearnedCapability> };
      if (!raw || typeof raw !== 'object' || !raw.entries) return;
      for (const [key, value] of Object.entries(raw.entries)) {
        if (!value || !Array.isArray(value.operations)) continue;
        this.store.set(key, value);
      }
      this.logger?.info('模型能力记忆已加载', { path: this.filePath, entries: this.store.size });
    } catch (error) {
      // 记忆损坏不能让进程起不来：丢掉它，重新学习即可。
      this.logger?.warn('模型能力记忆读取失败，已忽略', { path: this.filePath, error: String((error as Error)?.message || error) });
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushDelayMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const entries: Record<string, LearnedCapability> = {};
      for (const [key, value] of this.store) entries[key] = value;
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger?.warn('模型能力记忆写入失败', { path: this.filePath, error: String((error as Error)?.message || error) });
    }
  }

  get(key: string): LearnedCapability | undefined {
    return this.store.get(key);
  }

  set(key: string, value: LearnedCapability): void {
    this.store.set(key, { ...value, operations: [...value.operations] });
    this.schedule();
  }

  delete(key: string): void {
    if (!this.store.delete(key)) return;
    this.schedule();
  }

  list(): Array<{ key: string } & LearnedCapability> {
    return [...this.store.entries()].map(([key, value]) => ({ key, ...value, operations: [...value.operations] }));
  }
}