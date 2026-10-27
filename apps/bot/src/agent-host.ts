import { createHash, randomUUID } from 'node:crypto';
import {
  AgentRuntime,
  InMemoryAgentSessionManager,
  PromptRegistry,
  type AgentRuntimeMode,
  type AgentApprovalResolver,
  type AgentReplyPreference,
  type AgentJobResolver,
  type AgentTurnResult,
  type AgentTurnStatus,
  type AgentToolPreflight,
  type AgentToolResult,
} from '../../../packages/agent-runtime/src/index.js';
import { ToolExecutor, ToolRegistry } from '../../../packages/tool-runtime/src/index.js';
import type { ReplyPreferenceStore } from './reply-preference-store.js';
import { InMemoryToolIdempotencyStore, type ToolHandler, type ToolIdempotencyStore, type ToolSpec } from '../../../packages/tool-runtime/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { createAgentModelPort } from './agent-model-port.js';
import { buildReplyPlan, resolveReplyPolicy, textCharsOf, type ExecutionOutput, type ReplyPlan } from '../../../packages/orchestration/src/index.js';
import { ARTIFACT_CAPABILITY_TOOLS, MIGRATED_CAPABILITY_TOOLS, READ_ONLY_CAPABILITY_TOOLS, SIDE_EFFECT_CAPABILITY_TOOLS, type CapabilityToolBinding } from './capability-tool-adapter.js';

export interface AgentHostInput {
  text: string;
  chatType: 'group' | 'private';
  groupId?: string | number;
  userId?: string | number;
  images?: string[];
    videos?: string[];
    audios?: string[];
  files?: Array<Record<string, unknown>>;
  referencedText?: string;
    forwardText?: string;
  groupContext?: string;
  memoryContext?: string;
  sessionId?: string;
  requestId?: string;
  userRole?: 'guest' | 'user' | 'admin' | 'owner';
  replyPreference?: AgentReplyPreference;
  userReplyPreference?: AgentReplyPreference;
}

export interface AgentHostOutcome {
  mode: AgentRuntimeMode;
  status: AgentTurnStatus | 'disabled';
  handled: boolean;
  text?: string;
  reason?: string;
  turn?: AgentTurnResult;
  replyPlan?: ReplyPlan;
  terminal?: boolean;
  /** R11：异步挂起静默吸收——runtime 不发送任何内容（也不算失败），结果由 resume 通道送达。 */
  silent?: boolean;
}

export interface AgentHostOptions {
  getConfig: () => AppConfig;
  client: Pick<ModelClient, 'chat'>;
  logger?: StructuredLogger;
  sessions?: InMemoryAgentSessionManager;
  idempotencyStore?: ToolIdempotencyStore;
  replyPreferenceStore?: ReplyPreferenceStore;
  toolBindings?: () => CapabilityToolBinding[];
  preflightToolCall?: AgentToolPreflight;
  resolveApproval?: AgentApprovalResolver;
  resolveJob?: AgentJobResolver;
  isReadOnlyTool?: (name: string) => boolean;
  isMigratedTool?: (name: string) => boolean;
  spillDir?: string;
  clock?: () => Date;
}
export function createAgentHost(options: AgentHostOptions): (input: AgentHostInput) => Promise<AgentHostOutcome> {
  const sessions = options.sessions || new InMemoryAgentSessionManager({ clock: options.clock });
  const sessionLocks = new Map<string, Promise<void>>();
  const acquireSessionLock = async (sessionKey: string): Promise<() => void> => {
    const previous = sessionLocks.get(sessionKey) || Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    sessionLocks.set(sessionKey, tail);
    await previous.catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (sessionLocks.get(sessionKey) === tail) sessionLocks.delete(sessionKey);
    };
  };
  const clock = options.clock || (() => new Date());
  return async (input: AgentHostInput): Promise<AgentHostOutcome> => {
    let sideEffectExecuted = false;
    const sideEffectResults: AgentToolResult[] = [];
    const cfg = options.getConfig();
    const mode = resolveHostMode(cfg);
    if (mode === 'off') return { mode, status: 'disabled', handled: false, reason: 'agent_runtime_disabled' };

    const registry = new ToolRegistry();
    const executor = new ToolExecutor({
      registry,
      idempotencyStore: options.idempotencyStore || new InMemoryToolIdempotencyStore(),
      defaultTimeoutMs: cfg.toolRegistry.defaultTimeoutMs,
      defaultMaxRetries: cfg.toolRegistry.defaultMaxRetries,
      defaultMaxConcurrency: cfg.toolRegistry.defaultMaxConcurrency,
    });
    const bindings = new Map<string, CapabilityToolBinding>();
    for (const binding of options.toolBindings?.() || []) bindings.set(binding.spec.name, binding);
    for (const binding of bindings.values()) {
      registry.register(binding.spec);
      const originalHandler = binding.handler;
      executor.registerHandler(binding.spec.name, async (call, spec, context) => {
        const sideEffectTool = SIDE_EFFECT_CAPABILITY_TOOLS.has(binding.spec.name);
        if (sideEffectTool) sideEffectExecuted = true;
        const result = await originalHandler(call, spec, context);
        if (sideEffectTool && result.ok !== false && result.outputs?.length) {
          sideEffectResults.push({
            callId: call.id,
            toolName: spec.name,
            ok: true,
            content: result.content,
            outputs: result.outputs,
            ...(result.jobId ? { jobId: result.jobId } : {}),
            ...(result.pending ? { pending: true } : {}),
            meta: result.meta,
          });
        }
        return result;
      });
    }
    const modelPort = createAgentModelPort(options.client, {
      timeoutMs: cfg.agent.timeoutMs,
      reasoningEffort: cfg.agent.reasoningEffort as any,
      ...(cfg.agent.fallbackNodeIndex !== undefined ? { fallbackNodeIndex: cfg.agent.fallbackNodeIndex } : {}),
      ...(cfg.agent.fallbackModel ? { fallbackModel: cfg.agent.fallbackModel } : {}),
    });
    const promptRegistry = new PromptRegistry();
    promptRegistry.register({
      id: 'miobot-base',
      title: 'Miobot base prompt',
      content: buildAgentSystemPrompt(cfg),
      version: 'r5',
      status: 'active',
      order: 10,
    });
    const runtime = new AgentRuntime({
      model: modelPort,
      sessions,
      mainModel: cfg.agent.mainModel || cfg.llm.chatModel,
      nodeIndex: cfg.agent.mainNodeIndex ?? cfg.llm.chatNodeIndex,
      temperature: cfg.agent.temperature,
      featureFlag: { enabled: true, mode },
      promptRegistry,
      toolRegistry: registry,
      toolExecutor: executor,
      ...(options.preflightToolCall ? { preflightToolCall: options.preflightToolCall } : {}),
      ...(options.resolveApproval ? { resolveApproval: options.resolveApproval } : {}),
      ...(options.resolveJob ? { resolveJob: options.resolveJob } : {}),
      enablePlanTool: false,
      toolSearchEnabled: cfg.toolRegistry.toolSearchEnabled,
      contextMaxChars: cfg.contextPolicy.compactionEnabled ? Math.min(cfg.contextPolicy.historyMaxChars, cfg.contextPolicy.compactionThresholdTokens * 3) : cfg.contextPolicy.historyMaxChars,
      compactionEnabled: cfg.contextPolicy.compactionEnabled,
      toolResultMaxChars: cfg.contextPolicy.toolResultMaxChars,
      spillEnabled: cfg.contextPolicy.spillEnabled,
      ...(options.spillDir ? { spillDir: options.spillDir } : {}),
      maxPinnedFacts: cfg.contextPolicy.pinnedFactsMaxItems,
      limits: {
        maxModelRounds: cfg.agent.maxModelRounds,
        maxToolRounds: cfg.agent.maxToolRounds,
        maxParallelTools: Math.min(cfg.agent.maxParallelTools, cfg.toolRegistry.defaultMaxConcurrency),
        maxToolCallsPerRound: Math.max(1, cfg.toolRegistry.maxToolsPerTurn),
        maxTokens: cfg.agent.maxTokens,
        turnTimeoutMs: cfg.agent.turnTimeoutMs,
        maxToolsPerTurn: cfg.toolRegistry.maxToolsPerTurn,
        maxToolSchemaBytes: cfg.toolRegistry.maxToolSchemaBytes,
      },
      repairLimits: {
        maxProtocolRepairs: cfg.agent.repair.maxProtocolRepairs,
        maxSchemaRepairsPerCall: cfg.agent.repair.maxSchemaRepairsPerCall,
        maxTotalOutputRepairs: cfg.agent.repair.maxTotalOutputRepairs,
        maxRepeatedErrorCount: cfg.agent.repair.maxRepeatedErrorCount,
        repairTemperature: cfg.agent.repair.repairTemperature,
        allowTextFallback: cfg.agent.repair.allowTextFallback,
      },
      clock,
    });

    const sessionKey = input.sessionId || (input.chatType === 'group'
      ? `group:${input.groupId ?? 'unknown'}:${input.userId ?? 'unknown'}`
      : `private:${input.userId ?? 'unknown'}`);
    const priorSession = sessions.load(sessionKey);
    const requestedScope = input.replyPreference?.scope || 'session';
    const effectiveScope = requestedScope === 'user' && !input.userId ? 'session' : requestedScope;
    const userPreferenceKey = String(input.userId ?? '');
    if (input.replyPreference && options.replyPreferenceStore) {
      if (effectiveScope === 'session' && cfg.replyPolicy.allowSessionPreferences) {
        options.replyPreferenceStore.set('session', sessionKey, input.replyPreference, cfg.replyPolicy.sessionPreferenceTtlMs);
      } else if (effectiveScope === 'user' && userPreferenceKey && cfg.replyPolicy.allowUserPreferences) {
        options.replyPreferenceStore.set('user', userPreferenceKey, input.replyPreference, cfg.replyPolicy.userPreferenceTtlMs);
      }
    }
    const storedSessionPreference = options.replyPreferenceStore?.get('session', sessionKey);
    const storedUserPreference = options.replyPreferenceStore && userPreferenceKey
      ? options.replyPreferenceStore.get('user', userPreferenceKey)
      : undefined;
    // P1-A（R10 修复）：上一轮写进 session 的 replyPreference 只有 scope=session/user（持久语义）
    // 才能当 sessionPreference 读取；scope=turn 的残留一律丢弃，防止跨轮泄漏。
    const priorSessionPreference = priorSession?.replyPreference && priorSession.replyPreference.scope !== 'turn'
      ? priorSession.replyPreference
      : undefined;
    const effectiveSessionPreference = storedSessionPreference
      || (effectiveScope === 'session' ? input.replyPreference : undefined)
      || priorSessionPreference;
    const effectiveUserPreference = storedUserPreference
      || (effectiveScope === 'user' ? input.replyPreference : undefined)
      || input.userReplyPreference;
    const replyPreferences: { turnPreference?: AgentReplyPreference; sessionPreference?: AgentReplyPreference; userPreference?: AgentReplyPreference } = {
      ...(effectiveScope === 'turn' && input.replyPreference ? { turnPreference: input.replyPreference } : {}),
      ...(effectiveSessionPreference ? { sessionPreference: effectiveSessionPreference } : {}),
      ...(effectiveUserPreference ? { userPreference: effectiveUserPreference } : {}),
    };
    const runtimeSessionPreference = effectiveSessionPreference;
    const attachments = [
      ...(input.images || []).filter(Boolean).map((ref) => ({ kind: 'image' as const, ref })),
        ...(input.videos || []).filter(Boolean).map((ref) => ({ kind: 'video' as const, ref })),
        ...(input.audios || []).filter(Boolean).map((ref) => ({ kind: 'audio' as const, ref })),
      ...(input.files || []).flatMap((file) => {
        const ref = String(file.url || file.file || file.path || '').trim();
        if (!ref) return [];
        return [{
          kind: 'file' as const,
          ref,
          ...(file.name ? { name: String(file.name) } : {}),
        }];
      }),
    ];
    const availableContext = [
      ...(input.images?.length ? ['image' as const] : []),
        ...(input.videos?.length ? ['video' as const] : []),
        ...(input.audios?.length ? ['audio' as const] : []),
      ...(input.files?.length ? ['file' as const] : []),
      ...(input.referencedText ? ['quote' as const] : []),
      ...(input.forwardText ? ['forward' as const] : []),
    ];
    const turnInput = {
      sessionKey,
      turnId: `agent_${randomUUID()}`,
      userText: [input.text, input.referencedText ? '【引用消息】' + '\n' + input.referencedText : '', input.forwardText ? '【合并转发内容】' + '\n' + input.forwardText : ''].filter(Boolean).join('\n\n'),
      attachments,
      configRevision: configRevisionFor(cfg),
      runtimeVersion: 'r5-agent-loop',
      availableContext,
      toolChoice: cfg.agent.toolChoice,
      ...(runtimeSessionPreference ? { replyPreference: runtimeSessionPreference } : {}),
      metadata: {
        ...(input.groupContext ? { groupContext: input.groupContext } : {}),
        ...(input.memoryContext ? { memoryContext: input.memoryContext } : {}),
        ...(input.referencedText ? { referencedText: input.referencedText } : {}),
        ...(input.forwardText ? { forwardText: input.forwardText } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        chatType: input.chatType,
        ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.userRole ? { userRole: input.userRole } : {}),
        userText: input.text,
        attachments,
      },
    };
    let turn: AgentTurnResult;
    const releaseSession = await acquireSessionLock(sessionKey);
    try {
      try {
        turn = await runtime.runTurn(turnInput);
      } catch (error) {
        if (sideEffectExecuted) {
          return {
            mode,
            status: 'failed',
            handled: true,
            terminal: true,
            replyPlan: buildAgentReplyPlan(cfg, toolResultsToReplyOutputs(sideEffectResults, cfg), replyPreferences),
            reason: 'agent_side_effect_terminal',
          };
        }
        throw error;
      }
    } finally {
      releaseSession();
    }

    // P0-2：presentation 工具产生的偏好按 scope 落库：
    // turn —— 仅本次 buildReplyPlan 生效（不入 store）；
    // session/user —— 写 ReplyPreferenceStore，与后台偏好 API 同一存储。
    const turnPreference = turn.replyPreference;
    if (turnPreference && options.replyPreferenceStore) {
      const scope = turnPreference.scope || 'turn';
      if (scope === 'session' && cfg.replyPolicy.allowSessionPreferences) {
        options.replyPreferenceStore.set('session', sessionKey, turnPreference, cfg.replyPolicy.sessionPreferenceTtlMs);
      } else if (scope === 'user' && userPreferenceKey && cfg.replyPolicy.allowUserPreferences) {
        options.replyPreferenceStore.set('user', userPreferenceKey, turnPreference, cfg.replyPolicy.userPreferenceTtlMs);
      }
    }
    const collectedResults = turn.toolResults?.length ? turn.toolResults : sideEffectResults;
    const executedToolNames = Array.from(new Set(collectedResults.map((result) => result.toolName).filter(Boolean).map(String)));
    // P1-B（R10 修复）：已迁移判定不再看静态 MIGRATED_CAPABILITY_TOOLS 白名单（MCP/插件/
    // session.clear 等动态工具会因此 handoff 失败）。判定依据 = 本轮 toolBindings 里真的存在
    // 该工具的 handler（能被执行的工具必然在 bindings/registry 里），可由注入方显式覆盖。
    const isMigrated = options.isMigratedTool || ((name: string) => bindings.has(name));
    const onlyMigratedTools = executedToolNames.length === 0 || executedToolNames.every((name) => isMigrated(name));
    const sideEffectToolExecuted = sideEffectExecuted || executedToolNames.some((name) => SIDE_EFFECT_CAPABILITY_TOOLS.has(name));
    const turnText = String(turn.text || '').trim();
    const approvalHandoff = mode === 'enforce' && turn.status === 'suspended' && Boolean(turn.pendingApproval);
    const jobHandoff = mode === 'enforce' && turn.status === 'suspended' && Boolean(turn.pendingJob);
    // R11（生产问题修复）：异步挂起不再向用户发送任何固定状态文案——多步异步任务每挂起
    // 一次就回填一次「任务已提交…」并被 auto-TTS 成语音，用户连收几条重复语音。挂起一律
    // 静默吸收（silent），结果由 job 完成时的 resume 通道统一送达。审批提示保留（可感知）。
    const finalText = turnText || (approvalHandoff ? '该操作需要管理员审批，已提交审批，请等待结果。' : '');
    const artifactOutputs = toolResultsToReplyOutputs(collectedResults, cfg);
    const effectiveReplyPreferences: { turnPreference?: AgentReplyPreference; sessionPreference?: AgentReplyPreference; userPreference?: AgentReplyPreference } = {
      ...replyPreferences,
      ...(turnPreference ? { turnPreference } : {}),
    };
    const replyPlan = buildAgentReplyPlan(cfg, [
      ...artifactOutputs,
      ...(finalText ? [{ kind: 'text' as const, text: finalText, priority: 10, mergeable: true } as ExecutionOutput] : []),
    ], effectiveReplyPreferences);
    const normalHandoff = mode === 'enforce'
      && turn.status === 'completed'
      && Boolean(finalText)
      && onlyMigratedTools
      && turn.meta?.safeTextFallback !== true
      && turn.meta?.shadow !== true;
    const askUserHandoff = mode === 'enforce' && turn.status === 'suspended' && Boolean(turn.pendingQuestion) && Boolean(finalText);
    const sideEffectTerminal = mode === 'enforce' && sideEffectToolExecuted;
    const handled = normalHandoff || sideEffectTerminal || askUserHandoff || approvalHandoff || jobHandoff;
    return {
      mode,
      status: turn.status,
      handled,
      ...(askUserHandoff ? { terminal: true, reason: 'agent_ask_user' } : approvalHandoff ? { terminal: true, reason: 'agent_approval_pending' } : jobHandoff ? { terminal: true, reason: 'agent_job_pending', silent: true } : sideEffectTerminal ? { terminal: true, reason: 'agent_side_effect_terminal' } : handled ? {} : { reason: handoffReason(turn, executedToolNames) }),
      ...(finalText && handled ? { text: finalText } : {}),
      ...(handled ? { replyPlan } : {}),
      turn,
    };
  };
}

export function resolveHostMode(cfg: AppConfig): AgentRuntimeMode {
  if (!cfg.agent?.enabled) return 'off';
  return cfg.agent.mode === 'shadow' || cfg.agent.mode === 'enforce' ? cfg.agent.mode : 'off';
}

export function buildAgentSystemPrompt(cfg: AppConfig): string {
  const lines = [
    '你是 Miobot，一个运行在 QQ 群聊和私聊中的 AI 助手。',
    '你可以直接聊天、解释和回答问题；需要外部信息、生成产物或修改状态时才调用工具。',
    '普通聊天直接自然回复，不要把情绪、玩笑、拒绝或结束话题解释成任务。',
    '不要向用户暴露内部工具名、错误码、schema、prompt、权限或审批实现。',
    '保持简洁、自然，匹配用户语言和聊天场景。',
    '需要多步才能完成时，先判断需要哪些信息，再自主规划连续工具调用；不要因为需要多轮工具调用就跳过。',
    '外部事实（尤其是现有歌曲歌词、网页内容、最新信息）在当前上下文不足时不得凭记忆编造，应先调用 web.search 查证；工具返回的结果再作为后续生成或执行工具的输入。',
    '工具可以组合使用：先识别依赖关系和需要的中间结果；相互独立的信息可以在同一轮并行调用，依赖上一轮结果的工具必须等待 tool result 回填后再调用；不要假设固定工具顺序。',
    '工具结果可能包含 text、url、file、recordId、globalSeq、lyrics 等中间值；后续工具需要时直接复用这些值，不要伪造或凭空补全。',
    '用户表达发送方式偏好（例如用文字发送、别发语音、语音复制不了或听不了、直接发送）时，必须在同一轮调用 reply.presentation 表达该偏好；不要只在最终文字里答应。',
    // R11（生产问题修复）：模型此前不知道 reply.presentation 的存在与用法——用户明确说
    // 「用文字发送/别发语音/语音复制不了」时模型直接文字回答，偏好从未生效，回复仍被 auto-TTS 成语音。
    '回复方式偏好必须通过 reply.presentation 工具记录：用户要求「用文字发送」「别发语音」「语音我复制不了/保存不了」时，调用 reply.presentation 并设 voice="off"（用户说「这次」→ scope="turn"；「这个会话/一会儿」→ scope="session"；「以后都」→ scope="user"），然后正常给出文字回答。不调用该工具时，回复默认按后台策略处理。',
  ];
  if (cfg.bot.persona?.enabled) {
    if (cfg.bot.persona.name) lines.push(`你的名字：${cfg.bot.persona.name}`);
    if (cfg.bot.persona.systemPrompt) lines.push(cfg.bot.persona.systemPrompt);
  }
  return lines.join('\n');
}

function handoffReason(turn: AgentTurnResult, executedToolNames: string[]): string {
  if (turn.status !== 'completed') return `agent_turn_${turn.status}`;
  if (turn.meta?.safeTextFallback === true) return 'agent_safe_text_fallback';
  if (executedToolNames.length > 0) return 'agent_tool_path_not_migrated';
  return 'agent_result_not_handoffable';
}

function buildAgentReplyPlan(cfg: AppConfig, outputs: ExecutionOutput[], preferences: {
  turnPreference?: AgentReplyPreference;
  sessionPreference?: AgentReplyPreference;
  userPreference?: AgentReplyPreference;
}): ReplyPlan {
  const resolved = resolveReplyPolicy({
    config: cfg,
    textChars: textCharsOf(outputs),
    ...preferences,
  });
  const plan = buildReplyPlan(outputs, resolved.options);
  return { ...plan, policy: resolved.policy };
}

function toolResultsToReplyOutputs(results: NonNullable<AgentTurnResult['toolResults']>, cfg: AppConfig): ExecutionOutput[] {
  const outputs: ExecutionOutput[] = [];
  for (const result of results) {
    for (const output of result.outputs || []) {
      if (output.kind === 'text') continue;
      const directOnly = output.kind === 'audio' || output.kind === 'file';
      outputs.push({
        kind: output.kind,
        ...(output.id ? { id: output.id } : {}),
        ...(output.text !== undefined ? { text: output.text } : {}),
        ...(output.url !== undefined ? { url: output.url } : {}),
        ...(output.mime !== undefined ? { mime: output.mime } : {}),
        ...(output.size !== undefined ? { size: output.size } : {}),
        priority: output.priority ?? (directOnly ? 30 : output.kind === 'image' || output.kind === 'video' ? 20 : 10),
        mergeable: directOnly ? false : output.mergeable,
        meta: {
          ...(output.meta || {}),
          ...(result.toolName ? { sourceCapability: result.toolName } : {}),
          ...(result.callId ? { toolCallId: result.callId } : {}),
        },
      });
    }
  }

  // Agent 的 audio 工具结果不会自动变成歌词文本；与编排链路保持同一契约：
  // sendLyricsWithMusic 开启且预算允许时，把真实 Suno lyrics 作为独立 text output 放进 ReplyPlan。
  const musicAudio = outputs.find((output) => output.kind === 'audio'
    && (output.meta?.sourceCapability === 'audio.music.generate' || output.meta?.provider === 'suno-official'));
  const lyrics = String(musicAudio?.meta?.lyrics || '').trim();
  if (musicAudio && lyrics
    && cfg.orchestration.suno.sendLyricsWithMusic
    && cfg.orchestration.reply.maxMessages >= 2
    && cfg.orchestration.reply.maxResultItems >= 2) {
    const title = String(musicAudio.meta?.title || '').trim();
    outputs.unshift({
      id: 'suno-lyrics',
      kind: 'text',
      text: title ? title + '\n\n' + lyrics : lyrics,
      priority: 5,
      mergeable: true,
      meta: { synthetic: true, role: 'suno_lyrics', sourceCapability: 'audio.music.generate', skipTts: true, disableVoice: true, title },
    });
  }
  return outputs;
}

function configRevisionFor(cfg: AppConfig): string {
  const snapshot = {
    agent: cfg.agent,
    chat: {
      nodeIndex: cfg.llm.chatNodeIndex,
      model: cfg.llm.chatModel,
      temperature: cfg.llm.reasoningEffort,
    },
    toolRegistry: cfg.toolRegistry,
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
}
