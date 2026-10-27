import type { ToolResult, ToolSpec } from '../../tool-runtime/src/index.js';
import type {
  ParsedProviderToolResponse,
  ProviderToolAdapter,
  ProviderToolCall,
  ProviderToolChoice,
  ProviderToolContext,
  ProviderToolIssue,
  ProviderToolMessage,
} from './types.js';
import {
  appendToolResultMessage,
  createToolNameMap,
  finishReasonTruncated,
  normalizeToolCall,
  textFromContent,
} from './common.js';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function contextForTools(tools: ToolSpec[], context: ProviderToolContext = {}): ProviderToolContext {
  return { ...context, toolNames: Array.from(new Set([...(context.toolNames || []), ...tools.map((tool) => tool.name)])) };
}

function contextForMessages(messages: ProviderToolMessage[], context: ProviderToolContext = {}): ProviderToolContext {
  const names = [...(context.toolNames || [])];
  for (const message of messages) for (const call of message.toolCalls || []) if (call.name) names.push(call.name);
  return { ...context, toolNames: Array.from(new Set(names)) };
}

export const openAiToolAdapter: ProviderToolAdapter = {
  id: 'openai',
  buildTools(tools: ToolSpec[], context: ProviderToolContext = {}): unknown {
    const ctx = contextForTools(tools, context);
    const map = createToolNameMap(ctx.toolNames || []);
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: map.canonicalToWire[tool.name] || tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  },
  buildToolChoice(choice: ProviderToolChoice): unknown {
    return choice;
  },
  parseToolCalls(raw: unknown, context: ProviderToolContext = {}): ProviderToolCall[] {
    return openAiToolAdapter.parseToolResponse(raw, context).toolCalls;
  },
  parseToolResponse(raw: unknown, context: ProviderToolContext = {}): ParsedProviderToolResponse {
    const root = record(raw);
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const choice = record(choices[0]);
    const message = record(choice.message || root.message || root);
    const finishReason = String(choice.finish_reason ?? message.finish_reason ?? context.finishReason ?? '') || undefined;
    const truncated = finishReasonTruncated(finishReason);
    const issues: ProviderToolIssue[] = [];
    const rawCalls: unknown[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!rawCalls.length && message.function_call && typeof message.function_call === 'object') rawCalls.push({ function: message.function_call });
    const toolCalls: ProviderToolCall[] = [];
    rawCalls.forEach((rawCall, index) => {
      const call = record(rawCall);
      const fn = record(call.function);
      const normalized = normalizeToolCall(call, index, 'openai', context, {
        id: call.id,
        name: fn.name,
        arguments: fn.arguments,
      });
      toolCalls.push(normalized.call);
      issues.push(...normalized.issues);
    });
    if (truncated) {
      issues.push({ code: 'truncated_output', message: 'OpenAI-compatible output reached the token limit.', ...(finishReason ? { received: finishReason } : {}) });
    }
    return {
      toolCalls,
      text: textFromContent(message.content),
      issues,
      ...(finishReason ? { finishReason } : {}),
      truncated,
    };
  },
  appendToolResult(messages: ProviderToolMessage[], result: ToolResult): ProviderToolMessage[] {
    return appendToolResultMessage(messages, result);
  },
};

/** Convert provider-neutral tool messages to OpenAI chat-completions wire messages. */
export function toOpenAiMessages(messages: ProviderToolMessage[], context: ProviderToolContext = {}): Array<Record<string, unknown>> {
  const ctx = contextForMessages(messages, context);
  const map = createToolNameMap(ctx.toolNames || []);
  return messages.map((message) => {
    const role = String(message.role || 'user');
    if (role === 'tool') {
      return {
        role: 'tool',
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.name ? { name: map.canonicalToWire[message.name] || message.name } : {}),
        content: typeof message.content === 'string' ? message.content : textFromContent(message.content),
      };
    }
    const base: Record<string, unknown> = { role, content: message.content };
    if (role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      base.content = message.content === undefined || message.content === '' ? null : message.content;
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: map.canonicalToWire[call.name] || call.name,
          arguments: typeof call.rawArguments === 'string' ? call.rawArguments : JSON.stringify(call.arguments || {}),
        },
      }));
    }
    // Preserve already-native tool payloads from legacy callers.
    if (Array.isArray((message as any).tool_calls)) base.tool_calls = (message as any).tool_calls;
    if (typeof (message as any).tool_call_id === 'string') base.tool_call_id = (message as any).tool_call_id;
    return base;
  });
}
