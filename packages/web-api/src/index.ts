import { createHash } from 'node:crypto';
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

  getAuthSnapshot(passwordSeedChanged = false): PanelAuthSnapshot {
    return {
      token: derivePanelToken(this.config.panel.passwordSeed),
      tokenVersion: this.tokenVersionValue,
      passwordSeedHash: hashPasswordSeed(this.config.panel.passwordSeed),
      passwordSeedChanged,
    };
  }

  login(password: string): LoginResult {
    if (String(password) !== this.config.panel.passwordSeed) {
      throw new WebApiError(401, '密码错误');
    }
    return { success: true, auth: this.getAuthSnapshot(false), config: this.getConfig(), revision: this.revisionValue };
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
    const imported = importAppConfig(payload);
    const saved = this.saveFullConfig(imported.config, '配置已导入并热重载');
    return { ...saved, importResult: imported };
  }

  saveConfig(patchOrConfig: unknown): ConfigSaveResult {
    const merged = mergeConfigPatch(this.config, objectOrEmpty(patchOrConfig));
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

    for (const listener of this.listeners) listener(hotReload, this.getConfig());

    return {
      success: true,
      message,
      config: this.getConfig(),
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
        return ok({ success: true, config: this.repository.getConfig(), revision: this.repository.revision, auth: this.repository.getAuthSnapshot(false) });
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

export function createConfigRepository(options: ConfigRepositoryOptions = {}): ConfigRepository {
  return new ConfigRepository(options);
}

export function createWebApi(options: WebApiOptions = {}): WebApi {
  return new WebApi(options);
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
