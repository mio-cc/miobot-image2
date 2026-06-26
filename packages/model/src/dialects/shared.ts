import { ModelError, type ImageArtifact, type ImageResult, type TextResult } from '../ports.js';

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

export function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

export function bearerHeaders(apiKey?: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export function flattenTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        if (typeof record.output_text === 'string') return record.output_text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const record = asRecord(content);
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  return '';
}

export function assertNoTopLevelError(data: unknown): void {
  const root = asRecord(data);
  if (root.error !== undefined) {
    const err = asRecord(root.error);
    const message = typeof root.error === 'string' ? root.error : String(err.message || 'Upstream provider error');
    const status = typeof err.status === 'number' ? err.status : undefined;
    throw new ModelError(message, { category: 'upstream', retryable: status ? status >= 500 : false, status, code: typeof err.code === 'string' ? err.code : undefined });
  }
}

/** 从 OpenAI 风格响应取文本。 */
export function parseOpenAiText(data: unknown): TextResult {
  assertNoTopLevelError(data);
  const root = asRecord(data);
  if (typeof root.output_text === 'string' && root.output_text.trim()) return { text: root.output_text, raw: data };
  const choices = Array.isArray(root.choices) ? root.choices : [];
  for (const choice of choices) {
    const item = asRecord(choice);
    const message = asRecord(item.message);
    const text = flattenTextContent(message.content ?? item.text);
    if (text.trim()) return { text, raw: data };
  }
  throw new ModelError('Text response missing choices[].message.content/output_text', { category: 'validation', retryable: false });
}

/** 从 OpenAI 风格 images 响应取图片（data[].b64_json/url）。 */
export function parseOpenAiImages(data: unknown): ImageResult {
  assertNoTopLevelError(data);
  const root = asRecord(data);
  const items = Array.isArray(root.data) ? root.data : [];
  if (!items.length) throw new ModelError('Image response missing data[]', { category: 'validation', retryable: false });
  const images = items.map((item: unknown, index: number) => parseImageItem(item, index));
  return { images, raw: data };
}

export function parseImageItem(item: unknown, index: number): ImageArtifact {
  const record = asRecord(item);
  if (record.error !== undefined) {
    const err = asRecord(record.error);
    throw new ModelError(`data[${index}].error: ${String(err.message || record.error)}`, { category: 'upstream', retryable: true });
  }
  const mimeType = typeof record.mime_type === 'string' ? record.mime_type : typeof record.mimeType === 'string' ? record.mimeType : undefined;
  const revisedPrompt = typeof record.revised_prompt === 'string' ? record.revised_prompt : undefined;
  if (typeof record.b64_json === 'string' && record.b64_json) return { kind: 'base64', data: record.b64_json, mimeType, revisedPrompt, index };
  if (typeof record.base64 === 'string' && record.base64) return { kind: 'base64', data: record.base64, mimeType, revisedPrompt, index };
  if (typeof record.url === 'string' && record.url) return { kind: 'url', data: record.url, mimeType, revisedPrompt, index };
  throw new ModelError(`Image response data[${index}] missing b64_json/base64/url`, { category: 'validation', retryable: false });
}

export function getByPath(data: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: any = data;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    const idx = seg.match(/^(\w+)\[(\d+)\]$/);
    if (idx) { cur = cur?.[idx[1]]?.[Number(idx[2])]; } else { cur = cur?.[seg]; }
  }
  return cur;
}
