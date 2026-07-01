/**
 * 群聊上下文注入：@bot 时拉取最近群聊记录作为上下文喂给 chat 模型。
 *
 * 流程：napcat get_group_msg_history → 过滤合并转发 → 过滤 bot 自身 & 触发消息
 *      → 文字+图片URL(视频/文件/语音占位) → 裁剪 → 格式化为紧凑对话记录。
 *
 * 设计要点：
 * - 合并转发(forward)消息整条跳过，避免内容撑爆请求。
 * - 非文字内容按用户要求：文字保留、图片URL保留(若chat支持vision可见)、视频/文件/语音用占位符。
 * - 拉取失败/超时不阻塞回复，返回空字符串让 bot 无上下文继续回复。
 */

/** napcat get_group_msg_history 返回的单条消息（napcat 原始结构）。 */
export interface NapcatHistoryMessage {
  message_id?: number | string;
  user_id?: number | string;
  self_id?: number | string;
  time?: number;
  sender?: { user_id?: number | string; nickname?: string; card?: string };
  message?: Array<{ type: string; data: Record<string, any> }> | string;
  raw_message?: string;
}

export interface GroupContextOptions {
  /** 拉取条数（向前取）。 */
  messageCount: number;
  /** 跳过合并转发消息。 */
  skipForward: boolean;
  /** 上下文包含图片 URL（若 chat 模型支持 vision 可见）。 */
  includeImages: boolean;
  /** 上下文格式化后的最大字符数，超出从最旧截断。 */
  maxChars: number;
}

/** 检测一条消息是否为合并转发（segment 含 forward 或 CQ 含 [CQ:forward）。 */
export function isForwardMessage(msg: NapcatHistoryMessage): boolean {
  if (Array.isArray(msg.message) && msg.message.some((s) => s?.type === 'forward')) return true;
  const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
  return /\[CQ:forward[,\]]/i.test(raw);
}

/**
 * 把一条 napcat 历史消息格式化为紧凑文本。
 * - text 段：拼接文字
 * - image 段：includeImages 时保留 URL，否则 [图片]
 * - video/file/record/voice：占位符
 * - 其他非文字段：忽略
 */
export function formatHistoryMessageText(
  msg: NapcatHistoryMessage,
  options: Pick<GroupContextOptions, 'includeImages'>,
): string {
  const parts: string[] = [];
  const segments = Array.isArray(msg.message) ? msg.message : undefined;
  if (segments) {
    for (const seg of segments) {
      if (!seg || !seg.type) continue;
      const data = seg.data || {};
      switch (seg.type) {
        case 'text':
          if (typeof data.text === 'string' && data.text.trim()) parts.push(data.text.trim());
          break;
        case 'image':
          if (options.includeImages && data.url) parts.push(`[图片:${data.url}]`);
          else parts.push('[图片]');
          break;
        case 'video':
          parts.push('[视频]');
          break;
        case 'file':
          parts.push(`[文件:${data.file || data.name || ''}]`);
          break;
        case 'record':
        case 'voice':
          parts.push('[语音]');
          break;
        case 'at':
          // @某人 用昵称或 QQ 简注，不展开
          parts.push(`[@${data.qq || ''}]`);
          break;
        case 'reply':
          // 引用回复不展开内容，仅标注
          break;
        case 'face':
        case 'mface':
        case 'marketface':
          parts.push('[表情]');
          break;
        default:
          break;
      }
    }
  } else if (typeof msg.raw_message === 'string' && msg.raw_message.trim()) {
    // 退化：只有 CQ 字符串时，去掉非文字 CQ 段后的纯文本
    parts.push(stripNonTextCq(msg.raw_message).trim());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** 从 CQ 字符串中剥离非文字段，保留纯文本（退化路径用）。 */
function stripNonTextCq(raw: string): string {
  return String(raw || '')
    .replace(/\[CQ:(?:reply|at|image|file|record|video|forward|json|xml|face|mface|marketface|dice|rps|poke|music|share|location),[^\]]*\]/gi, ' ')
    .replace(/\[CQ:(?:reply|at|image|file|record|video|forward|json|xml|face|mface|marketface|dice|rps|poke|music|share|location)\]/gi, ' ')
    .trim();
}

/** 取发送者显示名：群名片优先，其次昵称，最后"用户"。 */
export function senderName(msg: NapcatHistoryMessage): string {
  const card = msg.sender?.card?.trim();
  if (card) return card;
  const nick = msg.sender?.nickname?.trim();
  if (nick) return nick;
  return '用户';
}

export interface BuildGroupContextParams {
  messages: NapcatHistoryMessage[];
  anchorMessageId?: number | string;
  selfId?: number | string;
  options: GroupContextOptions;
}

/**
 * 把 napcat 历史消息数组处理为最终上下文字符串。
 * 纯函数，可独立测试：过滤转发 → 过滤 bot 自身 & 触发消息 → 格式化 → 裁剪。
 */
export function buildGroupContext(params: BuildGroupContextParams): string {
  const { messages, anchorMessageId, selfId, options } = params;
  const selfIdStr = selfId !== undefined ? String(selfId) : '';
  const anchorStr = anchorMessageId !== undefined ? String(anchorMessageId) : '';

  const lines: string[] = [];
  // 倒序处理（最新在前），格式化后正序输出
  for (let i = messages.length - 1; i >= 0 && lines.length < options.messageCount; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (options.skipForward && isForwardMessage(msg)) continue;
    if (selfIdStr && String(msg.user_id ?? '') === selfIdStr) continue; // bot 自己发的
    if (anchorStr && String(msg.message_id ?? '') === anchorStr) continue; // 触发的那条
    const text = formatHistoryMessageText(msg, options);
    if (!text) continue; // 空消息跳过
    lines.push(`${senderName(msg)}: ${text}`);
  }

  if (!lines.length) return '';
  // 反转为时间正序（旧→新）
  lines.reverse();

  // 裁剪：从最旧截断，保证不超 maxChars
  let result = lines.join('\n');
  if (result.length > options.maxChars) {
    // 保留最新的部分
    result = result.slice(result.length - options.maxChars);
    // 截断后从第一个换行开始，避免半行
    const firstNl = result.indexOf('\n');
    if (firstNl > 0) result = result.slice(firstNl + 1);
  }
  return result;
}

/**
 * 拉取群历史并构建上下文。fetchHistory 由调用方注入（封装 napcat callAction）。
 * 失败/超时返回空字符串，不抛错。
 */
export async function fetchGroupContext(params: {
  fetchHistory: (groupId: number | string, anchorMessageId: number | string, count: number) => Promise<NapcatHistoryMessage[]>;
  groupId: number | string;
  anchorMessageId: number | string;
  selfId?: number | string;
  options: GroupContextOptions;
}): Promise<string> {
  const { fetchHistory, groupId, anchorMessageId, selfId, options } = params;
  try {
    // 多取一些以补偿过滤转发后的损失
    const fetchCount = options.messageCount + 8;
    const messages = await fetchHistory(groupId, anchorMessageId, fetchCount);
    if (!Array.isArray(messages) || !messages.length) return '';
    return buildGroupContext({ messages, anchorMessageId, selfId, options });
  } catch {
    // 拉取失败不阻塞回复
    return '';
  }
}
