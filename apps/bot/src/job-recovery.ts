import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { ApprovalRequest } from '../../../packages/orchestration/src/index.js';
import type { ApprovalRuntime } from './approval-runtime.js';
import { pendingSessionKey, type PendingJobRecord, type PendingJobStore } from './pending-job-store.js';

export interface JobRecoveryOptions {
  jobs: PendingJobStore;
  approvals: ApprovalRuntime;
  resume: (job: PendingJobRecord) => Promise<void>;
  logger?: StructuredLogger;
}

/**
 * 审批发生在 bot 重启之后时，ApprovalRuntime 没有原内存 waiter。
 * 这里把审批终态重新绑定到 Durable Job，并通过 runtime 的正常发送链路恢复任务。
 */
export class JobRecoveryService {
  private readonly active = new Set<string>();

  constructor(private readonly options: JobRecoveryOptions) {}

  onDecision(approval: ApprovalRequest): void {
    if (approval.status === 'pending') return;
    const job = this.options.jobs.findByApprovalId(approval.approvalId);
    if (!job) return;
    void this.recover(job);
  }

  start(): void {
    const expired = this.options.approvals.sweepExpired();
    if (expired.length) {
      this.options.logger?.info('恢复任务：审批已过期', { count: expired.length });
    }
    for (const job of this.options.jobs.listActive()) {
      if (job.status !== 'waiting_approval') continue;
      const approval = job.approvalId ? this.options.approvals.getBroker().get(job.approvalId) : undefined;
      if (!approval || approval.status !== 'pending') void this.recover(job);
    }
  }

  private async recover(job: PendingJobRecord): Promise<void> {
    // C2：等待审批的任务记录在 job:<jobId> 键；恢复前挪回会话键，
    // 合成消息走 handleInner 的会话键查找才能续上。dedupe 用 jobId（键会变）。
    const dedupeKey = String(job.jobId || job.key);
    if (this.active.has(dedupeKey)) return;
    this.active.add(dedupeKey);
    try {
      const chat = job.originalRequest?.chat;
      if (chat?.type && chat.userId) {
        const sessionKey = pendingSessionKey(chat);
        if (job.key !== sessionKey) {
          this.options.jobs.move(job.key, sessionKey);
          job = { ...job, key: sessionKey };
        }
      }
      await this.options.resume(job);
    } catch (error) {
      this.options.logger?.warn('恢复任务失败', {
        jobId: job.jobId,
        approvalId: job.approvalId,
        error: String((error as Error)?.message || error),
      });
    } finally {
      this.active.delete(dedupeKey);
    }
  }
}