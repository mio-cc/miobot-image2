import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OrchestrationTrace } from '../../../packages/orchestration/src/index.js';
import { pruneJsonlByAge } from './audit-service.js';

export interface TraceRetentionOptions {
  retentionDays?: number | (() => number);
  maxEntries?: number;
  maxBytes?: number;
}

export class OrchestrationTraceWriter {
  private queue: Promise<void> = Promise.resolve();
  private lastPrunedAt = 0;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 2 * 1024 * 1024,
    private readonly retention: TraceRetentionOptions = {},
  ) {}

  append(trace: OrchestrationTrace): void {
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, JSON.stringify(trace) + '\n', 'utf8');
      const stat = await fs.stat(this.filePath).catch(() => null);
      const dueByTime = Date.now() - this.lastPrunedAt > 6 * 60 * 60 * 1000;
      if ((stat && stat.size > this.maxBytes) || dueByTime) await this.pruneNow();
    }).catch(() => undefined);
  }

  async pruneNow(): Promise<void> {
    const retentionValue = typeof this.retention.retentionDays === 'function' ? this.retention.retentionDays() : this.retention.retentionDays;
    const retentionDays = Math.max(1, Number(retentionValue || 180));
    await pruneJsonlByAge(this.filePath, retentionDays, {
      maxEntries: this.retention.maxEntries || 100000,
      maxBytes: this.retention.maxBytes || this.maxBytes,
    });
    this.lastPrunedAt = Date.now();
  }
}

export async function pruneOrchestrationTraces(filePath: string, options: TraceRetentionOptions = {}): Promise<void> {
  const writer = new OrchestrationTraceWriter(filePath, Number(options.maxBytes) || 2 * 1024 * 1024, options);
  await writer.pruneNow();
}

export async function readOrchestrationTraces(filePath: string, limit = 50): Promise<OrchestrationTrace[]> {
  const content = await fs.readFile(filePath, 'utf8').catch(() => '');
  return content.trim()
    ? content.trim().split('\n').slice(-Math.max(1, Math.min(500, limit))).map((line) => {
        try { return JSON.parse(line) as OrchestrationTrace; } catch { return null; }
      }).filter(Boolean) as OrchestrationTrace[]
    : [];
}