import { ModelError, type HttpRequest, type HttpResponse, type Transport } from './ports.js';

export const defaultFetchTransport: Transport = async (request: HttpRequest): Promise<HttpResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs));
  try {
    const method = (request.method || 'POST').toUpperCase();
    // GET/HEAD 不带 body；视频轮询走 GET /videos/{id}。
    const init: RequestInit = { method, headers: request.headers, signal: controller.signal };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = request.multipart ? (request.body as BodyInit) : JSON.stringify(request.body ?? {});
    }
    const response = await fetch(request.url, init);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new ModelError(`request timed out after ${request.timeoutMs}ms`, { category: 'timeout', retryable: true });
    throw new ModelError(`fetch failed: ${(error as Error)?.message || error}`, { category: 'network', retryable: true });
  } finally {
    clearTimeout(timer);
  }
};
