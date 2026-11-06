import type { ApprovalQuorum, PermissionMode, PermissionRule, RiskLevel, UserRole } from './types.js';

export interface CapabilityOverride {
  enabled?: boolean;
  approvalRequired?: boolean;
  riskLevel?: RiskLevel;
  /** presentation recommendation; empty means no change. */
  presentationHint?: string;
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


export interface OrchestrationConfig {
  enabled: boolean;
  mode: 'shadow' | 'enforce';
  externalProviders: {
    enabled: boolean;
    allowlist: string[];
  };
  /** T4.1：MCP server 配置——启动时连入并把 tools 转为能力 descriptor（默认 deny，逐工具 allowlist 开启）。 */
  mcpServers: Array<{
    id: string;
    enabled: boolean;
    transport: 'stdio' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    token?: string;
    /** 只注册列出的工具名（留空注册全部，全部默认 deny）。 */
    allowlist?: string[];
  }>;
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
    /** 用途级备用（方案 6-P2）：空串/缺键 = 无备用。 */
    fallbackEmbeddingNodeIndex?: number;
    fallbackEmbeddingModel?: string;
    embeddingDimensions: number;
    // topK/minScore/maxContextChars 曾与 contextPolicy.memory* 双真源并存，已收口删除——
    // 检索预算唯一真源 contextPolicy.memoryTopK/memoryMinScore/memoryMaxChars。
    recentTurns: number;
    summarizeEvery: number;
    retentionDays: number;
    hybridSearch: boolean;
    autoIngest: boolean;
    userGlobalProfileEnabled: boolean;
    /**
     * 记忆库优先（灰度开关）：群聊回复的上下文组装在记忆命中非空时跳过 Napcat
     * get_group_msg_history 拉取（省一次上游调用）；记忆为空/关闭时仍走群历史兜底。
     */
    memoryFirstGroupContext: boolean;
    /** 观察与写入（Harness Memory Layer）：所有消息先观察入库，再触发路由。 */
    observation: {
      enabled: boolean;
      includeGroupMessages: boolean;
      includePrivateMessages: boolean;
      includeAssistantReplies: boolean;
      includeAttachments: boolean;
      maxTextCharsPerMessage: number;
      /**
       * 连发消息合并窗口（ms）：触发后短暂等待并收集同会话窗口内的相邻消息
       * （卡头/中间/结尾带触发的连发场景），合并进回合输入；0 = 关闭。所有消息仍照常入库。
       */
      coalesceWindowMs: number;
    };
    /** 保留与清理：每 cleanupIntervalDays 天执行一次，滚动保留 retentionDays 天。 */
    retention: {
      cleanupIntervalDays: number;
      cleanupHour: number;
      cleanupMinute: number;
    };
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
    nodeIndex?: number;
    model?: string;
    /** suno 局部编辑推理 maxTokens 兜底（capability-suno-library）。 */
    alignmentReviewMaxTokens: number;
    /** 执行期（needs_input）追问次数上限（enforce 执行循环）。 */
    maxClarifications: number;
    /** 执行期追问 pending 的过期时间。 */
    clarificationTimeoutMs: number;
  };
  roles: { planner: ModelRoleConfig };
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
    overflowPolicy: 'truncate' | 'link' | 'zip' | 'reject' | 'forward';
    /** 保底首段直发：always=多内容转发前首块文本先直发，转发失败不丢核心内容。 */
    textFallback: 'always' | 'on_forward_fail' | 'off';
    countProgressInBudget: boolean;
    includeTruncationNotice: boolean;
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
    /** 用途级备用（方案 6-P2）：空串/缺键 = 无备用。 */
    fallbackComposerNodeIndex?: number;
    fallbackComposerModel?: string;
    composerPromptTemplate: string;
    composerMaxTokens: number;
    composerTemperature: number;
    sendLyricsWithMusic: boolean;
    historyMaxRecords: number;
    historyPromptLimit: number;
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
    mcpServers: [],
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
      recentTurns: 4,
      summarizeEvery: 20,
      retentionDays: 3,
      hybridSearch: true,
      autoIngest: true,
      userGlobalProfileEnabled: false,
      memoryFirstGroupContext: false,
      observation: {
        enabled: true,
        includeGroupMessages: true,
        includePrivateMessages: true,
        includeAssistantReplies: true,
        includeAttachments: true,
        maxTextCharsPerMessage: 10000,
        coalesceWindowMs: 400,
      },
      retention: {
        cleanupIntervalDays: 3,
        cleanupHour: 4,
        cleanupMinute: 0,
      },
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
      alignmentReviewMaxTokens: 1000,
      maxClarifications: 1,
      clarificationTimeoutMs: 300000,
    },
    roles: {
      planner: { enabled: false },
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
      overflowPolicy: 'forward',
      textFallback: 'always',
      countProgressInBudget: false,
      includeTruncationNotice: true,
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
      historyMaxRecords: 100,
      historyPromptLimit: 5,
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

function numberIn(value: unknown, fallback: number, min: number, max?: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (max === undefined) return Math.max(min, n);
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
    // T4.1：MCP server 配置规整——只保留形态完整的条目（transport 与对应必填项齐全），其余丢弃。
    mcpServers: (Array.isArray(raw.mcpServers) ? raw.mcpServers : []).flatMap((entry: unknown) => {
      const item = record(entry);
      const id = String(item.id || '').trim();
      const transport = item.transport === 'http' ? 'http' as const : 'stdio' as const;
      const command = String(item.command || '').trim();
      const url = String(item.url || '').trim();
      if (!id) return [];
      if (transport === 'stdio' && !command) return [];
      if (transport === 'http' && !url) return [];
      return [{
        id,
        enabled: bool(item.enabled, false),
        transport,
        ...(transport === 'stdio' ? { command } : { url }),
        ...(Array.isArray(item.args) ? { args: item.args.map(String) } : {}),
        ...(String(item.token || '').trim() ? { token: String(item.token).trim() } : {}),
        ...(Array.isArray(item.allowlist) ? { allowlist: item.allowlist.map(String).filter(Boolean) } : {}),
      }];
    }),
    voice: (() => {
      const v = record(raw.voice);
      return {
        enabled: bool(v.enabled, d.voice.enabled),
        provider: 'fish-audio' as const,
        allowedScopes: v.allowedScopes === 'private' || v.allowedScopes === 'group' ? v.allowedScopes : 'both',
        userCanChange: bool(v.userCanChange, d.voice.userCanChange),
        licensedOnly: bool(v.licensedOnly, d.voice.licensedOnly),
        maxCandidates: numberIn(v.maxCandidates, d.voice.maxCandidates, 1),
        candidateTtlMs: numberIn(v.candidateTtlMs, d.voice.candidateTtlMs, 60000, 3600000),
        previewMaxChars: numberIn(v.previewMaxChars, d.voice.previewMaxChars, 1),
        previewCooldownMs: numberIn(v.previewCooldownMs, d.voice.previewCooldownMs, 0, 3600000),
        previewDailyLimit: numberIn(v.previewDailyLimit, d.voice.previewDailyLimit, 0, 1000),
        voicesApiUrl: String(v.voicesApiUrl || d.voice.voicesApiUrl).trim(),
      };
    })(),
    memory: (() => {
      const m = record(raw.memory);
      const obs = record(m.observation);
      const ret = record(m.retention);
      return {
        enabled: bool(m.enabled, d.memory.enabled),
        dataDir: String(m.dataDir || d.memory.dataDir).trim(),
        embeddingNodeIndex: numberIn(m.embeddingNodeIndex, d.memory.embeddingNodeIndex, 0, 10000),
        embeddingModel: m.embeddingModel === undefined || m.embeddingModel === null ? d.memory.embeddingModel : String(m.embeddingModel).trim().slice(0, 200),
        // 用途级备用（方案 6-P2）：model 空串/缺键不落盘 = 无备用。
        ...(String(m.fallbackEmbeddingModel || '').trim() ? {
          fallbackEmbeddingModel: String(m.fallbackEmbeddingModel).trim().slice(0, 200),
          fallbackEmbeddingNodeIndex: numberIn(m.fallbackEmbeddingNodeIndex, 0, 0, 10000),
        } : {}),
        embeddingDimensions: numberIn(m.embeddingDimensions, d.memory.embeddingDimensions, 1, 16384),
        recentTurns: numberIn(m.recentTurns, d.memory.recentTurns, 0, 20),
        summarizeEvery: numberIn(m.summarizeEvery, d.memory.summarizeEvery, 2, 500),
        retentionDays: numberIn(m.retentionDays, d.memory.retentionDays, 1, 3650),
        hybridSearch: bool(m.hybridSearch, d.memory.hybridSearch),
        autoIngest: bool(m.autoIngest, d.memory.autoIngest),
        userGlobalProfileEnabled: bool(m.userGlobalProfileEnabled, d.memory.userGlobalProfileEnabled),
        memoryFirstGroupContext: bool(m.memoryFirstGroupContext, d.memory.memoryFirstGroupContext),
        observation: {
          enabled: bool(obs.enabled, d.memory.observation.enabled),
          includeGroupMessages: bool(obs.includeGroupMessages, d.memory.observation.includeGroupMessages),
          includePrivateMessages: bool(obs.includePrivateMessages, d.memory.observation.includePrivateMessages),
          includeAssistantReplies: bool(obs.includeAssistantReplies, d.memory.observation.includeAssistantReplies),
          includeAttachments: bool(obs.includeAttachments, d.memory.observation.includeAttachments),
          maxTextCharsPerMessage: numberIn(obs.maxTextCharsPerMessage, d.memory.observation.maxTextCharsPerMessage, 200, 200000),
          coalesceWindowMs: numberIn(obs.coalesceWindowMs, d.memory.observation.coalesceWindowMs, 0, 2000),
        },
        retention: {
          cleanupIntervalDays: numberIn(ret.cleanupIntervalDays, d.memory.retention.cleanupIntervalDays, 1, 365),
          cleanupHour: numberIn(ret.cleanupHour, d.memory.retention.cleanupHour, 0, 23),
          cleanupMinute: numberIn(ret.cleanupMinute, d.memory.retention.cleanupMinute, 0, 59),
        },
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
          ...(typeof item.presentationHint === 'string' ? { presentationHint: String(item.presentationHint).trim().slice(0, 2000) } : {}),
        };
      }
      return out;
    })(),
    execution: {
      maxSteps: numberIn(execution.maxSteps, d.execution.maxSteps, 1, 1000),
      maxParallelSteps: numberIn(execution.maxParallelSteps, d.execution.maxParallelSteps, 1, 64),
      maxDepth: numberIn(execution.maxDepth, d.execution.maxDepth, 1),
      maxDurationMs: numberIn(execution.maxDurationMs, d.execution.maxDurationMs, 1000, 86400000),
      maxCost: numberIn(execution.maxCost, d.execution.maxCost, 0, 1000000),
      maxModelRounds: numberIn(execution.maxModelRounds, d.execution.maxModelRounds, 1, 100),
      loopDetection: bool(execution.loopDetection, d.execution.loopDetection),
      failurePolicy: execution.failurePolicy === 'continue' || execution.failurePolicy === 'ask' ? execution.failurePolicy : 'stop',
    },
    planner: {
      nodeIndex: planner.nodeIndex === undefined ? d.planner.nodeIndex : numberIn(planner.nodeIndex, 0, 0, 10000),
      model: planner.model === undefined ? d.planner.model : String(planner.model),
      // 2026-11-06 清理：规划提示词/对齐复核/置信度门等字段随自然语言规划分支删除；
      // 这三个字段仍被消费——执行期追问（enforce）与 suno 局部编辑推理（capability-suno-library）。
      alignmentReviewMaxTokens: numberIn(planner.alignmentReviewMaxTokens, d.planner.alignmentReviewMaxTokens, 1),
      maxClarifications: numberIn(planner.maxClarifications, d.planner.maxClarifications, 0),
      clarificationTimeoutMs: numberIn(planner.clarificationTimeoutMs, d.planner.clarificationTimeoutMs, 1000, 86400000),
    },
    help: { extraText: String(help.extraText || '') },
    roles: {
      planner: normalizeRole(roles.planner, d.roles.planner),
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
      maxMessages: numberIn(reply.maxMessages, d.reply.maxMessages, 1),
      maxResultItems: numberIn(reply.maxResultItems, d.reply.maxResultItems, 1, 1000),
      preferNestedForward: bool(reply.preferNestedForward, d.reply.preferNestedForward),
      nestedMaxNodes: numberIn(reply.nestedMaxNodes, d.reply.nestedMaxNodes, 1, 200),
      nestedMaxDepth: numberIn(reply.nestedMaxDepth, d.reply.nestedMaxDepth, 1),
      // truncate 仍是合法显式选择（旧配置兼容）；默认（缺省/非法值）才是 forward。
      overflowPolicy: reply.overflowPolicy === 'truncate' || reply.overflowPolicy === 'link' || reply.overflowPolicy === 'zip' || reply.overflowPolicy === 'reject' || reply.overflowPolicy === 'forward' ? reply.overflowPolicy : 'forward',
      textFallback: reply.textFallback === 'off' || reply.textFallback === 'on_forward_fail' ? reply.textFallback : 'always',
      countProgressInBudget: bool(reply.countProgressInBudget, d.reply.countProgressInBudget),
      includeTruncationNotice: bool(reply.includeTruncationNotice, d.reply.includeTruncationNotice),
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
      // 用途级备用（方案 6-P2）：model 空串/缺键不落盘 = 无备用。
      ...(String(suno.fallbackComposerModel || '').trim() ? {
        fallbackComposerModel: String(suno.fallbackComposerModel).trim().slice(0, 200),
        fallbackComposerNodeIndex: numberIn(suno.fallbackComposerNodeIndex, 0, 0, 10000),
      } : {}),
      composerPromptTemplate: String(suno.composerPromptTemplate || ''),
        composerMaxTokens: numberIn(suno.composerMaxTokens, d.suno.composerMaxTokens, 1),
        composerTemperature: numberIn(suno.composerTemperature, d.suno.composerTemperature, 0),
        sendLyricsWithMusic: bool(suno.sendLyricsWithMusic, d.suno.sendLyricsWithMusic),
        historyMaxRecords: numberIn(suno.historyMaxRecords, d.suno.historyMaxRecords, 1),
        historyPromptLimit: numberIn(suno.historyPromptLimit, d.suno.historyPromptLimit, 1),
      defaultVocalGender: suno.defaultVocalGender === 'm' || suno.defaultVocalGender === 'f' ? suno.defaultVocalGender : 'auto',
      defaultLanguage: String(suno.defaultLanguage || '').trim().slice(0, 80),
      // Suno 是远程异步生成，timeoutMs 是任务级等待上限，不是单次 HTTP 超时。
      // 20 秒这类配置会把仍在生成的任务误判为失败，导致 Agent 重复提交。
      timeoutMs: numberIn(suno.timeoutMs, Math.max(600000, d.suno.timeoutMs), 600000, 3600000),
      pollIntervalMs: numberIn(suno.pollIntervalMs, d.suno.pollIntervalMs, 500, 60000),
      maxDurationSeconds: numberIn(suno.maxDurationSeconds, d.suno.maxDurationSeconds, 5, 900),
      format: suno.format === 'wav' || suno.format === 'flac' ? suno.format : 'mp3',
      maxConcurrent: numberIn(suno.maxConcurrent, d.suno.maxConcurrent, 1, 20),
      maxQueue: numberIn(suno.maxQueue, d.suno.maxQueue, 1, 1000),
      maxRetries: numberIn(suno.maxRetries, d.suno.maxRetries, 0),
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
