/**
 * 参数自愈。
 *
 * params.ts 的静态规则只能覆盖已知模型。用户随时可能接一个没见过的中转、
 * 一个刚发布的模型，或者一个把参数改名的反代——硬编码的 payload 碰上它们就是 400。
 *
 * 这里做的事很简单：上游因为某个参数报 400 时，把这个参数摘掉
 * （或按它自己的提示改名）再发一次，并把结论按「节点 + 模型」记下来，之后不再犯同样的错。
 *
 * 于是用户换任何网关，第一次请求可能多花一轮，之后就自动收敛到正确的 payload 形态。
 */

const PARAM_REJECTED: RegExp[] = [
  // OpenAI: "Unsupported parameter: 'max_tokens' is not supported with this model."
  /(?:unsupported|unknown|unrecognized|invalid|not supported)\s+(?:request\s+)?(?:parameter|argument|field|property)[^'"`]*['"`]([a-zA-Z0-9_.]+)['"`]/i,
  // 另一种语序: "'response_format' is not supported"
  /['"`]([a-zA-Z0-9_.]+)['"`]\s+is\s+(?:not\s+supported|unsupported|invalid|unknown)/i,
  // 中转常见: "parameter response_format not allowed"
  /(?:parameter|field)\s+([a-zA-Z0-9_.]+)\s+(?:is\s+)?(?:not\s+allowed|not\s+supported|unknown)/i,
];

/** "Use 'max_completion_tokens' instead." —— 上游直接告诉了我们正确的参数名。 */
const PARAM_REPLACEMENT = /use\s+['"`]([a-zA-Z0-9_.]+)['"`]\s+instead/i;

/** 值不合法（而不是参数名不认识），比如 dall-e-3 的 n 必须为 1。 */
const VALUE_REJECTED = /['"`]?\b(n|size|quality|response_format|reasoning_effort|temperature|top_p)\b['"`]?[^.]{0,80}?(?:must be|only supports?|invalid value|unsupported value|not valid)/i;

export type HealingFix =
  | { action: 'drop'; param: string }
  | { action: 'rename'; param: string; to: string };

interface Learned {
  /** 已知这个模型不认识的参数 */
  drop: Set<string>;
  /** 已知需要改名的参数：原名 → 新名 */
  rename: Map<string, string>;
}

const learned = new Map<string, Learned>();

export function healingKey(nodeIndex: number, model: string): string {
  return `${Number(nodeIndex)}::${String(model || '').trim()}`;
}

function getLearned(key: string): Learned {
  let entry = learned.get(key);
  if (!entry) {
    entry = { drop: new Set(), rename: new Map() };
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
  for (const param of entry.drop) delete result[param];
  return result;
}

/** 当前这个「节点 + 模型」已知被拒的参数，供面板展示与排障。 */
export function describeLearned(key: string): { dropped: string[]; renamed: Record<string, string> } | undefined {
  const entry = learned.get(key);
  if (!entry) return undefined;
  return { dropped: [...entry.drop], renamed: Object.fromEntries(entry.rename) };
}

export function rememberFix(key: string, fix: HealingFix): void {
  const entry = getLearned(key);
  if (fix.action === 'rename') entry.rename.set(fix.param, fix.to);
  else entry.drop.add(fix.param);
}

export function resetLearned(key?: string): void {
  if (key) learned.delete(key);
  else learned.clear();
}

/**
 * 从错误里判断该怎么调整请求体。
 * 返回 undefined 表示「这不是参数问题，别重试」——
 * 把服务故障或鉴权失败当参数问题重试，只会放大故障、拖慢失败反馈。
 */
export function diagnose(status: number, payload: unknown, body: unknown): HealingFix | undefined {
  // 中转对参数问题的状态码并不统一，422 和 500 都见过，所以放宽一点，
  // 但仍然要求错误文本里能明确指认出某个参数名。
  if (![400, 415, 422, 500].includes(Number(status))) return undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;

  const record = body as Record<string, unknown>;
  const text = extractText(payload);
  if (!text) return undefined;

  for (const pattern of PARAM_REJECTED) {
    const name = pattern.exec(text)?.[1];
    if (!name) continue;
    // 只处理确实在本次请求体里的参数——否则可能是上游在抱怨别的东西。
    const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
    if (!key) continue;

    const replacement = PARAM_REPLACEMENT.exec(text)?.[1];
    return replacement && replacement !== key
      ? { action: 'rename', param: key, to: replacement }
      : { action: 'drop', param: key };
  }

  const valueParam = VALUE_REJECTED.exec(text)?.[1];
  if (valueParam && valueParam in record) return { action: 'drop', param: valueParam };

  return undefined;
}

/** 把修复应用到请求体，返回新的请求体。 */
export function applyFix(body: unknown, fix: HealingFix): unknown {
  const record = { ...(body as Record<string, unknown>) };
  if (fix.action === 'rename') {
    record[fix.to] = record[fix.param];
    delete record[fix.param];
  } else {
    delete record[fix.param];
  }
  return record;
}

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}
