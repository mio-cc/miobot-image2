import type { IntentPlan } from './types.js';

export interface PlanValidationResult {
  ok: boolean;
  errors: string[];
  order: string[];
}

export function topologicalStepOrder(plan: IntentPlan): string[] {
  const steps = plan.steps || [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`intent_plan_cycle:${id}`);
    const step = byId.get(id);
    if (!step) throw new Error(`intent_plan_missing_step:${id}`);
    visiting.add(id);
    for (const dep of step.dependsOn || []) visit(dep);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const step of steps) visit(step.id);
  return order;
}

export function validateIntentPlan(
  plan: IntentPlan,
  options: { maxSteps?: number } = {},
): PlanValidationResult {
  const errors: string[] = [];
  if (!plan.planId) errors.push('planId_required');
  if (!plan.requestId) errors.push('requestId_required');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) errors.push('steps_required');
  const maxSteps = Math.max(1, Math.trunc(Number(options.maxSteps) || 1000));
  if (plan.steps.length > maxSteps) errors.push(`too_many_steps:${plan.steps.length}>${maxSteps}`);
  const ids = new Set<string>();
  for (const step of plan.steps || []) {
    if (!step.id) errors.push('step_id_required');
    if (ids.has(step.id)) errors.push(`duplicate_step:${step.id}`);
    ids.add(step.id);
    if (!step.capability) errors.push(`capability_required:${step.id}`);
    for (const dep of step.dependsOn || []) {
      if (!ids.has(dep) && !plan.steps.some((candidate) => candidate.id === dep)) {
        errors.push(`missing_dependency:${step.id}->${dep}`);
      }
    }
  }
  let order: string[] = [];
  if (!errors.length) {
    try {
      order = topologicalStepOrder(plan);
    } catch (error) {
      errors.push(String((error as Error)?.message || error));
    }
  }
  return { ok: errors.length === 0, errors, order };
}
