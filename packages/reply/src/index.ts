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

  async replyText(context: ReplyContext, text: string, strategy = this.config.text): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.text);
    assertTarget(context);
    const chunks = splitLongText(text, this.textReply.maxChars);
    if (chunks.length <= 1) {
      if (context.chatType === 'private') return this.replyPrivateText(context, text, resolved);
      return this.replyGroupText(context, text, resolved);
    }
    const partNodes = chunks.map((chunk, index) => {
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
            if (nested.success) return nested;
          } catch { /* Napcat 不支持嵌套节点时回退到单个外层合并转发 */ }
        }
        if (this.client.sendGroupTextForward) {
          return this.wrap(
            'text', resolved, 'sendGroupTextForward(split)',
            () => this.client.sendGroupTextForward!(groupId, partNodes, context.botName),
          );
        }
      } else {
        const userId = required(context.userId, 'userId');
        if (this.client.sendPrivateNestedTextForward) {
          try {
            const nested = await this.wrap(
              'text', resolved, 'sendPrivateNestedTextForward',
              () => this.client.sendPrivateNestedTextForward!(userId, groups, context.botName),
            );
            if (nested.success) return nested;
          } catch { /* Napcat 不支持嵌套节点时回退到单个外层合并转发 */ }
        }
        if (this.client.sendPrivateTextForward) {
          return this.wrap(
            'text', resolved, 'sendPrivateTextForward(split)',
            () => this.client.sendPrivateTextForward!(userId, partNodes, context.botName),
          );
        }
      }
    }
    let last: ReplyDispatchResult | undefined;
    for (let i = 0; i < chunks.length; i += 1) {
      const part = partNodes[i].content;
      const partContext: ReplyContext = i === 0 ? context : { ...context, replyToMessageId: undefined };
      last = context.chatType === 'private'
        ? await this.replyPrivateText(partContext, part, resolved)
        : await this.replyGroupText(partContext, part, resolved);
      if (!last.success) return last;
      if (i < chunks.length - 1 && this.textReply.splitDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.textReply.splitDelayMs));
      }
    }
    return last!;
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

  async replyMixed(context: ReplyContext, payload: { text?: string; images?: string[]; videos?: string[]; files?: ReplyFile[] }, strategy = this.config.mixed): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.mixed);
    assertTarget(context);
    const text = String(payload?.text || '').trim();
    const images = dedupeImageUrls(payload?.images || []);
    const videos = dedupeVideoUrls(payload?.videos || []);
    const files = dedupeFilePayloads(payload?.files || []);
    const mediaKinds = [images.length > 0, videos.length > 0, files.length > 0].filter(Boolean).length;

    // 图/视/文件混排 → 合并转发；单介质走专用路径。
    if (mediaKinds >= 2 || (text && (videos.length || (files.length && images.length)))) {
      const items: NapcatMixedForwardItem[] = [
        ...(text ? [{ kind: 'text' as const, text, title: context.botName || 'Miobot' }] : []),
        ...images.map((file, index) => ({ kind: 'image' as const, file, title: `${context.botName || 'Miobot'} 图 ${index + 1}/${images.length}` })),
        ...videos.map((file, index) => ({ kind: 'video' as const, file, title: `${context.botName || 'Miobot'} 视频 ${index + 1}/${videos.length}` })),
        ...files.map((file, index) => ({ kind: 'file' as const, ...file, title: `${context.botName || 'Miobot'} 文件 ${index + 1}/${files.length}` })),
      ];
      return this.sendMixedForward(context, items, resolved);
    }

    if (files.length) return this.replyFiles(context, files, resolved);
    if (videos.length) return this.replyVideos(context, videos, resolved);
    if (images.length) return this.replyImages(context, images, resolved);
    return this.replyText(context, text, resolved);
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
  return value === 'forward' || value === 'at' || value === 'quote' || value === 'plain' || value === 'text-image' ? value : fallback;
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
