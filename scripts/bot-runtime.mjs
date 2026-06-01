#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBotRouter } from '../dist/packages/bot-router/src/index.js';
import { normalizeError } from '../dist/packages/core/src/index.js';
import { createDefaultConfig, importConfig } from '../dist/packages/config/src/index.js';
import { createFreeModeEngine } from '../dist/packages/free-mode/src/index.js';
import { createImageModule } from '../dist/packages/image/src/index.js';
import { createLogger, ConsoleLogSink } from '../dist/packages/logger/src/index.js';
import { createOpenAICompatibleAdapter } from '../dist/packages/llm/src/index.js';
import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createReplyStrategyEngine } from '../dist/packages/reply/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.MIOBOT_CONFIG_PATH || path.join(projectRoot, '.runtime', 'config.json');
const logger = createLogger({
  scope: 'bot',
  level: process.env.MIOBOT_LOG_LEVEL || 'info',
  sinks: [new ConsoleLogSink()],
});

const DIRECT_GROUP_COMMANDS = [
  'help',
  'clear',
  'originalImage',
  'templateLibrary',
  'referencedTemplateImage',
  'remotePromptSearch',
  'remotePromptSmartImage',
  'genImage',
  'editImage',
  'img2Img',
  'interrogate',
];

const FALLBACK_COMMANDS = {
  help: 'help, 帮助, 菜单',
  clear: '/clear, 清空, 清除上下文',
  originalImage: '原图, 下载原图',
  templateLibrary: '模板库, 反推库, 模板',
  referencedTemplateImage: '参考模板, 参考图模板',
  remotePromptSearch: '搜提示词, 搜模板',
  remotePromptSmartImage: '智能配图, 反推配图',
  genImage: '生图, 画图, 绘图, draw',
  editImage: '改图, 编辑图片, 修图',
  img2Img: '图生图, 垫图, 参考图',
  interrogate: '反推, 图片反推, 识图',
};

const MAX_REFERENCE_TEXT_CHARS = 16000;
const MAX_FORWARD_DEPTH = 2;

let currentAdapter = null;
let currentNapcatKey = '';
let ensureTimer = null;
const sessions = new Map();

function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) return createDefaultConfig();
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return importConfig(raw).config;
  } catch (error) {
    logger.error('读取配置失败，使用默认配置', { configPath, error: normalizeError(error) });
    return createDefaultConfig();
  }
}

function nodeAt(config, index, purpose) {
  const nodes = Array.isArray(config.llm?.apiKeys) ? config.llm.apiKeys : [];
  const preferred = nodes[normalizeIndex(index)];
  const node = preferred && preferred.enabled !== false ? preferred : nodes.find((item) => item?.enabled !== false);
  if (!node || !String(node.baseUrl || '').trim()) {
    throw new Error(`${purpose} 未配置可用模型节点，请在后台“模型与节点”里填写 Base URL 和 API Key 后保存配置。`);
  }
  return {
    name: node.name || purpose,
    baseUrl: String(node.baseUrl || '').trim(),
    key: String(node.key || '').trim(),
  };
}

function normalizeIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function createLlm(config, index, timeoutMs, purpose) {
  return createOpenAICompatibleAdapter({
    node: nodeAt(config, index, purpose),
    timeoutMs: Math.max(1, Number(timeoutMs) || 60000),
    logger: logger.child(`llm:${purpose}`),
    retryPolicy: {
      retries: Math.max(0, Number(config.llm?.imageRetryCount ?? 0)),
      delayMs: Math.max(0, Number(config.llm?.imageRetryDelayMs ?? 0)),
    },
  });
}

function createReply(adapter, config) {
  return createReplyStrategyEngine(adapter, {
    text: config.bot?.replyStrategies?.text || config.bot?.replyFormat || 'forward',
    image: config.bot?.replyStrategies?.image || config.bot?.replyFormat || 'forward',
    multiImage: config.bot?.replyStrategies?.multiImage || config.bot?.replyStrategies?.image || config.bot?.replyFormat || 'forward',
  });
}

function createImage(adapter, config, reply) {
  const llm = {
    generateImages: (request) => createLlm(config, config.llm?.imageNodeIndex, config.llm?.imageTimeoutMs, 'image').generateImages(request),
    editImage: (request) => createLlm(config, config.llm?.editNodeIndex ?? config.llm?.imageNodeIndex, config.llm?.imageTimeoutMs, 'image-edit').editImage(request),
    createVision: (request) => createLlm(config, config.llm?.interrogateNodeIndex ?? config.llm?.chatNodeIndex, config.llm?.interrogateTimeoutMs, 'interrogate').createVision(request),
  };
  return createImageModule({
    llm,
    reply,
    imageModel: config.llm?.imageModel || config.canvas?.imageModel || 'gpt-image-2',
    editModel: config.llm?.editModel || config.canvas?.editModel || config.llm?.imageModel || 'gpt-image-2',
    interrogateModel: config.llm?.interrogateModel || config.canvas?.interrogateModel || config.llm?.chatModel || 'gpt-4o-mini',
    defaultSize: config.canvas?.defaultSizePresetId === 'portrait-1k' ? '1024x1536' : config.canvas?.defaultSizePresetId === 'landscape-1k' ? '1536x1024' : '1024x1024',
    defaultCount: config.llm?.imageCount || config.canvas?.defaultCount || 1,
    defaultQuality: config.canvas?.defaultQuality || undefined,
    imageTimeoutMs: config.llm?.imageTimeoutMs || config.canvas?.imageTimeoutMs,
    editTimeoutMs: config.llm?.imageTimeoutMs || config.canvas?.imageTimeoutMs,
    interrogateTimeoutMs: config.llm?.interrogateTimeoutMs || config.canvas?.interrogateTimeoutMs,
    promptTemplates: config.bot?.promptTemplates || [],
    interrogatePromptTemplate: config.llm?.interrogatePromptTemplate || config.canvas?.interrogatePromptTemplate,
  });
}

function createRouter(config, botId) {
  return createBotRouter({
    botId,
    botAliases: (process.env.MIOBOT_BOT_ALIASES || '@bot,Miobot,Mio').split(/[,\uFF0C\n]/).map((item) => item.trim()).filter(Boolean),
    whitelistGroups: config.bot?.whitelistGroups || [],
    whitelistPrivate: config.bot?.whitelistPrivate || [],
    blacklistGroupUsers: config.bot?.blacklistGroupUsers || [],
    triggerModes: config.bot?.triggerModes || { mention: true, replyToBot: true },
    commands: withCommandFallbacks(config.bot?.commands || {}),
    freeModeEnabled: Boolean(config.freeMode?.enabled),
    chatEnabled: config.llm?.chatEnabled !== false,
    directGroupCommands: DIRECT_GROUP_COMMANDS,
  });
}

function withCommandFallbacks(commands) {
  const merged = { ...FALLBACK_COMMANDS, ...commands };
  for (const [key, fallback] of Object.entries(FALLBACK_COMMANDS)) {
    if (!commands[key]) continue;
    merged[key] = `${commands[key]}, ${fallback}`;
  }
  return merged;
}

async function ensureNapcat() {
  const config = loadConfig();
  const wsUrl = String(config.napcat?.wsUrl || '').trim();
  const token = String(config.napcat?.token || '');
  const nextKey = `${wsUrl}\n${token}`;
  if (!wsUrl) {
    logger.warn('Napcat WebSocket 地址为空，Bot 暂不连接。');
    return;
  }
  if (currentAdapter && nextKey === currentNapcatKey) return;

  if (currentAdapter) {
    logger.info('Napcat 配置变化，重建连接');
    currentAdapter.disconnect();
    currentAdapter = null;
  }

  currentNapcatKey = nextKey;
  const adapter = new NapcatAdapter({
    wsUrl,
    token,
    actionTimeoutMs: config.napcat?.actionTimeoutMs,
    textSendTimeoutMs: config.napcat?.textSendTimeoutMs,
    imageSendTimeoutMs: config.napcat?.imageSendTimeoutMs,
    forwardSendTimeoutMs: config.napcat?.forwardSendTimeoutMs,
    getMessageTimeoutMs: config.napcat?.getMessageTimeoutMs,
    logger: logger.child('napcat'),
  });

  adapter.on('open', (snapshot) => logger.info('Bot 已连接 Napcat', snapshot));
  adapter.on('message.group', (event) => void handleIncoming(adapter, event));
  adapter.on('message.private', (event) => void handleIncoming(adapter, event));
  currentAdapter = adapter;
  adapter.connect();
}

async function handleIncoming(adapter, event) {
  const config = loadConfig();
  const message = await normalizeIncomingMessage(adapter, event);
  if (!message) return;
  const botId = String(event.self_id || adapter.selfQqId || '');
  if (botId && String(message.userId || '') === botId) return;

  const router = createRouter(config, botId);
  const decision = router.route({
    chatType: message.chatType,
    rawMessage: message.rawMessage,
    messageId: message.messageId,
    groupId: message.groupId,
    userId: message.userId,
    replyToMessageId: message.replyToMessageId,
    replyToBot: message.replyToBot,
  });

  logger.info('收到消息并完成路由', {
    chatType: message.chatType,
    messageId: message.messageId,
    groupId: message.groupId,
    userId: message.userId,
    decision: decision.kind,
    reason: decision.reason,
    command: decision.command,
    commandText: decision.commandText,
    imageCount: message.images.length,
    referenceChars: String(message.referenceText || '').length,
    referenceImageCount: message.referenceImages?.length || 0,
  });

  if (decision.kind === 'ignored') return;

  const reply = createReply(adapter, config);
  const context = {
    chatType: message.chatType,
    groupId: message.groupId,
    userId: message.userId,
    senderId: message.userId,
    replyToMessageId: message.messageId,
    botName: 'Miobot',
  };

  try {
    if (decision.kind === 'command') {
      await handleCommand(adapter, config, reply, context, decision, message);
      return;
    }
    if (decision.kind === 'freeMode') {
      await handleFreeMode(adapter, config, reply, context, decision.args, message);
      return;
    }
    if (decision.kind === 'chat') {
      await handleChat(config, reply, context, withReferenceContext(decision.args, message));
    }
  } catch (error) {
    logger.error('消息处理失败', { error: normalizeError(error), decision });
    await reply.replyText(context, `处理失败：${error instanceof Error ? error.message : String(error)}`, 'quote');
  }
}

async function handleCommand(adapter, config, reply, context, decision, message) {
  const image = createImage(adapter, config, reply);
  const args = String(decision.args || '').trim();
  switch (decision.command) {
    case 'help':
      await reply.replyText(context, helpText(config));
      break;
    case 'clear':
      sessions.delete(sessionKey(context));
      await reply.replyText(context, '会话上下文已清空。');
      break;
    case 'templateLibrary':
      await reply.replyText(context, renderTemplateLibrary(config));
      break;
    case 'genImage':
      if (!config.llm?.imageEnabled) {
        await reply.replyText(context, '图像生成功能未启用，请在后台开启“图像生成”。');
        return;
      }
      await image.generate({ rawPrompt: withReferenceContext(args || message.commandText || '生成一张图片', message), context });
      break;
    case 'img2Img':
    case 'editImage': {
      const images = await imagesFromMessageOrReply(adapter, message);
      if (!images.length) {
        await reply.replyText(context, '请在消息里附带图片，或回复一条含图片的消息后再使用图生图/改图命令。');
        return;
      }
      await image.edit({ rawPrompt: args || '根据参考图重新生成', images, context });
      break;
    }
    case 'interrogate': {
      const images = await imagesFromMessageOrReply(adapter, message);
      if (!images.length) {
        await reply.replyText(context, '请附带图片，或回复一条含图片的消息后再使用反推命令。');
        return;
      }
      const result = await image.interrogate({ imageUrl: images[0], prompt: args || undefined });
      await reply.replyText(context, result.text || '未识别到反推结果。');
      break;
    }
    case 'referencedTemplateImage': {
      if (!config.llm?.imageEnabled) {
        await reply.replyText(context, '图像生成功能未启用，请在后台开启“图像生成”。');
        return;
      }
      const source = args || message.referenceText || message.commandText || '根据引用内容生成图片';
      await image.generate({ rawPrompt: withReferenceContext(source, message), context });
      break;
    }
    case 'remotePromptSearch': {
      await reply.replyText(context, renderTemplateSearch(config, args || message.referenceText || ''));
      break;
    }
    case 'remotePromptSmartImage': {
      if (!config.llm?.imageEnabled) {
        await reply.replyText(context, '图像生成功能未启用，请在后台开启“图像生成”。');
        return;
      }
      const query = String(args || message.referenceText || message.commandText || '').trim();
      const template = findBestTemplate(config, query);
      const rawPrompt = template ? renderLocalTemplate(template, query || message.referenceText || template.title) : withReferenceContext(query || '根据当前上下文生成图片', message);
      await image.generate({ rawPrompt, context });
      break;
    }
    case 'originalImage':
    case 'originalImageChoice': {
      const images = await imagesFromMessageOrReply(adapter, message);
      if (!images.length) {
        await reply.replyText(context, '没有在当前消息或引用消息里找到可发送的图片。');
        return;
      }
      if (decision.command === 'originalImageChoice') {
        const index = Math.max(0, Math.min(images.length - 1, Number.parseInt(args || decision.commandText || '1', 10) - 1));
        await reply.replyImages(context, [images[index]]);
      } else {
        await reply.replyImages(context, images);
      }
      break;
    }
    default:
      await reply.replyText(context, `未知命令：${decision.command}`);
  }
}

async function handleFreeMode(adapter, config, reply, context, args, message) {
  const image = createImage(adapter, config, undefined);
  const planner = createLlm(config, config.freeMode?.nodeIndex, config.freeMode?.timeoutMs, 'free-mode');
  const engine = createFreeModeEngine({
    planner,
    image,
    reply,
    model: config.freeMode?.model || config.llm?.chatModel || 'gpt-4o-mini',
    timeoutMs: config.freeMode?.timeoutMs,
    maxOutputImages: config.freeMode?.maxOutputImages,
    plannerPromptTemplate: config.freeMode?.plannerPromptTemplate,
    preferEditWhenImagePresent: config.freeMode?.preferEditWhenImagePresent,
  });
  await engine.handle({
    userContent: withReferenceContext(args, message),
    images: await imagesFromMessageOrReply(adapter, message),
    context,
  });
}

async function handleChat(config, reply, context, text) {
  const prompt = String(text || '').trim();
  if (!prompt) {
    await reply.replyText(context, '你想让我回复什么？');
    return;
  }
  const adapter = createLlm(config, config.llm?.chatNodeIndex, config.freeMode?.timeoutMs || 120000, 'chat');
  const key = sessionKey(context);
  const history = sessions.get(key) || [];
  const messages = [
    { role: 'system', content: '你是 Miobot，一个运行在 QQ/Napcat 上的中文机器人。回答要简洁、直接、有帮助。' },
    ...history,
    { role: 'user', content: prompt },
  ];
  const result = await adapter.createText({
    model: config.llm?.chatModel || 'gpt-4o-mini',
    messages,
    timeoutMs: config.freeMode?.timeoutMs || 120000,
    reasoningEffort: config.llm?.reasoningEffort,
  });
  const answer = trimReply(result.text, config.bot?.textReply?.maxChars);
  await reply.replyText(context, answer || '模型没有返回内容。');
  const next = [...history, { role: 'user', content: prompt }, { role: 'assistant', content: answer }];
  sessions.set(key, pruneHistory(next, config));
}

async function normalizeIncomingMessage(adapter, event) {
  const messageType = event.message_type || event.messageType;
  const chatType = messageType === 'group' ? 'group' : messageType === 'private' ? 'private' : '';
  if (!chatType) return null;

  const message = event.message ?? event.raw_message ?? '';
  const rawMessage = String(event.raw_message || segmentsToCq(message) || '').trim();
  const replyToMessageId = extractReplyIdFromSegments(message) || extractReplyIdFromRaw(rawMessage);
  const reference = replyToMessageId
    ? await resolveReferencedMessage(adapter, replyToMessageId, event.self_id || adapter.selfQqId)
    : emptyReferenceContext();
  const currentImages = extractImageUrls(message, rawMessage);
  return {
    chatType,
    rawMessage,
    commandText: rawMessage,
    messageId: event.message_id ?? event.messageId,
    groupId: event.group_id ?? event.groupId,
    userId: event.user_id ?? event.userId ?? event.sender?.user_id ?? event.sender?.userId,
    replyToMessageId,
    replyToBot: reference.replyToBot,
    referenceText: reference.text,
    referenceImages: reference.images,
    referenceMessageId: replyToMessageId,
    images: uniqueStrings([...currentImages, ...reference.images]),
  };
}

function segmentsToCq(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.map((segment) => {
    const type = segment?.type;
    const data = segment?.data || {};
    if (type === 'text') return String(data.text || '');
    if (type === 'at') return `[CQ:at,qq=${data.qq ?? data.user_id ?? ''}]`;
    if (type === 'reply') return `[CQ:reply,id=${data.id ?? data.message_id ?? ''}]`;
    if (type === 'image') return `[CQ:image,file=${data.file || data.url || ''}]`;
    return '';
  }).join('');
}

function extractReplyIdFromSegments(message) {
  if (!Array.isArray(message)) return undefined;
  const item = message.find((segment) => segment?.type === 'reply');
  const value = item?.data?.id ?? item?.data?.message_id;
  return value === undefined || value === null ? undefined : String(value);
}

function extractReplyIdFromRaw(raw) {
  return String(raw || '').match(/\[CQ:reply,[^\]]*id=([^,\]]+)/)?.[1];
}

function extractImageUrls(message, raw = '') {
  const urls = [];
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment?.type !== 'image') continue;
      const data = segment.data || {};
      const value = data.url || data.file || data.path;
      if (value) urls.push(String(value));
    }
  }
  for (const match of String(raw || '').matchAll(/\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)/g)) {
    if (match[1]) urls.push(decodeURIComponentSafe(match[1]));
  }
  return uniqueStrings(urls);
}

async function imagesFromMessageOrReply(adapter, message) {
  if (message.images.length) return message.images;
  return message.referenceImages || [];
}

async function isReplyToBot(adapter, messageId, botId) {
  if (!botId) return false;
  try {
    const data = await adapter.getMessage(messageId);
    return isMessageFromBot(data, botId);
  } catch (error) {
    logger.warn('判断引用消息归属失败', { messageId, error: normalizeError(error) });
    return false;
  }
}

function emptyReferenceContext() {
  return { text: '', images: [], replyToBot: false };
}

export async function resolveReferencedMessage(adapter, messageId, botId) {
  try {
    const data = await adapter.getMessage(messageId);
    const context = await collectMessageContext(adapter, data);
    return {
      ...context,
      replyToBot: isMessageFromBot(data, botId),
    };
  } catch (error) {
    logger.warn('读取引用消息失败', { messageId, error: normalizeError(error) });
    return emptyReferenceContext();
  }
}

export async function collectMessageContext(adapter, payload, depth = 0, seenForwardIds = new Set()) {
  const images = [];
  const textParts = [];
  const forwardItems = extractForwardMessageItems(payload);

  if (forwardItems.length) {
    for (const item of forwardItems.slice(0, 80)) {
      const child = await collectMessageContext(adapter, item, depth, seenForwardIds);
      if (child.text) textParts.push(formatForwardTextItem(item, child.text));
      images.push(...child.images);
    }
    return {
      text: truncateReferenceText(textParts.filter(Boolean).join('\n')),
      images: uniqueStrings(images),
    };
  }

  const baseText = extractMessageText(payload);
  if (baseText) textParts.push(baseText);
  images.push(...extractImageUrls(messageBodyOf(payload), rawMessageOf(payload)));

  if (depth < MAX_FORWARD_DEPTH && adapter?.getForwardMessage) {
    for (const forwardId of extractForwardIds(messageBodyOf(payload), rawMessageOf(payload))) {
      if (!forwardId || seenForwardIds.has(forwardId)) continue;
      seenForwardIds.add(forwardId);
      try {
        const forwardPayload = await adapter.getForwardMessage(forwardId);
        const child = await collectMessageContext(adapter, forwardPayload, depth + 1, seenForwardIds);
        if (child.text) textParts.push(`【合并聊天记录 ${forwardId}】\n${child.text}`);
        images.push(...child.images);
      } catch (error) {
        logger.warn('读取合并聊天记录失败', { forwardId, error: normalizeError(error) });
        textParts.push(`【合并聊天记录 ${forwardId} 读取失败】`);
      }
    }
  }

  return {
    text: truncateReferenceText(textParts.filter(Boolean).join('\n')),
    images: uniqueStrings(images),
  };
}

export function withReferenceContext(text, message) {
  const reference = truncateReferenceText(message?.referenceText || '');
  if (!reference) return String(text || '').trim();
  const body = String(text || '').trim() || '请根据引用内容处理。';
  const label = message?.referenceMessageId ? `【引用内容 #${message.referenceMessageId}】` : '【引用内容】';
  return truncateReferenceText(`${body}\n\n${label}\n${reference}`, Math.max(MAX_REFERENCE_TEXT_CHARS + body.length + label.length + 8, MAX_REFERENCE_TEXT_CHARS));
}

export function extractMessageText(payload) {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return cleanupRawText(payload);
  if (Array.isArray(payload)) {
    return payload.map(segmentToText).filter(Boolean).join('\n').trim();
  }
  if (typeof payload !== 'object') return '';

  if (Array.isArray(payload.message) || typeof payload.message === 'string') {
    return extractMessageText(payload.message);
  }
  if (Array.isArray(payload.content) || typeof payload.content === 'string') {
    return extractMessageText(payload.content);
  }
  if (Array.isArray(payload.data?.content) || typeof payload.data?.content === 'string') {
    return extractMessageText(payload.data.content);
  }
  if (typeof payload.raw_message === 'string') return cleanupRawText(payload.raw_message);
  if (typeof payload.message === 'object') return extractMessageText(payload.message);
  return '';
}

function segmentToText(segment) {
  if (!segment || typeof segment !== 'object') return '';
  const type = String(segment.type || '').toLowerCase();
  const data = segment.data || {};
  if (type === 'text') return String(data.text || '').trim();
  if (type === 'at') return '';
  if (type === 'reply') return '';
  if (type === 'image') return '[图片]';
  if (type === 'record') return '[语音]';
  if (type === 'video') return '[视频]';
  if (type === 'file') return `[文件：${data.name || data.file || data.file_name || '未命名'}]`;
  if (type === 'forward') return `[合并聊天记录：${data.id || data.file || data.resid || 'unknown'}]`;
  if (type === 'node') return extractMessageText(data.content || data.message || data);
  if (type === 'json') return extractJsonSegmentText(data.data || data.content || data.text || '');
  if (type === 'xml') return cleanupRawText(data.data || data.content || data.text || '[XML 消息]');
  return '';
}

function extractJsonSegmentText(value) {
  const raw = decodeURIComponentSafe(String(value || '')).trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return [
      parsed?.meta?.news?.title,
      parsed?.meta?.news?.desc,
      parsed?.meta?.detail_1?.title,
      parsed?.meta?.detail_1?.desc,
      parsed?.prompt,
      parsed?.summary,
    ].map((item) => String(item || '').trim()).filter(Boolean).join('\n') || raw.slice(0, 1000);
  } catch {
    return raw.slice(0, 1000);
  }
}

export function extractForwardIds(message, raw = '') {
  const ids = [];
  const body = messageBodyOf(message);
  if (Array.isArray(body)) {
    for (const segment of body) {
      if (segment?.type !== 'forward') continue;
      const data = segment.data || {};
      const value = data.id ?? data.file ?? data.resid;
      if (value !== undefined && value !== null) ids.push(String(value));
    }
  }
  const text = typeof raw === 'string' && raw ? raw : typeof message === 'string' ? message : '';
  for (const match of text.matchAll(/\[CQ:forward,[^\]]*(?:id|file|resid)=([^,\]]+)/g)) {
    if (match[1]) ids.push(decodeURIComponentSafe(match[1]));
  }
  return uniqueStrings(ids);
}

function extractForwardMessageItems(payload) {
  const direct =
    (Array.isArray(payload?.messages) && payload.messages) ||
    (Array.isArray(payload?.data?.messages) && payload.data.messages) ||
    (Array.isArray(payload?.forward?.messages) && payload.forward.messages) ||
    [];
  const items = [...direct];
  const body = messageBodyOf(payload);
  if (Array.isArray(body)) {
    for (const segment of body) {
      if (segment?.type !== 'node') continue;
      const data = segment.data || {};
      const content = data.content ?? data.message;
      if (content !== undefined) items.push({ ...data, message: content });
    }
  }
  return items.filter(Boolean);
}

function formatForwardTextItem(item, text) {
  const sender = item?.sender?.nickname || item?.sender?.card || item?.nickname || item?.user_name || item?.user_id || item?.userId;
  const body = String(text || '').trim();
  return sender ? `${sender}：${body}` : body;
}

function messageBodyOf(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.message !== undefined) return payload.message;
    if (payload.content !== undefined) return payload.content;
    if (payload.data?.message !== undefined) return payload.data.message;
    if (payload.data?.content !== undefined) return payload.data.content;
  }
  return payload;
}

function rawMessageOf(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return String(payload.raw_message || payload.rawMessage || payload.data?.raw_message || payload.data?.rawMessage || '');
  }
  return typeof payload === 'string' ? payload : '';
}

function isMessageFromBot(payload, botId) {
  if (!botId) return false;
  const sender = payload?.sender?.user_id ?? payload?.sender?.userId ?? payload?.user_id ?? payload?.userId ?? payload?.data?.sender?.user_id;
  return sender !== undefined && String(sender) === String(botId);
}

function cleanupRawText(raw) {
  return decodeURIComponentSafe(String(raw || ''))
    .replace(/\[CQ:reply,[^\]]+\]/g, '')
    .replace(/\[CQ:at,[^\]]+\]/g, '')
    .replace(/\[CQ:image,[^\]]+\]/g, '[图片]')
    .replace(/\[CQ:record,[^\]]+\]/g, '[语音]')
    .replace(/\[CQ:video,[^\]]+\]/g, '[视频]')
    .replace(/\[CQ:forward,[^\]]*(?:id|file|resid)=([^,\]]+)[^\]]*\]/g, (_all, id) => `[合并聊天记录：${decodeURIComponentSafe(id)}]`)
    .replace(/\[CQ:json,[^\]]*data=([^,\]]+)[^\]]*\]/g, (_all, data) => extractJsonSegmentText(data))
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateReferenceText(text, limit = MAX_REFERENCE_TEXT_CHARS) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 32)).trim()}\n……（引用内容过长，已截断）`;
}

function uniqueStrings(values) {
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function helpText(config) {
  const commands = config.bot?.commands || {};
  return [
    'Miobot 可用命令：',
    `- ${firstAlias(commands.genImage) || '生图'} <提示词>：生成图片`,
    `- ${firstAlias(commands.img2Img) || '图生图'} <提示词> + 图片：参考图生成`,
    `- ${firstAlias(commands.editImage) || '改图'} <提示词> + 图片：编辑图片`,
    `- ${firstAlias(commands.interrogate) || '反推'} + 图片：图片反推提示词`,
    `- ${firstAlias(commands.clear) || '/clear'}：清空当前会话`,
    '群聊普通对话需要 @机器人，图片命令可直接触发。',
  ].join('\n');
}

function renderTemplateLibrary(config) {
  const templates = config.bot?.promptTemplates || [];
  if (!templates.length) return '当前没有本地模板。';
  return templates.slice(0, 20).map((item) => `${item.id} · ${item.title}`).join('\n');
}

function renderTemplateSearch(config, query) {
  const templates = config.bot?.promptTemplates || [];
  if (!templates.length) return '当前没有本地提示词模板。';
  const keyword = String(query || '').trim().toLowerCase();
  const matches = keyword
    ? templates.filter((item) => `${item.id} ${item.title} ${item.prompt}`.toLowerCase().includes(keyword)).slice(0, 8)
    : templates.slice(0, 8);
  if (!matches.length) return `没有找到匹配模板：${String(query || '').trim()}`;
  return [
    keyword ? `找到 ${matches.length} 个相关模板：` : '可用模板：',
    ...matches.map((item, index) => `${index + 1}. ${item.id} · ${item.title}\n${String(item.prompt || '').slice(0, 180)}`),
  ].join('\n\n');
}

function findBestTemplate(config, query) {
  const templates = config.bot?.promptTemplates || [];
  if (!templates.length) return undefined;
  const keyword = String(query || '').trim().toLowerCase();
  if (!keyword) return templates[0];
  return templates.find((item) => String(item.id || '').toLowerCase() === keyword)
    || templates.find((item) => String(item.title || '').toLowerCase().includes(keyword))
    || templates.find((item) => String(item.prompt || '').toLowerCase().includes(keyword))
    || templates[0];
}

function renderLocalTemplate(template, prompt) {
  const rawPrompt = String(prompt || '').trim();
  const templateText = String(template?.prompt || '').trim();
  if (!templateText) return rawPrompt;
  const rendered = templateText
    .replace(/\{\{\s*rawPrompt\s*\}\}/g, rawPrompt)
    .replace(/\{\{\s*prompt\s*\}\}/g, rawPrompt)
    .trim();
  return rendered || rawPrompt;
}

function firstAlias(value) {
  return String(value || '').split(/[,，、;；|\n]/).map((item) => item.trim()).filter(Boolean)[0];
}

function sessionKey(context) {
  return context.chatType === 'group' ? `group:${context.groupId}` : `private:${context.userId}`;
}

function pruneHistory(messages, config) {
  const maxRounds = Math.max(1, Number(config.llm?.maxConversationRounds || 8));
  const maxChars = Math.max(1000, Number(config.llm?.maxConversationChars || 12000));
  let items = messages.slice(-maxRounds * 2);
  while (JSON.stringify(items).length > maxChars && items.length > 2) items = items.slice(2);
  return items;
}

function trimReply(text, maxChars) {
  const value = String(text || '').trim();
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0 || value.length <= n) return value;
  return `${value.slice(0, Math.max(1, n))}\n\n（内容过长已截断）`;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function startConfigWatcher() {
  if (ensureTimer) clearInterval(ensureTimer);
  ensureTimer = setInterval(() => {
    void ensureNapcat().catch((error) => logger.error('Napcat 配置检查失败', { error: normalizeError(error) }));
  }, Math.max(3000, Number(process.env.MIOBOT_CONFIG_POLL_MS || 5000)));
}

process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM，正在关闭 Bot');
  if (ensureTimer) clearInterval(ensureTimer);
  currentAdapter?.disconnect();
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('收到 SIGINT，正在关闭 Bot');
  if (ensureTimer) clearInterval(ensureTimer);
  currentAdapter?.disconnect();
  process.exit(0);
});

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMainModule()) {
  logger.info('Bot runtime starting', { configPath });
  await ensureNapcat();
  startConfigWatcher();
}
