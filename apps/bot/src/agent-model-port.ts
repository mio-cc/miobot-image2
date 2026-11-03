import type {
  AgentModelPort,
  AgentModelRequest,
  AgentModelResponse,
  AgentToolError,
} from '../../../packages/agent-runtime/src/index.js';
import type {
  ChatMessage,
  ChatRequest,
  ReasoningEffort,
  ModelClient,
  TextResult,
  ToolCall as ModelToolCall,
} from '../../../packages/model/src/index.js';
import { isToolErrorCode, makeToolError, type ToolError } from '../../../packages/tool-runtime/src/index.js';
import { isFailoverWorthyError, type ModelFallbackController } from './model-fallback.js';

export interface AgentModelPortOptions {
  defaultNodeIndex?: number;
  timeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  fallbackNodeIndex?: number;
  fallbackModel?: string;
  /**
   * P1 第三批：备用模型状态机（方案 §6）。传入后接管有备用场景的切换决策
   * （计数/粘滞/冷却试探/override 优先级）；无备用时整体旁路，行为与不传时一致。
   * 不传时保留旧的无状态朴素重试（兼容既有调用方与测试）。
   */
  fallback?: ModelFallbackController;
  /** 状态机管理的用途键（主对话链 = 'main'）。 */
  fallbackPurpose?: string;
}

/**
 * R4 bridge: converts the provider-neutral AgentRuntime protocol to the existing
 * ModelClient request shape and normalizes ModelClient output back into the
 * agent loop's structured validation contract.
 */
export function createAgentModelPort(client: Pick<ModelClient, 'chat'>, options: AgentModelPortOptions = {}): AgentModelPort {
  const fallbackPurpose = options.fallbackPurpose || 'main';
  return {
    async chat(request: AgentModelRequest): Promise<AgentModelResponse> {
      const messages: ChatMessage[] = request.messages.map(toModelMessage);
      const tools = request.tools || [];
      const requestedTimeout = Number(request.timeoutMs);
      const timeoutMs = requestedTimeout > 0
        ? (options.timeoutMs ? Math.min(requestedTimeout, options.timeoutMs) : requestedTimeout)
        : options.timeoutMs;
      const chatRequest: ChatRequest = {
        model: request.model,
        messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(tools.length ? {
          toolSpecs: tools,
          toolProtocol: 'auto' as const,
          toolChoice: request.toolChoice,
        } : {
          toolChoice: 'none' as const,
        }),
      };
      const primaryNode = request.nodeIndex ?? options.defaultNodeIndex ?? 0;

      // ── P1 第三批：状态机接管（有 controller 时） ──
      if (options.fallback) {
        return chatWithStateMachine(options.fallback, request, chatRequest, primaryNode, timeoutMs);
      }

      // ── 旧路径：无状态朴素重试（无 controller 的调用方兼容） ──
      try {
        return toAgentResponse(await chatWithAbort(client, primaryNode, chatRequest, request.signal));
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const fallbackModel = String(options.fallbackModel || '').trim();
        const fallbackNode = options.fallbackNodeIndex;
        if (!fallbackModel || (fallbackNode === primaryNode && fallbackModel === request.model)) throw error;
        return toAgentResponse(await chatWithAbort(client, fallbackNode ?? primaryNode, { ...chatRequest, model: fallbackModel }, request.signal));
      }
    },

  };

  /** 状态机版调用流程：对 agent-loop 透明（模型/节点选择在档位决策后覆写）。 */
  async function chatWithStateMachine(
    controller: ModelFallbackController,
    request: AgentModelRequest,
    chatRequest: ChatRequest,
    primaryNode: number,
    timeoutMs: number | undefined,
  ): Promise<AgentModelResponse> {
    const decision = controller.selectSlot(fallbackPurpose, request.purpose === 'turn');
    if (decision.mode !== 'bypass' && decision.slot === 'secondary' && decision.secondary) {
      // 锁定备 / 粘滞 / 跟随粘滞：直接用备，失败按现行为抛出（不切不计数）。
      return toAgentResponse(await chatWithAbort(client, decision.secondary.nodeIndex, { ...chatRequest, model: decision.secondary.model }, request.signal));
    }
    // 主档位（auto / probe / locked-primary / follow / bypass）。
    // probe：借本次真实调用试探主模型——短超时封顶，失败不计数。
    const primaryRequest = decision.mode === 'probe' && decision.probeTimeoutMs
      ? { ...chatRequest, timeoutMs: Math.min(decision.probeTimeoutMs, timeoutMs || decision.probeTimeoutMs) }
      : chatRequest;
    try {
      const result = await chatWithAbort(client, primaryNode, primaryRequest, request.signal);
      controller.onPrimarySuccess(decision);
      return toAgentResponse(result);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (!decision.secondary || !isFailoverWorthyError(error)) throw error;
      const { retryWithSecondary } = controller.onPrimaryFailure(decision, error);
      if (!retryWithSecondary) throw error;
      // 立即切备用重试**本次请求**（由备产生回答；备也失败则按现行为抛出）。
      return toAgentResponse(await chatWithAbort(client, decision.secondary.nodeIndex, { ...chatRequest, model: decision.secondary.model }, request.signal));
    }
  }
}

async function chatWithAbort(client: Pick<ModelClient, 'chat'>, nodeIndex: number, request: ChatRequest, signal?: AbortSignal) {
  if (!signal) return client.chat(nodeIndex, request);
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('agent_model_aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([client.chat(nodeIndex, request), aborted]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function toModelMessage(message: AgentModelRequest['messages'][number]): ChatMessage {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls.map(toModelToolCall) } : {}),
      ...(message.finishReason ? { finishReason: message.finishReason } : {}),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      toolCallId: message.toolCallId,
      ...(message.name ? { name: message.name } : {}),
      ...(message.isError ? { isError: true } : {}),
    };
  }
  // P0-4：带 imageRefs 的 user 消息转成 provider 多模态 content 数组
  // （[{type:'text'},{type:'image_url'}]——openai 原生；anthropic/gemini 方言各自转换 image_url part）。
  if (message.role === 'user' && message.imageRefs?.length) {
    const parts: Array<Record<string, unknown>> = [];
    const text = String(message.content || '').trim();
    if (text) parts.push({ type: 'text', text });
    for (const ref of message.imageRefs) {
      const url = String(ref || '').trim();
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
    if (parts.length) return { role: 'user', content: parts };
  }
  return { role: message.role, content: message.content };
}

function toModelToolCall(call: { id: string; name: string; arguments: unknown }): ModelToolCall {
  const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, unknown>
    : {};
  return { id: call.id, name: call.name, arguments: args };
}

function toAgentResponse(result: TextResult): AgentModelResponse {
  const issues: AgentToolError[] = (result.toolCallIssues || []).map(toToolError);
  const toolCalls = (result.toolCalls || []).map((call, index) => {
    const id = call.id || `model_call_${index + 1}`;
    if (!call.id) {
      issues.push(makeToolError({
        code: 'missing_tool_call_id',
        message: 'Model returned a tool call without an id.',
        callId: id,
        toolName: call.name,
        path: '$.toolCalls',
      }));
    }
    return {
      id,
      name: call.name,
      arguments: call.arguments,
    };
  });
  return {
    assistant: {
      text: result.text || '',
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.usage ? { usage: { ...result.usage } } : {}),
    },
    raw: result.raw,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    ...(issues.length ? { toolCallIssues: issues } : {}),
    ...(result.usage ? { usage: { ...result.usage } } : {}),
  };
}

function toToolError(issue: {
  code: string;
  message: string;
  callId?: string;
  toolName?: string;
  path?: string;
  expected?: unknown;
  received?: unknown;
}): ToolError {
  const code = isToolErrorCode(issue.code) ? issue.code : 'invalid_envelope';
  return makeToolError({
    code,
    message: issue.message,
    ...(issue.callId ? { callId: issue.callId } : {}),
    ...(issue.toolName ? { toolName: issue.toolName } : {}),
    ...(issue.path ? { path: issue.path } : {}),
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.received !== undefined ? { received: issue.received } : {}),
  });
}
