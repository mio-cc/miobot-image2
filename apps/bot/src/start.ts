import { NapcatAdapter } from '../../../packages/napcat/src/index.js';
import { createModelClient, createReloadableRegistry } from '../../../packages/model/src/index.js';
import { ConfigStore } from '../../../packages/storage/src/index.js';
import { createDefaultConfig, normalizeConfig, type AppConfig } from '../../../packages/config/src/index.js';
import { ConsoleLogSink, createLogger, type StructuredLogger } from '../../../packages/logger/src/index.js';
import { createBotApp } from './app.js';
import { createBotMessageRuntime, type NapcatMessageEvent } from './runtime.js';
import { toModelNodes, toCapabilityOverrides } from './config-bridge.js';
import { shouldUseTts, synthesizeSpeech } from './tts.js';
import type { OwnerCommand } from './owner.js';
import type { NapcatHistoryMessage } from './group-context.js';
import { normalizeForwardPayload } from './message-enrichment.js';

export interface StartBotOptions {
  /** 配置文件(JSON);不给则用默认配置(无可用节点,仅供连通性冒烟)。 */
  configFilePath?: string;
  logger?: StructuredLogger;
  botName?: string;
}

export interface RunningBot {
  adapter: NapcatAdapter;
  getConfig: () => AppConfig;
  stop: () => void;
}

/**
 * 启动 bot(v2 新架构):配置 → ModelClient(已加固方言/能力/规整) → bot-engine → runtime → 连 Napcat。
 * 与旧 scripts/bot-runtime.mjs 并行,互不影响;验证通过后再让 miobot-service 指向它。
 */
export function startBot(options: StartBotOptions = {}): RunningBot {
  const logger = options.logger || createLogger({ scope: 'bot-v2', level: 'info', sinks: [new ConsoleLogSink()] });
  const store = options.configFilePath
    ? new ConfigStore<AppConfig>(options.configFilePath, {
        defaultValue: createDefaultConfig(),
        normalize: normalizeConfig,
        onCorrupted: (info) => logger.error('config.json 解析失败', { reason: info.reason, backupPath: info.backupPath }),
      })
    : undefined;
  const config: AppConfig = store ? store.load() : createDefaultConfig();

  // 与 admin 同理：带着默认配置起来的 bot 是「白名单全空 = 谁都能用」，
  // 比起不起来危险得多。
  if (store?.isCorrupted()) {
    throw new Error(`config.json 解析失败，bot 拒绝启动：${store.corruptionReason()}。原文件未被覆盖，修好语法后重启。`);
  }
  const getConfig = (): AppConfig => config;

  const getRegistry = createReloadableRegistry(() => toCapabilityOverrides(getConfig().llm.capabilityOverrides));
  const registry = getRegistry();
  const client = createModelClient({ nodes: () => toModelNodes(getConfig()), registry: getRegistry, getNodeConcurrency: (i) => getConfig().llm.apiKeys?.[i]?.concurrency });
  const app = createBotApp({ getConfig, client, registry, log: logger });

  const nap = config.napcat;
  const adapter = new NapcatAdapter({
    wsUrl: nap.wsUrl,
    token: nap.token || undefined,
    actionTimeoutMs: nap.actionTimeoutMs,
    textSendTimeoutMs: nap.textSendTimeoutMs,
    imageSendTimeoutMs: nap.imageSendTimeoutMs,
    forwardSendTimeoutMs: nap.forwardSendTimeoutMs,
    getMessageTimeoutMs: nap.getMessageTimeoutMs,
    logger,
  });

  const runtime = createBotMessageRuntime({
    app,
    reply: adapter,
    getConfig,
    selfId: () => adapter.selfQqId || undefined,
    botName: options.botName || 'Miobot',
    logger,
    // 群聊上下文：@bot 时通过 napcat get_group_msg_history 拉取最近群聊记录。
    fetchGroupHistory: async (groupId, anchorMessageId, count): Promise<NapcatHistoryMessage[]> => {
      try {
        const resp = await adapter.callAction('get_group_msg_history', { group_id: groupId, message_id: anchorMessageId, count });
        const data = (resp?.data ?? {}) as { messages?: NapcatHistoryMessage[] };
        return Array.isArray(data.messages) ? data.messages : [];
      } catch (error) {
        logger.warn('get_group_msg_history failed', { groupId, error: String((error as { message?: string })?.message || error) });
        return [];
      }
    },
    // 引用消息富化:回复一张图片时,get_msg 取回引用消息,把图片带给模型并判定是否回复的是 bot。
    fetchReferencedMessage: async (replyId): Promise<NapcatMessageEvent | null> => {
      try {
        const data = await adapter.getMessage(replyId);
        return (data ?? null) as NapcatMessageEvent | null;
      } catch (error) {
        logger.warn('get_msg (referenced) failed', { replyId, error: String((error as { message?: string })?.message || error) });
        return null;
      }
    },
    // 合并转发富化:get_forward_msg 展开转发节点,文本/图片送模型,避免 [CQ:forward] 被剥离后内容丢失。
    fetchForwardMessage: async (forwardId): Promise<NapcatHistoryMessage[] | null> => {
      try {
        const data = await adapter.getForwardMessage(forwardId);
        return normalizeForwardPayload(data);
      } catch (error) {
        logger.warn('get_forward_msg failed', { forwardId, error: String((error as { message?: string })?.message || error) });
        return null;
      }
    },
    voice: async (text) => {
      const tts = getConfig().bot.tts;
      if (!shouldUseTts(tts, text)) return null;
      let speakText = text;
      const pre = tts.preprocess;
      if (pre?.enabled && String(pre.model || '').trim()) {
        try {
          const rendered = String(pre.promptTemplate || '').replace(/\{\{\s*text\s*\}\}/g, text);
          const res = await client.chat(pre.nodeIndex, { model: pre.model, messages: [{ role: 'user', content: rendered }] });
          const out = String(res.text || '').trim();
          if (out) speakText = out.slice(0, Math.max(1, Number(pre.maxOutputChars || 1000)));
          else if (!pre.fallbackToOriginal) return null;
        } catch {
          if (!pre.fallbackToOriginal) return null;
        }
      }
      try {
        const audio = await synthesizeSpeech(tts, speakText);
        return audio.file;
      } catch (error) {
        logger.warn('tts synthesize failed', { error: String((error as { message?: string })?.message || error) });
        return null;
      }
    },
    owner: {
      ownerQQs: () => getConfig().bot.ownerQQs,
      handle: (command, ownerCtx) => handleOwnerCommand(command, ownerCtx, { config, store }),
    },
  });
  runtime.attach(adapter);

  adapter.on('open', () => { logger.info('bot connected to napcat', { wsUrl: nap.wsUrl }); });
  adapter.on('close', (data) => { logger.warn('napcat connection closed', data as Record<string, unknown>); });
  adapter.on('error', (error) => { logger.error('napcat connection error', { error: String((error as { message?: string })?.message || error) }); });

  // 会话记忆空闲清理：按 sessionTtlMinutes 周期性清理超时会话，避免长期运行内存堆积。
  const sessionTtlMs = Math.max(0, (config.llm.sessionTtlMinutes ?? 0) * 60_000);
  let cleanupTimer: NodeJS.Timeout | undefined;
  if (sessionTtlMs > 0) {
    cleanupTimer = setInterval(() => {
      try {
        const removed = app.sessions.cleanup();
        if (removed) logger.info('session cleanup', { removed, ttlMinutes: config.llm.sessionTtlMinutes });
      } catch (e) { logger.warn('session cleanup failed', { error: String((e as { message?: string })?.message || e) }); }
    }, Math.max(60_000, Math.trunc(sessionTtlMs / 2)));
    cleanupTimer.unref?.();
  }

  logger.info('starting bot v2 runtime', {
    wsUrl: nap.wsUrl,
    hasToken: Boolean(nap.token),
    chatModel: config.llm.chatModel,
    imageModel: config.llm.imageModel,
    chatEnabled: config.llm.chatEnabled,
    nodes: config.llm.apiKeys.length,
  });
  adapter.connect();

  return { adapter, getConfig, stop: () => { if (cleanupTimer) clearInterval(cleanupTimer); adapter.disconnect(); } };
}

interface OwnerHandlerDeps { config: AppConfig; store?: ConfigStore<AppConfig> }

async function handleOwnerCommand(
  command: OwnerCommand,
  ctx: { chatType: 'group' | 'private'; groupId?: number | string; userId?: number | string; messageId?: number | string },
  deps: OwnerHandlerDeps,
): Promise<string | null> {
  const { config, store } = deps;
  const persist = () => { try { store?.save(config); } catch { /* best-effort */ } };
  switch (command.command) {
    case 'modelList':
      return buildModelListText(config);
    case 'switchModel': {
      const found = findModel(config, command.code);
      if (!found) return `未找到模型: ${command.code}`;
      config.llm.chatModel = found;
      persist();
      return `已切换 chat 模型为: ${found}`;
    }
    case 'ttsOn':
      config.bot.tts.enabled = true; persist();
      return '已开启 TTS 语音回复。';
    case 'ttsOff':
      config.bot.tts.enabled = false; persist();
      return '已关闭 TTS 语音回复。';
    case 'switchTtsVoice': {
      const voice = (config.bot.tts.voiceIds || [])[command.index - 1];
      if (!voice) return `未找到第 ${command.index} 个 TTS 音色。`;
      config.bot.tts.voiceId = voice; persist();
      return `已切换 TTS 音色为第 ${command.index} 个: ${voice}`;
    }
    case 'blacklist': {
      if (!command.targetUserId) return '请 @ 要拉黑的用户。';
      const entry = `${ctx.groupId ?? '*'}:${command.targetUserId}`;
      if (!config.bot.blacklistGroupUsers.includes(entry)) config.bot.blacklistGroupUsers.push(entry);
      persist();
      return `已拉黑: ${entry}`;
    }
    case 'whitelist': {
      if (!command.targetUserId) return '请 @ 要拉白的用户。';
      const id = String(command.targetUserId);
      if (!config.bot.whitelistPrivate.includes(id)) config.bot.whitelistPrivate.push(id);
      persist();
      return `已加入私聊白名单: ${id}`;
    }
    case 'recall':
      return '撤回功能尚未在新架构实现(需消息发送追踪)。';
    default:
      return null;
  }
}

function buildModelListText(config: AppConfig): string {
  const lines: string[] = [];
  config.llm.apiKeys.forEach((node, ni) => (node.models || []).forEach((m) => lines.push(`· ${m}${m === config.llm.chatModel ? ' (当前)' : ''} [节点${ni + 1}]`)));
  return lines.length ? ['可用模型(/切换 <名称> 切换 chat 模型):', ...lines].join('\n') : '未配置任何模型。';
}

function findModel(config: AppConfig, code: string): string | undefined {
  const norm = (s: string) => String(s || '').toLowerCase().replace(/_/g, '.');
  const target = norm(code);
  if (!target) return undefined;
  for (const node of config.llm.apiKeys) {
    for (const m of node.models || []) {
      const nm = norm(m);
      if (nm === target || nm.endsWith(target) || nm.includes(target)) return m;
    }
  }
  return undefined;
}
