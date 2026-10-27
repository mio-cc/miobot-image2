import type { CapabilityHandler, CapabilityInvocation, ExecutionOutput, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import type { CanvasStore } from '../../../packages/canvas-service/src/index.js';
import { resolvePublicImageBaseUrl } from './canvas-gallery.js';

export class CanvasGalleryCapabilityHandler implements CapabilityHandler {
  constructor(private readonly store: CanvasStore) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const limit = Math.max(1, Math.min(6, Math.trunc(Number(invocation.step.args?.count) || 6)));
    const items = this.store.gallery().filter((item) => item.status === 'succeeded' && item.asset?.url).slice(0, limit);
    const publicBase = resolvePublicImageBaseUrl();
    const imageUrl = (url: string) => url.startsWith('/') && publicBase ? publicBase.replace(/\/$/, '') + url : url;
    const outputs: ExecutionOutput[] = items.map((item) => ({
      kind: 'image', url: imageUrl(item.asset.url), priority: 9, mergeable: true,
      // 这是历史图库读取，不是新生成产物；不能被 postProcessReplyPlanOutputs 再回灌一次。
      meta: { prompt: item.prompt, createdAt: item.createdAt, sourceCapability: 'canvas.gallery', readOnlyArtifact: true },
    }));
    if (!outputs.length) outputs.push({ kind: 'text', text: '图库暂时为空。', priority: 10, mergeable: true });
    return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs };
  }
}
