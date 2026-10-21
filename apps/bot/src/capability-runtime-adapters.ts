import type { BotEngineResult } from '../../../packages/bot-engine/src/index.js';
import type { CapabilityHandler, CapabilityInvocation, ExecutionOutput, ExecutionResult } from '../../../packages/orchestration/src/index.js';

export function executionFromBotResult(
  invocation: CapabilityInvocation,
  result: BotEngineResult | null | undefined,
  fallbackError = 'capability_no_result',
): ExecutionResult {
  if (!result) {
    return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: fallbackError };
  }
  const outputs: ExecutionOutput[] = [];
  if (result.text?.trim()) outputs.push({ kind: 'text', text: result.text, priority: 10, mergeable: true });
  for (const image of result.images || []) outputs.push({ kind: 'image', url: image, priority: 9, mergeable: true });
  for (const video of result.videos || []) outputs.push({ kind: 'video', url: video, priority: 8, mergeable: true });
  const legacySpokenText = result.kind === 'chat' && result.text?.trim() && (result.audio || []).length ? result.text.trim() : undefined;
  for (const audio of result.audio || []) outputs.push({
    kind: 'audio', url: audio, priority: 10, mergeable: false,
    ...(legacySpokenText ? { meta: { spokenText: legacySpokenText, preferredVoice: true, voiceRequested: true, sourceCapability: 'tts.speak' } } : {}),
  });
  for (const file of result.files || []) {
    const value = typeof file === 'string' ? { file } : file;
    outputs.push({ kind: 'file', url: value.file, priority: 5, mergeable: false, meta: { name: value.name } });
  }
  return {
    jobId: invocation.plan.planId,
    stepId: invocation.step.id,
    status: result.handled ? 'success' : 'failed',
    outputs,
    error: result.handled ? undefined : result.decision?.reason || fallbackError,
    retryable: false,
    diagnostics: { legacyKind: result.kind, source: result.decision?.source },
  };
}

export class RuntimeAdapterCapabilityHandler implements CapabilityHandler {
  constructor(private readonly run: (invocation: CapabilityInvocation) => Promise<ExecutionResult>) {}
  execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    return this.run(invocation);
  }
}
