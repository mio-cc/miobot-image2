import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { SunoClient } from '../../../packages/orchestration/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { SunoComposedSpec } from './suno-composer.js';

export interface SunoCapabilityOptions {
  getConfig: () => AppConfig;
  logger?: StructuredLogger;
  createClient?: (config: AppConfig['orchestration']['suno']) => Pick<SunoClient, 'create' | 'wait'>;
  compose?: (args: Record<string, unknown>, request: any) => Promise<SunoComposedSpec>;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class SunoCapabilityHandler implements CapabilityHandler {
  private active = 0;
  private readonly queue: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly usage = new Map<string, { day: string; count: number }>();

  constructor(private readonly options: SunoCapabilityOptions) {}

  private quotaKey(userQq: string): string {
    return new Date().toISOString().slice(0, 10) + ':' + userQq;
  }

  private checkAndReserveQuota(userQq: string, quota: number): void {
    if (quota <= 0) return;
    const key = this.quotaKey(userQq);
    const day = key.slice(0, 10);
    const current = this.usage.get(key);
    const count = current?.day === day ? current.count : 0;
    if (count >= quota) throw new Error('suno_quota_exceeded');
    this.usage.set(key, { day, count: count + 1 });
  }

  private async acquireSlot(config: AppConfig['orchestration']['suno'], userQq: string): Promise<void> {
    const maxConcurrent = Math.max(1, Math.trunc(Number(config.maxConcurrent) || 1));
    const maxQueue = Math.max(0, Math.trunc(Number(config.maxQueue) || 0));
    if (this.active >= maxConcurrent && this.queue.length >= maxQueue) {
      throw new Error('suno_queue_full');
    }
    this.checkAndReserveQuota(userQq, Math.max(0, Math.trunc(Number(config.quotaPerUserPerDay) || 0)));
    if (this.active < maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  private async withRetry<T>(task: () => Promise<T>, maxRetries: number): Promise<T> {
    const retries = Math.max(0, Math.trunc(Number(maxRetries) || 0));
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        const message = String((error as Error)?.message || error);
        const retryable = !/suno_(?:http_4|quota|queue|base_url_missing|task_id_missing|unauthorized|forbidden)/i.test(message);
        if (!retryable || attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * (attempt + 1))));
      }
    }
    throw lastError;
  }
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const cfg = this.options.getConfig().orchestration.suno;
    if (!cfg.enabled) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: 'suno_disabled' };
    }
    const args = invocation.step.args || {};
    const rawUserText = stringArg(args, 'request') || stringArg(args, 'prompt') || invocation.request.text;
    let composed: SunoComposedSpec | undefined;
    if (this.options.compose) {
      try { composed = await this.options.compose(args, invocation.request); }
      catch (error) { this.options.logger?.warn('Suno composer failed', { error: String((error as Error)?.message || error) }); }
    }
    if (!rawUserText && !composed?.style && !composed?.lyrics) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'needs_input', outputs: [], diagnostics: { missingInformation: ['音乐主题', '风格或情绪', '歌词与纯音乐偏好', '语言或时长'], detail: 'music request is underspecified' } };
    }
    if (!this.options.createClient && (cfg.requestMode || 'v6') === 'v6' && !String(cfg.callbackUrl || '').trim()) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: 'suno_callback_url_missing' };
    }
    const client = this.options.createClient
      ? this.options.createClient(cfg)
      : new SunoClient({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: composed?.model || cfg.model,
          requestMode: cfg.requestMode,
          callbackUrl: cfg.callbackUrl,
          createPath: cfg.createPath,
          statusPath: cfg.statusPath,
          authHeader: cfg.authHeader,
          authPrefix: cfg.authPrefix,
          timeoutMs: cfg.timeoutMs,
          pollIntervalMs: cfg.pollIntervalMs,
        });
    const requestedDurationRaw = composed?.duration ?? Number(args.duration);
    const requestedDuration = Number.isFinite(requestedDurationRaw) && requestedDurationRaw > 0
      ? Math.min(Number(requestedDurationRaw), cfg.maxDurationSeconds)
      : undefined;
    const generationInput = {
      prompt: composed?.customMode ? '' : (composed?.musicBrief || rawUserText || ''),
      lyrics: composed?.lyrics || stringArg(args, 'lyrics'),
      title: composed?.title || stringArg(args, 'title'),
      style: composed?.style || stringArg(args, 'style'),
      instrumental: composed ? composed.instrumental : Boolean(args.instrumental),
      customMode: composed?.customMode,
      model: composed?.model || cfg.model,
      callbackUrl: cfg.callbackUrl,
      duration: requestedDuration,
      referenceAudio: stringArg(args, 'referenceAudio'),
      format: cfg.format,
      negativeTags: composed?.negativeTags || stringArg(args, 'negativeTags'),
      vocalGender: composed?.vocalGender || (args.vocalGender === 'm' || args.vocalGender === 'f' ? args.vocalGender : undefined),
      styleWeight: composed?.styleWeight,
      weirdnessConstraint: composed?.weirdnessConstraint,
      audioWeight: composed?.audioWeight,
      variety: composed?.variety,
      imageUrls: Array.isArray(args.imageUrls) ? args.imageUrls.map(String) : undefined,
      videoUrls: Array.isArray(args.videoUrls) ? args.videoUrls.map(String) : undefined,
      audioUrls: Array.isArray(args.audioUrls) ? args.audioUrls.map(String) : undefined,
      personaId: stringArg(args, 'personaId'),
      personaModel: args.personaModel === 'voice_persona' ? 'voice_persona' as const : args.personaModel === 'style_persona' ? 'style_persona' as const : undefined,
    };    let acquired = false;
    try {
      await this.acquireSlot(cfg, invocation.request.user.qq);
      acquired = true;
      const created = await this.withRetry(() => client.create(generationInput), cfg.maxRetries);
      const task = await this.withRetry(() => client.wait(created.id, { timeoutMs: cfg.timeoutMs }), cfg.maxRetries);
      if (task.status !== 'success') {
        return {
          jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed',
          outputs: [], error: `suno_task_${task.status}`, diagnostics: { taskId: created.id, raw: task.raw }, retryable: task.status !== 'failed',
        };
      }
      // Suno V6 对一次请求通常会返回两个 variant；这里只交付第一首，并且不返回歌曲封面。
      const first = task.outputs.find((item) => Boolean(item.url));
      const outputs = first?.url
        ? [{ kind: 'audio' as const, url: first.url, priority: 10, mergeable: false, meta: { title: first.title, lyrics: first.lyrics, provider: 'suno-official' } }]
        : [];
      this.options.logger?.info('Suno 任务完成，只交付首曲且不发送封面', { taskId: created.id, generatedVariants: task.outputs.length, returnedAudio: outputs.length, discardedCoverCount: task.outputs.filter((item) => Boolean(item.coverUrl)).length });
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs, diagnostics: { taskId: created.id, generatedVariants: task.outputs.length, returnedAudio: outputs.length } };
    } catch (error) {
      this.options.logger?.warn('Suno 能力执行失败', { error: String((error as Error)?.message || error) });
      const message = String((error as Error)?.message || error);
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: message, retryable: false };
    } finally {
      if (acquired) this.releaseSlot();
    }
  }
}
