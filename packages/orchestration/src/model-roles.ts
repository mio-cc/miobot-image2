import type { CapabilityDescriptor, ExecutionOutput, IntentPlan, UserRequest } from './types.js';
import { extractJsonObject, parseIntentPlan, type PlannerChatMessage, type PlannerModel } from './planner.js';
import { buildCapabilityManifest } from './capability-manifest.js';

export interface RoleCallOptions {
  nodeIndex: number;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  promptTemplate?: string;
  maxTokens?: number;
}

export interface RoleCallResult<T> {
  value: T;
  rounds: number;
  fallback: boolean;
  error?: string;
}

function compactCatalog(capabilities: CapabilityDescriptor[]): unknown[] {
  return buildCapabilityManifest(capabilities).capabilities;
}
function roleMessages(system: string, user: string): PlannerChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function renderConfiguredRolePrompt(options: RoleCallOptions, fallbackPrompt: string, values: Record<string, string>): string {
  const template = String(options.promptTemplate || '').trim();
  if (!template) return fallbackPrompt;
  let rendered = template;
  for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll('{{' + key + '}}', () => value);
  if (values.request && !template.includes('{{request}}')) rendered += '\n\n用户请求：' + values.request;
  if (values.catalog && !template.includes('{{catalog}}')) rendered += '\n\n能力目录：' + values.catalog;
  if (values.plan && !template.includes('{{plan}}')) rendered += '\n\n当前计划：' + values.plan;
  if (values.outputs && !template.includes('{{outputs}}')) rendered += '\n\n执行结果：' + values.outputs;
  if (values.question && !template.includes('{{question}}')) rendered += '\n\n追问：' + values.question;
  if (values.answer && !template.includes('{{answer}}')) rendered += '\n\n用户回答：' + values.answer;
  if (values.issues && !template.includes('{{issues}}')) rendered += '\n\n结构化问题：' + values.issues;
  return rendered;
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
  const fallbackPrompt = [
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
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, { request: request.text, catalog: JSON.stringify(compactCatalog(enabled)) });
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
export interface PlanAlignmentReview {
  aligned: boolean;
  reason: string;
  suggestedCapabilities?: string[];
  requiresClarification?: boolean;
}

/**
 * 通用意图-行动一致性复核。
 * 不针对具体话题或关键词，只比较用户期望的结果类型与计划能力的 effect/副作用。
 */
export async function verifyPlanAlignmentWithModel(
  client: PlannerModel,
  request: UserRequest,
  plan: IntentPlan,
  catalog: CapabilityDescriptor[],
  options: RoleCallOptions,
): Promise<RoleCallResult<PlanAlignmentReview>> {
  const fallbackPrompt = [
    '你是 Miobot 的意图-行动一致性复核器。',
    '你的任务不是猜关键词，而是比较用户真正想要的结果与计划步骤的实际 effect 和副作用。',
    '能力目录里每个能力都有 effect：answer/retrieve/generate/transform/mutate/delete/notify/control/unknown。',
    '如果用户目标是获得答案或获取信息，计划中的 generate/transform/mutate/delete/control/notify 步骤必须能从用户明确请求中得到直接理由，否则视为不一致。',
    '同一个话题可以被回答、检索、生成、修改或删除，主题词本身不能证明副作用合理。',
    '如果计划不一致，给出能完成用户目标的最小 suggestedCapabilities；如果仍无法判断，requiresClarification=true。',
    'suggestedCapabilities 只能使用能力目录中的 id，并且按 effect 与用户期望结果的匹配来选择。',
    '只输出 JSON：{"aligned":true|false,"reason":"简短原因","suggestedCapabilities":["id"],"requiresClarification":false}。',
    '',
    '用户请求：' + request.text,
    '附件：' + JSON.stringify(request.attachments || []),
    '当前计划：' + JSON.stringify(plan),
    '能力清单：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, { request: request.text, plan: JSON.stringify(plan), catalog: JSON.stringify(compactCatalog(catalog)) });
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You are a strict intent-to-effect alignment verifier. Never route by topic words. Output only one JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('plan_alignment_no_json');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.aligned !== 'boolean') throw new Error('plan_alignment_bad_result');
    const enabled = catalog.filter((item) => item.enabled);
    const byId = new Map(enabled.map((item) => [item.id, item]));
    const suggested = Array.isArray(parsed.suggestedCapabilities)
      ? parsed.suggestedCapabilities.map(String).filter((id) => byId.has(id)).slice(0, 8)
      : [];
    return {
      value: {
        aligned: parsed.aligned,
        reason: String(parsed.reason || '意图-行动一致性复核'),
        suggestedCapabilities: suggested,
        requiresClarification: Boolean(parsed.requiresClarification),
      },
      rounds: 1,
      fallback: false,
    };
  } catch (error) {
    return {
      value: { aligned: true, reason: '一致性复核失败，保留原计划' },
      rounds: 1,
      fallback: true,
      error: String((error as Error)?.message || error),
    };
  }
}
export async function replanWithAlignmentFeedbackWithModel(
  client: PlannerModel,
  request: UserRequest,
  catalog: CapabilityDescriptor[],
  priorPlan: IntentPlan,
  review: PlanAlignmentReview,
  options: RoleCallOptions & { maxSteps?: number },
): Promise<RoleCallResult<IntentPlan>> {
  const fallbackPrompt = [
    '你是 Miobot 的通用计划修复器。上一个计划与用户期望的结果或副作用不一致，请重新生成最小、正确的 IntentPlan。',
    '不要保留错误能力，不要按主题关键词选择能力。按用户期望的 answer/retrieve/generate/transform/mutate/delete/control 结果和目录 effect 匹配。',
    '需要用户选择或交互的能力，只规划到产生候选的那一步，不要在同一计划里自动执行后续选择。',
    '不能确定时返回 needsClarification=true。只使用能力目录中的 id。',
    '只输出完整 IntentPlan JSON，不要 Markdown 或解释。',
    '',
    '用户请求：' + request.text,
    '附件：' + JSON.stringify(request.attachments || []),
    '原计划：' + JSON.stringify(priorPlan),
    '复核原因：' + review.reason,
    '建议能力：' + JSON.stringify(review.suggestedCapabilities || []),
    '能力清单：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, {
    request: request.text,
    catalog: JSON.stringify(compactCatalog(catalog)),
    plan: JSON.stringify(priorPlan),
  });
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You repair misaligned plans by matching requested effects. Output only one IntentPlan JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('alignment_replan_no_json');
    const plan = parseIntentPlan(json, request, { maxSteps: options.maxSteps });
    return { value: plan, rounds: 1, fallback: false };
  } catch (error) {
    return { value: priorPlan, rounds: 1, fallback: true, error: String((error as Error)?.message || error) };
  }
}

export interface ModelPlanIssue {
  code: string;
  stepId?: string;
  capability?: string;
  requirement?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ClarificationGeneration {
  question: string;
  missingInformation: string[];
}

/**
 * 结构化校验结果只作为事实反馈给模型；用户看到的具体追问由模型生成。
 */
export async function generateClarificationWithModel(
  client: PlannerModel,
  request: UserRequest,
  plan: IntentPlan,
  catalog: CapabilityDescriptor[],
  issues: ModelPlanIssue[],
  options: RoleCallOptions,
): Promise<RoleCallResult<ClarificationGeneration>> {
  const fallbackPrompt = [
    '你是 Miobot 的对话追问生成器。',
    '当前计划缺少继续执行所需的信息。请结合用户原话、上下文、附件、计划和能力清单，生成一句自然、具体、单一的问题。',
    '不要使用固定模板；不要提到内部错误码、字段名、schema、validation issue 或实现细节。',
    '问题必须使用用户当前语言，尽量引用当前话题、对象或上下文。如果存在多个可能目标，可以在问题中给出少量具体方向。',
    '只输出 JSON：{"question":"向用户提出的问题","missingInformation":["模型理解到的缺失信息"]}。',
    '',
    '用户请求：' + request.text,
    '附件：' + JSON.stringify(request.attachments || []),
    '回复上下文：' + JSON.stringify(request.replyContext || {}),
    '历史上下文：' + JSON.stringify(request.history || []),
    '当前计划：' + JSON.stringify(plan),
    '结构化问题：' + JSON.stringify(issues),
    '能力清单：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, {
    request: request.text,
    plan: JSON.stringify(plan),
    catalog: JSON.stringify(compactCatalog(catalog)),
    issues: JSON.stringify(issues),
  });
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You generate one contextual clarification question. Never expose internal error codes. Output only one JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('clarification_no_json');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const question = String(parsed.question || '').trim();
    if (!question) throw new Error('clarification_question_empty');
    return {
      value: {
        question,
        missingInformation: Array.isArray(parsed.missingInformation) ? parsed.missingInformation.map(String).map((item) => item.trim()).filter(Boolean) : [],
      },
      rounds: 1,
      fallback: false,
    };
  } catch (error) {
    return {
      value: { question: '', missingInformation: [] },
      rounds: 1,
      fallback: true,
      error: String((error as Error)?.message || error),
    };
  }
}

/**
 * 规划修复轮。模型可以修复计划，也可以生成追问；不复制内部校验错误给用户。
 */
export async function repairPlanWithValidationFeedbackWithModel(
  client: PlannerModel,
  request: UserRequest,
  plan: IntentPlan,
  catalog: CapabilityDescriptor[],
  issues: ModelPlanIssue[],
  options: RoleCallOptions & { maxSteps?: number },
): Promise<RoleCallResult<IntentPlan>> {
  const fallbackPrompt = [
    '你是 Miobot 的计划修复器。确定性系统发现了当前计划的结构化问题；这些问题是事实约束，不是用户话术模板。',
    '请结合用户原话、上下文、附件、能力和计划，自主决定：',
    '1. 如果能从已有上下文或能力清单中修复计划，输出一个可执行 IntentPlan。',
    '2. 如果必须让用户补充信息或做出选择，输出 needsClarification=true，并生成一句自然、具体、单一的问题。',
    '追问由你根据用户当前语境生成，不要复制 issue.code、requirement、schema 或内部错误文本。',
    '只使用能力清单中的 id。需要多步时输出最小必要步骤和依赖关系。只输出完整 IntentPlan JSON。',
    '',
    '用户请求：' + request.text,
    '附件：' + JSON.stringify(request.attachments || []),
    '回复上下文：' + JSON.stringify(request.replyContext || {}),
    '历史上下文：' + JSON.stringify(request.history || []),
    '当前计划：' + JSON.stringify(plan),
    '结构化问题：' + JSON.stringify(issues),
    '能力清单：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, {
    request: request.text,
    plan: JSON.stringify(plan),
    catalog: JSON.stringify(compactCatalog(catalog)),
    issues: JSON.stringify(issues),
  });
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You repair plans or ask one contextual clarification question. Never expose internal codes. Output only one IntentPlan JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('plan_repair_no_json');
    const repaired = parseIntentPlan(json, request, { maxSteps: options.maxSteps });
    return { value: repaired, rounds: 1, fallback: false };
  } catch (error) {
    return { value: plan, rounds: 1, fallback: true, error: String((error as Error)?.message || error) };
  }
}
export async function refinePlanWithModel(
  client: PlannerModel,
  request: UserRequest,
  plan: IntentPlan,
  catalog: CapabilityDescriptor[],
  options: RoleCallOptions & { role: 'specialist' | 'critic' },
): Promise<RoleCallResult<IntentPlan>> {
  const fallbackPrompt = [
    '你是 ' + options.role + ' 角色，只审查和修正已有 IntentPlan，不执行工具。',
    '必须保留真实 requestId，输出完整 IntentPlan JSON；不要输出权限结论或 Markdown。',
    '只能使用能力目录中的 capability id。若无法安全修正，保持原计划不变。',
    '',
    '用户请求：' + request.text,
    '当前计划：' + JSON.stringify(plan),
    '能力清单：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, { request: request.text, plan: JSON.stringify(plan), catalog: JSON.stringify(compactCatalog(catalog)) });
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
  const fallbackPrompt = [
    '你是安全与风险预判器。只提供风险建议，不决定权限，不执行工具。',
    '只输出 JSON：{"riskLevel":"low|medium|high|critical","reason":"简短原因"}。',
    '',
    '用户请求：' + request.text,
    '计划：' + JSON.stringify(plan),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, { request: request.text, plan: JSON.stringify(plan) });
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
  const fallbackPrompt = [
    '你是结果编排器。根据用户请求和执行结果，生成一段简洁中文结果摘要。',
    '不要编造结果，不要提到权限、审批、trace 或内部实现。只输出摘要文本。',
    '',
    '用户请求：' + request.text,
    '执行结果：' + JSON.stringify(compactOutputs),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, { request: request.text, outputs: JSON.stringify(compactOutputs) });
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
  const fallbackPrompt = [
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
    '能力清单：' + JSON.stringify(compactCatalog(catalog)),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, { request: request.text, plan: JSON.stringify(plan || null), catalog: JSON.stringify(compactCatalog(catalog)), question: options.question, answer: options.answer });
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
