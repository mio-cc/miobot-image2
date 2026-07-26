import type { AppConfig } from '../../config/src/index.js';

/**
 * 画布的访问控制与限流。
 *
 * 画布前台没有登录态——它就是一个静态页面加一组 /canvas-api/*。
 * 生图、改图、反推这三条路由每次调用都会真金白银地打到上游，
 * 所以任何能访问这个端口的人都能消耗额度。默认放行是为了本机自用方便，
 * 但必须让用户能一键收紧，并且总有一层限流兜底。
 *
 * 只保护「花钱」的路由：读画廊、取资产、查任务状态一律不拦，
 * 否则前台刷新列表都会被限流打断。
 */

export type CanvasAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 429; code: string; message: string };

/** 会真正调用上游的路由（不含 GET 类读取）。 */
export function isCostlyCanvasRoute(method: string, path: string): boolean {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  return path === '/images/generate' || path === '/images/edit' || path === '/interrogate';
}

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '']);

/** 私有网段：RFC1918 + 链路本地 + IPv6 ULA。 */
function isPrivateAddress(ip: string): boolean {
  if (LOCAL_ADDRESSES.has(ip)) return true;
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^10\./.test(v4)) return true;
  if (/^192\.168\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (/^169\.254\./.test(v4)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

/**
 * 取调用方地址。传输层把它放在 x-client-ip 里；
 * **不**信任 x-forwarded-for——那个头是客户端可以随便写的，
 * 拿它做访问控制等于没做。反代场景由部署方自己在反代上限制来源。
 */
export function clientAddress(headers?: Record<string, string | undefined>): string {
  return String(headers?.['x-client-ip'] || '').trim();
}

export function isLocalClient(headers?: Record<string, string | undefined>): boolean {
  return isPrivateAddress(clientAddress(headers));
}

/** 固定窗口限流：每个来源每分钟允许 N 次。窗口固定而非滑动——够用且不用存时间戳数组。 */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 返回是否放行；limit <= 0 表示不限制。 */
  take(key: string, limit: number): boolean {
    if (!Number.isFinite(limit) || limit <= 0) return true;
    const nowMs = this.now();
    const windowStart = Math.floor(nowMs / 60_000) * 60_000;
    const entry = this.hits.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      this.hits.set(key, { windowStart, count: 1 });
      this.prune(windowStart);
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  /** 丢掉过期窗口，否则长期运行会按来源数无限增长。 */
  private prune(currentWindow: number): void {
    if (this.hits.size < 512) return;
    for (const [key, entry] of this.hits) {
      if (entry.windowStart !== currentWindow) this.hits.delete(key);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}

export interface CanvasAccessOptions {
  config: AppConfig;
  headers?: Record<string, string | undefined>;
  /** 面板会话校验；admin 模式下用它判断是不是管理员。 */
  isAuthorized: (headers?: Record<string, string | undefined>) => boolean;
  limiter: RateLimiter;
}

export function checkCanvasAccess(options: CanvasAccessOptions): CanvasAccessDecision {
  const canvas = options.config.canvas;

  if (canvas.enabled === false) {
    return { allowed: false, status: 403, code: 'canvas_disabled', message: '画布前台已在后台关闭。' };
  }

  const mode = canvas.access || 'public';
  if (mode === 'admin' && !options.isAuthorized(options.headers)) {
    return { allowed: false, status: 401, code: 'unauthorized', message: '画布当前限管理员使用，请先登录后台。' };
  }
  if (mode === 'local-only' && !isLocalClient(options.headers) && !options.isAuthorized(options.headers)) {
    return { allowed: false, status: 403, code: 'forbidden_origin', message: '画布当前只允许本机/内网访问。' };
  }

  // 管理员不受限流约束——他就是额度的主人，被自己的限流挡住只会莫名其妙。
  if (options.isAuthorized(options.headers)) return { allowed: true };

  const key = clientAddress(options.headers) || 'unknown';
  if (!options.limiter.take(key, Number(canvas.rateLimitPerMinute))) {
    return {
      allowed: false,
      status: 429,
      code: 'rate_limited',
      message: `请求过于频繁，每分钟最多 ${canvas.rateLimitPerMinute} 次。`,
    };
  }

  return { allowed: true };
}
