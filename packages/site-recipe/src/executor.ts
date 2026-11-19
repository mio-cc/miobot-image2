/**
 * 配方执行器（2026-11-19）。
 *
 * 安全边界（reviewer 会逐条核，改动前先读）：
 *   · 只允许 GET/HEAD；POST 必须在配方里 readOnly:true
 *   · host 锁定在配方里，任何跨 host（含 3xx 跳转）直接拒绝
 *   · 拒绝私网/环回/云元数据地址
 *   · 每域名速率上限（默认 1 req/2s）、单次页数上限（默认 20）
 *   · 不携带 cookie / 登录态；401/403 直接返回「需要登录，不支持」
 *
 * 注入 fetch 而不是直接用全局 fetch：可测、可控、可替换。
 */
import { createDataset, normalizeRecords, type Dataset } from './dataset.js';
import { queryJsonPath, queryJsonPathOne } from './jsonpath.js';
import { hostAllowed, renderTemplate, type SiteRecipe } from './recipe.js';
import { verifyDataset, type VerifyResult } from './verify.js';

export interface ExecutorFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type ExecutorFetch = (url: string, init: { method: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' }) => Promise<ExecutorFetchResponse>;

export interface ExecuteRecipeOptions {
  fetchImpl: ExecutorFetch;
  params?: Record<string, unknown>;
  /** 每域名最小请求间隔（毫秒），默认 2000。 */
  minIntervalMs?: number;
  /** 单次最多抓多少页，默认 20。 */
  maxPages?: number;
  /** 单次请求超时，默认 15s。 */
  timeoutMs?: number;
  /** 注入时钟，便于测试速率限制。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

export interface ExecuteRecipeResult {
  ok: boolean;
  dataset?: Dataset;
  verify?: VerifyResult;
  error?: string;
  /** 实际请求过的 URL，便于排障与配方修正。 */
  requested: string[];
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/i,
  /^\[?fe80:/i,
  /^\[?fc/i,
  /^\[?fd/i,
];

export function isPrivateHost(host: string): boolean {
  const value = String(host || '').trim().toLowerCase();
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(value));
}

/** 从请求体里拆出「要抓的 URL 列表」：支持分页展开。 */
export function planRequests(recipe: SiteRecipe, params: Record<string, unknown>, maxPages: number): string[] | string {
  const httpSteps = recipe.steps.filter((step): step is Extract<typeof step, { type: 'http' }> => step.type === 'http');
  const paginate = recipe.steps.find((step) => step.type === 'paginate');
  const urls: string[] = [];
  for (const step of httpSteps) {
    if (paginate && paginate.type === 'paginate') {
      const from = Number(paginate.from);
      const to = Math.min(Number(paginate.to), from + maxPages - 1);
      for (let page = from; page <= to; page += 1) {
        const rendered = renderTemplate(step.url, { ...params, [paginate.pageParam]: page });
        if (rendered === undefined) return '缺少模板参数：' + step.url;
        urls.push(rendered);
      }
    } else {
      const rendered = renderTemplate(step.url, params);
      if (rendered === undefined) return '缺少模板参数：' + step.url;
      urls.push(rendered);
    }
  }
  return urls;
}

export async function executeRecipe(recipe: SiteRecipe, options: ExecuteRecipeOptions): Promise<ExecuteRecipeResult> {
  const params = options.params || {};
  const maxPages = Math.max(1, Math.trunc(Number(options.maxPages ?? 20)));
  const minIntervalMs = Math.max(0, Math.trunc(Number(options.minIntervalMs ?? 2000)));
  const timeoutMs = Math.max(1000, Math.trunc(Number(options.timeoutMs ?? 15000)));
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requested: string[] = [];
  const lastHitAt = new Map<string, number>();

  const plan = planRequests(recipe, params, maxPages);
  if (typeof plan === 'string') return { ok: false, error: plan, requested };

  const httpSteps = recipe.steps.filter((step): step is Extract<typeof step, { type: 'http' }> => step.type === 'http');
  const extractSteps = recipe.steps.filter((step): step is Extract<typeof step, { type: 'extract' }> => step.type === 'extract');

  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < plan.length; index += 1) {
    const url = plan[index];
    // 安全 1：必须在配方声明的 host 范围内（只锁 host；pathPrefix 是选配方用的，
    // 拿它约束 /ajax/... 这类接口地址会误伤）
    if (!hostAllowed(recipe, url)) {
      return { ok: false, error: 'URL 不在配方声明的站点范围内：' + url, requested };
    }
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, error: 'URL 非法：' + url, requested }; }
    // 安全 2：私网 / 环回 / 云元数据
    if (isPrivateHost(parsed.hostname)) {
      return { ok: false, error: '拒绝访问私网地址：' + parsed.hostname, requested };
    }
    // 安全 3：只读方法
    const step = httpSteps[Math.min(httpSteps.length - 1, 0)];
    const method = String(step?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && step?.readOnly !== true) {
      return { ok: false, error: '配方包含非只读请求，已拒绝', requested };
    }
    // 安全 4：速率限制
    const host = parsed.hostname.toLowerCase();
    const last = lastHitAt.get(host);
    if (last !== undefined && minIntervalMs > 0) {
      const wait = minIntervalMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastHitAt.set(host, now());

    requested.push(url);
    let response: ExecutorFetchResponse;
    try {
      response = await options.fetchImpl(url, {
        method,
        redirect: 'manual',
        headers: { accept: 'application/json,text/html;q=0.9', ...(step?.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, error: '请求失败：' + String((error as Error)?.message || error), requested };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: '该站点需要登录，配方不支持（HTTP ' + response.status + '）', requested };
    }
    if (response.status >= 300 && response.status < 400) {
      // redirect: 'manual' 下 3xx 说明想跳走，一律不跟（防跨 host 逃逸）
      return { ok: false, error: '站点发生跳转（HTTP ' + response.status + '），配方需重新上线', requested };
    }
    if (!response.ok) {
      return { ok: false, error: '上游返回 HTTP ' + response.status, requested };
    }

    const body = await response.text();
    for (const extract of extractSteps) {
      const values = extractValues(body, extract);
      for (const item of values) {
        const row: Record<string, unknown> = {};
        for (const [column, selector] of Object.entries(extract.map)) {
          row[column] = pickValue(item, selector);
        }
        rows.push(row);
      }
    }
  }

  const records = normalizeRecords(rows, recipe.dataset.columns);
  const dataset = createDataset({
    columns: recipe.dataset.columns,
    records,
    source: recipe.site,
    ...(recipe.id ? { recipeId: recipe.id } : {}),
    recipeVersion: recipe.revision,
    ...(requested[0] ? { url: requested[0] } : {}),
  });
  const verify = verifyDataset(dataset, recipe.verify || {}, recipe.dataset.columns);
  if (!verify.ok) {
    options.logger?.warn('站点配方校验未通过', { recipeId: recipe.id, failures: verify.failures });
  }
  return { ok: verify.ok, dataset, verify, requested };
}

/** 从响应体里按 extract 步骤取记录数组。 */
export function extractValues(body: string, step: { engine: string; path: string; from: string }): unknown[] {
  if (step.engine === 'css') {
    // CSS 选择器需要 DOM 解析；本包不引依赖，明确返回空并让 verify 判失败，
    // 而不是返回半成品数据（半成品比空更危险）。
    return [];
  }
  let json: unknown;
  try { json = JSON.parse(body); } catch { return []; }
  const values = queryJsonPath(json, step.path);
  // $.a.records[*] 已经展开；$.a.records 这种没写 [*] 的，如果拿到的是数组就展开
  if (values.length === 1 && Array.isArray(values[0])) return values[0];
  return values;
}

/** 元素内取字段：支持 $.x.y 与裸字段名。 */
export function pickValue(item: unknown, selector: string): unknown {
  const expr = String(selector || '').trim();
  if (!expr) return undefined;
  if (expr.startsWith('$')) {
    const one = queryJsonPathOne(item, expr);
    return one === undefined && expr.startsWith('$.') ? (item as Record<string, unknown>)?.[expr.slice(2)] : one;
  }
  if (item && typeof item === 'object') return (item as Record<string, unknown>)[expr];
  return undefined;
}