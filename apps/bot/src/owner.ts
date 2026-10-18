/** 主人(owner)命令——独立的 owner-only 通道。纯解析,无 I/O,可单测。 */
export type OwnerCommand =
  | { command: 'modelList' }
  | { command: 'switchModel'; code: string }
  | { command: 'ttsOn' }
  | { command: 'ttsOff' }
  | { command: 'switchTtsVoice'; index: number }
  | { command: 'recall'; count: number }
  | { command: 'blacklist'; targetUserId: string }
  | { command: 'whitelist'; targetUserId: string };

export interface OwnerParseContext {
  chatType: 'group' | 'private';
  /** 被 @ 的 QQ 列表(用于群里 拉黑/拉白 选目标、判断是否点名 bot)。 */
  mentions?: string[];
  botId?: string | number;
}

export function isOwner(userId: string | number | undefined, ownerQQs: Array<string | number> = []): boolean {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  return ownerQQs.map((o) => String(o ?? '').trim()).filter(Boolean).includes(id);
}

/** 解析主人命令(沿用旧脚本语义:/拉黑 /拉白 /撤回 /ttsk /ttsg /tts.N /模型 /切换X)。 */
export function parseOwnerCommand(text: string, ctx: OwnerParseContext): OwnerCommand | undefined {
  const t = String(text || '').trim();
  const botQq = String(ctx.botId ?? '').trim();
  const mentions = (ctx.mentions || []).map((m) => String(m ?? '').trim());
  const addressedToBot = ctx.chatType === 'private' || (Boolean(botQq) && mentions.includes(botQq));

  const listMatch = t.match(/(?:^|\s)\/\s*(拉黑|拉白)(?:\s|$)/i);
  if (listMatch) {
    const target = mentions.find((id) => id && id !== botQq) || '';
    return { command: listMatch[1] === '拉黑' ? 'blacklist' : 'whitelist', targetUserId: target };
  }

  if (!addressedToBot) return undefined;

  const recall = t.match(/(?:^|\s)\/\s*(?:撤回|c)\s*(\d+)?(?:\s|$)/i);
  if (recall) return { command: 'recall', count: Math.max(1, Math.min(20, Number.parseInt(recall[1] || '1', 10) || 1)) };

  const ttsToggle = t.match(/(?:^|\s)\/\s*(ttsk|ttsg)(?:\s|$)/i);
  if (ttsToggle) return { command: ttsToggle[1].toLowerCase() === 'ttsk' ? 'ttsOn' : 'ttsOff' };

  const ttsVoice = t.match(/(?:^|\s)\/\s*tts\.(\d{1,2})(?:\s|$)/i);
  if (ttsVoice) return { command: 'switchTtsVoice', index: Math.max(1, Number.parseInt(ttsVoice[1], 10) || 1) };

  const modelList = t.match(/(?:^|\s)\/\s*(?:模型|模型列表|models?|model\s+list)(?:\s|$)/i);
  if (modelList) return { command: 'modelList' };

  const switchM = t.match(/(?:^|\s)\/\s*(?:切换|q)\s*([a-z0-9_.-]+)(?:\s|$)/i);
  if (switchM) return { command: 'switchModel', code: switchM[1].toLowerCase().replace(/_/g, '.') };

  return undefined;
}
