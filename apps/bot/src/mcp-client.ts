import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CapabilityDescriptor, CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/**
 * T4.1 MCP client——最小 JSON-RPC 2.0 实现（stdio 行分隔 / HTTP POST 双传输）。
 * 启动时 initialize + tools/list，把工具转为能力 descriptor 注册进编排器；
 * 执行时 tools/call。不引 SDK：协议面只需要 initialize/list/call 三个方法。
 */

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  token?: string;
  allowlist?: string[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
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

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: { timeoutMs?: number; logger?: StructuredLogger; fetchImpl?: typeof fetch } = {},
  ) {}

  private get timeoutMs(): number {
    return Math.max(5000, Number(this.options.timeoutMs) || 20000);
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<any> {
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
        this.ensureChild();
        this.child!.stdin.write(JSON.stringify(message) + '\n');
      } else {
        void this.postHttp(message, id);
      }
    });
  }

  private ensureChild(): void {
    if (this.child) return;
    if (!this.config.command) throw new Error('mcp_stdio_command_missing');
    this.child = spawn(this.config.command, this.config.args || [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.options.logger?.warn('mcp server stderr', { server: this.config.id, stderr: chunk.slice(0, 300) });
    });
    this.child.on('exit', (code) => {
      this.child = null;
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
    if (typeof message?.id !== 'number') return; // notification / server request 一律忽略（最小客户端）
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`mcp_error:${String(message.error.message || message.error.code)}`));
    else pending.resolve(message.result);
  }

  private async postHttp(message: Record<string, unknown>, id: number): Promise<void> {
    const pending = this.pending.get(id)!;
    try {
      const fetchImpl = this.options.fetchImpl || fetch;
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
      const response = await fetchImpl(String(this.config.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
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
        const fetchImpl = this.options.fetchImpl || fetch;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
        void await fetchImpl(String(this.config.url), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      } catch { /* notification 失败可容忍 */ }
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request('tools/list');
    return (Array.isArray(result?.tools) ? result.tools : []) as McpToolInfo[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }> {
    const result = await this.request('tools/call', { name, arguments: args || {} });
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: Boolean(result?.isError),
    };
  }

  close(): void {
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
