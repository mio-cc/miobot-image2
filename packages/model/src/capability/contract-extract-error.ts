/**
 * 从上游错误里提取「哪个参数被拒、合法值是什么」（2026-11-19）。
 *
 * healing.ts 原来只有三条英文正则 + 只看 error.message 文本，四类常见形态全漏：
 *   1. FastAPI / pydantic 的 detail[].loc —— fal 与大量自建网关都是这形状，
 *      参数路径写在结构化字段里，比正文可靠得多，我们却完全没读；
 *   2. 中文网关的「尺寸参数不合格」「size 参数不合法」—— 一条都匹配不上，
 *      于是每次请求重复同一个错，日志里就是「连续几次出现尺寸参数不合格」；
 *   3. Anthropic 的 error.type；
 *   4. 枚举错误里上游已列举合法值（literal_error），我们拿不到清单就只能 drop。
 *
 * 本文件只做「提取」，不决定怎么修；修法由 healing.ts 决定。
 */

export interface ParamRejection {
  param: string;
  /** 参数路径，例如 ['body','image_size']；用于排障与嵌套参数。 */
  path: string[];
  valueCandidates?: string[];
  renameTo?: string;
  shape: 'openai' | 'fastapi' | 'anthropic' | 'chinese' | 'text';
  evidence: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 从 literal_error 的 msg 里抠 'a','b','c' 候选值。 */
function literalCandidatesFromMessage(message: string): string[] | undefined {
  const quoted = Array.from(String(message || '').matchAll(/['"]([A-Za-z0-9_.\- :/]{1,40})['"]/g)).map((item) => item[1].trim()).filter(Boolean);
  const unique = Array.from(new Set(quoted));
  return unique.length ? unique : undefined;
}

/** 从英文句子找「must be one of / allowed values」后面的候选值。 */
function candidatesFromProse(text: string): string[] | undefined {
  const match = /(?:must be one of|one of|allowed values?|supported values?|取值(?:必须)?(?:是|为)|必须是|只能是|可选值)[：:\s]*([^\n。]{1,200})/i.exec(String(text || ''));
  if (!match) return undefined;
  const raw = match[1];
  const quoted = Array.from(raw.matchAll(/['"]([^'"]{1,40})['"]/g)).map((item) => item[1].trim());
  if (quoted.length) return Array.from(new Set(quoted));
  const tokens = raw.split(/[,，、/|]\s*/).map((item) => item.trim()).filter((item) => /^[A-Za-z0-9_.\-: x]{1,40}$/.test(item));
  return tokens.length > 1 ? tokens : undefined;
}

/** 中文枚举列举：1024x1024、1024x1536 或 auto。 */
function candidatesFromChineseProse(text: string): string[] | undefined {
  const match = /(?:必须是|只能是|可选值|支持|取值)\s*[：:]?\s*([^\n。；]{1,120})/i.exec(String(text || ''));
  if (!match) return undefined;
  const tokens = match[1]
    .replace(/之一|中的一个|等/g, '')
    .split(/[,，、/|]\s*|\s+或\s+/)
    .map((item) => item.trim().replace(/^['"「]|['"」]$/g, ''))
    .filter((item) => /^[A-Za-z0-9_.\-: x]{1,40}$/.test(item));
  return tokens.length > 1 ? tokens : undefined;
}

/** OpenAI 形态：{ error: { message, param } } */
function fromOpenAi(payload: Record<string, unknown>, evidence: (text: string) => string): ParamRejection | undefined {
  const error = asRecord(payload.error);
  if (!error) return undefined;
  const message = String(error.message || '');
  const param = String(error.param || '').trim();
  if (param) {
    return {
      param,
      path: param.split('.').filter(Boolean),
      // 只认「must be one of / allowed values」这类明确列举；
      // 不能用「所有引号里的词」——那会把参数名本身当成候选值（实测回归）。
      valueCandidates: candidatesFromProse(message),
      renameTo: /use\s+['"]([A-Za-z0-9_.]+)['"]\s+instead/i.exec(message)?.[1],
      shape: 'openai',
      evidence: evidence(message),
    };
  }
  const named = /(?:unsupported|unknown|unrecognized|invalid|not supported)\s+(?:request\s+)?(?:parameter|argument|field|property)[^'"]*['"]([A-Za-z0-9_.]+)['"]/i.exec(message)
    || /['"]([A-Za-z0-9_.]+)['"]\s+is\s+(?:not\s+supported|unsupported|invalid|unknown)/i.exec(message);
  if (!named) return undefined;
  return {
    param: named[1],
    path: [named[1]],
    valueCandidates: candidatesFromProse(message),
    renameTo: /use\s+['"]([A-Za-z0-9_.]+)['"]\s+instead/i.exec(message)?.[1],
    shape: 'openai',
    evidence: evidence(message),
  };
}

/**
 * FastAPI / pydantic：{ detail: [ { loc: ['body','image_size','ImageSize'], msg, type } ] }
 * loc 第一段常是 body/query/path，跳过；数字下标也跳过，取最近的字符串段。
 */
function fromFastApi(payload: Record<string, unknown>, evidence: (text: string) => string): ParamRejection | undefined {
  const detail = payload.detail;
  if (!Array.isArray(detail) || !detail.length) return undefined;
  for (const item of detail) {
    const entry = asRecord(item);
    if (!entry) continue;
    const loc = Array.isArray(entry.loc) ? entry.loc.map(String) : [];
    // loc 里除了 body + 参数名，还可能带类型描述（fal 会把枚举塞进 loc：
    // ['body','image_size',"literal['square_hd',...]"]）。只保留真正的参数路径段。
    const path = loc.filter((segment) =>
      !/^\d+$/.test(segment)
      && !['body', 'query', 'path', 'header'].includes(segment)
      && !/^literal\[/.test(segment)
      && !/\[.*\]/.test(segment));
    if (!path.length) continue;
    const message = String(entry.msg || '');
    const type = String(entry.type || '');
    const isLiteral = type.includes('literal') || type.includes('enum');
    return {
      param: path[0],
      path,
      valueCandidates: isLiteral ? literalCandidatesFromMessage(message) : candidatesFromProse(message),
      shape: 'fastapi',
      evidence: evidence(JSON.stringify({ loc: entry.loc, msg: message, type })),
    };
  }
  return undefined;
}
/** Anthropic 形态：{ error: { type: 'invalid_request_error', message } }，参数名只能在正文找。 */
function fromAnthropic(payload: Record<string, unknown>, body: Record<string, unknown>, evidence: (text: string) => string): ParamRejection | undefined {
  const error = asRecord(payload.error);
  if (!error) return undefined;
  const type = String(error.type || '');
  if (!/invalid_request/i.test(type)) return undefined;
  const message = String(error.message || '');
  const named = /(?:unexpected|unknown|unrecognized|extra|not permitted)[^:\n]*[:\s]\s*['"]?([A-Za-z0-9_.]+)['"]?/i.exec(message)
    || /['"]?([A-Za-z0-9_.]+)['"]?\s*:\s*extra inputs are not permitted/i.exec(message);
  if (!named) return undefined;
  const key = Object.keys(body).find((item) => item.toLowerCase() === named[1].toLowerCase()) || named[1];
  return {
    param: key,
    path: [key],
    valueCandidates: candidatesFromProse(message),
    shape: 'anthropic',
    evidence: evidence(message),
  };
}

/**
 * 中文形态。已覆盖句式（新增请同步扩测试）：
 *   不支持的参数 xxx / 未知参数 xxx / 缺少参数 xxx / 多余的参数 xxx
 *   参数 xxx 不合法 / 参数 xxx 取值必须是 a、b、c
 *   size 参数不合法 / 尺寸参数不合格
 *   xxx 必须是 a/b/c 之一
 * 只有中文词没有英文参数名时，按 CHINESE_FIELD_HINTS 映射，且必须真的在请求体里。
 */
const CHINESE_PARAM_PATTERNS: RegExp[] = [
  /(?:不支持|未知|无法识别|多余|缺少|缺失)的?(?:请求)?参数\s*[：:]?\s*['"「]?([A-Za-z0-9_.]+)/,
  /参数\s*['"「]?([A-Za-z0-9_.]+)['"」]?\s*(?:不合法|无效|非法|错误|超出范围|取值)/,
  /['"「]?([A-Za-z0-9_.]+)['"」]?\s*参数\s*(?:不合法|无效|非法|不合格|错误)/,
];

const CHINESE_FIELD_HINTS: Array<{ regex: RegExp; field: string }> = [
  { regex: /尺寸|画幅|分辨率|宽高/, field: 'size' },
  { regex: /质量|画质|精细度/, field: 'quality' },
  { regex: /张数|数量/, field: 'n' },
  { regex: /提示词|描述词/, field: 'prompt' },
  { regex: /格式|编码/, field: 'output_format' },
  { regex: /背景/, field: 'background' },
  { regex: /参考图|图片|图像/, field: 'image_urls' },
];

function fromChinese(text: string, body: Record<string, unknown>, evidence: (text: string) => string): ParamRejection | undefined {
  for (const regex of CHINESE_PARAM_PATTERNS) {
    const match = regex.exec(text);
    if (!match) continue;
    const key = Object.keys(body).find((item) => item.toLowerCase() === match[1].toLowerCase()) || match[1];
    return {
      param: key,
      path: [key],
      valueCandidates: candidatesFromProse(text) || candidatesFromChineseProse(text),
      shape: 'chinese',
      evidence: evidence(match[0]),
    };
  }
  for (const hint of CHINESE_FIELD_HINTS) {
    if (!hint.regex.test(text)) continue;
    if (!/(?:不合格|不合法|无效|非法|错误|不支持)/.test(text)) continue;
    const key = Object.keys(body).find((item) => item.toLowerCase() === hint.field.toLowerCase());
    if (!key) continue;
    return {
      param: key,
      path: [key],
      valueCandidates: candidatesFromChineseProse(text),
      shape: 'chinese',
      evidence: evidence(String(text).slice(0, 200)),
    };
  }
  return undefined;
}

/** 纯英文正文兜底（保持原有行为，避免回归）。 */
function fromFreeText(text: string, body: Record<string, unknown>, evidence: (text: string) => string): ParamRejection | undefined {
  const patterns = [
    /(?:unsupported|unknown|unrecognized|invalid|not supported)\s+(?:request\s+)?(?:parameter|argument|field|property)[^'"]*['"]([A-Za-z0-9_.]+)['"]/i,
    /['"]([A-Za-z0-9_.]+)['"]\s+is\s+(?:not\s+supported|unsupported|invalid|unknown)/i,
    /(?:parameter|field)\s+([A-Za-z0-9_.]+)\s+(?:is\s+)?(?:not\s+allowed|not\s+supported|unknown)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const key = Object.keys(body).find((item) => item.toLowerCase() === match[1].toLowerCase());
    if (!key) continue;
    return {
      param: key,
      path: [key],
      valueCandidates: candidatesFromProse(text),
      renameTo: /use\s+['"]([A-Za-z0-9_.]+)['"]\s+instead/i.exec(text)?.[1],
      shape: 'text',
      evidence: evidence(match[0]),
    };
  }
  const valueRejected = /['"]?\b(n|size|quality|response_format|reasoning_effort|temperature|top_p|image_size)\b['"]?[^.]{0,80}?(?:must be|only supports?|invalid value|unsupported value|not valid)/i.exec(text);
  if (valueRejected) {
    const key = Object.keys(body).find((item) => item.toLowerCase() === valueRejected[1].toLowerCase());
    if (key) {
      return {
        param: key,
        path: [key],
        valueCandidates: candidatesFromProse(text),
        shape: 'text',
        evidence: evidence(valueRejected[0]),
      };
    }
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

/**
 * 统一入口。优先级：结构化字段（OpenAI.param / FastAPI.loc）> Anthropic > 中文 > 英文正文。
 * 结构化优先：正文各家中转改写得很乱，字段是机器写的，几乎不会错。
 */
export function extractParamRejection(status: number, payload: unknown, body?: unknown): ParamRejection | undefined {
  const code = Number(status);
  if (![400, 404, 405, 415, 422, 500, 501].includes(code)) return undefined;
  const record = asRecord(payload);
  const requestBody = asRecord(body) || {};
  const evidence = (text: string) => String(text || '').replace(/\s+/g, ' ').slice(0, 240);

  if (record) {
    const openai = fromOpenAi(record, evidence);
    if (openai) return openai;
    const fastapi = fromFastApi(record, evidence);
    if (fastapi) return fastapi;
    const anthropic = fromAnthropic(record, requestBody, evidence);
    if (anthropic) return anthropic;
  }

  const text = safeStringify(payload);
  if (!text) return undefined;
  const chinese = fromChinese(text, requestBody, evidence);
  if (chinese) return chinese;
  return fromFreeText(text, requestBody, evidence);
}
