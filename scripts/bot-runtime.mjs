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
const JSON_TEXT_KEYS = new Set(['text', 'content', 'summary', 'prompt', 'finalPrompt', 'title', 'desc', 'description']);
const FORWARD_ID_KEYS = new Set(['forward_id', 'forwardId', 'res_id', 'resid']);

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

async function maybeEnhancePrompt(config, rawPrompt, enhance = {}) {
  const prompt = String(rawPrompt || '').trim();
  if (!prompt) return prompt;
  const mode = enhance?.enhanceMode || 'none';
  if (mode === 'disable') return prompt;
  const shouldEnhance = mode === 'force' || mode === 'toggle' || Boolean(config.llm?.enhanceEnabled);
  const model = String(config.llm?.enhanceModel || '').trim();
  if (!shouldEnhance || !model || model === 'none') return prompt;
  try {
    const template = config.llm?.enhancePromptTemplate || '请把用户原始提示词改写为适合图像生成模型的提示词：{{rawPrompt}}';
    const instruction = renderRuntimeTemplate(template, { rawPrompt: prompt, prompt });
    const adapter = createLlm(config, config.llm?.enhanceNodeIndex, config.llm?.imageTimeoutMs || 120000, 'enhance');
    const result = await adapter.createText({
      model,
      timeoutMs: config.llm?.imageTimeoutMs || 120000,
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: prompt },
      ],
    });
    const enhanced = extractPromptFromModelText(result.text);
    if (enhanced) {
      logger.info('提示词润色完成', { mode, beforeLength: prompt.length, afterLength: enhanced.length });
      return enhanced;
    }
  } catch (error) {
    logger.warn('提示词润色失败，降级使用原始提示词', { error: normalizeError(error) });
  }
  return prompt;
}

function extractPromptFromModelText(value) {
  const cleaned = cleanupModelText(value);
  if (!cleaned) return '';
  try {
    const parsed = JSON.parse(cleaned);
    const fromJson = parsed?.prompt ?? parsed?.finalPrompt ?? parsed?.positive_prompt ?? parsed?.positivePrompt ?? parsed?.description ?? parsed?.text;
    if (fromJson) return String(fromJson).trim();
  } catch {}
  return cleaned;
}

function renderRuntimeTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
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
      await image.generate({
        rawPrompt: await maybeEnhancePrompt(config, withReferenceContext(args || message.commandText || '生成一张图片', message), decision.metadata?.enhance),
        context,
      });
      break;
    case 'img2Img':
    case 'editImage': {
      const images = await imagesFromMessageOrReply(adapter, message);
      if (!images.length) {
        await reply.replyText(context, '请在消息里附带图片，或回复一条含图片的消息后再使用图生图/改图命令。');
        return;
      }
      await image.edit({
        rawPrompt: await maybeEnhancePrompt(config, args || '根据参考图重新生成', decision.metadata?.enhance),
        images,
        context,
      });
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
      await image.generate({
        rawPrompt: await maybeEnhancePrompt(config, withReferenceContext(source, message), decision.metadata?.enhance),
        context,
      });
      break;
    }
    case 'remotePromptSearch': {
      await reply.replyText(context, await renderRemoteOrLocalTemplateSearch(config, args || message.referenceText || ''));
      break;
    }
    case 'remotePromptSmartImage': {
      if (!config.llm?.imageEnabled) {
        await reply.replyText(context, '图像生成功能未启用，请在后台开启“图像生成”。');
        return;
      }
      const query = String(args || message.referenceText || message.commandText || '').trim();
      const rawPrompt = await resolveRemoteOrLocalSmartPrompt(config, query || message.referenceText || message.commandText || '', message);
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
  const currentForwardContext = hasForwardPayload(message, rawMessage)
    ? await collectMessageContext(adapter, { message, raw_message: rawMessage })
    : emptyReferenceContext();
  const currentForwardText = currentForwardContext.text
    ? `【当前消息合并转发】\n${currentForwardContext.text}`
    : '';
  const referenceText = [reference.text, currentForwardText].filter(Boolean).join('\n\n');
  return {
    chatType,
    rawMessage,
    commandText: rawMessage,
    messageId: event.message_id ?? event.messageId,
    groupId: event.group_id ?? event.groupId,
    userId: event.user_id ?? event.userId ?? event.sender?.user_id ?? event.sender?.userId,
    replyToMessageId,
    replyToBot: reference.replyToBot,
    referenceText,
    referenceImages: uniqueStrings([...reference.images, ...currentForwardContext.images]),
    referenceMessageId: replyToMessageId,
    images: uniqueStrings([...currentImages, ...reference.images, ...currentForwardContext.images]),
  };
}

function hasForwardPayload(message, rawMessage = '') {
  return extractForwardIds(message, rawMessage).length > 0 || extractForwardMessageItems({ message, raw_message: rawMessage }).length > 0;
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
      await collectForwardContext(adapter, forwardId, depth, seenForwardIds, textParts, images);
    }
  }

  return {
    text: truncateReferenceText(textParts.filter(Boolean).join('\n')),
    images: uniqueStrings(images),
  };
}

async function collectForwardContext(adapter, forwardId, depth, seenForwardIds, textParts, images) {
  const id = String(forwardId || '').trim();
  if (!id || seenForwardIds.has(id) || depth >= MAX_FORWARD_DEPTH) return;
  seenForwardIds.add(id);

  const bridgedTargets = typeof adapter?.getForwardBridgeTargets === 'function'
    ? uniqueStrings(adapter.getForwardBridgeTargets(id) || [])
    : [];
  for (const target of bridgedTargets) {
    await collectForwardContext(adapter, target, depth + 1, seenForwardIds, textParts, images);
  }

  if (!adapter?.getForwardMessage) return;
  try {
    const forwardPayload = await adapter.getForwardMessage(id);
    const child = await collectMessageContext(adapter, forwardPayload, depth + 1, seenForwardIds);
    if (child.text) textParts.push(`【合并聊天记录 ${id}】\n${child.text}`);
    images.push(...child.images);
  } catch (error) {
    logger.warn('读取合并聊天记录失败', { forwardId: id, error: normalizeError(error) });
    textParts.push(`【合并聊天记录 ${id} 读取失败】`);
  }
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
  const structured = collectJsonTextFields(payload).join('\n').trim();
  if (structured) return structured;
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
  if (type === 'forward') return `[合并聊天记录：${data.id || data.file || data.resid || data.res_id || data.forward_id || data.forwardId || 'unknown'}]`;
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
    return collectJsonTextFields(parsed).join('\n') || raw.slice(0, 1000);
  } catch {
    return raw.slice(0, 1000);
  }
}

export function extractForwardIds(message, raw = '') {
  const ids = [];
  const body = messageBodyOf(message);
  collectForwardIdsFromUnknown(body, ids);
  const text = typeof raw === 'string' && raw ? raw : typeof message === 'string' ? message : '';
  for (const match of text.matchAll(/\[CQ:forward,[^\]]*(?:id|file|resid|res_id|forward_id)=([^,\]]+)/gi)) {
    if (match[1]) ids.push(decodeURIComponentSafe(match[1]));
  }
  return uniqueStrings(ids);
}

function collectJsonTextFields(value, result = [], depth = 0) {
  if (value === undefined || value === null || depth > 6) return result;
  if (typeof value === 'string') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonTextFields(item, result, depth + 1);
    return uniqueStrings(result);
  }
  if (typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'string' && JSON_TEXT_KEYS.has(key)) {
      const cleaned = cleanupJsonTextValue(item);
      if (cleaned) result.push(cleaned);
      continue;
    }
    if (typeof item === 'object') collectJsonTextFields(item, result, depth + 1);
  }
  return uniqueStrings(result).slice(0, 40);
}

function cleanupJsonTextValue(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text || /^https?:\/\//i.test(text) || /^base64:\/\//i.test(text)) return '';
  return text.length > 2000 ? `${text.slice(0, 1999).trim()}…` : text;
}

function collectForwardIdsFromUnknown(value, ids, depth = 0) {
  if (value === undefined || value === null || depth > 6) return;
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\[CQ:forward,[^\]]*(?:id|file|resid|res_id|forward_id)=([^,\]]+)/gi)) {
      if (match[1]) ids.push(decodeURIComponentSafe(match[1]));
    }
    const decoded = decodeURIComponentSafe(value).trim();
    if (/^[\[{]/.test(decoded)) {
      try { collectForwardIdsFromUnknown(JSON.parse(decoded), ids, depth + 1); } catch {}
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectForwardIdsFromUnknown(item, ids, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const type = String(value.type || '').toLowerCase();
  const data = value.data && typeof value.data === 'object' ? value.data : {};
  if (type === 'forward') {
    for (const key of ['id', 'file', 'resid', 'res_id', 'forward_id', 'forwardId']) {
      if (data[key] !== undefined && data[key] !== null) ids.push(String(data[key]));
    }
  }
  if (type === 'json') collectForwardIdsFromUnknown(data.data ?? data.content ?? data.text, ids, depth + 1);

  for (const [key, item] of Object.entries(value)) {
    if (FORWARD_ID_KEYS.has(key) && item !== undefined && item !== null && typeof item !== 'object') {
      ids.push(String(item));
      continue;
    }
    if (['message', 'content', 'messages', 'nodes', 'data', 'forward', 'meta', 'extra'].includes(key)) {
      collectForwardIdsFromUnknown(item, ids, depth + 1);
    }
  }
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
    .replace(/\[CQ:forward,[^\]]*(?:id|file|resid|res_id|forward_id)=([^,\]]+)[^\]]*\]/gi, (_all, id) => `[合并聊天记录：${decodeURIComponentSafe(id)}]`)
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
    `- ${firstAlias(commands.originalImage) || '原图'}：回复图片/合并转发后取原图`,
    `- ${firstAlias(commands.templateLibrary) || '模板库'}：查看本地模板`,
    `- ${firstAlias(commands.referencedTemplateImage) || '套模板'} <主体>：引用模板消息并生图`,
    `- ${firstAlias(commands.remotePromptSearch) || 'pp'} <关键词>：搜索 prompts.chat / 本地模板`,
    `- ${firstAlias(commands.remotePromptSmartImage) || 'spp'}! <描述>：智能套用模板生图`,
    `- ${firstAlias(commands.clear) || '/clear'}：清空当前会话`,
    `- 生图命令里可加 ${firstAlias(commands.toggleEnhance) || '润色'} / ${firstAlias(commands.disableEnhance) || '原文'} 控制提示词润色`,
    '群聊普通对话需要 @机器人，图片命令可直接触发。',
  ].join('\n');
}

function renderTemplateLibrary(config) {
  const templates = config.bot?.promptTemplates || [];
  if (!templates.length) return '当前没有本地模板。';
  return [
    `本地模板库（${templates.length} 个）：`,
    ...templates.slice(0, 20).map((item, index) => {
      const preview = String(item.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      return `${index + 1}. ${item.id} · ${item.title}${preview ? `\n${preview}` : ''}`;
    }),
  ].join('\n\n');
}

async function renderRemoteOrLocalTemplateSearch(config, query) {
  const parsedInput = parseRemotePromptInput(query);
  if (promptsChatEnabled(config)) {
    if (!parsedInput.query && !parsedInput.id) return remotePromptHelpText(config);
    try {
      if (parsedInput.id) {
        const prompt = await getPromptsChatPrompt(config, parsedInput.id);
        return renderRemotePromptDetail(config, prompt);
      }

      const displayLimit = Math.max(1, Math.min(10, Number(config.promptsChat?.displayLimit || 5)));
      const limit = Math.max(displayLimit, Math.min(50, Math.max(Number(config.promptsChat?.searchLimit || 20), parsedInput.page * displayLimit)));
      const searchQuery = await maybeRewriteRemoteSearchQuery(config, parsedInput.query);
      const prompts = await searchPromptsChat(config, searchQuery, {
        limit,
        type: parsedInput.type,
        category: parsedInput.category,
        tag: parsedInput.tag,
      });
      const ranked = rankRemotePrompts(prompts, `${parsedInput.query} ${searchQuery}`);
      const start = (parsedInput.page - 1) * displayLimit;
      const pageItems = ranked.slice(start, start + displayLimit);
      if (pageItems.length) return renderRemotePromptResults(config, parsedInput.query, searchQuery, pageItems, parsedInput.page, start, ranked.length);
      return `prompts.chat 没有搜到结果：${parsedInput.query}\n\n${renderTemplateSearch(config, parsedInput.query)}`;
    } catch (error) {
      logger.warn('prompts.chat 搜索失败，降级到本地模板库', { error: normalizeError(error) });
      return `prompts.chat 搜索失败，已改用本地模板库。\n\n${renderTemplateSearch(config, parsedInput.query || parsedInput.id)}`;
    }
  }
  return renderTemplateSearch(config, parsedInput.query || parsedInput.id);
}

export function parseRemotePromptInput(rawText = '') {
  let text = String(rawText || '').trim();
  let page = 1;
  let type = '';
  let category = '';
  let tag = '';

  text = text.replace(/\s+(?:p|page|page=|页|第)(\d{1,2})\s*$/i, (_full, rawPage) => {
    page = Math.max(1, Math.min(10, Number(rawPage || 1)));
    return '';
  }).trim();

  text = text.replace(/\btype[:=]([a-z]+)\b/ig, (_full, rawType) => {
    type = normalizeRemotePromptType(rawType);
    return '';
  }).trim();

  text = text.replace(/\b(?:cat|category)[:=]([a-z0-9_-]+)\b/ig, (_full, rawCategory) => {
    category = String(rawCategory || '').trim();
    return '';
  }).trim();

  text = text.replace(/\btag[:=]([a-z0-9_-]+)\b/ig, (_full, rawTag) => {
    tag = String(rawTag || '').trim();
    return '';
  }).trim();

  const idMatch = text.match(/^id[:：\s]+(.+)$/i);
  return {
    query: idMatch ? '' : text,
    id: idMatch ? idMatch[1].trim() : '',
    page,
    type,
    category,
    tag,
  };
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

async function resolveRemoteOrLocalSmartPrompt(config, query, message) {
  const cleanQuery = String(query || '').trim();
  if (promptsChatEnabled(config) && cleanQuery) {
    try {
      const smart = await buildSmartPromptsChatPrompt(config, cleanQuery);
      if (smart.finalPrompt) return smart.finalPrompt;
    } catch (error) {
      logger.warn('prompts.chat 智能模板失败', { error: normalizeError(error) });
      if (config.promptsChat?.fallbackToRawPrompt === false) throw error;
    }
  }
  const template = findBestTemplate(config, cleanQuery);
  return template ? renderLocalTemplate(template, cleanQuery || message.referenceText || template.title) : withReferenceContext(cleanQuery || '根据当前上下文生成图片', message);
}

async function buildSmartPromptsChatPrompt(config, rawPrompt) {
  const pc = config.promptsChat || {};
  const queries = await buildRemoteSmartSearchQueries(config, rawPrompt);
  const searchResults = await Promise.all(queries.map((item) => searchPromptsChat(config, item, {
    limit: pc.smartSearchLimit || 24,
    type: pc.searchType,
  }).catch((error) => {
    logger.warn('prompts.chat 智能搜索单路失败', { query: item, error: normalizeError(error) });
    return [];
  })));
  const ranked = mergeUniqueRemotePrompts(searchResults, rawPrompt);
  if (!ranked.length) return { selectedId: 'none', selectedTitle: 'none', reason: '未搜索到远程模板', finalPrompt: rawPrompt, queries };
  const candidates = await hydrateRemoteCandidates(config, ranked.slice(0, Math.max(1, Number(pc.smartCandidateLimit || 6))));
  const model = String(pc.smartModel || '').trim();
  if (!model || model === 'none') {
    const selected = candidates.find((item) => item.content) || candidates[0];
    return {
      selectedId: selected?.id || 'none',
      selectedTitle: selected?.title || 'none',
      reason: 'smartModel 未配置，使用排序最高模板',
      finalPrompt: selected ? renderRemotePromptContent(selected, rawPrompt) : rawPrompt,
      queries,
    };
  }
  try {
    const candidatesText = formatRemoteCandidatesForModel(config, candidates);
    const template = pc.smartPromptTemplate || 'Return JSON only: {"selectedId":"id or none","finalPrompt":"ready-to-use image prompt"}. User request: {{rawPrompt}}\n\nCandidate prompts:\n{{candidates}}';
    const instruction = renderRuntimeTemplate(template, { rawPrompt, candidates: candidatesText });
    const adapter = createLlm(config, pc.smartNodeIndex, 120000, 'prompts-chat-smart');
    const result = await adapter.createText({
      model,
      timeoutMs: 120000,
      messages: [{ role: 'system', content: instruction }],
    });
    const parsed = parseSmartRemotePromptResult(result.text, candidates, rawPrompt);
    logger.info('prompts.chat 智能模板融合完成', { selectedId: parsed.selectedId, selectedTitle: parsed.selectedTitle, reason: parsed.reason });
    return { ...parsed, queries };
  } catch (error) {
    logger.warn('prompts.chat 智能融合失败，使用排序最高模板', { error: normalizeError(error) });
    const selected = candidates.find((item) => item.content) || candidates[0];
    return {
      selectedId: selected?.id || 'none',
      selectedTitle: selected?.title || 'none',
      reason: '智能融合失败，使用排序最高模板',
      finalPrompt: selected ? renderRemotePromptContent(selected, rawPrompt) : rawPrompt,
      queries,
    };
  }
}

async function buildRemoteSmartSearchQueries(config, rawPrompt) {
  const primary = await maybeRewriteRemoteSearchQuery(config, rawPrompt);
  return uniqueStrings([
    primary,
    rawPrompt,
    `${primary} image prompt`,
    `${primary} cinematic`,
    `${primary} illustration`,
  ]).slice(0, 4);
}

function mergeUniqueRemotePrompts(promptLists, query) {
  const byId = new Map();
  for (const prompts of promptLists) {
    for (const prompt of prompts) {
      const key = prompt.id || `${prompt.title}:${prompt.contentPreview}`;
      if (!key || byId.has(key)) continue;
      byId.set(key, prompt);
    }
  }
  return rankRemotePrompts([...byId.values()], query);
}

async function hydrateRemoteCandidates(config, prompts) {
  return Promise.all(prompts.map(async (prompt) => {
    if (!prompt.id) return prompt;
    try {
      const detail = await getPromptsChatPrompt(config, prompt.id);
      return { ...prompt, ...detail, content: detail.content || prompt.content, contentPreview: detail.contentPreview || prompt.contentPreview };
    } catch (error) {
      logger.warn('prompts.chat 完整模板拉取失败，保留搜索摘要', { promptId: prompt.id, error: normalizeError(error) });
      return prompt;
    }
  }));
}

function formatRemoteCandidatesForModel(config, prompts) {
  const max = Math.max(400, Math.min(5000, Number(config.promptsChat?.smartCandidateContentChars || 1800)));
  return prompts.map((prompt, index) => [
    `Candidate ${index + 1}`,
    `id: ${prompt.id || 'none'}`,
    `title: ${prompt.title}`,
    prompt.type ? `type: ${prompt.type}` : '',
    prompt.category ? `category: ${prompt.category}` : '',
    prompt.tags?.length ? `tags: ${prompt.tags.join(', ')}` : '',
    prompt.description ? `description: ${prompt.description}` : '',
    `content:\n${String(prompt.content || prompt.contentPreview || '').slice(0, max)}`,
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

function parseSmartRemotePromptResult(raw, candidates, rawPrompt) {
  const cleaned = cleanupModelText(raw);
  let parsed = {};
  try { parsed = JSON.parse(cleaned); } catch { parsed = { finalPrompt: cleaned }; }
  const ids = new Set(candidates.map((item) => item.id).filter(Boolean));
  const selectedId = String(parsed.selectedId || parsed.id || '').trim();
  const matched = ids.has(selectedId) ? candidates.find((item) => item.id === selectedId) : undefined;
  const finalPrompt = String(parsed.finalPrompt || parsed.prompt || '').trim()
    || (matched ? renderRemotePromptContent(matched, rawPrompt) : cleaned || rawPrompt);
  return {
    selectedId: matched?.id || 'none',
    selectedTitle: matched?.title || String(parsed.selectedTitle || parsed.title || 'none').trim() || 'none',
    reason: String(parsed.reason || '').trim(),
    finalPrompt,
  };
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

function promptsChatEnabled(config) {
  return Boolean(config.promptsChat?.enabled && String(config.promptsChat?.endpoint || '').trim());
}

function remotePromptHelpText(config) {
  const commands = config.bot?.commands || {};
  const searchAlias = firstAlias(commands.remotePromptSearch) || 'pp';
  const smartAlias = firstAlias(commands.remotePromptSmartImage) || 'spp';
  return [
    'prompts.chat 远程模板库',
    `搜索：${searchAlias} 关键词`,
    `详情/筛选会尽量透传到 prompts.chat，当前 v2 会自动降级本地模板。`,
    `智能套用生图：${smartAlias}! 你的画面描述`,
  ].join('\n');
}

async function searchPromptsChat(config, query, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || config.promptsChat?.searchLimit || 10)));
  const args = { query: String(query || '').trim(), limit };
  const type = options.type || config.promptsChat?.searchType;
  if (type) args.type = normalizeRemotePromptType(type);
  if (options.category) args.category = String(options.category);
  if (options.tag) args.tag = String(options.tag);
  const parsed = await callPromptsChatTool(config, 'search_prompts', args);
  const items = Array.isArray(parsed?.prompts) ? parsed.prompts : Array.isArray(parsed) ? parsed : [];
  return items.map(normalizeRemotePrompt).filter((item) => item.id || item.title || item.content);
}

async function getPromptsChatPrompt(config, id) {
  const parsed = await callPromptsChatTool(config, 'get_prompt', { id: String(id || '').trim(), fill_variables: false });
  return normalizeRemotePrompt(parsed);
}

async function maybeRewriteRemoteSearchQuery(config, query) {
  const raw = String(query || '').trim();
  if (!raw) return raw;
  const pc = config.promptsChat || {};
  const model = String(pc.smartModel || '').trim();
  if (!pc.queryRewriteEnabled || !model || model === 'none') return raw;
  try {
    const template = pc.searchQueryPromptTemplate || 'Return JSON only: {"queries":["query"]}. User request: {{rawPrompt}}';
    const adapter = createLlm(config, pc.smartNodeIndex, Math.min(60000, Number(pc.requestTimeoutMs || 60000) || 60000), 'prompts-chat-query');
    const result = await adapter.createText({
      model,
      timeoutMs: Math.min(60000, Number(pc.requestTimeoutMs || 60000) || 60000),
      messages: [{ role: 'system', content: renderRuntimeTemplate(template, { rawPrompt: raw }) }],
    });
    const queries = parseRemoteQueryRewrite(result.text);
    return queries[0] || raw;
  } catch (error) {
    logger.warn('prompts.chat 搜索词改写失败，使用原始关键词', { error: normalizeError(error) });
    return raw;
  }
}

function parseRemoteQueryRewrite(raw) {
  const cleaned = cleanupModelText(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return uniqueStrings(parsed.map(String));
    if (Array.isArray(parsed?.queries)) return uniqueStrings(parsed.queries.map(String));
    if (parsed?.query) return uniqueStrings([String(parsed.query)]);
  } catch {}
  return uniqueStrings(cleaned.split(/\r?\n|[,，;]/).map((item) => item.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean));
}

async function callPromptsChatTool(config, name, args) {
  const endpoint = String(config.promptsChat?.endpoint || '').trim();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const apiKey = String(config.promptsChat?.apiKey || process.env.PROMPTS_API_KEY || '').trim();
  if (apiKey) headers.PROMPTS_API_KEY = apiKey;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(Math.max(5000, Number(config.promptsChat?.requestTimeoutMs || 20000))),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`prompts.chat HTTP ${response.status}`);
  const envelope = parseMcpEnvelope(raw);
  if (envelope?.error) throw new Error(envelope.error?.message || JSON.stringify(envelope.error));
  return parseToolJson(envelope?.result);
}

function parseMcpEnvelope(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  const eventPayloads = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  const candidates = eventPayloads.length ? eventPayloads : [text];
  let parsed;
  for (const item of candidates) parsed = JSON.parse(item);
  return parsed;
}

function parseToolJson(result) {
  const text = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text
    : '';
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { text }; }
}

function normalizeRemotePrompt(item) {
  const content = String(item?.content || item?.prompt || item?.contentPreview || item?.preview || '').trim();
  return {
    id: String(item?.id || '').trim(),
    slug: String(item?.slug || '').trim(),
    title: String(item?.title || item?.name || item?.slug || 'Untitled prompt').trim(),
    description: String(item?.description || '').trim(),
    content,
    contentPreview: String(item?.contentPreview || item?.preview || content || '').trim(),
    type: normalizeRemotePromptType(item?.type),
    author: String(item?.author || '').trim(),
    category: String(item?.category || '').trim(),
    tags: Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    votes: Number(item?.votes || 0),
    createdAt: String(item?.createdAt || item?.created_at || '').trim(),
    link: String(item?.link || item?.url || '').trim(),
  };
}

function normalizeRemotePromptType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ['TEXT', 'STRUCTURED', 'IMAGE', 'VIDEO', 'AUDIO'].includes(normalized) ? normalized : '';
}

function rankRemotePrompts(prompts, query) {
  const words = new Set(String(query || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/i).map((item) => item.trim()).filter((item) => item.length >= 2));
  return [...prompts].sort((a, b) => scoreRemotePrompt(b, words) - scoreRemotePrompt(a, words));
}

function scoreRemotePrompt(prompt, words) {
  const haystack = [prompt.title, prompt.description, prompt.category, prompt.tags?.join(' '), prompt.contentPreview, prompt.content].join(' ').toLowerCase();
  let score = 0;
  if (prompt.type === 'IMAGE') score += 40;
  if (/image|photo|portrait|cinematic|illustration|visual|generation/i.test(`${prompt.category} ${prompt.tags?.join(' ')}`)) score += 24;
  score += Math.min(20, Math.max(0, Number(prompt.votes || 0)) * 2);
  for (const word of words) if (haystack.includes(word)) score += 6;
  if (prompt.contentPreview || prompt.content) score += 4;
  return score;
}

function renderRemotePromptResults(config, query, searchQuery, prompts, page = 1, start = 0, total = prompts.length) {
  const searchAlias = firstAlias(config.bot?.commands?.remotePromptSearch) || 'pp';
  const smartAlias = firstAlias(config.bot?.commands?.remotePromptSmartImage) || 'spp';
  return [
    `prompts.chat: ${query}（第 ${page} 页 / 共 ${total} 条）`,
    searchQuery && searchQuery !== query ? `实际搜索词：${searchQuery}` : '',
    ...prompts.map((prompt, index) => {
      const rank = start + index + 1;
      const meta = formatRemotePromptMeta(prompt);
      const preview = String(prompt.contentPreview || prompt.content || '').replace(/\s+/g, ' ').slice(0, 180);
      return `${rank}. ${prompt.title}${prompt.id ? `\nID: ${prompt.id}` : ''}${meta ? `\n${meta}` : ''}${prompt.description ? `\n简介: ${prompt.description}` : ''}${preview ? `\n模板预览：${preview}` : ''}`;
    }),
    '',
    `查看详情：${searchAlias} id:<ID>`,
    `翻页：${searchAlias} ${query} p${page + 1}`,
    `智能套用生图：${smartAlias}! ${query}`,
  ].filter(Boolean).join('\n\n');
}

function renderRemotePromptDetail(config, prompt) {
  const searchAlias = firstAlias(config.bot?.commands?.remotePromptSearch) || 'pp';
  const smartAlias = firstAlias(config.bot?.commands?.remotePromptSmartImage) || 'spp';
  const content = String(prompt.content || prompt.contentPreview || '').trim();
  return [
    `prompts.chat 详情：${prompt.title}`,
    prompt.id ? `ID: ${prompt.id}` : '',
    formatRemotePromptMeta(prompt),
    prompt.description ? `简介：${prompt.description}` : '',
    prompt.link ? `链接：${prompt.link}` : '',
    content ? `模板内容：\n${content.slice(0, 3500)}${content.length > 3500 ? '\n……（内容过长已截断）' : ''}` : '该模板没有返回正文内容。',
    '',
    `继续搜索：${searchAlias} 关键词`,
    `套用生图：${smartAlias}! 你的画面描述`,
  ].filter(Boolean).join('\n\n');
}

function formatRemotePromptMeta(prompt) {
  return [
    prompt.type ? `类型: ${prompt.type}` : '',
    prompt.category ? `分类: ${prompt.category}` : '',
    prompt.author ? `作者: ${prompt.author}` : '',
    prompt.votes ? `票数: ${prompt.votes}` : '',
    prompt.tags?.length ? `标签: ${prompt.tags.join(', ')}` : '',
  ].filter(Boolean).join(' / ');
}

function renderRemotePromptContent(prompt, query) {
  const content = String(prompt.content || prompt.contentPreview || '').trim();
  if (!content) return query;
  if (/\{\{\s*(prompt|rawPrompt|input|subject)\s*\}\}/i.test(content)) {
    return content
      .replace(/\{\{\s*rawPrompt\s*\}\}/gi, query)
      .replace(/\{\{\s*prompt\s*\}\}/gi, query)
      .replace(/\{\{\s*input\s*\}\}/gi, query)
      .replace(/\{\{\s*subject\s*\}\}/gi, query)
      .trim();
  }
  return `${content}\n\nUser request: ${query}`.trim();
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

function cleanupModelText(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:json|text)?/i, '')
    .replace(/```$/i, '')
    .trim();
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
