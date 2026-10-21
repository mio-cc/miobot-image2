import type { CapabilityDescriptor, ExecutionOutput, IntentPlan, UserRequest } from './types.js';
import { extractJsonObject, parseIntentPlan, type PlannerChatMessage, type PlannerModel } from './planner.js';

export interface RoleCallOptions {
  nodeIndex: number;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface RoleCallResult<T> {
  value: T;
  rounds: number;
  fallback: boolean;
  error?: string;
}

function compactCatalog(capabilities: CapabilityDescriptor[]): unknown[] {
  return capabilities.filter((item) => item.enabled).map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description || '',
    provider: item.provider,
    riskLevel: item.riskLevel || 'medium',
    inputSchema: item.inputSchema || {},
    outputKinds: item.outputKinds || [],
  }));
}

function roleMessages(system: string, user: string): PlannerChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function callRole(client: PlannerModel, options: RoleCallOptions, messages: PlannerChatMessage[]): Promise<string> {
  const result = await client.chat(options.nodeIndex, {
    model: options.model,
    messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs,
  });
  return String(result.text || '');
}

/**
 * retriever 只负责按语义选择候选能力，不执行能力，也不做关键词路由。
 * 模型失败时降级为完整启用能力目录，避免因候选检索失败阻断主链路。
 */
export async function retrieveCapabilitiesWithModel(
  client: PlannerModel,
  request: UserRequest,
  catalog: CapabilityDescriptor[],
  options: RoleCallOptions & { topK?: number },
): Promise<RoleCallResult<CapabilityDescriptor[]>> {
  const enabled = catalog.filter((item) => item.enabled);
  const topK = Math.max(1, Math.trunc(Number(options.topK) || 12));
  if (enabled.length <= topK) return { value: enabled, rounds: 0, fallback: false };
  const prompt = [
    '你是能力检索器。根据用户请求和附件语义，从能力目录中选出最相关的 TopK 能力。',
    '不要使用关键词匹配，不要执行能力，不要输出权限判断。',
    '交互式能力必须保留在候选中；用户在多轮选择时不要只返回搜索或上游能力。',
    '只输出 JSON：{"capabilityIds":["id1","id2"]}。',
    '',
    '用户请求：' + request.text,
    '附件：' + JSON.stringify(request.attachments || []),
    '',
    '能力目录：',
    JSON.stringify(compactCatalog(enabled)),
  ].join('\n');
  try {
    const text = await callRole(client, { ...options, maxTokens: Math.min(options.maxTokens || 800, 1200), temperature: 0 }, roleMessages(
      'You are a strict semantic capability retriever. Output only one JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('retriever_no_json');
    const parsed = JSON.parse(json) as { capabilityIds?: unknown; ids?: unknown };
    const ids = Array.isArray(parsed.capabilityIds) ? parsed.capabilityIds.map(String)
      : Array.isArray(parsed.ids) ? parsed.ids.map(String) : [];
    const byId = new Map(enabled.map((item) => [item.id, item]));
    const selected = Array.from(new Set(ids)).map((id) => byId.get(id)).filter((item): item is CapabilityDescriptor => Boolean(item)).slice(0, topK);
    if (!selected.length) throw new Error('retriever_empty_selection');
    return { value: selected, rounds: 1, fallback: false };
  } catch (error) {
    return { value: enabled, rounds: 1, fallback: true, error: String((error as Error)?.message || error) };
  }
}
export async function refinePlanWithModel(
  client: PlannerModel,
  request: UserRequest,
  plan: IntentPlan,
  catalog: CapabilityDescriptor[],
  options: RoleCallOptions & { role: 'specialist' | 'critic' },
): Promise<RoleCallResult<IntentPlan>> {
  const prompt = [
    '你是 ' + options.role + ' 角色，只审查和修正已有 IntentPlan，不执行工具。',
    '必须保留真实 requestId，输出完整 IntentPlan JSON；不要输出权限结论或 Markdown。',
    '只能使用能力目录中的 capability id。若无法安全修正，保持原计划不变。',
    '',
    '用户请求：' + request.text,
    '当前计划：' + JSON.stringify(plan),
    '能力目录：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You are a strict JSON plan reviewer. Never execute tools. Output only one JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('reviewer_no_json');
    const reviewed = parseIntentPlan(json, request, { maxSteps: plan.budget?.maxSteps });
    return { value: reviewed, rounds: 1, fallback: false };
  } catch (error) {
    return { value: plan, rounds: 1, fallback: true, error: String((error as Error)?.message || error) };
  }
}

export interface SafetyReview {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

export async function assessPlanSafetyWithModel(
  client: PlannerModel,
  request: UserRequest,
  plan: IntentPlan,
  options: RoleCallOptions,
): Promise<RoleCallResult<SafetyReview>> {
  const prompt = [
    '你是安全与风险预判器。只提供风险建议，不决定权限，不执行工具。',
    '只输出 JSON：{"riskLevel":"low|medium|high|critical","reason":"简短原因"}。',
    '',
    '用户请求：' + request.text,
    '计划：' + JSON.stringify(plan),
  ].join('\n');
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You are a strict safety reviewer. Output only one JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('safety_no_json');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const risk = String(parsed.riskLevel || parsed.risk || '').toLowerCase();
    if (!['low', 'medium', 'high', 'critical'].includes(risk)) throw new Error('safety_bad_risk');
    return {
      value: { riskLevel: risk as SafetyReview['riskLevel'], reason: String(parsed.reason || '模型风险预判') },
      rounds: 1,
      fallback: false,
    };
  } catch (error) {
    return { value: { riskLevel: 'medium', reason: '安全预判失败，按中风险处理' }, rounds: 1, fallback: true, error: String((error as Error)?.message || error) };
  }
}

export async function composeResultTextWithModel(
  client: PlannerModel,
  request: UserRequest,
  outputs: ExecutionOutput[],
  options: RoleCallOptions,
): Promise<RoleCallResult<string | undefined>> {
  const compactOutputs = outputs.map((output) => ({
    kind: output.kind,
    text: output.text,
    url: output.url,
    meta: output.meta,
  }));
  const prompt = [
    '你是结果编排器。根据用户请求和执行结果，生成一段简洁中文结果摘要。',
    '不要编造结果，不要提到权限、审批、trace 或内部实现。只输出摘要文本。',
    '',
    '用户请求：' + request.text,
    '执行结果：' + JSON.stringify(compactOutputs),
  ].join('\n');
  try {
    const text = (await callRole(client, { ...options, temperature: 0.2 }, roleMessages(
      'You compose final user-facing summaries. Never invent results.',
      prompt,
    ))).trim();
    return { value: text || undefined, rounds: 1, fallback: false };
  } catch (error) {
    return { value: undefined, rounds: 1, fallback: true, error: String((error as Error)?.message || error) };
  }
}
/**
 * 一次追问后的计划合并器。
 * 它只负责把用户补答合并进已有 DAG，不允许再次发起追问。
 */
export async function resolveClarificationWithModel(
  client: PlannerModel,
  request: UserRequest,
  plan: IntentPlan | undefined,
  catalog: CapabilityDescriptor[],
  options: RoleCallOptions & {
    question: string;
    answer: string;
    originalText?: string;
    maxSteps?: number;
  },
): Promise<RoleCallResult<IntentPlan | undefined>> {
  const prompt = [
    '你是追问回答合并器。把用户对唯一一次追问的回答合并进当前 IntentPlan。',
    '不要重新理解成一个全新任务；必须保留当前计划中已经明确的步骤、依赖和参数。',
    '不得再次提出任何问题。信息仍然不足时输出 resolved=false。',
    '只能使用能力目录中的 capability id。',
    '输出严格 JSON：{"resolved":true,"plan":{完整 IntentPlan}} 或 {"resolved":false,"reason":"原因"}。',
    '',
    '原始请求：' + String(options.originalText || request.text),
    '唯一追问：' + options.question,
    '用户回答：' + options.answer,
    '当前计划：' + JSON.stringify(plan || null),
    '能力目录：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You merge one clarification answer into an existing plan. Never ask another question. Output only one JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('clarification_no_json');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.resolved === false) return { value: undefined, rounds: 1, fallback: false, error: String(parsed.reason || 'clarification_unresolved') };
    const planCandidate = parsed.plan && typeof parsed.plan === 'object'
      ? parsed.plan
      : (parsed.planId || parsed.steps ? parsed : undefined);
    if (!planCandidate) throw new Error('clarification_no_plan');
    const merged = parseIntentPlan(JSON.stringify(planCandidate), request, { maxSteps: options.maxSteps });
    if (merged.needsClarification) return { value: undefined, rounds: 1, fallback: false, error: 'clarification_repeated_question_forbidden' };
    return { value: { ...merged, needsClarification: false, clarificationQuestion: undefined }, rounds: 1, fallback: false };
  } catch (error) {
    return { value: undefined, rounds: 1, fallback: true, error: String((error as Error)?.message || error) };
  }
}