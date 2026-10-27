import { ToolRuntimeError, type ToolError } from './tool-errors.js';
import { normalizeToolInputSchema, normalizeToolOutputSchema } from './tool-schema.js';

export const TOOL_SIDE_EFFECTS = [
  'creates_artifact',
  'modifies_state',
  'deletes_data',
  'sends_message',
  'external_call',
] as const;
export type ToolSideEffect = typeof TOOL_SIDE_EFFECTS[number];

export const TOOL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type ToolRiskLevel = typeof TOOL_RISK_LEVELS[number];

export const TOOL_QUEUES = ['image', 'video', 'audio', 'search', 'file', 'default'] as const;
export type ToolQueue = typeof TOOL_QUEUES[number];

export const TOOL_EXPOSURES = ['core', 'domain', 'searchable', 'hidden'] as const;
export type ToolExposure = typeof TOOL_EXPOSURES[number];

export const TOOL_IDEMPOTENCY_MODES = ['none', 'turn', 'payload'] as const;
export type ToolIdempotency = typeof TOOL_IDEMPOTENCY_MODES[number];

export const TOOL_CONTEXTS = ['image', 'file', 'video', 'audio', 'url', 'quote', 'forward'] as const;
export type ToolRequiredContext = typeof TOOL_CONTEXTS[number];

export const TOOL_OUTPUT_KINDS = ['text', 'image', 'video', 'audio', 'file', 'link', 'card'] as const;
export type ToolOutputKind = typeof TOOL_OUTPUT_KINDS[number];

export interface ToolMetadata {
  capabilityId?: string;
  aliases?: string[];
  scopes?: Array<'private' | 'group'>;
  groupActivation?: 'direct' | 'mention' | 'reply' | 'mention-or-reply';
  naturalLanguage?: boolean;
  legacyCommand?: string;
  legacyEffect?: string;
  implementationMode?: string;
  permissions?: string[];
  /** Set for adapters that are not yet able to execute through the V2 executor. */
  migrationStatus?: 'contract-only' | 'adapted' | 'native';
}

export interface ToolSpec {
  /** Stable model-visible identifier; legacy capability ids are reused during migration. */
  name: string;
  title: string;
  description: string;
  version?: string;
  provider?: string;
  enabled?: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  sideEffects?: ToolSideEffect[];
  riskLevel: ToolRiskLevel;
  approvalRequired?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  queue?: ToolQueue;
  maxConcurrency?: number;
  outputKinds?: ToolOutputKind[];
  idempotency?: ToolIdempotency;
  exposure?: ToolExposure;
  requiredContext?: ToolRequiredContext[];
  metadata?: ToolMetadata;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON object. Validation happens before any handler is invoked. */
  arguments: unknown;
}

export interface ToolOutput {
  kind: ToolOutputKind;
  id?: string;
  text?: string;
  url?: string;
  mime?: string;
  size?: number;
  priority?: number;
  mergeable?: boolean;
  meta?: Record<string, unknown>;
}

export interface ToolExecutionMeta {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface ToolResult {
  callId: string;
  toolName?: string;
  ok: boolean;
  content?: string;
  outputs?: ToolOutput[];
  error?: ToolError;
  jobId?: string;
  pending?: boolean;
  meta?: ToolExecutionMeta;
}

export type AgentToolSpec = ToolSpec;
export type AgentToolCall = ToolCall;
export type AgentToolResult = ToolResult;
export type AgentToolOutput = ToolOutput;

/** Structural shape accepted from the existing orchestration CapabilityDescriptor. */
export interface LegacyCapabilityDescriptorLike {
  id: string;
  version?: string;
  name?: string;
  description?: string;
  provider?: string;
  enabled?: boolean;
  aliases?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputKinds?: string[];
  sideEffects?: string[];
  riskLevel?: string;
  approvalRequired?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  queue?: string;
  requiredContext?: string[];
  mode?: string;
  permissions?: string[];
  effect?: string;
}

export interface ToolSpecAdapterOptions {
  exposure?: ToolExposure;
  enabled?: boolean;
  migrationStatus?: ToolMetadata['migrationStatus'];
  /** P1-9：capability 未声明超时的缺省值（来自 toolRegistry.defaultTimeoutMs）。 */
  timeoutMs?: number;
}


export const CORE_TOOL_NAMES = [
  'image.generate',
  'image.edit',
  'audio.music.generate',
  'audio.music.history',
  'audio.music.replay',
  'web.search',
  'file.read',
  'ask_user',
  'update_plan',
] as const;

export const DOMAIN_TOOL_NAMES = [
  'image.interrogate',
  'image.stitch',
  'video.generate',
  'audio.music.variant',
  'audio.music.lyrics',
  'audio.music.replace_section',
  'file.list',
  'file.generate',
  'code.render',
  'browser.render',
  'tts.speak',
  'voice.current',
  'voice.search',
  'voice.preview',
  'voice.select',
  'prompt.enhance',
  'prompt.translate',
  'template.list',
  'template.use',
  'canvas.gallery',
  'task.schedule',
] as const;

const CORE = new Set<string>(CORE_TOOL_NAMES);
const DOMAIN = new Set<string>(DOMAIN_TOOL_NAMES);

export function normalizeToolSpec(input: ToolSpec): ToolSpec {
  const name = String(input?.name || '').trim();
  if (!name) {
    throw new ToolRuntimeError({ code: 'invalid_envelope', message: 'Tool name is required.', path: '$.name' });
  }
  const riskLevel = (TOOL_RISK_LEVELS as readonly string[]).includes(String(input.riskLevel))
    ? input.riskLevel as ToolRiskLevel
    : 'medium';
  const sideEffects = Array.from(new Set((input.sideEffects || [])
    .filter((item): item is ToolSideEffect => (TOOL_SIDE_EFFECTS as readonly string[]).includes(String(item)))));
  const outputKinds = Array.from(new Set((input.outputKinds || [])
    .filter((item): item is ToolOutputKind => (TOOL_OUTPUT_KINDS as readonly string[]).includes(String(item)))));
  const requiredContext = Array.from(new Set((input.requiredContext || [])
    .filter((item): item is ToolRequiredContext => (TOOL_CONTEXTS as readonly string[]).includes(String(item)))));
  const queue = input.queue && (TOOL_QUEUES as readonly string[]).includes(input.queue) ? input.queue : undefined;
  const idempotency = input.idempotency && (TOOL_IDEMPOTENCY_MODES as readonly string[]).includes(input.idempotency)
    ? input.idempotency
    : inferIdempotency(sideEffects);
  const exposure = input.exposure && (TOOL_EXPOSURES as readonly string[]).includes(input.exposure)
    ? input.exposure
    : inferExposure(name, input.enabled !== false, riskLevel);
  const metadata = input.metadata ? {
    ...input.metadata,
    ...(input.metadata.aliases ? { aliases: Array.from(new Set(input.metadata.aliases.map(String).map((item) => item.trim()).filter(Boolean))) } : {}),
    ...(input.metadata.scopes ? { scopes: Array.from(new Set(input.metadata.scopes.filter((scope) => scope === 'private' || scope === 'group'))) } : {}),
    ...(input.metadata.permissions ? { permissions: Array.from(new Set(input.metadata.permissions.map(String).filter(Boolean))) } : {}),
  } : undefined;
  return {
    ...input,
    name,
    title: String(input.title || name).trim() || name,
    description: String(input.description || input.title || name).trim() || name,
    version: String(input.version || '1.0.0'),
    provider: input.provider ? String(input.provider) : undefined,
    enabled: input.enabled !== false,
    inputSchema: normalizeToolInputSchema(input.inputSchema),
    outputSchema: normalizeToolOutputSchema(input.outputSchema),
    sideEffects,
    riskLevel,
    approvalRequired: input.approvalRequired === true,
    timeoutMs: finiteInt(input.timeoutMs, 1, 3_600_000),
    maxRetries: finiteInt(input.maxRetries, 0, 20),
    queue,
    maxConcurrency: finiteInt(input.maxConcurrency, 1, 64),
    outputKinds,
    idempotency,
    exposure,
    requiredContext,
    metadata,
  };
}

export function toolSpecFromCapabilityDescriptor(
  descriptor: LegacyCapabilityDescriptorLike,
  options: ToolSpecAdapterOptions = {},
): ToolSpec {
  const inferredSideEffects = inferSideEffectsFromLegacyEffect(descriptor.effect);
  const sideEffects = Array.from(new Set([...(descriptor.sideEffects || []), ...inferredSideEffects]))
    .filter((item): item is ToolSideEffect => (TOOL_SIDE_EFFECTS as readonly string[]).includes(String(item)));
  const outputKinds = (descriptor.outputKinds || [])
    .filter((item): item is ToolOutputKind => (TOOL_OUTPUT_KINDS as readonly string[]).includes(String(item)));
  const riskLevel = (TOOL_RISK_LEVELS as readonly string[]).includes(String(descriptor.riskLevel))
    ? descriptor.riskLevel as ToolRiskLevel
    : 'low';
  const id = String(descriptor.id || '').trim();
  return normalizeToolSpec({
    name: id,
    title: String(descriptor.name || id),
    description: String(descriptor.description || descriptor.name || id),
    version: descriptor.version || '1.0.0',
    provider: descriptor.provider,
    enabled: options.enabled ?? descriptor.enabled !== false,
    inputSchema: descriptor.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: descriptor.outputSchema,
    sideEffects,
    riskLevel,
    approvalRequired: descriptor.approvalRequired === true,
    timeoutMs: descriptor.timeoutMs ?? options.timeoutMs,
    maxRetries: descriptor.maxRetries,
    queue: mapLegacyQueue(descriptor.queue),
    outputKinds,
    idempotency: inferIdempotency(sideEffects),
    exposure: options.exposure || inferExposure(id, options.enabled ?? descriptor.enabled !== false, riskLevel),
    requiredContext: mapRequiredContext(descriptor.requiredContext),
    metadata: {
      capabilityId: id,
      aliases: descriptor.aliases,
      legacyEffect: descriptor.effect,
      implementationMode: descriptor.mode,
      permissions: descriptor.permissions,
      migrationStatus: options.migrationStatus || 'adapted',
    },
  });
}

function inferSideEffectsFromLegacyEffect(effect: string | undefined): string[] {
  switch (String(effect || '')) {
    case 'generate':
    case 'transform':
      return ['creates_artifact'];
    case 'mutate':
    case 'control':
      return ['modifies_state'];
    case 'delete':
      return ['deletes_data'];
    case 'notify':
      return ['sends_message'];
    default:
      return [];
  }
}
function mapRequiredContext(values: string[] | undefined): ToolRequiredContext[] {
  const mapped = new Set<ToolRequiredContext>();
  for (const value of values || []) {
    if (value === 'image' || value === 'file' || value === 'video' || value === 'url') mapped.add(value);
    else if (value === 'reply') mapped.add('quote');
    else if (value === 'thread' || value === 'forward') mapped.add('forward');
  }
  return [...mapped];
}

function mapLegacyQueue(value: string | undefined): ToolQueue | undefined {
  if (!value) return undefined;
  return (TOOL_QUEUES as readonly string[]).includes(value) ? value as ToolQueue : 'default';
}

function inferIdempotency(sideEffects: ToolSideEffect[]): ToolIdempotency {
  if (sideEffects.some((effect) => effect === 'deletes_data' || effect === 'modifies_state' || effect === 'sends_message')) return 'payload';
  if (sideEffects.some((effect) => effect === 'creates_artifact' || effect === 'external_call')) return 'turn';
  return 'none';
}

function inferExposure(name: string, enabled: boolean, risk: ToolRiskLevel): ToolExposure {
  if (!enabled || risk === 'critical') return 'hidden';
  if (name === 'session.clear' || name.startsWith('owner.') || name.startsWith('config.') || name.startsWith('permission.')) return 'hidden';
  if (CORE.has(name)) return 'core';
  if (DOMAIN.has(name)) return 'domain';
  return 'searchable';
}

function finiteInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
