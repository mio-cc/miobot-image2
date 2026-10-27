import { normalizeToolSpec, type ToolSpec } from '../../tool-runtime/src/index.js';
import type { AgentReplyPreference } from './types.js';

export const REPLY_PRESENTATION_TOOL_NAME = 'reply.presentation';

/**
 * P0-2（R9 修复）：模型表达回复表现偏好的唯一入口。
 * 只更新当前 turn/session/user 的 presentation 偏好，不直接发送任何用户可见内容；
 * AgentHost 在最终 buildReplyPlan 前读取这些偏好交由 ReplyPolicy 统一裁决。
 */
export const REPLY_PRESENTATION_TOOL_SPEC: ToolSpec = normalizeToolSpec({
  name: REPLY_PRESENTATION_TOOL_NAME,
  title: 'Request reply presentation changes',
  description: [
    'Record how the assistant should present its replies, based on what the user just asked for.',
    'Use it when the user expresses a presentation preference, e.g. "现在不方便听语音" (voice off), "这次用文字" (text only this turn), "以后都别发语音" (voice off from now on), "发长一点没关系合并转发" or "这条直接发别合并转发" (mode).',
    'It changes only how replies are delivered (mode / forward style / voice / quote reference) and their duration scope (this turn / this session / this user persistently).',
    'It never sends content to the user by itself and never changes permissions, tool availability, or what gets generated.',
    'Call it at most once per turn, before or together with your final answer.',
  ].join(' '),
  version: '1.0.0',
  provider: 'builtin',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['auto', 'direct', 'quote', 'plain', 'forward'], description: '回复方式偏好：auto 默认后台策略；direct 直接发送；quote 引用回复；plain 纯文本；forward 合并转发。' },
      forwardStyle: { type: 'string', enum: ['auto', 'nested', 'flat'], description: '合并转发样式：nested 嵌套 / flat 平铺。' },
      voice: { type: 'string', enum: ['auto', 'on', 'off'], description: '语音回复偏好：off 表示用户不想听语音。' },
      reference: { type: 'string', enum: ['auto', 'quote', 'none'], description: '是否引用用户消息。' },
      scope: { type: 'string', enum: ['turn', 'session', 'user'], description: '偏好生效范围：turn 本轮；session 本会话；user 用户长期（需要用户明确说"以后/长期"）。' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { applied: { type: 'boolean' }, scope: { type: 'string' } },
  },
  sideEffects: ['modifies_state'],
  riskLevel: 'low',
  timeoutMs: 2000,
  maxRetries: 0,
  queue: 'default',
  outputKinds: ['text'],
  idempotency: 'turn',
  exposure: 'core',
  requiredContext: [],
  metadata: { migrationStatus: 'native' },
});

const REPLY_MODES = new Set(['auto', 'direct', 'quote', 'plain', 'forward']);
const FORWARD_STYLES = new Set(['auto', 'nested', 'flat']);
const VOICES = new Set(['auto', 'on', 'off']);
const REFERENCES = new Set(['auto', 'quote', 'none']);
const SCOPES = new Set(['turn', 'session', 'user']);

/** Parse tool arguments into a normalized AgentReplyPreference; returns undefined when nothing applicable. */
export function parseReplyPresentationArguments(args: Record<string, unknown>): AgentReplyPreference & { scope?: 'turn' | 'session' | 'user' } | undefined {
  const pickEnum = (value: unknown, allowed: Set<string>): string | undefined => {
    const text = typeof value === 'string' ? value.trim() : '';
    return allowed.has(text) ? text : undefined;
  };
  const mode = pickEnum(args.mode, REPLY_MODES);
  const forwardStyle = pickEnum(args.forwardStyle, FORWARD_STYLES);
  const voice = pickEnum(args.voice, VOICES);
  const reference = pickEnum(args.reference, REFERENCES);
  const scope = pickEnum(args.scope, SCOPES);
  if (!mode && !forwardStyle && !voice && !reference) return undefined;
  return {
    ...(mode ? { mode: mode as AgentReplyPreference['mode'] } : {}),
    ...(forwardStyle ? { forwardStyle: forwardStyle as AgentReplyPreference['forwardStyle'] } : {}),
    ...(voice ? { voice: voice as AgentReplyPreference['voice'] } : {}),
    ...(reference ? { reference: reference as AgentReplyPreference['reference'] } : {}),
    ...(scope ? { scope: scope as AgentReplyPreference['scope'] } : {}),
  };
}