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
  /** 允许自动路由命中的意图；未列出的意图会降级到 chat/ignore。 */
  allowedKinds?: IntentKind[];
  preferEditWhenImagePresent?: boolean;
  maxCount?: number;
  defaultSize?: string;
  defaultQuality?: string;
  /** 命中确定性信号的最低置信阈值；低于此值仍会尝试 planner。默认 0.7。 */
  signalThreshold?: number;
  /**
   * 没有规划器复核时，信号至少要多确信才敢直接执行。默认 0.65。
   * 弱信号（「把这」「画」「换个」这类日常词）现在只给 0.55~0.6，
   * 正常情况下会落到 planner 手里；但如果用户压根没配规划器，
   * 就必须宁可当聊天，也不能拿一个 0.55 的猜测去烧生图额度。
   */
  minActionableConfidence?: number;
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
  plannerDuration?: number;
  plannerResolution?: string;
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
          plannerDuration: output.duration,
          plannerResolution: output.resolution,
        });
      } catch (error) {
        // 规划器失败 → 走兜底规则，不让自动路由整体崩掉。
        return this.gate(params, {
          // 能走到这里说明 top 的置信低于阈值。拿一个自己都不确信的信号当兜底，
          // 只会把「规划器挂了」变成「莫名其妙改了张图」。
          kind: this.fallbackKind(input),
          source: 'fallback',
          confidence: 0.4,
          reason: `规划器失败，按聊天处理：${describeError(error)}`,
          usedPlanner: true,
        });
      }
    }

    // 3) 无规划器：只有足够确信的信号才直接执行，否则宁可当聊天。
    const minActionable = this.options.minActionableConfidence ?? 0.65;
    if (top && top.confidence >= minActionable) {
      return this.gate(params, {
        kind: top.kind,
        source: 'signal',
        confidence: top.confidence,
        reason: `${top.reason}（无规划器，采用最高信号）`,
        usedPlanner: false,
      });
    }
    if (top) {
      return this.gate(params, {
        kind: this.fallbackKind(input),
        source: 'fallback',
        confidence: 0.4,
        reason: `${top.reason}；证据不足且无规划器可复核，按聊天处理`,
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

  /**
   * 兜底意图恒为 chat。
   * 以前是「有图就当改图」——但群里回复一张图再 @bot 说话是最常见的用法，
   * 一旦没有明确的编辑意图，把用户的话当提示词丢给改图模型只会毁掉那张图并烧掉额度。
   * 有图但意图不明时，chat 模型（若具备视觉）本来就能看图回答。
   */
  private fallbackKind(_input: IntentInput): IntentKind {
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

    const allowed = this.options.allowedKinds;
    if (allowed && kind !== 'ignore' && !allowed.includes(kind)) {
      const fallback: IntentKind = allowed.includes('chat') ? 'chat' : 'ignore';
      if (fallback !== kind) {
        degradedFrom = degradedFrom || kind;
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
    // 图像/视频生成：bang 参数最高优先；prompt 主体在规划器路径采用规划器产出（受语言保持约束）。
    const explicitSize = params.tokens.some((t) => /^(?:\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|[124]k)!$/i.test(t));
    const explicitCount = params.tokens.some((t) => /^(?:\d+|n=\d+)!$/i.test(t));
    const explicitQuality = params.tokens.some((t) => /^(?:low|medium|high|auto|standard|hd)!$/i.test(t));
    const plannerPrompt = (raw.plannerPrompt || '').trim();
    const basePrompt = plannerPrompt ? preserveLanguage(params.rawInput || params.prompt, plannerPrompt) : params.prompt;
    const duration = extractDurationBang(params.tokens) ?? raw.plannerDuration;
    const resolution = extractResolutionBang(params.tokens) ?? raw.plannerResolution;
    return {
      prompt: basePrompt || params.prompt || plannerPrompt,
      size: explicitSize ? params.size : (raw.plannerSize || params.size),
      count: explicitCount ? params.count : (raw.plannerCount ?? params.count),
      quality: explicitQuality ? params.quality : (raw.plannerQuality || params.quality),
      templateId: params.templateId,
      duration,
      resolution,
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
    case 'video.generate': return caps.videoGenerate !== false;
    case 'ignore': return true;
  }
}

/** 不可用时的降级链：edit→generate→chat；video→chat；generate→chat；interrogate→chat。 */
function degradeKind(kind: IntentKind, caps: IntentCapabilities): IntentKind {
  const chain: IntentKind[] = kind === 'image.edit'
    ? ['image.generate', 'chat', 'ignore']
    : kind === 'image.generate'
      ? ['chat', 'ignore']
      : kind === 'image.interrogate'
        ? ['chat', 'ignore']
        : kind === 'video.generate'
          ? ['chat', 'ignore']
          : ['ignore'];
  for (const candidate of chain) {
    if (isCapable(candidate, caps)) return candidate;
  }
  return 'ignore';
}

/** bang: 6s! / duration=6! → 6 */
function extractDurationBang(tokens: string[]): number | undefined {
  for (const token of tokens) {
    const m = String(token || '').match(/^(?:(\d{1,2})s|duration=(\d{1,2}))!$/i);
    if (m) {
      const n = Number(m[1] || m[2]);
      if (Number.isFinite(n) && n > 0) return Math.min(15, Math.max(1, Math.trunc(n)));
    }
  }
  return undefined;
}

/** bang: 480p! / 720p! / 1080p! */
function extractResolutionBang(tokens: string[]): string | undefined {
  for (const token of tokens) {
    const m = String(token || '').match(/^(480p|720p|1080p)!$/i);
    if (m) return m[1].toLowerCase();
  }
  return undefined;
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
