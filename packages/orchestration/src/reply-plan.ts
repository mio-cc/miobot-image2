import type { ExecutionOutput, ReplyGroup, ReplyPlan } from './types.js';

export interface ReplyPlanOptions {
  maxMessages?: number;
  maxResultItems?: number;
  preferNestedForward?: boolean;
  includeTruncationNotice?: boolean;
  nestedMaxNodes?: number;
  nestedMaxDepth?: number;
  overflowPolicy?: 'truncate' | 'link' | 'zip' | 'reject';
}

function defaultMergeable(output: ExecutionOutput): boolean {
  if (output.kind === 'file' || output.kind === 'audio') return false;
  if (typeof output.mergeable === 'boolean') return output.mergeable;
  return output.kind === 'text' || output.kind === 'image' || output.kind === 'video';
}

const KIND_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '语音',
  file: '文件',
  link: '链接',
  card: '卡片',
};

function truncationNotice(outputs: ExecutionOutput[]): string {
  const counts = new Map<string, number>();
  for (const output of outputs) counts.set(output.kind, (counts.get(output.kind) || 0) + 1);
  const detail = Array.from(counts.entries())
    .map(([kind, count]) => (KIND_LABEL[kind] || kind) + ' ' + count + ' 个')
    .join('、');
  return '已按消息上限截断 ' + outputs.length + ' 个低优先级结果' + (detail ? '（' + detail + '）' : '') + '；主结果已保留。';
}

function overflowNotice(outputs: ExecutionOutput[], policy: 'truncate' | 'link' | 'zip' | 'reject'): string {
  const base = truncationNotice(outputs);
  if (policy !== 'link' && policy !== 'zip') return base;
  const links = outputs
    .filter((output) => Boolean(output.url))
    .slice(0, 8)
    .map((output, index) => (index + 1) + '. ' + (KIND_LABEL[output.kind] || output.kind) + ' ' + output.url);
  const prefix = policy === 'zip' ? base + ' ZIP 降级不可用，已回退为链接摘要。' : base;
  return links.length ? prefix + '\n' + links.join('\n') : prefix;
}
interface GroupCandidate {
  group: ReplyGroup;
  position: number;
}

export function buildReplyPlan(outputs: ExecutionOutput[], options: ReplyPlanOptions = {}): ReplyPlan {
  const maxMessages = Math.max(1, Math.trunc(Number(options.maxMessages) || 3));
  const maxResultItems = Math.max(1, Math.trunc(Number(options.maxResultItems) || 20));
  const preferNestedForward = options.preferNestedForward !== false;
  const includeTruncationNotice = options.includeTruncationNotice === true;
  const nestedMaxNodes = Math.max(1, Math.trunc(Number(options.nestedMaxNodes) || 20));
  const nestedMaxDepth = Math.max(1, Math.trunc(Number(options.nestedMaxDepth) || 2));
  const overflowPolicy = options.overflowPolicy === 'link' || options.overflowPolicy === 'zip' || options.overflowPolicy === 'reject'
    ? options.overflowPolicy
    : 'truncate';
  const indexed = outputs
    .map((output, index) => ({ output, index }))
    .sort((a, b) => {
      const priority = Number(b.output.priority || 0) - Number(a.output.priority || 0);
      return priority !== 0 ? priority : a.index - b.index;
    });

  const keptWithIndex = indexed.slice(0, maxResultItems);
  const truncated: ExecutionOutput[] = indexed.slice(maxResultItems).map((item) => item.output);
  const kept = keptWithIndex.map((item) => item.output);

  let mergeable = keptWithIndex.filter((item) => defaultMergeable(item.output));
  if (mergeable.length > nestedMaxNodes) {
    truncated.push(...mergeable.slice(nestedMaxNodes).map((item) => item.output));
    mergeable = mergeable.slice(0, nestedMaxNodes);
  }
  const direct = keptWithIndex.filter((item) => !defaultMergeable(item.output));
  const candidates: GroupCandidate[] = [];
  if (mergeable.length) {
    candidates.push({
      position: Math.min(...mergeable.map((item) => item.index)),
      group: {
        mode: preferNestedForward && nestedMaxDepth >= 2 ? 'nested_forward' : 'flat_forward',
        outputs: mergeable.map((item) => item.output),
        messageCount: 1,
      },
    });
  }
  for (const item of direct) {
    candidates.push({
      position: item.index,
      group: { mode: 'direct', outputs: [item.output], messageCount: 1 },
    });
  }
  candidates.sort((a, b) => a.position - b.position);
  const groups: ReplyGroup[] = [];
  let usedMessages = 0;
  const droppedGroups: ExecutionOutput[] = [];
  for (const candidate of candidates) {
    if (usedMessages + candidate.group.messageCount > maxMessages) {
      droppedGroups.push(...candidate.group.outputs);
      continue;
    }
    groups.push(candidate.group);
    usedMessages += candidate.group.messageCount;
  }
  truncated.push(...droppedGroups);
  let noticeIncluded = false;
  let warnings: string[] = [];
  if (truncated.length) {
    const notice = overflowNotice(truncated, overflowPolicy);
    warnings = [notice];
    if (overflowPolicy === 'reject') {
      groups.splice(0, groups.length, {
        mode: 'direct',
        outputs: [{ id: 'reply-overflow-rejected', kind: 'text', text: '结果数量超过限制，已按拒绝策略拦截。' + notice, priority: 0, mergeable: true, meta: { synthetic: true, reason: 'overflow_reject' } }],
        messageCount: 1,
      });
      usedMessages = 1;
      noticeIncluded = true;
    } else if (includeTruncationNotice && groups.length) {
      const mergeableGroup = groups.find((group) => group.mode !== 'direct');
      if (mergeableGroup) {
        mergeableGroup.outputs.push({
          id: 'reply-truncation-notice',
          kind: 'text',
          text: notice,
          priority: 0,
          mergeable: true,
          meta: { synthetic: true, reason: 'truncation_notice' },
        });
        noticeIncluded = true;
      } else if (usedMessages < maxMessages) {
        groups.push({
          mode: 'direct',
          outputs: [{ id: 'reply-truncation-notice', kind: 'text', text: notice, priority: 0, mergeable: true, meta: { synthetic: true, reason: 'truncation_notice' } }],
          messageCount: 1,
        });
        usedMessages += 1;
        noticeIncluded = true;
      } else if (groups.length === 1) {
        const main = groups[0].outputs[0];
        if (main?.kind === 'file') {
          const originalName = typeof main.meta?.name === 'string' && main.meta.name.trim() ? main.meta.name.trim() : '结果';
          main.meta = { ...(main.meta || {}), name: originalName + '（' + notice + '）', replyNotice: notice };
          noticeIncluded = true;
        }
      } else if (groups.length > 1) {
        const removed = groups.pop();
        if (removed) {
          truncated.push(...removed.outputs);
          usedMessages -= removed.messageCount;
        }
        const updatedNotice = overflowNotice(truncated, overflowPolicy);
        warnings = [updatedNotice];
        groups.push({
          mode: 'direct',
          outputs: [{ id: 'reply-truncation-notice', kind: 'text', text: updatedNotice, priority: 0, mergeable: true, meta: { synthetic: true, reason: 'truncation_notice' } }],
          messageCount: 1,
        });
        usedMessages += 1;
        noticeIncluded = true;
      }
    }
  }
  return {
    groups,
    messageCount: usedMessages,
    truncated,
    warnings,
    maxMessages,
    noticeIncluded,
    noticeSuppressed: includeTruncationNotice === false,
  };
}