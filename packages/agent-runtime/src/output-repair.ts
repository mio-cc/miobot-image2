import { fingerprintToolError, type ToolError } from '../../tool-runtime/src/index.js';

export type OutputRepairKind = 'protocol' | 'schema';

export interface OutputRepairLimits {
  maxProtocolRepairs: number;
  maxSchemaRepairsPerCall: number;
  maxTotalOutputRepairs: number;
  maxRepeatedErrorCount: number;
  repairTemperature: number;
  allowTextFallback: boolean;
}

export const DEFAULT_OUTPUT_REPAIR_LIMITS: Readonly<OutputRepairLimits> = Object.freeze({
  maxProtocolRepairs: 2,
  maxSchemaRepairsPerCall: 2,
  maxTotalOutputRepairs: 4,
  maxRepeatedErrorCount: 2,
  repairTemperature: 0,
  allowTextFallback: true,
});

export type RepairLimitReason =
  | 'max_protocol_repairs'
  | 'max_schema_repairs_per_call'
  | 'max_total_output_repairs'
  | 'max_repeated_error_count';

export interface OutputRepairDecision {
  allowed: boolean;
  reason?: RepairLimitReason;
  fingerprint: string;
  repeatedErrorCount: number;
}

export interface OutputRepairRequest {
  error: ToolError;
  kind: OutputRepairKind;
  callId?: string;
}

export interface OutputRepairSnapshot {
  protocolRepairs: number;
  totalRepairs: number;
  schemaRepairsByCall: Record<string, number>;
  repeatedErrors: Record<string, number>;
  limits: OutputRepairLimits;
}

/**
 * Tracks repair budgets and repeated-error fingerprints. It does not generate
 * repair prompts; that belongs to the R3 agent loop. Requesting a repair both
 * checks the budget and consumes it atomically.
 */
export class OutputRepairBudgetTracker {
  private readonly limits: OutputRepairLimits;
  private protocolRepairs = 0;
  private totalRepairs = 0;
  private readonly schemaRepairsByCall = new Map<string, number>();
  private readonly repeatedErrors = new Map<string, number>();

  constructor(limits: Partial<OutputRepairLimits> = {}) {
    this.limits = normalizeRepairLimits({ ...DEFAULT_OUTPUT_REPAIR_LIMITS, ...limits });
  }

  requestRepair(error: ToolError, kind: OutputRepairKind, callId?: string): OutputRepairDecision {
    return this.requestRepairBatch([{ error, kind, ...(callId ? { callId } : {}) }]);
  }

  /**
   * One validation failure can contain many issues, but it consumes one model
   * repair round. Per-call schema counters are still advanced for every call
   * represented in the batch.
   */
  requestRepairBatch(requests: OutputRepairRequest[]): OutputRepairDecision {
    const valid = (Array.isArray(requests) ? requests : []).filter((request) => request && request.error && (request.kind === 'protocol' || request.kind === 'schema'));
    if (!valid.length) return { allowed: true, fingerprint: '', repeatedErrorCount: 0 };
    const fingerprints = new Map<string, number>();
    for (const request of valid) {
      const fingerprint = request.error.fingerprint || fingerprintToolError(request.error);
      fingerprints.set(fingerprint, 1);
    }
    const primaryFingerprint = fingerprints.keys().next().value as string;
    let maxRepeat = 0;
    for (const [fingerprint, count] of fingerprints) {
      const next = (this.repeatedErrors.get(fingerprint) || 0) + count;
      this.repeatedErrors.set(fingerprint, next);
      maxRepeat = Math.max(maxRepeat, next);
    }
    if (maxRepeat >= this.limits.maxRepeatedErrorCount) {
      return { allowed: false, reason: 'max_repeated_error_count', fingerprint: primaryFingerprint, repeatedErrorCount: maxRepeat };
    }
    if (this.totalRepairs >= this.limits.maxTotalOutputRepairs) {
      return { allowed: false, reason: 'max_total_output_repairs', fingerprint: primaryFingerprint, repeatedErrorCount: maxRepeat };
    }
    const hasProtocol = valid.some((request) => request.kind === 'protocol');
    if (hasProtocol && this.protocolRepairs >= this.limits.maxProtocolRepairs) {
      return { allowed: false, reason: 'max_protocol_repairs', fingerprint: primaryFingerprint, repeatedErrorCount: maxRepeat };
    }
    const schemaCallIds = Array.from(new Set(valid
      .filter((request) => request.kind === 'schema')
      .map((request) => String(request.callId || '$'))));
    for (const callId of schemaCallIds) {
      if ((this.schemaRepairsByCall.get(callId) || 0) >= this.limits.maxSchemaRepairsPerCall) {
        return { allowed: false, reason: 'max_schema_repairs_per_call', fingerprint: primaryFingerprint, repeatedErrorCount: maxRepeat };
      }
    }
    this.totalRepairs += 1;
    if (hasProtocol) this.protocolRepairs += 1;
    for (const callId of schemaCallIds) this.schemaRepairsByCall.set(callId, (this.schemaRepairsByCall.get(callId) || 0) + 1);
    return { allowed: true, fingerprint: primaryFingerprint, repeatedErrorCount: maxRepeat };
  }

  getLimits(): OutputRepairLimits {
    return { ...this.limits };
  }

  snapshot(): OutputRepairSnapshot {
    return {
      protocolRepairs: this.protocolRepairs,
      totalRepairs: this.totalRepairs,
      schemaRepairsByCall: Object.fromEntries(this.schemaRepairsByCall),
      repeatedErrors: Object.fromEntries(this.repeatedErrors),
      limits: this.getLimits(),
    };
  }

  reset(): void {
    this.protocolRepairs = 0;
    this.totalRepairs = 0;
    this.schemaRepairsByCall.clear();
    this.repeatedErrors.clear();
  }
}

export function normalizeRepairLimits(input: Partial<OutputRepairLimits>): OutputRepairLimits {
  return {
    maxProtocolRepairs: intIn(input.maxProtocolRepairs, DEFAULT_OUTPUT_REPAIR_LIMITS.maxProtocolRepairs, 0, 20),
    maxSchemaRepairsPerCall: intIn(input.maxSchemaRepairsPerCall, DEFAULT_OUTPUT_REPAIR_LIMITS.maxSchemaRepairsPerCall, 0, 20),
    maxTotalOutputRepairs: intIn(input.maxTotalOutputRepairs, DEFAULT_OUTPUT_REPAIR_LIMITS.maxTotalOutputRepairs, 0, 40),
    maxRepeatedErrorCount: intIn(input.maxRepeatedErrorCount, DEFAULT_OUTPUT_REPAIR_LIMITS.maxRepeatedErrorCount, 1, 20),
    repairTemperature: numberIn(input.repairTemperature, DEFAULT_OUTPUT_REPAIR_LIMITS.repairTemperature, 0, 1),
    allowTextFallback: typeof input.allowTextFallback === 'boolean' ? input.allowTextFallback : DEFAULT_OUTPUT_REPAIR_LIMITS.allowTextFallback,
  };
}

function intIn(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
