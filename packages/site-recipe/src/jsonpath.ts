/**
 * 最小 JSONPath 子集（2026-11-19）。
 *
 * 为什么自己写：配方要能在「不引入新依赖」的前提下被验证与执行，
 * 而完整 JSONPath 的语义（过滤器/递归下降）对抓取配方来说是过剩的。
 *
 * 支持（明确写死，超出范围返回 undefined 而不是猜）：
 *   $.a.b            对象取值
 *   $.a.b[*].c       数组展开后取 c
 *   $.a[0].b         数组下标
 *   $[*].c           顶层数组展开
 *   $                整个值
 * 不支持：过滤表达式 [?()]、递归下降 ..、切片 [1:3]、函数调用。
 */

export function isJsonPath(expr: unknown): boolean {
  return typeof expr === 'string' && /^\$([.\[]|$)/.test(expr.trim());
}

interface Token { kind: 'key' | 'index' | 'wildcard'; value?: string | number }

function tokenize(path: string): Token[] | undefined {
  const text = path.trim();
  if (!text.startsWith('$')) return undefined;
  const tokens: Token[] = [];
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.') {
      i += 1;
      let key = '';
      while (i < text.length && /[A-Za-z0-9_$\-]/.test(text[i])) { key += text[i]; i += 1; }
      if (!key) return undefined;
      tokens.push({ kind: 'key', value: key });
      continue;
    }
    if (ch === '[') {
      const end = text.indexOf(']', i);
      if (end < 0) return undefined;
      const inner = text.slice(i + 1, end).trim();
      if (inner === '*') tokens.push({ kind: 'wildcard' });
      else if (/^\d+$/.test(inner)) tokens.push({ kind: 'index', value: Number(inner) });
      else if (/^['"][^'"]+['"]$/.test(inner)) tokens.push({ kind: 'key', value: inner.slice(1, -1) });
      else return undefined;
      i = end + 1;
      continue;
    }
    return undefined;
  }
  return tokens;
}

/** 求值：返回匹配到的值数组（可能 0 个或多个）。 */
export function queryJsonPath(root: unknown, path: string): unknown[] {
  const tokens = tokenize(path);
  if (!tokens) return [];
  let current: unknown[] = [root];
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const value of current) {
      if (token.kind === 'key') {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(record, token.value as string)) next.push(record[token.value as string]);
        }
      } else if (token.kind === 'index') {
        if (Array.isArray(value)) {
          const index = token.value as number;
          if (index >= 0 && index < value.length) next.push(value[index]);
        }
      } else if (Array.isArray(value)) {
        next.push(...value);
      }
    }
    current = next;
    if (!current.length) return [];
  }
  return current;
}

/** 取单个标量；多个时取第一个。 */
export function queryJsonPathOne(root: unknown, path: string): unknown {
  return queryJsonPath(root, path)[0];
}