import { normalizeError } from '../../core/src/index.js';
import type { StructuredLogger } from '../../logger/src/index.js';
import type { PackageDescriptor, SerializableError } from '@miobot-v2/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocket as WsWebSocket } from 'ws';

export const NAPCAT_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/napcat',
  phase: 'P6-napcat-adapter',
};

export const NAPCAT_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type NapcatSocketEvent = 'open' | 'message' | 'error' | 'close';
export type NapcatEventHandler<T = unknown> = (data: T) => void | Promise<void>;

export interface NapcatSocketLike {
  readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: NapcatSocketEvent, handler: (...args: any[]) => void): void;
  removeAllListeners?(): void;
}

export type NapcatSocketFactory = (url: string, options: { headers?: Record<string, string> }) => NapcatSocketLike;

export interface NapcatAdapterOptions {
  wsUrl: string;
  token?: string;
  actionTimeoutMs?: number;
  textSendTimeoutMs?: number;
  imageSendTimeoutMs?: number;
  forwardSendTimeoutMs?: number;
  getMessageTimeoutMs?: number;
  reconnectDelayMs?: number;
  autoReconnect?: boolean;
  socketFactory?: NapcatSocketFactory;
  logger?: StructuredLogger;
  requestIdFactory?: (action: string) => string;
  forwardUserId?: number | string;
}

export interface NapcatConnectionSnapshot {
  wsUrl: string;
  connected: boolean;
  readyState: number;
  readyStateText: string;
  selfQqId: string | null;
  lastConnectedAt: string | null;
  pendingActions: number;
  reconnectScheduled: boolean;
}

export interface NapcatActionResponse<T = unknown> {
  status?: string;
  retcode?: number;
  echo?: string;
  data?: T;
  wording?: string;
  message?: string;
  msg?: string;
  [key: string]: unknown;
}

export interface NapcatSendResult {
  success: boolean;
  messageId?: number | string;
  messageIds?: Array<number | string>;
  forwardId?: string;
  forwardIds?: string[];
  response?: NapcatActionResponse;
  error?: string;
  timedOut?: boolean;
  uncertain?: boolean;
}

export interface NapcatMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface NapcatForwardNode {
  type: 'node';
  data: {
    user_id: number | string;
    nickname: string;
    content: string | NapcatMessageSegment[];
  };
}

interface PendingAction {
  action: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (data: NapcatActionResponse) => void;
  reject: (error: Error) => void;
}

export class NapcatActionError extends Error {
  readonly action: string;
  readonly response?: NapcatActionResponse;
  readonly normalized: SerializableError;

  constructor(action: string, message: string, response?: NapcatActionResponse) {
    super(message);
    this.name = 'NapcatActionError';
    this.action = action;
    this.response = response;
    this.normalized = normalizeError({ name: this.name, message, status: typeof response?.retcode === 'number' ? response.retcode : undefined });
  }
}

export class NapcatAdapter {
  private readonly options: Required<Omit<NapcatAdapterOptions, 'socketFactory' | 'logger' | 'requestIdFactory' | 'token' | 'forwardUserId'>> & Pick<NapcatAdapterOptions, 'token' | 'forwardUserId'>;
  private readonly socketFactory: NapcatSocketFactory;
  private readonly logger?: StructuredLogger;
  private readonly requestIdFactory: (action: string) => string;
  private socket: NapcatSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private readonly pendingActions = new Map<string, PendingAction>();
  private readonly handlers = new Map<string, Set<NapcatEventHandler>>();
  private readonly forwardBridgeTargets = new Map<string, string[]>();
  private forwardBridgeLoaded = false;
  private lastConnectedAt: number | null = null;
  selfQqId = '';

  constructor(options: NapcatAdapterOptions) {
    this.options = {
      wsUrl: options.wsUrl,
      token: options.token,
      actionTimeoutMs: positiveInt(options.actionTimeoutMs, 15000),
      textSendTimeoutMs: positiveInt(options.textSendTimeoutMs, 15000),
      imageSendTimeoutMs: positiveInt(options.imageSendTimeoutMs, 120000),
      forwardSendTimeoutMs: positiveInt(options.forwardSendTimeoutMs, 300000),
      getMessageTimeoutMs: positiveInt(options.getMessageTimeoutMs, 10000),
      reconnectDelayMs: Math.max(0, positiveInt(options.reconnectDelayMs, 5000)),
      autoReconnect: options.autoReconnect !== false,
      forwardUserId: options.forwardUserId,
    };
    this.socketFactory = options.socketFactory || createGlobalWebSocketFactory();
    this.logger = options.logger;
    this.requestIdFactory = options.requestIdFactory || ((action) => `v2_${action}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
  }

  connect(): void {
    this.manualClose = false;
    this.clearReconnectTimer();
    this.logger?.info('napcat connect start', { wsUrl: this.options.wsUrl, hasToken: Boolean(this.options.token) });
    const headers = this.options.token ? { Authorization: `Bearer ${this.options.token}` } : undefined;
    const socket = this.socketFactory(this.options.wsUrl, { headers });
    this.socket = socket;
    socket.on('open', () => this.handleOpen());
    socket.on('message', (raw) => void this.handleRawMessage(raw));
    socket.on('error', (error) => this.handleSocketError(error));
    socket.on('close', (code, reason) => this.handleClose(code, reason));
  }

  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.rejectPendingActions(new Error('Napcat WebSocket disconnected'));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners?.();
      try { socket.close(); } catch (error) { this.logger?.warn('napcat close failed', { error: normalizeError(error) }); }
    }
  }

  reconnect(): void {
    this.logger?.info('napcat reconnect requested');
    this.disconnect();
    this.manualClose = false;
    this.connect();
  }

  on(event: string, handler: NapcatEventHandler): () => void {
    const set = this.handlers.get(event) || new Set<NapcatEventHandler>();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  getConnectionSnapshot(): NapcatConnectionSnapshot {
    const readyState = this.socket?.readyState ?? NAPCAT_READY_STATE.CLOSED;
    return {
      wsUrl: this.options.wsUrl,
      connected: readyState === NAPCAT_READY_STATE.OPEN,
      readyState,
      readyStateText: formatReadyState(readyState),
      selfQqId: this.selfQqId || null,
      lastConnectedAt: this.lastConnectedAt ? new Date(this.lastConnectedAt).toISOString() : null,
      pendingActions: this.pendingActions.size,
      reconnectScheduled: Boolean(this.reconnectTimer),
    };
  }

  async callAction<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = this.options.actionTimeoutMs): Promise<NapcatActionResponse<T>> {
    const response = await this.sendAction<T>(action, params, timeoutMs);
    if (!isActionOk(response)) throw new NapcatActionError(action, formatActionError(action, response), response);
    return response;
  }

  sendAction<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = this.options.actionTimeoutMs): Promise<NapcatActionResponse<T>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== NAPCAT_READY_STATE.OPEN) {
      const state = socket?.readyState ?? NAPCAT_READY_STATE.CLOSED;
      return Promise.reject(new Error(`Napcat WebSocket 未连接，当前状态: ${formatReadyState(state)}`));
    }

    const echo = this.requestIdFactory(action);
    const startedAt = Date.now();
    const resolvedTimeoutMs = positiveInt(timeoutMs, this.options.actionTimeoutMs);
    this.logger?.info('napcat action send', { action, echo, timeoutMs: resolvedTimeoutMs, params });

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        const pending = this.pendingActions.get(echo);
        if (pending) clearTimeout(pending.timeout);
        this.pendingActions.delete(echo);
        return true;
      };

      const timeout = setTimeout(() => {
        if (!cleanup()) return;
        const error = new Error(`Napcat action 超时: ${action} (${resolvedTimeoutMs}ms)`);
        this.logger?.error('napcat action timeout', { action, echo, durationMs: Date.now() - startedAt, timeoutMs: resolvedTimeoutMs });
        reject(error);
      }, resolvedTimeoutMs);

      this.pendingActions.set(echo, {
        action,
        startedAt,
        timeout,
        resolve: (data) => { if (cleanup()) resolve(data as NapcatActionResponse<T>); },
        reject: (error) => { if (cleanup()) reject(error); },
      });

      socket.send(JSON.stringify({ action, params, echo }), (error?: Error) => {
        if (!error) return;
        const pending = this.pendingActions.get(echo);
        this.logger?.error('napcat action write failed', { action, echo, error: normalizeError(error) });
        pending?.reject(error);
      });
    });
  }

  async sendGroupText(groupId: number | string, text: string, replyToMessageId?: number | string): Promise<NapcatSendResult> {
    const message: NapcatMessageSegment[] = [];
    if (replyToMessageId !== undefined) message.push({ type: 'reply', data: { id: String(replyToMessageId) } });
    message.push({ type: 'text', data: { text } });
    return this.sendAndReportResult('send_group_msg', { group_id: groupId, message }, this.options.textSendTimeoutMs);
  }

  async sendPrivateText(userId: number | string, text: string): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }],
    }, this.options.textSendTimeoutMs);
  }

  async sendGroupRecord(groupId: number | string, fileUrl: string, replyToMessageId?: number | string): Promise<NapcatSendResult> {
    const message: NapcatMessageSegment[] = [];
    if (replyToMessageId !== undefined) message.push({ type: 'reply', data: { id: String(replyToMessageId) } });
    message.push({ type: 'record', data: { file: fileUrl } });
    return this.sendAndReportResult('send_group_msg', { group_id: groupId, message }, this.options.imageSendTimeoutMs);
  }

  async sendPrivateRecord(userId: number | string, fileUrl: string): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_private_msg', {
      user_id: userId,
      message: [{ type: 'record', data: { file: fileUrl } }],
    }, this.options.imageSendTimeoutMs);
  }

  async sendGroupTextAt(groupId: number | string, text: string, userId: number | string): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_group_msg', {
      group_id: groupId,
      message: [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text } },
      ],
    }, this.options.textSendTimeoutMs);
  }

  async sendGroupTextForward(groupId: number | string, nodes: Array<{ title?: string; content: string }>, botName = 'Miobot'): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_group_forward_msg', {
      group_id: groupId,
      messages: buildTextForwardNodes(nodes, { botName, userId: this.getForwardUserId() }),
    }, this.options.forwardSendTimeoutMs);
  }

  async sendPrivateTextForward(userId: number | string, nodes: Array<{ title?: string; content: string }>, botName = 'Miobot'): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_private_forward_msg', {
      user_id: userId,
      messages: buildTextForwardNodes(nodes, { botName, userId: this.getForwardUserId() }),
    }, this.options.forwardSendTimeoutMs);
  }

  async sendGroupImage(groupId: number | string, fileUrl: string, summaryText = ''): Promise<NapcatSendResult> {
    const message: NapcatMessageSegment[] = [];
    if (summaryText) message.push({ type: 'text', data: { text: `${summaryText}\r\n` } });
    message.push({ type: 'image', data: { file: fileUrl } });
    return this.sendAndReportResult('send_group_msg', { group_id: groupId, message }, this.options.imageSendTimeoutMs);
  }

  async sendPrivateImage(userId: number | string, fileUrl: string): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_private_msg', {
      user_id: userId,
      message: [{ type: 'image', data: { file: fileUrl } }],
    }, this.options.imageSendTimeoutMs);
  }

  async sendGroupImageAt(groupId: number | string, fileUrl: string, userId: number | string): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_group_msg', {
      group_id: groupId,
      message: [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'image', data: { file: fileUrl } },
      ],
    }, this.options.imageSendTimeoutMs);
  }

  async sendGroupImageQuote(groupId: number | string, fileUrl: string, messageId: number | string): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_group_msg', {
      group_id: groupId,
      message: [
        { type: 'reply', data: { id: String(messageId) } },
        { type: 'image', data: { file: fileUrl } },
      ],
    }, this.options.imageSendTimeoutMs);
  }

  async sendGroupImageForward(groupId: number | string, fileUrl: string, botName = 'Miobot'): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_group_forward_msg', {
      group_id: groupId,
      messages: buildImageForwardNodes([fileUrl], { botName, userId: this.getForwardUserId() }),
    }, this.options.forwardSendTimeoutMs);
  }

  async sendGroupImagesForward(groupId: number | string, fileUrls: string[], botName = 'Miobot'): Promise<NapcatSendResult> {
    const cleanUrls = dedupeImageUrls(fileUrls);
    if (!cleanUrls.length) return { success: false, error: 'no images to send' };
    const messages = buildImageForwardNodes(cleanUrls, { botName, userId: this.getForwardUserId() });
    return this.sendAndReportResult('send_group_forward_msg', { group_id: groupId, messages }, this.options.forwardSendTimeoutMs);
  }

  async deleteMessage(messageId: number | string, timeoutMs = this.options.actionTimeoutMs): Promise<boolean> {
    const result = await this.sendAndReportResult('delete_msg', { message_id: normalizeMessageId(messageId) }, timeoutMs);
    return result.success;
  }

  async getMessage(messageId: number | string, timeoutMs = this.options.getMessageTimeoutMs): Promise<unknown> {
    const response = await this.callAction('get_msg', { message_id: normalizeMessageId(messageId) }, timeoutMs);
    return response.data ?? response;
  }

  async getForwardMessage(forwardId: number | string, timeoutMs = Math.max(this.options.getMessageTimeoutMs, 30000)): Promise<unknown> {
    const response = await this.callAction('get_forward_msg', { id: String(forwardId) }, timeoutMs);
    return response.data ?? response;
  }

  getForwardBridgeTargets(forwardId: number | string): string[] {
    this.loadForwardBridgeStore();
    const id = String(forwardId || '').trim();
    if (!id) return [];
    return [...(this.forwardBridgeTargets.get(id) || [])];
  }

  private async sendAndReportResult(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<NapcatSendResult> {
    try {
      const response = await this.callAction(action, params, timeoutMs);
      const messageId = response.data && typeof response.data === 'object' ? (response.data as any).message_id ?? (response.data as any).messageId : undefined;
      const forwardId = extractForwardIdFromResponse(response);
      return {
        success: true,
        messageId,
        messageIds: messageId !== undefined ? [messageId] : [],
        forwardId,
        forwardIds: forwardId ? [forwardId] : [],
        response,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error('napcat send failed', { action, error: normalizeError(error) });
      return { success: false, error: message, timedOut: /超时|timeout|timed out/i.test(message) };
    }
  }

  private handleOpen(): void {
    this.lastConnectedAt = Date.now();
    this.logger?.info('napcat connected', this.getConnectionSnapshot());
    void this.emit('open', this.getConnectionSnapshot());
  }

  private async handleRawMessage(raw: unknown): Promise<void> {
    let data: any;
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      data = JSON.parse(text);
    } catch (error) {
      this.logger?.error('napcat message parse failed', { error: normalizeError(error), rawPreview: String(raw).slice(0, 500) });
      return;
    }

    if (data?.self_id && !this.selfQqId) this.selfQqId = String(data.self_id);
    this.resolveActionResponse(data);
    if (data?.post_type) {
      await this.emit(data.post_type, data);
      if (data.post_type === 'message' && data.message_type) await this.emit(`message.${data.message_type}`, data);
    }
  }

  private handleSocketError(error: unknown): void {
    this.logger?.error('napcat socket error', { error: normalizeError(error) });
    this.rejectPendingActions(error instanceof Error ? error : new Error(String(error)));
    void this.emit('error', error);
  }

  private loadForwardBridgeStore(): void {
    if (this.forwardBridgeLoaded) return;
    this.forwardBridgeLoaded = true;
    const storePath = path.resolve(process.cwd(), 'output', 'forward-bridges.json');
    try {
      if (!fs.existsSync(storePath)) return;
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8') || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [key, value] of Object.entries(parsed)) {
        if (!Array.isArray(value)) continue;
        const targets = value.map((item) => String(item || '').trim()).filter(Boolean);
        if (key && targets.length) this.forwardBridgeTargets.set(String(key), Array.from(new Set(targets)));
      }
      this.logger?.info('napcat forward bridge store loaded', { path: storePath, entries: this.forwardBridgeTargets.size });
    } catch (error) {
      this.logger?.warn('napcat forward bridge store load failed', { path: storePath, error: normalizeError(error) });
    }
  }

  private handleClose(code?: number, reason?: unknown): void {
    this.logger?.warn('napcat closed', { code, reason: reasonToString(reason), pendingActions: this.pendingActions.size });
    this.rejectPendingActions(new Error('Napcat WebSocket closed'));
    this.socket = null;
    void this.emit('close', { code, reason: reasonToString(reason) });
    if (!this.manualClose && this.options.autoReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try { this.connect(); }
      catch (error) {
        this.logger?.error('napcat reconnect failed', { error: normalizeError(error) });
        if (!this.manualClose && this.options.autoReconnect) this.scheduleReconnect();
      }
    }, this.options.reconnectDelayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resolveActionResponse(data: NapcatActionResponse): void {
    const echo = typeof data?.echo === 'string' ? data.echo : '';
    if (!echo) return;
    const pending = this.pendingActions.get(echo);
    if (!pending) return;
    this.logger?.info('napcat action response', { action: pending.action, echo, durationMs: Date.now() - pending.startedAt, retcode: data.retcode, status: data.status });
    pending.resolve(data);
  }

  private rejectPendingActions(error: Error): void {
    for (const pending of this.pendingActions.values()) pending.reject(error);
    this.pendingActions.clear();
  }

  private async emit(event: string, data: unknown): Promise<void> {
    const handlers = [...(this.handlers.get(event) || [])];
    for (const handler of handlers) {
      try { await handler(data); }
      catch (error) { this.logger?.error('napcat event handler failed', { event, error: normalizeError(error) }); }
    }
  }

  private getForwardUserId(): number | string {
    if (this.options.forwardUserId !== undefined) return this.options.forwardUserId;
    const numeric = Number(this.selfQqId);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : (this.selfQqId || 0);
  }
}

export function buildImageForwardNodes(fileUrls: string[], options: { botName?: string; userId?: number | string } = {}): NapcatForwardNode[] {
  const cleanUrls = dedupeImageUrls(fileUrls);
  const botName = options.botName || 'Miobot';
  const userId = options.userId ?? 0;
  return cleanUrls.map((fileUrl, idx) => ({
    type: 'node',
    data: {
      user_id: userId,
      nickname: `${botName} ${idx + 1}/${cleanUrls.length}`,
      content: [{ type: 'image', data: { file: fileUrl } }],
    },
  }));
}

export function buildTextForwardNodes(nodes: Array<{ title?: string; content: string }>, options: { botName?: string; userId?: number | string } = {}): NapcatForwardNode[] {
  const botName = options.botName || 'Miobot';
  const userId = options.userId ?? 0;
  return nodes
    .map((node, idx) => ({
      type: 'node' as const,
      data: {
        user_id: userId,
        nickname: node.title || `${botName} #${idx + 1}`,
        content: [{ type: 'text', data: { text: String(node.content ?? '') } }],
      },
    }))
    .filter((node) => String((node.data.content as NapcatMessageSegment[])[0]?.data?.text ?? '').length > 0);
}

export function dedupeImageUrls(fileUrls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of fileUrls) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function isActionOk(data: NapcatActionResponse): boolean {
  return data?.status === 'ok' || data?.retcode === 0;
}

export function formatActionError(action: string, data: NapcatActionResponse): string {
  const retcode = data?.retcode ?? 'unknown';
  const detail = data?.wording || data?.message || data?.msg || JSON.stringify(data);
  return `${action} 返回失败: retcode=${retcode}, ${detail}`;
}

export function extractForwardIdFromResponse(response: NapcatActionResponse): string | undefined {
  const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
  const id = data.forward_id ?? data.forwardId ?? data.res_id ?? data.resid ?? data.id;
  const value = id === undefined || id === null ? '' : String(id).trim();
  return value || undefined;
}

export function createGlobalWebSocketFactory(): NapcatSocketFactory {
  return (url, options) => {
    const ws = new WsWebSocket(url, options?.headers ? { headers: options.headers } : undefined);
    return adaptEventTargetWebSocket(ws);
  };
}

export function adaptEventTargetWebSocket(ws: any): NapcatSocketLike {
  const listeners: Array<{ event: string; handler: (...args: any[]) => void; wrapped: (...args: any[]) => void }> = [];
  return {
    get readyState() { return ws.readyState; },
    send(data: string, callback?: (error?: Error) => void) {
      try { ws.send(data); callback?.(); }
      catch (error) { callback?.(error instanceof Error ? error : new Error(String(error))); }
    },
    close(code?: number, reason?: string) { ws.close(code, reason); },
    on(event: NapcatSocketEvent, handler: (...args: any[]) => void) {
      if (typeof ws.on === 'function') { ws.on(event, handler); listeners.push({ event, handler, wrapped: handler }); return; }
      const wrapped = (ev: any) => {
        if (event === 'message') handler(ev?.data ?? ev);
        else if (event === 'error') handler(ev?.error ?? ev);
        else if (event === 'close') handler(ev?.code, ev?.reason);
        else handler(ev);
      };
      ws.addEventListener(event, wrapped);
      listeners.push({ event, handler, wrapped });
    },
    removeAllListeners() {
      if (typeof ws.removeAllListeners === 'function') { ws.removeAllListeners(); return; }
      for (const item of listeners) ws.removeEventListener?.(item.event, item.wrapped);
      listeners.length = 0;
    },
  };
}

export function formatReadyState(state: number): string {
  switch (state) {
    case NAPCAT_READY_STATE.CONNECTING: return 'CONNECTING';
    case NAPCAT_READY_STATE.OPEN: return 'OPEN';
    case NAPCAT_READY_STATE.CLOSING: return 'CLOSING';
    case NAPCAT_READY_STATE.CLOSED: return 'CLOSED';
    default: return `UNKNOWN(${state})`;
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeMessageId(messageId: number | string): number | string {
  const numeric = Number(messageId);
  return Number.isFinite(numeric) && String(messageId).trim() !== '' ? numeric : String(messageId);
}

function reasonToString(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (Buffer.isBuffer(reason)) return reason.toString('utf8');
  return reason === undefined || reason === null ? '' : String(reason);
}
