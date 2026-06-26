import type { IntentInput, IntentKind } from './types.js';

/**
 * LLM 规划器：仅在确定性信号无法判定时调用。
 * 关键改进：当存在图片时，使用多模态 content（image_url）把图片真正传给模型，
 * 使其能够判断"描述这张图 / 基于这张图改 / 重新生成"等需要看到图才能判定的意图。
 */

export interface PlannerMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

export interface PlannerClient {
  createText(request: { model: string; messages: PlannerMessage[]; timeoutMs?: number; maxTokens?: number }): Promise<{ text: string; raw?: unknown }>;
}

export type PlannerAction = 'text' | 'generate' | 'edit' | 'interrogate';

export interface PlannerOutput {
  action: PlannerAction;
  text?: string;
  prompt?: string;
  size?: string;
  count?: number;
  quality?: string;
}

export const DEFAULT_PLANNER_TEMPLATE = [
  'You are the bot intent planner. Read the user message (and attached images, if any) and decide the single best action.',
  'Return JSON only, no prose, one of:',
  '  {"action":"text","text":"<conversational reply>"}',
  '  {"action":"generate","prompt":"<image prompt>","size":"1024x1024","count":1}',
  '  {"action":"edit","prompt":"<edit instruction>"}',
  '  {"action":"interrogate"}',
  'Rules:',
  '- Use "edit" only when input images are present AND the user wants to modify an image.',
  '- Use "interrogate" when the user wants the image described / reverse-prompted.',
  '- Use "generate" for text-to-image requests.',
  '- Otherwise use "text".',
  '- Preserve the user content language in prompt/text; if the user content is Chinese, keep Chinese unless the user explicitly asks for English.',
  'User content: {{userContent}}',
].join('\n');

export interface BuildPlannerMessagesOptions {
  template?: string;
  /** 是否允许把图片以多模态形式传入（取决于规划模型是否具备 vision 能力）。 */
  visionEnabled?: boolean;
  preferEditWhenImagePresent?: boolean;
}

export function buildPlannerMessages(input: IntentInput, options: BuildPlannerMessagesOptions = {}): PlannerMessage[] {
  const template = options.template || DEFAULT_PLANNER_TEMPLATE;
  const images = (input.images || []).filter(Boolean);
  const hasImages = Boolean(images.length || input.hasReferencedImage);
  const preference = options.preferEditWhenImagePresent !== false
    ? 'When input images are present and the user asks to modify them, prefer "edit".'
    : 'Do not assume "edit" merely because images are present.';
  const imageNote = hasImages
    ? `\n\n[Images attached: ${images.length || 'referenced'}]`
    : '\n\n[No images attached]';
  const userText = `${String(input.text || '').trim() || '(no text)'}${imageNote}`;
  const systemPrompt = `${template.replaceAll('{{userContent}}', userText)}\n\n${preference}`;

  // 有图且开启 vision：把图片以 image_url 形式拼进 user content，让模型"看见"图片。
  if (hasImages && options.visionEnabled && images.length) {
    const content = [
      { type: 'text', text: userText },
      ...images.slice(0, 6).map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ];
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];
}

export function parsePlannerOutput(raw: string): PlannerOutput {
  const parsed = extractJsonObject(raw);
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const actionRaw = String(record.action ?? record.type ?? '').toLowerCase();
    const action = normalizeAction(actionRaw, record);
    if (action === 'text') {
      return { action: 'text', text: String(record.text ?? record.reply ?? record.content ?? '').trim() || cleanupModelText(raw) };
    }
    if (action === 'interrogate') {
      return { action: 'interrogate' };
    }
    return {
      action,
      prompt: String(record.prompt ?? record.imagePrompt ?? record.description ?? '').trim(),
      size: nonEmpty(record.size ?? record.resolution),
      count: numberOrUndefined(record.count ?? record.n),
      quality: nonEmpty(record.quality),
    };
  }
  // 非 JSON：当作普通文本回复。
  return { action: 'text', text: cleanupModelText(raw) };
}

export function plannerActionToIntentKind(action: PlannerAction): IntentKind {
  switch (action) {
    case 'generate': return 'image.generate';
    case 'edit': return 'image.edit';
    case 'interrogate': return 'image.interrogate';
    default: return 'chat';
  }
}

function normalizeAction(actionRaw: string, record: Record<string, unknown>): PlannerAction {
  if (actionRaw === 'edit') return 'edit';
  if (actionRaw === 'interrogate' || actionRaw === 'describe' || actionRaw === 'caption') return 'interrogate';
  if (actionRaw === 'generate' || actionRaw === 'image' || actionRaw === 'images') return 'generate';
  if (actionRaw === 'text' || actionRaw === 'chat' || actionRaw === 'reply') return 'text';
  // 兼容旧 planner：mode=edit/generate + 有 prompt 即视为图像。
  const mode = String(record.mode ?? '').toLowerCase();
  if (mode === 'edit') return 'edit';
  if (record.prompt || record.imagePrompt || mode === 'generate') return 'generate';
  return 'text';
}

// ── 解析工具 ──────────────────────────────────────────────────────────────

function extractJsonObject(value: string): unknown {
  const cleaned = cleanupModelText(value);
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  return undefined;
}

function cleanupModelText(value: string): string {
  return String(value || '').trim().replace(/^```(?:json|text)?/i, '').replace(/```$/i, '').trim();
}

function nonEmpty(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
