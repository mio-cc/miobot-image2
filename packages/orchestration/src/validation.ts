export interface ValidationIssue {
  path: string;
  code: 'required' | 'type' | 'enum' | 'minimum' | 'maximum' | 'minLength' | 'maxLength' | 'minItems' | 'maxItems' | 'additional';
  message: string;
}

export interface ArgsValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value: unknown, expected: unknown): boolean {
  const types = Array.isArray(expected) ? expected.map(String) : [String(expected || '')];
  const actual = jsonType(value);
  return types.some((type) => type === actual || (type === 'number' && actual === 'number') || (type === 'integer' && actual === 'number' && Number.isInteger(value)));
}

function issue(path: string, code: ValidationIssue['code'], message: string): ValidationIssue {
  return { path, code, message };
}

export function validateCapabilityArgs(schema: unknown, args: unknown, basePath = '$'): ArgsValidationResult {
  const issues: ValidationIssue[] = [];
  const validate = (currentSchema: any, value: unknown, path: string): void => {
    if (!currentSchema || typeof currentSchema !== 'object') return;
    if (currentSchema.type && !typeMatches(value, currentSchema.type)) {
      issues.push(issue(path, 'type', `应为 ${Array.isArray(currentSchema.type) ? currentSchema.type.join('|') : currentSchema.type}`));
      return;
    }
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.some((item: unknown) => JSON.stringify(item) === JSON.stringify(value))) {
      issues.push(issue(path, 'enum', `必须是 ${currentSchema.enum.join(', ')} 之一`));
    }
    if (typeof value === 'number') {
      if (typeof currentSchema.minimum === 'number' && value < currentSchema.minimum) issues.push(issue(path, 'minimum', `不能小于 ${currentSchema.minimum}`));
      if (typeof currentSchema.maximum === 'number' && value > currentSchema.maximum) issues.push(issue(path, 'maximum', `不能大于 ${currentSchema.maximum}`));
    }
    if (typeof value === 'string') {
      if (typeof currentSchema.minLength === 'number' && value.length < currentSchema.minLength) issues.push(issue(path, 'minLength', `长度不能小于 ${currentSchema.minLength}`));
      if (typeof currentSchema.maxLength === 'number' && value.length > currentSchema.maxLength) issues.push(issue(path, 'maxLength', `长度不能大于 ${currentSchema.maxLength}`));
    }
    if (Array.isArray(value)) {
      if (typeof currentSchema.minItems === 'number' && value.length < currentSchema.minItems) issues.push(issue(path, 'minItems', `至少需要 ${currentSchema.minItems} 项`));
      if (typeof currentSchema.maxItems === 'number' && value.length > currentSchema.maxItems) issues.push(issue(path, 'maxItems', `最多允许 ${currentSchema.maxItems} 项`));
      if (currentSchema.items) value.forEach((item, index) => validate(currentSchema.items, item, `${path}[${index}]`));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const key of Array.isArray(currentSchema.required) ? currentSchema.required : []) {
        if (obj[key] === undefined || obj[key] === null || obj[key] === '') issues.push(issue(`${path}.${key}`, 'required', '缺少必填参数'));
      }
      if (currentSchema.additionalProperties === false) {
        const known = new Set(Object.keys(currentSchema.properties || {}));
        for (const key of Object.keys(obj)) {
          if (!known.has(key)) issues.push(issue(`${path}.${key}`, 'additional', '不允许的额外参数'));
        }
      }
      for (const [key, childSchema] of Object.entries(currentSchema.properties || {})) {
        if (obj[key] !== undefined) validate(childSchema, obj[key], `${path}.${key}`);
      }
    }
  };
  validate(schema, args, basePath);
  return { ok: issues.length === 0, issues };
}

export function validationQuestion(issues: ValidationIssue[]): string {
  if (!issues.length) return '';
  return `计划参数需要修正：${issues.slice(0, 5).map((item) => `${item.path} ${item.message}`).join('；')}`;
}

export interface ArgsNormalizationWarning {
  path: string;
  code: 'clamped' | 'truncated';
  message: string;
}

export interface ArgsNormalizationResult {
  ok: boolean;
  args: unknown;
  issues: ValidationIssue[];
  warnings: ArgsNormalizationWarning[];
}

/**
 * 功能层参数归一化：必填/类型/枚举等问题仍返回追问；
 * 数值越界和数组超限按 schema 收敛并记录 warning，避免坏参数直接穿透执行器。
 */
export function normalizeCapabilityArgs(schema: unknown, args: unknown, basePath = '$'): ArgsNormalizationResult {
  const issues: ValidationIssue[] = [];
  const warnings: ArgsNormalizationWarning[] = [];

  const normalize = (currentSchema: any, value: unknown, path: string): unknown => {
    if (!currentSchema || typeof currentSchema !== 'object') return value;
    if (currentSchema.type && !typeMatches(value, currentSchema.type)) {
      issues.push(issue(path, 'type', `应为 ${Array.isArray(currentSchema.type) ? currentSchema.type.join('|') : currentSchema.type}`));
      return value;
    }
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.some((item: unknown) => JSON.stringify(item) === JSON.stringify(value))) {
      issues.push(issue(path, 'enum', `必须是 ${currentSchema.enum.join(', ')} 之一`));
      return value;
    }

    if (typeof value === 'number') {
      let next = value;
      if (typeof currentSchema.minimum === 'number' && next < currentSchema.minimum) {
        next = currentSchema.minimum;
        warnings.push({ path, code: 'clamped', message: `已收敛到最小值 ${currentSchema.minimum}` });
      }
      if (typeof currentSchema.maximum === 'number' && next > currentSchema.maximum) {
        next = currentSchema.maximum;
        warnings.push({ path, code: 'clamped', message: `已收敛到最大值 ${currentSchema.maximum}` });
      }
      return next;
    }

    if (typeof value === 'string') {
      if (typeof currentSchema.minLength === 'number' && value.length < currentSchema.minLength) {
        issues.push(issue(path, 'minLength', `长度不能小于 ${currentSchema.minLength}`));
      }
      return value;
    }

    if (Array.isArray(value)) {
      if (typeof currentSchema.minItems === 'number' && value.length < currentSchema.minItems) {
        issues.push(issue(path, 'minItems', `至少需要 ${currentSchema.minItems} 项`));
      }
      let items = value.map((item, index) => currentSchema.items
        ? normalize(currentSchema.items, item, `${path}[${index}]`)
        : item);
      if (typeof currentSchema.maxItems === 'number' && items.length > currentSchema.maxItems) {
        items = items.slice(0, currentSchema.maxItems);
        warnings.push({ path, code: 'truncated', message: `已截断到最多 ${currentSchema.maxItems} 项` });
      }
      return items;
    }

    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const known = new Set(Object.keys(currentSchema.properties || {}));
      const result: Record<string, unknown> = {};
      for (const key of Array.isArray(currentSchema.required) ? currentSchema.required : []) {
        if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
          issues.push(issue(`${path}.${key}`, 'required', '缺少必填参数'));
        }
      }
      for (const [key, childSchema] of Object.entries(currentSchema.properties || {})) {
        if (obj[key] !== undefined) result[key] = normalize(childSchema, obj[key], `${path}.${key}`);
      }
      for (const [key, childValue] of Object.entries(obj)) {
        if (known.has(key)) continue;
        if (currentSchema.additionalProperties === false) {
          issues.push(issue(`${path}.${key}`, 'additional', '不允许的额外参数'));
        } else if (currentSchema.additionalProperties && typeof currentSchema.additionalProperties === 'object') {
          result[key] = normalize(currentSchema.additionalProperties, childValue, `${path}.${key}`);
        } else {
          result[key] = childValue;
        }
      }
      return result;
    }
    return value;
  };

  const normalized = normalize(schema, args, basePath);
  return { ok: issues.length === 0, args: normalized, issues, warnings };
}