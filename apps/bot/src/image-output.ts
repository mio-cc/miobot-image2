import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface ImageCompressionOptions {
  scale: number;
  quality: number;
  /** 聊天图片的目标上限；超过后继续降质量/尺寸。 */
  maxBytes?: number;
  uploadFile?: (localPath: string, name: string, mime: string) => Promise<string>;
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
}

async function loadBuffer(ref: string): Promise<Buffer | null> {
  const value = String(ref || '').trim();
  if (!value) return null;
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    return comma >= 0 ? Buffer.from(value.slice(comma + 1), 'base64') : null;
  }
  if (value.startsWith('base64://')) return Buffer.from(value.slice('base64://'.length), 'base64');
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  try { return await fs.readFile(value); } catch { return null; }
}

export async function compressOutboundImages(
  images: string[],
  options: ImageCompressionOptions,
): Promise<string[]> {
  let sharpFactory: any;
  try {
    const mod: any = await import('sharp');
    sharpFactory = mod.default || mod;
  } catch {
    options.logger?.warn('图片压缩跳过：sharp 不可用');
    return images;
  }
  const out: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const original = images[i];
    try {
      const input = await loadBuffer(original);
      if (!input) { out.push(original); continue; }
      const meta = await sharpFactory(input, { limitInputPixels: 40_000_000 }).metadata();
      const initialWidth = Math.max(1, Math.round(Number(meta.width || 0) * Math.max(0.1, Math.min(1, options.scale))));
      const maxBytes = Math.max(64 * 1024, Number(options.maxBytes || 700 * 1024));
      let width = initialWidth;
      let quality = Math.max(1, Math.min(100, options.quality));
      let buffer: Buffer | undefined;
      // QQ 图片上传对 base64 体积很敏感；透明 PNG 也统一扁平化为 JPEG，避免 1.5MB 的 PNG 卡住 sendMsg 回调。
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let pipeline = sharpFactory(input, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality, mozjpeg: true });
        const nextBuffer = await pipeline.toBuffer();
        buffer = nextBuffer;
        if (nextBuffer.length <= maxBytes) break;
        width = Math.max(256, Math.round(width * 0.75));
        quality = Math.max(45, Math.round(quality * 0.8));
      }
      if (!buffer) { out.push(original); continue; }
      const mime = 'image/jpeg';
      const ext = 'jpg';
      if (buffer.length <= 6 * 1024 * 1024 || !options.uploadFile) {
        out.push(`data:${mime};base64,${buffer.toString('base64')}`);
      } else {
        const temp = path.join(os.tmpdir(), `miobot-compress-${randomUUID()}.${ext}`);
        await fs.writeFile(temp, buffer);
        try { out.push(await options.uploadFile(temp, `image-${i + 1}.${ext}`, mime)); }
        finally { await fs.unlink(temp).catch(() => undefined); }
      }
      options.logger?.info('图片已压缩', { index: i, beforeBytes: input.length, afterBytes: buffer.length, width, quality, mime });
    } catch (error) {
      options.logger?.warn('单张图片压缩失败，回退原图', { index: i, error: String((error as Error)?.message || error) });
      out.push(original);
    }
  }
  return out;
}

export function createOutboundImageCompressor(options: {
  getConfig: () => AppConfig;
  uploadFile?: (localPath: string, name: string, mime: string) => Promise<string>;
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
}): (images: string[]) => Promise<string[]> {
  return async (images) => {
    const cfg = options.getConfig().bot.imageCompression;
    if (cfg?.enabled === false) return images;
    return compressOutboundImages(images, {
      scale: Math.max(0.1, Math.min(1, Number(cfg?.scale || 0.65))),
      quality: Math.max(1, Math.min(100, Number(cfg?.quality || 82))),
      maxBytes: 700 * 1024,
      uploadFile: options.uploadFile,
      logger: options.logger,
    });
  };
}
