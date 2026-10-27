const INLINE_IMAGE = /!\[([^\]]*)\]\(\s*data:image\/[^)]+\)/gi;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const BASE64_URI = /base64:\/\/[a-z0-9+/=]+/gi;

/**
 * 图片的 data URL 只应作为 image 产物传递，不能进入模型可见文本或用户可见正文。
 * 工具结果回填和 ReplyPlan 文本都必须在边界处清洗，避免模型复述整段 base64。
 */
export function stripInlineImagePayloads(value: string): string {
  return String(value || '')
    .replace(INLINE_IMAGE, '![$1](图片)')
    .replace(DATA_IMAGE, '[图片数据已省略]')
    .replace(BASE64_URI, '[图片数据已省略]')
    .trim();
}

/** 对结构化工具结果做递归清洗；对象/数组保留原形状。 */
export function sanitizeStructuredPayload(value: unknown): unknown {
  if (typeof value === 'string') return stripInlineImagePayloads(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeStructuredPayload(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeStructuredPayload(item)]));
  }
  return value;
}
