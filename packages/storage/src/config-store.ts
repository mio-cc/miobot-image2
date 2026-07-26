import fs from 'node:fs';

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
  /** 检测到 config.json 损坏时的回调（用于打日志/告警）。 */
  onCorrupted?: (info: { filePath: string; backupPath?: string; reason: string }) => void;
}

/**
 * 配置仓储：统一 config.json 的读写。读出经 normalize，写入原子落盘。
 * 取代脚本里散落的 fs.readFile/writeFile(config.json)。
 */
export class ConfigStore<T = unknown> {
  private readonly store: JsonStore<unknown>;
  private readonly normalize: (raw: unknown) => T;
  private readonly defaultValue: T;
  /** 只有文件型仓储才有路径；内存型仓储没有 mtime 可比，每次都重新读。 */
  private readonly filePath?: string;
  private cached?: { stamp: string; value: T };

  constructor(filePathOrStore: string | JsonStore<unknown>, options: ConfigStoreOptions<T>) {
    this.defaultValue = options.defaultValue;
    this.normalize = options.normalize || ((raw) => (raw === undefined ? options.defaultValue : (raw as T)));
    if (typeof filePathOrStore === 'string') this.filePath = filePathOrStore;
    if (typeof filePathOrStore === 'string') {
      // config.json 是用户手写、且内含全部节点密钥的文件：
      // 解析失败时必须保护原文件，绝不能让默认值覆盖上去。
      this.store = options.store || new FileJsonStore<unknown>(filePathOrStore, {
        defaultValue: options.defaultValue,
        guardCorruptedFile: true,
        onCorrupted: options.onCorrupted,
      });
    } else {
      this.store = filePathOrStore;
    }
  }

  /** config.json 当前是否处于「存在但解析不了」的状态（此时所有保存都会被拒绝）。 */
  isCorrupted(): boolean {
    const store = this.store as { isCorrupted?: () => boolean };
    return typeof store.isCorrupted === 'function' ? store.isCorrupted() : false;
  }

  corruptionReason(): string {
    const store = this.store as { corruptionReason?: () => string };
    return typeof store.corruptionReason === 'function' ? store.corruptionReason() : '';
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

  /**
   * 文件变了才重新读，否则给上次的结果。
   *
   * 为什么需要它：web 和 bot 是 miobot-service 起的**两个独立进程**，
   * 只共享一个 config.json。面板保存后 web 进程内的热重载确实生效了，
   * 但 bot 进程的配置是启动时 load 的那一份，此后永不改变——
   * 于是面板上那句「配置已热重载生效，无需重启」对机器人完全是假的：
   * 换模型、改触发词、改白名单、调并发上限，QQ 里的机器人一律照旧，
   * 直到有人手动重启。排障时会出现「后台明明写着 A，日志里却在调 B」。
   *
   * 配置文件很小，但 normalize 不便宜，而 bot 每条消息都要问一次，
   * 所以先 stat（很便宜），mtime + size 都没变就直接复用缓存。
   */
  loadIfChanged(): T {
    if (!this.filePath) return this.normalize(this.store.exists() ? this.store.load() : this.defaultValue);

    let stamp: string;
    try {
      const st = fs.statSync(this.filePath);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // 文件暂时读不到（被替换/权限抖动）——继续用上一次的好配置。
      // 绝不能在这里回落到默认值：那等于白名单突然清空、变成谁都能用。
      if (this.cached) return this.cached.value;
      stamp = 'missing';
    }

    if (this.cached && this.cached.stamp === stamp) return this.cached.value;

    try {
      const value = this.load();
      // 开了损坏保护的仓储在解析失败时**不会抛**，而是返回默认值——
      // 直接采信就等于白名单突然清空、面板密码回落默认种子。必须显式问一句。
      if (this.isCorrupted() && this.cached) {
        // 记下 stamp，避免每条消息都重新读一个已知读不了的文件；
        // 用户把语法修好后 mtime 会再变，那时自然会重新加载。
        this.cached = { stamp, value: this.cached.value };
        return this.cached.value;
      }
      this.cached = { stamp, value };
      return value;
    } catch (error) {
      // 解析失败同理：宁可继续用旧配置，也不能 fail-open 成默认配置。
      if (this.cached) return this.cached.value;
      throw error;
    }
  }
}
