// API 节点延迟检测：
//   被动——包装 ModelClient 的 chat/vision，按节点记录每次调用耗时/成败，防抖落盘 node-latency.json；
//   主动——面板「测延迟」按钮 → node-latency-actions.jsonl → 本文件消费者逐启用节点发 maxTokens=1
//          的 ping（默认 10s 超时）→ node-latency-results.json → 面板轮询展示。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { ModelClient, ModelNode } from '../../../packages/model/src/index.js';
import { loadJsonlActionCursor, readJsonlActionBatch, reconcileJsonlActionOffset, saveJsonlActionCursor } from './jsonl-action-cursor.js';

export interface NodeLatencyStat {
  nodeIndex: number;
  name?: string;
  model?: string;
  count: number;
  failCount: number;
  avgMs: number;
  lastMs: number;
  lastOkAt?: string;
  lastError?: string;
}

export interface NodeLatencySnapshot {
  updatedAt: string;
  nodes: Record<string, NodeLatencyStat>;
}

export interface NodeLatencyRecorderOptions {
  filePath: string;
  logger?: StructuredLogger;
}

export class NodeLatencyRecorder {
  private snapshot: NodeLatencySnapshot = { updatedAt: new Date().toISOString(), nodes: {} };
  private saveTimer?: ReturnType<typeof setTimeout>;
  private loaded = false;

  constructor(private readonly options: NodeLatencyRecorderOptions) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.filePath, 'utf8')) as NodeLatencySnapshot;
      if (parsed && typeof parsed === 'object' && parsed.nodes && typeof parsed.nodes === 'object') this.snapshot = parsed;
    } catch { /* first run */ }
  }

  record(nodeIndex: number, model: string, ms: number, ok: boolean, nodeName?: string, error?: string): void {
    const key = String(nodeIndex);
    const stat = this.snapshot.nodes[key] || { nodeIndex, count: 0, failCount: 0, avgMs: 0, lastMs: 0 };
    const total = stat.avgMs * stat.count + ms;
    stat.count += 1;
    if (!ok) stat.failCount += 1;
    stat.avgMs = Math.round(total / stat.count);
    stat.lastMs = Math.round(ms);
    stat.model = model || stat.model;
    if (nodeName) stat.name = nodeName;
    if (ok) stat.lastOkAt = new Date().toISOString();
    else stat.lastError = String(error || 'unknown').slice(0, 200);
    this.snapshot.nodes[key] = stat;
    this.snapshot.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
      const temp = this.options.filePath + '.tmp';
      await fs.writeFile(temp, JSON.stringify(this.snapshot, null, 2), 'utf8');
      await fs.rename(temp, this.options.filePath);
    } catch (error) {
      this.options.logger?.warn('节点延迟数据写入失败', { error: String((error as Error)?.message || error) });
    }
  }

  async apiSnapshot(): Promise<{ updatedAt: string; nodes: NodeLatencyStat[] }> {
    await this.ensureLoaded();
    return {
      updatedAt: this.snapshot.updatedAt,
      nodes: Object.values(this.snapshot.nodes).sort((a, b) => a.nodeIndex - b.nodeIndex),
    };
  }
}

/** 包装 ModelClient 的 chat/vision：每次真实调用按节点记录延迟/成败（不改 model 包）。 */
export function wrapClientWithLatency<T extends ModelClient>(client: T, recorder: NodeLatencyRecorder, nodeNameOf: (nodeIndex: number) => string | undefined): T {
  for (const method of ['chat', 'vision'] as const) {
    const original = (client as any)[method].bind(client);
    (client as any)[method] = async (nodeIndex: number, req: any) => {
      const startedAt = Date.now();
      try {
        const result = await original(nodeIndex, req);
        recorder.record(Number(nodeIndex), String(req?.model || ''), Date.now() - startedAt, true, nodeNameOf(Number(nodeIndex)));
        return result;
      } catch (error) {
        recorder.record(Number(nodeIndex), String(req?.model || ''), Date.now() - startedAt, false, nodeNameOf(Number(nodeIndex)), String((error as Error)?.message || error));
        throw error;
      }
    };
  }
  return client;
}

export interface NodeLatencyProbeItem {
  nodeIndex: number;
  name: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** 主动探测：对每个启用的 LLM 节点发一次 maxTokens=1 的最小请求并计时（并发执行）。 */
export async function probeAllNodes(client: ModelClient, nodes: ModelNode[], timeoutMs = 10000): Promise<NodeLatencyProbeItem[]> {
  const tasks = nodes.map(async (node, nodeIndex): Promise<NodeLatencyProbeItem> => {
    const model = String(node.models?.[0] || 'gpt-4o-mini');
    const name = node.name || `节点 ${nodeIndex + 1}`;
    const startedAt = Date.now();
    if (node.enabled === false || !String(node.baseUrl || '').trim()) {
      return { nodeIndex, name, model, ok: false, latencyMs: 0, error: node.enabled === false ? 'node_disabled' : 'base_url_missing' };
    }
    try {
      await client.chat(nodeIndex, {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        temperature: 0,
        timeoutMs,
      });
      return { nodeIndex, name, model, ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { nodeIndex, name, model, ok: false, latencyMs: Date.now() - startedAt, error: String((error as Error)?.message || error).slice(0, 200) };
    }
  });
  return Promise.all(tasks);
}

export interface NodeLatencyAction {
  id: string;
  createdAt: string;
  actor?: string;
}

export interface NodeLatencyTestResult {
  id: string;
  createdAt: string;
  finishedAt: string;
  results: NodeLatencyProbeItem[];
  durationMs: number;
  error?: string;
}

export interface NodeLatencyActionConsumerOptions {
  actionFile: string;
  resultFile: string;
  processedFile: string;
  intervalMs?: number;
  logger?: StructuredLogger;
  onAction: (action: NodeLatencyAction) => Promise<Omit<NodeLatencyTestResult, 'id' | 'createdAt' | 'finishedAt'>>;
}

export class NodeLatencyActionConsumer {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly processed = new Set<string>();
  private readonly results = new Map<string, NodeLatencyTestResult>();
  private offset = 0;

  constructor(private readonly options: NodeLatencyActionConsumerOptions) {}

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
    const results = Array.from(this.results.values()).slice(-100);
    await fs.mkdir(path.dirname(this.options.resultFile), { recursive: true });
    const temp = this.options.resultFile + '.tmp';
    await fs.writeFile(temp, JSON.stringify({ results }, null, 2), 'utf8');
    await fs.rename(temp, this.options.resultFile);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const batch = await readJsonlActionBatch<NodeLatencyAction>(this.options.actionFile, this.offset);
      let changed = batch.reset || batch.nextOffset !== this.offset;
      for (const action of batch.actions) {
        if (!action?.id || this.processed.has(action.id)) continue;
        let body: Omit<NodeLatencyTestResult, 'id' | 'createdAt' | 'finishedAt'>;
        const startedAt = Date.now();
        try {
          body = await this.options.onAction(action);
        } catch (error) {
          body = { results: [], durationMs: Date.now() - startedAt, error: String((error as Error)?.message || error) };
        }
        this.results.set(action.id, { ...body, id: action.id, createdAt: action.createdAt, finishedAt: new Date().toISOString() });
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
