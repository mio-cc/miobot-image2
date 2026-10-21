import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { loadJsonlActionCursor, readJsonlActionBatch, reconcileJsonlActionOffset, saveJsonlActionCursor } from './jsonl-action-cursor.js';

export interface ApprovalAction {
  id: string;
  code: string;
  decision: 'approve' | 'reject' | 'cancel';
  actor?: string;
  createdAt: string;
}

export interface ApprovalActionConsumerOptions {
  actionFile: string;
  processedFile: string;
  intervalMs?: number;
  logger?: StructuredLogger;
  onAction: (action: ApprovalAction) => Promise<void>;
}

export class ApprovalActionConsumer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly processed = new Set<string>();
  private offset = 0;

  constructor(private readonly options: ApprovalActionConsumerOptions) {}

  async start(): Promise<void> {
    await this.loadProcessed();
    const interval = Math.max(500, this.options.intervalMs || 2000);
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.timer.unref?.();
    await this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async loadProcessed(): Promise<void> {
    const loaded = await loadJsonlActionCursor(this.options.processedFile);
    for (const id of loaded.ids) this.processed.add(id);
    const reconciled = await reconcileJsonlActionOffset(this.options.actionFile, loaded);
    this.offset = reconciled.offset;
  }

  private async saveProcessed(): Promise<void> {
    await saveJsonlActionCursor(this.options.processedFile, { offset: this.offset, ids: Array.from(this.processed) });
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const batch = await readJsonlActionBatch<ApprovalAction>(this.options.actionFile, this.offset);
      let changed = batch.reset || batch.nextOffset !== this.offset;
      for (const action of batch.actions) {
        if (!action?.id || !action?.code || !action?.decision) continue;
        if (this.processed.has(action.id)) continue;
        try {
          await this.options.onAction(action);
        } catch (error) {
          this.options.logger?.warn('审批面板操作失败', { id: action.id, code: action.code, error: String((error as Error)?.message || error) });
        }
        this.processed.add(action.id);
        changed = true;
      }
      this.offset = batch.nextOffset;
      if (changed) await this.saveProcessed();
    } finally {
      this.busy = false;
    }
  }
}
