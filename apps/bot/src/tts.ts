import type { BotTtsConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface TtsRequestPlan {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  format: string;
}

export interface TtsAudio {
  /** napcat record 段可用的文件引用(base64://...)。 */
  file: string;
  format: string;
  bytes: number;
}

export interface TtsSynthesizeOptions {
  fetchImpl?: typeof fetch;
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
}

function normalizeTtsApiUrl(value: string | undefined, provider: 'fish-audio' | 'openai-compatible'): string {
  const raw = String(value || '').trim();
  if (raw) return raw;
  return provider === 'fish-audio' ? 'https://api.fish.audio/v1/tts' : 'https://api.openai.com/v1/audio/speech';
}

export function activeFishVoiceId(tts: BotTtsConfig): string {
  const direct = String(tts.voiceId || '').trim();
  if (direct) return direct;
  const first = (tts.voiceIds || []).map((v) => String(v || '').trim()).find(Boolean);
  return first || '';
}

/** Fish Audio 主音色 + 备用音色，去重且保持顺序。 */
export function fishVoiceCandidates(tts: BotTtsConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [tts.voiceId, ...(tts.voiceIds || [])]) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 是否应对这段文本走 TTS:开启 + 文本非空且不过长 + 对应 provider 有可用音色。 */
export function shouldUseTts(tts: BotTtsConfig, text: string): boolean {
  if (!tts || !tts.enabled) return false;
  const clean = String(text || '').trim();
  if (!clean) return false;
  const maxChars = Math.max(1, Number(tts.autoTextMaxChars || 180));
  if (clean.length > maxChars) return false;
  if (tts.provider === 'fish-audio') return Boolean(activeFishVoiceId(tts));
  return Boolean(String(tts.voice || tts.voiceId || '').trim());
}

/** 纯函数: 构造 TTS HTTP 请求计划(便于单测,不发网络)。 */
export function buildTtsRequest(tts: BotTtsConfig, text: string): TtsRequestPlan {
  const provider: 'fish-audio' | 'openai-compatible' = tts.provider === 'openai-compatible' ? 'openai-compatible' : 'fish-audio';
  const format = ['mp3', 'wav', 'opus'].includes(String(tts.format || '').toLowerCase()) ? String(tts.format).toLowerCase() : 'mp3';
  const apiKey = String(tts.apiKey || '').trim();
  const url = normalizeTtsApiUrl(tts.apiUrl, provider);
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  let body: Record<string, unknown>;
  if (provider === 'fish-audio') {
    // Fish Audio 的模型 ID 走 HTTP 请求头，不是 JSON body。
    // s2.1-pro-free 在 2026-11-30 前按官方文档为 $0，默认不要再落回收费的 s2-pro。
    headers.model = String(tts.model || 's2.1-pro-free').trim() || 's2.1-pro-free';
    body = {
      text,
      reference_id: activeFishVoiceId(tts),
      format,
      normalize: true,
      latency: tts.latency || 'normal',
      prosody: { speed: Number(tts.speed || 1), volume: Number(tts.volume || 0), normalize_loudness: true },
    };
  } else {
    body = {
      model: String(tts.model || 'tts-1').trim() || 'tts-1',
      voice: String(tts.voice || tts.voiceId || 'alloy').trim() || 'alloy',
      input: text,
      response_format: format,
      speed: Number(tts.speed || 1),
    };
  }
  return { url, headers, body, format };
}

/** 合成语音,返回 napcat record 可用的 base64:// 文件引用。 */
export async function synthesizeSpeech(
  tts: BotTtsConfig,
  text: string,
  options: TtsSynthesizeOptions = {},
): Promise<TtsAudio> {
  const provider: 'fish-audio' | 'openai-compatible' = tts.provider === 'openai-compatible' ? 'openai-compatible' : 'fish-audio';
  const timeoutMs = Math.max(5000, Number(tts.timeoutMs || 60000));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('TTS fetch is unavailable');

  const attempts = provider === 'fish-audio'
    ? fishVoiceCandidates(tts).map((voiceId) => ({ ...tts, voiceId, voiceIds: [] }))
    : [tts];
  if (!attempts.length) throw new Error('Fish Audio voice ID 未配置');

  let lastError: Error | undefined;
  for (let index = 0; index < attempts.length; index += 1) {
    const attemptTts = attempts[index]!;
    const plan = buildTtsRequest(attemptTts, text);
    const model = provider === 'fish-audio'
      ? String(plan.headers.model || '')
      : String((plan.body as Record<string, unknown>).model || '');
    const voiceId = provider === 'fish-audio'
      ? activeFishVoiceId(attemptTts)
      : String(attemptTts.voice || attemptTts.voiceId || 'alloy');
    const startedAt = Date.now();

    options.logger?.info('TTS request', {
      provider,
      model,
      modelHeader: provider === 'fish-audio' ? model : undefined,
      format: plan.format,
      voiceId: maskVoiceId(voiceId),
      textChars: text.length,
      attempt: index + 1,
      attempts: attempts.length,
    });

    let response: Response;
    try {
      response = await fetchImpl(plan.url, {
        method: 'POST',
        headers: plan.headers,
        body: JSON.stringify(plan.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      throw lastError;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      lastError = new Error(`TTS HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      if (provider === 'fish-audio' && index < attempts.length - 1 && isRetryableFishVoiceStatus(response.status)) {
        options.logger?.warn('TTS voice failed; trying fallback voice', {
          status: response.status,
          voiceId: maskVoiceId(voiceId),
          nextAttempt: index + 2,
          error: lastError.message,
        });
        continue;
      }
      throw lastError;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('TTS returned empty audio');
    options.logger?.info('TTS request completed', {
      provider,
      model,
      format: plan.format,
      voiceId: maskVoiceId(voiceId),
      chars: text.length,
      durationMs: Date.now() - startedAt,
      bytes: buffer.length,
    });
    return { file: `base64://${buffer.toString('base64')}`, format: plan.format, bytes: buffer.length };
  }

  throw lastError || new Error('TTS failed');
}

function isRetryableFishVoiceStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

function maskVoiceId(value: string): string {
  const id = String(value || '').trim();
  if (!id) return '';
  if (id.length <= 8) return `${id.slice(0, 2)}***${id.slice(-2)}`;
  return `${id.slice(0, 4)}***${id.slice(-4)}`;
}