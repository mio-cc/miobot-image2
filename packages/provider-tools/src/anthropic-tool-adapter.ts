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

function toAnthropicContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = record(part);
      if (item.type === 'text') return { type: 'text', text: String(item.text || '') };
      if (item.type === 'image_url') {
        const url = String(record(item.image_url).url || '');
        const match = url.match(/^data:([^;]+);base64,(.*)$/i);
        if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
        return { type: 'image', source: { type: 'url', url } };
      }
      return { type: 'text', text: String(item.text || '') };
    });
  }
  return String(content ?? '');
}

export const anthropicToolAdapter: ProviderToolAdapter = {
  id: 'anthropic',
  buildTools(tools: ToolSpec[], context: ProviderToolContext = {}): unknown {
    const ctx = contextForTools(tools, context);
    const map = createToolNameMap(ctx.toolNames || []);
    return tools.map((tool) => ({
      name: map.canonicalToWire[tool.name] || tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  },
  buildToolChoice(choice: ProviderToolChoice): unknown {
    if (choice === 'required') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    return { type: 'auto' };
  },
  parseToolCalls(raw: unknown, context: ProviderToolContext = {}): ProviderToolCall[] {
    return anthropicToolAdapter.parseToolResponse(raw, context).toolCalls;
  },
  parseToolResponse(raw: unknown, context: ProviderToolContext = {}): ParsedProviderToolResponse {
    const root = record(raw);
    const blocks = Array.isArray(root.content) ? root.content : [];
    const finishReason = String(root.stop_reason ?? context.finishReason ?? '') || undefined;
    const truncated = finishReasonTruncated(finishReason);
    const issues: ProviderToolIssue[] = [];
    const text = blocks
      .map((block) => { const item = record(block); return item.type === 'text' && typeof item.text === 'string' ? item.text : ''; })
      .filter(Boolean)
      .join('\n');
    const toolCalls: ProviderToolCall[] = [];
    blocks.forEach((block, index) => {
      const item = record(block);
      if (item.type !== 'tool_use') return;
      const normalized = normalizeToolCall(item, index, 'anthropic', context, {
        id: item.id,
        name: item.name,
        arguments: item.input,
      });
      toolCalls.push(normalized.call);
      issues.push(...normalized.issues);
    });
    if (truncated) issues.push({ code: 'truncated_output', message: 'Anthropic output reached max_tokens.', ...(finishReason ? { received: finishReason } : {}) });
    return {
      toolCalls,
      ...(text ? { text } : {}),
      issues,
      ...(finishReason ? { finishReason } : {}),
      truncated,
    };
  },
  appendToolResult(messages: ProviderToolMessage[], result: ToolResult): ProviderToolMessage[] {
    return appendToolResultMessage(messages, result);
  },
};

/** Convert provider-neutral tool messages into Anthropic system + user/assistant messages. */
export function toAnthropicMessages(messages: ProviderToolMessage[], context: ProviderToolContext = {}): { system?: string; messages: Array<Record<string, unknown>> } {
  const ctx = contextForMessages(messages, context);
  const map = createToolNameMap(ctx.toolNames || []);
  const systemParts: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  const callByName = new Map<string, string>();
  let lastWasToolGroup = false;
  for (const message of messages) {
    const role = String(message.role || 'user');
    if (role === 'system') {
      systemParts.push(textFromContent(message.content, JSON.stringify(message.content ?? '')));
      lastWasToolGroup = false;
      continue;
    }
    if (role === 'tool') {
      let callId = String(message.toolCallId || '').trim();
      if (!callId && message.name) callId = callByName.get(String(message.name)) || '';
      const block = {
        type: 'tool_result',
        tool_use_id: callId,
        content: typeof message.content === 'string' ? message.content : textFromContent(message.content),
        ...(message.isError ? { is_error: true } : {}),
      };
      if (lastWasToolGroup && out.length) {
        const previous = out[out.length - 1];
        const blocks = Array.isArray(previous.content) ? previous.content : [{ type: 'text', text: String(previous.content ?? '') }];
        previous.content = [...blocks, block];
      } else {
        out.push({ role: 'user', content: [block] });
        lastWasToolGroup = true;
      }
      continue;
    }
    if (role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      const blocks: unknown[] = [];
      const text = textFromContent(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.toolCalls) {
        callByName.set(call.name, call.id);
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: map.canonicalToWire[call.name] || call.name,
          input: call.arguments || {},
        });
      }
      out.push({ role: 'assistant', content: blocks });
      lastWasToolGroup = false;
      continue;
    }
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(message.content) });
    lastWasToolGroup = false;
  }
  return { ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}), messages: out };
}
