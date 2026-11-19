/**
 * 运行期队列快照（2026-11-19）。
 *
 * 为什么需要：并发与排队状态原来散在五处内存里（turn 闸、会话链、异步工具队列、
 * 出站发送链、ComfyUI 队列），只有 comfyui 和 node-gate 有 snapshot()，
 * 面板一个都看不到。用户想判断「是不是卡在排队」只能靠猜。
 *
 * 做法沿用本仓库既有模式（node-latency.json / mcp-status.json）：
 * bot 进程按固定间隔把快照写到 data/runtime-queues.json，面板读文件。
 * 不引入 IPC，bot 挂了面板也不会报错（只是快照变旧）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { QueueGateSnapshot } from './queue-gate.js';

export interface RuntimeQueuesSnapshot {
  version: 1;
  updatedAt: string;
  agentTurns: QueueGateSnapshot[];
  toolQueues: QueueGateSnapshot[];
  outbound: QueueGateSnapshot[];
  /** 同一 session 有 turn 在跑或排队时，会话链里会留一条记录。 */
  agentSessions: { inFlight: number };
  toolJobs: { queued: number; running: number; total: number };
  comfyui: Array<{ key: string; running: number; queued: number; limit: number }>;
  suno?: { active: number; queued: number; maxConcurrent: number; maxQueue: number };
  nodes?: Array<{ nodeIndex: number; running: number; queued: number; limit: number }>;
  warnings?: string[];
}

export interface RuntimeQueuesSampler {
  agentTurns: () => QueueGateSnapshot[];
  toolQueues: () => QueueGateSnapshot[];
  outbound: () => QueueGateSnapshot[];
  agentSessions: () => number;
  toolJobs: () => { queued: number; running: number; total: number };
  comfyui?: () => Array<{ key: string; running: number; queued: number; limit: number }>;
  suno?: () => { active: number; queued: number; maxConcurrent: number; maxQueue: number } | undefined;
  nodes?: () => Array<{ nodeIndex: number; running: number; queued: number; limit: number }>;
}

/** 取一次快照（纯读取，不改任何状态）。 */
export function sampleRuntimeQueues(sampler: RuntimeQueuesSampler, now = new Date()): RuntimeQueuesSnapshot {
  const warnings: string[] = [];
  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try { return fn(); } catch (error) {
      warnings.push(label + ': ' + String((error as Error)?.message || error));
      return fallback;
    }
  };
  const snapshot: RuntimeQueuesSnapshot = {
    version: 1,
    updatedAt: now.toISOString(),
    agentTurns: safe(sampler.agentTurns, [], 'agentTurns'),
    toolQueues: safe(sampler.toolQueues, [], 'toolQueues'),
    outbound: safe(sampler.outbound, [], 'outbound'),
    agentSessions: { inFlight: safe(sampler.agentSessions, 0, 'agentSessions') },
    toolJobs: safe(sampler.toolJobs, { queued: 0, running: 0, total: 0 }, 'toolJobs'),
    comfyui: sampler.comfyui ? safe(sampler.comfyui, [], 'comfyui') : [],
    ...(sampler.suno ? (() => { const value = safe(sampler.suno!, undefined, 'suno'); return value ? { suno: value } : {}; })() : {}),
    ...(sampler.nodes ? { nodes: safe(sampler.nodes, [], 'nodes') } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  return snapshot;
}

/** 原子写：先写 .tmp 再 rename，面板永远读不到半截 JSON。 */
export function writeRuntimeQueuesSnapshot(filePath: string, snapshot: RuntimeQueuesSnapshot): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 1), 'utf8');
  fs.renameSync(temp, filePath);
}