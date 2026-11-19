/**
 * 从「上游公开的结构化描述」提取参数契约（2026-11-19）。
 *
 * 全部是纯函数：不发网络、不读配置、不写盘。调用方负责取 HTML/YAML 并决定何时落盘。
 *
 * 为什么可行（已实测）：
 * · fal 的模型文档页 https://fal.ai/models/<model>/api 的 RSC 流里嵌着完整 OpenAPI 3.1：
 *     self.__next_f.push([1,"…{\"openapi\":{…components.schemas…}}…"])
 *   实测 gpt-image-2.6 抽出 6.8 KB spec，含 GPTImage26TextToImageRequest / ImageSize。
 * · OpenAI 官方 https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml
 *   公开可下，CreateImageRequest 里含 quality/size/background/output_format 等完整枚举。
 *
 * 局限（写清楚，避免过度承诺）：
 * · fal 的数值约束（16 的倍数 / 边 3840 / 像素预算）在 description 散文里，
 *   正则可以覆盖常见句式，长尾句式仍需主脑读一次。
 * · OpenAI yaml 只做「CreateImageRequest 这一个 schema」的受限解析，不是通用 YAML 解析器。
 */
import type { ContractSource, ModelParamContract, ParamSizeObjectLimits, ParamSpec } from './contract.js';
import { createContract } from './contract.js';

/* ═══════════ fal：RSC → OpenAPI ═══════════ */

/**
 * 从 Next.js RSC 流里抽出内嵌的 OpenAPI spec。
 * 取不到返回 undefined（调用方降级），不抛异常。
 */
export function extractFalSpecFromHtml(html: string): Record<string, unknown> | undefined {
  const source = String(html || '');
  const chunk = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = chunk.exec(source))) {
    try { parts.push(String(JSON.parse(match[1]))); } catch { /* 单块坏了跳过 */ }
  }
  if (!parts.length) return undefined;
  const rsc = parts.join('');
  const start = rsc.indexOf('{"openapi"');
  if (start < 0) return undefined;
  // 平衡括号截取（跳过字符串内的括号）
  let depth = 0;
  let end = -1;
  for (let i = start; i < rsc.length; i += 1) {
    const ch = rsc[i];
    if (ch === '"') {
      i += 1;
      while (i < rsc.length && rsc[i] !== '"') { if (rsc[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end <= start) return undefined;
  try {
    const root = JSON.parse(rsc.slice(start, end)) as Record<string, unknown>;
    const inner = root.openapi;
    return inner && typeof inner === 'object' ? inner as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/* ═══════════ 通用：OpenAPI → 契约 ═══════════ */

interface OpenApiLike {
  components?: { schemas?: Record<string, Record<string, unknown>> };
  paths?: Record<string, Record<string, unknown>>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function schemaNameOfRef(ref: unknown): string | undefined {
  const text = String(ref || '');
  const index = text.lastIndexOf('/');
  return index >= 0 ? text.slice(index + 1) : undefined;
}

/**
 * 找请求体主 schema：优先 paths 里 requestBody 的 $ref，
 * 其次按名字猜 *Request / *Input（fal 两种都出现过）。
 */
export function findRequestSchemaName(spec: OpenApiLike): string | undefined {
  const schemas = spec.components?.schemas || {};
  for (const pathItem of Object.values(spec.paths || {})) {
    const post = asRecord(asRecord(pathItem)?.post);
    const requestBody = asRecord(post?.requestBody);
    const content = asRecord(requestBody?.content);
    const media = asRecord(content?.['application/json']);
    const ref = schemaNameOfRef(asRecord(media?.schema)?.$ref);
    if (ref && schemas[ref]) return ref;
  }
  const names = Object.keys(schemas);
  return names.find((name) => /Request$/i.test(name))
    || names.find((name) => /Input$/i.test(name));
}

function resolveRef(spec: OpenApiLike, ref: unknown): Record<string, unknown> | undefined {
  const name = schemaNameOfRef(ref);
  if (!name) return undefined;
  return asRecord(spec.components?.schemas?.[name]);
}

/** 从 $ref 目标推断是不是 size 对象（有 width/height 两个整数字段）。 */
function sizeObjectLimitsOf(target: Record<string, unknown> | undefined): ParamSizeObjectLimits | undefined {
  const props = asRecord(target?.properties);
  if (!props) return undefined;
  const width = asRecord(props.width);
  const height = asRecord(props.height);
  if (!width || !height) return undefined;
  const limits: ParamSizeObjectLimits = {};
  const maxOf = Math.max(Number(width.maximum) || 0, Number(height.maximum) || 0);
  if (maxOf > 0) limits.maxEdge = maxOf;
  return limits;
}

/** 把 OpenAPI 的单个 property 转成 ParamSpec。 */
export function paramSpecFromOpenApiProperty(
  spec: OpenApiLike,
  property: Record<string, unknown>,
  prose?: string,
): ParamSpec {
  const description = typeof property.description === 'string' ? property.description : undefined;
  const enumValues = Array.isArray(property.enum) ? property.enum.map(String) : undefined;
  const type = typeof property.type === 'string' ? property.type : undefined;

  // anyOf：fal 的 image_size = ImageSize($ref) ∨ enum[string]
  const anyOf = Array.isArray(property.anyOf) ? property.anyOf.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  if (anyOf.length) {
    const enumBranch = anyOf.find((branch) => Array.isArray(branch.enum));
    const refBranch = anyOf.find((branch) => typeof branch.$ref === 'string');
    if (refBranch) {
      const target = resolveRef(spec, refBranch.$ref);
      const sizeLimits = sizeObjectLimitsOf(target);
      if (sizeLimits || /ImageSize/i.test(String(refBranch.$ref))) {
        const combined = { ...(sizeLimits || {}) };
        const proseLimits = parseSizeProse(String(property.description || '')).limits;
        Object.assign(combined, proseLimits);
        return {
          kind: 'size',
          ...(enumBranch && Array.isArray(enumBranch.enum) ? { enum: enumBranch.enum.map(String) } : {}),
          ...(description ? { description } : {}),
          size: combined,
        };
      }
    }
    const firstTyped = anyOf.find((branch) => typeof branch.type === 'string');
    if (firstTyped && !enumBranch) {
      return { kind: kindOfType(String(firstTyped.type)), ...(description ? { description } : {}) };
    }
  }

  if (typeof property.$ref === 'string') {
    const target = resolveRef(spec, property.$ref);
    const sizeLimits = sizeObjectLimitsOf(target);
    if (sizeLimits) {
      return { kind: 'size', size: { ...sizeLimits, ...parseSizeProse(String(property.description || prose || '')).limits }, ...(description ? { description } : {}) };
    }
    const targetProps = asRecord(target?.properties);
    if (targetProps) {
      const props: Record<string, ParamSpec> = {};
      for (const [name, value] of Object.entries(targetProps)) {
        const record = asRecord(value);
        if (record) props[name] = paramSpecFromOpenApiProperty(spec, record);
      }
      return { kind: 'object', props };
    }
    return { kind: 'object' };
  }

  if (enumValues && enumValues.length) {
    return { kind: 'enum', enum: enumValues, ...(description ? { description } : {}), ...(property.default !== undefined ? { default: property.default } : {}) };
  }
  if (type === 'array') {
    const items = asRecord(property.items);
    return { kind: 'array', ...(items ? { items: paramSpecFromOpenApiProperty(spec, items) } : {}), ...(description ? { description } : {}) };
  }
  if (type === 'integer') {
    return {
      kind: 'int',
      ...(Number.isFinite(Number(property.minimum)) ? { min: Number(property.minimum) } : {}),
      ...(Number.isFinite(Number(property.maximum)) ? { max: Number(property.maximum) } : {}),
      ...(description ? { description } : {}),
      ...(property.default !== undefined ? { default: property.default } : {}),
    };
  }
  if (type === 'number') {
    return { kind: 'number', ...(description ? { description } : {}), ...(property.default !== undefined ? { default: property.default } : {}) };
  }
  if (type === 'boolean') return { kind: 'bool', ...(description ? { description } : {}) };
  if (type === 'string') {
    return { kind: property.format === 'uri' ? 'url' : 'string', ...(description ? { description } : {}), ...(property.default !== undefined ? { default: property.default } : {}) };
  }
  return { kind: 'string', ...(description ? { description } : {}) };
}

function kindOfType(type: string): ParamSpec['kind'] {
  if (type === 'integer') return 'int';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'bool';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'string';
}

/* ═══════════ 文档散文里的数值约束 ═══════════ */

export interface ParsedSizeProse {
  matched: string[];
  limits: ParamSizeObjectLimits;
}

/**
 * 从散文里抠数值约束。已覆盖的句式（fal gpt-image-2.6 的真实原文即命中前四条）：
 *   "both dimensions as multiples of 16"
 *   "max edge 3840px"
 *   "aspect ratio <= 3:1"
 *   "total pixels between 655,360 and 8,294,400"
 * 未覆盖的长尾句式由主脑读一次补进契约（notes 里会留痕）。
 */
export function parseSizeProse(text: string): ParsedSizeProse {
  const prose = String(text || '');
  const limits: ParamSizeObjectLimits = {};
  const matched: string[] = [];

  const multiple = prose.match(/multiple[s]?\s+of\s+(\d+)/i);
  if (multiple) { limits.multipleOf = Number(multiple[1]); matched.push(multiple[0]); }

  const maxEdge = prose.match(/max(?:imum)?\s+(?:edge|side)\s+(?:of\s+)?(\d+)\s*px/i);
  if (maxEdge) { limits.maxEdge = Number(maxEdge[1]); matched.push(maxEdge[0]); }

  const aspect = prose.match(/aspect\s+ratio\s*(?:<=|≤|max(?:imum)?\s*(?:of)?)\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  if (aspect) {
    const long = Number(aspect[1]);
    const short = Number(aspect[2]) || 1;
    if (long > 0 && short > 0) { limits.aspectMax = long / short; matched.push(aspect[0]); }
  }

  const pixels = prose.match(/(?:total\s+)?pixels?\s+between\s+([\d,]+)\s+and\s+([\d,]+)/i);
  if (pixels) {
    limits.pixels = {
      min: Number(pixels[1].replace(/,/g, '')),
      max: Number(pixels[2].replace(/,/g, '')),
    };
    matched.push(pixels[0]);
  }

  return { matched, limits };
}

/** 把散文约束合并进契约里所有 kind=size 的参数，返回命中的参数名。 */
export function applyDescriptionConstraints(
  contract: ModelParamContract,
  prose: string,
): { contract: ModelParamContract; appliedTo: string[]; matched: string[] } {
  const parsed = parseSizeProse(prose);
  if (!parsed.matched.length) return { contract, appliedTo: [], matched: [] };
  const appliedTo: string[] = [];
  const params: Record<string, ParamSpec> = { ...contract.params };
  for (const [name, spec] of Object.entries(params)) {
    if (spec.kind !== 'size') continue;
    params[name] = { ...spec, size: { ...(spec.size || {}), ...parsed.limits } };
    appliedTo.push(name);
  }
  if (!appliedTo.length) return { contract, appliedTo, matched: parsed.matched };
  return { contract: { ...contract, params }, appliedTo, matched: parsed.matched };
}

/* ═══════════ OpenAPI → 契约 ═══════════ */

export function contractFromOpenApi(
  spec: unknown,
  options: { key: string; model: string; op: string; source?: ContractSource; now?: Date },
): ModelParamContract | undefined {
  const openapi = asRecord(spec) as OpenApiLike | undefined;
  if (!openapi) return undefined;
  const schemaName = findRequestSchemaName(openapi);
  if (!schemaName) return undefined;
  const schema = asRecord(openapi.components?.schemas?.[schemaName]);
  const properties = asRecord(schema?.properties);
  if (!schema || !properties) return undefined;

  const params: Record<string, ParamSpec> = {};
  for (const [name, value] of Object.entries(properties)) {
    const record = asRecord(value);
    if (!record) continue;
    params[name] = paramSpecFromOpenApiProperty(openapi, record);
  }
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const name of required) {
    if (params[name]) params[name] = { ...params[name], required: true };
  }

  const notes: string[] = [];
  // output_compression 只在 jpeg/webp 下有效（两份 spec 都这么写）
  if (params.output_compression && params.output_format) {
    params.output_compression = { ...params.output_compression, onlyFor: { param: 'output_format', values: ['jpeg', 'webp'] } };
    notes.push('output_compression 仅在 output_format=jpeg|webp 时下发');
  }

  return createContract({
    key: options.key,
    model: options.model,
    op: options.op,
    source: options.source || 'schema',
    params,
    required,
    notes: [schemaName + ' from OpenAPI', ...notes],
    now: options.now,
  });
}

/* ═══════════ OpenAI 官方 yaml（受限解析） ═══════════ */

/**
 * 只解析 `CreateImageRequest:` 这一个 schema 的 properties。
 * 不引入 YAML 依赖：按缩进切块，只认 enum / minimum / maximum / default / description。
 * 明确局限：嵌套 anyOf 只挖 enum 与 minimum/maximum；不处理锚点/多文档。
 */
/**
 * 收集 yaml 里 components.schemas 下每个 schema 的 enum 列表。
 * 官方 yaml 大量用 $ref: "#/components/schemas/ImagesApiOutputFormat" 这种引用，
 * 不解析的话 output_format 这类参数就拿不到枚举（实测确实如此）。
 * 只认「schema 名 + 直接子级 enum」，不处理嵌套引用链。
 */
/**
 * 收集 yaml 里 components.schemas 下每个 schema 的完整块（名字 -> 块文本）。
 * 缩进不写死：从 schemas: 那一行的缩进推导（官方 yaml 里 schemas 在 2 空格、名字在 4 空格）。
 */
export function collectYamlSchemas(yamlText: string): Record<string, string> {
  const text = String(yamlText || '');
  const out: Record<string, string> = {};
  const schemasLine = /^( *)(schemas):\s*$/m.exec(text);
  if (!schemasLine) return out;
  const schemasIndent = schemasLine[1].length;
  const body = text.slice(schemasLine.index + schemasLine[0].length);
  const nameIndent = ' '.repeat(schemasIndent + 2);
  const headerRe = new RegExp('(^|\\n)' + nameIndent + '([A-Za-z][A-Za-z0-9_]*):\\s*$', 'gm');
  const marks: Array<{ name: string; index: number; length: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(body))) marks.push({ name: m[2], index: m.index, length: m[0].length });
  for (let i = 0; i < marks.length; i += 1) {
    const from = marks[i].index + marks[i].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : body.length;
    out[marks[i].name] = body.slice(from, to);
  }
  return out;
}

/** 兼容旧名：只要枚举。 */
export function collectYamlSchemaEnums(yamlText: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, block] of Object.entries(collectYamlSchemas(yamlText))) {
    const values = enumValuesFromBlock(block);
    if (values.length) out[name] = values;
  }
  return out;
}

/** 从 yaml 片段里取 $ref 指向的 schema 名。 */
function yamlRefName(body: string): string | undefined {
  const m = body.match(/\$ref:\s*"?[^"\n]*\/components\/schemas\/([A-Za-z0-9_]+)"?/);
  return m ? m[1] : undefined;
}

/** 从一个 yaml 片段里读 kind/enum/min/max/default；$ref 会跟一层。 */
/**
 * 只从 enum: 子块收集枚举值。
 * 之前直接用「所有 - xxx 行」，会把 type 列表里的 - integer / - "null" 也当枚举——
 * 结果 n 被解析成 enum[integer|null]，kind 判断全错（实测踩到）。
 */
function enumValuesFromBlock(body: string): string[] {
  const text = String(body || '');
  const inline = /^\s*enum:\s*\[(.*)\]\s*$/m.exec(text);
  if (inline) {
    return inline[1].split(',').map((v) => v.trim().replace(/^[\x27\x22]|[\x27\x22]$/g, '')).filter(Boolean);
  }
  const marker = /^( *)enum:\s*$/m.exec(text);
  if (!marker) return [];
  const enumIndent = marker[1].length;
  const after = text.slice(marker.index + marker[0].length);
  const values: string[] = [];
  for (const line of after.split('\n')) {
    if (!line.trim()) continue;
    const indent = (line.match(/^ */) || [''])[0].length;
    if (indent <= enumIndent) break;
    const item = line.match(/^\s*-\s+(\S.*)$/);
    if (!item) break;
    const value = item[1].trim().replace(/^[\x27\x22]|[\x27\x22]$/g, '');
    // null/None 是 type 联合的回声（例如 complexity 的 enum 里带 null），不是可选值。
    if (value && value !== 'null' && value !== 'None') values.push(value);
  }
  return values;
}
function yamlSpecFromBlock(block: string, schemas: Record<string, string>, depth = 0): ParamSpec {
  const body = String(block || '');
  const refName = yamlRefName(body);
  if (refName && depth < 2 && schemas[refName]) {
    const inner = yamlSpecFromBlock(schemas[refName], schemas, depth + 1);
    const selfMin = body.match(/minimum:\s*(-?\d+(?:\.\d+)?)/);
    const selfMax = body.match(/maximum:\s*(-?\d+(?:\.\d+)?)/);
    const selfDefault = body.match(/default:\s*(\S+)/);
    return {
      ...inner,
      ...(selfMin ? { min: Number(selfMin[1]) } : {}),
      ...(selfMax ? { max: Number(selfMax[1]) } : {}),
      ...(selfDefault ? { default: selfDefault[1].replace(/^[\x27\x22]|[\x27\x22]$/g, '') } : {}),
    };
  }
  const enumValues = enumValuesFromBlock(body);
  if (enumValues.length) return { kind: 'enum', enum: enumValues };
  const minMatch = body.match(/minimum:\s*(-?\d+(?:\.\d+)?)/);
  const maxMatch = body.match(/maximum:\s*(-?\d+(?:\.\d+)?)/);
  const typeMatch = body.match(/type:\s*\n?\s*-?\s*"?([a-z]+)"?/);
  const kind = kindOfType(String(typeMatch && typeMatch[1] ? typeMatch[1] : (minMatch || maxMatch ? 'integer' : 'string')));
  const spec: ParamSpec = { kind };
  if (minMatch) spec.min = Number(minMatch[1]);
  if (maxMatch) spec.max = Number(maxMatch[1]);
  return spec;
}

export function extractOpenAiYamlContract(
  yamlText: string,
  options?: { key?: string; model?: string; op?: string; now?: Date },
): ModelParamContract | undefined {
  const text = String(yamlText || '');
  // 缩进不写死：从 CreateImageRequest 这一行的实际缩进推导出 properties / property 的层级。
  // （官方 yaml 里它在 components.schemas 下是 6 空格，测试/别的分支可能是 4 空格。）
  const headerMatch = /^( *)([A-Za-z][A-Za-z0-9_]*):\s*$/m.exec(text);
  const schemaLine = /^( *)(CreateImageRequest):\s*$/m.exec(text);
  if (!schemaLine) return undefined;
  const schemaIndent = schemaLine[1].length;
  const rest = text.slice(schemaLine.index + schemaLine[0].length);
  // 下一个同级 schema（缩进 == schemaIndent）为边界
  const siblingPattern = new RegExp('\\n' + ' '.repeat(schemaIndent) + '[A-Za-z][A-Za-z0-9_]*:\\s*$', 'm');
  const sibling = siblingPattern.exec(rest);
  const block = sibling && sibling.index > 0 ? rest.slice(0, sibling.index) : rest;
  const propertiesIndent = ' '.repeat(schemaIndent + 2);
  const propsMarker = '\n' + propertiesIndent + 'properties:';
  const propsIndex = block.indexOf(propsMarker);
  if (propsIndex < 0) return undefined;
  const propsBlock = block.slice(propsIndex + propsMarker.length);
  const propIndentLen = schemaIndent + 4;
  const headerRe = new RegExp('(^|\\n)' + ' '.repeat(propIndentLen) + '([A-Za-z_][A-Za-z0-9_]*):\\s*\\n', 'g');
  const marks: Array<{ name: string; index: number; length: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(propsBlock))) {
    marks.push({ name: match[2], index: match.index, length: match[0].length });
  }
  if (!marks.length) return undefined;
  const schemas = collectYamlSchemas(text);
  const params: Record<string, ParamSpec> = {};
  const notes: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const from = marks[i].index + marks[i].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : propsBlock.length;
    const body = propsBlock.slice(from, to);
    const name = marks[i].name;
    const spec = yamlSpecFromBlock(body, schemas);
    const flat = body.replace(/\s+/g, ' ');
    const description = String((/description: ?(.{0,400})/.exec(flat) || ['', ''])[1] || '').trim();
    if (description) spec.description = description;
    const defaultMatch = body.match(/default:\s*(\S+)/);
    if (defaultMatch && spec.default === undefined) spec.default = defaultMatch[1].replace(/^[\x27\x22]|[\x27\x22]$/g, '');
    params[name] = spec;
  }
  if (!params.prompt) notes.push('未解析到 prompt 字段，可能 yaml 结构变了');

  return createContract({
    key: options?.key || 'openai|https://api.openai.com/v1::official::create-image-request',
    model: options?.model || 'openai-create-image-request',
    op: options?.op || 'image.generate',
    source: 'schema',
    params,
    required: ['prompt', 'model'].filter((name) => Boolean(params[name])),
    notes: ['CreateImageRequest from openai-openapi.yaml（受限解析）', ...notes],
    now: options?.now,
  });
}
