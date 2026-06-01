import type { PackageDescriptor } from '@miobot-v2/shared';

export const BOT_ROUTER_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/bot-router',
  phase: 'P10-bot-router',
};

export type BotChatType = 'group' | 'private';
export type CommandAliasInput = string | string[] | readonly string[] | null | undefined;

export type BotCommandName =
  | 'help'
  | 'clear'
  | 'originalImage'
  | 'originalImageChoice'
  | 'templateLibrary'
  | 'referencedTemplateImage'
  | 'remotePromptSearch'
  | 'remotePromptSmartImage'
  | 'genImage'
  | 'editImage'
  | 'img2Img'
  | 'interrogate';

export type BotRouteKind = 'ignored' | 'command' | 'freeMode' | 'chat';

export type BotIgnoredReason =
  | 'empty-message'
  | 'group-not-whitelisted'
  | 'private-not-whitelisted'
  | 'group-user-blacklisted'
  | 'group-not-triggered'
  | 'no-handler-enabled';

export interface BotCommandAliases {
  genImage?: CommandAliasInput;
  img2Img?: CommandAliasInput;
  editImage?: CommandAliasInput;
  interrogate?: CommandAliasInput;
  originalImage?: CommandAliasInput;
  imageCount?: CommandAliasInput;
  referencedTemplateImage?: CommandAliasInput;
  templateLibrary?: CommandAliasInput;
  help?: CommandAliasInput;
  clear?: CommandAliasInput;
  remotePromptSearch?: CommandAliasInput;
  remotePromptSmartImage?: CommandAliasInput;
  toggleEnhance?: CommandAliasInput;
  forceEnhance?: CommandAliasInput;
  disableEnhance?: CommandAliasInput;
}

export interface BotTriggerModes {
  mention?: boolean;
  replyToBot?: boolean;
}

export interface BotRouterConfig {
  botId?: string | number;
  botAliases?: string[];
  whitelistGroups?: Array<string | number>;
  whitelistPrivate?: Array<string | number>;
  blacklistGroupUsers?: string[];
  triggerModes?: BotTriggerModes;
  commands: BotCommandAliases;
  freeModeEnabled?: boolean;
  chatEnabled?: boolean;
  directGroupCommands?: BotCommandName[];
}

export interface BotMessageContext {
  chatType: BotChatType;
  rawMessage: string;
  messageId?: string | number;
  groupId?: string | number;
  userId?: string | number;
  /** 可由 Napcat adapter/上层路由在 get_msg 后注入，保持本模块纯决策、无 I/O。 */
  replyToBot?: boolean;
  replyToMessageId?: string | number;
  /** 引用的旧多图消息存在可取原图选项时，1-4 数字可作为原图选择命令。 */
  originalChoiceAvailable?: boolean;
}

export interface BotTriggerResolution {
  triggered: boolean;
  mentionTriggered: boolean;
  replyTriggered: boolean;
  commandTriggered: boolean;
  mentioned: boolean;
  replyId?: string;
  commandText: string;
  textWithoutReply: string;
}

export interface BotCommandMatch {
  command: BotCommandName;
  matchedAlias?: string;
  args: string;
  commandText: string;
  metadata?: Record<string, unknown>;
}

export type BotRouteDecision =
  | {
      kind: 'ignored';
      reason: BotIgnoredReason;
      commandText: string;
      trigger?: BotTriggerResolution;
    }
  | {
      kind: 'command';
      command: BotCommandName;
      matchedAlias?: string;
      args: string;
      commandText: string;
      trigger: BotTriggerResolution;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: 'freeMode';
      args: string;
      commandText: string;
      trigger: BotTriggerResolution;
    }
  | {
      kind: 'chat';
      args: string;
      commandText: string;
      trigger: BotTriggerResolution;
    };

export interface CommandPrefixMatch {
  alias: string;
  args: string;
}

export interface EnhanceModeResult {
  prompt: string;
  forceEnhance: boolean;
  enhanceMode: 'none' | 'toggle' | 'force' | 'disable';
  matchedAlias?: string;
}

const LEGACY_DIRECT_GROUP_COMMANDS: BotCommandName[] = [
  'originalImage',
  'img2Img',
  'editImage',
  'referencedTemplateImage',
  'templateLibrary',
  'help',
  'clear',
  'remotePromptSearch',
  'remotePromptSmartImage',
];

export class BotRouter {
  private readonly config: BotRouterConfig;

  constructor(config: BotRouterConfig) {
    this.config = config;
  }

  route(message: BotMessageContext): BotRouteDecision {
    return routeBotMessage(message, this.config);
  }
}

export function createBotRouter(config: BotRouterConfig): BotRouter {
  return new BotRouter(config);
}

export function routeBotMessage(message: BotMessageContext, config: BotRouterConfig): BotRouteDecision {
  const rawMessage = String(message.rawMessage || '').trim();
  if (!rawMessage) return ignored('empty-message', '');

  if (message.chatType === 'group') return routeGroupMessage({ ...message, rawMessage }, config);
  return routePrivateMessage({ ...message, rawMessage }, config);
}

function routeGroupMessage(message: BotMessageContext, config: BotRouterConfig): BotRouteDecision {
  const groupId = message.groupId;
  const userId = message.userId;
  if (!isAllowedByWhitelist(groupId, config.whitelistGroups)) return ignored('group-not-whitelisted', '');
  if (groupId !== undefined && userId !== undefined && isGroupUserBlacklisted(groupId, userId, config.blacklistGroupUsers)) {
    return ignored('group-user-blacklisted', '');
  }

  const trigger = resolveGroupTrigger(message, config);
  if (!trigger.triggered) return ignored('group-not-triggered', trigger.commandText, trigger);

  const explicit = matchExplicitCommand(trigger.commandText, config.commands, {
    replyId: trigger.replyId,
    originalChoiceAvailable: message.originalChoiceAvailable,
  });
  if (explicit) return { kind: 'command', ...explicit, trigger };

  if (config.freeModeEnabled && shouldEnterFreeMode(message.chatType, trigger)) {
    return { kind: 'freeMode', args: trigger.commandText, commandText: trigger.commandText, trigger };
  }

  if (config.chatEnabled && shouldEnterChat(message.chatType, trigger)) {
    return { kind: 'chat', args: trigger.commandText, commandText: trigger.commandText, trigger };
  }

  return ignored('no-handler-enabled', trigger.commandText, trigger);
}

function routePrivateMessage(message: BotMessageContext, config: BotRouterConfig): BotRouteDecision {
  if (!isAllowedByWhitelist(message.userId, config.whitelistPrivate)) return ignored('private-not-whitelisted', '');
  const trigger = resolvePrivateTrigger(message, config);

  const explicit = matchExplicitCommand(trigger.commandText, config.commands, {
    replyId: trigger.replyId,
    originalChoiceAvailable: true,
  });
  if (explicit) return { kind: 'command', ...explicit, trigger };

  if (config.freeModeEnabled) return { kind: 'freeMode', args: trigger.commandText, commandText: trigger.commandText, trigger };
  if (config.chatEnabled) return { kind: 'chat', args: trigger.commandText, commandText: trigger.commandText, trigger };
  return ignored('no-handler-enabled', trigger.commandText, trigger);
}

function ignored(reason: BotIgnoredReason, commandText: string, trigger?: BotTriggerResolution): BotRouteDecision {
  return { kind: 'ignored', reason, commandText, trigger };
}

export function resolveGroupTrigger(message: BotMessageContext, config: BotRouterConfig): BotTriggerResolution {
  const triggerModes = { mention: true, replyToBot: true, ...config.triggerModes };
  const replyId = extractReplyId(message.rawMessage) ?? stringifyId(message.replyToMessageId);
  const textWithoutReply = stripReplySegments(message.rawMessage).trim();
  const mentioned = hasBotMention(textWithoutReply, config.botId, config.botAliases);
  const mentionTriggered = triggerModes.mention !== false && mentioned;
  const replyTriggered = triggerModes.replyToBot !== false && Boolean(replyId) && message.replyToBot === true;
  const commandText = cleanupCommandText(textWithoutReply, config.botId, config.botAliases);
  const commandTriggered = isDirectGroupCommand(commandText, config.commands, {
    directGroupCommands: config.directGroupCommands,
    replyId,
    originalChoiceAvailable: message.originalChoiceAvailable,
  });
  return {
    triggered: mentionTriggered || replyTriggered || commandTriggered,
    mentionTriggered,
    replyTriggered,
    commandTriggered,
    mentioned,
    replyId,
    commandText,
    textWithoutReply,
  };
}

export function resolvePrivateTrigger(message: BotMessageContext, config: BotRouterConfig): BotTriggerResolution {
  const replyId = extractReplyId(message.rawMessage) ?? stringifyId(message.replyToMessageId);
  const textWithoutReply = stripReplySegments(message.rawMessage).trim();
  const commandText = cleanupCommandText(textWithoutReply, config.botId, config.botAliases);
  return {
    triggered: true,
    mentionTriggered: false,
    replyTriggered: false,
    commandTriggered: true,
    mentioned: false,
    replyId,
    commandText,
    textWithoutReply,
  };
}

export function parseTriggers(raw: CommandAliasInput): string[] {
  const items = Array.isArray(raw) ? raw : String(raw || '').split(/[,，、;；|\n]/);
  const seen = new Set<string>();
  return items
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.length - a.length);
}

export function startsWithCommand(text: string, trigger: string, separators = '\\s'): boolean {
  if (!trigger) return false;
  const lowerText = String(text || '').toLowerCase();
  const lowerTrigger = trigger.toLowerCase();
  if (lowerText === lowerTrigger) return true;
  if (!lowerText.startsWith(lowerTrigger)) return false;
  const next = String(text || '').slice(trigger.length, trigger.length + 1);
  return new RegExp(`[${separators}]`).test(next);
}

export function findCommandPrefix(text: string, rawTriggers: CommandAliasInput): string | undefined {
  return parseTriggers(rawTriggers).find((trigger) => startsWithCommand(text, trigger, '\\s!！:：'));
}

export function matchCommandPrefix(text: string, rawTriggers: CommandAliasInput): CommandPrefixMatch | undefined {
  const alias = findCommandPrefix(text, rawTriggers);
  return alias ? { alias, args: stripCommandPrefix(text, alias) } : undefined;
}

export function stripCommandPrefix(text: string, trigger: string): string {
  if (String(text || '').length === trigger.length) return '';
  return String(text || '').substring(trigger.length).replace(/^[\s!！:：]+/, '').trim();
}

export function findBangCommandPrefix(text: string, rawTriggers: CommandAliasInput): string | undefined {
  return findCommandPrefix(text, rawTriggers);
}

export function stripBangCommandPrefix(text: string, trigger: string): string {
  return stripCommandPrefix(text, trigger);
}

export function extractReplyId(text: string): string | undefined {
  const match = String(text || '').match(/\[CQ:reply,[^\]]*id=([^,\]]+)/);
  return match?.[1];
}

export function stripReplySegments(text: string): string {
  return String(text || '').replace(/\[CQ:reply,[^\]]+\]/g, '').trim();
}

export function botMentionRegex(botId?: string | number): RegExp | undefined {
  const id = stringifyId(botId);
  if (!id) return undefined;
  return new RegExp(`\\[CQ:at,qq=${escapeRegExp(id)}(?:,[^\\]]*)?\\]`, 'g');
}

export function hasBotMention(text: string, botId?: string | number, aliases: string[] = ['@bot']): boolean {
  const regex = botMentionRegex(botId);
  if (regex?.test(text)) return true;
  return normalizeBotAliases(aliases).some((alias) => String(text || '').toLowerCase().includes(alias.toLowerCase()));
}

export function stripBotMentions(text: string, botId?: string | number, aliases: string[] = ['@bot']): string {
  const regex = botMentionRegex(botId);
  let output = regex ? String(text || '').replace(regex, '') : String(text || '');
  for (const alias of normalizeBotAliases(aliases)) {
    output = replaceAllCaseInsensitive(output, alias, '');
  }
  return output.replace(/^[\s+＋]+/, '').trim();
}

export function stripLeadingCqAtSegments(text: string): string {
  return String(text || '').replace(/^(?:\s*\[CQ:at,[^\]]+\]\s*)+/g, '').trim();
}

export function cleanupCommandText(text: string, botId?: string | number, aliases?: string[]): string {
  return stripLeadingCqAtSegments(stripBotMentions(text, botId, aliases)).trim();
}

export function isGroupUserBlacklisted(groupId: string | number, userId: string | number, entries: string[] = []): boolean {
  const group = String(groupId);
  const user = String(userId);
  return entries.some((entry) => {
    const normalized = String(entry || '').trim().replace('：', ':');
    const [entryGroup, entryUser] = normalized.split(':').map((part) => part.trim());
    if (!entryGroup || !entryUser) return false;
    return (entryGroup === '*' || entryGroup === group) && (entryUser === '*' || entryUser === user);
  });
}

export function isAllowedByWhitelist(id: string | number | undefined, whitelist: Array<string | number> = []): boolean {
  if (!whitelist.length) return true;
  const normalized = whitelist.map((item) => String(item));
  return normalized.includes('*') || (id !== undefined && normalized.includes(String(id)));
}

export function isDirectGroupCommand(
  commandText: string,
  commands: BotCommandAliases,
  options: { directGroupCommands?: BotCommandName[]; replyId?: string; originalChoiceAvailable?: boolean } = {},
): boolean {
  if (isOriginalChoiceCommand(commandText, options.replyId, options.originalChoiceAvailable)) return true;
  const names = options.directGroupCommands || LEGACY_DIRECT_GROUP_COMMANDS;
  return names.some((name) => Boolean(commandNameMatch(name, commandText, commands)));
}

export function matchExplicitCommand(
  commandText: string,
  commands: BotCommandAliases,
  options: { replyId?: string; originalChoiceAvailable?: boolean } = {},
): BotCommandMatch | undefined {
  const text = String(commandText || '').trim();
  const help = commandNameMatch('help', text, commands);
  if (help) return help;
  const clear = commandNameMatch('clear', text, commands);
  if (clear) return clear;
  const original = commandNameMatch('originalImage', text, commands);
  if (original) return original;
  if (isOriginalChoiceCommand(text, options.replyId, options.originalChoiceAvailable)) {
    return { command: 'originalImageChoice', commandText: text, args: text, metadata: { replyId: options.replyId } };
  }
  const templateLibrary = commandNameMatch('templateLibrary', text, commands);
  if (templateLibrary) return templateLibrary;
  const referencedTemplateImage = commandNameMatch('referencedTemplateImage', text, commands);
  if (referencedTemplateImage) return referencedTemplateImage;
  const remotePromptSearch = commandNameMatch('remotePromptSearch', text, commands, true);
  if (remotePromptSearch) return remotePromptSearch;
  const remotePromptSmartImage = commandNameMatch('remotePromptSmartImage', text, commands, true);
  if (remotePromptSmartImage) return remotePromptSmartImage;
  const genImage = commandNameMatch('genImage', text, commands);
  if (genImage) {
    const enhance = parseEnhanceMode(genImage.args, commands);
    return {
      ...genImage,
      args: enhance.prompt,
      metadata: { enhance },
    };
  }
  const editImage = commandNameMatch('editImage', text, commands);
  if (editImage) return editImage;
  const img2Img = commandNameMatch('img2Img', text, commands);
  if (img2Img) return img2Img;
  const interrogate = commandNameMatch('interrogate', text, commands);
  if (interrogate) return interrogate;
  return undefined;
}

export function parseEnhanceMode(prompt: string, commands: BotCommandAliases): EnhanceModeResult {
  const force = matchCommandPrefix(prompt, commands.forceEnhance);
  if (force) return { prompt: force.args, forceEnhance: true, enhanceMode: 'force', matchedAlias: force.alias };
  const disable = matchCommandPrefix(prompt, commands.disableEnhance);
  if (disable) return { prompt: disable.args, forceEnhance: false, enhanceMode: 'disable', matchedAlias: disable.alias };
  const toggle = matchCommandPrefix(prompt, commands.toggleEnhance);
  if (toggle) return { prompt: toggle.args, forceEnhance: true, enhanceMode: 'toggle', matchedAlias: toggle.alias };
  return { prompt, forceEnhance: false, enhanceMode: 'none' };
}

export function shouldEnterFreeMode(chatType: BotChatType, trigger: BotTriggerResolution): boolean {
  if (chatType === 'private') return true;
  return trigger.mentionTriggered || trigger.replyTriggered;
}

export function shouldEnterChat(chatType: BotChatType, trigger: BotTriggerResolution): boolean {
  if (chatType === 'private') return true;
  return trigger.mentionTriggered || trigger.replyTriggered;
}

function commandNameMatch(name: BotCommandName, text: string, commands: BotCommandAliases, bang = false): BotCommandMatch | undefined {
  const aliases = commandAliasesForName(name, commands);
  const alias = bang ? findBangCommandPrefix(text, aliases) : findCommandPrefix(text, aliases);
  if (!alias) return undefined;
  const args = bang ? stripBangCommandPrefix(text, alias) : stripCommandPrefix(text, alias);
  return { command: name, matchedAlias: alias, args, commandText: text };
}

function commandAliasesForName(name: BotCommandName, commands: BotCommandAliases): CommandAliasInput {
  if (name === 'originalImageChoice') return undefined;
  return commands[name];
}

function isOriginalChoiceCommand(commandText: string, replyId?: string, originalChoiceAvailable = false): boolean {
  return Boolean(replyId) && originalChoiceAvailable && /^[1-4]$/.test(String(commandText || '').trim());
}

function normalizeBotAliases(aliases: string[] = ['@bot']): string[] {
  const base = aliases.length ? aliases : ['@bot'];
  return base.map((alias) => String(alias || '').trim()).filter(Boolean);
}

function stringifyId(id: string | number | undefined): string | undefined {
  if (id === undefined || id === null) return undefined;
  const value = String(id).trim();
  return value || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAllCaseInsensitive(text: string, needle: string, replacement: string): string {
  return text.replace(new RegExp(escapeRegExp(needle), 'gi'), replacement);
}
