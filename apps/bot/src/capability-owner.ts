import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { sentChatKey, type SentMessageTracker } from './sent-messages.js';

export interface OwnerRecallHandlerOptions {
  tracker: SentMessageTracker;
  deleteMessage: (messageId: number | string) => Promise<boolean>;
}

export class OwnerRecallCapabilityHandler implements CapabilityHandler {
  constructor(private readonly options: OwnerRecallHandlerOptions) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const count = Math.max(1, Math.min(20, Math.trunc(Number(invocation.step.args?.count) || 1)));
    const key = sentChatKey(invocation.request.chat.type, invocation.request.chat.groupId, invocation.request.user.qq);
    const ids = this.options.tracker.take(key, count);
    if (!ids.length) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: [{ kind: 'text', text: '没有可撤回的本会话机器人消息。', priority: 10, mergeable: true }] };
    }
    const failed: Array<number | string> = [];
    for (const id of ids) {
      try {
        const ok = await this.options.deleteMessage(id);
        if (!ok) failed.push(id);
      } catch { failed.push(id); }
    }
    if (failed.length) this.options.tracker.restore(key, failed);
    const succeeded = ids.length - failed.length;
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: failed.length ? 'partial' : 'success',
      outputs: [{ kind: 'text', text: succeeded ? `已撤回 ${succeeded} 条消息${failed.length ? `，${failed.length} 条失败` : ''}。` : '撤回失败。', priority: 10, mergeable: true }],
      diagnostics: { succeeded, failed: failed.length },
    };
  }
}
