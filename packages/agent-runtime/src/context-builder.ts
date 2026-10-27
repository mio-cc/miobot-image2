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
    messages.push({
      role: 'user',
      content: `${String(input.userText || '')}${nonImageSuffix}`,
      ...(imageRefs.length ? { imageRefs } : {}),
    });
    const maxChars = input.maxChars && input.maxChars > 0 ? Math.trunc(input.maxChars) : 0;
    if (maxChars && estimateChars(messages) > maxChars) trimToBudget(messages, maxChars, Boolean(input.compactionEnabled));
    return {
      messages,
      includedSections: sections.map(([label]) => label),
      estimatedChars: estimateChars(messages),
    };
  }
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

function trimToBudget(messages: AgentMessage[], maxChars: number, compactionEnabled = false): void {
  const removed: AgentMessage[] = [];
  while (messages.length > 2 && estimateChars(messages) > maxChars) {
    const removable = messages.findIndex((message, index) => index > 0 && message.role !== 'system');
    if (removable < 0) break;
    removed.push(...messages.splice(removable, 1));
  }
  if (!compactionEnabled || !removed.length) return;
  const summary = removed
    .slice(-16)
    .map((message) => {
      const content = String((message as { content?: unknown }).content || '').replace(/\s+/g, ' ').trim();
      return `${message.role}: ${content.slice(0, 240)}`;
    })
    .filter((line) => line.length > 3)
    .join('\n');
  if (!summary) return;
  const summaryMessage: AgentMessage = {
    role: 'system',
    content: `[Compacted earlier conversation]\n${summary}`,
  };
  const insertAt = messages.findIndex((message) => message.role !== 'system');
  messages.splice(insertAt < 0 ? messages.length : insertAt, 0, summaryMessage);
}