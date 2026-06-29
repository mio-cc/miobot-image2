import { createCapabilityRegistry, createModelClient, type ModelNode, type ProviderDialect } from '../../../packages/model/src/index.js';
import { NapcatAdapter } from '../../../packages/napcat/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { AdminResponse, AdminServiceDeps } from '../../../packages/admin-service/src/index.js';

const KNOWN: ProviderDialect[] = ['openai', 'anthropic', 'gemini', 'huggingface', 'custom'];

export function cleanBaseUrl(value: string): string {
  return String(value || '').trim()
    .replace(/[\s,，;；]+$/g, '')
    .replace(/\/(?:chat\/completions|images\/generations|images\/edits|models)\/?$/i, '')
    .replace(/\/+$/, '');
}

function joinUrl(base: string, path: string): string {
  return `${cleanBaseUrl(base)}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 从 /models 响应里抽取模型 id(兼容 {data:[{id}]} / {models:[...]} / 字符串数组)。 */
export function extractModelIds(data: unknown): string[] {
  const root = data as Record<string, any>;
  const list: any[] = Array.isArray(root?.data) ? root.data
    : Array.isArray(root?.models) ? root.models
    : Array.isArray(root) ? (root as any[]) : [];
  const ids = list.map((item) => typeof item === 'string' ? item : String(item?.id || item?.name || '')).map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(ids)).sort();
}

function inferDialect(node: Record<string, unknown>): ProviderDialect {
  const explicit = String(node.dialect || '').trim().toLowerCase();
  if ((KNOWN as string[]).includes(explicit)) return explicit as ProviderDialect;
  const provider = String(node.provider || '').trim().toLowerCase();
  if ((KNOWN as string[]).includes(provider)) return provider as ProviderDialect;
  return 'openai';
}

function toModelNodes(cfg: AppConfig): ModelNode[] {
  return (cfg.llm?.apiKeys || []).map((n) => {
    const raw = n as unknown as Record<string, unknown>;
    return { name: n.name, dialect: inferDialect(raw), baseUrl: n.baseUrl, apiKey: n.key, headers: n.headers, models: n.models, enabled: n.enabled };
  });
}

function ok(body: unknown): AdminResponse { return { status: 200, body }; }
function fail(status: number, error: string): AdminResponse { return { status, body: { success: false, error } }; }
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** 配置回存：结构与 web-api ConfigRepository.saveConfig 兼容(只用 .config)。同步或异步均可。 */
type SaveConfigFn = (patch: unknown) => { config: AppConfig } | Promise<{ config: AppConfig }>;

/**
 * apps/admin 注入给 admin-service 的真实外部集成。用 Node fetch + ModelClient + NapcatAdapter 实现。
 * 取代 local-verify-server 里内联的 fetchOpenAIModels / test-napcat / test-image / templates 等。
 * @param getConfig 读热重载后的最新配置(前向引用，闭包内 svc 就绪后生效)。
 * @param saveConfig 把配置 patch 回存(走 web-api repository.saveConfig → 触发 onReload 落盘)。
 */
export function createAdminDeps(getConfig: () => AppConfig, saveConfig: SaveConfigFn): AdminServiceDeps {
  const registry = createCapabilityRegistry();

  async function fetchModels(body: unknown): Promise<AdminResponse> {
    const b = (body || {}) as Record<string, any>;
    const baseUrl = cleanBaseUrl(String(b.baseUrl || ''));
    const key = String(b.key || '').trim();
    if (!baseUrl) return fail(400, '请填写 OpenAI 兼容 Base URL，例如 https://anyrouter.top/v1');
    try {
      const res = await fetch(joinUrl(baseUrl, '/models'), { headers: key ? { Authorization: `Bearer ${key}` } : {} });
      if (!res.ok) return fail(502, `获取模型列表失败: HTTP ${res.status}`);
      const data = await res.json();
      const models = extractModelIds(data);
      return ok({ success: true, models, normalized: { baseUrl, keyDetected: Boolean(key) } });
    } catch (e) {
      return fail(502, errMsg(e));
    }
  }

  async function fetchHuggingFaceModels(body: unknown): Promise<AdminResponse> {
    const cfg = getConfig();
    const b = (body || {}) as Record<string, any>;
    const hf = { ...(cfg.huggingFace || {}), ...(b.huggingFace || {}) };
    const filters = { ...(cfg.huggingFace?.filters || {}), ...(b.huggingFace?.filters || {}), ...(b.filters || {}) };
    const hub = cleanBaseUrl(String(hf.hubApiUrl || 'https://huggingface.co/api/models')).replace(/\/models$/, '/models');
    const params = new URLSearchParams();
    if (filters.search) params.set('search', String(filters.search));
    if (filters.author) params.set('author', String(filters.author));
    if (filters.pipelineTag) params.set('pipeline_tag', String(filters.pipelineTag));
    params.set('limit', String(Math.max(1, Math.min(200, Number(filters.limit) || 50))));
    params.set('full', 'true');
    try {
      const url = `${hub}?${params.toString()}`;
      const res = await fetch(url, { headers: hf.token ? { Authorization: `Bearer ${hf.token}` } : {} });
      if (!res.ok) return fail(502, `Hugging Face 列表失败: HTTP ${res.status}`);
      const data = await res.json();
      const models = Array.isArray(data) ? data.map((m: any) => ({ id: String(m?.id || m?.modelId || ''), pipelineTag: String(m?.pipeline_tag || ''), downloads: Number(m?.downloads || 0), likes: Number(m?.likes || 0) })).filter((m) => m.id) : [];
      return ok({ success: true, models });
    } catch (e) {
      return fail(502, errMsg(e));
    }
  }

  async function testImage(body: unknown): Promise<AdminResponse> {
    const cfg = getConfig();
    const b = (body || {}) as Record<string, any>;
    const nodeIndex = Number.isFinite(Number(b.nodeIndex)) ? Number(b.nodeIndex) : cfg.canvas.imageNodeIndex;
    const model = String(b.model || cfg.canvas.imageModel || cfg.llm.imageModel || '').trim();
    if (!model) return fail(400, '未配置生图模型。');
    const prompt = String(b.prompt || 'a small red apple on a white table, studio lighting').trim();
    try {
      const client = createModelClient({ nodes: toModelNodes(cfg), registry });
      const result = await client.generateImages(nodeIndex, { model, prompt, size: b.size ? String(b.size) : undefined });
      const first = result.images[0];
      const preview = first ? (first.kind === 'url' ? first.data : `data:${first.mimeType || 'image/png'};base64,${first.data}`) : '';
      return ok({ success: true, model, image: preview, count: result.images.length });
    } catch (e) {
      return fail(502, errMsg(e));
    }
  }

  // 模板转换：对齐 monolith 行为(非 AI)——把 rawPrompt 包成带 {{prompt}} 占位符的可复用模板，
  // 存入 bot.promptTemplates 并回存配置；前端 applyServerConfig(res.data.config) 刷列表。
  async function templatesConvert(body: unknown): Promise<AdminResponse> {
    const cfg = getConfig();
    const b = (body || {}) as Record<string, any>;
    const raw = String(b.rawPrompt || b.sourcePrompt || '').trim();
    if (!raw) return fail(400, '请粘贴要转换的提示词。');
    const existing = Array.isArray(cfg.bot?.promptTemplates) ? cfg.bot.promptTemplates : [];
    const template = {
      id: `mb_${existing.length + 1}`,
      title: raw.slice(0, 16) || 'AI模板',
      prompt: raw.includes('{{prompt}}') ? raw : `${raw || '模板'}\n\n主体内容：{{prompt}}`,
    };
    try {
      const saved = await saveConfig({ bot: { promptTemplates: [...existing, template] } });
      return ok({ success: true, template, config: saved.config });
    } catch (e) {
      return fail(502, errMsg(e));
    }
  }

  async function testNapcat(body: unknown): Promise<AdminResponse> {
    const cfg = getConfig();
    const b = (body || {}) as Record<string, any>;
    const wsUrl = String(b.wsUrl || cfg.napcat.wsUrl || '').trim();
    const token = String(b.token || cfg.napcat.token || '').trim() || undefined;
    if (!wsUrl) return fail(400, '请填写 Napcat WebSocket 地址。');
    const adapter = new NapcatAdapter({ wsUrl, token, autoReconnect: false, actionTimeoutMs: 8000 });
    try {
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Number(b.timeoutMs) || 8000);
        adapter.on('open', () => { clearTimeout(timer); resolve(true); });
        adapter.on('error', () => { clearTimeout(timer); resolve(false); });
        adapter.connect();
      });
      const snapshot = adapter.getConnectionSnapshot();
      return connected
        ? ok({ success: true, message: '已连接 Napcat。', snapshot })
        : fail(502, `连接失败或超时(${wsUrl})。请检查地址/Token/防火墙。`);
    } catch (e) {
      return fail(502, errMsg(e));
    } finally {
      adapter.disconnect();
    }
  }

  return { fetchModels, fetchHuggingFaceModels, testImage, templatesConvert, testNapcat };
}
