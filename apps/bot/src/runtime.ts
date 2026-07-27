import { createBotRouter, extractReplyId, stripNonTextCqSegments, type BotMessageContext, type BotRouteDecision, type BotRouterConfig } from '../../../packages/bot-router/src/index.js';
import { createReplyStrategyEngine, type ReplyClient, type ReplyContext, type ReplyStrategyConfig } from '../../../packages/reply/src/index.js';
import { dedupeImageUrls, dedupeVideoUrls } from '../../../packages/napcat/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { BotEngineResult } from '../../../packages/bot-engine/src/index.js';
import type { BotApp } from './app.js';
import { isOwner, parseOwnerCommand, type OwnerCommand } from './owner.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { fetchGroupContext, type GroupContextOptions, type NapcatHistoryMessage } from './group-context.js';
import { extractForwardIds, extractReferenceText, formatForwardMessages, isReferencedFromBot } from './message-enrichment.js';

/** Napcat(OneBot) 上报的消息事件(只取本环需要的字段)。 */
export interface NapcatMessageEvent {
  post_type?: string;
  message_type?: 'group' | 'private';
  message_id?: number | string;
  group_id?: number | string;
  user_id?: number | string;
  self_id?: number | string;
  /** OneBot 事件时间戳(秒)，用于陈旧消息丢弃。 */
  time?: number;
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
  /** 可选:拉取被引用(回复)的消息(get_msg)。用于①判定回复是否指向 bot ②把引用消息里的图片/转发内容带回模型。 */
  fetchReferencedMessage?: (replyId: string | number) => Promise<NapcatMessageEvent | null>;
  /** 可选:展开合并转发消息(get_forward_msg),把转发节点文本/图片带给模型。 */
  fetchForwardMessage?: (forwardId: string) => Promise<NapcatHistoryMessage[] | null>;
  /** 可选:拉取群历史消息(@bot 时取最近群聊上下文)。由 start.ts 注入 napcat callAction。 */
  fetchGroupHistory?: (groupId: number | string, anchorMessageId: number | string, count: number) => Promise<NapcatHistoryMessage[]>;
  /** 文本回复转语音:返回 record 文件引用则发语音,返回空则发文本。 */
  voice?: (text: string) => Promise<string | null | undefined>;
  /**
   * 运行指标（可选）。写在 bot 进程，面板在 web 进程读同一个文件。
   * 不注入时所有埋点都是空操作。
   */
  metrics?: {
    record(event: 'message' | 'command' | 'chat' | 'image' | 'video' | 'voice' | 'error', count?: number): void;
    recordDuration(key: string, ms: number): void;
  };
  /** 主人命令(owner-only):匹配则优先于普通路由处理。handle 返回文本则回复。 */
  owner?: {
    ownerQQs: () => Array<string | number>;
    handle: (command: OwnerCommand, ctx: { chatType: 'group' | 'private'; groupId?: number | string; userId?: number | string; messageId?: number | string }) => Promise<string | null | undefined>;
  };
  /** 结构化日志器(对齐 monolith bot-runtime.mjs 的 logger);不给则无日志。 */
  logger?: StructuredLogger;
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
  const log = options.logger;
  // 会话内“只回最新”：记录每个会话最后一条已进入处理的消息序号，
  // chat 文本结果发送前若已有更新消息，则丢弃这份迟到回复（图/视频等昂贵产物不丢）。
  let messageSeq = 0;
  const latestSessionSeq = new Map<string, number>();
  async function handleMessageEvent(event: NapcatMessageEvent): Promise<BotRuntimeResult> {
    if (event.post_type && event.post_type !== 'message') return { handled: false, reason: 'not-a-message' };
    const cfg = options.getConfig();
    const chatType: 'group' | 'private' = event.message_type === 'private' ? 'private' : 'group';
    const rawMessage = typeof event.message === 'string' && event.message
      ? event.message
      : (event.raw_message || segmentsToRaw(event.message));
    const baseImages = extractImages(event);
    const baseVideos = extractVideos(event);
    const userId = event.user_id ?? event.sender?.user_id;
    const sessionId = chatType === 'group' ? `group:${event.group_id}:${userId}` : `private:${userId}`;
    log?.info('收到消息', { chatType, groupId: event.group_id, userId, rawMessage: rawMessage.slice(0, 100), images: baseImages.length, videos: baseVideos.length });

    // 自身消息过滤：Napcat 开了「上报自身消息」时 bot 自己的发言也会推过来，不拦会自问自答。
    const selfIdRaw = String(options.selfId?.() ?? cfg.bot.botQqId ?? '').trim();
    if (selfIdRaw && String(userId ?? '').trim() === selfIdRaw) {
      log?.info('消息被忽略', { reason: 'self-message' });
      return { handled: false, reason: 'self-message' };
    }

    // 陈旧消息丢弃：积压/重连补推的老消息不再回复，避免“两分钟前的问题现在才答”扎堆刷屏。
    const maxAgeSec = cfg.bot.staleMessageMaxAgeSeconds;
    if (maxAgeSec > 0 && typeof event.time === 'number' && event.time > 0) {
      const ageMs = Date.now() - event.time * 1000;
      if (ageMs > maxAgeSec * 1000) {
        log?.info('消息被忽略', { reason: 'stale-message', ageSeconds: Math.round(ageMs / 1000), maxAgeSeconds: maxAgeSec });
        return { handled: false, reason: 'stale-message' };
      }
    }

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

    // 引用消息富化:get_msg 拉取被回复的消息 → 取其图片/转发内容,并判定是否回复的是 bot("回复 bot"触发依赖此判定)。
    // 注意: reply id 必须同时从 segments 与 CQ 取(legacy bot-runtime 的 extractReplyIdFromSegments || extractReplyIdFromRaw)。
    // 仅依赖 raw_message 时,部分 Napcat/OneBot 实现只在 message[] 里放 reply 段,会导致引用图完全丢失。
    const selfId = options.selfId?.() ?? cfg.bot.botQqId;
    const includeQuoted = cfg.freeMode?.includeQuotedMessage !== false;
    const replyId = extractReplyIdFromEvent(event, rawMessage);
    let referenced: NapcatMessageEvent | null = null;
    if (includeQuoted && replyId && options.fetchReferencedMessage) {
      try {
        referenced = await options.fetchReferencedMessage(replyId);
      } catch (e) {
        log?.warn('fetchReferencedMessage failed', { replyId, error: String((e as Error)?.message || e) });
      }
    }
    const replyToBot = options.resolveReplyToBot
      ? await options.resolveReplyToBot(event)
      : (referenced ? isReferencedFromBot(referenced, selfId) : undefined);

    const ctx: BotMessageContext = {
      chatType,
      rawMessage,
      messageId: event.message_id,
      groupId: event.group_id,
      userId,
      replyToBot,
      originalChoiceAvailable: false,
    };

    const router = createBotRouter(toRouterConfig(cfg, options.selfId?.()));
    const decision = router.route(ctx);
    if (decision.kind === 'ignored') {
      log?.info('消息被忽略', { reason: decision.reason, rawMessage: rawMessage.slice(0, 80) });
      return { handled: false, reason: decision.reason };
    }
    log?.info('路由决策', { kind: decision.kind, commandText: (decision as any).commandText?.slice(0, 80) });

    // 本会话的最新消息序号——迟到的 chat 回复发送前会核对，被更新消息取代则不发。
    const seq = ++messageSeq;
    latestSessionSeq.set(sessionId, seq);

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

    // 转发富化:展开当前消息/引用消息里的合并转发(get_forward_msg),取文本 + 图片,
    // 连同引用消息的图片,合并进最终送模型的 images,避免引用图片与转发内容丢失。
    const forwardIds = [...extractForwardIds(event), ...(referenced ? extractForwardIds(referenced) : [])];
    const forwardNodes = await expandForwards(forwardIds, options, log);
    const referenceText = referenced ? extractReferenceText(referenced) : '';
    const forwardText = forwardNodes.length ? formatForwardMessages(forwardNodes, { maxChars: 4000 }) : '';
    const referencedImages = referenced ? extractImages(referenced) : [];
    const forwardImages = forwardNodes.flatMap((n) => extractImages(n as unknown as NapcatMessageEvent));
    const referencedVideos = referenced ? extractVideos(referenced) : [];
    const forwardVideos = forwardNodes.flatMap((n) => extractVideos(n as unknown as NapcatMessageEvent));
    const maxInputImages = Math.max(1, cfg.freeMode.maxInputImages || 6);
    // 引用/转发图片/视频是否并入模型输入:受 freeMode.includeQuotedMessage 控制(默认 true)。
    // 当前消息自带图/视频始终保留。
    const quotedImages = includeQuoted ? [...referencedImages, ...forwardImages] : [];
    const quotedVideos = includeQuoted ? [...referencedVideos, ...forwardVideos] : [];
    const enrichedImages = dedupeImageUrls([
      ...baseImages,
      ...quotedImages,
    ]).slice(0, maxInputImages);
    const enrichedVideos = dedupeVideoUrls([
      ...baseVideos,
      ...quotedVideos,
    ]).slice(0, maxInputImages);
    const hasReferencedImage = includeQuoted && (referencedImages.length > 0 || forwardImages.length > 0);
    const hasReferencedVideo = includeQuoted && (referencedVideos.length > 0 || forwardVideos.length > 0);
    if (referenced || forwardNodes.length || baseVideos.length) {
      log?.info('消息内容已富化', {
        replyId: replyId || null,
        referencedImages: referencedImages.length,
        forwardNodes: forwardNodes.length,
        forwardImages: forwardImages.length,
        enrichedImages: enrichedImages.length,
        enrichedVideos: enrichedVideos.length,
        hasReferencedImage,
        hasReferencedVideo,
        includeQuoted,
      });
    } else if (replyId && !referenced) {
      log?.warn('引用消息未能拉取', { replyId, includeQuoted, hasFetch: Boolean(options.fetchReferencedMessage) });
    }

    const metrics = options.metrics;
    metrics?.record('message');
    if (decision.kind === 'command') metrics?.record('command');
    const startedAt = Date.now();

    let result: BotEngineResult | null = null;
    try {
      if (decision.kind === 'chat' || decision.kind === 'freeMode') {
        // 纯用户文本送意图路由(不污染 edit/generate prompt);引用/转发文本由 engine 仅在 chat 路径注入。
        const cleanText = stripNonTextCqSegments(decision.commandText);
        // 空 @（无文本/图/视频/引用）不值得跑完整 LLM 流水线，直接快捷回复。
        if (!cleanText && !enrichedImages.length && !enrichedVideos.length && !referenceText && !forwardText) {
          await engine.replyText(replyCtx, '我在。直接说需求就行，比如提问、「生图 一只猫」，或发「帮助」看指令。', 'quote');
          log?.info('回复发送完成', { kind: 'empty-mention' });
          return { handled: true, kind: 'empty-mention' };
        }
        // 群聊上下文注入：@bot 时拉取最近群聊记录，让 bot 知道在聊什么。
        let context: string | undefined;
        const gc = cfg.bot.groupContext;
        if (chatType === 'group' && gc?.enabled && options.fetchGroupHistory && event.message_id && event.group_id) {
          const ctxOptions: GroupContextOptions = {
            messageCount: gc.messageCount,
            skipForward: gc.skipForward,
            includeImages: gc.includeImages,
            maxChars: gc.maxChars,
          };
          context = await fetchGroupContext({
            fetchHistory: options.fetchGroupHistory,
            groupId: event.group_id,
            anchorMessageId: event.message_id,
            selfId: options.selfId?.() ?? cfg.bot.botQqId,
            options: ctxOptions,
          });
          if (context) log?.info('群上下文已注入', { groupId: event.group_id, contextChars: context.length });
        }
        result = await options.app.handle({
          text: cleanText, images: enrichedImages, videos: enrichedVideos,
          hasReferencedImage, hasReferencedVideo, chatType, sessionId, context, referenceText, forwardText,
        });
      } else if (decision.kind === 'command') {
        // 命令类:图片用富化后的(引用图片可达改图/反推),提示词保持原始 args 不注入引用文本。
        result = await runCommand(options.app, decision, {
          text: stripNonTextCqSegments(decision.args), images: enrichedImages, videos: enrichedVideos,
          hasReferencedImage, hasReferencedVideo, chatType, sessionId,
        });
        if (!result) return { handled: false, reason: `command-unsupported:${decision.command}` };
      } else {
        return { handled: false, reason: 'no-route' };
      }
    } catch (error) {
      const errMsg = String((error as Error)?.message || error);
      metrics?.record('error');
      log?.error('引擎处理失败', { error: errMsg, kind: decision.kind, chatModel: cfg.llm.chatModel, chatNodeIndex: cfg.llm.chatNodeIndex, imageNodeIndex: cfg.llm.imageNodeIndex, freeModeNodeIndex: cfg.freeMode.nodeIndex });
      try { await engine.replyText(replyCtx, `处理失败: ${errMsg.slice(0, 200)}`, 'quote'); } catch { /* best-effort */ }
      return { handled: false, reason: 'engine-error' };
    }
    if (!result) return { handled: false, reason: 'no-result' };

    log?.info('引擎返回结果', {
      kind: result.kind, handled: result.handled, hasText: !!(result as any).text,
      imageCount: (result as any).images?.length || 0, videoCount: (result as any).videos?.length || 0,
      reason: (result as any).reason || (result as any).decision?.reason,
    });
    // 按实际产出的能力计数，总览页的四张卡和 24 小时图就是靠这里。
    const elapsed = Date.now() - startedAt;
    if (result.kind === 'chat') { metrics?.record('chat'); metrics?.recordDuration('chat', elapsed); }
    else if (result.kind === 'image.generate' || result.kind === 'image.edit') {
      metrics?.record('image', (result as { images?: string[] }).images?.length || 1);
      metrics?.recordDuration('image', elapsed);
    } else if (result.kind === 'video.generate') { metrics?.record('video'); metrics?.recordDuration('video', elapsed); }
    else if (result.kind === 'image.interrogate') { metrics?.recordDuration('interrogate', elapsed); }

    // 只回最新：chat 文本是对话性的，被同会话更新消息取代后不再迟到刷屏；
    // 图片/视频/反推产物昂贵且用户明确在等，照发。
    if (result.kind === 'chat' && latestSessionSeq.get(sessionId) !== seq) {
      log?.info('回复已被更新消息取代，不再发送', { sessionId, elapsedMs: elapsed });
      return { handled: result.handled, kind: 'chat-superseded' };
    }

    await sendResult(engine, replyCtx, result, options.voice, options.reply);
    log?.info('回复发送完成', { kind: result.kind });
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
  input: { text: string; images: string[]; videos?: string[]; hasReferencedImage?: boolean; hasReferencedVideo?: boolean; chatType: 'group' | 'private'; sessionId: string },
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

/** 递归展开合并转发(深度受限 + seen 防环),返回所有节点;拉取由注入的 fetchForwardMessage 完成。 */
async function expandForwards(
  forwardIds: string[],
  options: BotRuntimeOptions,
  log?: StructuredLogger,
  seen: Set<string> = new Set(),
  depth = 0,
): Promise<NapcatHistoryMessage[]> {
  if (depth >= 3 || !options.fetchForwardMessage) return [];
  const out: NapcatHistoryMessage[] = [];
  for (const fid of forwardIds) {
    const id = String(fid || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const nodes = await options.fetchForwardMessage(id);
      if (nodes?.length) {
        out.push(...nodes);
        // 转发节点里可能还嵌套转发,递归展开。
        const nested = nodes.flatMap((n) => extractForwardIds(n));
        if (nested.length) out.push(...await expandForwards(nested, options, log, seen, depth + 1));
      }
    } catch (e) {
      log?.warn('fetchForwardMessage failed', { forwardId: id, error: String((e as Error)?.message || e) });
    }
  }
  return out;
}

async function sendResult(
  engine: ReturnType<typeof createReplyStrategyEngine>,
  ctx: ReplyContext,
  result: BotEngineResult,
  voice?: (text: string) => Promise<string | null | undefined>,
  reply?: ReplyClient,
): Promise<void> {
  const videos = (result.videos || []).filter(Boolean);
  // 视频优先：单视频直发 type:video；多视频合并转发（见 ReplyStrategyEngine.replyVideos）。
  // QQ 注意：短视频有时长/大小/编码限制；超限时 Napcat 可能失败，可后续改发 file。
  if (videos.length === 1) { await engine.replyVideo(ctx, videos[0]); return; }
  if (videos.length > 1) { await engine.replyVideos(ctx, videos); return; }
  const images = (result.images || []).filter(Boolean);
  if (images.length === 1) { await engine.replyImage(ctx, images[0]); return; }
  if (images.length > 1) { await engine.replyImages(ctx, images); return; }
  if (result.text && result.text.trim()) {
    // 文本结果优先尝试转语音(失败则回退文本)。
    if (voice && reply) {
      try {
        const file = await voice(result.text);
        if (file) {
          // record 发送失败(如 Napcat 编码/风控失败)不能静默吞掉回复，落到文本兑底。
          if (ctx.chatType === 'group' && reply.sendGroupRecord && ctx.groupId !== undefined) {
            const rec = await reply.sendGroupRecord(ctx.groupId, file);
            if (rec?.success) return;
          } else if (ctx.chatType === 'private' && reply.sendPrivateRecord && ctx.userId !== undefined) {
            const rec = await reply.sendPrivateRecord(ctx.userId, file);
            if (rec?.success) return;
          }
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
    '· 视频: 自由模式说「生成视频 / 做个视频 / 视频 …」或 bang「video!」「6s!」「720p!」',
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

/**
 * 从消息事件提取图片引用。
 * 兼容: message[] 段 / message 为 CQ 字符串 / content 字段(转发节点) / raw_message CQ /
 * image|mface 段的 url|file|path / base64://。
 * 对齐 legacy bot-runtime.extractImageUrls,并覆盖 get_msg / get_forward_msg 常见结构。
 */
export function extractImages(event: NapcatMessageEvent | { message?: unknown; content?: unknown; raw_message?: string } | null | undefined): string[] {
  return extractMediaRefs(event, ['image', 'mface'], /\[CQ:(?:image|mface),([^\]]*)\]/gi, normalizeImageUrl, dedupeImageUrls);
}

/**
 * 从消息事件提取视频引用（OneBot type:video / CQ:video）。
 * 与 extractImages 并列，供引用/转发富化与模型输入（视频理解不支持时由 deps.chat 优雅降级）。
 */
export function extractVideos(event: NapcatMessageEvent | { message?: unknown; content?: unknown; raw_message?: string } | null | undefined): string[] {
  return extractMediaRefs(event, ['video'], /\[CQ:video,([^\]]*)\]/gi, normalizeVideoUrl, dedupeVideoUrls);
}

function extractMediaRefs(
  event: NapcatMessageEvent | { message?: unknown; content?: unknown; raw_message?: string } | null | undefined,
  types: string[],
  cqRe: RegExp,
  normalize: (url: string) => string,
  dedupe: (urls: string[]) => string[],
): string[] {
  if (!event || typeof event !== 'object') return [];
  const urls: string[] = [];
  const typeSet = new Set(types.map((t) => t.toLowerCase()));
  const push = (value: unknown) => {
    const u = String(value || '').trim();
    if (u) urls.push(u);
  };
  const visitSegments = (body: unknown) => {
    if (!body) return;
    if (typeof body === 'string') {
      for (const m of body.matchAll(cqRe)) {
        const params = m[1] || '';
        const hit = params.match(/(?:url|file|path)=([^,\]]+)/i);
        if (hit?.[1]) push(decodeCqValue(hit[1]));
      }
      return;
    }
    if (!Array.isArray(body)) return;
    for (const seg of body) {
      if (!seg || typeof seg !== 'object') continue;
      const type = String((seg as { type?: string }).type || '').toLowerCase();
      const data = ((seg as { data?: Record<string, unknown> }).data || {}) as Record<string, unknown>;
      if (typeSet.has(type)) {
        push(data.url || data.file || data.path);
      } else if (type === 'node') {
        visitSegments(data.content ?? data.message ?? (seg as { content?: unknown }).content);
      }
    }
  };

  const anyEvent = event as { message?: unknown; content?: unknown; raw_message?: string; data?: { message?: unknown; content?: unknown } };
  visitSegments(anyEvent.message);
  visitSegments(anyEvent.content);
  if (anyEvent.data && typeof anyEvent.data === 'object') {
    visitSegments(anyEvent.data.message);
    visitSegments(anyEvent.data.content);
  }
  const raw = typeof anyEvent.raw_message === 'string' ? anyEvent.raw_message : (typeof anyEvent.message === 'string' ? anyEvent.message : '');
  if (raw) visitSegments(raw);
  return dedupe(urls.map(normalize).filter(Boolean));
}

/**
 * 从 segments + CQ raw 提取 reply id。
 * 部分 Napcat 上报 raw_message 不含 [CQ:reply],仅 message[] 有 reply 段 —— 必须 segments 优先。
 */
export function extractReplyIdFromEvent(event: NapcatMessageEvent, rawMessage?: string): string | undefined {
  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (seg && seg.type === 'reply') {
        const id = seg.data?.id ?? seg.data?.message_id;
        if (id !== undefined && id !== null && String(id).trim()) return String(id).trim();
      }
    }
  }
  const raw = rawMessage ?? (typeof event.raw_message === 'string' ? event.raw_message : '') ?? segmentsToRaw(event.message);
  return extractReplyId(raw);
}

/**
 * 归一化图片引用:nappcat 产出的 base64:// / base64: 前缀转 data: URL,
 * 让 Anthropic/Gemini 方言(只认 data: 前缀)能正确解析。http(s)/data: 原样保留。
 */
export function normalizeImageUrl(url: string): string {
  const u = String(url || '').trim();
  if (!u) return u;
  if (/^data:/i.test(u) || /^https?:\/\//i.test(u)) return u;
  // base64://XXXX 或 base64:XXXX → data:image/png;base64,XXXX(napcat base64 默认 png)
  const m = u.match(/^base64:\/{0,2}([A-Za-z0-9+/=]+)$/i);
  if (m) return `data:image/png;base64,${m[1]}`;
  return u;
}

/** 视频引用归一：data:/http(s) 保留；base64:// → data:video/mp4;base64, */
export function normalizeVideoUrl(url: string): string {
  const u = String(url || '').trim();
  if (!u) return u;
  if (/^data:/i.test(u) || /^https?:\/\//i.test(u)) return u;
  const m = u.match(/^base64:\/{0,2}([A-Za-z0-9+/=]+)$/i);
  if (m) return `data:video/mp4;base64,${m[1]}`;
  return u;
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
      case 'at': parts.push(`[CQ:at,qq=${seg.data?.qq ?? seg.data?.user_id ?? ''}]`); break;
      case 'reply': parts.push(`[CQ:reply,id=${seg.data?.id ?? seg.data?.message_id ?? ''}]`); break;
      case 'image': parts.push(`[CQ:image,file=${seg.data?.url ?? seg.data?.file ?? seg.data?.path ?? ''}]`); break;
      case 'video': parts.push(`[CQ:video,file=${seg.data?.url ?? seg.data?.file ?? seg.data?.path ?? ''}]`); break;
      case 'mface': parts.push(`[CQ:mface,url=${seg.data?.url ?? seg.data?.file ?? ''}]`); break;
      case 'forward': parts.push(`[CQ:forward,id=${seg.data?.id ?? seg.data?.file ?? seg.data?.resid ?? seg.data?.res_id ?? ''}]`); break;
      default: break;
    }
  }
  return parts.join('');
}

function decodeCqValue(value: string): string {
  return String(value || '').replace(/&amp;/g, '&').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',');
}
