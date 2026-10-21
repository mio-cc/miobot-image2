import type { CapabilityDescriptor, IntentPlan, UserRequest } from './types.js';
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
    },
  ): Promise<{ text: string }>;
}

export interface PlannerOptions {
  nodeIndex: number;
  model: string;
  capabilityCatalog: CapabilityDescriptor[];
  maxRepairAttempts?: number;
  maxModelRounds?: number;
  systemPrompt?: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export function buildPlannerPrompt(request: UserRequest, capabilities: CapabilityDescriptor[]): string {
  const catalog = capabilities.filter((item) => item.enabled).map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description || '',
    inputSchema: item.inputSchema || {},
    outputKinds: item.outputKinds || [],
    riskLevel: item.riskLevel || 'medium',
    approvalRequired: Boolean(item.approvalRequired),
    mode: item.mode || 'sync',
  }));
  return [
    '你是 Miobot 的意图理解与任务规划器。',
    '根据用户自然语言、上下文、附件引用和能力目录，输出一个严格 JSON 的 IntentPlan。',
    '不要用固定关键词做判断；要理解同义表达、比例、方向、引用、隐含需求和上下文。',
    '用户明确给出的约束优先；无法确定的参数不要编造，必要时输出 needsClarification。',
    '只输出 JSON object，不要 Markdown、代码块、解释或工具调用。',
    '步骤必须使用能力目录中的 id；多步骤使用 dependsOn 表示依赖关系。',
    '不要输出 workflow、节点 ID、执行器内部参数或权限结论。',
    '交互式能力先返回候选或问题，需要用户选择的能力不要在同一个计划里自动串联。',
    '',
    `用户请求：${request.text}`,
    `用户角色：${request.user.role}`,
    `聊天类型：${request.chat.type}`,
    `附件引用：${JSON.stringify(request.attachments || [])}`,
    `回复上下文：${JSON.stringify(request.replyContext || {})}`,
    `群聊/历史上下文：${JSON.stringify(request.history || [])}`,
    '',
    '可用能力目录：',
    JSON.stringify(catalog),
    '',
    '输出结构示例：',
    JSON.stringify({
      planId: 'plan_x',
      requestId: request.requestId,
      goal: '用户的真实目标',
      steps: [{ id: 'step1', capability: 'image.generate', args: {}, dependsOn: [] }],
      budget: { maxSteps: 20 },
      needsClarification: false,
      confidence: 0.9,
    }),
  ].join('\n');
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
  try { raw = JSON.parse(json); } catch { throw new Error('planner_invalid_json'); }
  const plan: IntentPlan = {
    planId: String(raw.planId || `plan_${Date.now()}`),
    requestId: request.requestId,
    goal: String(raw.goal || ''),
    language: raw.language ? String(raw.language) : undefined,
    steps: Array.isArray(raw.steps) ? raw.steps.map((step: any, index: number) => ({
      id: String(step.id || `step${index + 1}`),
      capability: String(step.capability || ''),
      args: step.args && typeof step.args === 'object' ? step.args : {},
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
      optional: Boolean(step.optional),
      condition: step.condition ? String(step.condition) : undefined,
      approvalRequired: Boolean(step.approvalRequired),
    })) : [],
    budget: raw.budget && typeof raw.budget === 'object' ? raw.budget : undefined,
    needsClarification: Boolean(raw.needsClarification),
    clarificationQuestion: raw.clarificationQuestion ? String(raw.clarificationQuestion) : undefined,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
    source: 'model',
  };
  const validation = validateIntentPlan(plan, { maxSteps: options.maxSteps });
  if (!validation.ok) throw new Error(`planner_invalid_plan:${validation.errors.join(',')}`);
  return plan;
}

export async function planWithModel(
  client: PlannerModel,
  request: UserRequest,
  options: PlannerOptions,
): Promise<IntentPlan> {
  const messages: PlannerChatMessage[] = [
    { role: 'system', content: String(options.systemPrompt || '').trim() || 'You are a strict JSON planner. Never use keyword matching. Output only one JSON object.' },
    { role: 'user', content: buildPlannerPrompt(request, options.capabilityCatalog) },
  ];
  const requestedAttempts = Math.max(0, Math.trunc(Number(options.maxRepairAttempts) || 0)) + 1;
  const configuredRounds = Math.trunc(Number(options.maxModelRounds));
  const maxModelRounds = Number.isFinite(configuredRounds) && configuredRounds > 0 ? configuredRounds : Number.POSITIVE_INFINITY;
  const maxAttempts = Math.min(requestedAttempts, maxModelRounds);
  let modelRoundsUsed = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    modelRoundsUsed += 1;
    const result = await client.chat(options.nodeIndex, {
      model: options.model,
      messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
    });
    try {
      const plan = parseIntentPlan(result.text, request, { maxSteps: options.maxSteps });
      return { ...plan, modelRoundsUsed };
    } catch (error) {
      lastError = error;
      messages.push({ role: 'assistant', content: result.text });
      messages.push({ role: 'user', content: `上一次输出不合法：${String((error as Error)?.message || error)}。请只输出符合 schema 的完整 JSON。` });
    }
  }
  throw new Error(`planner_failed:${String((lastError as Error)?.message || lastError)}`);
}
