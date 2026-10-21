import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalQuorum,
  ApprovalRequest,
  ApprovalState,
  RiskLevel,
} from './types.js';

export interface CreateApprovalInput {
  requestId: string;
  jobId: string;
  stepId?: string;
  payload: unknown;
  capability: string;
  riskLevel: RiskLevel;
  requesterQq: string;
  groupId?: string;
  adminQqIds: string[];
  ownerQqIds?: string[];
  quorum?: ApprovalQuorum;
  ttlMs?: number;
  now?: Date;
}

export function hashApprovalPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

export function createApproval(input: CreateApprovalInput): ApprovalRequest {
  const now = input.now || new Date();
  const ttlMs = Math.max(1000, Math.trunc(Number(input.ttlMs) || 120000));
  return {
    approvalId: `apr_${randomUUID()}`,
    code: randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase(),
    requestId: input.requestId,
    jobId: input.jobId,
    stepId: input.stepId,
    payloadHash: hashApprovalPayload(input.payload),
    capability: input.capability,
    riskLevel: input.riskLevel,
    requesterQq: input.requesterQq,
    groupId: input.groupId,
    adminQqIds: Array.from(new Set(input.adminQqIds.map(String).filter(Boolean))),
    ownerQqIds: Array.from(new Set((input.ownerQqIds || []).map(String).filter(Boolean))),
    quorum: input.quorum || 'any',
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    decisions: [],
  };
}

export function expireApproval(approval: ApprovalRequest, now: Date = new Date()): ApprovalRequest {
  if (approval.status !== 'pending') return approval;
  if (now.getTime() < Date.parse(approval.expiresAt)) return approval;
  return { ...approval, status: 'expired', decidedAt: now.toISOString(), reason: '审批超时' };
}

export function decideApproval(
  approval: ApprovalRequest,
  decision: ApprovalDecision,
  payloadHash?: string,
  now: Date = new Date(),
  options: { bypassApproverCheck?: boolean } = {},
): ApprovalRequest {
  const current = expireApproval(approval, now);
  if (current.status !== 'pending') return current;
  const allowedApprovers = current.quorum === 'owner' ? current.ownerQqIds || [] : current.adminQqIds;
  if (!options.bypassApproverCheck && !allowedApprovers.includes(decision.adminQq)) {
    throw new Error('approval_admin_not_allowed');
  }
  if (!options.bypassApproverCheck && current.requesterQq === decision.adminQq) {
    throw new Error('approval_requester_cannot_decide');
  }
  if (payloadHash !== undefined && payloadHash !== current.payloadHash) {
    throw new Error('approval_payload_changed');
  }
  const decisions = [...(current.decisions || [])];
  if (!decisions.some((item) => item.adminQq === decision.adminQq)) {
    decisions.push(decision);
  }
  const rejected = decisions.find((item) => item.decision === 'reject' || item.decision === 'cancel');
  if (rejected) {
    return {
      ...current,
      status: rejected.decision === 'cancel' ? 'cancelled' : 'rejected',
      decidedAt: now.toISOString(),
      decidedBy: rejected.adminQq,
      reason: rejected.reason || '管理员拒绝',
      decisions,
    };
  }
  const approvals = new Set(decisions.filter((item) => item.decision === 'approve').map((item) => item.adminQq));
  const required = current.quorum === 'all' ? new Set(current.adminQqIds)
    : current.quorum === 'owner' ? new Set(current.ownerQqIds || []) : null;
  const approved = required
    ? required.size > 0 && Array.from(required).every((qq) => approvals.has(qq))
    : approvals.size > 0;
  if (!approved) return { ...current, decisions };
  return {
    ...current,
    status: 'approved',
    decidedAt: now.toISOString(),
    decidedBy: decisions[decisions.length - 1]?.adminQq,
    decisions,
  };
}

export function isApprovalTerminal(status: ApprovalState): boolean {
  return status !== 'pending';
}
