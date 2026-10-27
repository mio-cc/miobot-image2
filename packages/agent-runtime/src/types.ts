import type { ToolCall, ToolError, ToolExposure, ToolOutput, ToolRequiredContext, ToolResult, ToolSpec } from '../../tool-runtime/src/index.js';

export type AgentToolSpec = ToolSpec;
export type AgentToolCall = ToolCall;
export type AgentToolResult = ToolResult;
export type AgentToolError = ToolError;
export type AgentToolOutput = ToolOutput;
export type AgentToolExposure = ToolExposure;
export type AgentToolRequiredContext = ToolRequiredContext;

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';
export type AgentRuntimeMode = 'off' | 'shadow' | 'enforce';

export interface AgentSystemMessage {
  role: 'system';
  content: string;
}

export interface AgentUserMessage {
  role: 'user';
  content: string;
  attachments?: AgentAttachment[];
  /** P0-4：本轮真实图片输入（http/data URL）。model port 会把它们转成 provider 的 image content part。 */
  imageRefs?: string[];
  meta?: Record<string, unknown>;
}

export interface AgentAssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: AgentToolCall[];
  finishReason?: string;
  meta?: Record<string, unknown>;
}

export interface AgentToolMessage {
  role: 'tool';
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export type AgentMessage = AgentSystemMessage | AgentUserMessage | AgentAssistantMessage | AgentToolMessage;

export interface AgentAssistantTurn {
  text?: string;
  toolCalls?: AgentToolCall[];
  finishReason?: string;
  usage?: AgentUsage;
  raw?: unknown;
}

export interface AgentAttachment {
  kind: 'image' | 'file' | 'video' | 'audio' | 'url' | 'unknown';
  ref: string;
  name?: string;
  mime?: string;
  meta?: Record<string, unknown>;
}

export interface AgentArtifactRef {
  id: string;
  kind: string;
  url?: string;
  name?: string;
  meta?: Record<string, unknown>;
}

export interface AgentUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  modelRounds?: number;
  toolRounds?: number;
}

export interface AgentTurnError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export type AgentApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface AgentApprovalRecord {
  approvalId: string;
  status: AgentApprovalStatus;
  toolName: string;
  callId?: string;
  payloadHash: string;
  createdAt: string;
  expiresAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export type AgentJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface AgentJobRecord {
  jobId: string;
  status: AgentJobStatus;
  toolName: string;
  callId?: string;
  configRevision?: string;
  createdAt: string;
  updatedAt?: string;
  error?: AgentTurnError;
  meta?: Record<string, unknown>;
}

export interface AgentReplyPreference {
  mode?: 'auto' | 'direct' | 'quote' | 'plain' | 'forward';
  forwardStyle?: 'auto' | 'nested' | 'flat';
  voice?: 'auto' | 'on' | 'off';
  reference?: 'auto' | 'quote' | 'none';
  scope?: 'turn' | 'session' | 'user';
}

/** AgentTurnState is the serializable working state for one turn. */
export interface AgentPendingQuestion {
  toolCallId: string;
  question: string;
  missingFields: string[];
  options?: string[];
  createdAt: string;
}

export interface AgentSessionState {
  sessionKey: string;
  turnId: string;
  messages: AgentMessage[];
  pendingToolCalls?: AgentToolCall[];
  pendingApprovals?: AgentApprovalRecord[];
  pendingJobs?: AgentJobRecord[];
  pendingQuestion?: AgentPendingQuestion;
  compactSummary?: string;
  pinnedFacts: Record<string, unknown>;
  replyPreference?: AgentReplyPreference;
  artifacts: AgentArtifactRef[];
  configRevision: string;
  runtimeVersion: string;
  createdAt?: string;
  updatedAt?: string;
}

export type AgentTurnState = AgentSessionState;

export interface AgentTurnInput {
  sessionKey: string;
  turnId: string;
  userText: string;
  attachments?: AgentAttachment[];
  configRevision: string;
  runtimeVersion: string;
  replyPreference?: AgentReplyPreference;
  pinnedFacts?: Record<string, unknown>;
  availableToolNames?: string[];
  availableContext?: AgentToolRequiredContext[];
  toolChoice?: 'auto' | 'required' | 'none';
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export type AgentTurnStatus = 'completed' | 'failed' | 'cancelled' | 'suspended';

export interface AgentTurnResult {
  sessionKey: string;
  turnId: string;
  status: AgentTurnStatus;
  text?: string;
  messages?: AgentMessage[];
  toolResults?: AgentToolResult[];
  replyPreference?: AgentReplyPreference;
  usage?: AgentUsage;
  error?: AgentTurnError;
  pendingApproval?: AgentApprovalRecord;
  pendingJob?: AgentJobRecord;
  pendingQuestion?: AgentPendingQuestion;
  meta?: Record<string, unknown>;
}

export interface AgentFeatureFlag {
  enabled: boolean;
  mode: AgentRuntimeMode;
}

export const DEFAULT_AGENT_FEATURE_FLAG: Readonly<AgentFeatureFlag> = Object.freeze({ enabled: false, mode: 'off' });
