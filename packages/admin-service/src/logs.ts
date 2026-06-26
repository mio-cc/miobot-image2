import { filterLogRecords, LogFileStore } from '../../storage/src/index.js';
import type { LogQuery, LogRecord } from '../../logger/src/index.js';

/** 一路日志（系统 / 画布）的查询与清空。 */
export interface AdminLogChannel {
  query(query?: LogQuery): LogRecord[];
  append(record: LogRecord): void;
  clear(): void;
}

export interface AdminLogStore {
  system: AdminLogChannel;
  canvas: AdminLogChannel;
}

/** 内存日志通道（测试/无落盘场景）。 */
export class InMemoryLogChannel implements AdminLogChannel {
  private readonly records: LogRecord[] = [];
  private readonly max: number;

  constructor(max = 1000) {
    this.max = Math.max(1, Math.trunc(max));
  }

  query(query: LogQuery = {}): LogRecord[] {
    return filterLogRecords(this.records, query);
  }

  append(record: LogRecord): void {
    this.records.push(record);
    while (this.records.length > this.max) this.records.shift();
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** 文件日志通道：读历史 JSONL（与 logger 的 JsonFileLogSink 配套）。 */
export class FileLogChannel implements AdminLogChannel {
  private readonly store: LogFileStore;

  constructor(filePath: string) {
    this.store = new LogFileStore(filePath);
  }

  query(query: LogQuery = {}): LogRecord[] {
    return this.store.query(query);
  }

  append(record: LogRecord): void {
    this.store.append(record);
  }

  clear(): void {
    this.store.clear();
  }
}

export function createInMemoryLogStore(max = 1000): AdminLogStore {
  return { system: new InMemoryLogChannel(max), canvas: new InMemoryLogChannel(max) };
}

export function createFileLogStore(systemFile: string, canvasFile: string): AdminLogStore {
  return { system: new FileLogChannel(systemFile), canvas: new FileLogChannel(canvasFile) };
}
