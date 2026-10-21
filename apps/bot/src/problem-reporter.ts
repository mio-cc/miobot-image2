import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { ApprovalSendResult } from './approval-runtime.js';

export interface ProblemReportInput {
  kind: string;
  error?: unknown;
  chatType: 'group' | 'private';
  groupId?: string | number;
  userId?: string | number;
  message?: string;
  extra?: Record<string, unknown>;
}

export interface ProblemReporterOptions {
  adminQqIds: () => string[];
  ownerQqIds?: () => string[];
  sendPrivate: (qq: string, text: string) => Promise<ApprovalSendResult>;
  logger?: StructuredLogger;
  dedupeWindowMs?: number;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export class ProblemReporter {
  private readonly recent = new Map<string, number>();
  private readonly dedupeWindowMs: number;

  constructor(private readonly options: ProblemReporterOptions) {
    this.dedupeWindowMs = Math.max(0, options.dedupeWindowMs ?? 15000);
  }

  private recipients(): string[] {
    return Array.from(new Set([
      ...this.options.adminQqIds().map(String),
      ...(this.options.ownerQqIds?.() || []).map(String),
    ].map((item) => item.trim()).filter(Boolean)));
  }

  async report(input: ProblemReportInput): Promise<boolean> {
    const detail = input.message?.trim() || errorText(input.error) || '未知问题';
    const fingerprint = `${input.kind}|${detail}|${input.chatType}|${input.groupId || ''}|${input.userId || ''}`;
    const now = Date.now();
    for (const [key, at] of this.recent) {
      if (now - at > this.dedupeWindowMs) this.recent.delete(key);
    }
    if (this.dedupeWindowMs > 0 && this.recent.has(fingerprint)) return false;
    this.recent.set(fingerprint, now);
    const recipients = this.recipients();
    if (!recipients.length) {
      this.options.logger?.error('问题上报失败：未配置管理员 QQ', { kind: input.kind, detail: detail.slice(0, 500) });
      return false;
    }
    const text = [
      '【Miobot 问题上报】',
      `类型: ${input.kind}`,
      `时间: ${new Date().toISOString()}`,
      `聊天: ${input.chatType}${input.groupId ? ` / 群 ${input.groupId}` : ''}`,
      `用户: ${input.userId || '-'}`,
      `详情: ${detail.slice(0, 1200)}`,
      input.extra && Object.keys(input.extra).length ? `上下文: ${JSON.stringify(input.extra).slice(0, 1200)}` : '',
    ].filter(Boolean).join('\n');
    this.options.logger?.warn('问题已上报管理员', { kind: input.kind, recipients: recipients.length, detail: detail.slice(0, 300) });
    await Promise.allSettled(recipients.map((qq) => this.options.sendPrivate(qq, text)));
    return true;
  }
}
