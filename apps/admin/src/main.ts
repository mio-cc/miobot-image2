import { createAdminService, createFileLogStore, createInMemoryLogStore, type AdminResponse, type AdminServiceDeps, type AdminService } from '../../../packages/admin-service/src/index.js';
import { ConfigStore } from '../../../packages/storage/src/index.js';
import { createDefaultConfig, normalizeConfig, type AppConfig } from '../../../packages/config/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';
import { createAdminDeps } from './adapters.js';

export { createAdminDeps, cleanBaseUrl, extractModelIds } from './adapters.js';

export const ADMIN_APP: PackageDescriptor = { name: '@miobot-v2/app-admin', phase: 'P5-admin-service' };

export interface AdminAppOptions {
  /** 配置文件路径(JSON)。给定则从文件读、热重载回存；不给则纯内存默认配置。 */
  configFilePath?: string;
  /** 系统/画布日志文件；两个都给才用文件日志，否则内存日志。 */
  systemLogFile?: string;
  canvasLogFile?: string;
  /** 注入外部集成(fetch-models / test-napcat / test-image / huggingface / codex)。 */
  deps?: AdminServiceDeps;
  now?: () => Date;
}

export interface AdminApp {
  service: AdminService;
}

/**
 * 装配 admin 应用：storage.ConfigStore 持久化 + admin-service 路由 + 配置热重载回存。
 * 这是 local-verify-server.mjs 里 admin 部分(配置读写/日志/测试)的去向。
 */
export function createAdminApp(options: AdminAppOptions = {}): AdminApp {
  const configStore = options.configFilePath
    ? new ConfigStore<AppConfig>(options.configFilePath, { defaultValue: createDefaultConfig(), normalize: normalizeConfig })
    : undefined;
  const initialConfig = configStore ? configStore.load() : createDefaultConfig();
  const logs = options.systemLogFile && options.canvasLogFile
    ? createFileLogStore(options.systemLogFile, options.canvasLogFile)
    : createInMemoryLogStore();

  // 注入真实外部适配器(fetch-models/test-image/test-napcat/hf/templates);getConfig 前向引用读热重载后的配置。
  let svc: AdminService | null = null;
  const deps = options.deps || createAdminDeps(() => (svc ? svc.repository.getConfig() : initialConfig));
  const service = createAdminService({ initialConfig, logs, deps, now: options.now });
  svc = service;

  // 配置热重载 → 原子回存到文件。
  if (configStore) {
    service.repository.onReload((_event, config) => {
      try { configStore.save(config); } catch { /* 落盘失败不阻塞热重载 */ }
    });
  }

  return { service };
}

/** 把 admin 响应套用到 Node http 响应(供 apps/admin 的 http 适配层调用)。 */
export function applyAdminResponse(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (chunk?: string) => void }, result: AdminResponse): void {
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(result.body));
}

export function describeAdminApp() {
  return { app: '@miobot-v2/app-admin', phase: 'P5-admin-service' as const, packages: ['@miobot-v2/admin-service', '@miobot-v2/web-api', '@miobot-v2/storage'] };
}
