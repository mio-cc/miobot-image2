import type { CapabilityDescriptor, IntentPlan, PlanUnderstanding, UserRequest } from './types.js';
import { validateIntentPlan } from './plan.js';

export interface PlannerChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlannerModel {
  chat(
    nodeIndex: number,
    request: {
      model: string;
      messages: PlannerChatMessage[];
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      /** T3.2：FC 通道——tools/tool_choice 透传给底层模型客户端。 */
      tools?: unknown[];
      toolChoice?: unknown;
    },
  ): Promise<{ text: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }>;
}

export function extractJsonObject(text: string): string | null {
  const value = String(text || '').trim();
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null;
}

export function parseIntentPlan(text: string, request: UserRequest, options: { maxSteps?: number } = {}): IntentPlan {
  const json = extractJsonObject(text);
  if (!json) throw new Error('planner_no_json');
  let raw: any;
    try { raw = JSON.parse(json); } catch { const preview = json.replace(/\s+/g, '').slice(0, 300); throw new Error(`planner_invalid_json:chars=${json.length}:preview=${preview}`); }
  return normalizeIntentPlanObject(raw, request, options);
}

/**
 * T3.2：把“计划原始对象”规范化为 IntentPlan——JSON 通道（parseIntentPlan）与
 * FC 通道（tool_calls.arguments）共用，保证两通道产出等价计划。
 */
export function normalizeIntentPlanObject(raw: any, request: UserRequest, options: { maxSteps?: number } = {}): IntentPlan {
  const validEffects = new Set(['answer', 'retrieve', 'generate', 'transform', 'mutate', 'delete', 'notify', 'control', 'unknown']);
  const rawUnderstanding = raw.understanding && typeof raw.understanding === 'object' ? raw.understanding : {};
  const desiredOutcome = validEffects.has(String(rawUnderstanding.desiredOutcome || ''))
    ? String(rawUnderstanding.desiredOutcome)
    : 'unknown';
  const understanding: PlanUnderstanding | undefined = raw.understanding && typeof raw.understanding === 'object' ? {
    goal: String(rawUnderstanding.goal || raw.goal || ''),
    desiredOutcome: desiredOutcome as PlanUnderstanding['desiredOutcome'],
    constraints: Array.isArray(rawUnderstanding.constraints) ? rawUnderstanding.constraints.map(String).map((item: string) => item.trim()).filter(Boolean) : [],
    missingInformation: Array.isArray(rawUnderstanding.missingInformation) ? rawUnderstanding.missingInformation.map(String).map((item: string) => item.trim()).filter(Boolean) : [],
    confidence: Number.isFinite(Number(rawUnderstanding.confidence)) ? Math.max(0, Math.min(1, Number(rawUnderstanding.confidence))) : 0,
  } : undefined;
  const plan: IntentPlan = {
    planId: String(raw.planId || `plan_${Date.now()}`),
    requestId: request.requestId,
    goal: String(raw.goal || understanding?.goal || ''),
    understanding,
    language: raw.language ? String(raw.language) : undefined,
    // A（规划即回答）：捕获模型附带的直接回复文本（仅单步 chat.reply 场景由提示词约束）。
    directReply: typeof raw.directReply === 'string' && raw.directReply.trim() ? raw.directReply.trim() : undefined,
    steps: Array.isArray(raw.steps) ? raw.steps.map((step: any, index: number) => ({
      id: String(step.id || `step${index + 1}`),
      capability: String(step.capability || ''),
      args: step.args && typeof step.args === 'object' ? step.args : {},
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
      optional: Boolean(step.optional),
      condition: step.condition ? String(step.condition) : undefined,
      approvalRequired: Boolean(step.approvalRequired),
      iterate: Boolean(step.iterate),
    })) : [],
    budget: raw.budget && typeof raw.budget === 'object' ? raw.budget : undefined,
    needsClarification: Boolean(raw.needsClarification),
    clarificationQuestion: raw.clarificationQuestion ? String(raw.clarificationQuestion) : undefined,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : (understanding?.confidence || 0),
    source: 'model',
  };
  const validation = validateIntentPlan(plan, { maxSteps: options.maxSteps });
  if (!validation.ok) throw new Error(`planner_invalid_plan:${validation.errors.join(',')}`);
  return plan;
}
/** T3.2：FC 通道的唯一工具——模型调用 submit_plan 提交整份计划（与 JSON 通道同一规范化/校验）。 */
const SUBMIT_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'submit_plan',
    description: '提交任务执行计划。不要输出任何文本，直接调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '任务目标' },
        directReply: { type: 'string', description: '仅当计划为单个 chat.reply 且无需工具时：直接给出的完整回复文本（跳过第二次模型调用）' },
        understanding: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            desiredOutcome: { type: 'string', description: 'answer/retrieve/generate/transform/mutate/notify/control' },
            constraints: { type: 'array', items: { type: 'string' } },
            missingInformation: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'number' },
          },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              capability: { type: 'string', description: '必须来自 capabilityManifest' },
              args: { type: 'object' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              optional: { type: 'boolean' },
              iterate: { type: 'boolean' },
            },
            required: ['id', 'capability', 'args'],
          },
        },
        confidence: { type: 'number' },
      },
      required: ['goal', 'steps'],
    },
  },
};
