import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { derivePanelToken } from '../../../packages/web-api/src/index.js';

export interface CanvasGallerySyncContext {
  chatType: 'group' | 'private';
  groupId?: number | string;
  userId?: number | string;
}

export interface CanvasGallerySyncInput {
  mode: 'generate' | 'edit';
  prompt: string;
  images: string[];
  context: CanvasGallerySyncContext;
}

export interface CanvasGallerySync {
  /** 把 Bot 生图结果写入 Canvas 图库，返回可交给 Napcat 发送的绝对图片 URL。 */
  syncImages(input: CanvasGallerySyncInput): Promise<string[]>;
}

export interface CanvasGallerySyncOptions {
  getConfig: () => AppConfig;
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

interface GalleryArtifact {
  kind: 'url' | 'base64';
  data: string;
  mimeType?: string;
}

interface GallerySyncResponse {
  ok?: boolean;
  record?: {
    outputs?: Array<{
      asset?: {
        url?: string;
      };
    }>;
  };
  error?: {
    message?: string;
  };
}

const DEFAULT_SYNC_TIMEOUT_MS = 15_000;

/**
 * Bot 生图默认走 Napcat WebSocket 回图。直接回 data:image/...;base64 时，
 * 大图会把 WS 帧撑得很大；同时 v2 Bot 也没有把生图结果写入 Canvas 图库。
 *
 * 这里统一走同机 Canvas API：
 *   1. POST /canvas-api/bot/gallery 保存资产并写入图库；
 *   2. 取返回的 asset.url；
 *   3. 用 MIOBOT_PUBLIC_BASE_URL 转成 Napcat 可下载的绝对 URL。
 *
 * 任何一步失败都回退原图片引用，不能因为图库同步失败让用户收不到图。
 */
export function createCanvasGallerySync(options: CanvasGallerySyncOptions): CanvasGallerySync {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return {
    async syncImages(input) {
      const originals = input.images.filter((image) => String(image || '').trim());
      if (!originals.length) return input.images;
      if (String(env.MIOBOT_SYNC_BOT_GALLERY || '1') === '0') return input.images;

      const config = options.getConfig();
      if (config.canvas.enabled === false) return input.images;

      const artifacts = originals.map(toGalleryArtifact);
      if (artifacts.some((artifact) => !artifact)) {
        options.logger?.warn('Bot image gallery sync skipped: unsupported image reference', {
          imageCount: originals.length,
        });
        return input.images;
      }

      const endpoint = resolveCanvasSyncEndpoint(config, env);
      const payload = buildGalleryPayload(input, originals, artifacts as GalleryArtifact[]);
      const token = derivePanelToken(String(config.panel.passwordSeed || ''));
      const timeoutMs = readPositiveInt(env.MIOBOT_CANVAS_SYNC_TIMEOUT_MS, DEFAULT_SYNC_TIMEOUT_MS);

      if (typeof fetchImpl !== 'function') {
        options.logger?.warn('Bot image gallery sync skipped: fetch is unavailable');
        return input.images;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await readErrorDetail(response);
          throw new Error(`Canvas gallery sync HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        }

        const body = await response.json() as GallerySyncResponse;
        const assetUrls = (body.record?.outputs || [])
          .map((output) => String(output?.asset?.url || '').trim())
          .filter(Boolean);

        if (assetUrls.length !== originals.length) {
          throw new Error(`Canvas gallery sync returned ${assetUrls.length} assets for ${originals.length} images`);
        }

        const publicBaseUrl = resolvePublicImageBaseUrl(env);
        const sendableUrls = assetUrls.map((url) => toAbsoluteImageUrl(url, publicBaseUrl));
        if (sendableUrls.some((url) => !url)) {
          options.logger?.warn('Bot image gallery sync saved images, but MIOBOT_PUBLIC_BASE_URL is not configured; fallback to original image payload', {
            imageCount: originals.length,
            endpoint,
          });
          return input.images;
        }

        options.logger?.info('Bot images synced to canvas gallery', {
          imageCount: originals.length,
          endpoint,
          publicBaseUrl: publicBaseUrl || '(absolute provider URL)',
        });
        return sendableUrls as string[];
      } catch (error) {
        options.logger?.warn('Bot image gallery sync failed; fallback to original image payload', {
          endpoint,
          imageCount: originals.length,
          error: error instanceof Error ? error.message : String(error),
        });
        return input.images;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function resolveCanvasSyncEndpoint(config: AppConfig, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.MIOBOT_CANVAS_SYNC_URL || '').trim();
  if (explicit) return explicit;
  const port = readPositiveInt(
    env.MIOBOT_PORT || env.MIOBOT_VERIFY_PORT || env.PORT || config.panel?.port,
    3018,
  );
  return `http://127.0.0.1:${port}/canvas-api/bot/gallery`;
}

export function resolvePublicImageBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = String(
    env.MIOBOT_PUBLIC_BASE_URL
      || env.MIOBOT_NAPCAT_IMAGE_BASE_URL
      || env.MIOBOT_CANVAS_ASSET_BASE_URL
      || '',
  ).trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.toString().replace(/\/+$/, '')}/`;
  } catch {
    return undefined;
  }
}

function buildGalleryPayload(input: CanvasGallerySyncInput, images: string[], artifacts: GalleryArtifact[]): Record<string, unknown> {
  const prompt = String(input.prompt || '').trim();
  return {
    source: 'bot',
    taskId: `bot_${Date.now()}_${randomUUID().slice(0, 8)}`,
    mode: input.mode,
    prompt,
    effectivePrompt: prompt,
    outputFormat: inferOutputFormat(images[0]),
    quality: 'auto',
    context: {
      chatType: input.context.chatType,
      groupId: input.context.groupId === undefined ? '' : String(input.context.groupId),
      userId: input.context.userId === undefined ? '' : String(input.context.userId),
    },
    artifacts,
  };
}

function toGalleryArtifact(value: string): GalleryArtifact | undefined {
  const text = String(value || '').trim();
  if (!text) return undefined;
  if (/^data:image\//i.test(text)) return { kind: 'url', data: text, mimeType: imageMimeFromDataUrl(text) };
  if (/^https?:\/\//i.test(text)) return { kind: 'url', data: text };
  if (/^base64:\/\//i.test(text)) {
    return {
      kind: 'base64',
      data: text.slice('base64://'.length),
      mimeType: 'image/png',
    };
  }
  return undefined;
}

function toAbsoluteImageUrl(value: string, publicBaseUrl: string | undefined): string | undefined {
  const url = String(value || '').trim();
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (!publicBaseUrl) return undefined;
  try {
    return new URL(url, publicBaseUrl).toString();
  } catch {
    return undefined;
  }
}

function inferOutputFormat(value: string | undefined): 'png' | 'jpeg' | 'webp' {
  const mime = imageMimeFromDataUrl(String(value || ''));
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

function imageMimeFromDataUrl(value: string): string {
  return String(value || '').match(/^data:([^;,]+)[;,]/i)?.[1]?.toLowerCase() || 'image/png';
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
      return String(parsed.error?.message || parsed.message || '').trim().slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return '';
  }
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}