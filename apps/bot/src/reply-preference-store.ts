import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentReplyPreference } from '../../../packages/agent-runtime/src/index.js';

export type ReplyPreferenceScope = 'session' | 'user';

export interface ReplyPreferenceRecord {
  scope: ReplyPreferenceScope;
  key: string;
  preference: AgentReplyPreference;
  updatedAt: string;
  expiresAt?: string;
}

export interface ReplyPreferenceStoreOptions {
  filePath?: string;
  maxRecords?: number;
  clock?: () => Date;
  onError?: (error: unknown) => void;
}

export class ReplyPreferenceStore {
  private readonly records = new Map<string, ReplyPreferenceRecord>();
  private readonly maxRecords: number;
  private readonly clock: () => Date;

  constructor(private readonly options: ReplyPreferenceStoreOptions = {}) {
    this.maxRecords = Math.max(1, Math.trunc(Number(options.maxRecords) || 5000));
    this.clock = options.clock || (() => new Date());
    this.restore();
  }

  get(scope: ReplyPreferenceScope, key: string): AgentReplyPreference | undefined {
    const id = this.recordKey(scope, key);
    const record = this.records.get(id);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.records.delete(id);
      this.flush();
      return undefined;
    }
    return structuredClone(record.preference);
  }

  set(scope: ReplyPreferenceScope, key: string, preference: AgentReplyPreference, ttlMs: number): AgentReplyPreference | undefined {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return undefined;
    const id = this.recordKey(scope, normalizedKey);
    const clean = this.cleanPreference(preference);
    if (!clean) {
      this.records.delete(id);
      this.flush();
      return undefined;
    }
    const now = this.clock();
    const ttl = Math.max(0, Math.trunc(Number(ttlMs) || 0));
    const record: ReplyPreferenceRecord = {
      scope,
      key: normalizedKey,
      preference: clean,
      updatedAt: now.toISOString(),
      ...(ttl > 0 ? { expiresAt: new Date(now.getTime() + ttl).toISOString() } : {}),
    };
    this.records.set(id, record);
    this.prune();
    this.flush();
    return structuredClone(clean);
  }

  delete(scope: ReplyPreferenceScope, key: string): boolean {
    const removed = this.records.delete(this.recordKey(scope, key));
    if (removed) this.flush();
    return removed;
  }

  snapshot(): ReplyPreferenceRecord[] {
    this.prune();
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  private restore(): void {
    if (!this.options.filePath) return;
    try {
      if (!existsSync(this.options.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.options.filePath, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of records as ReplyPreferenceRecord[]) {
        if ((record?.scope === 'session' || record?.scope === 'user') && record.key && record.preference) {
          this.records.set(this.recordKey(record.scope, record.key), structuredClone(record));
        }
      }
      this.prune();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private cleanPreference(value: AgentReplyPreference): AgentReplyPreference | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const clean: AgentReplyPreference = {};
    if (['auto', 'direct', 'quote', 'plain', 'forward'].includes(String(value.mode))) clean.mode = value.mode;
    if (['auto', 'nested', 'flat'].includes(String(value.forwardStyle))) clean.forwardStyle = value.forwardStyle;
    if (['auto', 'on', 'off'].includes(String(value.voice))) clean.voice = value.voice;
    if (['auto', 'quote', 'none'].includes(String(value.reference))) clean.reference = value.reference;
    if (['turn', 'session', 'user'].includes(String(value.scope))) clean.scope = value.scope;
    return Object.keys(clean).length ? clean : undefined;
  }

  private isExpired(record: ReplyPreferenceRecord): boolean {
    if (!record.expiresAt) return false;
    const expiresAt = Date.parse(record.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= this.clock().getTime();
  }

  private prune(): void {
    let changed = false;
    for (const [id, record] of this.records) {
      if (this.isExpired(record)) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (this.records.size > this.maxRecords) {
      const keep = [...this.records.values()]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, this.maxRecords);
      this.records.clear();
      for (const record of keep) this.records.set(this.recordKey(record.scope, record.key), record);
      changed = true;
    }
    if (changed) this.flush();
  }

  private recordKey(scope: ReplyPreferenceScope, key: string): string {
    return `${scope}:${String(key || '').trim()}`;
  }

  private flush(): void {
    if (!this.options.filePath) return;
    try {
      mkdirSync(path.dirname(this.options.filePath), { recursive: true });
      const payload = JSON.stringify({ version: 1, records: [...this.records.values()] });
      const temp = this.options.filePath + '.tmp';
      writeFileSync(temp, payload, 'utf8');
      try { renameSync(temp, this.options.filePath); } catch { writeFileSync(this.options.filePath, payload, 'utf8'); }
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
