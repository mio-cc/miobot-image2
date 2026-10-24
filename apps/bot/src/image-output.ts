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

export interface NapcatMountOutputOptions {
  /** Bot 所在宿主机可写的目录。 */
  hostDir: string;
  /** Napcat 容器内可见的同一目录。 */
  containerDir: string;
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
}

function extensionForImage(buffer: Buffer, original: string): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const mime = /^data:image\/([a-z0-9.+-]+)/i.exec(original)?.[1]?.toLowerCase();
  if (mime === 'jpeg') return 'jpg';
  if (mime === 'png' || mime === 'webp' || mime === 'gif') return mime;
  return 'bin';
}

/** 把出站图片写到 Napcat 共享目录，返回 Napcat 容器内可直接读取的 file:// 路径。 */
export async function materializeImagesForNapcat(
  images: string[],
  options: NapcatMountOutputOptions,
): Promise<string[]> {
  const hostDir = String(options.hostDir || '').trim();
  const containerDir = String(options.containerDir || '').trim().replace(/\/+$/, '');
  if (!hostDir || !containerDir) return images;
  await fs.mkdir(hostDir, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const original = images[i];
    try {
      const input = await loadBuffer(original);
      if (!input) { out.push(original); continue; }
      const ext = extensionForImage(input, original);
      const filename = `miobot-${Date.now()}-${i}-${randomUUID()}.${ext}`;
      const localPath = path.join(hostDir, filename);
      await fs.writeFile(localPath, input, { mode: 0o644 });
      out.push(`file://${containerDir}/${filename}`);
      options.logger?.info('图片已写入 Napcat 共享目录', {
        index: i,
        bytes: input.length,
        hostPath: localPath,
        napcatPath: `file://${containerDir}/${filename}`,
      });
    } catch (error) {
      options.logger?.warn('图片写入 Napcat 共享目录失败，回退原引用', {
        index: i,
        error: String((error as Error)?.message || error),
      });
      out.push(original);
    }
  }
  return out;
}

/**
 * 把出站语音（TTS/Suno 的 base64 或 URL）写到 Napcat 共享目录，返回容器内 file:// 路径。
 * 实测 99KB record 走 base64 WS 上行耗时 4.6s；走共享目录文件路径由 Napcat 本地读取。
 */
export async function materializeAudioForNapcat(
  audios: string[],
  options: NapcatMountOutputOptions,
): Promise<string[]> {
  const hostDir = String(options.hostDir || '').trim();
  const containerDir = String(options.containerDir || '').trim().replace(/\/+$/, '');
  if (!hostDir || !containerDir) return audios;
  try {
    await fs.mkdir(hostDir, { recursive: true });
  } catch {
    // 目录不可写（权限/路径非法）：整体回退原引用，绝不阻断语音发送。
    options.logger?.warn('语音共享目录不可写，回退 base64 发送', { hostDir });
    return audios;
  }
  const out: string[] = [];
  for (let i = 0; i < audios.length; i += 1) {
    const original = audios[i];
    // 远端 URL（如 Suno CDN）由 Napcat 自行下载更稳，只物化本地 base64。
    if (!/^base64:\/\//i.test(original)) { out.push(original); continue; }
    try {
      const input = await loadBuffer(original);
      if (!input) { out.push(original); continue; }
      const mime = /^data:audio\/([a-z0-9.+-]+)/i.exec(original)?.[1]?.toLowerCase();
      const ext = mime === 'mpeg' ? 'mp3' : mime || 'mp3';
      const filename = `miobot-voice-${Date.now()}-${i}-${randomUUID()}.${ext}`;
      const localPath = path.join(hostDir, filename);
      await fs.writeFile(localPath, input, { mode: 0o644 });
      out.push(`file://${containerDir}/${filename}`);
      options.logger?.info('语音已写入 Napcat 共享目录', {
        index: i,
        bytes: input.length,
        hostPath: localPath,
        napcatPath: `file://${containerDir}/${filename}`,
      });
    } catch (error) {
      options.logger?.warn('语音写入 Napcat 共享目录失败，回退原引用', {
        index: i,
        error: String((error as Error)?.message || error),
      });
      out.push(original);
    }
  }
  return out;
}
