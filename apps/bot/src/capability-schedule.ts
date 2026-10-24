import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/** T4.3：定时提醒的投递目标（注册时快照请求者会话，到点原路投回）。 */
export interface ScheduleTarget {
  chatType: 'group' | 'private';
  groupId?: string;
  userId: string;
}

export interface ScheduleHandlerOptions {
  schedule: (input: { remindText: string; runAt: string; target: ScheduleTarget }) => Promise<{ id: string }>;
  now?: () => Date;
  logger?: StructuredLogger;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * T4.3 定时提醒能力（task.schedule）：
 * planner 把"明早9点提醒我X"解析为 {remindText, at(ISO) | inMinutes}，
 * handler 注册一次性调度任务；到点由 SchedulerService 合成消息走完整消息链。
 * 时间信息缺失/已过去 → needs_input（结构化事实，交追问或模型修复轮），绝不静默猜时间。
 */
export class ScheduleCapabilityHandler implements CapabilityHandler {
  constructor(private readonly options: ScheduleHandlerOptions) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const args = invocation.step.args || {};
    const base = { jobId: invocation.plan.planId, stepId: invocation.step.id };
    const remindText = String(args.remindText || args.text || '').trim();
    if (!remindText) {
      return { ...base, status: 'needs_input', outputs: [], diagnostics: { missingInformation: ['提醒内容'] } };
    }
    const now = (this.options.now || (() => new Date()))();
    let runAt: Date | undefined;
    const at = String(args.at || '').trim();
    const inMinutes = Number(args.inMinutes);
    if (at) {
      const parsed = new Date(at);
      if (!Number.isNaN(parsed.getTime())) runAt = parsed;
    } else if (Number.isFinite(inMinutes) && inMinutes > 0) {
      runAt = new Date(now.getTime() + inMinutes * 60_000);
    }
    if (!runAt || runAt.getTime() <= now.getTime()) {
      return {
        ...base, status: 'needs_input', outputs: [],
        diagnostics: { missingInformation: ['提醒时间（ISO 时间或多少分钟后）'], detail: 'schedule_time_missing_or_past' },
      };
    }
    const target: ScheduleTarget = {
      chatType: invocation.request.chat.type === 'group' ? 'group' : 'private',
      ...(invocation.request.chat.groupId !== undefined ? { groupId: String(invocation.request.chat.groupId) } : {}),
      userId: String(invocation.request.user.qq || ''),
    };
    try {
      const scheduled = await this.options.schedule({ remindText, runAt: runAt.toISOString(), target });
      const local = `${runAt.getFullYear()}-${pad(runAt.getMonth() + 1)}-${pad(runAt.getDate())} ${pad(runAt.getHours())}:${pad(runAt.getMinutes())}`;
      return {
        ...base, status: 'success',
        outputs: [{ kind: 'text', text: `好的，${local} 提醒你：${remindText}`, priority: 10, mergeable: true }],
        diagnostics: { scheduledId: scheduled.id, runAt: runAt.toISOString() },
      };
    } catch (error) {
      this.options.logger?.warn('定时提醒注册失败', { error: String((error as Error)?.message || error) });
      return { ...base, status: 'failed', outputs: [], error: 'schedule_register_failed', retryable: true };
    }
  }
}
