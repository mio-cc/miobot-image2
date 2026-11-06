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
  if (values.context && !template.includes('{{context}}')) rendered += '\n\n追问上下文/可选项：' + values.context;
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
    '先判断当前计划是否已经有一个明确的具体任务；只有该任务缺少执行所需的关键参数时，才生成一个问题。',
    '不要把普通聊天、情绪表达、吐槽、玩笑、拒绝或敷衍自动解释成功能请求，也不要生成能力问卷。',
    '严禁向用户列举或暗示能力、功能类型或具体功能名；不要把问题写成你是想 A 还是 B。',
    '如果用户只是在聊天或结束话题，应该让正常 chat 回应，不要在这里强行追问；必须追问时只问当前任务缺失的那一个具体信息，并引用当前话题。',
    '只输出 JSON：{"question":"向用户提出的问题","missingInformation":["模型理解到的缺失信息"]}。',
    '',
    '用户请求：' + request.text,
    '附件：' + JSON.stringify(request.attachments || []),
    '回复上下文：' + JSON.stringify(request.replyContext || {}),
    '历史上下文：' + JSON.stringify(request.history || []),
    '当前计划：' + JSON.stringify(plan),
    '结构化问题：' + JSON.stringify(issues),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, {
    request: request.text,
    plan: JSON.stringify(plan),
    issues: JSON.stringify(issues),
  });
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You generate one contextual clarification question only when a concrete task is missing one concrete parameter. Never enumerate capabilities or turn casual chat into a capability questionnaire. Never expose internal codes. Output only one JSON object.',
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
    '追问只能针对当前计划缺少的一个具体参数，不得列举能力或把普通聊天变成功能问卷。',
    '只使用能力清单中的 id。需要多步时输出最小必要步骤和依赖关系。只输出完整 IntentPlan JSON。',
    '',
    '用户请求：' + request.text,
    '附件：' + JSON.stringify(request.attachments || []),
    '回复上下文：' + JSON.stringify(request.replyContext || {}),
    '历史上下文：' + JSON.stringify(request.history || []),
    '当前计划：' + JSON.stringify(plan),
    '结构化问题：' + JSON.stringify(issues),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, {
    request: request.text,
    plan: JSON.stringify(plan),
    issues: JSON.stringify(issues),
  });
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You repair plans or ask one contextual clarification question only for a concrete missing parameter. Never enumerate capabilities or turn casual chat into a task questionnaire. Never expose internal codes. Output only one IntentPlan JSON object.',
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

/**
 * 追问回答合并器：把用户对唯一一次追问的回答合并进当前计划。
 * 信息不足或回答是闲聊/拒绝时返回 resolved=false（不清空原 pending 之外的任何状态）。
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
    context?: string;
  },
): Promise<RoleCallResult<IntentPlan | undefined>> {
  const fallbackPrompt = [
    '你是追问回答合并器。把用户对唯一一次追问的回答合并进当前 IntentPlan。',
    '不要重新理解成一个全新任务；必须保留当前计划中已经明确的步骤、依赖和参数。',
    '不得再次提出任何问题。信息仍然不足时输出 resolved=false。',
    '如果用户回答是情绪、拒绝、敷衍或普通聊天，不要把它解释成新的能力任务；信息不足时直接 resolved=false。',
    '只能使用能力目录中的 capability id。',
    '输出严格 JSON：{"resolved":true,"plan":{完整 IntentPlan}} 或 {"resolved":false,"reason":"原因"}。',
    '',
    '原始请求：' + String(options.originalText || request.text),
    '唯一追问：' + options.question,
    '追问上下文/可选项：' + String(options.context || ''),
    '用户回答：' + options.answer,
    '当前计划：' + JSON.stringify(plan || null),
  ].join('\n');
  const prompt = renderConfiguredRolePrompt(options, fallbackPrompt, { request: request.text, plan: JSON.stringify(plan || null), question: options.question, answer: options.answer, context: String(options.context || '') });
  try {
    const text = await callRole(client, { ...options, temperature: 0 }, roleMessages(
      'You merge one clarification answer into an existing plan. Never reinterpret a refusal, joke or casual chat as a new capability task. Never enumerate capabilities or feature examples. Never ask another question. Output only one JSON object.',
      prompt,
    ));
    const json = extractJsonObject(text);
    if (!json) throw new Error('clarification_no_json');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.resolved === false) return { value: undefined, rounds: 1, fallback: false, error: 'clarification_unresolved:' + String(parsed.reason || 'user_did_not_resolve') };
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
