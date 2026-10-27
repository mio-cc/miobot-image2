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
    '记录用户刚刚提出的回复表现偏好，并立即生效。这是唯一的回复方式入口。',
    '触发：用户表达「怎么发/怎么回复」类偏好时必须调用，例如「用文字发送」「别发语音」「语音我复制不了/听不了/保存不了」「发文字给我」「以后都用文字」→ voice:"off"（scope 按用户措辞：这次/本轮→"turn"；这个会话/一会儿→"session"；以后/以后都→"user"）。',
    '其他触发：「合并转发/直接发/引用回复」→ mode；「嵌套/平铺」→ forwardStyle；「别引用我」→ reference:"none"。',
    '它只改变送达方式，不产生任何用户可见内容，也不改变权限或工具可用性。',
    '调用时机：在给出最终文字回答的同一轮里调用（先 presentation 再回答，或回答前单独一轮均可）。默认 scope 为 "turn"。',
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