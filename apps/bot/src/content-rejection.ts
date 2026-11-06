import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/**
 * 内容审核被拒登记表（方案 1/D，2026-11-06 拍板）。
 *
 * 一次审核拒绝会通过三条持久化通道在后续请求里「连坐」：长期记忆库（观察链路在触发路由前
 * 入库，失败与否无关）、群历史上下文（QQ 群记录每轮重拉）、连发合并窗口。本登记表是这些
 * 通道的统一「坏消息名单」：装配处命中即替换为占位符（保留说话人与时序），记忆写入/摘要
 * 输入侧排除，审核修复模型复用其改写缓存（原文 hash → 改写版）。
 *
 * 主键设计：**原文规范化 hash**（模型调用层拿不到 QQ messageId，只能拿到发给模型的文本）；
 * runtime 在 turn 失败后补录 messageId（群历史行有 message_id，可精确匹配）——双键互补：
 * - contentHash：port 层登记（修复/占位重试仍败时）+ 改写缓存；
 * - messageId：runtime 失败分支补录，群历史/burst 过滤优先用它（准确、不受文本格式化差异影响）。
 *
 * 持久化：内存 Map + 落盘 JSON（防抖 3s，崩溃最多丢最近几条登记）；TTL 默认 7 天，
 * 上限默认 500 条（FIFO 淘汰）防膨胀。TTL/上限可配。
 */

/** 规范化原文 → 稳定 hash（去空白差异；截 4000 字防超长内容放大 hash 成本）。 */
export function hashRejectionContent(text: string): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

export interface ContentRejectionEntry {
  /** 原文规范化 hash（主键）。 */
  hash: string;
  /** QQ 消息 id（runtime 失败分支补录；群历史/burst 过滤优先用它）。 */
  messageId?: string;
  /** 触发时的时间戳（ms）。 */
  at: number;
  /** 错误摘要（前 300 字符，审计用）。 */
  reason: string;
  /** 改写缓存：原文 hash → 修复模型产出的改写版（旁挂映射，只替换进模型请求，不改原文）。 */
  rewrite?: string;
  /** 该内容历史被拒次数（同 hash 重复登记累加）。 */
  hits: number;
}

export interface ContentRejectionRegistry {
  /** 登记/累计一次拒绝（按原文 hash 幂等合并；hits 累加）。 */
  register(input: { text: string; messageId?: string; reason: string; at?: number }): ContentRejectionEntry;
  /** 补录 messageId（runtime 在 turn 失败后调用，让下一轮群历史过滤能精确命中）。 */
  attachMessageId(text: string, messageId: string): void;
  /** 精确命中：messageId 优先，回退 contentHash。 */
  isRejected(input: { messageId?: string; text?: string }): boolean;
  /** 取登记条目（改写缓存/审计用）。 */
  entryOf(text: string): ContentRejectionEntry | undefined;
  /** 记录改写版（缓存即登记：同类内容二次不再调用修复模型）。 */
  setRewrite(text: string, rewrite: string): void;
  /** 当前条目数（观测/测试）。 */
  size(): number;
  /** 手动清理过期条目（load 时与定时都会清）。 */
  sweep(now?: number): number;
  /** 优雅退出前调用。 */
  flush(): Promise<void>;
}

export const CONTENT_REJECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTENT_REJECTION_MAX_ENTRIES = 500;

/** 装配处替换被拒消息的占位文案（保留说话人与时序的行内占位）。 */
export const CONTENT_REJECTION_PLACEHOLDER = '[该消息因触发上游内容审核被略去]';

export function createContentRejectionRegistry(options: {
  filePath?: string;
  ttlMs?: number;
  maxEntries?: number;
  logger?: StructuredLogger;
  clock?: () => number;
}): ContentRejectionRegistry {
  const { logger } = options;
  const now = options.clock || (() => Date.now());
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || CONTENT_REJECTION_TTL_MS);
  const maxEntries = Math.max(10, Number(options.maxEntries) || CONTENT_REJECTION_MAX_ENTRIES);
  const entries = new Map<string, ContentRejectionEntry>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let loaded = false;

  function sweepInternal(at: number): number {
    let removed = 0;
    for (const [hash, entry] of entries) {
      if (at - entry.at > ttlMs) {
        entries.delete(hash);
        removed += 1;
      }
    }
    // FIFO 淘汰：超上限时按登记时间从最旧删除。
    while (entries.size > maxEntries) {
      const oldest = [...entries.values()].sort((a, b) => a.at - b.at)[0];
      if (!oldest) break;
      entries.delete(oldest.hash);
      removed += 1;
    }
    return removed;
  }

  function scheduleFlush(): void {
    if (!options.filePath) return;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 3000);
    flushTimer.unref?.();
  }

  async function flush(): Promise<void> {
    if (!options.filePath) return;
    try {
      await fs.mkdir(path.dirname(options.filePath), { recursive: true });
      const temp = options.filePath + '.tmp';
      await fs.writeFile(temp, JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 0), 'utf8');
      await fs.rename(temp, options.filePath);
    } catch (error) {
      logger?.warn('content rejection registry persist failed', { error: String((error as Error)?.message || error) });
    }
  }

  async function load(): Promise<void> {
    if (loaded || !options.filePath) {
      loaded = true;
      return;
    }
    loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(options.filePath, 'utf8')) as { entries?: ContentRejectionEntry[] };
      const at = now();
      for (const entry of raw.entries || []) {
        if (!entry?.hash || typeof entry.hash !== 'string') continue;
        if (at - entry.at > ttlMs) continue;
        entries.set(entry.hash, { hits: Number(entry.hits) || 1, at: entry.at, hash: entry.hash, reason: String(entry.reason || '').slice(0, 300), ...(entry.messageId ? { messageId: String(entry.messageId) } : {}), ...(entry.rewrite ? { rewrite: String(entry.rewrite) } : {}) });
      }
    } catch { /* 文件不存在/损坏：空表起步 */ }
    sweepInternal(now());
  }

  void load();

  return {
    register({ text, messageId, reason, at }) {
      const hash = hashRejectionContent(text);
      const existing = entries.get(hash);
      if (existing) {
        existing.hits += 1;
        existing.at = at ?? now();
        if (messageId) existing.messageId = String(messageId);
      } else {
        entries.set(hash, { hash, at: at ?? now(), reason: String(reason || '').slice(0, 300), hits: 1, ...(messageId ? { messageId: String(messageId) } : {}) });
      }
      sweepInternal(entries.get(hash)!.at);
      scheduleFlush();
      return entries.get(hash)!;
    },
    attachMessageId(text, messageId) {
      const hash = hashRejectionContent(text);
      const existing = entries.get(hash);
      if (existing) {
        existing.messageId = String(messageId);
        scheduleFlush();
      }
    },
    isRejected({ messageId, text }) {
      if (messageId) {
        for (const entry of entries.values()) {
          if (entry.messageId === String(messageId)) return true;
        }
      }
      if (text !== undefined) return entries.has(hashRejectionContent(text));
      return false;
    },
    entryOf(text) {
      return entries.get(hashRejectionContent(text));
    },
    setRewrite(text, rewrite) {
      const hash = hashRejectionContent(text);
      const existing = entries.get(hash);
      if (existing) {
        existing.rewrite = String(rewrite).slice(0, 8000);
      } else {
        // 修复成功时条目尚未登记（register 只发生在终局失败）——缓存条目自行建账，hits=0 表示「已改写未拒」。
        entries.set(hash, { hash, at: now(), reason: 'moderation_rewritten', hits: 0, rewrite: String(rewrite).slice(0, 8000) });
        sweepInternal(now());
      }
      scheduleFlush();
    },
    size() {
      return entries.size;
    },
    sweep(atOverride) {
      const removed = sweepInternal(atOverride ?? now());
      if (removed) scheduleFlush();
      return removed;
    },
    flush,
  };
}
