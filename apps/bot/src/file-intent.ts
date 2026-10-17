import type { FileIntentConfig } from '../../../packages/config/src/index.js';
import type { GeneratedFileType } from '../../../packages/filegen/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';

export interface FileIntentFallback {
  shouldGenerate: boolean;
  fileType?: GeneratedFileType;
}

export interface FileIntentDecision extends FileIntentFallback {
  confidence: number;
  source: 'model' | 'regex' | 'skipped';
  reason?: string;
}

export interface FileIntentClassifierOptions {
  client: Pick<ModelClient, 'chat'> | undefined;
  text: string;
  config: FileIntentConfig;
  fallback: FileIntentFallback;
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

/** 宽泛的候选预筛：只有看起来可能在要文件时才花一次小模型调用。 */
export const FILE_INTENT_CANDIDATE_RE = /(?:生成|创建|制作|导出|整理|做成|写一份|写一个|写个|做一份|做一个|来一份|给我一份|帮我(?:生成|创建|制作|导出|整理|写|做))/i;

const ALLOWED_TYPES = new Set<GeneratedFileType>(['txt', 'md', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'pdf', 'zip']);

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeType(value: unknown): GeneratedFileType | undefined {
  const type = String(value || '').toLowerCase().trim() as GeneratedFileType;
  return ALLOWED_TYPES.has(type) ? type : undefined;
}

export async function classifyFileIntent(options: FileIntentClassifierOptions): Promise<FileIntentDecision> {
  const config = options.config;
  const text = String(options.text || '').trim();
  const fallback = options.fallback;
  const fallbackDecision = (reason?: string): FileIntentDecision => ({
    ...fallback,
    confidence: fallback.shouldGenerate ? 1 : 0,
    source: 'regex',
    reason,
  });

  if (!text) return fallbackDecision('empty');
  if (!config?.enabled) return fallbackDecision('disabled');
  if (config.prefilter && !FILE_INTENT_CANDIDATE_RE.test(text)) return { shouldGenerate: false, confidence: 0, source: 'skipped', reason: 'prefilter' };
  if (!options.client || typeof options.client.chat !== 'function' || !config.model) return fallbackDecision('classifier-unavailable');

  const prompt = String(config.promptTemplate || '').replaceAll('{{userContent}}', text.slice(0, 2000));
  try {
    const result = await options.client.chat(config.nodeIndex, {
      model: config.model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text.slice(0, 2000) },
      ],
      timeoutMs: config.timeoutMs,
      maxTokens: 160,
    });
    const parsed = parseJsonObject(String(result.text || ''));
    if (!parsed) return fallbackDecision('invalid-json');
    const intent = String(parsed.intent || '').trim();
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const modelType = normalizeType(parsed.fileType);
    if (confidence < config.minConfidence) return fallbackDecision('low-confidence');
    if (intent === 'file.generate') {
      return { shouldGenerate: true, fileType: modelType || fallback.fileType, confidence, source: 'model', reason: String(parsed.reason || '') };
    }
    if (intent === 'chat') {
      return { shouldGenerate: false, confidence, source: 'model', reason: String(parsed.reason || '') };
    }
    return fallbackDecision('unknown-intent');
  } catch (error) {
    options.logger?.warn('文件生成意图分类失败，回退正则', { error: String((error as Error)?.message || error) });
    return fallbackDecision('classifier-error');
  }
}
