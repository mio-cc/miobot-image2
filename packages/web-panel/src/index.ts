import { importConfig as importAppConfig, type AppConfig, type ConfigImportResult } from '../../config/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';

export const WEB_PANEL_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/web-panel',
  phase: 'P11-web-panel',
};

export interface PanelAuthState {
  token: string;
  tokenVersion: number;
  passwordSeedHash: string;
}

export interface PanelSessionState {
  authenticated: boolean;
  token?: string;
  tokenVersion?: number;
  passwordSeedHash?: string;
  revision?: number;
  config?: AppConfig;
  viewModel?: PanelViewModel;
  lastError?: string;
  migrations: ConfigImportResult['migrations'];
  warnings: string[];
}

export interface PanelSection<T = unknown> {
  id: string;
  title: string;
  ready: boolean;
  data: T;
}

export interface PanelViewModel {
  config: AppConfig;
  sections: {
    connection: PanelSection<{ wsUrl: string; hasToken: boolean }>;
    llm: PanelSection<{ nodeCount: number; chatModel: string; imageModel: string }>;
    freeMode: PanelSection<AppConfig['freeMode']>;
    replyStrategies: PanelSection<AppConfig['bot']['replyStrategies']>;
    templates: PanelSection<{ count: number; ids: string[] }>;
  };
  canRender: boolean;
  migrations: ConfigImportResult['migrations'];
  warnings: string[];
}

export interface PanelApiClient {
  login(password: string): Promise<PanelLoginResponse>;
  loadConfig(token: string): Promise<PanelConfigResponse>;
  saveConfig(token: string, config: unknown): Promise<PanelSaveResponse>;
  importConfig(token: string, payload: unknown): Promise<PanelImportResponse>;
}

export interface PanelLoginResponse {
  success: true;
  auth: PanelAuthState;
  config: AppConfig;
  revision: number;
}

export interface PanelConfigResponse {
  success: true;
  config: AppConfig;
  revision: number;
  auth?: PanelAuthState;
}

export interface PanelSaveResponse extends PanelConfigResponse {
  message?: string;
  hotReload?: { revision: number; changedPaths: string[]; passwordSeedChanged: boolean; napcatReconnectRequired: boolean; reloadedAt: string };
}

export interface PanelImportResponse extends PanelSaveResponse {
  importResult?: ConfigImportResult;
}

export class PanelController {
  readonly state: PanelSessionState = { authenticated: false, migrations: [], warnings: [] };
  private readonly client: PanelApiClient;

  constructor(client: PanelApiClient) {
    this.client = client;
  }

  async login(password: string): Promise<PanelSessionState> {
    try {
      const response = await this.client.login(password);
      this.applyConfigResponse(response);
      this.applyAuth(response.auth);
      this.state.authenticated = true;
      this.state.lastError = undefined;
    } catch (error) {
      this.state.authenticated = false;
      this.state.lastError = errorMessage(error);
    }
    return this.snapshot();
  }

  async loadConfig(): Promise<PanelSessionState> {
    try {
      const token = this.requireToken();
      const response = await this.client.loadConfig(token);
      this.applyConfigResponse(response);
      if (response.auth) this.applyAuth(response.auth);
      this.state.lastError = undefined;
    } catch (error) {
      this.state.lastError = errorMessage(error);
    }
    return this.snapshot();
  }

  async saveConfig(config: unknown): Promise<PanelSessionState> {
    try {
      const token = this.requireToken();
      const response = await this.client.saveConfig(token, config);
      this.applyConfigResponse(response);
      if (response.auth) this.applyAuth(response.auth);
      this.state.lastError = undefined;
    } catch (error) {
      this.state.lastError = errorMessage(error);
    }
    return this.snapshot();
  }

  async importConfig(payload: unknown): Promise<PanelSessionState> {
    try {
      const token = this.requireToken();
      const response = await this.client.importConfig(token, payload);
      this.applyConfigResponse(response, response.importResult);
      if (response.auth) this.applyAuth(response.auth);
      this.state.lastError = undefined;
    } catch (error) {
      this.state.lastError = errorMessage(error);
    }
    return this.snapshot();
  }

  snapshot(): PanelSessionState {
    return {
      authenticated: this.state.authenticated,
      token: this.state.token,
      tokenVersion: this.state.tokenVersion,
      passwordSeedHash: this.state.passwordSeedHash,
      revision: this.state.revision,
      config: this.state.config,
      viewModel: this.state.viewModel,
      lastError: this.state.lastError,
      migrations: [...this.state.migrations],
      warnings: [...this.state.warnings],
    };
  }

  private applyAuth(auth: PanelAuthState) {
    this.state.token = auth.token;
    this.state.tokenVersion = auth.tokenVersion;
    this.state.passwordSeedHash = auth.passwordSeedHash;
    this.state.authenticated = true;
  }

  private applyConfigResponse(response: PanelConfigResponse, importResult?: ConfigImportResult) {
    const vm = createPanelViewModel(importResult ? importResult.config : response.config);
    this.state.config = vm.config;
    this.state.viewModel = vm;
    this.state.revision = response.revision;
    this.state.migrations = importResult?.migrations || vm.migrations;
    this.state.warnings = importResult?.warnings || vm.warnings;
  }

  private requireToken(): string {
    if (!this.state.token) throw new Error('Panel is not authenticated.');
    return this.state.token;
  }
}

export function createPanelController(client: PanelApiClient): PanelController {
  return new PanelController(client);
}

export function createPanelViewModel(rawConfig: unknown): PanelViewModel {
  const imported = importAppConfig(rawConfig);
  const config = imported.config;
  return {
    config,
    sections: {
      connection: {
        id: 'connection',
        title: '连接配置',
        ready: Boolean(config.napcat.wsUrl),
        data: { wsUrl: config.napcat.wsUrl, hasToken: Boolean(config.napcat.token) },
      },
      llm: {
        id: 'llm',
        title: '模型节点',
        ready: config.llm.apiKeys.length > 0,
        data: { nodeCount: config.llm.apiKeys.length, chatModel: config.llm.chatModel, imageModel: config.llm.imageModel },
      },
      freeMode: {
        id: 'freeMode',
        title: '自由模式',
        ready: typeof config.freeMode.enabled === 'boolean' && Boolean(config.freeMode.model),
        data: config.freeMode,
      },
      replyStrategies: {
        id: 'replyStrategies',
        title: '回复策略',
        ready: Boolean(config.bot.replyStrategies.text && config.bot.replyStrategies.image && config.bot.replyStrategies.multiImage),
        data: config.bot.replyStrategies,
      },
      templates: {
        id: 'templates',
        title: '模板库',
        ready: Array.isArray(config.bot.promptTemplates),
        data: { count: config.bot.promptTemplates.length, ids: config.bot.promptTemplates.map((item) => item.id) },
      },
    },
    canRender: true,
    migrations: imported.migrations,
    warnings: imported.warnings,
  };
}

export function renderPanelShell(viewModel: PanelViewModel): string {
  const sections = Object.values(viewModel.sections)
    .map((section) => `${section.ready ? 'ready' : 'pending'}:${section.id}`)
    .join('|');
  return `Miobot Admin Panel[${sections}]`;
}

export function reducePanelDraft(current: unknown, patch: unknown): AppConfig {
  const base = createPanelViewModel(current).config as unknown as Record<string, unknown>;
  const next = isObject(patch) ? deepMerge(base, patch) : base;
  return createPanelViewModel(next).config;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
