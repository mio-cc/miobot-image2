/**
 * 站点配方（2026-11-19）。
 *
 * 设计取舍：**大模型只做一次站点上线（生成可复现配方），之后由确定性执行器跑。**
 * 而不是每次抓取都让模型现场读 HTML——那样慢、贵、不可复现。
 *
 * Recipe 是「代码的一种」：它能被校验、被版本化、被回滚、被结构校验兜住。
 */
import type { DatasetColumn } from './dataset.js';

export type StepType = 'http' | 'extract' | 'paginate';
export type ExtractEngine = 'json-api' | 'embedded-json' | 'css';

export interface HttpStep {
  type: 'http';
  method: 'GET' | 'HEAD' | 'POST';
  url: string;
  /** POST 查询接口必须显式声明只读，否则执行器拒绝。 */
  readOnly?: boolean;
  headers?: Record<string, string>;
}

export interface ExtractStep {
  type: 'extract';
  from: 'json' | 'html';
  engine: ExtractEngine;
  /** 记录数组的 JSONPath，例如 $.data.records[*]；embedded-json 时是数据在页面里的路径。 */
  path: string;
  /** 列名 → 相对上一步元素的取值（JSONPath 或字段名）。 */
  map: Record<string, string>;
}

export interface PaginateStep {
  type: 'paginate';
  /** 模板 URL 里的占位符名，例如 page。 */
  pageParam: string;
  from: number;
  to: number;
}

export type RecipeStep = HttpStep | ExtractStep | PaginateStep;

export interface RecipeVerifyRules {
  minRecords?: number;
  requiredFieldsNonEmpty?: string[];
  uniqueBy?: string[];
}

export interface SiteRecipe {
  version: 1;
  id: string;
  site: string;
  /** 站点配方自身的修订号，重上线时 +1。 */
  revision: number;
  match: { host: string[]; pathPrefix?: string[] };
  dataset: { columns: DatasetColumn[] };
  steps: RecipeStep[];
  verify?: RecipeVerifyRules;
  provenance?: {
    createdBy: 'model' | 'human';
    createdAt: string;
    /** 最近一次通过校验的样本哈希，用于回归对比。 */
    sampleHash?: string;
    successRate?: number;
  };
}

export interface RecipeValidationError {
  field: string;
  message: string;
}

/**
 * 校验配方。返回空数组表示通过。
 * 校验不通过绝不允许保存——否则脏配方会在生产里静默产出空数据。
 */
export function validateRecipe(input: unknown): RecipeValidationError[] {
  const errors: RecipeValidationError[] = [];
  const recipe = input as SiteRecipe | undefined;
  if (!recipe || typeof recipe !== 'object') return [{ field: '', message: '配方必须是对象' }];

  if (!String(recipe.id || '').trim()) errors.push({ field: 'id', message: '缺少 id' });
  if (!String(recipe.site || '').trim()) errors.push({ field: 'site', message: '缺少 site' });
  if (recipe.version !== 1) errors.push({ field: 'version', message: 'version 必须为 1' });
  if (!Number.isFinite(Number(recipe.revision)) || Number(recipe.revision) < 1) {
    errors.push({ field: 'revision', message: 'revision 必须是 >=1 的整数' });
  }

  const hosts = recipe.match?.host;
  if (!Array.isArray(hosts) || !hosts.length) {
    errors.push({ field: 'match.host', message: '必须锁定至少一个 host' });
  } else if (hosts.some((host) => !/^[a-z0-9.-]+$/i.test(String(host || '')))) {
    errors.push({ field: 'match.host', message: 'host 只能是域名，不能带协议/路径' });
  }

  const columns = recipe.dataset?.columns;
  if (!Array.isArray(columns) || !columns.length) {
    errors.push({ field: 'dataset.columns', message: '必须声明至少一列' });
  } else {
    const names = new Set<string>();
    for (const column of columns) {
      const name = String(column?.name || '').trim();
      if (!name) { errors.push({ field: 'dataset.columns', message: '列名不能为空' }); continue; }
      if (names.has(name)) errors.push({ field: 'dataset.columns', message: '列名重复：' + name });
      names.add(name);
      if (!['string', 'number', 'boolean', 'date'].includes(String(column.type))) {
        errors.push({ field: 'dataset.columns.' + name, message: '列类型非法：' + String(column.type) });
      }
    }
  }

  const steps = recipe.steps;
  if (!Array.isArray(steps) || !steps.length) {
    errors.push({ field: 'steps', message: '至少要有一步' });
  } else {
    let sawHttp = false;
    let sawExtract = false;
    steps.forEach((step, index) => {
      const where = 'steps[' + index + ']';
      if (step?.type === 'http') {
        sawHttp = true;
        const method = String(step.method || '').toUpperCase();
        if (!['GET', 'HEAD', 'POST'].includes(method)) {
          errors.push({ field: where + '.method', message: '只允许 GET/HEAD/POST' });
        }
        if (method === 'POST' && step.readOnly !== true) {
          errors.push({ field: where, message: 'POST 必须显式声明 readOnly: true（只读查询接口）' });
        }
        if (!/^https?:\/\//i.test(String(step.url || ''))) {
          errors.push({ field: where + '.url', message: 'url 必须是绝对地址' });
        }
      } else if (step?.type === 'extract') {
        sawExtract = true;
        if (!['json-api', 'embedded-json', 'css'].includes(String(step.engine))) {
          errors.push({ field: where + '.engine', message: 'engine 非法' });
        }
        if (!String(step.path || '').trim()) errors.push({ field: where + '.path', message: '缺少 path' });
        if (!step.map || typeof step.map !== 'object' || !Object.keys(step.map).length) {
          errors.push({ field: where + '.map', message: 'map 不能为空' });
        }
      } else if (step?.type === 'paginate') {
        if (!String(step.pageParam || '').trim()) errors.push({ field: where + '.pageParam', message: '缺少 pageParam' });
        const from = Number(step.from);
        const to = Number(step.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
          errors.push({ field: where, message: '分页区间非法' });
        }
      } else {
        errors.push({ field: where, message: '未知步骤类型' });
      }
    });
    if (!sawHttp) errors.push({ field: 'steps', message: '缺少 http 步骤' });
    if (!sawExtract) errors.push({ field: 'steps', message: '缺少 extract 步骤' });
  }

  return errors;
}

/**
 * 该 URL 的 host 是否在配方允许范围内。
 *
 * 执行器只应该用这个（host 锁定）；pathPrefix 是「这个配方负责哪些页面」，
 * 用于给用户给的页面 URL 选配方。两者混用会误伤：配方的 http 步骤常常是
 * /ajax/xxx 这类接口地址，而 match.pathPrefix 写的是 /rank/ 这样的页面路径。
 */
export function hostAllowed(recipe: SiteRecipe, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  const allowed = (recipe.match?.host || []).map((item) => String(item).toLowerCase());
  return allowed.some((item) => host === item || host.endsWith('.' + item));
}

/** 该 URL 是否属于配方的站点范围（host + pathPrefix）。用于「按页面选配方」。 */
export function recipeMatchesUrl(recipe: SiteRecipe, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (!hostAllowed(recipe, url)) return false;
  const prefixes = recipe.match?.pathPrefix || [];
  if (!prefixes.length) return true;
  return prefixes.some((prefix) => parsed.pathname.startsWith(prefix));
}

/** 把模板 URL 里的 {name} 换成实际参数。缺参数返回 undefined（不猜）。 */
export function renderTemplate(template: string, params: Record<string, unknown>): string | undefined {
  let missing = false;
  const text = String(template || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_all, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || String(value) === '') { missing = true; return ''; }
    return encodeURIComponent(String(value));
  });
  return missing ? undefined : text;
}