/**
 * 受限 HTTP 读取：每一跳 redirect 都重新做 SSRF 校验，并限制响应体字节数。
 * web.fetch 与 capability-http-generic 共用，避免各自复制一套不完整的 fetch 逻辑。
 */
export interface SafeFetchTextOptions {
  assertSafeUrl: (raw: string, allowPrivate: boolean) => Promise<URL>;
  allowPrivate?: boolean;
  init?: RequestInit;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeFetchTextResult {
  response: Response;
  text: string;
  url: URL;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const headers = response.headers as any;
  const declared = Number(headers && typeof headers.get === 'function' ? headers.get('content-length') || 0 : 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => undefined);
    throw new Error('response_too_large');
  }
  // 测试替身/极简 fetch 实现可能只有 text()，没有 ReadableStream。
  if (!response.body || typeof (response.body as any).getReader !== 'function') {
    const text = typeof response.text === 'function' ? await response.text() : '';
    return String(text).slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return text + '\n[内容截断]';
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* already closed */ }
  }
}

export async function fetchTextSafely(rawUrl: string, options: SafeFetchTextOptions): Promise<SafeFetchTextResult> {
  const timeoutMs = Math.max(1000, Math.trunc(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(1024, Math.trunc(Number(options.maxBytes) || DEFAULT_MAX_BYTES));
  const maxRedirects = Math.max(0, Math.min(10, Math.trunc(Number(options.maxRedirects) || 5)));
  const allowPrivate = options.allowPrivate === true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let current = await options.assertSafeUrl(rawUrl, allowPrivate);
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const response = await fetch(current.toString(), {
        ...options.init,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (REDIRECT_CODES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) return { response, text: '', url: current };
        if (redirects >= maxRedirects) throw new Error('too_many_redirects');
        current = await options.assertSafeUrl(new URL(location, current).toString(), allowPrivate);
        continue;
      }
      const text = await readLimited(response, maxBytes);
      return { response, text, url: current };
    }
    throw new Error('too_many_redirects');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}