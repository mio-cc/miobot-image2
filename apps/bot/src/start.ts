import { NapcatAdapter } from '../../../packages/napcat/src/index.js';
import { createModelClient, createReloadableRegistry } from '../../../packages/model/src/index.js';
import { ConfigStore } from '../../../packages/storage/src/index.js';
import { createFileMetricsStore, createMetrics } from '../../../packages/core/src/metrics.js';
import { createDefaultConfig, normalizeConfig, type AppConfig } from '../../../packages/config/src/index.js';
import { ConsoleLogSink, createLogger, type StructuredLogger } from '../../../packages/logger/src/index.js';
import { createBotApp } from './app.js';
import { createBotMessageRuntime, type FileReference, type NapcatMessageEvent } from './runtime.js';
import { toModelNodes, toCapabilityOverrides } from './config-bridge.js';
import { shouldUseTts, synthesizeSpeech } from './tts.js';
import type { OwnerCommand } from './owner.js';
import type { NapcatHistoryMessage } from './group-context.js';
import { normalizeForwardPayload } from './message-enrichment.js';
import { FeatureGate } from './feature-gate.js';
import { createOutboundImageCompressor } from './image-output.js';
import { createWebSearchService } from '../../../packages/search/src/index.js';
import { createBrowserRenderer } from '../../../packages/browser-render/src/index.js';
import { fetchComfyUiObjectInfo } from '../../../packages/comfyui/src/index.js';
import { PendingFileIndex, DEFAULT_FILE_PARSE_LIMITS } from '../../../packages/file-ingest/src/index.js';
import { derivePanelToken } from '../../../packages/web-api/src/index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvasGallerySync } from './canvas-gallery.js';
import {
  createImageInputPreparer,
  createNapcatImageReferenceResolver,
  type NapcatGetImageResponse,
} from './image-input.js';

export interface StartBotOptions {
  /** 配置文件(JSON);不给则用默认配置(无可用节点,仅供连通性冒烟)。 */
  configFilePath?: string;
  logger?: StructuredLogger;
  botName?: string;
  /**
   * 运行指标落盘路径。消息流在 bot 进程，而面板在 web 进程，
   * 两边只能靠这个文件交换数据——不给就不统计。
   */
  metricsFilePath?: string;
  /** 运行时数据目录（文件索引/临时文件）。默认取 config.json 所在目录。 */
  dataDir?: string;
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
  // 每次用配置都问一次文件；mtime 没变时 loadIfChanged 直接给缓存，代价只有一次 stat。
  // 这样面板保存后，bot 进程下一条消息就用上新配置，不需要重启——
  // 否则 web 和 bot 是两个进程，面板那句「无需重启」对机器人是假的。
  const getConfig = (): AppConfig => (store ? store.loadIfChanged() : config);
  const dataDir = options.dataDir || (options.configFilePath ? path.dirname(options.configFilePath) : path.resolve('.runtime'));
  const tempFileDir = path.join(dataDir, 'tmp-files');
  const fileIndex = new PendingFileIndex({ filePath: path.join(dataDir, 'pending-files.json'), ttlMs: Math.max(1, config.bot.files.indexTtlMinutes || 1440) * 60_000, maxPerChat: Math.max(10, config.bot.files.maxIndexPerChat || 200) });
  fileIndex.loadSync();
  void fs.mkdir(tempFileDir, { recursive: true }).catch(() => undefined);

  async function downloadIncomingFile(ref: FileReference, maxBytes = DEFAULT_FILE_PARSE_LIMITS.maxBytes): Promise<string> {
    const tempPath = path.join(tempFileDir, `${Date.now()}-${randomUUID()}-${path.basename(ref.name || 'file')}`);
    if (ref.size > maxBytes) throw new Error(`文件 ${ref.name} 大小 ${ref.size} bytes，超过上限 ${maxBytes} bytes`);
    if (ref.fileId || ref.file) {
      if (ref.size > 8 * 1024 * 1024 || String(process.env.MIOBOT_FILE_STREAM || '') === '1') {
        try {
          const streamed = await adapter.downloadFileStream({
            fileId: ref.fileId,
            file: ref.file,
            outputPath: tempPath,
            timeoutMs: 10 * 60 * 1000,
            onProgress: ({ receivedBytes, fileSize }) => logger.info('文件流式下载进度', { name: ref.name, receivedBytes, fileSize }),
          });
          if (streamed.totalBytes > maxBytes) throw new Error(`流式下载文件超过上限 ${maxBytes} bytes`);
          logger.info('文件流式下载完成', { name: ref.name, bytes: streamed.totalBytes });
          return tempPath;
        } catch (error) {
          logger.warn('文件流式下载失败，回退 get_file', { name: ref.name, error: String((error as Error)?.message || error) });
          await fs.unlink(tempPath).catch(() => undefined);
        }
      }
    }
    let response: any = null;
    if (ref.fileId || ref.file) {
      const params: Record<string, unknown> = ref.fileId ? { file_id: ref.fileId } : { file: ref.file };
      response = await adapter.callAction<any>('get_file', params, 120_000);
    }
    const data = response?.data || {};
    let base64 = String(data.base64 || data.data || '').trim();
    if (base64.startsWith('data:')) base64 = base64.slice(base64.indexOf(',') + 1);
    if (base64.startsWith('base64://')) base64 = base64.slice('base64://'.length);
    if (base64) {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > maxBytes) throw new Error(`下载文件超过上限 ${maxBytes} bytes`);
      await fs.writeFile(tempPath, buffer);
      return tempPath;
    }
    const sourceUrl = String(data.url || data.file_url || ref.url || '').trim();
    if (sourceUrl) {
      const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`下载文件失败 HTTP ${res.status}`);
      const length = Number(res.headers.get('content-length') || 0);
      if (length > maxBytes) throw new Error(`下载文件超过上限 ${maxBytes} bytes`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error(`下载文件超过上限 ${maxBytes} bytes`);
      await fs.writeFile(tempPath, buffer);
      return tempPath;
    }
    const localPath = String(data.file || ref.file || '').trim();
    if (localPath && !/^https?:/i.test(localPath)) {
      try {
        const stat = await fs.stat(localPath);
        if (stat.size > maxBytes) throw new Error(`本地文件超过上限 ${maxBytes} bytes`);
        await fs.copyFile(localPath, tempPath);
        return tempPath;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Napcat get_file 没有返回 base64、URL 或可访问的本地路径；请确认 enableLocalFile2Url 已开启');
  }

  // 指标写文件，web 进程读同一个文件。不配路径就不统计。
  const generatedFileDir = path.join(dataDir, 'generated-files');
  void fs.mkdir(generatedFileDir, { recursive: true }).catch(() => undefined);
  async function cleanupOldFiles(dir: string, maxAgeMs: number): Promise<void> {
    try {
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      const now = Date.now();
      await Promise.all(entries.map(async (name) => {
        const file = path.join(dir, name);
        try {
          const stat = await fs.stat(file);
          if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) await fs.unlink(file);
        } catch { /* best effort */ }
      }));
    } catch { /* best effort */ }
  }
  void cleanupOldFiles(tempFileDir, 60 * 60 * 1000);
  void cleanupOldFiles(generatedFileDir, 3 * 24 * 60 * 60 * 1000);

  async function uploadGeneratedFile(localPath: string, name: string, mime: string): Promise<string> {
    const buffer = await fs.readFile(localPath);
    if (buffer.length > 20 * 1024 * 1024) throw new Error('生成文件超过 20MiB，无法上传');
    const cfg = getConfig();
    const syncUrl = String(process.env.MIOBOT_CANVAS_SYNC_URL || '').trim();
    let uploadEndpoint: string;
    try {
      uploadEndpoint = syncUrl
        ? new URL('/canvas-api/bot/files', new URL(syncUrl).origin).toString()
        : `http://127.0.0.1:${cfg.panel.port}/canvas-api/bot/files`;
    } catch {
      uploadEndpoint = `http://127.0.0.1:${cfg.panel.port}/canvas-api/bot/files`;
    }
    const token = derivePanelToken(String(cfg.panel.passwordSeed || ''));
    const response = await fetch(uploadEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, mime, base64: buffer.toString('base64') }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`文件上传失败 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json() as { file?: { url?: string } };
    const assetUrl = String(body.file?.url || '').trim();
    if (!assetUrl) throw new Error('文件上传响应缺少 URL');
    const publicBase = String(process.env.MIOBOT_PUBLIC_BASE_URL || `http://127.0.0.1:${cfg.panel.port}`).replace(/\/+$/, '');
    if (!process.env.MIOBOT_PUBLIC_BASE_URL) logger.warn('MIOBOT_PUBLIC_BASE_URL 未配置，生成文件 URL 只能本机访问；Napcat 容器可能下载失败');
    return assetUrl.startsWith('http://') || assetUrl.startsWith('https://') ? assetUrl : `${publicBase}${assetUrl}`;
  }

  const metrics = options.metricsFilePath
    ? createMetrics({ store: createFileMetricsStore(options.metricsFilePath) })
    : undefined;

  const getRegistry = createReloadableRegistry(() => toCapabilityOverrides(getConfig().llm.capabilityOverrides));
  const client = createModelClient({ nodes: () => toModelNodes(getConfig()), registry: getRegistry, getNodeConcurrency: (i) => getConfig().llm.apiKeys?.[i]?.concurrency });
  // 注意别传 registry：createBotApp 一旦收到实例就退化成 `() => 该实例`，
  // 把它自己那条可热重载的分支整个绕过去。BotEngine 判断「这个模型支不支持生图/视频」
  // 用的就是这份注册表，于是用户在面板上加了能力覆盖、提示热重载成功，
  // bot 那边照旧回「当前模型不支持」，重启才认。
  const featureGate = new FeatureGate({ getConfig });
  const searchService = createWebSearchService({ getConfig, logger });
  const browserRenderer = createBrowserRenderer({ getConfig, logger });
  const app = createBotApp({
    getConfig,
    client,
    search: searchService,
    log: logger,
    beforeDispatch: async (decision, input) => {
      const featureId = input.featureId || (decision.kind === 'image.generate' ? 'image.generate'
        : decision.kind === 'image.edit' ? 'image.edit'
          : decision.kind === 'image.interrogate' ? 'image.interrogate'
            : decision.kind === 'video.generate' ? 'video.generate'
              : undefined);
      if (!featureId) return undefined;
      return featureGate.acquire({
        featureId,
        chatType: input.featureContext?.chatType || input.chatType,
        groupId: input.featureContext?.groupId,
        userId: input.featureContext?.userId,
        promptChars: input.featureContext?.promptChars,
      });
    },
  });

  const canvasGallerySync = createCanvasGallerySync({ getConfig, logger });

  const nap = config.napcat;
  const adapter = new NapcatAdapter({
    wsUrl: nap.wsUrl,
    token: nap.token || undefined,
    actionTimeoutMs: nap.actionTimeoutMs,
    textSendTimeoutMs: nap.textSendTimeoutMs,
    imageSendTimeoutMs: nap.imageSendTimeoutMs,
    forwardSendTimeoutMs: nap.forwardSendTimeoutMs,
    getMessageTimeoutMs: nap.getMessageTimeoutMs,
    // 这三个面板上能改、config 里也归一化了，但以前压根没传给适配器，
    // 于是「文件发送超时/重试次数/重试间隔」改了重启也不生效。
    // videoSendTimeoutMs 的 fallback 链也依赖 fileSendTimeoutMs。
    fileSendTimeoutMs: nap.fileSendTimeoutMs,
    fileSendRetryCount: nap.fileSendRetryCount,
    fileSendRetryDelayMs: nap.fileSendRetryDelayMs,
    logger,
  });

  const resolveLocalImageReference = createNapcatImageReferenceResolver({
    callGetImage: (file) => adapter.callAction<NonNullable<NapcatGetImageResponse['data']>>('get_image', { file }, Math.min(getConfig().napcat.actionTimeoutMs, 30000)),
    logger,
  });
  const prepareInputImages = createImageInputPreparer({
    logger,
    resolveLocalImage: resolveLocalImageReference,
  });

  /**
   * 把面板上改过的 napcat 配置推给适配器。
   *
   * 每条消息前调一次：getConfig 是 store.loadIfChanged（带 mtime+size 门控），
   * 文件没变时根本不会重读；applyOptions 也只是几个字段赋值，开销可忽略。
   * wsUrl / token 变了必须重连——连接就是照着它们建的。
   */
  const syncNapcat = () => {
    const next = getConfig().napcat;
    const { reconnectRequired } = adapter.applyOptions({
      wsUrl: next.wsUrl,
      token: next.token || undefined,
      actionTimeoutMs: next.actionTimeoutMs,
      textSendTimeoutMs: next.textSendTimeoutMs,
      imageSendTimeoutMs: next.imageSendTimeoutMs,
      forwardSendTimeoutMs: next.forwardSendTimeoutMs,
      getMessageTimeoutMs: next.getMessageTimeoutMs,
      fileSendTimeoutMs: next.fileSendTimeoutMs,
      fileSendRetryCount: next.fileSendRetryCount,
      fileSendRetryDelayMs: next.fileSendRetryDelayMs,
    });
    if (!reconnectRequired) return;
    logger.info('napcat 连接参数已变更，重连中', { wsUrl: next.wsUrl });
    adapter.disconnect();
    adapter.connect();
  };

  const runtime = createBotMessageRuntime({
    app,
    reply: adapter,
    getConfig: () => { syncNapcat(); return getConfig(); },
    selfId: () => adapter.selfQqId || undefined,
    botName: options.botName || 'Miobot',
    syncImagesToGallery: canvasGallerySync.syncImages,
    prepareInputImages,
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
        const data = await adapter.getMessage(replyId, Math.min(getConfig().napcat.getMessageTimeoutMs, 15000));
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
    metrics,
    featureGate,
    fileIndex,
    generatedFileDir,
    uploadFile: uploadGeneratedFile,
    browserRenderer,
    compressImages: createOutboundImageCompressor({ getConfig, uploadFile: uploadGeneratedFile, logger }),
    deleteMessage: (messageId) => adapter.deleteMessage(messageId),
    downloadFile: downloadIncomingFile,
    fileParseLimits: DEFAULT_FILE_PARSE_LIMITS,
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
        const audio = await synthesizeSpeech(tts, speakText, { logger });
        const delayMs = Math.max(0, Math.min(30000, Math.trunc(Number(pre?.delayMs || 0))));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return audio.file;
      } catch (error) {
        logger.warn('tts synthesize failed', { error: String((error as { message?: string })?.message || error) });
        return null;
      }
    },
    owner: {
      ownerQQs: () => getConfig().bot.ownerQQs,
      handle: (command, ownerCtx) => handleOwnerCommand(command, ownerCtx, { getConfig, store }),
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

/**
 * owner 指令要改并回存配置。这里必须收 getConfig 而不是一个 config 快照——
 * store.save 是**整文件覆盖**，拿启动快照去写等于把用户此后在面板上做的
 * 所有改动静默回滚掉，而且回滚发生在 bot 进程里，面板上完全看不出来。
 */
interface OwnerHandlerDeps { getConfig: () => AppConfig; store?: ConfigStore<AppConfig> }

async function handleOwnerCommand(
  command: OwnerCommand,
  ctx: { chatType: 'group' | 'private'; groupId?: number | string; userId?: number | string; messageId?: number | string },
  deps: OwnerHandlerDeps,
): Promise<string | null> {
  const { store } = deps;
  // 每条指令都从当前磁盘配置起步，改完再整份写回。
  const config = deps.getConfig();
  const persist = () => { try { store?.save(config); } catch { /* best-effort */ } };
  switch (command.command) {
    case 'modelList':
      return await buildModelListText(config);
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

async function buildModelListText(config: AppConfig): Promise<string> {
  const lines: string[] = ['【模型列表】', `当前文本模型：${config.llm.chatModel || '(未配置)'}`, ''];
  config.llm.apiKeys.forEach((node, ni) => {
    const models = node.models || [];
    lines.push(`节点 ${ni + 1}：${node.name || '未命名'}${node.enabled === false ? '（停用）' : ''}`);
    if (!models.length) lines.push(node.kind === 'comfyui' ? '  - ComfyUI：暂无已保存 Profile' : '  - 暂无已保存模型，请先在后台获取');
    else for (const model of models.slice(0, 80)) lines.push(`  - ${model}${model === config.llm.chatModel ? '（当前文本）' : ''}`);
    if (models.length > 80) lines.push(`  ... 其余 ${models.length - 80} 个省略`);
  });
  const comfyNodes = config.llm.apiKeys.map((node, index) => ({ node, index })).filter(({ node }) => node.kind === 'comfyui' && node.comfyui);
  if (comfyNodes.length) {
    lines.push('', 'ComfyUI 实时模型：');
    await Promise.all(comfyNodes.map(async ({ node, index }) => {
      lines.push(`节点 ${index + 1}：${node.name || 'ComfyUI'}`);
      const profiles = (node.comfyui?.profiles || []).map((p) => p.id).filter(Boolean);
      if (profiles.length) lines.push(`  - Profiles：${profiles.join(', ')}`);
      try {
        const info = await fetchComfyUiObjectInfo(node.baseUrl, { apiKey: node.key, headers: node.headers, timeoutMs: 5000 });
        const checkpoints = extractComfyUiModelNames(info);
        if (checkpoints.length) lines.push(`  - Checkpoints：${checkpoints.slice(0, 30).join(', ')}${checkpoints.length > 30 ? ` ... +${checkpoints.length - 30}` : ''}`);
        else lines.push('  - Checkpoints：未从 object_info 识别到 ckpt_name');
      } catch (error) {
        lines.push(`  - Checkpoints：读取失败（${String((error as Error)?.message || error).slice(0, 120)}）`);
      }
    }).map((task) => task));
  }
  const hf = config.huggingFace?.cachedModels || [];
  if (hf.length) {
    lines.push('', 'Hugging Face 缓存模型：');
    for (const model of hf.slice(0, 50)) lines.push(`  - ${model.code || model.id}: ${model.id}`);
    if (hf.length > 50) lines.push(`  ... 其余 ${hf.length - 50} 个省略`);
  }
  return lines.join('\n');
}

function extractComfyUiModelNames(info: unknown): string[] {
  const root = info && typeof info === 'object' && !Array.isArray(info) ? info as Record<string, any> : {};
  const names = new Set<string>();
  for (const node of Object.values(root)) {
    const record = node && typeof node === 'object' ? node as Record<string, any> : {};
    const inputs = { ...(record.input?.required || {}), ...(record.input?.optional || {}) };
    for (const field of ['ckpt_name', 'unet_name', 'lora_name']) {
      const value = inputs[field];
      if (Array.isArray(value) && Array.isArray(value[0])) {
        for (const item of value[0]) if (typeof item === 'string' && item) names.add(item);
      }
    }
  }
  return [...names].sort();
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
