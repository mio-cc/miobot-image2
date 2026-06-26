import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomic.js';
import type { LogQuery, LogRecord } from '../../logger/src/index.js';

/**
 * 日志文件仓储：读取 logger 的 JsonFileLogSink 落下的 JSONL 持久日志，供管理后台"日志页"查询。
 * 与内存 sink 互补：内存看最近、文件看历史。append/clear 也走这里，集中 IO。
 */
export class LogFileStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  /** 读取全部持久日志记录（损坏行跳过）。 */
  readAll(): LogRecord[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: LogRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as LogRecord);
      } catch {
        // 跳过损坏行，保证日志页不因一行坏数据整体失败。
      }
    }
    return out;
  }

  /** 按 level/scope/contains/limit 过滤（语义与 MemoryLogSink.query 对齐）。 */
  query(query: LogQuery = {}): LogRecord[] {
    return filterLogRecords(this.readAll(), query);
  }

  /** 追加一条记录（JSONL）。 */
  append(record: LogRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 日志写入失败不得影响主流程。
    }
  }

  /** 清空持久日志（原子写空文件）。 */
  clear(): void {
    try {
      writeFileAtomicSync(this.filePath, '');
    } catch {
      // best-effort
    }
  }
}

/** 过滤日志记录：level 精确、scope 前缀、contains 全文（忽略大小写）、limit 取末尾 N 条。语义与 MemoryLogSink.query 对齐。 */
export function filterLogRecords(records: LogRecord[], query: LogQuery = {}): LogRecord[] {
  let items = [...records];
  if (query.level) {
    items = items.filter((item) => item.level === query.level);
  }
  if (query.scope) {
    items = items.filter((item) => item.scope === query.scope || item.scope.startsWith(`${query.scope}:`));
  }
  if (query.contains) {
    const needle = query.contains.toLowerCase();
    items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }
  if (query.limit !== undefined) items = items.slice(-Math.max(0, Math.trunc(query.limit)));
  return items;
}

/**
 * 合并内存与文件两路日志：按 (timestamp|scope|level|message) 去重，按时间升序，可选取末尾 limit 条。
 * 取代 local-verify-server 里手写的 mergeLogEntries。
 */
export function mergeLogRecords(a: LogRecord[], b: LogRecord[], limit?: number): LogRecord[] {
  const seen = new Set<string>();
  const merged: LogRecord[] = [];
  for (const record of [...a, ...b]) {
    const key = `${record.timestamp}|${record.scope}|${record.level}|${record.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  merged.sort((x, y) => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0));
  if (limit !== undefined) return merged.slice(-Math.max(0, Math.trunc(limit)));
  return merged;
}
