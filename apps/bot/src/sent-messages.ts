import type { NapcatSendResult } from '../../../packages/napcat/src/index.js';
import type { ReplyClient } from '../../../packages/reply/src/index.js';

export interface SentMessageTracker {
  record(chatKey: string, ids: Array<number | string>): void;
  take(chatKey: string, count: number): Array<number | string>;
  restore(chatKey: string, ids: Array<number | string>): void;
  remove(chatKey: string, ids: Array<number | string>): void;
  clear(): void;
}

const MAX_MESSAGES_PER_CHAT = 100;

export function sentChatKey(chatType: 'group' | 'private', groupId?: number | string, userId?: number | string): string {
  return chatType === 'group' ? `group:${String(groupId ?? '')}` : `private:${String(userId ?? '')}`;
}

export function createSentMessageTracker(): SentMessageTracker {
  const map = new Map<string, Array<number | string>>();
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
  const append = (chatKey: string, ids: Array<number | string>) => {
    if (!chatKey || !ids.length) return;
    const list = map.get(chatKey) || [];
    for (const id of normalize(ids)) list.push(id);
    while (list.length > MAX_MESSAGES_PER_CHAT) list.shift();
    map.set(chatKey, list);
  };
  return {
    record(chatKey, ids) { append(chatKey, ids); },
    take(chatKey, count) {
      const list = map.get(chatKey) || [];
      const n = Math.max(0, Math.trunc(Number(count) || 0));
      const taken = list.splice(Math.max(0, list.length - n), n).reverse();
      if (!list.length) map.delete(chatKey);
      return taken;
    },
    restore(chatKey, ids) { append(chatKey, [...ids].reverse()); },
    remove(chatKey, ids) {
      const remove = new Set(normalize(ids).map(String));
      const list = (map.get(chatKey) || []).filter((id) => !remove.has(String(id)));
      if (list.length) map.set(chatKey, list); else map.delete(chatKey);
    },
    clear() { map.clear(); },
  };
}

function idsFromSendResult(result: NapcatSendResult | undefined): Array<number | string> {
  if (!result || result.success === false) return [];
  return [...(result.messageIds || []), ...(result.messageId !== undefined ? [result.messageId] : [])]
    .filter((id): id is number | string => id !== undefined && id !== null && String(id).trim() !== '');
}

function chatKeyFromMethod(method: string, args: unknown[]): string {
  if (method.startsWith('sendGroup')) return `group:${String(args[0] ?? '')}`;
  if (method.startsWith('sendPrivate')) return `private:${String(args[0] ?? '')}`;
  return '';
}

/** 用 Proxy 包住 ReplyClient，所有成功发送出去的消息 ID 都记入当前聊天。 */
export function createTrackingReplyClient(client: ReplyClient, tracker: SentMessageTracker): ReplyClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args) as NapcatSendResult;
        const chatKey = chatKeyFromMethod(String(prop), args);
        tracker.record(chatKey, idsFromSendResult(result));
        return result;
      };
    },
  }) as ReplyClient;
}
