import type { NapcatSendResult } from '../../../packages/napcat/src/index.js';
import type { ReplyClient } from '../../../packages/reply/src/index.js';

export interface SentMessageEntry {
  id: number | string;
  at: number;
  kind: 'text' | 'image' | 'video' | 'file' | 'record' | 'forward' | 'unknown';
}

export interface SentMessageTracker {
  record(chatKey: string, ids: Array<number | string>, kind?: SentMessageEntry['kind']): void;
  take(chatKey: string, count: number): Array<number | string>;
  /** 撤回用：返回带时间戳与类型的条目（新→旧），供撤回窗口过滤与类型提示。 */
  takeDetailed(chatKey: string, count: number): SentMessageEntry[];
  restore(chatKey: string, ids: Array<number | string>): void;
  restoreEntries(chatKey: string, entries: SentMessageEntry[]): void;
  remove(chatKey: string, ids: Array<number | string>): void;
  clear(): void;
}

const MAX_MESSAGES_PER_CHAT = 100;

/** QQ 普通成员/群管理的撤回窗口约 2 分钟。 */
export const RECALL_WINDOW_MS = 2 * 60 * 1000;

/** 撤回前的条目分区：超窗跳过、合并转发跳过（QQ 协议不支持撤回转发），其余逐条尝试。 */
export function partitionRecallEntries(entries: SentMessageEntry[], now = Date.now()): {
  targets: SentMessageEntry[];
  forward: SentMessageEntry[];
  expired: number;
} {
  const recent = entries.filter((entry) => now - entry.at <= RECALL_WINDOW_MS);
  const forward = recent.filter((entry) => entry.kind === 'forward');
  const targets = recent.filter((entry) => entry.kind !== 'forward');
  return { targets, forward, expired: entries.length - recent.length };
}

export function sentChatKey(chatType: 'group' | 'private', groupId?: number | string, userId?: number | string): string {
  return chatType === 'group' ? `group:${String(groupId ?? '')}` : `private:${String(userId ?? '')}`;
}

function kindFromMethod(method: string): SentMessageEntry['kind'] {
  if (method.includes('Forward')) return 'forward';
  if (method.includes('Record')) return 'record';
  if (method.includes('Image')) return 'image';
  if (method.includes('Video')) return 'video';
  if (method.includes('File')) return 'file';
  if (method.startsWith('sendGroup') || method.startsWith('sendPrivate')) return 'text';
  return 'unknown';
}

export function createSentMessageTracker(): SentMessageTracker {
  const map = new Map<string, SentMessageEntry[]>();
  const normalize = (ids: Array<number | string | undefined>) => {
    const seen = new Set<string>();
    const out: Array<number | string> = [];
    for (const id of ids) {
      if (id === undefined || id === null || String(id).trim() === '') continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
    return out;
  };
  const append = (chatKey: string, entries: SentMessageEntry[]) => {
    if (!chatKey || !entries.length) return;
    const list = map.get(chatKey) || [];
    const seen = new Set(list.map((item) => String(item.id)));
    for (const entry of entries) {
      if (seen.has(String(entry.id))) continue;
      seen.add(String(entry.id));
      list.push(entry);
    }
    while (list.length > MAX_MESSAGES_PER_CHAT) list.shift();
    map.set(chatKey, list);
  };
  const idEntries = (ids: Array<number | string>, kind: SentMessageEntry['kind'], at: number): SentMessageEntry[] =>
    normalize(ids).map((id) => ({ id, at, kind }));
  return {
    record(chatKey, ids, kind) { append(chatKey, idEntries(ids, kind || 'text', Date.now())); },
    take(chatKey, count) {
      return this.takeDetailed(chatKey, count).map((entry) => entry.id);
    },
    takeDetailed(chatKey, count) {
      const list = map.get(chatKey) || [];
      const n = Math.max(0, Math.trunc(Number(count) || 0));
      const taken = list.splice(Math.max(0, list.length - n), n).reverse();
      if (!list.length) map.delete(chatKey);
      return taken;
    },
    restore(chatKey, ids) { append(chatKey, idEntries([...ids].reverse(), 'text', Date.now())); },
    restoreEntries(chatKey, entries) { append(chatKey, [...entries].reverse()); },
    remove(chatKey, ids) {
      const remove = new Set(normalize(ids).map(String));
      const list = (map.get(chatKey) || []).filter((entry) => !remove.has(String(entry.id)));
      if (list.length) map.set(chatKey, list); else map.delete(chatKey);
    },
    clear() { map.clear(); },
  };
}

function idsFromSendResult(result: NapcatSendResult | undefined): Array<number | string> {
  if (!result) return [];
  // uncertain（retcode 1200 等）的消息大概率已送达——同样登记，否则这类语音/图片无法撤回（线上实测）。
  if (result.success === false && result.uncertain !== true) return [];
  return [...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : [])]
    .filter((id): id is number | string => id !== undefined && id !== null && String(id).trim() !== '');
}

function chatKeyFromMethod(method: string, args: unknown[]): string {
  if (method.startsWith('sendGroup')) return `group:${String(args[0] ?? '')}`;
  if (method.startsWith('sendPrivate')) return `private:${String(args[0] ?? '')}`;
  return '';
}

/** 用 Proxy 包住 ReplyClient，所有发送出去的消息 ID 都记入当前聊天（含 uncertain）。 */
export function createTrackingReplyClient(client: ReplyClient, tracker: SentMessageTracker): ReplyClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args) as NapcatSendResult;
        const chatKey = chatKeyFromMethod(String(prop), args);
        tracker.record(chatKey, idsFromSendResult(result), kindFromMethod(String(prop)));
        return result;
      };
    },
  }) as ReplyClient;
}

export { kindFromMethod };
