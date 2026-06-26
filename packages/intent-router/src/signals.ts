import type { ParsedImageParams } from '../../image/src/index.js';
import type { IntentInput, IntentSignal } from './types.js';

/**
 * 确定性信号检测：在"内容足够明确"时直接给出高置信意图，避免无谓的 LLM 往返。
 * 不确定时返回 undefined，交给 planner。所有函数为纯函数，可单测。
 */

// ── 词库（中英；中文用包含匹配，英文用单词边界匹配）──────────────────────────

const GENERATE_TERMS = [
  // zh
  '画', '画个', '画一', '画张', '画幅', '生成图', '生成一', '生成张', '来一张', '来张', '画一个',
  '绘制', '绘图', '生图', '文生图', '出一张', '出张', '帮我画', '给我画', '设计一张', '做一张图',
  // en
  'draw', 'generate', 'paint', 'render', 'create an image', 'make an image', 'make me an image',
  'a picture of', 'an image of', 'text to image', 'text2image',
];

const EDIT_TERMS = [
  // zh
  '改图', '改成', '编辑', '修图', '修改', '换成', '换个', '替换', '去掉', '删掉', '抹掉', '加上',
  '添加', '调整', '调色', '美化', '重绘', '局部重绘', '扩图', '图生图', '垫图', '参考图', '以图生图',
  '把这', '把图', '基于这', '在这张', '这张图改', '风格化',
  // en
  'edit', 'modify', 'change', 'replace', 'remove', 'retouch', 'inpaint', 'outpaint', 'upscale',
  'img2img', 'image to image', 'based on this image', 'turn this into',
];

const INTERROGATE_TERMS = [
  // zh
  '反推', '反向提示', '识图', '看图', '看看这', '描述这', '描述一下', '这是什么', '这张图是',
  '图里', '图中', '什么内容', '提取提示词', '反推提示词', '解析这', '分析这张', '这幅图', '图片描述',
  // en
  'describe', 'caption', 'what is this', "what's in this", 'what is in this', 'reverse prompt',
  'analyze this image', 'interrogate', 'reverse engineer this image',
];

// ── 匹配工具 ──────────────────────────────────────────────────────────────

function hasCjk(value: string): boolean {
  return /[㐀-鿿豈-﫿]/u.test(value);
}

/** 中文词用包含；英文词用单词/短语边界，避免 "change" 命中 "exchange"。 */
function matchesTerm(text: string, term: string): boolean {
  if (!term) return false;
  if (hasCjk(term)) return text.includes(term);
  const lower = text.toLowerCase();
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(lower);
}

export function matchesAny(text: string, terms: string[]): string | undefined {
  const value = String(text || '');
  for (const term of terms) {
    if (matchesTerm(value, term)) return term;
  }
  return undefined;
}

export function hasGenerateVerb(text: string): string | undefined {
  return matchesAny(text, GENERATE_TERMS);
}
export function hasEditVerb(text: string): string | undefined {
  return matchesAny(text, EDIT_TERMS);
}
export function hasInterrogateVerb(text: string): string | undefined {
  return matchesAny(text, INTERROGATE_TERMS);
}

/** 是否存在"图像类" bang 参数（模板 / 显式尺寸 / 比例 / 放大 / 张数 / 质量）。 */
export function hasImageBang(params: ParsedImageParams): boolean {
  if (params.templateId) return true;
  return params.tokens.some((token) =>
    /^(?:mb_\d+|\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|[124]k|\d+|n=\d+|low|medium|high|auto|standard|hd)!$/i.test(token),
  );
}

export interface SignalOptions {
  preferEditWhenImagePresent?: boolean;
}

/**
 * 输入：清洗后的文本、bang 解析结果、是否有图。
 * 输出：命中的高/中置信信号（可能为空）。由 router 做能力门控与兜底。
 */
export function detectIntentSignals(
  input: IntentInput,
  params: ParsedImageParams,
  options: SignalOptions = {},
): IntentSignal[] {
  const text = String(input.text || '').trim();
  const hasImages = Boolean((input.images && input.images.length) || input.hasReferencedImage);
  const preferEdit = options.preferEditWhenImagePresent !== false;
  const signals: IntentSignal[] = [];

  const gen = hasGenerateVerb(text);
  const edit = hasEditVerb(text);
  const interrogate = hasInterrogateVerb(text);
  const imageBang = hasImageBang(params);

  // 1) 反推/识图：有图 + 反推类动词，且没有明确的"再画一张/改成"意图。
  if (hasImages && interrogate && !gen) {
    signals.push({
      kind: 'image.interrogate',
      confidence: 0.92,
      reason: `检测到反推/识图意图（"${interrogate}"）且存在图片`,
    });
  }

  // 2) 改图：有图 + 编辑类动词。
  if (hasImages && edit) {
    signals.push({
      kind: 'image.edit',
      confidence: 0.9,
      reason: `检测到改图意图（"${edit}"）且存在图片`,
    });
  }

  // 3) 生图：明确的生成类动词。
  if (gen) {
    // 有图 + 生成词：可能是"用这风格再画一张"，倾向 edit 时降权由 router 决策；这里给 generate 中高置信。
    signals.push({
      kind: 'image.generate',
      confidence: hasImages ? 0.7 : 0.85,
      reason: `检测到生图意图（"${gen}"）`,
    });
  }

  // 4) 仅凭图像 bang 参数 + 有 prompt 主体：
  if (imageBang && params.prompt.trim()) {
    if (hasImages) {
      signals.push({
        kind: preferEdit ? 'image.edit' : 'image.generate',
        confidence: 0.72,
        reason: '存在图像 bang 参数且附带图片',
      });
    } else {
      signals.push({
        kind: 'image.generate',
        confidence: 0.78,
        reason: '存在图像 bang 参数（尺寸/比例/模板/张数等）',
      });
    }
  }

  // 5) 仅模板 bang（mb_1!）即使没有其它主体也强烈表示生图。
  if (params.templateId && !signals.some((s) => s.kind.startsWith('image'))) {
    signals.push({
      kind: hasImages && preferEdit ? 'image.edit' : 'image.generate',
      confidence: 0.7,
      reason: `检测到模板参数（${params.templateId}!）`,
    });
  }

  return dedupeBestByKind(signals);
}

/** 同一 kind 只保留最高置信的一条，并按置信降序。 */
function dedupeBestByKind(signals: IntentSignal[]): IntentSignal[] {
  const best = new Map<string, IntentSignal>();
  for (const signal of signals) {
    const current = best.get(signal.kind);
    if (!current || signal.confidence > current.confidence) best.set(signal.kind, signal);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}
