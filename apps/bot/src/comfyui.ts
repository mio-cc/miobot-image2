import type { AppConfig, ApiNode, ComfyUiProfile, ComfyUiTransformConfig } from '../../../packages/config/src/index.js';
import type { ImageArtifact, ImageResult, ModelClient } from '../../../packages/model/src/index.js';
import { runComfyUiWorkflow } from '../../../packages/comfyui/src/index.js';
import { stitchImages } from '../../../packages/image-compose/src/index.js';

export interface ComfyUiGenerateOptions {
  getConfig: () => AppConfig;
  client: ModelClient;
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

export interface ComfyUiGenerateRequest {
  nodeIndex: number;
  profileId: string;
  prompt: string;
  count?: number;
  timeoutMs?: number;
}

interface TransformResult {
  params: Record<string, unknown>;
  source: 'model' | 'fallback';
  confidence: number;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function fallbackParams(profile: ComfyUiProfile, prompt: string, count: number | undefined, maxBatchSize: number): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...(profile.defaults || {}),
    prompt,
    batchSize: 1,
  };
  if (profile.defaults?.negativePrompt !== undefined) params.negativePrompt = profile.defaults.negativePrompt;
  if (profile.parameterMap?.batchSize && count && Number.isFinite(Number(count))) params.batchSize = Math.min(maxBatchSize, Math.max(1, Math.trunc(Number(count))));
  return params;
}

function mergeTransformConfig(global: ComfyUiTransformConfig, profile: ComfyUiProfile): ComfyUiTransformConfig {
  const local = profile.transform || {};
  return {
    ...global,
    ...(local.enabled === undefined ? {} : { enabled: local.enabled }),
    ...(local.nodeIndex === undefined || local.nodeIndex === 0 ? {} : { nodeIndex: local.nodeIndex }),
    ...(local.model ? { model: local.model } : {}),
    ...(local.timeoutMs ? { timeoutMs: local.timeoutMs } : {}),
    ...(local.maxTokens ? { maxTokens: local.maxTokens } : {}),
    ...(local.promptTemplate ? { promptTemplate: local.promptTemplate } : {}),
  };
}

function applyTransformParams(profile: ComfyUiProfile, raw: Record<string, unknown>, prompt: string, count: number | undefined, maxBatchSize: number): Record<string, unknown> {
  const defaults = profile.defaults || {};
  const constraints = profile.constraints || {};
  const allowed = new Set([...Object.keys(profile.parameterMap || {}), ...Object.keys(defaults), ...Object.keys(constraints)]);
  const out: Record<string, unknown> = { ...defaults };
  for (const key of allowed) {
    if (raw[key] === undefined) continue;
    let value: any = raw[key];
    const constraint = constraints[key];
    if (constraint?.type === 'number' || typeof value === 'number') {
      let n = Number(value);
      if (!Number.isFinite(n)) continue;
      if (constraint?.min !== undefined) n = Math.max(constraint.min, n);
      if (constraint?.max !== undefined) n = Math.min(constraint.max, n);
      value = Math.trunc(n);
    }
    if (constraint?.enum?.length && !constraint.enum.includes(String(value))) {
      value = defaults[key];
    }
    if (value !== undefined) out[key] = value;
  }
  out.prompt = String(raw.prompt || prompt || defaults.prompt || '') || prompt;
  if (out.negativePrompt === undefined && defaults.negativePrompt !== undefined) out.negativePrompt = defaults.negativePrompt;
  const requestedCount = Math.trunc(Number(count || raw.batchSize || defaults.batchSize || 1));
  out.batchSize = profile.parameterMap?.batchSize ? Math.min(maxBatchSize, Math.max(1, requestedCount || 1)) : 1;
  return out;
}

async function transformParams(options: ComfyUiGenerateOptions, profile: ComfyUiProfile, prompt: string, count: number | undefined, maxBatchSize: number): Promise<TransformResult> {
  const cfg = options.getConfig();
  const transform = mergeTransformConfig(cfg.comfyuiTransform, profile);
  const fallback = fallbackParams(profile, prompt, count, maxBatchSize);
  if (!transform.enabled || !transform.model) return { params: fallback, source: 'fallback', confidence: 0 };
  try {
    const renderedPrompt = String(transform.promptTemplate || '')
      .replaceAll('{{userRequest}}', prompt.slice(0, 4000))
      .replaceAll('{{defaults}}', JSON.stringify(profile.defaults || {}))
      .replaceAll('{{constraints}}', JSON.stringify(profile.constraints || {}))
      .replaceAll('{{maxBatchSize}}', String(maxBatchSize));
    const result = await options.client.chat(transform.nodeIndex, {
      model: transform.model,
      messages: [{ role: 'user', content: renderedPrompt }],
      timeoutMs: transform.timeoutMs,
      maxTokens: transform.maxTokens,
    });
    const parsed = parseJsonObject(String(result.text || ''));
    if (!parsed) throw new Error('参数转化模型没有返回 JSON');
    const confidence = Math.max(0, Math.min(1, Number((parsed as any).confidence) || 0.8));
    return { params: applyTransformParams(profile, parsed, prompt, count, maxBatchSize), source: 'model', confidence };
  } catch (error) {
    options.logger?.warn('ComfyUI 参数转化失败，使用后台默认参数兜底', { error: String((error as Error)?.message || error) });
    return { params: fallback, source: 'fallback', confidence: 0 };
  }
}

function findProfile(node: ApiNode, profileId: string): ComfyUiProfile | undefined {
  const profiles = node.comfyui?.profiles || [];
  return profiles.find((item) => item.id === profileId || item.name === profileId) || profiles[0];
}

export async function generateComfyUiImages(options: ComfyUiGenerateOptions, req: ComfyUiGenerateRequest): Promise<ImageResult> {
  const cfg = options.getConfig();
  const node = cfg.llm.apiKeys[req.nodeIndex];
  if (!node || node.kind !== 'comfyui' || !node.comfyui) throw new Error('当前生图节点不是 ComfyUI');
  const profile = findProfile(node, req.profileId);
  if (!profile) throw new Error('ComfyUI 节点没有可用 profile');
  const transformed = await transformParams(options, profile, req.prompt, req.count, node.comfyui.maxBatchSize);
  options.logger?.info('ComfyUI 参数准备完成', {
    profile: profile.id,
    source: transformed.source,
    confidence: transformed.confidence,
    promptCount: String(transformed.params.prompt || '').length,
    batchSize: transformed.params.batchSize,
  });
  const result = await runComfyUiWorkflow({
    baseUrl: node.baseUrl,
    apiKey: node.key,
    headers: node.headers,
    profile,
    params: transformed.params,
    node: node.comfyui,
    outputNodeId: profile.outputNodeId,
    maxImageBytes: 20 * 1024 * 1024,
  });
  const images = result.images;
  if (!images.length) throw new Error('ComfyUI 没有生成图片');
  let output = images;
  let outputMime = images[0].mime;
  if (profile.stitch?.enabled !== false && images.length > 1) {
    try {
      const stitched = await stitchImages(images.map((item) => item.buffer), profile.stitch || { quality: 70 });
      output = [{ filename: 'comfyui-stitched.jpg', subfolder: '', type: 'output', mime: stitched.mime, buffer: stitched.buffer }];
      outputMime = stitched.mime;
      options.logger?.info('ComfyUI 多图已拼接', { count: images.length, width: stitched.width, height: stitched.height, mime: stitched.mime });
    } catch (error) {
      options.logger?.warn('ComfyUI 多图拼接失败，发送第一张图', { error: String((error as Error)?.message || error) });
      output = [images[0]];
    }
  }
  const artifacts: ImageArtifact[] = output.map((item, index) => ({
    kind: 'base64',
    data: item.buffer.toString('base64'),
    mimeType: item.mime || outputMime,
    index,
  }));
  return { images: artifacts, raw: { promptId: result.promptId, seed: result.seed, source: images } };
}
