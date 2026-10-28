import { NapcatAdapter } from '../../../packages/napcat/src/index.js';
import { createModelClient, createReloadableRegistry } from '../../../packages/model/src/index.js';
import { ConfigStore } from '../../../packages/storage/src/index.js';
import { createFileMetricsStore, createMetrics } from '../../../packages/core/src/metrics.js';
import { createDefaultConfig, normalizeConfig, type AppConfig } from '../../../packages/config/src/index.js';
import { ConsoleLogSink, JsonFileLogSink, createLogger, type StructuredLogger } from '../../../packages/logger/src/index.js';
import { createBotApp } from './app.js';
import { createAgentHost } from './agent-host.js';
import { createCapabilityToolBinding, STATEFUL_CAPABILITY_TOOLS } from './capability-tool-adapter.js';
import { createAgentToolPreflight } from './agent-tool-policy.js';
import { FileToolIdempotencyStore, makeToolError, toolFailure, toolPending, toolSuccess, type ToolResult } from '../../../packages/tool-runtime/src/index.js';
import { ToolJobRuntime, type ToolJobRecord } from './tool-job-runtime.js';
import { resolveAsyncJobTimeoutMs } from './async-job-timeout.js';
import { ReplyPreferenceStore } from './reply-preference-store.js';
import { hasPendingAgentClarification } from './pending-clarification.js';
import { InMemoryAgentSessionManager, type AgentJobRecord, type AgentToolPreflightDecision, type AgentToolPreflightInput } from '../../../packages/agent-runtime/src/index.js';
import { createBotMessageRuntime, handleCodeRenderRequest, handleFileGenerateCommand, handleFileReadCommand, handleWebScreenshotRequest, type BotRuntimeOptions, type FileReference, type NapcatMessageEvent } from './runtime.js';
import { toModelNodes, toCapabilityOverrides } from './config-bridge.js';
import { renderTtsPreprocessPrompt, shouldUseTts, synthesizeSpeech } from './tts.js';
import type { OwnerCommand } from './owner.js';
import type { NapcatHistoryMessage } from './group-context.js';
import { normalizeForwardPayload } from './message-enrichment.js';
import { FeatureGate } from './feature-gate.js';
import { createOutboundImageCompressor, materializeImagesForNapcat, materializeAudioForNapcat } from './image-output.js';
import { ApprovalRuntime } from './approval-runtime.js';
import { buildCommandIntentPlan, createPermissionPolicyFromDefaults, hashApprovalPayload, resolvePermission, type UserRole } from '../../../packages/orchestration/src/index.js';
import { ApprovalActionConsumer } from './approval-actions.js';
import { CapabilityTestActionConsumer } from './capability-test-actions.js';
import { NodeLatencyActionConsumer, NodeLatencyRecorder, probeAllNodes, wrapClientWithLatency } from './node-latency.js';
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
import { SchedulerService, buildDailyReport, withinQuietWindow } from './scheduler.js';
import { WebFetchCapabilityHandler } from './capability-web-fetch.js';
import { HttpCapabilityRegistry } from './capability-http-generic.js';
import { fileURLToPath } from 'node:url';
import { assertSafePublicUrl } from '../../../packages/browser-render/src/index.js';
import { TriggerIntentChecker } from './trigger-intent.js';
import { ScheduleCapabilityHandler } from './capability-schedule.js';
import { loadCapabilityPlugins, pluginManifestPath } from './capability-plugins.js';
import { McpClient, McpToolCapabilityHandler, mcpToolToDescriptor } from './mcp-client.js';
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
import { promises as fs, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * 启动 bot(v2 新架构):配置 → ModelClient(已加固方言/能力/规整) → AgentRuntime → runtime → 连 Napcat。
 * 与旧 scripts/bot-runtime.mjs 并行,互不影响;验证通过后再让 miobot-service 指向它。
 */
export function startBot(options: StartBotOptions = {}): RunningBot {
  // R18/日志：dataDir 先于 logger 计算——bot 与面板跨进程，日志必须走文件（bot-logs.jsonl）。
  const dataDir = options.dataDir || (options.configFilePath ? path.dirname(options.configFilePath) : path.resolve('.runtime'));
  const logFilePath = process.env.MIOBOT_LOG_FILE || path.join(dataDir, 'bot-logs.jsonl');
  const logger = options.logger || createLogger({
    scope: 'bot-v2',
    level: (process.env.MIOBOT_LOG_LEVEL as any) || 'info',
    sinks: [new ConsoleLogSink(), new JsonFileLogSink(logFilePath, 5 * 1024 * 1024)],
  });
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
    throw new Error(`config.json 解析失败，bot 拒绝动动：${store.corruptionReason()}。原文件未被覆盖，修好语法后重动。`);
  }
  // 每次用配置都问一次文件；mtime 没变时 loadIfChanged 直接给缓存，代价只有一次 stat。
  // 这样面板保存后，bot 进程下一条消息就用上新配置，不需要重动——
  // 否则 web 和 bot 是两个进程，面板那句「无需重动」对机器人是假的。
  const getConfig = (): AppConfig => (store ? store.loadIfChanged() : config);

  const logImageRoutingSnapshot = (cfg: AppConfig) => {
    const imageNode = cfg.llm.apiKeys?.[cfg.llm.imageNodeIndex];
    const imageOverrideDisabled = cfg.orchestration.capabilityOverrides?.['image.generate']?.enabled === false;
    const imageFeatureDisabled = cfg.bot.features?.['image.generate']?.enabled === false;
    const imageMasterDisabled = cfg.llm.imageEnabled !== true;
    const warnings = [
      ...(imageMasterDisabled ? ['llm.imageEnabled=false'] : []),
      ...(imageFeatureDisabled ? ['bot.features.image.generate.enabled=false'] : []),
      ...(imageOverrideDisabled ? ['orchestration.capabilityOverrides.image.generate.enabled=false'] : []),
      ...(cfg.codeRender?.enabled !== false && (imageMasterDisabled || imageFeatureDisabled || imageOverrideDisabled)
        ? ['image.generate 当前不可见/可能回退，普通画图请求可能由 code.render 处理']
        : []),
    ];
    logger.info('image routing snapshot', {
      imageGenerate: {
        available: !imageMasterDisabled && !imageFeatureDisabled && !imageOverrideDisabled,
        llmImageEnabled: cfg.llm.imageEnabled === true,
        featureEnabled: !imageFeatureDisabled,
        capabilityOverrideEnabled: !imageOverrideDisabled,
        nodeIndex: cfg.llm.imageNodeIndex,
        nodeKind: imageNode?.kind || '',
        nodeName: imageNode?.name || '',
        model: cfg.llm.imageModel,
        provider: imageNode?.kind === 'comfyui' || imageNode?.comfyui ? 'comfyui' : 'model',
      },
      imageEdit: { nodeIndex: cfg.llm.editNodeIndex, model: cfg.llm.editModel },
      imageInterrogate: { nodeIndex: cfg.llm.interrogateNodeIndex, model: cfg.llm.interrogateModel },
      codeRender: { enabled: cfg.codeRender?.enabled !== false, nodeIndex: cfg.codeRender?.nodeIndex, model: cfg.codeRender?.model },
      canvasImage: { nodeIndex: cfg.canvas.imageNodeIndex, model: cfg.canvas.imageModel },
      warnings,
    });
  };
  logImageRoutingSnapshot(getConfig());
  if (Number(getConfig().toolRegistry?.maxToolsPerTurn || 0) < 8) {
    logger.warn('工具露出上限过小：domain 工具可能被裁掉', {
      maxToolsPerTurn: getConfig().toolRegistry?.maxToolsPerTurn,
      recommended: 24,
      examplesAtRisk: ['code.render', 'browser.render', 'canvas.gallery', 'file.generate'],
    });
  }
// (dataDir 已在上方提前计算)
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
    throw new Error('Napcat get_file 没有返回 base64、URL 或可访问的本地路径；请确认 enableLocalFile2Url 已开动');
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
  // T2.5：临时/生成文件清理从"仅动动一次"改为每日巡检，防长运行进程磁盘无界增长。
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
  // 节点延迟被动采集：包装 chat/vision，每次真实调用按节点记录耗时/成败 → node-latency.json（面板可读）。
  const nodeLatencyRecorder = new NodeLatencyRecorder({ filePath: path.join(dataDir, 'node-latency.json'), logger });
  wrapClientWithLatency(client, nodeLatencyRecorder, (nodeIndex) => getConfig().llm.apiKeys?.[nodeIndex]?.name);
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
  // bot 那边照旧回「当前模型不支持」，重动才认。
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

  // T2.3：会话持久化——动动恢复快照、每 60s 落盘、退出 flush，重动不再失忆。
  const sessionsFile = path.join(dataDir, 'sessions.json');
  try {
    const parsed = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    const restored = app.sessions?.restore?.(parsed) || 0;
    if (restored > 0) logger?.info('会话快照已恢复', { restored });
  } catch { /* 首次动动或快照损坏 */ }
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
    // 于是「文件发送超时/重试次数/重试间隔」改了重动也不生效。
    // videoSendTimeoutMs 的 fallback 链也依赖 fileSendTimeoutMs。
    fileSendTimeoutMs: nap.fileSendTimeoutMs,
    fileSendRetryCount: nap.fileSendRetryCount,
    fileSendRetryDelayMs: nap.fileSendRetryDelayMs,
    // ENOENT 回退：file:// 容器路径 → 宿主路径映射（NapCat 打不开共享目录文件时
    // 由 bot 进程读回并转 base64 重发一次，消息不丢）。
    resolveLocalFile: (uri) => {
      const current = getConfig().napcat;
      const container = String(current.mountOutputContainerDir || '').replace(/\/+$/, '');
      const hostDir = String(current.mountOutputDir || '').replace(/\/+$/, '');
      if (!container || !hostDir || !uri.startsWith('file://' + container + '/')) return null;
      return path.join(hostDir, uri.slice(('file://' + container + '/').length));
    },
    logger,
  });

  const resolveLocalImageReference = createNapcatImageReferenceResolver({
    // 超时跟随后台「通用 action」配置（此前被硬顶 30s，配置调大不生效）。
    callGetImage: (file) => adapter.callAction<NonNullable<NapcatGetImageResponse['data']>>('get_image', { file }, getConfig().napcat.actionTimeoutMs),
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
  let resumeAgentApproval: ((approval: { approvalId: string; status: string }) => Promise<void>) | undefined;
  let resumeAgentJob: ((job: ToolJobRecord) => Promise<void>) | undefined;
  const resumedAgentJobs = new Set<string>();
  const resumedAgentApprovals = new Set<string>();
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
    onDecision: (approval) => {
      try { jobRecoveryService?.onDecision(approval); } catch { /* recovery failure must not affect approval */ }
      if (approval.status !== 'pending' && !resumedAgentApprovals.has(approval.approvalId)) {
        resumedAgentApprovals.add(approval.approvalId);
        void resumeAgentApproval?.(approval).catch((error) => logger.warn('agent approval resume failed', { approvalId: approval.approvalId, error: String((error as Error)?.message || error) }));
      }
    },
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
  void approvalActionConsumer.start().catch((error) => logger.warn('审批面板文件监听动动失败', { error: String((error as Error)?.message || error) }));

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
  // T3.1：调度器 + 每日聚合日报（§11.5 静默观测闭环；默认关，面板/配置开动）。
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
        // 安静窗口（03:00–06:30）外不跑：模型密集后台任务白天触发（含部署补跑）会打满免费档拖垮交互。
        if (!withinQuietWindow(new Date())) {
          logger?.info('记忆巩固在安静窗口外触发，跳过（顺延至次日 03:30 窗口）', { hour: new Date().getHours() });
          return null;
        }
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
  // T3.4：记忆夜间巩固——固定 03:30 低峰执行；memory 未动用时 consolidate 自身返回零计数。
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
    status: /失败|未动用|缺少|不可用|不支持|不存在|异常|failed|failure|error|timeout|unsupported|not supported/i.test(message) ? 'failed' as const : 'needs_input' as const,
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
  // R15/V-2①：job.cancel——模型可调用的异步任务取消工具。幂等语义（F-6）：
  // pending/running 才真取消；已完成/已取消返回当前状态不报错。
  // R16/14.2：能力目录——模型侧发现工具（结果回填模型，不直达用户）。
  orchestrationHandlers.set('web.fetch', new WebFetchCapabilityHandler({
    logger,
    allowPrivateHosts: () => Boolean(getConfig().browserRender?.allowPrivateHosts),
    timeoutMs: () => Math.max(5000, Math.trunc(Number(getConfig().browserRender?.timeoutMs) || 20000)),
    maxChars: () => 12000,
  }) as any);
  // R17/4.3：通用 HTTP 三方 API 注册器——描述符驱动，新接入零代码（改 capabilities-http.json 即可）。
  const httpRegistry = new HttpCapabilityRegistry({
    getConfig: () => getConfig(),
    logger,
    assertSafeUrl: assertSafePublicUrl,
  });
  let loadedHttpCapabilities = 0;
  try {
    const httpJsonPath = fileURLToPath(new URL('./capabilities-http.json', import.meta.url));
    const raw = JSON.parse(readFileSync(httpJsonPath, 'utf8')) as { descriptors?: unknown[] };
    loadedHttpCapabilities = httpRegistry.load((raw.descriptors || []) as any);
  } catch (error) {
    logger?.warn('capabilities-http.json load failed; no http capabilities registered', { error: String((error as Error)?.message || error) });
  }
  for (const descriptor of httpRegistry.list()) {
    orchestrationHandlers.set(descriptor.id, new RuntimeAdapterCapabilityHandler(async (invocation) => {
      const result = await httpRegistry.execute(
        descriptor.id,
        (invocation.step.args || {}) as Record<string, unknown>,
        invocation.signal,
      );
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
        outputs: result.outputs as any,
      };
    }));
  }
  if (loadedHttpCapabilities) logger.info('http capabilities registered', { count: loadedHttpCapabilities });

  orchestrationHandlers.set('capability.catalog', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const args = (invocation.step.args || {}) as Record<string, unknown>;
    const keyword = String(args.keyword || '').trim().toLowerCase();
    const category = String(args.category || '').trim();
    const CATEGORY_PATTERNS: Array<[string, RegExp]> = [
      ['生成', /^(image|video|audio|code)/],
      ['解析', /^(file|memory|ocr|interrogate)/],
      ['信息', /^(web|search|render|browser)/],
      ['输入', /^(session|reply|tts)/],
    ];
    const categoryOf = (key: string) => CATEGORY_PATTERNS.find(([, re]) => re.test(key))?.[0] || '其他';
    let descriptors = orchestrationEnforcer.listCapabilities();
    if (category) descriptors = descriptors.filter((d) => categoryOf(String(d.id)) === category);
    if (keyword) {
      descriptors = descriptors.filter((d) =>
        `${d.id} ${d.name} ${d.description || ''}`.toLowerCase().includes(keyword));
    }
    const lines = descriptors.slice(0, 40).map((d) => {
      const enabled = getConfig().orchestration.capabilityOverrides?.[d.id]?.enabled !== false;
      const known = DEDICATED_CAP_PAGES.has(String(d.id));
      return `- ${d.id}（${d.name}）：${String(d.description || '').slice(0, 80)}${known ? '［有专属配置页］' : ''}${enabled ? '' : '［已停用］'}`;
    });
    const text = lines.length
      ? `可用能力目录（${descriptors.length} 项）：\n${lines.join('\n')}`
      : '没有匹配的能力。';
    return {
      jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
      outputs: [{ kind: 'text', text, priority: 10, mergeable: true }],
    };
  }));
  orchestrationHandlers.set('job.cancel', new RuntimeAdapterCapabilityHandler(async (invocation) => {
    const args = (invocation.step.args || {}) as Record<string, unknown>;
    const jobIdArg = String(args.jobId || '').trim();
    let pendingIds = jobIdArg ? [jobIdArg] : toolJobRuntime.snapshot()
      .filter((job) => job.status === 'queued' || job.status === 'running')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map((job) => job.jobId);
    if (!jobIdArg) {
      // 无 jobId 时按会话范围过滤（同 session 的未完成任务）
      const sessionKey = invocation.request.chat.type === 'group'
        ? `group:${invocation.request.chat.groupId}:${invocation.request.user.qq}`
        : `private:${invocation.request.user.qq}`;
      const session = agentSessions.load(sessionKey);
      const sessionPending = (session?.pendingJobs || []).map((p) => p.jobId);
      pendingIds = pendingIds.filter((id) => !sessionPending.length || sessionPending.includes(id));
    }
    if (!pendingIds.length) {
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
        outputs: [{ kind: 'text', text: '当前没有进行中的异步任务，无需取消。', priority: 10, mergeable: true }],
      };
    }
    const lines = [];
    for (const id of pendingIds.slice(0, 5)) {
      const record = toolJobRuntime.cancel(id, String(args.reason || '用户要求取消'));
      const status = record?.status || 'unknown';
      const friendly = status === 'cancelled'
        ? `已取消任务 ${id}`
        : status === 'queued' || status === 'running'
          ? `任务 ${id} 已请求取消（${status}）`
          : `任务 ${id} 当前状态为 ${status}，无需取消`;
      lines.push(friendly);
    }
    return {
      jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
      outputs: [{ kind: 'text', text: lines.join('\n'), priority: 10, mergeable: true }],
    };
  }));
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

  // R16：有专属后台配置页的能力（能力目录里标注用）。
  const DEDICATED_CAP_PAGES = new Set(['image.generate', 'image.edit', 'image.interrogate', 'audio.music.generate', 'tts.speak', 'file.read', 'file.list', 'memory.search', 'web.search', 'browser.render', 'code.render']);
  // R13：Suno 迟到投递——等待超时但远端任务仍在跑时不丢弃，登记后由轮询补投。
  const sunoLateDeliveries = new Map<string, { invocation: import('../../../packages/orchestration/src/index.js').CapabilityInvocation; composed?: unknown; rawUserText: string; registeredAt: number; delivered: boolean; jobId?: string }>();
  const registerSunoLateDelivery = (taskId: string, input: { invocation: import('../../../packages/orchestration/src/index.js').CapabilityInvocation; composed?: unknown; rawUserText: string }) => {
    // 把 tool job 绑定到迟到投递，发送成功后 markDelivered，和恢复通道共享同一幂等账本。
    const job = toolJobRuntime?.snapshot().find((record) => record.externalTaskIds.includes(taskId));
    sunoLateDeliveries.set(taskId, { ...input, registeredAt: Date.now(), delivered: false, ...(job?.jobId ? { jobId: job.jobId } : {}) });
  };
  // R15/C-4+V-2②：迟到投递轮询器——每 60s 探测已登记任务；幂等与取消前置：
  // 已投递/超龄(>1h)登记直接清掉；投递走 deliverExternalOutputs→onExternalDeliver
  // →sendAgentOutcome（复用出站队列）。与 resume 恢复通道按 jobId 幂等互斥。
  const SUNO_LATE_DELIVERY_MAX_AGE_MS = 60 * 60 * 1000;
  const pollSunoLateDeliveries = async (): Promise<void> => {
    for (const [taskId, entry] of [...sunoLateDeliveries.entries()]) {
      if (entry.delivered) { sunoLateDeliveries.delete(taskId); continue; }
      if (Date.now() - entry.registeredAt > SUNO_LATE_DELIVERY_MAX_AGE_MS) {
        sunoLateDeliveries.delete(taskId);
        logger.warn('suno late delivery expired', { taskId, ageMs: Date.now() - entry.registeredAt });
        continue;
      }
      try {
        if (entry.jobId) {
          const currentJob = toolJobRuntime.get(entry.jobId);
          if (currentJob?.deliveredAt || currentJob?.status === 'cancelled') {
            sunoLateDeliveries.delete(taskId);
            continue;
          }
        }
        const probe = await orchestrationEnforcer.probeExternalTask('audio.music.generate', taskId);
        if (probe?.status !== 'success') continue;
        await orchestrationEnforcer.deliverExternalOutputs(entry.invocation, (probe.outputs || []) as any, { source: 'suno_late_delivery' });
        if (entry.jobId) toolJobRuntime.markDelivered(entry.jobId);
        entry.delivered = true;
        sunoLateDeliveries.delete(taskId);
        logger.info('suno late delivery completed', { taskId, userId: entry.invocation.request.user.qq });
      } catch (error) {
        logger.warn('suno late delivery poll failed', { taskId, error: String((error as Error)?.message || error) });
      }
    }
  };
  const sunoLateDeliveryTimer = setInterval(() => { void pollSunoLateDeliveries(); }, 60_000);
  sunoLateDeliveryTimer.unref?.();
  const orchestrationEnforcer = new OrchestrationEnforcer({
    registerSunoLateDelivery,
    onExternalDeliver: async (invocation, result) => {
      // R13：迟到投递的发送——复用 sendAgentOutcome 的发送队列与 ReplyPlan 处理。
      const chatType = invocation.request.chat.type === 'group' ? 'group' : 'private';
      const groupId = invocation.request.chat.type === 'group' ? invocation.request.chat.groupId : undefined;
      const userId = invocation.request.user.qq;
      const replyPlan = (result as { replyPlan?: unknown }).replyPlan as import('../../../packages/orchestration/src/index.js').ReplyPlan | undefined;
      await runtime.sendAgentOutcome({
        chatType,
        ...(groupId !== undefined ? { groupId } : {}),
        userId,
        ...(result.text ? { text: String(result.text) } : {}),
        ...(replyPlan ? { replyPlan } : {}),
        reason: 'suno_late_delivery',
      });
    },
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
      if (capability.startsWith('video.')) {
        const nodeIndex = cfg.llm.videoNodeIndex;
        const node = cfg.llm.apiKeys?.[nodeIndex];
        if (!node || node.kind === 'comfyui') return undefined;
        try {
          const probed = await client.probeVideo(nodeIndex, taskId, 30000);
          if (probed.status === 'running') return { status: 'running' as const };
          if (probed.status === 'failed' || probed.status === 'expired') return { status: 'failed' as const, error: probed.error || `video_task_${probed.status}` };
          const outputs = (probed.videos || [])
            .filter((video) => Boolean(String(video.data || '').trim()))
            .map((video) => ({
              kind: 'video' as const,
              url: video.kind === 'base64' ? `data:${video.mimeType || 'video/mp4'};base64,${video.data}` : video.data,
              priority: 8,
              mergeable: true,
              meta: { requestId: video.requestId, mimeType: video.mimeType },
            }));
          return outputs.length ? { status: 'success' as const, outputs } : { status: 'running' as const };
        } catch { return undefined; }
      }
      return undefined;
    },
  });
  // 编排器就绪后接入能力默认配额解析（featureGate 先于 enforcer 创建，用闭包晚绑定）。
  describeCapabilityForGate = (id) => orchestrationEnforcer.describeCapabilityForGate(id);
  // T4.2：插件目录加载（dataDir/capabilities/*.mjs，工厂 (ctx) => {descriptor, handler}）；
  // 清单 plugins.json 供 web 面板进程展示（面板可见）。单个失败只告警不拖垮动动。
  void (async () => {
    const capabilitiesDir = path.join(dataDir, 'capabilities');
    const manifest = await loadCapabilityPlugins(capabilitiesDir, { getConfig, client, logger, dataDir }, (plugin) => {
      orchestrationEnforcer.registerCapability(plugin.descriptor, plugin.handler);
    }, { logger });
    if (manifest.length) logger.info('能力插件加载完成', { count: manifest.length, manifestFile: pluginManifestPath(capabilitiesDir) });
  })().catch((error) => logger.warn('能力插件目录加载异常', { error: String((error as Error)?.message || error) }));
  // T4.1：MCP servers（orchestration.mcpServers，配置得到本进程才会接入）——
  // 动动连接、tools 转能力注册（默认全 deny，面板逐工具开动）；单个 server 失败只告警。
  void (async () => {
    const servers = (getConfig().orchestration.mcpServers || []).filter((server) => server.enabled);
    for (const server of servers) {
      try {
        const client = new McpClient(server, { logger });
        await client.initialize();
        const tools = await client.listTools();
        const allowlist = server.allowlist?.length ? new Set(server.allowlist.map(String)) : null;
        let registered = 0;
        for (const tool of tools) {
          if (allowlist && !allowlist.has(tool.name)) continue;
          orchestrationEnforcer.registerCapability(mcpToolToDescriptor(server.id, tool), new McpToolCapabilityHandler(client, tool.name));
          registered += 1;
        }
        logger.info('MCP server 已接入', { server: server.id, tools: tools.length, registered });
      } catch (error) {
        logger.warn('MCP server 接入失败', { server: server.id, error: String((error as Error)?.message || error) });
      }
    }
  })();

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
  void memoryActionConsumer.start().catch((error) => logger.warn('记忆管理消费者动动失败', { error: String((error as Error)?.message || error) }));
  const capabilityTestActionFile = process.env.MIOBOT_CAPABILITY_TEST_ACTION_FILE || path.join(dataDir, 'orchestration-capability-test-actions.jsonl');
  const capabilityTestResultFile = process.env.MIOBOT_CAPABILITY_TEST_RESULT_FILE || path.join(dataDir, 'orchestration-capability-test-results.json');
  const capabilityTestConsumer = new CapabilityTestActionConsumer({
    actionFile: capabilityTestActionFile,
    resultFile: capabilityTestResultFile,
    processedFile: path.join(dataDir, 'orchestration-capability-test-actions.done.json'),
    logger,
    onAction: (action) => orchestrationEnforcer.testCapability(action),
  });
  void capabilityTestConsumer.start().catch((error) => logger.warn('能力测试消费者动动失败', { error: String((error as Error)?.message || error) }));
  // 节点延迟主动检测消费者：面板「测延迟」→ JSONL 动作 → 逐动用节点发最小 ping。
  const nodeLatencyConsumer = new NodeLatencyActionConsumer({
    actionFile: process.env.MIOBOT_NODE_LATENCY_ACTION_FILE || path.join(dataDir, 'node-latency-actions.jsonl'),
    resultFile: process.env.MIOBOT_NODE_LATENCY_RESULT_FILE || path.join(dataDir, 'node-latency-results.json'),
    processedFile: path.join(dataDir, 'node-latency-actions.done.json'),
    logger,
    onAction: async () => {
      const startedAt = Date.now();
      const nodes = toModelNodes(getConfig());
      const results = await probeAllNodes(client, nodes, 10000);
      return { results, durationMs: Date.now() - startedAt };
    },
  });
  void nodeLatencyConsumer.start().catch((error) => logger.warn('节点延迟检测消费者动动失败', { error: String((error as Error)?.message || error) }));
  const agentUserRole = (cfg: AppConfig, userId?: string | number): UserRole => {
    const id = String(userId ?? '');
    if ((cfg.bot.ownerQQs || []).map(String).includes(id)) return 'owner';
    if ((cfg.orchestration.approval.adminQqIds || []).map(String).includes(id)) return 'admin';
    return 'user';
  };

  // R5.1：先只把信息型/只读能力暴露给 Agent Runtime。生成、发送、删除和配置类工具
  // 仍由旧链路独占，直到新发送层能完整承接 ReplyPlan、审批和异步任务。
  type AgentToolQueueEntry = {
    job: ToolJobRecord;
    run: (signal: AbortSignal) => Promise<ToolResult>;
    timeoutMs: number;
  };
  type AgentToolQueueState = { activeJobId?: string; pending: AgentToolQueueEntry[] };
  const agentToolQueues = new Map<string, AgentToolQueueState>();
  const agentToolQueueKey = (sessionKey: string, toolName: string) => sessionKey + '\u0000' + toolName;
  let toolJobRuntime!: ToolJobRuntime;
  const startQueuedAgentToolJob = (key: string): void => {
    const state = agentToolQueues.get(key);
    if (!state || state.activeJobId) return;
    const next = state.pending.shift();
    if (!next) {
      agentToolQueues.delete(key);
      return;
    }
    state.activeJobId = next.job.jobId;
    logger.info('异步工具任务出队', { toolName: next.job.toolName, jobId: next.job.jobId, queued: state.pending.length });
    void toolJobRuntime.run(next.job.jobId, next.run, next.timeoutMs);
  };
  const agentJobDeadLetterFile = process.env.MIOBOT_AGENT_JOB_DEAD_LETTER_FILE || path.join(dataDir, 'agent-tool-job-dead-letters.json');
  const recordAgentJobDeadLetter = (job: ToolJobRecord, reason: string): void => {
    try {
      let records: unknown[] = [];
      try {
        const parsed = JSON.parse(readFileSync(agentJobDeadLetterFile, 'utf8'));
        if (Array.isArray(parsed?.records)) records = parsed.records;
      } catch { /* first run */ }
      records.push({ jobId: job.jobId, toolName: job.toolName, callId: job.callId, sessionKey: job.sessionKey, reason, createdAt: job.createdAt, deadLetteredAt: new Date().toISOString() });
      mkdirSync(path.dirname(agentJobDeadLetterFile), { recursive: true });
      const temp = agentJobDeadLetterFile + '.tmp';
      writeFileSync(temp, JSON.stringify({ version: 1, records: records.slice(-200) }, null, 2), 'utf8');
      try { renameSync(temp, agentJobDeadLetterFile); } catch { writeFileSync(agentJobDeadLetterFile, JSON.stringify({ version: 1, records: records.slice(-200) }, null, 2), 'utf8'); }
    } catch (error) {
      logger.warn('agent job dead-letter write failed', { jobId: job.jobId, error: String((error as Error)?.message || error) });
    }
  };
  toolJobRuntime = new ToolJobRuntime({
    filePath: process.env.MIOBOT_TOOL_JOB_FILE || path.join(dataDir, 'agent-tool-jobs.json'),
    maxRecords: 2000,
    onComplete: (job) => {
      if (job.status === 'queued' || resumedAgentJobs.has(job.jobId)) return;
      resumedAgentJobs.add(job.jobId);
      const queueKey = agentToolQueueKey(job.sessionKey, job.toolName);
      const state = agentToolQueues.get(queueKey);
      if (state?.activeJobId === job.jobId) state.activeJobId = undefined;
      void (async () => {
        try {
          await resumeAgentJob?.(job);
        } catch (error) {
          logger.warn('agent tool job resume failed', { jobId: job.jobId, error: String((error as Error)?.message || error) });
        } finally {
          startQueuedAgentToolJob(queueKey);
        }
      })();
    },
    onError: (error) => logger.warn('tool job persistence failed', { error: String((error as Error)?.message || error) }),
  });
  const resolveAgentJob = (record: AgentJobRecord) => {
    const job = toolJobRuntime.get(record.jobId);
    if (!job) {
      return {
        jobId: record.jobId,
        status: 'failed' as const,
        error: makeToolError({ code: 'tool_execution_failed', message: '异步任务记录不存在。', toolName: record.toolName }),
      };
    }
    return {
      jobId: job.jobId,
      status: job.status,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? {
        error: makeToolError({
          code: 'tool_execution_failed' as const,
          message: job.error.message,
          toolName: job.toolName,
          details: { jobErrorCode: job.error.code },
        }),
      } : {}),
    };
  };
  let warnedToolRegistryDisabled = false;
  const agentToolBindings = () => {
    const cfg = getConfig();
    if (!cfg.toolRegistry.enabled) {
      if (!warnedToolRegistryDisabled) {
        warnedToolRegistryDisabled = true;
        logger.warn('tool registry disabled: Agent enforce will run without external tools', { toolRegistryEnabled: false });
      }
      return [];
    }
    // P1-6（R9 修复）：不做静态白名单过滤——所有已注册能力（含 MCP/插件/session.clear 等动态注册）
    // 一律生成 ToolSpec；hidden exposure 由 ToolRegistry.loadout 侧过滤。toolRegistry.defaultTimeoutMs
    // 作为未声明 timeout 工具的缺省超时（P1-9）。
    return orchestrationEnforcer.listCapabilities()
    .flatMap((descriptor) => {
      const handler = orchestrationEnforcer.getCapabilityHandler(descriptor.id);
      if (!handler) return [];
      // P1-C（R10 修复）：后台 toolRegistry.exposure 覆盖优先于静态推导；
      // stateful 能力缺省 core，其余由 descriptor 推导，后台显式配置最终生效。
      const configuredExposure = cfg.toolRegistry?.exposure?.[descriptor.id];
      // tts.speak 是底层合成工具，不是回复方式开关；Agent 语音偏好走 reply.presentation。
      if (descriptor.id === 'tts.speak' && !configuredExposure) return [];
      const binding = createCapabilityToolBinding(descriptor, handler, {
        ...(configuredExposure ? { exposure: configuredExposure } : STATEFUL_CAPABILITY_TOOLS.has(descriptor.id) ? { exposure: 'core' } : {}),
        ...(!descriptor.timeoutMs ? { timeoutMs: Math.max(1000, cfg.toolRegistry.defaultTimeoutMs) } : {}),
      });
      if (descriptor.mode !== 'async_job') return [binding];
      const original = binding.handler;
      binding.handler = async (call, spec, context) => {
        const queueKey = agentToolQueueKey(context.sessionKey, call.name);
        const existingQueue = agentToolQueues.get(queueKey);
        const queueState = existingQueue || { pending: [] as AgentToolQueueEntry[] };
        if (!existingQueue) agentToolQueues.set(queueKey, queueState);
        // 前一个 job 已完成、resume 尚在投递时，不能让新请求越过已经排队的 entry。
        if (!queueState.activeJobId && queueState.pending.length) startQueuedAgentToolJob(queueKey);
        const shouldQueue = Boolean(queueState.activeJobId || queueState.pending.length);
        const job = toolJobRuntime.create({
          toolName: call.name,
          callId: call.id,
          sessionKey: context.sessionKey,
          status: shouldQueue ? 'queued' : 'running',
        });
        const jobTimeoutMs = resolveAsyncJobTimeoutMs(getConfig(), call.name, spec.timeoutMs);
        const run = (signal: AbortSignal) => Promise.resolve()
          .then(() => original(call, spec, {
            ...context,
            signal,
            metadata: {
              ...(context.metadata || {}),
              reportExternalTask: (taskId: string) => toolJobRuntime.recordExternalTask(job.jobId, taskId),
            },
          }))
          .then((raw): ToolResult => {
            const value = raw as any;
            if (value && typeof value.callId === 'string' && typeof value.ok === 'boolean') return value as ToolResult;
            if (value?.ok === false) {
              return toolFailure(call.id, value.error || makeToolError({
                code: 'tool_execution_failed',
                message: '异步工具失败：' + call.name,
                callId: call.id,
                toolName: call.name,
              }), { toolName: call.name, content: value?.content, meta: value?.meta });
            }
            return toolSuccess(call.id, call.name, {
              content: value?.content,
              outputs: value?.outputs,
              meta: value?.meta,
            });
          });
        if (shouldQueue) {
          queueState.pending.push({ job, run, timeoutMs: jobTimeoutMs });
          logger.info('异步工具任务排队', { toolName: call.name, jobId: job.jobId, position: queueState.pending.length });
          return toolPending(call.id, job.jobId, {
            toolName: call.name,
            content: '任务已排队，等待同一会话的前序任务完成。',
            meta: { asyncJob: true, queued: true, sessionKey: context.sessionKey, queuePosition: queueState.pending.length },
          });
        }
        queueState.activeJobId = job.jobId;
        logger.info('异步工具任务登记', { toolName: call.name, jobId: job.jobId, timeoutMs: jobTimeoutMs });
        void toolJobRuntime.run(job.jobId, run, jobTimeoutMs);
        return toolPending(call.id, job.jobId, {
          toolName: call.name,
          meta: { asyncJob: true, sessionKey: context.sessionKey },
        });
      };
      return [binding];
    });
  };
  const agentPreflightToolCall = createAgentToolPreflight({ getConfig, approvalRuntime, resolveRole: agentUserRole, approvalMode: 'suspend' });

  const agentSessionsFile = process.env.MIOBOT_AGENT_SESSIONS_FILE || path.join(dataDir, 'agent-sessions.json');
  let initialAgentSessions: any[] = [];
  try {
    const parsed = JSON.parse(readFileSync(agentSessionsFile, 'utf8'));
    initialAgentSessions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch { /* first run or corrupt session file */ }
  let agentSessionsPersistTimer: ReturnType<typeof setTimeout> | undefined;
  let latestAgentSessionsSnapshot: any[] | undefined;
  let agentSessionsPersistRunning = false;
  const persistLatestAgentSessions = () => {
    if (agentSessionsPersistRunning || !latestAgentSessionsSnapshot) return;
    const sessions = latestAgentSessionsSnapshot;
    latestAgentSessionsSnapshot = undefined;
    agentSessionsPersistRunning = true;
    try {
      mkdirSync(path.dirname(agentSessionsFile), { recursive: true });
      const payload = JSON.stringify({ version: 1, sessions });
      const tempFile = agentSessionsFile + '.tmp';
      writeFileSync(tempFile, payload, 'utf8');
      try { renameSync(tempFile, agentSessionsFile); } catch { writeFileSync(agentSessionsFile, payload, 'utf8'); }
    } catch (error) {
      logger.warn('agent session persistence failed', { error: String((error as Error)?.message || error) });
    } finally {
      agentSessionsPersistRunning = false;
      if (latestAgentSessionsSnapshot) scheduleAgentSessionsPersist();
    }
  };
  const scheduleAgentSessionsPersist = () => {
    if (agentSessionsPersistTimer) return;
    agentSessionsPersistTimer = setTimeout(() => {
      agentSessionsPersistTimer = undefined;
      persistLatestAgentSessions();
    }, 200);
    agentSessionsPersistTimer.unref?.();
  };
  const agentSessions = new InMemoryAgentSessionManager({
    getLimits: () => {
      const cfg = getConfig();
      const cp = cfg.contextPolicy;
      return {
        maxSessions: 2000,
        maxMessagesPerSession: Math.max(4, cp.historyMaxRounds * 4),
        maxCharsPerSession: Math.max(cp.historyMaxChars, 1000),
        ttlMs: Math.max(0, Number(cfg.llm.sessionTtlMinutes || 0) * 60_000),
      };
    },
    initialSessions: initialAgentSessions,
    persist: (sessions) => {
      latestAgentSessionsSnapshot = sessions;
      scheduleAgentSessionsPersist();
    },
  });
  const resolveAgentApproval = (record: { approvalId: string }) => {
    const broker = approvalRuntime.getBroker();
    broker.expire();
    const approval = broker.get(record.approvalId);
    return approval
      ? { approvalId: approval.approvalId, status: approval.status, payloadHash: approval.payloadHash }
      : { approvalId: record.approvalId, status: 'expired' as const };
  };
  const replyPreferenceStore = new ReplyPreferenceStore({
    filePath: process.env.MIOBOT_REPLY_PREFERENCES_FILE || path.join(dataDir, 'reply-preferences.json'),
    maxRecords: 5000,
    onError: (error) => logger.warn('reply preference persistence failed', { error: String((error as Error)?.message || error) }),
  });
  const toolIdempotencyStore = new FileToolIdempotencyStore({
    filePath: process.env.MIOBOT_TOOL_IDEMPOTENCY_FILE || path.join(dataDir, 'tool-idempotency.json'),
    maxRecords: 5000,
    maxAgeMs: 24 * 60 * 60 * 1000,
    onError: (error) => logger.warn('tool idempotency persistence failed', { error: String((error as Error)?.message || error) }),
  });
  const agentHost = createAgentHost({
    getConfig,
    client,
    logger,
    sessions: agentSessions,
    resolveApproval: resolveAgentApproval,
    resolveJob: resolveAgentJob,
    idempotencyStore: toolIdempotencyStore,
    replyPreferenceStore,
    spillDir: path.join(dataDir, 'tool-results'),
    toolBindings: agentToolBindings,
    preflightToolCall: agentPreflightToolCall,
  });

  const runtime = createBotMessageRuntime({
    app,
    reply: adapter,
    getConfig: () => { syncNapcat(); return getConfig(); },
    // 追问等待中的会话：用户后续无触发消息（含纯图答案）转入澄清合并，不再被忽略。
    hasPendingClarification: ({ chatType, groupId, userId }) => orchestrationEnforcer.hasPendingClarification(chatType, groupId, userId) || hasPendingAgentClarification(agentSessions, { chatType, groupId, userId }),
    selfId: () => adapter.selfQqId || undefined,
    // T2.2b：好友请求自动通过等需要的通用 action 通道。
    callNapcatAction: (action, params) => adapter.callAction(action, params),
    sentMessages,
    triggerIntentChecker: new TriggerIntentChecker({
      getConfig,
      client,
      logger,
      trace: (entry) => traceWriter.append(entry as any),
      getRequestId: () => orchestrationEnforcer?.currentRequestId || '',
    }),
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
        topK: getConfig().contextPolicy.memoryTopK,
        minScore: getConfig().contextPolicy.memoryMinScore,
        maxContextChars: getConfig().contextPolicy.memoryMaxChars,
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
    },
    agentRuntime: async (input) => {
      const cfg = getConfig();
      const mode = cfg.agent?.enabled ? cfg.agent.mode : 'off';
      if (mode === 'shadow') {
        const userRole = agentUserRole(cfg, input.userId);
        void agentHost({ ...input, userRole })
          .then((outcome) => logger.info('agent shadow turn', {
            status: outcome.status,
            handled: outcome.handled,
            reason: outcome.reason,
            modelRounds: outcome.turn?.usage?.modelRounds,
            toolRounds: outcome.turn?.usage?.toolRounds,
          }))
          .catch((error) => logger.warn('agent shadow error', { error: String((error as Error)?.message || error) }));
        return { handled: false, reason: 'agent_shadow_dispatched', meta: { shadow: true } };
      }
      const userRole = agentUserRole(cfg, input.userId);
      const outcome = await agentHost({ ...input, userRole });
      const toolNames = Array.from(new Set((outcome.turn?.toolResults || []).map((item) => String(item.toolName || '')).filter(Boolean)));
      const imageToolNames = toolNames.filter((name) => ['image.generate', 'image.edit', 'image.interrogate', 'image.stitch', 'code.render', 'browser.render'].includes(name));
      if (imageToolNames.length) {
        const imageNode = cfg.llm.apiKeys?.[cfg.llm.imageNodeIndex];
        logger.info('agent image route', {
          tools: imageToolNames,
          llmImageEnabled: cfg.llm.imageEnabled === true,
          imageGenerateFeature: cfg.bot.features?.['image.generate']?.enabled !== false,
          imageGenerateCapability: cfg.orchestration.capabilityOverrides?.['image.generate']?.enabled !== false,
          imageNodeIndex: cfg.llm.imageNodeIndex,
          imageNodeKind: imageNode?.kind || '',
          imageModel: cfg.llm.imageModel,
          codeRenderEnabled: cfg.codeRender?.enabled !== false,
          codeRenderNodeIndex: cfg.codeRender?.nodeIndex,
          codeRenderModel: cfg.codeRender?.model,
        });
      }
      logger.info('agent runtime turn', {
        mode: outcome.mode,
        status: outcome.status,
        handled: outcome.handled,
        reason: outcome.reason,
        modelRounds: outcome.turn?.usage?.modelRounds,
        toolRounds: outcome.turn?.usage?.toolRounds,
        safeTextFallback: outcome.turn?.meta?.safeTextFallback === true,
        partial: outcome.turn?.meta?.partial === true,
        timedOut: outcome.turn?.meta?.timedOut === true,
        errorCode: outcome.turn?.error?.code,
        errorMessage: outcome.turn?.error?.message,
        toolResultCount: outcome.turn?.toolResults?.length,
        toolNames,
        terminal: outcome.terminal === true,
        replyPlanMessages: outcome.replyPlan?.messageCount,
      });
      return {
        handled: outcome.handled,
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.silent ? { silent: true } : {}),
        ...(outcome.problem ? { problem: outcome.problem } : {}),
        meta: {
          status: outcome.status,
          mode: outcome.mode,
          ...(outcome.turn?.usage ? { usage: outcome.turn.usage } : {}),
          ...(outcome.turn?.error ? { error: outcome.turn.error } : {}),
          ...(outcome.turn?.meta?.partial ? { partial: true, timedOut: true } : {}),
          ...(outcome.turn?.toolResults ? { toolResultCount: outcome.turn.toolResults.length } : {}),
          ...(toolNames.length ? { toolNames } : {}),
        },
      };
    },
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
        // 超时完全跟随后台「消息获取超时」配置（此前被硬顶 15s，配置调大不生效）。
        const data = await adapter.getMessage(replyId, getConfig().napcat.getMessageTimeoutMs);
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
    materializeAudio: async (audios) => {
      const napcat = getConfig().napcat;
      if (!napcat.mountOutputDir || !napcat.mountOutputContainerDir) return audios;
      return materializeAudioForNapcat(audios, {
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
          const rendered = renderTtsPreprocessPrompt(String(pre.promptTemplate || ''), text);
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
        // 次要优化（2026-10-24 实测）：auto-TTS 的 record 也走共享目录 file:// 路径，
        // 省 99KB base64 的 WS 上行（实测 4.6s）；失败回退 base64 原样发送。
        try {
          const napcat = getConfig().napcat;
          if (audio.file && napcat.mountOutputDir && napcat.mountOutputContainerDir) {
            const [materialized] = await materializeAudioForNapcat([audio.file], {
              hostDir: napcat.mountOutputDir,
              containerDir: napcat.mountOutputContainerDir,
              logger,
            });
            return materialized || audio.file;
          }
        } catch { /* 物化失败回退 base64 */ }
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
  // P0-1（R9 修复）：旧自然语言链路已物理删除，Agent 是唯一主运行时。
  // 显式关闭 Agent 时阻止 bot 消息处理（Napcat 连接保持但消息按未处理丢弃会让用户困惑，
  // 也不允许给每个用户发固定提示）——启动即报管理员并阻止接入；面板照常可用以便修配置。
  {
    const bootCfg = getConfig();
    const agentOff = !bootCfg.agent?.enabled || bootCfg.agent.mode === 'off';
    const shadowOnly = bootCfg.agent?.enabled && bootCfg.agent.mode === 'shadow';
    if (agentOff) {
      const error = new Error('配置阻止启动：Agent 已显式关闭，而旧自然语言链路已移除（无回退路径）。请在后台开启 Agent enforce 后重启 bot。');
      logger.error('bot 启动被配置阻断', { agentEnabled: bootCfg.agent?.enabled, agentMode: bootCfg.agent?.mode });
      void problemReporter.report({ kind: 'agent-disabled-boot-block', error, chatType: 'private', message: 'Agent 已显式关闭且旧链路已删除，bot 拒绝启动；请在后台开启 Agent enforce。' }).catch(() => {});
      throw error;
    }
    if (shadowOnly) {
      logger.warn('Agent 运行于 shadow 模式：自然语言不会回复用户（也不会发送固定提示）。验收前请切到 enforce。', { agentMode: 'shadow' });
    }
  }
  runtime.attach(adapter);
  resumeAgentApproval = async (approval) => {
    const session = agentSessions.snapshot().find((candidate) =>
      candidate.pendingApprovals?.some((item) => item.approvalId === approval.approvalId),
    );
    if (!session) return;
    let chatType: 'group' | 'private';
    let groupId: string | undefined;
    let userId: string;
    if (session.sessionKey.startsWith('private:')) {
      chatType = 'private';
      userId = session.sessionKey.slice('private:'.length);
    } else if (session.sessionKey.startsWith('group:')) {
      const rest = session.sessionKey.slice('group:'.length);
      const separator = rest.indexOf(':');
      if (separator <= 0) return;
      chatType = 'group';
      groupId = rest.slice(0, separator);
      userId = rest.slice(separator + 1);
    } else {
      return;
    }
    if (!userId) return;
    const cfg = getConfig();
    const userRole = agentUserRole(cfg, userId);
    const outcome = await agentHost({
      text: '审批结果已确定，请根据工具结果继续完成原操作。',
      chatType,
      ...(groupId !== undefined ? { groupId } : {}),
      userId,
      sessionId: session.sessionKey,
      requestId: `approval_${approval.approvalId}`,
      userRole,
    });
    if (!outcome.handled) {
      logger.warn('agent approval resume not handled', { approvalId: approval.approvalId, reason: outcome.reason });
      return;
    }
    await runtime.sendAgentOutcome({
      chatType,
      ...(groupId !== undefined ? { groupId } : {}),
      userId,
      ...(outcome.text ? { text: outcome.text } : {}),
      ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
  };
  resumeAgentJob = async (job) => {
    let session = agentSessions.snapshot().find((candidate) =>
      candidate.pendingJobs?.some((item) => item.jobId === job.jobId),
    );
    // Fast jobs may complete before AgentRuntime persists pendingJobs. Wait briefly.
    for (let attempt = 0; !session && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      session = agentSessions.snapshot().find((candidate) =>
        candidate.pendingJobs?.some((item) => item.jobId === job.jobId),
      );
    }
    if (!session) {
      recordAgentJobDeadLetter(job, 'session_not_found');
      toolJobRuntime.markDelivered(job.jobId);
      logger.warn('agent tool job orphaned', { jobId: job.jobId, toolName: job.toolName, sessionKey: job.sessionKey });
      return;
    }
    let chatType: 'group' | 'private';
    let groupId: string | undefined;
    let userId: string;
    if (session.sessionKey.startsWith('private:')) {
      chatType = 'private';
      userId = session.sessionKey.slice('private:'.length);
    } else if (session.sessionKey.startsWith('group:')) {
      const rest = session.sessionKey.slice('group:'.length);
      const separator = rest.indexOf(':');
      if (separator <= 0) return;
      chatType = 'group';
      groupId = rest.slice(0, separator);
      userId = rest.slice(separator + 1);
    } else {
      return;
    }
    if (!userId) return;
    const cfg = getConfig();
    const userRole = agentUserRole(cfg, userId);
    const resumeNotice = '异步任务结果已就绪，请根据工具结果继续完成原操作。';
    const userMessages = (session.messages || [])
      .filter((message): message is Extract<(typeof session.messages)[number], { role: 'user' }> => message.role === 'user')
      .filter((message) => String(message.content || '').trim() && message.meta?.internal !== true && String(message.content || '').trim() !== resumeNotice);
    const pendingRecord = session.pendingJobs?.find((item) => item.jobId === job.jobId);
    const originalUser = userMessages.at(-1);
    const originalText = String(pendingRecord?.meta?.originalUserText || originalUser?.content || '').trim();
    const originalAttachments = Array.isArray(pendingRecord?.meta?.originalAttachments)
      ? pendingRecord.meta.originalAttachments as any[]
      : Array.isArray(originalUser?.attachments) ? originalUser.attachments : [];
    const originalImages = originalAttachments.filter((item) => item.kind === 'image').map((item) => item.ref);
    const originalVideos = originalAttachments.filter((item) => item.kind === 'video').map((item) => item.ref);
    const originalAudios = originalAttachments.filter((item) => item.kind === 'audio').map((item) => item.ref);
    const otherPendingToolNames = new Set((session.pendingJobs || [])
      .filter((item) => item.jobId !== job.jobId)
      .map((item) => String(item.toolName || ''))
      .filter(Boolean));
    const jobFailed = job.status !== 'succeeded';
    // 生成任务失败后不要立刻换同族工具无限重试；先让模型向用户说明失败。
    const failedFamilyPrefix = jobFailed
      ? (job.toolName.startsWith('audio.music.') ? 'audio.music.'
        : job.toolName.startsWith('image.') ? 'image.'
        : job.toolName.startsWith('video.') ? 'video.' : '')
      : '';
    const availableToolNames = agentToolBindings()
      .map((binding) => binding.spec.name)
      .filter((name) => name !== job.toolName && !otherPendingToolNames.has(name))
      .filter((name) => !failedFamilyPrefix || !name.startsWith(failedFamilyPrefix));
    logger.info('agent tool job resume', {
      jobId: job.jobId,
      toolName: job.toolName,
      originalTextLength: originalText.length,
      originalTextPreview: originalText.slice(0, 160),
      availableToolNames,
    });
    const outcome = await agentHost({
      text: (originalText || '请根据已完成工具结果处理原请求。') + (jobFailed
        ? '\n\n【系统状态】上一轮异步任务执行失败。请直接向用户说明本次失败，不要再次调用同类生成工具或自动重试。'
        : ''),
      resumeJob: true,
      resumeJobId: job.jobId,
      ...(pendingRecord?.meta?.originalReplyPreference ? { replyPreference: pendingRecord.meta.originalReplyPreference as any } : {}),
      ...(typeof pendingRecord?.meta?.originalReplyPreferenceSessionKey === 'string' ? { replyPreferenceSessionKey: pendingRecord.meta.originalReplyPreferenceSessionKey } : {}),
      availableToolNames,
      ...(originalImages.length ? { images: originalImages } : {}),
      ...(originalVideos.length ? { videos: originalVideos } : {}),
      ...(originalAudios.length ? { audios: originalAudios } : {}),
      chatType,
      ...(groupId !== undefined ? { groupId } : {}),
      userId,
      sessionId: session.sessionKey,
      requestId: `job_${job.jobId}`,
      userRole,
    });
    if (!outcome.handled) {
      recordAgentJobDeadLetter(job, 'resume_not_handled:' + String(outcome.reason || 'unknown'));
      toolJobRuntime.markDelivered(job.jobId);
      logger.warn('agent tool job resume not handled', { jobId: job.jobId, reason: outcome.reason });
      if (jobFailed) {
        await runtime.sendAgentOutcome({
          chatType,
          ...(groupId !== undefined ? { groupId } : {}),
          userId,
          text: '这次生成任务没有完成，请稍后再试。',
          reason: 'agent_job_failed',
        });
      }
      return;
    }
    await runtime.sendAgentOutcome({
      chatType,
      ...(groupId !== undefined ? { groupId } : {}),
      userId,
      ...(outcome.text ? { text: outcome.text } : {}),
      ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
    toolJobRuntime.markDelivered(job.jobId);
  };
  const recoverInterruptedToolJob = async (job: ToolJobRecord, attempt = 0): Promise<void> => {
    attempt = Math.max(attempt, Math.max(0, Math.trunc(Number(job.probeAttempts) || 0)));
    // R15/V-2②：恢复通道投递幂等与取消前置——已投递/已取消的 job 不再进入恢复投递
    //（与 suno 迟到投递轮询器通过 deliveredAt 互斥，防双投递）。
    const currentJob = toolJobRuntime.snapshot().find((record) => record.jobId === job.jobId);
    if (currentJob?.deliveredAt || currentJob?.status === 'cancelled') {
      logger.info('agent tool job resume skipped (delivered or cancelled)', { jobId: job.jobId, status: currentJob?.status, delivered: Boolean(currentJob?.deliveredAt) });
      return;
    }
    const finish = async (record: ToolJobRecord | undefined) => {
      if (!record || resumedAgentJobs.has(record.jobId)) return;
      resumedAgentJobs.add(record.jobId);
      await resumeAgentJob?.(record);
    };
    if (job.error?.code !== 'tool_job_interrupted' || !job.externalTaskIds.length || !orchestrationEnforcer.probeExternalTask) {
      await finish(job);
      return;
    }
    let probe;
    for (const taskId of job.externalTaskIds) {
      probe = await orchestrationEnforcer.probeExternalTask(job.toolName, taskId);
      if (probe) break;
    }
    if (probe?.status === 'running' && attempt < 20) {
      const nextAttempt = toolJobRuntime.recordProbeAttempt(job.jobId);
      const timer = setTimeout(() => {
        void recoverInterruptedToolJob(job, nextAttempt).catch((error) => logger.warn('agent tool job probe failed', { jobId: job.jobId, error: String((error as Error)?.message || error) }));
      }, 30_000);
      timer.unref?.();
      return;
    }
    if (probe?.status === 'success') {
      const result = toolSuccess(job.callId, job.toolName, {
        jobId: job.jobId,
        outputs: (probe.outputs || []) as any,
      });
      await finish(toolJobRuntime.reconcileInterrupted(job.jobId, result));
      return;
    }
    if (probe?.status === 'failed') {
      const result = toolFailure(job.callId, makeToolError({
        code: 'tool_execution_failed',
        message: probe.error || '异步任务执行失败。',
        callId: job.callId,
        toolName: job.toolName,
      }), { toolName: job.toolName });
      await finish(toolJobRuntime.reconcileInterrupted(job.jobId, result));
      return;
    }
    await finish(job);
  };
  const waitForAdapterConnected = async (timeoutMs = 60000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!adapter.getConnectionSnapshot().connected) {
      if (Date.now() >= deadline) throw new Error('napcat_not_connected_for_job_recovery');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  void (async () => {
    try {
      await waitForAdapterConnected();
      const broker = approvalRuntime.getBroker();
      broker.expire();
      for (const session of agentSessions.snapshot()) {
        for (const pending of session.pendingApprovals || []) {
          if (resumedAgentApprovals.has(pending.approvalId)) continue;
          const current = broker.get(pending.approvalId);
          if (!current || current.status === 'pending') continue;
          resumedAgentApprovals.add(pending.approvalId);
          await resumeAgentApproval?.(current);
        }
      }
      for (const job of toolJobRuntime.snapshot()) {
        if (job.deliveredAt || job.status === 'running' || job.status === 'queued' || resumedAgentJobs.has(job.jobId)) continue;
        const hasPendingSession = agentSessions.snapshot().some((session) =>
          session.pendingJobs?.some((pending) => pending.jobId === job.jobId),
        );
        if (!hasPendingSession) continue;
        // 旧版本没有 deliveredAt。已成功的 job 不能因为 session 里还残留 pending 记录就再次发送；
        // failed job 需要一次用户说明，交给 resumeAgentJob 的 jobFailed 分支处理，避免静默消失。
        if (job.status === 'succeeded') {
          recordAgentJobDeadLetter(job, 'terminal_job_not_replayed_after_restart');
          toolJobRuntime.markDelivered(job.jobId);
          logger.warn('terminal agent job not replayed after restart', { jobId: job.jobId, toolName: job.toolName, status: job.status });
          continue;
        }
        if (job.status === 'failed' && job.error?.code !== 'tool_job_interrupted') {
          recordAgentJobDeadLetter(job, 'terminal_failed_job_notify_after_restart');
          logger.warn('terminal failed agent job notify after restart', { jobId: job.jobId, toolName: job.toolName, status: job.status });
          await resumeAgentJob?.(job);
          continue;
        }
        await recoverInterruptedToolJob(job);
      }
      // 清理旧版本/已投递 job 留在 session.pendingJobs 里的死记录，防止下一次重启或 resume 再次拾取。
      const jobRecords = new Map(toolJobRuntime.snapshot().map((job) => [job.jobId, job]));
      let cleanedSessions = 0;
      for (const session of agentSessions.snapshot()) {
        const pendingJobs = session.pendingJobs || [];
        if (!pendingJobs.length) continue;
        const stale = pendingJobs.filter((pending) => {
          const record = jobRecords.get(pending.jobId);
          return Boolean(record && (record.deliveredAt || record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled' || record.status === 'expired'));
        });
        if (!stale.length) continue;
        const staleIds = new Set(stale.map((job) => job.jobId));
        const staleCallIds = new Set(stale.map((job) => String(job.callId || '')).filter(Boolean));
        const remainingJobs = pendingJobs.filter((job) => !staleIds.has(job.jobId));
        const remainingCalls = (session.pendingToolCalls || []).filter((call) => !staleCallIds.has(String(call.id || '')));
        agentSessions.save({
          ...session,
          pendingJobs: remainingJobs.length ? remainingJobs : undefined,
          pendingToolCalls: remainingCalls.length ? remainingCalls : undefined,
        });
        cleanedSessions += 1;
      }
      if (cleanedSessions) logger.info('agent stale pending jobs cleaned', { sessions: cleanedSessions });
    } catch (error) {
      logger.warn('persisted agent recovery failed', { error: String((error as Error)?.message || error) });
    }
  })();
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
  // 避免进程退出杀死排队中的原子写（重动后丢最后一条审批/任务状态）。
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
    if (agentSessionsPersistTimer) clearTimeout(agentSessionsPersistTimer);
    agentSessionsPersistTimer = undefined;
    persistLatestAgentSessions();
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
 * store.save 是**整文件覆盖**，拿动动快照去写等于把用户此后在面板上做的
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
        return '已开动 TTS 语音回复。';
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
