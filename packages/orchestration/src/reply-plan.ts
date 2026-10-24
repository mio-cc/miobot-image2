import type { ExecutionOutput, ReplyGroup, ReplyPlan } from './types.js';

export interface ReplyPlanOptions {
  maxMessages?: number;
  maxResultItems?: number;
  preferNestedForward?: boolean;
  includeTruncationNotice?: boolean;
  nestedMaxNodes?: number;
  nestedMaxDepth?: number;
  overflowPolicy?: 'truncate' | 'link' | 'zip' | 'reject' | 'forward';
  /** 单条文本上限；超长文本拆成多个块（直发与转发节点同界）。0 = 不拆分。 */
  textMaxChars?: number;
  /** 保底首段直发：多内容转发前，最高优先级文本的首块先直发，转发失败也不丢核心内容。 */
  textFallback?: 'always' | 'on_forward_fail' | 'off';
}

/**
 * 按段落/句子边界把长文本拆成 ≤maxChars 的块（与 reply 层 splitLongText 同语义的本地实现，
 * 避免 orchestration 反向依赖 reply 包）。
 */
export function splitTextIntoChunks(text: string, maxChars: number): string[] {
  const source = String(text || '');
  if (maxChars <= 0 || source.length <= maxChars) return source ? [source] : [];
  const chunks: string[] = [];
  let rest = source;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.45)) {
      cut = Math.max(...['。', '！', '？', '；', '.', '!', '?', ';', '\n'].map((char) => rest.lastIndexOf(char, maxChars)));
    }
    if (cut < Math.floor(maxChars * 0.45)) cut = maxChars;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks.filter(Boolean);
}

/**
 * 执行成功但没有任何可投递输出时的确定性兜底摘要。
 * 不依赖模型：按步骤状态生成"任务完成：搜索 ✓ / 生图 ✗"式文本，保证用户至少知道任务结束了。
 */
export function buildDeterministicPlanSummary(
  plan: { steps: Array<{ id: string; capability: string }> },
  results: Record<string, { status?: string }>,
  capabilityName: (id: string) => string,
): ExecutionOutput {
  const parts = (plan.steps || []).map((step) => {
    const status = results?.[step.id]?.status || 'unknown';
    const label = capabilityName(step.capability) || step.capability;
    const ok = status === 'success' || status === 'partial';
    const suffix = status === 'partial' ? '（部分完成）' : status === 'skipped' ? '（跳过）' : ok ? '' : '（未完成）';
    return label + (ok ? ' ✓' : status === 'skipped' ? ' ∅' : ' ✗') + suffix;
  });
  const text = parts.length
    ? '任务已结束：' + parts.join('、') + '。'
    : '任务已结束，但没有产生可发送的内容。';
  return { id: 'plan-summary', kind: 'text', text, priority: 0, mergeable: true, meta: { synthetic: true, reason: 'empty_output_fallback', skipTts: false } };
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

function overflowNotice(outputs: ExecutionOutput[], policy: 'truncate' | 'link' | 'zip' | 'reject' | 'forward'): string {
  const base = truncationNotice(outputs);
  if (policy !== 'link' && policy !== 'zip') return base;
  const links = outputs
    .filter((output) => Boolean(output.url))
    .slice(0, 8)
    .map((output, index) => (index + 1) + '. ' + (KIND_LABEL[output.kind] || output.kind) + ' ' + output.url);
  const prefix = policy === 'zip' ? base + ' ZIP 降级不可用，已回退为链接摘要。' : base;
  return links.length ? prefix + '\n' + links.join('\n') : prefix;
}
function outputMeta(output: ExecutionOutput): Record<string, unknown> {
  return output.meta && typeof output.meta === 'object' && !Array.isArray(output.meta) ? output.meta as Record<string, unknown> : {};
}

export function normalizeReplyFingerprint(value: unknown): string {
  const text = String(value ?? '').normalize('NFKC')
    .replace(/\[CQ:[^\]]+\]/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#|]/g, ' ')
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

export function replyContentHash(value: unknown): string {
  const text = normalizeReplyFingerprint(value);
  if (!text) return '';
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function withContentMeta(output: ExecutionOutput, hash: string): ExecutionOutput {
  if (!hash) return output;
  return { ...output, meta: { ...outputMeta(output), contentHash: hash } };
}

function isComposerOutput(output: ExecutionOutput): boolean {
  const meta = outputMeta(output);
  return meta.role === 'composer' || meta.synthetic === true && meta.composer === true;
}

function isExplicitVoiceOutput(output: ExecutionOutput): boolean {
  const meta = outputMeta(output);
  return meta.preferredVoice === true
    || meta.voiceRequested === true
    || typeof meta.replacesOutputId === 'string' && Boolean(meta.replacesOutputId)
    || meta.sourceCapability === 'tts.speak';
}

function preferredText(existing: ExecutionOutput, incoming: ExecutionOutput): ExecutionOutput {
  if (isComposerOutput(existing) !== isComposerOutput(incoming)) return isComposerOutput(existing) ? incoming : existing;
  const existingPriority = Number(existing.priority || 0);
  const incomingPriority = Number(incoming.priority || 0);
  return incomingPriority > existingPriority ? incoming : existing;
}

export interface ReplyDedupeResult {
  outputs: ExecutionOutput[];
  removed: ExecutionOutput[];
  removedCount: number;
}

/**
 * 在计算 maxMessages 之前做语义去重：
 * 1. 同 kind + URL + 规范化文本只保留一条；
 * 2. text 用 contentHash 去重，composer 摘要优先让位给正常回复；
 * 3. audio.spokenText 与 text 同内容时只保留一条，明确语音优先；
 * 4. 同一文本跨 group 只保留一次。
 */
export function dedupeExecutionOutputs(outputs: ExecutionOutput[]): ReplyDedupeResult {
  const removed: ExecutionOutput[] = [];
  const selected = new Map<string, ExecutionOutput>();
  for (const output of outputs || []) {
    const meta = outputMeta(output);
    const textFingerprint = output.kind === 'text' || output.kind === 'link' || output.kind === 'card'
      ? normalizeReplyFingerprint(output.text)
      : '';
    const hash = textFingerprint ? replyContentHash(textFingerprint) : '';
    const normalized = (output.kind === 'text' || output.kind === 'link' || output.kind === 'card')
      ? (textFingerprint ? 'text:' + textFingerprint : 'id:' + String(output.id || Math.random()))
      : output.url
        ? output.kind + ':url:' + String(output.url)
        : 'id:' + String(output.id || Math.random());
    const candidate = hash ? withContentMeta(output, hash) : output;
    const existing = selected.get(normalized);
    if (!existing) {
      selected.set(normalized, candidate);
      continue;
    }
    if (output.kind === 'text' || output.kind === 'link' || output.kind === 'card') {
      const winner = preferredText(existing, candidate);
      selected.set(normalized, winner);
      removed.push(winner === existing ? candidate : existing);
    } else {
      const existingPriority = Number(existing.priority || 0);
      const candidatePriority = Number(candidate.priority || 0);
      const winner = candidatePriority > existingPriority ? candidate : existing;
      selected.set(normalized, winner);
      removed.push(winner === existing ? candidate : existing);
    }
  }

  let deduped = Array.from(selected.values());
  const textsByFingerprint = new Map<string, ExecutionOutput>();
  for (const output of deduped) {
    if (output.kind !== 'text' && output.kind !== 'link' && output.kind !== 'card') continue;
    const fingerprint = normalizeReplyFingerprint(output.text);
    if (fingerprint && !textsByFingerprint.has(fingerprint)) textsByFingerprint.set(fingerprint, output);
  }

  const audioByFingerprint = new Map<string, ExecutionOutput>();
  const duplicateAudioUrlsToRemove = new Set<string>();
  for (let index = 0; index < deduped.length; index += 1) {
    const output = deduped[index];
    if (output.kind !== 'audio') continue;
    const meta = outputMeta(output);
    const spokenText = String(meta.spokenText || '').trim();
    const fingerprint = normalizeReplyFingerprint(spokenText);
    if (fingerprint) {
      const hash = replyContentHash(fingerprint);
      const candidate = withContentMeta({ ...output, meta: { ...meta, spokenText } }, hash);
      deduped[index] = candidate;
      const existing = audioByFingerprint.get(fingerprint);
      if (!existing) {
        audioByFingerprint.set(fingerprint, candidate);
        continue;
      }
      const winner = isExplicitVoiceOutput(existing) || !isExplicitVoiceOutput(candidate) ? existing : candidate;
      audioByFingerprint.set(fingerprint, winner);
      const loser = winner === existing ? candidate : existing;
      duplicateAudioUrlsToRemove.add(String(loser.url || loser.id || ''));
      removed.push(loser);
    } else {
      audioByFingerprint.set('url:' + String(output.url || output.id || Math.random()), output);
    }
  }

  if (duplicateAudioUrlsToRemove.size) deduped = deduped.filter((output) => output.kind !== 'audio' || !duplicateAudioUrlsToRemove.has(String(output.url || output.id || '')));

  const textFingerprintsToRemove = new Set<string>();
  const audioUrlsToRemove = new Set<string>();
  for (const [fingerprint, audio] of audioByFingerprint.entries()) {
    if (fingerprint.startsWith('url:')) continue;
    const matchingText = textsByFingerprint.get(fingerprint);
    if (!matchingText) continue;
    if (isExplicitVoiceOutput(audio)) textFingerprintsToRemove.add(fingerprint);
    else audioUrlsToRemove.add(String(audio.url || audio.id || ''));
  }
  if (textFingerprintsToRemove.size || audioUrlsToRemove.size) {
    deduped = deduped.filter((output) => {
      if (output.kind === 'audio') {
        const key = String(output.url || output.id || '');
        if (audioUrlsToRemove.has(key)) { removed.push(output); return false; }
        return true;
      }
      if (output.kind !== 'text' && output.kind !== 'link' && output.kind !== 'card') return true;
      const fingerprint = normalizeReplyFingerprint(output.text);
      if (textFingerprintsToRemove.has(fingerprint)) { removed.push(output); return false; }
      return true;
    });
  }

  const finalByFingerprint = new Map<string, ExecutionOutput>();
  const final: ExecutionOutput[] = [];
  for (const output of deduped) {
    if (output.kind === 'text' || output.kind === 'link' || output.kind === 'card') {
      const fingerprint = normalizeReplyFingerprint(output.text);
      if (fingerprint && finalByFingerprint.has(fingerprint)) {
        const previous = finalByFingerprint.get(fingerprint)!;
        const winner = preferredText(previous, output);
        if (winner === previous) { removed.push(output); continue; }
        const index = final.indexOf(previous);
        if (index >= 0) final[index] = winner;
        finalByFingerprint.set(fingerprint, winner);
        removed.push(previous);
        continue;
      }
      if (fingerprint) finalByFingerprint.set(fingerprint, output);
    }
    final.push(output);
  }
  return { outputs: final, removed, removedCount: removed.length };
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
  const overflowPolicy = options.overflowPolicy === 'link' || options.overflowPolicy === 'zip' || options.overflowPolicy === 'reject' || options.overflowPolicy === 'forward'
    ? options.overflowPolicy
    : 'truncate';
  const textMaxChars = Math.max(0, Math.trunc(Number(options.textMaxChars) || 0));
  const textFallback = options.textFallback === 'off' || options.textFallback === 'on_forward_fail' ? options.textFallback : 'always';
  const deduped = dedupeExecutionOutputs(outputs);
  const indexed = deduped.outputs
    .map((output, index) => ({ output, index }))
    .sort((a, b) => {
      const priority = Number(b.output.priority || 0) - Number(a.output.priority || 0);
      return priority !== 0 ? priority : a.index - b.index;
    });

  // overflowPolicy=forward：可合并输出不再按 maxResultItems/nestedMaxNodes 截断，
  // 改为拆成多个转发组按消息预算投递，成功结果不结构性丢弃。
  const keepAll = overflowPolicy === 'forward';
  const keptWithIndex = keepAll ? indexed : indexed.slice(0, maxResultItems);
  const truncated: ExecutionOutput[] = keepAll ? [] : indexed.slice(maxResultItems).map((item) => item.output);

  // 超长文本拆成 ≤textMaxChars 的块：直发、转发节点、后续 TTS 输入共用同一上限。
  const expanded: Array<{ output: ExecutionOutput; index: number }> = [];
  for (const item of keptWithIndex) {
    const output = item.output;
    if (output.kind === 'text' && textMaxChars > 0 && typeof output.text === 'string' && output.text.length > textMaxChars) {
      const chunks = splitTextIntoChunks(output.text, textMaxChars);
      chunks.forEach((chunk, i) => expanded.push({
        output: { ...output, text: chunk, meta: { ...outputMeta(output), textChunk: i + 1, textChunks: chunks.length } },
        index: item.index,
      }));
    } else {
      expanded.push(item);
    }
  }

  // 保底首段直发：转发组内容较多或文本被拆块时，把最高优先级文本的首块剥成 direct 组放在最前，
  // 后续合并转发失败（含 uncertain 停机）也不丢核心内容。单条短文本保持原有行为不变。
  let leadDirect: GroupCandidate | null = null;
  if (textFallback === 'always' && maxMessages >= 2) {
    const firstTextPos = expanded.findIndex((item) => defaultMergeable(item.output) && item.output.kind === 'text');
    if (firstTextPos >= 0) {
      const mergeableCount = expanded.filter((item) => defaultMergeable(item.output)).length;
      const target = expanded[firstTextPos];
      const isSplitChunk = Number(outputMeta(target.output).textChunks) > 1;
      if (mergeableCount > 1 || isSplitChunk) {
        expanded.splice(firstTextPos, 1);
        leadDirect = {
          position: target.index,
          group: { mode: 'direct', outputs: [{ ...target.output, meta: { ...outputMeta(target.output), leadText: true } }], messageCount: 1 },
        };
      }
    }
  }

  let mergeable = expanded.filter((item) => defaultMergeable(item.output));
  if (!keepAll && mergeable.length > nestedMaxNodes) {
    truncated.push(...mergeable.slice(nestedMaxNodes).map((item) => item.output));
    mergeable = mergeable.slice(0, nestedMaxNodes);
  }
  const direct = expanded.filter((item) => !defaultMergeable(item.output));
  const candidates: GroupCandidate[] = [];
  if (leadDirect) candidates.push(leadDirect);
  if (mergeable.length) {
    const groupSize = keepAll ? nestedMaxNodes : mergeable.length;
    for (let start = 0; start < mergeable.length; start += groupSize) {
      const slice = mergeable.slice(start, start + groupSize);
      candidates.push({
        position: Math.min(...slice.map((item) => item.index)),
        group: {
          mode: preferNestedForward && nestedMaxDepth >= 2 ? 'nested_forward' : 'flat_forward',
          outputs: slice.map((item) => item.output),
          messageCount: 1,
        },
      });
    }
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
    dedupedCount: deduped.removedCount,
  };
}
