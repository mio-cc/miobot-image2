/**
 * 把整形结果落成「真正要发出去的请求对象」（2026-11-19）。
 *
 * 抽出来的原因：面板 dry-run 与真实调用必须走**同一段代码**，否则出现
 * 「面板显示会发 1024x1536，实际发了 1152x1536」这种比没有更糟的情况。
 * client.ts 的 shapeImageGeneration / shapeImageEdit 现在只是这里的薄壳。
 */
import type { ImageEditRequest, ImageGenerationRequest } from '../ports.js';
import type { ModelParamContract } from './contract.js';
import { shapeImageParams, type ShapedImageParams } from './shape-request.js';

export interface ShapeProfileHints {
  supportsCount?: boolean;
  maxImagesPerRequest?: number;
  supportsMask?: boolean;
}

export interface ShapeOutcome<T> {
  request: T;
  shaped: ShapedImageParams;
}

function clampCount(value: number | undefined, max: number | undefined): number {
  const count = Math.trunc(Number(value) || 1);
  const cap = Math.max(1, Math.trunc(Number(max) || 4));
  return Math.min(cap, Math.max(1, count));
}

/** 生图请求整形：契约优先，无契约保守。 */
export function shapeGenerationRequest(
  req: ImageGenerationRequest,
  contract: ModelParamContract | undefined,
  hints: ShapeProfileHints = {},
): ShapeOutcome<ImageGenerationRequest> {
  const shaped = shapeImageParams({
    model: req.model,
    prompt: req.prompt,
    ...(req.size !== undefined ? { size: req.size } : {}),
    ...(req.count !== undefined ? { count: req.count } : {}),
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    ...(req.background !== undefined ? { background: req.background } : {}),
    ...(req.outputFormat !== undefined ? { outputFormat: req.outputFormat } : {}),
    ...(req.outputCompression !== undefined ? { outputCompression: req.outputCompression } : {}),
    ...(req.moderation !== undefined ? { moderation: req.moderation } : {}),
    ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
  }, contract);

  const request: ImageGenerationRequest = { ...req };
  delete request.size; delete request.quality; delete request.background; delete request.outputFormat;
  delete request.outputCompression; delete request.moderation; delete request.reasoningEffort;
  if (shaped.size !== undefined) request.size = shaped.size;
  if (shaped.quality !== undefined) request.quality = shaped.quality;
  if (shaped.background !== undefined) request.background = shaped.background;
  if (shaped.outputFormat !== undefined) request.outputFormat = shaped.outputFormat;
  if (shaped.outputCompression !== undefined) request.outputCompression = shaped.outputCompression;
  if (shaped.moderation !== undefined) request.moderation = shaped.moderation;
  if (shaped.reasoningEffort !== undefined) request.reasoningEffort = shaped.reasoningEffort;
  request.count = hints.supportsCount === false ? 1 : clampCount(shaped.count ?? req.count, hints.maxImagesPerRequest);
  return { request, shaped };
}

/** 改图请求整形：契约优先，无契约保守（只发 prompt + images）。 */
export function shapeEditRequest(
  req: ImageEditRequest,
  contract: ModelParamContract | undefined,
  hints: ShapeProfileHints = {},
): ShapeOutcome<ImageEditRequest> {
  const shaped = shapeImageParams({
    model: req.model,
    prompt: req.prompt,
    ...(req.size !== undefined ? { size: req.size } : {}),
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    ...(req.background !== undefined ? { background: req.background } : {}),
    ...(req.outputFormat !== undefined ? { outputFormat: req.outputFormat } : {}),
    ...(req.outputCompression !== undefined ? { outputCompression: req.outputCompression } : {}),
    ...(req.moderation !== undefined ? { moderation: req.moderation } : {}),
    ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
  }, contract);

  const request: ImageEditRequest = { ...req };
  delete request.size; delete request.quality; delete request.background; delete request.outputFormat;
  delete request.outputCompression; delete request.moderation; delete request.reasoningEffort;
  if (shaped.size !== undefined) request.size = shaped.size;
  if (shaped.quality !== undefined) request.quality = shaped.quality;
  if (shaped.background !== undefined) request.background = shaped.background;
  if (shaped.outputFormat !== undefined) request.outputFormat = shaped.outputFormat;
  if (shaped.outputCompression !== undefined) request.outputCompression = shaped.outputCompression;
  if (shaped.moderation !== undefined) request.moderation = shaped.moderation;
  if (shaped.reasoningEffort !== undefined) request.reasoningEffort = shaped.reasoningEffort;
  if (hints.supportsMask === false) delete request.mask;
  return { request, shaped };
}