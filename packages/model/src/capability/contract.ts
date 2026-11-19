/**
 * 模型参数契约（2026-11-19）。
 *
 * 解决的问题：以前「这个模型支持哪些参数、取值是什么、尺寸约束是多少」全靠
 * profiles.ts 里的正则猜 + 硬编码白名单。猜错的表现有两种：
 *   · 发出去被拒（尺寸参数不合格 / 400 / 422），且中文报错对自愈不可见 → 每次重复同一个错
 *   · 静默丢弃（1152x1536 对 gpt-image 不在白名单里 → delete size → 用户选的画幅没了）
 *
 * 契约把「上游真实的参数面」变成可学习、可持久、可展示的结构：
 *   来源优先级 schema > docs > probe > learned
 *   schema 指 OpenAPI（fal 文档页内嵌 / OpenAI 官方 yaml），能直接给出 enum/type/required/default
 *   docs 指文档散文，数值约束（16 的倍数、边 3840、像素预算）只能从这里读
 *   probe 指 422 探测（无 schema 时的兜底，上游会把合法枚举列出来）
 *   learned 指运行时自愈写入的修正
 */

export type ContractSource = 'schema' | 'docs' | 'probe' | 'learned';

export type ParamKind = 'enum' | 'int' | 'number' | 'string' | 'bool' | 'size' | 'url' | 'array' | 'object';

/** size 参数的对象形态约束（fal 的 image_size: {width, height} 就受这些限制）。 */
export interface ParamSizeObjectLimits {
  /** 宽高必须是该值的倍数。 */
  multipleOf?: number;
  /** 单边最大像素。 */
  maxEdge?: number;
  /** 最大宽高比（长边/短边）。 */
  aspectMax?: number;
  pixels?: { min?: number; max?: number };
}

/** 某个参数在当前契约下的形态。 */
export interface ParamSpec {
  kind: ParamKind;
  required?: boolean;
  /** kind=enum 时的合法取值；kind=size 时表示枚举形态的合法值（如 portrait_4_3）。 */
  enum?: string[];
  min?: number;
  max?: number;
  default?: unknown;
  description?: string;
  /** size 参数的对象形态约束。 */
  size?: ParamSizeObjectLimits;
  /** 条件下发：例如 output_compression 只在 output_format ∈ {jpeg,webp} 时才允许。 */
  onlyFor?: { param: string; values: string[] };
  /** kind=array 时元素形态。 */
  items?: ParamSpec;
  /** kind=object 时的字段表。 */
  props?: Record<string, ParamSpec>;
}

export interface ModelParamContract {
  version: 1;
  /** 与 capabilityKey 同构：dialect|baseUrl::凭据指纹::模型名。 */
  key: string;
  model: string;
  /** 操作：image.generate / image.edit / video.generate / chat … */
  op: string;
  source: ContractSource;
  fetchedAt: string;
  /** 必填参数名（等价于各 ParamSpec.required，单独留一份便于快速判断）。 */
  required: string[];
  params: Record<string, ParamSpec>;
  /**
   * 值映射表：paramName -> { 请求值 -> 应发值 }。
   * 例如 size: { "1152x1536": "1024x1536" }。
   */
  transforms?: Record<string, Record<string, string>>;
  /** 解析过程中的观察（缺 schema、描述未覆盖、被上游纠正过等）。 */
  notes?: string[];
}

export function createContract(init: {
  key: string;
  model: string;
  op: string;
  source: ContractSource;
  params?: Record<string, ParamSpec>;
  required?: string[];
  transforms?: Record<string, Record<string, string>>;
  notes?: string[];
  now?: Date;
}): ModelParamContract {
  const params = init.params || {};
  const required = init.required && init.required.length
    ? [...init.required]
    : Object.entries(params).filter(([, spec]) => spec?.required).map(([name]) => name);
  return {
    version: 1,
    key: init.key,
    model: init.model,
    op: init.op,
    source: init.source,
    fetchedAt: (init.now || new Date()).toISOString(),
    required,
    params,
    ...(init.transforms && Object.keys(init.transforms).length ? { transforms: init.transforms } : {}),
    ...(init.notes && init.notes.length ? { notes: init.notes } : {}),
  };
}

/** 容错解析：字段缺失/类型不对只丢掉那一条，不抛异常。 */
export function parseContract(raw: unknown): ModelParamContract | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const key = String(record.key || '').trim();
  const model = String(record.model || '').trim();
  const op = String(record.op || '').trim();
  if (!key || !model || !op) return undefined;
  const source = String(record.source || '') as ContractSource;
  if (!['schema', 'docs', 'probe', 'learned'].includes(source)) return undefined;
  const params: Record<string, ParamSpec> = {};
  const rawParams = record.params;
  if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    for (const [name, value] of Object.entries(rawParams as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const spec = value as Record<string, unknown>;
      const kind = String(spec.kind || '');
      if (!['enum', 'int', 'number', 'string', 'bool', 'size', 'url', 'array', 'object'].includes(kind)) continue;
      params[name] = { ...(spec as unknown as ParamSpec), kind: kind as ParamKind };
    }
  }
  const required = Array.isArray(record.required) ? record.required.map(String) : [];
  return {
    version: 1,
    key,
    model,
    op,
    source,
    fetchedAt: String(record.fetchedAt || ''),
    required,
    params,
    ...(record.transforms && typeof record.transforms === 'object' && !Array.isArray(record.transforms)
      ? { transforms: record.transforms as Record<string, Record<string, string>> }
      : {}),
    ...(Array.isArray(record.notes) ? { notes: record.notes.map(String) } : {}),
  };
}

/**
 * 合并契约（自愈回写用）。
 * 规则：patch 里出现的参数覆盖 base；transforms 累加；notes 累加去重；
 * source 只在「更可靠」时升级（learned 不会覆盖 schema，避免把实测偶然错误覆盖掉完整参数面）。
 */
export function mergeContract(base: ModelParamContract, patch: Partial<ModelParamContract>): ModelParamContract {
  const rank: Record<ContractSource, number> = { schema: 4, docs: 3, probe: 2, learned: 1 };
  const source = patch.source && rank[patch.source] > rank[base.source] ? patch.source : base.source;
  const params = { ...base.params, ...(patch.params || {}) };
  const transforms: Record<string, Record<string, string>> = { ...(base.transforms || {}) };
  for (const [param, map] of Object.entries(patch.transforms || {})) {
    transforms[param] = { ...(transforms[param] || {}), ...map };
  }
  const notes = Array.from(new Set([...(base.notes || []), ...(patch.notes || [])]));
  return {
    ...base,
    ...patch,
    version: 1,
    key: base.key,
    model: base.model,
    op: base.op,
    source,
    fetchedAt: patch.fetchedAt || base.fetchedAt,
    required: patch.required && patch.required.length ? patch.required : base.required,
    params,
    ...(Object.keys(transforms).length ? { transforms } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** 取某参数的契约；不存在返回 undefined（调用方据此走保守模式）。 */
export function paramSpec(contract: ModelParamContract | undefined, name: string): ParamSpec | undefined {
  return contract?.params?.[name];
}

/** 该参数在契约里是否允许下发。 */
export function allowsParam(contract: ModelParamContract | undefined, name: string): boolean {
  return Boolean(contract?.params?.[name]);
}