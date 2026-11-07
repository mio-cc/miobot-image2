import type { AgentAttachment, AgentMessage, AgentSessionState } from './types.js';

export interface AgentContextBuildInput {
  session: AgentSessionState;
  userText: string;
  attachments?: AgentAttachment[];
  systemSections?: string[];
  memoryContext?: string;
  groupContext?: string;
  currentTask?: string;
  pinnedFacts?: Record<string, unknown>;
  compactionEnabled?: boolean;
  maxChars?: number;
}

export interface AgentContextBuildResult {
  messages: AgentMessage[];
  includedSections: string[];
  estimatedChars: number;
  /** 各注入段落的实际字符数（预算告警观测用；[Group context] 段含上游合并的记忆/群历史/连发消息）。 */
  sectionChars?: Array<{ label: string; chars: number }>;
  /** 总预算裁剪丢弃的历史消息数（0 = 未触顶；system 块永不参与裁剪）。 */
  trimmedMessages?: number;
}

export interface AgentContextBuilder {
  build(input: AgentContextBuildInput): AgentContextBuildResult;
}

/**
 * Contract-level context builder. R2/R3 can extend it with compaction,
 * spill-to-disk and provider-specific message conversion without changing callers.
 */
export class DefaultAgentContextBuilder implements AgentContextBuilder {
  build(input: AgentContextBuildInput): AgentContextBuildResult {
    const sections: Array<[string, string]> = [];
    for (const content of input.systemSections || []) {
      const text = String(content || '').trim();
      if (text) sections.push(['System', text]);
    }
    if (String(input.groupContext || '').trim()) sections.push(['Group context', String(input.groupContext)]);
    if (String(input.memoryContext || '').trim()) sections.push(['Memory context', String(input.memoryContext)]);
    if (String(input.currentTask || '').trim()) sections.push(['Current task', String(input.currentTask)]);
    if (input.pinnedFacts && Object.keys(input.pinnedFacts).length) sections.push(['Pinned facts', JSON.stringify(input.pinnedFacts)]);
    const contextBlock = sections.map(([label, content]) => `[${label}]\n${content}`).join('\n\n');
    const messages: AgentMessage[] = [];
    if (contextBlock) messages.push({ role: 'system', content: contextBlock });
    messages.push(...(input.session.messages || []).map((message) => structuredClone(message)));
    const attachments = input.attachments || [];
    // P0-4：图片作为真实视觉输入（imageRefs → provider image content part），不再降级成一行附件文本。
    const imageRefs = attachments
      .filter((attachment) => attachment.kind === 'image' && String(attachment.ref || '').trim())
      .map((attachment) => String(attachment.ref).trim());
    const nonImageSuffix = formatAttachments(attachments.filter((attachment) => attachment.kind !== 'image'));
    const normalizedUserText = String(input.userText || '').trim();
    if (normalizedUserText || attachments.length) {
      messages.push({
        role: 'user',
        content: `${normalizedUserText}${nonImageSuffix}`,
        ...(imageRefs.length ? { imageRefs } : {}),
      });
    }
    const maxChars = input.maxChars && input.maxChars > 0 ? Math.trunc(input.maxChars) : 0;
    let trimmedMessages = 0;
    if (maxChars && estimateChars(messages) > maxChars) trimmedMessages = trimToBudget(messages, maxChars, Boolean(input.compactionEnabled));
    const sanitized = sanitizeToolMessagePairs(messages);
    return {
      messages: sanitized,
      includedSections: sections.map(([label]) => label),
      estimatedChars: estimateChars(sanitized),
      ...(sections.length ? { sectionChars: sections.map(([label, content]) => ({ label, chars: String(content).length })) } : {}),
      ...(trimmedMessages ? { trimmedMessages } : {}),
    };
  }
}

/**
ex * 会话历史/压缩可能留下孤立的 tool message，或者修剪掉 assistant.tool_calls 却保留 tool result。
 * 多数 OpenAI-compatible provider 会直接返回 400，所以发模型前必须清理。
 */
export function sanitizeToolMessagePairs(messages: AgentMessage[]): AgentMessage[] {
  const cleaned: AgentMessage[] = [];
  let activeCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      activeCallIds = new Set((message.toolCalls || []).map((call) => String(call.id || '')).filter(Boolean));
      cleaned.push(message);
      continue;
    }
    if (message.role === 'tool') {
      const callId = String(message.toolCallId || '');
      if (callId && activeCallIds.has(callId)) cleaned.push(message);
      continue;
    }
    activeCallIds.clear();
    cleaned.push(message);
  }
  return cleaned;
}

export function createContextBuilder(): AgentContextBuilder {
  return new DefaultAgentContextBuilder();
}

function formatAttachments(attachments: AgentAttachment[]): string {
  if (!attachments.length) return '';
  return '\n\n[Attachments]\n' + attachments.map((attachment) => {
    const name = attachment.name || attachment.ref;
    return `- ${attachment.kind}: ${name}`;
  }).join('\n');
}

function estimateChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

function trimToBudget(messages: AgentMessage[], maxChars: number, compactionEnabled = false): number {
  const removed: AgentMessage[] = [];
  while (messages.length > 2 && estimateChars(messages) > maxChars) {
    const removable = messages.findIndex((message, index) => index > 0 && message.role !== 'system');
    if (removable < 0) break;
    removed.push(...messages.splice(removable, 1));
  }
  if (!compactionEnabled || !removed.length) return removed.length;
  const summary = removed
    .slice(-16)
    .map((message) => {
      const content = String((message as { content?: unknown }).content || '').replace(/\s+/g, ' ').trim();
      return `${message.role}: ${content.slice(0, 240)}`;
    })
    .filter((line) => line.length > 3)
    .join('\n');
  if (!summary) return removed.length;
  const summaryMessage: AgentMessage = {
    role: 'system',
    content: `[Compacted earlier conversation]\n${summary}`,
  };
  const insertAt = messages.findIndex((message) => message.role !== 'system');
  messages.splice(insertAt < 0 ? messages.length : insertAt, 0, summaryMessage);
  return removed.length;
}