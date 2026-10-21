import type { AppConfig } from '../../../packages/config/src/index.js';
import type { BotApp } from './app.js';
import type { BotEngineResult, BotEngineInput } from '../../../packages/bot-engine/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import {
  applyCapabilityOverrides,
  applyRuntimeCapabilityGates,
  builtinCapabilityDescriptors,
  CapabilityDispatcher,
  CapabilityRegistry,
  createPermissionPolicyFromDefaults,
  buildReplyPlan,
  executeIntentPlan,
  hashApprovalPayload,
  planWithModel,
  selectConfiguredPromptVersion,
  retrieveCapabilitiesWithModel,
  refinePlanWithModel,
  assessPlanSafetyWithModel,
  composeResultTextWithModel,
  resolveClarificationWithModel,
  validateIntentPlan,
  type CapabilityHandler,
  type IntentPlan,
  type IntentStep,
  type ExecutionOutput,
  type ReplyPlan,
  type UserRequest,
  type OrchestrationTrace,
} from '../../../packages/orchestration/src/index.js';
import { LegacyEngineCapabilityHandler, type LegacyCapabilityKind } from './capability-legacy.js';
import { VoiceCurrentCapabilityHandler, VoicePreviewCapabilityHandler, VoiceSearchCapabilityHandler, VoiceSelectCapabilityHandler, type FishAudioVoiceService } from './voice-service.js';
import { SunoPromptComposer } from './suno-composer.js';
import { SunoCapabilityHandler } from './capability-suno.js';
import { HelpCapabilityHandler, ModelCatalogCapabilityHandler, PromptCapabilityHandler, SearchCapabilityHandler, TemplateListCapabilityHandler, TtsCapabilityHandler } from './capability-basic.js';
import type { ApprovalRuntime } from './approval-runtime.js';
import type { PendingJobRecord, PendingJobStore } from './pending-job-store.js';

export interface EnforceOrchestrationInput {
  text: string;
  chatType: 'group' | 'private';
  groupId?: string | number;
  userId?: string | number;
  images?: string[];
  files?: Array<Record<string, unknown>>;
  referencedText?: string;
  groupContext?: string;
  memoryContext?: string;
  sessionId?: string;
  plan?: IntentPlan;
}

export interface CapabilityTestInput {
  capability: string;
  mode: 'validate' | 'dry_run' | 'live';
  args?: Record<string, unknown>;
  requesterQq?: string;
  chatType?: 'group' | 'private';
  groupId?: string;
  allowLive?: boolean;
}

export interface CapabilityTestResult {
  ok: boolean;
  capability: string;
  mode: 'validate' | 'dry_run' | 'live';
  stage: 'validate' | 'authorize' | 'execute' | 'complete';
  durationMs: number;
  handlerRegistered: boolean;
  permission?: unknown;
  validation?: { ok: boolean; issues?: unknown; question?: unknown };
  result?: { status: string; outputs: unknown[]; error?: string };
  error?: string;
}
export interface EnforceOrchestrationResult {
  handled: boolean;
  result?: BotEngineResult;
  reason?: string;
  problem?: { kind: string; error: string };
}

const LEGACY_KINDS: LegacyCapabilityKind[] = ['chat.reply', 'image.generate', 'image.edit', 'image.interrogate', 'video.generate'];

export class OrchestrationEnforcer {
  private readonly registry = new CapabilityRegistry();
  private readonly dispatcher: CapabilityDispatcher;
  private configFingerprint = '';

  constructor(private readonly options: {
    getConfig: () => AppConfig;
    app: BotApp;
    client: ModelClient;
    approvalRuntime?: ApprovalRuntime;
    pendingJobs?: PendingJobStore;
    voiceService?: FishAudioVoiceService;
    logger?: StructuredLogger;
    trace?: (trace: OrchestrationTrace) => void;
    handlers?: Map<string, CapabilityHandler>;
  }) {
    this.dispatcher = new CapabilityDispatcher(this.registry, createPermissionPolicyFromDefaults({
      low: 'allow', medium: 'allow', high: 'ask_admin', critical: 'ask_admin',
    }));
    this.refreshConfig(this.options.getConfig());
    for (const kind of LEGACY_KINDS) {
      const handler = this.options.handlers?.get(kind) || new LegacyEngineCapabilityHandler(this.options.app, kind);
      this.dispatcher.registerHandler(kind, handler);
    }
    const sunoComposer = new SunoPromptComposer(this.options.client, this.options.getConfig, this.options.logger);
    const suno = this.options.handlers?.get('audio.music.generate') || new SunoCapabilityHandler({ getConfig: this.options.getConfig, logger: this.options.logger, compose: (args, request) => sunoComposer.compose(args, request) });
    this.dispatcher.registerHandler('audio.music.generate', suno);
    this.dispatcher.registerHandler('web.search', new SearchCapabilityHandler(this.options.app));
    this.dispatcher.registerHandler('prompt.enhance', new PromptCapabilityHandler(this.options.client, this.options.getConfig, 'enhance'));
    this.dispatcher.registerHandler('prompt.translate', new PromptCapabilityHandler(this.options.client, this.options.getConfig, 'translate'));
    this.dispatcher.registerHandler('template.list', new TemplateListCapabilityHandler(this.options.getConfig));
    this.dispatcher.registerHandler('template.use', new LegacyEngineCapabilityHandler(this.options.app, 'image.generate'));
    this.dispatcher.registerHandler('tts.speak', new TtsCapabilityHandler(this.options.getConfig, this.options.logger));
    this.dispatcher.registerHandler('help', new HelpCapabilityHandler());
    this.dispatcher.registerHandler('model.catalog.list', new ModelCatalogCapabilityHandler(this.options.getConfig));
    if (this.options.voiceService) {
      this.dispatcher.registerHandler('voice.search', new VoiceSearchCapabilityHandler(this.options.voiceService));
      this.dispatcher.registerHandler('voice.preview', new VoicePreviewCapabilityHandler(this.options.voiceService));
      this.dispatcher.registerHandler('voice.select', new VoiceSelectCapabilityHandler(this.options.voiceService));
      this.dispatcher.registerHandler('voice.current', new VoiceCurrentCapabilityHandler(this.options.voiceService));
    }
    this.dispatcher.registerHandler('session.clear', {
      execute: async (invocation) => {
        const sessionId = invocation.request.chat.type === 'group'
          ? 'group:' + String(invocation.request.chat.groupId ?? '') + ':' + invocation.request.user.qq
          : 'private:' + invocation.request.user.qq;
        this.options.app.sessions?.clear?.(sessionId);
        return {
          jobId: invocation.plan.planId,
          stepId: invocation.step.id,
          status: 'success',
          outputs: [{ kind: 'text', text: '已开启新对话，之前的上下文已清除。', priority: 10, mergeable: true }],
        };
      },
    });

    for (const [id, handler] of this.options.handlers || []) this.dispatcher.registerHandler(id, handler);
  }

  async testCapability(input: CapabilityTestInput): Promise<CapabilityTestResult> {
    const startedAt = Date.now();
    const cfg = this.options.getConfig();
    this.refreshConfig(cfg);
    const capabilityId = String(input.capability || '').trim();
    const mode = input.mode === 'live' || input.mode === 'dry_run' ? input.mode : 'validate';
    const descriptor = this.registry.get(capabilityId);
    const handlerRegistered = this.dispatcher.hasHandler(capabilityId);
    if (!descriptor || !descriptor.enabled) {
      return {
        ok: false, capability: capabilityId, mode, stage: 'validate', durationMs: Date.now() - startedAt,
        handlerRegistered, error: descriptor ? 'capability_disabled' : 'capability_not_found',
      };
    }
    const userId = String(input.requesterQq || cfg.bot.ownerQQs[0] || '0');
    const role = (cfg.bot.ownerQQs || []).map(String).includes(userId) ? 'owner'
      : (cfg.orchestration.approval.adminQqIds || []).map(String).includes(userId) ? 'admin' : 'user';
    const request: UserRequest = {
      requestId: `cap_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      chat: {
        type: input.chatType === 'group' ? 'group' : 'private',
        groupId: input.chatType === 'group' ? String(input.groupId || '0') : undefined,
        userId,
      },
      user: { qq: userId, role },
      text: 'capability test',
      receivedAt: new Date().toISOString(),
    };
    const plan: IntentPlan = {
      planId: `cap_test_plan_${Date.now()}`,
      requestId: request.requestId,
      goal: 'capability test',
      steps: [{ id: 'test', capability: capabilityId, args: input.args || {} }],
      confidence: 1,
      source: 'model',
    };
    const step = plan.steps[0];
    const authorization = this.dispatcher.authorize(request, plan, step);
    const validation = authorization.validationWarnings
      ? { ok: true, issues: authorization.result?.diagnostics?.validationIssues, question: authorization.result?.diagnostics?.question }
      : { ok: !authorization.result || authorization.result.status !== 'needs_input', issues: authorization.result?.diagnostics?.validationIssues, question: authorization.result?.diagnostics?.question };
    if (!handlerRegistered) {
      return {
        ok: false, capability: capabilityId, mode, stage: 'validate', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation, error: 'capability_handler_missing',
      };
    }
    if (!validation.ok || authorization.result?.status === 'failed') {
      return {
        ok: false, capability: capabilityId, mode, stage: 'validate', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation, error: authorization.result?.error || 'capability_validation_failed',
      };
    }
    if (mode === 'validate') {
      return {
        ok: true, capability: capabilityId, mode, stage: 'validate', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation,
      };
    }
    if (mode === 'dry_run') {
      return {
        ok: authorization.result?.status !== 'denied',
        capability: capabilityId, mode, stage: 'authorize', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation,
        result: { status: authorization.result?.status || 'ready', outputs: [], error: authorization.result?.error },
        error: authorization.result?.status === 'denied' ? authorization.result.error : undefined,
      };
    }
    if (input.allowLive !== true) {
      return {
        ok: false, capability: capabilityId, mode, stage: 'authorize', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation, error: 'live_confirmation_required',
      };
    }
    if (authorization.result?.status === 'waiting_approval' || authorization.result?.status === 'denied') {
      return {
        ok: false, capability: capabilityId, mode, stage: 'authorize', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation,
        error: authorization.result.status === 'denied' ? authorization.result.error || 'permission_denied' : 'approval_required_live_test',
      };
    }
    const timeoutMs = Math.max(1000, Number(descriptor.timeoutMs || 120000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const dispatched = await Promise.race([
        this.dispatcher.dispatch(request, plan, step),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('capability_test_timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const outputs = (dispatched.result.outputs || []).slice(0, 20).map((output) => ({
        kind: output.kind,
        text: output.text ? output.text.slice(0, 500) : undefined,
        url: output.url,
        size: output.size,
        meta: output.meta,
      }));
      return {
        ok: dispatched.result.status === 'success' || dispatched.result.status === 'partial',
        capability: capabilityId, mode, stage: 'complete', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation,
        result: { status: dispatched.result.status, outputs, error: dispatched.result.error },
        error: dispatched.result.status === 'failed' || dispatched.result.status === 'denied' ? dispatched.result.error : undefined,
      };
    } catch (error) {
      return {
        ok: false, capability: capabilityId, mode, stage: 'complete', durationMs: Date.now() - startedAt,
        handlerRegistered, permission: authorization.permission, validation, error: String((error as Error)?.message || error),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private refreshConfig(cfg: AppConfig): void {
    const fingerprint = JSON.stringify({
      overrides: cfg.orchestration.capabilityOverrides,
      permissions: cfg.orchestration.permissions,
      sunoEnabled: cfg.orchestration.suno.enabled,
      externalProviders: cfg.orchestration.externalProviders,
    });
    if (fingerprint === this.configFingerprint) return;
    const descriptors = applyCapabilityOverrides(builtinCapabilityDescriptors(), cfg.orchestration.capabilityOverrides);
    this.registry.replaceAll(applyRuntimeCapabilityGates(descriptors, { sunoEnabled: Boolean(cfg.orchestration.suno.enabled), externalEnabled: Boolean(cfg.orchestration.externalProviders?.enabled), allowlist: cfg.orchestration.externalProviders?.allowlist || [] }));
    const defaults = cfg.orchestration.permissions;
    this.dispatcher.setPermissionPolicy(createPermissionPolicyFromDefaults({
      low: defaults.defaultLow,
      medium: defaults.defaultMedium,
      high: defaults.defaultHigh,
      critical: defaults.defaultCritical,
      hardDenyEnabled: defaults.hardDenyEnabled,
      hardDenyCapabilities: defaults.hardDenyCapabilities,
      rules: defaults.rules,
    }));
    this.configFingerprint = fingerprint;
  }

  private roleOptions(cfg: AppConfig, role: 'planner' | 'retriever' | 'specialist' | 'critic' | 'safety' | 'composer') {
    const selected = cfg.orchestration.roles[role];
    const fallbackNode = Number(selected.fallbackNodeIndex ?? cfg.orchestration.planner.nodeIndex ?? cfg.freeMode.nodeIndex ?? 0);
    const fallbackModel = String(selected.fallbackModel || selected.model || cfg.orchestration.planner.model || cfg.freeMode.model || cfg.llm.chatModel || '');
    return {
      nodeIndex: Number(selected.nodeIndex ?? cfg.orchestration.planner.nodeIndex ?? cfg.freeMode.nodeIndex ?? 0),
      model: String(selected.model || cfg.orchestration.planner.model || cfg.freeMode.model || cfg.llm.chatModel || ''),
      timeoutMs: Number(selected.timeoutMs ?? cfg.orchestration.planner.clarificationTimeoutMs ?? 60000),
      temperature: selected.temperature,
      maxTokens: selected.maxTokens,
      fallbackNodeIndex: fallbackNode,
      fallbackModel,
    };
  }

  private roleModelClient() {
    return {
      chat: (nodeIndex: number, req: any) => this.options.client.chat(nodeIndex, {
        model: req.model,
        messages: req.messages,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        timeoutMs: req.timeoutMs,
      }),
    };
  }
  private async runRoleWithFallback<T>(
    options: ReturnType<OrchestrationEnforcer['roleOptions']>,
    runner: (options: any) => Promise<{ value: T; rounds: number; fallback: boolean; error?: string }>,
  ): Promise<{ value: T; rounds: number; fallback: boolean; error?: string }> {
    let result = await runner(options);
    let rounds = result.rounds;
    if (result.fallback && options.fallbackModel && (options.fallbackModel !== options.model || options.fallbackNodeIndex !== options.nodeIndex)) {
      const fallback = await runner({
        ...options,
        nodeIndex: options.fallbackNodeIndex,
        model: options.fallbackModel,
      });
      rounds += fallback.rounds;
      result = fallback;
    }
    return { ...result, rounds };
  }
  async handle(input: EnforceOrchestrationInput): Promise<EnforceOrchestrationResult> {
    const cfg = this.options.getConfig();
    if (!cfg.orchestration?.enabled || cfg.orchestration.mode !== 'enforce') {
      return { handled: false, reason: 'orchestration_disabled' };
    }
    this.refreshConfig(cfg);
    const text = String(input.text || '').trim();
    if (!text && !input.plan) return { handled: false, reason: 'empty_text' };
    const userId = String(input.userId || '');
    const pendingKey = input.chatType === 'group'
      ? `group:${input.groupId ?? ''}:${userId}`
      : `private:${userId}`;
    const pending = input.plan ? undefined : this.options.pendingJobs?.get(pendingKey);
    if (input.plan) this.options.pendingJobs?.delete(pendingKey);
    const role = (cfg.bot.ownerQQs || []).map(String).includes(userId) ? 'owner'
      : (cfg.orchestration.approval.adminQqIds || []).map(String).includes(userId) ? 'admin' : 'user';
    const requestId = pending?.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const jobId = pending?.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const originalText = pending?.originalText || text;
    const effectiveText = pending
      ? `${originalText}\n用户补充信息：${text}`
      : text;
    const incomingHistory = [input.memoryContext, input.groupContext]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join('\n\n');
    const baseRequest = pending?.originalRequest;
    const request: UserRequest = baseRequest ? {
      ...baseRequest,
      requestId,
      chat: {
        type: input.chatType,
        groupId: input.groupId === undefined ? undefined : String(input.groupId),
        userId: input.userId === undefined ? undefined : String(input.userId),
      },
      user: { ...baseRequest.user, qq: userId, role },
      text: effectiveText,
      attachments: [
        ...(baseRequest.attachments || []),
        ...(input.images || []).map((image) => ({ kind: 'image', ref: image })),
        ...(input.files || []).map((file) => ({ kind: 'file', ...file })),
      ],
      replyContext: input.referencedText ? { text: input.referencedText } : baseRequest.replyContext,
      history: incomingHistory
        ? [{ role: 'system', content: incomingHistory }, ...(baseRequest.history || []).filter((item) => item.role !== 'system')]
        : baseRequest.history,
      receivedAt: new Date().toISOString(),
    } : {
      requestId,
      chat: {
        type: input.chatType,
        groupId: input.groupId === undefined ? undefined : String(input.groupId),
        userId: input.userId === undefined ? undefined : String(input.userId),
      },
      user: { qq: userId, role },
      text: effectiveText,
      attachments: [
        ...(input.images || []).map((image) => ({ kind: 'image', ref: image })),
        ...(input.files || []).map((file) => ({ kind: 'file', ...file })),
      ],
      replyContext: input.referencedText ? { text: input.referencedText } : undefined,
      history: incomingHistory ? [{ role: 'system', content: incomingHistory }] : undefined,
      receivedAt: new Date().toISOString(),
    };
    const clarificationCount = Math.max(0, Math.trunc(Number(pending?.clarificationCount ?? pending?.attempts ?? 0)));
    const jobStartedAt = Number(pending?.startedAt) || Date.now();
    let resumePlan = pending?.plan;
    let resumeResults: Record<string, any> = pending?.results ? { ...pending.results } : {};
    const resumeApprovedStepIds = new Set<string>(pending?.approvedStepIds || []);
    let resumePendingStepId = pending?.pendingStepId;
    let resumedFromJob = false;

    // 审批通过后的恢复不依赖原进程 waiter；这里用持久化 Job + 审批终态重建执行上下文。
    if (pending?.status === 'waiting_approval') {
      const approval = pending.approvalId ? this.options.approvalRuntime?.getBroker().get(pending.approvalId) : undefined;
      if (!approval) {
        this.options.pendingJobs?.delete(pendingKey);
        return { handled: true, result: this.messageEngineResult('审批记录不存在，本次任务已取消。') };
      }
      if (approval.status === 'pending') {
        return { handled: true, result: this.messageEngineResult('任务仍在等待管理员审批，请稍候。') };
      }
      if (approval.status === 'approved') {
        if (!resumePlan) {
          this.options.pendingJobs?.delete(pendingKey);
          return this.approvalFailureResult('审批已通过，但任务 DAG 快照丢失，未执行。', 'approval_plan_lost', 'approval_plan_missing');
        }
        if (resumePendingStepId && approval.stepId && resumePendingStepId !== approval.stepId) {
          this.options.pendingJobs?.delete(pendingKey);
          return this.approvalFailureResult('审批绑定的步骤与任务快照不一致，未执行。', 'approval_step_mismatch', 'approval_step_mismatch');
        }
        const expectedHash = pending.approvalPayloadHash || approval.payloadHash;
        const approvedStep = resumePendingStepId ? resumePlan.steps.find((step) => step.id === resumePendingStepId) : undefined;
        if (approval.payloadHash !== expectedHash || (approvedStep && hashApprovalPayload(approvedStep.args) !== approval.payloadHash)) {
          this.options.pendingJobs?.delete(pendingKey);
          return this.approvalFailureResult('审批参数已变化，原审批失效，任务未执行。', 'approval_payload_changed', 'approval_payload_hash_changed');
        }
        if (resumePendingStepId) {
          delete resumeResults[resumePendingStepId];
          resumeApprovedStepIds.add(resumePendingStepId);
        }
        resumedFromJob = true;
      } else {
        this.options.pendingJobs?.delete(pendingKey);
        const fallback = cfg.orchestration.approval.fallback;
        const message = approval.status === 'rejected'
          ? '管理员已拒绝该操作。'
          : approval.status === 'cancelled'
            ? '该操作已取消。'
            : fallback === 'cancel' ? '审批超时，任务已取消。' : '审批超时，任务已拒绝。';
        return this.approvalFailureResult(message, approval.status === 'rejected' ? 'approval_rejected' : (fallback === 'cancel' || approval.status === 'cancelled' ? 'approval_timeout_cancelled' : 'approval_timeout_denied'), String(approval.status));
      }
    } else if (pending?.status === 'running' && pending.plan) {
      resumedFromJob = true;
    } else if (pending?.status === 'clarifying' && pending.plan === undefined) {
      // Planner 阶段还没有 DAG；仍保留原 requestId/jobId，后面交给 ClarificationResolver。
    }
    const appendTrace = (stage: OrchestrationTrace['stage'], summary: string, data?: Record<string, unknown>) => {
      this.options.trace?.({
        id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(), requestId: request.requestId, stage, summary, data,
      });
    };
    appendTrace('request', '收到编排请求', { text: request.text.slice(0, 200), role, jobId, resumedFromJob, historyChars: String(request.history?.[0]?.content || '').length });
    if (!input.plan && !pending && !cfg.orchestration.planner.enabled) return { handled: false, reason: 'planner_disabled' };

    const modelAdapter = this.roleModelClient();
    let roleRoundsUsed = 0;
    let plan: IntentPlan;

    try {
      if (input.plan) {
        plan = input.plan;
      } else if (resumedFromJob && resumePlan) {
        plan = resumePlan;
        appendTrace('plan', '从 Job checkpoint 恢复计划', { jobId, status: pending?.status, completedSteps: Object.keys(resumeResults) });
      } else if (pending?.status === 'clarifying') {
        const question = pending.pendingQuestion || pending.question;
        const resolved = await this.runRoleWithFallback(this.roleOptions(cfg, 'planner'), (opts) => resolveClarificationWithModel(
          modelAdapter,
          request,
          pending.plan,
          this.registry.list(),
          {
            ...opts,
            question,
            answer: text,
            originalText,
            maxSteps: cfg.orchestration.execution.maxSteps,
          },
        ));
        roleRoundsUsed += resolved.rounds;
        if (!resolved.value) {
          this.options.pendingJobs?.delete(pendingKey);
          appendTrace('plan', '追问回答仍无法合并', { jobId, error: resolved.error });
          return { handled: true, result: this.messageEngineResult('信息仍然不足，已停止本次任务。') };
        }
        plan = { ...resolved.value, modelRoundsUsed: roleRoundsUsed };
        resumePlan = plan;
        resumedFromJob = true;
        appendTrace('plan', '追问回答已合并到原计划', { jobId, fallback: resolved.fallback, error: resolved.error });
      } else {
        const maxModelRounds = Math.max(1, Number(cfg.orchestration.execution.maxModelRounds || 1));
        let catalog = this.registry.list();
        const retriever = cfg.orchestration.roles.retriever;
        if (retriever.enabled && maxModelRounds - roleRoundsUsed > 1) {
          const retrieved = await this.runRoleWithFallback(this.roleOptions(cfg, 'retriever'), (opts) => retrieveCapabilitiesWithModel(modelAdapter, request, catalog, { ...opts, topK: cfg.orchestration.planner.capabilityTopK }));
          roleRoundsUsed += retrieved.rounds;
          if (!retrieved.fallback) catalog = retrieved.value;
          appendTrace('plan', 'retriever 完成', { fallback: retrieved.fallback, capabilityCount: catalog.length, error: retrieved.error });
        }
        const promptVersion = selectConfiguredPromptVersion(
          cfg.orchestration.promptOptimization.versions,
          cfg.orchestration.promptOptimization.activeVersionId,
          cfg.orchestration.promptOptimization.canaryVersionId,
          request.requestId,
          cfg.orchestration.promptOptimization.enabled ? cfg.orchestration.promptOptimization.canaryPercent : 0,
        );
        appendTrace('plan', '选择 Planner 提示词版本', {
          promptVersionId: promptVersion?.id,
          promptVersionStatus: promptVersion?.status,
          canaryPercent: cfg.orchestration.promptOptimization.canaryPercent,
        });
        const plannerRole = this.roleOptions(cfg, 'planner');
        plan = await planWithModel(modelAdapter, request, {
          ...plannerRole,
          nodeIndex: Number(cfg.orchestration.planner.nodeIndex ?? plannerRole.nodeIndex ?? 0),
          model: String(cfg.orchestration.planner.model || plannerRole.model || ''),
          capabilityCatalog: catalog,
          maxRepairAttempts: cfg.orchestration.planner.maxRepairAttempts,
          maxModelRounds: Math.max(1, maxModelRounds - roleRoundsUsed),
          maxSteps: cfg.orchestration.execution.maxSteps,
          timeoutMs: Number(cfg.orchestration.planner.clarificationTimeoutMs || plannerRole.timeoutMs || 60000),
          systemPrompt: promptVersion?.content,
        });
        roleRoundsUsed += Number(plan.modelRoundsUsed || 0);
        for (const reviewRole of ['specialist', 'critic'] as const) {
          if (!cfg.orchestration.roles[reviewRole].enabled || maxModelRounds - roleRoundsUsed <= 0) continue;
          const reviewed = await this.runRoleWithFallback(this.roleOptions(cfg, reviewRole), (opts) => refinePlanWithModel(modelAdapter, request, plan, catalog, { ...opts, role: reviewRole }));
          roleRoundsUsed += reviewed.rounds;
          if (!reviewed.fallback) plan = reviewed.value;
          appendTrace('plan', reviewRole + ' 完成', { fallback: reviewed.fallback, error: reviewed.error });
        }
        if (cfg.orchestration.roles.safety.enabled && maxModelRounds - roleRoundsUsed > 0) {
          const safety = await this.runRoleWithFallback(this.roleOptions(cfg, 'safety'), (opts) => assessPlanSafetyWithModel(modelAdapter, request, plan, opts));
          roleRoundsUsed += safety.rounds;
          if (safety.value.riskLevel === 'high' || safety.value.riskLevel === 'critical') {
            plan = { ...plan, steps: plan.steps.map((step) => ({ ...step, approvalRequired: true })) };
          }
          appendTrace('plan', 'safety 完成', { fallback: safety.fallback, riskLevel: safety.value.riskLevel, reason: safety.value.reason, error: safety.error });
        }
        plan = { ...plan, requestId: request.requestId, source: 'model', modelRoundsUsed: roleRoundsUsed };
      }
    } catch (error) {
      this.options.logger?.warn('智能编排规划失败，回退旧链路', { error: String((error as Error)?.message || error) });
      return { handled: false, reason: 'planner_failed' };
    }
    if (!input.plan && plan.steps.some((step) => step.capability === 'voice.search')) {
      const removed = plan.steps.filter((step) => step.capability === 'voice.preview' || step.capability === 'voice.select');
      if (removed.length) {
        plan = {
          ...plan,
          steps: plan.steps.filter((step) => step.capability !== 'voice.preview' && step.capability !== 'voice.select'),
        };
        appendTrace('plan', '音色候选需用户确认后再试听/选择', { removedSteps: removed.map((step) => step.id) });
      }
    }
    const minConfidence = Math.max(0, Number(cfg.orchestration.planner.minConfidence || 0));
    if (!resumedFromJob && plan.source === 'model' && !plan.needsClarification && minConfidence > 0 && Number(plan.confidence || 0) < minConfidence) {
      plan = {
        ...plan,
        needsClarification: true,
        clarificationQuestion: plan.clarificationQuestion || '我还不能确定你的完整需求，请再补充一点目标、对象或约束。',
      };
    }
    const validation = validateIntentPlan(plan, { maxSteps: cfg.orchestration.execution.maxSteps });
    if (!validation.ok) return { handled: false, reason: `invalid_plan:${validation.errors.join(',')}` };
    if (plan.needsClarification) {
      const question = plan.clarificationQuestion || '请补充更具体的信息。';
      const maxClarifications = Math.min(1, Math.max(0, Number(cfg.orchestration.planner.maxClarifications ?? 1)));
      if (clarificationCount >= maxClarifications) {
        this.options.pendingJobs?.delete(pendingKey);
        return { handled: true, result: this.messageEngineResult('信息仍然不足，已停止本次任务。') };
      }
      const now = new Date().toISOString();
      this.options.pendingJobs?.set({
        key: pendingKey,
        originalText,
        question,
        attempts: clarificationCount + 1,
        createdAt: pending?.createdAt || now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + Math.max(1000, Number(cfg.orchestration.planner.clarificationTimeoutMs || 300000))).toISOString(),
        schemaVersion: 2,
        jobId,
        requestId,
        status: 'clarifying',
        originalRequest: pending?.originalRequest || request,
        plan: { ...plan, requestId, needsClarification: true, clarificationQuestion: question },
        order: plan.steps.map((step) => step.id),
        results: {},
        approvedStepIds: [],
        pendingStepId: undefined,
        pendingQuestion: question,
        clarificationUsed: true,
        clarificationCount: clarificationCount + 1,
        startedAt: jobStartedAt,
      });
      appendTrace('plan', '发起唯一一次追问', { jobId, question, clarificationCount: clarificationCount + 1 });
      return { handled: true, result: this.messageEngineResult(question) };
    }

    plan = { ...plan, requestId, needsClarification: false, clarificationQuestion: undefined };
    appendTrace('plan', '生成执行计划', { jobId, goal: plan.goal, steps: plan.steps.map((step) => ({ id: step.id, capability: step.capability, dependsOn: step.dependsOn || [] })), confidence: plan.confidence, resumedFromJob });

    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    const approvedStepIds = new Set<string>(resumeApprovedStepIds);
    let initialResults: Record<string, any> = { ...resumeResults };
    if (resumePendingStepId) delete initialResults[resumePendingStepId];
    let approvalRounds = 0;
    const maxApprovalRounds = Math.max(1, Number(cfg.orchestration.approval.maxPendingGlobal || 50));
    const jobCreatedAt = pending?.createdAt || new Date().toISOString();
    const runningExpiresAt = new Date(Date.now() + Math.max(3600000, Number(cfg.orchestration.execution.maxDurationMs || 0) + 300000)).toISOString();
    const baseJob: PendingJobRecord = {
      key: pendingKey,
      originalText,
      question: pending?.question || '',
      attempts: clarificationCount,
      createdAt: jobCreatedAt,
      updatedAt: new Date().toISOString(),
      expiresAt: runningExpiresAt,
      schemaVersion: 2,
      jobId,
      requestId,
      status: 'running',
      originalRequest: pending?.originalRequest || request,
      plan,
      order: plan.steps.map((step) => step.id),
      results: initialResults,
      approvedStepIds: Array.from(approvedStepIds),
      pendingStepId: undefined,
      clarificationUsed: clarificationCount > 0,
      clarificationCount,
      startedAt: jobStartedAt,
    };
    this.options.pendingJobs?.set(baseJob);
    while (true) {
      const execution = await executeIntentPlan(request, plan, {
        dispatcher: this.dispatcher,
        maxSteps: cfg.orchestration.execution.maxSteps,
        maxParallelSteps: cfg.orchestration.execution.maxParallelSteps,
        maxDepth: cfg.orchestration.execution.maxDepth,
        maxDurationMs: cfg.orchestration.execution.maxDurationMs,
        maxCost: cfg.orchestration.execution.maxCost,
        maxModelRounds: cfg.orchestration.execution.maxModelRounds,
        loopDetection: cfg.orchestration.execution.loopDetection,
        failurePolicy: cfg.orchestration.execution.failurePolicy === 'continue' ? 'continue' : cfg.orchestration.execution.failurePolicy === 'ask' ? 'ask' : 'stop',
        initialResults,
        approvedStepIds,
        initialModelRounds: plan.modelRoundsUsed || (plan.source === 'model' ? 1 : 0),
        startedAt: jobStartedAt,
        onCheckpoint: (checkpoint) => {
          this.options.pendingJobs?.update(pendingKey, {
            status: 'running',
            plan,
            results: checkpoint.results,
            order: checkpoint.order,
            approvedStepIds: Array.from(approvedStepIds),
            pendingStepId: checkpoint.pendingStepId,
            clarificationUsed: clarificationCount > 0,
            clarificationCount,
            startedAt: jobStartedAt,
            lastError: checkpoint.reason,
          });
        },
      });
      initialResults = execution.results;
      let outputs = execution.outputs;

      if (execution.status === 'waiting_approval') {
        const waitingId = execution.order.find((id) => execution.results[id]?.status === 'waiting_approval');
        const step = waitingId ? byId.get(waitingId) : undefined;
        if (!step) return this.partialResult(outputs, 'approval_invalid', '审批步骤不存在');
        if (!this.options.approvalRuntime || !cfg.orchestration.approval.enabled) {
          this.options.pendingJobs?.delete(pendingKey);
          return this.approvalFailureResult('该操作需要管理员审批，但当前没有可用审批配置，已拒绝执行。', 'approval_unavailable', 'approval_unavailable');
        }
        approvalRounds += 1;
        if (approvalRounds > maxApprovalRounds) {
          return this.partialResult(outputs, 'approval_loop', '审批轮次超过上限，已停止执行。');
        }
        const capability = this.registry.get(step.capability);
        const approvalPayloadHash = hashApprovalPayload(step.args);
        const waitingExpiresAt = new Date(Date.now() + Math.max(60000, Number(cfg.orchestration.approval.timeoutMs || 120000)) + 60000).toISOString();
        this.options.pendingJobs?.update(pendingKey, {
          status: 'waiting_approval',
          plan,
          results: execution.results,
          order: execution.order,
          approvedStepIds: Array.from(approvedStepIds),
          pendingStepId: step.id,
          approvalPayloadHash,
          clarificationUsed: clarificationCount > 0,
          clarificationCount,
          startedAt: jobStartedAt,
          expiresAt: waitingExpiresAt,
        });
        const outcome = await this.options.approvalRuntime.request({
          requestId: request.requestId,
          jobId,
          stepId: step.id,
          capability: step.capability,
          riskLevel: (capability?.riskLevel || 'high') as any,
          requesterQq: request.user.qq,
          groupId: request.chat.groupId,
          payload: step.args,
          quorum: cfg.orchestration.approval.quorum,
          maskArgs: cfg.orchestration.approval.maskArgs,
          summary: `${step.capability} 需要管理员审批`,
          ttlMs: cfg.orchestration.approval.timeoutMs,
          onCreated: (approval) => {
            this.options.pendingJobs?.update(pendingKey, {
              approvalId: approval.approvalId,
              approvalPayloadHash: approval.payloadHash,
              status: 'waiting_approval',
            });
          },
        });
        appendTrace('approval', '管理员审批结果', { step: step.id, status: outcome.status, approvalId: outcome.approval?.approvalId });
        if (outcome.status !== 'approved') {
          this.options.pendingJobs?.delete(pendingKey);
          const fallback = cfg.orchestration.approval.fallback;
          if (outcome.status === 'failed') {
            return this.approvalFailureResult('审批通知发送失败，任务已按安全策略终止。', ('approval_delivery_failed_' + fallback) as string, 'approval_delivery_failed');
          }
          if (outcome.status === 'rejected') {
            return this.approvalFailureResult('管理员已拒绝该操作。', 'approval_rejected', 'approval_rejected');
          }
          const cancelled = fallback === 'cancel' || outcome.status === 'cancelled';
          return this.approvalFailureResult(
            cancelled ? '审批未完成，任务已取消。' : '审批未完成，任务已拒绝。',
            cancelled ? 'approval_timeout_cancelled' : 'approval_timeout_denied',
            outcome.status,
          );
        }
        if (outcome.approval && approvalPayloadHash !== outcome.approval.payloadHash) {
          this.options.pendingJobs?.delete(pendingKey);
          return this.partialResult(outputs, 'approval_payload_changed', '审批参数已变化，原审批失效，已拒绝执行。');
        }
        delete initialResults[step.id];
        approvedStepIds.add(step.id);
        this.options.pendingJobs?.update(pendingKey, {
          status: 'running',
          results: initialResults,
          approvedStepIds: Array.from(approvedStepIds),
          pendingStepId: undefined,
          approvalId: outcome.approval?.approvalId,
          approvalPayloadHash: outcome.approval?.payloadHash,
        });
        continue;
      }

      if (execution.status === 'needs_input') {
        const pendingResult: any = Object.values(execution.results).find((result: any) => result.status === 'needs_input');
        const question = String(pendingResult?.diagnostics?.question || '请补充必要参数后继续。');
        if (clarificationCount >= Math.min(1, Math.max(0, Number(cfg.orchestration.planner.maxClarifications ?? 1)))) {
          this.options.pendingJobs?.delete(pendingKey);
          return { handled: true, result: this.messageEngineResult('信息仍然不足，已停止本次任务。') };
        }
        const now = new Date().toISOString();
        this.options.pendingJobs?.set({
          key: pendingKey,
          originalText: originalText || effectiveText,
          question,
          attempts: clarificationCount + 1,
          createdAt: pending?.createdAt || now,
          updatedAt: now,
          expiresAt: new Date(Date.now() + Math.max(1000, Number(cfg.orchestration.planner.clarificationTimeoutMs || 300000))).toISOString(),
          schemaVersion: 2,
          jobId,
          requestId,
          status: 'clarifying',
          originalRequest: pending?.originalRequest || request,
          plan,
          order: execution.order,
          results: execution.results,
          approvedStepIds: Array.from(approvedStepIds),
          pendingStepId: pendingResult?.stepId,
          pendingQuestion: question,
          clarificationUsed: true,
          clarificationCount: clarificationCount + 1,
          startedAt: jobStartedAt,
        });
        appendTrace('plan', '执行阶段发起唯一一次追问', { jobId, stepId: pendingResult?.stepId, question });
        return { handled: true, result: this.messageEngineResult(question) };
      }
      if (execution.status === 'denied') {
        this.options.pendingJobs?.delete(pendingKey);
        return this.partialResult(outputs, 'permission_denied', execution.error || '该操作没有执行权限。');
      }
      if (execution.status === 'failed') {
        this.options.pendingJobs?.delete(pendingKey);
        if (execution.usage.stepsExecuted > 0) {
          return this.partialResult(outputs, 'execution_failed', execution.error || 'capability_failed');
        }
        return { handled: false, reason: execution.error || 'capability_failed', problem: { kind: 'execution_failed', error: execution.error || 'capability_failed' } };
      }
      if (execution.status === 'partial') {
        this.options.pendingJobs?.delete(pendingKey);
        return this.partialResult(outputs, 'capability_failed', execution.error || '部分步骤执行失败');
      }

      this.options.pendingJobs?.delete(pendingKey);
      if (plan.source === 'model' && cfg.orchestration.roles.composer.enabled) {
        const maxModelRounds = Math.max(1, Number(cfg.orchestration.execution.maxModelRounds || 1));
        if (execution.usage.modelRounds < maxModelRounds) {
          const composed = await this.runRoleWithFallback(this.roleOptions(cfg, 'composer'), (opts) => composeResultTextWithModel(
            modelAdapter,
            request,
            outputs,
            opts,
          ));
          if (composed.value) {
            outputs.push({
              kind: 'text',
              text: composed.value,
              priority: 1,
              mergeable: true,
              meta: { synthetic: true, role: 'composer' },
            });
          }
          appendTrace('reply', 'composer 完成', { fallback: composed.fallback, hasText: Boolean(composed.value), error: composed.error });
        }
      }
      const replyPlan = buildReplyPlan(outputs, {
        maxMessages: cfg.orchestration.reply.maxMessages,
        maxResultItems: cfg.orchestration.reply.maxResultItems,
        preferNestedForward: cfg.orchestration.reply.preferNestedForward,
        includeTruncationNotice: cfg.orchestration.reply.includeTruncationNotice,
      nestedMaxNodes: cfg.orchestration.reply.nestedMaxNodes,
      nestedMaxDepth: cfg.orchestration.reply.nestedMaxDepth,
      overflowPolicy: cfg.orchestration.reply.overflowPolicy,
      });
      const visibleOutputs = replyPlan.groups.flatMap((group) => group.outputs);
      const result = this.toEngineResult(visibleOutputs) || this.emptyEngineResult();
      result.replyPlan = replyPlan;
      return { handled: true, result, ...(replyPlan.warnings.length ? { reason: replyPlan.warnings.join(';') } : {}) };
    }
  }

  private makeReplyPlan(outputs: ExecutionOutput[]): ReplyPlan {
    const cfg = this.options.getConfig();
    return buildReplyPlan(outputs, {
      maxMessages: cfg.orchestration.reply.maxMessages,
      maxResultItems: cfg.orchestration.reply.maxResultItems,
      preferNestedForward: cfg.orchestration.reply.preferNestedForward,
      includeTruncationNotice: cfg.orchestration.reply.includeTruncationNotice,
      nestedMaxNodes: cfg.orchestration.reply.nestedMaxNodes,
      nestedMaxDepth: cfg.orchestration.reply.nestedMaxDepth,
      overflowPolicy: cfg.orchestration.reply.overflowPolicy,
    });
  }
  private messageEngineResult(text: string): BotEngineResult {
    return {
      kind: 'chat',
      decision: { kind: 'chat', source: 'model', confidence: 1, reason: 'clarification', params: { prompt: text, tokens: [] }, usedPlanner: true } as any,
      text,
      replyPlan: this.makeReplyPlan([{ kind: 'text', text, priority: 10, mergeable: true }]),
      handled: true,
    };
  }

  private emptyEngineResult(): BotEngineResult {
    return {
      kind: 'chat',
      decision: { kind: 'chat', source: 'fallback', confidence: 1, reason: 'orchestration_partial', params: { prompt: '', tokens: [] }, usedPlanner: false } as any,
      replyPlan: this.makeReplyPlan([]),
      handled: true,
    };
  }

  private approvalFailureResult(text: string, kind: string, error: string): EnforceOrchestrationResult {
    return {
      handled: true,
      // 审批拒绝/超时/投递失败属于内部问题：只上报管理员，不向用户发错误文本。
      result: this.emptyEngineResult(),
      problem: { kind, error },
    };
  }
  private partialResult(outputs: any[], kind: string, error: string): EnforceOrchestrationResult {
    const replyPlan = this.makeReplyPlan(outputs as ExecutionOutput[]);
    const visibleOutputs = replyPlan.groups.flatMap((group) => group.outputs);
    const result = this.toEngineResult(visibleOutputs) || this.emptyEngineResult();
    result.replyPlan = replyPlan;
    return {
      handled: true,
      result,
      problem: { kind, error },
    };
  }
  private toEngineResult(outputs: any[]): BotEngineResult | null {
    const text = outputs.filter((item) => item.kind === 'text' && item.text).map((item) => item.text).filter(Boolean).join('\n\n');
    const images = outputs.filter((item) => item.kind === 'image' && item.url).map((item) => item.url);
    const videos = outputs.filter((item) => item.kind === 'video' && item.url).map((item) => item.url);
    const files = outputs.filter((item) => item.kind === 'file' && item.url).map((item) => ({ file: item.url, name: item.meta?.name }));
    const audio = outputs.filter((item) => item.kind === 'audio' && item.url).map((item) => item.url);
    if (!text && !images.length && !videos.length && !files.length && !audio.length) return null;
    const kind = images.length ? 'image.generate' : videos.length ? 'video.generate' : 'chat';
    return {
      kind: kind as any,
      decision: { kind, source: 'model', confidence: 1, reason: 'orchestration', params: { prompt: text, tokens: [] }, usedPlanner: true } as any,
      text: text || undefined,
      images: images.length ? images : undefined,
      videos: videos.length ? videos : undefined,
      files: files.length ? files : undefined,
      audio: audio.length ? audio : undefined,
      handled: true,
    };
  }
}
