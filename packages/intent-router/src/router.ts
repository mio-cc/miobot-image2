import { parseImageCommand, type ParsedImageParams } from '../../image/src/index.js';
import { detectIntentSignals } from './signals.js';
import {
  buildPlannerMessages,
  parsePlannerOutput,
  plannerActionToIntentKind,
  type PlannerClient,
} from './planner.js';
import type {
  IntentCapabilities,
  IntentDecision,
  IntentInput,
  IntentKind,
  IntentParams,
} from './types.js';

export interface IntentRouterOptions {
  /** 规划器（可选）。不提供时只用确定性信号 + 兜底规则。 */
  planner?: PlannerClient;
  plannerModel?: string;
  plannerPromptTemplate?: string;
  /** 规划模型是否具备 vision（决定有图时是否多模态传图）。 */
  plannerVisionEnabled?: boolean;
  timeoutMs?: number;
  /** 各能力是否可用；不提供时视为全部可用。 */
  capabilities?: IntentCapabilities;
  preferEditWhenImagePresent?: boolean;
  maxCount?: number;
  defaultSize?: string;
  defaultQuality?: string;
  /** 命中确定性信号的最低置信阈值；低于此值仍会尝试 planner。默认 0.7。 */
  signalThreshold?: number;
}

interface RawDecision {
  kind: IntentKind;
  source: IntentDecision['source'];
  confidence: number;
  reason: string;
  usedPlanner: boolean;
  plannerText?: string;
  plannerPrompt?: string;
  plannerSize?: string;
  plannerCount?: number;
  plannerQuality?: string;
}

export class IntentRouter {
  private readonly options: IntentRouterOptions;

  constructor(options: IntentRouterOptions = {}) {
    this.options = options;
  }

  async route(input: IntentInput): Promise<IntentDecision> {
    const params = parseImageCommand(input.text || '', {
      defaultSize: this.options.defaultSize,
      defaultQuality: this.options.defaultQuality,
      maxCount: this.options.maxCount ?? 4,
    });
    const preferEdit = this.options.preferEditWhenImagePresent !== false;
    const threshold = this.options.signalThreshold ?? 0.7;

    // 1) 确定性信号优先。
    const signals = detectIntentSignals(input, params, { preferEditWhenImagePresent: preferEdit });
    const top = signals[0];
    if (top && top.confidence >= threshold) {
      return this.gate(params, {
        kind: top.kind,
        source: 'signal',
        confidence: top.confidence,
        reason: top.reason,
        usedPlanner: false,
      });
    }

    // 2) 规划器兜底（仅在有规划器时）。
    if (this.options.planner && this.options.plannerModel) {
      try {
        const messages = buildPlannerMessages(input, {
          template: this.options.plannerPromptTemplate,
          visionEnabled: Boolean(this.options.plannerVisionEnabled),
          preferEditWhenImagePresent: preferEdit,
        });
        const result = await this.options.planner.createText({
          model: this.options.plannerModel,
          messages,
          timeoutMs: this.options.timeoutMs,
        });
        const output = parsePlannerOutput(result.text || '');
        const kind = plannerActionToIntentKind(output.action);
        return this.gate(params, {
          kind,
          source: 'planner',
          confidence: 0.7,
          reason: `规划器判定 action=${output.action}`,
          usedPlanner: true,
          plannerText: output.text,
          plannerPrompt: output.prompt,
          plannerSize: output.size,
          plannerCount: output.count,
          plannerQuality: output.quality,
        });
      } catch (error) {
        // 规划器失败 → 走兜底规则，不让自动路由整体崩掉。
        return this.gate(params, {
          kind: this.fallbackKind(input, top?.kind),
          source: 'fallback',
          confidence: 0.4,
          reason: `规划器失败，使用兜底规则：${describeError(error)}`,
          usedPlanner: true,
        });
      }
    }

    // 3) 无规划器：用最高信号或兜底。
    if (top) {
      return this.gate(params, {
        kind: top.kind,
        source: 'signal',
        confidence: top.confidence,
        reason: `${top.reason}（无规划器，采用最高信号）`,
        usedPlanner: false,
      });
    }
    return this.gate(params, {
      kind: this.fallbackKind(input),
      source: 'fallback',
      confidence: 0.4,
      reason: '无明确信号且无规划器，使用兜底规则',
      usedPlanner: false,
    });
  }

  /** 兜底意图：有图倾向 edit（若开启），否则 chat。 */
  private fallbackKind(input: IntentInput, hint?: IntentKind): IntentKind {
    if (hint) return hint;
    const hasImages = Boolean((input.images && input.images.length) || input.hasReferencedImage);
    if (hasImages && this.options.preferEditWhenImagePresent !== false) return 'image.edit';
    return 'chat';
  }

  /**
   * 能力门控 + 降级：若目标能力不可用，按合理顺序降级，
   * 并记录 degradedFrom，保证不会路由到未开启/不具备的能力。
   */
  private gate(params: ParsedImageParams, raw: RawDecision): IntentDecision {
    const caps = this.options.capabilities;
    let kind = raw.kind;
    let degradedFrom: IntentKind | undefined;

    if (caps && !isCapable(kind, caps)) {
      const fallback = degradeKind(kind, caps);
      if (fallback !== kind) {
        degradedFrom = kind;
        kind = fallback;
      }
    }

    const decision: IntentDecision = {
      kind,
      source: raw.source,
      confidence: raw.confidence,
      reason: degradedFrom ? `${raw.reason}；因 ${degradedFrom} 能力不可用降级为 ${kind}` : raw.reason,
      params: this.buildParams(kind, params, raw),
      usedPlanner: raw.usedPlanner,
    };
    if (degradedFrom) decision.degradedFrom = degradedFrom;
    return decision;
  }

  /** 合并 bang 参数（最高优先）与 planner 参数；chat/interrogate 不需要图像参数。 */
  private buildParams(kind: IntentKind, params: ParsedImageParams, raw: RawDecision): IntentParams {
    if (kind === 'chat') {
      // chat 用用户原始输入作为提示词，不用 plannerText —— planner 只判定意图，
      // 它的 text 回复若被当作用户消息喂给 chat 模型，会产生无上下文的奇怪回复，
      // 甚至触发部分模型/中转的 function-calling 语法(如 search("..."))泄露到输出。
      return { prompt: params.prompt ?? params.rawInput ?? '', tokens: params.tokens };
    }
    if (kind === 'image.interrogate' || kind === 'ignore') {
      return { prompt: params.prompt, tokens: params.tokens, templateId: params.templateId };
    }
    // 图像生成/编辑：bang 参数最高优先；prompt 主体在规划器路径采用规划器产出（受语言保持约束），否则用清洗后的用户文本。
    const explicitSize = params.tokens.some((t) => /^(?:\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|[124]k)!$/i.test(t));
    const explicitCount = params.tokens.some((t) => /^(?:\d+|n=\d+)!$/i.test(t));
    const explicitQuality = params.tokens.some((t) => /^(?:low|medium|high|auto|standard|hd)!$/i.test(t));
    const plannerPrompt = (raw.plannerPrompt || '').trim();
    const basePrompt = plannerPrompt ? preserveLanguage(params.rawInput || params.prompt, plannerPrompt) : params.prompt;
    return {
      prompt: basePrompt || params.prompt || plannerPrompt,
      size: explicitSize ? params.size : (raw.plannerSize || params.size),
      count: explicitCount ? params.count : (raw.plannerCount ?? params.count),
      quality: explicitQuality ? params.quality : (raw.plannerQuality || params.quality),
      templateId: params.templateId,
      tokens: params.tokens,
    };
  }
}

export function createIntentRouter(options: IntentRouterOptions = {}): IntentRouter {
  return new IntentRouter(options);
}

// ── 能力门控辅助 ────────────────────────────────────────────────────────────

function isCapable(kind: IntentKind, caps: IntentCapabilities): boolean {
  switch (kind) {
    case 'chat': return caps.chat !== false;
    case 'image.generate': return caps.imageGenerate !== false;
    case 'image.edit': return caps.imageEdit !== false;
    case 'image.interrogate': return caps.interrogate !== false;
    case 'ignore': return true;
  }
}

/** 不可用时的降级链：edit→generate→chat→ignore；generate→chat→ignore；interrogate→chat→ignore。 */
function degradeKind(kind: IntentKind, caps: IntentCapabilities): IntentKind {
  const chain: IntentKind[] = kind === 'image.edit'
    ? ['image.generate', 'chat', 'ignore']
    : kind === 'image.generate'
      ? ['chat', 'ignore']
      : kind === 'image.interrogate'
        ? ['chat', 'ignore']
        : ['ignore'];
  for (const candidate of chain) {
    if (isCapable(candidate, caps)) return candidate;
  }
  return 'ignore';
}

// ── 语言保持（中文 prompt 不被擅自翻译成英文）────────────────────────────────

function hasCjk(value: string): boolean {
  return /[㐀-鿿豈-﫿]/u.test(String(value || ''));
}

function explicitlyRequestsEnglish(value: string): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/(?:不要|别|禁止|无需|不需要|不许).{0,10}(?:英文|英语|english)/i.test(text)) return false;
  return /(?:翻译|译成|转成|转换成|改成|写成|输出|使用|用).{0,16}(?:英文|英语|english)/i.test(text)
    || /(?:英文|英语).{0,8}(?:prompt|提示词|版|版本|输出)/i.test(text)
    || /(?:translate|convert|rewrite|write).{0,24}(?:to|into|in)\s+english/i.test(text);
}

export function preserveLanguage(rawPrompt: string, nextPrompt: string): string {
  const raw = String(rawPrompt || '').trim();
  const next = String(nextPrompt || '').trim();
  if (!next) return raw;
  if (raw && hasCjk(raw) && !hasCjk(next) && !explicitlyRequestsEnglish(raw)) return raw;
  return next;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
