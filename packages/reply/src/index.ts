import { dedupeFilePayloads, dedupeImageUrls, dedupeVideoUrls, type NapcatFilePayload, type NapcatMixedForwardItem, type NapcatSendResult } from '../../napcat/src/index.js';
import type { PackageDescriptor, ReplyStrategy } from '@miobot-v2/shared';

export const REPLY_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/reply',
  phase: 'P7-reply-strategy',
};

export type ReplyKind = 'text' | 'image' | 'multiImage' | 'video' | 'multiVideo' | 'file' | 'multiFile' | 'mixed';
export type ChatType = 'group' | 'private';
export type ReplyFile = string | NapcatFilePayload;

export interface ReplyStrategyConfig {
  text?: ReplyStrategy;
  image?: ReplyStrategy;
  multiImage?: ReplyStrategy;
  video?: ReplyStrategy;
  multiVideo?: ReplyStrategy;
  file?: ReplyStrategy;
  multiFile?: ReplyStrategy;
  mixed?: ReplyStrategy;
  /** 长文本分段设置；由 AppConfig.bot.textReply 透传。 */
  textReply?: { maxChars?: number; splitDelayMs?: number; showPartPrefix?: boolean };
  fallbackSequentialOnForwardFailure?: boolean;
}

export interface ReplyContext {
  chatType: ChatType;
  groupId?: number | string;
  userId?: number | string;
  senderId?: number | string;
  replyToMessageId?: number | string;
  botName?: string;
}

export interface ReplyClient {
  sendGroupText(groupId: number | string, text: string, replyToMessageId?: number | string): Promise<NapcatSendResult>;
  sendPrivateText(userId: number | string, text: string): Promise<NapcatSendResult>;
  sendGroupTextAt?(groupId: number | string, text: string, userId: number | string): Promise<NapcatSendResult>;
  sendGroupTextForward?(groupId: number | string, nodes: Array<{ title?: string; content: string }>, botName?: string): Promise<NapcatSendResult>;
  sendPrivateTextForward?(userId: number | string, nodes: Array<{ title?: string; content: string }>, botName?: string): Promise<NapcatSendResult>;
  sendGroupNestedTextForward?(groupId: number | string, groups: Array<Array<{ title?: string; content: string }>>, botName?: string): Promise<NapcatSendResult>;
  sendPrivateNestedTextForward?(userId: number | string, groups: Array<Array<{ title?: string; content: string }>>, botName?: string): Promise<NapcatSendResult>;
  sendGroupImage(groupId: number | string, fileUrl: string, summaryText?: string): Promise<NapcatSendResult>;
  sendPrivateImage(userId: number | string, fileUrl: string): Promise<NapcatSendResult>;
  sendGroupRecord?(groupId: number | string, fileUrl: string): Promise<NapcatSendResult>;
  sendPrivateRecord?(userId: number | string, fileUrl: string): Promise<NapcatSendResult>;
  sendGroupVideo?(groupId: number | string, fileUrl: string, summaryText?: string): Promise<NapcatSendResult>;
  sendPrivateVideo?(userId: number | string, fileUrl: string): Promise<NapcatSendResult>;
  sendGroupVideosForward?(groupId: number | string, fileUrls: string[], botName?: string): Promise<NapcatSendResult>;
  sendPrivateVideosForward?(userId: number | string, fileUrls: string[], botName?: string): Promise<NapcatSendResult>;
  sendGroupImageAt?(groupId: number | string, fileUrl: string, userId: number | string): Promise<NapcatSendResult>;
  sendGroupImageQuote?(groupId: number | string, fileUrl: string, messageId: number | string): Promise<NapcatSendResult>;
  sendGroupImageForward?(groupId: number | string, fileUrl: string, botName?: string): Promise<NapcatSendResult>;
  sendGroupImagesForward?(groupId: number | string, fileUrls: string[], botName?: string): Promise<NapcatSendResult>;
  sendGroupFile?(groupId: number | string, fileUrl: string, fileName?: string): Promise<NapcatSendResult>;
  sendPrivateFile?(userId: number | string, fileUrl: string, fileName?: string): Promise<NapcatSendResult>;
  sendGroupFilesForward?(groupId: number | string, files: ReplyFile[], botName?: string): Promise<NapcatSendResult>;
  sendPrivateFilesForward?(userId: number | string, files: ReplyFile[], botName?: string): Promise<NapcatSendResult>;
  sendGroupMixedForward?(groupId: number | string, items: NapcatMixedForwardItem[], botName?: string): Promise<NapcatSendResult>;
  sendPrivateMixedForward?(userId: number | string, items: NapcatMixedForwardItem[], botName?: string): Promise<NapcatSendResult>;
  sendGroupNestedMixedForward?(groupId: number | string, groups: NapcatMixedForwardItem[][], botName?: string): Promise<NapcatSendResult>;
  sendPrivateNestedMixedForward?(userId: number | string, groups: NapcatMixedForwardItem[][], botName?: string): Promise<NapcatSendResult>;
}

export interface ReplyAttempt {
  kind: ReplyKind;
  strategy: ReplyStrategy;
  method: string;
  success: boolean;
  error?: string;
}

export interface ReplyDispatchResult extends Omit<NapcatSendResult, 'attempts'> {
  kind: ReplyKind;
  strategy: ReplyStrategy;
  attempts: ReplyAttempt[];
  sentImages?: string[];
  sentVideos?: string[];
  /** 实际占用消息预算的发送条数；长文本按策略拆分时可能大于 1。 */
  messageCount?: number;
}

export interface ReplyPlanOutputLike {
  kind: string;
  id?: string;
  text?: string;
  url?: string;
  mime?: string;
  mergeable?: boolean;
  meta?: Record<string, unknown>;
}

export interface ReplyPlanGroupLike {
  mode: 'nested_forward' | 'flat_forward' | 'direct';
  outputs: ReplyPlanOutputLike[];
  messageCount: number;
}

export interface ReplyPlanLike {
  groups: ReplyPlanGroupLike[];
  messageCount: number;
  truncated?: ReplyPlanOutputLike[];
  warnings?: string[];
  maxMessages?: number;
  noticeIncluded?: boolean;
  noticeSuppressed?: boolean;
  /** Agent ReplyPolicy 的最终裁决；转发组单条输出需要据此保留显式 forward。 */
  policy?: { mode?: string; reference?: string; forcedForward?: boolean };
}

export interface ReplyPlanDispatchResult extends ReplyDispatchResult {
  sentCount: number;
  truncatedCount: number;
  warnings: string[];
  budgetEnforced: boolean;
}
function normalizePlanFingerprint(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?;；:：'"”‘’()（）\[\]【】]/g, '')
    .trim();
}

function isExplicitVoiceOutput(output: ReplyPlanOutputLike): boolean {
  const meta = output.meta && typeof output.meta === 'object' ? output.meta : {};
  return meta.preferredVoice === true || meta.voiceRequested === true || meta.sourceCapability === 'tts.speak';

}

function dedupeReplyPlanGroups(groups: ReplyPlanGroupLike[]): ReplyPlanGroupLike[] {
  const all = groups.flatMap((group, groupIndex) => (group.outputs || []).map((output, outputIndex) => ({ group, groupIndex, output, outputIndex })));
  const keep = new Set<string>();
  const textSeen = new Set<string>();
  const explicitVoiceFingerprints = new Set<string>();
  for (const item of all) {
    const { output } = item;
    if (output.kind !== 'audio' || !isExplicitVoiceOutput(output)) continue;
    const fp = normalizePlanFingerprint(output.meta?.spokenText);
    if (fp) explicitVoiceFingerprints.add(fp);
  }
  for (const item of all) {
    const { output, groupIndex, outputIndex } = item;
    const key = groupIndex + ':' + outputIndex;
    if (['text', 'link', 'card'].includes(String(output.kind))) {
      const fp = normalizePlanFingerprint(output.text);
      if (fp && explicitVoiceFingerprints.has(fp)) continue;
      if (fp && textSeen.has(fp)) continue;
      if (fp) textSeen.add(fp);
      keep.add(key);
      continue;
    }
    if (output.kind === 'audio') {
      const meta = output.meta && typeof output.meta === 'object' ? output.meta : {};
      const spokenFp = normalizePlanFingerprint(meta.spokenText);
      if (spokenFp) {
        if (meta.skipTts === true && !isExplicitVoiceOutput(output)) continue;
      }
      keep.add(key);
      continue;
    }
    keep.add(key);
  }
  const audioGroups = new Map<string, typeof all>();
  for (const item of all) {
    if (item.output.kind !== 'audio') continue;
    const key = item.groupIndex + ':' + item.outputIndex;
    if (!keep.has(key)) continue;
    const meta = item.output.meta && typeof item.output.meta === 'object' ? item.output.meta : {};
    const fp = normalizePlanFingerprint(meta.spokenText) || String(item.output.url || item.output.id || '');
    if (!fp) continue;
    const list = audioGroups.get(fp) || [];
    list.push(item);
    audioGroups.set(fp, list);
  }
  for (const list of audioGroups.values()) {
    if (list.length < 2) continue;
    const winner = list.find((item) => isExplicitVoiceOutput(item.output)) || list[0];
    for (const item of list) {
      if (item === winner) continue;
      keep.delete(item.groupIndex + ':' + item.outputIndex);
    }
  }
  return groups.flatMap((group, groupIndex) => {
    const outputs = (group.outputs || []).filter((_output, outputIndex) => keep.has(groupIndex + ':' + outputIndex));
    return outputs.length ? [{ ...group, outputs }] : [];
  });
}
export class ReplyStrategyEngine {
  private readonly client: ReplyClient;
  private readonly config: Required<ReplyStrategyConfig>;
  private readonly textReply: { maxChars: number; splitDelayMs: number; showPartPrefix: boolean };

  constructor(client: ReplyClient, config: ReplyStrategyConfig = {}) {
    this.client = client;
    this.config = {
      text: normalizeStrategy(config.text, 'forward'),
      image: normalizeStrategy(config.image, 'forward'),
      multiImage: normalizeStrategy(config.multiImage, 'forward'),
      video: normalizeStrategy(config.video, 'plain'),
      multiVideo: normalizeStrategy(config.multiVideo, 'forward'),
      file: normalizeStrategy(config.file, 'forward'),
      multiFile: normalizeStrategy(config.multiFile, 'forward'),
      mixed: normalizeStrategy(config.mixed, 'forward'),
      fallbackSequentialOnForwardFailure: config.fallbackSequentialOnForwardFailure !== false,
      textReply: config.textReply || {},
    };
    this.textReply = {
      maxChars: Math.max(0, Number(config.textReply?.maxChars ?? 0)),
      splitDelayMs: Math.max(0, Number(config.textReply?.splitDelayMs ?? 0)),
      showPartPrefix: config.textReply?.showPartPrefix !== false,
    };
  }

  async replyText(context: ReplyContext, text: string, strategy = this.config.text, options: { maxMessages?: number } = {}): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.text);
    assertTarget(context);
    const maxMessages = Math.max(0, Math.trunc(Number(options.maxMessages) || 0));
    let chunks = splitLongText(text, this.textReply.maxChars);
    const capChunks = (values: string[]): string[] => {
      if (!maxMessages || values.length <= maxMessages) return values;
      const capped = values.slice(0, maxMessages);
      const lastIndex = capped.length - 1;
      capped[lastIndex] = capped[lastIndex] + '\n\n（内容过长，后续已按消息预算截断）';
      return capped;
    };
    const canForward = context.chatType === 'group'
      ? Boolean(this.client.sendGroupNestedTextForward || this.client.sendGroupTextForward)
      : Boolean(this.client.sendPrivateNestedTextForward || this.client.sendPrivateTextForward);
    if (resolved !== 'forward' || !canForward) chunks = capChunks(chunks);
    if (chunks.length <= 1) {
      const single = context.chatType === 'private'
        ? await this.replyPrivateText(context, chunks[0] || text, resolved)
        : await this.replyGroupText(context, chunks[0] || text, resolved);
      return { ...single, messageCount: 1 };
    }
    let partNodes = chunks.map((chunk, index) => {
      const prefix = this.textReply.showPartPrefix ? `(${index + 1}/${chunks.length}) ` : '';
      return {
        title: `${context.botName || 'Miobot'} ${index + 1}/${chunks.length}`,
        content: `${prefix}${chunk}`,
      };
    });
    if (resolved === 'forward') {
      const groups = partNodes.map((node) => [node]);
      if (context.chatType === 'group') {
        const groupId = required(context.groupId, 'groupId');
        if (this.client.sendGroupNestedTextForward) {
          try {
            const nested = await this.wrap(
              'text', resolved, 'sendGroupNestedTextForward',
              () => this.client.sendGroupNestedTextForward!(groupId, groups, context.botName),
            );
            if (nested.success || nested.uncertain) return { ...nested, messageCount: 1 };
          } catch { /* Napcat 不支持嵌套节点时回退到单个外层合并转发 */ }
        }
        if (this.client.sendGroupTextForward) {
          const flat = await this.wrap(
            'text', resolved, 'sendGroupTextForward(split)',
            () => this.client.sendGroupTextForward!(groupId, partNodes, context.botName),
          );
          return { ...flat, messageCount: 1 };
        }
      } else {
        const userId = required(context.userId, 'userId');
        if (this.client.sendPrivateNestedTextForward) {
          try {
            const nested = await this.wrap(
              'text', resolved, 'sendPrivateNestedTextForward',
              () => this.client.sendPrivateNestedTextForward!(userId, groups, context.botName),
            );
            if (nested.success || nested.uncertain) return { ...nested, messageCount: 1 };
          } catch { /* Napcat 不支持嵌套节点时回退到单个外层合并转发 */ }
        }
        if (this.client.sendPrivateTextForward) {
          const flat = await this.wrap(
            'text', resolved, 'sendPrivateTextForward(split)',
            () => this.client.sendPrivateTextForward!(userId, partNodes, context.botName),
          );
          return { ...flat, messageCount: 1 };
        }
      }
    }
    if (resolved === 'forward') {
      const capped = capChunks(chunks);
      if (capped.length !== chunks.length) {
        chunks = capped;
        partNodes = chunks.map((chunk, index) => {
          const prefix = this.textReply.showPartPrefix ? '(' + (index + 1) + '/' + chunks.length + ') ' : '';
          return {
            title: (context.botName || 'Miobot') + ' ' + (index + 1) + '/' + chunks.length,
            content: prefix + chunk,
          };
        });
      }
    }
    let last: ReplyDispatchResult | undefined;
    for (let i = 0; i < chunks.length; i += 1) {
      const part = partNodes[i].content;
      const partContext: ReplyContext = i === 0 ? context : { ...context, replyToMessageId: undefined };
      last = context.chatType === 'private'
        ? await this.replyPrivateText(partContext, part, resolved)
        : await this.replyGroupText(partContext, part, resolved);
      if (!last.success) return { ...last, messageCount: i + 1 };
      if (i < chunks.length - 1 && this.textReply.splitDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.textReply.splitDelayMs));
      }
    }
    return { ...last!, messageCount: chunks.length };
  }

  async replyImage(context: ReplyContext, fileUrl: string, strategy = this.config.image): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.image);
    assertTarget(context);
    if (context.chatType === 'private') return this.replyPrivateImage(context, fileUrl, resolved);
    return this.replyGroupImage(context, fileUrl, resolved);
  }

  async replyImages(context: ReplyContext, fileUrls: string[], strategy = this.config.multiImage): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.multiImage);
    assertTarget(context);
    const cleanUrls = dedupeImageUrls(fileUrls);
    if (!cleanUrls.length) return this.finish('multiImage', resolved, [{ kind: 'multiImage', strategy: resolved, method: 'validate-images', success: false, error: 'no images to send' }], { success: false, error: 'no images to send', sentImages: [] });
    if (cleanUrls.length === 1) {
      const single = await this.replyImage(context, cleanUrls[0], this.config.image);
      return { ...single, kind: 'multiImage', strategy: resolved, sentImages: cleanUrls };
    }
    if (context.chatType === 'private') return this.sendPrivateImagesSequential(context, cleanUrls, resolved);
    return this.replyGroupImages(context, cleanUrls, resolved);
  }

  /**
   * 单视频直发（type:video）。
   * QQ 限制：短视频时长/大小/编码；失败时调用方也可改走 replyFiles。
   */
  async replyVideo(context: ReplyContext, fileUrl: string, strategy = this.config.video): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.video);
    assertTarget(context);
    const file = String(fileUrl || '').trim();
    if (!file) return this.finish('video', resolved, [{ kind: 'video', strategy: resolved, method: 'validate-video', success: false, error: 'no video to send' }], { success: false, error: 'no video to send', sentVideos: [] });
    if (context.chatType === 'private') {
      const userId = required(context.userId, 'userId');
      if (!this.client.sendPrivateVideo) return this.finish('video', resolved, [{ kind: 'video', strategy: resolved, method: 'sendPrivateVideo', success: false, error: 'private video send not supported' }], { success: false, error: 'private video send not supported' });
      return this.wrap('video', resolved, 'sendPrivateVideo', () => this.client.sendPrivateVideo!(userId, file), undefined, [file]);
    }
    const groupId = required(context.groupId, 'groupId');
    if (!this.client.sendGroupVideo) return this.finish('video', resolved, [{ kind: 'video', strategy: resolved, method: 'sendGroupVideo', success: false, error: 'group video send not supported' }], { success: false, error: 'group video send not supported' });
    return this.wrap('video', resolved, 'sendGroupVideo', () => this.client.sendGroupVideo!(groupId, file), undefined, [file]);
  }

  /** 多视频：单条直发；多条优先合并转发，失败则顺序直发。 */
  async replyVideos(context: ReplyContext, fileUrls: string[], strategy = this.config.multiVideo): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.multiVideo);
    assertTarget(context);
    const cleanUrls = dedupeVideoUrls(fileUrls);
    if (!cleanUrls.length) return this.finish('multiVideo', resolved, [{ kind: 'multiVideo', strategy: resolved, method: 'validate-videos', success: false, error: 'no videos to send' }], { success: false, error: 'no videos to send', sentVideos: [] });
    if (cleanUrls.length === 1) {
      const single = await this.replyVideo(context, cleanUrls[0], this.config.video);
      return { ...single, kind: 'multiVideo', strategy: resolved, sentVideos: cleanUrls };
    }
    if (context.chatType === 'private') return this.replyPrivateVideos(context, cleanUrls, resolved);
    return this.replyGroupVideos(context, cleanUrls, resolved);
  }

  async replyFiles(context: ReplyContext, files: ReplyFile[], strategy = this.config.multiFile): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.multiFile);
    assertTarget(context);
    const cleanFiles = dedupeFilePayloads(files);
    if (!cleanFiles.length) return this.finish('multiFile', resolved, [{ kind: 'multiFile', strategy: resolved, method: 'validate-files', success: false, error: 'no files to send' }], { success: false, error: 'no files to send' });
    if (cleanFiles.length === 1) return this.replySingleFile(context, cleanFiles[0], this.config.file);
    if (context.chatType === 'private') return this.replyPrivateFiles(context, cleanFiles, resolved);
    return this.replyGroupFiles(context, cleanFiles, resolved);
  }

  async replyMixed(context: ReplyContext, payload: { text?: string; images?: string[]; videos?: string[]; files?: ReplyFile[] }, strategy = this.config.mixed, options: { preferNestedForward?: boolean } = {}): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.mixed);
    assertTarget(context);
    const text = String(payload?.text || '').trim();
    const images = dedupeImageUrls(payload?.images || []);
    const videos = dedupeVideoUrls(payload?.videos || []);
    const files = dedupeFilePayloads(payload?.files || []);
    const mediaKinds = [images.length > 0, videos.length > 0, files.length > 0].filter(Boolean).length;

    // 图/视/文件混排 → 合并转发；单介质走专用路径。
    if (mediaKinds >= 2 || (text && (images.length || videos.length || files.length))) {
      const items: NapcatMixedForwardItem[] = [
        ...(text ? [{ kind: 'text' as const, text, title: context.botName || 'Miobot' }] : []),
        ...images.map((file, index) => ({ kind: 'image' as const, file, title: `${context.botName || 'Miobot'} 图 ${index + 1}/${images.length}` })),
        ...videos.map((file, index) => ({ kind: 'video' as const, file, title: `${context.botName || 'Miobot'} 视频 ${index + 1}/${videos.length}` })),
        ...files.map((file, index) => ({ kind: 'file' as const, ...file, title: `${context.botName || 'Miobot'} 文件 ${index + 1}/${files.length}` })),
      ];
      const groups = [
        items.filter((item) => item.kind === 'text'),
        items.filter((item) => item.kind === 'image'),
        items.filter((item) => item.kind === 'video'),
        items.filter((item) => item.kind === 'file'),
      ].filter((group) => group.length > 0);
      if (resolved === 'forward' && options.preferNestedForward !== false) {
        const nested = await this.sendNestedMixedForward(context, groups, resolved);
        if (nested.success || nested.uncertain) return { ...nested, messageCount: 1 };
      }
      return this.sendMixedForward(context, items, resolved);
    }

    if (files.length) return this.replyFiles(context, files, resolved);
    if (videos.length) return this.replyVideos(context, videos, resolved);
    if (images.length) return this.replyImages(context, images, resolved);
    return this.replyText(context, text, resolved);
  }

  /**
   * ReplyPlan 的唯一发送入口。它按 plan.groups 决定发送顺序和消息数，
   * 并在最终发送层再次执行 maxMessages；任何 uncertain 发送都会立即停止后续消息，避免双发。
   */
  async replyPlan(context: ReplyContext, plan: ReplyPlanLike, options: { maxMessages?: number } = {}): Promise<ReplyPlanDispatchResult> {
    assertTarget(context);
    const limits = [options.maxMessages, plan.maxMessages]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 1);
    const maxMessages = limits.length ? Math.max(1, Math.trunc(Math.min(...limits))) : 3;
    const attempts: ReplyAttempt[] = [];
    const messageIds: Array<number | string> = [];
    const warnings = Array.isArray(plan.warnings) ? plan.warnings.map(String).filter(Boolean) : [];
    let sentCount = 0;
    let truncatedCount = Array.isArray(plan.truncated) ? plan.truncated.length : 0;
    let failure = '';
    let uncertain = false;
    let budgetEnforced = false;

    const usedMessages = (result: ReplyDispatchResult): number => {
      const explicit = Number(result.messageCount);
      if (Number.isFinite(explicit) && explicit >= 1) return Math.trunc(explicit);
      const attemptCount = Array.isArray(result.attempts) ? result.attempts.length : 0;
      return Math.max(1, attemptCount);
    };
    const remember = (result: ReplyDispatchResult): boolean => {
      attempts.push(...(result.attempts || []));
      if (result.messageId !== undefined) messageIds.push(result.messageId);
      if (Array.isArray(result.messageIds)) messageIds.push(...result.messageIds);
      if (result.uncertain) {
        uncertain = true;
        return false;
      }
      if (!result.success) {
        failure ||= result.error || 'reply_plan_send_failed';
        return false;
      }
      return true;
    };

    const forceForward = plan.policy?.mode === 'forward' || plan.policy?.forcedForward === true;
    const textStrategy = plan.policy?.mode === 'quote' || plan.policy?.reference === 'quote'
      ? 'quote'
      : plan.policy?.reference === 'none' || plan.policy?.mode === 'direct' || plan.policy?.mode === 'plain'
        ? 'plain'
        : undefined;
    const dedupedGroups = dedupeReplyPlanGroups(plan.groups || []);
    for (const group of dedupedGroups) {
      if (sentCount >= maxMessages) {
        budgetEnforced = true;
        truncatedCount += group.outputs?.length || 0;
        break;
      }
      if (group.mode !== 'direct') {
        const result = await this.replyPlanGroup(context, group, maxMessages - sentCount, forceForward, textStrategy);
        remember(result);
        sentCount += usedMessages(result);
        if (failure || uncertain) break;
        continue;
      }
      for (const output of group.outputs || []) {
        if (sentCount >= maxMessages) {
          budgetEnforced = true;
          truncatedCount += 1;
          continue;
        }
        const result = await this.replyPlanDirectOutput(context, output, maxMessages - sentCount, textStrategy);
        remember(result);
        sentCount += usedMessages(result);
        if (failure || uncertain) break;
      }
      if (failure || uncertain) break;
    }

    if (!failure && !uncertain && !plan.noticeIncluded && !plan.noticeSuppressed && warnings.length && sentCount < maxMessages) {
      const notice = await this.replyText(context, warnings.join('\n'), this.config.text, { maxMessages: maxMessages - sentCount });
      if (remember(notice)) sentCount += usedMessages(notice);
    }

    const success = !failure && !uncertain;
    return {
      success,
      uncertain: uncertain || undefined,
      messageId: messageIds[0],
      messageIds: uniqueIds(messageIds),
      error: failure || undefined,
      kind: 'mixed',
      strategy: 'forward',
      attempts,
      sentCount,
      truncatedCount,
      warnings,
      budgetEnforced,
    };
  }
  private replyPlanText(outputs: ReplyPlanOutputLike[]): string {
    return outputs
      .map((output) => {
        if (output.text && output.text.trim()) return output.text.trim();
        const title = typeof output.meta?.title === 'string' ? output.meta.title : '';
        return [title, output.url || ''].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join('\n\n');
  }

  private async replyPlanForwardGroup(context: ReplyContext, group: ReplyPlanGroupLike): Promise<ReplyDispatchResult> {
    const audioOutputs = (group.outputs || []).filter((output) => output.kind === 'audio');
    const nonAudioOutputs = (group.outputs || []).filter((output) => output.kind !== 'audio');
    const items: NapcatMixedForwardItem[] = [];
    for (const output of nonAudioOutputs) {
      const title = typeof output.meta?.title === 'string' ? output.meta.title : undefined;
      if ((output.kind === 'text' || output.kind === 'link' || output.kind === 'card')) {
        const text = this.replyPlanText([output]);
        if (text) items.push({ kind: 'text', text, title });
      } else if (output.kind === 'image' && output.url) {
        items.push({ kind: 'image', file: String(output.url), title });
      } else if (output.kind === 'video' && output.url) {
        items.push({ kind: 'video', file: String(output.url), title });
      } else if (output.kind === 'file' && output.url) {
        const name = typeof output.meta?.name === 'string' ? output.meta.name : undefined;
        items.push({ kind: 'file', file: String(output.url), name, title });
      }
    }
    let forwardResult: ReplyDispatchResult | null = null;
    if (items.length) {
      if (group.mode === 'nested_forward') {
        const groups = [
          items.filter((item) => item.kind === 'text'),
          items.filter((item) => item.kind === 'image'),
          items.filter((item) => item.kind === 'video'),
          items.filter((item) => item.kind === 'file'),
        ].filter((item) => item.length > 0);
        const nested = await this.sendNestedMixedForward(context, groups, 'forward');
        if (nested.success || nested.uncertain) forwardResult = nested;
      }
      forwardResult = forwardResult || await this.sendMixedForward(context, items, 'forward');
      if (!forwardResult.success || forwardResult.uncertain) return forwardResult;
    }
    if (!audioOutputs.length) return forwardResult || this.replyText(context, '');

    const audioResults: ReplyDispatchResult[] = [];
    for (const output of audioOutputs) {
      const url = String(output.url || '').trim();
      if (!url) {
        audioResults.push(this.finish('mixed', 'plain', [{ kind: 'mixed', strategy: 'plain', method: 'validate-record', success: false, error: 'empty_audio_url' }], { success: false, error: 'empty_audio_url' }));
        break;
      }
      const sent = await this.replyPlanRecord(context, url);
      audioResults.push(sent);
      if (sent.uncertain || !sent.success) break;
    }
    if (!forwardResult && audioResults.length === 1) return audioResults[0];
    const all = [...(forwardResult ? [forwardResult] : []), ...audioResults];
    const messageIds = uniqueIds(all.flatMap((result) => result.messageIds?.length ? result.messageIds : (result.messageId !== undefined ? [result.messageId] : [])));
    return this.finish('mixed', 'plain', all.flatMap((result) => result.attempts || []), {
      success: all.every((result) => result.success),
      uncertain: all.some((result) => result.uncertain) || undefined,
      messageId: messageIds[0],
      messageIds,
      error: all.find((result) => result.error)?.error,
    });
  }
  private async replyPlanGroup(context: ReplyContext, group: ReplyPlanGroupLike, maxMessages?: number, forceForward = false, textStrategy?: ReplyStrategy): Promise<ReplyDispatchResult> {
    const outputs = group.outputs || [];
    if (!outputs.length) return this.replyText(context, '');
    // buildReplyPlan 默认会把短文本放进 nested_forward 组；只有显式 forward
    // 或 forcedForward 才应该把单条输出也走转发，否则普通闲聊仍应直接发送。
    const forceOutputForward = outputs.some((output) => output.meta?.forceForward === true);
    if (outputs.length === 1 && !forceForward && !forceOutputForward) return this.replyPlanDirectOutput(context, outputs[0], maxMessages, textStrategy);
    if (outputs.length === 1 && forceOutputForward) {
      const output = outputs[0];
      if (output.kind === 'text' || output.kind === 'link' || output.kind === 'card') {
        return this.replyText(context, this.replyPlanText([output]), 'forward', { maxMessages });
      }
    }
    if (group.mode === 'direct') {
      if (outputs.length === 1) return this.replyPlanDirectOutput(context, outputs[0], maxMessages, textStrategy);
      const results: ReplyDispatchResult[] = [];
      for (const output of outputs) results.push(await this.replyPlanDirectOutput(context, output, maxMessages, textStrategy));
      const messageIds = uniqueIds(results.flatMap((result) => result.messageIds?.length ? result.messageIds : (result.messageId !== undefined ? [result.messageId] : [])));
      return this.finish('mixed', 'plain', results.flatMap((result) => result.attempts || []), {
        success: results.every((result) => result.success),
        uncertain: results.some((result) => result.uncertain) || undefined,
        messageId: messageIds[0],
        messageIds,
        error: results.find((result) => result.error)?.error,
      });
    }
    return this.replyPlanForwardGroup(context, group);
  }

  private async replyPlanDirectOutput(context: ReplyContext, output: ReplyPlanOutputLike, maxMessages?: number, textStrategy?: ReplyStrategy): Promise<ReplyDispatchResult> {
    const url = String(output.url || '').trim();
    if (output.kind === 'text' || output.kind === 'link' || output.kind === 'card') {
      return this.replyText(context, this.replyPlanText([output]), textStrategy || this.config.text, { maxMessages });
    }
    if (output.kind === 'image') {
      if (!url) return this.finish('image', this.config.image, [{ kind: 'image', strategy: this.config.image, method: 'validate-image', success: false, error: 'empty_image_url' }], { success: false, error: 'empty_image_url' });
      return this.replyImage(context, url);
    }
    if (output.kind === 'video') {
      if (!url) return this.finish('video', this.config.video, [{ kind: 'video', strategy: this.config.video, method: 'validate-video', success: false, error: 'empty_video_url' }], { success: false, error: 'empty_video_url' });
      return this.replyVideo(context, url);
    }
    if (output.kind === 'file') {
      if (!url) return this.finish('file', this.config.file, [{ kind: 'file', strategy: this.config.file, method: 'validate-file', success: false, error: 'empty_file_url' }], { success: false, error: 'empty_file_url' });
      const name = typeof output.meta?.name === 'string' ? output.meta.name : undefined;
      return this.replyFiles(context, [{ file: url, name }]);
    }
    if (output.kind === 'audio') {
      if (!url) return this.finish('mixed', 'plain', [{ kind: 'mixed', strategy: 'plain', method: 'validate-record', success: false, error: 'empty_audio_url' }], { success: false, error: 'empty_audio_url' });
      return this.replyPlanRecord(context, url);
    }
    return this.finish('mixed', 'plain', [{ kind: 'mixed', strategy: 'plain', method: 'unsupported-output', success: false, error: 'unsupported_output_kind:' + output.kind }], { success: false, error: 'unsupported_output_kind:' + output.kind });
  }

  private async replyPlanRecord(context: ReplyContext, fileUrl: string): Promise<ReplyDispatchResult> {
    if (context.chatType === 'group') {
      const groupId = required(context.groupId, 'groupId');
      if (!this.client.sendGroupRecord) return this.finish('mixed', 'plain', [{ kind: 'mixed', strategy: 'plain', method: 'sendGroupRecord', success: false, error: 'group record send not supported' }], { success: false, error: 'group record send not supported' });
      return this.wrap('mixed', 'plain', 'sendGroupRecord', () => this.client.sendGroupRecord!(groupId, fileUrl));
    }
    const userId = required(context.userId, 'userId');
    if (!this.client.sendPrivateRecord) return this.finish('mixed', 'plain', [{ kind: 'mixed', strategy: 'plain', method: 'sendPrivateRecord', success: false, error: 'private record send not supported' }], { success: false, error: 'private record send not supported' });
    return this.wrap('mixed', 'plain', 'sendPrivateRecord', () => this.client.sendPrivateRecord!(userId, fileUrl));
  }
  private async replyGroupText(context: ReplyContext, text: string, strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    if (strategy === 'forward' && this.client.sendGroupTextForward) {
      return this.wrap('text', strategy, 'sendGroupTextForward', () => this.client.sendGroupTextForward!(groupId, [{ title: context.botName, content: text }], context.botName));
    }
    if (strategy === 'at' && context.senderId !== undefined && this.client.sendGroupTextAt) {
      return this.wrap('text', strategy, 'sendGroupTextAt', () => this.client.sendGroupTextAt!(groupId, text, context.senderId!));
    }
    if (strategy === 'quote' && context.replyToMessageId !== undefined) {
      return this.wrap('text', strategy, 'sendGroupText(quote)', () => this.client.sendGroupText(groupId, text, context.replyToMessageId));
    }
    return this.wrap('text', strategy, 'sendGroupText', () => this.client.sendGroupText(groupId, text));
  }

  private async replyPrivateText(context: ReplyContext, text: string, strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const userId = required(context.userId, 'userId');
    if (strategy === 'forward' && this.client.sendPrivateTextForward) {
      return this.wrap('text', strategy, 'sendPrivateTextForward', () => this.client.sendPrivateTextForward!(userId, [{ title: context.botName, content: text }], context.botName));
    }
    return this.wrap('text', strategy, 'sendPrivateText', () => this.client.sendPrivateText(userId, text));
  }

  private async replyGroupImage(context: ReplyContext, fileUrl: string, strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    if (strategy === 'forward' && this.client.sendGroupImageForward) {
      return this.wrap('image', strategy, 'sendGroupImageForward', () => this.client.sendGroupImageForward!(groupId, fileUrl, context.botName), [fileUrl]);
    }
    if (strategy === 'at' && context.senderId !== undefined && this.client.sendGroupImageAt) {
      return this.wrap('image', strategy, 'sendGroupImageAt', () => this.client.sendGroupImageAt!(groupId, fileUrl, context.senderId!), [fileUrl]);
    }
    if (strategy === 'quote' && context.replyToMessageId !== undefined && this.client.sendGroupImageQuote) {
      return this.wrap('image', strategy, 'sendGroupImageQuote', () => this.client.sendGroupImageQuote!(groupId, fileUrl, context.replyToMessageId!), [fileUrl]);
    }
    return this.wrap('image', strategy, 'sendGroupImage', () => this.client.sendGroupImage(groupId, fileUrl), [fileUrl]);
  }

  private async replyPrivateImage(context: ReplyContext, fileUrl: string, strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const userId = required(context.userId, 'userId');
    return this.wrap('image', strategy, 'sendPrivateImage', () => this.client.sendPrivateImage(userId, fileUrl), [fileUrl]);
  }

  private async replyGroupImages(context: ReplyContext, fileUrls: string[], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    if (strategy === 'forward' && this.client.sendGroupImagesForward) {
      const forward = await this.wrap('multiImage', strategy, 'sendGroupImagesForward', () => this.client.sendGroupImagesForward!(groupId, fileUrls, context.botName), fileUrls);
      if (forward.success || !this.config.fallbackSequentialOnForwardFailure) return forward;
      const fallback = await this.sendGroupImagesSequential(context, fileUrls, 'plain', forward.attempts);
      return { ...fallback, strategy };
    }
    return this.sendGroupImagesSequential(context, fileUrls, strategy, []);
  }

  private async sendGroupImagesSequential(context: ReplyContext, fileUrls: string[], strategy: ReplyStrategy, previousAttempts: ReplyAttempt[]): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    const attempts: ReplyAttempt[] = [];
    const messageIds: Array<number | string> = [];
    let firstError = '';
    for (let idx = 0; idx < fileUrls.length; idx += 1) {
      const fileUrl = fileUrls[idx];
      const useAt = idx === 0 && strategy === 'at' && context.senderId !== undefined && this.client.sendGroupImageAt;
      const useQuote = idx === 0 && strategy === 'quote' && context.replyToMessageId !== undefined && this.client.sendGroupImageQuote;
      const method = useAt ? 'sendGroupImageAt' : useQuote ? 'sendGroupImageQuote' : 'sendGroupImage';
      const result = useAt
        ? await this.client.sendGroupImageAt!(groupId, fileUrl, context.senderId!)
        : useQuote
          ? await this.client.sendGroupImageQuote!(groupId, fileUrl, context.replyToMessageId!)
          : await this.client.sendGroupImage(groupId, fileUrl);
      attempts.push({ kind: 'multiImage', strategy, method, success: result.success, error: result.error });
      if (!result.success) firstError ||= result.error || `${method} failed`;
      messageIds.push(...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : []));
    }
    const success = attempts.every((attempt) => attempt.success);
    return this.finish('multiImage', strategy, [...previousAttempts, ...attempts], { success, messageIds: uniqueIds(messageIds), error: success ? undefined : firstError, sentImages: fileUrls });
  }

  private async sendPrivateImagesSequential(context: ReplyContext, fileUrls: string[], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const userId = required(context.userId, 'userId');
    const attempts: ReplyAttempt[] = [];
    const messageIds: Array<number | string> = [];
    let firstError = '';
    for (const fileUrl of fileUrls) {
      const result = await this.client.sendPrivateImage(userId, fileUrl);
      attempts.push({ kind: 'multiImage', strategy, method: 'sendPrivateImage', success: result.success, error: result.error });
      if (!result.success) firstError ||= result.error || 'sendPrivateImage failed';
      messageIds.push(...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : []));
    }
    const success = attempts.every((attempt) => attempt.success);
    return this.finish('multiImage', strategy, attempts, { success, messageIds: uniqueIds(messageIds), error: success ? undefined : firstError, sentImages: fileUrls });
  }

  private async replyGroupVideos(context: ReplyContext, fileUrls: string[], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    if (strategy === 'forward' && this.client.sendGroupVideosForward) {
      const forward = await this.wrap('multiVideo', strategy, 'sendGroupVideosForward', () => this.client.sendGroupVideosForward!(groupId, fileUrls, context.botName), undefined, fileUrls);
      if (forward.success || !this.config.fallbackSequentialOnForwardFailure) return forward;
      const fallback = await this.sendGroupVideosSequential(context, fileUrls, 'plain', forward.attempts);
      return { ...fallback, strategy };
    }
    return this.sendGroupVideosSequential(context, fileUrls, strategy, []);
  }

  private async replyPrivateVideos(context: ReplyContext, fileUrls: string[], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const userId = required(context.userId, 'userId');
    if (strategy === 'forward' && this.client.sendPrivateVideosForward) {
      const forward = await this.wrap('multiVideo', strategy, 'sendPrivateVideosForward', () => this.client.sendPrivateVideosForward!(userId, fileUrls, context.botName), undefined, fileUrls);
      if (forward.success || !this.config.fallbackSequentialOnForwardFailure) return forward;
      const fallback = await this.sendPrivateVideosSequential(context, fileUrls, 'plain', forward.attempts);
      return { ...fallback, strategy };
    }
    return this.sendPrivateVideosSequential(context, fileUrls, strategy, []);
  }

  private async sendGroupVideosSequential(context: ReplyContext, fileUrls: string[], strategy: ReplyStrategy, previousAttempts: ReplyAttempt[]): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    if (!this.client.sendGroupVideo) {
      return this.finish('multiVideo', strategy, [...previousAttempts, { kind: 'multiVideo', strategy, method: 'sendGroupVideo', success: false, error: 'group video send not supported' }], { success: false, error: 'group video send not supported', sentVideos: fileUrls });
    }
    const attempts: ReplyAttempt[] = [];
    const messageIds: Array<number | string> = [];
    let firstError = '';
    for (const fileUrl of fileUrls) {
      const result = await this.client.sendGroupVideo!(groupId, fileUrl);
      attempts.push({ kind: 'multiVideo', strategy, method: 'sendGroupVideo', success: result.success, error: result.error });
      if (!result.success) firstError ||= result.error || 'sendGroupVideo failed';
      messageIds.push(...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : []));
    }
    const success = attempts.every((attempt) => attempt.success);
    return this.finish('multiVideo', strategy, [...previousAttempts, ...attempts], { success, messageIds: uniqueIds(messageIds), error: success ? undefined : firstError, sentVideos: fileUrls });
  }

  private async sendPrivateVideosSequential(context: ReplyContext, fileUrls: string[], strategy: ReplyStrategy, previousAttempts: ReplyAttempt[] = []): Promise<ReplyDispatchResult> {
    const userId = required(context.userId, 'userId');
    if (!this.client.sendPrivateVideo) {
      return this.finish('multiVideo', strategy, [...previousAttempts, { kind: 'multiVideo', strategy, method: 'sendPrivateVideo', success: false, error: 'private video send not supported' }], { success: false, error: 'private video send not supported', sentVideos: fileUrls });
    }
    const attempts: ReplyAttempt[] = [];
    const messageIds: Array<number | string> = [];
    let firstError = '';
    for (const fileUrl of fileUrls) {
      const result = await this.client.sendPrivateVideo!(userId, fileUrl);
      attempts.push({ kind: 'multiVideo', strategy, method: 'sendPrivateVideo', success: result.success, error: result.error });
      if (!result.success) firstError ||= result.error || 'sendPrivateVideo failed';
      messageIds.push(...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : []));
    }
    const success = attempts.every((attempt) => attempt.success);
    return this.finish('multiVideo', strategy, [...previousAttempts, ...attempts], { success, messageIds: uniqueIds(messageIds), error: success ? undefined : firstError, sentVideos: fileUrls });
  }

  private async replySingleFile(context: ReplyContext, file: NapcatFilePayload, strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    if (context.chatType === 'private') {
      const userId = required(context.userId, 'userId');
      return this.wrap('file', strategy, 'sendPrivateFile', () => this.callPrivateFile(userId, file));
    }
    const groupId = required(context.groupId, 'groupId');
    return this.wrap('file', strategy, 'sendGroupFile', () => this.callGroupFile(groupId, file));
  }

  private async replyGroupFiles(context: ReplyContext, files: NapcatFilePayload[], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    if (this.client.sendGroupFilesForward) {
      const forward = await this.wrap('multiFile', strategy, 'sendGroupFilesForward', () => this.client.sendGroupFilesForward!(groupId, files, context.botName));
      if (forward.success || !this.config.fallbackSequentialOnForwardFailure) return forward;
      const fallback = await this.sendGroupFilesSequential(context, files, strategy, forward.attempts);
      return { ...fallback, strategy };
    }
    return this.sendGroupFilesSequential(context, files, strategy, []);
  }

  private async replyPrivateFiles(context: ReplyContext, files: NapcatFilePayload[], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    const userId = required(context.userId, 'userId');
    if (this.client.sendPrivateFilesForward) {
      const forward = await this.wrap('multiFile', strategy, 'sendPrivateFilesForward', () => this.client.sendPrivateFilesForward!(userId, files, context.botName));
      if (forward.success || !this.config.fallbackSequentialOnForwardFailure) return forward;
      const fallback = await this.sendPrivateFilesSequential(context, files, strategy, forward.attempts);
      return { ...fallback, strategy };
    }
    return this.sendPrivateFilesSequential(context, files, strategy, []);
  }

  private async sendGroupFilesSequential(context: ReplyContext, files: NapcatFilePayload[], strategy: ReplyStrategy, previousAttempts: ReplyAttempt[]): Promise<ReplyDispatchResult> {
    const groupId = required(context.groupId, 'groupId');
    const attempts: ReplyAttempt[] = [];
    const messageIds: Array<number | string> = [];
    let firstError = '';
    for (const file of files) {
      const result = await this.callGroupFile(groupId, file);
      attempts.push({ kind: 'multiFile', strategy, method: 'sendGroupFile', success: result.success, error: result.error });
      if (!result.success) firstError ||= result.error || 'sendGroupFile failed';
      messageIds.push(...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : []));
    }
    const success = attempts.every((attempt) => attempt.success);
    return this.finish('multiFile', strategy, [...previousAttempts, ...attempts], { success, messageIds: uniqueIds(messageIds), error: success ? undefined : firstError });
  }

  private async sendPrivateFilesSequential(context: ReplyContext, files: NapcatFilePayload[], strategy: ReplyStrategy, previousAttempts: ReplyAttempt[] = []): Promise<ReplyDispatchResult> {
    const userId = required(context.userId, 'userId');
    const attempts: ReplyAttempt[] = [];
    const messageIds: Array<number | string> = [];
    let firstError = '';
    for (const file of files) {
      const result = await this.callPrivateFile(userId, file);
      attempts.push({ kind: 'multiFile', strategy, method: 'sendPrivateFile', success: result.success, error: result.error });
      if (!result.success) firstError ||= result.error || 'sendPrivateFile failed';
      messageIds.push(...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : []));
    }
    const success = attempts.every((attempt) => attempt.success);
    return this.finish('multiFile', strategy, [...previousAttempts, ...attempts], { success, messageIds: uniqueIds(messageIds), error: success ? undefined : firstError });
  }

  private async sendNestedMixedForward(context: ReplyContext, groups: NapcatMixedForwardItem[][], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    if (context.chatType === 'private') {
      const userId = required(context.userId, 'userId');
      if (!this.client.sendPrivateNestedMixedForward) return this.finish('mixed', strategy, [], { success: false, error: 'nested mixed forward not supported' });
      return this.wrap('mixed', strategy, 'sendPrivateNestedMixedForward', () => this.client.sendPrivateNestedMixedForward!(userId, groups, context.botName));
    }
    const groupId = required(context.groupId, 'groupId');
    if (!this.client.sendGroupNestedMixedForward) return this.finish('mixed', strategy, [], { success: false, error: 'nested mixed forward not supported' });
    return this.wrap('mixed', strategy, 'sendGroupNestedMixedForward', () => this.client.sendGroupNestedMixedForward!(groupId, groups, context.botName));
  }

  private async sendMixedForward(context: ReplyContext, items: NapcatMixedForwardItem[], strategy: ReplyStrategy): Promise<ReplyDispatchResult> {
    if (context.chatType === 'private') {
      const userId = required(context.userId, 'userId');
      if (!this.client.sendPrivateMixedForward) return this.finish('mixed', strategy, [{ kind: 'mixed', strategy, method: 'sendPrivateMixedForward', success: false, error: 'mixed forward not supported' }], { success: false, error: 'mixed forward not supported' });
      return this.wrap('mixed', strategy, 'sendPrivateMixedForward', () => this.client.sendPrivateMixedForward!(userId, items, context.botName));
    }
    const groupId = required(context.groupId, 'groupId');
    if (!this.client.sendGroupMixedForward) return this.finish('mixed', strategy, [{ kind: 'mixed', strategy, method: 'sendGroupMixedForward', success: false, error: 'mixed forward not supported' }], { success: false, error: 'mixed forward not supported' });
    return this.wrap('mixed', strategy, 'sendGroupMixedForward', () => this.client.sendGroupMixedForward!(groupId, items, context.botName));
  }

  private async callGroupFile(groupId: number | string, file: NapcatFilePayload): Promise<NapcatSendResult> {
    if (!this.client.sendGroupFile) return { success: false, error: 'group file send not supported' };
    return this.client.sendGroupFile(groupId, file.file, file.name);
  }

  private async callPrivateFile(userId: number | string, file: NapcatFilePayload): Promise<NapcatSendResult> {
    if (!this.client.sendPrivateFile) return { success: false, error: 'private file send not supported' };
    return this.client.sendPrivateFile(userId, file.file, file.name);
  }

  private async wrap(kind: ReplyKind, strategy: ReplyStrategy, method: string, fn: () => Promise<NapcatSendResult>, sentImages?: string[], sentVideos?: string[]): Promise<ReplyDispatchResult> {
    const result = await fn();
    return this.finish(kind, strategy, [{ kind, strategy, method, success: result.success, error: result.error }], { ...result, sentImages, sentVideos });
  }

  private finish(kind: ReplyKind, strategy: ReplyStrategy, attempts: ReplyAttempt[], result: NapcatSendResult & { sentImages?: string[]; sentVideos?: string[] }): ReplyDispatchResult {
    return { ...result, kind, strategy, attempts };
  }
}

export function createReplyStrategyEngine(client: ReplyClient, config: ReplyStrategyConfig = {}): ReplyStrategyEngine {
  return new ReplyStrategyEngine(client, config);
}

/** 按段落/句子边界拆分长文本；maxChars <= 0 表示不拆分。 */
export function splitLongText(text: string, maxChars: number): string[] {
  const source = String(text || '');
  if (maxChars <= 0 || source.length <= maxChars) return [source];
  const chunks: string[] = [];
  let rest = source;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.45)) cut = Math.max(...['。', '！', '？', '；', '.', '!', '?', ';', '\n'].map((char) => rest.lastIndexOf(char, maxChars)));
    if (cut < Math.floor(maxChars * 0.45)) cut = maxChars;
    const chunk = rest.slice(0, Math.max(1, cut)).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(Math.max(1, cut)).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [source];
}

export function normalizeStrategy(value: unknown, fallback: ReplyStrategy = 'plain'): ReplyStrategy {
  return value === 'forward' || value === 'at' || value === 'quote' || value === 'plain' || value === 'text-image' || value === 'voice' ? value : fallback;
}

export function resolveReplyStrategy(config: ReplyStrategyConfig, kind: ReplyKind): ReplyStrategy {
  const fallback = kind === 'text' ? 'forward' : 'forward';
  return normalizeStrategy(config[kind as keyof ReplyStrategyConfig], fallback);
}

function assertTarget(context: ReplyContext): void {
  if (context.chatType === 'group') required(context.groupId, 'groupId');
  else required(context.userId, 'userId');
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`Reply context missing ${name}`);
  return value;
}

function uniqueIds(values: Array<number | string>): Array<number | string> {
  const seen = new Set<string>();
  const result: Array<number | string> = [];
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
