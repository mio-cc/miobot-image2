import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { SunoClient } from '../../../packages/orchestration/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { SunoComposedSpec } from './suno-composer.js';
import type { SunoSongHistoryStore } from './suno-song-history.js';

export interface SunoCapabilityOptions {
  getConfig: () => AppConfig;
  logger?: StructuredLogger;
  createClient?: (config: AppConfig['orchestration']['suno']) => Pick<SunoClient, 'create' | 'wait'>;
  compose?: (args: Record<string, unknown>, request: any) => Promise<SunoComposedSpec>;
  composeSafeFallback?: (args: Record<string, unknown>, request: any) => SunoComposedSpec;
  history?: SunoSongHistoryStore;
}

function appendLanguageHint(value: string | undefined, language: string | undefined, maxLength = 1000): string | undefined {
  const text = String(value || '').trim();
  const lang = String(language || '').trim();
  if (!lang || /^auto$/i.test(lang)) return text || undefined;
  if (text && text.toLowerCase().includes(lang.toLowerCase())) return text.slice(0, maxLength);
  const suffix = `language: ${lang}`;
  return (text ? `${text}, ${suffix}` : suffix).slice(0, maxLength);
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
    // T2.4：写入时清理非当日的过期键（date:qq 键随天数×用户数增长，不清理即慢性泄漏）。
    for (const [existingKey, value] of this.usage) {
      if (value.day !== day) this.usage.delete(existingKey);
    }
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
      catch (error) {
        this.options.logger?.warn('Suno composer failed', { error: String((error as Error)?.message || error) });
        // safe fallback：用用户原文直传 Suno（不做模型编排，保证歌一定能出）。
        const composer = this.options as { composeSafeFallback?: (args: Record<string, unknown>, request: any) => SunoComposedSpec };
        if (typeof composer.composeSafeFallback === 'function') {
          composed = composer.composeSafeFallback(args, invocation.request);
        }
      }
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
    const instrumental = composed ? composed.instrumental : Boolean(args.instrumental);
    const language = composed?.language
      || stringArg(args, 'language')
      || (cfg.defaultLanguage && !/^auto$/i.test(cfg.defaultLanguage) ? cfg.defaultLanguage : undefined);
    const argumentGender = args.vocalGender === 'm' || args.vocalGender === 'f' ? args.vocalGender : undefined;
    const configuredGender = cfg.defaultVocalGender === 'm' || cfg.defaultVocalGender === 'f' ? cfg.defaultVocalGender : undefined;
    const vocalGender = instrumental ? undefined : (composed?.vocalGender || argumentGender || configuredGender);
    const customMode = composed ? composed.customMode : Boolean(vocalGender);
    const generationInput = {
      prompt: customMode ? '' : (appendLanguageHint(composed?.musicBrief || rawUserText, language, 3000) || ''),
      lyrics: composed?.lyrics || stringArg(args, 'lyrics'),
      title: composed?.title || stringArg(args, 'title'),
      style: appendLanguageHint(composed?.style || stringArg(args, 'style'), language, 1000),
      instrumental,
      customMode,
      model: composed?.model || cfg.model,
      callbackUrl: cfg.callbackUrl,
      duration: requestedDuration,
      referenceAudio: stringArg(args, 'referenceAudio'),
      format: cfg.format,
      negativeTags: composed?.negativeTags || stringArg(args, 'negativeTags'),
      vocalGender,
      styleWeight: composed?.styleWeight,
      weirdnessConstraint: composed?.weirdnessConstraint,
      audioWeight: composed?.audioWeight,
      variety: composed?.variety,
      imageUrls: Array.isArray(args.imageUrls) ? args.imageUrls.map(String) : undefined,
      videoUrls: Array.isArray(args.videoUrls) ? args.videoUrls.map(String) : undefined,
      audioUrls: Array.isArray(args.audioUrls) ? args.audioUrls.map(String) : undefined,
      personaId: stringArg(args, 'personaId'),
      personaModel: args.personaModel === 'voice_persona' ? 'voice_persona' as const : args.personaModel === 'style_persona' ? 'style_persona' as const : undefined,
    };
    let acquired = false;
    try {
      await this.acquireSlot(cfg, invocation.request.user.qq);
      acquired = true;
      const created = await this.withRetry(() => client.create(generationInput), cfg.maxRetries);
      // T2.8：提交成功即上报 taskId——崩溃恢复时才有对账依据（不重放、防双计费）。
      invocation.reportExternalTask?.(created.id);
      const task = await this.withRetry(() => client.wait(created.id, { timeoutMs: cfg.timeoutMs }), cfg.maxRetries);
      if (task.status !== 'success') {
        return {
          jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed',
          outputs: [], error: `suno_task_${task.status}`, diagnostics: { taskId: created.id, raw: task.raw }, retryable: task.status !== 'failed',
        };
      }
      // Suno V6 一次请求通常返回两个 variant：第一首交付，其余保留入库为分支（B版），不发送。
      const audioOutputs = task.outputs.filter((item) => Boolean(item.url));
      const first = audioOutputs[0];
      let historyRecord: ReturnType<SunoSongHistoryStore["add"]> | undefined;
      if (first?.url && this.options.history) {
        try {
          historyRecord = this.options.history.add({
            chatType: invocation.request.chat.type,
            groupId: invocation.request.chat.groupId,
            userQq: invocation.request.user.qq,
            requestText: rawUserText,
            taskId: created.id,
            audioId: first.audioId,
            title: first.title,
            lyrics: first.lyrics,
            audioUrl: first.url,
            duration: first.duration,
            model: composed?.model || cfg.model,
            style: composed?.style || stringArg(args, "style"),
            variantIndex: 1,
          });
        } catch (error) {
          this.options.logger?.warn("Suno 歌曲历史写入失败", { error: String((error as Error)?.message || error) });
        }
      }
      // 其余 variant 入库为分支（requestText 标注"（分支）"），供 audio.music.variant 能力取用；入库失败不影响交付。
      let branchSaved = 0;
      if (first?.url && this.options.history) {
        for (const variant of audioOutputs.slice(1)) {
          if (!variant.url) continue;
          try {
            this.options.history.add({
              chatType: invocation.request.chat.type,
              groupId: invocation.request.chat.groupId,
              userQq: invocation.request.user.qq,
              requestText: `${rawUserText}（分支）`,
              taskId: created.id,
              audioId: variant.audioId,
              title: variant.title || first.title,
              lyrics: variant.lyrics,
              audioUrl: variant.url,
              duration: variant.duration,
              model: composed?.model || cfg.model,
              style: composed?.style || stringArg(args, "style"),
              variantOf: historyRecord?.id,
              variantIndex: 2,
            });
            branchSaved += 1;
          } catch (error) {
            this.options.logger?.warn("Suno 分支版本入库失败", { error: String((error as Error)?.message || error) });
          }
        }
      }
      const outputs = first?.url
        ? [{ kind: "audio" as const, url: first.url, priority: 10, mergeable: false, meta: {
            title: first.title,
            // Suno V6 状态响应不总是带 lyrics 字段——API 没返回时用 composer/用户提供的歌词回退，
            // 保证 sendLyricsWithMusic 开启后歌词一定能随歌发出。
            lyrics: first.lyrics || composed?.lyrics || stringArg(args, 'lyrics') || undefined,
            audioId: first.audioId,
            duration: first.duration,
            historyId: historyRecord?.id,
            historySeq: historyRecord?.seq,
            provider: "suno-official",
          } }]
        : [];
      this.options.logger?.info('Suno 任务完成，交付首曲，其余保留为分支', {
        taskId: created.id,
        generatedVariants: task.outputs.length,
        deliveredAudio: outputs.length,
        branchSaved,
        discardedCoverCount: task.outputs.filter((item) => Boolean(item.coverUrl)).length,
        hasLyrics: Boolean(outputs[0]?.meta?.lyrics),
        lyricsSource: first?.lyrics ? 'api' : composed?.lyrics ? 'composer' : stringArg(args, 'lyrics') ? 'args' : 'none',
      });
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs, diagnostics: { taskId: created.id, generatedVariants: task.outputs.length, deliveredAudio: outputs.length, branchSaved } };
    } catch (error) {
      this.options.logger?.warn('Suno 能力执行失败', { error: String((error as Error)?.message || error) });
      const message = String((error as Error)?.message || error);
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: message, retryable: false };
    } finally {
      if (acquired) this.releaseSlot();
    }
  }
}
