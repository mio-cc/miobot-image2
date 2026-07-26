import { createModelClient, createReloadableRegistry, type CapabilityOverride, type ModelNode, type ModelOperation, type ProviderDialect } from '../../../packages/model/src/index.js';
import { NapcatAdapter } from '../../../packages/napcat/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { AdminResponse, AdminServiceDeps } from '../../../packages/admin-service/src/index.js';

const KNOWN: ProviderDialect[] = ['openai', 'anthropic', 'gemini', 'huggingface', 'custom'];

/**
 * OpenAI 兼容 Base URL 的清洗。
 *
 * 规则必须与 config 里的 cleanupApiBaseUrl 一致——那边是落盘用的，这边是探测用的。
 * 两边不一致时，「探测通过的地址」和「实际存下来的地址」会是两个东西，
 * 于是「获取模型成功了，但发消息还是连不上」。
 */
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
  // new-api / one-api 一类网关会在外面再包一层业务信封：
  //   { code: 0, msg: 'ok', data: { object: 'list', data: [...] } }
  // 只认最外层的话会静默拿到 0 个模型，界面还显示成功。
  const unwrap = (value: unknown, depth = 0): any[] => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object' || depth > 2) return [];
    const node = value as Record<string, any>;
    for (const key of ['data', 'models', 'result', 'items']) {
      const found = unwrap(node[key], depth + 1);
      if (found.length) return found;
    }
    return [];
  };
  const ids = unwrap(data)
    .map((item) => typeof item === 'string' ? item : String(item?.id || item?.model || item?.name || ''))
    .map((s) => s.trim())
    .filter(Boolean);
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
    return { name: n.name, dialect: inferDialect(raw), baseUrl: n.baseUrl, apiKey: n.key, headers: n.headers, models: n.models, enabled: n.enabled, concurrency: n.concurrency };
  });
}

/** AppConfig.llm.capabilityOverrides → model 层 CapabilityOverride[]。 */
function toCapabilityOverrides(cfg: AppConfig): CapabilityOverride[] {
  const overrides = cfg.llm?.capabilityOverrides || [];
  if (!Array.isArray(overrides) || !overrides.length) return [];
  // 必须包含 video.generate：视频模型名（Veo / CogVideoX / Vidu…）最没规律，
  // 恰恰是最需要手动指定能力的一类，漏掉它等于覆盖功能对视频不生效。
  const ALLOWED: ModelOperation[] = ['chat', 'vision', 'interrogate', 'image.generate', 'image.edit', 'video.generate'];
  return overrides
    .filter((o) => o && String(o.model || '').trim())
    .map((o) => {
      const ops = (o.operations || []).map((op) => String(op || '').trim() as ModelOperation).filter((op) => (ALLOWED as string[]).includes(op));
      return ops.length ? { model: String(o.model).trim(), operations: ops } : { model: String(o.model).trim() };
    });
}

/** 面板上的密钥是打码值（含 ••••）。收到打码值等于「用户没改过」，要用存量真值。 */
const MASK_SENTINEL = '••••';
function isMasked(value: string): boolean { return value.includes(MASK_SENTINEL); }

/**
 * 上游失败时把响应正文里的原因带出来。
 *
 * 只报 `HTTP 403` 等于什么都没说：中转站几乎都会在 body 里写明真正原因
 * （余额不足、key 无权限、模型不存在、区域限制），丢掉它用户根本没法排查。
 * 正文可能是 JSON 也可能是 HTML 错误页，两种都收，并且截断——
 * 有的网关直接返回整页 HTML，糊到面板上没有意义。
 */
async function upstreamDetail(res: Response): Promise<string> {
  let text = '';
  try { text = await res.text(); } catch { return ''; }
  if (!text.trim()) return '';
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message ?? json?.message ?? json?.error ?? json?.detail;
    if (typeof msg === 'string' && msg.trim()) return ` · ${msg.trim().slice(0, 300)}`;
  } catch { /* 不是 JSON，往下当纯文本处理 */ }
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain ? ` · ${plain.slice(0, 300)}` : '';
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
  // 不能在这里求值一次：createAdminApp 调用本函数时 svc 还是 null，getConfig() 返回的是
  // 进程启动时的磁盘快照。用户在「能力分工」页加了能力覆盖、面板提示「已热重载」、
  // 体检表也转绿了（那条路每次请求新建 registry），可「测试生图」这里仍然用开机快照，
  // 于是同一个页面上「体检说能用」和「测试说不支持」自相矛盾，重启才一致。
  const getRegistry = createReloadableRegistry(() => toCapabilityOverrides(getConfig()));

  /**
   * 面板发来的节点定位。
   *
   * 优先用 keyRef——它是打码那一刻写进节点对象的下标（见 web-api/secrets.ts），
   * 挂在对象上、随 splice 一起走。用实时下标会漂：用户删掉一个节点但还没保存时，
   * 后面每个节点的下标都往前挪一位，按下标取到的是**别的节点**。
   * 取模型时表现为跨家 401（更糟的是请求成功、把 A 账号的模型列表写进 B），
   * 测试生图时表现为「拿 B 的凭据去测 C 的模型」。
   */
  function resolveNode(body: Record<string, any>, fallbackIndex?: number) {
    const nodes = getConfig().llm?.apiKeys || [];
    const raw = Number(body.keyRef ?? body.nodeIndex ?? fallbackIndex);
    const index = Number.isInteger(raw) && raw >= 0 && raw < nodes.length ? raw : -1;
    return { nodes, index, node: index >= 0 ? nodes[index] : undefined };
  }

  async function fetchModels(body: unknown): Promise<AdminResponse> {
    const b = (body || {}) as Record<string, any>;
    // 面板对已保存的节点发的是空 key（界面上只有打码值），指望后端凭 nodeIndex
    // 自己去取真值。之前这里只读 b.key，于是请求不带 Authorization 头就发出去了，
    // 上游一律 401——表现就是「已经配好的节点，一点获取模型就失败」。
    const { node: stored } = resolveNode(b);

    const submittedKey = String(b.key || '').trim();
    const key = (!submittedKey || isMasked(submittedKey)) ? String(stored?.key || '').trim() : submittedKey;
    const baseUrl = cleanBaseUrl(String(b.baseUrl || stored?.baseUrl || ''));

    if (!baseUrl) return fail(400, '请填写 OpenAI 兼容 Base URL，例如 https://anyrouter.top/v1');
    try {
      const res = await fetch(joinUrl(baseUrl, '/models'), { headers: key ? { Authorization: `Bearer ${key}` } : {} });
      if (!res.ok) {
        const hint = !key && res.status === 401 ? '（该节点还没有密钥）' : '';
        return fail(502, `获取模型列表失败: HTTP ${res.status}${hint}${await upstreamDetail(res)}`);
      }
      const data = await res.json();
      const models = extractModelIds(data);
      // 上游 200 但一个都解析不出来，通常是响应形状不认识，而不是真没有模型。
      // 以前这里照样报成功，面板拿到空数组把已有列表清空了——用户会以为节点坏了。
      if (!models.length) {
        return ok({
          success: true,
          models,
          warning: '上游返回了 200，但没能从响应里解析出任何模型（可能是响应格式不认识）。已保留原有列表。',
          normalized: { baseUrl, keyDetected: Boolean(key) },
        });
      }
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
    // 不能用 cleanBaseUrl：它的白名单里有 models，会把 HF hub 正确的 /api/models 尾巴剥掉，
    // 剥完再 .replace(/\/models$/, '/models') 是个自我替换、匹配不上，等于没写——
    // 最终打到 https://huggingface.co/api，稳定 404。
    const hubRaw = String(hf.hubApiUrl || 'https://huggingface.co/api/models').trim().replace(/[\s,，;；]+$/g, '').replace(/\/+$/, '');
    const hub = /\/models$/i.test(hubRaw) ? hubRaw : `${hubRaw}/models`;
    const params = new URLSearchParams();
    if (filters.search) params.set('search', String(filters.search));
    if (filters.author) params.set('author', String(filters.author));
    if (filters.pipelineTag) params.set('pipeline_tag', String(filters.pipelineTag));
    params.set('limit', String(Math.max(1, Math.min(200, Number(filters.limit) || 50))));
    params.set('full', 'true');
    try {
      const url = `${hub}?${params.toString()}`;
      const res = await fetch(url, { headers: hf.token ? { Authorization: `Bearer ${hf.token}` } : {} });
      if (!res.ok) return fail(502, `Hugging Face 列表失败: HTTP ${res.status}${await upstreamDetail(res)}`);
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
    const resolved = resolveNode(b, cfg.canvas.imageNodeIndex);
    const nodeIndex = resolved.index >= 0 ? resolved.index : cfg.canvas.imageNodeIndex;
    const model = String(b.model || cfg.canvas.imageModel || cfg.llm.imageModel || '').trim();
    if (!model) return fail(400, '未配置生图模型。');
    const prompt = String(b.prompt || 'a small red apple on a white table, studio lighting').trim();
    // 超时/重试以前一个都没传，ModelClient 一律按默认 60s 走。
    // 生图模型动辄 90–180 秒，于是「面板上把超时调到 300s、测试生图仍然 60 秒就失败，
    // 群里发同一张图却能成」，用户会照着这个错误结论去改 baseUrl 和 key，越改越乱。
    const timeoutMs = cfg.canvas.imageTimeoutMs || cfg.llm.imageTimeoutMs;
    try {
      const client = createModelClient({
        nodes: () => toModelNodes(getConfig()),
        registry: getRegistry,
        retries: cfg.llm.imageRetryCount,
        retryDelayMs: cfg.llm.imageRetryDelayMs,
        getNodeConcurrency: (i) => getConfig().llm.apiKeys?.[i]?.concurrency,
      });
      const result = await client.generateImages(nodeIndex, {
        model,
        prompt,
        size: b.size ? String(b.size) : undefined,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
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
    // 打码值等于「用户没改过」，要用磁盘上的真 token；
    // 直接 String(b.token || ...) 会把 abc••••••••wxyz 当成真 token 发给 NapCat。
    const submittedToken = String(b.token || '').trim();
    const token = (submittedToken && !isMasked(submittedToken) ? submittedToken : String(cfg.napcat.token || '').trim()) || undefined;
    if (!wsUrl) return fail(400, '请填写 Napcat WebSocket 地址。');
    const adapter = new NapcatAdapter({ wsUrl, token, autoReconnect: false, actionTimeoutMs: 8000 });
    const startedAt = Date.now();
    try {
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Number(b.timeoutMs) || 8000);
        adapter.on('open', () => { clearTimeout(timer); resolve(true); });
        adapter.on('error', () => { clearTimeout(timer); resolve(false); });
        adapter.connect();
      });
      const snapshot = adapter.getConnectionSnapshot();
      if (!connected) return fail(502, `连接失败或超时(${wsUrl})。请检查地址/Token/防火墙。`);

      // 握手成功只说明端口通了。再要一次登录信息，才能证明 token 也对——
      // 鉴权失败的连接同样会 open，随后才被服务端关掉。
      let selfQqId = '';
      let nickname = '';
      try {
        const info = await adapter.callAction<{ user_id?: number | string; nickname?: string }>('get_login_info', {}, 5000);
        selfQqId = String(info?.data?.user_id ?? '');
        nickname = String(info?.data?.nickname ?? '');
      } catch { /* 拿不到账号信息不影响"连上了"这个结论 */ }

      return ok({
        success: true,
        message: selfQqId ? `已连接 NapCat，登录账号 ${nickname || selfQqId}。` : '已连接 NapCat（未取到账号信息）。',
        latencyMs: Date.now() - startedAt,
        selfQqId,
        nickname,
        snapshot,
      });
    } catch (e) {
      return fail(502, errMsg(e));
    } finally {
      adapter.disconnect();
    }
  }

  return { fetchModels, fetchHuggingFaceModels, testImage, templatesConvert, testNapcat };
}
