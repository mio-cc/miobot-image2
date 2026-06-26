import { createBotRouter, stripNonTextCqSegments, type BotMessageContext, type BotRouteDecision, type BotRouterConfig } from '../../../packages/bot-router/src/index.js';
import { createReplyStrategyEngine, type ReplyClient, type ReplyContext, type ReplyStrategyConfig } from '../../../packages/reply/src/index.js';
import { dedupeImageUrls } from '../../../packages/napcat/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { BotEngineResult } from '../../../packages/bot-engine/src/index.js';
import type { BotApp } from './app.js';
import { isOwner, parseOwnerCommand, type OwnerCommand } from './owner.js';

/** Napcat(OneBot) 上报的消息事件(只取本环需要的字段)。 */
export interface NapcatMessageEvent {
  post_type?: string;
  message_type?: 'group' | 'private';
  message_id?: number | string;
  group_id?: number | string;
  user_id?: number | string;
  self_id?: number | string;
  raw_message?: string;
  message?: Array<{ type: string; data: Record<string, any> }> | string;
  sender?: { user_id?: number | string; nickname?: string };
}

export interface BotRuntimeOptions {
  app: BotApp;
  /** NapcatAdapter 结构上即是 ReplyClient(发送各类消息)。 */
  reply: ReplyClient;
  getConfig: () => AppConfig;
  /** 机器人自身 QQ(用于 mention 判定);不给则用 config.bot.botQqId。 */
  selfId?: () => string | number | undefined;
  botName?: string;
  /** 可选:对引用消息做 get_msg 判断是否回复的是 bot(影响群里"回复 bot"触发)。 */
  resolveReplyToBot?: (event: NapcatMessageEvent) => Promise<boolean> | boolean;
  /** 文本回复转语音:返回 record 文件引用则发语音,返回空则发文本。 */
  voice?: (text: string) => Promise<string | null | undefined>;
  /** 主人命令(owner-only):匹配则优先于普通路由处理。handle 返回文本则回复。 */
  owner?: {
    ownerQQs: () => Array<string | number>;
    handle: (command: OwnerCommand, ctx: { chatType: 'group' | 'private'; groupId?: number | string; userId?: number | string; messageId?: number | string }) => Promise<string | null | undefined>;
  };
}

export interface BotRuntimeResult {
  handled: boolean;
  kind?: string;
  reason?: string;
}

const DEFAULT_CLEAR_ALIASES = '/clear, 新对话, 清除对话, 清空对话, clear';

/**
 * 实时收发环:Napcat 消息 → bot-router 决策 → bot-engine(handleAuto/handleExplicit) → reply 发送。
 * chat 带会话记忆(sessionId);clear 清会话;help 自动生成。纯装配 + 依赖注入,可用 fake 单测。
 */
export function createBotMessageRuntime(options: BotRuntimeOptions) {
  async function handleMessageEvent(event: NapcatMessageEvent): Promise<BotRuntimeResult> {
    if (event.post_type && event.post_type !== 'message') return { handled: false, reason: 'not-a-message' };
    const cfg = options.getConfig();
    const chatType: 'group' | 'private' = event.message_type === 'private' ? 'private' : 'group';
    const rawMessage = typeof event.message === 'string' && event.message
      ? event.message
      : (event.raw_message || segmentsToRaw(event.message));
    const images = extractImages(event);
    const userId = event.user_id ?? event.sender?.user_id;
    const sessionId = chatType === 'group' ? `group:${event.group_id}` : `private:${userId}`;

    // 主人命令优先于普通路由。
    if (options.owner && isOwner(userId, options.owner.ownerQQs())) {
      const oc = parseOwnerCommand(stripNonTextCqSegments(rawMessage), { chatType, mentions: extractMentions(event), botId: options.selfId?.() ?? cfg.bot.botQqId });
      if (oc) {
        const text = await options.owner.handle(oc, { chatType, groupId: event.group_id, userId, messageId: event.message_id });
        if (text) {
          const ownerReply = createReplyStrategyEngine(options.reply, toReplyStrategyConfig(cfg));
          await ownerReply.replyText({ chatType, groupId: event.group_id, userId, senderId: userId, botName: options.botName || 'Miobot' }, text);
        }
        return { handled: true, kind: `owner:${oc.command}` };
      }
    }

    const ctx: BotMessageContext = {
      chatType,
      rawMessage,
      messageId: event.message_id,
      groupId: event.group_id,
      userId,
      replyToBot: options.resolveReplyToBot ? await options.resolveReplyToBot(event) : undefined,
      originalChoiceAvailable: false,
    };

    const router = createBotRouter(toRouterConfig(cfg, options.selfId?.()));
    const decision = router.route(ctx);
    if (decision.kind === 'ignored') return { handled: false, reason: decision.reason };

    const replyCtx: ReplyContext = {
      chatType,
      groupId: event.group_id,
      userId,
      senderId: userId,
      replyToMessageId: event.message_id,
      botName: options.botName || 'Miobot',
    };
    const engine = createReplyStrategyEngine(options.reply, toReplyStrategyConfig(cfg));

    // 纯文本类命令(clear/help)直接处理,不进引擎。
    if (decision.kind === 'command') {
      if (decision.command === 'clear') {
        options.app.sessions.clear(sessionId);
        await engine.replyText(replyCtx, '已开启新对话，之前的上下文已清除。');
        return { handled: true, kind: 'clear' };
      }
      if (decision.command === 'help') {
        await engine.replyText(replyCtx, buildHelpText(cfg));
        return { handled: true, kind: 'help' };
      }
      if (decision.command === 'templateLibrary') {
        await engine.replyText(replyCtx, buildTemplateLibraryText(cfg));
        return { handled: true, kind: 'templateLibrary' };
      }
    }

    let result: BotEngineResult | null = null;
    if (decision.kind === 'chat' || decision.kind === 'freeMode') {
      result = await options.app.handle({ text: stripNonTextCqSegments(decision.commandText), images, chatType, sessionId });
    } else if (decision.kind === 'command') {
      result = await runCommand(options.app, decision, { text: stripNonTextCqSegments(decision.args), images, chatType, sessionId });
      if (!result) return { handled: false, reason: `command-unsupported:${decision.command}` };
    } else {
      return { handled: false, reason: 'no-route' };
    }
    if (!result) return { handled: false, reason: 'no-result' };

    await sendResult(engine, replyCtx, result, options.voice, options.reply);
    return { handled: result.handled, kind: result.kind };
  }

  /** 订阅一个 Napcat adapter 的 message 事件(adapter.on('message', ...))。 */
  function attach(adapter: { on(event: string, handler: (data: any) => void | Promise<void>): unknown }): void {
    adapter.on('message', (data) => { void handleMessageEvent(data as NapcatMessageEvent); });
  }

  return { handleMessageEvent, attach };
}

async function runCommand(
  app: BotApp,
  decision: Extract<BotRouteDecision, { kind: 'command' }>,
  input: { text: string; images: string[]; chatType: 'group' | 'private'; sessionId: string },
): Promise<BotEngineResult | null> {
  switch (decision.command) {
    case 'genImage':
      return app.engine.handleExplicit('image.generate', input, { prompt: input.text });
    case 'editImage':
    case 'img2Img':
      return app.engine.handleExplicit('image.edit', input, { prompt: input.text });
    case 'interrogate':
      return app.engine.handleExplicit('image.interrogate', input, { prompt: input.text });
    default:
      // templateLibrary/originalImage*/remotePrompt* 需要额外子系统,后续批次接入。
      return null;
  }
}

async function sendResult(
  engine: ReturnType<typeof createReplyStrategyEngine>,
  ctx: ReplyContext,
  result: BotEngineResult,
  voice?: (text: string) => Promise<string | null | undefined>,
  reply?: ReplyClient,
): Promise<void> {
  const images = (result.images || []).filter(Boolean);
  if (images.length === 1) { await engine.replyImage(ctx, images[0]); return; }
  if (images.length > 1) { await engine.replyImages(ctx, images); return; }
  if (result.text && result.text.trim()) {
    // 文本结果优先尝试转语音(失败则回退文本)。
    if (voice && reply) {
      try {
        const file = await voice(result.text);
        if (file) {
          if (ctx.chatType === 'group' && reply.sendGroupRecord && ctx.groupId !== undefined) { await reply.sendGroupRecord(ctx.groupId, file); return; }
          if (ctx.chatType === 'private' && reply.sendPrivateRecord && ctx.userId !== undefined) { await reply.sendPrivateRecord(ctx.userId, file); return; }
        }
      } catch {
        // 语音失败,回退到文本。
      }
    }
    await engine.replyText(ctx, result.text);
  }
}

function buildHelpText(cfg: AppConfig): string {
  const c = cfg.bot.commands;
  const first = (alias: string | undefined, fallback: string): string => {
    const v = String(alias || '').split(/[,，、;；|\n]/)[0]?.trim();
    return v || fallback;
  };
  return [
    'Miobot 指令:',
    `· 生图: ${first(c.genImage, '生图')} <描述>`,
    `· 图生图: ${first(c.img2Img, '图生图')} <描述>（带图）`,
    `· 改图: ${first(c.editImage, '改图')} <描述>（带图）`,
    `· 反推: ${first(c.interrogate, '反推')}（带图）`,
    `· 本地模板库: ${first(c.templateLibrary, '模板库')}`,
    `· 远程模板: ${first(c.remotePromptSearch, 'pp')} / 智能生图: ${first(c.remotePromptSmartImage, 'spp')}`,
    `· 新对话: ${first(DEFAULT_CLEAR_ALIASES, '/clear')}`,
    '群里需 @机器人 或 回复机器人 触发；私聊直接说话即可。',
  ].join('\n');
}

function buildTemplateLibraryText(cfg: AppConfig): string {
  const templates = cfg.bot.promptTemplates || [];
  if (!templates.length) return '本地模板库为空。可在后台「提示词模板」添加。';
  const lines = templates.map((t) => `· ${t.id}: ${t.title}`);
  return ['本地模板库（生图时用 bang「mb_<编号>!」或模板 id 套用）:', ...lines].join('\n');
}

/** AppConfig → bot-router 配置。clear 别名在此收敛注入(旧脚本散在 FALLBACK)。 */
export function toRouterConfig(cfg: AppConfig, selfId?: string | number): BotRouterConfig {
  const bot = cfg.bot;
  const commands = { ...bot.commands } as BotRouterConfig['commands'];
  if (!commands.clear) commands.clear = DEFAULT_CLEAR_ALIASES;
  return {
    botId: bot.botQqId || selfId,
    whitelistGroups: bot.whitelistGroups,
    whitelistPrivate: bot.whitelistPrivate,
    blacklistGroupUsers: bot.blacklistGroupUsers,
    triggerModes: bot.triggerModes,
    commands,
    freeModeEnabled: cfg.freeMode.enabled,
    chatEnabled: cfg.llm.chatEnabled,
  };
}

/** AppConfig → reply 策略配置。 */
export function toReplyStrategyConfig(cfg: AppConfig): ReplyStrategyConfig {
  const s = cfg.bot.replyStrategies;
  return { text: s.text, image: s.image, multiImage: s.multiImage };
}

/** 从消息事件提取图片引用(segments 的 image 段 + raw_message 里的 CQ image)。 */
export function extractImages(event: NapcatMessageEvent): string[] {
  const urls: string[] = [];
  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (seg && seg.type === 'image') {
        const u = String(seg.data?.url || seg.data?.file || '').trim();
        if (u) urls.push(u);
      }
    }
  }
  const raw = typeof event.raw_message === 'string' ? event.raw_message : '';
  for (const m of raw.matchAll(/\[CQ:image,([^\]]*)\]/g)) {
    const params = m[1];
    const url = (params.match(/url=([^,\]]+)/) || params.match(/file=([^,\]]+)/) || [])[1];
    if (url) urls.push(decodeCqValue(url));
  }
  return dedupeImageUrls(urls);
}

/** 从消息事件提取被 @ 的 QQ 列表(segments at 段 + raw_message CQ at)。 */
export function extractMentions(event: NapcatMessageEvent): string[] {
  const out: string[] = [];
  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (seg && seg.type === 'at') {
        const q = String(seg.data?.qq || '').trim();
        if (q) out.push(q);
      }
    }
  }
  const raw = typeof event.raw_message === 'string' ? event.raw_message : '';
  for (const m of raw.matchAll(/\[CQ:at,[^\]]*qq=([^,\]]+)/g)) {
    const q = String(m[1] || '').trim();
    if (q) out.push(q);
  }
  return Array.from(new Set(out));
}

/** segments 数组重建为带 CQ 码的 raw 字符串(供 bot-router 解析 at/reply)。 */
export function segmentsToRaw(message: NapcatMessageEvent['message']): string {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  const parts: string[] = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    switch (seg.type) {
      case 'text': parts.push(String(seg.data?.text ?? '')); break;
      case 'at': parts.push(`[CQ:at,qq=${seg.data?.qq ?? ''}]`); break;
      case 'reply': parts.push(`[CQ:reply,id=${seg.data?.id ?? ''}]`); break;
      case 'image': parts.push(`[CQ:image,file=${seg.data?.file ?? seg.data?.url ?? ''}]`); break;
      default: break;
    }
  }
  return parts.join('');
}

function decodeCqValue(value: string): string {
  return String(value || '').replace(/&amp;/g, '&').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',');
}
