import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export type ImageInputPreparer = (images: string[]) => Promise<string[]>;

export interface ImageInputPreparerOptions {
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
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
    if (disabled || !Array.isArray(images) || !images.length) return images;
    if (typeof fetchImpl !== 'function') return images;

    const resolved = await Promise.all(images.map(async (image) => {
      const value = String(image || '').trim();
      if (!/^https?:\/\//i.test(value)) return image;
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
        options.logger?.warn('输入图片内联失败，保留原引用', {
          reference: describeImageReference(value),
          error: error instanceof Error ? error.message : String(error),
        });
        return image;
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