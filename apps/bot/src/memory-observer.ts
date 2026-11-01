import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { IngestMemoryInput, MemoryAttachmentMeta } from './memory-service.js';

/**
 * Harness Memory Layer 观察链路（对标 pi/Codex 的 append-only 会话哲学）：
 * 写入路径只追加不筛选——所有消息先入观察队列，再走触发路由；压缩/淘汰是后台变换。
 *
 * 设计约束：
 * - observe() 同步入队即返回，绝不阻塞、绝不抛错（观察失败不能影响聊天回复）。
 * - 有界队列：超限丢最旧并计数告警，防止消息洪峰打爆内存。
 * - 批量 embedding：凑批（16 条或 500ms）一次 HTTP，全量观察的成本基础。
 * - 失败不丢消息：embedding 失败/限流 → pending.jsonl 持久队列，重启后低峰重试
 *   （Orama 空向量不可插入——实证 2026-11，持久重试即"全文降级"的落地形态）。
 */
export interface ObserveMemoryInput {
  botId: string;
  chatType: 'group' | 'private';
  groupId?: number | string;
  userId: number | string;
  authorName?: string;
  role: 'user' | 'assistant';
  text: string;
  messageId?: number | string;
  /** 消息原始事件时间（ISO）；重连补发时保留原事件时间。 */
  eventTime?: string;
  attachments?: MemoryAttachmentMeta[];
}

export interface MemoryObserverStats {
  observed: number;
  queued: number;
  dropped: number;
  flushed: number;
  failed: number;
  deduped: number;
  pendingCount: number;
  batchFlushes: number;
  lastFlushAt?: string;
  lastError?: string;
}

export interface MemoryObserverOptions {
  getConfig: () => AppConfig;
  /** 记忆数据目录（与 ChatMemoryService.rootDir 同源），pending.jsonl 落在这里。 */
  rootDir: string | (() => string);
  ingestBatch: (items: IngestMemoryInput[]) => Promise<Array<{ ok: boolean; indexed: number; deduped?: boolean; error?: string }>>;
  logger?: StructuredLogger;
  now?: () => number;
  /** 队列上限（超出丢最旧）；默认 2000。 */
  maxQueue?: number;
  /** 触发立即 flush 的批量阈值；默认 16。 */
  batchSize?: number;
  /** 防抖 flush 间隔 ms；默认 500。 */
  flushIntervalMs?: number;
}

interface QueueItem {
  input: IngestMemoryInput;
  observedAt: number;
}

export class MemoryObserver {
  private readonly queue: QueueItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingCount = { value: 0 };
  private readonly stats: MemoryObserverStats = { observed: 0, queued: 0, dropped: 0, flushed: 0, failed: 0, deduped: 0, pendingCount: 0, batchFlushes: 0 };

  constructor(private readonly options: MemoryObserverOptions) {}

  private rootPath(): string {
    const value = typeof this.options.rootDir === 'function' ? this.options.rootDir() : this.options.rootDir;
    return String(value || '').trim() || path.resolve('.runtime', 'memory');
  }

  private pendingPath(): string {
    return path.join(this.rootPath(), 'pending.jsonl');
  }

  private now(): number {
    return (this.options.now || Date.now)();
  }

  private observationEnabled(): boolean {
    const memory = this.options.getConfig().orchestration.memory;
    return Boolean(memory.enabled && memory.autoIngest && memory.observation?.enabled);
  }

  /**
   * 观察一条消息：同步入队即返回。闸门（self/duplicate/rate-limit/白名单）由 runtime 把关后调用；
   * 这里只做配置闸门与队列管理，任何异常都不外抛。
   */
  observe(input: ObserveMemoryInput): void {
    try {
      if (!this.observationEnabled()) return;
      const memory = this.options.getConfig().orchestration.memory.observation;
      if (input.chatType === 'group' && !memory.includeGroupMessages) return;
      if (input.chatType === 'private' && !memory.includePrivateMessages) return;
      if (input.role === 'assistant' && !memory.includeAssistantReplies) return;
      const attachments = memory.includeAttachments ? (input.attachments || []) : [];
      const text = String(input.text || '').trim().slice(0, Math.max(200, memory.maxTextCharsPerMessage));
      if (!text && !attachments.length) return;
      const item: QueueItem = {
        input: {
          botId: String(input.botId || ''),
          chatType: input.chatType,
          groupId: input.groupId === undefined ? undefined : String(input.groupId),
          userId: String(input.userId || ''),
          authorName: input.authorName ? String(input.authorName) : undefined,
          role: input.role,
          text,
          messageId: input.messageId === undefined ? undefined : String(input.messageId),
          eventTime: input.eventTime,
          attachments: attachments.length ? attachments : undefined,
          source: input.role === 'assistant' ? 'reply' : 'observation',
        },
        observedAt: this.now(),
      };
      this.stats.observed += 1;
      // 爆发缓冲：user 消息按会话暂存（含图片引用），供触发回合的合并窗口读取。
      if (input.role === 'user') {
        const burstKey = this.burstKey(input);
        const retainMs = this.burstRetainMs();
        const list = this.burstBuffer.get(burstKey) || [];
        list.push({
          at: this.now(),
          userId: String(input.userId || ''),
          authorName: input.authorName ? String(input.authorName) : String(input.userId || ''),
          text,
          imageRefs: attachments.filter((a) => a.type === 'image').map((a) => String(a.ref || '')).filter(Boolean),
          messageId: input.messageId === undefined ? '' : String(input.messageId),
        });
        while (list.length && this.now() - list[0].at > retainMs) list.shift();
        if (list.length > 50) list.splice(0, list.length - 50);
        this.burstBuffer.set(burstKey, list);
      }
      const maxQueue = Math.max(16, this.options.maxQueue ?? 2000);
      if (this.queue.length >= maxQueue) {
        const droppedNow = this.queue.length - maxQueue + 1;
        this.queue.splice(0, droppedNow);
        this.stats.dropped += droppedNow;
        // 节流告警：持续过载时不逐条刷日志，10s 一条。
        if (this.now() - this.lastDropWarnAt > 10_000) {
          this.lastDropWarnAt = this.now();
          this.options.logger?.warn('memory observation queue overflow; dropped oldest', { droppedThisRound: droppedNow, droppedTotal: this.stats.dropped });
        }
      }
      this.queue.push(item);
      this.stats.queued = this.queue.length;
      if (this.queue.length >= (this.options.batchSize ?? 16)) void this.flush();
      else this.scheduleFlush();
    } catch (error) {
      this.stats.lastError = String((error as Error)?.message || error);
      this.options.logger?.warn('memory observe failed (non-fatal)', { error: this.stats.lastError });
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, Math.max(50, this.options.flushIntervalMs ?? 500));
    this.flushTimer.unref?.();
  }

  private flushInFlight: Promise<void> | null = null;
  private lastDropWarnAt = 0;
  /** 连发消息合并窗口的爆发缓冲：按会话保留最近几秒的用户消息原文（仅供触发回合合并，不影响入库）。 */
  private readonly burstBuffer = new Map<string, Array<{ at: number; userId: string; authorName: string; text: string; imageRefs: string[]; messageId: string }>>();

  /** 立即冲刷队列（测试与优雅退出用）。并发调用共享同一次在途冲刷；返回时队列必为空。 */
  async flush(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight.catch(() => undefined);
    } else if (this.queue.length) {
      this.flushInFlight = this.runFlush();
      try { await this.flushInFlight; } finally { this.flushInFlight = null; }
    }
    // 在途冲刷期间又有入队（罕见）：再跑一轮，保证 flush() 返回即清空。
    if (this.queue.length) return this.flush();
  }

  private async runFlush(): Promise<void> {
    this.stats.batchFlushes += 1;
    while (this.queue.length) {
      const batch = this.queue.splice(0, Math.max(1, this.options.batchSize ?? 16));
      this.stats.queued = this.queue.length;
      await this.ingestWithRetry(batch);
    }
  }

  private async ingestWithRetry(batch: QueueItem[]): Promise<void> {
    try {
      const results = await this.options.ingestBatch(batch.map((item) => item.input));
      const failed: QueueItem[] = [];
      batch.forEach((item, index) => {
        const result = results[index];
        if (!result) { failed.push(item); return; }
        if (result.ok) {
          this.stats.flushed += 1;
          if (result.deduped) this.stats.deduped += 1;
          return;
        }
        // 配置关闭时静默丢弃（observe 闸门已挡，这里是竞态兜底）；其余失败进持久队列。
        if (result.error === 'memory_disabled') return;
        failed.push(item);
        this.stats.lastError = result.error;
      });
      if (failed.length) {
        this.stats.failed += failed.length;
        await this.appendPending(failed);
      }
      this.stats.lastFlushAt = new Date(this.now()).toISOString();
      this.stats.batchFlushes += 1;
    } catch (error) {
      this.stats.failed += batch.length;
      this.stats.lastError = String((error as Error)?.message || error);
      this.options.logger?.warn('memory observer flush failed; deferred to pending queue', { count: batch.length, error: this.stats.lastError });
      await this.appendPending(batch).catch(() => undefined);
    }
  }

  private async appendPending(items: QueueItem[]): Promise<void> {
    if (!items.length) return;
    await fs.mkdir(this.rootPath(), { recursive: true });
    const lines = items.map((item) => JSON.stringify({ ...item.input, pendingAt: new Date(this.now()).toISOString() }));
    await fs.appendFile(this.pendingPath(), lines.join('\n') + '\n', 'utf8');
    this.pendingCount.value += items.length;
    this.stats.pendingCount = this.pendingCount.value;
  }

  /** 启动/低峰重试 pending.jsonl：成功即从文件移除，失败保留原行。 */
  async retryPending(): Promise<{ retried: number; remaining: number }> {
    let raw = '';
    try { raw = await fs.readFile(this.pendingPath(), 'utf8'); } catch { return { retried: 0, remaining: 0 }; }
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return { retried: 0, remaining: 0 };
    const items: IngestMemoryInput[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as IngestMemoryInput & { pendingAt?: string };
        delete parsed.pendingAt;
        items.push(parsed);
      } catch { /* 坏行丢弃 */ }
    }
    const remaining: IngestMemoryInput[] = [];
    for (let start = 0; start < items.length; start += 32) {
      const chunk = items.slice(start, start + 32);
      try {
        const results = await this.options.ingestBatch(chunk);
        chunk.forEach((item, index) => {
          const result = results[index];
          if (result?.ok) this.stats.flushed += 1;
          else if (result?.error === 'memory_disabled') { /* 配置关闭，丢弃 */ }
          else remaining.push(item);
        });
      } catch {
        remaining.push(...chunk);
      }
    }
    await fs.mkdir(this.rootPath(), { recursive: true });
    const temp = this.pendingPath() + '.tmp';
    await fs.writeFile(temp, remaining.map((item) => JSON.stringify(item)).join('\n') + (remaining.length ? '\n' : ''), 'utf8');
    await fs.rename(temp, this.pendingPath());
    this.pendingCount.value = remaining.length;
    this.stats.pendingCount = remaining.length;
    if (items.length - remaining.length > 0) {
      this.options.logger?.info('memory pending retry finished', { retried: items.length - remaining.length, remaining: remaining.length });
    }
    return { retried: items.length - remaining.length, remaining: remaining.length };
  }

  startRetryLoop(intervalMs = 10 * 60 * 1000): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (!this.observationEnabled()) return;
      void this.retryPending().catch(() => undefined);
    }, Math.max(60_000, intervalMs));
    this.retryTimer.unref?.();
  }

  private burstKey(input: { botId: string; chatType: 'group' | 'private'; groupId?: number | string; userId: number | string }): string {
    return input.chatType === 'group' ? 'g:' + String(input.groupId ?? '') : 'p:' + String(input.botId || '') + ':' + String(input.userId || '');
  }

  /** 爆发缓冲保留时长：≥2s（覆盖"结尾带触发"的回溯），随合并窗口放大。 */
  private burstRetainMs(): number {
    const windowMs = Number(this.options.getConfig().orchestration.memory.observation?.coalesceWindowMs ?? 400) || 0;
    return Math.max(2000, windowMs * 4);
  }

  /**
   * 触发回合的合并窗口：收集同会话爆发缓冲内的相邻用户消息（时间正序，排除触发消息本身）。
   * 用于"一连串消息卡头/中间/结尾带触发"的场景——合并进回合输入，不影响入库；0 窗口返回空。
   */
  collectBurst(input: { botId: string; chatType: 'group' | 'private'; groupId?: number | string; userId: number | string; excludeMessageId?: number | string }): Array<{ userId: string; authorName: string; text: string; imageRefs: string[]; at: number; messageId: string }> {
    try {
      const windowMs = Math.max(0, Math.trunc(Number(this.options.getConfig().orchestration.memory.observation?.coalesceWindowMs ?? 400)) || 0);
      if (!windowMs) return [];
      const key = this.burstKey(input);
      const list = this.burstBuffer.get(key) || [];
      const now = this.now();
      const cutoff = now - this.burstRetainMs();
      const exclude = String(input.excludeMessageId ?? '');
      const collected = list.filter((item) => item.at >= cutoff && item.messageId !== exclude);
      while (list.length && list[0].at < cutoff) list.shift();
      return collected.map((item) => ({ ...item }));
    } catch {
      return [];
    }
  }

  statsSnapshot(): MemoryObserverStats {
    return { ...this.stats, queued: this.queue.length, pendingCount: this.pendingCount.value };
  }

  /** 优雅退出/测试收尾：停定时器、冲刷队列（pending 由调用方按需 retry）。 */
  async dispose(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    await this.flush();
  }
}
