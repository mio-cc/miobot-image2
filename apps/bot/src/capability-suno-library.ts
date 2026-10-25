import type { CapabilityHandler, CapabilityInvocation, ExecutionOutput, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { SunoClient, extractJsonObject } from '../../../packages/orchestration/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { SunoSongHistoryRecord, SunoSongHistoryStore } from './suno-song-history.js';

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// 歌曲历史全局共享（歌单是公开内容）：列表/查找跨全部会话与用户，输出不标注来源群与生成者。
function globalHistoryOutput(store: SunoSongHistoryStore, limit = 20): ExecutionOutput {
  return {
    kind: 'text',
    text: store.formatListGlobal(limit),
    priority: 5,
    mergeable: true,
    meta: { role: 'suno_history', sourceCapability: 'audio.music.history', skipTts: true, disableVoice: true },
  };
}

function missingSongResult(invocation: CapabilityInvocation, store: SunoSongHistoryStore): ExecutionResult {
  return {
    jobId: invocation.plan.planId,
    stepId: invocation.step.id,
    status: 'needs_input',
    outputs: [globalHistoryOutput(store, 20)],
    diagnostics: { missingInformation: ['要选择哪一首歌？请回复歌曲序号或歌名。'] },
  };
}

export class SunoHistoryCapabilityHandler implements CapabilityHandler {
  constructor(private readonly store: SunoSongHistoryStore) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const limit = Math.max(1, Math.min(50, Number(invocation.step.args?.limit) || 20));
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: 'success',
      outputs: [globalHistoryOutput(this.store, limit)],
    };
  }
}

export class SunoReplayCapabilityHandler implements CapabilityHandler {
  constructor(private readonly store: SunoSongHistoryStore) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const args = invocation.step.args || {};
    // 全局共享：任何用户可回放任何人生成的歌；sequence/selection 语义为全局序号。
    const record = this.store.findGlobal({
      recordId: argString(args, 'recordId'),
      globalSeq: Number(args.globalSeq) || Number(args.sequence) || Number(argString(args, 'selection')),
      title: argString(args, 'title'),
    });
    if (!record) return missingSongResult(invocation, this.store);
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: 'success',
      outputs: [{
        kind: 'audio',
        url: record.audioUrl,
        priority: 10,
        mergeable: false,
        meta: {
          title: record.title,
          lyrics: record.lyrics,
          audioId: record.audioId,
          historyId: record.id,
          historySeq: record.seq,
          sourceCapability: 'audio.music.replay',
          provider: 'suno-official',
        },
      }],
      diagnostics: { replay: true, seq: record.seq, taskId: record.taskId },
    };
  }
}

export class SunoVariantCapabilityHandler implements CapabilityHandler {
  constructor(private readonly store: SunoSongHistoryStore) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const args = invocation.step.args || {};
    const record = this.store.findGlobal({
      recordId: argString(args, 'recordId'),
      globalSeq: Number(args.globalSeq) || Number(args.sequence) || Number(argString(args, 'selection')),
      title: argString(args, 'title'),
    });
    if (!record) return missingSongResult(invocation, this.store);
    // 目标语义：定位到主版 → 发它的分支；定位到的本身就是分支（模型可能直接选中列表里的 B 版行）→ 发该分支。
    const variant = (Number(record.variantIndex) || 1) >= 2 ? record : this.store.findVariantOf(record);
    if (!variant?.audioUrl) {
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'needs_input',
        outputs: [{
          kind: 'text',
          text: `「${record.title || record.requestText || '这首歌'}」只保留了一个版本，没有另一版可发。`,
          priority: 5,
          mergeable: true,
          meta: { skipTts: true, disableVoice: true, sourceCapability: 'audio.music.variant' },
        }],
        diagnostics: { missingInformation: ['这首歌只有一个版本。'] },
      };
    }
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: 'success',
      outputs: [{
        kind: 'audio',
        url: variant.audioUrl,
        priority: 10,
        mergeable: false,
        meta: {
          title: variant.title || record.title,
          lyrics: variant.lyrics,
          audioId: variant.audioId,
          historyId: variant.id,
          historySeq: variant.seq,
          variantIndex: variant.variantIndex ?? 2,
          sourceCapability: 'audio.music.variant',
          provider: 'suno-official',
        },
      }],
      diagnostics: { variantOf: record.id, variantId: variant.id, taskId: variant.taskId },
    };
  }
}

export interface SunoReplaceSectionOptions {
  getConfig: () => AppConfig;
  store: SunoSongHistoryStore;
  client?: { chat(nodeIndex: number, req: any): Promise<{ text?: string }> };
  createClient?: (config: AppConfig['orchestration']['suno']) => Pick<SunoClient, 'replaceSection' | 'wait' | 'getTimestampedLyrics'>;
}

export class SunoReplaceSectionCapabilityHandler implements CapabilityHandler {
  constructor(private readonly options: SunoReplaceSectionOptions) {}

  private async inferSection(
    client: { getTimestampedLyrics(taskId: string, audioId: string): Promise<any> },
    appCfg: AppConfig,
    record: SunoSongHistoryRecord,
    change: string,
    args: Record<string, unknown>,
  ): Promise<{ startSeconds: number; endSeconds: number; prompt?: string; tags?: string; lyrics?: string; fullLyrics?: string } | null> {
    if (!this.options.client || !record.taskId || !record.audioId) return null;
    let timing: any;
    try {
      timing = await client.getTimestampedLyrics(record.taskId, record.audioId);
    } catch {
      return null;
    }
    const words = Array.isArray(timing?.alignedWords) ? timing.alignedWords : [];
    const timeline = words
      .map((word: any) => {
        const value = String(word?.word || '').replace(/\s+/g, ' ').trim();
        const start = Number(word?.startS);
        const end = Number(word?.endS);
        return value && Number.isFinite(start) && Number.isFinite(end) ? `[${start.toFixed(2)}-${end.toFixed(2)}] ${value}` : '';
      })
      .filter(Boolean)
      .join(' ')
      .slice(0, 14000);
    if (!timeline) return null;
    const planner = appCfg.orchestration.planner;
    const prompt = [
      '你在为已有歌曲定位一个需要局部替换的时间段。',
      '根据带时间戳歌词、原歌词、原曲时长和用户的编辑要求，选择最符合用户意图的连续区间。',
      '区间必须至少 10 秒，开始时间小于结束时间，且不能超过原曲总时长的 50%。',
      '如果用户只要求改变风格/编曲而不要求改歌词，歌词字段应尽量保留原片段歌词；fullLyrics 是修改后的完整歌词。',
      '只输出严格 JSON：{"startSeconds":数字,"endSeconds":数字,"prompt":"新片段的音乐/演唱描述","tags":"风格标签","lyrics":"替换片段歌词","fullLyrics":"修改后的完整歌词"}。',
      '',
      '用户编辑要求：' + change,
      '原曲标题：' + String(record.title || ''),
      '原曲时长（秒）：' + String(record.duration || '未知'),
      '原曲风格：' + String(record.style || ''),
      '原歌词：' + String(record.lyrics || ''),
      '带时间戳歌词：' + timeline,
      '补充参数：' + JSON.stringify({
        lyrics: argString(args, 'lyrics'),
        fullLyrics: argString(args, 'fullLyrics'),
        tags: argString(args, 'tags'),
      }),
    ].join('\n');
    try {
      const result = await this.options.client.chat(Number(planner.nodeIndex ?? 0), {
        model: String(planner.model || appCfg.orchestration.suno.model || ''),
        messages: [
          { role: 'system', content: 'Return only one JSON object. Do not use Markdown.' },
          { role: 'user', content: prompt },
        ],
        maxTokens: Number(appCfg.orchestration.roles.planner.maxTokens || planner.alignmentReviewMaxTokens || 2400),
        temperature: 0,
        timeoutMs: Number(appCfg.orchestration.roles.planner.timeoutMs || planner.clarificationTimeoutMs || 60000),
      });
      const json = extractJsonObject(String(result.text || ''));
      if (!json) return null;
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const startSeconds = Number(parsed.startSeconds);
      const endSeconds = Number(parsed.endSeconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds - startSeconds < 10) return null;
      if (record.duration && endSeconds - startSeconds > record.duration / 2 + 0.01) return null;
      return {
        startSeconds,
        endSeconds,
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
        tags: typeof parsed.tags === 'string' ? parsed.tags : undefined,
        lyrics: typeof parsed.lyrics === 'string' ? parsed.lyrics : undefined,
        fullLyrics: typeof parsed.fullLyrics === 'string' ? parsed.fullLyrics : undefined,
      };
    } catch {
      return null;
    }
  }
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const args = invocation.step.args || {};
    // 全局共享：可定位任何人生成的歌（编辑消耗发起人的生成额度）。
    const record = this.options.store.findGlobal({
      recordId: argString(args, 'recordId'),
      globalSeq: Number(args.globalSeq) || Number(args.sequence) || Number(argString(args, 'selection')),
      title: argString(args, 'title'),
    });
    if (!record) return missingSongResult(invocation, this.options.store);
    if (!record.taskId || !record.audioId) {
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'failed',
        outputs: [],
        error: 'suno_source_audio_id_missing',
        retryable: false,
      };
    }
    const change = argString(args, 'change') || argString(args, 'prompt');
    if (!change) {
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'needs_input',
        outputs: [],
        diagnostics: { missingInformation: ['想把哪一段改成什么内容？比如"第二段副歌换成…"。'] },
      };
    }
    const appCfg = this.options.getConfig();
    const cfg = appCfg.orchestration.suno;
    if (!cfg.enabled) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: 'suno_disabled', retryable: false };
    }
    const client = this.options.createClient
      ? this.options.createClient(cfg)
      : new SunoClient({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          requestMode: cfg.requestMode,
          callbackUrl: cfg.callbackUrl,
          createPath: cfg.createPath,
          statusPath: cfg.statusPath,
          replacePath: '/api/v1/generate/replace-section',
          authHeader: cfg.authHeader,
          authPrefix: cfg.authPrefix,
          timeoutMs: cfg.timeoutMs,
          pollIntervalMs: cfg.pollIntervalMs,
        });
    let startSeconds = Number(args.startSeconds);
    let endSeconds = Number(args.endSeconds);
    const validRange = () => Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && startSeconds >= 0 && endSeconds > startSeconds && endSeconds - startSeconds >= 10
      && (!record.duration || endSeconds - startSeconds <= record.duration / 2 + 0.01);
    let inferred: Awaited<ReturnType<SunoReplaceSectionCapabilityHandler['inferSection']>> = null;
    if (!validRange()) {
      inferred = await this.inferSection(client, appCfg, record, change, args);
      if (inferred) {
        startSeconds = inferred.startSeconds;
        endSeconds = inferred.endSeconds;
      }
    }
    if (!validRange()) {
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'needs_input',
        // 附全局历史列表：模型/用户可以据此把目标歌说清楚（澄清合并链路会把它带进上下文）。
        outputs: [globalHistoryOutput(this.options.store, 20)],
        diagnostics: { missingInformation: ['想替换哪一段？可以直接说"第二段副歌换成…"，我会自动定位；也可以给出至少 10 秒的起止秒数。'] },
      };
    }
    const promptText = argString(args, 'prompt') || inferred?.prompt || change;
    const tags = argString(args, 'tags') || inferred?.tags || record.style || 'music';
    const lyrics = argString(args, 'lyrics') || inferred?.lyrics;
    const fullLyrics = argString(args, 'fullLyrics') || inferred?.fullLyrics || record.lyrics || lyrics || change;
    try {
      const created = await client.replaceSection({
        taskId: record.taskId,
        audioId: record.audioId,
        prompt: promptText,
        lyrics,
        tags,
        title: argString(args, 'title') || record.title || 'Edited song',
        infillStartS: startSeconds,
        infillEndS: endSeconds,
        fullLyrics,
        negativeTags: argString(args, 'negativeTags'),
        vocalGender: args.vocalGender === 'm' || args.vocalGender === 'f' ? args.vocalGender : undefined,
        callBackUrl: cfg.callbackUrl,
        model: cfg.model,
      });
      // T2.8：提交成功即上报 taskId，供崩溃恢复对账。
      invocation.reportExternalTask?.(created.id);
      const task = await client.wait(created.id, { timeoutMs: cfg.timeoutMs });
      if (task.status !== 'success') {
        return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: `suno_replace_${task.status}`, diagnostics: { taskId: created.id }, retryable: task.status !== 'failed' };
      }
      const first = task.outputs.find((item) => Boolean(item.url));
      if (!first?.url) return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: 'suno_replace_no_audio', retryable: false };
      let historyRecord;
      try {
        historyRecord = this.options.store.add({
          chatType: invocation.request.chat.type,
          groupId: invocation.request.chat.groupId,
          userQq: invocation.request.user.qq,
          requestText: `编辑：${change}`,
          taskId: created.id,
          audioId: first.audioId,
          title: first.title || argString(args, 'title') || record.title,
          lyrics: first.lyrics || fullLyrics,
          audioUrl: first.url,
          duration: first.duration,
          model: cfg.model,
          style: tags,
        });
      } catch { /* history must not fail the edit */ }
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'success',
        outputs: [{
          kind: 'audio',
          url: first.url,
          priority: 10,
          mergeable: false,
          meta: {
            title: first.title || argString(args, 'title') || record.title,
            lyrics: first.lyrics || fullLyrics,
            audioId: first.audioId,
            historyId: historyRecord?.id,
            historySeq: historyRecord?.seq,
            sourceCapability: 'audio.music.replace_section',
            provider: 'suno-official',
          },
        }],
        diagnostics: { taskId: created.id, editedRecordId: record.id, startSeconds, endSeconds, inferredSection: Boolean(inferred) },
      };
    } catch (error) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: String((error as Error)?.message || error), retryable: false };
    }
  }
}

export class SunoLyricsCapabilityHandler implements CapabilityHandler {
  constructor(private readonly store: SunoSongHistoryStore) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const args = invocation.step.args || {};
    const record = this.store.findGlobal({
      recordId: argString(args, 'recordId'),
      globalSeq: Number(args.globalSeq) || Number(args.sequence) || Number(argString(args, 'selection')),
      title: argString(args, 'title'),
    });
    if (!record) return missingSongResult(invocation, this.store);
    const title = record.title || record.requestText || '未命名歌曲';
    if (!record.lyrics || !record.lyrics.trim()) {
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'needs_input',
        outputs: [{ kind: 'text', text: `「${title}」没有保存歌词（生成时上游未返回）。`, priority: 5, mergeable: true, meta: { skipTts: true, disableVoice: true, sourceCapability: 'audio.music.lyrics' } }],
        diagnostics: { missingInformation: ['这首歌没有已保存的歌词。'] },
      };
    }
    return {
      jobId: invocation.plan.planId,
      stepId: invocation.step.id,
      status: 'success',
      outputs: [{
        kind: 'text',
        text: `「${title}」的歌词：\n${record.lyrics}`,
        priority: 10,
        mergeable: true,
        meta: { skipTts: true, disableVoice: true, historyId: record.id, sourceCapability: 'audio.music.lyrics' },
      }],
      diagnostics: { lyricsChars: record.lyrics.length, taskId: record.taskId },
    };
  }
}
