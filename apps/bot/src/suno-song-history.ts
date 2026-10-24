import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface SunoSongHistoryRecord {
  id: string;
  seq: number;
  scopeKey: string;
  chatType: 'group' | 'private';
  chatId: string;
  userQq: string;
  createdAt: string;
  requestText: string;
  taskId: string;
  audioId?: string;
  title?: string;
  lyrics?: string;
  audioUrl: string;
  duration?: number;
  model?: string;
  style?: string;
}

export interface SunoSongHistoryAddInput {
  chatType: 'group' | 'private';
  groupId?: string | number;
  userQq: string;
  requestText: string;
  taskId: string;
  audioId?: string;
  title?: string;
  lyrics?: string;
  audioUrl: string;
  duration?: number;
  model?: string;
  style?: string;
}

export interface SunoSongHistoryOptions {
  filePath: string;
  maxRecords?: () => number;
  logger?: StructuredLogger;
}

function normalizeTitle(value: unknown): string {
  return String(value || '').toLowerCase().replace(/\s+/g, '').trim();
}

export class SunoSongHistoryStore {
  private readonly filePath: string;
  private readonly maxRecords: () => number;
  private readonly logger?: StructuredLogger;
  private records: SunoSongHistoryRecord[] = [];

  constructor(options: SunoSongHistoryOptions) {
    this.filePath = options.filePath;
    this.maxRecords = options.maxRecords || (() => 100);
    this.logger = options.logger;
    this.loadSync();
  }

  private loadSync(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { records?: unknown };
      if (!Array.isArray(parsed?.records)) return;
      this.records = parsed.records.filter((item): item is SunoSongHistoryRecord => Boolean(item && typeof item === 'object' && typeof (item as any).id === 'string' && typeof (item as any).audioUrl === 'string'));
    } catch (error) {
      this.logger?.warn('Suno history read failed', { error: String((error as Error)?.message || error) });
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records: this.records }, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger?.warn('Suno history write failed', { error: String((error as Error)?.message || error) });
    }
  }

  scopeKey(chatType: 'group' | 'private', groupId: string | number | undefined, userQq: string): string {
    return chatType === 'group' ? `group:${String(groupId || '')}:${String(userQq)}` : `private:${String(userQq)}`;
  }

  add(input: SunoSongHistoryAddInput): SunoSongHistoryRecord {
    const scopeKey = this.scopeKey(input.chatType, input.groupId, input.userQq);
    const sameScope = this.records.filter((item) => item.scopeKey === scopeKey);
    const seq = sameScope.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0) + 1;
    const record: SunoSongHistoryRecord = {
      id: `song_${Date.now()}_${randomUUID().slice(0, 8)}`,
      seq,
      scopeKey,
      chatType: input.chatType,
      chatId: String(input.groupId || input.userQq),
      userQq: String(input.userQq),
      createdAt: new Date().toISOString(),
      requestText: String(input.requestText || '').slice(0, 500),
      taskId: String(input.taskId || ''),
      audioId: input.audioId ? String(input.audioId) : undefined,
      title: input.title ? String(input.title).slice(0, 200) : undefined,
      lyrics: input.lyrics ? String(input.lyrics).slice(0, 10000) : undefined,
      audioUrl: String(input.audioUrl || ''),
      duration: Number.isFinite(Number(input.duration)) ? Number(input.duration) : undefined,
      model: input.model ? String(input.model) : undefined,
      style: input.style ? String(input.style).slice(0, 1000) : undefined,
    };
    this.records.push(record);
    const limit = Math.max(1, Math.trunc(Number(this.maxRecords()) || 100));
    const scoped = this.records.filter((item) => item.scopeKey === scopeKey).sort((a, b) => b.seq - a.seq).slice(0, limit);
    const keep = new Set(scoped.map((item) => item.id));
    this.records = this.records.filter((item) => item.scopeKey !== scopeKey || keep.has(item.id));
    this.save();
    return record;
  }

  list(scopeOrChat: string, limit = 20): SunoSongHistoryRecord[] {
    return this.records
      .filter((item) => item.scopeKey === scopeOrChat)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20))));
  }

  find(scopeKey: string, query: { recordId?: string; sequence?: number; title?: string }): SunoSongHistoryRecord | undefined {
    const scoped = this.records.filter((item) => item.scopeKey === scopeKey);
    const recordId = String(query.recordId || '').trim();
    if (recordId) return scoped.find((item) => item.id === recordId);
    const sequence = Number(query.sequence);
    if (Number.isFinite(sequence) && sequence > 0) return scoped.find((item) => item.seq === Math.trunc(sequence));
    const title = normalizeTitle(query.title);
    if (title) return scoped.find((item) => normalizeTitle(item.title) === title || normalizeTitle(item.requestText) === title);
    return undefined;
  }

  formatList(scopeKey: string, limit = 20): string {
    const records = this.list(scopeKey, limit);
    if (!records.length) return '当前会话还没有生成过歌曲。';
    return [
      'Suno 歌曲历史（序号越大越新；回复序号或歌名即可选择）：',
      ...records.map((item) => {
        const title = item.title || item.requestText || '未命名歌曲';
        const date = item.createdAt.slice(0, 16).replace('T', ' ');
        return `#${item.seq} ${title} | ${date}${item.duration ? ` | ${Math.round(item.duration)}s` : ''}`;
      }),
    ].join('\n');
  }

  promptContext(scopeKey: string, limit = 10): string {
    const records = this.list(scopeKey, limit);
    if (!records.length) return '';
    return [
      '当前用户最近生成的歌曲（用于重发/编辑目标定位；序号稳定；不要按关键词硬匹配）：',
      ...records.map((item) => JSON.stringify({ seq: item.seq, recordId: item.id, title: item.title || '', request: String(item.requestText || '').slice(0, 40), duration: item.duration || null })),
    ].join('\n');
  }
}
