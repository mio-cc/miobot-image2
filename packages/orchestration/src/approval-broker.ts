import type { ApprovalDecision, ApprovalRequest, ApprovalState } from './types.js';
import { createApproval, decideApproval, expireApproval, type CreateApprovalInput } from './approvals.js';

export class ApprovalBroker {
  private readonly byId = new Map<string, ApprovalRequest>();
  private readonly byCode = new Map<string, string>();

  restore(items: ApprovalRequest[]): void {
    this.byId.clear();
    this.byCode.clear();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.approvalId || !item.code) continue;
      this.byId.set(item.approvalId, item);
      this.byCode.set(String(item.code).toUpperCase(), item.approvalId);
    }
  }

  snapshot(): ApprovalRequest[] {
    return Array.from(this.byId.values()).map((item) => ({ ...item }));
  }

  create(input: CreateApprovalInput): ApprovalRequest {
    const approval = createApproval(input);
    this.byId.set(approval.approvalId, approval);
    this.byCode.set(approval.code, approval.approvalId);
    return approval;
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.byId.get(String(approvalId));
  }

  getByCode(code: string): ApprovalRequest | undefined {
    const id = this.byCode.get(String(code).toUpperCase());
    return id ? this.byId.get(id) : undefined;
  }

  list(status?: ApprovalState): ApprovalRequest[] {
    const values = Array.from(this.byId.values());
    return status ? values.filter((item) => item.status === status) : values;
  }

  decide(approvalId: string, decision: ApprovalDecision, payloadHash?: string, now: Date = new Date(), bypassApproverCheck = false): ApprovalRequest {
    const current = this.byId.get(String(approvalId));
    if (!current) throw new Error('approval_not_found');
    const next = decideApproval(current, decision, payloadHash, now, { bypassApproverCheck });
    this.byId.set(next.approvalId, next);
    return next;
  }

  decideByCode(code: string, decision: ApprovalDecision, payloadHash?: string, now: Date = new Date(), bypassApproverCheck = false): ApprovalRequest {
    const current = this.getByCode(code);
    if (!current) throw new Error('approval_not_found');
    return this.decide(current.approvalId, decision, payloadHash, now, bypassApproverCheck);
  }

  expire(now: Date = new Date()): ApprovalRequest[] {
    const changed: ApprovalRequest[] = [];
    for (const [id, current] of this.byId) {
      const next = expireApproval(current, now);
      if (next !== current) {
        this.byId.set(id, next);
        changed.push(next);
      }
    }
    return changed;
  }

  pruneTerminal(cutoffMs: number, protectedIds: Set<string> = new Set()): ApprovalRequest[] {
    const removed: ApprovalRequest[] = [];
    const kept: ApprovalRequest[] = [];
    for (const approval of this.byId.values()) {
      if (approval.status !== 'pending') {
        if (protectedIds.has(approval.approvalId)) { kept.push(approval); continue; }
        const at = Date.parse(approval.decidedAt || approval.createdAt);
        if (Number.isFinite(at) && at < cutoffMs) {
          removed.push(approval);
          continue;
        }
      }
      kept.push(approval);
    }
    if (removed.length) this.restore(kept);
    return removed;
  }
  cancel(approvalId: string, reason = 'cancelled'): ApprovalRequest {
    const current = this.byId.get(String(approvalId));
    if (!current) throw new Error('approval_not_found');
    if (current.status !== 'pending') return current;
    const next = { ...current, status: 'cancelled' as const, reason, decidedAt: new Date().toISOString() };
    this.byId.set(next.approvalId, next);
    return next;
  }
}
