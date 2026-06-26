import { ModelError, type HttpRequest, type HttpResponse, type Transport } from './ports.js';

export const defaultFetchTransport: Transport = async (request: HttpRequest): Promise<HttpResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs));
  try {
    const body = request.multipart ? (request.body as BodyInit) : JSON.stringify(request.body);
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body, signal: controller.signal });
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
