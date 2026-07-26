import { createAdminService, createFileLogStore, createInMemoryLogStore, type AdminResponse, type AdminServiceDeps, type AdminService, type CanvasCardsDep } from '../../../packages/admin-service/src/index.js';
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
  /** 画布卡片视图(跨域读 canvas 画廊/反推)；可延迟注入(闭包在请求时解析 canvas store)。 */
  canvasCards?: CanvasCardsDep;
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
    ? new ConfigStore<AppConfig>(options.configFilePath, {
        defaultValue: createDefaultConfig(),
        normalize: normalizeConfig,
        onCorrupted: (info) => {
          console.error(`[admin] config.json 解析失败：${info.reason}`);
          if (info.backupPath) console.error(`[admin] 原文件已备份到 ${info.backupPath}`);
        },
      })
    : undefined;
  const initialConfig = configStore ? configStore.load() : createDefaultConfig();

  // config.json 存在但解析不了时，**必须拒绝启动**。
  // 以前是静默用默认配置继续跑，后果是：白名单变成空数组（对 bot-router 来说等于全放行）、
  // 面板密码回落成公开的默认种子、画布访问模式回落 public——
  // 一个语法错误就能让整台机器从「有门禁」变成「全开放」，而健康检查照样 200。
  // 宁可 crash-loop 让进程管理器报警，也不能带着 fail-open 的默认配置上线。
  if (configStore?.isCorrupted()) {
    throw new Error(
      `config.json 解析失败，已拒绝启动：${configStore.corruptionReason()}。`
      + '原文件未被覆盖，修好 JSON 语法后重启即可；若要从零开始，删掉该文件再启动。',
    );
  }
  const logs = options.systemLogFile && options.canvasLogFile
    ? createFileLogStore(options.systemLogFile, options.canvasLogFile)
    : createInMemoryLogStore();

  // 注入真实外部适配器(fetch-models/test-image/test-napcat/hf/templates);getConfig/saveConfig 前向引用读热重载后的配置仓储。
  let svc: AdminService | null = null;
  const baseDeps = options.deps || createAdminDeps(
    () => (svc ? svc.repository.getConfig() : initialConfig),
    (patch) => (svc ? svc.repository.saveConfig(patch) : { config: initialConfig }),
  );
  // canvasCards 跨域注入(可延迟：闭包在请求时解析已装配的 canvas store)。
  const deps: AdminServiceDeps = options.canvasCards ? { ...baseDeps, canvasCards: options.canvasCards } : baseDeps;
  const service = createAdminService({ initialConfig, logs, deps, now: options.now });
  svc = service;

  // 配置热重载 → 原子回存到文件。
  if (configStore) {
    // 这里**不要**吞异常：web-api 会逐个收集监听器的错误，
    // 并把 persisted:false + 原因如实返回给面板。吞掉的话用户会以为已经保存了。
    service.repository.onReload((_event, config) => {
      configStore.save(config);
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
