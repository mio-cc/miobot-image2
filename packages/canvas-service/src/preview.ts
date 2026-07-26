import type { StoredAsset } from './assets.js';

/**
 * 缩略图。
 *
 * /assets/:id/preview?width= 以前完全忽略 width，直接把原图吐回去——
 * 画廊一屏十几张全尺寸图，几千张作品攒起来光打开列表就要下几百 MB。
 *
 * sharp 是**可选依赖**：装不上（冷门架构、没有编译环境）时回退原图，
 * 只是慢，不会让整个画布起不来。
 */

export interface PreviewResizer {
  /** id 单独传：StoredAsset 本身不带 id（它是资产仓储的键），而缓存要用它。 */
  (id: string, asset: StoredAsset, width: number): Promise<StoredAsset | undefined>;
}

const MIN_PREVIEW_WIDTH = 64;
const MAX_PREVIEW_WIDTH = 2048;
export const DEFAULT_PREVIEW_WIDTH = 512;

/** 把请求里的 width 夹到合理区间。缺省/非法一律给默认值。 */
export function clampPreviewWidth(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PREVIEW_WIDTH;
  return Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, n));
}

/** 只有这几种能缩；gif/svg 等原样返回，免得把动图压成一帧。 */
const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export function isResizable(contentType: string): boolean {
  return RESIZABLE.has(String(contentType || '').toLowerCase().split(';')[0]);
}

/**
 * 用 sharp 建一个缩略图生成器；sharp 不可用时返回 undefined，调用方回退原图。
 *
 * 带一个有上限的内存缓存：同一张图在画廊里会被反复请求（滚动、筛选、切页），
 * 每次都重新解码大图纯属浪费。缓存键含宽度，不同宽度各存一份。
 */
export function createSharpPreviewResizer(options: { cacheEntries?: number } = {}): PreviewResizer {
  const maxEntries = Math.max(16, Math.trunc(options.cacheEntries ?? 256));
  const cache = new Map<string, StoredAsset>();

  // 惰性加载：编译产物是 ESM，`require` 在里面根本不存在，
  // 用它去探测会永远失败、缩略图静默退化成原图。只解析一次并缓存结果（含失败）。
  let sharpPromise: Promise<any | undefined> | undefined;
  const loadSharp = (): Promise<any | undefined> => {
    if (!sharpPromise) {
      sharpPromise = import('sharp')
        .then((mod: any) => {
          const fn = mod?.default ?? mod;
          return typeof fn === 'function' ? fn : undefined;
        })
        .catch(() => undefined);
    }
    return sharpPromise;
  };

  return async (id: string, asset: StoredAsset, width: number): Promise<StoredAsset | undefined> => {
    if (!isResizable(asset.contentType)) return undefined;

    const key = `${id}@${width}`;
    const hit = cache.get(key);
    if (hit) {
      // 命中后挪到队尾，让 LRU 逐出的是真正没人用的。
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }

    const sharp = await loadSharp();
    if (!sharp) return undefined;   // 装不上 sharp 就回退原图，只是慢，不该让请求失败

    try {
      const input = Buffer.from(asset.base64, 'base64');
      // withoutEnlargement：原图比目标还小就别放大，那只会让文件变大。
      const output = await sharp(input)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();

      // 缩完反而更大就没意义（小图、已高度压缩的图都可能这样），回退原图。
      if (output.length >= input.length) return undefined;

      const thumb: StoredAsset = {
        ...asset,
        contentType: 'image/webp',
        base64: output.toString('base64'),
      };
      cache.set(key, thumb);
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return thumb;
    } catch {
      // 解码失败（损坏的图、意外的格式）不该让请求失败，回退原图即可。
      return undefined;
    }
  };
}
