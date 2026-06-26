import type { BotTtsConfig } from '../../../packages/config/src/index.js';

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

/** 是否应对这段文本走 TTS:开启 + 文本非空且不超长 + 对应 provider 有可用音色。 */
export function shouldUseTts(tts: BotTtsConfig, text: string): boolean {
  if (!tts || !tts.enabled) return false;
  const clean = String(text || '').trim();
  if (!clean) return false;
  const maxChars = Math.max(1, Number(tts.autoTextMaxChars || 180));
  if (clean.length > maxChars) return false;
  if (tts.provider === 'fish-audio') return Boolean(activeFishVoiceId(tts));
  return Boolean(String(tts.voice || tts.voiceId || '').trim());
}

/** 纯函数:构造 TTS HTTP 请求计划(便于单测,不发网络)。 */
export function buildTtsRequest(tts: BotTtsConfig, text: string): TtsRequestPlan {
  const provider: 'fish-audio' | 'openai-compatible' = tts.provider === 'openai-compatible' ? 'openai-compatible' : 'fish-audio';
  const format = ['mp3', 'wav', 'opus'].includes(String(tts.format || '').toLowerCase()) ? String(tts.format).toLowerCase() : 'mp3';
  const apiKey = String(tts.apiKey || '').trim();
  const url = normalizeTtsApiUrl(tts.apiUrl, provider);
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  let body: Record<string, unknown>;
  if (provider === 'fish-audio') {
    headers.model = String(tts.model || 's2-pro').trim() || 's2-pro';
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
export async function synthesizeSpeech(tts: BotTtsConfig, text: string): Promise<TtsAudio> {
  const plan = buildTtsRequest(tts, text);
  const timeoutMs = Math.max(5000, Number(tts.timeoutMs || 60000));
  const response = await fetch(plan.url, {
    method: 'POST',
    headers: plan.headers,
    body: JSON.stringify(plan.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`TTS HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('TTS returned empty audio');
  return { file: `base64://${buffer.toString('base64')}`, format: plan.format, bytes: buffer.length };
}
