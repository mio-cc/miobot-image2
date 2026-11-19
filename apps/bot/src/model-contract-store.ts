/**
 * 参数契约落盘（2026-11-19）。
 *
 * 为什么不放数据库：契约是「上游文档的快照」，体积小、读取频繁、丢失可重抓。
 * 与 model-capabilities.json 同构（原子写 + 损坏只告警），便于一起备份/清理。
 *
 * 结构：
 *   { version: 1, entries: { [key]: ModelParamContract } }
 * key 与 capabilityKey 同构（dialect|baseUrl::凭据指纹::模型名），因此换 key 自然失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseContract, type ModelParamContract } from '../../../packages/model/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface ModelContractStoreOptions {
  filePath: string;
  logger?: StructuredLogger;
  flushDelayMs?: number;
}

export class FileModelContractStore {
  private readonly filePath: string;
  private readonly logger?: StructuredLogger;
  private readonly flushDelayMs: number;
  private readonly store = new Map<string, ModelParamContract>();
  private timer?: NodeJS.Timeout;
  private dirty = false;

  constructor(options: ModelContractStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.flushDelayMs = Math.max(0, Math.trunc(options.flushDelayMs ?? 800));
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { version?: number; entries?: Record<string, unknown> };
      if (!raw || typeof raw !== 'object' || !raw.entries) return;
      let skipped = 0;
      for (const [key, value] of Object.entries(raw.entries)) {
        const contract = parseContract(value);
        if (!contract) { skipped += 1; continue; }
        this.store.set(key, contract);
      }
      this.logger?.info('模型参数契约已加载', { path: this.filePath, entries: this.store.size, skipped });
    } catch (error) {
      // 契约损坏不能让进程起不来：丢掉它，下次抓取时重建。
      this.logger?.warn('模型参数契约读取失败，已忽略', { path: this.filePath, error: String((error as Error)?.message || error) });
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.flushDelayMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const entries: Record<string, ModelParamContract> = {};
      for (const [key, value] of this.store) entries[key] = value;
      const temp = this.filePath + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 1), 'utf8');
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      this.logger?.warn('模型参数契约写入失败', { path: this.filePath, error: String((error as Error)?.message || error) });
    }
  }

  get(key: string): ModelParamContract | undefined {
    return this.store.get(key);
  }

  set(contract: ModelParamContract): void {
    this.store.set(contract.key, contract);
    this.schedule();
  }

  delete(key: string): boolean {
    const removed = this.store.delete(key);
    if (removed) this.schedule();
    return removed;
  }

  list(): ModelParamContract[] {
    return [...this.store.values()];
  }

  /** 按模型名找（面板「这个模型学到什么」用；同名多节点时返回全部）。 */
  findByModel(model: string): ModelParamContract[] {
    const target = String(model || '').trim().toLowerCase();
    return this.list().filter((contract) => contract.model.toLowerCase() === target);
  }
}