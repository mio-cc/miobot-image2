import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '../../../packages/tool-runtime/src/index.js';

export type ToolJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface ToolJobRecord {
  jobId: string;
  toolName: string;
  callId: string;
  sessionKey: string;
  status: ToolJobStatus;
  createdAt: string;
  updatedAt: string;
  externalTaskIds: string[];
  /** 崩溃恢复时已尝试的远端 probe 次数；跨进程持久化，避免重启后无限重试。 */
  probeAttempts?: number;
  result?: ToolResult;
  error?: { code: string; message: string };
}

export interface ToolJobRuntimeOptions {
  filePath?: string;
  maxRecords?: number;
  clock?: () => Date;
  onComplete?: (job: ToolJobRecord) => void;
  onError?: (error: unknown) => void;
}

export class ToolJobRuntime {
  private readonly records = new Map<string, ToolJobRecord>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly maxRecords: number;
  private readonly clock: () => Date;
  private recoveredTerminal: ToolJobRecord[] = [];

  constructor(private readonly options: ToolJobRuntimeOptions = {}) {
    this.maxRecords = Math.max(1, Math.trunc(Number(options.maxRecords) || 5000));
    this.clock = options.clock || (() => new Date());
    this.restore();
  }

  create(input: { toolName: string; callId: string; sessionKey: string; jobId?: string }): ToolJobRecord {
    const now = this.now();
    const jobId = String(input.jobId || `tooljob_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    const record: ToolJobRecord = {
      jobId,
      toolName: String(input.toolName),
      callId: String(input.callId),
      sessionKey: String(input.sessionKey),
      status: 'running',
      createdAt: now,
      updatedAt: now,
      externalTaskIds: [],
      probeAttempts: 0,
    };
    this.records.set(jobId, { ...record });
    this.prune();
    this.flush();
    return structuredClone(record);
  }

  get(jobId: string): ToolJobRecord | undefined {
    const record = this.records.get(String(jobId));
    return record ? structuredClone(record) : undefined;
  }

  recordProbeAttempt(jobId: string): number {
    const record = this.records.get(String(jobId));
    if (!record) return 0;
    record.probeAttempts = Math.max(0, Math.trunc(Number(record.probeAttempts) || 0)) + 1;
    record.updatedAt = this.now();
    this.flush();
    return record.probeAttempts;
  }

  recordExternalTask(jobId: string, taskId: string): void {
    const record = this.records.get(String(jobId));
    if (!record || !taskId) return;
    if (!record.externalTaskIds.includes(taskId)) record.externalTaskIds.push(taskId);
    record.updatedAt = this.now();
    this.flush();
  }

  run(jobId: string, task: Promise<ToolResult> | ((signal: AbortSignal) => Promise<ToolResult>), timeoutMs = 15 * 60 * 1000): Promise<void> {
    const key = String(jobId);
    if (this.active.has(key)) return this.active.get(key)!;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    // timeoutMs=0 表示不设本地任务总超时，等待远端/工作流真实完成或失败。
    const requestedTimeout = Number(timeoutMs);
    const noTimeout = requestedTimeout === 0;
    const timeout = noTimeout ? 0 : Math.max(1000, Number.isFinite(requestedTimeout) ? Math.trunc(requestedTimeout) : 15 * 60 * 1000);
    let timedOut = false;
    const taskPromise = typeof task === 'function' ? Promise.resolve().then(() => task(controller.signal)) : task;
    const guarded = noTimeout ? taskPromise : Promise.race([
      taskPromise,
      new Promise<ToolResult>((_, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('tool_job_timeout'));
        }, timeout);
        timer.unref?.();
      }),
    ]);
    const running = guarded
      .then((result) => { this.complete(key, result); })
      .catch((error) => {
        const current = this.records.get(key);
        if (current?.status === 'cancelled' || current?.status === 'expired') return;
        this.fail(key, timedOut ? 'tool_job_timeout' : controller.signal.aborted ? 'tool_job_cancelled' : 'tool_job_failed', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.active.delete(key);
        this.controllers.delete(key);
      });
    this.active.set(key, running);
    return running;
  }
  complete(jobId: string, result: ToolResult): ToolJobRecord | undefined {
    const record = this.records.get(String(jobId));
    if (!record || record.status !== 'running') return record ? structuredClone(record) : undefined;
    record.result = structuredClone(result);
    record.status = result.pending ? 'running' : result.ok ? 'succeeded' : 'failed';
    record.updatedAt = this.now();
    if (!result.ok && result.error) record.error = { code: result.error.code, message: result.error.message };
    this.flush();
    if (record.status !== 'running') this.notify(record);
    return structuredClone(record);
  }

  fail(jobId: string, code: string, message: string): ToolJobRecord | undefined {
    const record = this.records.get(String(jobId));
    if (!record || record.status !== 'running') return record ? structuredClone(record) : undefined;
    record.status = 'failed';
    record.error = { code, message };
    record.updatedAt = this.now();
    this.flush();
    this.notify(record);
    return structuredClone(record);
  }

  cancel(jobId: string, message = 'cancelled'): ToolJobRecord | undefined {
    const record = this.records.get(String(jobId));
    this.controllers.get(String(jobId))?.abort();
    if (!record || record.status !== 'running') return record ? structuredClone(record) : undefined;
    record.status = 'cancelled';
    record.error = { code: 'tool_job_cancelled', message };
    record.updatedAt = this.now();
    this.flush();
    this.notify(record);
    return structuredClone(record);
  }

  reconcileInterrupted(jobId: string, result: ToolResult): ToolJobRecord | undefined {
    const record = this.records.get(String(jobId));
    if (!record) return undefined;
    const interrupted = record.status === 'running' || record.error?.code === 'tool_job_interrupted';
    if (!interrupted) return structuredClone(record);
    record.result = structuredClone(result);
    record.status = result.pending ? 'running' : result.ok ? 'succeeded' : 'failed';
    if (result.ok) delete record.error;
    else if (result.error) record.error = { code: result.error.code, message: result.error.message };
    record.updatedAt = this.now();
    this.flush();
    if (record.status !== 'running') this.notify(record);
    return structuredClone(record);
  }

  recoverInterrupted(): ToolJobRecord[] {
    const recovered = this.recoveredTerminal;
    this.recoveredTerminal = [];
    return recovered.map((item) => structuredClone(item));
  }

  snapshot(): ToolJobRecord[] {
    return [...this.records.values()].map((item) => structuredClone(item));
  }

  private restore(): void {
    if (!this.options.filePath) return;
    try {
      if (!existsSync(this.options.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.options.filePath, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      for (const record of records as ToolJobRecord[]) {
        if (record?.jobId && record?.status) this.records.set(record.jobId, {
          ...record,
          externalTaskIds: Array.isArray(record.externalTaskIds) ? record.externalTaskIds.map(String) : [],
          probeAttempts: Math.max(0, Math.trunc(Number(record.probeAttempts) || 0)),
        });
      }
      for (const record of this.records.values()) {
        if (record.status !== 'running') continue;
        record.status = 'failed';
        record.error = { code: 'tool_job_interrupted', message: '任务在进程重启时中断，未自动重放。' };
        record.updatedAt = this.now();
        this.recoveredTerminal.push(structuredClone(record));
      }
      this.flush();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private notify(record: ToolJobRecord): void {
    try { this.options.onComplete?.(structuredClone(record)); } catch (error) { this.options.onError?.(error); }
  }

  private prune(): void {
    const running = [...this.records.values()].filter((record) => record.status === 'running');
    const terminal = [...this.records.values()]
      .filter((record) => record.status !== 'running')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const keep = [...running, ...terminal].slice(0, this.maxRecords);
    this.records.clear();
    for (const record of keep) this.records.set(record.jobId, record);
  }

  private flush(): void {
    if (!this.options.filePath) return;
    try {
      mkdirSync(path.dirname(this.options.filePath), { recursive: true });
      const payload = JSON.stringify({ version: 1, jobs: this.snapshot() });
      const temp = this.options.filePath + '.tmp';
      writeFileSync(temp, payload, 'utf8');
      try { renameSync(temp, this.options.filePath); } catch { writeFileSync(this.options.filePath, payload, 'utf8'); }
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
