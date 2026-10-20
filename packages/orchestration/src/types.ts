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
}

export interface IntentPlan {
  planId: string;
  requestId: string;
  goal: string;
  language?: string;
  steps: IntentStep[];
  budget?: {
    maxSteps?: number;
    maxDurationMs?: number;
    maxCost?: number;
    maxModelRounds?: number;
  };
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

export interface CapabilityDescriptor {
  id: string;
  version: string;
  name: string;
  description?: string;
  provider: string;
  enabled: boolean;
  aliases?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputKinds?: OutputKind[];
  permissions?: UserRole[];
  riskLevel?: RiskLevel;
  approvalRequired?: boolean;
  mode?: 'sync' | 'async_job' | 'stream' | 'interactive';
  queue?: string;
  timeoutMs?: number;
  maxRetries?: number;
  mergeable?: boolean;
  expectedLatency?: 'fast' | 'medium' | 'slow';
  costClass?: 'free' | 'low' | 'medium' | 'high';
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
