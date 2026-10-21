import type { ApprovalRequest } from './types.js';

export interface ApprovalPromptOptions {
  maskArgs?: boolean;
  summary?: string;
}

export function renderApprovalPrompt(approval: ApprovalRequest, options: ApprovalPromptOptions = {}): string {
  const lines = [
    '【Miobot 高风险审批】',
    `审批码：${approval.code}`,
    `用户：${approval.requesterQq}`,
    approval.groupId ? `群：${approval.groupId}` : '场景：私聊',
    `能力：${approval.capability}`,
    `风险：${approval.riskLevel}`,
    `任务：${approval.jobId}${approval.stepId ? ` / ${approval.stepId}` : ''}`,
  ];
  if (options.summary) lines.push(`操作：${options.summary}`);
  if (options.maskArgs === false) lines.push(`参数摘要：${approval.payloadHash.slice(0, 16)}`);
  lines.push('', '回复：', `同意 ${approval.code}`, `拒绝 ${approval.code}`, `取消 ${approval.code}`);
  return lines.join('\n');
}

export interface ParsedApprovalReply {
  decision: 'approve' | 'reject' | 'cancel';
  code: string;
}

export function parseApprovalReply(text: string): ParsedApprovalReply | null {
  const value = String(text || '').trim();
  if (!value) return null;
  const match = /^(同意|批准|approve|拒绝|驳回|reject|取消|cancel)\s+([a-z0-9]{4,12})$/i.exec(value);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const decision = raw === '同意' || raw === '批准' || raw === 'approve'
    ? 'approve'
    : raw === '拒绝' || raw === '驳回' || raw === 'reject'
      ? 'reject'
      : 'cancel';
  return { decision, code: match[2].toUpperCase() };
}
