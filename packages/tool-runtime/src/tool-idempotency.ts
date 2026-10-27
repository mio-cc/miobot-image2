import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolResult } from './tool-spec.js';

export type ToolIdempotencyStatus = 'started' | 'completed' | 'failed';

export interface ToolIdempotencyRecord {
  key: string;
  status: ToolIdempotencyStatus;
  result?: ToolResult;
  updatedAt: string;
}

export interface ToolIdempotencyStore {
  get(key: string): ToolIdempotencyRecord | undefined;
  set(record: ToolIdempotencyRecord): void;
  delete(key: string): boolean;
}

export class InMemoryToolIdempotencyStore implements ToolIdempotencyStore {
  private readonly records = new Map<string, ToolIdempotencyRecord>();

  get(key: string): ToolIdempotencyRecord | undefined {
    const record = this.records.get(String(key));
    return record ? structuredClone(record) : undefined;
  }

  set(record: ToolIdempotencyRecord): void {
    if (!record?.key) return;
    this.records.set(record.key, structuredClone(record));
  }

  delete(key: string): boolean {
    return this.records.delete(String(key));
  }

  clear(): void {
    this.records.clear();
  }

  snapshot(): ToolIdempotencyRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

export interface FileToolIdempotencyStoreOptions {
  filePath: string;
  maxRecords?: number;
  maxAgeMs?: number;
  clock?: () => number;
  onError?: (error: unknown) => void;
}

/**
 * Durable idempotency ledger. ToolExecutor's contract is synchronous, so writes
 * are synchronous and atomic (temp file + rename) to preserve the started marker
 * before a side effect executes.
 */
export class FileToolIdempotencyStore implements ToolIdempotencyStore {
  private readonly records = new Map<string, ToolIdempotencyRecord>();
  private readonly maxRecords: number;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;

  constructor(private readonly options: FileToolIdempotencyStoreOptions) {
    this.maxRecords = Math.max(1, Math.trunc(Number(options.maxRecords) || 5000));
    const configuredMaxAge = options.maxAgeMs === undefined ? 24 * 60 * 60 * 1000 : Number(options.maxAgeMs);
    this.maxAgeMs = Math.max(0, Math.trunc(configuredMaxAge));
    this.clock = options.clock || (() => Date.now());
    this.restore();
  }

  get(key: string): ToolIdempotencyRecord | undefined {
    const record = this.records.get(String(key));
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.records.delete(String(key));
      this.flush();
      return undefined;
    }
    return structuredClone(record);
  }

  set(record: ToolIdempotencyRecord): void {
    if (!record?.key) return;
    this.records.set(record.key, structuredClone(record));
    this.prune();
    this.flush();
  }

  delete(key: string): boolean {
    const removed = this.records.delete(String(key));
    if (removed) this.flush();
    return removed;
  }

  snapshot(): ToolIdempotencyRecord[] {
    this.prune();
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  clear(): void {
    this.records.clear();
    this.flush();
  }

  private restore(): void {
    try {
      if (!existsSync(this.options.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.options.filePath, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of records as ToolIdempotencyRecord[]) {
        if (record?.key && record?.status && record?.updatedAt) this.records.set(record.key, structuredClone(record));
      }
      this.prune(false);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private isExpired(record: ToolIdempotencyRecord): boolean {
    if (this.maxAgeMs <= 0) return false;
    const updatedAt = Date.parse(record.updatedAt);
    return Number.isFinite(updatedAt) && this.clock() - updatedAt > this.maxAgeMs;
  }

  private prune(flush = true): void {
    let changed = false;
    for (const [key, record] of this.records) {
      if (this.isExpired(record)) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (this.records.size > this.maxRecords) {
      const newest = [...this.records.values()]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, this.maxRecords);
      this.records.clear();
      for (const record of newest) this.records.set(record.key, record);
      changed = true;
    }
    if (changed && flush) this.flush();
  }

  private flush(): void {
    try {
      mkdirSync(path.dirname(this.options.filePath), { recursive: true });
      const payload = JSON.stringify({ version: 1, records: [...this.records.values()] });
      const tempPath = this.options.filePath + '.tmp';
      writeFileSync(tempPath, payload, 'utf8');
      try {
        renameSync(tempPath, this.options.filePath);
      } catch {
        writeFileSync(this.options.filePath, payload, 'utf8');
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
