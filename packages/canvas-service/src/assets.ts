/** 一份二进制资产(以 base64 持有 + MIME 类型)。 */
export interface StoredAsset { contentType: string; base64: string; createdAt: string }

/** 可注入的资产仓储：内存(默认) / 文件(apps/canvas 用 fs 实现)。 */
export interface AssetStore {
  put(id: string, asset: StoredAsset): void;
  get(id: string): StoredAsset | undefined;
  delete(id: string): boolean;
}

/** 内存资产仓储(进程内,重启丢失)。生产建议由 apps/canvas 注入文件后端。 */
export class InMemoryAssetStore implements AssetStore {
  private readonly map = new Map<string, StoredAsset>();
  put(id: string, asset: StoredAsset): void { this.map.set(id, asset); }
  get(id: string): StoredAsset | undefined { return this.map.get(id); }
  delete(id: string): boolean { return this.map.delete(id); }
}

/** 解析 data URL → {contentType, base64};非 data URL 返回 null(视为外链)。 */
export function parseDataUrl(value: string): { contentType: string; base64: string } | null {
  const m = String(value || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!m) return null;
  const isBase64 = Boolean(m[2]);
  const contentType = (m[1] || 'image/png').trim();
  const payload = m[3] || '';
  return { contentType, base64: isBase64 ? payload : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64') };
}

/** 由内容类型推断下载文件扩展名。 */
export function extensionFor(contentType: string): string {
  const map: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  return map[String(contentType || '').toLowerCase()] || 'png';
}
