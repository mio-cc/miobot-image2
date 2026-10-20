import type { ExecutionOutput, ReplyGroup, ReplyPlan } from './types.js';

export interface ReplyPlanOptions {
  maxMessages?: number;
  maxResultItems?: number;
  preferNestedForward?: boolean;
}

function defaultMergeable(output: ExecutionOutput): boolean {
  if (typeof output.mergeable === 'boolean') return output.mergeable;
  return output.kind === 'text' || output.kind === 'image' || output.kind === 'video';
}

export function buildReplyPlan(outputs: ExecutionOutput[], options: ReplyPlanOptions = {}): ReplyPlan {
  const maxMessages = Math.max(1, Math.trunc(Number(options.maxMessages) || 3));
  const maxResultItems = Math.max(1, Math.trunc(Number(options.maxResultItems) || 20));
  const preferNestedForward = options.preferNestedForward !== false;
  const sorted = outputs
    .map((output, index) => ({ output, index }))
    .sort((a, b) => {
      const priority = Number(b.output.priority || 0) - Number(a.output.priority || 0);
      return priority !== 0 ? priority : a.index - b.index;
    })
    .map((item) => item.output);
  const kept = sorted.slice(0, maxResultItems);
  const truncated = sorted.slice(maxResultItems);
  const mergeable = kept.filter(defaultMergeable);
  const direct = kept.filter((item) => !defaultMergeable(item));
  const groups: ReplyGroup[] = [];
  if (mergeable.length) {
    groups.push({
      mode: preferNestedForward ? 'nested_forward' : 'flat_forward',
      outputs: mergeable,
      messageCount: 1,
    });
  }
  for (const output of direct) {
    groups.push({ mode: 'direct', outputs: [output], messageCount: 1 });
  }
  const visibleGroups: ReplyGroup[] = [];
  for (const group of groups) {
    if (visibleGroups.reduce((sum, item) => sum + item.messageCount, 0) + group.messageCount > maxMessages) break;
    visibleGroups.push(group);
  }
  const visibleIds = new Set(visibleGroups.flatMap((group) => group.outputs.map((item) => item.id || item.url || item.text || '')));
  const droppedByBudget = kept.filter((item) => !visibleIds.has(item.id || item.url || item.text || ''));
  const allTruncated = [...truncated, ...droppedByBudget];
  const warnings: string[] = [];
  if (allTruncated.length) warnings.push(`已截断 ${allTruncated.length} 个低优先级结果`);
  return {
    groups: visibleGroups,
    messageCount: visibleGroups.reduce((sum, group) => sum + group.messageCount, 0),
    truncated: allTruncated,
    warnings,
  };
}
