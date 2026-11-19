/**
 * XHR 记录与证据包（2026-11-19）。
 *
 * 为什么需要：抓取的瓶颈不是"会不会发请求"，而是"不知道站点真实接口长什么样"。
 * SSR 站点还能靠静态 HTML 推断，SPA/接口型站点必须看到真实的 XHR 才能生成可复现配方。
 *
 * 安全边界（硬性，改动前先读这段）：
 *   · 永不记录任何 request/response header（Authorization / Cookie 一律不碰）
 *   · 默认只记同源；跨域需显式关闭，且仍然脱敏
 *   · responseShape 只保留"结构骨架"（类型 + 数组长度），不含任何真实值
 *   · sample 默认关闭；开启时按 maxBodyBytes 截断并做敏感串脱敏
 *   · 过滤 document/script/stylesheet/image/font/media，只留 xhr/fetch
 */

export interface NetworkEventInput {
  url: string;
  method?: string;
  resourceType?: string;
  status?: number;
  contentType?: string;
  size?: number;
  timingMs?: number;
  bodyText?: string;
}

export interface NetworkShapeNode {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown';
  /** 数组长度（只记长度，不记内容）。 */
  length?: number;
  /** 对象的键（只记键名，不记值）。 */
  keys?: string[];
}

export interface NetworkEvent {
  method: string;
  url: string;
  /** 把数字 / uuid / 日期路径段与 query 值抽象成 {param}，用于配方复用。 */
  urlTemplate: string;
  status?: number;
  contentType?: string;
  size?: number;
  timingMs?: number;
  /** 只含结构骨架。 */
  shape?: NetworkShapeNode;
  /** 仅 includeResponseBody=true 时存在，已截断并脱敏。 */
  sample?: string;
}

export interface RecordNetworkOptions {
  maxEvents?: number;
  includeResponseBody?: boolean;
  maxBodyBytes?: number;
  sameOriginOnly?: boolean;
}

export const DEFAULT_RECORD_NETWORK_OPTIONS: Required<RecordNetworkOptions> = {
  maxEvents: 200,
  includeResponseBody: false,
  maxBodyBytes: 32768,
  sameOriginOnly: true,
};

/** 只记这两类；document/script/stylesheet/image/font/media 一律跳过。 */
export function shouldRecordResource(resourceType: string): boolean {
  return /^(xhr|fetch)$/i.test(String(resourceType || ''));
}

/**
 * 把 URL 抽象成可复用模板。
 *
 * 规则：
 *   · path 段是纯数字 / uuid / 日期(2026-11-19) / 长 hex → {param}
 *   · query 的值一律换成 {key}，保留 key 顺序
 *   · 末尾斜杠、hash 去掉
 * 同一个 host 下不同 id 的两次请求会得到同一个模板——这是配方能复用的前提。
 */
export function urlTemplateOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return String(url || '');
  }
  const segments = parsed.pathname.split('/').map((segment) => {
    if (!segment) return segment;
    if (/^\d+$/.test(segment)) return '{param}';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return '{param}';
    if (/^\d{4}-\d{2}-\d{2}([T_].*)?$/.test(segment)) return '{param}';
    if (/^[0-9a-f]{16,}$/i.test(segment)) return '{param}';
    // 常见「英文前缀 + 数字」的 id（book12345 / rank_2026）
    if (/^[a-z_-]+\d{3,}$/i.test(segment)) return '{param}';
    return segment;
  });
  const pathname = segments.join('/');
  const keys = Array.from(parsed.searchParams.keys());
  const query = keys.map((key) => key + '={' + key + '}').join('&');
  return parsed.origin + pathname + (query ? '?' + query : '');
}

/** 只保留结构骨架：类型 + 数组长度 + 对象键名，绝不带值。 */
export function responseShapeOf(value: unknown, depth = 0): NetworkShapeNode {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return { type: type as NetworkShapeNode['type'] };
  if (type !== 'object') return { type: 'unknown' };
  const record = value as Record<string, unknown>;
  const node: NetworkShapeNode = { type: 'object', keys: Object.keys(record).slice(0, 40) };
  return node;
}

/** 敏感串脱敏：Bearer token / 邮箱 / 手机号 / 长 hex 密钥。 */
export function redactSensitive(text: string): string {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '***')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***');
}

export interface NormalizeNetworkInput {
  events: NetworkEventInput[];
  pageUrl: string;
  options?: RecordNetworkOptions;
  /** 用于把响应体解析成 shape；未提供时 sample 不出 shape。 */
  parseBody?: (text: string, contentType: string) => unknown;
}

/**
 * 把原始网络事件整理成证据。纯函数：不判断安全策略以外的任何东西，不发请求。
 */
export function normalizeNetworkEvents(input: NormalizeNetworkInput): NetworkEvent[] {
  const options = { ...DEFAULT_RECORD_NETWORK_OPTIONS, ...(input.options || {}) };
  let pageOrigin = '';
  try { pageOrigin = new URL(input.pageUrl).origin; } catch { pageOrigin = ''; }

  const out: NetworkEvent[] = [];
  const seen = new Set<string>();
  for (const event of input.events) {
    if (out.length >= options.maxEvents) break;
    if (!shouldRecordResource(event.resourceType || '')) continue;
    const rawUrl = String(event.url || '');
    if (!rawUrl || /^(data|blob|about):/i.test(rawUrl)) continue;
    if (options.sameOriginOnly && pageOrigin) {
      try {
        if (new URL(rawUrl).origin !== pageOrigin) continue;
      } catch { continue; }
    }
    const template = urlTemplateOf(rawUrl);
    // 按「模板 + 方法」去重：page=1/2/3 是同一个接口的不同页，模板里已经是 {page}，
    // 重复列出来只会占上下文。需要区分页数时看模板就够了。
    const key = template + '|' + String(event.method || 'GET').toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const contentType = String(event.contentType || '');
    const record: NetworkEvent = {
      method: String(event.method || 'GET').toUpperCase(),
      url: rawUrl,
      urlTemplate: template,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(contentType ? { contentType: contentType.split(';')[0] } : {}),
      ...(event.size !== undefined ? { size: event.size } : {}),
      ...(event.timingMs !== undefined ? { timingMs: event.timingMs } : {}),
    };

    if (input.parseBody && event.bodyText) {
      try {
        const parsed = input.parseBody(event.bodyText, contentType);
        if (parsed !== undefined) record.shape = responseShapeOf(parsed);
      } catch { /* 非 JSON 就不出 shape */ }
    }
    if (options.includeResponseBody && event.bodyText) {
      record.sample = redactSensitive(event.bodyText.slice(0, options.maxBodyBytes));
    }
    out.push(record);
  }
  return out;
}

/** 对象骨架 → 一行可读描述，例如 {code:number, data:{records:array[20], total:number}} */
export function describeShape(value: unknown, depth = 0): string {
  if (depth > 2) return '…';
  if (Array.isArray(value)) return 'array[' + value.length + ']';
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object') return type;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 12);
  return '{' + keys.map((key) => key + ':' + describeShape(record[key], depth + 1)).join(', ') + '}';
}

export interface ProbeEvidenceInput {
  url: string;
  title?: string;
  /** ssr / spa / unknown */
  pageKind?: 'ssr' | 'spa' | 'unknown';
  embeddedStateKeys?: string[];
  network: NetworkEvent[];
  /** 证据包字符上限。 */
  maxChars?: number;
}

/**
 * 生成给主脑看的「站点探测证据包」。
 * 结构固定（页面类型 / 嵌入式状态 / 候选接口），便于模型稳定解析。
 */
export function formatProbeEvidence(input: ProbeEvidenceInput): string {
  const maxChars = Math.max(500, Math.trunc(input.maxChars ?? 6000));
  const lines: string[] = [];
  lines.push('【站点探测证据】' + String(input.url || ''));
  if (input.title) lines.push('页面标题：' + input.title);
  lines.push('页面类型：' + (input.pageKind === 'ssr' ? 'SSR（首屏 HTML 含数据）' : input.pageKind === 'spa' ? 'SPA（首屏靠 XHR 取数）' : '未知'));
  const embedded = input.embeddedStateKeys || [];
  lines.push('嵌入式状态：' + (embedded.length ? '命中 ' + embedded.join(' / ') : '未命中（__NEXT_DATA__ / __INITIAL_STATE__ 均无）'));

  if (!input.network.length) {
    lines.push('候选接口：未记录到 XHR/fetch（可能需要先在页面内触发一次加载）');
  } else {
    lines.push('候选接口（按记录顺序）：');
    input.network.forEach((event, index) => {
      lines.push('  ' + (index + 1) + ') ' + event.method + ' ' + event.urlTemplate
        + (event.status !== undefined ? '  → ' + event.status : '')
        + (event.contentType ? ' ' + event.contentType : ''));
      if (event.shape) {
        const shapeText = event.shape.type === 'object' && event.shape.keys
          ? '{' + event.shape.keys.slice(0, 12).join(', ') + '}'
          : event.shape.type === 'array'
            ? 'array[' + (event.shape.length ?? 0) + ']'
            : event.shape.type;
        lines.push('     shape: ' + shapeText);
      }
      if (event.sample) lines.push('     sample: ' + event.sample.slice(0, 400));
    });
  }

  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n…（证据过长已截断，共 ' + text.length + ' 字符）';
}