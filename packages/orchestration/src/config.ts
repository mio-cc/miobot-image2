import type { ApprovalQuorum, PermissionMode, PermissionRule, RiskLevel, UserRole } from './types.js';
import { DEFAULT_PLANNER_CAPABILITY_DESCRIPTIONS, DEFAULT_PLANNER_SYSTEM_PROMPT, DEFAULT_PLANNER_USER_PROMPT_TEMPLATE } from './planner.js';

export interface CapabilityOverride {
  enabled?: boolean;
  approvalRequired?: boolean;
  riskLevel?: RiskLevel;
}

export interface ModelRoleConfig {
  enabled: boolean;
  nodeIndex?: number;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  fallbackNodeIndex?: number;
  fallbackModel?: string;
  promptVersion?: string;
  promptTemplate?: string;
}

export interface PromptVersionEvaluation {
  samples: number;
  successRate: number;
  averageScore: number;
  safetyFailures: number;
  ownerApproved: boolean;
  promote: boolean;
  reason: string;
  evaluatedAt: string;
}

export interface PromptVersionConfig {
  id: string;
  name: string;
  content: string;
  status: 'draft' | 'canary' | 'active' | 'retired';
  createdAt: string;
  evaluation?: PromptVersionEvaluation;
}
export interface OrchestrationConfig {
  enabled: boolean;
  mode: 'shadow' | 'enforce';
  externalProviders: {
    enabled: boolean;
    allowlist: string[];
  };
  voice: {
    enabled: boolean;
    provider: 'fish-audio';
    allowedScopes: 'private' | 'group' | 'both';
    userCanChange: boolean;
    licensedOnly: boolean;
    maxCandidates: number;
    candidateTtlMs: number;
    previewMaxChars: number;
    previewCooldownMs: number;
    previewDailyLimit: number;
    voicesApiUrl: string;
  };
  memory: {
    enabled: boolean;
    dataDir: string;
    embeddingNodeIndex: number;
    embeddingModel: string;
    embeddingDimensions: number;
    topK: number;
    minScore: number;
    maxContextChars: number;
    recentTurns: number;
    summarizeEvery: number;
    retentionDays: number;
    hybridSearch: boolean;
    autoIngest: boolean;
    userGlobalProfileEnabled: boolean;
  };
  capabilityOverrides: Record<string, CapabilityOverride>;
  execution: {
    maxSteps: number;
    maxParallelSteps: number;
    maxDepth: number;
    maxDurationMs: number;
    maxCost: number;
    maxModelRounds: number;
    loopDetection: boolean;
    failurePolicy: 'stop' | 'continue' | 'ask';
  };
  planner: {
    enabled: boolean;
    nodeIndex?: number;
    model?: string;
    promptVersion: string;
    systemPromptTemplate: string;
    userPromptTemplate: string;
    capabilityDescriptions: Record<string, string>;
    actionAlignmentGuardEnabled: boolean;
    alignmentGuardConfidenceThreshold: number;
    alignmentReviewMaxTokens: number;
    capabilityTopK: number;
    minConfidence: number;
    maxRepairAttempts: number;
    maxClarifications: number;
    clarificationTimeoutMs: number;
  };
  roles: Record<'planner' | 'retriever' | 'specialist' | 'critic' | 'safety' | 'composer', ModelRoleConfig>;
  help: { extraText: string };
  permissions: {
    defaultLow: PermissionMode;
    defaultMedium: PermissionMode;
    defaultHigh: PermissionMode;
    defaultCritical: PermissionMode;
    hardDenyEnabled: boolean;
    hardDenyCapabilities: string[];
    rules: PermissionRule[];
  };
  approval: {
    enabled: boolean;
    adminQqIds: string[];
    quorum: ApprovalQuorum;
    timeoutMs: number;
    fallback: 'deny' | 'cancel';
    allowGroupReply: boolean;
    allowedGroupIds: string[];
    maxPendingPerUser: number;
    maxPendingGlobal: number;
    resendIntervalMs: number;
    maxResend: number;
    maskArgs: boolean;
  };
  reply: {
    maxMessages: number;
    maxResultItems: number;
    preferNestedForward: boolean;
    nestedMaxNodes: number;
    nestedMaxDepth: number;
    overflowPolicy: 'truncate' | 'link' | 'zip' | 'reject';
    countProgressInBudget: boolean;
    includeTruncationNotice: boolean;
  };
  promptOptimization: {
    enabled: boolean;
    scope: 'task' | 'all';
    canaryPercent: number;
    minSamples: number;
    requireOwnerApproval: boolean;
    activeVersionId: string;
    canaryVersionId: string;
    versions: PromptVersionConfig[];
  };
  suno: {
    enabled: boolean;
    provider: 'suno-official';
    requestMode: 'v6' | 'legacy';
    baseUrl: string;
    apiKey: string;
    model: string;
    callbackUrl: string;
    callbackSecret: string;
    composerNodeIndex?: number;
    composerModel?: string;
    composerPromptTemplate: string;
    composerMaxTokens: number;
    composerTemperature: number;
    sendLyricsWithMusic: boolean;
    defaultVocalGender: 'auto' | 'm' | 'f';
    defaultLanguage: string;
    timeoutMs: number;
    pollIntervalMs: number;
    maxDurationSeconds: number;
    format: 'mp3' | 'wav' | 'flac';
    maxConcurrent: number;
    maxQueue: number;
    maxRetries: number;
    quotaPerUserPerDay: number;
    createPath: string;
    statusPath: string;
    authHeader: string;
    authPrefix: string;
  };
  audit: {
    enabled: boolean;
    retentionDays: number;
  };
}

export function defaultOrchestrationConfig(): OrchestrationConfig {
  return {
    enabled: false,
    mode: 'shadow',
    help: { extraText: '' },
    externalProviders: {
      enabled: false,
      allowlist: ['suno-official'],
    },
    voice: {
      enabled: false,
      provider: 'fish-audio',
      allowedScopes: 'both',
      userCanChange: true,
      licensedOnly: false,
      maxCandidates: 5,
      candidateTtlMs: 600000,
      previewMaxChars: 40,
      previewCooldownMs: 10000,
      previewDailyLimit: 10,
      voicesApiUrl: 'https://api.fish.audio/model',
    },
    memory: {
      enabled: false,
      dataDir: '',
      embeddingNodeIndex: 0,
      embeddingModel: '',
      embeddingDimensions: 1536,
      topK: 8,
      minScore: 0.2,
      maxContextChars: 5000,
      recentTurns: 4,
      summarizeEvery: 20,
      retentionDays: 30,
      hybridSearch: true,
      autoIngest: true,
      userGlobalProfileEnabled: false,
    },
    capabilityOverrides: {},
    execution: {
      maxSteps: 20,
      maxParallelSteps: 4,
      maxDepth: 10,
      maxDurationMs: 600000,
      maxCost: 5,
      maxModelRounds: 6,
      loopDetection: true,
      failurePolicy: 'stop',
    },
    planner: {
      enabled: false,
      promptVersion: 'v3-planner-1',
      systemPromptTemplate: DEFAULT_PLANNER_SYSTEM_PROMPT,
      userPromptTemplate: DEFAULT_PLANNER_USER_PROMPT_TEMPLATE,
      capabilityDescriptions: { ...DEFAULT_PLANNER_CAPABILITY_DESCRIPTIONS },
      actionAlignmentGuardEnabled: true,
      alignmentGuardConfidenceThreshold: 0.8,
      alignmentReviewMaxTokens: 1000,
      capabilityTopK: 12,
      minConfidence: 0.55,
      maxRepairAttempts: 2,
      maxClarifications: 1,
      clarificationTimeoutMs: 300000,
    },
    roles: {
      planner: { enabled: false },
      retriever: { enabled: false },
      specialist: { enabled: false },
      critic: { enabled: false },
      safety: { enabled: false },
      composer: { enabled: false },
    },
    permissions: {
      defaultLow: 'allow',
      defaultMedium: 'allow',
      defaultHigh: 'ask_admin',
      defaultCritical: 'deny',
      hardDenyEnabled: false,
      hardDenyCapabilities: [],
      rules: [],
    },
    approval: {
      enabled: false,
      adminQqIds: [],
      quorum: 'any',
      timeoutMs: 120000,
      fallback: 'deny',
      allowGroupReply: true,
      allowedGroupIds: [],
      maxPendingPerUser: 3,
      maxPendingGlobal: 50,
      resendIntervalMs: 60000,
      maxResend: 2,
      maskArgs: true,
    },
    reply: {
      maxMessages: 3,
      maxResultItems: 20,
      preferNestedForward: true,
      nestedMaxNodes: 20,
      nestedMaxDepth: 2,
      overflowPolicy: 'truncate',
      countProgressInBudget: false,
      includeTruncationNotice: true,
    },
    promptOptimization: {
      enabled: false,
      scope: 'task',
      canaryPercent: 0,
      minSamples: 50,
      requireOwnerApproval: true,
        activeVersionId: '',
        canaryVersionId: '',
        versions: [],
    },
    suno: {
      enabled: false,
      provider: 'suno-official',
      requestMode: 'v6',
      baseUrl: '',
      apiKey: '',
      model: 'V6',
      callbackUrl: '',
      callbackSecret: '',
      composerPromptTemplate: '',
      composerMaxTokens: 6000,
      composerTemperature: 0.6,
      sendLyricsWithMusic: false,
      defaultVocalGender: 'auto',
      defaultLanguage: '',
      timeoutMs: 600000,
      pollIntervalMs: 5000,
      maxDurationSeconds: 300,
      format: 'mp3',
      maxConcurrent: 1,
      maxQueue: 5,
      maxRetries: 2,
      quotaPerUserPerDay: 10,
      createPath: '/api/v1/generate',
      statusPath: '/api/v1/generate/record-info?taskId={id}',
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
    },
    audit: { enabled: true, retentionDays: 180 },
  };
}

export function defaultRiskMode(risk: RiskLevel, config: OrchestrationConfig): PermissionMode {
  if (risk === 'low') return config.permissions.defaultLow;
  if (risk === 'medium') return config.permissions.defaultMedium;
  if (risk === 'high') return config.permissions.defaultHigh;
  return config.permissions.defaultCritical;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const PERMISSION_SCOPES = ['global', 'provider', 'capability', 'role', 'group', 'user'] as const;
const PERMISSION_MODES = ['allow', 'ask_admin', 'deny'] as const;
const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const USER_ROLES: UserRole[] = ['guest', 'user', 'admin', 'owner'];

/**
 * 权限矩阵来自后台/导入文件，必须按固定结构清洗。
 * 这里只做 schema 和范围收敛，不根据自然语言内容做任何路由。
 */
export function normalizePermissionRules(input: unknown): PermissionRule[] {
  if (!Array.isArray(input)) return [];
  const out: PermissionRule[] = [];
  const seen = new Set<string>();
  input.slice(0, 200).forEach((value, index) => {
    const item = record(value);
    const mode = PERMISSION_MODES.includes(item.mode as any) ? item.mode as PermissionMode : undefined;
    if (!mode) return;
    const scope = PERMISSION_SCOPES.includes(item.scope as any) ? item.scope as PermissionRule['scope'] : 'global';
    const rawId = String(item.id || ('rule_' + (index + 1))).trim().slice(0, 120) || ('rule_' + (index + 1));
    let id = rawId;
    let suffix = 2;
    while (seen.has(id)) { id = rawId + '_' + suffix; suffix += 1; }
    seen.add(id);
    const roles = Array.isArray(item.roles)
      ? Array.from(new Set(item.roles.map(String).filter((role): role is UserRole => USER_ROLES.includes(role as UserRole))))
      : [];
    const riskLevels = Array.isArray(item.riskLevels)
      ? Array.from(new Set(item.riskLevels.map(String).filter((risk): risk is RiskLevel => RISK_LEVELS.includes(risk as RiskLevel))))
      : [];
    const rule: PermissionRule = {
      id,
      scope,
      mode,
      priority: numberIn(item.priority, 0, 0, 10000),
      hard: bool(item.hard, false),
      reason: String(item.reason || '后台权限矩阵规则').trim().slice(0, 500),
    };
    if (roles.length) rule.roles = roles;
    if (String(item.qq || '').trim()) rule.qq = String(item.qq).trim().slice(0, 64);
    if (String(item.groupId || '').trim()) rule.groupId = String(item.groupId).trim().slice(0, 64);
    if (String(item.capability || '').trim()) rule.capability = String(item.capability).trim().slice(0, 200);
    if (String(item.provider || '').trim()) rule.provider = String(item.provider).trim().slice(0, 200);
    if (riskLevels.length) rule.riskLevels = riskLevels;
    if (scope === 'user' && !rule.qq) return;
    if (scope === 'group' && !rule.groupId) return;
    if (scope === 'role' && !rule.roles?.length) return;
    if (scope === 'capability' && !rule.capability) return;
    if (scope === 'provider' && !rule.provider) return;
    out.push(rule);
  });
  return out;
}
export function normalizePromptVersions(input: unknown): PromptVersionConfig[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: PromptVersionConfig[] = [];
  for (const value of input.slice(0, 50)) {
    const item = record(value);
    const id = String(item.id || '').trim().slice(0, 120);
    const content = String(item.content || '').slice(0, 50000);
    if (!id || !content.trim() || seen.has(id)) continue;
    seen.add(id);
    const status = ['draft', 'canary', 'active', 'retired'].includes(String(item.status))
      ? String(item.status) as PromptVersionConfig['status']
      : 'draft';
    out.push({
      id,
      name: String(item.name || id).trim().slice(0, 200),
      content,
      status,
      createdAt: String(item.createdAt || new Date().toISOString()),
      ...(item.evaluation && typeof item.evaluation === 'object' ? { evaluation: {
        samples: Math.max(0, Math.trunc(Number(item.evaluation.samples) || 0)),
        successRate: Math.min(1, Math.max(0, Number(item.evaluation.successRate) || 0)),
        averageScore: Math.min(1, Math.max(0, Number(item.evaluation.averageScore) || 0)),
        safetyFailures: Math.max(0, Math.trunc(Number(item.evaluation.safetyFailures) || 0)),
        ownerApproved: Boolean(item.evaluation.ownerApproved),
        promote: Boolean(item.evaluation.promote),
        reason: String(item.evaluation.reason || ''),
        evaluatedAt: String(item.evaluation.evaluatedAt || ''),
      } } : {}),
    });
  }
  return out;
}
export function normalizeOrchestrationConfig(input: unknown): OrchestrationConfig {
  const d = defaultOrchestrationConfig();
  const raw = record(input);
  const execution = record(raw.execution);
  const planner = record(raw.planner);
  const roles = record(raw.roles);
  const permissions = record(raw.permissions);
  const approval = record(raw.approval);
  const help = record(raw.help);
  const reply = record(raw.reply);
  const promptOptimization = record(raw.promptOptimization);
  const suno = record(raw.suno);
  const audit = record(raw.audit);
  const mode = raw.mode === 'enforce' ? 'enforce' : 'shadow';
  const pickMode = (value: unknown, fallback: PermissionMode): PermissionMode => value === 'allow' || value === 'ask_admin' || value === 'deny' ? value : fallback;
  const normalizeRole = (value: unknown, fallback: ModelRoleConfig): ModelRoleConfig => {
    const r = record(value);
    return {
      enabled: bool(r.enabled, fallback.enabled),
      nodeIndex: r.nodeIndex === undefined ? fallback.nodeIndex : numberIn(r.nodeIndex, 0, 0, 10000),
      model: r.model === undefined ? fallback.model : String(r.model),
      timeoutMs: r.timeoutMs === undefined ? fallback.timeoutMs : numberIn(r.timeoutMs, 60000, 1000, 3600000),
      temperature: r.temperature === undefined ? fallback.temperature : numberIn(r.temperature, 0.2, 0, 2),
      maxTokens: r.maxTokens === undefined ? fallback.maxTokens : numberIn(r.maxTokens, 2000, 1, 200000),
      fallbackNodeIndex: r.fallbackNodeIndex === undefined ? fallback.fallbackNodeIndex : numberIn(r.fallbackNodeIndex, 0, 0, 10000),
      fallbackModel: r.fallbackModel === undefined ? fallback.fallbackModel : String(r.fallbackModel),
      promptVersion: r.promptVersion === undefined ? fallback.promptVersion : String(r.promptVersion),
      promptTemplate: r.promptTemplate === undefined ? fallback.promptTemplate : String(r.promptTemplate || ''),
    };
  };
  return {
    enabled: bool(raw.enabled, d.enabled),
    mode,
    externalProviders: {
      enabled: bool(record(raw.externalProviders).enabled, d.externalProviders.enabled),
      allowlist: Array.isArray(record(raw.externalProviders).allowlist) ? record(raw.externalProviders).allowlist.map(String).filter(Boolean) : d.externalProviders.allowlist,
    },
    voice: (() => {
      const v = record(raw.voice);
      return {
        enabled: bool(v.enabled, d.voice.enabled),
        provider: 'fish-audio' as const,
        allowedScopes: v.allowedScopes === 'private' || v.allowedScopes === 'group' ? v.allowedScopes : 'both',
        userCanChange: bool(v.userCanChange, d.voice.userCanChange),
        licensedOnly: bool(v.licensedOnly, d.voice.licensedOnly),
        maxCandidates: numberIn(v.maxCandidates, d.voice.maxCandidates, 1, 10),
        candidateTtlMs: numberIn(v.candidateTtlMs, d.voice.candidateTtlMs, 60000, 3600000),
        previewMaxChars: numberIn(v.previewMaxChars, d.voice.previewMaxChars, 1, 200),
        previewCooldownMs: numberIn(v.previewCooldownMs, d.voice.previewCooldownMs, 0, 3600000),
        previewDailyLimit: numberIn(v.previewDailyLimit, d.voice.previewDailyLimit, 0, 1000),
        voicesApiUrl: String(v.voicesApiUrl || d.voice.voicesApiUrl).trim(),
      };
    })(),
    memory: (() => {
      const m = record(raw.memory);
      return {
        enabled: bool(m.enabled, d.memory.enabled),
        dataDir: String(m.dataDir || d.memory.dataDir).trim(),
        embeddingNodeIndex: numberIn(m.embeddingNodeIndex, d.memory.embeddingNodeIndex, 0, 10000),
        embeddingModel: String(m.embeddingModel || d.memory.embeddingModel).trim(),
        embeddingDimensions: numberIn(m.embeddingDimensions, d.memory.embeddingDimensions, 1, 16384),
        topK: numberIn(m.topK, d.memory.topK, 1, 100),
        minScore: numberIn(m.minScore, d.memory.minScore, 0, 1),
        maxContextChars: numberIn(m.maxContextChars, d.memory.maxContextChars, 200, 50000),
        recentTurns: numberIn(m.recentTurns, d.memory.recentTurns, 0, 20),
        summarizeEvery: numberIn(m.summarizeEvery, d.memory.summarizeEvery, 2, 500),
        retentionDays: numberIn(m.retentionDays, d.memory.retentionDays, 1, 3650),
        hybridSearch: bool(m.hybridSearch, d.memory.hybridSearch),
        autoIngest: bool(m.autoIngest, d.memory.autoIngest),
        userGlobalProfileEnabled: bool(m.userGlobalProfileEnabled, d.memory.userGlobalProfileEnabled),
      };
    })(),
    capabilityOverrides: (() => {
      const source = record(raw.capabilityOverrides);
      const out: Record<string, CapabilityOverride> = {};
      for (const [id, value] of Object.entries(source)) {
        const item = record(value);
        out[id] = {
          ...(item.enabled === undefined ? {} : { enabled: bool(item.enabled, true) }),
          ...(item.approvalRequired === undefined ? {} : { approvalRequired: bool(item.approvalRequired, false) }),
          ...(item.riskLevel === 'low' || item.riskLevel === 'medium' || item.riskLevel === 'high' || item.riskLevel === 'critical' ? { riskLevel: item.riskLevel } : {}),
        };
      }
      return out;
    })(),
    execution: {
      maxSteps: numberIn(execution.maxSteps, d.execution.maxSteps, 1, 1000),
      maxParallelSteps: numberIn(execution.maxParallelSteps, d.execution.maxParallelSteps, 1, 64),
      maxDepth: numberIn(execution.maxDepth, d.execution.maxDepth, 1, 100),
      maxDurationMs: numberIn(execution.maxDurationMs, d.execution.maxDurationMs, 1000, 86400000),
      maxCost: numberIn(execution.maxCost, d.execution.maxCost, 0, 1000000),
      maxModelRounds: numberIn(execution.maxModelRounds, d.execution.maxModelRounds, 1, 100),
      loopDetection: bool(execution.loopDetection, d.execution.loopDetection),
      failurePolicy: execution.failurePolicy === 'continue' || execution.failurePolicy === 'ask' ? execution.failurePolicy : 'stop',
    },
    planner: {
      enabled: bool(planner.enabled, d.planner.enabled),
      nodeIndex: planner.nodeIndex === undefined ? d.planner.nodeIndex : numberIn(planner.nodeIndex, 0, 0, 10000),
      model: planner.model === undefined ? d.planner.model : String(planner.model),
      promptVersion: String(planner.promptVersion || d.planner.promptVersion),
      systemPromptTemplate: String(planner.systemPromptTemplate || d.planner.systemPromptTemplate),
      userPromptTemplate: String(planner.userPromptTemplate || d.planner.userPromptTemplate),
      capabilityDescriptions: Object.fromEntries(Object.entries(planner.capabilityDescriptions && typeof planner.capabilityDescriptions === 'object' && !Array.isArray(planner.capabilityDescriptions) ? planner.capabilityDescriptions : d.planner.capabilityDescriptions).map(([key, value]) => [String(key), String(value ?? '')]).filter(([, value]) => Boolean(value))),
      actionAlignmentGuardEnabled: bool(planner.actionAlignmentGuardEnabled ?? planner.visualIntentGuardEnabled, d.planner.actionAlignmentGuardEnabled),
      alignmentGuardConfidenceThreshold: numberIn(planner.alignmentGuardConfidenceThreshold, d.planner.alignmentGuardConfidenceThreshold, 0, 1),
      alignmentReviewMaxTokens: numberIn(planner.alignmentReviewMaxTokens, d.planner.alignmentReviewMaxTokens, 1, 200000),
      capabilityTopK: numberIn(planner.capabilityTopK, d.planner.capabilityTopK, 1, 100),
      minConfidence: numberIn(planner.minConfidence, d.planner.minConfidence, 0, 1),
      maxRepairAttempts: numberIn(planner.maxRepairAttempts, d.planner.maxRepairAttempts, 0, 10),
      maxClarifications: Math.min(1, numberIn(planner.maxClarifications, d.planner.maxClarifications, 0, 1)),
      clarificationTimeoutMs: numberIn(planner.clarificationTimeoutMs, d.planner.clarificationTimeoutMs, 1000, 86400000),
    },
    help: { extraText: String(help.extraText || '') },
    roles: {
      planner: normalizeRole(roles.planner, d.roles.planner),
      retriever: normalizeRole(roles.retriever, d.roles.retriever),
      specialist: normalizeRole(roles.specialist, d.roles.specialist),
      critic: normalizeRole(roles.critic, d.roles.critic),
      safety: normalizeRole(roles.safety, d.roles.safety),
      composer: normalizeRole(roles.composer, d.roles.composer),
    },
    permissions: {
      defaultLow: pickMode(permissions.defaultLow, d.permissions.defaultLow),
      defaultMedium: pickMode(permissions.defaultMedium, d.permissions.defaultMedium),
      defaultHigh: pickMode(permissions.defaultHigh, d.permissions.defaultHigh),
      defaultCritical: pickMode(permissions.defaultCritical, d.permissions.defaultCritical),
      hardDenyEnabled: bool(permissions.hardDenyEnabled, d.permissions.hardDenyEnabled),
      hardDenyCapabilities: Array.isArray(permissions.hardDenyCapabilities) ? permissions.hardDenyCapabilities.map(String).filter(Boolean) : d.permissions.hardDenyCapabilities,
      rules: normalizePermissionRules(permissions.rules),
    },
    approval: {
      enabled: bool(approval.enabled, d.approval.enabled),
      adminQqIds: Array.isArray(approval.adminQqIds) ? approval.adminQqIds.map(String).filter(Boolean) : d.approval.adminQqIds,
      quorum: approval.quorum === 'all' || approval.quorum === 'owner' ? approval.quorum : 'any',
      timeoutMs: numberIn(approval.timeoutMs, d.approval.timeoutMs, 1000, 86400000),
      fallback: approval.fallback === 'cancel' ? 'cancel' : 'deny',
      allowGroupReply: bool(approval.allowGroupReply, d.approval.allowGroupReply),
      allowedGroupIds: Array.isArray(approval.allowedGroupIds) ? approval.allowedGroupIds.map(String).filter(Boolean) : [],
      maxPendingPerUser: numberIn(approval.maxPendingPerUser, d.approval.maxPendingPerUser, 1, 100),
      maxPendingGlobal: numberIn(approval.maxPendingGlobal, d.approval.maxPendingGlobal, 1, 1000),
      resendIntervalMs: numberIn(approval.resendIntervalMs, d.approval.resendIntervalMs, 1000, 3600000),
      maxResend: numberIn(approval.maxResend, d.approval.maxResend, 0, 10),
      maskArgs: bool(approval.maskArgs, d.approval.maskArgs),
    },
    reply: {
      maxMessages: numberIn(reply.maxMessages, d.reply.maxMessages, 1, 20),
      maxResultItems: numberIn(reply.maxResultItems, d.reply.maxResultItems, 1, 1000),
      preferNestedForward: bool(reply.preferNestedForward, d.reply.preferNestedForward),
      nestedMaxNodes: numberIn(reply.nestedMaxNodes, d.reply.nestedMaxNodes, 1, 200),
      nestedMaxDepth: numberIn(reply.nestedMaxDepth, d.reply.nestedMaxDepth, 1, 5),
      overflowPolicy: reply.overflowPolicy === 'link' || reply.overflowPolicy === 'zip' || reply.overflowPolicy === 'reject' ? reply.overflowPolicy : 'truncate',
      countProgressInBudget: bool(reply.countProgressInBudget, d.reply.countProgressInBudget),
      includeTruncationNotice: bool(reply.includeTruncationNotice, d.reply.includeTruncationNotice),
    },
    promptOptimization: {
      enabled: bool(promptOptimization.enabled, d.promptOptimization.enabled),
      scope: promptOptimization.scope === 'all' ? 'all' : 'task',
      canaryPercent: numberIn(promptOptimization.canaryPercent, d.promptOptimization.canaryPercent, 0, 100),
      minSamples: numberIn(promptOptimization.minSamples, d.promptOptimization.minSamples, 1, 100000),
      requireOwnerApproval: bool(promptOptimization.requireOwnerApproval, d.promptOptimization.requireOwnerApproval),
      activeVersionId: String(promptOptimization.activeVersionId || ''),
      canaryVersionId: String(promptOptimization.canaryVersionId || ''),
      versions: normalizePromptVersions(promptOptimization.versions),
    },
    suno: {
      enabled: bool(suno.enabled, d.suno.enabled),
      provider: 'suno-official',
      requestMode: suno.requestMode === 'legacy' ? 'legacy' : 'v6',
      baseUrl: String(suno.baseUrl || ''),
      apiKey: String(suno.apiKey || ''),
      model: String(suno.model || d.suno.model),
      callbackUrl: String(suno.callbackUrl || d.suno.callbackUrl).trim(),
      callbackSecret: String(suno.callbackSecret || d.suno.callbackSecret).trim(),
      composerNodeIndex: suno.composerNodeIndex === undefined ? undefined : numberIn(suno.composerNodeIndex, d.suno.composerNodeIndex ?? 0, 0, 10000),
      composerModel: suno.composerModel === undefined ? undefined : String(suno.composerModel || '').trim(),
      composerPromptTemplate: String(suno.composerPromptTemplate || ''),
        composerMaxTokens: numberIn(suno.composerMaxTokens, d.suno.composerMaxTokens, 1, 200000),
        composerTemperature: numberIn(suno.composerTemperature, d.suno.composerTemperature, 0, 2),
        sendLyricsWithMusic: bool(suno.sendLyricsWithMusic, d.suno.sendLyricsWithMusic),
      defaultVocalGender: suno.defaultVocalGender === 'm' || suno.defaultVocalGender === 'f' ? suno.defaultVocalGender : 'auto',
      defaultLanguage: String(suno.defaultLanguage || '').trim().slice(0, 80),
      timeoutMs: numberIn(suno.timeoutMs, d.suno.timeoutMs, 1000, 3600000),
      pollIntervalMs: numberIn(suno.pollIntervalMs, d.suno.pollIntervalMs, 500, 60000),
      maxDurationSeconds: numberIn(suno.maxDurationSeconds, d.suno.maxDurationSeconds, 5, 900),
      format: suno.format === 'wav' || suno.format === 'flac' ? suno.format : 'mp3',
      maxConcurrent: numberIn(suno.maxConcurrent, d.suno.maxConcurrent, 1, 20),
      maxQueue: numberIn(suno.maxQueue, d.suno.maxQueue, 1, 1000),
      maxRetries: numberIn(suno.maxRetries, d.suno.maxRetries, 0, 10),
      quotaPerUserPerDay: numberIn(suno.quotaPerUserPerDay, d.suno.quotaPerUserPerDay, 0, 10000),
      createPath: String(suno.createPath || d.suno.createPath),
      statusPath: String(suno.statusPath || d.suno.statusPath),
      authHeader: String(suno.authHeader || d.suno.authHeader),
      authPrefix: String(suno.authPrefix ?? d.suno.authPrefix),
    },
    audit: {
      enabled: bool(audit.enabled, d.audit.enabled),
      retentionDays: numberIn(audit.retentionDays, d.audit.retentionDays, 1, 3650),
    },
  };
}
