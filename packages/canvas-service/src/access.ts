import type { AppConfig } from '../../config/src/index.js';

/**
 * 画布的访问控制与限流。
 *
 * 画布前台没有登录态——它就是一个静态页面加一组 /canvas-api/*。
 * 生图、改图、反推这三条路由每次调用都会真金白银地打到上游，
 * 所以任何能访问这个端口的人都能消耗额度。默认放行是为了本机自用方便，
 * 但必须让用户能一键收紧，并且总有一层限流兜底。
 *
 * 保护范围：所有会**改变状态**的请求。读路由（GET/HEAD）一律不拦——
 * 否则前台刷新列表都会被限流打断；这一点在后台画布页的说明文字里也写明了。
 * 只有真正调上游的三条路由计入每分钟配额，删记录/改项目要鉴权但不占额度。
 */

export type CanvasAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 429; code: string; message: string };

/** 会真正调用上游、要花钱的三条路由。 */
const COSTLY_PATHS = new Set(['/images/generate', '/images/edit', '/interrogate']);

/** bot 往画廊回写自己的生成记录，走的是它自己的面板令牌校验，且不该被画布开关影响。 */
const SELF_GUARDED_PATHS = new Set(['/bot/gallery']);

export interface CanvasRouteGuard {
  /** 是否要过访问控制。 */
  guarded: boolean;
  /** 是否计入每分钟生成配额。只有真正花钱的路由才计。 */
  countsAgainstLimit: boolean;
}

/**
 * 哪些路由要过闸门。
 *
 * 最初这里写的是「只拦 POST」——这是个范围错误。画布的写操作里
 * DELETE /gallery/:id 会连带 fs.rmSync 真删磁盘资产，PUT /project 能把任意 JSON
 * 灌进内存并反复全量落盘，两者都不是 POST，于是「关闭画布」和「仅管理员」
 * 对它们完全无效——任何能连到端口的人都能把画廊删空。
 *
 * 现在按「是否改变状态」判定：GET/HEAD/OPTIONS 放行（读路由不拦是既定设计，
 * 见文件头注释与后台 UI 上的说明），其余方法一律过闸门。
 * 写路由过闸门但不占生图配额——删一条记录不该消耗用户的每分钟生成额度。
 */
export function canvasRouteGuard(method: string, path: string): CanvasRouteGuard {
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') {
    return { guarded: false, countsAgainstLimit: false };
  }
  if (SELF_GUARDED_PATHS.has(path)) return { guarded: false, countsAgainstLimit: false };
  return { guarded: true, countsAgainstLimit: verb === 'POST' && COSTLY_PATHS.has(path) };
}

/** 会真正调用上游的路由（保留给既有调用方与测试）。 */
export function isCostlyCanvasRoute(method: string, path: string): boolean {
  return String(method || '').toUpperCase() === 'POST' && COSTLY_PATHS.has(path);
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

/**
 * 单个进程内最多跟踪多少个来源。
 * 来源地址由传输层从 socket 覆写、不可伪造，正常用量远到不了这个数；
 * 但没有上界的话，一个 IPv6 段就能生成海量不同来源，把这张表撑爆。
 */
const MAX_TRACKED_KEYS = 10_000;

/** 固定窗口限流：每个来源每分钟允许 N 次。窗口固定而非滑动——够用且不用存时间戳数组。 */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private lastPrunedWindow = -1;

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

  /**
   * 丢掉过期窗口，并给同一窗口内的条数封顶。
   *
   * 原来只清「非当前窗口」，于是同一分钟内来源数没有任何上界；
   * 而且每插入一个新来源就全表扫一次，N 个来源的总扫描量是 O(N²)。
   */
  private prune(currentWindow: number): void {
    // 过期窗口的全量清扫每个窗口只做一次。
    if (this.lastPrunedWindow !== currentWindow) {
      this.lastPrunedWindow = currentWindow;
      for (const [key, entry] of this.hits) {
        if (entry.windowStart !== currentWindow) this.hits.delete(key);
      }
    }
    // 同窗口内仍然超限，说明来源数异常，按插入顺序丢掉最早的那批。
    // Map 保持插入序，直接迭代即可。
    if (this.hits.size <= MAX_TRACKED_KEYS) return;
    const excess = this.hits.size - MAX_TRACKED_KEYS;
    let dropped = 0;
    for (const key of this.hits.keys()) {
      this.hits.delete(key);
      if (++dropped >= excess) break;
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
  /** 是否计入每分钟配额。写操作（删记录、改项目）要鉴权但不该占生图额度。 */
  countsAgainstLimit?: boolean;
}

export function checkCanvasAccess(options: CanvasAccessOptions): CanvasAccessDecision {
  const canvas = options.config.canvas;

  if (canvas.enabled === false) {
    return { allowed: false, status: 403, code: 'canvas_disabled', message: '画布已在后台关闭' };
  }

  const mode = canvas.access || 'public';
  if (mode === 'admin' && !options.isAuthorized(options.headers)) {
    return { allowed: false, status: 401, code: 'unauthorized', message: '请先登录后台再用' };
  }
  if (mode === 'local-only' && !isLocalClient(options.headers) && !options.isAuthorized(options.headers)) {
    return { allowed: false, status: 403, code: 'forbidden_origin', message: '仅限本机内网访问' };
  }

  // 管理员不受限流约束——他就是额度的主人，被自己的限流挡住只会莫名其妙。
  if (options.isAuthorized(options.headers)) return { allowed: true };

  if (options.countsAgainstLimit === false) return { allowed: true };

  const key = clientAddress(options.headers) || 'unknown';
  if (!options.limiter.take(key, Number(canvas.rateLimitPerMinute))) {
    return {
      allowed: false,
      status: 429,
      code: 'rate_limited',
      message: `太频繁，每分钟限 ${canvas.rateLimitPerMinute} 次`,
    };
  }

  return { allowed: true };
}
