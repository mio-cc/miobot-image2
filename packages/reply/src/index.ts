import { dedupeFilePayloads, dedupeImageUrls, type NapcatFilePayload, type NapcatMixedForwardItem, type NapcatSendResult } from '../../napcat/src/index.js';
import type { PackageDescriptor, ReplyStrategy } from '@miobot-v2/shared';

export const REPLY_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/reply',
  phase: 'P7-reply-strategy',
};

export type ReplyKind = 'text' | 'image' | 'multiImage' | 'file' | 'multiFile' | 'mixed';
export type ChatType = 'group' | 'private';
export type ReplyFile = string | NapcatFilePayload;

export interface ReplyStrategyConfig {
  text?: ReplyStrategy;
  image?: ReplyStrategy;
  multiImage?: ReplyStrategy;
  file?: ReplyStrategy;
  multiFile?: ReplyStrategy;
  mixed?: ReplyStrategy;
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
  sendGroupImage(groupId: number | string, fileUrl: string, summaryText?: string): Promise<NapcatSendResult>;
  sendPrivateImage(userId: number | string, fileUrl: string): Promise<NapcatSendResult>;
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
}

export class ReplyStrategyEngine {
  private readonly client: ReplyClient;
  private readonly config: Required<ReplyStrategyConfig>;

  constructor(client: ReplyClient, config: ReplyStrategyConfig = {}) {
    this.client = client;
    this.config = {
      text: normalizeStrategy(config.text, 'forward'),
      image: normalizeStrategy(config.image, 'forward'),
      multiImage: normalizeStrategy(config.multiImage, 'forward'),
      file: normalizeStrategy(config.file, 'forward'),
      multiFile: normalizeStrategy(config.multiFile, 'forward'),
      mixed: normalizeStrategy(config.mixed, 'forward'),
      fallbackSequentialOnForwardFailure: config.fallbackSequentialOnForwardFailure !== false,
    };
  }

  async replyText(context: ReplyContext, text: string, strategy = this.config.text): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.text);
    assertTarget(context);
    if (context.chatType === 'private') return this.replyPrivateText(context, text, resolved);
    return this.replyGroupText(context, text, resolved);
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

  async replyFiles(context: ReplyContext, files: ReplyFile[], strategy = this.config.multiFile): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.multiFile);
    assertTarget(context);
    const cleanFiles = dedupeFilePayloads(files);
    if (!cleanFiles.length) return this.finish('multiFile', resolved, [{ kind: 'multiFile', strategy: resolved, method: 'validate-files', success: false, error: 'no files to send' }], { success: false, error: 'no files to send' });
    if (cleanFiles.length === 1) return this.replySingleFile(context, cleanFiles[0], this.config.file);
    if (context.chatType === 'private') return this.replyPrivateFiles(context, cleanFiles, resolved);
    return this.replyGroupFiles(context, cleanFiles, resolved);
  }

  async replyMixed(context: ReplyContext, payload: { text?: string; images?: string[]; files?: ReplyFile[] }, strategy = this.config.mixed): Promise<ReplyDispatchResult> {
    const resolved = normalizeStrategy(strategy, this.config.mixed);
    assertTarget(context);
    const text = String(payload?.text || '').trim();
    const images = dedupeImageUrls(payload?.images || []);
    const files = dedupeFilePayloads(payload?.files || []);

    if (files.length && images.length) {
      const items: NapcatMixedForwardItem[] = [
        ...(text ? [{ kind: 'text' as const, text, title: context.botName || 'Miobot' }] : []),
        ...images.map((file, index) => ({ kind: 'image' as const, file, title: `${context.botName || 'Miobot'} ?? ${index + 1}/${images.length}` })),
        ...files.map((file, index) => ({ kind: 'file' as const, ...file, title: `${context.botName || 'Miobot'} ?? ${index + 1}/${files.length}` })),
      ];
      return this.sendMixedForward(context, items, resolved);
    }

    if (files.length) return this.replyFiles(context, files, resolved);
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

  private async wrap(kind: ReplyKind, strategy: ReplyStrategy, method: string, fn: () => Promise<NapcatSendResult>, sentImages?: string[]): Promise<ReplyDispatchResult> {
    const result = await fn();
    return this.finish(kind, strategy, [{ kind, strategy, method, success: result.success, error: result.error }], { ...result, sentImages });
  }

  private finish(kind: ReplyKind, strategy: ReplyStrategy, attempts: ReplyAttempt[], result: NapcatSendResult & { sentImages?: string[] }): ReplyDispatchResult {
    return { ...result, kind, strategy, attempts };
  }
}

export function createReplyStrategyEngine(client: ReplyClient, config: ReplyStrategyConfig = {}): ReplyStrategyEngine {
  return new ReplyStrategyEngine(client, config);
}

export function normalizeStrategy(value: unknown, fallback: ReplyStrategy = 'plain'): ReplyStrategy {
  return value === 'forward' || value === 'at' || value === 'quote' || value === 'plain' ? value : fallback;
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
