import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import {
  builtinComfyUiProfile,
  CONFIG_MIGRATION_TABLE,
  CONFIG_SCHEMA_VERSION,
  CONFIG_V3_FIELD_METADATA,
  createDefaultConfig,
  exportConfig,
  importConfig as importAppConfig,
  normalizeConfig,
  type AppConfig,
  type ConfigImportResult,
  type ExportedConfigFile,
} from '../../config/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';
import { findUnresolvedSecrets, maskConfigSecrets, unmaskConfigSecrets } from './secrets.js';
import { PROMPT_REGISTRY, getPromptValue, setPromptValue } from './prompt-registry.js';
import { applyCapabilityOverrides, applyRuntimeCapabilityGates, builtinCapabilityDescriptors, buildCapabilityManifest, createPermissionPolicyFromDefaults, resolvePermission, evaluatePromptPromotion, diffPromptText, type CapabilityDescriptor } from '../../orchestration/src/index.js';
import { detectComfyUiPromptNodeIds, inspectComfyUiWorkflow, validateComfyUiProfile } from '../../comfyui/src/index.js';

export const WEB_API_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/web-api',
  phase: 'P11-web-panel',
};

export type WebApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type WebApiHeaders = Record<string, string | undefined>;
export type WebApiStatus = 200 | 201 | 400 | 401 | 404 | 405 | 429 | 500; // R15/N-20: 429 登录限速

export interface PanelAuthSnapshot {
  token: string;
  tokenVersion: number;
  passwordSeedHash: string;
  passwordSeedChanged?: boolean;
  /** 面板密码是否还是出厂默认。前端拿到的是打码值，自己比不出来。 */
  usingDefaultPassword: boolean;
}

export interface HotReloadEvent {
  revision: number;
  changedPaths: string[];
  napcatReconnectRequired: boolean;
  passwordSeedChanged: boolean;
  reloadedAt: string;
}

export interface ConfigSaveResult {
  success: true;
  message: string;
  config: AppConfig;
  revision: number;
  hotReload: HotReloadEvent;
  auth: PanelAuthSnapshot;
  /** 是否真的写进了磁盘。false 表示只在内存生效，重启即丢——前端据此**不要**清脏标记。 */
  persisted: boolean;
  /** persisted 为 false 时的具体原因（磁盘满 / 无权限 / config.json 处于损坏保护状态等）。 */
  persistErrors?: string[];
}

export interface ConfigImportSaveResult extends ConfigSaveResult {
  importResult: ConfigImportResult;
}

export interface LoginResult {
  success: true;
  auth: PanelAuthSnapshot;
  config: AppConfig;
  revision: number;
}

function capabilityHealth(cfg: AppConfig, capability: { provider: string; id: string }): { status: 'ok' | 'disabled' | 'unconfigured'; detail: string } {
  const provider = String(capability.provider || '').toLowerCase();
  if (provider === 'model') return cfg.llm.chatEnabled ? { status: 'ok', detail: '聊天模型已启用' } : { status: 'disabled', detail: '聊天模型已关闭' };
  if (provider === 'comfyui') {
    const node = cfg.llm.apiKeys.find((item) => item.kind === 'comfyui' && item.enabled);
    return node ? { status: 'ok', detail: `节点: ${node.name || 'ComfyUI'}` } : { status: 'unconfigured', detail: '未找到启用的 ComfyUI 节点' };
  }
  if (provider === 'search') return cfg.search.enabled ? { status: 'ok', detail: '搜索已启用' } : { status: 'disabled', detail: '搜索已关闭' };
  if (provider === 'browser-render') return cfg.browserRender.enabled ? { status: 'ok', detail: '浏览器渲染已启用' } : { status: 'disabled', detail: '浏览器渲染已关闭' };
  if (provider === 'file-ingest' || provider === 'file-generator') return cfg.bot.files.enabled === false ? { status: 'disabled', detail: '文件功能已关闭' } : { status: 'ok', detail: '文件功能已启用' };
  if (provider === 'tts') return cfg.bot.tts.enabled ? { status: 'ok', detail: 'TTS 已启用' } : { status: 'disabled', detail: 'TTS 已关闭' };
  if (provider === 'suno-official') {
    if (!cfg.orchestration.externalProviders.enabled) return { status: 'disabled', detail: '外部 Provider 总开关已关闭' };
    const allow = cfg.orchestration.externalProviders.allowlist || [];
    if (allow.length && !allow.includes('suno-official')) return { status: 'disabled', detail: 'suno-official 不在外部 Provider 白名单' };
    if (!cfg.orchestration.suno.enabled) return { status: 'disabled', detail: 'Suno 已关闭' };
    if (!String(cfg.orchestration.suno.baseUrl || '').trim()) return { status: 'unconfigured', detail: 'Suno Base URL 缺失' };
    if (!cfg.orchestration.suno.apiKey) return { status: 'unconfigured', detail: 'Suno API Key 缺失' };
    if ((cfg.orchestration.suno.requestMode || 'v6') === 'v6') {
      if (!String(cfg.orchestration.suno.callbackUrl || '').trim()) return { status: 'unconfigured', detail: 'V6 Callback URL 缺失' };
      if (!String(cfg.orchestration.suno.callbackSecret || '').trim()) return { status: 'unconfigured', detail: 'V6 Callback Secret 缺失（回调无法鉴权）' };
    }
    return { status: 'ok', detail: 'Suno 已配置' };
  }
  if (provider === 'admin') return { status: 'unconfigured', detail: '高风险管理能力未绑定执行器' };
  return { status: 'ok', detail: '内置能力可用' };
}

export interface WebApiRequest {
  method: WebApiMethod;
  path: string;
  headers?: WebApiHeaders;
  body?: unknown;
  /** R18：GET 请求的查询参数（由 HTTP 适配层从 URL search params 解析）。 */
  query?: Record<string, string>;
}

export interface WebApiResponse<T = unknown> {
  status: WebApiStatus;
  body: T;
}

export type ConfigReloadListener = (event: HotReloadEvent, config: AppConfig) => void;

export interface ConfigRepositoryOptions {
  initialConfig?: unknown;
  now?: () => Date;
  /** 跨进程保存的配置版本历史文件；未指定时读取 MIOBOT_CONFIG_VERSION_FILE。 */
  versionFile?: string;
}

function miobotDataDir(): string {
  // 面板进程和 bot 进程共享同一批运行时文件。生产环境可以只设置
  // MIOBOT_RUNTIME_DIR；不能悄悄退回固定 /var/lib 路径，否则自定义
  // 数据目录时面板审批/记忆/能力测试会写到另一个目录。
  return String(process.env.MIOBOT_DATA_DIR || process.env.MIOBOT_RUNTIME_DIR || '/var/lib/miobot-v2');
}

function replyPreferenceFilePath(): string {
  return process.env.MIOBOT_REPLY_PREFERENCES_FILE || nodePath.join(miobotDataDir(), 'reply-preferences.json');
}

interface StoredReplyPreferenceRecord {
  scope: 'session' | 'user';
  key: string;
  preference: Record<string, unknown>;
  updatedAt: string;
  expiresAt?: string;
}

async function readReplyPreferenceRecords(): Promise<StoredReplyPreferenceRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(replyPreferenceFilePath(), 'utf8'));
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];
    return (records as StoredReplyPreferenceRecord[]).filter((record) =>
      (record?.scope === 'session' || record?.scope === 'user') && Boolean(record.key) && Boolean(record.preference));
  } catch {
    return [];
  }
}

async function writeReplyPreferenceRecords(records: StoredReplyPreferenceRecord[]): Promise<void> {
  const file = replyPreferenceFilePath();
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify({ version: 1, records }, null, 2), 'utf8');
  await fs.rename(temp, file);
}

async function auditReplyPreferenceAction(action: string, data: Record<string, unknown>): Promise<void> {
  const file = process.env.MIOBOT_AUDIT_FILE || nodePath.join(miobotDataDir(), 'audit.jsonl');
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify({ timestamp: new Date().toISOString(), type: action, actor: 'panel', data }) + '\n', 'utf8');
}

/**
 * T4.2：插件能力描述符——bot 进程加载 capabilities/*.mjs 后把清单写到
 * capabilities/plugins.json；面板进程不执行插件 JS，只读清单合并展示（60s 缓存）。
 */
let pluginDescriptorCache: { at: number; descriptors: CapabilityDescriptor[] } | null = null;
function pluginCapabilityDescriptors(): CapabilityDescriptor[] {
  const now = Date.now();
  if (pluginDescriptorCache && now - pluginDescriptorCache.at < 60_000) return pluginDescriptorCache.descriptors;
  let descriptors: CapabilityDescriptor[] = [];
  try {
    const raw = JSON.parse(readFileSync(nodePath.join(miobotDataDir(), 'capabilities', 'plugins.json'), 'utf8')) as { plugins?: Array<{ descriptor?: CapabilityDescriptor }> };
    descriptors = (Array.isArray(raw.plugins) ? raw.plugins : [])
      .map((entry) => entry?.descriptor)
      .filter((item): item is CapabilityDescriptor => Boolean(item?.id));
  } catch { /* 无清单 = 无插件 */ }
  pluginDescriptorCache = { at: now, descriptors };
  return descriptors;
}

/** 内置 + 插件描述符合集（面板进程的能力目录/测试/预览统一用它）。 */
function allCapabilityDescriptors(): CapabilityDescriptor[] {
  return [...builtinCapabilityDescriptors(), ...pluginCapabilityDescriptors(), ...httpCapabilityDescriptors()];
}

/**
 * R21：读取 capabilities-http.json 里的三方 HTTP API 描述符，让面板能力中心也能看到。
 * bot 进程在 start.ts 注册 handler；面板进程只展示，不执行。
 */
function httpCapabilityDescriptors(): CapabilityDescriptor[] {
  try {
    const jsonPath = process.env.MIOBOT_HTTP_CAPABILITIES_FILE
      || nodePath.join(nodePath.resolve(process.env.MIOBOT_DATA_DIR || process.env.MIOBOT_RUNTIME_DIR || '.runtime'), 'capabilities-http.json');
    // 先试 dataDir，再试源码目录（开发时）
    let raw: string;
    try {
      raw = readFileSync(jsonPath, 'utf8');
    } catch {
      const srcPath = nodePath.join(nodePath.resolve('.'), 'apps', 'bot', 'capabilities-http.json');
      raw = readFileSync(srcPath, 'utf8');
    }
    const parsed = JSON.parse(raw) as { descriptors?: Array<Record<string, unknown>> };
    return (parsed.descriptors || []).map((d) => {
      const desc = d as Record<string, any>;
      const params = Array.isArray(desc.params) ? desc.params : [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const param of params) {
        const pn = String(param?.name || '').trim();
        if (!pn) continue;
        properties[pn] = { type: String(param?.type || 'string'), description: String(param?.description || '') };
        if (param?.required) required.push(pn);
      }
      return {
        id: String(desc.id || ''),
        name: String(desc.name || desc.id || ''),
        description: String(desc.description || ''),
        provider: 'http-generic',
        mode: 'sync',
        riskLevel: 'low',
        mergeable: true,
        outputKinds: [String(desc.outputKind || 'text')],
        inputSchema: params.length ? { type: 'object', properties, required, additionalProperties: true } : { type: 'object', additionalProperties: true },
      } as unknown as CapabilityDescriptor;
    });
  } catch {
    return [];
  }
}

export interface WebApiOptions extends ConfigRepositoryOptions {
  repository?: ConfigRepository;
}

export interface ConfigVersionSummary {
  version: number;
  revision: number;
  savedAt: string;
  changedPaths: string[];
  current: boolean;
}

export interface ConfigVersionRecord extends ConfigVersionSummary {
  config: AppConfig;
}
const CONFIG_SECTION_KEYS = new Set([
  'panel', 'napcat', 'promptsChat', 'canvas', 'freeMode', 'intentRecognition',
  'browserRender', 'codeRender', 'comfyuiTransform', 'huggingFace', 'search',
  'llm', 'bot', 'orchestration',
]);

function importPayloadHasKnownSection(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const root = (payload as Record<string, unknown>).config;
  const candidate = root && typeof root === 'object' && !Array.isArray(root) ? root : payload;
  return [...CONFIG_SECTION_KEYS].some((key) => Object.prototype.hasOwnProperty.call(candidate, key));
}

export class ConfigRepository {
  private config: AppConfig;
  private revisionValue = 1;
  private tokenVersionValue = 1;
  private readonly listeners = new Set<ConfigReloadListener>();
  private readonly now: () => Date;
  private versionSequence = 1;
  private readonly versions: Array<{ version: number; revision: number; savedAt: string; changedPaths: string[]; config: AppConfig }> = [];
  private readonly versionFile?: string;

  constructor(options: ConfigRepositoryOptions = {}) {
    this.config = options.initialConfig === undefined ? createDefaultConfig() : normalizeConfig(options.initialConfig);
    this.now = options.now || (() => new Date());
    const dataDir = process.env.MIOBOT_DATA_DIR || process.env.MIOBOT_RUNTIME_DIR;
    this.versionFile = options.versionFile || process.env.MIOBOT_CONFIG_VERSION_FILE
      || (dataDir ? nodePath.join(dataDir, 'config-versions.json') : undefined);
    const restored = this.loadVersions();
    if (restored.length) {
      this.versions.push(...restored);
      this.versionSequence = Math.max(...restored.map((item) => item.version), 1);
      this.revisionValue = Math.max(...restored.map((item) => item.revision), 1);
    } else {
      this.versions.push({
        version: 1,
        revision: 1,
        savedAt: this.now().toISOString(),
        changedPaths: [],
        config: clone(this.config),
      });
    }
  }

  private loadVersions(): Array<{ version: number; revision: number; savedAt: string; changedPaths: string[]; config: AppConfig }> {
    if (!this.versionFile || !existsSync(this.versionFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.versionFile, 'utf8')) as { versions?: unknown[] };
      const loaded: Array<{ version: number; revision: number; savedAt: string; changedPaths: string[]; config: AppConfig }> = [];
      for (const raw of Array.isArray(parsed.versions) ? parsed.versions : []) {
        const item = raw as Record<string, any>;
        const version = Math.trunc(Number(item.version));
        const revision = Math.trunc(Number(item.revision));
        if (!Number.isFinite(version) || version <= 0 || !item.config) continue;
        try {
          loaded.push({
            version,
            revision: Number.isFinite(revision) && revision > 0 ? revision : version,
            savedAt: String(item.savedAt || new Date().toISOString()),
            changedPaths: Array.isArray(item.changedPaths) ? item.changedPaths.map(String) : [],
            config: normalizeConfig(item.config),
          });
        } catch { /* skip invalid historical record */ }
      }
      return loaded.sort((a, b) => a.version - b.version).slice(-50);
    } catch {
      return [];
    }
  }

  private persistVersions(): void {
    if (!this.versionFile) return;
    try {
      mkdirSync(nodePath.dirname(this.versionFile), { recursive: true });
      const temp = this.versionFile + '.tmp';
      writeFileSync(temp, JSON.stringify({ versions: this.versions }, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.versionFile);
    } catch { /* version history failure must not block current config persistence */ }
  }

  get revision(): number {
    return this.revisionValue;
  }

  get tokenVersion(): number {
    return this.tokenVersionValue;
  }

  getConfig(): AppConfig {
    return clone(this.config);
  }

  /**
   * 给浏览器看的配置：密钥一律打码。
   * 注意不要把打码逻辑放进 getConfig()——热重载监听器（bot 运行时）消费的是同一个方法，
   * 它需要真实密钥才能调上游。
   */
  getMaskedConfig(): AppConfig {
    return maskConfigSecrets(this.getConfig());
  }

  getAuthSnapshot(passwordSeedChanged = false): PanelAuthSnapshot {
    return {
      token: derivePanelToken(this.config.panel.passwordSeed),
      tokenVersion: this.tokenVersionValue,
      passwordSeedHash: hashPasswordSeed(this.config.panel.passwordSeed),
      passwordSeedChanged,
      // 前端拿到的 passwordSeed 是打码后的（'cha••••••••ogin'），
      // 它自己没法跟默认种子比对——这个判断只能由能看到真值的这边下。
      usingDefaultPassword: this.config.panel.passwordSeed === createDefaultConfig().panel.passwordSeed,
    };
  }

  // R15/N-20：登录限速——1 分钟滑窗 5 次失败即拒（内存即可，个人项目不上持久层）。
  private loginFailures: Array<number> = [];
  login(password: string): LoginResult {
    const now = Date.now();
    const windowMs = 60_000;
    const maxFails = 5;
    this.loginFailures = this.loginFailures.filter((at) => now - at < windowMs);
    if (this.loginFailures.length >= maxFails) {
      throw new WebApiError(429, '尝试过于频繁，请稍后再试');
    }
    if (!safeEqual(String(password ?? ''), this.config.panel.passwordSeed)) {
      this.loginFailures.push(now);
      throw new WebApiError(401, '密码错误');
    }
    this.loginFailures = [];
    return { success: true, auth: this.getAuthSnapshot(false), config: this.getMaskedConfig(), revision: this.revisionValue };
  }

  isAuthorized(authorizationHeader?: string): boolean {
    const provided = String(authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
    // S2：token 比较改用常量时间，与登录密码侧一致，杜绝时序侧信道。
    return Boolean(provided) && safeEqual(provided, derivePanelToken(this.config.panel.passwordSeed));
  }

  exportConfig(): ExportedConfigFile {
    return exportConfig(this.config, { exportedAt: this.now() });
  }

  previewImport(payload: unknown): ConfigImportResult {
    return importAppConfig(payload);
  }

  importAndSave(payload: unknown): ConfigImportSaveResult {
    // 先让 importAppConfig 解掉 { config: ... } 外壳并归一化，再还原打码字段——
    // 导入的可能是本机导出的备份（真实密钥），也可能是面板上打码过的配置。
    // 还原只在「值恰好等于当前值的打码结果」时生效，两种来源都安全。
    const imported = importAppConfig(payload);
    // 错误文件（空对象、随机 JSON、无效根节点）归一化后会变成默认配置。
    // 如果直接保存，等同于把生产配置整份清空；导入接口必须先拒绝。
    if (imported.sourceFormat === 'invalid' || !importPayloadHasKnownSection(payload)) {
      throw new WebApiError(400, '配置文件格式无法识别，已拒绝导入，当前配置未变');
    }
    const restored = unmaskConfigSecrets(imported.config, this.config);
    assertSecretsResolved(restored, '导入的配置');
    const saved = this.saveFullConfig(restored, '配置已导入并热重载');
    // imported.config 是被 unmaskConfigSecrets **就地**还原成真实凭据的那个对象，
    // 原样回给浏览器等于绕过打码——面板密码、napcat token、全部节点密钥都会明文出现在
    // 导入接口的响应体里。换成 saved.config（已 getMaskedConfig 且已归一化）。
    return { ...saved, importResult: { ...imported, config: saved.config } };
  }

  saveConfig(patchOrConfig: unknown): ConfigSaveResult {
    // 面板拿到的是打码后的配置，原样提交回来时要先还原成真实密钥，
    // 否则一次「只改了别的字段」的保存就会把密钥写成一串圆点。
    const restored = unmaskConfigSecrets(objectOrEmpty(patchOrConfig), this.config);
    assertSecretsResolved(restored, '提交的配置');
    const merged = mergeConfigPatch(this.config, objectOrEmpty(restored));
    return this.saveFullConfig(merged, '配置已热重载生效，无需重启');
  }

  listVersions(): ConfigVersionSummary[] {
    const latest = this.versions[this.versions.length - 1]?.version;
    return this.versions.map((record) => ({
      version: record.version,
      revision: record.revision,
      savedAt: record.savedAt,
      changedPaths: [...record.changedPaths],
      current: record.version === latest,
    }));
  }

  getVersion(version: number): ConfigVersionRecord {
    const record = this.versions.find((item) => item.version === Number(version));
    if (!record) throw new WebApiError(404, '配置版本不存在');
    const latest = this.versions[this.versions.length - 1]?.version;
    return {
      version: record.version,
      revision: record.revision,
      savedAt: record.savedAt,
      changedPaths: [...record.changedPaths],
      current: record.version === latest,
      config: maskConfigSecrets(clone(record.config)),
    };
  }

  diffVersion(version: number): string[] {
    const record = this.versions.find((item) => item.version === Number(version));
    if (!record) throw new WebApiError(404, '配置版本不存在');
    return diffConfigPaths(record.config, this.config);
  }

  rollbackToVersion(version: number): ConfigSaveResult {
    const record = this.versions.find((item) => item.version === Number(version));
    if (!record) throw new WebApiError(404, '配置版本不存在');
    return this.saveFullConfig(clone(record.config), '配置已回滚到版本 v' + record.version + ' 并热重载');
  }
  onReload(listener: ConfigReloadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private saveFullConfig(input: unknown, message: string): ConfigSaveResult {
    const previous = this.config;
    const next = normalizeConfig(input);
    const changedPaths = diffConfigPaths(previous, next);
    const passwordSeedChanged = previous.panel.passwordSeed !== next.panel.passwordSeed;
    const napcatReconnectRequired = previous.napcat.wsUrl !== next.napcat.wsUrl || previous.napcat.token !== next.napcat.token;
    this.config = next;
    this.revisionValue += 1;
    this.versionSequence += 1;
    this.versions.push({
      version: this.versionSequence,
      revision: this.revisionValue,
      savedAt: this.now().toISOString(),
      changedPaths: [...changedPaths],
      config: clone(this.config),
    });
    if (this.versions.length > 50) this.versions.shift();
    this.persistVersions();
    if (passwordSeedChanged) this.tokenVersionValue += 1;

    const hotReload: HotReloadEvent = {
      revision: this.revisionValue,
      changedPaths,
      napcatReconnectRequired,
      passwordSeedChanged,
      reloadedAt: this.now().toISOString(),
    };

    // 落盘由监听器完成。以前监听器里的异常被 apps 层空 catch 吞掉，
    // 面板照样收到「配置已热重载生效」，前端还会据此清掉脏标记——
    // 用户确信改动已保存，实际磁盘上一个字节都没变，进程一重启全没了。
    // 现在逐个收集异常，如实报给调用方。
    const persistErrors: string[] = [];
    for (const listener of this.listeners) {
      try {
        listener(hotReload, this.getConfig());
      } catch (error) {
        persistErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const persisted = persistErrors.length === 0;

    return {
      success: true,
      persisted,
      persistErrors: persisted ? undefined : persistErrors,
      message: persisted
        ? message
        : `配置已在内存生效，但写入磁盘失败，重启后会丢失：${persistErrors.join('；')}`,
      config: this.getMaskedConfig(),
      revision: this.revisionValue,
      hotReload,
      auth: this.getAuthSnapshot(passwordSeedChanged),
    };
  }
}

export class WebApi {
  readonly repository: ConfigRepository;

  constructor(options: WebApiOptions = {}) {
    this.repository = options.repository || new ConfigRepository(options);
  }

  /** R18/日志：bot-logs.jsonl 所在的数据目录（与 bot 进程共享同一 dataDir）。 */
  dataDir(): string {
    return process.env.MIOBOT_DATA_DIR || process.env.MIOBOT_RUNTIME_DIR || nodePath.resolve('.runtime');
  }

  /** 日志接口只允许 dataDir 下的 .jsonl/.log 文件，禁止任意路径和软链逃逸。 */
  private resolveLogPath(file: unknown): string {
    const dataDir = nodePath.resolve(this.dataDir());
    const requested = String(file || '').trim();
    const fallback = nodePath.join(dataDir, 'bot-logs.jsonl');
    if (!requested) return fallback;
    if (requested.includes('\0') || nodePath.isAbsolute(requested) || nodePath.basename(requested) !== requested) {
      throw new WebApiError(400, '日志文件名必须是 dataDir 下的 basename');
    }
    if (!/.(jsonl|log)$/i.test(requested)) throw new WebApiError(400, '只允许读取 .jsonl 或 .log 日志');
    const resolved = nodePath.resolve(dataDir, requested);
    if (nodePath.dirname(resolved) !== dataDir) throw new WebApiError(400, '日志路径越界');
    try {
      const real = realpathSync(resolved);
      if (nodePath.dirname(real) !== dataDir) throw new WebApiError(400, '日志路径越界');
    } catch (error) {
      if (error instanceof WebApiError) throw error;
      // 文件尚不存在时允许返回空日志；存在时的软链由上面 realpath 拦截。
    }
    return resolved;
  }

  async handle(request: WebApiRequest): Promise<WebApiResponse> {
    const method = request.method.toUpperCase() as WebApiMethod;
    const path = normalizePath(request.path);
    try {
      if (method === 'POST' && path === '/api/login') {
        return ok(this.repository.login(readPassword(request.body)));
      }

      if (method === 'POST' && path.startsWith('/api/orchestration/suno/callback/')) {
        const token = decodeURIComponent(path.slice('/api/orchestration/suno/callback/'.length));
        const cfg = this.repository.getConfig();
        const secret = String(cfg.orchestration?.suno?.callbackSecret || '').trim();
        if (!secret) return json(500, { code: 503, msg: 'suno_callback_not_configured' });
        if (!safeEqual(token, secret)) return json(401, { code: 403, msg: 'invalid_callback_token' });
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const rootData = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
        const nestedData = rootData.data && typeof rootData.data === 'object' ? rootData.data as Record<string, unknown> : {};
        const taskId = String(rootData.taskId || nestedData.taskId || body.taskId || '').trim();
        const callbackType = String(rootData.callbackType || body.callbackType || 'complete').trim();
        if (!taskId) return json(400, { code: 400, msg: 'suno_callback_task_id_missing' });
        const callbackFile = process.env.MIOBOT_SUNO_CALLBACK_FILE || nodePath.join(miobotDataDir(), 'orchestration-suno-callbacks.jsonl');
        const existing = await fs.readFile(callbackFile, 'utf8').catch(() => '');
        const duplicate = existing.trim().split('\n').slice(-2000).some((line) => {
          try {
            const item = JSON.parse(line) as { taskId?: string; callbackType?: string };
            return item.taskId === taskId && item.callbackType === callbackType;
          } catch { return false; }
        });
        if (!duplicate) {
          await fs.mkdir(nodePath.dirname(callbackFile), { recursive: true });
          await fs.appendFile(callbackFile, JSON.stringify({ receivedAt: new Date().toISOString(), taskId, callbackType, payload: body }) + '\n', 'utf8');
        }
        return ok({ code: 200, msg: 'success', data: { received: true, duplicate } });
      }

      if (path.startsWith('/api/') && !this.repository.isAuthorized(getAuthorization(request.headers))) {
        return json(401, { success: false, error: 'Unauthorized' });
      }

      if (method === 'GET' && path === '/api/orchestration/comfyui/workflows') {
        const cfg = this.repository.getConfig();
        const nodes = (cfg.llm.apiKeys || []).map((node, nodeIndex) => ({ node, nodeIndex }))
          .filter(({ node }) => node.kind === 'comfyui' && node.comfyui)
          .map(({ node, nodeIndex }) => ({
            nodeIndex,
            name: node.name,
            baseUrl: node.baseUrl,
            enabled: node.enabled,
            profiles: (node.comfyui?.profiles || []).map((profile) => {
              const validation = validateComfyUiProfile(profile);
              return {
                id: profile.id,
                name: profile.name,
                nodeCount: Object.keys(profile.workflow || {}).length,
                promptNodeIds: profile.promptNodeIds || [],
                negativePromptNodeIds: profile.negativePromptNodeIds || [],
                outputNodeId: profile.outputNodeId || '',
                fallbackProfileId: profile.fallbackProfileId || '',
                fallbackEnabled: profile.fallbackEnabled !== false,
                builtinRevision: profile.builtinRevision || '',
                customized: Boolean(profile.customized),
                skipFaceDetailer: Boolean(profile.skipFaceDetailer),
                hasBuiltin: Boolean(builtinComfyUiProfile(profile.id)),
                parameterMap: profile.parameterMap || {},
                defaults: profile.defaults || {},
                promptPolicy: profile.promptPolicy,
                validation,
              };
            }),
          }));
        return ok({ success: true, nodes });
      }
      if (method === 'GET' && path.startsWith('/api/orchestration/comfyui/workflows/')) {
        const parts = path.slice('/api/orchestration/comfyui/workflows/'.length).split('/').filter(Boolean);
        const nodeIndex = Number(parts[0]);
        const profileId = decodeURIComponent(parts[1] || '');
        const cfg = this.repository.getConfig();
        const node = cfg.llm.apiKeys[nodeIndex];
        if (!node || node.kind !== 'comfyui' || !node.comfyui) return json(404, { success: false, error: 'comfyui_node_not_found' });
        const profile = (node.comfyui.profiles || []).find((item) => item.id === profileId);
        if (!profile) return json(404, { success: false, error: 'comfyui_profile_not_found' });
        return ok({ success: true, nodeIndex, profile, builtin: builtinComfyUiProfile(profile.id), validation: validateComfyUiProfile(profile), nodes: inspectComfyUiWorkflow(profile.workflow || {}) });
      }
      if (method === 'PUT' && path.startsWith('/api/orchestration/comfyui/workflows/')) {
        const parts = path.slice('/api/orchestration/comfyui/workflows/'.length).split('/').filter(Boolean);
        const nodeIndex = Number(parts[0]);
        const profileId = decodeURIComponent(parts[1] || '');
        if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || !profileId) return json(400, { success: false, error: 'comfyui_route_invalid' });
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const cfg = this.repository.getConfig();
        const node = cfg.llm.apiKeys[nodeIndex];
        if (!node || node.kind !== 'comfyui' || !node.comfyui) return json(404, { success: false, error: 'comfyui_node_not_found' });
        const profiles = node.comfyui.profiles || [];
        const currentIndex = profiles.findIndex((item) => item.id === profileId);
        const restoreBuiltin = body.restoreBuiltin === true;
        const current = restoreBuiltin ? (builtinComfyUiProfile(profileId) || (currentIndex >= 0 ? profiles[currentIndex] : undefined)) : (currentIndex >= 0 ? profiles[currentIndex] : undefined);
        const workflow = body.workflow && typeof body.workflow === 'object' && !Array.isArray(body.workflow) ? body.workflow as Record<string, unknown> : current?.workflow || {};
        const negativePromptNodeIds = Array.isArray(body.negativePromptNodeIds)
          ? body.negativePromptNodeIds.map(String).map((item) => item.trim()).filter(Boolean)
          : current?.negativePromptNodeIds || [];
        const promptNodeIds = Array.isArray(body.promptNodeIds)
          ? body.promptNodeIds.map(String).map((item) => item.trim()).filter(Boolean)
          : current?.promptNodeIds || detectComfyUiPromptNodeIds(workflow, negativePromptNodeIds);
        const nextProfile = {
          ...(current || {}),
          id: profileId,
          name: String(body.name || current?.name || profileId).trim() || profileId,
          workflow,
          promptNodeIds,
          negativePromptNodeIds,
          parameterMap: body.parameterMap && typeof body.parameterMap === 'object' && !Array.isArray(body.parameterMap) ? body.parameterMap as Record<string, string> : current?.parameterMap || {},
          defaults: body.defaults && typeof body.defaults === 'object' && !Array.isArray(body.defaults) ? body.defaults as Record<string, unknown> : current?.defaults || {},
          constraints: body.constraints && typeof body.constraints === 'object' && !Array.isArray(body.constraints) ? body.constraints as Record<string, unknown> : current?.constraints || {},
          outputNodeId: body.outputNodeId === undefined ? current?.outputNodeId : String(body.outputNodeId || '').trim() || undefined,
          promptPolicy: body.promptPolicy && typeof body.promptPolicy === 'object' && !Array.isArray(body.promptPolicy) ? body.promptPolicy : current?.promptPolicy,
          stitch: current?.stitch,
          transform: current?.transform,
          // 面板保存不携带 lora 字段；保留 profile 现有 LoRA 目录，避免一次保存即清空。
          lora: current?.lora,
          skipFaceDetailer: body.skipFaceDetailer === undefined ? current?.skipFaceDetailer : Boolean(body.skipFaceDetailer),
          fallbackProfileId: body.fallbackProfileId === undefined ? (current?.fallbackProfileId || builtinComfyUiProfile(profileId)?.id || profileId) : String(body.fallbackProfileId || '').trim() || undefined,
          fallbackEnabled: body.fallbackEnabled === undefined ? (current?.fallbackEnabled ?? true) : Boolean(body.fallbackEnabled),
          builtinRevision: current?.builtinRevision || builtinComfyUiProfile(profileId)?.builtinRevision,
          customized: restoreBuiltin ? false : (body.customized === undefined ? (current?.customized ?? true) : Boolean(body.customized)),
        };
        const routeBaseline = builtinComfyUiProfile(profileId);
        if (routeBaseline && !restoreBuiltin) {
          const changedRecord = (actual: Record<string, unknown>, base: Record<string, unknown>) => Object.keys(actual || {}).some((key) => JSON.stringify(actual?.[key]) !== JSON.stringify(base?.[key]));
          const changed = JSON.stringify(nextProfile.workflow) !== JSON.stringify(routeBaseline.workflow)
            || changedRecord(nextProfile.defaults as Record<string, unknown>, routeBaseline.defaults as Record<string, unknown>)
            || changedRecord(nextProfile.parameterMap as Record<string, unknown>, routeBaseline.parameterMap as Record<string, unknown>)
            || JSON.stringify(nextProfile.promptNodeIds) !== JSON.stringify(routeBaseline.promptNodeIds)
            || JSON.stringify(nextProfile.negativePromptNodeIds) !== JSON.stringify(routeBaseline.negativePromptNodeIds)
            || String(nextProfile.outputNodeId || '') !== String(routeBaseline.outputNodeId || '')
            || JSON.stringify(nextProfile.promptPolicy || {}) !== JSON.stringify(routeBaseline.promptPolicy || {})
            || Boolean(nextProfile.skipFaceDetailer) !== Boolean(routeBaseline.skipFaceDetailer);
          nextProfile.customized = changed;
          nextProfile.builtinRevision = routeBaseline.builtinRevision;
          if (!nextProfile.fallbackProfileId) nextProfile.fallbackProfileId = routeBaseline.id;
        }
        const validation = validateComfyUiProfile(nextProfile as any);
        if (!validation.ok) return json(400, { success: false, error: 'comfyui_workflow_invalid', validation });
        const nextProfiles = currentIndex >= 0
          ? profiles.map((item, index) => index === currentIndex ? nextProfile : item)
          : [...profiles, nextProfile];
        const apiKeys = (cfg.llm.apiKeys || []).map((item, index) => index === nodeIndex ? {
          ...item,
          models: Array.from(new Set([...(item.models || []), ...nextProfiles.map((profile) => profile.id)])),
          comfyui: { ...item.comfyui!, profiles: nextProfiles },
        } : item);
        const saved = this.repository.saveConfig({ llm: { apiKeys } });
        return ok({ success: true, nodeIndex, profile: nextProfile, validation, revision: saved.revision });
      }
      if (method === 'DELETE' && path.startsWith('/api/orchestration/comfyui/workflows/')) {
        const parts = path.slice('/api/orchestration/comfyui/workflows/'.length).split('/').filter(Boolean);
        const nodeIndex = Number(parts[0]);
        const profileId = decodeURIComponent(parts[1] || '');
        const cfg = this.repository.getConfig();
        const node = cfg.llm.apiKeys[nodeIndex];
        if (!node || node.kind !== 'comfyui' || !node.comfyui) return json(404, { success: false, error: 'comfyui_node_not_found' });
        const profiles = node.comfyui.profiles || [];
        if (!profiles.some((item) => item.id === profileId)) return json(404, { success: false, error: 'comfyui_profile_not_found' });
        if (profiles.length <= 1) return json(400, { success: false, error: 'comfyui_last_profile_protected' });
        const nextProfiles = profiles.filter((item) => item.id !== profileId);
        const apiKeys = (cfg.llm.apiKeys || []).map((item, index) => index === nodeIndex ? { ...item, comfyui: { ...item.comfyui!, profiles: nextProfiles } } : item);
        const saved = this.repository.saveConfig({ llm: { apiKeys } });
        return ok({ success: true, deleted: profileId, revision: saved.revision });
      }
      if (method === 'POST' && path === '/api/orchestration/capabilities/test') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const id = String(body.id || body.capability || '').trim();
        if (!id) return json(400, { success: false, error: 'capability id is required' });
        const mode = String(body.mode || '').trim();
        if (['validate', 'dry_run', 'live'].includes(mode)) {
          if (mode === 'live' && body.allowLive !== true) return json(400, { success: false, error: 'live_confirmation_required' });
          const actionFile = process.env.MIOBOT_CAPABILITY_TEST_ACTION_FILE || nodePath.join(miobotDataDir(), 'orchestration-capability-test-actions.jsonl');
          const testId = `ct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await fs.mkdir(nodePath.dirname(actionFile), { recursive: true });
          await fs.appendFile(actionFile, JSON.stringify({
            id: testId,
            capability: id,
            mode,
            args: body.args && typeof body.args === 'object' ? body.args : {},
            requesterQq: String(body.requesterQq || ''),
            chatType: body.chatType === 'group' ? 'group' : 'private',
            groupId: body.groupId === undefined ? undefined : String(body.groupId),
            allowLive: body.allowLive === true,
            actor: 'panel',
            createdAt: new Date().toISOString(),
          }) + '\n', 'utf8');
          return ok({ success: true, queued: true, testId, status: 'queued' });
        }
        const cfg = this.repository.getConfig();
        const descriptors = applyCapabilityOverrides(allCapabilityDescriptors(), cfg.orchestration?.capabilityOverrides || {});
        const gated = applyRuntimeCapabilityGates(descriptors, { sunoEnabled: Boolean(cfg.orchestration?.suno?.enabled), externalEnabled: Boolean(cfg.orchestration?.externalProviders?.enabled), allowlist: cfg.orchestration?.externalProviders?.allowlist || [] });
        const capability = gated.find((item) => item.id === id);
        if (!capability) return json(404, { success: false, error: 'capability_not_found' });
        return ok({ success: true, capability: { ...capability, health: capabilityHealth(cfg, capability) } });
      }
      if (method === 'GET' && path.startsWith('/api/orchestration/capabilities/test/')) {
        const testId = decodeURIComponent(path.slice('/api/orchestration/capabilities/test/'.length));
        const resultFile = process.env.MIOBOT_CAPABILITY_TEST_RESULT_FILE || nodePath.join(miobotDataDir(), 'orchestration-capability-test-results.json');
        const content = await fs.readFile(resultFile, 'utf8').catch(() => '');
        let results: unknown[] = [];
        try { const parsed = JSON.parse(content || '{}'); results = Array.isArray(parsed?.results) ? parsed.results : []; } catch { results = []; }
        const result = (results as Array<Record<string, unknown>>).find((item) => String(item.id || '') === testId);
        if (!result) return json(404, { success: false, error: 'capability_test_pending_or_not_found', testId });
        return ok({ success: true, testId, result });
      }
      if (method === 'POST' && path === '/api/nodes/latency-test') {
        const actionFile = process.env.MIOBOT_NODE_LATENCY_ACTION_FILE || nodePath.join(miobotDataDir(), 'node-latency-actions.jsonl');
        const testId = `nlt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await fs.mkdir(nodePath.dirname(actionFile), { recursive: true });
        await fs.appendFile(actionFile, JSON.stringify({ id: testId, actor: 'panel', createdAt: new Date().toISOString() }) + '\n', 'utf8');
        return ok({ success: true, queued: true, testId, status: 'queued' });
      }
      if (method === 'GET' && path.startsWith('/api/nodes/latency-test/')) {
        const testId = decodeURIComponent(path.slice('/api/nodes/latency-test/'.length));
        const resultFile = process.env.MIOBOT_NODE_LATENCY_RESULT_FILE || nodePath.join(miobotDataDir(), 'node-latency-results.json');
        const content = await fs.readFile(resultFile, 'utf8').catch(() => '');
        let results: unknown[] = [];
        try { const parsed = JSON.parse(content || '{}'); results = Array.isArray(parsed?.results) ? parsed.results : []; } catch { results = []; }
        const result = (results as Array<Record<string, unknown>>).find((item) => String(item.id || '') === testId);
        if (!result) return json(404, { success: false, error: 'latency_test_pending_or_not_found', testId });
        return ok({ success: true, testId, result });
      }
      if (method === 'GET' && path === '/api/nodes/latency') {
        // 被动采集快照：bot 进程每次真实模型调用记录的按节点延迟/成败。
        const snapshotFile = nodePath.join(miobotDataDir(), 'node-latency.json');
        const content = await fs.readFile(snapshotFile, 'utf8').catch(() => '');
        let nodes: unknown = {};
        let updatedAt = '';
        try { const parsed = JSON.parse(content || '{}'); nodes = parsed?.nodes || {}; updatedAt = String(parsed?.updatedAt || ''); } catch { nodes = {}; }
        return ok({ success: true, updatedAt, nodes });
      }
      if (method === 'GET' && path === '/api/orchestration/jobs') {
        const jobFile = process.env.MIOBOT_PENDING_JOB_FILE || nodePath.join(miobotDataDir(), 'orchestration-pending-jobs.json');
        const agentJobFile = process.env.MIOBOT_TOOL_JOB_FILE || nodePath.join(miobotDataDir(), 'agent-tool-jobs.json');
        const readJobs = async (file: string, source: string): Promise<unknown[]> => {
          const content = await fs.readFile(file, 'utf8').catch(() => '');
          try {
            const parsed = JSON.parse(content || '{}');
            return (Array.isArray(parsed?.jobs) ? parsed.jobs : []).map((job: unknown) => (
              job && typeof job === 'object' ? { ...(job as Record<string, unknown>), source } : job
            ));
          } catch { return []; }
        };
        const jobs = [...await readJobs(jobFile, 'orchestration'), ...await readJobs(agentJobFile, 'agent')];
        return ok({ success: true, jobs });
      }      if (method === 'POST' && path === '/api/orchestration/approvals') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const code = String(body.code || '').trim().toUpperCase();
        const decision = String(body.decision || '').trim().toLowerCase();
        if (!code || !['approve', 'reject', 'cancel'].includes(decision)) {
          return json(400, { success: false, error: 'code and decision(approve/reject/cancel) are required' });
        }
        const actionFile = process.env.MIOBOT_APPROVAL_ACTION_FILE || nodePath.join(miobotDataDir(), 'orchestration-approval-actions.jsonl');
        await fs.mkdir(nodePath.dirname(actionFile), { recursive: true });
        await fs.appendFile(actionFile, JSON.stringify({
          id: `panel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          code,
          decision,
          actor: 'panel',
          createdAt: new Date().toISOString(),
        }) + '\n', 'utf8');
        return ok({ success: true, accepted: true, code, decision });
      }
      if (method === 'GET' && path === '/api/orchestration/approvals') {
        const approvalFile = process.env.MIOBOT_APPROVAL_FILE || nodePath.join(miobotDataDir(), 'orchestration-approvals.json');
        const content = await fs.readFile(approvalFile, 'utf8').catch(() => '');
        let approvals: unknown[] = [];
        try {
          const parsed = JSON.parse(content || '{}');
          approvals = Array.isArray(parsed?.approvals) ? parsed.approvals : [];
        } catch { approvals = []; }
        return ok({ success: true, approvals });
      }
      if (method === 'POST' && path === '/api/orchestration/memory/actions') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const type = String(body.type || '').trim();
        if (!['list', 'search', 'clear_group', 'clear_user', 'prune'].includes(type)) return json(400, { success: false, error: 'memory_action_invalid' });
        const actionFile = process.env.MIOBOT_MEMORY_ACTION_FILE || nodePath.join(miobotDataDir(), 'orchestration-memory-actions.jsonl');
        const actionId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await fs.mkdir(nodePath.dirname(actionFile), { recursive: true });
        await fs.appendFile(actionFile, JSON.stringify({
          id: actionId,
          type,
          botId: body.botId === undefined ? undefined : String(body.botId),
          chatType: body.chatType === 'group' ? 'group' : body.chatType === 'private' ? 'private' : undefined,
          groupId: body.groupId === undefined ? undefined : String(body.groupId),
          userId: body.userId === undefined ? undefined : String(body.userId),
          query: body.query === undefined ? undefined : String(body.query),
          createdAt: new Date().toISOString(),
        }) + '\n', 'utf8');
        return ok({ success: true, queued: true, actionId, status: 'queued' });
      }
      if (method === 'GET' && path.startsWith('/api/orchestration/memory/actions/')) {
        const actionId = decodeURIComponent(path.slice('/api/orchestration/memory/actions/'.length));
        const resultFile = process.env.MIOBOT_MEMORY_RESULT_FILE || nodePath.join(miobotDataDir(), 'orchestration-memory-results.json');
        const content = await fs.readFile(resultFile, 'utf8').catch(() => '');
        let results: unknown[] = [];
        try { const parsed = JSON.parse(content || '{}'); results = Array.isArray(parsed?.results) ? parsed.results : []; } catch { results = []; }
        const result = (results as Array<Record<string, unknown>>).find((item) => String(item.id || '') === actionId);
        if (!result) return json(404, { success: false, error: 'memory_action_pending_or_not_found', actionId });
        return ok({ success: true, actionId, result });
      }      if (method === 'GET' && path === '/api/orchestration/suno/callbacks') {
        const callbackFile = process.env.MIOBOT_SUNO_CALLBACK_FILE || nodePath.join(miobotDataDir(), 'orchestration-suno-callbacks.jsonl');
        const content = await fs.readFile(callbackFile, 'utf8').catch(() => '');
        const callbacks = content.trim() ? content.trim().split('\n').slice(-200).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean) : [];
        return ok({ success: true, callbacks });
      }      if (method === 'GET' && path === '/api/orchestration/audit') {
        const auditFile = process.env.MIOBOT_AUDIT_FILE || nodePath.join(miobotDataDir(), 'audit.jsonl');
        const content = await fs.readFile(auditFile, 'utf8').catch(() => '');
        const audit = content.trim() ? content.trim().split('\n').slice(-200).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean) : [];
        return ok({ success: true, audit });
      }      if (method === 'GET' && path === '/api/orchestration/traces') {
        const traceFile = process.env.MIOBOT_TRACE_FILE || nodePath.join(miobotDataDir(), 'orchestration-traces.jsonl');
        const content = await fs.readFile(traceFile, 'utf8').catch(() => '');
        const traces = content.trim() ? content.trim().split('\n').slice(-100).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean) : [];
        return ok({ success: true, traces });
      }
      if (method === 'GET' && path.startsWith('/api/orchestration/traces/')) {
        const requestId = decodeURIComponent(path.slice('/api/orchestration/traces/'.length));
        const traceFile = process.env.MIOBOT_TRACE_FILE || nodePath.join(miobotDataDir(), 'orchestration-traces.jsonl');
        const content = await fs.readFile(traceFile, 'utf8').catch(() => '');
        const all = content.trim() ? content.trim().split('\n').slice(-500).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean) : [];
        const traces = all.filter((trace: any) => String(trace?.requestId || '') === requestId);
        if (!traces.length) return json(404, { success: false, error: 'trace_not_found' });
        return ok({
          success: true,
          requestId,
          traces,
          timeline: traces.map((trace: any) => ({ at: trace.timestamp, stage: trace.stage, summary: trace.summary, data: trace.data })),
        });
      }
      if (method === 'POST' && path === '/api/orchestration/permissions/preview') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const capabilityId = String(body.capability || '').trim();
        if (!capabilityId) return json(400, { success: false, error: 'capability is required' });
        const cfg = this.repository.getConfig();
        const descriptor = applyCapabilityOverrides(
          allCapabilityDescriptors(),
          cfg.orchestration?.capabilityOverrides || {},
        ).find((item) => item.id === capabilityId);
        const qq = String(body.userQq || body.qq || '').trim();
        const groupId = String(body.groupId || '').trim();
        const requestedRole = String(body.role || '').trim();
        const role = ['guest', 'user', 'admin', 'owner'].includes(requestedRole)
          ? requestedRole
          : (cfg.bot.ownerQQs || []).map(String).includes(qq)
            ? 'owner'
            : (cfg.orchestration.approval.adminQqIds || []).map(String).includes(qq)
              ? 'admin'
              : 'user';
        const requestedRisk = String(body.riskLevel || '').trim();
        const riskLevel = ['low', 'medium', 'high', 'critical'].includes(requestedRisk)
          ? requestedRisk
          : (descriptor?.riskLevel || 'medium');
        const provider = String(body.provider || descriptor?.provider || '').trim();
        const defaults = cfg.orchestration.permissions;
        const policy = createPermissionPolicyFromDefaults({
          low: defaults.defaultLow,
          medium: defaults.defaultMedium,
          high: defaults.defaultHigh,
          critical: defaults.defaultCritical,
          hardDenyEnabled: defaults.hardDenyEnabled,
          hardDenyCapabilities: defaults.hardDenyCapabilities,
          rules: defaults.rules,
        }, 'preview-v' + this.repository.revision);
        const decision = resolvePermission({
          capability: capabilityId,
          provider,
          riskLevel: riskLevel as any,
          user: { qq, role: role as any },
          chat: groupId ? { type: 'group', groupId, userId: qq } : { type: 'private', userId: qq },
        }, policy);
        return ok({
          success: true,
          preview: {
            input: { capability: capabilityId, provider, riskLevel, userQq: qq, role, groupId: groupId || undefined },
            decision: decision.decision,
            reason: decision.reason,
            matchedRule: decision.matchedRule,
            hardDenied: decision.hardDenied,
            policyVersion: decision.policyVersion,
            effectivePolicy: {
              defaultLow: defaults.defaultLow,
              defaultMedium: defaults.defaultMedium,
              defaultHigh: defaults.defaultHigh,
              defaultCritical: defaults.defaultCritical,
              hardDenyEnabled: defaults.hardDenyEnabled,
              customRuleCount: (defaults.rules || []).length,
            },
          },
        });
      }
      if (method === 'GET' && path === '/api/orchestration/prompts') {
        const cfg = this.repository.getConfig();
        return ok({
          success: true,
          prompts: {
            enabled: cfg.orchestration.promptOptimization.enabled,
            canaryPercent: cfg.orchestration.promptOptimization.canaryPercent,
            activeVersionId: cfg.orchestration.promptOptimization.activeVersionId,
            canaryVersionId: cfg.orchestration.promptOptimization.canaryVersionId,
            versions: cfg.orchestration.promptOptimization.versions,
          },
        });
      }
      if (method === 'GET' && path.startsWith('/api/orchestration/prompts/') && path.endsWith('/diff')) {
        const id = decodeURIComponent(path.slice('/api/orchestration/prompts/'.length, -'/diff'.length));
        const cfg = this.repository.getConfig();
        const versions = cfg.orchestration.promptOptimization.versions;
        const target = versions.find((item) => item.id === id);
        if (!target) return json(404, { success: false, error: 'prompt_version_not_found' });
        const baseline = versions.find((item) => item.id === cfg.orchestration.promptOptimization.activeVersionId)
          || versions.find((item) => item.status === 'active');
        return ok({ success: true, versionId: id, baselineId: baseline?.id, diff: diffPromptText(baseline?.content || '', target.content) });
      }
      if (method === 'POST' && path === '/api/orchestration/prompts/evaluate') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const cfg = this.repository.getConfig();
        const target = cfg.orchestration.promptOptimization.versions.find((item) => item.id === String(body.versionId || ''));
        if (!target) return json(404, { success: false, error: 'prompt_version_not_found' });
        const ownerApproved = Boolean(body.ownerApproved);
        const decision = evaluatePromptPromotion({
          samples: Number(body.samples) || 0,
          successRate: Number(body.successRate) || 0,
          averageScore: Number(body.averageScore) || 0,
          safetyFailures: Number(body.safetyFailures) || 0,
        }, {
          minSamples: cfg.orchestration.promptOptimization.minSamples,
          minSuccessRate: 0.9,
          minAverageScore: 0.8,
          maxSafetyFailures: 0,
          canaryPercent: cfg.orchestration.promptOptimization.canaryPercent,
          requireOwnerApproval: cfg.orchestration.promptOptimization.requireOwnerApproval,
        }, ownerApproved);
        const versions = cfg.orchestration.promptOptimization.versions.map((item) => item.id === target.id ? {
          ...item,
          evaluation: {
            samples: Number(body.samples) || 0,
            successRate: Number(body.successRate) || 0,
            averageScore: Number(body.averageScore) || 0,
            safetyFailures: Number(body.safetyFailures) || 0,
            ownerApproved,
            promote: decision.promote,
            reason: decision.reason,
            evaluatedAt: new Date().toISOString(),
          },
        } : item);
        const saved = this.repository.saveConfig({ orchestration: { promptOptimization: { versions } } });
        return ok({ success: true, versionId: target.id, decision, config: saved.config, revision: saved.revision });
      }
      if (method === 'POST' && (path === '/api/orchestration/prompts/activate' || path === '/api/orchestration/prompts/rollback')) {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const cfg = this.repository.getConfig();
        const targetId = String(body.versionId || '');
        const target = cfg.orchestration.promptOptimization.versions.find((item) => item.id === targetId);
        if (!target) return json(404, { success: false, error: 'prompt_version_not_found' });
        const isRollback = path.endsWith('/rollback');
        if (!isRollback) {
          if (cfg.orchestration.promptOptimization.requireOwnerApproval && !target.evaluation?.ownerApproved) {
            return json(400, { success: false, error: 'prompt_owner_approval_required' });
          }
          if (!target.evaluation?.promote) {
            return json(400, { success: false, error: 'prompt_evaluation_required' });
          }
        }
        const mode = isRollback ? 'active' : (String(body.mode || 'active') === 'canary' ? 'canary' : 'active');
        const versions = cfg.orchestration.promptOptimization.versions.map((item) => {
          if (item.id === target.id) return { ...item, status: mode === 'active' ? 'active' as const : 'canary' as const };
          if (mode === 'active' && item.status === 'active') return { ...item, status: 'retired' as const };
          if (mode === 'canary' && item.status === 'canary') return { ...item, status: 'draft' as const };
          return item;
        });
        const saved = this.repository.saveConfig({
          orchestration: {
            promptOptimization: {
              versions,
              activeVersionId: mode === 'active' ? target.id : cfg.orchestration.promptOptimization.activeVersionId,
              canaryVersionId: mode === 'canary' ? target.id : '',
            },
          },
        });
        return ok(saved);
      }
      if (method === 'GET' && path === '/api/orchestration/capabilities') {
        const cfg = this.repository.getConfig();
        const descriptors = applyCapabilityOverrides(allCapabilityDescriptors(), cfg.orchestration?.capabilityOverrides || {});
        const gated = applyRuntimeCapabilityGates(descriptors, { sunoEnabled: Boolean(cfg.orchestration?.suno?.enabled), externalEnabled: Boolean(cfg.orchestration?.externalProviders?.enabled), allowlist: cfg.orchestration?.externalProviders?.allowlist || [] });
        return ok({ success: true, capabilities: gated.map((item) => ({ ...item, health: capabilityHealth(cfg, item) })), manifest: buildCapabilityManifest(gated) });
      }
      if (method === 'GET' && path === '/api/reply-preferences') {
        const records = await readReplyPreferenceRecords();
        const now = Date.now();
        return ok({
          success: true,
          records: records.map((record) => ({
            ...record,
            expired: Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now),
          })),
        });
      }
      if (method === 'POST' && path === '/api/reply-preferences/delete') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const scope = body.scope === 'session' || body.scope === 'user' ? body.scope : undefined;
        const key = String(body.key || '').trim();
        if (!scope || !key) return json(400, { success: false, error: 'scope(session|user) and key are required' });
        const records = await readReplyPreferenceRecords();
        const next = records.filter((record) => !(record.scope === scope && record.key === key));
        const removed = records.length - next.length;
        if (removed) {
          await writeReplyPreferenceRecords(next);
          await auditReplyPreferenceAction('reply_preference.deleted', { scope, key, removed });
        }
        return ok({ success: true, removed });
      }
      if (method === 'POST' && path === '/api/reply-preferences/clear') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const scope = body.scope === 'session' || body.scope === 'user' ? body.scope : undefined;
        const records = await readReplyPreferenceRecords();
        const next = scope ? records.filter((record) => record.scope !== scope) : [];
        const removed = records.length - next.length;
        if (removed) {
          await writeReplyPreferenceRecords(next);
          await auditReplyPreferenceAction('reply_preference.cleared', { scope: scope || 'all', removed });
        }
        return ok({ success: true, removed });
      }
      // ── R18/提示词注册表：GET 列表 + POST 修改（保存 config → bot loadIfChanged → 下一轮热重载）──
      if (method === 'GET' && path === '/api/prompts') {
        const cfg = this.repository.getConfig() as unknown as Record<string, unknown>;
        const entries = PROMPT_REGISTRY.map((entry) => ({
          id: entry.id,
          title: entry.title,
          description: entry.description,
          category: entry.category,
          hotReload: entry.hotReload,
          variables: entry.variables || '',
          editable: Boolean(entry.configPath),
          builtin: Boolean(entry.builtin),
          content: entry.configPath ? getPromptValue(cfg, entry.configPath) : '',
          configPath: entry.configPath,
        }));
        return ok({ success: true, prompts: entries });
      }
      if (method === 'POST' && path === '/api/prompts/update') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const id = String(body.id || '').trim();
        const content = String(body.content ?? '');
        const entry = PROMPT_REGISTRY.find((item) => item.id === id);
        if (!entry) throw new WebApiError(404, `未知提示词 ID: ${id}`);
        if (!entry.configPath) throw new WebApiError(400, `提示词 ${id} 当前为代码内置，暂不支持面板编辑`);
        if (content.length > 100_000) throw new WebApiError(400, '提示词内容过长（上限 100,000 字符）');
        // 读取当前配置 → 写入指定路径 → 保存（saveConfig 内含归一化 + 版本记录 + mtime 热重载通知）
        const cfg = this.repository.getConfig() as unknown as Record<string, unknown>;
        setPromptValue(cfg, entry.configPath, content);
        const saved = this.repository.saveConfig(cfg);
        return ok({ success: true, saved: true, id, revision: saved.revision, hotReload: entry.hotReload });
      }
      if (method === 'POST' && path === '/api/prompts/reset') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const id = String(body.id || '').trim();
        const entry = PROMPT_REGISTRY.find((item) => item.id === id);
        if (!entry) throw new WebApiError(404, `未知提示词 ID: ${id}`);
        if (!entry.configPath) throw new WebApiError(400, `提示词 ${id} 当前为代码内置`);
        const cfg = this.repository.getConfig() as unknown as Record<string, unknown>;
        setPromptValue(cfg, entry.configPath, '');
        const saved = this.repository.saveConfig(cfg);
        return ok({ success: true, reset: true, id, note: '已重置为出厂默认（空值触发 normalize 填充内置模板）', revision: saved.revision });
      }
      // ── R18/日志：GET /api/logs?level=&contains=&limit= （读 bot-logs.jsonl）──
      if (method === 'GET' && path === '/api/logs') {
        const query = request.query || {};
        const level = String(query.level || '').trim().toLowerCase() || undefined;
        const contains = String(query.contains || '').trim() || undefined;
        const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
        const logPath = this.resolveLogPath(query.file);
        const entries: unknown[] = [];
        try {
          const raw = readFileSync(logPath, 'utf8');
          const lines = raw.split('\n').filter(Boolean);
          const start = Math.max(0, lines.length - limit * 4);
          for (const line of lines.slice(start)) {
            try {
              const record = JSON.parse(line);
              if (level && record.level !== level) continue;
              if (contains && !JSON.stringify(record).toLowerCase().includes(contains.toLowerCase())) continue;
              entries.push(record);
              if (entries.length >= limit) break;
            } catch { /* skip malformed */ }
          }
        } catch { /* file may not exist yet */ }
        return ok({ success: true, logs: entries, total: entries.length, file: logPath });
      }
      // ── R18/日志原始文本：GET /api/logs/raw（面板"复制"按钮用，返回可复制的纯文本）──
      if (method === 'GET' && path === '/api/logs/raw') {
        const query = request.query || {};
        const level = String(query.level || '').trim().toLowerCase() || undefined;
        const contains = String(query.contains || '').trim() || undefined;
        const limit = Math.min(2000, Math.max(1, Number(query.limit) || 200));
        const logPath = this.resolveLogPath(query.file);
        const lines: string[] = [];
        try {
          const raw = readFileSync(logPath, 'utf8');
          const all = raw.split('\n').filter(Boolean);
          for (const line of all.slice(-limit * 4)) {
            try {
              const record = JSON.parse(line);
              if (level && record.level !== level) continue;
              if (contains && !JSON.stringify(record).toLowerCase().includes(contains.toLowerCase())) continue;
              const ts = String(record.timestamp || '');
              const lv = String(record.level || '').toUpperCase().padEnd(5);
              const scope = String(record.scope || '');
              const msg = String(record.message || '');
              const data = record.data ? ' ' + JSON.stringify(record.data) : '';
              const err = record.error ? ' ERROR=' + JSON.stringify(record.error) : '';
              lines.push(`${ts} [${lv}] ${scope}: ${msg}${data}${err}`);
              if (lines.length >= limit) break;
            } catch { /* skip */ }
          }
        } catch { /* empty */ }
        return { status: 200, body: { success: true, raw: lines.join('\n'), count: lines.length } };
      }
      if (method === 'GET' && path === '/api/config/schema') {
        return ok({
          success: true,
          schemaVersion: CONFIG_SCHEMA_VERSION,
          fields: CONFIG_V3_FIELD_METADATA,
          migrations: CONFIG_MIGRATION_TABLE,
        });
      }
      if (method === 'GET' && path === '/api/config') {
        return ok({ success: true, config: this.repository.getMaskedConfig(), revision: this.repository.revision, auth: this.repository.getAuthSnapshot(false) });
      }
      if (method === 'POST' && path === '/api/config') {
        const saved = this.repository.saveConfig(request.body);
        return ok(isCompactRequest(request.path) ? compactConfigSaveResult(saved) : saved);
      }
      if (method === 'POST' && path === '/api/config/import') {
        return ok(this.repository.importAndSave(request.body));
      }
      if (method === 'POST' && path === '/api/config/import/preview') {
        return ok({ success: true, importResult: this.repository.previewImport(request.body) });
      }
      if (method === 'GET' && path === '/api/config/export') {
        return ok({ success: true, export: this.repository.exportConfig() });
      }
      if (method === 'GET' && path === '/api/config/versions') {
        return ok({ success: true, versions: this.repository.listVersions() });
      }
      if (method === 'GET' && path.startsWith('/api/config/versions/')) {
        const rest = path.slice('/api/config/versions/'.length);
        if (rest.endsWith('/diff')) {
          const version = Number(rest.slice(0, -'/diff'.length));
          return ok({ success: true, version, changedPaths: this.repository.diffVersion(version) });
        }
        const version = Number(rest);
        return ok({ success: true, version: this.repository.getVersion(version) });
      }
      if (method === 'POST' && path === '/api/config/rollback') {
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
        const version = Number(body.version);
        if (!Number.isFinite(version) || version < 1) return json(400, { success: false, error: 'version is required' });
        return ok(this.repository.rollbackToVersion(version));
      }
      if (method === 'GET' && path === '/api/auth/status') {
        return ok({ success: true, auth: this.repository.getAuthSnapshot(false), revision: this.repository.revision });
      }

      return json(404, { success: false, error: 'Not Found' });
    } catch (error) {
      if (error instanceof WebApiError) return json(error.status, { success: false, error: error.message });
      const message = error instanceof Error ? error.message : String(error);
      return json(500, { success: false, error: message });
    }
  }
}

/**
 * 凭据里还带着打码哨兵就直接拒绝，绝不落盘。
 * 典型场景是导入了别人机器上打码过的配置——那串圆点对不上本机任何旧值，
 * 一旦写进去，上游调用全 401、NapCat 掉线、面板密码变成圆点，且原值再也找不回来。
 */
function assertSecretsResolved(config: unknown, what: string): void {
  const unresolved = findUnresolvedSecrets(config);
  if (!unresolved.length) return;
  throw new WebApiError(
    400,
    `${what}里有 ${unresolved.length} 项凭据仍是打码值，未保存：${unresolved.join('、')}。`
    + '这通常是因为导入了别处面板导出的配置——打码值只能在生成它的那台机器上还原。'
    + '请在对应字段填入真实凭据后再保存。',
  );
}

export function createConfigRepository(options: ConfigRepositoryOptions = {}): ConfigRepository {
  return new ConfigRepository(options);
}

export function createWebApi(options: WebApiOptions = {}): WebApi {
  return new WebApi(options);
}

/**
 * 常量时间比较。用逐字符短路比较校验密码，理论上可以按响应耗时逐位试出前缀；
 * 这里比较的是用户真实密码，值得用常量时间。
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // 长度不同也跑一次比较，保持耗时稳定。
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function derivePanelToken(passwordSeed: string): string {
  return createHash('sha256').update(`miobot-v2-panel:${String(passwordSeed || '')}`).digest('hex');
}

export function hashPasswordSeed(passwordSeed: string): string {
  return createHash('sha256').update(`seed:${String(passwordSeed || '')}`).digest('hex').slice(0, 16);
}

export function diffConfigPaths(previous: unknown, next: unknown): string[] {
  const paths = diffValue(previous, next, '');
  return paths.length ? paths : [];
}

export function mergeConfigPatch(current: AppConfig, patch: Record<string, unknown>): AppConfig {
  return deepMerge(clone(current) as unknown as Record<string, unknown>, patch) as unknown as AppConfig;
}

class WebApiError extends Error {
  readonly status: WebApiStatus;
  constructor(status: WebApiStatus, message: string) {
    super(message);
    this.name = 'WebApiError';
    this.status = status;
  }
}

function ok<T>(body: T): WebApiResponse<T> {
  return json(200, body);
}

function json<T>(status: WebApiStatus, body: T): WebApiResponse<T> {
  return { status, body };
}

function normalizePath(path: string): string {
  const raw = String(path || '/').split('?')[0] || '/';
  return raw.endsWith('/') && raw.length > 1 ? raw.slice(0, -1) : raw;
}

function isCompactRequest(path: string): boolean {
  const query = String(path || '').split('?')[1] || '';
  return new URLSearchParams(query).get('compact') === '1';
}

function compactConfigSaveResult(result: ConfigSaveResult): Omit<ConfigSaveResult, 'config'> {
  const { config: _config, ...rest } = result;
  return rest;
}

function getAuthorization(headers?: WebApiHeaders): string | undefined {
  if (!headers) return undefined;
  return headers.authorization || headers.Authorization || headers.AUTHORIZATION;
}

function readPassword(body: unknown): string {
  if (isObject(body)) return String(body.password ?? '');
  return '';
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // 配置来自 HTTP 请求体，合并前必须挡掉原型链注入（与 config 包同规则）。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    output[key] = isObject(value) && isObject(output[key]) ? deepMerge(output[key] as Record<string, unknown>, value) : value;
  }
  return output;
}

function diffValue(previous: unknown, next: unknown, prefix: string): string[] {
  if (stableJson(previous) === stableJson(next)) return [];
  if (!isObject(previous) || !isObject(next)) return [prefix || '$'];
  const keys = Array.from(new Set([...Object.keys(previous), ...Object.keys(next)])).sort();
  const out: string[] = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = previous[key];
    const b = next[key];
    if (Array.isArray(a) || Array.isArray(b) || !isObject(a) || !isObject(b)) {
      if (stableJson(a) !== stableJson(b)) out.push(path);
      continue;
    }
    out.push(...diffValue(a, b, path));
  }
  return out;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
