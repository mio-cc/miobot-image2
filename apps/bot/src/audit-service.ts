import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface AuditRecord {
  id: string;
  timestamp: string;
  type: 'approval.created' | 'approval.decided' | 'approval.expired' | 'file.delete' | 'config.change' | 'permission.denied' | 'capability.test' | 'job.recovery' | 'job.terminal' | string;
  actor?: string;
  requestId?: string;
  jobId?: string;
  approvalId?: string;
  capability?: string;
  riskLevel?: string;
  decision?: string;
  reason?: string;
  data?: Record<string, unknown>;
}

export interface AuditServiceOptions {
  filePath: string;
  enabled?: boolean | (() => boolean);
  retentionDays?: number | (() => number);
  maxEntries?: number;
  maxBytes?: number;
  logger?: StructuredLogger;
}

const SENSITIVE_KEY = /^(api.?key|authorization|password|passwordseed|secret|token|access.?token|refresh.?token|cookie)$/i;

export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactAuditValue(child, depth + 1);
  }
  return out;
}

export class AuditService {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: AuditServiceOptions) {}

  private enabled(): boolean {
    const value = this.options.enabled;
    return typeof value === 'function' ? value() : value !== false;
  }

  private retentionDays(): number {
    const value = this.options.retentionDays;
    return Math.max(1, Math.trunc(Number(typeof value === 'function' ? value() : value) || 180));
  }

  append(record: Omit<AuditRecord, 'id' | 'timestamp'> & Partial<Pick<AuditRecord, 'id' | 'timestamp'>>): void {
    if (!this.enabled()) return;
    const full: AuditRecord = {
      id: record.id || `audit_${randomUUID()}`,
      timestamp: record.timestamp || new Date().toISOString(),
      ...record,
      data: record.data ? redactAuditValue(record.data) as Record<string, unknown> : undefined,
    };
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
      await fs.appendFile(this.options.filePath, JSON.stringify(full) + '\n', 'utf8');
    }).catch((error) => {
      this.options.logger?.warn('audit append failed', { error: String((error as Error)?.message || error) });
    });
  }

  async list(limit = 100): Promise<AuditRecord[]> {
    await this.queue;
    const content = await fs.readFile(this.options.filePath, 'utf8').catch(() => '');
    return content.trim()
      ? content.trim().split('\n').slice(-Math.max(1, Math.min(1000, limit))).map((line) => {
          try { return JSON.parse(line) as AuditRecord; } catch { return null; }
        }).filter(Boolean) as AuditRecord[]
      : [];
  }

  async prune(now = Date.now()): Promise<{ before: number; after: number; removed: number }> {
    await this.queue;
    const content = await fs.readFile(this.options.filePath, 'utf8').catch(() => '');
    const before = content.trim() ? content.trim().split('\n').length : 0;
    if (!before) return { before: 0, after: 0, removed: 0 };
    const retentionDays = this.retentionDays();
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const maxEntries = Math.max(1, Math.trunc(Number(this.options.maxEntries) || 100000));
    const maxBytes = Math.max(1024, Math.trunc(Number(this.options.maxBytes) || 16 * 1024 * 1024));
    let lines = content.trim().split('\n').filter((line) => {
      try {
        const record = JSON.parse(line) as AuditRecord;
        return Date.parse(record.timestamp) >= cutoff;
      } catch { return false; }
    }).slice(-maxEntries);
    let output = lines.join('\n') + (lines.length ? '\n' : '');
    while (Buffer.byteLength(output, 'utf8') > maxBytes && lines.length > 1) {
      lines = lines.slice(Math.max(1, Math.floor(lines.length / 10)));
      output = lines.join('\n') + '\n';
    }
    const temp = this.options.filePath + '.tmp';
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    await fs.writeFile(temp, output, 'utf8');
    await fs.rename(temp, this.options.filePath);
    return { before, after: lines.length, removed: before - lines.length };
  }

  start(intervalMs = 24 * 60 * 60 * 1000): void {
    void this.prune();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.prune(); }, Math.max(60000, intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export async function pruneJsonlByAge(
  filePath: string,
  retentionDays: number,
  options: { maxEntries?: number; maxBytes?: number } = {},
): Promise<{ before: number; after: number; removed: number }> {
  const content = await fs.readFile(filePath, 'utf8').catch(() => '');
  const before = content.trim() ? content.trim().split('\n').length : 0;
  if (!before) return { before: 0, after: 0, removed: 0 };
  const cutoff = Date.now() - Math.max(1, Math.trunc(Number(retentionDays) || 180)) * 24 * 60 * 60 * 1000;
  const maxEntries = Math.max(1, Math.trunc(Number(options.maxEntries) || 100000));
  const maxBytes = Math.max(1024, Math.trunc(Number(options.maxBytes) || 16 * 1024 * 1024));
  let lines = content.trim().split('\n').filter((line) => {
    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      return Date.parse(String(parsed.timestamp || '')) >= cutoff;
    } catch { return false; }
  }).slice(-maxEntries);
  let output = lines.join('\n') + (lines.length ? '\n' : '');
  while (Buffer.byteLength(output, 'utf8') > maxBytes && lines.length > 1) {
    lines = lines.slice(Math.max(1, Math.floor(lines.length / 10)));
    output = lines.join('\n') + '\n';
  }
  const temp = filePath + '.tmp';
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(temp, output, 'utf8');
  await fs.rename(temp, filePath);
  return { before, after: lines.length, removed: before - lines.length };
}