import type { BotApp } from './app.js';
import type { RuntimeInput as BotEngineInput, RuntimeResult as BotEngineResult } from './runtime-types.js';
import type { CapabilityHandler, CapabilityInvocation, ExecutionOutput, ExecutionResult } from '../../../packages/orchestration/src/index.js';

export type ModelCapabilityKind = 'image.generate' | 'image.edit' | 'image.interrogate' | 'video.generate' | 'chat.reply';

/** 图片 size 预设 -> 真实宽高；执行层统一收口。 */
const IMAGE_SIZE_PRESETS: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 1024, height: 1536 },
  'portrait-3-4': { width: 1152, height: 1536 },
  portrait34: { width: 1152, height: 1536 },
  landscape: { width: 1536, height: 1024 },
  'landscape-4-5': { width: 1280, height: 1024 },
  landscape45: { width: 1280, height: 1024 },
};

export function resolveImageSize(value: unknown): { size?: string; width?: number; height?: number } {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return {};
  const preset = IMAGE_SIZE_PRESETS[raw];
  if (preset) return { size: `${preset.width}x${preset.height}`, width: preset.width, height: preset.height };
  if (/^\d{2,5}x\d{2,5}$/.test(raw)) {
    const [width, height] = raw.split('x').map((item) => Math.max(1, Math.trunc(Number(item))));
    return { size: `${width}x${height}`, width, height };
  }
  return { size: raw };
}

export function mergeImageUrls(primary: string[], extra: unknown): string[] {
  const value = typeof extra === 'string' ? extra.trim() : '';
  return Array.from(new Set([...primary, ...(value ? [value] : [])].filter(Boolean)));
}

export class ModelCapabilityHandler implements CapabilityHandler {
  constructor(
    private readonly app: BotApp,
    private readonly kind: ModelCapabilityKind,
  ) {}

  private input(invocation: CapabilityInvocation): BotEngineInput {
    const args = invocation.step.args || {};
    const images = (invocation.request.attachments || [])
      .map((item: any) => String(item.ref || item.url || item.data || '').trim())
      .filter(Boolean);
    const text = String(args.prompt || invocation.request.text || '');
    return {
      text,
      images,
      chatType: invocation.request.chat.type,
      featureContext: {
        chatType: invocation.request.chat.type,
        groupId: invocation.request.chat.groupId,
        userId: invocation.request.user.qq,
        promptChars: text.length,
      },
      sessionId: invocation.request.chat.type === 'group'
        ? `group:${invocation.request.chat.groupId}:${invocation.request.user.qq}`
        : `private:${invocation.request.user.qq}`,
    };
  }

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const input = this.input(invocation);
    let result: BotEngineResult;
    if (this.kind === 'chat.reply') {
      result = await this.app.engine.handleExplicit('chat', input, { prompt: input.text });
    } else {
      const args = invocation.step.args || {};
      if (this.kind === 'image.edit') input.images = mergeImageUrls(input.images || [], args.imageUrl);
      if (this.kind === 'image.edit' && !(input.images?.length)) {
        return {
          jobId: invocation.plan.planId,
          stepId: invocation.step.id,
          status: 'needs_input',
          outputs: [{ kind: 'text', text: '请先发送一张图片，或引用一条带图片的消息，再进行图片编辑。', priority: 10, mergeable: true }],
          diagnostics: { missingInformation: ['参考图'] },
        };
      }
      const size = resolveImageSize(args.size);
      result = await this.app.engine.handleExplicit(this.kind as any, input, {
        prompt: String(args.prompt || input.text || ''),
        ...(size.size !== undefined ? { size: size.size } : {}),
        ...(size.width !== undefined ? { width: size.width } : {}),
        ...(size.height !== undefined ? { height: size.height } : {}),
        ...(Number.isFinite(Number(args.width)) && size.width === undefined ? { width: Number(args.width) } : {}),
        ...(Number.isFinite(Number(args.height)) && size.height === undefined ? { height: Number(args.height) } : {}),
        ...(Number.isFinite(Number(args.count)) ? { count: Number(args.count) } : {}),
        ...(typeof args.quality === 'string' ? { quality: args.quality } : {}),
        ...(typeof args.templateId === 'string' ? { templateId: args.templateId } : {}),
        tokens: Array.isArray(args.tokens) ? args.tokens.map(String) : [],
      });
    }
    const outputs: ExecutionOutput[] = [];
    if (result.text) outputs.push({ kind: 'text', text: result.text, priority: 10, mergeable: true });
    for (const image of result.images || []) outputs.push({ kind: 'image', url: image, priority: 9, mergeable: true });
    for (const video of result.videos || []) outputs.push({ kind: 'video', url: video, priority: 8, mergeable: true });
    for (const file of result.files || []) {
      const value = typeof file === 'string' ? { file } : file;
      outputs.push({ kind: 'file', url: value.file, priority: 5, mergeable: false, meta: { name: value.name } });
    }
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: result.handled ? 'success' : 'failed',
      outputs,
      error: result.handled ? undefined : result.decision?.reason,
      retryable: false,
      diagnostics: { modelKind: result.kind, source: result.decision?.source },
    };
  }
}
