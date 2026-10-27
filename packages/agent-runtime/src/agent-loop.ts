import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeToolError,
  toolFailure,
  toolSuccess,
  type ToolCall,
  type ToolError,
  type ToolResult,
  type ToolSpec,
  type ToolRegistry,
} from '../../tool-runtime/src/index.js';
import type { ToolExecutor } from '../../tool-runtime/src/index.js';
import {
  DEFAULT_OUTPUT_REPAIR_LIMITS,
  OutputRepairBudgetTracker,
  type OutputRepairLimits,
} from './output-repair.js';
import { DefaultAgentContextBuilder, type AgentContextBuilder } from './context-builder.js';
import { estimateTokens, type PromptRegistry } from './prompt-registry.js';
import type { AgentSessionStore } from './session-manager.js';
import { ASK_USER_TOOL_NAME, ASK_USER_TOOL_SPEC } from './ask-user-tool.js';
import { REPLY_PRESENTATION_TOOL_NAME, REPLY_PRESENTATION_TOOL_SPEC } from './reply-presentation-tool.js';
import { parseReplyPresentationArguments } from './reply-presentation-tool.js';
import { sanitizeStructuredPayload, stripInlineImagePayloads } from './text-sanitize.js';
import type { AgentReplyPreference } from './types.js';
import { UPDATE_PLAN_TOOL_NAME, UPDATE_PLAN_TOOL_SPEC } from './plan-tool.js';
import {
  buildRepairInstruction,
  buildSafeTextInstruction,
  isProtocolToolError,
  toolErrorForCall,
  toolErrorResultContent,
  validateAgentModelOutput,
  type AgentModelValidation,
} from './agent-output.js';
import type {
  AgentApprovalRecord,
  AgentAssistantTurn,
  AgentFeatureFlag,
  AgentJobRecord,
  AgentMessage,
  AgentPendingQuestion,
  AgentRuntimeMode,
  AgentSessionState,
  AgentToolError,
  AgentToolResult,
  AgentToolSpec,
  AgentTurnInput,
  AgentTurnResult,
  AgentUsage,
} from './types.js';
import { DEFAULT_AGENT_FEATURE_FLAG } from './types.js';

export interface AgentModelRequest {
  model: string;
  nodeIndex?: number;
  messages: AgentMessage[];
  tools: AgentToolSpec[];
  toolChoice: 'auto' | 'required' | 'none';
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  purpose?: 'turn' | 'repair' | 'safe-text';
  /** 本请求的预算上限；上层 turn deadline 会把它进一步 clamp。 */
  timeoutMs?: number;
}

export interface AgentModelResponse {
  assistant: AgentAssistantTurn;
  raw?: unknown;
  finishReason?: string;
  truncated?: boolean;
  toolCallIssues?: AgentToolError[];
  usage?: AgentUsage;
}

export interface AgentModelPort {
  chat(request: AgentModelRequest): Promise<AgentModelResponse>;
}

export interface AgentLoopLimits {
  maxModelRounds: number;
  maxToolRounds: number;
  maxParallelTools: number;
  maxToolCallsPerRound: number;
  maxTokens: number;
  turnTimeoutMs: number;
  finalizeTimeoutMs: number;
  maxToolsPerTurn: number;
  maxToolSchemaBytes: number;
}

export const DEFAULT_AGENT_LOOP_LIMITS: Readonly<AgentLoopLimits> = Object.freeze({
  maxModelRounds: 8,
  maxToolRounds: 16,
  maxParallelTools: 4,
  maxToolCallsPerRound: 16,
  maxTokens: 8192,
  turnTimeoutMs: 180_000,
  finalizeTimeoutMs: 15_000,
  maxToolsPerTurn: 24,
  maxToolSchemaBytes: 48_000,
});

export interface AgentToolPreflightInput {
  call: ToolCall;
  spec: ToolSpec;
  turnId: string;
  sessionKey: string;
  requestId?: string;
  mode: Exclude<AgentRuntimeMode, 'off'>;
  metadata?: Record<string, unknown>;
}

export interface AgentToolPreflightDecision {
  allowed: boolean;
  error?: ToolError;
  pendingApproval?: AgentApprovalRecord;
  pendingJob?: AgentJobRecord;
}

export type AgentToolPreflight = (
  input: AgentToolPreflightInput,
) => Promise<AgentToolPreflightDecision> | AgentToolPreflightDecision;

export interface AgentApprovalResolution {
  approvalId: string;
  status: AgentApprovalRecord['status'];
  payloadHash?: string;
}

export type AgentApprovalResolver = (
  record: AgentApprovalRecord,
) => Promise<AgentApprovalResolution> | AgentApprovalResolution;

export interface AgentJobResolution {
  jobId: string;
  status: AgentJobRecord['status'];
  result?: ToolResult;
  error?: ToolError;
}

export type AgentJobResolver = (
  record: AgentJobRecord,
) => Promise<AgentJobResolution> | AgentJobResolution;
export interface AgentLoopDependencies {
  model: AgentModelPort;
  sessions: AgentSessionStore;
  mainModel: string;
  nodeIndex?: number;
  temperature?: number;
  contextBuilder?: AgentContextBuilder;
  promptRegistry?: PromptRegistry;
  toolRegistry?: ToolRegistry;
  toolSpecs?: AgentToolSpec[];
  toolExecutor?: ToolExecutor;
  featureFlag?: AgentFeatureFlag;
  limits?: Partial<AgentLoopLimits>;
  repairLimits?: Partial<OutputRepairLimits>;
  preflightToolCall?: AgentToolPreflight;
  resolveApproval?: AgentApprovalResolver;
  resolveJob?: AgentJobResolver;
  drainSteeringMessages?: () => string[] | Promise<string[]>;
  shouldStop?: () => boolean;
  enablePlanTool?: boolean;
  toolSearchEnabled?: boolean;
  contextMaxChars?: number;
  compactionEnabled?: boolean;
  toolResultMaxChars?: number;
  spillEnabled?: boolean;
  spillDir?: string;
  maxPinnedFacts?: number;
  clock?: () => Date;
}

export interface AgentLoop {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

interface TurnBudget {
  modelRounds: number;
  toolRounds: number;
  remainingTokens: number;
  usage: AgentUsage;
}

interface TurnExecutionState {
  budget: TurnBudget;
  toolResults: AgentToolResult[];
  deadlineAt: number;
}

class AgentAbortError extends Error {
  constructor() { super('agent_turn_aborted'); }
}

class AgentTimeoutError extends Error {
  constructor() { super('agent_turn_timeout'); }
}

export class AgentRuntime implements AgentLoop {
  private readonly deps: AgentLoopDependencies;
  private readonly limits: AgentLoopLimits;
  private readonly repairLimits: OutputRepairLimits;
  private readonly clock: () => Date;

  constructor(dependencies: AgentLoopDependencies) {
    this.deps = dependencies;
    this.limits = normalizeLoopLimits(dependencies.limits);
    this.repairLimits = normalizeRepairConfig(dependencies.repairLimits);
    this.clock = dependencies.clock || (() => new Date());
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const mode = resolveAgentRuntimeMode(this.deps.featureFlag);
    if (mode === 'off') {
      return this.failedResult(input, 'agent_runtime_disabled', 'Agent runtime is disabled.');
    }
    if (!String(input.userText || '').trim()) {
      return this.failedResult(input, 'empty_user_input', 'User input is empty.');
    }
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (input.signal?.aborted) return this.cancelledResult(input, 'turn_cancelled_before_start');
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const executionState: TurnExecutionState = {
      budget: { modelRounds: 0, toolRounds: 0, remainingTokens: this.limits.maxTokens, usage: {} },
      toolResults: [],
      deadlineAt: Date.now() + this.limits.turnTimeoutMs,
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.turnTimeoutMs);
    const task = this.runTurnInner(input, mode, controller.signal, executionState);
    const abortRace = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new AgentAbortError()), { once: true });
    });
    try {
      return await Promise.race([task, abortRace]);
    } catch (error) {
      if (timedOut) return await this.finalizeTimedOut(input, executionState, 'turn_timeout');
      if (error instanceof AgentAbortError || controller.signal.aborted || input.signal?.aborted) return this.cancelledResult(input, 'turn_cancelled');
      return this.failedResult(input, 'agent_runtime_error', error instanceof Error ? error.message : String(error), {
        usage: this.finalUsage(executionState.budget),
        toolResults: executionState.toolResults,
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async runTurnInner(input: AgentTurnInput, mode: Exclude<AgentRuntimeMode, 'off'>, signal: AbortSignal, executionState: TurnExecutionState): Promise<AgentTurnResult> {
    const created = this.deps.sessions.loadOrCreate?.({
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      configRevision: input.configRevision,
      runtimeVersion: input.runtimeVersion,
    });
    const session = created || this.deps.sessions.load(input.sessionKey) || {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      messages: [],
      pinnedFacts: {},
      artifacts: [],
      configRevision: input.configRevision,
      runtimeVersion: input.runtimeVersion,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const resumedToolResults: AgentToolResult[] = [];
    const pendingApprovals = [...(session.pendingApprovals || [])];
    if (pendingApprovals.length) {
      if (!this.deps.resolveApproval) {
        return {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          status: 'suspended',
          messages: structuredClone(session.messages),
          usage: { modelRounds: 0, toolRounds: 0 },
          pendingApproval: pendingApprovals[0],
          meta: { reason: 'approval_pending_resume' },
        };
      }
      let remainingApprovals = [...pendingApprovals];
      let remainingCalls = [...(session.pendingToolCalls || [])];
      for (const pendingApproval of pendingApprovals) {
        const callIndex = remainingCalls.findIndex((call) => !pendingApproval.callId || call.id === pendingApproval.callId);
        if (callIndex < 0) {
          remainingApprovals = remainingApprovals.filter((item) => item.approvalId !== pendingApproval.approvalId);
          continue;
        }
        const pendingCall = remainingCalls[callIndex];
        const resolved = await this.deps.resolveApproval(pendingApproval);
        if (resolved.status === 'pending') {
          session.pendingApprovals = remainingApprovals.length ? remainingApprovals : undefined;
          session.pendingToolCalls = remainingCalls.length ? remainingCalls : undefined;
          return {
            sessionKey: input.sessionKey,
            turnId: input.turnId,
            status: 'suspended',
            messages: structuredClone(session.messages),
            usage: { modelRounds: 0, toolRounds: 0 },
            pendingApproval: { ...pendingApproval, status: 'pending' },
            meta: { reason: 'approval_pending_resume' },
          };
        }
        let result: AgentToolResult;
        const callHash = approvalPayloadHash(pendingCall.arguments);
        const approved = resolved.status === 'approved'
          && (!resolved.payloadHash || resolved.payloadHash === pendingApproval.payloadHash)
          && callHash === pendingApproval.payloadHash;
        if (approved && this.deps.toolExecutor) {
          result = await this.deps.toolExecutor.execute(pendingCall, {
            turnId: input.turnId,
            operationId: pendingApproval.approvalId,
            sessionKey: input.sessionKey,
            ...(typeof input.metadata?.requestId === 'string' ? { requestId: input.metadata.requestId } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          });
        } else {
          const approvedMismatch = resolved.status === 'approved';
          result = toolFailure(pendingCall.id, makeToolError({
            code: approvedMismatch ? 'permission_denied' : 'approval_required',
            message: approvedMismatch
              ? '审批参数哈希不一致，拒绝执行。'
              : `审批未通过：${resolved.status}`,
            callId: pendingCall.id,
            toolName: pendingCall.name,
            retryable: false,
            details: {
              approvalId: pendingApproval.approvalId,
              approvalStatus: resolved.status,
              expectedPayloadHash: pendingApproval.payloadHash,
              actualPayloadHash: callHash,
            },
          }), { toolName: pendingCall.name });
        }
        const toolMessage: AgentMessage = {
          role: 'tool',
          toolCallId: pendingCall.id,
          name: pendingCall.name,
          content: JSON.stringify(result),
          isError: !result.ok,
        };
        session.messages = [ ...(session.messages || []).filter((message) => !(message.role === 'tool' && message.toolCallId === pendingCall.id)), toolMessage ];
        resumedToolResults.push(result);
        remainingApprovals = remainingApprovals.filter((item) => item.approvalId !== pendingApproval.approvalId);
        remainingCalls = remainingCalls.filter((call) => call.id !== pendingCall.id);
        session.pendingApprovals = remainingApprovals.length ? remainingApprovals : undefined;
        session.pendingToolCalls = remainingCalls.length ? remainingCalls : undefined;
      }
    }
    // 普通新消息不能消费上一轮尚未完成的异步任务；否则会把旧图片/旧音频
    // 当成本轮 tool result 注入 ReplyPlan，造成旧产物被再次发送。
    // 只有 ToolJobRuntime 完成回调带来的 resumeJob turn 才允许结算 pendingJobs。
    const existingPendingJobs = session.pendingJobs || [];
    // 普通新消息可以正常回答，但绝不能结算旧 pending job；旧产物只在
    // resumeJob=true 的完成回调里注入。同工具重复请求由工具层 per-session FIFO 队列承接。
    const resumeJobId = typeof input.metadata?.resumeJobId === 'string' ? input.metadata.resumeJobId : '';
    const pendingJobs = input.metadata?.resumeJob === true
      ? existingPendingJobs.filter((job) => !resumeJobId || job.jobId === resumeJobId).slice(0, 1)
      : [];
    if (pendingJobs.length) {
      if (!this.deps.resolveJob) {
        return {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          status: 'suspended',
          messages: structuredClone(session.messages),
          usage: { modelRounds: 0, toolRounds: 0 },
          pendingJob: pendingJobs[0],
          meta: { reason: 'async_job_pending_resume' },
        };
      }
      const pendingJob = pendingJobs[0];
      const pendingCalls = [...(session.pendingToolCalls || [])];
      const callIndex = pendingCalls.findIndex((call) => call.id === pendingJob.callId);
      if (callIndex < 0) {
        session.pendingJobs = existingPendingJobs.filter((item) => item.jobId !== pendingJob.jobId);
        if (!session.pendingJobs.length) session.pendingJobs = undefined;
        return {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          status: 'suspended',
          messages: structuredClone(session.messages),
          usage: { modelRounds: 0, toolRounds: 0 },
          meta: { reason: 'async_job_pending_missing_call' },
        };
      }
      const pendingCall = pendingCalls[callIndex];
      const resolved = await this.deps.resolveJob(pendingJob);
      if (resolved.status === 'queued' || resolved.status === 'running' || resolved.result?.pending) {
        session.pendingJobs = existingPendingJobs;
        session.pendingToolCalls = pendingCalls;
        return {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          status: 'suspended',
          messages: structuredClone(session.messages),
          usage: { modelRounds: 0, toolRounds: 0 },
          pendingJob: { ...pendingJob, status: resolved.status === 'queued' ? 'queued' : 'running' },
          meta: { reason: 'async_job_pending_resume' },
        };
      }
      let result: AgentToolResult;
      if (resolved.result && !resolved.result.pending) {
        result = resolved.result;
      } else if (resolved.status === 'succeeded') {
        result = resolved.result || toolSuccess(pendingCall.id, pendingCall.name, {
          content: '任务已完成。',
          meta: { jobId: pendingJob.jobId },
        });
      } else {
        result = toolFailure(pendingCall.id, resolved.error || makeToolError({
          code: 'tool_execution_failed',
          message: '异步任务状态：' + String(resolved.status),
          callId: pendingCall.id,
          toolName: pendingCall.name,
          retryable: resolved.status === 'cancelled',
          details: { jobId: pendingJob.jobId, jobStatus: resolved.status },
        }), { toolName: pendingCall.name });
      }
      const toolMessage: AgentMessage = {
        role: 'tool',
        toolCallId: pendingCall.id,
        name: pendingCall.name,
        content: JSON.stringify(result),
        isError: !result.ok,
      };
      const remainingCalls = pendingCalls.filter((call) => call.id !== pendingCall.id);
      session.messages = [ ...(session.messages || []).filter((message) => !(message.role === 'tool' && message.toolCallId === pendingCall.id)), toolMessage ];
      resumedToolResults.push(result);
      session.pendingJobs = existingPendingJobs.filter((item) => item.jobId !== pendingJob.jobId);
      if (!session.pendingJobs.length) session.pendingJobs = undefined;
      session.pendingToolCalls = remainingCalls.length ? remainingCalls : undefined;
    }
    let contextUserText = input.userText;
    // 异步任务续跑时原用户消息已经在 session.messages；不要把续跑通知伪装成新用户请求。
    if (input.metadata?.resumeJob === true && resumedToolResults.length > 0) contextUserText = '';
    const pendingQuestion = session.pendingQuestion;
    if (pendingQuestion) {
      const pendingCall = (session.pendingToolCalls || []).find((call) => call.name === ASK_USER_TOOL_NAME);
      if (pendingCall) {
        const answer = String(input.userText || '').trim();
        const toolResult: AgentMessage = {
          role: 'tool',
          toolCallId: pendingCall.id,
          name: ASK_USER_TOOL_NAME,
          content: JSON.stringify({
            ok: true,
            content: answer,
            answer,
            missingFields: pendingQuestion.missingFields,
            ...(pendingQuestion.options?.length ? { options: pendingQuestion.options } : {}),
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          }),
          isError: false,
        };
        session.messages = [...(session.messages || []), toolResult];
        // The user's answer is represented by the tool result. Attachment-only
        // answers still add a user message through the context builder.
        contextUserText = '';
      }
      session.pendingQuestion = undefined;
      session.pendingToolCalls = undefined;
    }
    // pending 工具仍然对模型可见：同工具重复请求由 ToolJobRuntime 的 per-session FIFO 队列承接，
    // 不能靠隐藏工具来防止重复提交，否则用户会无工具可用、turn 失败或无回复。
    const tools = this.resolveTools(input);
    const availableToolNames = tools.map((tool) => tool.name);
    const prompt = this.deps.promptRegistry?.build();
    const contextBuilder = this.deps.contextBuilder || new DefaultAgentContextBuilder();
    const preferenceSection = input.replyPreference
      ? `【当前会话回复呈现偏好】\n${JSON.stringify(input.replyPreference)}\n当前用户消息如果提出不同的呈现方式，必须以当前消息为准，并先调用 reply.presentation 更新偏好。`
      : '';
    const systemSections = [prompt?.content, preferenceSection].filter((value): value is string => Boolean(String(value || '').trim()));
    const context = contextBuilder.build({
      session,
      userText: contextUserText,
      attachments: input.attachments,
      ...(systemSections.length ? { systemSections } : {}),
      ...(typeof input.metadata?.memoryContext === 'string' ? { memoryContext: input.metadata.memoryContext } : {}),
      ...(typeof input.metadata?.groupContext === 'string' ? { groupContext: input.metadata.groupContext } : {}),
      ...(typeof input.metadata?.currentTask === 'string' ? { currentTask: input.metadata.currentTask } : {}),
      ...(session.pinnedFacts && Object.keys(session.pinnedFacts).length ? { pinnedFacts: session.pinnedFacts } : {}),
      ...(this.deps.compactionEnabled ? { compactionEnabled: true } : {}),
      ...(this.deps.contextMaxChars ? { maxChars: this.deps.contextMaxChars } : {}),
    });
    const workingMessages: AgentMessage[] = context.messages.map((message) => structuredClone(message));
    const persistedMessages: AgentMessage[] = workingMessages
      .filter((message) => message.role !== 'system')
      .map((message) => structuredClone(message));
    const budget: TurnBudget = executionState.budget;
    const repairTracker = new OutputRepairBudgetTracker(this.repairLimits);
    executionState.toolResults = [...resumedToolResults];
    const executedResults: AgentToolResult[] = executionState.toolResults;
    let temperatureOverride: number | undefined;
    let lastRepairReason: string | undefined;
    // P0-2：reply.presentation 按当前 turn 暂存，最终随 AgentTurnResult 交给 AgentHost。
    let turnReplyPreference: AgentReplyPreference | undefined;

    for (let round = 0; round < this.limits.maxModelRounds; round += 1) {
      this.throwIfStopped(input, signal);
      await this.appendSteeringMessages(input, workingMessages, persistedMessages);
      this.throwIfStopped(input, signal);
      if (budget.remainingTokens <= 0) {
        return this.safeTextOrFailure({
          input, mode, signal, budget, workingMessages, persistedMessages, session, availableToolNames, toolResults: executedResults,
          reason: 'token_budget_exhausted', repairLimits: this.repairLimits, deadlineAt: executionState.deadlineAt,
        });
      }
      const response = await this.deps.model.chat({
        model: this.deps.mainModel,
        ...(this.deps.nodeIndex !== undefined ? { nodeIndex: this.deps.nodeIndex } : {}),
        messages: workingMessages.map((message) => structuredClone(message)),
        tools,
        toolChoice: tools.length ? (input.toolChoice || 'auto') : 'none',
        maxTokens: Math.max(1, Math.min(budget.remainingTokens, this.limits.maxTokens)),
        temperature: temperatureOverride ?? this.deps.temperature,
        signal,
        purpose: 'turn',
        timeoutMs: Math.max(1, executionState.deadlineAt - Date.now()),
      });
      temperatureOverride = undefined;
      this.consumeModelUsage(response, budget);
      this.throwIfStopped(input, signal);

      const validation = validateAgentModelOutput({
        assistant: response.assistant,
        toolCallIssues: response.toolCallIssues,
        truncated: response.truncated,
        finishReason: response.finishReason || response.assistant.finishReason,
        registry: this.deps.toolRegistry,
        toolSpecs: tools,
        availableToolNames,
        maxCallsPerRound: this.limits.maxToolCallsPerRound,
      });

      if (validation.errors.length) {
        const repairRequests = validation.errors.map((error) => ({
          error,
          kind: isProtocolToolError(error) ? 'protocol' as const : 'schema' as const,
          ...(error.callId ? { callId: error.callId } : {}),
        }));
        const decision = repairTracker.requestRepairBatch(repairRequests);
        if (!decision.allowed) {
          lastRepairReason = decision.reason || 'repair_budget_exhausted';
          return this.safeTextOrFailure({
            input, mode, signal, budget, workingMessages, persistedMessages, session, availableToolNames, toolResults: executedResults,
            reason: lastRepairReason, repairLimits: this.repairLimits, deadlineAt: executionState.deadlineAt,
          });
        }
        this.appendRepairMessages(workingMessages, response, validation);
        temperatureOverride = this.repairLimits.repairTemperature;
        continue;
      }

      if (validation.calls.length > 0) {
        if (mode === 'shadow') {
          return this.suspendedResult({
            input, session, messages: persistedMessages, budget,
            meta: { shadow: true, plannedToolCalls: validation.calls },
            errorCode: 'shadow_tool_calls',
            errorMessage: 'Shadow mode planned tool calls without executing them.',
          });
        }
        if (!this.deps.toolExecutor) {
          return this.failedResult(input, 'tool_executor_unavailable', 'Tool executor is not configured.');
        }
        if (budget.toolRounds + validation.calls.length > this.limits.maxToolRounds) {
          return this.safeTextOrFailure({
            input, mode, signal, budget, workingMessages, persistedMessages, session, availableToolNames, toolResults: executedResults,
            reason: 'max_tool_rounds', repairLimits: this.repairLimits, deadlineAt: executionState.deadlineAt,
          });
        }

        const askCall = validation.calls.find((call) => call.name === ASK_USER_TOOL_NAME);
        if (askCall) return this.suspendForAskUser(input, session, persistedMessages, budget, askCall);

        // P0-2：reply.presentation 只改回复表现偏好，本地处理（不进 executor、不产生副作用）。
        // 其余调用照常执行；presentation 结果以 ok=true 回填，模型可继续产出最终文本。
        {
          const presentationCalls = validation.calls.filter((call) => call.name === REPLY_PRESENTATION_TOOL_NAME);
          if (presentationCalls.length) {
            for (const call of presentationCalls) {
              const parsed = parseReplyPresentationArguments(
                call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
                  ? call.arguments as Record<string, unknown> : {},
              );
              if (!parsed) {
                this.appendSingleToolRound(workingMessages, persistedMessages, response, call, {
                  callId: call.id,
                  toolName: call.name,
                  ok: false,
                  error: {
                    code: 'invalid_arguments',
                    message: 'reply.presentation 需要至少一个 mode/forwardStyle/voice/reference 字段。',
                  },
                });
                continue;
              }
              turnReplyPreference = { ...turnReplyPreference, ...parsed };
              this.appendSingleToolRound(workingMessages, persistedMessages, response, call, {
                callId: call.id,
                toolName: call.name,
                ok: true,
                content: `已记录回复表现偏好（scope=${parsed.scope || 'turn'}）。`,
              });
            }
            // 只剩 presentation 时直接进入下一轮模型（等最终文本），不空转 executor。
            if (presentationCalls.length === validation.calls.length) {
              budget.toolRounds += presentationCalls.length;
              continue;
            }
          }
          // 从执行批里剔除 presentation，其余照常 preflight/执行。
          for (const call of presentationCalls) {
            const index = validation.calls.indexOf(call);
            if (index >= 0) validation.calls.splice(index, 1);
          }
          if (!validation.calls.length) { budget.toolRounds += 1; continue; }
        }

        if (validation.calls.length === 1 && validation.calls[0].name === UPDATE_PLAN_TOOL_NAME) {
          budget.toolRounds += 1;
          const planCall = validation.calls[0];
          this.appendSingleToolRound(workingMessages, persistedMessages, response, planCall, {
            callId: planCall.id,
            toolName: planCall.name,
            ok: true,
            content: 'Plan updated.',
          });
          session.pinnedFacts = {
            ...(session.pinnedFacts || {}),
            agentPlan: planCall.arguments,
          };
          continue;
        }

        const preflightResults: ToolResult[] = [];
        for (const call of validation.calls) {
          const spec = tools.find((tool) => tool.name === call.name);
          if (!spec) {
            return this.failedResult(input, 'unknown_tool', `Tool loadout lost spec for ${call.name}.`);
          }
          if (!this.deps.preflightToolCall) continue;
          let decision: AgentToolPreflightDecision;
          try {
            decision = await this.deps.preflightToolCall({
              call,
              spec,
              turnId: input.turnId,
              sessionKey: input.sessionKey,
              ...(input.metadata?.requestId ? { requestId: String(input.metadata.requestId) } : {}),
              // BUG-1（R9 修复）：权限/审批判定依赖 meta.userId/userRole/chatType/groupId；
              // 不传会把 owner/admin 降级成 user 而静默 deny，审批链路整条不可达。
              ...(input.metadata ? { metadata: input.metadata } : {}),
              mode,
            });
          } catch (error) {
            return this.failedResult(input, 'tool_preflight_failed', error instanceof Error ? error.message : String(error));
          }
          if (decision.allowed) continue;
          const pending = Boolean(decision.pendingApproval || decision.pendingJob || decision.error?.code === 'approval_required');
          if (pending) {
            const saved = this.saveSession(session, input, persistedMessages, {
              pendingToolCalls: validation.calls,
              ...(decision.pendingApproval ? { pendingApprovals: [decision.pendingApproval] } : {}),
              ...(decision.pendingJob ? { pendingJobs: [decision.pendingJob] } : {}),
            });
            return {
              sessionKey: input.sessionKey,
              turnId: input.turnId,
              status: 'suspended',
              messages: saved.messages,
              usage: this.finalUsage(budget),
              ...(turnReplyPreference ? { replyPreference: turnReplyPreference } : {}),
              ...(decision.pendingApproval ? { pendingApproval: decision.pendingApproval } : {}),
              ...(decision.pendingJob ? { pendingJob: decision.pendingJob } : {}),
              ...(decision.error ? { error: toolErrorToTurnError(decision.error) } : {}),
              meta: { reason: 'tool_preflight', toolCallId: call.id },
            };
          }
          preflightResults.push(toolFailure(call.id, decision.error || makeToolError({
            code: 'permission_denied',
            message: 'Tool preflight denied the call.',
            callId: call.id,
            toolName: call.name,
            retryable: false,
          }), { toolName: call.name }));
        }
        if (preflightResults.length) {
          const blockedResults = validation.calls.map((call) => preflightResults.find((result) => result.callId === call.id) || toolFailure(call.id, makeToolError({
            code: 'tool_call_not_executable',
            message: 'Tool batch was blocked because another call failed preflight.',
            callId: call.id,
            toolName: call.name,
            retryable: false,
          }), { toolName: call.name }));
          this.appendToolRound(workingMessages, persistedMessages, response, validation.calls, blockedResults);
          budget.toolRounds += validation.calls.length;
          continue;
        }

        // P1-7（R9 修复）：只读工具并行；副作用工具（file.delete/config.update/权限/撤回等）
        // 逐个串行执行，避免同一批模型调用并发触发多个不可逆操作。
        const executionContext = {
          turnId: input.turnId,
          sessionKey: input.sessionKey,
          requestId: input.metadata?.requestId ? String(input.metadata.requestId) : `${input.sessionKey}:${input.turnId}`,
          signal,
          deadlineAt: executionState.deadlineAt,
          metadata: input.metadata,
        };
        const specByName = new Map(tools.map((tool) => [tool.name, tool]));
        const hasSideEffects = (call: ToolCall) => {
          const spec = specByName.get(call.name);
          return Boolean(spec?.sideEffects?.length);
        };
        const readOnlyCalls = validation.calls.filter((call) => !hasSideEffects(call));
        const sideEffectCalls = validation.calls.filter((call) => hasSideEffects(call));
        const results: ToolResult[] = [];
        if (readOnlyCalls.length) {
          results.push(...await this.deps.toolExecutor.executeBatch(
            readOnlyCalls,
            executionContext,
            { maxConcurrency: this.limits.maxParallelTools },
          ));
        }
        for (const call of sideEffectCalls) {
          this.throwIfStopped(input, signal);
          results.push(...await this.deps.toolExecutor.executeBatch([call], executionContext, { maxConcurrency: 1 }));
        }
        budget.toolRounds += validation.calls.length;
        const normalizedResults = ensureBatchResults(validation.calls, results);
        executedResults.push(...normalizedResults);
        this.appendToolRound(workingMessages, persistedMessages, response, validation.calls, normalizedResults);
        const pendingJobs = this.pendingJobsFromResults(normalizedResults, input);
        if (pendingJobs.length) {
          const mergedCalls = [...(session.pendingToolCalls || []), ...validation.calls];
          const mergedJobs = [...(session.pendingJobs || []), ...pendingJobs];
          const saved = this.saveSession(session, input, persistedMessages, {
            pendingToolCalls: mergedCalls,
            pendingJobs: mergedJobs,
          });
          return {
            sessionKey: input.sessionKey,
            turnId: input.turnId,
            status: 'suspended',
            messages: saved.messages,
            toolResults: normalizedResults,
            pendingJob: pendingJobs[0],
            ...(turnReplyPreference ? { replyPreference: turnReplyPreference } : {}),
            usage: this.finalUsage(budget),
            meta: { reason: 'async_job_pending', pendingJobs },
          };
        }
        const approvalError = normalizedResults.find((result) => result.error?.code === 'approval_required');
        if (approvalError) {
          const approval = approvalFromToolResult(approvalError, validation.calls, this.now());
          const saved = this.saveSession(session, input, persistedMessages, {
            pendingToolCalls: validation.calls,
            ...(approval ? { pendingApprovals: [approval] } : {}),
          });
          return {
            sessionKey: input.sessionKey,
            turnId: input.turnId,
            status: 'suspended',
            messages: saved.messages,
            toolResults: normalizedResults,
            ...(approval ? { pendingApproval: approval } : {}),
            error: approvalError.error ? toolErrorToTurnError(approvalError.error) : { code: 'approval_required', message: 'Tool approval is required.' },
            usage: this.finalUsage(budget),
            meta: { reason: 'approval_required' },
          };
        }
        continue;
      }

      if (validation.text.trim()) {
        return this.completeWithText(input, session, persistedMessages, budget, validation.text, workingMessages, executedResults, turnReplyPreference);
      }
    }

    return this.safeTextOrFailure({
      input, mode, signal, budget, workingMessages, persistedMessages, session, availableToolNames, toolResults: executedResults,
      reason: lastRepairReason || 'max_model_rounds', repairLimits: this.repairLimits, deadlineAt: executionState.deadlineAt,
    });
  }

  private resolveTools(input: AgentTurnInput): ToolSpec[] {
    const requested = input.availableToolNames ? new Set(input.availableToolNames) : undefined;
    const exposed = this.deps.toolRegistry
      ? this.deps.toolRegistry.resolveLoadout({
        exposures: this.deps.toolSearchEnabled ? ['core', 'domain', 'searchable'] : ['core', 'domain'],
        ...(requested ? { enabledToolNames: [...requested] } : {}),
        ...(input.availableContext ? { availableContext: input.availableContext } : {}),
        maxTools: this.limits.maxToolsPerTurn,
        maxSchemaBytes: this.limits.maxToolSchemaBytes,
      }).tools
      : (this.deps.toolSpecs || []).filter((spec) => spec.enabled !== false && spec.exposure !== 'hidden');
    const byName = new Map<string, ToolSpec>();
    for (const spec of exposed) byName.set(spec.name, spec);
    const builtins: ToolSpec[] = [ASK_USER_TOOL_SPEC, REPLY_PRESENTATION_TOOL_SPEC];
    if (this.deps.enablePlanTool) builtins.push(UPDATE_PLAN_TOOL_SPEC);
    for (const spec of builtins) {
      if (requested && !requested.has(spec.name)) continue;
      if (!byName.has(spec.name)) byName.set(spec.name, spec);
    }
    return [...byName.values()];
  }

  private async appendSteeringMessages(input: AgentTurnInput, working: AgentMessage[], persisted: AgentMessage[]): Promise<void> {
    if (!this.deps.drainSteeringMessages) return;
    const messages = await this.deps.drainSteeringMessages();
    for (const content of messages || []) {
      const text = String(content || '').trim();
      if (!text) continue;
      const message: AgentMessage = { role: 'user', content: text, meta: { steering: true } };
      working.push(message);
      persisted.push(message);
    }
  }

  private appendRepairMessages(working: AgentMessage[], response: AgentModelResponse, validation: AgentModelValidation): void {
    const assistantText = response.assistant.text || (response.raw !== undefined ? safeJson(response.raw, 8000) : '[invalid tool output]');
    if (validation.canStructuredRepair) {
      working.push({
        role: 'assistant',
        content: assistantText,
        toolCalls: validation.calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
        ...(response.finishReason || response.assistant.finishReason ? { finishReason: response.finishReason || response.assistant.finishReason } : {}),
        meta: { internal: true, repair: true },
      });
      for (const call of validation.calls) {
        const error = toolErrorForCall(validation.errors, call.id, call.name);
        working.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: toolErrorResultContent(error),
          isError: true,
          meta: { internal: true, repair: true },
        });
      }
      working.push({
        role: 'user',
        content: buildRepairInstruction(validation.errors),
        meta: { internal: true, repair: true },
      });
      return;
    }
    working.push({
      role: 'assistant',
      content: assistantText,
      ...(response.finishReason || response.assistant.finishReason ? { finishReason: response.finishReason || response.assistant.finishReason } : {}),
      meta: { internal: true, repair: true },
    });
    working.push({
      role: 'user',
      content: buildRepairInstruction(validation.errors),
      meta: { internal: true, repair: true },
    });
  }

  private truncateToolResult(content: string): string {
    const max = Math.max(0, Math.trunc(Number(this.deps.toolResultMaxChars) || 0));
    if (!max || content.length <= max) return content;
    const preview = content.slice(0, max);
    if (!this.deps.spillEnabled || !this.deps.spillDir) {
      return preview + `\n...[tool result truncated: ${content.length - max} chars omitted]`;
    }
    try {
      mkdirSync(this.deps.spillDir, { recursive: true });
      const key = createHash('sha256').update(content).digest('hex').slice(0, 24);
      const file = join(this.deps.spillDir, `tool-result-${key}.txt`);
      writeFileSync(file, content, 'utf8');
      return preview + `\n...[tool result truncated: ${content.length - max} chars omitted; full result: ${file}]`;
    } catch {
      return preview + `\n...[tool result truncated: ${content.length - max} chars omitted]`;
    }
  }
  private limitPinnedFacts(facts: Record<string, unknown>): Record<string, unknown> {
    const max = Math.max(1, Math.trunc(Number(this.deps.maxPinnedFacts) || 0));
    const keys = Object.keys(facts);
    if (!max || keys.length <= max) return facts;
    return Object.fromEntries(keys.slice(-max).map((key) => [key, facts[key]]));
  }

  private appendToolRound(
    working: AgentMessage[],
    persisted: AgentMessage[],
    response: AgentModelResponse,
    calls: ToolCall[],
    results: ToolResult[],
  ): void {
    const assistant: AgentMessage = {
      role: 'assistant',
      content: response.assistant.text || '',
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      ...(response.finishReason || response.assistant.finishReason ? { finishReason: response.finishReason || response.assistant.finishReason } : {}),
    };
    working.push(assistant);
    persisted.push(structuredClone(assistant));
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const result = results[index];
      const message: AgentMessage = {
        role: 'tool',
        toolCallId: result.callId,
        name: result.toolName || call.name,
      content: this.truncateToolResult(serializeToolResult(result)),
        isError: result.ok === false,
      };
      working.push(message);
      persisted.push(structuredClone(message));
    }
  }

  private appendSingleToolRound(
    working: AgentMessage[],
    persisted: AgentMessage[],
    response: AgentModelResponse,
    call: ToolCall,
    result: ToolResult,
  ): void {
    this.appendToolRound(working, persisted, response, [call], [result]);
  }

  private suspendForAskUser(
    input: AgentTurnInput,
    session: AgentSessionState,
    persisted: AgentMessage[],
    budget: TurnBudget,
    call: ToolCall,
  ): AgentTurnResult {
    const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? call.arguments as Record<string, unknown>
      : {};
    const question = String(args.question || '').trim();
    const missingFields = Array.isArray(args.missingFields) ? args.missingFields.map(String).filter(Boolean) : [];
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : [];
    const pendingQuestion: AgentPendingQuestion = {
      toolCallId: call.id,
      question,
      missingFields,
      ...(options.length ? { options } : {}),
      createdAt: this.now(),
    };
    const assistant: AgentMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments }],
    };
    persisted.push(assistant);
    const saved = this.saveSession(session, input, persisted, {
      pendingToolCalls: [{ id: call.id, name: call.name, arguments: call.arguments }],
      pendingQuestion,
    });
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      status: 'suspended',
      text: question,
      messages: saved.messages,
      pendingQuestion,
      usage: this.finalUsage(budget),
      meta: { reason: 'ask_user', question, missingFields, options },
    };
  }

  private pendingJobsFromResults(results: ToolResult[], input: AgentTurnInput): AgentJobRecord[] {
    return results
      .filter((result) => result.pending && result.jobId)
      .map((result) => ({
        jobId: String(result.jobId),
        status: result.meta?.queued === true ? 'queued' as const : 'running' as const,
        toolName: result.toolName || 'unknown',
        callId: result.callId,
        configRevision: input.configRevision,
        createdAt: this.now(),
        updatedAt: this.now(),
        meta: {
          ...(result.meta || {}),
          ...(String(input.userText || '').trim() ? { originalUserText: String(input.userText).slice(0, 6000) } : {}),
          ...(input.attachments?.length ? { originalAttachments: input.attachments } : {}),
          ...(input.replyPreference ? { originalReplyPreference: input.replyPreference } : {}),
          ...(typeof input.metadata?.replyPreferenceSessionKey === 'string' ? { originalReplyPreferenceSessionKey: input.metadata.replyPreferenceSessionKey } : {}),
          ...(typeof input.metadata?.requestId === 'string' ? { requestId: input.metadata.requestId } : {}),
        },
      }));
  }

  private async safeTextOrFailure(options: {
    input: AgentTurnInput;
    mode: Exclude<AgentRuntimeMode, 'off'>;
    signal: AbortSignal;
    budget: TurnBudget;
    workingMessages: AgentMessage[];
    persistedMessages: AgentMessage[];
    session: AgentSessionState;
    availableToolNames: string[];
    toolResults?: AgentToolResult[];
    reason: string;
    repairLimits: OutputRepairLimits;
    deadlineAt?: number;
  }): Promise<AgentTurnResult> {
    const { input, signal, budget, workingMessages, persistedMessages, session, reason } = options;
    if (!options.repairLimits.allowTextFallback || budget.modelRounds >= this.limits.maxModelRounds || budget.remainingTokens <= 0) {
      return {
        ...this.failedResult(input, reason, 'Tool output repair or loop budget was exhausted.'),
        usage: this.finalUsage(budget),
        ...(options.toolResults?.length ? { toolResults: options.toolResults } : {}),
      };
    }
    this.throwIfStopped(input, signal);
    workingMessages.push({
      role: 'user',
      content: buildSafeTextInstruction(reason),
      meta: { internal: true, safeTextFallback: true },
    });
    let response: AgentModelResponse;
    try {
      response = await this.deps.model.chat({
        model: this.deps.mainModel,
        ...(this.deps.nodeIndex !== undefined ? { nodeIndex: this.deps.nodeIndex } : {}),
        messages: workingMessages.map((message) => structuredClone(message)),
        tools: [],
        toolChoice: 'none',
        maxTokens: Math.max(1, Math.min(budget.remainingTokens, this.limits.maxTokens)),
        temperature: 0,
        signal,
        purpose: 'safe-text',
        timeoutMs: Math.max(1, (options.deadlineAt || Date.now() + this.limits.turnTimeoutMs) - Date.now()),
      });
    } catch (error) {
      return {
        ...this.failedResult(input, reason, error instanceof Error ? error.message : String(error)),
        usage: this.finalUsage(budget),
        ...(options.toolResults?.length ? { toolResults: options.toolResults } : {}),
      };
    }
    this.consumeModelUsage(response, budget);
    const text = String(response.assistant.text || '').trim();
    if (response.truncated || response.toolCallIssues?.length || response.assistant.toolCalls?.length || !text) {
      return {
        ...this.failedResult(input, reason, 'Safe text fallback did not produce plain text.'),
        usage: this.finalUsage(budget),
        ...(options.toolResults?.length ? { toolResults: options.toolResults } : {}),
      };
    }
    const assistant: AgentMessage = { role: 'assistant', content: text };
    persistedMessages.push(assistant);
    const saved = this.saveSession(session, input, persistedMessages, {});
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      status: 'completed',
      text,
      messages: saved.messages,
      ...(options.toolResults?.length ? { toolResults: options.toolResults } : {}),
      usage: this.finalUsage(budget),
      meta: { reason: 'safe_text_fallback', repairReason: reason, safeTextFallback: true },
    };
  }

  private completeWithText(
    input: AgentTurnInput,
    session: AgentSessionState,
    persistedMessages: AgentMessage[],
    budget: TurnBudget,
    text: string,
    workingMessages: AgentMessage[],
    toolResults: AgentToolResult[],
    turnReplyPreference?: AgentReplyPreference,
  ): AgentTurnResult {
    const assistant: AgentMessage = { role: 'assistant', content: text };
    workingMessages.push(assistant);
    persistedMessages.push(assistant);
    // P1-A（R10 修复）：scope=turn 的偏好只属于当前 turn——不写进 session（写进会让下一轮
    // AgentHost 把它当 sessionPreference 读出，跨轮泄漏）；session/user scope 的持久化
    // 由 AgentHost 的 preference store 负责。TurnResult.replyPreference 仅用于当轮回传。
    const persistentPreference = turnReplyPreference && turnReplyPreference.scope !== 'turn' ? turnReplyPreference : undefined;
    const saved = this.saveSession(session, input, persistedMessages, persistentPreference ? { replyPreference: persistentPreference } : {});
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      status: 'completed',
      text,
      messages: saved.messages,
      ...(toolResults.length ? { toolResults } : {}),
      ...(turnReplyPreference ? { replyPreference: turnReplyPreference } : {}),
      usage: this.finalUsage(budget),
    };
  }

  private saveSession(
    session: AgentSessionState,
    input: AgentTurnInput,
    messages: AgentMessage[],
    overrides: Partial<AgentSessionState>,
  ): AgentSessionState {
    const next: AgentSessionState = {
      ...session,
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      messages: messages.filter((message) => !isInternalMessage(message)).map((message) => structuredClone(message)),
      pinnedFacts: this.limitPinnedFacts({ ...(session.pinnedFacts || {}), ...(input.pinnedFacts || {}) }),
      artifacts: session.artifacts || [],
      configRevision: input.configRevision,
      runtimeVersion: input.runtimeVersion,
      ...(input.replyPreference ? { replyPreference: input.replyPreference } : {}),
      pendingToolCalls: 'pendingToolCalls' in overrides ? overrides.pendingToolCalls : session.pendingToolCalls,
      pendingApprovals: 'pendingApprovals' in overrides ? overrides.pendingApprovals : session.pendingApprovals,
      pendingJobs: 'pendingJobs' in overrides ? overrides.pendingJobs : session.pendingJobs,
      pendingQuestion: 'pendingQuestion' in overrides ? overrides.pendingQuestion : session.pendingQuestion,
      updatedAt: this.now(),
      ...overrides,
    };
    return this.deps.sessions.save(next);
  }

  private consumeModelUsage(response: AgentModelResponse, budget: TurnBudget): void {
    budget.modelRounds += 1;
    const usage = response.usage || response.assistant.usage || {};
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cost'] as const) {
      const value = Number(usage[key]);
      if (Number.isFinite(value) && value >= 0) {
        (budget.usage as Record<string, number>)[key] = Number((budget.usage as Record<string, number>)[key] || 0) + value;
      }
    }
    const completion = Number(usage.completionTokens);
    const total = Number(usage.totalTokens);
    const consumed = Number.isFinite(completion) && completion > 0
      ? completion
      : Number.isFinite(total) && total > 0
        ? total
        : Math.max(1, estimateTokens(JSON.stringify(response.assistant || {})));
    budget.remainingTokens = Math.max(0, budget.remainingTokens - consumed);
  }

  private finalUsage(budget: TurnBudget): AgentUsage {
    return {
      ...budget.usage,
      modelRounds: budget.modelRounds,
      toolRounds: budget.toolRounds,
    };
  }

  private throwIfStopped(input: AgentTurnInput, signal: AbortSignal): void {
    if (signal.aborted || input.signal?.aborted || this.deps.shouldStop?.()) throw new AgentAbortError();
  }

  private suspendedResult(options: {
    input: AgentTurnInput;
    session: AgentSessionState;
    messages: AgentMessage[];
    budget: TurnBudget;
    meta: Record<string, unknown>;
    errorCode: string;
    errorMessage: string;
  }): AgentTurnResult {
    const saved = this.saveSession(options.session, options.input, options.messages, {});
    return {
      sessionKey: options.input.sessionKey,
      turnId: options.input.turnId,
      status: 'suspended',
      messages: saved.messages,
      usage: this.finalUsage(options.budget),
      error: { code: options.errorCode, message: options.errorMessage },
      meta: options.meta,
    };
  }

  private partialToolText(toolResults: AgentToolResult[]): string {
    const parts: string[] = [];
    for (const result of toolResults || []) {
      if (result.ok === false) continue;
      const text = [
        String(result.content || '').trim(),
        ...(result.outputs || []).flatMap((output) => [
          String(output.text || '').trim(),
          output.url ? String(output.url) : '',
        ]),
      ].map((part) => stripInlineImagePayloads(part)).filter(Boolean).join('\n');
      if (!text) continue;
      parts.push('[' + String(result.toolName || result.callId || 'tool') + ']\n' + text);
    }
    return parts.join('\n\n').slice(0, 12_000);
  }

  private async finalizeTimedOut(input: AgentTurnInput, state: TurnExecutionState, reason: string): Promise<AgentTurnResult> {
    const usage = this.finalUsage(state.budget);
    const toolResults = state.toolResults || [];
    const context = this.partialToolText(toolResults);
    if (!context) {
      return this.failedResult(input, reason, 'Agent turn timed out before any usable tool result was produced.', { usage, toolResults });
    }
    const finalizeTimeoutMs = Math.max(500, Math.min(this.limits.finalizeTimeoutMs, Math.floor(this.limits.turnTimeoutMs / 4)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), finalizeTimeoutMs);
    try {
      const response = await this.deps.model.chat({
        model: this.deps.mainModel,
        ...(this.deps.nodeIndex !== undefined ? { nodeIndex: this.deps.nodeIndex } : {}),
        messages: [
          { role: 'user', content: [
            '本轮执行超过了时间预算。不要调用工具，不要继续搜索。',
            '请只根据下面已经完成的工具结果，用用户使用的语言给出简洁、诚实的部分回答。',
            '如果结果不足以回答，明确说明还缺什么；不要编造。',
            '',
            '用户请求：' + String(input.userText || '').slice(0, 2_000),
            '',
            '已完成工具结果：',
            context,
          ].join('\n') },
        ],
        tools: [],
        toolChoice: 'none',
        maxTokens: 1_200,
        temperature: 0,
        signal: controller.signal,
        purpose: 'safe-text',
        timeoutMs: finalizeTimeoutMs,
      });
      const text = String(response.assistant.text || '').trim();
      if (text && !response.truncated && !response.assistant.toolCalls?.length) {
        const session = this.deps.sessions.load(input.sessionKey);
        const messages = session?.messages ? [...session.messages, { role: 'assistant' as const, content: text }] : undefined;
        if (session && messages) this.saveSession(session, input, messages, {});
        return {
          sessionKey: input.sessionKey,
          turnId: input.turnId,
          status: 'completed',
          text,
          toolResults,
          usage,
          meta: { reason: 'timeout_partial', timedOut: true, partial: true, safeTextFallback: false },
        };
      }
    } catch {
      // fall through to the deterministic partial result below
    } finally {
      clearTimeout(timer);
    }
    const fallback = '时间限制前没能整理成完整回答。已经查到的内容：\n\n' + context;
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      status: 'completed',
      text: fallback.slice(0, 12_000),
      toolResults,
      usage,
      meta: { reason: 'timeout_partial_deterministic', timedOut: true, partial: true, safeTextFallback: false },
    };
  }

  private failedResult(input: AgentTurnInput, code: string, message: string, extra: Partial<AgentTurnResult> = {}): AgentTurnResult {
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      status: 'failed',
      error: { code, message, retryable: false },
      ...extra,
    };
  }

  private cancelledResult(input: AgentTurnInput, code: string): AgentTurnResult {
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      status: 'cancelled',
      error: { code, message: 'Agent turn was cancelled.' },
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

export function createAgentRuntime(dependencies: AgentLoopDependencies): AgentRuntime {
  return new AgentRuntime(dependencies);
}

export function isAgentRuntimeEnabled(flag: Partial<AgentFeatureFlag> | undefined | null): boolean {
  if (!flag || flag.enabled !== true) return false;
  return flag.mode === 'shadow' || flag.mode === 'enforce';
}

export function resolveAgentRuntimeMode(flag: Partial<AgentFeatureFlag> | undefined | null): AgentRuntimeMode {
  if (!flag || flag.enabled !== true) return 'off';
  return flag.mode === 'shadow' || flag.mode === 'enforce' ? flag.mode : DEFAULT_AGENT_FEATURE_FLAG.mode;
}

function normalizeLoopLimits(input: Partial<AgentLoopLimits> = {}): AgentLoopLimits {
  return {
    maxModelRounds: intIn(input.maxModelRounds, DEFAULT_AGENT_LOOP_LIMITS.maxModelRounds, 1, 100),
    maxToolRounds: intIn(input.maxToolRounds, DEFAULT_AGENT_LOOP_LIMITS.maxToolRounds, 0, 200),
    maxParallelTools: intIn(input.maxParallelTools, DEFAULT_AGENT_LOOP_LIMITS.maxParallelTools, 1, 32),
    maxToolCallsPerRound: intIn(input.maxToolCallsPerRound, DEFAULT_AGENT_LOOP_LIMITS.maxToolCallsPerRound, 1, 100),
    maxTokens: intIn(input.maxTokens, DEFAULT_AGENT_LOOP_LIMITS.maxTokens, 1, 1_000_000),
    turnTimeoutMs: intIn(input.turnTimeoutMs, DEFAULT_AGENT_LOOP_LIMITS.turnTimeoutMs, 100, 3_600_000),
      finalizeTimeoutMs: intIn(input.finalizeTimeoutMs, DEFAULT_AGENT_LOOP_LIMITS.finalizeTimeoutMs, 500, 120_000),
    maxToolsPerTurn: intIn(input.maxToolsPerTurn, DEFAULT_AGENT_LOOP_LIMITS.maxToolsPerTurn, 1, 128),
    maxToolSchemaBytes: intIn(input.maxToolSchemaBytes, DEFAULT_AGENT_LOOP_LIMITS.maxToolSchemaBytes, 1_024, 1_000_000),
  };
}

function normalizeRepairConfig(input: Partial<OutputRepairLimits> = {}): OutputRepairLimits {
  return {
    maxProtocolRepairs: intIn(input.maxProtocolRepairs, DEFAULT_OUTPUT_REPAIR_LIMITS.maxProtocolRepairs, 0, 20),
    maxSchemaRepairsPerCall: intIn(input.maxSchemaRepairsPerCall, DEFAULT_OUTPUT_REPAIR_LIMITS.maxSchemaRepairsPerCall, 0, 20),
    maxTotalOutputRepairs: intIn(input.maxTotalOutputRepairs, DEFAULT_OUTPUT_REPAIR_LIMITS.maxTotalOutputRepairs, 0, 40),
    maxRepeatedErrorCount: intIn(input.maxRepeatedErrorCount, DEFAULT_OUTPUT_REPAIR_LIMITS.maxRepeatedErrorCount, 1, 20),
    repairTemperature: numberIn(input.repairTemperature, DEFAULT_OUTPUT_REPAIR_LIMITS.repairTemperature, 0, 1),
    allowTextFallback: typeof input.allowTextFallback === 'boolean' ? input.allowTextFallback : DEFAULT_OUTPUT_REPAIR_LIMITS.allowTextFallback,
  };
}

function ensureBatchResults(calls: ToolCall[], results: ToolResult[]): ToolResult[] {
  return calls.map((call, index) => results[index] || {
    callId: call.id,
    toolName: call.name,
    ok: false,
    error: makeToolError({
      code: 'tool_execution_failed',
      message: 'Tool executor returned no result for this call.',
      callId: call.id,
      toolName: call.name,
    }),
  });
}

function serializeToolResult(result: ToolResult): string {
  try {
    return JSON.stringify(sanitizeStructuredPayload({
      callId: result.callId,
      ...(result.toolName ? { toolName: result.toolName } : {}),
      ok: result.ok,
      ...(result.content !== undefined ? { content: result.content } : {}),
      ...(result.outputs ? { outputs: result.outputs } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.jobId ? { jobId: result.jobId } : {}),
      ...(result.pending ? { pending: true } : {}),
    }));
  } catch {
    return JSON.stringify({ callId: result.callId, ok: result.ok, error: { code: 'tool_execution_failed', message: 'Result was not serializable.' } });
  }
}

function approvalFromToolResult(result: ToolResult, calls: ToolCall[], now: string): AgentApprovalRecord | undefined {
  const raw = result.error?.details?.approval;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.approvalId && record.payloadHash) {
      return {
        approvalId: String(record.approvalId),
        status: 'pending',
        toolName: String(record.toolName || result.toolName || 'unknown'),
        ...(result.callId ? { callId: result.callId } : {}),
        payloadHash: String(record.payloadHash),
        createdAt: String(record.createdAt || now),
        ...(record.expiresAt ? { expiresAt: String(record.expiresAt) } : {}),
      };
    }
  }
  // Never fabricate an approval record. R5 must provide a real payload hash and
  // persisted approval checkpoint through the preflight/approval layer.
  void calls;
  void now;
  return undefined;
}

function toolErrorToTurnError(error: ToolError): { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> } {
  return {
    code: error.code,
    message: error.message,
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.details ? { details: error.details } : {}),
  };
}

function isInternalMessage(message: AgentMessage): boolean {
  return message.role !== 'system' && Boolean((message as { meta?: Record<string, unknown> }).meta?.internal);
}

function safeJson(value: unknown, maxChars: number): string {
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function intIn(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
function approvalPayloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}
