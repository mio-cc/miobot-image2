import type { CapabilityDescriptor, ExecutionResult, IntentPlan, IntentStep, UserRequest } from './types.js';
import { topologicalStepOrder, validateIntentPlan } from './plan.js';
import { CapabilityDispatcher, type DispatchResult } from './dispatcher.js';

export interface PlanExecutionUsage {
  stepsExecuted: number;
  cost: number;
  modelRounds: number;
  durationMs: number;
  maxParallelObserved: number;
}

export interface PlanExecutionResult {
  status: 'success' | 'partial' | 'failed' | 'waiting_approval' | 'needs_input' | 'denied';
  results: Record<string, ExecutionResult>;
  order: string[];
  outputs: ExecutionResult['outputs'];
  error?: string;
  usage: PlanExecutionUsage;
}

export interface PlanExecutionCheckpoint {
  results: Record<string, ExecutionResult>;
  order: string[];
  usage: PlanExecutionUsage;
  pendingStepId?: string;
  reason?: string;
}

export interface ExecutePlanOptions {
  dispatcher: CapabilityDispatcher;
  /** 每完成/阻塞一个步骤后落盘，用于 bot 重启后的严格断点恢复。 */
  onCheckpoint?: (checkpoint: PlanExecutionCheckpoint) => void;
  maxSteps?: number;
  maxParallelSteps?: number;
  maxDepth?: number;
  maxDurationMs?: number;
  maxCost?: number;
  maxModelRounds?: number;
  stepTimeoutMs?: number;
  loopDetection?: boolean;
  failurePolicy?: 'stop' | 'continue' | 'ask';
  initialResults?: Record<string, ExecutionResult>;
  approvedStepIds?: Set<string>;
  initialModelRounds?: number;
  /** 审批/追问恢复时传入原任务开始时间，避免每次恢复都重置总时长预算。 */
  startedAt?: number;
}

const COST_BY_CLASS: Record<string, number> = {
  free: 0,
  low: 0.25,
  medium: 1,
  high: 3,
};

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function lowerLimit(...values: Array<number | undefined>): number {
  const finite = values.map(finiteNumber).filter((value): value is number => value !== undefined && value >= 0);
  return finite.length ? Math.min(...finite) : Number.POSITIVE_INFINITY;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function settled(result: ExecutionResult | undefined): boolean {
  return result?.status === 'success' || result?.status === 'partial';
}

function dependencySatisfied(result: ExecutionResult | undefined): boolean {
  return result?.status === 'success';
}

function estimatedCost(step: IntentStep, capability?: CapabilityDescriptor): number {
  const explicit = finiteNumber(step.estimatedCost);
  if (explicit !== undefined && explicit >= 0) return explicit;
  const descriptorCost = finiteNumber(capability?.estimatedCost);
  if (descriptorCost !== undefined && descriptorCost >= 0) return descriptorCost;
  return COST_BY_CLASS[String(capability?.costClass || '')] ?? 0;
}

function estimatedModelRounds(step: IntentStep, capability?: CapabilityDescriptor): number {
  const explicit = finiteNumber(step.modelRounds);
  if (explicit !== undefined && explicit >= 0) return explicit;
  const descriptorRounds = finiteNumber(capability?.modelRounds);
  if (descriptorRounds !== undefined && descriptorRounds >= 0) return descriptorRounds;
  return capability?.provider === 'model' ? 1 : 0;
}

function completedCost(result: ExecutionResult, estimate: number): number {
  const actual = finiteNumber(result.cost);
  if (actual !== undefined && actual >= 0) return actual;
  return settled(result) ? estimate : 0;
}

function completedModelRounds(result: ExecutionResult, estimate: number): number {
  const actual = finiteNumber(result.modelRounds);
  if (actual !== undefined && actual >= 0) return actual;
  return settled(result) ? estimate : 0;
}

function buildLayers(plan: IntentPlan, order: string[]): string[][] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const completed = new Set<string>();
  const remaining = new Set(order);
  const layers: string[][] = [];
  while (remaining.size) {
    const layer = order.filter((id) => {
      if (!remaining.has(id)) return false;
      const step = byId.get(id);
      return (step?.dependsOn || []).every((dep) => completed.has(dep));
    });
    if (!layer.length) throw new Error('intent_plan_cycle_or_missing_dependency');
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return layers;
}

function planDepth(plan: IntentPlan): number {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error('intent_plan_cycle:' + id);
    visiting.add(id);
    const step = byId.get(id);
    const value = 1 + Math.max(0, ...(step?.dependsOn || []).map(depth));
    visiting.delete(id);
    memo.set(id, value);
    return value;
  }
  return Math.max(0, ...plan.steps.map((step) => depth(step.id)));
}

function failedResult(plan: IntentPlan, stepId: string, error: string, diagnostics?: Record<string, unknown>): ExecutionResult {
  return { jobId: plan.planId, stepId, status: 'failed', outputs: [], error, retryable: false, diagnostics };
}

async function withTimeout(
  task: Promise<DispatchResult>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<{ dispatched: DispatchResult | null; timedOut: boolean }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { dispatched: await task, timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ dispatched: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* abort callbacks must not throw */ }
      resolve({ dispatched: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
  });
  const finished = task.then((dispatched) => ({ dispatched, timedOut: false as const }));
  try {
    return await Promise.race([finished, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function evaluateStepCondition(
  condition: string | undefined,
  step: IntentStep,
  results: Record<string, ExecutionResult>,
): boolean {
  const expression = String(condition || '').trim();
  if (!expression || expression === 'always') return true;
  const deps = step.dependsOn || [];
  if (expression === 'previous_success') return deps.length > 0 && deps.every((id) => results[id]?.status === 'success');
  if (expression === 'previous_failed') return deps.some((id) => results[id] && results[id].status !== 'success');
  const match = expression.match(/^([A-Za-z0-9_-]+)\.(status|outputs(?:\.length)?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) return false;
  const stepId = match[1];
  const field = match[2];
  const operator = match[3];
  let expected: unknown = match[4].trim();
  if ((String(expected).startsWith('"') && String(expected).endsWith('"'))
    || (String(expected).startsWith("'") && String(expected).endsWith("'"))) {
    expected = String(expected).slice(1, -1);
  } else if (String(expected) === 'true' || String(expected) === 'false') {
    expected = String(expected) === 'true';
  } else if (Number.isFinite(Number(expected))) {
    expected = Number(expected);
  }
  const result = results[stepId];
  if (!result) return false;
  const actual: unknown = field === 'status' ? result.status : (result.outputs || []).length;
  if (operator === '==') return actual === expected;
  if (operator === '!=') return actual !== expected;
  const left = Number(actual);
  const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === '>') return left > right;
  if (operator === '>=') return left >= right;
  if (operator === '<') return left < right;
  return left <= right;
}

function skippedConditionResult(plan: IntentPlan, step: IntentStep): ExecutionResult {
  return {
    jobId: plan.planId,
    stepId: step.id,
    status: 'success',
    outputs: [],
    diagnostics: { skipped: true, reason: 'condition_false', condition: step.condition },
  };
}
async function dispatchStepWithPolicy(
  request: UserRequest,
  plan: IntentPlan,
  step: IntentStep,
  dependencyResults: Record<string, ExecutionResult>,
  options: ExecutePlanOptions,
  deadline: number,
): Promise<ExecutionResult> {
  const dispatcher = options.dispatcher;
  const capability = dispatcher.getCapability(step.capability);
  const configuredTimeout = finiteNumber(step.timeoutMs) ?? finiteNumber(capability?.timeoutMs) ?? finiteNumber(options.stepTimeoutMs);
  const maxRetries = Math.max(0, Math.trunc(finiteNumber(step.maxRetries) ?? finiteNumber(capability?.maxRetries) ?? 0));
  const seenErrors = new Set<string>();
  let lastResult: ExecutionResult | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return failedResult(plan, step.id, 'max_duration_exceeded', { attempts: attempt - 1, budget: 'maxDurationMs' });
    }
    const timeoutMs = configuredTimeout !== undefined && configuredTimeout > 0
      ? Math.min(configuredTimeout, remaining)
      : remaining;
    const controller = new AbortController();
    const { dispatched, timedOut } = await withTimeout(
      dispatcher.dispatch(request, plan, step, dependencyResults, {
        approvalGranted: options.approvedStepIds?.has(step.id),
        signal: controller.signal,
      }),
      timeoutMs,
      () => controller.abort(new Error('step_timeout')),
    );
    if (timedOut || !dispatched) {
      return failedResult(plan, step.id, 'step_timeout', {
        attempts: attempt,
        timeoutMs,
        budget: 'stepTimeout',
        retrySuppressed: 'timeout_may_have_side_effects',
      });
    }
    const result: ExecutionResult = {
      ...dispatched.result,
      diagnostics: { ...(dispatched.result.diagnostics || {}), attempts: attempt },
    };
    lastResult = result;
    if (result.status !== 'failed' || !result.retryable || attempt > maxRetries) return result;
    const fingerprint = String(result.error || 'unknown_failure');
    if (options.loopDetection !== false && seenErrors.has(fingerprint)) {
      return {
        ...result,
        diagnostics: { ...(result.diagnostics || {}), loopDetected: true, attempts: attempt },
      };
    }
    seenErrors.add(fingerprint);
  }
  return lastResult || failedResult(plan, step.id, 'step_not_executed');
}

export async function executeIntentPlan(
  request: UserRequest,
  plan: IntentPlan,
  options: ExecutePlanOptions,
): Promise<PlanExecutionResult> {
  const maxSteps = lowerLimit(options.maxSteps, plan.budget?.maxSteps);
  const validation = validateIntentPlan(plan, {
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : undefined,
  });
  if (!validation.ok) {
    return {
      status: 'failed', results: {}, order: [], outputs: [], error: validation.errors.join(','),
      usage: { stepsExecuted: 0, cost: 0, modelRounds: 0, durationMs: 0, maxParallelObserved: 0 },
    };
  }
  const order = topologicalStepOrder(plan);
  const depthLimit = lowerLimit(options.maxDepth, plan.budget?.maxDepth);
  if (Number.isFinite(depthLimit) && planDepth(plan) > depthLimit) {
    return {
      status: 'failed', results: {}, order, outputs: [], error: 'max_depth_exceeded',
      usage: { stepsExecuted: 0, cost: 0, modelRounds: 0, durationMs: 0, maxParallelObserved: 0 },
    };
  }

  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const results: Record<string, ExecutionResult> = { ...(options.initialResults || {}) };
  const startedAt = Number(options.startedAt) || Date.now();
  const maxDurationMs = lowerLimit(options.maxDurationMs, plan.budget?.maxDurationMs);
  const deadline = Number.isFinite(maxDurationMs) ? startedAt + maxDurationMs : Number.POSITIVE_INFINITY;
  const maxCost = lowerLimit(options.maxCost, plan.budget?.maxCost);
  const maxModelRounds = lowerLimit(options.maxModelRounds, plan.budget?.maxModelRounds);
  const maxParallel = positiveInt(lowerLimit(options.maxParallelSteps, plan.budget?.maxParallelSteps), 1);
  const failurePolicy = options.failurePolicy || 'stop';
  const loopDetection = options.loopDetection !== false;

  const usage: PlanExecutionUsage = {
    stepsExecuted: 0,
    cost: 0,
    modelRounds: Math.max(0, finiteNumber(options.initialModelRounds) || 0),
    durationMs: 0,
    maxParallelObserved: 0,
  };  const emitCheckpoint = (reason?: string): void => {
    try {
      const pendingStepId = order.find((id) => results[id]?.status === 'waiting_approval' || results[id]?.status === 'needs_input');
      options.onCheckpoint?.({
        results: { ...results },
        order: [...order],
        usage: { ...usage, durationMs: Date.now() - startedAt },
        pendingStepId,
        reason,
      });
    } catch { /* checkpoints must never break execution */ }
  };
  for (const id of order) {
    const result = results[id];
    if (!result || result.status === 'waiting_approval' || result.status === 'needs_input' || result.status === 'denied') continue;
    const step = byId.get(id);
    if (!step) continue;
    const capability = options.dispatcher.getCapability(step.capability);
    usage.stepsExecuted += 1;
    usage.cost += completedCost(result, estimatedCost(step, capability));
    usage.modelRounds += completedModelRounds(result, estimatedModelRounds(step, capability));
  }

  let haltReason: 'waiting_approval' | 'needs_input' | 'denied' | 'failed' | 'duration' | null = null;
  let anyFailure = false;
  let anySuccess = Object.values(results).some((result) => result?.status === 'success' || result?.status === 'partial');
  let sawPartial = Object.values(results).some((result) => result?.status === 'partial');
  let firstError: string | undefined = Object.values(results).find((result) => result?.error)?.error;

  const layers = buildLayers(plan, order);
  for (const layer of layers) {
    if (haltReason) break;
    if (Date.now() >= deadline) {
      haltReason = 'duration';
      break;
    }
    const preflightBlocked = new Set<string>();
    // 整层预检：先确认本层所有可执行步骤都已通过能力/参数/权限检查。
    // 任一步需要审批、追问或被拒绝时，同层兄弟步骤不会先产生副作用。
    for (const id of layer) {
      const step = byId.get(id);
      if (!step || settled(results[id])) continue;
      if ((step.dependsOn || []).some((dep) => !dependencySatisfied(results[dep]))) continue;
      if (!evaluateStepCondition(step.condition, step, results)) {
        results[id] = skippedConditionResult(plan, step);
        anySuccess = true;
        emitCheckpoint('condition_skipped');
        continue;
      }
      const authorization = options.dispatcher.authorize(request, plan, step, {
        approvalGranted: options.approvedStepIds?.has(id),
      });
      if (!authorization.result) continue;
      results[id] = authorization.result;
      const status = authorization.result.status;
      if (status === 'waiting_approval') {
        haltReason = 'waiting_approval';
        break;
      }
      if (status === 'needs_input') {
        haltReason = 'needs_input';
        break;
      }
      if (status === 'denied') {
        haltReason = 'denied';
        firstError ||= authorization.result.error;
        break;
      }
      if (status === 'failed') {
        preflightBlocked.add(id);
        anyFailure = true;
        if (authorization.result.error) firstError ||= authorization.result.error;
        if (failurePolicy === 'ask') {
          results[id] = {
            ...authorization.result,
            status: 'needs_input',
            diagnostics: {
              ...(authorization.result.diagnostics || {}),
              failurePolicy: 'ask',
              failureStage: 'preflight',
            },
          };
          haltReason = 'needs_input';
          break;
        }
        if (failurePolicy === 'stop') {
          haltReason = 'failed';
          break;
        }
      }
    }
    emitCheckpoint(haltReason || 'preflight_complete');
    if (haltReason) break;
    let nextIndex = 0;
    let activeWorkers = 0;
    let reservedCost = 0;
    let reservedRounds = 0;

    const workers = Array.from({ length: Math.max(1, Math.min(maxParallel, layer.length)) }, () => (async () => {
      while (true) {
        if (haltReason) return;
        const layerIndex = nextIndex;
        nextIndex += 1;
        if (layerIndex >= layer.length) return;
        const id = layer[layerIndex];
        const step = byId.get(id);
        if (!step || settled(results[id]) || preflightBlocked.has(id)) continue;

        if (Date.now() >= deadline) {
          results[id] = failedResult(plan, id, 'max_duration_exceeded', { budget: 'maxDurationMs' });
          anyFailure = true;
          firstError ||= 'max_duration_exceeded';
          haltReason = 'duration';
          emitCheckpoint('duration_exceeded');
          return;
        }

        const dependencyResults = Object.fromEntries((step.dependsOn || []).map((dep) => [dep, results[dep]]));
        if ((step.dependsOn || []).some((dep) => !dependencySatisfied(results[dep]))) {
          results[id] = failedResult(plan, id, 'dependency_failed');
          emitCheckpoint('dependency_failed');
          if (!step.optional) {
            anyFailure = true;
            firstError ||= 'dependency_failed';
            if (failurePolicy === 'stop') haltReason = 'failed';
          }
          continue;
        }

        if (!evaluateStepCondition(step.condition, step, results)) {
          results[id] = skippedConditionResult(plan, step);
          anySuccess = true;
          emitCheckpoint('condition_skipped');
          continue;
        }
        const capability = options.dispatcher.getCapability(step.capability);
        const estimate = estimatedCost(step, capability);
        const roundsEstimate = estimatedModelRounds(step, capability);
        if (usage.cost + reservedCost + estimate > maxCost + 1e-9) {
          results[id] = failedResult(plan, id, 'max_cost_exceeded', {
            budget: 'maxCost', estimatedCost: estimate, usedCost: usage.cost, reservedCost,
          });
          emitCheckpoint('max_cost_exceeded');
          anyFailure = true;
          firstError ||= 'max_cost_exceeded';
          if (failurePolicy === 'stop') haltReason = 'failed';
          continue;
        }
        if (usage.modelRounds + reservedRounds + roundsEstimate > maxModelRounds + 1e-9) {
          results[id] = failedResult(plan, id, 'max_model_rounds_exceeded', {
            budget: 'maxModelRounds', estimatedModelRounds: roundsEstimate, usedModelRounds: usage.modelRounds, reservedRounds,
          });
          emitCheckpoint('max_model_rounds_exceeded');
          anyFailure = true;
          firstError ||= 'max_model_rounds_exceeded';
          if (failurePolicy === 'stop') haltReason = 'failed';
          continue;
        }

        reservedCost += estimate;
        reservedRounds += roundsEstimate;
        activeWorkers += 1;
        usage.maxParallelObserved = Math.max(usage.maxParallelObserved, activeWorkers);
        try {
          const result = await dispatchStepWithPolicy(request, plan, step, dependencyResults, options, deadline);
          reservedCost -= estimate;
          reservedRounds -= roundsEstimate;
          const actualCost = completedCost(result, estimate);
          const actualRounds = completedModelRounds(result, roundsEstimate);
          usage.cost += actualCost;
          usage.modelRounds += actualRounds;
          usage.stepsExecuted += 1;
          results[id] = result;
          if (result.status === 'waiting_approval') haltReason = 'waiting_approval';
          else if (result.status === 'needs_input') haltReason = 'needs_input';
          else if (result.status === 'denied') haltReason = 'denied';
          else if (result.status === 'partial') {
            sawPartial = true;
            anySuccess = true;
            if (result.error) firstError ||= result.error;
          } else if (result.status === 'failed') {
              anyFailure = true;
              if (result.error) firstError ||= result.error;
              if (failurePolicy === 'ask') {
                results[id] = {
                  ...result,
                  status: 'needs_input',
                  diagnostics: {
                    ...(result.diagnostics || {}),
                    failurePolicy: 'ask',
                    failureStage: 'execution',
                  },
                };
                haltReason = 'needs_input';
              } else if (failurePolicy === 'stop') {
                haltReason = 'failed';
              }
            } else {
            anySuccess = true;
          }
          emitCheckpoint((haltReason as string) || 'step_complete');
        } catch (error) {
          reservedCost -= estimate;
          reservedRounds -= roundsEstimate;
          const message = String((error as Error)?.message || error);
          results[id] = failedResult(plan, id, message, { unexpected: true });
          emitCheckpoint('unexpected_error');
          anyFailure = true;
          firstError ||= message;
          if (failurePolicy === 'stop') haltReason = 'failed';
        } finally {
          activeWorkers -= 1;
        }
      }
    })());
    await Promise.all(workers);
    if (haltReason === 'waiting_approval' || haltReason === 'needs_input' || haltReason === 'denied' || haltReason === 'failed') break;
  }

  if (haltReason === 'duration') {
    for (const id of order) {
      if (settled(results[id])) continue;
      results[id] = failedResult(plan, id, 'max_duration_exceeded', { budget: 'maxDurationMs' });
      anyFailure = true;
      firstError ||= 'max_duration_exceeded';
    }
  }

  emitCheckpoint((haltReason as string) || 'plan_finished');
  const outputs = order.flatMap((id) => {
    const step = byId.get(id);
    const capability = step ? options.dispatcher.getCapability(step.capability) : undefined;
    const skipTts = capability?.ttsPolicy === 'skip';
    return (results[id]?.outputs || []).map((output) => ({
      ...output,
      meta: {
        ...(output.meta || {}),
        sourceStepId: output.meta?.sourceStepId || id,
        sourceCapability: output.meta?.sourceCapability || step?.capability,
        ...(skipTts ? { skipTts: true, disableVoice: true } : {}),
      },
    }));
  });
  usage.durationMs = Date.now() - startedAt;
  const base = { results, order, outputs, error: firstError, usage };
  if ((haltReason as string) === 'waiting_approval') return { ...base, status: 'waiting_approval', error: undefined };
  if ((haltReason as string) === 'needs_input') return { ...base, status: 'needs_input', error: undefined };
  if ((haltReason as string) === 'denied') return { ...base, status: 'denied' };
  if (anyFailure || sawPartial) {
    return { ...base, status: anySuccess ? 'partial' : 'failed' };
  }
  return { ...base, status: 'success', error: undefined };
}
