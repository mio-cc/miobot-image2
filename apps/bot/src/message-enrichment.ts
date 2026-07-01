import { formatHistoryMessageText, senderName, type NapcatHistoryMessage } from './group-context.js';

/**
 * 消息内容富化:把 get_msg(引用消息) / get_forward_msg(合并转发) 拉到的外部内容,
 * 拼回进当前消息喂给模型。解决两类内容丢失:
 * 1. 回复一张图片时,reply 段只带 id,图片在引用消息里 → 需要 get_msg 取回图片。
 * 2. 发送/引用合并转发时,[CQ:forward] 会被剥离 → 需要 get_forward_msg 展开文本。
 *
 * 本模块为纯函数,不直接访问 napcat;拉取由 runtime 注入的 hook 完成,便于单测。
 */

/** 任意带 message/raw_message 字段的消息(兼容 NapcatMessageEvent 与 NapcatHistoryMessage)。 */
type AnyMessage = { message?: Array<{ type: string; data: Record<string, any> }> | string; raw_message?: string };

const FORWARD_ID_KEYS = ['id', 'file', 'resid', 'res_id', 'forward_id', 'forwardId'];

/** 从消息段 + CQ 码 + json 卡片里提取合并转发 id。 */
export function extractForwardIds(message: AnyMessage | string | undefined | null): string[] {
  const ids: string[] = [];
  const segs = message && typeof message === 'object' && Array.isArray(message.message) ? message.message : undefined;
  if (segs) {
    for (const seg of segs) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'forward') {
        const d = seg.data || {};
        for (const k of FORWARD_ID_KEYS) if (d[k] !== undefined && d[k] !== null) ids.push(String(d[k]));
      } else if (seg.type === 'json') {
        // json 卡片(如"聊天记录")里常嵌套 forward res_id,深扫一次。
        collectForwardIdsUnknown(seg.data?.data ?? seg.data?.content ?? seg.data?.text, ids, 0);
      }
    }
  }
  const raw = typeof message === 'string' ? message : (message && typeof message.raw_message === 'string' ? message.raw_message : '');
  for (const m of String(raw).matchAll(/\[CQ:forward,[^\]]*(?:id|file|resid|res_id|forward_id)=([^,\]]+)/gi)) {
    if (m[1]) ids.push(safeDecode(m[1]));
  }
  return dedupeStrings(ids);
}

/** 递归扫描任意结构里的 forward id(CQ 码 / forward 段 / json 嵌套)。 */
function collectForwardIdsUnknown(value: unknown, ids: string[], depth: number): void {
  if (value === undefined || value === null || depth > 6) return;
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\[CQ:forward,[^\]]*(?:id|file|resid|res_id|forward_id)=([^,\]]+)/gi)) {
      if (m[1]) ids.push(safeDecode(m[1]));
    }
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try { collectForwardIdsUnknown(JSON.parse(trimmed), ids, depth + 1); } catch { /* 非 JSON,忽略 */ }
    }
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectForwardIdsUnknown(v, ids, depth + 1); return; }
  if (typeof value !== 'object') return;
  const obj = value as Record<string, any>;
  const type = String(obj.type || '').toLowerCase();
  if (type === 'forward') {
    const d = obj.data && typeof obj.data === 'object' ? obj.data : obj;
    for (const k of FORWARD_ID_KEYS) if (d[k] !== undefined && d[k] !== null) ids.push(String(d[k]));
  }
  // 任意层级出现的 forward_id / resid 等键(非对象值)也认作转发 id(兼容 json 卡片解析后的扁平结构)。
  for (const k of FORWARD_ID_KEYS) {
    const v = obj[k];
    if (v !== undefined && v !== null && typeof v !== 'object') ids.push(String(v));
  }
  for (const key of ['message', 'content', 'messages', 'nodes', 'data', 'forward', 'meta', 'extra']) {
    if (obj[key] !== undefined) collectForwardIdsUnknown(obj[key], ids, depth + 1);
  }
}

/** 把 get_forward_msg 的返回归一化为 NapcatHistoryMessage[](content→message,sender→sender),复用群上下文格式化器。 */
export function normalizeForwardPayload(payload: unknown): NapcatHistoryMessage[] {
  if (!payload) return [];
  const root = payload as any;
  const arr = root.messages ?? root.data?.messages ?? root.forward?.messages;
  const items = Array.isArray(arr) ? arr : Array.isArray(root) ? root : [];
  const out: NapcatHistoryMessage[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    out.push(normalizeForwardNode(item));
  }
  // 部分实现把转发节点裹在 message/content 里的 {type:'node', data:{content}} 段中,一并展开。
  const body = root.message ?? root.content ?? root.data?.message ?? root.data?.content;
  if (Array.isArray(body)) {
    for (const seg of body) {
      if (seg && typeof seg === 'object' && seg.type === 'node') out.push(normalizeForwardNode(seg.data ?? {}));
    }
  }
  return out;
}

function normalizeForwardNode(item: any): NapcatHistoryMessage {
  const content = item.content ?? item.message ?? item.data?.content ?? item.data?.message;
  return {
    message_id: item.message_id ?? item.id,
    user_id: item.user_id ?? item.sender?.user_id ?? item.data?.user_id,
    self_id: item.self_id,
    time: item.time,
    sender: item.sender ?? { user_id: item.user_id, nickname: item.nickname },
    message: Array.isArray(content) ? content : (typeof content === 'string' ? content : undefined),
    raw_message: item.raw_message ?? item.data?.raw_message,
  };
}

/** 把转发节点数组格式化为紧凑文本(图片占位,真实图片走 images 数组喂 vision)。 */
export function formatForwardMessages(nodes: NapcatHistoryMessage[], options: { maxChars?: number; messageCount?: number } = {}): string {
  const maxCount = options.messageCount ?? 80;
  const maxChars = options.maxChars ?? 4000;
  const lines: string[] = [];
  for (const node of nodes.slice(0, maxCount)) {
    const name = senderName(node) || '用户';
    const text = formatHistoryMessageText(node, { includeImages: false });
    if (text) lines.push(`${name}: ${text}`);
  }
  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = `${result.slice(0, Math.max(0, maxChars - 32)).trim()}\n……（转发内容过长，已截断）`;
  }
  return result;
}

/** 从一条消息(引用消息)提取文本(图片/视频等占位),作为引用上下文。 */
export function extractReferenceText(message: AnyMessage): string {
  return formatHistoryMessageText(message as unknown as NapcatHistoryMessage, { includeImages: false });
}

/** 被引用的消息是否来自 bot(用于"回复 bot"触发判定)。 */
export function isReferencedFromBot(message: { user_id?: number | string; sender?: { user_id?: number | string } }, selfId: string | number | undefined): boolean {
  if (!selfId) return false;
  const sender = message.user_id ?? message.sender?.user_id;
  return sender !== undefined && String(sender) === String(selfId);
}

/** 把用户文本 + 引用内容 + 转发内容合成最终送模型的文本。 */
export function composeEnrichedText(userText: string, referenceText: string, forwardText: string): string {
  const body = String(userText || '').trim();
  const parts: string[] = [];
  if (body) parts.push(body);
  if (referenceText) parts.push(`【引用内容】\n${referenceText}`);
  if (forwardText) parts.push(`【合并转发内容】\n${forwardText}`);
  if (!parts.length) return '请根据引用/转发内容处理。';
  return parts.join('\n\n');
}

function safeDecode(value: string): string {
  const v = String(value || '').trim();
  try { return decodeURIComponent(v); } catch { return v; }
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = String(v || '').trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}
