import { ModelError, type ImageEditRequest, type ModelNode, type RequestPlan } from '../ports.js';
import { trimTrailingSlash } from './shared.js';

/**
 * 改图的 multipart 形态。
 *
 * OpenAI 官方的 /images/edits 只接受 multipart/form-data——JSON 会被直接拒。
 * 而 xAI 正好相反，官方文档明确说不支持 multipart。所以形态必须按模型选。
 *
 * 这里之所以单独成文件而不是塞进 openai 方言：构造 multipart 需要图片的**字节**，
 * 拿字节是异步的（要下载 http URL），而方言是同步纯函数。
 * 因此由 client 先把图片解析成 ResolvedImage 再交给这里拼装。
 */

export interface ResolvedImage {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function extensionForMime(mimeType: string): string {
  return EXT_BY_MIME[String(mimeType || '').toLowerCase().split(';')[0]] || 'png';
}

/**
 * 把一个图片引用解析成字节。
 * 支持 data URL、base64://、http(s) URL；本地路径不在这里处理（Node 侧由调用方决定是否放行）。
 */
export async function resolveImageBytes(reference: string, fetchImpl: typeof fetch = fetch): Promise<ResolvedImage> {
  const value = String(reference || '').trim();
  if (!value) throw new ModelError('改图缺少图片', { category: 'validation', retryable: false });

  const dataUrl = value.match(/^data:([^;]+);base64,(.+)$/is);
  if (dataUrl) {
    const mimeType = dataUrl[1].toLowerCase();
    return { bytes: base64ToBytes(dataUrl[2]), mimeType, fileName: `image.${extensionForMime(mimeType)}` };
  }

  if (value.startsWith('base64://')) {
    // 没有 MIME 信息，按 png 处理——官方接口只看实际字节，扩展名仅作提示。
    return { bytes: base64ToBytes(value.slice('base64://'.length)), mimeType: 'image/png', fileName: 'image.png' };
  }

  if (/^https?:\/\//i.test(value)) {
    const response = await fetchImpl(value);
    if (!response.ok) {
      throw new ModelError(`下载参考图失败：HTTP ${response.status}`, { category: 'upstream', retryable: true });
    }
    const mimeType = String(response.headers.get('content-type') || 'image/png').split(';')[0];
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, mimeType, fileName: `image.${extensionForMime(mimeType)}` };
  }

  throw new ModelError(`无法解析参考图（既不是 data URL、base64:// 也不是 http 链接）：${value.slice(0, 80)}`, {
    category: 'validation',
    retryable: false,
  });
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = String(base64 || '').replace(/\s+/g, '');
  return Uint8Array.from(Buffer.from(clean, 'base64'));
}

/**
 * 拼装 multipart 改图请求。
 * 注意 headers 不能带 Content-Type——boundary 由 FormData 自己生成，
 * 手工设置会让服务端解析不出分隔符。
 */
export function buildMultipartImageEdit(
  node: ModelNode,
  req: ImageEditRequest,
  images: ResolvedImage[],
  mask?: ResolvedImage,
): RequestPlan {
  if (!images.length) throw new ModelError('改图缺少图片', { category: 'validation', retryable: false });

  const form = new FormData();
  form.append('model', req.model);
  form.append('prompt', req.prompt);
  if (req.size) form.append('size', req.size);
  if (req.quality) form.append('quality', req.quality);

  // 官方支持多图参考时字段名是 image[]，单图用 image。
  const field = images.length > 1 ? 'image[]' : 'image';
  for (const image of images) {
    form.append(field, new Blob([image.bytes as unknown as BlobPart], { type: image.mimeType }), image.fileName);
  }
  if (mask) {
    form.append('mask', new Blob([mask.bytes as unknown as BlobPart], { type: mask.mimeType }), mask.fileName);
  }

  const headers: Record<string, string> = {};
  if (node.apiKey) headers.Authorization = `Bearer ${node.apiKey}`;
  for (const [key, value] of Object.entries(node.headers || {})) {
    // 显式跳过 Content-Type：boundary 必须由 FormData 决定。
    if (key.toLowerCase() === 'content-type') continue;
    headers[key] = value;
  }

  return {
    method: 'POST',
    url: `${trimTrailingSlash(node.baseUrl)}/images/edits`,
    headers,
    body: form,
    multipart: true,
  };
}
