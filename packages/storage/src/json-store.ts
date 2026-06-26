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
}

/** 文件后端 JSON 仓储：原子写、损坏回退默认值。 */
export class FileJsonStore<T> implements JsonStore<T> {
  readonly filePath: string;
  private readonly defaultValue: T;

  constructor(filePath: string, options: FileJsonStoreOptions<T>) {
    this.filePath = filePath;
    this.defaultValue = options.defaultValue;
  }

  load(): T {
    return readJsonSync<T>(this.filePath, this.defaultValue);
  }

  save(value: T): void {
    writeJsonAtomicSync(this.filePath, value);
  }

  exists(): boolean {
    return fileExists(this.filePath);
  }
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
