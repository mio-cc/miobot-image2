import type { ExecutionResult, IntentPlan, UserRequest } from '../../../packages/orchestration/src/index.js';

export type PendingJobStatus =
  | 'clarifying'
  | 'waiting_approval'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface PendingJobRecord {
  key: string;
  originalText: string;
  question: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  schemaVersion?: number;
  jobId?: string;
  requestId?: string;
  status?: PendingJobStatus;
  originalRequest?: UserRequest;
  plan?: IntentPlan;
  order?: string[];
  results?: Record<string, ExecutionResult>;
  approvedStepIds?: string[];
  pendingStepId?: string;
  pendingQuestion?: string;
  approvalId?: string;
  approvalPayloadHash?: string;
  clarificationUsed?: boolean;
  clarificationCount?: number;
  startedAt?: number;
  lastError?: string;
}

export class PendingJobStore {
  private readonly records = new Map<string, PendingJobRecord>();

  constructor(private readonly persist?: (records: PendingJobRecord[]) => void) {}

  restore(records: PendingJobRecord[]): void {
    for (const record of Array.isArray(records) ? records : []) {
      if (record?.key && record?.expiresAt) {
        this.records.set(record.key, this.clone({ ...record, schemaVersion: record.schemaVersion || 2 }));
      }
    }
  }

  get(key: string, now = Date.now()): PendingJobRecord | undefined {
    const record = this.records.get(String(key));
    if (!record) return undefined;
    if (Date.parse(record.expiresAt) <= now) {
      this.records.delete(record.key);
      this.flush();
      return undefined;
    }
    return this.clone(record);
  }

  set(record: PendingJobRecord): void {
    this.records.set(record.key, this.clone({ ...record, schemaVersion: record.schemaVersion || 2 }));
    this.flush();
  }

  update(key: string, patch: Partial<PendingJobRecord>): PendingJobRecord | undefined {
    const current = this.records.get(String(key));
    if (!current) return undefined;
    const next = this.clone({ ...current, ...patch, key: current.key, schemaVersion: 2, updatedAt: new Date().toISOString() });
    this.records.set(next.key, next);
    this.flush();
    return this.clone(next);
  }

  delete(key: string): void {
    if (this.records.delete(String(key))) this.flush();
  }

  findByApprovalId(approvalId: string, now = Date.now()): PendingJobRecord | undefined {
    for (const record of this.records.values()) {
      if (record.approvalId !== approvalId) continue;
      if (Date.parse(record.expiresAt) <= now) {
        this.records.delete(record.key);
        this.flush();
        return undefined;
      }
      return this.clone(record);
    }
    return undefined;
  }

  listActive(now = Date.now()): PendingJobRecord[] {
    let changed = false;
    for (const [key, record] of this.records) {
      if (Date.parse(record.expiresAt) <= now) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (changed) this.flush();
    return Array.from(this.records.values()).map((item) => this.clone(item));
  }

  list(): PendingJobRecord[] {
    return Array.from(this.records.values()).map((item) => this.clone(item));
  }

  private clone<T>(value: T): T {
    const structured = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone;
    if (structured) {
      try { return structured(value); } catch { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private flush(): void {
    try { this.persist?.(this.list()); } catch { /* persistence must not block conversation */ }
  }
}