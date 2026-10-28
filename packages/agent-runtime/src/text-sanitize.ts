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
const SECRET_KEY_PATTERN = /^(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|token|password|authorization|auth[-_]?header|bearer[-_]?token|cookie|key)$/i;
const SECRET_KEY_PART_PATTERN = /(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|authorization|private[-_]?key|signature)/i;

/** R15/#10：工具结果回填模型前的秘钥脱敏——QQ 公开群特有风险（GUI harness 单用户无此面）。 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const normalizedKey = String(key).replace(/[^a-z]/gi, '');
      const isSecretKey = SECRET_KEY_PATTERN.test(key) || (SECRET_KEY_PART_PATTERN.test(normalizedKey) && /key|token|secret|password|auth/i.test(normalizedKey));
      if (isSecretKey && (typeof item === 'string' || typeof item === 'number')) {
        const text = String(item);
        return [key, text ? '[已脱敏]' : item];
      }
      return [key, redactSecrets(item)];
    }));
  }
  return value;
}

/** 对结构化工具结果做递归清洗（图片内联 payload 剥除 + 秘钥脱敏）；对象/数组保留原形状。 */
/**
 * R18（E2E 测验抓到的真缺口）：工具 handler 常把 JSON stringify 后放进 content 字符串
 *（file.read/config 类），R15 的对象形态脱敏盖不住字符串内嵌 JSON——秘钥全裸。
 * 这里对字符串做 JSON 秘钥模式脱敏："apiKey":"sk-..." → "apiKey":"[已脱敏]"。
 */
const SECRET_JSON_PATTERN = /("(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|token|password|authorization|auth[-_]?header|bearer[-_]?token|cookie|key)"\s*:\s*)(?:"([^"\\]|\\.)*"|'([^'\\]|\\.)*')/gi;

function redactSecretsInText(value: string): string {
  return String(value || '').replace(SECRET_JSON_PATTERN, (_match, prefix) => `${prefix}"[已脱敏]"`);
}

export function sanitizeStructuredPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsInText(stripInlineImagePayloads(value));
  if (Array.isArray(value)) return value.map((item) => sanitizeStructuredPayload(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const normalizedKey = String(key).replace(/[^a-z]/gi, '');
      const isSecretKey = SECRET_KEY_PATTERN.test(key) || (SECRET_KEY_PART_PATTERN.test(normalizedKey) && /key|token|secret|password|auth/i.test(normalizedKey));
      if (isSecretKey && (typeof item === 'string' || typeof item === 'number')) {
        return [key, String(item) ? '[已脱敏]' : item];
      }
      return [key, sanitizeStructuredPayload(item)];
    }));
  }
  return value;
}
