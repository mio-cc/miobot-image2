import type { AppConfig, BotTtsConfig, BotTtsPreprocessConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { toMainModelSelection } from './config-bridge.js';

/** 渲染 TTS 前置处理提示词，占位符只接受 {{text}}。 */
export function renderTtsPreprocessPrompt(template: string, text: string): string {
  // {{text}} 是整段待处理正文：其后若还有同行内容（如生产模板出现过的「{{text}}4.人物…」补充指令），
  // 强制以换行分隔，避免指令拼进正文、边界全靠模型猜（2026-11-07 坑）。
  // 归一化层 normalizeTtsPreprocessTemplate 对存量配置做同规则治愈，这里是不经过归一化的最后防线。
  const separated = String(template || '').replace(/(\{\{\s*text\s*\}\})[ \t]*(?=[^\r\n])/g, '$1\n');
  return separated.replace(/\{\{\s*text\s*\}\}/g, () => String(text || ''));
}

/**
 * 「跟随」语义（2026-11-06 拍板）：preprocess.model 为空 = 用户在用途表点了「恢复跟随」，
 * 节点与模型都跟主对话走（与 trigger-intent.ts chatNode() 同款先例；ModelsPage 用途表
 * 「未选择 → 回落主对话」的公开承诺）。此前运行时把空当「跳过改写」，与面板语义割裂——
 * 966 字原文零处理直送 TTS 的实测根因。主对话也没配时返回空 model，由调用方门控降级。
 */
export function resolveTtsPreprocessTarget(pre: BotTtsPreprocessConfig | undefined, cfg: AppConfig): { nodeIndex: number; model: string } {
  const own = String(pre?.model || '').trim();
  if (own) return { nodeIndex: Number(pre?.nodeIndex) || 0, model: own };
  const main = toMainModelSelection(cfg);
  return { nodeIndex: main.nodeIndex, model: main.model };
}

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
export function ttsTimeoutForText(tts: Pick<BotTtsConfig, 'timeoutMs'>, textLength: number): number {
  const configured = Math.max(5000, Number(tts.timeoutMs || 60000));
  return Math.min(300000, Math.max(configured, 30000 + Math.max(0, textLength) * 150));
}
export async function synthesizeSpeech(
  tts: BotTtsConfig,
  text: string,
  options: TtsSynthesizeOptions = {},
): Promise<TtsAudio> {
  const provider: 'fish-audio' | 'openai-compatible' = tts.provider === 'openai-compatible' ? 'openai-compatible' : 'fish-audio';
  const timeoutMs = ttsTimeoutForText(tts, text.length);
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

/**
 * 把「给眼睛看的回复」转成「给耳朵听的文本」——TTS 前的最后一道闸（2026-11-19）。
 *
 * 线上时测：回复里夹着 https 链接、markdown 表格、代码围栏、`[图片]` 占位符，
 * 而 voice() 里原来是 `let speakText = text`，原文直送合成，于是语音会念出
 * 「https 冒号 斜杠 斜杠 …」「竖线 竖线」这种东西。
 *
 * 这里只改「念什么」，不改「发什么」：文字回复里的链接、表格照常显示，只有语音被净化。
 * 纯函数，便于单测（见 tests/tts-speech-text.test.mjs）。
 */
export function toSpeechText(input: string): string {
  let text = String(input || '');

  // 1) 代码块整段丢弃：念代码没有任何意义。但留一句占位，
  //    否则「配置如下：」后面直接跳走，听着像断线。
  text = text.replace(/```[\s\S]*?```/g, '（示例代码见文字回复）');
  text = text.replace(/~~~[\s\S]*?~~~/g, '（示例代码见文字回复）');

  // 2) QQ 的 CQ 码与内部占位符：这些是给链路看的，不是给人听的。
  text = text.replace(/\[CQ:[^\]]*\]/gi, ' ');
  text = text.replace(/\[(?:图片|视频|语音|文件|合并转发|表情|历史图片|图片已省略)(?:[:：][^\]]*)?\]/g, ' ');

  // 3) 图片语法整条丢弃，链接语法只留文字。
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
  // 尖括号包起来的自动链接 <https://…>
  text = text.replace(/<(?:https?|ftp):\/\/[^>\s]+>/gi, ' ');

  // 4) 裸链接与裸域名：念出来就是灾难。
  text = text.replace(/\b(?:https?|ftp|file|data):\/\/[^\s，。、；：？！）】"]+/gi, ' ');
  text = text.replace(/\bwww\.[^\s，。、；：？！）】"]+/gi, ' ');
  // 不带协议头的裸域名（实测模型常写「IT之家 — ithome.com」），念出来是「点 com」。
  // 用 TLD 白名单而不是「任意 xxx.yyy」——否则 Node.js / package.json 这类会被误删。
  text = text.replace(/\b(?:[\w-]+\.)+(?:com|cn|net|org|io|ai|dev|app|co|me|tv|cc|xyz|info|ly|to|tw|jp|so|gg|fm|site|top|vip|edu|gov|us|uk|de|fr|ru|kr|in|au|ca|br|it|nl|se|no|fi|dk|pl|cz|es|pt|gr|tr|il|ae|sa|sg|hk|mo|my|th|vn|id|ph|pk|bd|lk|np)\b(?:\/[\w\-.~%&=?#]*)?/gi, ' ');
  text = text.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, ' ');   // 邮箱同理

  // 5) Markdown 表格：分隔行直接丢，数据行把竖线读成停顿。
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line))
    .map((line) => (/^\s*\|.*\|\s*$/.test(line)
      ? line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim()).filter(Boolean).join('，')
      : line))
    .join('\n');

  // 6) 行级标记：标题、引用、分隔线、列表符号。
  text = text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ')
    .replace(/^\s{0,3}[-*+]\s+/gm, '');

  // 7) 行内标记：加粗/斜体/删除线/行内代码的反引号（内容保留）。
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1');

  // 8) 零宽字符、变体选择符与 emoji：语音模型对它们行为不可预期
  //    （实测残留的 🔗 会单独占一行，合成出来是一声怪响）。
  text = text.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufe0e\ufe0f]/g, '');
  text = text.replace(/[\u2190-\u21ff\u2300-\u23ff\u2600-\u27bf\u2b00-\u2bff\ufe0f]/g, '');
  text = text.replace(/[\u{1f000}-\u{1faff}]/gu, '');

  // 9) 逐行丢弃两类噪音行：
  //    a. 净化后没有任何文字/数字（只剩 🔗、「-」、空标题等）；
  //    b. 只剩「标签：」没有内容的孤儿行（链接被摘掉后的「网易云：」「YouTube：」）。
  //    实测这两类都会让语音念出无意义的尾巴。
  text = text
    .split(/\r?\n/)
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .filter((line) => !/^\s*[^：:\n]{1,32}[：:]\s*$/.test(line))
    .join('\n');

  // 10) 空白收敛：多余空行会让语音出现莫名的长停顿。
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  // 11) 只剩标点（例如整条回复只有链接）→ 视为无可念内容。
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  return text;
}
