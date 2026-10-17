import { createWebApi, type ConfigRepository, type WebApi, type WebApiRequest } from '../../web-api/src/index.js';
import { getDefaultPrompts } from '../../config/src/index.js';
import type { LogQuery } from '../../logger/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';
import { COMMON_FEATURE_LIMIT_FIELDS, FEATURE_DEFINITIONS, featureAliasCollisions, type FeatureSettings } from '../../shared/src/features.js';
import { createInMemoryLogStore, type AdminLogStore } from './logs.js';
import { OPERATION_LABELS, checkCapabilityBindings, resolveModelCapabilities } from './capabilities.js';
import { createMetrics, type Metrics } from '../../core/src/metrics.js';
import type { AdminHandler, AdminResponse, AdminServiceDeps } from './types.js';

export const ADMIN_SERVICE_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/admin-service',
  phase: 'P5-admin-service',
};

export interface AdminServiceOptions {
  initialConfig?: unknown;
  logs?: AdminLogStore;
  deps?: AdminServiceDeps;
  webApi?: WebApi;
  now?: () => Date;
  /** 运行指标收集器；不传则用纯内存实例（重启即清零）。 */
  metrics?: Metrics;
}

/**
 * 管理后台业务：在 web-api(配置仓储/登录/导入导出) 之上补齐 logs/default-prompts/test/models/templates/codex 路由。
 * 传输无关(吃 WebApiRequest 吐 AdminResponse)，外部集成全部依赖注入(未配置则 501)。
 * 取代 local-verify-server.mjs 里 handleCompatApi 那一大坨内联逻辑。
 */
export class AdminService {
  readonly api: WebApi;
  readonly logs: AdminLogStore;
  readonly metrics: Metrics;
  private readonly deps: AdminServiceDeps;

  constructor(options: AdminServiceOptions = {}) {
    this.api = options.webApi || createWebApi({ initialConfig: options.initialConfig, now: options.now });
    this.logs = options.logs || createInMemoryLogStore();
    this.deps = options.deps || {};
    this.metrics = options.metrics || createMetrics();
  }

  get repository(): ConfigRepository {
    return this.api.repository;
  }

  async handle(req: WebApiRequest): Promise<AdminResponse> {
    const method = String(req.method || 'GET').toUpperCase();
    const path = normalizePath(req.path);

    // 登录公共，交给 web-api。
    if (method === 'POST' && path === '/api/login') return this.api.handle(req);

    // /api/* 统一鉴权（Bearer token = derivePanelToken(passwordSeed)）。
    if (path.startsWith('/api/') && !this.repository.isAuthorized(authHeader(req.headers))) {
      return { status: 401, body: { success: false, error: 'Unauthorized' } };
    }

    if (method === 'GET' && path === '/api/default-prompts') {
      return { status: 200, body: { success: true, prompts: getDefaultPrompts() } };
    }

    // 命令与意图：前端动态表单的唯一数据源，避免新增功能后后台字段漂移。
    if (method === 'GET' && path === '/api/features') {
      const cfg = this.repository.getConfig();
      const settings = (cfg.bot?.features || {}) as FeatureSettings;
      return {
        status: 200,
        body: {
          success: true,
          definitions: FEATURE_DEFINITIONS,
          commonLimitFields: COMMON_FEATURE_LIMIT_FIELDS,
          settings,
          collisions: featureAliasCollisions(settings),
        },
      };
    }

    // 能力体检：逐项检查「这项能力配的模型能不能干这活」，
    // 让用户在发消息之前就看到问题，而不是等群里收到一句看不懂的 400。
    if (method === 'GET' && path === '/api/capabilities') {
      const bindings = checkCapabilityBindings(this.repository.getConfig());
      return {
        status: 200,
        body: {
          success: true,
          bindings,
          labels: OPERATION_LABELS,
          brokenCount: bindings.filter((b) => b.enabled && !b.ok).length,
        },
      };
    }

    if (method === 'POST' && path === '/api/capabilities/resolve') {
      const body = (req.body || {}) as { nodeIndex?: unknown; model?: unknown };
      const model = String(body.model ?? '').trim();
      if (!model) return { status: 400, body: { success: false, error: '缺少 model' } };
      return {
        status: 200,
        body: { success: true, resolved: resolveModelCapabilities(this.repository.getConfig(), Number(body.nodeIndex ?? 0) || 0, model) },
      };
    }

    /** 近 24 小时的分小时指标，总览页用它画趋势。 */
    if (method === 'GET' && path === '/api/metrics') {
      // 数据是 bot 进程写的，这里必须重读文件——否则面板永远显示 web 进程
      // 启动那一刻的快照（在没有生产者的年代，那就是一片 0）。
      this.metrics.reload();
      return { status: 200, body: { success: true, ...this.metrics.snapshot() } };
    }

    if (method === 'GET' && path === '/api/logs') return { status: 200, body: this.readLogs('system', req.path) };
    if (method === 'POST' && path === '/api/logs/clear') { this.logs.system.clear(); return { status: 200, body: this.readLogs('system', req.path) }; }
    if (method === 'GET' && path === '/api/canvas/logs') return { status: 200, body: this.readLogs('canvas', req.path) };
    if (method === 'POST' && path === '/api/canvas/logs/clear') { this.logs.canvas.clear(); return { status: 200, body: this.readLogs('canvas', req.path) }; }

    if (method === 'POST' && path === '/api/templates/title') {
      return { status: 200, body: { success: true, title: templateTitle(req.body) } };
    }
    if (method === 'POST' && path === '/api/templates/convert') return this.viaDep(this.deps.templatesConvert, req.body, 'templates/convert');
    if (method === 'POST' && path === '/api/fetch-models') return this.viaDep(this.deps.fetchModels, req.body, 'fetch-models');
    if (method === 'POST' && path === '/api/huggingface/models') return this.viaDep(this.deps.fetchHuggingFaceModels, req.body, 'huggingface/models');
    if (method === 'POST' && path === '/api/test-napcat') return this.viaDep(this.deps.testNapcat, req.body, 'test-napcat');
    if (method === 'POST' && path === '/api/test-image') return this.viaDep(this.deps.testImage, req.body, 'test-image');
    if (method === 'POST' && path === '/api/search/test') return this.viaDep(this.deps.testSearch, req.body, 'search/test');

    // 画布卡片视图：admin 面板展示/删除画布画廊+反推记录，数据归属 canvas 域(经 canvasCards 注入)。
    if (method === 'GET' && path === '/api/canvas/cards') {
      if (!this.deps.canvasCards) return notConfigured('canvas/cards');
      const items = this.deps.canvasCards.list();
      return { status: 200, body: { success: true, items, total: items.length } };
    }
    const cardDelete = matchCanvasCardDelete(method, path);
    if (cardDelete) {
      if (!this.deps.canvasCards) return notConfigured('canvas/cards');
      const deleted = this.deps.canvasCards.delete(cardDelete.kind, cardDelete.id);
      if (!deleted) return { status: 404, body: { success: false, error: 'Card not found' } };
      const items = this.deps.canvasCards.list();
      return { status: 200, body: { success: true, deleted: { kind: cardDelete.kind, id: cardDelete.id }, items, total: items.length } };
    }

    if (path.startsWith('/api/codex/')) {
      // codex 未注入时返回 200 + enabled:false（而非 501）。
      // 501 会让浏览器控制台刷红色网络错误噪音；200 让前端 codexStatus 正常拿到"未启用"状态。
      if (!this.deps.codex) return { status: 200, body: { success: true, enabled: false, notConfigured: true } };
      return this.deps.codex.handle(method, path, req.body);
    }

    // 其余 config/import/export/auth 交给 web-api。
    return this.api.handle(req);
  }

  private async viaDep(handler: AdminHandler | undefined, body: unknown, name: string): Promise<AdminResponse> {
    if (typeof handler !== 'function') return notConfigured(name);
    try {
      return await handler(body);
    } catch (error) {
      return { status: 502, body: { success: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }

  private readLogs(channel: 'system' | 'canvas', rawPath: string): { success: true; items: unknown[]; total: number } {
    const items = this.logs[channel].query(parseLogQuery(rawPath));
    return { success: true, items, total: items.length };
  }
}

export function createAdminService(options: AdminServiceOptions = {}): AdminService {
  return new AdminService(options);
}

function normalizePath(path: string): string {
  const raw = String(path || '/').split('?')[0] || '/';
  return raw.endsWith('/') && raw.length > 1 ? raw.slice(0, -1) : raw;
}

function authHeader(headers?: Record<string, string | undefined>): string | undefined {
  if (!headers) return undefined;
  return headers.authorization || headers.Authorization || (headers as Record<string, string | undefined>).AUTHORIZATION;
}

function templateTitle(body: unknown): string {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const prompt = String(b.templatePrompt || b.prompt || '').trim();
  return prompt.replace(/\{\{prompt\}\}/g, '').trim().slice(0, 16) || '模板';
}

function parseLogQuery(rawPath: string): LogQuery {
  const query = String(rawPath || '').split('?')[1] || '';
  const params = new URLSearchParams(query);
  const out: LogQuery = {};
  const level = params.get('level');
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') out.level = level;
  const scope = params.get('scope');
  if (scope) out.scope = scope;
  const contains = params.get('contains') || params.get('q');
  if (contains) out.contains = contains;
  const limit = params.get('limit');
  if (limit && Number.isFinite(Number(limit))) out.limit = Math.max(0, Math.trunc(Number(limit)));
  return out;
}

function notConfigured(name: string): AdminResponse {
  return { status: 501, body: { success: false, error: `${name} 未配置（apps/admin 未注入该集成）` } };
}

/** 匹配 DELETE /api/canvas/cards/:kind/:id（kind=gallery|interrogation）；不匹配返回 undefined。 */
function matchCanvasCardDelete(method: string, path: string): { kind: 'gallery' | 'interrogation'; id: string } | undefined {
  if (method !== 'DELETE') return undefined;
  const m = path.match(/^\/api\/canvas\/cards\/(gallery|interrogation)\/(.+)$/);
  if (!m) return undefined;
  return { kind: m[1] as 'gallery' | 'interrogation', id: decodeURIComponent(m[2]) };
}
