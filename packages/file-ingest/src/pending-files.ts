import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface PendingFileRecord {
  code: string;
  messageId: string;
  chatType: 'group' | 'private';
  chatKey: string;
  groupId?: string;
  userId: string;
  fileId?: string;
  file?: string;
  url?: string;
  name: string;
  size: number;
  mime: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingFileInput {
  messageId?: string | number;
  chatType: 'group' | 'private';
  groupId?: string | number;
  userId: string | number;
  fileId?: string;
  file?: string;
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
}

export interface PendingFileIndexOptions {
  filePath?: string;
  /** 静态数值或现读函数（支持配置热重载）。 */
  ttlMs?: number | (() => number);
  maxPerChat?: number | (() => number);
  maxTotal?: number;
}

export function chatKeyOf(chatType: 'group' | 'private', groupId?: string | number, userId?: string | number): string {
  return chatType === 'group' ? `group:${String(groupId ?? '')}` : `private:${String(userId ?? '')}`;
}

function shortCode(messageId: string): string {
  return `F${createHash('sha1').update(messageId || randomUUID()).digest('hex').slice(0, 5).toUpperCase()}`;
}

export class PendingFileIndex {
  readonly filePath?: string;
  /** 热重载支持：数值或现读函数，访问时解析。 */
  readonly ttlMs: number | (() => number);
  readonly maxPerChat: number | (() => number);
  readonly maxTotal: number;
  private records: PendingFileRecord[] = [];
  resolvedTtlMs(): number {
    return typeof this.ttlMs === 'function' ? Math.max(0, this.ttlMs() || 0) : this.ttlMs;
  }
  resolvedMaxPerChat(): number {
    return typeof this.maxPerChat === 'function' ? Math.max(1, this.maxPerChat() || 1) : this.maxPerChat;
  }
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: PendingFileIndexOptions = {}) {
    this.filePath = options.filePath;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxPerChat = options.maxPerChat ?? 200;
    this.maxTotal = options.maxTotal ?? 5000;
  }

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (Array.isArray(raw?.records)) {
        this.records = raw.records.filter((item: any) => item && item.messageId && item.chatKey);
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') this.records = [];
    }
    this.prune();
  }

  loadSync(): void {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(raw?.records)) {
        this.records = raw.records.filter((item: any) => item && item.messageId && item.chatKey);
      }
    } catch {
      this.records = [];
    }
    this.prune();
  }

  record(input: PendingFileInput): PendingFileRecord {
    const now = Date.now();
    const messageId = String(input.messageId ?? randomUUID());
    const chatKey = chatKeyOf(input.chatType, input.groupId, input.userId);
    const existing = this.records.find((item) => item.chatKey === chatKey && item.messageId === messageId);
    if (existing) return existing;
    let code = shortCode(messageId);
    let n = 1;
    while (this.records.some((item) => item.chatKey === chatKey && item.code === code)) {
      code = `${shortCode(messageId)}-${n++}`;
    }
    const record: PendingFileRecord = {
      code,
      messageId,
      chatType: input.chatType,
      chatKey,
      groupId: input.groupId === undefined ? undefined : String(input.groupId),
      userId: String(input.userId),
      fileId: input.fileId ? String(input.fileId) : undefined,
      file: input.file ? String(input.file) : undefined,
      url: input.url ? String(input.url) : undefined,
      name: String(input.name || '未命名文件'),
      size: Number(input.size || 0),
      mime: String(input.mime || ''),
      createdAt: now,
      expiresAt: now + this.resolvedTtlMs(),
    };
    this.records.push(record);
    this.prune();
    void this.save();
    return record;
  }

  findByMessageId(chatType: 'group' | 'private', groupId: string | number | undefined, userId: string | number | undefined, messageId: string | number): PendingFileRecord | undefined {
    this.prune();
    const key = chatKeyOf(chatType, groupId, userId);
    return this.records.find((item) => item.chatKey === key && item.messageId === String(messageId));
  }

  findCode(chatType: 'group' | 'private', groupId: string | number | undefined, userId: string | number | undefined, code: string): PendingFileRecord | undefined {
    this.prune();
    const key = chatKeyOf(chatType, groupId, userId);
    const target = String(code || '').trim().toUpperCase();
    return this.records.find((item) => item.chatKey === key && item.code.toUpperCase() === target);
  }

  list(chatType: 'group' | 'private', groupId: string | number | undefined, userId: string | number | undefined, limit = 10): PendingFileRecord[] {
    this.prune();
    const key = chatKeyOf(chatType, groupId, userId);
    return this.records.filter((item) => item.chatKey === key).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, limit));
  }

  prune(now = Date.now()): void {
    const before = this.records.length;
    this.records = this.records.filter((item) => item.expiresAt > now);
    const byChat = new Map<string, PendingFileRecord[]>();
    for (const item of this.records) byChat.set(item.chatKey, [...(byChat.get(item.chatKey) || []), item]);
    const keep = new Set<string>();
    for (const items of byChat.values()) {
      items.sort((a, b) => b.createdAt - a.createdAt).slice(0, this.resolvedMaxPerChat()).forEach((item) => keep.add(item.chatKey + ':' + item.code + ':' + item.messageId));
    }
    this.records = this.records.filter((item) => keep.has(item.chatKey + ':' + item.code + ':' + item.messageId));
    if (this.records.length > this.maxTotal) this.records = this.records.slice(-this.maxTotal);
    if (before !== this.records.length) void this.save();
  }

  async save(): Promise<void> {
    if (!this.filePath) return;
    const payload = JSON.stringify({ version: 1, records: this.records }, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath!), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.filePath!);
    }).catch(() => undefined);
    await this.saveChain;
  }
}
