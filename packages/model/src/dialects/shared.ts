import { ModelError, type ImageArtifact, type ImageResult, type ModelNode, type RequestPlan, type TextResult, type VideoArtifact, type VideoJobStatus, type VideoResult } from '../ports.js';

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
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key');
  if (apiKey && !hasAuth) headers.Authorization = `Bearer ${apiKey}`;
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
    // T3.2：FC 出参——tool_calls 优先（此时 content 通常为 null）；arguments 容错解析。
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls = rawCalls.map((raw: unknown) => {
      const call = asRecord(raw);
      const fn = asRecord(call.function);
      let args: Record<string, unknown> = {};
      if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
        try { args = JSON.parse(fn.arguments) as Record<string, unknown>; } catch { args = {}; }
      } else if (fn.arguments && typeof fn.arguments === 'object') {
        args = fn.arguments as Record<string, unknown>;
      }
      return { ...(call.id ? { id: String(call.id) } : {}), name: String(fn.name || ''), arguments: args };
    }).filter((call) => call.name);
    if (toolCalls.length) return { text: '', raw: data, toolCalls };
    const text = flattenTextContent(message.content ?? item.text);
    if (text.trim()) return { text, raw: data };
    // 部分推理模型把正文放在 reasoning_content 里。注意 content 常常是空字符串而不是 null，
    // 用 ?? 串联取不到这个兜底，必须显式判空。
    const reasoning = flattenTextContent(message.reasoning_content);
    if (reasoning.trim()) return { text: reasoning, raw: data };
  }

  // 到这里说明没取到正文。下面两种情况很常见，必须给出说得清的原因，
  // 否则用户只会看到一句「missing choices」，完全不知道发生了什么。
  if (!choices.length) {
    // Gemini 经 OpenAI 兼容层做安全拦截时会返回 200 + 空 choices，真实原因在 prompt_feedback 里。
    const feedback = root.prompt_feedback ?? root.promptFeedback;
    if (feedback !== undefined) {
      throw new ModelError(`上游拒绝生成（可能触发内容安全策略）：${safeJson(feedback)}`, {
        category: 'upstream', retryable: false, code: 'content_filtered',
      });
    }
    throw new ModelError(`上游返回了空 choices：${safeJson(data).slice(0, 400)}`, {
      category: 'upstream', retryable: false, code: 'empty_choices',
    });
  }

  const finishReason = String(asRecord(choices[0]).finish_reason ?? '').toLowerCase();
  if (finishReason === 'length') {
    // 推理模型的推理 token 与正文共用输出额度，给小了就会推理没跑完先被截断。
    throw new ModelError('输出被 token 上限截断（推理模型请调大输出预算）', {
      category: 'validation', retryable: false, code: 'output_truncated',
    });
  }
  if (finishReason === 'content_filter') {
    throw new ModelError('上游内容安全策略拦截了本次输出', { category: 'upstream', retryable: false, code: 'content_filtered' });
  }

  throw new ModelError(`上游未返回文本内容（finish_reason=${finishReason || 'unknown'}）`, {
    category: 'validation', retryable: false, code: 'empty_content',
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

/**
 * 解析 OpenAI 风格 / xAI Grok Imagine 视频响应。
 * 兼容形态:
 * - 提交: { request_id } → pending
 * - 轮询: { status: "pending"|"done"|"failed"|"expired", video: { url, duration } }
 * - 即时: { data: [{ url | b64_json }] } / { video: { url } } / { url }
 *
 * 官方文档: POST /v1/videos/generations → GET /v1/videos/{request_id}
 * status: pending | done | failed | expired
 */
export function parseOpenAiVideo(data: unknown): VideoResult {
  const root = asRecord(data);
  const jobStatus = normalizeVideoJobStatus(root.status);
  const requestId = stringOrUndef(root.request_id ?? root.requestId ?? root.id);

  // 终端失败态须在 assertNoTopLevelError 之前：轮询响应常带 error 字段，
  // 若先 assert 会丢掉 video_failed/video_expired 专用 code。
  if (jobStatus === 'failed' || jobStatus === 'expired') {
    const errRec = asRecord(root.error);
    const detail = stringOrUndef(errRec.message ?? root.error ?? root.message) || jobStatus;
    throw new ModelError(`Video generation ${jobStatus}: ${detail}`, {
      category: 'upstream',
      retryable: false,
      code: jobStatus === 'expired' ? 'video_expired' : 'video_failed',
    });
  }

  assertNoTopLevelError(data);

  const items = Array.isArray(root.data) ? root.data
    : root.video ? [root.video]
      : root.url || root.b64_json || root.base64 ? [root]
        : [];
  const videos: VideoArtifact[] = [];
  items.forEach((item: unknown, index: number) => {
    const record = asRecord(item);
    if (record.error !== undefined) {
      const err = asRecord(record.error);
      throw new ModelError(`video data[${index}].error: ${String(err.message || record.error)}`, { category: 'upstream', retryable: true });
    }
    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : typeof record.mimeType === 'string' ? record.mimeType : 'video/mp4';
    if (typeof record.url === 'string' && record.url) {
      videos.push({ kind: 'url', data: record.url, mimeType, index, requestId: stringOrUndef(record.request_id ?? record.id) ?? requestId });
      return;
    }
    if (typeof record.b64_json === 'string' && record.b64_json) {
      videos.push({ kind: 'base64', data: record.b64_json, mimeType, index, requestId });
      return;
    }
    if (typeof record.base64 === 'string' && record.base64) {
      videos.push({ kind: 'base64', data: record.base64, mimeType, index, requestId });
    }
  });

  const hasPlayable = videos.some((v) => String(v.data || '').trim());
  if (hasPlayable) return { videos, raw: data, pending: false, jobStatus: jobStatus === 'unknown' ? 'done' : jobStatus };

  // 仍在生成 / 仅有 request_id
  if (jobStatus === 'pending' || requestId) {
    return {
      videos: [{ kind: 'url', data: '', mimeType: 'video/mp4', requestId: requestId || videos[0]?.requestId, index: 0 }],
      raw: data,
      pending: true,
      jobStatus: jobStatus === 'unknown' ? 'pending' : jobStatus,
    };
  }
  throw new ModelError('Video response missing data[]/url/request_id', { category: 'validation', retryable: false });
}

/** xAI / OpenAI 兼容：GET {baseUrl}/videos/{requestId} */
export function buildOpenAiVideoStatus(node: ModelNode, requestId: string): RequestPlan {
  const id = encodeURIComponent(String(requestId || '').trim());
  return {
    method: 'GET',
    url: joinUrl(node.baseUrl, `/videos/${id}`),
    headers: bearerHeaders(node.apiKey, node.headers),
  };
}

export function normalizeVideoJobStatus(value: unknown): VideoJobStatus {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s === 'done' || s === 'completed' || s === 'succeeded' || s === 'success') return 'done';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') return 'failed';
  if (s === 'expired') return 'expired';
  if (s === 'pending' || s === 'processing' || s === 'running' || s === 'queued' || s === 'in_progress') return 'pending';
  return 'unknown';
}

function stringOrUndef(value: unknown): string | undefined {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || undefined;
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
