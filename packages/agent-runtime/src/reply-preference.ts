import type { AgentReplyPreference } from './types.js';

export interface ReplyPreferenceDefaults {
  mode: NonNullable<AgentReplyPreference['mode']>;
  forwardStyle: NonNullable<AgentReplyPreference['forwardStyle']>;
  voice: NonNullable<AgentReplyPreference['voice']>;
  reference: NonNullable<AgentReplyPreference['reference']>;
}

export interface ReplyPreferenceSources {
  defaults?: Partial<ReplyPreferenceDefaults>;
  turn?: AgentReplyPreference;
  session?: AgentReplyPreference;
  user?: AgentReplyPreference;
}

export interface ResolvedReplyPreference extends ReplyPreferenceDefaults {}

export const DEFAULT_REPLY_PREFERENCE: Readonly<ReplyPreferenceDefaults> = Object.freeze({
  mode: 'auto',
  forwardStyle: 'auto',
  voice: 'auto',
  reference: 'auto',
});

/**
 * Precedence is fixed: turn > session > user > admin defaults.
 * Media direct-only and final message budgets are hard constraints enforced by
 * the reply layer, never by this preference resolver.
 */
export function resolveReplyPreference(sources: ReplyPreferenceSources = {}): ResolvedReplyPreference {
  const defaults = { ...DEFAULT_REPLY_PREFERENCE, ...(sources.defaults || {}) };
  return {
    mode: sources.turn?.mode ?? sources.session?.mode ?? sources.user?.mode ?? defaults.mode,
    forwardStyle: sources.turn?.forwardStyle ?? sources.session?.forwardStyle ?? sources.user?.forwardStyle ?? defaults.forwardStyle,
    voice: sources.turn?.voice ?? sources.session?.voice ?? sources.user?.voice ?? defaults.voice,
    reference: sources.turn?.reference ?? sources.session?.reference ?? sources.user?.reference ?? defaults.reference,
  };
}

export function normalizeReplyPreference(value: unknown): AgentReplyPreference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const preference: AgentReplyPreference = {};
  if (isOneOf(raw.mode, ['auto', 'direct', 'quote', 'plain', 'forward'])) preference.mode = raw.mode;
  if (isOneOf(raw.forwardStyle, ['auto', 'nested', 'flat'])) preference.forwardStyle = raw.forwardStyle;
  if (isOneOf(raw.voice, ['auto', 'on', 'off'])) preference.voice = raw.voice;
  if (isOneOf(raw.reference, ['auto', 'quote', 'none'])) preference.reference = raw.reference;
  if (isOneOf(raw.scope, ['turn', 'session', 'user'])) preference.scope = raw.scope;
  return Object.keys(preference).length ? preference : undefined;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
