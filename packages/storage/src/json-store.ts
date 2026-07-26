import fs from 'node:fs';
import path from 'node:path';
import { fileExists, readJsonSync, writeJsonAtomicSync } from './atomic.js';

/** 可注入的 JSON 仓储抽象：业务只依赖这个接口，便于单测换内存实现。 */
export interface JsonStore<T> {
  load(): T;
  save(value: T): void;
  exists(): boolean;
}

export interface FileJsonStoreOptions<T> {
  /** 文件不存在/损坏时返回的默认值。 */
  defaultValue: T;
  /**
   * 文件存在但解析失败时，是否保护磁盘上的原文件。
   *
   * 对用户手写、且内含密钥的文件（config.json）必须开启：
   * 否则「语法错一个逗号 → 内存里跑默认配置 → 下一次保存」会把用户的全部节点与密钥
   * 用默认值永久覆盖，且没有任何提示。开启后会备份原文件并让 save() 直接报错。
   *
   * 缓存/日志类文件不需要开（损坏了重建即可）。默认关闭以保持既有行为。
   */
  guardCorruptedFile?: boolean;
  /** 检测到损坏时的回调（用于打日志/告警）。 */
  onCorrupted?: (info: { filePath: string; backupPath?: string; reason: string }) => void;
}

/** 文件后端 JSON 仓储：原子写、损坏回退默认值（可选保护原文件）。 */
export class FileJsonStore<T> implements JsonStore<T> {
  readonly filePath: string;
  private readonly defaultValue: T;
  private readonly guardCorruptedFile: boolean;
  private readonly onCorrupted?: FileJsonStoreOptions<T>['onCorrupted'];
  private corruptedReason = '';

  constructor(filePath: string, options: FileJsonStoreOptions<T>) {
    this.filePath = filePath;
    this.defaultValue = options.defaultValue;
    this.guardCorruptedFile = options.guardCorruptedFile === true;
    this.onCorrupted = options.onCorrupted;
  }

  /** 文件是否处于「存在但解析不了」的状态。此时禁止写盘。 */
  isCorrupted(): boolean {
    return Boolean(this.corruptedReason);
  }

  corruptionReason(): string {
    return this.corruptedReason;
  }

  load(): T {
    if (!this.guardCorruptedFile) return readJsonSync<T>(this.filePath, this.defaultValue);

    if (!fileExists(this.filePath)) {
      this.corruptedReason = '';
      return clone(this.defaultValue);
    }

    try {
      const raw = fs.readFileSync(path.resolve(this.filePath), 'utf8');
      if (!raw.trim()) {
        // 空文件当作「还没写过」，不算损坏。
        this.corruptedReason = '';
        return clone(this.defaultValue);
      }
      const parsed = JSON.parse(raw) as T;
      this.corruptedReason = '';
      return parsed;
    } catch (error) {
      this.corruptedReason = (error as Error)?.message || String(error);
      const backupPath = this.backupCorruptedFile();
      this.onCorrupted?.({ filePath: this.filePath, backupPath, reason: this.corruptedReason });
      return clone(this.defaultValue);
    }
  }

  save(value: T): void {
    if (this.corruptedReason) {
      throw new Error(
        `拒绝写入 ${this.filePath}：该文件当前解析失败（${this.corruptedReason}），`
        + '继续保存会用默认值覆盖你的原配置。请先修复文件语法后重启。',
      );
    }
    writeJsonAtomicSync(this.filePath, value);
  }

  exists(): boolean {
    return fileExists(this.filePath);
  }

  private backupCorruptedFile(): string | undefined {
    const backupPath = `${path.resolve(this.filePath)}.broken-${Date.now()}`;
    try {
      fs.copyFileSync(path.resolve(this.filePath), backupPath);
      return backupPath;
    } catch {
      // 备份失败不该阻断启动，但 save() 仍会被拦住，原文件不会被覆盖。
      return undefined;
    }
  }
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 内存 JSON 仓储：测试用，无磁盘副作用。 */
export class InMemoryJsonStore<T> implements JsonStore<T> {
  private value: T | undefined;
  private has = false;

  constructor(initial?: T) {
    if (initial !== undefined) {
      this.value = initial;
      this.has = true;
    }
  }

  load(): T {
    return (this.has ? (this.value as T) : (undefined as unknown as T));
  }

  save(value: T): void {
    this.value = value;
    this.has = true;
  }

  exists(): boolean {
    return this.has;
  }
}
