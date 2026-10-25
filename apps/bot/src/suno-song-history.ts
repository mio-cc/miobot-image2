import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface SunoSongHistoryRecord {
  id: string;
  seq: number;
  /** 全局稳定序号（跨会话/跨用户递增），全局共享列表与"回复序号选歌"都用它。 */
  globalSeq?: number;
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
  /** 分支版本：指向同一次生成的主记录 id；主记录该字段为空。 */
  variantOf?: string;
  /** 1=主版（实际交付），2+=保留的分支版本。旧记录视为 1。 */
  variantIndex?: number;
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
  variantOf?: string;
  variantIndex?: number;
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
      // 迁移：旧记录没有 globalSeq——按 createdAt 升序回填，保证序号稳定（下次 add 落盘固化）。
      const missing = this.records.filter((item) => !Number.isFinite(Number(item.globalSeq)));
      if (missing.length) {
        [...this.records]
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .forEach((item, index) => { item.globalSeq = index + 1; });
      }
    } catch (error) {
      this.logger?.warn('Suno history read failed', { error: String((error as Error)?.message || error) });
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, records: this.records }, null, 2), 'utf8');
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
    const globalSeq = this.records.reduce((max, item) => Math.max(max, Number(item.globalSeq) || 0), 0) + 1;
    const record: SunoSongHistoryRecord = {
      id: `song_${Date.now()}_${randomUUID().slice(0, 8)}`,
      seq,
      globalSeq,
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
      variantOf: input.variantOf ? String(input.variantOf) : undefined,
      variantIndex: Number.isFinite(Number(input.variantIndex)) ? Math.trunc(Number(input.variantIndex)) : undefined,
    };
    this.records.push(record);
    const limit = Math.max(1, Math.trunc(Number(this.maxRecords()) || 100));
    const scoped = this.records.filter((item) => item.scopeKey === scopeKey).sort((a, b) => b.seq - a.seq).slice(0, limit);
    const keep = new Set(scoped.map((item) => item.id));
    this.records = this.records.filter((item) => item.scopeKey !== scopeKey || keep.has(item.id));
    // T2.7：全局上限（每范围上限×20）——跨会话总量随用户/群数增长，防文件无限膨胀。
    const globalLimit = limit * 20;
    if (this.records.length > globalLimit) {
      this.records = this.records
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, globalLimit);
    }
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

  /** 全局共享：全库按 globalSeq 倒序（歌单是公开内容，任何会话可查所有生成记录）。 */
  listGlobal(limit = 20): SunoSongHistoryRecord[] {
    return this.records
      .slice()
      .sort((a, b) => (Number(b.globalSeq) || 0) - (Number(a.globalSeq) || 0))
      .slice(0, Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20))));
  }

  /** 全局查找：recordId 全局唯一；globalSeq/sequence 为全局序号；title 命中多条时优先主版。 */
  findGlobal(query: { recordId?: string; globalSeq?: number; sequence?: number; title?: string }): SunoSongHistoryRecord | undefined {
    const recordId = String(query.recordId || '').trim();
    if (recordId) return this.records.find((item) => item.id === recordId);
    const seq = Number(query.globalSeq ?? query.sequence);
    if (Number.isFinite(seq) && seq > 0) return this.records.find((item) => Number(item.globalSeq) === Math.trunc(seq));
    const title = normalizeTitle(query.title);
    if (title) {
      const matches = this.records.filter((item) => normalizeTitle(item.title) === title || normalizeTitle(item.requestText) === title);
      return matches.find((item) => (Number(item.variantIndex) || 1) === 1) ?? matches[0];
    }
    return undefined;
  }

  /** 同一次生成的另一版本（同 taskId 分组优先，variantOf 兜底）。 */
  findVariantOf(record: SunoSongHistoryRecord): SunoSongHistoryRecord | undefined {
    const group = record.taskId
      ? this.records.filter((item) => item.taskId === record.taskId)
      : this.records.filter((item) => item.variantOf === record.id || item.id === record.variantOf);
    if (group.length <= 1) return undefined;
    const selfIndex = Number(record.variantIndex) || 1;
    return group.find((item) => item.id !== record.id && (Number(item.variantIndex) || 1) !== selfIndex)
      ?? group.find((item) => item.id !== record.id);
  }

  private hasVariant(record: SunoSongHistoryRecord): boolean {
    return this.findVariantOf(record) !== undefined;
  }

  /** 全局共享列表（不标注来源群与生成者——歌单是公开内容，输出只含序号/标题/时间/分支标记）。 */
  formatListGlobal(limit = 20): string {
    const records = this.listGlobal(limit);
    if (!records.length) return '还没有生成过歌曲。';
    return [
      'Suno 歌曲历史（序号越大越新；回复序号或歌名即可选择）：',
      ...records.map((item) => {
        const title = item.title || item.requestText || '未命名歌曲';
        const date = item.createdAt.slice(0, 16).replace('T', ' ');
        const variantTag = (Number(item.variantIndex) || 1) === 2 ? ' | B版' : (this.hasVariant(item) ? ' | 有B版' : '');
        return `#${item.globalSeq} ${title} | ${date}${item.duration ? ` | ${Math.round(item.duration)}s` : ''}${variantTag}`;
      }),
    ].join('\n');
  }

  /** 全局歌曲上下文（供 planner 定位重发/取另一版/同曲换词重做/编辑目标；不携带会话与用户信息）。 */
  promptContextGlobal(limit = 10): string {
    const records = this.listGlobal(limit);
    if (!records.length) return '';
    return [
      '最近生成的全部歌曲（全局共享，用于重发/取另一版/换词重做/编辑目标定位；序号稳定；不要按关键词硬匹配；"换词重做"时用对应记录的 style 作为生成 style）：',
      ...records.map((item) => JSON.stringify({ seq: item.globalSeq, recordId: item.id, title: item.title || '', variantIndex: item.variantIndex ?? 1, duration: item.duration || null, style: item.style || null, hasLyrics: Boolean(item.lyrics) })),
    ].join('\n');
  }
}
