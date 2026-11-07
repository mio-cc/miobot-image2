import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CapabilityDescriptor, CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/**
 * T4.1 MCP client——最小 JSON-RPC 2.0 实现（stdio 行分隔 / HTTP POST 双传输）。
 * 启动时 initialize + tools/list，把工具转为能力 descriptor 注册进编排器；
 * 执行时 tools/call。不引 SDK：协议面只需要 initialize/list/call 三个方法。
 *
 * Phase 1（传输层硬化，方案 §4.2）：
 * - Mcp-Session-Id 会话保持：initialize 响应头捕获，后续请求自动回带；
 *   404（会话失效）自动重开新会话并重放一次（防循环）。
 * - tools/list 游标分页：循环取页直至无 nextCursor。
 * - 服务器通知（notifications/*，含 tools/list_changed）：stdio 走 stdout 消息，
 *   HTTP 走 listen() 的 GET SSE 流，统一交给 onNotification 回调。
 * - stdio 崩溃自愈：exit 后按 reconnect 策略（次数上限 + 间隔）在下次请求时拉起。
 * - structuredContent 透传：callTool 结果携带服务器结构化输出。
 * - proxyUrl（本地调试可选项）：默认不填即直连；填写时经 undici ProxyAgent 走 HTTP 代理
 *   （需环境自装 undici，生产部署不要求配置）。
 */

/** MCP 参数默认值规则（2026-11-07 拍板）：value 为默认值；locked=true 时无论模型传什么都以此为准。 */
export interface McpParamDefaultRule {
  value: string | number | boolean;
  locked?: boolean;
}

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  token?: string;
  allowlist?: string[];
  /** 鉴权模式：'static'（默认，token 字段）| 'oauth'（Phase 3 OAuth 流程）。 */
  auth?: 'static' | 'oauth';
  /** 本地调试可选项：HTTP 代理地址（http://…）。默认不填即直连；生产部署不要求配置。 */
  proxyUrl?: string;
  /** 工具目录缓存 TTL 兜底（ms；0 = 禁用 TTL，仅 list_changed 通知失效）。 */
  toolsCacheTtlMs?: number;
  /** stdio 崩溃自愈策略（D2）：重启次数上限与最小间隔。 */
  reconnect?: { maxAttempts?: number; delayMs?: number };
  /** 参数默认值（根级）：作用于该服务器全部子项的指定参数。子项级同键整条覆盖（含锁定标志）。 */
  paramDefaults?: Record<string, McpParamDefaultRule>;
  /** 参数默认值（子项级）：键=子项工具名。 */
  childParamDefaults?: Record<string, Record<string, McpParamDefaultRule>>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** MCP 工具 annotations（readOnlyHint/destructiveHint 等；服务器自述，仅作初筛，D8）。 */
  annotations?: Record<string, unknown>;
}

/** Phase 1：服务器通知（如 notifications/tools/list_changed）的回调。 */
export type McpNotificationHandler = (method: string, params?: Record<string, unknown>) => void;

export interface McpClientOptions {
  timeoutMs?: number;
  logger?: StructuredLogger;
  fetchImpl?: typeof fetch;
  /** 本地调试可选项：HTTP 代理地址（http://…）。默认不填即直连；填写需环境装有 undici（动态加载）。 */
  proxyUrl?: string;
  /** stdio 崩溃自愈策略：重启次数上限与最小间隔（成功响应后计数清零）。 */
  reconnect?: { maxAttempts?: number; delayMs?: number };
  /** 服务器通知回调（stdio 响应内嵌通知与 HTTP GET 流通知都进这里）。 */
  onNotification?: McpNotificationHandler;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  /** Phase 1：streamable HTTP 会话 id（initialize 响应头捕获，后续请求回带）。 */
  private sessionId: string | null = null;
  /** Phase 1：stdio 自愈计数（自上次成功响应以来的 exit 次数）。 */
  private restartCount = 0;
  private lastExitAt = 0;
  private proxyFetch: typeof fetch | null = null;
  private notificationStream: AbortController | null = null;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: McpClientOptions = {},
  ) {}

  private get timeoutMs(): number {
    return Math.max(5000, Number(this.options.timeoutMs) || 20000);
  }

  private get reconnect(): { maxAttempts: number; delayMs: number } {
    return {
      maxAttempts: Math.max(1, Math.trunc(Number(this.options.reconnect?.maxAttempts)) || 3),
      delayMs: Math.max(0, Number(this.options.reconnect?.delayMs) || 1000),
    };
  }

  /** Phase 1：HTTP 请求实际使用的 fetch（proxyUrl 未配置时为全局 fetch / 注入实现）。 */
  private async httpFetch(): Promise<typeof fetch> {
    if (this.options.fetchImpl) return this.options.fetchImpl;
    if (!this.options.proxyUrl) return fetch;
    if (this.proxyFetch) return this.proxyFetch;
    const proxyUrl = String(this.options.proxyUrl);
    if (!/^https?:\/\//i.test(proxyUrl)) {
      throw new Error('mcp_proxy_invalid:仅支持 http(s):// 代理地址（SOCKS 代理请使用代理软件的 HTTP 端口）');
    }
    try {
      const moduleName = 'undici' as string;
      const undici = (await import(moduleName)) as any;
      const agent = new undici.ProxyAgent(proxyUrl);
      this.proxyFetch = ((url: any, init: any = {}) => undici.fetch(url, { ...init, dispatcher: agent })) as typeof fetch;
      return this.proxyFetch;
    } catch {
      throw new Error('mcp_proxy_requires_undici:启用代理需在环境内安装 undici 依赖（本地调试可选项，生产默认直连）');
    }
  }

  private async request(method: string, params?: Record<string, unknown>, replayed = false): Promise<any> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp_${method}_timeout`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      if (this.config.transport === 'stdio') {
        void this.postStdio(message, id);
      } else {
        void this.postHttp(message, id, replayed);
      }
    });
  }

  /** Phase 1：404（会话失效）→ 丢弃 session、重新 initialize、重放原请求（仅一次防循环）。 */
  private async requestWithSessionRecovery(method: string, params?: Record<string, unknown>): Promise<any> {
    try {
      return await this.request(method, params);
    } catch (error) {
      const message = String((error as Error)?.message || error);
      if (message === 'mcp_http_404' && this.config.transport === 'http' && this.sessionId) {
        this.options.logger?.info('mcp 会话失效，自动重开会话并重放', { server: this.config.id, method });
        this.sessionId = null;
        await this.initialize();
        return this.request(method, params, true);
      }
      throw error;
    }
  }

  private async postStdio(message: Record<string, unknown>, id: number): Promise<void> {
    const pending = this.pending.get(id)!;
    try {
      const { delayMs } = this.reconnect;
      if (this.lastExitAt && delayMs > 0) {
        const wait = delayMs - (Date.now() - this.lastExitAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.ensureChild();
      this.child!.stdin.write(JSON.stringify(message) + '\n');
    } catch (error) {
      this.pending.delete(id);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private ensureChild(): void {
    if (this.child) return;
    if (!this.config.command) throw new Error('mcp_stdio_command_missing');
    const { maxAttempts } = this.reconnect;
    if (this.restartCount >= maxAttempts) {
      throw new Error(`mcp_stdio_restart_exhausted:${this.restartCount}`);
    }
    this.child = spawn(this.config.command, this.config.args || [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.options.logger?.warn('mcp server stderr', { server: this.config.id, stderr: chunk.slice(0, 300) });
    });
    this.child.on('exit', (code) => {
      this.child = null;
      this.restartCount += 1;
      this.lastExitAt = Date.now();
      this.options.logger?.warn('mcp stdio server 退出，下次请求按策略拉起', { server: this.config.id, code, restartCount: this.restartCount });
      for (const pending of this.pending.values()) pending.reject(new Error(`mcp_server_exit_${code}`));
      this.pending.clear();
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.dispatchMessage(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  private dispatchMessage(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { return; /* 非 JSON 行忽略 */ }
    // Phase 1：服务器通知（无 id 有 method）交给回调；服务器→客户端的请求类消息仍忽略（最小客户端）。
    if (message?.id === undefined || message?.id === null) {
      if (typeof message?.method === 'string' && message.method) {
        this.options.onNotification?.(message.method, message.params);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`mcp_error:${String(message.error.message || message.error.code)}`));
    else {
      // 成功响应 = 传输链路健康：stdio 自愈计数清零。
      this.restartCount = 0;
      pending.resolve(message.result);
    }
  }

  private async postHttp(message: Record<string, unknown>, id: number, replayed: boolean): Promise<void> {
    const pending = this.pending.get(id)!;
    try {
      const fetchImpl = await this.httpFetch();
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const response = await fetchImpl(String(this.config.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Phase 1：捕获会话 id（规范为 initialize 响应头；任意响应携带则更新）。
      const sessionHeader = (response.headers as any)?.get?.('mcp-session-id');
      if (typeof sessionHeader === 'string' && sessionHeader) this.sessionId = sessionHeader;
      const text = await response.text();
      if (response.status === 404 && !replayed) {
        // 会话失效：上抛给 requestWithSessionRecovery 自愈（重 initialize + 重放一次）。
        throw new Error('mcp_http_404');
      }
      if (!response.ok) throw new Error(`mcp_http_${response.status}`);
      // streamable http 可能回 JSON 或 SSE（data: 行）；两种都解析出首个 JSON 对象。
      const parsed = this.parseResponsePayload(text);
      if (parsed?.error) throw new Error(`mcp_error:${String(parsed.error.message || parsed.error.code)}`);
      pending.resolve(parsed?.result);
    } catch (error) {
      this.pending.delete(id);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private parseResponsePayload(text: string): any {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed); } catch { return null; }
    }
    for (const line of trimmed.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { return JSON.parse(payload); } catch { /* 下一行 */ }
    }
    return null;
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'miobot', version: '2' },
    });
    if (this.config.transport === 'stdio' && this.child) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    } else if (this.config.transport === 'http') {
      try {
        const fetchImpl = await this.httpFetch();
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        void await fetchImpl(String(this.config.url), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      } catch { /* notification 失败可容忍 */ }
    }
  }

  /** Phase 1：游标分页拉全工具清单（循环直至无 nextCursor，方案 D4）。 */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.requestWithSessionRecovery('tools/list', cursor ? { cursor } : undefined);
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<Record<string, unknown>>; isError?: boolean; structuredContent?: Record<string, unknown> }> {
    const result = await this.requestWithSessionRecovery('tools/call', { name, arguments: args || {} });
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: Boolean(result?.isError),
      ...(result?.structuredContent && typeof result.structuredContent === 'object'
        ? { structuredContent: result.structuredContent as Record<string, unknown> }
        : {}),
    };
  }

  /**
   * Phase 1：订阅服务器通知流（streamable HTTP 的 GET SSE 通道）。
   * 收到的 data: 事件按 JSON 解析后交给 options.onNotification；返回关闭句柄。
   */
  async listen(): Promise<() => void> {
    if (this.config.transport !== 'http') throw new Error('mcp_listen_http_only');
    if (this.notificationStream) return () => this.closeNotificationStream();
    const controller = new AbortController();
    this.notificationStream = controller;
    const fetchImpl = await this.httpFetch();
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    void fetchImpl(String(this.config.url), { method: 'GET', headers, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok || !response.body) return;
        const reader = (response.body as any).getReader?.();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (payload) {
                try {
                  const event = JSON.parse(payload);
                  if (typeof event?.method === 'string') this.options.onNotification?.(event.method, event.params);
                } catch { /* 非 JSON data 行忽略 */ }
              }
            }
            index = buffer.indexOf('\n');
          }
        }
      })
      .catch(() => { /* 流断开可容忍：缓存/TTL 失效兜底（方案 D3） */ });
    return () => this.closeNotificationStream();
  }

  private closeNotificationStream(): void {
    this.notificationStream?.abort();
    this.notificationStream = null;
  }

  close(): void {
    this.closeNotificationStream();
    this.child?.kill();
    this.child = null;
    for (const pending of this.pending.values()) pending.reject(new Error('mcp_client_closed'));
    this.pending.clear();
  }
}

/** T4.1：按工具描述推断 effect——检索类 retrieve、生成类 generate、写副作用类 mutate，拿不准 unknown。 */
export function inferEffectFromDescription(description: string): CapabilityDescriptor['effect'] {
  const text = String(description || '').toLowerCase();
  if (/\b(delete|remove|drop)\b|删除|移除/.test(text)) return 'delete';
  if (/\b(read|list|get|query|search|fetch|find)\b|读取|查询|搜索|获取|列表/.test(text)) return 'retrieve';
  if (/\b(create|generate|draw|make|build)\b|生成|创建|绘制/.test(text)) return 'generate';
  if (/\b(convert|transform|translate|edit|update|modify|set|send|post|publish|write)\b|发送|修改|更新|写入|转换|翻译/.test(text)) return 'mutate';
  return 'unknown';
}

/** MCP tool → CapabilityDescriptor：id 形如 mcp.<server>.<tool>，riskLevel 默认 medium，enabled 默认 false（默认全 deny，逐工具在面板开启）。 */
export function mcpToolToDescriptor(serverId: string, tool: McpToolInfo): CapabilityDescriptor {
  const description = String(tool.description || '');
  return {
    id: `mcp.${serverId}.${tool.name}`,
    version: '1.0.0',
    name: String(tool.name),
    description: description || `MCP 工具 ${serverId}/${tool.name}`,
    provider: `mcp:${serverId}`,
    presentationHint: '',
    mode: 'sync',
    riskLevel: 'medium',
    enabled: false,
    mergeable: true,
    outputKinds: ['text'],
    effect: inferEffectFromDescription(description),
    sideEffects: ['external_call'],
    inputSchema: (tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {}, additionalProperties: true }) as CapabilityDescriptor['inputSchema'],
  } as CapabilityDescriptor;
}

/** MCP 工具的编排 handler：tools/call → 文本输出；isError 映射为不可重试失败。 */
export class McpToolCapabilityHandler implements CapabilityHandler {
  constructor(
    private readonly client: McpClient,
    private readonly toolName: string,
  ) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const base = { jobId: invocation.plan.planId, stepId: invocation.step.id };
    try {
      const result = await this.client.callTool(this.toolName, (invocation.step.args || {}) as Record<string, unknown>);
      if (result.isError) {
        return { ...base, status: 'failed', outputs: [], error: 'mcp_tool_error', retryable: false };
      }
      const outputs = result.content
        .filter((item) => String(item?.type) === 'text' && String(item?.text || '').trim())
        .map((item) => ({ kind: 'text' as const, text: String(item.text), priority: 10, mergeable: true }));
      if (!outputs.length) {
        return { ...base, status: 'failed', outputs: [], error: 'mcp_tool_empty_output', retryable: true };
      }
      return { ...base, status: 'success', outputs };
    } catch (error) {
      return { ...base, status: 'failed', outputs: [], error: String((error as Error)?.message || error), retryable: true };
    }
  }
}
