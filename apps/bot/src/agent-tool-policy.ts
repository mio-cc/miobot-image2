import type { AgentToolPreflight, AgentToolPreflightInput, AgentToolPreflightDecision } from '../../../packages/agent-runtime/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import {
  createPermissionPolicyFromDefaults,
  hashApprovalPayload,
  resolvePermission,
  type UserRole,
} from '../../../packages/orchestration/src/index.js';
import { makeToolError } from '../../../packages/tool-runtime/src/index.js';
import type { ApprovalRuntime } from './approval-runtime.js';

export interface AgentToolPolicyOptions {
  getConfig: () => AppConfig;
  resolveRole: (cfg: AppConfig, userId?: string | number) => UserRole;
  approvalRuntime?: Pick<ApprovalRuntime, 'request' | 'propose'>;
  /** block keeps legacy request/wait; suspend checkpoints pendingApproval for cross-message resume. */
  approvalMode?: 'block' | 'suspend';
}

export function createAgentToolPreflight(options: AgentToolPolicyOptions): AgentToolPreflight {
  return async (input: AgentToolPreflightInput): Promise<AgentToolPreflightDecision> => {
    const cfg = options.getConfig();
    const meta = input.metadata || {};
    const args = input.call.arguments && typeof input.call.arguments === 'object' && !Array.isArray(input.call.arguments)
      ? input.call.arguments as Record<string, unknown>
      : {};
    const role = meta.userRole === 'owner' || meta.userRole === 'admin' || meta.userRole === 'guest' || meta.userRole === 'user'
      ? meta.userRole as UserRole
      : options.resolveRole(cfg, meta.userId as string | number | undefined);
    const permissions = cfg.orchestration.permissions;
    const policy = createPermissionPolicyFromDefaults({
      low: permissions.defaultLow,
      medium: permissions.defaultMedium,
      high: permissions.defaultHigh,
      critical: permissions.defaultCritical,
      hardDenyEnabled: permissions.hardDenyEnabled,
      hardDenyCapabilities: permissions.hardDenyCapabilities,
      rules: permissions.rules,
    });
    const declaredRisk = input.spec.riskLevel || 'medium';
    const effectiveRisk = input.spec.approvalRequired && role !== 'owner' && (declaredRisk === 'low' || declaredRisk === 'medium')
      ? 'high'
      : declaredRisk;
    const permission = resolvePermission({
      capability: input.call.name,
      provider: input.spec.provider,
      riskLevel: effectiveRisk,
      user: { qq: String(meta.userId ?? ''), role },
      chat: {
        type: meta.chatType === 'group' ? 'group' : 'private',
        ...(meta.groupId !== undefined ? { groupId: String(meta.groupId) } : {}),
        ...(meta.userId !== undefined ? { userId: String(meta.userId) } : {}),
      },
      params: args,
    }, policy);
    if (permission.decision === 'deny') {
      return {
        allowed: false,
        error: makeToolError({
          code: 'permission_denied',
          message: permission.reason || '权限规则拒绝该工具调用。',
          callId: input.call.id,
          toolName: input.call.name,
          retryable: false,
          details: { matchedRule: permission.matchedRule, policyVersion: permission.policyVersion },
        }),
      };
    }
    if (permission.decision === 'allow') return { allowed: true };
    if (!cfg.orchestration.approval.enabled || !options.approvalRuntime) {
      return {
        allowed: false,
        error: makeToolError({
          code: 'approval_required',
          message: '该工具需要管理员审批，但审批运行时不可用。',
          callId: input.call.id,
          toolName: input.call.name,
          retryable: false,
          details: { approvalUnavailable: true },
        }),
      };
    }

    const payloadHash = hashApprovalPayload(args);
    const requestId = String(meta.requestId || input.requestId || input.turnId);
    const approvalRequest = {
      requestId,
      jobId: `agent:${input.sessionKey}:${input.turnId}`,
      stepId: input.call.id,
      capability: input.call.name,
      riskLevel: effectiveRisk as 'low' | 'medium' | 'high' | 'critical',
      requesterQq: String(meta.userId ?? ''),
      ...(meta.groupId !== undefined ? { groupId: String(meta.groupId) } : {}),
      payload: args,
      quorum: cfg.orchestration.approval.quorum,
      maskArgs: cfg.orchestration.approval.maskArgs,
      summary: `${input.call.name} 需要管理员审批`,
      ttlMs: cfg.orchestration.approval.timeoutMs,
    };

    if (options.approvalMode === 'suspend') {
      if (!options.approvalRuntime.propose) {
        return {
          allowed: false,
          error: makeToolError({
            code: 'approval_required',
            message: '审批运行时缺少非阻塞提交能力。',
            callId: input.call.id,
            toolName: input.call.name,
            retryable: false,
            details: { approvalUnavailable: true, expectedPayloadHash: payloadHash },
          }),
        };
      }
      const proposal = await options.approvalRuntime.propose(approvalRequest);
      if (proposal.status === 'pending' && proposal.approval) {
        return {
          allowed: false,
          error: makeToolError({
            code: 'approval_required',
            message: '该操作已提交管理员审批。',
            callId: input.call.id,
            toolName: input.call.name,
            retryable: false,
            details: {
              approvalId: proposal.approval.approvalId,
              approvalStatus: 'pending',
              expectedPayloadHash: payloadHash,
            },
          }),
          pendingApproval: {
            approvalId: proposal.approval.approvalId,
            status: 'pending',
            toolName: input.call.name,
            callId: input.call.id,
            payloadHash,
            createdAt: proposal.approval.createdAt,
            expiresAt: proposal.approval.expiresAt,
          },
        };
      }
      return {
        allowed: false,
        error: makeToolError({
          code: 'approval_required',
          message: proposal.error || `审批提交失败：${proposal.status}`,
          callId: input.call.id,
          toolName: input.call.name,
          retryable: proposal.status === 'failed',
          details: {
            approvalStatus: proposal.status,
            ...(proposal.approval?.approvalId ? { approvalId: proposal.approval.approvalId } : {}),
            expectedPayloadHash: payloadHash,
          },
        }),
      };
    }

    const outcome = await options.approvalRuntime.request(approvalRequest);
    if (outcome.status === 'approved' && outcome.approval?.payloadHash === payloadHash) return { allowed: true };
    return {
      allowed: false,
      error: makeToolError({
        code: outcome.status === 'rejected' ? 'permission_denied' : 'approval_required',
        message: outcome.status === 'approved'
          ? '审批参数哈希不一致，拒绝执行。'
          : `审批未通过：${outcome.status}`,
        callId: input.call.id,
        toolName: input.call.name,
        retryable: outcome.status === 'failed',
        details: {
          approvalStatus: outcome.status,
          ...(outcome.approval?.approvalId ? { approvalId: outcome.approval.approvalId } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          expectedPayloadHash: payloadHash,
        },
      }),
    };
  };
}
