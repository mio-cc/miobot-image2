import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityDescriptor, CapabilityHandler } from '../../../packages/orchestration/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { McpClient, type McpServerConfig, type McpToolInfo } from './mcp-client.js';
import { refreshAccessToken } from './mcp-oauth.js';
import type { McpCredentialStore } from './mcp-credential-store.js';
import { buildMcpChildTools, buildMcpRootDescriptor, McpRootToolHandler, type McpCapabilityOverrideInput, type McpChildTool } from './mcp-root-tool.js';

/**
 * Phase 2（方案 §4.1/§4.3/§4.9，D3/D6/D7/D11/D16）：MCP 服务器生命周期管理器。
 * - 每服务器恰注册一个树形根能力（registerCapability 同 id 覆盖语义 = 热替换，无需注销即可更新）；
 * - 状态机：disabled / connecting / connected / connected-no-tools / needs-auth / disconnected（D11）；
 * - 工具目录缓存：list_changed 通知失效 + TTL 兜底（D3），重拉后子项 diff——新子项默认不进树（D6）；
 * - 配置 diff 热重载（D16）：新增连接、移除断开、变更重连。
 * 本模块不依赖 start.ts 装配，可独立测试（register/unregister/构造 client 全部可注入）。
 */

export type McpServerState = 'disabled' | 'connecting' | 'connected' | 'connected-no-tools' | 'needs-auth' | 'disconnected';

export interface McpServerStatus {
  serverId: string;
  state: McpServerState;
  toolCount: number;
  enabledToolCount: number;
  lastError?: string;
  lastChangedAt: string;
  /** 目录快照时间（ISO）；list_changed/TTL 失效后重拉更新。 */
  fetchedAt?: string;
}

/** D16：配置摘要——参与 diff 的字段（不含 toolOverrides；覆盖经 capabilityOverrides 即时生效）。
 * token 参与 diff：静态 token 变更即重连（旧 client 持旧 token 会一直 401）；OAuth 服务器凭据在
 * 独立 secret 文件（config 内 token 通常为空），401 走刷新链路，不受此处影响。 */
export function mcpServerConfigSummary(server: McpServerConfig): string {
  return JSON.stringify([
    server.id, server.enabled, server.transport, server.url ?? null, server.command ?? null,
    server.args ?? null, server.allowlist ?? null, server.token ?? null, server.auth ?? null,
    server.proxyUrl ?? null, server.reconnect ?? null, server.toolsCacheTtlMs ?? null,
  ]);
}

export interface McpServerManagerOptions {
  getConfig: () => { orchestration?: { mcpServers?: McpServerConfig[]; capabilityOverrides?: Record<string, McpCapabilityOverrideInput | undefined> } };
  registerCapability: (descriptor: CapabilityDescriptor, handler: CapabilityHandler) => void;
  unregisterCapability: (capabilityId: string) => void;
  logger?: StructuredLogger;
  /** Phase 3：OAuth 凭据存储（auth:'oauth' 服务器读取/刷新）。 */
  credentialStore?: McpCredentialStore;
  /** Phase 3：状态快照文件（data 目录，面板进程读取；缺省不写）。 */
  statusFilePath?: string;
  /** 测试注入：构造 client 的工厂。 */
  createClient?: (server: McpServerConfig, options: { logger?: StructuredLogger; onNotification: (method: string) => void }) => McpClient;
  now?: () => number;
}

interface ManagedServer {
  config: McpServerConfig;
  summary: string;
  client: McpClient | null;
  children: McpChildTool[];
  status: McpServerStatus;
  cacheStale: boolean;
  /** connect 时拉到的原始工具清单（覆盖变化时本地重建树，免重连）。 */
  tools: McpToolInfo[];
  /** 覆盖摘要（capabilityOverrides 的 mcp.<server> 前缀键）——变化时热替换树。 */
  overridesSummary: string;
}

const DEFAULT_TOOLS_CACHE_TTL_MS = 600_000; // D3：目录缓存 TTL 兜底（默认 10 分钟）

export class McpServerManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly logger?: StructuredLogger;
  private readonly now: () => number;
  private readonly createClient: McpServerManagerOptions['createClient'];

  constructor(private readonly options: McpServerManagerOptions) {
    this.logger = options.logger;
    this.now = options.now || (() => Date.now());
    this.createClient = options.createClient || ((server, opts) => new McpClient(server, {
      ...opts,
      // 把配置声明的 proxyUrl（本地调试可选项）与 reconnect（stdio 自愈策略）接进 client options——
      // McpClient 只读 options.*，此前这两个字段仅被解析与 diff，运行时永不生效（死配置）。
      ...(server.proxyUrl ? { proxyUrl: server.proxyUrl } : {}),
      ...(server.reconnect ? { reconnect: server.reconnect } : {}),
    }));
  }

  private capabilities(): Record<string, McpCapabilityOverrideInput | undefined> {
    return this.options.getConfig().orchestration?.capabilityOverrides || {};
  }

  private overrideFor(serverId: string): McpCapabilityOverrideInput {
    return this.capabilities()[`mcp.${serverId}`] || {};
  }

  private setState(managed: ManagedServer, state: McpServerState, lastError?: string): void {
    if (managed.status.state === state && managed.status.lastError === lastError) return;
    managed.status = {
      ...managed.status,
      state,
      ...(lastError !== undefined ? { lastError } : state === 'connected' || state === 'connected-no-tools' ? { lastError: undefined } : {}),
      lastChangedAt: new Date(this.now()).toISOString(),
    };
  }

  private rootId(serverId: string): string {
    return `mcp.${serverId}`;
  }

  /** 子项进树：allowlist 命中（空 allowlist = 全部进树，与 T4.1 语义一致）+ capabilityOverrides 应用（D6/D14/D22）。 */
  private buildChildren(serverId: string, tools: McpToolInfo[], allowlist: string[] | undefined): McpChildTool[] {
    const allow = Array.isArray(allowlist) && allowlist.length ? new Set(allowlist.map(String)) : null;
    const inTree = allow ? tools.filter((tool) => allow.has(String(tool.name))) : tools;
    return buildMcpChildTools(serverId, inTree, this.capabilities());
  }

  private registerRoot(managed: ManagedServer): void {
    const descriptor = buildMcpRootDescriptor(managed.config.id, managed.children, this.overrideFor(managed.config.id));
    const handler = new McpRootToolHandler(managed.client!, managed.config.id, managed.children);
    this.options.registerCapability(descriptor, handler);
    managed.status.toolCount = managed.children.length;
    managed.status.enabledToolCount = managed.children.filter((child) => child.enabled).length;
    this.setState(managed, managed.children.length ? 'connected' : 'connected-no-tools');
  }

  /** 连接单台服务器：initialize → 分页 listTools → 构造树 → 注册根能力。失败分类入状态机（D10/D11）。 */
  async connect(server: McpServerConfig): Promise<void> {
    const managed: ManagedServer = this.servers.get(server.id) || {
      config: server,
      summary: mcpServerConfigSummary(server),
      client: null,
      children: [],
      status: { serverId: server.id, state: 'disabled', toolCount: 0, enabledToolCount: 0, lastChangedAt: new Date(this.now()).toISOString() },
      cacheStale: true,
      tools: [],
      overridesSummary: this.overridesSummaryFor(server.id),
    };
    this.servers.set(server.id, managed);
    this.setState(managed, 'connecting');
    await this.connectManaged(managed, server);
  }

  /** capabilityOverrides 中与该服务器相关的键摘要（前缀 mcp.<server> / mcp.<server>.）。 */
  private overridesSummaryFor(serverId: string): string {
    const entries = Object.entries(this.capabilities())
      .filter(([key]) => key === `mcp.${serverId}` || key.startsWith(`mcp.${serverId}.`))
      .map(([key, value]) => [key, value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(entries);
  }

  /** Phase 3：实际连接逻辑（含 OAuth 凭据注入与 401 刷新重试一次）。
   * refreshDepth：401 刷新重试的深度上限（超限不再刷新，直接进 needs-auth）——
   * 防服务器持续 401 而 AS 持续签发新 token 时的无限递归（每轮都伴随网络调用）。 */
  private async connectManaged(managed: ManagedServer, server: McpServerConfig, refreshDepth = 0): Promise<void> {
    // OAuth 服务器：每次连接从独立 secret 存储取最新 access token 注入（凭据不进 config.json，D13）。
    const effectiveServer = server.auth === 'oauth' && this.options.credentialStore
      ? { ...server, token: this.options.credentialStore.get(server.id)?.accessToken || server.token }
      : server;
    const client = this.createClient!(effectiveServer, {
      logger: this.logger,
      onNotification: (method) => {
        if (method === 'notifications/tools/list_changed') {
          managed.cacheStale = true; // D3：通知失效，待下次调用/巡检重拉
          this.logger?.info('mcp 工具目录变更通知', { server: server.id });
        }
      },
    });
    managed.client = client;
    try {
      await client.initialize();
      const tools = await client.listTools();
      managed.tools = tools;
      managed.children = this.buildChildren(server.id, tools, server.allowlist);
      managed.cacheStale = false;
      managed.overridesSummary = this.overridesSummaryFor(server.id);
      managed.status.fetchedAt = new Date(this.now()).toISOString();
      this.registerRoot(managed);
      this.writeStatusFile();
      this.logger?.info('MCP server 已接入（树形根）', { server: server.id, tools: tools.length, inTree: managed.children.length });
    } catch (error) {
      const message = String((error as Error)?.message || error);
      const refreshed = refreshDepth < 1 ? await this.tryRefreshCredential(server, message) : false;
      if (refreshed) {
        // 刷新成功：关闭旧 client，用新 token 重试一次（仅一次；再 401 由下一轮 needs-auth 判定接住）。
        try { client.close(); } catch { /* 忽略关闭失败 */ }
        await this.connectManaged(managed, server, refreshDepth + 1);
        return;
      }
      managed.client = null;
      try { client.close(); } catch { /* 忽略关闭失败 */ }
      const needsAuth = message.includes('mcp_http_401') || message.includes('mcp_oauth_token_failed:invalid_grant');
      this.setState(managed, needsAuth ? 'needs-auth' : 'disconnected', message);
      this.writeStatusFile();
      this.logger?.warn('MCP server 接入失败', { server: server.id, state: needsAuth ? 'needs-auth' : 'disconnected', error: message });
    }
  }

  /** Phase 3：401 时尝试用 refresh token 换新（auth:'oauth' 且存有 tokenEndpoint/resource）；成功更新存储。 */
  private async tryRefreshCredential(server: McpServerConfig, errorMessage: string): Promise<boolean> {
    if (server.auth !== 'oauth' || !this.options.credentialStore) return false;
    if (!errorMessage.includes('mcp_http_401')) return false;
    const store = this.options.credentialStore;
    const credential = store.get(server.id);
    const storedClient = store.getClient(server.id);
    if (!credential?.refreshToken || !credential.tokenEndpoint || !storedClient || !credential.resource) return false;
    try {
      const refreshed = await refreshAccessToken({
        tokenEndpoint: credential.tokenEndpoint,
        clientId: storedClient.clientId,
        refreshToken: credential.refreshToken,
        resource: credential.resource,
      });
      store.set(server.id, {
        ...credential,
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
        ...(refreshed.expiresIn ? { expiresAt: new Date(this.now() + refreshed.expiresIn * 1000).toISOString() } : {}),
      });
      this.logger?.info('mcp oauth token 已刷新', { server: server.id });
      return true;
    } catch (error) {
      this.logger?.warn('mcp oauth token 刷新失败', { server: server.id, error: String((error as Error)?.message || error) });
      return false;
    }
  }

  /** Phase 3：状态快照文件（面板进程读取；mtime 语义，失败可容忍）。 */
  private writeStatusFile(): void {
    const filePath = this.options.statusFilePath;
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, writtenAt: new Date(this.now()).toISOString(), servers: this.status(), children: this.childSnapshot() }, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      this.logger?.warn('mcp 状态快照写入失败', { filePath, error: String((error as Error)?.message || error) });
    }
  }

  /** 子项目录快照（面板子项列表数据源）。 */
  private childSnapshot(): Array<{ serverId: string; name: string; displayName?: string; summary: string; effect: string; riskLevel: string; enabled: boolean }> {
    const snapshot: Array<{ serverId: string; name: string; displayName?: string; summary: string; effect: string; riskLevel: string; enabled: boolean }> = [];
    for (const managed of this.servers.values()) {
      for (const child of managed.children) {
        snapshot.push({
          serverId: managed.config.id,
          name: child.name,
          ...(child.displayName ? { displayName: child.displayName } : {}),
          summary: child.summary,
          effect: String(child.effect || 'unknown'),
          riskLevel: String(child.riskLevel || 'medium'),
          enabled: child.enabled,
        });
      }
    }
    return snapshot;
  }

  /** 断开并注销根能力（配置移除 / enabled=false / 变更重连前）。 */
  disconnect(serverId: string): void {
    const managed = this.servers.get(serverId);
    if (!managed) return;
    try { managed.client?.close(); } catch { /* 忽略关闭失败 */ }
    this.options.unregisterCapability(this.rootId(serverId));
    this.servers.delete(serverId);
    this.writeStatusFile();
    this.logger?.info('MCP server 已断开并注销', { server: serverId });
  }

  /** D16：配置 diff 热重载——新增连接、移除断开、变更重连。 */
  async reload(): Promise<void> {
    const config = this.options.getConfig();
    const configured = new Map((config.orchestration?.mcpServers || []).map((server) => [server.id, server]));
    // 移除：配置中不存在或 enabled=false。
    for (const serverId of [...this.servers.keys()]) {
      const entry = configured.get(serverId);
      if (!entry || entry.enabled === false) this.disconnect(serverId);
    }
    const tasks: Promise<void>[] = [];
    for (const [serverId, server] of configured) {
      if (server.enabled === false) continue;
      const managed = this.servers.get(serverId);
      const summary = mcpServerConfigSummary(server);
      if (!managed) {
        tasks.push(this.connect(server));
      } else if (managed.summary !== summary) {
        // 变更：先断开再重连（窗口期调用按 mcp_server_unavailable 失败）。
        this.disconnect(serverId);
        tasks.push(this.connect(server));
      } else {
        // 连接参数未变：capabilityOverrides 变化 → 本地重建树并热替换根能力（免重连，走查实测发现）。
        const overridesSummary = this.overridesSummaryFor(serverId);
        if (managed.overridesSummary !== overridesSummary) {
          managed.config = server;
          managed.children = this.buildChildren(serverId, managed.tools, server.allowlist);
          managed.overridesSummary = overridesSummary;
          if (managed.client) {
            this.registerRoot(managed);
            this.writeStatusFile();
            this.logger?.info('MCP 覆盖变更，树已热替换', { server: serverId, enabledToolCount: managed.status.enabledToolCount });
          }
        }
      }
    }
    await Promise.all(tasks);
  }

  /**
   * D3：目录刷新——list_changed 标记 stale 或 TTL 到期时重拉。
   * 重拉后 diff：新子项默认不进树（D6：不在 allowlist 即排除；在 allowlist 的新子项进树并保持
   * capabilityOverrides 控制的启用态）；根能力经同 id 覆盖热替换（description 子项数随之更新）。
   */
  async refreshTools(serverId: string): Promise<boolean> {
    const managed = this.servers.get(serverId);
    if (!managed || !managed.client) return false;
    const ttl = Number(managed.config.toolsCacheTtlMs);
    const ttlExpired = Number.isFinite(ttl) && ttl > 0
      ? this.now() - Date.parse(managed.status.fetchedAt || '') > ttl
      : false;
    if (!managed.cacheStale && !ttlExpired) return false;
    try {
      const tools = await managed.client.listTools();
      managed.children = this.buildChildren(serverId, tools, managed.config.allowlist);
      managed.cacheStale = false;
      managed.status.fetchedAt = new Date(this.now()).toISOString();
      this.registerRoot(managed); // 同 id 覆盖 = 热替换（含 description 子项数更新）
      this.writeStatusFile();
      this.logger?.info('MCP 工具目录已刷新', { server: serverId, inTree: managed.children.length });
      return true;
    } catch (error) {
      const message = String((error as Error)?.message || error);
      const needsAuth = message.includes('mcp_http_401') || message.includes('mcp_oauth_token_failed:invalid_grant');
      this.setState(managed, needsAuth ? 'needs-auth' : managed.status.state === 'connected' ? 'connected' : 'disconnected', message);
      this.logger?.warn('MCP 工具目录刷新失败', { server: serverId, error: message });
      return false;
    }
  }

  /** 全量巡检：对 stale/TTL 过期的服务器刷新目录（周期调用入口）。 */
  async refreshStale(): Promise<void> {
    for (const serverId of [...this.servers.keys()]) {
      await this.refreshTools(serverId);
    }
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((managed) => ({ ...managed.status }));
  }

  statusOf(serverId: string): McpServerStatus | undefined {
    const managed = this.servers.get(serverId);
    return managed ? { ...managed.status } : undefined;
  }

  /** D19：检索索引数据（根 id + 子项名 + 摘要），供 capability.catalog 关键字匹配扩展消费（接线在 start.ts）。 */
  searchIndex(): Array<{ serverId: string; rootId: string; childName: string; displayName?: string; summary: string }> {
    const entries: Array<{ serverId: string; rootId: string; childName: string; displayName?: string; summary: string }> = [];
    for (const managed of this.servers.values()) {
      for (const child of managed.children) {
        entries.push({
          serverId: managed.config.id,
          rootId: this.rootId(managed.config.id),
          childName: child.name,
          ...(child.displayName ? { displayName: child.displayName } : {}),
          summary: child.summary,
        });
      }
    }
    return entries;
  }

  async close(): Promise<void> {
    for (const serverId of [...this.servers.keys()]) this.disconnect(serverId);
  }

  /**
   * Phase 3：即时热重载通道——watch config.json（面板保存）与 trigger 文件（OAuth 完成/断开/重连）。
   * 面板与 bot 是双进程，无法进程内调用；文件事件（debounce 500ms）→ reload()（幂等 diff）。
   * 返回关闭句柄。
   */
  watchDataFiles(options: { configPath?: string; triggerPath?: string } = {}): () => void {
    const watchers: Array<{ close: () => void }> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = (source: string): void => {
      this.logger?.info('mcp 触发热重载', { source });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void this.reload().catch((error) => this.logger?.warn('mcp 热重载失败', { source, error: String((error as Error)?.message || error) }));
      }, 500);
    };
    const watchFile = (filePath: string | undefined, source: string): void => {
      if (!filePath) return;
      try {
        // 目录级 watch + 文件名过滤：兼容原子写（tmp+rename）导致的 watch 句柄失效。
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const watcher = fs.watch(dir, (_event, filename) => {
          if (typeof filename === 'string' && filename === base) scheduleReload(source);
        });
        watchers.push(watcher);
      } catch (error) {
        this.logger?.warn('mcp watch 启动失败（回退 30s 巡检）', { filePath, error: String((error as Error)?.message || error) });
      }
    };
    watchFile(options.configPath, 'config');
    watchFile(options.triggerPath, 'trigger');
    return () => {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }
}
