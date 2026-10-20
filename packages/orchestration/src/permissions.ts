import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRule,
  RiskLevel,
} from './types.js';

export interface PermissionPolicy {
  version?: string;
  rules: PermissionRule[];
}

const SCOPE_RANK: Record<PermissionRule['scope'], number> = {
  global: 1,
  provider: 2,
  capability: 3,
  role: 4,
  group: 5,
  user: 6,
};

const MODE_RESTRICTIVENESS: Record<PermissionMode, number> = {
  allow: 1,
  ask_admin: 2,
  deny: 3,
};

function matchesRule(rule: PermissionRule, request: PermissionRequest): boolean {
  if (rule.roles && !rule.roles.includes(request.user.role)) return false;
  if (rule.qq && rule.qq !== request.user.qq) return false;
  if (rule.groupId && rule.groupId !== request.chat.groupId) return false;
  if (rule.capability && rule.capability !== request.capability) return false;
  if (rule.provider && rule.provider !== request.provider) return false;
  if (rule.riskLevels && !rule.riskLevels.includes(request.riskLevel)) return false;
  return true;
}

function sortRules(a: PermissionRule, b: PermissionRule): number {
  const rankDiff = (SCOPE_RANK[b.scope] || 0) - (SCOPE_RANK[a.scope] || 0);
  if (rankDiff !== 0) return rankDiff;
  const priorityDiff = (Number(b.priority) || 0) - (Number(a.priority) || 0);
  if (priorityDiff !== 0) return priorityDiff;
  return (MODE_RESTRICTIVENESS[b.mode] || 0) - (MODE_RESTRICTIVENESS[a.mode] || 0);
}

export function createDefaultPermissionPolicy(version = 'default-v1'): PermissionPolicy {
  return {
    version,
    rules: [
      {
        id: 'owner-full-permission',
        scope: 'role',
        roles: ['owner'],
        mode: 'allow',
        priority: 100,
        reason: 'owner 默认完全权限',
      },
      {
        id: 'admin-high-risk-approval',
        scope: 'role',
        roles: ['admin'],
        mode: 'ask_admin',
        riskLevels: ['high', 'critical'],
        priority: 90,
        reason: 'admin 高风险动作需要审批',
      },
      {
        id: 'user-high-risk-deny',
        scope: 'role',
        roles: ['guest', 'user'],
        mode: 'deny',
        riskLevels: ['high', 'critical'],
        priority: 90,
        reason: '普通用户高风险动作默认拒绝',
      },
      {
        id: 'low-medium-allow',
        scope: 'global',
        mode: 'allow',
        riskLevels: ['low', 'medium'],
        priority: 10,
        reason: '低中风险默认允许',
      },
    ],
  };
}

export function resolvePermission(
  request: PermissionRequest,
  policy: PermissionPolicy,
): PermissionDecision {
  const applicable = policy.rules.filter((rule) => matchesRule(rule, request)).sort(sortRules);
  const hardDeny = applicable.find((rule) => rule.hard && rule.mode === 'deny');
  if (hardDeny) {
    return {
      decision: 'deny',
      reason: hardDeny.reason || '命中硬拒绝规则',
      matchedRule: hardDeny.id,
      hardDenied: true,
      policyVersion: policy.version,
    };
  }

  const selected = applicable[0];
  if (!selected) {
    const fallback: PermissionMode = request.riskLevel === 'critical' ? 'deny' : 'ask_admin';
    return {
      decision: fallback,
      reason: '没有匹配规则，按安全默认处理',
      hardDenied: false,
      policyVersion: policy.version,
    };
  }

  return {
    decision: selected.mode,
    reason: selected.reason || '命中权限规则',
    matchedRule: selected.id,
    hardDenied: false,
    policyVersion: policy.version,
  };
}

export function isRiskAtLeast(risk: RiskLevel, threshold: RiskLevel): boolean {
  const order: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return order.indexOf(risk) >= order.indexOf(threshold);
}
