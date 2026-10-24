import type { BotApp } from './app.js';
import type { BotEngineInput, BotEngineResult } from '../../../packages/bot-engine/src/index.js';
import type { CapabilityHandler, CapabilityInvocation, ExecutionOutput, ExecutionResult } from '../../../packages/orchestration/src/index.js';

export type LegacyCapabilityKind = 'image.generate' | 'image.edit' | 'image.interrogate' | 'video.generate' | 'chat.reply';

export class LegacyEngineCapabilityHandler implements CapabilityHandler {
  constructor(
    private readonly app: BotApp,
    private readonly kind: LegacyCapabilityKind,
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
      result = await this.app.engine.handleExplicit(this.kind as any, input, {
        prompt: String(args.prompt || input.text || ''),
        size: typeof args.size === 'string' ? args.size : undefined,
        width: Number.isFinite(Number(args.width)) ? Number(args.width) : undefined,
        height: Number.isFinite(Number(args.height)) ? Number(args.height) : undefined,
        count: Number.isFinite(Number(args.count)) ? Number(args.count) : undefined,
        quality: typeof args.quality === 'string' ? args.quality : undefined,
        templateId: typeof args.templateId === 'string' ? args.templateId : undefined,
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
      diagnostics: { legacyKind: result.kind, source: result.decision?.source },
    };
  }
}
