import {
  ApprovalBroker,
  parseApprovalReply,
  renderApprovalPrompt,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalState,
} from '../../../packages/orchestration/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface ApprovalSendResult {
  success: boolean;
  messageId?: number | string;
  uncertain?: boolean;
  error?: string;
}

export interface ApprovalRuntimeOptions {
  broker?: ApprovalBroker;
  adminQqIds: () => string[];
  ownerQqIds?: () => string[];
  allowGroupReply: () => boolean;
  allowedGroupIds?: () => string[];
  sendPrivate: (qq: string, text: string) => Promise<ApprovalSendResult>;
  sendGroup?: (groupId: string, text: string) => Promise<ApprovalSendResult>;
  logger?: StructuredLogger;
  initialApprovals?: ApprovalRequest[];
  persist?: (approvals: ApprovalRequest[]) => void;
  maxPendingPerUser?: number | (() => number);
  maxPendingGlobal?: number | (() => number);
  resendIntervalMs?: number | (() => number);
  maxResend?: number | (() => number);
  /** 仅用于重启恢复：没有内存 waiter 的审批进入终态时通知 JobRecovery。 */
  onDecision?: (approval: ApprovalRequest) => void;
  audit?: (record: Record<string, unknown>) => void;
}

export interface ApprovalRequestInput {
  requestId: string;
  jobId: string;
  stepId?: string;
  capability: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requesterQq: string;
  groupId?: string;
  payload: unknown;
  summary?: string;
  quorum?: 'any' | 'all' | 'owner';
  ttlMs?: number;
  maskArgs?: boolean;
  onCreated?: (approval: ApprovalRequest) => void;
}

export interface ApprovalOutcome {
  status: ApprovalState | 'failed';
  approval?: ApprovalRequest;
  error?: string;
}

export class ApprovalRuntime {
  private readonly broker: ApprovalBroker;
  private readonly waiters = new Map<string, {
    resolve: (outcome: ApprovalOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
    resendTimer?: ReturnType<typeof setTimeout>;
    resendCount: number;
  }>();

  constructor(private readonly options: ApprovalRuntimeOptions) {
    this.broker = options.broker || new ApprovalBroker();
    if (options.initialApprovals?.length) this.broker.restore(options.initialApprovals);
  }

  getBroker(): ApprovalBroker {
    return this.broker;
  }

  async request(input: ApprovalRequestInput): Promise<ApprovalOutcome> {
    const admins = Array.from(new Set(this.options.adminQqIds().map(String).filter(Boolean)));
    const owners = Array.from(new Set((this.options.ownerQqIds?.() || []).map(String).filter(Boolean)));
    const eligibleAdmins = admins.filter((qq) => qq !== input.requesterQq);
    const eligibleOwners = owners.filter((qq) => qq !== input.requesterQq);
    const quorum = input.quorum || 'any';
    if (quorum === 'owner' ? !eligibleOwners.length : !eligibleAdmins.length) {
      return { status: 'failed', error: quorum === 'owner' ? 'approval_owner_unavailable' : 'approval_admin_unavailable' };
    }
    this.broker.expire();
    this.persist();
    const pending = this.broker.list('pending');
    const maxGlobal = Math.max(1, Number(typeof this.options.maxPendingGlobal === 'function' ? this.options.maxPendingGlobal() : this.options.maxPendingGlobal) || 50);
    const maxPerUser = Math.max(1, Number(typeof this.options.maxPendingPerUser === 'function' ? this.options.maxPendingPerUser() : this.options.maxPendingPerUser) || 3);
    if (pending.length >= maxGlobal) return { status: 'failed', error: 'approval_queue_full_global' };
    if (pending.filter((item) => item.requesterQq === input.requesterQq).length >= maxPerUser) return { status: 'failed', error: 'approval_queue_full_user' };
    const approval = this.broker.create({
      requestId: input.requestId,
      jobId: input.jobId,
      stepId: input.stepId,
      payload: input.payload,
      capability: input.capability,
      riskLevel: input.riskLevel,
      requesterQq: input.requesterQq,
      groupId: input.groupId,
      adminQqIds: eligibleAdmins,
      ownerQqIds: eligibleOwners,
      quorum,
      ttlMs: input.ttlMs,
    });
    this.audit('approval.created', approval);
    try { input.onCreated?.(approval); } catch { /* job checkpoint must not block approval */ }
    this.persist();
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const currentWaiter = this.waiters.get(approval.approvalId);
        if (currentWaiter?.resendTimer) clearTimeout(currentWaiter.resendTimer);
        this.waiters.delete(approval.approvalId);
        this.broker.expire();
        this.persist();
        const expired = this.broker.get(approval.approvalId) || approval;
        this.audit('approval.expired', expired);
        resolve({ status: 'expired', approval: expired });
      }, Math.max(1000, Date.parse(approval.expiresAt) - Date.now()));
      this.waiters.set(approval.approvalId, { resolve, timer, resendCount: 0 });
    });
    const prompt = renderApprovalPrompt(approval, { summary: input.summary, maskArgs: input.maskArgs });
    const recipients = quorum === 'owner' ? eligibleOwners : eligibleAdmins;
    const deliveries = await Promise.allSettled(recipients.map((admin) => this.options.sendPrivate(admin, prompt)));
    const delivered = deliveries.some((item) => item.status === 'fulfilled' && (item.value.success || item.value.uncertain));
    if (!delivered) {
      const waiter = this.waiters.get(approval.approvalId);
      if (waiter) {
        clearTimeout(waiter.timer);

        if (waiter.resendTimer) clearTimeout(waiter.resendTimer);
        this.waiters.delete(approval.approvalId);
      }
      this.broker.cancel(approval.approvalId, 'approval_delivery_failed');
      this.persist();
      const failed = this.broker.get(approval.approvalId);
      if (failed) this.audit('approval.decided', failed, { reason: 'approval_delivery_failed' });
      return { status: 'failed', approval: failed, error: 'approval_delivery_failed' };
    }
    const resendIntervalMs = Math.max(0, Math.trunc(Number(typeof this.options.resendIntervalMs === 'function' ? this.options.resendIntervalMs() : this.options.resendIntervalMs) || 0));
    const maxResend = Math.max(0, Math.trunc(Number(typeof this.options.maxResend === 'function' ? this.options.maxResend() : this.options.maxResend) || 0));
    const waiter = this.waiters.get(approval.approvalId);
    if (waiter && resendIntervalMs > 0 && maxResend > 0 && recipients.length) {
      const scheduleResend = () => {
        if (!this.waiters.has(approval.approvalId)) return;
        waiter.resendTimer = setTimeout(() => {
          const current = this.broker.get(approval.approvalId);
          if (!current || current.status !== 'pending' || !this.waiters.has(approval.approvalId)) return;
          if (waiter.resendCount >= maxResend) return;
          waiter.resendCount += 1;
          const resendText = '审批提醒（重发 ' + waiter.resendCount + '/' + maxResend + '）\n' + prompt;
          void Promise.allSettled(recipients.map((admin) => this.options.sendPrivate(admin, resendText)))
            .finally(() => scheduleResend());
        }, resendIntervalMs);
        waiter.resendTimer.unref?.();
      };
      scheduleResend();
    }
    return outcome;
  }

  private audit(type: string, approval: ApprovalRequest, extra: Record<string, unknown> = {}): void {
    try {
      this.options.audit?.({
        type,
        approvalId: approval.approvalId,
        requestId: approval.requestId,
        jobId: approval.jobId,
        capability: approval.capability,
        riskLevel: approval.riskLevel,
        decision: approval.status,
        actor: approval.decidedBy,
        data: {
          requesterQq: approval.requesterQq,
          groupId: approval.groupId,
          quorum: approval.quorum,
          stepId: approval.stepId,
          ...extra,
        },
      });
    } catch { /* audit must not affect approvals */ }
  }
  private persist(): void {
    try { this.options.persist?.(this.broker.snapshot()); } catch { /* persistence must never block approval */ }
  }

  private notifyDecision(approval: ApprovalRequest): void {
    if (approval.status === 'pending') return;
    try { this.options.onDecision?.(approval); } catch { /* recovery must not break approval handling */ }
  }

  pruneTerminal(retentionDays = 180, now = Date.now(), protectedApprovalIds: Iterable<string> = []): ApprovalRequest[] {
    const cutoff = now - Math.max(1, Math.trunc(Number(retentionDays) || 180)) * 24 * 60 * 60 * 1000;
    const removed = this.broker.pruneTerminal(cutoff, new Set(Array.from(protectedApprovalIds).map(String)));
    if (removed.length) this.persist();
    return removed;
  }
  /** 启动或定时扫描：没有内存 waiter 的过期审批通过 onDecision 恢复 Job。 */
  sweepExpired(now = new Date()): ApprovalRequest[] {
    const changed = this.broker.expire(now);
    if (!changed.length) return changed;
    this.persist();
    for (const approval of changed) {
      this.audit('approval.expired', approval);
      if (this.waiters.has(approval.approvalId)) {
        const waiter = this.waiters.get(approval.approvalId)!;
        clearTimeout(waiter.timer);
        if (waiter.resendTimer) clearTimeout(waiter.resendTimer);
        this.waiters.delete(approval.approvalId);
        waiter.resolve({ status: approval.status, approval });
      } else {
        this.notifyDecision(approval);
      }
    }
    return changed;
  }

  decideFromPanel(code: string, decision: 'approve' | 'reject' | 'cancel', actor = 'panel'): ApprovalRequest {
    const current = this.broker.getByCode(code);
    if (!current) throw new Error('approval_not_found');
    const next = this.broker.decide(current.approvalId, {
      adminQq: actor,
      decision,
      at: new Date().toISOString(),
      reason: 'admin_panel',
    }, undefined, new Date(), true);
    this.persist();
    const waiter = this.waiters.get(next.approvalId);
    const hadWaiter = Boolean(waiter);
    if (waiter && next.status !== 'pending') {
      clearTimeout(waiter.timer);
      if (waiter.resendTimer) clearTimeout(waiter.resendTimer);
      this.waiters.delete(next.approvalId);
      waiter.resolve({ status: next.status, approval: next });
    }
    if (next.status !== 'pending' && !hadWaiter) this.notifyDecision(next);
    this.audit('approval.decided', next);
    return next;
  }

  async handleReply(input: {
    text: string;
    userId: string | number;
    groupId?: string | number;
    chatType: 'group' | 'private';
  }): Promise<{ handled: boolean; approval?: ApprovalRequest; reason?: string }> {
    const parsed = parseApprovalReply(input.text);
    if (!parsed) return { handled: false };
    const adminQq = String(input.userId || '');
    const current = this.broker.getByCode(parsed.code);
    const owners = this.options.ownerQqIds?.() || [];
    const allowedApprovers = current?.quorum === 'owner' ? owners.map(String) : this.options.adminQqIds().map(String);
    if (!allowedApprovers.includes(adminQq)) {
      return { handled: true, reason: 'not_an_approval_admin' };
    }
    if (input.chatType === 'group') {
      if (!this.options.allowGroupReply()) return { handled: true, reason: 'group_approval_disabled' };
      const allowed = this.options.allowedGroupIds?.() || [];
      if (allowed.length && !allowed.map(String).includes(String(input.groupId))) {
        return { handled: true, reason: 'approval_group_not_allowed' };
      }
    }
    if (!current) return { handled: true, reason: 'approval_not_found' };
    if (current.requesterQq === adminQq) return { handled: true, reason: 'requester_cannot_approve' };
    const decision: ApprovalDecision = {
      adminQq,
      decision: parsed.decision,
      at: new Date().toISOString(),
      reason: input.chatType === 'group' ? 'group_admin_approval' : 'private_admin_approval',
    };
    const next = this.broker.decide(current.approvalId, decision);
    this.persist();
    const waiter = this.waiters.get(next.approvalId);
    const hadWaiter = Boolean(waiter);
    if (waiter && next.status !== 'pending') {
      clearTimeout(waiter.timer);
      if (waiter.resendTimer) clearTimeout(waiter.resendTimer);
      this.waiters.delete(next.approvalId);
      waiter.resolve({ status: next.status, approval: next });
    }
    if (next.status !== 'pending' && !hadWaiter) this.notifyDecision(next);
    this.audit('approval.decided', next);
    const confirmation = next.status === 'approved'
      ? `已批准 ${next.code}`
      : next.status === 'rejected'
        ? `已拒绝 ${next.code}`
        : next.status === 'cancelled' ? `已取消 ${next.code}` : `已记录 ${next.code}，等待其他管理员`;
    if (input.chatType === 'group' && this.options.sendGroup && input.groupId !== undefined) {
      void this.options.sendGroup(String(input.groupId), confirmation).catch?.(() => undefined);
    } else {
      void this.options.sendPrivate(adminQq, confirmation).catch?.(() => undefined);
    }
    return { handled: true, approval: next };
  }
}
