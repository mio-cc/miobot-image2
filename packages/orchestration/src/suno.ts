export interface SunoGenerateInput {
  prompt: string;
  lyrics?: string;
  title?: string;
  style?: string;
  instrumental?: boolean;
  duration?: number;
  referenceAudio?: string;
  format?: string;
  customMode?: boolean;
  model?: string;
  callbackUrl?: string;
  negativeTags?: string;
  vocalGender?: 'm' | 'f';
  styleWeight?: number;
  weirdnessConstraint?: number;
  audioWeight?: number;
  variety?: number;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  personaId?: string;
  personaModel?: 'style_persona' | 'voice_persona';
}

export interface SunoAudioOutput {
  url?: string;
  title?: string;
  lyrics?: string;
  coverUrl?: string;
  raw?: unknown;
}

export interface SunoTask {
  id: string;
  status: 'pending' | 'processing' | 'success' | 'failed' | 'unknown';
  outputs: SunoAudioOutput[];
  raw: unknown;
}

export interface SunoClientOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  requestMode?: 'v6' | 'legacy';
  callbackUrl?: string;
  createPath?: string;
  statusPath?: string;
  authHeader?: string;
  authPrefix?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

function getFirstString(value: any, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value?.[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

function collectAudio(value: any): SunoAudioOutput[] {
  const candidates = [
    value?.audio,
    value?.audios,
    value?.clips,
    value?.songs,
    value?.output,
    value?.data?.audio,
    value?.data?.audios,
    value?.data?.clips,
    value?.data?.songs,
    value?.data?.output,
    value?.data?.response?.sunoData,
    value?.data?.sunoData,
    value?.response?.sunoData,
    value?.data,
    value,
  ];
  const out: SunoAudioOutput[] = [];
  for (const candidate of candidates) {
    const items = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
    for (const item of items) {
      const url = typeof item === 'string'
        ? item
        : getFirstString(item, ['audio_url', 'audioUrl', 'url', 'streamUrl', 'source']);
      if (!url) continue;
      out.push({
        url,
        title: typeof item === 'object' ? getFirstString(item, ['title', 'name']) : undefined,
        lyrics: typeof item === 'object' ? getFirstString(item, ['lyrics', 'lyric']) : undefined,
        coverUrl: typeof item === 'object' ? getFirstString(item, ['cover_url', 'coverUrl', 'image_url', 'imageUrl']) : undefined,
        raw: item,
      });
    }
  }
  return out;
}

export class SunoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly createPath: string;
  private readonly statusPath: string;
  private readonly requestMode: 'v6' | 'legacy';

  constructor(private readonly options: SunoClientOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.requestMode = options.requestMode === 'legacy' ? 'legacy' : 'v6';
    this.createPath = String(options.createPath || (this.requestMode === 'v6' ? '/api/v1/generate' : '/generate'));
    this.statusPath = String(options.statusPath || (this.requestMode === 'v6' ? '/api/v1/generate/record-info?taskId={id}' : '/generate/{id}'));
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey) {
      headers[this.options.authHeader || 'Authorization'] = `${this.options.authPrefix ?? 'Bearer '}${this.options.apiKey}`;
    }
    return headers;
  }

  private async requestJson(path: string, init: RequestInit): Promise<any> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, this.options.timeoutMs || 60000));
    try {
      const response = await this.fetchImpl(url, { ...init, headers: { ...this.headers(), ...(init.headers || {}) }, signal: controller.signal });
      const text = await response.text();
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
      if (!response.ok) throw new Error(`suno_http_${response.status}:${String(data?.message || data?.error || text).slice(0, 300)}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildBody(input: SunoGenerateInput): Record<string, unknown> {
    if (this.requestMode === 'legacy') {
      return {
        model: input.model || this.options.model || undefined,
        prompt: input.prompt,
        lyrics: input.lyrics || undefined,
        title: input.title || undefined,
        style: input.style || undefined,
        instrumental: input.instrumental || undefined,
        duration: input.duration || undefined,
        reference_audio: input.referenceAudio || undefined,
        format: input.format || undefined,
      };
    }
    const customMode = Boolean(input.customMode);
    const callbackUrl = String(input.callbackUrl || this.options.callbackUrl || '').trim();
    if (!callbackUrl) throw new Error('suno_callback_url_missing');
    const body: Record<string, unknown> = {
      model: input.model || this.options.model || 'V6',
      customMode,
      instrumental: Boolean(input.instrumental),
      callBackUrl: callbackUrl,
    };
    if (customMode) {
      if (input.title) body.title = input.title;
      if (input.style) body.style = input.style;
      if (input.negativeTags) body.negativeTags = input.negativeTags;
      if (input.vocalGender) body.vocalGender = input.vocalGender;
      if (Number.isFinite(Number(input.styleWeight))) body.styleWeight = Number(input.styleWeight);
      if (Number.isFinite(Number(input.weirdnessConstraint))) body.weirdnessConstraint = Number(input.weirdnessConstraint);
      if (!input.instrumental && Number.isFinite(Number(input.audioWeight))) body.audioWeight = Number(input.audioWeight);
      if (Number.isFinite(Number(input.variety))) body.variety = Number(input.variety);
      if (Number.isFinite(Number(input.duration))) body.duration = Number(input.duration);
      if (input.personaId) body.personaId = input.personaId;
      if (input.personaModel) body.personaModel = input.personaModel;
      if (!input.instrumental) {
        if (input.lyrics) body.lyrics = input.lyrics;
        else if (input.prompt) body.prompt = input.prompt;
      } else if (input.prompt) {
        body.prompt = input.prompt;
      }
      if (!body.style && !body.lyrics && !body.negativeTags && !body.prompt) throw new Error('suno_custom_mode_content_missing');
    } else {
      if (input.prompt) body.prompt = input.prompt;
      if (input.style) body.style = input.style;
      if (input.lyrics) body.lyrics = input.lyrics;
      if (input.imageUrls?.length) body.imageUrls = input.imageUrls.slice(0, 5);
      if (input.videoUrls?.length) body.videoUrls = input.videoUrls.slice(0, 1);
      if (input.audioUrls?.length) body.audioUrls = input.audioUrls;
      if (!body.prompt && !body.style && !body.lyrics && !body.imageUrls && !body.videoUrls && !body.audioUrls) throw new Error('suno_content_missing');
    }
    return body;
  }
  async create(input: SunoGenerateInput): Promise<{ id: string; raw: unknown }> {
    if (!this.baseUrl) throw new Error('suno_base_url_missing');
    const data = await this.requestJson(this.createPath, {
      method: 'POST',
      body: JSON.stringify(this.buildBody(input)),
    });
    const id = getFirstString(data, ['id', 'taskId', 'task_id', 'jobId', 'job_id']) ||
      getFirstString(data?.data, ['id', 'taskId', 'task_id', 'jobId', 'job_id']);
    if (!id) throw new Error('suno_task_id_missing');
    return { id, raw: data };
  }

  async get(id: string): Promise<SunoTask> {
    const path = this.statusPath.replace('{id}', encodeURIComponent(id));
    const data = await this.requestJson(path, { method: 'GET' });
    const statusText = String(
      getFirstString(data, ['status', 'state']) || getFirstString(data?.data, ['status', 'state']) || '',
    ).toLowerCase();
    const status = ['success', 'succeeded', 'complete', 'completed', 'done'].includes(statusText)
      ? 'success'
      : ['failed', 'error', 'cancelled', 'canceled'].includes(statusText)
        ? 'failed'
        : ['pending', 'queued', 'created'].includes(statusText)
          ? 'pending'
          : statusText ? 'processing' : 'unknown';
    return { id, status, outputs: collectAudio(data), raw: data };
  }

  async wait(id: string, options: { timeoutMs?: number } = {}): Promise<SunoTask> {
    const interval = Math.max(500, this.options.pollIntervalMs || 5000);
    let last: SunoTask = { id, status: 'unknown', outputs: [], raw: {} };
    const timeoutMs = Math.max(0, Math.trunc(Number(options.timeoutMs) || 0));
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (deadline !== undefined && Date.now() >= deadline) throw new Error('suno_wait_timeout');
      last = await this.get(id);
      if (last.status === 'success' || last.status === 'failed') return last;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return last;
  }
}
