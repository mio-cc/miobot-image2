import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { partitionRecallEntries, sentChatKey, type SentMessageTracker } from './sent-messages.js';

export interface OwnerRecallHandlerOptions {
  tracker: SentMessageTracker;
  deleteMessage: (messageId: number | string) => Promise<boolean>;
}

export class OwnerRecallCapabilityHandler implements CapabilityHandler {
  constructor(private readonly options: OwnerRecallHandlerOptions) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const count = Math.max(1, Math.min(20, Math.trunc(Number(invocation.step.args?.count) || 1)));
    const key = sentChatKey(invocation.request.chat.type, invocation.request.chat.groupId, invocation.request.user.qq);
    const entries = this.options.tracker.takeDetailed(key, count);
    if (!entries.length) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: [{ kind: 'text', text: '没有可撤回的本会话机器人消息。', priority: 10, mergeable: true }] };
    }
    const { targets, forward, expired } = partitionRecallEntries(entries);
    const failed: Array<number | string> = [];
    for (const entry of targets) {
      try {
        const ok = await this.options.deleteMessage(entry.id);
        if (!ok) failed.push(entry.id);
      } catch { failed.push(entry.id); }
    }
    if (failed.length) this.options.tracker.restoreEntries(key, targets.filter((entry) => failed.some((f) => String(f) === String(entry.id))));
    const succeeded = targets.length - failed.length;
    const parts: string[] = [];
    if (succeeded) parts.push(`已撤回 ${succeeded} 条消息`);
    if (forward.length) parts.push(`${forward.length} 条合并转发无法撤回（QQ 协议限制）`);
    if (expired) parts.push(`${expired} 条已超撤回窗口`);
    if (failed.length) parts.push(`${failed.length} 条撤回失败`);
    const text = parts.length ? parts.join('；') + '。' : '撤回失败。';
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: succeeded && !failed.length && !forward.length && !expired ? 'success' : 'partial',
      outputs: [{ kind: 'text', text, priority: 10, mergeable: true }],
      diagnostics: { succeeded, failed: failed.length, expired, forward: forward.length },
    };
  }
}
