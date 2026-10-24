import { NapcatAdapter } from '../../../packages/napcat/src/index.js';
import { createModelClient, createReloadableRegistry } from '../../../packages/model/src/index.js';
import { ConfigStore } from '../../../packages/storage/src/index.js';
import { createFileMetricsStore, createMetrics } from '../../../packages/core/src/metrics.js';
import { createDefaultConfig, normalizeConfig, type AppConfig } from '../../../packages/config/src/index.js';
import { ConsoleLogSink, createLogger, type StructuredLogger } from '../../../packages/logger/src/index.js';
import { createBotApp } from './app.js';
import { createBotMessageRuntime, handleCodeRenderRequest, handleFileGenerateCommand, handleFileReadCommand, handleWebScreenshotRequest, type BotRuntimeOptions, type FileReference, type NapcatMessageEvent } from './runtime.js';
import { toModelNodes, toCapabilityOverrides } from './config-bridge.js';
import { shouldUseTts, synthesizeSpeech } from './tts.js';
import type { OwnerCommand } from './owner.js';
import type { NapcatHistoryMessage } from './group-context.js';
import { normalizeForwardPayload } from './message-enrichment.js';
import { FeatureGate } from './feature-gate.js';
import { createOutboundImageCompressor, materializeImagesForNapcat } from './image-output.js';
import { runShadowOrchestration } from './orchestration-shadow.js';
import { ApprovalRuntime } from './approval-runtime.js';
import { buildCommandIntentPlan } from '../../../packages/orchestration/src/index.js';
import { ApprovalActionConsumer } from './approval-actions.js';
import { CapabilityTestActionConsumer } from './capability-test-actions.js';
import { MemoryActionConsumer } from './memory-actions.js';
import { ProblemReporter } from './problem-reporter.js';
import { PendingJobStore, type PendingJobRecord } from './pending-job-store.js';
import { JobRecoveryService } from './job-recovery.js';
import { FileDeleteCapabilityHandler, ManagedArtifactRegistry, type ArtifactScope } from './managed-artifacts.js';
import { AuditService } from './audit-service.js';
import { ChatMemoryService } from './memory-service.js';
import { FishAudioVoiceService } from './voice-service.js';
import { OwnerRecallCapabilityHandler } from './capability-owner.js';
import { createSentMessageTracker } from './sent-messages.js';
import { OrchestrationEnforcer } from './orchestration-enforce.js';
import { OrchestrationTraceWriter } from './orchestration-trace.js';
import { SchedulerService, buildDailyReport } from './scheduler.js';
import { ScheduleCapabilityHandler } from './capability-schedule.js';
import { RuntimeAdapterCapabilityHandler, executionFromBotResult } from './capability-runtime-adapters.js';
import { ImageStitchCapabilityHandler } from './capability-image.js';
import { CanvasGalleryCapabilityHandler } from './capability-canvas.js';
import { SunoSongHistoryStore } from './suno-song-history.js';
import { CanvasStore } from '../../../packages/canvas-service/src/index.js';
import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { createWebSearchService } from '../../../packages/search/src/index.js';
import { createBrowserRenderer } from '../../../packages/browser-render/src/index.js';
import { fetchComfyUiObjectInfo, probeComfyUiPrompt } from '../../../packages/comfyui/src/index.js';
import { SunoClient } from '../../../packages/orchestration/src/suno.js';
import { PendingFileIndex, DEFAULT_FILE_PARSE_LIMITS } from '../../../packages/file-ingest/src/index.js';
import { derivePanelToken } from '../../../packages/web-api/src/index.js';
import { promises as fs, readFileSync } from 'node:fs';
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
  stop: () => void | Promise<void>;
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
    const sunoSongHistory = new SunoSongHistoryStore({ filePath: path.join(dataDir, "suno-song-history.json"), maxRecords: () => getConfig().orchestration.suno.historyMaxRecords || 100, logger });
  const auditService = new AuditService({
    filePath: process.env.MIOBOT_AUDIT_FILE || path.join(dataDir, 'audit.jsonl'),
    enabled: () => getConfig().orchestration.audit.enabled,
    retentionDays: () => getConfig().orchestration.audit.retentionDays,
    logger,
  });
  const voiceService = new FishAudioVoiceService({
    getConfig,
    preferenceFile: path.join(dataDir, 'voice-preferences.json'),
    logger,
  });
  const tempFileDir = path.join(dataDir, 'tmp-files');
  const fileIndex = new PendingFileIndex({ filePath: path.join(dataDir, 'pending-files.json'), ttlMs: () => Math.max(1, getConfig().bot.files.indexTtlMinutes || 1440) * 60_000, maxPerChat: () => Math.max(10, getConfig().bot.files.maxIndexPerChat || 200) });
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
  const managedArtifacts = new ManagedArtifactRegistry({
    filePath: process.env.MIOBOT_MANAGED_ARTIFACTS_FILE || path.join(dataDir, 'managed-artifacts.json'),
    roots: [generatedFileDir, tempFileDir],
  });
  const uploadedLocalByUrl = new Map<string, { localPath: string; name: string; mime?: string }>();
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
  // T2.5：临时/生成文件清理从"仅启动一次"改为每日巡检，防长运行进程磁盘无界增长。
  const fileCleanupTimer = setInterval(() => {
    void cleanupOldFiles(tempFileDir, 60 * 60 * 1000);
    void cleanupOldFiles(generatedFileDir, 3 * 24 * 60 * 60 * 1000);
  }, 24 * 60 * 60 * 1000);
  fileCleanupTimer.unref?.();

  async function uploadGeneratedFile(localPath: string, name: string, mime: string): Promise<string> {
    const buffer = await fs.readFile(localPath);
    if (buffer.length > 20 * 1024 * 1024) throw new Error('生成文件超过 20MiB，无法上传');
    const cfg = getConfig();
    const syncUrl = String(process.env.MIOBOT_CANVAS_SYNC_URL || '').trim();
    let uploadEndpoint: string;
    try {
      uploadEndpoint = syncUrl
        ? new URL('/canvas-api/bot/files', new URL(syncUrl).origin).toString()
        : `http://127.0.0.1:${process.env.MIOBOT_PORT || process.env.MIOBOT_VERIFY_PORT || cfg.panel.port}/canvas-api/bot/files`;
    } catch {
      uploadEndpoint = `http://127.0.0.1:${process.env.MIOBOT_PORT || process.env.MIOBOT_VERIFY_PORT || cfg.panel.port}/canvas-api/bot/files`;
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
    const publicBase = String(process.env.MIOBOT_PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.MIOBOT_PORT || process.env.MIOBOT_VERIFY_PORT || cfg.panel.port}`).replace(/\/+$/, '');
    if (!process.env.MIOBOT_PUBLIC_BASE_URL) logger.warn('MIOBOT_PUBLIC_BASE_URL 未配置，生成文件 URL 只能本机访问；Napcat 容器可能下载失败');
    const finalUrl = assetUrl.startsWith('http://') || assetUrl.startsWith('https://') ? assetUrl : publicBase + assetUrl;
    uploadedLocalByUrl.set(finalUrl, { localPath, name, mime });
    if (uploadedLocalByUrl.size > 500) uploadedLocalByUrl.delete(uploadedLocalByUrl.keys().next().value as string);
    return finalUrl;
  }

  const artifactScope = (invocation: CapabilityInvocation): ArtifactScope => ({
    chatType: invocation.request.chat.type,
    groupId: invocation.request.chat.groupId,
    userId: invocation.request.user.qq,
  });
  const registerResultArtifacts = (invocation: CapabilityInvocation, result: ExecutionResult): ExecutionResult => {
    const scope = artifactScope(invocation);
    const outputs = (result.outputs || []).map((output) => {
      if (!['file', 'image', 'video'].includes(output.kind) || !output.url) return output;
      const uploaded = uploadedLocalByUrl.get(output.url);
      if (!uploaded) return output;
      try {
        const artifact = managedArtifacts.register({
          scope,
          localPath: uploaded.localPath,
          publicUrl: output.url,
          name: String(output.meta?.name || uploaded.name),
          mime: output.mime || uploaded.mime,
          source: invocation.step.capability,
        });
        return { ...output, meta: { ...(output.meta || {}), artifactId: artifact.artifactId } };
      } catch {
        return output;
      }
    });
    return { ...result, outputs };
  };
  const metrics = options.metricsFilePath
    ? createMetrics({ store: createFileMetricsStore(options.metricsFilePath) })
    : undefined;

  const getRegistry = createReloadableRegistry(() => toCapabilityOverrides(getConfig().llm.capabilityOverrides));
  const client = createModelClient({ nodes: () => toModelNodes(getConfig()), registry: getRegistry, getNodeConcurrency: (i) => getConfig().llm.apiKeys?.[i]?.concurrency });
  const memoryService = new ChatMemoryService({
    rootDir: getConfig().orchestration.memory.dataDir || path.join(dataDir, 'memory'),
    getConfig,
    logger,
    summarize: async ({ namespace, messages }) => {
      const cfg = getConfig();
      const transcript = messages.map((item) => (item.role === 'assistant' ? '助手' : '用户') + '(' + item.userId + '): ' + item.text).join('\n');
      const prompt = '你是会话记忆摘要器。请把以下聊天记录压缩成不超过 300 字的事实摘要，保留人物、偏好、未完成事项和重要上下文；不同 QQ 号是不同用户，不能合并；只输出摘要文本。\n范围：' + namespace.kind + '\n聊天记录：\n' + transcript.slice(0, 12000);
      const result = await client.chat(Number(cfg.llm.chatNodeIndex || 0), {
        model: String(cfg.llm.chatModel || ''),
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 500,
      });
      return String(result.text || '').trim();
    },
    // T3.4：夜间巩固重要性评分（LLM 批量打分 0-10，每批 50 条）。
    scoreImportance: async ({ documents }) => {
      const cfg = getConfig();
      const scores: number[] = [];
      for (let offset = 0; offset < documents.length; offset += 50) {
        const batch = documents.slice(offset, offset + 50);
        const lines = batch.map((doc, index) => offset + index + ': ' + (doc.role === 'assistant' ? '助手' : '用户') + ': ' + doc.text.slice(0, 120));
        const prompt = '你是记忆重要性评分器。给每条聊天记忆打 0-10 分（10=长期重要：人物偏好/事实承诺/未完成事项/关键决定；0=寒暄闲聊/无信息量）。只输出一个 JSON 数字数组，长度与输入条数一致，不要任何其他文字。\n' + lines.join('\n');
        const result = await client.chat(Number(cfg.llm.chatNodeIndex || 0), {
          model: String(cfg.llm.chatModel || ''),
          messages: [{ role: 'user', content: prompt.slice(0, 16000) }],
          temperature: 0,
          maxTokens: 2000,
        });
        const match = String(result.text || '').match(/\[[\s\S]*\]/);
        if (!match) throw new Error('memory_score_parse_failed');
        const values = JSON.parse(match[0]);
        if (!Array.isArray(values)) throw new Error('memory_score_not_array');
        for (const value of values) scores.push(Number(value) || 0);
      }
      return scores;
    },
  });
  // 注意别传 registry：createBotApp 一旦收到实例就退化成 `() => 该实例`，
  // 把它自己那条可热重载的分支整个绕过去。BotEngine 判断「这个模型支不支持生图/视频」
  // 用的就是这份注册表，于是用户在面板上加了能力覆盖、提示热重载成功，
  // bot 那边照旧回「当前模型不支持」，重启才认。
  // T0.2：能力默认配额（面板未显式配置时按 costClass 兜底；answer 类对话能力不限，
  // 防刷屏只针对副作用能力——生图/视频/音乐/语音/搜索等）。
  // T2.9a：成本断路器（轻量版）——群日限即单群场景的全局日限近似：
  // 免费模型/上游故障被刷爆时当日自动熔断（静默降级+problem 上报），面板可覆盖。
  const CAPABILITY_GATE_DEFAULTS: Record<string, { cooldownSec: number; userDailyLimit: number; groupDailyLimit: number }> = {
    free: { cooldownSec: 3, userDailyLimit: 0, groupDailyLimit: 0 },
    low: { cooldownSec: 10, userDailyLimit: 100, groupDailyLimit: 200 },
    medium: { cooldownSec: 30, userDailyLimit: 30, groupDailyLimit: 60 },
    high: { cooldownSec: 60, userDailyLimit: 10, groupDailyLimit: 20 },
  };
  let describeCapabilityForGate: ((id: string) => { enabled: boolean; costClass?: string; effect?: string } | undefined) | undefined;
  const featureGate = new FeatureGate({
    getConfig,
    resolveDefaultSetting: (featureId) => {
      const info = describeCapabilityForGate?.(featureId);
      if (!info || !info.enabled) return undefined;
      if (info.effect === 'answer' || info.effect === 'unknown' || !info.effect) return undefined;
      const limits = CAPABILITY_GATE_DEFAULTS[String(info.costClass || '')];
      if (!limits) return undefined;
      return { enabled: true, aliases: [], scopes: ['private', 'group'] as const, groupActivation: 'mention-or-reply' as const, naturalLanguage: true, limits: { cooldownSec: limits.cooldownSec, userDailyLimit: limits.userDailyLimit, groupDailyLimit: limits.groupDailyLimit } };
    },
  });
  const searchService = createWebSearchService({
    getConfig,
    logger,
    // T3.5 agentic：主 provider 空结果时用聊天模型改写查询重试一次（小 maxTokens，改写失败不影响原搜索）。
    rewriteQuery: async ({ query, oriQuestion }) => {
      try {
        const cfg = getConfig();
        const result = await client.chat(cfg.llm.chatNodeIndex, {
          model: cfg.llm.chatModel,
          messages: [
            { role: 'system', content: '你是搜索查询改写器。给搜索引擎的查询没有返回结果。请输出一个更容易命中的改写查询：换成更常见的表述、补全关键词、必要时改写为英文。只输出改写后的查询本身，不要任何解释或引号。' },
            { role: 'user', content: '用户问题：' + String(oriQuestion || '').slice(0, 200) + '\n没有结果的查询：' + query + '\n改写查询：' },
          ],
          maxTokens: 120,
          temperature: 0,
          timeoutMs: 15000,
        });
        return String(result.text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
      } catch {
        return undefined;
      }
    },
  });
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

  // T2.3：会话持久化——启动恢复快照、每 60s 落盘、退出 flush，重启不再失忆。
  const sessionsFile = path.join(dataDir, 'sessions.json');
  try {
    const parsed = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    const restored = app.sessions?.restore?.(parsed) || 0;
    if (restored > 0) logger?.info('会话快照已恢复', { restored });
  } catch { /* 首次启动或快照损坏 */ }
  const writeSessionsSnapshot = async (): Promise<void> => {
    try {
      const dump = app.sessions?.dump?.();
      if (!dump) return;
      await fs.mkdir(path.dirname(sessionsFile), { recursive: true });
      const temp = sessionsFile + '.tmp';
      await fs.writeFile(temp, JSON.stringify(dump), 'utf8');
      await fs.rename(temp, sessionsFile);
    } catch (error) {
      logger?.warn('会话快照写入失败', { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const sessionPersistTimer = setInterval(() => { void writeSessionsSnapshot(); }, 60_000);
  sessionPersistTimer.unref?.();

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

  let jobRecoveryService: JobRecoveryService | undefined;
  let approvalPersistQueue: Promise<void> = Promise.resolve();
  const approvalFile = process.env.MIOBOT_APPROVAL_FILE || path.join(dataDir, 'orchestration-approvals.json');
  let initialApprovals: any[] = [];
  try {
    const raw = readFileSync(approvalFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.approvals)) initialApprovals = parsed.approvals;
  } catch { /* first run or corrupt file: start empty */ }

  const approvalRuntime = new ApprovalRuntime({
    adminQqIds: () => getConfig().orchestration.approval.adminQqIds,
    ownerQqIds: () => getConfig().bot.ownerQQs,
    allowGroupReply: () => getConfig().orchestration.approval.allowGroupReply,
    allowedGroupIds: () => getConfig().orchestration.approval.allowedGroupIds,
    sendPrivate: async (qq, text) => {
      const result = await adapter.sendPrivateText(qq, text);
      return { success: result.success, messageId: result.messageId, uncertain: result.uncertain, error: result.error };
    },
    sendGroup: async (groupId, text) => {
      const result = await adapter.sendGroupText(groupId, text);
      return { success: result.success, messageId: result.messageId, uncertain: result.uncertain, error: result.error };
    },
    logger,
    initialApprovals,
    maxPendingPerUser: () => getConfig().orchestration.approval.maxPendingPerUser,
    maxPendingGlobal: () => getConfig().orchestration.approval.maxPendingGlobal,
    resendIntervalMs: () => getConfig().orchestration.approval.resendIntervalMs,
    maxResend: () => getConfig().orchestration.approval.maxResend,
    onDecision: (approval) => jobRecoveryService?.onDecision(approval),
    audit: (record) => auditService.append(record as any),
    persist: (approvals) => {
      const payload = JSON.stringify({ approvals }, null, 2);
      const tempFile = approvalFile + '.tmp';
      approvalPersistQueue = approvalPersistQueue
        .then(async () => {
          await fs.mkdir(path.dirname(approvalFile), { recursive: true });
          await fs.writeFile(tempFile, payload, 'utf8');
          await fs.rename(tempFile, approvalFile);
        })
        .catch(() => undefined);
    },
  });

  const approvalActionFile = process.env.MIOBOT_APPROVAL_ACTION_FILE || path.join(dataDir, 'orchestration-approval-actions.jsonl');
  const approvalActionConsumer = new ApprovalActionConsumer({
    actionFile: approvalActionFile,
    processedFile: path.join(dataDir, 'orchestration-approval-actions.done.json'),
    logger,
    onAction: async (action) => {
      approvalRuntime.decideFromPanel(action.code, action.decision, action.actor || 'panel');
    },
  });
  void approvalActionConsumer.start().catch((error) => logger.warn('审批面板文件监听启动失败', { error: String((error as Error)?.message || error) }));

  const problemReporter = new ProblemReporter({
    adminQqIds: () => getConfig().orchestration.approval.adminQqIds,
    ownerQqIds: () => getConfig().bot.ownerQQs,
    sendPrivate: async (qq, text) => {
      const result = await adapter.sendPrivateText(qq, text);
      return { success: result.success, messageId: result.messageId, uncertain: result.uncertain, error: result.error };
    },
    logger,
  });

  const traceFile = process.env.MIOBOT_TRACE_FILE || path.join(dataDir, 'orchestration-traces.jsonl');
  const traceWriter = new OrchestrationTraceWriter(traceFile, 2 * 1024 * 1024, {
    retentionDays: () => getConfig().orchestration.audit.retentionDays,
    maxEntries: 100000,
    maxBytes: 2 * 1024 * 1024,
  });

  // T4.3：定时提醒的 scheduler 引用（在下方 handlers 注册时尚未构造，声明在前闭包晚绑定）。
  let schedulerForSchedule: SchedulerService | undefined;
  // T3.1：调度器 + 每日聚合日报（§11.5 静默观测闭环；默认关，面板/配置开启）。
  const scheduler = new SchedulerService({
    filePath: path.join(dataDir, 'scheduled-jobs.json'),
    logger,
    run: async (job) => {
      // T4.3：定时提醒到点——合成消息走完整消息链（编排层可规划后续动作，如“提醒我查天气”），与 jobRecovery 同款注入方式。
      if (job.type === 'reminder') {
        const payload = (job.payload || {}) as { remindText?: string; chatType?: string; groupId?: string; userId?: string };
        const text = `提醒：${String(payload.remindText || '')}`;
        const chatType = payload.chatType === 'group' ? 'group' : 'private';
        const botQq = String(getConfig().bot.botQqId || adapter.selfQqId || '');
        const rawMessage = chatType === 'group' && botQq ? `[CQ:at,qq=${botQq}] ${text}` : text;
        const message = chatType === 'group'
          ? [...(botQq ? [{ type: 'at', data: { qq: botQq } }] : []), { type: 'text', data: { text: ' ' + text } }]
          : [{ type: 'text', data: { text } }];
        await runtime.handleMessageEvent({
          post_type: 'message',
          message_type: chatType,
          group_id: payload.groupId === undefined ? undefined : Number(payload.groupId) || payload.groupId,
          user_id: Number(payload.userId) || payload.userId,
          self_id: Number(botQq) || botQq || undefined,
          message_id: 'schedule_' + job.id + '_' + Date.now(),
          time: Math.floor(Date.now() / 1000),
          raw_message: rawMessage,
          message,
          sender: { user_id: payload.userId },
        } as any);
        return text;
      }
      // T3.4：记忆夜间巩固（03:30）——评分 + 归并 + 淘汰 + retention prune，memory 关闭时自身零计数返回。
      if (job.type === 'memory-consolidate') {
        const stats = await memoryService.consolidate();
        if (stats.namespaces || stats.merged || stats.evicted || stats.pruned) {
          logger?.info('记忆夜间巩固完成', stats as unknown as Record<string, unknown>);
        }
        return null;
      }
      if (job.type !== 'daily-report') return null;
      const text = await buildDailyReport({ traceFile, dataDir });
      const targets = getConfig().bot.ownerQQs || [];
      for (const ownerQq of targets) {
        try {
          const sent = await adapter.sendPrivateText(Number(ownerQq) || ownerQq, text);
          if (!sent.success) logger?.warn('日报发送失败', { ownerQq, error: sent.error });
        } catch { /* 单个目标失败不影响其他 */ }
      }
      return targets.length ? text : null;
    },
  });
  if (getConfig().bot.dailyReport?.enabled) {
    scheduler.register({ id: 'daily-report', kind: 'daily', type: 'daily-report', hour: getConfig().bot.dailyReport.hour, minute: getConfig().bot.dailyReport.minute, enabled: true });
  }
  schedulerForSchedule = scheduler;
  // T3.4：记忆夜间巩固——固定 03:30 低峰执行；memory 未启用时 consolidate 自身返回零计数。
  scheduler.register({ id: 'memory-consolidate', kind: 'daily', type: 'memory-consolidate', hour: 3, minute: 30, enabled: true });
  void scheduler.start();

  const pendingJobFile = process.env.MIOBOT_PENDING_JOB_FILE || path.join(dataDir, 'orchestration-pending-jobs.json');
  let initialPendingJobs: any[] = [];
  try {
    const parsed = JSON.parse(readFileSync(pendingJobFile, 'utf8'));
    if (Array.isArray(parsed?.jobs)) initialPendingJobs = parsed.jobs;
  } catch { /* first run */ }
  let pendingJobPersistQueue: Promise<void> = Promise.resolve();
  const pendingJobStore = new PendingJobStore((jobs) => {
    const payload = JSON.stringify({ jobs }, null, 2);
    const tempFile = pendingJobFile + '.tmp';
    pendingJobPersistQueue = pendingJobPersistQueue
      .then(async () => {
        await fs.mkdir(path.dirname(pendingJobFile), { recursive: true });
        await fs.writeFile(tempFile, payload, 'utf8');
        await fs.rename(tempFile, pendingJobFile);
      })
      .catch(() => undefined);
  });
  pendingJobStore.restore(initialPendingJobs);
  const runRetention = async (): Promise<void> => {
    const retentionDays = getConfig().orchestration.audit.retentionDays;
    const protectedApprovals = pendingJobStore.listActive().map((job) => job.approvalId).filter(Boolean) as string[];
    await Promise.allSettled([
      auditService.prune(),
      traceWriter.pruneNow(),
      memoryService.prune(),
    ]);
    approvalRuntime.pruneTerminal(retentionDays, Date.now(), protectedApprovals);
  };
  const retentionTimer = setInterval(() => { void runRetention(); }, 24 * 60 * 60 * 1000);
  retentionTimer.unref?.();
  void runRetention();

  const sentMessages = createSentMessageTracker();
  const canvasStore = new CanvasStore({
    filePath: process.env.MIOBOT_CANVAS_STATE_FILE || process.env.MIOBOT_CANVAS_STATE_PATH || path.join(dataDir, 'canvas-state.json'),
    maxHistory: () => getConfig().canvas?.maxHistory,
  });


  const runtimeAdapterOptions = {
    app,
    reply: adapter,
    getConfig,
    featureGate,
    generatedFileDir,
    uploadFile: uploadGeneratedFile,
    browserRenderer,
    fileIndex,
    downloadFile: downloadIncomingFile,
    logger,
  } as BotRuntimeOptions;
  const orchestrationHandlers = new Map<string, CapabilityHandler>();
  // T4.3：定时提醒——schedule 回调运行时才用 scheduler（其构造在上方），闭包晚绑定。
  orchestrationHandlers.set('task.schedule', new ScheduleCapabilityHandler({
    schedule: async ({ remindText, runAt, target }) => {
      const id = `remind_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      schedulerForSchedule?.register({ id, kind: 'once', hour: 0, minute: 0, runAt, type: 'reminder', enabled: true, payload: { remindText, chatType: target.chatType, ...(target.groupId !== undefined ? { groupId: target.groupId } : {}), userId: target.userId } });
      return { id };
    },
    logger,
  }));
  const handlerFailure = (invocation: any, message: string) => ({
    jobId: invocation.plan.planId,
    stepId: invocation.step.id,
    status: /失败|未启用|缺少|不可用|不支持|不存在|异常|failed|failure|error|timeout|unsupported|not supported/i.test(message) ? 'failed' as const : 'needs_input' as const,
    outputs: [],
    error: message,
    diagnostics: { missingInformation: [message] },
  });
  const runOwnerPlan = async (invocation: any, allowedActions: Set<string>) => {
    const action = String(invocation.step.args?.ownerAction || '');
    if (!allowedActions.has(action)) return handlerFailure(invocation, '配置/权限操作失败：不支持的 action');
    let command: OwnerCommand | null = null;
    if (action === 'switchModel') command = { command: 'switchModel', code: String(invocation.step.args?.code || '') };
    else if (action === 'ttsOn') command = { command: 'ttsOn' };
    else if (action === 'ttsOff') command = { command: 'ttsOff' };
    else if (action === 'switchTtsVoice') command = { command: 'switchTtsVoice', index: Math.max(1, Math.trunc(Number(invocation.step.args?.index) || 1)) };
    else if (action === 'blacklist') command = { command: 'blacklist', targetUserId: String(invocation.step.args?.targetUserId || '') };
    else if (action === 'whitelist') command = { command: 'whitelist', targetUserId: String(invocation.step.args?.targetUserId || '') };
    if (!command) return handlerFailure(invocation, '配置/权限操作失败：不支持的 action');
    const text = await handleOwnerCommand(command, {
      chatType: invocation.request.chat.type,
      groupId: invocation.request.chat.groupId,
      userId: invocation.request.user.qq,
    }, { getConfig, store });
    if (!text) return handlerFailure(invocation, '主人命令执行失败：没有返回结果');
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: 'success' as const,
      outputs: [{ kind: 'text' as const, text, priority: 10, mergeable: true }],
    };
  };
  orchestrationHandlers.set('owner.model.list', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const text = await handleOwnerCommand({ command: 'modelList' }, {
      chatType: invocation.request.chat.type,
      groupId: invocation.request.chat.groupId,
      userId: invocation.request.user.qq,
    }, { getConfig, store });
    if (!text) return handlerFailure(invocation, '模型列表失败：不可用');
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: 'success' as const,
      outputs: [{ kind: 'text' as const, text, priority: 10, mergeable: true }],
    };
  }));
  orchestrationHandlers.set('config.update', new RuntimeAdapterCapabilityHandler(async (invocation) => (
    runOwnerPlan(invocation, new Set(['switchModel', 'ttsOn', 'ttsOff', 'switchTtsVoice']))
  )));
  orchestrationHandlers.set('permission.update', new RuntimeAdapterCapabilityHandler(async (invocation) => (
    runOwnerPlan(invocation, new Set(['blacklist', 'whitelist']))
  )));  orchestrationHandlers.set('code.render', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const outcome = await handleCodeRenderRequest(runtimeAdapterOptions, invocation.request.text, invocation.request.chat.type, invocation.request.chat.groupId, invocation.request.user.qq, `orchestration:${invocation.request.requestId}`);
    if (outcome.message) return handlerFailure(invocation, outcome.message);
    return registerResultArtifacts(invocation, executionFromBotResult(invocation, outcome.result));
  }));
  orchestrationHandlers.set('browser.render', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const outcome = await handleWebScreenshotRequest(runtimeAdapterOptions, invocation.request.text, invocation.request.chat.type, invocation.request.chat.groupId, invocation.request.user.qq);
    if (outcome.message) return handlerFailure(invocation, outcome.message);
    return registerResultArtifacts(invocation, executionFromBotResult(invocation, outcome.result));
  }));
  orchestrationHandlers.set('file.generate', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const event = { message_id: '', group_id: invocation.request.chat.groupId, user_id: invocation.request.user.qq, message: [], raw_message: invocation.request.text } as unknown as NapcatMessageEvent;
    const decision = { kind: 'command', command: 'fileGenerate', args: invocation.request.text, commandText: invocation.request.text } as any;
    const outcome = await handleFileGenerateCommand(runtimeAdapterOptions, decision, event, invocation.request.chat.type, `orchestration:${invocation.request.requestId}`, invocation.request.user.qq);
    if (outcome.message) return handlerFailure(invocation, outcome.message);
    return registerResultArtifacts(invocation, executionFromBotResult(invocation, outcome.result));
  }));
  orchestrationHandlers.set('owner.recall', new OwnerRecallCapabilityHandler({
    tracker: sentMessages,
    deleteMessage: (id) => adapter.deleteMessage(id),
  }));
  orchestrationHandlers.set('canvas.gallery', new CanvasGalleryCapabilityHandler(canvasStore));
  orchestrationHandlers.set('image.stitch', new ImageStitchCapabilityHandler({
    getConfig,
    generatedFileDir,
    uploadFile: uploadGeneratedFile,
  }));
  orchestrationHandlers.set('file.delete', new FileDeleteCapabilityHandler(managedArtifacts, (record) => auditService.append(record as any)));
  orchestrationHandlers.set('file.list', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const files = fileIndex?.list(invocation.request.chat.type, invocation.request.chat.groupId, invocation.request.user.qq, 10) || [];
    const artifacts = managedArtifacts.list(artifactScope(invocation), 10);
    const lines = [
      ...files.map((item: any) => `- ${item.code || item.fileId || '-'}: ${item.name || '文件'}`),
      ...artifacts.map((item) => `- ${item.artifactId}: ${item.name}`),
    ];
    const text = lines.length
      ? ['最近文件:', ...lines].join('\n')
      : '当前没有可读取的文件记录。';
    return {
      jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
      outputs: [{ kind: 'text', text, priority: 10, mergeable: true }],
    };
  }));
  orchestrationHandlers.set('file.read', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const event = { message_id: '', group_id: invocation.request.chat.groupId, user_id: invocation.request.user.qq, message: [], raw_message: invocation.request.text } as unknown as NapcatMessageEvent;
    const baseFiles = (invocation.request.attachments || []).filter((item: any) => item.kind === 'file').map((item: any) => ({
      type: 'file', file: item.file || item.ref, url: item.url, name: item.name || 'file', size: Number(item.size || 0), mime: String(item.mime || 'application/octet-stream'),
    })) as FileReference[];
    const decision = { kind: 'command', command: 'fileRead', args: invocation.request.text, commandText: invocation.request.text } as any;
    const outcome = await handleFileReadCommand(runtimeAdapterOptions, decision, event, invocation.request.chat.type, invocation.request.user.qq, undefined, null, baseFiles, `orchestration:${invocation.request.requestId}`);
    if (outcome.message) return handlerFailure(invocation, outcome.message);
    return registerResultArtifacts(invocation, executionFromBotResult(invocation, outcome.result));
  }));

  const orchestrationEnforcer = new OrchestrationEnforcer({
    getConfig,
    app,
    client,
    approvalRuntime,
    pendingJobs: pendingJobStore,
    voiceService,
      sunoHistory: sunoSongHistory,
    logger,
    featureGate,
    handlers: orchestrationHandlers,
    trace: (trace) => traceWriter.append(trace),
    // T2.8：崩溃恢复对账——Suno 查 statusPath，ComfyUI 查 /history/{promptId}；
    // 成功则带回输出补投递，未完成/失败维持 interrupted（防双计费不重放）。
    externalTaskProbe: async ({ capability, taskId }) => {
      const cfg = getConfig();
      if (capability.startsWith('audio.music')) {
        if (!cfg.orchestration.suno.enabled) return undefined;
        const client = new SunoClient({
          baseUrl: cfg.orchestration.suno.baseUrl,
          apiKey: cfg.orchestration.suno.apiKey,
          model: cfg.orchestration.suno.model,
          requestMode: cfg.orchestration.suno.requestMode,
          callbackUrl: cfg.orchestration.suno.callbackUrl,
          createPath: cfg.orchestration.suno.createPath,
          statusPath: cfg.orchestration.suno.statusPath,
          authHeader: cfg.orchestration.suno.authHeader,
          authPrefix: cfg.orchestration.suno.authPrefix,
          timeoutMs: cfg.orchestration.suno.timeoutMs,
          pollIntervalMs: cfg.orchestration.suno.pollIntervalMs,
        });
        try {
          const task = await client.get(taskId);
          if (task.status === 'success') {
            // 与 SunoCapabilityHandler 同款映射：Suno 原始输出 → 编排 ExecutionOutput。
            const outputs = task.outputs
              .filter((item) => Boolean(item.url))
              .map((item) => ({
                kind: 'audio' as const,
                url: item.url,
                priority: 10,
                mergeable: false,
                meta: { title: item.title, lyrics: item.lyrics, audioId: item.audioId, duration: item.duration, provider: 'suno-official' },
              }));
            return outputs.length ? { status: 'success' as const, outputs } : { status: 'failed' as const, error: 'suno_task_no_audio' };
          }
          if (task.status === 'failed') return { status: 'failed' as const, error: 'suno_task_failed' };
          return { status: 'running' as const };
        } catch { return undefined; }
      }
      if (capability.startsWith('image.')) {
        const node = cfg.llm.apiKeys?.[cfg.llm.imageNodeIndex];
        if (!node || node.kind !== 'comfyui') return undefined;
        try {
          const probed = await probeComfyUiPrompt({ baseUrl: node.baseUrl, apiKey: node.key, headers: node.headers, promptId: taskId, timeoutMs: 30000 });
          if (probed.status !== 'success') return { status: probed.status, error: probed.error };
          const outputs = probed.images.map((image) => ({ kind: 'image' as const, url: `data:${image.mime};base64,${image.buffer.toString('base64')}` }));
          return outputs.length ? { status: 'success' as const, outputs } : { status: 'running' as const };
        } catch { return undefined; }
      }
      return undefined;
    },
  });
  // 编排器就绪后接入能力默认配额解析（featureGate 先于 enforcer 创建，用闭包晚绑定）。
  describeCapabilityForGate = (id) => orchestrationEnforcer.describeCapabilityForGate(id);

  const memoryActionFile = process.env.MIOBOT_MEMORY_ACTION_FILE || path.join(dataDir, 'orchestration-memory-actions.jsonl');
  const memoryResultFile = process.env.MIOBOT_MEMORY_RESULT_FILE || path.join(dataDir, 'orchestration-memory-results.json');
  const memoryActionConsumer = new MemoryActionConsumer({
    actionFile: memoryActionFile,
    resultFile: memoryResultFile,
    processedFile: path.join(dataDir, 'orchestration-memory-actions.done.json'),
    logger,
    onAction: async (action) => {
      const botId = String(action.botId || getConfig().bot.botQqId || adapter.selfQqId || 'unknown');
      if (action.type === 'list') {
        const namespaces = (await memoryService.listNamespaces()).filter((item) =>
          (!action.botId || String(item.namespace.botId) === String(action.botId))
          && (!action.groupId || String(item.namespace.groupId || '') === String(action.groupId))
          && (!action.userId || String(item.namespace.userId || '') === String(action.userId)));
        return { ok: true, namespaces };
      }
      if (action.type === 'search') {
        if (!action.chatType || !action.userId) throw new Error('memory_search_scope_required');
        const result = await memoryService.retrieve({
          botId,
          chatType: action.chatType,
          groupId: action.groupId,
          userId: String(action.userId),
          query: String(action.query || ''),
        });
        return { ok: true, result };
      }
      if (action.type === 'clear_group') {
        if (!action.groupId) throw new Error('memory_group_id_required');
        await memoryService.clearNamespace({ kind: 'group', botId, groupId: String(action.groupId) });
        return { ok: true, cleared: 'group_and_personal_group' };
      }
      if (action.type === 'clear_user') {
        if (!action.userId) throw new Error('memory_user_id_required');
        const removed = await memoryService.clearUser(botId, String(action.userId), action.groupId);
        return { ok: true, removed };
      }
      if (action.type === 'prune') return { ok: true, ...(await memoryService.prune()) };
      throw new Error('memory_action_unknown');
    },
  });
  void memoryActionConsumer.start().catch((error) => logger.warn('记忆管理消费者启动失败', { error: String((error as Error)?.message || error) }));
  const capabilityTestActionFile = process.env.MIOBOT_CAPABILITY_TEST_ACTION_FILE || path.join(dataDir, 'orchestration-capability-test-actions.jsonl');
  const capabilityTestResultFile = process.env.MIOBOT_CAPABILITY_TEST_RESULT_FILE || path.join(dataDir, 'orchestration-capability-test-results.json');
  const capabilityTestConsumer = new CapabilityTestActionConsumer({
    actionFile: capabilityTestActionFile,
    resultFile: capabilityTestResultFile,
    processedFile: path.join(dataDir, 'orchestration-capability-test-actions.done.json'),
    logger,
    onAction: (action) => orchestrationEnforcer.testCapability(action),
  });
  void capabilityTestConsumer.start().catch((error) => logger.warn('能力测试消费者启动失败', { error: String((error as Error)?.message || error) }));
  const runtime = createBotMessageRuntime({
    app,
    reply: adapter,
    getConfig: () => { syncNapcat(); return getConfig(); },
    selfId: () => adapter.selfQqId || undefined,
    // T2.2b：好友请求自动通过等需要的通用 action 通道。
    callNapcatAction: (action, params) => adapter.callAction(action, params),
    sentMessages,
    botName: options.botName || 'Miobot',
    syncImagesToGallery: canvasGallerySync.syncImages,
    prepareInputImages,
    logger,
    // 群聊上下文：@bot 时通过 napcat get_group_msg_history 拉取最近群聊记录。
    handleApprovalReply: (input) => approvalRuntime.handleReply(input),
    reportProblem: (input) => problemReporter.report(input),
    loadMemoryContext: async (input) => {
      const botId = String(getConfig().bot.botQqId || adapter.selfQqId || 'unknown');
      const result = await memoryService.retrieve({
        botId,
        chatType: input.chatType,
        groupId: input.groupId === undefined ? undefined : String(input.groupId),
        userId: String(input.userId),
        query: input.query,
      });
      const voiceScope = {
        chatType: input.chatType,
        groupId: input.groupId === undefined ? undefined : String(input.groupId),
        userId: String(input.userId),
      };
      const voiceCandidates = voiceService.listCandidates(voiceScope);
      const voiceContext = voiceCandidates.length ? voiceService.formatCandidates(voiceCandidates) : '';
      return [result.context, voiceContext].filter(Boolean).join('\n\n') || undefined;
    },
    ingestMemory: async (input) => {
      const botId = String(getConfig().bot.botQqId || adapter.selfQqId || 'unknown');
      await memoryService.ingest({
        botId,
        chatType: input.chatType,
        groupId: input.groupId === undefined ? undefined : String(input.groupId),
        userId: String(input.userId),
        authorName: input.authorName,
        role: input.role,
        text: input.text,
        messageId: input.messageId === undefined ? undefined : String(input.messageId),
      });
    },    enforceOrchestration: (input) => orchestrationEnforcer.handle(input),
    commandOrchestration: async (input) => {
      const plan = buildCommandIntentPlan({
        requestId: `cmd_${Date.now()}`,
        command: input.command,
        args: input.args,
        commandText: input.commandText,
      });
      if (!plan) return { handled: false, reason: 'command_not_mapped' };
      return orchestrationEnforcer.handle({
        text: input.text || input.args || '',
        chatType: input.chatType,
        groupId: input.groupId,
        userId: input.userId,
        images: input.images,
        files: input.files,
        groupContext: input.groupContext,
        sessionId: input.sessionId,
        plan,
      });
    },
    shadowOrchestration: async (input) => {
      await runShadowOrchestration({
        ...input,
        config: getConfig(),
        client,
        logger,
        groupContext: input.groupContext,
      });
    },
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
    progressMessages: true,
    featureGate,
    fileIndex,
    generatedFileDir,
    uploadFile: uploadGeneratedFile,
    browserRenderer,
    compressImages: createOutboundImageCompressor({ getConfig, uploadFile: uploadGeneratedFile, logger }),
    materializeImages: async (images) => {
      const napcat = getConfig().napcat;
      if (!napcat.mountOutputDir || !napcat.mountOutputContainerDir) return images;
      return materializeImagesForNapcat(images, {
        hostDir: napcat.mountOutputDir,
        containerDir: napcat.mountOutputContainerDir,
        logger,
      });
    },
    deleteMessage: (messageId) => adapter.deleteMessage(messageId),
    downloadFile: downloadIncomingFile,
    fileParseLimits: DEFAULT_FILE_PARSE_LIMITS,
    voice: async (text, voiceCtx) => {
      const tts = voiceService.effectiveTts(getConfig().bot.tts, {
        chatType: voiceCtx.chatType,
        groupId: voiceCtx.groupId === undefined ? undefined : String(voiceCtx.groupId),
        userId: String(voiceCtx.userId || ''),
      });
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
        void problemReporter.report({ kind: 'tts-synthesize-error', error, chatType: 'private', message: 'TTS 合成失败' });
        return null;
      }
    },
    voiceEligible: (text, voiceCtx) => {
      const tts = voiceService.effectiveTts(getConfig().bot.tts, {
        chatType: voiceCtx.chatType,
        groupId: voiceCtx.groupId === undefined ? undefined : String(voiceCtx.groupId),
        userId: String(voiceCtx.userId || ''),
      });
      return shouldUseTts(tts, text);
    },
    owner: {
      ownerQQs: () => getConfig().bot.ownerQQs,
      handle: (command, ownerCtx) => handleOwnerCommand(command, ownerCtx, { getConfig, store }),
    },
  });
  runtime.attach(adapter);
  const waitForAdapterConnected = async (timeoutMs = 60000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!adapter.getConnectionSnapshot().connected) {
      if (Date.now() >= deadline) throw new Error('napcat_not_connected_for_job_recovery');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const resumePersistedJob = async (job: PendingJobRecord): Promise<void> => {
    await waitForAdapterConnected();
    const chat = job.originalRequest?.chat;
    if (!chat?.type || !chat.userId) throw new Error('recovered_job_missing_chat_context');
    const botQq = String(getConfig().bot.botQqId || adapter.selfQqId || '');
    const chatType = chat.type;
    const text = '继续';
    const rawMessage = chatType === 'group'
      ? (botQq ? `[CQ:at,qq=${botQq}] ${text}` : text)
      : text;
    const message = chatType === 'group'
      ? [
          ...(botQq ? [{ type: 'at', data: { qq: botQq } }] : []),
          { type: 'text', data: { text: ' ' + text } },
        ]
      : [{ type: 'text', data: { text } }];
    await runtime.handleMessageEvent({
      post_type: 'message',
      message_type: chatType,
      group_id: chat.groupId === undefined ? undefined : Number(chat.groupId) || chat.groupId,
      user_id: Number(chat.userId) || chat.userId,
      self_id: Number(botQq) || botQq || undefined,
      message_id: 'recover_' + String(job.jobId || job.key) + '_' + Date.now(),
      time: Math.floor(Date.now() / 1000),
      raw_message: rawMessage,
      message,
      sender: { user_id: chat.userId },
    } as any);
  };
  jobRecoveryService = new JobRecoveryService({
    jobs: pendingJobStore,
    approvals: approvalRuntime,
    resume: resumePersistedJob,
    logger,
  });

  adapter.on('open', () => {
    logger.info('bot connected to napcat', { wsUrl: nap.wsUrl });
    jobRecoveryService?.start();
  });
  adapter.on('close', (data) => { logger.warn('napcat connection closed', data as Record<string, unknown>); });
  adapter.on('error', (error) => {
    logger.error('napcat connection error', { error: String((error as { message?: string })?.message || error) });
    void problemReporter.report({ kind: 'napcat-adapter-error', error, chatType: 'private', message: 'Napcat 连接异常' });
  });

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

  // T2.5：stop 改为异步——退出前 flush 审批/待办持久化队列（最多等 3s），
  // 避免进程退出杀死排队中的原子写（重启后丢最后一条审批/任务状态）。
  const stop = async (): Promise<void> => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    clearInterval(retentionTimer);
    clearInterval(fileCleanupTimer);
    clearInterval(sessionPersistTimer);
    scheduler.stop();
    auditService.stop();
    approvalActionConsumer.stop();
    capabilityTestConsumer.stop();
    memoryActionConsumer.stop();
    // T3.4：记忆防抖落盘的优雅退出 flush。
    try { await memoryService.flush(); } catch { /* best effort */ }
    // T2.3：会话快照退出 flush。
    await writeSessionsSnapshot();
    adapter.disconnect();
    await Promise.race([
      Promise.all([approvalPersistQueue, pendingJobPersistQueue]),
      new Promise((resolve) => setTimeout(resolve, 3000).unref?.()),
    ]);
  };
  return { adapter, getConfig, stop };
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
  // T2.6：落盘前重读磁盘最新配置并重放同一变更——消除与 Web 面板并发保存的
  // 互相覆盖竞态（此前 owner 保存会把面板刚保存的改动静默回滚，反之亦然）。
  // 变更闭包均为可重放（set 字段 / 去重 push）。
  const persistMutation = (mutate: (c: AppConfig) => string | null): string | null => {
    const reply = mutate(config);
    if (reply === null || !store) return reply;
    try {
      const fresh = store.loadIfChanged();
      if (fresh !== config) {
        mutate(fresh);
        store.save(fresh);
        return reply;
      }
    } catch { /* 重读失败时按已变更的本份配置保存 */ }
    try { store.save(config); } catch { /* best-effort */ }
    return reply;
  };
  switch (command.command) {
    case 'modelList':
      return await buildModelListText(config);
    case 'switchModel':
      return persistMutation((c) => {
        const found = findModel(c, command.code);
        if (!found) return `未找到模型: ${command.code}`;
        c.llm.chatModel = found;
        return `已切换 chat 模型为: ${found}`;
      });
    case 'ttsOn':
      return persistMutation((c) => {
        c.bot.tts.enabled = true;
        return '已开启 TTS 语音回复。';
      });
    case 'ttsOff':
      return persistMutation((c) => {
        c.bot.tts.enabled = false;
        return '已关闭 TTS 语音回复。';
      });
    case 'switchTtsVoice':
      return persistMutation((c) => {
        const voice = (c.bot.tts.voiceIds || [])[command.index - 1];
        if (!voice) return `未找到第 ${command.index} 个 TTS 音色。`;
        c.bot.tts.voiceId = voice;
        return `已切换 TTS 音色为第 ${command.index} 个: ${voice}`;
      });
    case 'blacklist':
      return persistMutation((c) => {
        if (!command.targetUserId) return '请 @ 要拉黑的用户。';
        const entry = `${ctx.groupId ?? '*'}:${command.targetUserId}`;
        if (!c.bot.blacklistGroupUsers.includes(entry)) c.bot.blacklistGroupUsers.push(entry);
        return `已拉黑: ${entry}`;
      });
    case 'whitelist':
      return persistMutation((c) => {
        if (!command.targetUserId) return '请 @ 要拉白的用户。';
        const id = String(command.targetUserId);
        if (!c.bot.whitelistPrivate.includes(id)) c.bot.whitelistPrivate.push(id);
        return `已加入私聊白名单: ${id}`;
      });
    case 'recall':
      // recall needs the runtime's sent-message tracker; runtime intercepts this command.
      return null;
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
