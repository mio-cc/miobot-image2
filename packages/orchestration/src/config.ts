import type { ApprovalQuorum, PermissionMode, PermissionRule, RiskLevel, UserRole } from './types.js';

export interface CapabilityOverride {
  enabled?: boolean;
  approvalRequired?: boolean;
  riskLevel?: RiskLevel;
  /** presentation recommendation; empty means no change. */
  presentationHint?: string;
  /** D22：显示名覆盖（能力中心自定义命名 / MCP 根与子项同一套字段）。 */
  name?: string;
  /** D22：超时覆盖（ms）。 */
  timeoutMs?: number;
}

/** 流程编排（2026-11-07 拍板）：能力默认调用链的一步——capability 为目标能力 id，
 *  hint 为该步的参数/行为提示（≤120 字符），when 为自然语言条件（给模型读，不做运行时求值）。 */
export interface CapabilityFlowStep {
  capability: string;
  hint?: string;
  when?: string;
}

/** 能力默认调用链：单条；steps 有序；未配置 = 默认链 = 该能力自己（单步，零成本）。 */
export interface CapabilityFlowConfig {
  steps: CapabilityFlowStep[];
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
    /** 参数默认值（根级，2026-11-07）：作用于全部子项；locked=true 时强制覆盖模型传参。 */
    paramDefaults?: Record<string, { value: string | number | boolean; locked?: boolean }>;
    /** 参数默认值（子项级）：键=子项工具名；同键整条覆盖根级。 */
    childParamDefaults?: Record<string, Record<string, { value: string | number | boolean; locked?: boolean }>>;
    /** P2-MCP：鉴权模式（缺省=静态 token/免鉴权；oauth=浏览器账号授权）。 */
    auth?: 'static' | 'oauth';
    /** L1：根工具描述覆写——模型检索工具时看到的短简介，替代自动生成的目录式描述。 */
    rootDescription?: string;
    /** L2：使用指南全文——模型 action=guide 时返回；缺省由运行时 guideResolver 从 dataDir 读文件兜底。 */
    guide?: string;
    /** 系统预置项标记：自动注入、不可删除，只允许停用/断开（用户不填此字段）。 */
    builtin?: boolean;
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
    // recentTurns（无条件注入最近 N 条）已随 P0 注入去重（2026-11-07 拍板）删除：
    // 与群上下文最近 30 条整段重叠，是跨通道重复注入的结构性根源之一。
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
  /** 流程编排：能力默认调用链（键=能力 id）。与 capabilityOverrides 分键空间——后者管「树内待遇」，
   *  这里管「调用组合」；不配置 = 单步 = 自己。纯声明+提示注入，不进执行路径（零运行时状态）。 */
  capabilityFlows: Record<string, CapabilityFlowConfig>;
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

/**
 * 内置 MCP 预置项：作为模块能力随配置默认值注入，用户打开面板即可看到并直接授权，
 * 不需要手填 URL/传输/鉴权。已存在同 id 的用户配置时只补 `builtin` 标记，
 * 不覆盖用户字段（尤其是 enabled:false 必须保持停用）。
 */
export const BUILTIN_MCP_SERVERS: OrchestrationConfig['mcpServers'] = [
  {
    id: 'suno-official',
    enabled: true,
    transport: 'http',
    url: 'https://api.suno.com/mcp',
    auth: 'oauth',
    builtin: true,
  },
  {
    id: 'box',
    enabled: false,
    transport: 'http',
    url: 'https://mcp.box.simular.ai/mcp',
    auth: 'oauth',
    builtin: true,
    // L1（检索期简介）：模型扫工具目录时看到的短文本；指南全文由运行时从 dataDir/mcp-guides/box.md 读取（L2）。
    rootDescription: 'Box 云桌面：可远程操作的 Linux（Ubuntu 24.04，Chrome + LibreOffice，联网，可装软件）。能力：跑 shell/脚本、读写文件、浏览器浏览与交互、桌面 GUI 自动化、截图。入口：action=工具名、params=参数。先 list_actions 看清单；深度使用前先 guide 取使用指南。注意：截图原图不会回传给你，视觉判断请用文本层工具或在脚本里调 desk 的 ask/decide。',
  },
];

/** 合并内置项：不存在则补默认值；已存在则只补 builtin 标记，保留用户已有配置。 */
function mergeBuiltinMcpServers(servers: OrchestrationConfig['mcpServers']): OrchestrationConfig['mcpServers'] {
  for (const preset of BUILTIN_MCP_SERVERS) {
    const existing = servers.find((server) => server.id === preset.id);
    if (existing) {
      existing.builtin = true;
      continue;
    }
    servers.push({ ...preset });
  }
  return servers;
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
    mcpServers: BUILTIN_MCP_SERVERS.map((server) => ({ ...server })),
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
    capabilityFlows: {},
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
/**
 * 流程编排（capabilityFlows）规整：清洗 steps（capability 必填、hint≤120、when≤200），
 * 悬挂引用（能力 id 不在注册表）不在此拦截——链是提示不是依赖，模型调不到会收到既有错误。
 * 上限：≤64 条链 × ≤12 步（防配置膨胀；超出部分丢弃）。
 */
export function normalizeCapabilityFlows(input: unknown): Record<string, CapabilityFlowConfig> {
  const source = record(input);
  const out: Record<string, CapabilityFlowConfig> = {};
  for (const [id, value] of Object.entries(source).slice(0, 64)) {
    const key = id.trim().slice(0, 200);
    if (!key) continue;
    const item = record(value);
    if (!Array.isArray(item.steps) || !item.steps.length) continue;
    const steps: CapabilityFlowStep[] = [];
    for (const step of item.steps.slice(0, 12)) {
      const s = record(step);
      const capability = String(s.capability || '').trim().slice(0, 200);
      if (!capability) continue;
      steps.push({
        capability,
        ...(String(s.hint || '').trim() ? { hint: String(s.hint).trim().slice(0, 120) } : {}),
        ...(String(s.when || '').trim() ? { when: String(s.when).trim().slice(0, 200) } : {}),
      });
    }
    if (steps.length) out[key] = { steps };
  }
  return out;
}

/**
 * MCP 参数默认值规整（2026-11-07）：value 必须是 string|number|boolean；键 ≤120 字符；
 * 上限 32 键（根级）/ 32 子项 × 32 键（子项级）——超出丢弃。悬挂键（schema 里没有的参数）不拦截：
 * 合并发生在校验之前，真有问题会以带路径的可读错误暴露。
 */
function normalizeParamDefaultRules(input: unknown): Record<string, { value: string | number | boolean; locked?: boolean }> {
  const source = record(input);
  const out: Record<string, { value: string | number | boolean; locked?: boolean }> = {};
  for (const [rawKey, rawValue] of Object.entries(source).slice(0, 32)) {
    const key = rawKey.trim().slice(0, 120);
    if (!key) continue;
    const item = record(rawValue);
    const { value } = item;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    out[key] = { value, ...(item.locked === true ? { locked: true } : {}) };
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
    mcpServers: mergeBuiltinMcpServers((Array.isArray(raw.mcpServers) ? raw.mcpServers : []).flatMap((entry: unknown) => {
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
        // 参数默认值（2026-11-07）：根级 + 子项级（空对象不落键）。
        ...(Object.keys(record(item.paramDefaults)).length ? { paramDefaults: normalizeParamDefaultRules(item.paramDefaults) } : {}),
        ...(Object.keys(record(item.childParamDefaults)).length ? {
          childParamDefaults: Object.fromEntries(
            Object.entries(record(item.childParamDefaults)).slice(0, 32)
              .map(([toolName, rules]) => [String(toolName).trim().slice(0, 120), normalizeParamDefaultRules(rules)])
              .filter(([toolName, rules]) => String(toolName) && Object.keys(rules as object).length > 0),
          ),
        } : {}),
        // P2-MCP：鉴权模式（static 默认 | oauth）、代理（本地调试可选项）、目录缓存 TTL、stdio 重连策略。
        ...(item.auth === 'oauth' ? { auth: 'oauth' as const } : {}),
        // L1/L2（2026-11-10，box MCP 接入）：根描述覆写与使用指南全文，截断防配置膨胀。
        ...(typeof item.rootDescription === 'string' && item.rootDescription.trim() ? { rootDescription: item.rootDescription.trim().slice(0, 600) } : {}),
        ...(typeof item.guide === 'string' && item.guide.trim() ? { guide: item.guide.trim().slice(0, 65536) } : {}),
        ...(typeof item.proxyUrl === 'string' && /^https?:\/\//i.test(item.proxyUrl.trim()) ? { proxyUrl: item.proxyUrl.trim() } : {}),
        ...(item.toolsCacheTtlMs !== undefined && Number.isFinite(Number(item.toolsCacheTtlMs)) ? { toolsCacheTtlMs: Math.max(0, Math.trunc(Number(item.toolsCacheTtlMs))) } : {}),
        ...(item.reconnect && typeof item.reconnect === 'object' ? {
          reconnect: {
            ...(Number.isFinite(Number(item.reconnect.maxAttempts)) ? { maxAttempts: Math.max(1, Math.trunc(Number(item.reconnect.maxAttempts))) } : {}),
            ...(Number.isFinite(Number(item.reconnect.delayMs)) ? { delayMs: Math.max(0, Math.trunc(Number(item.reconnect.delayMs))) } : {}),
          },
        } : {}),
      }];
    })),
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
          // D22：显示名与超时覆盖（MCP 根/子项与能力中心同一套字段）。
          ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim().slice(0, 120) } : {}),
          ...(item.timeoutMs !== undefined && Number.isFinite(Number(item.timeoutMs)) ? { timeoutMs: Math.max(1000, Math.trunc(Number(item.timeoutMs))) } : {}),
        };
      }
      return out;
    })(),
    capabilityFlows: normalizeCapabilityFlows(raw.capabilityFlows),
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
