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
    '记录用户对最终回复呈现方式的偏好，并使其在当前对话中生效。',
    '当消息在改变回复的交付形态、结构、引用关系或呈现媒介时使用；关注的是「最终回复如何送达和呈现」，而不是用户想生成或查询的内容本身。',
    '只有当消息实际提出或改变最终回复的呈现偏好时才使用；如果只是在讨论、引用或询问某种媒介或格式，不要调用。',
    '交付偏好与内容请求是正交的：同一请求如果既包含呈现方式变化，又包含内容生成、查询或状态修改，先记录呈现偏好，再继续完成内容目标。',
    '依据语义、上下文和时效性推断作用范围：默认使用最小范围 turn；只有用户明确表示偏好在当前会话继续有效时才用 session，只有明确表示跨会话长期有效时才用 user。不要因为语气坚定、礼貌或请求本身而扩大范围。',
    '该工具不产生用户可见内容、不生成媒体、不改变权限；实际发送方式由 ReplyPolicy 结合当前会话策略裁决。',
    '字段值应反映用户希望最终回复成为什么：目标是可听的音频交付时用 voice=on，目标是非音频交付时用 voice=off，没有明确媒介倾向时才用 auto。voice=on 已表示最终回复将由系统合成音频，不需要再调用独立音频生成工具。',
    '在给出最终回答的同一轮内调用，或在此前单独一轮先记录偏好；不要只在回复正文里表示同意。',
  ].join(' '),
  version: '1.0.0',
  provider: 'builtin',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['auto', 'direct', 'quote', 'plain', 'forward'], description: '最终回复的交付结构：auto 沿用后台策略；direct 直接发送；quote 引用回复；plain 纯文本；forward 合并转发。' },
      forwardStyle: { type: 'string', enum: ['auto', 'nested', 'flat'], description: '合并转发时的结构样式：nested 嵌套 / flat 平铺。' },
      voice: { type: 'string', enum: ['auto', 'on', 'off'], description: '最终回复的呈现媒介偏好：on 使用语音呈现，off 使用非语音呈现，auto 沿用策略。' },
      reference: { type: 'string', enum: ['auto', 'quote', 'none'], description: '最终回复与用户消息的引用关系。' },
      scope: { type: 'string', enum: ['turn', 'session', 'user'], description: '偏好的生命周期：turn 仅本次回复；session 当前会话；user 跨会话长期偏好。按语义中的时效性推断，不确定时使用 turn。' },
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