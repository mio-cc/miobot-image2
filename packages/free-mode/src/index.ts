import { ImageModule, parseImageCommand, type ImageOperationResult } from '../../image/src/index.js';
import type { ReplyContext, ReplyDispatchResult, ReplyStrategyEngine } from '../../reply/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';

export const FREE_MODE_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/free-mode',
  phase: 'P9-free-mode',
};

export type FreeModeAction = 'text' | 'image';
export type FreeModeImageMode = 'generate' | 'edit';

export interface FreeModePlannerClient {
  createText(request: { model: string; messages: Array<{ role: string; content: unknown }>; timeoutMs?: number }): Promise<{ text: string; raw: unknown }>;
}

export interface FreeModeImagePlanItem {
  prompt: string;
  size?: string;
  count?: number;
  quality?: string;
}

export interface FreeModePlannerResult {
  action: FreeModeAction;
  text?: string;
  mode?: FreeModeImageMode;
  prompt?: string;
  size?: string;
  count?: number;
  quality?: string;
  images?: FreeModeImagePlanItem[];
}

export interface FreeModeInput {
  userContent: string;
  images?: string[];
  context?: ReplyContext;
}

export interface FreeModeOptions {
  planner: FreeModePlannerClient;
  image: ImageModule;
  reply?: ReplyStrategyEngine;
  model: string;
  timeoutMs?: number;
  maxOutputImages?: number;
  plannerPromptTemplate?: string;
  preferEditWhenImagePresent?: boolean;
}

export interface FreeModeResult {
  action: FreeModeAction;
  mode?: FreeModeImageMode;
  planner: FreeModePlannerResult;
  text?: string;
  images?: string[];
  imageResults?: ImageOperationResult[];
  reply?: ReplyDispatchResult;
  directives: FreeModeDirectives;
}

export interface FreeModeDirectives {
  rawPrompt: string;
  tokens: string[];
  size?: string;
  count?: number;
  quality?: string;
  templateId?: string;
}

const DEFAULT_PLANNER_TEMPLATE = 'You are the Napcat Bot Free Mode planner. Return JSON only. Use {"action":"text","text":"..."} or {"action":"image","mode":"generate|edit","prompt":"...","size":"1024x1024","count":1}. User content: {{userContent}}';

export class FreeModeEngine {
  private readonly options: Required<Omit<FreeModeOptions, 'reply' | 'plannerPromptTemplate'>> & Pick<FreeModeOptions, 'reply' | 'plannerPromptTemplate'>;

  constructor(options: FreeModeOptions) {
    this.options = {
      planner: options.planner,
      image: options.image,
      reply: options.reply,
      model: options.model,
      timeoutMs: positiveInt(options.timeoutMs, 120000),
      maxOutputImages: Math.max(1, Math.trunc(options.maxOutputImages ?? 4)),
      plannerPromptTemplate: options.plannerPromptTemplate,
      preferEditWhenImagePresent: options.preferEditWhenImagePresent !== false,
    };
  }

  async handle(input: FreeModeInput): Promise<FreeModeResult> {
    const directives = extractFreeModeDirectives(input.userContent);
    const planner = await this.plan(input, directives);
    if (planner.action === 'text') {
      const text = planner.text || '';
      const reply = input.context && this.options.reply ? await this.options.reply.replyText(input.context, text) : undefined;
      return { action: 'text', planner, text, reply, directives };
    }

    const mode = resolveImageMode(planner, input.images || [], this.options.preferEditWhenImagePresent);
    const imageResults = await this.executeImagePlan(planner, mode, input, directives);
    const images = imageResults.flatMap((result) => result.images).slice(0, this.options.maxOutputImages);
    const reply = input.context && this.options.reply ? await this.options.reply.replyImages(input.context, images) : undefined;
    return { action: 'image', mode, planner, images, imageResults, reply, directives };
  }

  private async plan(input: FreeModeInput, directives: FreeModeDirectives): Promise<FreeModePlannerResult> {
    const userContent = renderUserContent(input, directives);
    const systemPrompt = renderPlannerPrompt(this.options.plannerPromptTemplate || DEFAULT_PLANNER_TEMPLATE, userContent, this.options.preferEditWhenImagePresent);
    const result = await this.options.planner.createText({
      model: this.options.model,
      timeoutMs: this.options.timeoutMs,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });
    return normalizePlannerResult(parsePlannerResult(result.text), input.userContent);
  }

  private async executeImagePlan(planner: FreeModePlannerResult, mode: FreeModeImageMode, input: FreeModeInput, directives: FreeModeDirectives): Promise<ImageOperationResult[]> {
    const items = normalizeImagePlanItems(planner).slice(0, this.options.maxOutputImages);
    const results: ImageOperationResult[] = [];
    if (mode === 'edit') {
      const editImages = (input.images || []).filter(Boolean);
      if (!editImages.length) throw new Error('Free mode planner requested edit but no input images were provided.');
      for (const item of items) {
        const rawPrompt = buildRawPromptWithOverrides(item, directives);
        results.push(await this.options.image.edit({ rawPrompt, images: editImages }));
        if (results.flatMap((result) => result.images).length >= this.options.maxOutputImages) break;
      }
      return results;
    }

    for (const item of items) {
      const rawPrompt = buildRawPromptWithOverrides(item, directives);
      results.push(await this.options.image.generate({ rawPrompt }));
      if (results.flatMap((result) => result.images).length >= this.options.maxOutputImages) break;
    }
    return results;
  }
}

export function createFreeModeEngine(options: FreeModeOptions): FreeModeEngine {
  return new FreeModeEngine(options);
}

export function parsePlannerResult(raw: string): FreeModePlannerResult {
  const parsed = extractJsonObject(raw);
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const actionRaw = String(record.action || record.type || '').toLowerCase();
    const images = Array.isArray(record.images)
      ? record.images
        .filter(isRecord)
        .map((item) => ({
          prompt: String(item.prompt || item.description || '').trim(),
          size: String(item.size || record.size || '').trim() || undefined,
          count: numberOrUndefined(item.count) ?? numberOrUndefined(record.count),
          quality: String(item.quality || record.quality || '').trim() || undefined,
        }))
        .filter((item) => item.prompt)
      : undefined;
    if (actionRaw === 'image' || actionRaw === 'images' || images?.length || record.prompt || record.imagePrompt) {
      return {
        action: 'image',
        mode: String(record.mode || '').toLowerCase() === 'edit' ? 'edit' : 'generate',
        prompt: String(record.prompt || record.imagePrompt || '').trim(),
        size: String(record.size || record.resolution || '').trim() || undefined,
        count: numberOrUndefined(record.count) ?? numberOrUndefined(record.n),
        quality: String(record.quality || '').trim() || undefined,
        images,
        text: String(record.text || '').trim() || undefined,
      };
    }
    return { action: 'text', text: String(record.text || record.reply || record.content || raw).trim() };
  }
  return { action: 'text', text: cleanupModelText(raw) };
}

export function extractFreeModeDirectives(userContent: string): FreeModeDirectives {
  const parsed = parseImageCommand(userContent, { defaultCount: 1, maxCount: 4 });
  return {
    rawPrompt: parsed.prompt,
    tokens: parsed.tokens,
    size: parsed.tokens.some((token) => /^(\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2})!/i.test(token)) ? parsed.size : undefined,
    count: parsed.tokens.some((token) => /^(\d+|n=\d+)!/i.test(token)) ? parsed.count : undefined,
    quality: parsed.quality,
    templateId: parsed.templateId,
  };
}

export function buildRawPromptWithOverrides(item: FreeModeImagePlanItem, directives: FreeModeDirectives): string {
  const tokens: string[] = [];
  if (directives.templateId) tokens.push(`${directives.templateId}!`);
  if (directives.size || item.size) tokens.push(`${directives.size || item.size}!`);
  if (directives.count ?? item.count) tokens.push(`${directives.count ?? item.count}!`);
  if (directives.quality || item.quality) tokens.push(`${directives.quality || item.quality}!`);
  const prompt = String(item.prompt || directives.rawPrompt || '').trim();
  return [...tokens, prompt].filter(Boolean).join(' ').trim();
}

export function renderPlannerPrompt(template: string, userContent: string, preferEditWhenImagePresent = true): string {
  const preference = preferEditWhenImagePresent
    ? 'Planner preference: when input images are present and the user asks for modification, prefer mode=edit.'
    : 'Planner preference: do not automatically prefer mode=edit merely because input images are present.';
  return `${String(template || DEFAULT_PLANNER_TEMPLATE).replaceAll('{{userContent}}', userContent)}\n\n${preference}`;
}

function renderUserContent(input: FreeModeInput, directives: FreeModeDirectives): string {
  const images = input.images?.length ? `\n\n【图片】共 ${input.images.length} 张。` : '\n\n【图片】无。';
  const directiveText = directives.tokens.length ? `\n\n【用户 bang 参数】${directives.tokens.join(' ')}` : '';
  return `${directives.rawPrompt || input.userContent || '（无文字内容）'}${directiveText}${images}`.slice(0, 30000);
}

function normalizePlannerResult(result: FreeModePlannerResult, fallbackPrompt: string): FreeModePlannerResult {
  if (result.action === 'text') return { action: 'text', text: result.text || '' };
  const prompt = result.prompt || result.images?.[0]?.prompt || fallbackPrompt;
  return { ...result, prompt };
}

function normalizeImagePlanItems(planner: FreeModePlannerResult): FreeModeImagePlanItem[] {
  if (planner.images?.length) return planner.images;
  return [{ prompt: planner.prompt || '', size: planner.size, count: planner.count, quality: planner.quality }];
}

function resolveImageMode(planner: FreeModePlannerResult, inputImages: string[], preferEditWhenImagePresent: boolean): FreeModeImageMode {
  if (planner.mode === 'edit') return 'edit';
  if (planner.mode === 'generate') return 'generate';
  return preferEditWhenImagePresent && inputImages.length > 0 ? 'edit' : 'generate';
}

function extractJsonObject(value: string): unknown {
  const cleaned = cleanupModelText(value);
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return undefined;
}

function cleanupModelText(value: string): string {
  return String(value || '').trim().replace(/^```(?:json|text)?/i, '').replace(/```$/i, '').trim();
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
