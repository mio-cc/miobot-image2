import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel, PackageDescriptor, SerializableError } from '@miobot-v2/shared';

export const LOGGER_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/logger',
  phase: 'P4-infrastructure',
};

export type { LogLevel } from '@miobot-v2/shared';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
  error?: SerializableError | Record<string, unknown>;
}

export interface LoggerSink {
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  scope?: string;
  level?: LogLevel;
  sinks?: LoggerSink[];
  clock?: () => Date;
  redactKeys?: string[];
}

export interface LogQuery {
  level?: LogLevel;
  scope?: string;
  contains?: string;
  limit?: number;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_REDACT_KEYS = ['password', 'passwordSeed', 'token', 'authorization', 'apiKey', 'key', 'secret'];

export class MemoryLogSink implements LoggerSink {
  readonly maxEntries: number;
  private readonly records: LogRecord[] = [];

  constructor(maxEntries = 1000) {
    this.maxEntries = Math.max(1, Math.trunc(maxEntries));
  }

  write(record: LogRecord): void {
    this.records.push(record);
    while (this.records.length > this.maxEntries) this.records.shift();
  }

  all(): LogRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }

  query(query: LogQuery = {}): LogRecord[] {
    let items = this.all();
    if (query.level) items = items.filter((item) => item.level === query.level);
    if (query.scope) items = items.filter((item) => item.scope === query.scope || item.scope.startsWith(`${query.scope}:`));
    if (query.contains) {
      const needle = query.contains.toLowerCase();
      items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
    }
    if (query.limit !== undefined) items = items.slice(-Math.max(0, Math.trunc(query.limit)));
    return items;
  }
}

export class ConsoleLogSink implements LoggerSink {
  write(record: LogRecord): void {
    const line = JSON.stringify(record);
    if (record.level === 'error') console.error(line);
    else if (record.level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export class JsonFileLogSink implements LoggerSink {
  readonly filePath: string;
  readonly maxBytes: number;

  constructor(filePath: string, maxBytes = 5 * 1024 * 1024) {
    this.filePath = path.resolve(filePath);
    this.maxBytes = Math.max(64 * 1024, Math.trunc(maxBytes));
  }

  write(record: LogRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      rotateIfNeeded(this.filePath, this.maxBytes);
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Logging must never break runtime behavior.
    }
  }
}

export class StructuredLogger {
  private readonly scope: string;
  private readonly level: LogLevel;
  private readonly sinks: LoggerSink[];
  private readonly clock: () => Date;
  private readonly redactKeys: string[];

  constructor(options: LoggerOptions = {}) {
    this.scope = options.scope || 'app';
    this.level = options.level || 'info';
    this.sinks = options.sinks || [];
    this.clock = options.clock || (() => new Date());
    this.redactKeys = options.redactKeys || DEFAULT_REDACT_KEYS;
  }

  child(scope: string): StructuredLogger {
    return new StructuredLogger({
      scope: `${this.scope}:${scope}`,
      level: this.level,
      sinks: this.sinks,
      clock: this.clock,
      redactKeys: this.redactKeys,
    });
  }

  debug(message: string, data?: unknown): LogRecord | undefined { return this.log('debug', message, data); }
  info(message: string, data?: unknown): LogRecord | undefined { return this.log('info', message, data); }
  warn(message: string, data?: unknown): LogRecord | undefined { return this.log('warn', message, data); }
  error(message: string, data?: unknown): LogRecord | undefined { return this.log('error', message, data); }

  log(level: LogLevel, message: string, data?: unknown): LogRecord | undefined {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return undefined;
    const record: LogRecord = {
      timestamp: this.clock().toISOString(),
      level,
      scope: this.scope,
      message,
    };
    const redacted = redactValue(data, new Set(this.redactKeys.map((key) => key.toLowerCase())));
    if (redacted !== undefined) {
      if (isRecord(redacted) && isRecord(redacted.error)) record.error = redacted.error as LogRecord['error'];
      record.data = redacted;
    }
    for (const sink of this.sinks) sink.write(record);
    return record;
  }
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  return new StructuredLogger(options);
}

export function redactValue(value: unknown, redactKeys: Set<string> = new Set(DEFAULT_REDACT_KEYS.map((key) => key.toLowerCase()))): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactKeys));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactKeys.has(key.toLowerCase()) ? '[REDACTED]' : redactValue(item, redactKeys);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rotateIfNeeded(filePath: string, maxBytes: number): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return;
    const rotated = `${filePath}.1`;
    fs.rmSync(rotated, { force: true });
    fs.renameSync(filePath, rotated);
  } catch {
    // Best-effort rotation.
  }
}
