import { createHash, timingSafeEqual } from 'node:crypto';
import {
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

export const WEB_API_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/web-api',
  phase: 'P11-web-panel',
};

export type WebApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type WebApiHeaders = Record<string, string | undefined>;
export type WebApiStatus = 200 | 201 | 400 | 401 | 404 | 405 | 500;

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

export interface WebApiRequest {
  method: WebApiMethod;
  path: string;
  headers?: WebApiHeaders;
  body?: unknown;
}

export interface WebApiResponse<T = unknown> {
  status: WebApiStatus;
  body: T;
}

export type ConfigReloadListener = (event: HotReloadEvent, config: AppConfig) => void;

export interface ConfigRepositoryOptions {
  initialConfig?: unknown;
  now?: () => Date;
}

export interface WebApiOptions extends ConfigRepositoryOptions {
  repository?: ConfigRepository;
}

export class ConfigRepository {
  private config: AppConfig;
  private revisionValue = 1;
  private tokenVersionValue = 1;
  private readonly listeners = new Set<ConfigReloadListener>();
  private readonly now: () => Date;

  constructor(options: ConfigRepositoryOptions = {}) {
    this.config = options.initialConfig === undefined ? createDefaultConfig() : normalizeConfig(options.initialConfig);
    this.now = options.now || (() => new Date());
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

  login(password: string): LoginResult {
    if (!safeEqual(String(password ?? ''), this.config.panel.passwordSeed)) {
      throw new WebApiError(401, '密码错误');
    }
    return { success: true, auth: this.getAuthSnapshot(false), config: this.getMaskedConfig(), revision: this.revisionValue };
  }

  isAuthorized(authorizationHeader?: string): boolean {
    const provided = String(authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
    return Boolean(provided) && provided === derivePanelToken(this.config.panel.passwordSeed);
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

  async handle(request: WebApiRequest): Promise<WebApiResponse> {
    const method = request.method.toUpperCase() as WebApiMethod;
    const path = normalizePath(request.path);
    try {
      if (method === 'POST' && path === '/api/login') {
        return ok(this.repository.login(readPassword(request.body)));
      }

      if (path.startsWith('/api/') && !this.repository.isAuthorized(getAuthorization(request.headers))) {
        return json(401, { success: false, error: 'Unauthorized' });
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
