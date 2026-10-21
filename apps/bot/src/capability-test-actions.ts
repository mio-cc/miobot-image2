import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { CapabilityTestInput, CapabilityTestResult } from './orchestration-enforce.js';
import { loadJsonlActionCursor, readJsonlActionBatch, reconcileJsonlActionOffset, saveJsonlActionCursor } from './jsonl-action-cursor.js';

export interface CapabilityTestAction extends CapabilityTestInput {
  id: string;
  createdAt: string;
  actor?: string;
}

export interface CapabilityTestActionConsumerOptions {
  actionFile: string;
  resultFile: string;
  processedFile: string;
  intervalMs?: number;
  logger?: StructuredLogger;
  onAction: (action: CapabilityTestAction) => Promise<CapabilityTestResult>;
}

export class CapabilityTestActionConsumer {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly processed = new Set<string>();
  private readonly results = new Map<string, CapabilityTestResult & { id: string; createdAt: string; finishedAt: string }>();
  private offset = 0;

  constructor(private readonly options: CapabilityTestActionConsumerOptions) {}

  async start(): Promise<void> {
    await this.loadState();
    this.timer = setInterval(() => { void this.tick(); }, Math.max(500, this.options.intervalMs || 1000));
    this.timer.unref?.();
    await this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async loadState(): Promise<void> {
    const cursor = await loadJsonlActionCursor(this.options.processedFile);
    for (const id of cursor.ids) this.processed.add(id);
    this.offset = (await reconcileJsonlActionOffset(this.options.actionFile, cursor)).offset;
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.resultFile, 'utf8'));
      for (const result of Array.isArray(parsed?.results) ? parsed.results : []) {
        if (result?.id) this.results.set(String(result.id), result);
      }
    } catch { /* first run */ }
  }

  private async save(): Promise<void> {
    await saveJsonlActionCursor(this.options.processedFile, { offset: this.offset, ids: Array.from(this.processed) });
    const results = Array.from(this.results.values()).slice(-500);
    await fs.mkdir(path.dirname(this.options.resultFile), { recursive: true });
    const temp = this.options.resultFile + '.tmp';
    await fs.writeFile(temp, JSON.stringify({ results }, null, 2), 'utf8');
    await fs.rename(temp, this.options.resultFile);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const batch = await readJsonlActionBatch<CapabilityTestAction>(this.options.actionFile, this.offset);
      let changed = batch.reset || batch.nextOffset !== this.offset;
      for (const action of batch.actions) {
        if (!action?.id || !action?.capability || !action?.mode || this.processed.has(action.id)) continue;
        let result: CapabilityTestResult;
        try {
          result = await this.options.onAction(action);
        } catch (error) {
          result = {
            ok: false,
            capability: action.capability,
            mode: action.mode,
            stage: 'complete',
            durationMs: 0,
            handlerRegistered: false,
            error: String((error as Error)?.message || error),
          };
        }
        this.results.set(action.id, { ...result, id: action.id, createdAt: action.createdAt, finishedAt: new Date().toISOString() });
        this.processed.add(action.id);
        changed = true;
      }
      this.offset = batch.nextOffset;
      if (changed) await this.save();
    } finally {
      this.busy = false;
    }
  }
}