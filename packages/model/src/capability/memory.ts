/**
 * 能力记忆：把「这个模型能干什么」变成运行时学习到的状态，而不是代码里的名字表。
 *
 * 背景（2026-11-16）：能力档案原来只有「内置正则 + 用户覆盖」两级，认不出的模型一律
 * 兜底成「只会 chat」，于是 ModelClient 在本地直接拒掉——用户把网关自带的新模型填进
 * 生图位，请求根本没发出去，日志里也看不到任何上游错误。加一个模型就得改一次代码，
 * 这与「模型是主脑、harness 只提供事实」的设计相悖。
 *
 * 这里的做法与 params.ts 的参数自愈同源：不猜，先问环境，然后把结论记下来。
 *   - 成功调用 → 记「支持该操作」
 *   - 上游明确说这个模型不支持 → 记「不支持」，以后不再对着它重试
 *   - 大脑判定（model.capability.classify）→ 记「判定结论」
 *
 * key 用 dialect|baseUrl::model 而不是节点下标：换服务商自然失效，不会张冠李戴。
 */

import type { ModelOperation } from '../ports.js';

export const ALL_OPERATIONS: ModelOperation[] = ['chat', 'vision', 'interrogate', 'image.generate', 'image.edit', 'video.generate'];

/** 结论从哪来——决定面板上怎么展示、以及谁可以覆盖谁。 */
export type CapabilitySource = 'user-override' | 'learned-call' | 'learned-rejected' | 'learned-llm' | 'builtin-hint' | 'unknown';

export interface LearnedCapability {
  /** 该模型被证实/判定支持的操作集合（空数组 = 已知全都不是）。 */
  operations: ModelOperation[];
  source: Exclude<CapabilitySource, 'user-override' | 'builtin-hint' | 'unknown'>;
  /** 判定依据，用于排障与面板展示（上游错误摘要 / 判定理由）。 */
  evidence?: string;
  updatedAt: string;
}

export interface CapabilityMemory {
  get(key: string): LearnedCapability | undefined;
  /** 整条写入（覆盖语义）。 */
  set(key: string, value: LearnedCapability): void;
  delete(key: string): void;
  list(): Array<{ key: string } & LearnedCapability>;
}

export function createInMemoryCapabilityMemory(initial?: Record<string, LearnedCapability>): CapabilityMemory {
  const store = new Map<string, LearnedCapability>();
  for (const [key, value] of Object.entries(initial || {})) store.set(key, { ...value, operations: [...value.operations] });
  return {
    get: (key) => store.get(key),
    set: (key, value) => { store.set(key, { ...value, operations: [...value.operations] }); },
    delete: (key) => { store.delete(key); },
    list: () => [...store.entries()].map(([key, value]) => ({ key, ...value, operations: [...value.operations] })),
  };
}

/** 能唯一标识一个上游的最小信息（与 healing.ts 的 healingKey 同构）。 */
export interface CapabilityNodeRef {
  baseUrl?: string;
  dialect?: string;
}

export function capabilityKey(node: CapabilityNodeRef | undefined, model: string): string {
  const base = String(node?.baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  return `${node?.dialect || 'openai'}|${base}::${String(model || '').trim()}`;
}

/** 合并操作集合并去重（成功调用只带来「追加」，不会抹掉已知能力）。 */
export function mergeOperations(base: readonly ModelOperation[], add: readonly ModelOperation[]): ModelOperation[] {
  const out = new Set<ModelOperation>();
  for (const op of base) if (ALL_OPERATIONS.includes(op)) out.add(op);
  for (const op of add) if (ALL_OPERATIONS.includes(op)) out.add(op);
  return ALL_OPERATIONS.filter((op) => out.has(op));
}

export function revokeOperation(base: readonly ModelOperation[], remove: ModelOperation): ModelOperation[] {
  return base.filter((op) => op !== remove);
}

/**
 * 上游是否在说「这个模型不支持这个操作」。
 *
 * 只认明确的能力类拒绝，绝不把 429/5xx/网络故障当能力结论——否则一次上游抖动就会
 * 把可用模型永久判死（这正是参数自愈里刻意避开的坑）。
 */
export function diagnoseCapabilityRejection(status: number, payload: unknown): { rejected: true; evidence: string } | undefined {
  const code = Number(status);
  if (![400, 404, 405, 415, 422, 501].includes(code)) return undefined;
  const text = extractText(payload);
  if (!text) return undefined;
  // 有明确的能力/端点措辞才算。
  // 「Invalid URL」是中转网关对「这条路由不存在」的标准回话（2026-11-16 实测
  // api.howtofix.id：/videos/generations → 404 Invalid URL (POST /v1/videos/generations)）。
  // 路由缺失是稳定事实，学下来可以省掉每次重试。
  // 注意 403 Access denied（permission_error）刻意**不学**：那是套餐/权限问题，
  // 换 key 或升级后同样请求就能通，把它记成「模型不支持」会长期误伤。
  if (!/(does not support|not support|unsupported|not capable|invalid model|model not found|unknown model|no such model|not available|invalid url|不支持|不可用|无此模型|模型不存在)/i.test(text)) {
    return undefined;
  }
  return { rejected: true, evidence: text.slice(0, 300) };
}

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}