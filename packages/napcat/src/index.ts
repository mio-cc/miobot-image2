import { normalizeError } from '../../core/src/index.js';
import { describeBytes, guardVideoPayload, guardWebSocketPayload, WS_FRAME_SAFE_BYTES } from './media-limits.js';
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
  /** 强制断开（不等握手）；心跳死链看门狗优先使用。 */
  terminate?(): void;
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
  /** 视频发送超时；QQ 短视频上传可能较慢，默认与 file 同级。 */
  videoSendTimeoutMs?: number;
  fileSendTimeoutMs?: number;
  fileSendRetryCount?: number;
  fileSendRetryDelayMs?: number;
  forwardSendTimeoutMs?: number;
  getMessageTimeoutMs?: number;
  reconnectDelayMs?: number;
  /** T2.1：指数退避上限（默认 30s）。 */
  reconnectMaxDelayMs?: number;
  /** T2.1：心跳死链阈值（默认 150s，0=关闭）。 */
  heartbeatStaleMs?: number;
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
  attempts?: Array<{ attempt: number; success: boolean; error?: string; timedOut?: boolean }>;
  /** 因体积超限被发送前拦下（未真正发出）。 */
  oversized?: boolean;
  /** 视频超过 100MB 时的建议：改用文件方式发送。 */
  suggestFileSend?: boolean;
}

export interface NapcatMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface NapcatFilePayload {
  file: string;
  name?: string;
}

export type NapcatMixedForwardItem =
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'image'; file: string; title?: string }
  | { kind: 'video'; file: string; title?: string }
  | { kind: 'file'; file: string; name?: string; title?: string };

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

interface PendingStream {
  action: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  onPacket: (packet: Record<string, any>, wrapper: NapcatActionResponse) => void;
  resolve: (packet: Record<string, any>) => void;
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
  /** T2.1：连续重连失败次数（指数退避），连接成功清零。 */
  private reconnectAttempts = 0;
  /** T2.1：最近一次收到任意 post_type 事件的时间，用于心跳死链检测。 */
  private lastHeartbeatAt = 0;
  private heartbeatWatchdog: ReturnType<typeof setInterval> | null = null;
  private readonly pendingActions = new Map<string, PendingAction>();
  private readonly pendingStreams = new Map<string, PendingStream>();
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
      // QQ 短视频：常见限制为较短时长(约数十秒级)、H.264/MP4、体积不宜过大；超限可能失败或需改发文件。
      videoSendTimeoutMs: positiveInt(options.videoSendTimeoutMs, positiveInt(options.fileSendTimeoutMs, 300000)),
      fileSendTimeoutMs: positiveInt(options.fileSendTimeoutMs, positiveInt(options.forwardSendTimeoutMs, 300000)),
      fileSendRetryCount: Math.max(0, Math.trunc(Number(options.fileSendRetryCount ?? 1) || 0)),
      fileSendRetryDelayMs: Math.max(0, Math.trunc(Number(options.fileSendRetryDelayMs ?? 1200) || 0)),
      forwardSendTimeoutMs: positiveInt(options.forwardSendTimeoutMs, 300000),
      getMessageTimeoutMs: positiveInt(options.getMessageTimeoutMs, 10000),
      reconnectDelayMs: Math.max(0, positiveInt(options.reconnectDelayMs, 5000)),
      reconnectMaxDelayMs: Math.max(0, positiveInt(options.reconnectMaxDelayMs, 30000)),
      heartbeatStaleMs: Math.max(0, positiveInt(options.heartbeatStaleMs, 150000)),
      autoReconnect: options.autoReconnect !== false,
      forwardUserId: options.forwardUserId,
    };
    this.socketFactory = options.socketFactory || createGlobalWebSocketFactory();
    this.logger = options.logger;
    this.requestIdFactory = options.requestIdFactory || ((action) => `v2_${action}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
  }

  /**
   * 把面板上改过的 napcat 配置推给已经在跑的适配器。
   *
   * 这些选项以前在构造时冻死：用户改了「图片上传超时」或「文件发送重试次数」，
   * 面板提示「已热重载生效」，可 bot 进程里的适配器还拿着开机时的值——
   * 表现是「按我配的超时应该够，怎么还是超时失败」。
   *
   * wsUrl / token 不能就地改：连接就是照着它们建立的。这里只更新字段并把
   * reconnectRequired 报给调用方，由调用方挑时机断开重连——在这里直接重连
   * 会打断正在进行的发送。
   */
  applyOptions(patch: Partial<NapcatAdapterOptions>): { reconnectRequired: boolean } {
    const numeric: Array<[string, number]> = [
      ['actionTimeoutMs', 15000],
      ['textSendTimeoutMs', 15000],
      ['imageSendTimeoutMs', 120000],
      ['forwardSendTimeoutMs', 300000],
      ['getMessageTimeoutMs', 10000],
    ];
    const raw = patch as Record<string, any>;
    for (const [key, fallback] of numeric) {
      if (raw[key] === undefined) continue;
      (this.options as Record<string, any>)[key] = positiveInt(raw[key], fallback);
    }
    // file/video 的默认值互相依赖，单独算——别让「只改了 file」把 video 的回退链弄断。
    if (patch.fileSendTimeoutMs !== undefined) {
      this.options.fileSendTimeoutMs = positiveInt(patch.fileSendTimeoutMs, positiveInt(patch.forwardSendTimeoutMs, 300000));
    }
    if (patch.videoSendTimeoutMs !== undefined || patch.fileSendTimeoutMs !== undefined) {
      this.options.videoSendTimeoutMs = positiveInt(patch.videoSendTimeoutMs, this.options.fileSendTimeoutMs);
    }
    if (patch.fileSendRetryCount !== undefined) {
      this.options.fileSendRetryCount = Math.max(0, Math.trunc(Number(patch.fileSendRetryCount) || 0));
    }
    if (patch.fileSendRetryDelayMs !== undefined) {
      this.options.fileSendRetryDelayMs = Math.max(0, Math.trunc(Number(patch.fileSendRetryDelayMs) || 0));
    }

    let reconnectRequired = false;
    const nextUrl = String(patch.wsUrl ?? '').trim();
    if (nextUrl && nextUrl !== this.options.wsUrl) {
      this.options.wsUrl = nextUrl;
      reconnectRequired = true;
    }
    if (patch.token !== undefined) {
      const nextToken = String(patch.token || '') || undefined;
      if (nextToken !== this.options.token) {
        this.options.token = nextToken;
        reconnectRequired = true;
      }
    }
    return { reconnectRequired };
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
    if (this.heartbeatWatchdog) {
      clearInterval(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
    }
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
      pendingActions: this.pendingActions.size + this.pendingStreams.size,
      reconnectScheduled: Boolean(this.reconnectTimer),
    };
  }

  sendStreamAction(
    action: string,
    params: Record<string, unknown> = {},
    onPacket: (packet: Record<string, any>, wrapper: NapcatActionResponse) => void,
    timeoutMs = 10 * 60 * 1000,
  ): Promise<Record<string, any>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== NAPCAT_READY_STATE.OPEN) {
      return Promise.reject(new Error(`Napcat WebSocket 未连接，当前状态 ${formatReadyState(socket?.readyState ?? NAPCAT_READY_STATE.CLOSED)}`));
    }
    const echo = this.requestIdFactory(action);
    const startedAt = Date.now();
    const resolvedTimeoutMs = positiveInt(timeoutMs, 10 * 60 * 1000);
    const payload = JSON.stringify({ action, params, echo });
    const frameBytes = Buffer.byteLength(payload);
    if (frameBytes > WS_FRAME_SAFE_BYTES) return Promise.reject(new Error(`Napcat 流式 action 帧 ${describeBytes(frameBytes)} 超过安全上限`));
    this.logger?.info('napcat stream action send', { action, echo, timeoutMs: resolvedTimeoutMs, params: summarizeLogValue(params) });
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        this.pendingStreams.delete(echo);
        return true;
      };
      const timeout = setTimeout(() => {
        if (!cleanup()) return;
        reject(new Error(`Napcat 流式 action ${action} 超时（${resolvedTimeoutMs}ms）`));
      }, resolvedTimeoutMs);
      timeout.unref?.();
      this.pendingStreams.set(echo, {
        action, startedAt, timeout, onPacket,
        resolve: (packet) => { if (cleanup()) resolve(packet); },
        reject: (error) => { if (cleanup()) reject(error); },
      });
      socket.send(payload, (error?: Error) => {
        if (!error) return;
        const pending = this.pendingStreams.get(echo);
        if (pending) { clearTimeout(pending.timeout); this.pendingStreams.delete(echo); }
        reject(error);
      });
    });
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
    this.logger?.info('napcat action send', { action, echo, timeoutMs: resolvedTimeoutMs, params: summarizeLogValue(params) });

    // 帧级兜底：超过 maxPayload 时 NapCat 会直接断连，bot 表现为莫名其妙掉线重连。
    // 逐个方法的护栏挡不住合并转发这种「单条都不超、加起来就炸」的情况，
    // 只有在真正要发帧的这一刻量一次才靠得住。
    const payload = JSON.stringify({ action, params, echo });
    const frameBytes = Buffer.byteLength(payload);
    if (frameBytes > WS_FRAME_SAFE_BYTES) {
      const message = `Napcat 单帧 ${describeBytes(frameBytes)} 超过安全上限 ${describeBytes(WS_FRAME_SAFE_BYTES)}，已中止发送（继续发会被对端直接断连）。请改用本地文件路径，或拆分成多条发送。`;
      this.logger?.error('napcat frame too large', { action, echo, frameBytes });
      return Promise.reject(new Error(message));
    }

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

      socket.send(payload, (error?: Error) => {
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

  async sendGroupRecord(groupId: number | string, fileUrl: string, _replyToMessageId?: number | string): Promise<NapcatSendResult> {
    const guard = guardWebSocketPayload(fileUrl, '语音');
    if (!guard.ok) return { success: false, error: guard.reason, oversized: true };
    const message: NapcatMessageSegment[] = [{ type: 'record', data: { file: fileUrl } }];
    return this.sendAndReportResult('send_group_msg', { group_id: groupId, message }, this.options.imageSendTimeoutMs);
  }

  async sendPrivateRecord(userId: number | string, fileUrl: string): Promise<NapcatSendResult> {
    return this.sendAndReportResult('send_private_msg', {
      user_id: userId,
      message: [{ type: 'record', data: { file: fileUrl } }],
    }, this.options.imageSendTimeoutMs);
  }

  async sendGroupFile(groupId: number | string, fileUrl: string, fileName?: string): Promise<NapcatSendResult> {
    const segment = buildFileSegment(fileUrl, fileName);
    if (!segment) return { success: false, error: 'no file to send' };
    const guard = guardWebSocketPayload(fileUrl, '文件');
    if (!guard.ok) return { success: false, error: guard.reason, oversized: true };
    return this.sendAndReportResultWithRetry('send_group_msg', {
      group_id: groupId,
      message: [segment],
    }, this.options.fileSendTimeoutMs, 'file');
  }

  async sendPrivateFile(userId: number | string, fileUrl: string, fileName?: string): Promise<NapcatSendResult> {
    const segment = buildFileSegment(fileUrl, fileName);
    if (!segment) return { success: false, error: 'no file to send' };
    return this.sendAndReportResultWithRetry('send_private_msg', {
      user_id: userId,
      message: [segment],
    }, this.options.fileSendTimeoutMs, 'file');
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

  /** 一个外层合并转发，内部包含多个合并转发节点。 */
  async sendGroupNestedTextForward(groupId: number | string, groups: Array<Array<{ title?: string; content: string }>>, botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildNestedTextForwardNodes(groups, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no nested text forward groups to send' };
    return this.sendAndReportResult('send_group_forward_msg', { group_id: groupId, messages }, this.options.forwardSendTimeoutMs);
  }

  async sendPrivateNestedTextForward(userId: number | string, groups: Array<Array<{ title?: string; content: string }>>, botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildNestedTextForwardNodes(groups, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no nested text forward groups to send' };
    return this.sendAndReportResult('send_private_forward_msg', { user_id: userId, messages }, this.options.forwardSendTimeoutMs);
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

  /**
   * 发送群视频（OneBot type:video）。
   * file 支持 http(s) URL、本地路径、base64://、data:video/...;base64,。
   * 注意 QQ 短视频限制：时长/大小/编码(多为 MP4+H.264)；失败时可改用 sendGroupFile。
   */
  async sendGroupVideo(groupId: number | string, fileUrl: string, summaryText = ''): Promise<NapcatSendResult> {
    const segment = buildVideoSegment(fileUrl);
    if (!segment) return { success: false, error: 'no video to send' };
    const guard = guardVideoPayload(fileUrl);
    if (!guard.ok) return { success: false, error: guard.reason, oversized: true, suggestFileSend: guard.suggestFileSend };
    const message: NapcatMessageSegment[] = [];
    if (summaryText) message.push({ type: 'text', data: { text: `${summaryText}\r\n` } });
    message.push(segment);
    return this.sendAndReportResult('send_group_msg', { group_id: groupId, message }, this.options.videoSendTimeoutMs);
  }

  /** 发送私聊视频（OneBot type:video）。file 形态同 sendGroupVideo。 */
  async sendPrivateVideo(userId: number | string, fileUrl: string): Promise<NapcatSendResult> {
    const segment = buildVideoSegment(fileUrl);
    if (!segment) return { success: false, error: 'no video to send' };
    const guard = guardVideoPayload(fileUrl);
    if (!guard.ok) return { success: false, error: guard.reason, oversized: true, suggestFileSend: guard.suggestFileSend };
    return this.sendAndReportResult('send_private_msg', {
      user_id: userId,
      message: [segment],
    }, this.options.videoSendTimeoutMs);
  }

  /** 多视频合并转发（群）。 */
  async sendGroupVideosForward(groupId: number | string, fileUrls: string[], botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildVideoForwardNodes(fileUrls, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no videos to send' };
    return this.sendAndReportResult('send_group_forward_msg', { group_id: groupId, messages }, this.options.forwardSendTimeoutMs);
  }

  /** 多视频合并转发（私聊）。 */
  async sendPrivateVideosForward(userId: number | string, fileUrls: string[], botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildVideoForwardNodes(fileUrls, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no videos to send' };
    return this.sendAndReportResult('send_private_forward_msg', { user_id: userId, messages }, this.options.forwardSendTimeoutMs);
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

  async sendGroupFilesForward(groupId: number | string, files: Array<string | NapcatFilePayload>, botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildFileForwardNodes(files, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no files to send' };
    return this.sendAndReportResultWithRetry('send_group_forward_msg', { group_id: groupId, messages }, this.options.fileSendTimeoutMs, 'file-forward');
  }

  async sendPrivateFilesForward(userId: number | string, files: Array<string | NapcatFilePayload>, botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildFileForwardNodes(files, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no files to send' };
    return this.sendAndReportResultWithRetry('send_private_forward_msg', { user_id: userId, messages }, this.options.fileSendTimeoutMs, 'file-forward');
  }

  async sendGroupMixedForward(groupId: number | string, items: NapcatMixedForwardItem[], botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildMixedForwardNodes(items, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no mixed forward items to send' };
    return this.sendAndReportResultWithRetry('send_group_forward_msg', { group_id: groupId, messages }, this.options.fileSendTimeoutMs, 'mixed-forward');
  }

  async sendGroupNestedMixedForward(groupId: number | string, groups: NapcatMixedForwardItem[][], botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildNestedMixedForwardNodes(groups, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no nested mixed forward groups to send' };
    return this.sendAndReportResult('send_group_forward_msg', { group_id: groupId, messages }, this.options.forwardSendTimeoutMs);
  }

  async sendPrivateNestedMixedForward(userId: number | string, groups: NapcatMixedForwardItem[][], botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildNestedMixedForwardNodes(groups, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no nested mixed forward groups to send' };
    return this.sendAndReportResult('send_private_forward_msg', { user_id: userId, messages }, this.options.forwardSendTimeoutMs);
  }

  async sendPrivateMixedForward(userId: number | string, items: NapcatMixedForwardItem[], botName = 'Miobot'): Promise<NapcatSendResult> {
    const messages = buildMixedForwardNodes(items, { botName, userId: this.getForwardUserId() });
    if (!messages.length) return { success: false, error: 'no mixed forward items to send' };
    return this.sendAndReportResultWithRetry('send_private_forward_msg', { user_id: userId, messages }, this.options.fileSendTimeoutMs, 'mixed-forward');
  }

  async downloadFileStream(options: {
    file?: string;
    fileId?: string;
    outputPath: string;
    chunkSize?: number;
    timeoutMs?: number;
    onProgress?: (progress: { receivedBytes: number; fileSize?: number; progress?: number }) => void;
  }): Promise<{ filePath: string; fileName?: string; fileSize?: number; totalBytes: number }> {
    const output = fs.createWriteStream(options.outputPath);
    let fileName = '';
    let fileSize = 0;
    let totalBytes = 0;
    const finished = new Promise<void>((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });
    try {
      await this.sendStreamAction('download_file_stream', {
        file: options.file || options.fileId || '',
        file_id: options.fileId,
        chunk_size: options.chunkSize || 64 * 1024,
      }, (packet) => {
        if (packet.data_type === 'file_info') {
          fileName = String(packet.file_name || '');
          fileSize = Number(packet.file_size || 0);
        } else if (packet.data_type === 'file_chunk' && packet.data) {
          const chunk = Buffer.from(String(packet.data), 'base64');
          totalBytes += chunk.length;
          output.write(chunk);
          options.onProgress?.({ receivedBytes: totalBytes, fileSize: fileSize || undefined, progress: Number(packet.progress || 0) });
        } else if (packet.data_type === 'file_complete') {
          fileName = fileName || String(packet.file_name || '');
          fileSize = Number(packet.total_bytes || fileSize || totalBytes);
        }
      }, options.timeoutMs || 10 * 60 * 1000);
      output.end();
      await finished;
      if (fileSize > 0 && totalBytes !== fileSize) throw new Error(`流式下载字节数不一致：收到 ${totalBytes}，声明 ${fileSize}`);
      return { filePath: options.outputPath, fileName: fileName || undefined, fileSize: fileSize || totalBytes, totalBytes };
    } catch (error) {
      output.destroy();
      try { fs.unlinkSync(options.outputPath); } catch { /* ignore */ }
      throw error;
    }
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
      const retcode = error instanceof NapcatActionError ? Number(error.response?.retcode) : undefined;
      const uncertain = retcode === 1200 || /NodeIKernelMsgService\/sendMsg|onMsgInfoListUpdate|EventRet/i.test(message);
      const timedOut = /超时|timeout|timed out/i.test(message);
      if (uncertain) {
        this.logger?.warn('napcat send uncertain; message may already be delivered, not retrying', { action, error: normalizeError(error), retcode });
      } else {
        this.logger?.error('napcat send failed', { action, error: normalizeError(error) });
      }
      return { success: false, error: message, timedOut, uncertain };
    }
  }

  private async sendAndReportResultWithRetry(action: string, params: Record<string, unknown>, timeoutMs: number, label = action): Promise<NapcatSendResult> {
    const maxAttempts = Math.max(1, Math.trunc(this.options.fileSendRetryCount || 0) + 1);
    const attempts: Array<{ attempt: number; success: boolean; error?: string; timedOut?: boolean }> = [];
    let last: NapcatSendResult = { success: false, error: `${label} not attempted` };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      last = await this.sendAndReportResult(action, params, timeoutMs);
      attempts.push({ attempt, success: last.success, error: last.error, timedOut: last.timedOut });
      // retcode 1200 是 Napcat 发送回调超时，消息可能已经送达；再发会重复。
      if (last.success || last.uncertain) return { ...last, attempts };
      if (attempt < maxAttempts) await sleep(this.options.fileSendRetryDelayMs);
    }
    return { ...last, attempts };
  }

  private handleOpen(): void {
    this.lastConnectedAt = Date.now();
    // T2.1：连接成功即重置退避计数，并启动心跳死链看门狗。
    this.reconnectAttempts = 0;
    this.lastHeartbeatAt = Date.now();
    this.ensureHeartbeatWatchdog();
    this.logger?.info('napcat connected', this.getConnectionSnapshot());
    void this.emit('open', this.getConnectionSnapshot());
  }

  /**
   * T2.1：心跳死链检测。NapCat 会周期上报 meta_event（heartbeat/lifecycle）；
   * 一旦观察到过心跳，超过 heartbeatStaleMs（默认 150s，0=关闭）没有任何事件，
   * 视为半开连接，主动断开触发重连——不用等 TCP 超时。
   */
  private ensureHeartbeatWatchdog(): void {
    const staleMs = Math.max(0, Number(this.options.heartbeatStaleMs) || 150000);
    if (staleMs <= 0 || this.heartbeatWatchdog) return;
    this.heartbeatWatchdog = setInterval(() => {
      if (this.manualClose || !this.socket) return;
      if (!this.lastHeartbeatAt) return;
      const silentMs = Date.now() - this.lastHeartbeatAt;
      if (silentMs > staleMs) {
        this.logger?.warn('napcat heartbeat stale, forcing reconnect', { silentMs });
        try { if (this.socket.terminate) this.socket.terminate(); else this.socket.close(); } catch { /* 断开不得抛出 */ }
      }
    }, 30000);
    this.heartbeatWatchdog.unref?.();
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
    if (data?.post_type) this.lastHeartbeatAt = Date.now();
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

  /**
   * T2.1：指数退避重连。连续失败按 reconnectDelayMs * 2^attempt 递增（上限 reconnectMaxDelayMs，
   * 默认 30s）加 ±20% 抖动；连接成功（open）后计数清零。避免对端故障/风控期固定 5s 疯狂重连。
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = Math.max(0, Number(this.options.reconnectDelayMs) || 5000);
    const cap = Math.max(base, Number(this.options.reconnectMaxDelayMs) || 30000);
    const backoff = Math.min(cap, base * Math.pow(2, this.reconnectAttempts));
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    this.reconnectAttempts += 1;
    this.logger?.info('napcat reconnect scheduled', { attempt: this.reconnectAttempts, delayMs: Math.round(jitter) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try { this.connect(); }
      catch (error) {
        this.logger?.error('napcat reconnect failed', { error: normalizeError(error) });
        if (!this.manualClose && this.options.autoReconnect) this.scheduleReconnect();
      }
    }, Math.max(0, jitter));
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resolveActionResponse(data: NapcatActionResponse): void {
    const echo = typeof data?.echo === 'string' ? data.echo : '';
    if (!echo) return;
    const stream = this.pendingStreams.get(echo);
    if (stream) {
      const packet = (data?.data && typeof data.data === 'object') ? data.data as Record<string, any> : data as Record<string, any>;
      if (packet?.type === 'stream') {
        try { stream.onPacket(packet, data); } catch (error) { stream.reject(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      if (packet?.type === 'response') {
        clearTimeout(stream.timeout);
        this.pendingStreams.delete(echo);
        this.logger?.info('napcat stream response', { action: stream.action, echo, durationMs: Date.now() - stream.startedAt, status: data.status, retcode: data.retcode });
        stream.resolve(packet);
        return;
      }
      if (packet?.type === 'error' || (typeof data.retcode === 'number' && data.retcode !== 0)) {
        clearTimeout(stream.timeout);
        this.pendingStreams.delete(echo);
        stream.reject(new NapcatActionError(stream.action, formatActionError(stream.action, data), data));
        return;
      }
      stream.onPacket(packet, data);
      return;
    }
    const pending = this.pendingActions.get(echo);
    if (!pending) return;
    this.logger?.info('napcat action response', { action: pending.action, echo, durationMs: Date.now() - pending.startedAt, retcode: data.retcode, status: data.status });
    pending.resolve(data);
  }

  private rejectPendingActions(error: Error): void {
    for (const pending of this.pendingActions.values()) pending.reject(error);
    this.pendingActions.clear();
    for (const pending of this.pendingStreams.values()) pending.reject(error);
    this.pendingStreams.clear();
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

export function buildVideoForwardNodes(fileUrls: string[], options: { botName?: string; userId?: number | string } = {}): NapcatForwardNode[] {
  const cleanUrls = dedupeVideoUrls(fileUrls);
  const botName = options.botName || 'Miobot';
  const userId = options.userId ?? 0;
  return cleanUrls.map((fileUrl, idx) => ({
    type: 'node',
    data: {
      user_id: userId,
      nickname: `${botName} 视频 ${idx + 1}/${cleanUrls.length}`,
      content: [buildVideoSegment(fileUrl)!],
    },
  }));
}

/**
 * 构造 type:video 消息段。
 * 支持 http(s)、file 路径、base64://、data:video/...;base64,。
 * data URL 会规范为 Napcat 更易识别的 base64:// 或原样 file。
 */
export { guardVideoPayload, guardWebSocketPayload, inspectMediaPayload, VIDEO_MAX_BYTES, WS_BASE64_SAFE_BYTES, WS_FRAME_SAFE_BYTES, describeBytes } from './media-limits.js';

export function buildVideoSegment(fileUrl: string): NapcatMessageSegment | undefined {
  const file = normalizeVideoFilePayload(fileUrl);
  if (!file) return undefined;
  return { type: 'video', data: { file } };
}

/** 将 data:video/...;base64,XXX 转为 base64://XXX，便于部分 Napcat 版本识别。 */
export function normalizeVideoFilePayload(fileUrl: string): string {
  const u = String(fileUrl || '').trim();
  if (!u) return '';
  const dataMatch = u.match(/^data:video\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataMatch) return `base64://${dataMatch[1].replace(/\s+/g, '')}`;
  return u;
}

export function dedupeVideoUrls(fileUrls: string[]): string[] {
  return dedupeImageUrls(fileUrls);
}

export function buildNestedTextForwardNodes(groups: Array<Array<{ title?: string; content: string }>>, options: { botName?: string; userId?: number | string } = {}): NapcatForwardNode[] {
  const botName = options.botName || 'Miobot';
  const userId = options.userId ?? 0;
  const cleanGroups = (Array.isArray(groups) ? groups : [])
    .map((group) => (Array.isArray(group) ? group : []).filter((node) => String(node?.content || '').trim()))
    .filter((group) => group.length > 0);
  return cleanGroups.map((group, groupIndex) => ({
    type: 'node' as const,
    data: {
      user_id: userId,
      nickname: `${botName} 合并转发 ${groupIndex + 1}/${cleanGroups.length}`,
      content: group.map((node, nodeIndex) => ({
        type: 'node' as const,
        data: {
          user_id: userId,
          nickname: node.title || `${botName} ${groupIndex + 1}-${nodeIndex + 1}`,
          content: [{ type: 'text', data: { text: String(node.content || '') } }],
        },
      })) as unknown as NapcatMessageSegment[],
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

export function buildFileForwardNodes(files: Array<string | NapcatFilePayload>, options: { botName?: string; userId?: number | string } = {}): NapcatForwardNode[] {
  const cleanFiles = dedupeFilePayloads(files);
  const botName = options.botName || 'Miobot';
  const userId = options.userId ?? 0;
  return cleanFiles.map((item, idx) => ({
    type: 'node',
    data: {
      user_id: userId,
      nickname: `${botName} 文件 ${idx + 1}/${cleanFiles.length}`,
      content: [buildFileSegment(item.file, item.name)!],
    },
  }));
}

export function buildMixedForwardNodes(items: NapcatMixedForwardItem[], options: { botName?: string; userId?: number | string } = {}): NapcatForwardNode[] {
  const botName = options.botName || 'Miobot';
  const userId = options.userId ?? 0;
  const cleanItems = normalizeMixedForwardItems(items);
  return cleanItems.map((item, idx) => {
    const title = item.title || `${botName} ${idx + 1}/${cleanItems.length}`;
    const content = item.kind === 'text'
      ? [{ type: 'text', data: { text: item.text } }]
      : item.kind === 'image'
        ? [{ type: 'image', data: { file: item.file } }]
        : item.kind === 'video'
          ? [buildVideoSegment(item.file)!]
          : [buildFileSegment(item.file, item.name)!];
    return {
      type: 'node',
      data: {
        user_id: userId,
        nickname: title,
        content,
      },
    };
  });
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

export function dedupeFilePayloads(files: Array<string | NapcatFilePayload>): NapcatFilePayload[] {
  const seen = new Set<string>();
  const result: NapcatFilePayload[] = [];
  for (const item of files) {
    const payload = normalizeFilePayload(item);
    if (!payload || seen.has(payload.file)) continue;
    seen.add(payload.file);
    result.push(payload);
  }

  return result;
}

export function normalizeFilePayload(file: string | NapcatFilePayload | undefined | null, name?: string): NapcatFilePayload | undefined {
  const source = typeof file === 'string' ? { file, name } : file;
  const fileValue = String(source?.file || '').trim();
  if (!fileValue) return undefined;
  const fileName = String(source?.name || '').trim();
  return fileName ? { file: fileValue, name: fileName } : { file: fileValue };
}

export function buildFileSegment(file: string, name?: string): NapcatMessageSegment | undefined {
  const payload = normalizeFilePayload(file, name);
  if (!payload) return undefined;
  return { type: 'file', data: payload.name ? { file: payload.file, name: payload.name } : { file: payload.file } };
}

export function normalizeMixedForwardItems(items: NapcatMixedForwardItem[]): NapcatMixedForwardItem[] {
  const output: NapcatMixedForwardItem[] = [];
  const seenImages = new Set<string>();
  const seenVideos = new Set<string>();
  const seenFiles = new Set<string>();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'text') {
      const text = String(item.text || '').trim();
      if (text) output.push({ ...item, text });
      continue;
    }
    if (item.kind === 'image') {
      const file = String(item.file || '').trim();
      if (!file || seenImages.has(file)) continue;
      seenImages.add(file);
      output.push({ ...item, file });
      continue;
    }
    if (item.kind === 'video') {
      const file = normalizeVideoFilePayload(String(item.file || '').trim());
      if (!file || seenVideos.has(file)) continue;
      seenVideos.add(file);
      output.push({ ...item, file });
      continue;
    }
    if (item.kind === 'file') {
      const payload = normalizeFilePayload(item);
      if (!payload || seenFiles.has(payload.file)) continue;
      seenFiles.add(payload.file);
      output.push({ ...item, ...payload });
    }
  }
  return output;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 日志里字符串的最大长度。超过就摘要，只影响日志，实际发送仍是原始值。 */
const MAX_LOG_STRING = 256;

/**
 * 把要写进日志的值裁短。
 *
 * 之前是把完整 params 直接扔进结构化日志——而 params 里带的是整段 base64：
 * 一张普通图片就产生 1.33MB 的一行日志，几张图就能把 5MB 的轮转窗口冲干净，
 * 真正需要的诊断信息全被挤掉。发送用的仍是原始 params，只有日志走这里。
 */
export function summarizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<深层嵌套已省略>';
  if (typeof value === 'string') {
    if (value.length <= MAX_LOG_STRING) return value;
    const dataUrl = /^data:([^;]+);base64,/i.exec(value);
    const bytes = Math.floor((value.length * 3) / 4);
    if (dataUrl) return `<${dataUrl[1]} base64 约 ${Math.round(bytes / 1024)}KB>`;
    if (/^base64:\/\//i.test(value)) return `<base64 约 ${Math.round(bytes / 1024)}KB>`;
    return `${value.slice(0, MAX_LOG_STRING)}…<共 ${value.length} 字符>`;
  }
  if (Array.isArray(value)) return value.map((item) => summarizeLogValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = summarizeLogValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

function mixedForwardItemContent(item: NapcatMixedForwardItem): NapcatMessageSegment[] {
  if (item.kind === 'text') return [{ type: 'text', data: { text: item.text } }];
  if (item.kind === 'image') return [{ type: 'image', data: { file: item.file } }];
  if (item.kind === 'video') return [buildVideoSegment(item.file)!].filter(Boolean);
  return [buildFileSegment(item.file, item.name)!].filter(Boolean);
}

export function buildNestedMixedForwardNodes(groups: NapcatMixedForwardItem[][], options: { botName?: string; userId?: number | string } = {}): NapcatForwardNode[] {
  const botName = options.botName || 'Miobot';
  const userId = options.userId ?? 0;
  const cleanGroups = (Array.isArray(groups) ? groups : [])
    .map((group) => (Array.isArray(group) ? normalizeMixedForwardItems(group) : []))
    .filter((group) => group.length > 0);
  return cleanGroups.map((group, groupIndex) => ({
    type: 'node' as const,
    data: {
      user_id: userId,
      nickname: `${botName} 混合合并转发 ${groupIndex + 1}/${cleanGroups.length}`,
      content: group.map((item, itemIndex) => ({
        type: 'node' as const,
        data: {
          user_id: userId,
          nickname: item.title || `${botName} ${groupIndex + 1}-${itemIndex + 1}`,
          content: mixedForwardItemContent(item),
        },
      })) as unknown as NapcatMessageSegment[],
    },
  }));
}
