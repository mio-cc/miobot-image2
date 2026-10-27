import type { ReplyPlanOptions } from './reply-plan.js';
import type { ReplyPlanPolicy } from './types.js';

export type ReplyModePreference = 'auto' | 'direct' | 'quote' | 'plain' | 'forward';
export type ReplyForwardPreference = 'auto' | 'nested' | 'flat';
export type ReplyVoicePreference = 'auto' | 'on' | 'off';
export type ReplyReferencePreference = 'auto' | 'quote' | 'none';

export interface ReplyPreferenceLike {
  mode?: ReplyModePreference;
  forwardStyle?: ReplyForwardPreference;
  voice?: ReplyVoicePreference;
  reference?: ReplyReferencePreference;
  scope?: 'turn' | 'session' | 'user';
}

export interface ReplyPolicyConfigLike {
  replyPolicy: {
    enabled: boolean;
    allowModelOverride: boolean;
    allowSessionPreferences: boolean;
    allowUserPreferences: boolean;
    defaultVoice: ReplyVoicePreference;
    forcedForwardThreshold: number;
    hardMaxChars: number;
    hardMaxMessages: number;
  };
  orchestration: {
    reply: {
      maxMessages: number;
      maxResultItems: number;
      preferNestedForward: boolean;
      includeTruncationNotice: boolean;
      nestedMaxNodes: number;
      nestedMaxDepth: number;
      overflowPolicy: 'truncate' | 'link' | 'zip' | 'reject' | 'forward';
      textFallback: 'always' | 'on_forward_fail' | 'off';
    };
  };
  bot: { textReply: { maxChars: number }; replyStrategies: { text: 'forward' | 'at' | 'quote' | 'plain' | 'text-image' } };
}

export interface ReplyPolicyResolveInput {
  config: ReplyPolicyConfigLike;
  textChars?: number;
  turnPreference?: ReplyPreferenceLike;
  sessionPreference?: ReplyPreferenceLike;
  userPreference?: ReplyPreferenceLike;
}

export interface ResolvedReplyPolicy {
  options: ReplyPlanOptions;
  policy: ReplyPlanPolicy;
}

export function resolveReplyPolicy(input: ReplyPolicyResolveInput): ResolvedReplyPolicy {
  const cfg = input.config;
  const enabled = cfg.replyPolicy.enabled === true;
  const turn = enabled && cfg.replyPolicy.allowModelOverride ? input.turnPreference : undefined;
  const session = enabled && cfg.replyPolicy.allowSessionPreferences ? input.sessionPreference : undefined;
  const user = enabled && cfg.replyPolicy.allowUserPreferences ? input.userPreference : undefined;
  // P0-3 根因A（R12 修复）：后台默认 bot.replyStrategies.text 必须进入 Agent 的回复策略。
  // 无任何显式偏好（turn/session/user）时，mode 兜底到后台文本策略：
  // forward→forward（合并转发），quote→quote，direct/plain→direct；auto 保持自动。
  // 优先级：协议硬约束 > turn 请求 > session/user 偏好 > 后台默认（不变）。
  const backendTextMode = String(cfg.bot?.replyStrategies?.text || 'plain').trim() as 'forward' | 'at' | 'quote' | 'plain' | 'text-image';
  const backendMode: ReplyModePreference = backendTextMode === 'forward' ? 'forward' : backendTextMode === 'quote' ? 'quote' : backendTextMode === 'at' ? 'quote' : backendTextMode === 'plain' ? 'direct' : 'auto';
  const mode = turn?.mode ?? session?.mode ?? user?.mode ?? backendMode;
  const forwardStyle = turn?.forwardStyle ?? session?.forwardStyle ?? user?.forwardStyle ?? 'auto';
  const voice = turn?.voice ?? session?.voice ?? user?.voice ?? (enabled ? cfg.replyPolicy.defaultVoice : 'auto');
  const reference = turn?.reference ?? session?.reference ?? user?.reference ?? 'auto';
  const textChars = Math.max(0, Math.trunc(Number(input.textChars) || 0));
  // P0-3（R9 修复）：文本超过阈值一律强制合并转发——mode=direct/plain 也不能绕过。
  // 只有显式 forward 或超阈值才进转发；无转发能力时的降级由发送层既有逻辑处理（分条 direct，
  // 仍受 hardMaxChars/hardMaxMessages/maxResultItems 限制；audio/file 永远 direct 不进 forward）。
  const forcedForward = enabled
    && (mode === 'auto' || mode === 'direct' || mode === 'plain' || mode === 'forward')
    && textChars >= Math.max(1, Math.trunc(Number(cfg.replyPolicy.forcedForwardThreshold) || 1800));

  const legacyMaxMessages = Math.max(1, Math.trunc(Number(cfg.orchestration.reply.maxMessages) || 3));
  const maxMessages = enabled
    ? Math.min(legacyMaxMessages, Math.max(1, Math.trunc(Number(cfg.replyPolicy.hardMaxMessages) || legacyMaxMessages)))
    : legacyMaxMessages;
  const legacyTextMaxChars = Math.max(0, Math.trunc(Number(cfg.bot.textReply.maxChars) || 0));
  const maxChars = enabled
    ? legacyTextMaxChars > 0
      ? Math.min(legacyTextMaxChars, Math.max(1, Math.trunc(cfg.replyPolicy.hardMaxChars)))
      : Math.max(1, Math.trunc(cfg.replyPolicy.hardMaxChars))
    : legacyTextMaxChars;

  let preferNestedForward = cfg.orchestration.reply.preferNestedForward !== false;
  if (forwardStyle === 'nested') preferNestedForward = true;
  else if (forwardStyle === 'flat') preferNestedForward = false;
  else if (mode === 'forward' || forcedForward) preferNestedForward = true;
  else if (mode === 'direct' || mode === 'plain' || mode === 'quote') preferNestedForward = false;

  let textFallback = cfg.orchestration.reply.textFallback || 'always';
  if (forcedForward || mode === 'forward') textFallback = 'off';
  else if (mode === 'direct' || mode === 'plain' || mode === 'quote') textFallback = 'always';

  return {
    options: {
      maxMessages,
      maxResultItems: cfg.orchestration.reply.maxResultItems,
      preferNestedForward,
      includeTruncationNotice: cfg.orchestration.reply.includeTruncationNotice,
      nestedMaxNodes: cfg.orchestration.reply.nestedMaxNodes,
      nestedMaxDepth: cfg.orchestration.reply.nestedMaxDepth,
      overflowPolicy: cfg.orchestration.reply.overflowPolicy,
      textMaxChars: maxChars,
      textFallback,
    },
    policy: {
      enabled,
      maxMessages,
      maxChars,
      mode,
      forwardStyle,
      voice,
      reference,
      forcedForward,
    },
  };
}

export function textCharsOf(outputs: Array<{ kind?: string; text?: string }>): number {
  return (outputs || []).reduce((sum, output) => sum + (output.kind === 'text' ? String(output.text || '').length : 0), 0);
}
