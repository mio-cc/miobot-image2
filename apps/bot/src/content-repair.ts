import { isContentRejectionError, withPurposeFallback, type ModelFallbackController } from './model-fallback.js';
import type { ContentRejectionRegistry } from './content-rejection.js';
import { CONTENT_REJECTION_PLACEHOLDER } from './content-rejection.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/**
 * 内容审核修复管线（方案 D，2026-11-06 拍板）——「智能容错」。
 *
 * 执行顺序（用户钦定，不得更改）：请求失败 → 判定审核拒绝（复用 A② 的 isContentRejectionError，
 * 不建第二套判定）→ 先走既有切备救本次（发生在 modelPort.chat 内部的状态机层，本包装只收到
 * 「主+备都拒」后的最终错误）→ 备也拒/无备 → 修复一次（sanitize 用途，独立节点+模型+自己的备用）
 * → 改写后重试主模型一次（A② 保证审核不计数，重试必然从主档位开始）→ 仍败 → 登记 + 明确告知用户。
 *
 * 修复不可用（未配置 sanitize / 探针降级 / 修复调用失败）→ 降级为占位剥离重试一次 → 仍败 → 登记 + 告知。
 * 网络类失败**绝不**进入本路径（isContentRejectionError 守门）。
 * 防循环：每个请求对象只允许一次修复/剥离重试（WeakSet 标记），绝不递归修复修复结果。
 * 改写结果按原文 hash 缓存在登记表（同类内容二次零修复调用），旁挂映射：只在发模型时替换，
 * 原文在群记录与审计日志留痕，删登记条目即回滚。
 */

/** 用户可见文案前缀（agent runtime 全程透传 error.message；runtime 据此前缀识别并发送明确回复）。 */
export const CONTENT_REJECTION_EXHAUSTED_PREFIX = 'content_rejection_exhausted:';
export const CONTENT_REJECTION_EXHAUSTED_NOTICE =
  '刚才那条消息触发了上游内容审核，自动改写后仍未通过；相关内容已从上下文中略去，请调整措辞（或换个说法）后再发。';

/** 已知会触发审核的中文探针样本：验证修复模型自身能处理这类内容（不同审核边界）。 */
export const SANITIZE_PROBE_SAMPLE = '他破口大骂了一句脏话，接着绘声绘色地描述了一段血腥的打斗场面，细节非常露骨。';

const SANITIZE_SYSTEM_PROMPT = [
  '你是内容安全改写器。用户给你的这段文本会因触发上游内容审核而被拒绝。',
  '请改写它：保留原意与对话作用，把直白、露骨、容易触发审核的表达替换成含蓄的说法；',
  '不得添加原文没有的信息，不得改变事实，不得解释；篇幅与原文相当（可略短）。',
  '只输出改写后的正文，不要任何说明、引号或 markdown。',
].join('\n');

/** 歌词修复的附加约束（批 3：Suno 400 审核后改写歌词再提交）。 */
export const SUNO_LYRICS_SYSTEM_HINT =
  '本次改写对象是歌词。保留段落结构标记（[Intro]/[Verse]/[Chorus] 等）、押韵、语言与主题故事；只把容易触发内容审核的直白表达改含蓄，不改歌名与整体风格。';

export interface SanitizeCallOptions {
  /** 歌词等特殊文体的额外约束（system 提示附加段）。 */
  systemHint?: string;
  timeoutMs?: number;
}

/** 修复调用器：读 llm.sanitizeModel（空 = 不启用修复，返回 null）；走 sanitize 用途的独立备用状态机。 */
export function createSanitizeCall(client: ModelClient, getConfig: () => AppConfig, fallback: ModelFallbackController | undefined, logger?: StructuredLogger) {
  return async (input: string, options?: SanitizeCallOptions): Promise<string | null> => {
    const llm = getConfig().llm;
    const model = String(llm.sanitizeModel || '').trim();
    if (!model) return null;
    const nodeIndex = Number(llm.sanitizeNodeIndex) || 0;
    const call = (target: { nodeIndex: number; model: string }) => client.chat(target.nodeIndex, {
      model: target.model,
      messages: [
        { role: 'system', content: options?.systemHint ? `${SANITIZE_SYSTEM_PROMPT}\n${options.systemHint}` : SANITIZE_SYSTEM_PROMPT },
        { role: 'user', content: String(input || '').slice(0, 8000) },
      ],
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: options?.timeoutMs ?? 30_000,
    });
    // P2 接入点：purpose = 'sanitize'（常量显式，第 13 用途；备用取 llm.fallbackSanitize*）。
    const res = fallback
      ? await withPurposeFallback(fallback, 'sanitize', { nodeIndex, model }, call)
      : await call({ nodeIndex, model });
    const text = String(res.text || '').trim().replace(/^```(?:text|json)?/i, '').replace(/```$/i, '').trim();
    if (!text) {
      logger?.warn('content.repair', { event: 'empty_rewrite', model });
      return null;
    }
    return text.slice(0, 8000);
  };
}

type ChatMessage = { role: string; content: unknown };
type ChatRequest = { messages: ChatMessage[]; [key: string]: unknown };

function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text || '');
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

/** 替换一条消息的文本部分：字符串 content 整体替换；多模态数组只替换 text 项，图片等附件保留。 */
function replaceMessageText(message: ChatMessage, newText: string): ChatMessage {
  if (typeof message.content === 'string') return { ...message, content: newText };
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((part) => (typeof part === 'string' || (part && typeof part === 'object' && 'text' in part) ? { type: 'text', text: newText } : part)),
    };
  }
  return { ...message, content: newText };
}

/** 元凶定位主路径（零额外调用）：最后一条 user 消息 = 本轮新消息 + 其引用/合并转发展开。 */
function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

export interface ContentRepairOptions {
  registry: ContentRejectionRegistry;
  /** 修复调用器（未配置 sanitize 模型时传 undefined 或返回 null 的函数 → 降级占位剥离）。 */
  sanitize?: (input: string, options?: SanitizeCallOptions) => Promise<string | null>;
  /** 二分裁切开关（llm.sanitizeBisectEnabled）：改写/占位重试仍拒时逐段二分定位元凶（≤4 次探测）。 */
  bisectEnabled?: () => boolean;
  logger?: StructuredLogger;
  placeholder?: string;
  /** 修复次数上限（防循环；默认 1，每请求对象只修一次）。 */
  maxRepairs?: number;
  clock?: () => number;
}

export class ContentRepairExhaustedError extends Error {
  constructor(notice: string) {
    super(`${CONTENT_REJECTION_EXHAUSTED_PREFIX}${notice}`);
    this.name = 'ContentRepairExhaustedError';
  }
}

/** 探针状态（进程级缓存）：unknown 未探 / ok 可用 / degraded 本进程内降级（重启即重试）。 */
interface ProbeState { status: 'unknown' | 'ok' | 'degraded' }

/**
 * 包装 agent model port：审核拒绝 → （切备已在此前发生）→ 修复一次/占位剥离一次 → 仍败 → 登记 + 明确告知。
 * 网络/鉴权类失败原样抛出，绝不进入本路径。main 链的失败 turn 不落盘语义不变（本包装不碰会话）。
 */
export function wrapModelPortWithContentRepair<P extends object>(port: P, options: ContentRepairOptions): P {
  const { registry, sanitize, logger } = options;
  const placeholder = options.placeholder || CONTENT_REJECTION_PLACEHOLDER;
  const repairedRequests = new WeakSet<object>();
  const probe: ProbeState = { status: 'unknown' };

  async function probeSanitizer(): Promise<boolean> {
    if (probe.status === 'ok') return true;
    if (probe.status === 'degraded') return false; // 本进程内降级不再探（重启即重试）
    if (!sanitize) return false;
    try {
      const out = await sanitize(SANITIZE_PROBE_SAMPLE, { timeoutMs: 20_000 });
      if (out && out.trim()) {
        probe.status = 'ok';
        logger?.info('content.repair', { event: 'probe_ok' });
        return true;
      }
      probe.status = 'degraded';
      logger?.warn('content.repair', { event: 'probe_failed', reason: 'empty_rewrite' });
      return false;
    } catch (error) {
      probe.status = 'degraded';
      logger?.warn('content.repair', { event: 'probe_failed', reason: String((error as Error)?.message || error).slice(0, 200) });
      return false;
    }
  }

  /**
   * 二分裁切（升级路径②）：对元凶消息按空行分段，保留前半探测——仍拒=元凶在前半，否则在后半；
   * 收敛到单段返回之。探测直接打 port（不经 wrap，无递归），maxTokens 压到 64（只判审核，内容丢弃）。
   * 预算硬顶 4 次探测（≤16 段可完整收敛）；探测遇网络类异常立即中止（环境不可靠，按原逻辑告知）。
   */
  async function bisectCulprit(request: ChatRequest, messages: ChatMessage[], culpritIndex: number, culpritText: string, retryError: unknown): Promise<string | null> {
    if (!options.bisectEnabled?.()) return null;
    if (!isContentRejectionError(retryError)) return null;
    const segments = culpritText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    if (segments.length < 4 || segments.length > 16) return null;
    let probes = 0;
    const stillRejected = async (kept: string[]): Promise<boolean> => {
      const probeMessages = [...messages];
      probeMessages[culpritIndex] = replaceMessageText(messages[culpritIndex], kept.join('\n\n'));
      const probeRequest: ChatRequest = { ...request, messages: probeMessages, maxTokens: 64 };
      probes += 1;
      try {
        await (port as unknown as { chat: (req: ChatRequest) => Promise<unknown> }).chat(probeRequest);
        return false;
      } catch (error) {
        if (isContentRejectionError(error)) return true;
        throw error;
      }
    };
    try {
      let lo = 0;
      let hi = segments.length - 1;
      while (lo < hi && probes < 4) {
        const mid = lo + ((hi - lo) >> 1);
        if (await stillRejected(segments.slice(lo, mid + 1))) hi = mid;
        else lo = mid + 1;
      }
      if (lo !== hi) return null;
      logger?.info('content.repair', { event: 'bisect_located', probes, segmentIndex: lo, segments: segments.length });
      return segments[lo];
    } catch {
      logger?.info('content.repair', { event: 'bisect_aborted', probes });
      return null;
    }
  }

  const wrappedChat = async (request: ChatRequest): Promise<unknown> => {
    try {
      return await (port as unknown as { chat: (req: ChatRequest) => Promise<unknown> }).chat(request);
    } catch (error) {
      // 守门：只有内容审核类拒绝进入修复/剥离路径；网络/超时/鉴权等原样抛出（反例测试钉死）。
      if (!isContentRejectionError(error)) throw error;
      const reason = String((error as Error)?.message || error);
      const messages = Array.isArray(request?.messages) ? request.messages : [];
      const culpritIndex = lastUserIndex(messages);
      const culpritText = culpritIndex >= 0 ? contentTextOf(messages[culpritIndex].content) : '';

      // 已修复/剥离过的请求仍拒：登记 + 明确告知，不再循环。
      if (repairedRequests.has(request) || culpritIndex < 0 || !culpritText.trim()) {
        registry.register({ text: culpritText || '(unknown)', reason });
        logger?.info('content.repair', { event: 'exhausted', via: repairedRequests.has(request) ? 'after_retry' : 'no_user_message' });
        throw new ContentRepairExhaustedError(CONTENT_REJECTION_EXHAUSTED_NOTICE);
      }

      let rewritten: string | null = null;
      let via: 'repair' | 'placeholder' = 'placeholder';

      // 修复路径：sanitize 配置存在 + 探针通过（探针只做一次，降级冷却期内直接走占位剥离）。
      if (sanitize) {
        const cached = registry.entryOf(culpritText)?.rewrite;
        if (cached) {
          rewritten = cached;
          logger?.info('content.repair', { event: 'cache_hit' });
        } else if (await probeSanitizer()) {
          try {
            rewritten = await sanitize(culpritText);
            if (rewritten) registry.setRewrite(culpritText, rewritten);
            logger?.info('content.repair', { event: rewritten ? 'attempt_success' : 'attempt_empty' });
          } catch (repairError) {
            logger?.warn('content.repair', { event: 'attempt_failed', error: String((repairError as Error)?.message || repairError).slice(0, 200) });
          }
        }
      }
      if (rewritten) via = 'repair';
      else rewritten = placeholder;

      const retryMessages = [...messages];
      retryMessages[culpritIndex] = replaceMessageText(messages[culpritIndex], rewritten);
      const retryRequest: ChatRequest = { ...request, messages: retryMessages };
      repairedRequests.add(retryRequest);
      logger?.info('content.repair', { event: 'retry', via, previewChars: culpritText.length });

      try {
        const result = await (port as unknown as { chat: (req: ChatRequest) => Promise<unknown> }).chat(retryRequest);
        logger?.info('content.repair', { event: 'rescued', via });
        return result;
      } catch (retryError) {
        // 二分裁切（2026-11-06 二轮，升级路径②）：改写/占位重试仍拒且消息够长（≥4 段）时，
        // 对元凶消息逐段二分定位最小触发段（≤4 次探测，开关 llm.sanitizeBisectEnabled）——
        // 成功则登记该段并剥离重试（保留消息其余段落），失败或开关关闭按原逻辑告知。
        const bisectSegment = await bisectCulprit(request, messages, culpritIndex, culpritText, retryError);
        if (bisectSegment !== null) {
          registry.register({ text: bisectSegment, reason: 'moderation_bisected' });
          const maskedText = culpritText.replace(bisectSegment, placeholder).trim() || placeholder;
          const bisectMessages = [...messages];
          bisectMessages[culpritIndex] = replaceMessageText(messages[culpritIndex], maskedText);
          const bisectRequest: ChatRequest = { ...request, messages: bisectMessages };
          repairedRequests.add(bisectRequest);
          logger?.info('content.repair', { event: 'bisect_retry', segmentChars: bisectSegment.length });
          try {
            const result = await (port as unknown as { chat: (req: ChatRequest) => Promise<unknown> }).chat(bisectRequest);
            logger?.info('content.repair', { event: 'rescued', via: 'bisect' });
            return result;
          } catch (bisectError) {
            registry.register({ text: culpritText, reason: String((bisectError as Error)?.message || bisectError) });
            logger?.info('content.repair', { event: 'exhausted', via: 'bisect' });
            throw new ContentRepairExhaustedError(CONTENT_REJECTION_EXHAUSTED_NOTICE);
          }
        }
        // 修复/剥离重试仍失败：登记原文（下一轮起装配处剥离 + 记忆清理），明确告知用户，绝不静默。
        registry.register({ text: culpritText, reason: String((retryError as Error)?.message || retryError) });
        logger?.info('content.repair', { event: 'exhausted', via });
        throw new ContentRepairExhaustedError(CONTENT_REJECTION_EXHAUSTED_NOTICE);
      }
    }
  };

  return new Proxy(port, {
    get(target, prop, receiver) {
      if (prop === 'chat') return wrappedChat;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as P;
}
