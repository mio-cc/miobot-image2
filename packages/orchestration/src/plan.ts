import type { CapabilityContextRequirement, CapabilityDescriptor, IntentPlan, UserRequest } from './types.js';

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

export interface PlanContextValidationResult {
  ok: boolean;
  errors: string[];
}

function initialContext(request: UserRequest): Set<CapabilityContextRequirement> {
  const available = new Set<CapabilityContextRequirement>();
  const attachments = Array.isArray(request.attachments) ? request.attachments : [];
  const kindOf = (item: Record<string, unknown>) => String(item.kind || item.type || item.mime || '').toLowerCase();
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    const kind = kindOf(item);
    if (kind.includes('image')) available.add('image');
    if (kind.includes('video')) available.add('video');
    if (kind.includes('file') || kind.includes('document')) available.add('file');
    if (kind.includes('url') || kind.includes('link')) available.add('url');
  }
  const reply = request.replyContext && typeof request.replyContext === 'object' ? request.replyContext : {};
  if (Object.keys(reply).length > 0) available.add('reply');
  if (Array.isArray(request.history) && request.history.length > 0) available.add('thread');
  const text = [request.text, JSON.stringify(reply)].join('\n');
  if (/https?:\/\/[^\s<>"']+/i.test(text)) available.add('url');
  return available;
}

/**
 * 校验计划执行前的客观上下文前置条件。
 * 这里只检查 requiredContext 和步骤产出，不判断用户意图，也不使用关键词路由。
 */
export interface PlanEffectAlignmentResult {
  ok: boolean;
  errors: string[];
}

/**
 * 程序化交叉校验模型自己声明的 desiredOutcome 与计划能力的 effect。
 * 只使用 effect 元数据，不读取用户关键词，也不替代模型理解。
 */
export function validatePlanEffectAlignment(plan: IntentPlan, capabilities: CapabilityDescriptor[]): PlanEffectAlignmentResult {
  const desired = plan.understanding?.desiredOutcome || 'unknown';
  if (desired === 'unknown') return { ok: true, errors: [] };
  const byId = new Map(capabilities.map((item) => [item.id, item]));
  const effects = plan.steps.map((step) => byId.get(step.capability)?.effect || 'unknown');
  const has = (effect: string) => effects.includes(effect as any);
  const sideEffects = effects.filter((effect) => ['generate', 'transform', 'mutate', 'delete', 'control', 'notify'].includes(String(effect)));
  const errors: string[] = [];
  if (desired === 'answer' || desired === 'retrieve') {
    if (sideEffects.length) errors.push(`desired_${desired}_has_side_effect:${sideEffects.join(',')}`);
    if (desired === 'retrieve' && !has('retrieve')) errors.push('desired_retrieve_has_no_retrieve_step');
  } else if (desired === 'generate') {
    if (!has('generate')) errors.push('desired_generate_has_no_generate_step');
    if (has('delete') || has('control')) errors.push('desired_generate_has_destructive_step');
  } else if (desired === 'transform') {
    if (!has('transform')) errors.push('desired_transform_has_no_transform_step');
    if (has('delete') || has('control')) errors.push('desired_transform_has_destructive_step');
  } else if (desired === 'mutate') {
    if (!has('mutate')) errors.push('desired_mutate_has_no_mutate_step');
    if (has('delete') || has('control')) errors.push('desired_mutate_has_destructive_step');
  } else if (desired === 'delete') {
    if (!has('delete')) errors.push('desired_delete_has_no_delete_step');
    if (has('generate') || has('transform') || has('mutate') || has('control')) errors.push('desired_delete_has_conflicting_step');
  } else if (desired === 'control') {
    if (!has('control')) errors.push('desired_control_has_no_control_step');
    if (has('generate') || has('transform') || has('mutate') || has('delete')) errors.push('desired_control_has_conflicting_step');
  } else if (desired === 'notify') {
    if (!has('notify')) errors.push('desired_notify_has_no_notify_step');
  }
  return { ok: errors.length === 0, errors };
}
export function validatePlanContext(
  plan: IntentPlan,
  capabilities: CapabilityDescriptor[],
  request: UserRequest,
): PlanContextValidationResult {
  const byId = new Map(capabilities.map((item) => [item.id, item]));
  const available = initialContext(request);
  const errors: string[] = [];
  let order: string[];
  try { order = topologicalStepOrder(plan); } catch { return { ok: false, errors: ['invalid_plan_dag'] }; }
  const byStepId = new Map(plan.steps.map((step) => [step.id, step]));
  for (const stepId of order) {
    const step = byStepId.get(stepId);
    if (!step) continue;
    const capability = byId.get(step.capability);
    for (const requirement of capability?.requiredContext || []) {
      if (!available.has(requirement)) errors.push(`missing_required_context:${step.id}:${requirement}`);
    }
    for (const outputKind of capability?.outputKinds || []) {
      if (outputKind === 'image' || outputKind === 'file' || outputKind === 'video') available.add(outputKind);
      if (outputKind === 'link') available.add('url');
    }
  }
  return { ok: errors.length === 0, errors };
}
export function validateIntentPlan(
  plan: IntentPlan,
  options: { maxSteps?: number } = {},
): PlanValidationResult {
  const errors: string[] = [];
  if (!plan.planId) errors.push('planId_required');
  if (!plan.requestId) errors.push('requestId_required');
  const canClarify = Boolean(plan.needsClarification && String(plan.clarificationQuestion || '').trim());
  if (!Array.isArray(plan.steps) || (plan.steps.length === 0 && !canClarify)) errors.push('steps_required');
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
