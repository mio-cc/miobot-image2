export type ProviderErrorKind =
  | 'invalid_request'
  | 'authentication'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'quota_exceeded'
  | 'context_length'
  | 'content_filter'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unknown';

export interface ProviderErrorClassification {
  kind: ProviderErrorKind;
  category: 'validation' | 'upstream' | 'timeout' | 'network' | 'unknown';
  retryable: boolean;
  status?: number;
  code?: string;
  message: string;
  provider?: string;
}

export interface ClassifyProviderErrorInput {
  status?: number;
  body?: unknown;
  error?: unknown;
  message?: string;
  provider?: string;
}

/**
 * Normalize provider HTTP/body errors without exposing vendor-specific payloads
 * to callers. The classification drives retry/failover and UI diagnostics.
 */
export function classifyProviderError(input: ClassifyProviderErrorInput): ProviderErrorClassification {
  const body = input.body;
  const extracted = extractProviderError(input.error ?? body, input.message);
  const status = validStatus(input.status);
  const rawCode = extracted.code || codeFromBody(body);
  const code = rawCode ? rawCode.toLowerCase() : undefined;
  const message = extracted.message || input.message || (status ? `HTTP ${status}` : 'Provider request failed');
  const haystack = `${code || ''} ${message}`.toLowerCase();
  const provider = input.provider;

  if (looksLikeNetworkError(haystack)) return cls('network', 'network', true, status, code, message, provider);
  if (status === 408 || /timeout|timed out|etimedout/.test(haystack)) return cls('timeout', 'timeout', true, status, code, message, provider);
  if (/content[_ -]?filter|safety|moderation|blocked/.test(haystack)) return cls('content_filter', 'validation', false, status, code, message, provider);
  if (/context[_ -]?length|maximum context|too many tokens|token limit/.test(haystack)) return cls('context_length', 'validation', false, status, code, message, provider);
  if (isQuotaCode(code)) return cls('quota_exceeded', 'upstream', false, status, code, message, provider);
  if (status === 401 || /invalid api key|authentication|unauthorized/.test(haystack)) return cls('authentication', 'validation', false, status, code, message, provider);
  if (status === 403 || /permission|forbidden/.test(haystack)) return cls('permission', 'validation', false, status, code, message, provider);
  if (status === 404 || /model[_ -]?not[_ -]?found|not found/.test(haystack)) return cls('not_found', 'upstream', false, status, code, message, provider);
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(haystack)) return cls('rate_limit', 'upstream', true, status, code, message, provider);
  if (status === 529 || /overloaded|server busy|capacity/.test(haystack)) return cls('overloaded', 'upstream', true, status, code, message, provider);
  if (status === 409 || status === 425 || (status !== undefined && status >= 500)) return cls('server', 'upstream', true, status, code, message, provider);
  if (status === 400 || status === 422 || /invalid[_ -]?request|bad request/.test(haystack)) return cls('invalid_request', 'validation', false, status, code, message, provider);
  return cls('unknown', 'unknown', false, status, code, message, provider);
}

export function classifyProviderResponse(status: number, body: unknown, provider?: string): ProviderErrorClassification {
  return classifyProviderError({ status, body, provider });
}

function cls(
  kind: ProviderErrorKind,
  category: ProviderErrorClassification['category'],
  retryable: boolean,
  status: number | undefined,
  code: string | undefined,
  message: string,
  provider?: string,
): ProviderErrorClassification {
  return {
    kind,
    category,
    retryable,
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    message,
    ...(provider ? { provider } : {}),
  };
}

function extractProviderError(value: unknown, fallback?: string): { message?: string; code?: string } {
  if (typeof value === 'string') return { message: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback ? { message: fallback } : {};
  const root = value as Record<string, any>;
  const nested = root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? root.error as Record<string, any> : root;
  const message = stringOrUndef(nested.message ?? nested.msg ?? root.message ?? root.msg ?? fallback);
  const code = stringOrUndef(nested.code ?? nested.type ?? root.code ?? root.type);
  return { ...(message ? { message } : {}), ...(code ? { code } : {}) };
}

function codeFromBody(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const root = value as Record<string, any>;
  return stringOrUndef(root.code ?? root.type ?? root.error?.code ?? root.error?.type);
}

function isQuotaCode(code?: string): boolean {
  return Boolean(code && /insufficient_quota|quota_exceeded|billing|credit/.test(code));
}

function looksLikeNetworkError(text: string): boolean {
  return /econnreset|econnrefused|enotfound|eai_again|enetunreach|socket hang up|network error|fetch failed|dns/.test(text);
}

function validStatus(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : undefined;
}

function stringOrUndef(value: unknown): string | undefined {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || undefined;
}
