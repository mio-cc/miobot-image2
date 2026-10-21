import type { AppConfig } from '../../../packages/config/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import {
  builtinCapabilityDescriptors,
  createDefaultPermissionPolicy,
  planWithModel,
  resolvePermission,
  type UserRequest,
} from '../../../packages/orchestration/src/index.js';

export interface ShadowOrchestrationInput {
  config: AppConfig;
  client: ModelClient;
  logger?: StructuredLogger;
  request: UserRequest;
  text: string;
  chatType: 'group' | 'private';
  groupId?: string | number;
  userId?: string | number;
  images?: string[];
  referencedText?: string;
  groupContext?: string;
}

export async function runShadowOrchestration(input: ShadowOrchestrationInput): Promise<void> {
  const config = input.config;
  const orch = config.orchestration;
  if (!orch?.enabled) return;
  const role = String(input.userId || '') && (config.bot.ownerQQs || []).map(String).includes(String(input.userId)) ? 'owner'
    : (orch.approval.adminQqIds || []).map(String).includes(String(input.userId)) ? 'admin' : 'user';
  const request: UserRequest = {
    requestId: `shadow_${Date.now()}`,
    chat: {
      type: input.chatType,
      groupId: input.groupId === undefined ? undefined : String(input.groupId),
      userId: input.userId === undefined ? undefined : String(input.userId),
    },
    user: { qq: String(input.userId || ''), role },
    text: input.text,
    attachments: (input.images || []).map((image) => ({ kind: 'image', ref: image })),
    replyContext: input.referencedText ? { text: input.referencedText } : undefined,
    history: input.groupContext ? [{ role: 'system', content: input.groupContext }] : undefined,
    receivedAt: new Date().toISOString(),
  };
  const catalog = builtinCapabilityDescriptors();
  const plannerNode = Number(orch.planner.nodeIndex ?? config.freeMode.nodeIndex ?? 0);
  const plannerModel = String(orch.planner.model || config.freeMode.model || config.llm.chatModel || '');
  const plan = await planWithModel({
    chat: (nodeIndex, req) => input.client.chat(nodeIndex, {
      model: req.model,
      messages: req.messages,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      timeoutMs: req.timeoutMs,
    }),
  }, request, {
    nodeIndex: plannerNode,
    model: plannerModel,
    capabilityCatalog: catalog,
    maxRepairAttempts: orch.planner.maxRepairAttempts,
    maxSteps: orch.execution.maxSteps,
  });
  const policy = createDefaultPermissionPolicy(`shadow-${orch.planner.promptVersion || 'v1'}`);
  const decisions = plan.steps.map((step) => {
    const capability = catalog.find((item) => item.id === step.capability);
    const decision = resolvePermission({
      capability: step.capability,
      provider: capability?.provider,
      riskLevel: capability?.riskLevel || 'medium',
      user: request.user,
      chat: request.chat,
      params: step.args,
    }, policy);
    return { step: step.id, capability: step.capability, decision: decision.decision, reason: decision.reason };
  });
  input.logger?.info('智能编排影子计划', {
    mode: orch.mode,
    requestId: request.requestId,
    goal: plan.goal,
    steps: plan.steps.map((step) => ({ id: step.id, capability: step.capability, dependsOn: step.dependsOn || [] })),
    confidence: plan.confidence,
    decisions,
    textPreview: input.text.slice(0, 160),
  });
  if (orch.mode === 'enforce') {
    input.logger?.warn('智能编排 enforce 已开启，但 shadow 适配器不会直接执行；请接入 Dispatcher', { requestId: request.requestId });
  }
}
