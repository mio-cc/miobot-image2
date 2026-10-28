export type AgentRuntimeConfigMode = 'off' | 'shadow' | 'enforce';
export type AgentToolChoice = 'auto' | 'required' | 'none';

export interface AgentRepairConfigV3 {
  maxProtocolRepairs: number;
  maxSchemaRepairsPerCall: number;
  maxTotalOutputRepairs: number;
  maxRepeatedErrorCount: number;
  repairTemperature: number;
  allowTextFallback: boolean;
}

export interface AgentConfigV3 {
  enabled: boolean;
  mode: AgentRuntimeConfigMode;
  mainNodeIndex: number;
  mainModel: string;
  fallbackNodeIndex?: number;
  fallbackModel?: string;
  toolChoice: AgentToolChoice;
  maxModelRounds: number;
  maxToolRounds: number;
  maxParallelTools: number;
  /** R15/C-2：全局同时执行的 Agent turn 上限（跨群共享，超出排队；0=不限制）。 */
  maxConcurrentTurns: number;
  maxTokens: number;
  temperature: number;
  reasoningEffort: string;
  timeoutMs: number;
  turnTimeoutMs: number;
  finalizeTimeoutMs: number;
  streaming: boolean;
  repair: AgentRepairConfigV3;
}

export type ToolExposureMode = 'core' | 'domain' | 'searchable' | 'hidden';

export interface ToolRegistryConfigV3 {
  enabled: boolean;
  maxToolsPerTurn: number;
  maxToolSchemaBytes: number;
  toolSearchEnabled: boolean;
  defaultTimeoutMs: number;
  defaultMaxRetries: number;
  defaultMaxConcurrency: number;
  exposure: Record<string, ToolExposureMode>;
}

export interface ReplyPolicyConfigV3 {
  enabled: boolean;
  allowModelOverride: boolean;
  allowSessionPreferences: boolean;
  allowUserPreferences: boolean;
  defaultVoice: 'auto' | 'on' | 'off';
  forcedForwardThreshold: number;
  hardMaxChars: number;
  hardMaxMessages: number;
  sessionPreferenceTtlMs: number;
  userPreferenceTtlMs: number;
  /** Hard protocol constraint: audio is always sent direct, never forwarded. */
  audioDirectOnly: true;
  /** Hard protocol constraint: files are always sent direct, never forwarded. */
  fileDirectOnly: true;
}

export interface ContextConfigV3 {
  historyMaxRounds: number;
  historyMaxChars: number;
  groupContextEnabled: boolean;
  groupContextMessages: number;
  groupContextMaxChars: number;
  memoryTopK: number;
  memoryMinScore: number;
  memoryMaxChars: number;
  compactionEnabled: boolean;
  compactionThresholdTokens: number;
  toolResultMaxChars: number;
  spillEnabled: boolean;
  pinnedFactsMaxItems: number;
}

export interface ConfigV3Sections {
  agent: AgentConfigV3;
  toolRegistry: ToolRegistryConfigV3;
  replyPolicy: ReplyPolicyConfigV3;
  contextPolicy: ContextConfigV3;
}

export type ConfigFieldMetaType = 'boolean' | 'number' | 'string' | 'enum' | 'secret' | 'string[]' | 'json';
export type ConfigFieldMetaScope = 'global' | 'feature' | 'group' | 'user';
export type ConfigFieldHotReload = 'next_turn' | 'new_job_only' | 'restart_required';

export interface ConfigFieldMetadata {
  key: string;
  label: string;
  type: ConfigFieldMetaType;
  defaultValue: unknown;
  min?: number;
  max?: number;
  enumValues?: string[];
  unit?: string;
  help?: string;
  scope: ConfigFieldMetaScope;
  hotReload: ConfigFieldHotReload;
  danger?: boolean;
  legacyKey?: string;
  /** R17：唯一写入点（primary editor）页面的路由路径；未标注 = 只读镜像或暂无 UI。 */
  primaryEditor?: string;
}

export function defaultAgentConfigV3(): AgentConfigV3 {
  // R9 修复（P0-1）：旧自然语言链路已物理删除，AgentRuntime 是唯一主运行时。
  // 缺省配置必须直接可用：默认 enforce。显式 enabled:false 仍被 normalize 尊重（运维明确关闭），
  // 但启动装配会在该状态下阻断 bot 并向管理员报错，而不是给每个用户发固定提示。
  return {
    enabled: true,
    mode: 'enforce',
    mainNodeIndex: 0,
    mainModel: 'gpt-4o-mini',
    toolChoice: 'auto',
    maxModelRounds: 8,
    maxToolRounds: 16,
    maxParallelTools: 4,
    maxConcurrentTurns: 4,
    maxTokens: 8192,
    temperature: 0.7,
    reasoningEffort: 'high',
    timeoutMs: 120_000,
    turnTimeoutMs: 180_000,
    finalizeTimeoutMs: 15_000,
    streaming: false,
    repair: {
      maxProtocolRepairs: 2,
      maxSchemaRepairsPerCall: 2,
      maxTotalOutputRepairs: 4,
      maxRepeatedErrorCount: 2,
      repairTemperature: 0,
      allowTextFallback: true,
    },
  };
}

export function defaultToolRegistryConfigV3(): ToolRegistryConfigV3 {
  return {
    enabled: true,
    maxToolsPerTurn: 24,
    maxToolSchemaBytes: 48_000,
    toolSearchEnabled: false,
    defaultTimeoutMs: 120_000,
    defaultMaxRetries: 1,
    defaultMaxConcurrency: 2,
    exposure: {},
  };
}

export function defaultReplyPolicyConfigV3(): ReplyPolicyConfigV3 {
  return {
    enabled: true,
    allowModelOverride: true,
    allowSessionPreferences: true,
    allowUserPreferences: true,
    defaultVoice: 'auto',
    forcedForwardThreshold: 1800,
    hardMaxChars: 20_000,
    hardMaxMessages: 12,
    sessionPreferenceTtlMs: 86_400_000,
    userPreferenceTtlMs: 2_592_000_000,
    audioDirectOnly: true,
    fileDirectOnly: true,
  };
}

export function defaultContextConfigV3(): ContextConfigV3 {
  return {
    historyMaxRounds: 8,
    historyMaxChars: 12_000,
    groupContextEnabled: true,
    groupContextMessages: 30,
    groupContextMaxChars: 4_000,
    memoryTopK: 8,
    memoryMinScore: 0.2,
    memoryMaxChars: 5_000,
    compactionEnabled: false,
    compactionThresholdTokens: 24_000,
    toolResultMaxChars: 12_000,
    spillEnabled: true,
    pinnedFactsMaxItems: 20,
  };
}

export function defaultConfigV3Sections(): ConfigV3Sections {
  return {
    agent: defaultAgentConfigV3(),
    toolRegistry: defaultToolRegistryConfigV3(),
    replyPolicy: defaultReplyPolicyConfigV3(),
    contextPolicy: defaultContextConfigV3(),
  };
}

export function normalizeConfigV3Sections(input: unknown): ConfigV3Sections {
  const root = record(input);
  return {
    agent: normalizeAgentConfigV3(root.agent),
    toolRegistry: normalizeToolRegistryConfigV3(root.toolRegistry),
    replyPolicy: normalizeReplyPolicyConfigV3(root.replyPolicy),
    contextPolicy: normalizeContextConfigV3(root.contextPolicy),
  };
}

export function normalizeAgentConfigV3(input: unknown): AgentConfigV3 {
  const d = defaultAgentConfigV3();
  const raw = record(input);
  const repair = record(raw.repair);
  const enabled = bool(raw.enabled, d.enabled);
  return {
    enabled,
    mode: enabled ? pick(raw.mode, ['off', 'shadow', 'enforce'] as const, d.mode) : pick(raw.mode, ['off', 'shadow', 'enforce'] as const, 'off'),
    mainNodeIndex: intIn(raw.mainNodeIndex, d.mainNodeIndex, 0, 10_000),
    mainModel: str(raw.mainModel, d.mainModel).trim().slice(0, 200) || d.mainModel,
    ...(hasValue(raw.fallbackNodeIndex) ? { fallbackNodeIndex: intIn(raw.fallbackNodeIndex, 0, 0, 10_000) } : {}),
    ...(str(raw.fallbackModel, '').trim() ? { fallbackModel: str(raw.fallbackModel, '').trim().slice(0, 200) } : {}),
    toolChoice: pick(raw.toolChoice, ['auto', 'required', 'none'] as const, d.toolChoice),
    maxModelRounds: intIn(raw.maxModelRounds, d.maxModelRounds, 1, 100),
    maxToolRounds: intIn(raw.maxToolRounds, d.maxToolRounds, 0, 200),
    maxParallelTools: intIn(raw.maxParallelTools, d.maxParallelTools, 1, 32),
    maxConcurrentTurns: intIn(raw.maxConcurrentTurns, d.maxConcurrentTurns, 0, 256),
    maxTokens: intIn(raw.maxTokens, d.maxTokens, 1, 200_000),
    temperature: numberIn(raw.temperature, d.temperature, 0, 2),
    reasoningEffort: str(raw.reasoningEffort, d.reasoningEffort).trim().slice(0, 50) || d.reasoningEffort,
    timeoutMs: intIn(raw.timeoutMs, d.timeoutMs, 1_000, 3_600_000),
    turnTimeoutMs: intIn(raw.turnTimeoutMs, d.turnTimeoutMs, 1_000, 3_600_000),
    finalizeTimeoutMs: intIn(raw.finalizeTimeoutMs, d.finalizeTimeoutMs, 500, 120_000),
    streaming: bool(raw.streaming, d.streaming),
    repair: {
      maxProtocolRepairs: intIn(repair.maxProtocolRepairs, d.repair.maxProtocolRepairs, 0, 20),
      maxSchemaRepairsPerCall: intIn(repair.maxSchemaRepairsPerCall, d.repair.maxSchemaRepairsPerCall, 0, 20),
      maxTotalOutputRepairs: intIn(repair.maxTotalOutputRepairs, d.repair.maxTotalOutputRepairs, 0, 40),
      maxRepeatedErrorCount: intIn(repair.maxRepeatedErrorCount, d.repair.maxRepeatedErrorCount, 1, 20),
      repairTemperature: numberIn(repair.repairTemperature, d.repair.repairTemperature, 0, 1),
      allowTextFallback: bool(repair.allowTextFallback, d.repair.allowTextFallback),
    },
  };
}

export function normalizeToolRegistryConfigV3(input: unknown): ToolRegistryConfigV3 {
  const d = defaultToolRegistryConfigV3();
  const raw = record(input);
  const exposure: Record<string, ToolExposureMode> = {};
  for (const [key, value] of Object.entries(record(raw.exposure)).slice(0, 500)) {
    const name = key.trim().slice(0, 200);
    if (!name) continue;
    if (value === 'core' || value === 'domain' || value === 'searchable' || value === 'hidden') exposure[name] = value;
  }
  return {
    enabled: bool(raw.enabled, d.enabled),
    maxToolsPerTurn: intIn(raw.maxToolsPerTurn, d.maxToolsPerTurn, 1, 128),
    maxToolSchemaBytes: intIn(raw.maxToolSchemaBytes, d.maxToolSchemaBytes, 1_024, 1_000_000),
    toolSearchEnabled: bool(raw.toolSearchEnabled, d.toolSearchEnabled),
    defaultTimeoutMs: intIn(raw.defaultTimeoutMs, d.defaultTimeoutMs, 1_000, 3_600_000),
    defaultMaxRetries: intIn(raw.defaultMaxRetries, d.defaultMaxRetries, 0, 20),
    defaultMaxConcurrency: intIn(raw.defaultMaxConcurrency, d.defaultMaxConcurrency, 1, 64),
    exposure,
  };
}

export function normalizeReplyPolicyConfigV3(input: unknown): ReplyPolicyConfigV3 {
  const d = defaultReplyPolicyConfigV3();
  const raw = record(input);
  return {
    enabled: bool(raw.enabled, d.enabled),
    allowModelOverride: bool(raw.allowModelOverride, d.allowModelOverride),
    allowSessionPreferences: bool(raw.allowSessionPreferences, d.allowSessionPreferences),
    allowUserPreferences: bool(raw.allowUserPreferences, d.allowUserPreferences),
    defaultVoice: pick(raw.defaultVoice, ['auto', 'on', 'off'] as const, d.defaultVoice),
    forcedForwardThreshold: intIn(raw.forcedForwardThreshold, d.forcedForwardThreshold, 1, 100_000),
    hardMaxChars: intIn(raw.hardMaxChars, d.hardMaxChars, 1, 100_000),
    hardMaxMessages: intIn(raw.hardMaxMessages, d.hardMaxMessages, 1, 100),
    sessionPreferenceTtlMs: intIn(raw.sessionPreferenceTtlMs, d.sessionPreferenceTtlMs, 0, 31_536_000_000),
    userPreferenceTtlMs: intIn(raw.userPreferenceTtlMs, d.userPreferenceTtlMs, 0, 31_536_000_000),
    audioDirectOnly: true,
    fileDirectOnly: true,
  };
}

export function normalizeContextConfigV3(input: unknown): ContextConfigV3 {
  const d = defaultContextConfigV3();
  const raw = record(input);
  return {
    historyMaxRounds: intIn(raw.historyMaxRounds, d.historyMaxRounds, 1, 200),
    historyMaxChars: intIn(raw.historyMaxChars, d.historyMaxChars, 500, 500_000),
    groupContextEnabled: bool(raw.groupContextEnabled, d.groupContextEnabled),
    groupContextMessages: intIn(raw.groupContextMessages, d.groupContextMessages, 1, 500),
    groupContextMaxChars: intIn(raw.groupContextMaxChars, d.groupContextMaxChars, 200, 100_000),
    memoryTopK: intIn(raw.memoryTopK, d.memoryTopK, 1, 100),
    memoryMinScore: numberIn(raw.memoryMinScore, d.memoryMinScore, 0, 1),
    memoryMaxChars: intIn(raw.memoryMaxChars, d.memoryMaxChars, 200, 100_000),
    compactionEnabled: bool(raw.compactionEnabled, d.compactionEnabled),
    compactionThresholdTokens: intIn(raw.compactionThresholdTokens, d.compactionThresholdTokens, 1_000, 1_000_000),
    toolResultMaxChars: intIn(raw.toolResultMaxChars, d.toolResultMaxChars, 500, 1_000_000),
    spillEnabled: bool(raw.spillEnabled, d.spillEnabled),
    pinnedFactsMaxItems: intIn(raw.pinnedFactsMaxItems, d.pinnedFactsMaxItems, 1, 500),
  };
}

const nextTurn = 'next_turn' as const;
const newJob = 'new_job_only' as const;
const global = 'global' as const;

export const CONFIG_V3_FIELD_METADATA: readonly ConfigFieldMetadata[] = [
  field('agent.enabled', '启用 Agent Runtime', 'boolean', true, global, nextTurn),
  field('agent.mode', 'Agent 运行模式', 'enum', 'enforce', global, nextTurn, { enumValues: ['off', 'shadow', 'enforce'] }),
  field('agent.mainNodeIndex', '主节点', 'number', 0, global, nextTurn, { min: 0, max: 10_000 }),
  field('agent.mainModel', '主模型', 'string', 'gpt-4o-mini', global, nextTurn),
  field('agent.fallbackNodeIndex', '备用节点', 'number', undefined, global, nextTurn, { min: 0, max: 10_000 }),
  field('agent.fallbackModel', '备用模型', 'string', '', global, nextTurn),
  field('agent.toolChoice', '工具选择策略', 'enum', 'auto', global, nextTurn, { enumValues: ['auto', 'required', 'none'] }),
  field('agent.maxModelRounds', '最大模型轮次', 'number', 8, global, nextTurn, { min: 1, max: 100 }),
  field('agent.streaming', '流式输出（不适用：Napcat 只接受完整回复）', 'boolean', false, global, nextTurn),
  field('agent.maxToolRounds', '最大工具轮次', 'number', 16, global, nextTurn, { min: 0, max: 200 }),
  field('agent.maxParallelTools', '最大并行工具数', 'number', 4, global, nextTurn, { min: 1, max: 32 }),
  field('agent.maxConcurrentTurns', '全局并发 Turn 上限', 'number', 4, global, nextTurn, { min: 0, max: 256, help: '跨群共享的同时执行的 Agent turn 上限，超出排队先来先得；0=不限制。1c2g 建议 4。' }),
  field('agent.maxTokens', '单轮最大 Token', 'number', 8192, global, nextTurn, { min: 1, max: 200_000 }),
  field('agent.temperature', '温度', 'number', 0.7, global, nextTurn, { min: 0, max: 2 }),
  field('agent.reasoningEffort', '推理强度', 'string', 'high', global, nextTurn),
  field('agent.timeoutMs', '模型请求超时', 'number', 120_000, global, nextTurn, { min: 1_000, max: 3_600_000, unit: 'ms' }),
  field('agent.turnTimeoutMs', '单轮总超时', 'number', 180_000, global, nextTurn, { min: 1_000, max: 3_600_000, unit: 'ms' }),
    field('agent.finalizeTimeoutMs', '超时后收口预算', 'number', 15_000, global, nextTurn, { min: 500, max: 120_000, unit: 'ms' }),
  field('agent.repair.maxProtocolRepairs', '协议修复上限', 'number', 2, global, nextTurn, { min: 0, max: 20 }),
  field('agent.repair.maxSchemaRepairsPerCall', '单调用参数修复上限', 'number', 2, global, nextTurn, { min: 0, max: 20 }),
  field('agent.repair.maxTotalOutputRepairs', '总输出修复上限', 'number', 4, global, nextTurn, { min: 0, max: 40 }),
  field('agent.repair.maxRepeatedErrorCount', '重复错误上限', 'number', 2, global, nextTurn, { min: 1, max: 20 }),
  field('agent.repair.repairTemperature', '修复温度', 'number', 0, global, nextTurn, { min: 0, max: 1 }),
  field('agent.repair.allowTextFallback', '允许纯文本安全退出', 'boolean', true, global, nextTurn),
  field('toolRegistry.enabled', '启用 Tool Registry', 'boolean', true, global, nextTurn),
  field('toolRegistry.maxToolsPerTurn', '每轮最大工具数', 'number', 24, global, nextTurn, { min: 1, max: 128 }),
  field('toolRegistry.maxToolSchemaBytes', '工具 Schema 预算', 'number', 48_000, global, nextTurn, { min: 1_024, max: 1_000_000, unit: 'bytes' }),
  field('toolRegistry.toolSearchEnabled', '启用 searchable 工具（检索式加载待扩展）', 'boolean', false, global, nextTurn),
  field('toolRegistry.defaultTimeoutMs', '工具默认超时', 'number', 120_000, global, newJob, { min: 1_000, max: 3_600_000, unit: 'ms' }),
  field('toolRegistry.defaultMaxRetries', '工具默认重试', 'number', 1, global, newJob, { min: 0, max: 20 }),
  field('toolRegistry.defaultMaxConcurrency', '工具默认并发', 'number', 2, global, newJob, { min: 1, max: 64 }),
  field('toolRegistry.exposure', '工具暴露策略', 'json', {}, global, nextTurn),
  field('replyPolicy.enabled', '启用 Reply Policy', 'boolean', true, global, nextTurn),
  field('replyPolicy.allowModelOverride', '允许模型请求表现', 'boolean', true, global, nextTurn),
  field('replyPolicy.allowSessionPreferences', '允许会话偏好', 'boolean', true, global, nextTurn),
  field('replyPolicy.allowUserPreferences', '允许用户长期偏好', 'boolean', true, global, nextTurn),
  field('replyPolicy.defaultVoice', '默认语音策略', 'enum', 'auto', global, nextTurn, { enumValues: ['auto', 'on', 'off'] }),
  field('replyPolicy.forcedForwardThreshold', '强制转发阈值', 'number', 1800, global, nextTurn, { min: 1, max: 100_000, unit: 'chars' }),
  field('replyPolicy.hardMaxChars', '硬最大字符数', 'number', 20_000, global, nextTurn, { min: 1, max: 100_000, unit: 'chars' }),
  field('replyPolicy.hardMaxMessages', '硬最大消息数', 'number', 12, global, nextTurn, { min: 1, max: 100 }),
  field('replyPolicy.sessionPreferenceTtlMs', '会话偏好 TTL', 'number', 86_400_000, global, nextTurn, { min: 0, max: 31_536_000_000, unit: 'ms' }),
  field('replyPolicy.userPreferenceTtlMs', '用户偏好 TTL', 'number', 2_592_000_000, global, nextTurn, { min: 0, max: 31_536_000_000, unit: 'ms' }),
  field('replyPolicy.audioDirectOnly', '音频仅直发', 'boolean', true, global, nextTurn, { danger: true }),
  field('replyPolicy.fileDirectOnly', '文件仅直发', 'boolean', true, global, nextTurn, { danger: true }),
  field('contextPolicy.historyMaxRounds', '对话历史上限', 'number', 8, global, nextTurn, { min: 1, max: 200 }),
  field('contextPolicy.historyMaxChars', '对话历史字符上限', 'number', 12_000, global, nextTurn, { min: 500, max: 500_000 }),
  field('contextPolicy.groupContextEnabled', '启用群上下文', 'boolean', true, global, nextTurn),
  field('contextPolicy.groupContextMessages', '群上下文消息数', 'number', 30, global, nextTurn, { min: 1, max: 500 }),
  field('contextPolicy.groupContextMaxChars', '群上下文字符上限', 'number', 4_000, global, nextTurn, { min: 200, max: 100_000 }),
  field('contextPolicy.memoryTopK', '记忆 TopK', 'number', 8, global, nextTurn, { min: 1, max: 100 }),
  field('contextPolicy.memoryMinScore', '记忆最小分数', 'number', 0.2, global, nextTurn, { min: 0, max: 1 }),
  field('contextPolicy.memoryMaxChars', '记忆字符上限', 'number', 5_000, global, nextTurn, { min: 200, max: 100_000 }),
  field('contextPolicy.compactionEnabled', '启用上下文压缩（消息裁剪 + 摘要）', 'boolean', false, global, nextTurn),
  field('contextPolicy.compactionThresholdTokens', '压缩阈值', 'number', 24_000, global, nextTurn, { min: 1_000, max: 1_000_000, unit: 'tokens' }),
  field('contextPolicy.toolResultMaxChars', '工具结果字符上限', 'number', 12_000, global, nextTurn, { min: 500, max: 1_000_000 }),
  field('contextPolicy.spillEnabled', '启用大工具结果落盘', 'boolean', true, global, nextTurn),
  field('contextPolicy.pinnedFactsMaxItems', '固定事实上限', 'number', 20, global, nextTurn, { min: 1, max: 500 }),
];

function field(
  key: string,
  label: string,
  type: ConfigFieldMetaType,
  defaultValue: unknown,
  scope: ConfigFieldMetaScope,
  hotReload: ConfigFieldHotReload,
  extra: Partial<Omit<ConfigFieldMetadata, 'key' | 'label' | 'type' | 'defaultValue' | 'scope' | 'hotReload'>> = {},
): ConfigFieldMetadata {
  return { key, label, type, defaultValue, scope, hotReload, ...extra };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function intIn(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}
