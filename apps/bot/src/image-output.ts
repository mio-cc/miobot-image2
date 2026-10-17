import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface ImageCompressionOptions {
  scale: number;
  quality: number;
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
      const image = sharpFactory(input, { limitInputPixels: 40_000_000 }).rotate();
      const meta = await image.metadata();
      const width = Math.max(1, Math.round(Number(meta.width || 0) * Math.max(0.1, Math.min(1, options.scale))));
      const hasAlpha = Boolean(meta.hasAlpha);
      let pipeline = image.resize({ width, withoutEnlargement: true });
      pipeline = hasAlpha
        ? pipeline.png({ compressionLevel: 9 })
        : pipeline.jpeg({ quality: Math.max(1, Math.min(100, options.quality)), mozjpeg: true });
      const buffer = await pipeline.toBuffer();
      if (buffer.length >= input.length) { out.push(original); continue; }
      const mime = hasAlpha ? 'image/png' : 'image/jpeg';
      const ext = hasAlpha ? 'png' : 'jpg';
      if (buffer.length <= 6 * 1024 * 1024 || !options.uploadFile) {
        out.push(`data:${mime};base64,${buffer.toString('base64')}`);
      } else {
        const temp = path.join(os.tmpdir(), `miobot-compress-${randomUUID()}.${ext}`);
        await fs.writeFile(temp, buffer);
        try { out.push(await options.uploadFile(temp, `image-${i + 1}.${ext}`, mime)); }
        finally { await fs.unlink(temp).catch(() => undefined); }
      }
      options.logger?.info('图片已压缩', { index: i, beforeBytes: input.length, afterBytes: buffer.length, width });
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
      uploadFile: options.uploadFile,
      logger: options.logger,
    });
  };
}
