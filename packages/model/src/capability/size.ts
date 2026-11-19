/**
 * 图像尺寸契约与求解（2026-11-19）。
 *
 * 为什么放在 packages/model：这里的约束是「上游模型/网关」的约束，不是排版偏好。
 * client.ts 整形请求要用它，bot 的 capability 层解析预设也要用它，放一处避免两份表。
 *
 * 约束来源（已联网核实，2026-11-19）：
 * - fal 托管的 openai/gpt-image-2.6/sunburst/text-to-image 文档页内嵌 OpenAPI 的
 *   image_size 描述原文：
 *     "Concrete sizes must have both dimensions as multiples of 16, max edge 3840px,
 *      aspect ratio <= 3:1, total pixels between 655,360 and 8,294,400."
 * - OpenAI 官方 openapi.yaml 的 size 枚举只有 1024x1024 / 1536x1024 / 1024x1536 / auto
 *   （2K/4K 只在 fal 这类代理上通过 image_size 对象可得）。
 *
 * 注意：这些数值只对 fal 系 gpt-image 成立。不同厂商不一样，所以本文件只提供
 * 「默认值 + 可覆盖」；真正的每模型约束应由参数契约（contract）提供。
 */

/** 尺寸约束。全部可选，缺省用 fal gpt-image-2.6 的实测值。 */
export interface ImageSizeLimits {
  /** 宽高必须是该值的倍数。 */
  multipleOf?: number;
  /** 单边最大像素。 */
  maxEdge?: number;
  /** 最大宽高比（长边/短边）。 */
  aspectMax?: number;
  /** 总像素下限。 */
  minPixels?: number;
  /** 总像素上限。 */
  maxPixels?: number;
}

export const DEFAULT_IMAGE_SIZE_LIMITS: Readonly<Required<ImageSizeLimits>> = Object.freeze({
  multipleOf: 16,
  maxEdge: 3840,
  aspectMax: 3,
  minPixels: 655360,
  maxPixels: 8294400,
});

/**
 * 画幅预设单一真源。
 *
 * 前 6 个是历史预设，名称与像素值**不得改动**（已有用户配置与测试依赖）。
 * 后 6 个是 2026-11-19 新增的 2K/4K 档。
 *
 * 4k-square 只能是 2880x2880：3840x3840 = 14,745,600 像素，超过 8,294,400 预算 78%，
 * 上游会 400；2880x2880 = 8,294,400 正好顶到上限。
 */
export const IMAGE_SIZE_PRESETS: Readonly<Record<string, { width: number; height: number }>> = Object.freeze({
  square: { width: 1024, height: 1024 },
  portrait: { width: 1024, height: 1536 },
  'portrait-3-4': { width: 1152, height: 1536 },
  portrait34: { width: 1152, height: 1536 },
  landscape: { width: 1536, height: 1024 },
  'landscape-4-5': { width: 1280, height: 1024 },
  landscape45: { width: 1280, height: 1024 },
  '2k-16-9': { width: 2048, height: 1152 },
  '2k-9-16': { width: 1152, height: 2048 },
  '2k-square': { width: 2048, height: 2048 },
  '4k-16-9': { width: 3840, height: 2160 },
  '4k-9-16': { width: 2160, height: 3840 },
  '4k-square': { width: 2880, height: 2880 },
});

export interface SolvedImageSize {
  width: number;
  height: number;
  /** 规范的 'WxH' 字符串，方便直接塞进 size 字段。 */
  size: string;
  /** 是否与请求值不同（true = 发生了调整，调用方应打日志告知用户）。 */
  snapped: boolean;
  /** 人类可读的原因链，便于排查「尺寸参数不合格」。 */
  reason: string;
  /** 逐条调整记录；空数组表示原样通过。 */
  steps: string[];
}

function normalizeLimits(limits?: ImageSizeLimits): Required<ImageSizeLimits> {
  const base = DEFAULT_IMAGE_SIZE_LIMITS;
  const positive = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    multipleOf: Math.max(1, Math.trunc(positive(limits?.multipleOf, base.multipleOf))),
    maxEdge: Math.trunc(positive(limits?.maxEdge, base.maxEdge)),
    aspectMax: positive(limits?.aspectMax, base.aspectMax),
    minPixels: Math.trunc(positive(limits?.minPixels, base.minPixels)),
    maxPixels: Math.trunc(positive(limits?.maxPixels, base.maxPixels)),
  };
}

function roundTo(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function floorTo(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function ceilTo(value: number, multiple: number): number {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

/**
 * 解析用户给的值：'WxH' / 'auto' / 空 / 预设名。
 * 无法解析时返回 undefined，由调用方决定用默认值。
 */
export function parseRequestedSize(value: unknown): { width: number; height: number } | undefined {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!raw || raw === 'auto') return undefined;
  const preset = IMAGE_SIZE_PRESETS[raw];
  if (preset) return { width: preset.width, height: preset.height };
  const match = raw.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/);
  if (match) {
    const width = Math.trunc(Number(match[1]));
    const height = Math.trunc(Number(match[2]));
    if (width > 0 && height > 0) return { width, height };
  }
  return undefined;
}

/**
 * 把「想要的尺寸」解成「该模型一定接受的尺寸」。
 *
 * 顺序（每一步都不退化成非法值）：
 *   1. 对齐 multipleOf
 *   2. 边长夹到 maxEdge
 *   3. 宽高比夹到 aspectMax（裁长边）
 *   4. 总像素夹到 maxPixels（等比缩小后再对齐）
 *   5. 总像素抬到 minPixels（等比放大后再对齐）
 *   6. 仍不合法（极少）→ 退回默认 1024x1024，并再走一遍 2-5
 */
export function solveImageSize(requested: unknown, limits?: ImageSizeLimits): SolvedImageSize {
  const cap = normalizeLimits(limits);
  const steps: string[] = [];
  const parsed = parseRequestedSize(requested);
  let width = parsed?.width ?? 1024;
  let height = parsed?.height ?? 1024;
  const original = { width, height };
  if (!parsed) steps.push('未指定有效尺寸，使用默认 1024x1024');

  // 1) 对齐
  const alignedW = roundTo(width, cap.multipleOf);
  const alignedH = roundTo(height, cap.multipleOf);
  if (alignedW !== width || alignedH !== height) {
    steps.push('对齐到 ' + cap.multipleOf + ' 的倍数：' + width + 'x' + height + ' → ' + alignedW + 'x' + alignedH);
    width = alignedW;
    height = alignedH;
  }

  // 2) 边长上限
  if (width > cap.maxEdge) {
    const next = floorTo(cap.maxEdge, cap.multipleOf);
    steps.push('宽度超过上限 ' + cap.maxEdge + '：' + width + ' → ' + next);
    width = next;
  }
  if (height > cap.maxEdge) {
    const next = floorTo(cap.maxEdge, cap.multipleOf);
    steps.push('高度超过上限 ' + cap.maxEdge + '：' + height + ' → ' + next);
    height = next;
  }

  // 3) 宽高比：**放大短边**而不是缩小长边。
  //    两种做法都满足比例约束，但放大短边保留更多像素（画质更好、也更接近用户想表达的画幅）。
  //    例如 4096x1024(4:1) → 缩长边得 3072x1024(3.1M)，放短边得 3840x1280(4.9M)。
  const maxEdgeAligned = floorTo(cap.maxEdge, cap.multipleOf);
  if (width / height > cap.aspectMax) {
    const next = Math.min(ceilTo(width / cap.aspectMax, cap.multipleOf), maxEdgeAligned);
    steps.push('宽高比超过 ' + cap.aspectMax + ':1：高度 ' + height + ' → ' + next);
    height = next;
  } else if (height / width > cap.aspectMax) {
    const next = Math.min(ceilTo(height / cap.aspectMax, cap.multipleOf), maxEdgeAligned);
    steps.push('宽高比超过 ' + cap.aspectMax + ':1：宽度 ' + width + ' → ' + next);
    width = next;
  }

  // 4) 总像素上限（等比缩，最多 8 轮避免浮点抖动导致死循环）
  for (let i = 0; i < 8 && width * height > cap.maxPixels; i += 1) {
    const scale = Math.sqrt(cap.maxPixels / (width * height));
    const nextW = floorTo(width * scale, cap.multipleOf);
    const nextH = floorTo(height * scale, cap.multipleOf);
    steps.push('总像素超过 ' + cap.maxPixels + '：' + width + 'x' + height + ' → ' + nextW + 'x' + nextH);
    if (nextW === width && nextH === height) break;
    width = nextW;
    height = nextH;
  }

  // 5) 总像素下限
  for (let i = 0; i < 8 && width * height < cap.minPixels; i += 1) {
    const scale = Math.sqrt(cap.minPixels / (width * height));
    const nextW = Math.min(ceilTo(width * scale, cap.multipleOf), floorTo(cap.maxEdge, cap.multipleOf));
    const nextH = Math.min(ceilTo(height * scale, cap.multipleOf), floorTo(cap.maxEdge, cap.multipleOf));
    steps.push('总像素低于 ' + cap.minPixels + '：' + width + 'x' + height + ' → ' + nextW + 'x' + nextH);
    if (nextW === width && nextH === height) break;
    width = nextW;
    height = nextH;
  }

  // 6) 兜底：仍然不合法就退回默认正方
  const valid = (w: number, h: number): boolean => {
    if (w < cap.multipleOf || h < cap.multipleOf) return false;
    if (w % cap.multipleOf !== 0 || h % cap.multipleOf !== 0) return false;
    if (w > cap.maxEdge || h > cap.maxEdge) return false;
    if (Math.max(w, h) / Math.min(w, h) > cap.aspectMax) return false;
    const pixels = w * h;
    return pixels >= cap.minPixels && pixels <= cap.maxPixels;
  };
  if (!valid(width, height)) {
    const fallbackW = Math.min(floorTo(1024, cap.multipleOf), floorTo(cap.maxEdge, cap.multipleOf));
    const fallbackH = fallbackW;
    steps.push('约束无法满足，退回默认 ' + fallbackW + 'x' + fallbackH);
    width = fallbackW;
    height = fallbackH;
  }

  const snapped = width !== original.width || height !== original.height;
  return {
    width,
    height,
    size: width + 'x' + height,
    snapped,
    reason: steps.length ? steps.join('；') : '原尺寸已满足约束',
    steps,
  };
}
/**
 * 已退役的图像模型（2026-11-19 核实）。
 * 只用于「提示用户/管理员」——不改变任何请求形态，因为中转可能仍在代理这些名字。
 */
export const RETIRED_IMAGE_MODELS: Readonly<Record<string, string>> = Object.freeze({
  'dall-e-2': '2026-05-12 退役',
  'dall-e-3': '2026-05-12 退役',
  'gpt-image-1': '2026-10-23 关停，请改用 gpt-image-2.5-sunburst / gpt-image-2.6-sunburst',
});

/** 该模型是否已退役；返回原因字符串或 undefined。 */
export function retiredImageModelNotice(model: string): string | undefined {
  const key = String(model || '').trim().toLowerCase();
  if (!key) return undefined;
  for (const [name, notice] of Object.entries(RETIRED_IMAGE_MODELS)) {
    if (key === name || key.startsWith(name + '-') || key.startsWith(name + '/')) return name + '：' + notice;
  }
  return undefined;
}

/** 图像质量档位（2026-11-19：官方与 fal 均已提供 xhigh / max）。 */
export const IMAGE_QUALITY_ENUM = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ImageQualityLevel = typeof IMAGE_QUALITY_ENUM[number];
