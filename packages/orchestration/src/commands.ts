export interface ExactCommandDefinition {
  id: string;
  aliases: string[];
  capability: string;
  requiresPrefix?: boolean;
}

export interface MatchedCommand {
  id: string;
  capability: string;
  alias: string;
  args: string;
}

/**
 * 只做整条消息前缀匹配，不在普通句子里扫描关键词。
 * 例：alias="ch" 只匹配 "ch" 或 "ch 3"，不匹配 "帮我 ch 一下"。
 */
export function matchExactCommand(text: string, commands: ExactCommandDefinition[]): MatchedCommand | null {
  const value = String(text || '').trim();
  if (!value) return null;
  const candidates = commands
    .flatMap((command) => (command.aliases || []).map((alias) => ({ command, alias: String(alias).trim() })))
    .filter((item) => item.alias)
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { command, alias } of candidates) {
    if (value === alias) {
      return { id: command.id, capability: command.capability, alias, args: '' };
    }
    if (value.startsWith(alias + ' ')) {
      return { id: command.id, capability: command.capability, alias, args: value.slice(alias.length).trim() };
    }
  }
  return null;
}
