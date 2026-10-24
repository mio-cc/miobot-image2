import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig, BotTtsConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { synthesizeSpeech } from './tts.js';

export interface VoiceScope {
  chatType: 'group' | 'private';
  groupId?: string;
  userId: string;
}

interface FishVoiceCandidate {
  candidateId: string;
  voiceId: string;
  index: number;
  title: string;
  description?: string;
  tags: string[];
  languages: string[];
  licensed: boolean;
  author?: string;
  taskCount?: number;
  sampleUrl?: string;
  expiresAt: number;
}

interface VoicePreference {
  voiceId: string;
  title: string;
  selectedAt: string;
}

function scopeKey(scope: VoiceScope): string {
  return [scope.chatType, scope.chatType === 'group' ? String(scope.groupId || '') : '', String(scope.userId || '')].join(':');
}

function clip(value: unknown, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const TAG_ALIASES: Record<string, string> = {
  '温柔': 'gentle', '柔和': 'soft', '软': 'soft', '女声': 'female', '女性': 'female', '男声': 'male', '男性': 'male',
  '成熟': 'mature', '年轻': 'young', '少女': 'young', '老年': 'old', '低沉': 'deep', '深厚': 'deep',
  '活泼': 'energetic', '活力': 'energetic', '清亮': 'bright', '清晰': 'clear', '平静': 'calm', '冷静': 'calm',
  '温暖': 'warm', '温暖感': 'warm', '旁白': 'narration', '叙述': 'narration', '纪录片': 'documentary',
  '专业': 'professional', '友好': 'friendly', '自然': 'natural', '可爱': 'cute', '御姐': 'mature',
  '讲故事': 'narration', '适合讲故事': 'narration', '故事': 'narration', '朗读': 'narration', '叙述感': 'narration',
};
const LANGUAGE_ALIASES: Record<string, string> = {
  '中文': 'zh', '汉语': 'zh', '普通话': 'zh', '国语': 'zh', 'zh-cn': 'zh', 'mandarin': 'zh',
  '英文': 'en', '英语': 'en', 'english': 'en', '日语': 'ja', '日文': 'ja', 'japanese': 'ja',
  '韩语': 'ko', 'korean': 'ko', '粤语': 'yue', 'cantonese': 'yue',
};
function normalizeTag(value: string): string {
  const clean = String(value || '').trim().toLowerCase();
  const mapped = TAG_ALIASES[clean] || clean.replace(/\s+/g, '-');
  return /^[a-z0-9_-]+$/i.test(mapped) ? mapped : '';
}
function normalizeLanguage(value: string): string {
  const clean = String(value || '').trim().toLowerCase();
  return LANGUAGE_ALIASES[clean] || clean;
}
function maskVoiceId(value: string): string {
  const id = String(value || '');
  return id.length <= 8 ? id.slice(0, 2) + '***' : id.slice(0, 4) + '***' + id.slice(-3);
}

function audioPayload(file: string): string {
  if (/^base64:\/{0,2}/i.test(file)) return 'base64://' + file.replace(/^base64:\/{0,2}/i, '');
  return file;
}
export class FishAudioVoiceService {
  private readonly candidates = new Map<string, FishVoiceCandidate[]>();
  private readonly preferences = new Map<string, VoicePreference>();
  private readonly previewUsage = new Map<string, { day: string; count: number; lastAt: number }>();

  constructor(private readonly options: {
    getConfig: () => AppConfig;
    preferenceFile: string;
    logger?: StructuredLogger;
  }) {
    this.load();
  }

  private get voiceConfig() {
    return this.options.getConfig().orchestration.voice;
  }

  private assertEnabled(scope: VoiceScope): void {
    const cfg = this.voiceConfig;
    if (!cfg.enabled) throw new Error('voice_management_disabled');
    if (!cfg.userCanChange) throw new Error('user_voice_change_disabled');
    if (cfg.allowedScopes === 'private' && scope.chatType !== 'private') throw new Error('voice_scope_private_only');
    if (cfg.allowedScopes === 'group' && scope.chatType !== 'group') throw new Error('voice_scope_group_only');
  }

  async search(scope: VoiceScope, args: Record<string, unknown>): Promise<{ needsInput?: boolean; missingPreferences?: string[]; candidates?: FishVoiceCandidate[]; total?: number }> {
    this.assertEnabled(scope);
    const cfg = this.voiceConfig;
    const title = clip(args.title ?? args.query, 120);
    const tags = Array.isArray(args.tags) ? args.tags.map((item) => normalizeTag(clip(item, 40))).filter(Boolean) : [];
    const languages = Array.isArray(args.language)
      ? args.language.map((item) => normalizeLanguage(clip(item, 20))).filter(Boolean)
      : (clip(args.language, 20) ? [normalizeLanguage(clip(args.language, 20))] : []);
    if (!title && !tags.length && !languages.length) {
      return { needsInput: true, missingPreferences: ['声音风格', '性别', '语言', '年龄感'] };
    }
    const tts = this.options.getConfig().bot.tts;
    const apiKey = String(tts.apiKey || '').trim();
    if (!apiKey) throw new Error('fishaudio_api_key_missing');
    const url = new URL(String(cfg.voicesApiUrl || 'https://api.fish.audio/model'));
    url.searchParams.set('self', 'false');
    url.searchParams.set('page_size', String(Math.max(1, Math.min(10, cfg.maxCandidates))));
    url.searchParams.set('sort_by', 'task_count');
    if (title) url.searchParams.set('title', title);
    for (const tag of tags) url.searchParams.append('tag', tag);
    for (const language of languages) url.searchParams.append('language', language);
    if (cfg.licensedOnly || args.licensedOnly === true) url.searchParams.set('licensed', 'true');
    const response = await fetch(url, {
      headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error('fishaudio_search_http_' + response.status);
    const body = await response.json() as { total?: number; items?: Array<Record<string, any>> };
    const now = Date.now();
    const candidates = (body.items || [])
      .filter((item) => item && item._id && item.state === 'trained' && item.type === 'tts')
      .slice(0, Math.max(1, Math.min(10, cfg.maxCandidates)))
      .map((item, index): FishVoiceCandidate => ({
        candidateId: 'vc_' + randomUUID().replace(/-/g, '').slice(0, 16),
        voiceId: String(item._id),
        index: index + 1,
        title: clip(item.title || '未命名音色', 100),
        description: clip(item.description, 300),
        tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 20) : [],
        languages: Array.isArray(item.languages) ? item.languages.map(String).slice(0, 10) : [],
        licensed: Boolean(item.licensed),
        author: item.author?.nickname ? String(item.author.nickname) : undefined,
        taskCount: Number(item.task_count) || 0,
        sampleUrl: Array.isArray(item.samples) && item.samples[0]?.audio ? String(item.samples[0].audio) : undefined,
        expiresAt: now + Math.max(60000, cfg.candidateTtlMs),
      }));
    if (candidates.length) this.candidates.set(scopeKey(scope), candidates);
    this.options.logger?.info('FishAudio voice search completed', { scope: scopeKey(scope), total: body.total, candidates: candidates.length });
    return { candidates, total: Number(body.total) || candidates.length };
  }

  listCandidates(scope: VoiceScope): FishVoiceCandidate[] {
    const key = scopeKey(scope);
    const current = (this.candidates.get(key) || []).filter((item) => item.expiresAt > Date.now());
    if (current.length) this.candidates.set(key, current);
    else this.candidates.delete(key);
    return current.map((item) => ({ ...item }));
  }

  private resolveCandidate(scope: VoiceScope, args: Record<string, unknown>): FishVoiceCandidate {
    const list = this.listCandidates(scope);
    if (!list.length) throw new Error('voice_candidates_expired');
    const candidateId = clip(args.candidateId, 80);
    const index = Math.max(0, Math.trunc(Number(args.index) || 0));
    const candidate = candidateId ? list.find((item) => item.candidateId === candidateId) : list.find((item) => item.index === index);
    if (!candidate) throw new Error('voice_candidate_not_found');
    return candidate;
  }
  async preview(scope: VoiceScope, args: Record<string, unknown>): Promise<{ candidate: FishVoiceCandidate; audioFile: string }> {
    this.assertEnabled(scope);
    const cfg = this.voiceConfig;
    const candidate = this.resolveCandidate(scope, args);
    const usageKey = scopeKey(scope);
    const day = new Date().toISOString().slice(0, 10);
    const usage = this.previewUsage.get(usageKey);
    if (usage?.day === day) {
      if (cfg.previewCooldownMs > 0 && Date.now() - usage.lastAt < cfg.previewCooldownMs) throw new Error('voice_preview_cooldown');
      if (cfg.previewDailyLimit > 0 && usage.count >= cfg.previewDailyLimit) throw new Error('voice_preview_daily_limit');
    }
    let audioFile = '';
    if (candidate.sampleUrl) {
      try {
        const response = await fetch(candidate.sampleUrl, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 0 && bytes.length <= 10 * 1024 * 1024) audioFile = 'base64://' + bytes.toString('base64');
        }
      } catch { /* fall back to short TTS */ }
    }
    if (!audioFile) {
      const tts = this.options.getConfig().bot.tts;
      const audio = await synthesizeSpeech({ ...tts, voiceId: candidate.voiceId, voiceIds: [] }, clip(args.text, cfg.previewMaxChars) || '你好，这是当前音色的试听。', { logger: this.options.logger });
      audioFile = audio.file;
    }
    // T2.4：写入时清理非当日的死键（每个会话一条，长期运行随会话数增长）。
    if (this.previewUsage.size > 500) {
      for (const [existingKey, value] of this.previewUsage) {
        if (value.day !== day) this.previewUsage.delete(existingKey);
      }
    }
    this.previewUsage.set(usageKey, { day, count: (usage?.day === day ? usage.count : 0) + 1, lastAt: Date.now() });
    return { candidate, audioFile: audioPayload(audioFile) };
  }
  select(scope: VoiceScope, args: Record<string, unknown>): VoicePreference {
    this.assertEnabled(scope);
    const candidate = this.resolveCandidate(scope, args);
    const preference = { voiceId: candidate.voiceId, title: candidate.title, selectedAt: new Date().toISOString() };
    this.preferences.set(scopeKey(scope), preference);
    this.persist();
    return preference;
  }

  current(scope: VoiceScope): VoicePreference | undefined {
    return this.preferences.get(scopeKey(scope));
  }

  effectiveTts(tts: BotTtsConfig, scope: VoiceScope): BotTtsConfig {
    if (!this.voiceConfig.enabled) return tts;
    const selected = this.current(scope);
    return selected ? { ...tts, voiceId: selected.voiceId, voiceIds: [] } : tts;
  }
  // test


  formatCandidates(candidates: FishVoiceCandidate[]): string {
    if (!candidates.length) return '没有找到匹配的 FishAudio 音色，可以换一种描述再试。';
    const lines = ['找到以下 FishAudio 候选音色：'];
    for (const item of candidates) {
      const parts = [item.languages.join('/'), item.tags.slice(0, 6).join(', '), item.licensed ? '已授权' : ''].filter(Boolean);
      lines.push(item.index + '. ' + item.title + (parts.length ? ' | ' + parts.join(' | ') : ''));
    }
    lines.push('');
    lines.push('可以试听或选择，候选约 10 分钟内有效。');
    return lines.join('\n');
  }
  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.options.preferenceFile, 'utf8')) as { preferences?: Record<string, VoicePreference> };
      for (const [key, value] of Object.entries(parsed.preferences || {})) if (value?.voiceId) this.preferences.set(key, value);
    } catch { /* first run */ }
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.options.preferenceFile), { recursive: true });
      const temp = this.options.preferenceFile + '.tmp';
      writeFileSync(temp, JSON.stringify({ preferences: Object.fromEntries(this.preferences) }, null, 2), 'utf8');
      renameSync(temp, this.options.preferenceFile);
    } catch (error) {
      this.options.logger?.warn('voice preference persist failed', { error: String((error as Error)?.message || error) });
    }
  }
}
function invocationScope(invocation: CapabilityInvocation): VoiceScope {
  return { chatType: invocation.request.chat.type, groupId: invocation.request.chat.groupId, userId: invocation.request.user.qq };
}

export class VoiceSearchCapabilityHandler implements CapabilityHandler {
  constructor(private readonly service: FishAudioVoiceService) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    try {
      const result = await this.service.search(invocationScope(invocation), invocation.step.args || {});
      if (result.needsInput) {
        return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'needs_input', outputs: [], diagnostics: { missingInformation: result.missingPreferences || [], detail: 'voice search preferences are insufficient' } };
      }
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
        outputs: [{ kind: 'text', text: this.service.formatCandidates(result.candidates || []), priority: 10, mergeable: true }],
        diagnostics: { voiceCandidates: result.candidates?.map((item) => ({ index: item.index, title: item.title, candidateId: item.candidateId })), total: result.total },
      };
    } catch (error) {
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: String((error as Error)?.message || error) };
    }
  }
}
export class VoicePreviewCapabilityHandler implements CapabilityHandler {
  constructor(private readonly service: FishAudioVoiceService) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    try {
      const result = await this.service.preview(invocationScope(invocation), invocation.step.args || {});
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
        outputs: [
          { kind: 'audio', url: result.audioFile, priority: 10, mergeable: false },
          { kind: 'text', text: '试听：' + result.candidate.title, priority: 8, mergeable: true },
        ],
      };
    } catch (error) {
      // T1.3：用户尚未选择候选（候选缺失/未指定）走 needs_input + 候选列表，
      // 由模型生成追问并携带选项，替代 enforce 里的删步骤特判。
      return voiceCandidateNeedsInput(this.service, invocation, error, '试听');
    }
  }
}

export class VoiceSelectCapabilityHandler implements CapabilityHandler {
  constructor(private readonly service: FishAudioVoiceService) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    try {
      const selected = this.service.select(invocationScope(invocation), invocation.step.args || {});
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
        outputs: [{ kind: 'text', text: '已切换为音色：' + selected.title + '（' + maskVoiceId(selected.voiceId) + '）', priority: 10, mergeable: true }],
        diagnostics: { voiceIdMasked: maskVoiceId(selected.voiceId) },
      };
    } catch (error) {
      return voiceCandidateNeedsInput(this.service, invocation, error, '切换');
    }
  }
}

/** T1.3：候选未选择 → needs_input（候选列表带 clarificationContext，模型据此追问）。 */
function voiceCandidateNeedsInput(service: FishAudioVoiceService, invocation: CapabilityInvocation, error: unknown, action: string): ExecutionResult {
  const message = String((error as Error)?.message || error);
  const isSelectionMissing = /voice_candidate|voice_candidates_expired/.test(message);
  if (!isSelectionMissing) {
    return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: message };
  }
  const candidates = service.listCandidates(invocationScope(invocation));
  const outputs = candidates.length
    ? [{
        kind: 'text' as const,
        text: ['当前音色候选（回复序号即可）：', ...candidates.map((item) => '#' + item.index + ' ' + item.title)].join('\n'),
        priority: 5,
        mergeable: true,
        meta: { role: 'voice_candidates', clarificationContext: true, skipTts: true, disableVoice: true },
      }]
    : [];
  const missingQuestion = candidates.length
    ? ('要' + action + '哪个音色？请回复序号。')
    : '音色候选已过期，请先搜索音色。';
  return {
    jobId: invocation.plan.planId,
    stepId: invocation.step.id,
    status: 'needs_input',
    outputs,
    diagnostics: { missingInformation: [missingQuestion] },
    retryable: false,
  };
}

export class VoiceCurrentCapabilityHandler implements CapabilityHandler {
  constructor(private readonly service: FishAudioVoiceService) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const selected = this.service.current(invocationScope(invocation));
    const text = selected ? '当前音色：' + selected.title + '（' + maskVoiceId(selected.voiceId) + '）' : '当前使用全局默认音色。';
    return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: [{ kind: 'text', text, priority: 10, mergeable: true }] };
  }
}
