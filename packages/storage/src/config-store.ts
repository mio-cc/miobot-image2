import { FileJsonStore, type JsonStore } from './json-store.js';

export interface ConfigStoreOptions<T> {
  /** 文件不存在/损坏时的默认配置。 */
  defaultValue: T;
  /**
   * 归一化钩子：读出后统一补字段/迁移。由 admin-service 注入 packages/config 的 normalizeConfig，
   * 确保"配置 normalize 只在一处"（plan §2.2 铁律）。
   */
  normalize?: (raw: unknown) => T;
  /** 自定义底层仓储（测试可注入 InMemoryJsonStore）。 */
  store?: JsonStore<unknown>;
}

/**
 * 配置仓储：统一 config.json 的读写。读出经 normalize，写入原子落盘。
 * 取代脚本里散落的 fs.readFile/writeFile(config.json)。
 */
export class ConfigStore<T = unknown> {
  private readonly store: JsonStore<unknown>;
  private readonly normalize: (raw: unknown) => T;
  private readonly defaultValue: T;

  constructor(filePathOrStore: string | JsonStore<unknown>, options: ConfigStoreOptions<T>) {
    this.defaultValue = options.defaultValue;
    this.normalize = options.normalize || ((raw) => (raw === undefined ? options.defaultValue : (raw as T)));
    if (typeof filePathOrStore === 'string') {
      this.store = options.store || new FileJsonStore<unknown>(filePathOrStore, { defaultValue: options.defaultValue });
    } else {
      this.store = filePathOrStore;
    }
  }

  /** 读取并归一化当前配置。 */
  load(): T {
    const raw = this.store.exists() ? this.store.load() : this.defaultValue;
    return this.normalize(raw);
  }

  /** 写入配置（先归一化再原子落盘），返回落盘后的归一化结果。 */
  save(value: T): T {
    const normalized = this.normalize(value);
    this.store.save(normalized);
    return normalized;
  }

  exists(): boolean {
    return this.store.exists();
  }
}
