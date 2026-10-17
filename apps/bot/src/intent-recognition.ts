import type { IntentRecognitionConfig } from '../../../packages/config/src/index.js';
import type { GeneratedFileType } from '../../../packages/filegen/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';

export interface IntentCatalogItem {
  id: string;
  label: string;
  description: string;
  requires?: 'images' | 'files';
}

export interface IntentFallback {
  intent: string;
  args: string;
  fileType?: GeneratedFileType;
  confidence: number;
}

export interface IntentClassification extends IntentFallback {
  source: 'model' | 'regex';
  reason?: string;
}

export interface IntentClassifierOptions {
  client: Pick<ModelClient, 'chat'> | undefined;
  text: string;
  config: IntentRecognitionConfig;
  catalog: IntentCatalogItem[];
  context: { chatType: 'group' | 'private'; hasImages: boolean; hasFiles: boolean };
  fallback: IntentFallback;
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

const ALLOWED_FILE_TYPES = new Set<GeneratedFileType>(['txt', 'md', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'pdf', 'zip']);

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

function modelFileType(value: unknown): GeneratedFileType | undefined {
  const type = String(value || '').toLowerCase().trim() as GeneratedFileType;
  return ALLOWED_FILE_TYPES.has(type) ? type : undefined;
}

export async function classifyNaturalLanguageIntent(options: IntentClassifierOptions): Promise<IntentClassification> {
  const config = options.config;
  const text = String(options.text || '').trim();
  const fallback = (reason: string): IntentClassification => ({ ...options.fallback, source: 'regex', reason });

  if (!text) return fallback('empty');
  if (!config?.enabled) return fallback('disabled');
  if (!options.client || typeof options.client.chat !== 'function' || !config.model) return fallback('classifier-unavailable');

  const prompt = String(config.promptTemplate || '')
    .replaceAll('{{intents}}', JSON.stringify(options.catalog))
    .replaceAll('{{context}}', JSON.stringify(options.context))
    .replaceAll('{{userContent}}', text.slice(0, 2000));
  try {
    const result = await options.client.chat(config.nodeIndex, {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      timeoutMs: config.timeoutMs,
      maxTokens: 240,
    });
    const parsed = parseJsonObject(String(result.text || ''));
    if (!parsed) return fallback('invalid-json');
    const intent = String(parsed.intent || '').trim();
    const item = options.catalog.find((entry) => entry.id === intent);
    if (!item && intent !== 'chat') return fallback('unknown-intent');
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    if (confidence < config.minConfidence) return fallback('low-confidence');
    if (item?.requires === 'images' && !options.context.hasImages) return fallback('images-required');
    if (item?.requires === 'files' && !options.context.hasFiles) return fallback('files-required');
    const args = String(parsed.args || text).trim().slice(0, 4000) || text;
    return {
      intent,
      args,
      fileType: modelFileType(parsed.fileType) || options.fallback.fileType,
      confidence,
      source: 'model',
      reason: String(parsed.reason || ''),
    };
  } catch (error) {
    options.logger?.warn('自然语言意图识别失败，回退正则', { error: String((error as Error)?.message || error) });
    return fallback('classifier-error');
  }
}
