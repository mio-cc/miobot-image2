import type { PromptVersionConfig } from './config.js';

export interface PromptVersion {
  id: string;
  version: string;
  prompt: string;
  createdAt: string;
  status: 'draft' | 'canary' | 'active' | 'retired';
}

export interface PromptEvaluation {
  samples: number;
  successRate: number;
  averageScore: number;
  safetyFailures: number;
}

export interface PromptPromotionPolicy {
  minSamples: number;
  minSuccessRate: number;
  minAverageScore: number;
  maxSafetyFailures: number;
  canaryPercent: number;
  requireOwnerApproval?: boolean;
}

export interface PromptPromotionDecision {
  promote: boolean;
  reason: string;
}

export function evaluatePromptPromotion(
  evaluation: PromptEvaluation,
  policy: PromptPromotionPolicy,
  ownerApproved = !policy.requireOwnerApproval,
): PromptPromotionDecision {
  if (policy.requireOwnerApproval && !ownerApproved) return { promote: false, reason: 'owner_approval_required' };
  if (evaluation.samples < policy.minSamples) return { promote: false, reason: 'not_enough_samples' };
  if (evaluation.safetyFailures > policy.maxSafetyFailures) return { promote: false, reason: 'safety_failures' };
  if (evaluation.successRate < policy.minSuccessRate) return { promote: false, reason: 'success_rate_below_threshold' };
  if (evaluation.averageScore < policy.minAverageScore) return { promote: false, reason: 'score_below_threshold' };
  return { promote: true, reason: 'passed_evaluation' };
}

export function isCanarySelected(key: string, percent: number): boolean {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < pct;
}

export function pickPromptVersion(
  stable: PromptVersion,
  canary: PromptVersion | undefined,
  key: string,
  canaryPercent: number,
): PromptVersion {
  return canary && isCanarySelected(key, canaryPercent) ? canary : stable;
}

export function selectConfiguredPromptVersion(
  versions: PromptVersionConfig[],
  activeVersionId: string,
  canaryVersionId: string,
  key: string,
  canaryPercent: number,
): PromptVersionConfig | undefined {
  const active = versions.find((item) => item.id === activeVersionId)
    || versions.find((item) => item.status === 'active');
  const canary = versions.find((item) => item.id === canaryVersionId)
    || versions.find((item) => item.status === 'canary');
  if (canary && isCanarySelected(key, canaryPercent)) return canary;
  return active;
}

export interface PromptLineDiff {
  type: 'same' | 'add' | 'remove';
  text: string;
}

export function diffPromptText(before: string, after: string): PromptLineDiff[] {
  const left = String(before || '').split('\n');
  const right = String(after || '').split('\n');
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: PromptLineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({ type: 'same', text: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'remove', text: left[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    out.push({ type: 'remove', text: left[i] });
    i += 1;
  }
  while (j < right.length) {
    out.push({ type: 'add', text: right[j] });
    j += 1;
  }
  return out;
}