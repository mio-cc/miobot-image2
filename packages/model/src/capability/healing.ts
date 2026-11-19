/**
 * 参数自愈（2026-11-19 重写）。
 *
 * params.ts 的静态规则只能覆盖已知模型。用户随时可能接一个没见过的中转、
 * 一个刚发布的模型、或一个把参数改名的反代——硬编码的 payload 碰上它们就是 400。
 *
 * 这里做三件事：
 *   1. 从错误里认出「哪个参数被拒」（交给 contract-extract-error.ts，支持 OpenAI /
 *      FastAPI detail[].loc / Anthropic / 中文句式）；
 *   2. 决定怎么修：drop（不认识就摘掉）/ rename（上游给了新名字）/ snap（值不合法但
 *      上游列了合法值，改成最接近的那个）；
 *   3. 按「节点 + 模型」记住结论，之后不再犯同样的错。
 *
 * 为什么必须有 snap：以前命中值不合法一律 drop，对 size 来说等于「用户选了画幅、
 * 上游用默认」——静默丢弃比报错更难查。snap 至少保住了意图（竖图不会变横图）。
 */
import { extractParamRejection } from './contract-extract-error.js';
import { aspectOfSizeName, signedAspect } from './shape-request.js';

export type HealingFix =
  | { action: 'drop'; param: string }
  | { action: 'rename'; param: string; to: string }
  | { action: 'snap'; param: string; to: string };

interface Learned {
  drop: Set<string>;
  rename: Map<string, string>;
  snap: Map<string, string>;
}

const learned = new Map<string, Learned>();

export interface HealingNodeRef {
  baseUrl?: string;
  dialect?: string;
}

/**
 * 自愈结论的缓存键。
 *
 * 原来是「数组下标 + 模型名」。下标是配置位置不是身份：用户删掉中间节点、或把节点 1
 * 换成另一家服务商后，下标 1 仍命中之前学到的结论——于是在新服务商上继续静默剔除
 * 它其实支持的参数，且永不自我纠正。现在绑 dialect + baseUrl。
 */
export function healingKey(node: HealingNodeRef | undefined, model: string): string {
  const base = String(node?.baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  return `${node?.dialect || 'openai'}|${base}::${String(model || '').trim()}`;
}

function getLearned(key: string): Learned {
  let entry = learned.get(key);
  if (!entry) {
    entry = { drop: new Set(), rename: new Map(), snap: new Map() };
    learned.set(key, entry);
  }
  return entry;
}

/** 把已学到的结论应用到请求体上。 */
export function applyLearned(key: string, body: unknown): unknown {
  const entry = learned.get(key);
  if (!entry || !body || typeof body !== 'object' || Array.isArray(body)) return body;

  const result: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const [from, to] of entry.rename) {
    if (from in result) {
      result[to] = result[from];
      delete result[from];
    }
  }
  for (const [param, value] of entry.snap) {
    if (param in result) result[param] = value;
  }
  for (const param of entry.drop) delete result[param];
  return result;
}

/** 当前这个「节点 + 模型」已知被拒的参数，供面板展示与排障。 */
export function describeLearned(key: string): { dropped: string[]; renamed: Record<string, string>; snapped: Record<string, string> } | undefined {
  const entry = learned.get(key);
  if (!entry) return undefined;
  return {
    dropped: [...entry.drop],
    renamed: Object.fromEntries(entry.rename),
    snapped: Object.fromEntries(entry.snap),
  };
}

export function rememberFix(key: string, fix: HealingFix): void {
  const entry = getLearned(key);
  if (fix.action === 'rename') entry.rename.set(fix.param, fix.to);
  else if (fix.action === 'snap') entry.snap.set(fix.param, fix.to);
  else entry.drop.add(fix.param);
}

export function resetLearned(key?: string): void {
  if (key) learned.delete(key);
  else learned.clear();
}

export interface DiagnoseOptions {
  /** 契约里该参数的合法取值（上游没有列举时用它做 snap 目标）。 */
  candidatesFor?: (param: string) => string[] | undefined;
}

/**
 * 从错误里判断该怎么调整请求体。
 * 返回 undefined 表示「这不是可修的参数问题，别重试」——
 * 把服务故障或鉴权失败当参数问题重试，只会放大故障、拖慢失败反馈。
 */
export function diagnose(status: number, payload: unknown, body: unknown, options?: DiagnoseOptions): HealingFix | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const rejection = extractParamRejection(Number(status), payload, record);
  if (!rejection) return undefined;

  // 只处理确实在本次请求体里的参数——否则可能是上游在抱怨别的东西。
  const key = Object.keys(record).find((item) => item.toLowerCase() === rejection.param.toLowerCase());
  if (!key) return undefined;

  // 1) 改名：上游直接给了正确参数名
  if (rejection.renameTo && rejection.renameTo !== key) {
    return { action: 'rename', param: key, to: rejection.renameTo };
  }

  // 2) 改值：上游列举了合法值，或契约里有
  const candidates = rejection.valueCandidates?.length
    ? rejection.valueCandidates
    : options?.candidatesFor?.(key);
  if (candidates && candidates.length) {
    const target = pickCandidate(record[key], candidates);
    if (target && String(target).toLowerCase() !== String(record[key] ?? '').toLowerCase()) {
      return { action: 'snap', param: key, to: target };
    }
    // 当前值已经在合法集合里，说明问题不在值上 → 不重试
    return undefined;
  }

  // 3) 兜底：摘掉这个参数
  return { action: 'drop', param: key };
}

/** 把修复应用到请求体，返回新的请求体。 */
export function applyFix(body: unknown, fix: HealingFix): unknown {
  const record = { ...(body as Record<string, unknown>) };
  if (fix.action === 'rename') {
    record[fix.to] = record[fix.param];
    delete record[fix.param];
  } else if (fix.action === 'snap') {
    record[fix.param] = fix.to;
  } else {
    delete record[fix.param];
  }
  return record;
}

/**
 * 从合法值里挑一个最接近当前值的。
 *
 * 尺寸优先按「带方向的宽高比」比较：1152x1536 与 1536x1024 的 max/min 都是 1.5，
 * 只比比例会打平然后按数组顺序选中横版——用户要竖图却给横图（实测踩过）。
 * 数字按距离；其它按「代表自动」的 auto/default 优先，否则取第一个。
 */
export function pickCandidate(current: unknown, candidates: string[]): string | undefined {
  const raw = String(current ?? '').trim();
  if (!candidates.length) return undefined;
  const lower = raw.toLowerCase();
  const exact = candidates.find((item) => String(item).toLowerCase() === lower);
  if (exact) return exact;

  const numericCurrent = Number(raw);
  if (Number.isFinite(numericCurrent) && candidates.every((item) => Number.isFinite(Number(item)))) {
    let best: { value: string; distance: number } | undefined;
    for (const item of candidates) {
      const distance = Math.abs(Number(item) - numericCurrent);
      if (!best || distance < best.distance) best = { value: item, distance };
    }
    return best?.value;
  }

  // 尺寸：当前可能是 'WxH'，候选可能是 'WxH' 也可能是 fal 的枚举名
  // （portrait_4_3 / landscape_16_9 / square_hd）。两边都归一成「带方向比例」再比，
  // 否则 1152x1536(竖) 会在候选里选中 square_hd（比例最接近 1 的那个）——实测踩到。
  const sizeMatch = /^(\d{2,5})x(\d{2,5})$/i.exec(raw);
  const target = sizeMatch ? signedAspect(Number(sizeMatch[1]), Number(sizeMatch[2])) : undefined;
  if (target !== undefined) {
    let best: { value: string; distance: number } | undefined;
    for (const item of candidates) {
      const token = String(item);
      const literal = /^(\d{2,5})x(\d{2,5})$/i.exec(token);
      const aspect = literal ? signedAspect(Number(literal[1]), Number(literal[2])) : aspectOfSizeName(token);
      if (aspect === undefined) continue;
      const distance = Math.abs(aspect - target);
      if (!best || distance < best.distance) best = { value: item, distance };
    }
    if (best) return best.value;
  }

  const auto = candidates.find((item) => /^(auto|default|adaptive)$/i.test(String(item)));
  if (auto) return auto;
  return candidates[0];
}