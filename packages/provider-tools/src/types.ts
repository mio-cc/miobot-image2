import type { ToolResult, ToolSpec } from '../../tool-runtime/src/index.js';

export type ProviderToolProtocol = 'native' | 'json-fallback' | 'none';
export type ProviderToolChoice = 'auto' | 'required' | 'none';

export interface ProviderToolCall {
  id: string;
  /** Canonical Miobot tool name, not the provider-safe wire name. */
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  parseError?: string;
}

export type ProviderToolIssueCode =
  | 'empty_output'
  | 'malformed_json'
  | 'truncated_output'
  | 'invalid_envelope'
  | 'missing_tool_call_id';

export interface ProviderToolIssue {
  code: ProviderToolIssueCode;
  message: string;
  callId?: string;
  toolName?: string;
  path?: string;
  received?: unknown;
}

export interface ParsedProviderToolResponse {
  toolCalls: ProviderToolCall[];
  /** Text portion returned by a JSON envelope or alongside native calls. */
  text?: string;
  issues: ProviderToolIssue[];
  finishReason?: string;
  truncated: boolean;
}

export type ProviderMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Provider-neutral message accepted by adapters and emitted back to model dialects. */
export interface ProviderToolMessage {
  role: ProviderMessageRole;
  content: unknown;
  toolCalls?: ProviderToolCall[];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ProviderToolContext {
  /** Canonical tool names in the current loadout. Used to reverse provider-safe wire names. */
  toolNames?: string[];
  finishReason?: string;
}

export interface ProviderToolAdapter {
  readonly id: 'openai' | 'anthropic' | 'gemini' | 'json-fallback';
  buildTools(tools: ToolSpec[], context?: ProviderToolContext): unknown;
  buildToolChoice(choice: ProviderToolChoice): unknown;
  parseToolCalls(raw: unknown, context?: ProviderToolContext): ProviderToolCall[];
  parseToolResponse(raw: unknown, context?: ProviderToolContext): ParsedProviderToolResponse;
  appendToolResult(messages: ProviderToolMessage[], result: ToolResult): ProviderToolMessage[];
}
