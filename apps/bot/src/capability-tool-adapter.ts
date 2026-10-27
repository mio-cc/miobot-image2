import type {
  CapabilityDescriptor,
  CapabilityHandler,
  CapabilityInvocation,
  ExecutionOutput,
  ExecutionResult,
  IntentPlan,
  IntentStep,
  UserRequest,
  UserRole,
} from '../../../packages/orchestration/src/index.js';
import { runWithExternalTaskScope } from '../../../packages/orchestration/src/index.js';
import {
  makeToolError,
  toolSpecFromCapabilityDescriptor,
  type ToolCall,
  type ToolExecutionContext,
  type ToolHandler,
  type ToolOutput,
  type ToolResult,
  type ToolSpec,
  type ToolSpecAdapterOptions,
} from '../../../packages/tool-runtime/src/index.js';

export interface CapabilityToolBinding {
  spec: ToolSpec;
  handler: ToolHandler;
}

/** Capabilities whose result is information-only and safe to expose to the R5 agent loop. */
export const READ_ONLY_CAPABILITY_TOOLS = new Set([
  'web.search',
  'image.interrogate',
  'file.list',
  'file.read',
  'audio.music.history',
  'audio.music.lyrics',
  'canvas.gallery',
  'prompt.enhance',
  'prompt.translate',
  'template.list',
  'model.catalog.list',
  'help',
  'voice.current',
  'voice.search',
  'owner.model.list',
]);

/** Artifact-producing tools whose structured outputs can already be sent through ReplyPlan. */
export const ARTIFACT_CAPABILITY_TOOLS = new Set([
  'image.generate',
  'image.edit',
  'image.stitch',
  'video.generate',
  'file.generate',
  'code.render',
  'browser.render',
  'audio.music.generate',
  'audio.music.replay',
  'audio.music.variant',
  'audio.music.replace_section',
  'tts.speak',
  'template.use',
]);

export const INTERACTIVE_CAPABILITY_TOOLS = new Set([
  'voice.preview',
  'voice.select',
]);

export const STATEFUL_CAPABILITY_TOOLS = new Set([
  'file.delete',
  'config.update',
  'permission.update',
  'owner.recall',
  'task.schedule',
]);
/** Non-read-only tools that must never fall back to the old engine after execution. */
export const SIDE_EFFECT_CAPABILITY_TOOLS = new Set([
  ...ARTIFACT_CAPABILITY_TOOLS,
  ...INTERACTIVE_CAPABILITY_TOOLS,
  ...STATEFUL_CAPABILITY_TOOLS,
]);
export const MIGRATED_CAPABILITY_TOOLS = new Set([
  ...READ_ONLY_CAPABILITY_TOOLS,
  ...ARTIFACT_CAPABILITY_TOOLS,
  ...INTERACTIVE_CAPABILITY_TOOLS,
  ...STATEFUL_CAPABILITY_TOOLS,
]);
export function createCapabilityToolBinding(descriptor: CapabilityDescriptor, handler: CapabilityHandler, options: ToolSpecAdapterOptions = {}): CapabilityToolBinding {
  return {
    spec: toolSpecFromCapabilityDescriptor(descriptor, { migrationStatus: 'adapted', ...options }),
    handler: createCapabilityToolHandler(descriptor, handler),
  };
}

export function createCapabilityToolHandler(descriptor: CapabilityDescriptor, handler: CapabilityHandler): ToolHandler {
  return async (call: ToolCall, spec: ToolSpec, context: ToolExecutionContext): Promise<ToolResult> => {
    const meta = context.metadata || {};
    const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? call.arguments as Record<string, unknown>
      : {};
    const chatType = meta.chatType === 'group' ? 'group' : 'private';
    const userId = String(meta.userId ?? context.sessionKey.split(':').at(-1) ?? '');
    const role = normalizeUserRole(meta.userRole);
    const requestId = context.requestId || `${context.turnId}:${call.id}`;
    const step: IntentStep = { id: call.id, capability: descriptor.id, args };
    const plan: IntentPlan = {
      planId: `tool_plan_${context.turnId}_${call.id}`,
      requestId,
      goal: descriptor.name || descriptor.id,
      steps: [step],
      source: 'model',
    };
    const request: UserRequest = {
      requestId,
      chat: {
        type: chatType,
        ...(meta.groupId !== undefined ? { groupId: String(meta.groupId) } : {}),
        ...(userId ? { userId } : {}),
      },
      user: { qq: userId, role },
      text: String(meta.userText || firstString(args.prompt, args.request, args.query, args.title) || ''),
      attachments: Array.isArray(meta.attachments) ? meta.attachments as Array<Record<string, unknown>> : [],
      ...(meta.referencedText ? { replyContext: { text: String(meta.referencedText) } } : {}),
      ...(Array.isArray(meta.history) ? { history: meta.history as Array<Record<string, unknown>> } : {}),
    };
    const invocation: CapabilityInvocation = {
      request,
      plan,
      step,
      dependencyResults: {},
      signal: context.signal,
      ...((typeof meta.reportExternalTask === 'function' || context.reportExternalTask)
        ? { reportExternalTask: (meta.reportExternalTask || context.reportExternalTask) as (taskId: string) => void }
        : {}),
    };
    const execute = () => handler.execute(invocation);
    const result = context.reportExternalTask
      ? await runWithExternalTaskScope({ stepId: step.id, capability: descriptor.id, report: context.reportExternalTask }, execute)
      : await execute();
    return executionResultToToolResult(result, call, spec);
  };
}

export function executionResultToToolResult(result: ExecutionResult, call: ToolCall, spec: ToolSpec): ToolResult {
  const outputs = (Array.isArray(result.outputs) ? result.outputs : []).map(toToolOutput);
  const content = outputs
    .map((output) => output.text || '')
    .filter(Boolean)
    .join('\n');
  const meta = {
    executionStatus: result.status,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.cost !== undefined ? { cost: result.cost } : {}),
    ...(result.modelRounds !== undefined ? { modelRounds: result.modelRounds } : {}),
  };
  if (result.status === 'success' || result.status === 'partial') {
    return {
      callId: call.id,
      toolName: spec.name,
      ok: true,
      ...(content ? { content } : { content: JSON.stringify({ status: result.status, outputs }) }),
      ...(outputs.length ? { outputs } : {}),
      ...(result.jobId ? { jobId: result.jobId } : {}),
      meta,
    };
  }
  const code = result.status === 'denied'
    ? 'permission_denied'
    : result.status === 'waiting_approval'
      ? 'approval_required'
      : result.status === 'needs_input'
        ? 'invalid_arguments'
        : 'tool_execution_failed';
  return {
    callId: call.id,
    toolName: spec.name,
    ok: false,
    content: content || undefined,
    ...(outputs.length ? { outputs } : {}),
    error: makeToolError({
      code,
      message: result.error || `Capability ${spec.name} finished with status ${result.status}.`,
      callId: call.id,
      toolName: spec.name,
      retryable: result.retryable === true,
      details: {
        executionStatus: result.status,
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      },
    }),
    meta,
  };
}

function toToolOutput(output: ExecutionOutput): ToolOutput {
  return {
    kind: output.kind,
    ...(output.id ? { id: output.id } : {}),
    ...(output.text !== undefined ? { text: output.text } : {}),
    ...(output.url !== undefined ? { url: output.url } : {}),
    ...(output.mime !== undefined ? { mime: output.mime } : {}),
    ...(output.size !== undefined ? { size: output.size } : {}),
    ...(output.priority !== undefined ? { priority: output.priority } : {}),
    ...(output.mergeable !== undefined ? { mergeable: output.mergeable } : {}),
    ...(output.meta ? { meta: output.meta } : {}),
  };
}

function normalizeUserRole(value: unknown): UserRole {
  return value === 'owner' || value === 'admin' || value === 'guest' || value === 'user' ? value : 'user';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}
