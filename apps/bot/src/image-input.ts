import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export type ImageInputPreparer = (images: string[]) => Promise<string[]>;

export interface ImageInputPreparerOptions {
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** 把 Napcat 本地文件引用(file=xxx.jpg/path)解析成 URL 或 data URL。 */
  resolveLocalImage?: (reference: string) => Promise<string | undefined>;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 把 QQ/Napcat 上报的远程图片内联成 data URL。
 *
 * 背景：部分 OpenAI 兼容网关/模型不接受 QQ 多媒体签名 URL，或者会把它当成
 * 非法的 image_url。先由 Miobot 下载再转 base64，通常兼容性最高。
 *
 * 只处理 http(s) 图片；data/base64/file 引用原样返回。下载失败、响应不是图片、
 * 超过体积上限或超时时保留原引用，不阻断后续流程。
 */
export function createImageInputPreparer(options: ImageInputPreparerOptions = {}): ImageInputPreparer {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxBytes = readPositiveInt(env.MIOBOT_INLINE_IMAGE_MAX_BYTES, DEFAULT_MAX_BYTES);
  const timeoutMs = readPositiveInt(env.MIOBOT_INLINE_IMAGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const disabled = isFalsy(env.MIOBOT_INLINE_REMOTE_IMAGES);

  return async (images) => {
    if (!Array.isArray(images) || !images.length) return images;

    const resolved = await Promise.all(images.map(async (image) => {
      let value = String(image || '').trim();
      if (!value) return image;

      if (isLocalImageReference(value)) {
        if (!options.resolveLocalImage) return image;
        try {
          const resolvedLocal = await options.resolveLocalImage(value);
          if (!resolvedLocal) {
            options.logger?.warn('本地图片引用无法解析，已丢弃该图片引用（下游按缺少图片处理并追问）', {
              reference: describeImageReference(value),
            });
            return '';
          }
          value = resolvedLocal;
        } catch (error) {
          options.logger?.warn('本地图片引用解析失败，已丢弃该图片引用（下游按缺少图片处理并追问）', {
            reference: describeImageReference(value),
            error: error instanceof Error ? error.message : String(error),
          });
          return '';
        }
      }

      if (/^base64:\/\//i.test(value)) {
        return imageDataUrlFromBase64(value) || value;
      }
      if (/^data:image\//i.test(value)) return value;
      if (!/^https?:\/\//i.test(value)) return value;
      // 关闭远程 URL 内联时，只停掉这一步下载；本地 get_image 解析仍然保留。
      if (disabled || typeof fetchImpl !== 'function') return value;

      try {
        const response = await fetchImpl(value, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
          throw new Error(`图片超过内联上限 (${declaredSize} > ${maxBytes} bytes)`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) {
          throw new Error(`图片超过内联上限 (${buffer.length} > ${maxBytes} bytes)`);
        }
        const mime = detectImageMime(buffer, response.headers.get('content-type'));
        if (!mime) throw new Error('响应不是可识别的图片');
        return `data:${mime};base64,${buffer.toString('base64')}`;
      } catch (error) {
        const qqHosted = isQqImageHost(value);
        options.logger?.warn(qqHosted ? 'QQ 图片内联失败，已丢弃，避免上游再次下载签名 URL' : '输入图片内联失败，保留原引用', {
          reference: describeImageReference(value),
          error: error instanceof Error ? error.message : String(error),
        });
        return qqHosted ? '' : image;
      }
    }));

    if (resolved.some((image, index) => image !== images[index])) {
      options.logger?.info('输入图片已内联为 data URL', {
        imageCount: images.length,
        inlinedCount: resolved.filter((image, index) => image !== images[index]).length,
        maxBytes,
      });
    }
    return resolved;
  };
}

export interface NapcatGetImageResponse {
  data?: {
    base64?: unknown;
    url?: unknown;
    file?: unknown;
    file_name?: unknown;
  };
}

export interface NapcatImageReferenceResolverOptions {
  callGetImage: (file: string) => Promise<NapcatGetImageResponse>;
  logger?: Pick<StructuredLogger, 'warn'>;
}

/**
 * 兼容 Napcat 只上报 file=xxx.jpg、不附带 url 的场景。
 *
 * OneBot get_image 在 enableLocalFile2Url 开启时会返回 base64；否则可能返回
 * 临时的 QQ URL 或 Napcat 容器内本地路径。这里优先 base64，其次 http/data URL。
 */
export function createNapcatImageReferenceResolver(
  options: NapcatImageReferenceResolverOptions,
): (reference: string) => Promise<string | undefined> {
  return async (reference) => {
    try {
      const response = await options.callGetImage(reference);
      const data = response?.data || {};
      const base64 = String(data.base64 || '').trim();
      if (base64) {
        const dataUrl = imageDataUrlFromBase64(base64);
        if (dataUrl) return dataUrl;
      }
      const url = String(data.url || '').trim();
      if (/^(?:https?:\/\/|data:image\/)/i.test(url)) return url;
      options.logger?.warn('Napcat get_image 未返回可用图片 URL/base64', {
        reference: describeImageReference(reference),
        hasBase64: Boolean(base64),
        hasUrl: Boolean(url),
        hasLocalFile: Boolean(data.file),
        fileName: String(data.file_name || '').slice(0, 80) || undefined,
      });
      return undefined;
    } catch (error) {
      options.logger?.warn('Napcat get_image 调用失败', {
        reference: describeImageReference(reference),
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
}

/** 把裸 base64 或 base64:// 统一成 data URL；无法识别图片时返回 undefined。 */
export function imageDataUrlFromBase64(value: string): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (/^data:image\//i.test(raw)) return raw;
  const body = raw.startsWith('base64://') ? raw.slice('base64://'.length) : raw;
  if (!body || /[^A-Za-z0-9+/=\s]/.test(body)) return undefined;
  try {
    const buffer = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    if (!buffer.length) return undefined;
    const mime = detectImageMime(buffer, null);
    if (!mime) return undefined;
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** 日志里只展示图片引用的类型/域名，避免把 QQ 签名 URL 完整打进日志。 */
export function describeImageReference(image: string): string {
  const value = String(image || '').trim();
  if (!value) return 'empty';
  if (/^data:image\//i.test(value)) return 'data-url';
  if (/^base64:\/\//i.test(value)) return 'base64://';
  if (/^file:\/\//i.test(value)) return 'file://';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}`;
    } catch {
      return 'http-url';
    }
  }
  return `local:${value.slice(0, 100)}`;
}

function isQqImageHost(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'gchat.qpic.cn' || host.endsWith('.qpic.cn') || host === 'multimedia.nt.qq.com.cn' || host.endsWith('.nt.qq.com.cn');
  } catch {
    return false;
  }
}

function isLocalImageReference(value: string): boolean {
  return !/^(?:https?:\/\/|data:|base64:|blob:)/i.test(value);
}

function detectImageMime(buffer: Buffer, contentType: string | null): string | undefined {
  const header = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (header.startsWith('image/')) return header;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

function isFalsy(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}