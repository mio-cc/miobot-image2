export type UserRole = 'guest' | 'user' | 'admin' | 'owner';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PermissionMode = 'allow' | 'ask_admin' | 'deny';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ApprovalQuorum = 'any' | 'all' | 'owner';
export type OutputKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'link' | 'card';

export interface ChatContext {
  type: 'group' | 'private';
  groupId?: string;
  userId?: string;
}

export interface UserContext {
  qq: string;
  role: UserRole;
  groups?: string[];
}

export interface UserRequest {
  requestId: string;
  chat: ChatContext;
  user: UserContext;
  text: string;
  attachments?: Array<Record<string, unknown>>;
  replyContext?: Record<string, unknown>;
  history?: Array<Record<string, unknown>>;
  pendingJobId?: string;
  receivedAt?: string;
}

export interface IntentStep {
  id: string;
  capability: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
  optional?: boolean;
  condition?: string;
  approvalRequired?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  estimatedCost?: number;
  modelRounds?: number;
}

export interface PlanUnderstanding {
  goal: string;
  desiredOutcome: CapabilityEffect;
  constraints: string[];
  missingInformation: string[];
  confidence: number;
}

export interface IntentPlan {
  planId: string;
  requestId: string;
  goal: string;
  understanding?: PlanUnderstanding;
  language?: string;
  steps: IntentStep[];
  budget?: {
    maxSteps?: number;
    maxDurationMs?: number;
    maxCost?: number;
    maxModelRounds?: number;
    maxParallelSteps?: number;
    maxDepth?: number;
  };
  /** 规划阶段实际消耗的模型轮数，用于执行预算续算。 */
  modelRoundsUsed?: number;
  needsClarification?: boolean;
  clarificationQuestion?: string;
  confidence?: number;
  source?: 'model' | 'command' | 'fallback';
}

export interface ClarificationRequest {
  clarificationId: string;
  jobId: string;
  stepId?: string;
  missing: string[];
  question: string;
  options?: string[];
  expiresAt: string;
}

export type CapabilityEffect = 'answer' | 'retrieve' | 'generate' | 'transform' | 'mutate' | 'delete' | 'notify' | 'control' | 'unknown';
export type CapabilityContextRequirement = 'image' | 'file' | 'video' | 'url' | 'reply' | 'thread';
export type CapabilitySideEffect = 'creates_artifact' | 'modifies_state' | 'deletes_data' | 'sends_message' | 'external_call';

export interface CapabilityDescriptor {
  id: string;
  version: string;
  name: string;
  description?: string;
  /** 语义结果类型：Planner 按期望结果和副作用匹配，而不是按主题词匹配。 */
  effect?: CapabilityEffect;
  /** 执行前必须具备的事实性上下文，例如图片、文件、URL。 */
  requiredContext?: CapabilityContextRequirement[];
  /** 客观副作用；不用于表达能力适用/不适用规则。 */
  sideEffects?: CapabilitySideEffect[];
  provider: string;
  enabled: boolean;
  aliases?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputKinds?: OutputKind[];
  permissions?: UserRole[];
  riskLevel?: RiskLevel;
  approvalRequired?: boolean;
  /** auto: 可按用户配置自动 TTS；skip: 命令/查询类结果不进入自动 TTS。 */
  ttsPolicy?: 'auto' | 'skip';
  mode?: 'sync' | 'async_job' | 'stream' | 'interactive';
  queue?: string;
  timeoutMs?: number;
  maxRetries?: number;
  mergeable?: boolean;
  expectedLatency?: 'fast' | 'medium' | 'slow';
  costClass?: 'free' | 'low' | 'medium' | 'high';
  external?: boolean;
  estimatedCost?: number;
  modelRounds?: number;
}

export interface ExecutionOutput {
  kind: OutputKind;
  id?: string;
  text?: string;
  url?: string;
  mime?: string;
  size?: number;
  priority?: number;
  mergeable?: boolean;
  meta?: Record<string, unknown>;
}

export interface ExecutionResult {
  jobId: string;
  stepId?: string;
  status: 'success' | 'partial' | 'failed' | 'needs_input' | 'waiting_approval' | 'denied';
  outputs: ExecutionOutput[];
  diagnostics?: Record<string, unknown>;
  error?: string;
  retryable?: boolean;
  durationMs?: number;
  cost?: number;
  modelRounds?: number;
}

export interface ReplyGroup {
  mode: 'nested_forward' | 'flat_forward' | 'direct';
  outputs: ExecutionOutput[];
  messageCount: number;
}

export interface ReplyPlan {
  groups: ReplyGroup[];
  messageCount: number;
  truncated: ExecutionOutput[];
  warnings: string[];
  maxMessages?: number;
  noticeIncluded?: boolean;
  noticeSuppressed?: boolean;
    dedupedCount?: number;
}

export interface PermissionRule {
  id: string;
  scope: 'global' | 'provider' | 'capability' | 'role' | 'group' | 'user';
  mode: PermissionMode;
  priority?: number;
  roles?: UserRole[];
  qq?: string;
  groupId?: string;
  capability?: string;
  provider?: string;
  riskLevels?: RiskLevel[];
  hard?: boolean;
  reason?: string;
}

export interface PermissionRequest {
  capability: string;
  provider?: string;
  riskLevel: RiskLevel;
  user: UserContext;
  chat: ChatContext;
  estimatedCost?: number;
  params?: Record<string, unknown>;
}

export interface PermissionDecision {
  decision: PermissionMode;
  reason: string;
  matchedRule?: string;
  hardDenied: boolean;
  policyVersion?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  code: string;
  requestId: string;
  jobId: string;
  stepId?: string;
  payloadHash: string;
  capability: string;
  riskLevel: RiskLevel;
  requesterQq: string;
  groupId?: string;
  adminQqIds: string[];
  ownerQqIds?: string[];
  quorum: ApprovalQuorum;
  status: ApprovalState;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  responseDeliveryUncertain?: boolean;
  decisions?: ApprovalDecision[];
}

export interface ApprovalDecision {
  adminQq: string;
  decision: 'approve' | 'reject' | 'cancel';
  at: string;
  reason?: string;
}
