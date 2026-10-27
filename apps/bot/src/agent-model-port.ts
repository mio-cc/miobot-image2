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

export interface AgentModelPortOptions {
  defaultNodeIndex?: number;
  timeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  fallbackNodeIndex?: number;
  fallbackModel?: string;
}

/**
 * R4 bridge: converts the provider-neutral AgentRuntime protocol to the existing
 * ModelClient request shape and normalizes ModelClient output back into the
 * agent loop's structured validation contract.
 */
export function createAgentModelPort(client: Pick<ModelClient, 'chat'>, options: AgentModelPortOptions = {}): AgentModelPort {
  return {
    async chat(request: AgentModelRequest): Promise<AgentModelResponse> {
      const messages: ChatMessage[] = request.messages.map(toModelMessage);
      const tools = request.tools || [];
      const chatRequest: ChatRequest = {
        model: request.model,
        messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
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
      try {
        return toAgentResponse(await client.chat(primaryNode, chatRequest));
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const fallbackModel = String(options.fallbackModel || '').trim();
        const fallbackNode = options.fallbackNodeIndex;
        if (!fallbackModel || (fallbackNode === primaryNode && fallbackModel === request.model)) throw error;
        return toAgentResponse(await client.chat(fallbackNode ?? primaryNode, { ...chatRequest, model: fallbackModel }));
      }
    },
  };
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
