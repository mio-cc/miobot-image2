import fs from 'node:fs';

/**
 * 媒体体积护栏。
 *
 * 两条限制的后果完全不同，必须分开处理：
 *
 * 1. **WebSocket 帧上限**：Napcat 的正/反向 WS 都是 maxPayload = 50MB。
 *    base64 编码会让体积涨约 1.34 倍，因此经 WS 传 base64:// 的原始文件实际只能到约 37MB。
 *    **超了是直接断开连接**，不是返回错误——机器人会掉线重连，而且用户看不到任何原因。
 *    所以这条必须在发送前拦住。
 *
 * 2. **视频 100MB**：走 highway 通道时 Napcat 自己会抛错（有明确报错），
 *    可以降级成文件发送。
 *
 * 本地路径与 http(s) URL 不经 WS 传内容，只传一个字符串，不受第 1 条限制。
 */

/** 视频走 highway 的硬上限。 */
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/**
 * 经 WS 下发 base64 的保守阈值。
 * 理论上限约 37MB，这里留足协议开销与并发余量。
 */
export const WS_BASE64_SAFE_BYTES = 8 * 1024 * 1024;

/**
 * 单个 WebSocket 帧的安全上限。
 *
 * NapCat 侧 maxPayload 是 50MB，超过会**直接断连**——不是报错，是整条连接没了，
 * bot 表现为"忽然掉线又重连"，日志里看不出跟哪条消息有关。
 * 留 10MB 余量给协议开销与多段消息的累加。
 *
 * 逐个方法加护栏挡不住这个：合并转发是把 N 条消息拼进同一帧，
 * 每条单独看都不超标，加起来就炸了。所以必须在**发帧那一刻**兜一次底。
 */
export const WS_FRAME_SAFE_BYTES = 40 * 1024 * 1024;

export type MediaPayloadKind = 'base64' | 'local-file' | 'remote-url' | 'unknown';

export interface MediaPayloadInfo {
  kind: MediaPayloadKind;
  /** 已知的字节数；取不到时为 undefined（例如远程 URL）。 */
  bytes?: number;
  /** 该载荷是否会把内容塞进 WebSocket 帧。 */
  travelsOverWebSocket: boolean;
}

/** 判断一个 file 字段的形态与体积。 */
export function inspectMediaPayload(fileRef: string): MediaPayloadInfo {
  const value = String(fileRef || '').trim();
  if (!value) return { kind: 'unknown', travelsOverWebSocket: false };

  if (/^https?:\/\//i.test(value)) {
    return { kind: 'remote-url', travelsOverWebSocket: false };
  }

  const base64Body = value.startsWith('base64://')
    ? value.slice('base64://'.length)
    : /^data:[^;]+;base64,/i.test(value)
      ? value.slice(value.indexOf('base64,') + 'base64,'.length)
      : '';

  if (base64Body) {
    // base64 长度 → 原始字节数：每 4 个字符编码 3 字节，末尾的 = 是补位。
    const clean = base64Body.replace(/\s+/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return { kind: 'base64', bytes: Math.max(0, Math.floor((clean.length * 3) / 4) - padding), travelsOverWebSocket: true };
  }

  const localPath = value.startsWith('file://') ? value.slice('file://'.length) : value;
  try {
    const stat = fs.statSync(localPath);
    if (stat.isFile()) return { kind: 'local-file', bytes: stat.size, travelsOverWebSocket: false };
  } catch {
    // 不是本机可见的文件——可能是容器内路径，交给 Napcat 自己解析。
  }
  return { kind: 'unknown', travelsOverWebSocket: false };
}

export interface MediaGuardVerdict {
  ok: boolean;
  /** 中文原因，可直接回给用户/写进日志。 */
  reason?: string;
  /** 视频超过 100MB 时建议改用文件发送。 */
  suggestFileSend?: boolean;
  info: MediaPayloadInfo;
}

/** 通用护栏：任何经 WS 传的 base64 都不能超过安全阈值，否则会直接断连。 */
export function guardWebSocketPayload(fileRef: string, label = '文件'): MediaGuardVerdict {
  const info = inspectMediaPayload(fileRef);
  if (info.travelsOverWebSocket && info.bytes !== undefined && info.bytes > WS_BASE64_SAFE_BYTES) {
    return {
      ok: false,
      info,
      reason: `${label}有 ${describeBytes(info.bytes)}，以 base64 经 WebSocket 下发会超出 Napcat 的帧上限并直接断开连接。`
        + '请改为先落盘再传本地路径（或配置挂载目录）。',
    };
  }
  return { ok: true, info };
}

/** 视频专用护栏：先查 WS 限制，再查 100MB 硬上限。 */
export function guardVideoPayload(fileRef: string): MediaGuardVerdict {
  const wsVerdict = guardWebSocketPayload(fileRef, '视频');
  if (!wsVerdict.ok) return wsVerdict;

  const info = wsVerdict.info;
  if (info.bytes !== undefined && info.bytes > VIDEO_MAX_BYTES) {
    return {
      ok: false,
      info,
      suggestFileSend: true,
      reason: `视频有 ${describeBytes(info.bytes)}，超过 Napcat 视频通道的 100MB 上限，建议改用文件方式发送。`,
    };
  }
  return { ok: true, info };
}

export function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
