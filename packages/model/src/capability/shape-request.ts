/**
 * 请求整形（2026-11-19）。
 *
 * 为什么需要：`client.ts` 原来的 applySizeProfile 只有两级行为——
 *   · profile.sizes 非空且不在白名单 → delete size（静默丢画幅，用户选了竖图出正方）
 *   · profile.sizes 为空（UNKNOWN_PROFILE）→ 原样下发（新网关/新模型名必 400）
 * 两者都不对。改成读参数契约：
 *   · 有契约：按契约的 enum + 对象约束 snap 到合法值，并记 requested → sent 的日志
 *   · 无契约：保守模式，只发 prompt（+ 调用方明确要求的 n），绝不再裸发 size/quality
 *
 * 纯函数，不读配置不发网络，因此可以和面板 dry-run 共用同一份逻辑。
 */
import type { ImageSizeLimits } from './size.js';
import { solveImageSize } from './size.js';
import type { ModelParamContract, ParamSpec } from './contract.js';
import { paramSpec } from './contract.js';

export interface ShapeImageInput {
  model: string;
  prompt: string;
  /** 'WxH' 或 'auto'；预设名由调用方先解析成 WxH。 */
  size?: string;
  count?: number;
  quality?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  reasoningEffort?: string;
}

export interface ShapedImageParams {
  prompt: string;
  size?: string;
  count?: number;
  quality?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  reasoningEffort?: string;
  /** 是否发生了尺寸调整。 */
  snapped: boolean;
  /** 调整原因链（snapped=true 时非空）。 */
  snapReason?: string;
  requestedSize?: string;
  /** 无契约 → 保守模式（只发最小必要参数）。 */
  conservative: boolean;
  /** 因契约不允许而没下发的参数名。 */
  dropped: string[];
  contractSource?: ModelParamContract['source'];
}

/** 契约里代表尺寸的参数名（fal 用 image_size，OpenAI 用 size）。 */
export function sizeParamName(contract: ModelParamContract | undefined): string | undefined {
  if (!contract) return undefined;
  if (contract.params.image_size) return 'image_size';
  if (contract.params.size) return 'size';
  return undefined;
}

function enumValuesOf(spec: ParamSpec | undefined): string[] | undefined {
  if (!spec?.enum?.length) return undefined;
  const filtered = spec.enum.filter((value) => value !== 'auto');
  return filtered.length ? filtered : undefined;
}

function aspectOfSizeString(value: string): number | undefined {
  const match = String(value || '').match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return undefined;
  return Math.max(w, h) / Math.min(w, h);
}

/**
 * 按「带方向的宽高比」找最接近的枚举尺寸。
 *
 * 为什么不能只比 max/min 比例：1152x1536 与 1536x1024 的 max/min 都是 1.5，
 * 用无方向比例会打平，然后按数组顺序选中横版——用户要竖图却给了横图（实测踩到）。
 * 这里用 w/h 的带符号比例：竖图 0.75、横图 1.5，方向不同自然区分开。
 */
export function signedAspect(width: number, height: number): number | undefined {
  if (!width || !height) return undefined;
  return width / height;
}

/** 枚举名 → 带方向比例（portrait_4_3 → 4/3 取倒数 = 0.75；landscape_16_9 → 1.78；square → 1）。 */
export function aspectOfSizeName(name: string): number | undefined {
  const lowered = String(name || '').toLowerCase();
  if (/square/.test(lowered)) return 1;
  const ratio = lowered.match(/(\d+)[_x](\d+)/);
  if (!ratio) return undefined;
  const long = Number(ratio[1]);
  const short = Number(ratio[2]);
  if (!long || !short) return undefined;
  const value = long / short;
  if (/^portrait|_portrait|vertical/.test(lowered)) return 1 / value;
  if (/^landscape|_landscape|horizontal/.test(lowered)) return value;
  // 名字里没有方向词（例如 1024x1536）时按字面顺序，w/h 本身就带方向
  return value;
}

export function nearestSizeEnum(requested: string, candidates: string[]): string | undefined {
  const match = String(requested || '').match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return undefined;
  const target = signedAspect(Number(match[1]), Number(match[2]));
  if (!target) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const aspect = aspectOfSizeName(name);
    if (aspect === undefined) continue;
    const distance = Math.abs(aspect - target);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best?.name;
}

/** 契约里 size 参数的对象约束 → solveImageSize 的 limits。 */
function limitsOf(spec: ParamSpec | undefined): ImageSizeLimits | undefined {
  if (!spec?.size) return undefined;
  const size = spec.size;
  const limits: ImageSizeLimits = {
    ...(size.multipleOf ? { multipleOf: size.multipleOf } : {}),
    ...(size.maxEdge ? { maxEdge: size.maxEdge } : {}),
    ...(size.aspectMax ? { aspectMax: size.aspectMax } : {}),
    ...(size.pixels?.min ? { minPixels: size.pixels.min } : {}),
    ...(size.pixels?.max ? { maxPixels: size.pixels.max } : {}),
  };
  return Object.keys(limits).length ? limits : undefined;
}

/**
 * 把一个可选参数按契约决定发不发、发什么。
 * 契约没有该参数 → dropped；契约有 enum 而值不在枚举内 → dropped（宁可用上游默认也不发非法值）。
 */
function acceptEnum(
  name: string,
  value: unknown,
  contract: ModelParamContract | undefined,
  dropped: string[],
): string | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const spec = paramSpec(contract, name);
  const text = String(value).trim();
  if (!spec) { dropped.push(name); return undefined; }
  const allowed = spec.enum;
  if (allowed && allowed.length && !allowed.includes(text)) { dropped.push(name); return undefined; }
  return text;
}

function acceptInt(
  name: string,
  value: unknown,
  contract: ModelParamContract | undefined,
  dropped: string[],
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  const spec = paramSpec(contract, name);
  if (!spec) { dropped.push(name); return undefined; }
  if (spec.min !== undefined && num < spec.min) { dropped.push(name); return undefined; }
  if (spec.max !== undefined && num > spec.max) { dropped.push(name); return undefined; }
  return Math.trunc(num);
}

/**
 * 核心整形。
 *
 * 保守模式（无契约）下只发：prompt（+ count，因为它是「要几张」而不是格式选项）。
 * 这条规则的意义：换网关/新模型名时不会再因为多发一个 size/quality 而 400。
 */
export function shapeImageParams(input: ShapeImageInput, contract?: ModelParamContract): ShapedImageParams {
  const dropped: string[] = [];
  const conservative = !contract || !sizeParamName(contract);
  const shaped: ShapedImageParams = {
    prompt: String(input.prompt || ''),
    conservative,
    snapped: false,
    dropped,
    ...(contract ? { contractSource: contract.source } : {}),
  };

  // 1) 尺寸
  if (input.size !== undefined && String(input.size).trim() !== '') {
    const requested = String(input.size).trim();
    if (conservative) {
      dropped.push('size');
    } else {
      const paramName = sizeParamName(contract);
      const spec = paramName ? paramSpec(contract, paramName) : undefined;
      // 先查 transforms（历史学到的映射优先，避免每次重新推导）
      const mapped = paramName ? contract?.transforms?.[paramName]?.[requested] : undefined;
      const candidate = mapped || requested;
      const enumCandidates = enumValuesOf(spec);
      if (mapped && enumCandidates?.includes(mapped)) {
        shaped.size = mapped;
        shaped.requestedSize = requested;
        shaped.snapped = mapped !== requested;
        if (shaped.snapped) shaped.snapReason = '使用已学到的映射 ' + requested + ' → ' + mapped;
      } else {
        const solved = solveImageSize(candidate, limitsOf(spec));
        shaped.requestedSize = requested;
        shaped.size = solved.size;
        shaped.snapped = solved.size !== requested;
        if (shaped.snapped) shaped.snapReason = solved.reason;
        // 契约只有枚举形态（没有对象约束）时，按 aspect 找最近的枚举名
        if (enumCandidates?.length && !spec?.size) {
          const nearest = nearestSizeEnum(solved.size, enumCandidates);
          if (nearest) {
            shaped.size = nearest;
            shaped.snapped = nearest !== requested;
            if (shaped.snapped) shaped.snapReason = '契约只接受枚举，' + requested + ' → ' + nearest;
          }
        }
      }
    }
  }

  // 2) 张数：保守模式仍允许（它不是格式选项，且上游普遍接受）
  if (input.count !== undefined) {
    const count = Math.trunc(Number(input.count));
    if (Number.isFinite(count) && count > 0) {
      const spec = paramSpec(contract, 'num_images') || paramSpec(contract, 'n');
      if (conservative || !spec) shaped.count = Math.min(count, 4);
      else if (spec.max !== undefined && count > spec.max) { shaped.count = Math.trunc(spec.max); dropped.push('count>max'); }
      else shaped.count = count;
    }
  }

  // 3) 其余格式参数：保守模式一律不发
  if (input.quality !== undefined) shaped.quality = acceptEnum('quality', input.quality, contract, dropped);
  if (input.background !== undefined) shaped.background = acceptEnum('background', input.background, contract, dropped);
  if (input.outputFormat !== undefined) shaped.outputFormat = acceptEnum('output_format', input.outputFormat, contract, dropped);
  if (input.moderation !== undefined) shaped.moderation = acceptEnum('moderation', input.moderation, contract, dropped);
  if (input.reasoningEffort !== undefined) shaped.reasoningEffort = acceptEnum('reasoning_effort', input.reasoningEffort, contract, dropped);
  if (input.outputCompression !== undefined) shaped.outputCompression = acceptInt('output_compression', input.outputCompression, contract, dropped);

  // onlyFor 条件：output_compression 只在 jpeg/webp 下有效
  const compressionSpec = paramSpec(contract, 'output_compression');
  if (shaped.outputCompression !== undefined && compressionSpec?.onlyFor) {
    const gate = shaped[compressionSpec.onlyFor.param === 'output_format' ? 'outputFormat' : 'outputFormat'];
    if (!gate || !compressionSpec.onlyFor.values.includes(String(gate))) {
      shaped.outputCompression = undefined;
      dropped.push('output_compression(onlyFor)');
    }
  }

  return shaped;
}

/** 供日志/面板用的一行摘要。 */
export function describeShapedParams(shaped: ShapedImageParams): string {
  const parts: string[] = [];
  if (shaped.conservative) parts.push('保守模式（无契约，只发 prompt）');
  if (shaped.requestedSize && shaped.size !== shaped.requestedSize) parts.push('尺寸 ' + shaped.requestedSize + ' → ' + shaped.size);
  else if (shaped.size) parts.push('尺寸 ' + shaped.size);
  if (shaped.count !== undefined) parts.push('张数 ' + shaped.count);
  for (const key of ['quality', 'background', 'outputFormat', 'outputCompression', 'moderation', 'reasoningEffort'] as const) {
    const value = shaped[key];
    if (value !== undefined) parts.push(key + '=' + String(value));
  }
  if (shaped.dropped.length) parts.push('未下发：' + Array.from(new Set(shaped.dropped)).join('/'));
  return parts.join('，') || '无参数';
}
/**
 * 用内置能力档案合成一份「弱契约」（2026-11-19）。
 *
 * 为什么需要：契约要靠抓文档才会存在。在抓之前如果直接用保守模式，
 * 所有存量部署的画幅/质量会突然全部失效——这是不可接受的回归。
 *
 * 规则：
 *   · 档案里有尺寸白名单（如 gpt-image 的 4 档）→ 合成 enum 契约，
 *     于是 1152x1536 会被 snap 到 1024x1536（比旧行为「直接丢弃」更好）；
 *   · 档案里没有任何尺寸信息（UNKNOWN_PROFILE）→ 返回 undefined，
 *     让调用方走保守模式（旧行为是裸发，正是 400 的来源）。
 */
export function contractFromProfile(
  model: string,
  profile: { operations?: string[]; sizes?: string[]; supportsSize?: boolean; supportsCount?: boolean; supportsQuality?: boolean; maxImagesPerRequest?: number },
  options: { key?: string; op?: string } = {},
): ModelParamContract | undefined {
  const sizes = Array.isArray(profile.sizes) ? profile.sizes.filter(Boolean) : [];
  const hasSizeInfo = profile.supportsSize !== false && sizes.length > 0;
  // 档案明确说「不支持 quality」时，契约里就**不要有这个参数**（absence = 不下发）。
  // 之前我在这里造了 low|high 两档，等于把「不支持」翻译成「支持两档」，直接把
  // grok-2-image 的 quality 又发出去了（被 model-compat 测试抓到）。
  const allowsQuality = profile.supportsQuality !== false;
  if (!hasSizeInfo) return undefined;
  const params: Record<string, ParamSpec> = {};
  if (hasSizeInfo) params.size = { kind: 'size', enum: sizes };
  // 允许 quality 但不知道枚举时用宽松 string，保持旧行为（原样下发，由上游决定）
  if (allowsQuality) params.quality = { kind: 'string' };
  return {
    version: 1,
    key: options.key || 'profile|' + model,
    model,
    op: options.op || 'image.generate',
    source: 'docs',
    fetchedAt: new Date(0).toISOString(),
    required: ['prompt'],
    params,
    notes: ['由内置能力档案合成的弱契约（未经文档校验）'],
  };
}
