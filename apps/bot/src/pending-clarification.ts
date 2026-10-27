export interface PendingAgentQuestionSession {
  pendingQuestion?: unknown;
}

export interface AgentSessionLookup {
  load(sessionKey: string): PendingAgentQuestionSession | undefined;
}

export function agentSessionKey(chatType: 'group' | 'private', groupId?: number | string, userId?: number | string): string {
  return chatType === 'group'
    ? `group:${groupId ?? 'unknown'}:${userId ?? 'unknown'}`
    : `private:${userId ?? 'unknown'}`;
}

export function hasPendingAgentClarification(
  sessions: AgentSessionLookup,
  input: { chatType: 'group' | 'private'; groupId?: number | string; userId?: number | string },
): boolean {
  return Boolean(sessions.load(agentSessionKey(input.chatType, input.groupId, input.userId))?.pendingQuestion);
}
