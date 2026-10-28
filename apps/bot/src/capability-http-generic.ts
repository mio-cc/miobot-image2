import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { fetchTextSafely } from './safe-http.js';

/**
 * R17/4.3：通用 HTTP 三方 API 能力——配置驱动的描述符注册器。
 * 一个描述符 = 一个工具：endpoint + 参数 schema + 输出分类 + 健康探测。
 * 模型按生成的 ToolSpec 自然语言描述自主调用；结果按 kind 分类走既有 ReplyPlan 链。
 * 新增三方 API = 在 capabilities-http.json 注册描述符，零代码改动。
 */

export interface HttpCapabilityParam {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  enumValues?: string[];
  default?: string | number | boolean;
}

export interface HttpCapabilityDescriptor {
  id: string;
  name: string;
  description: string;
  category: '生成' | '解析' | '信息' | '输入' | '其他';
  endpoint: string;
  method?: 'GET' | 'POST';
  outputKind: 'text' | 'image' | 'audio' | 'file';
  params?: HttpCapabilityParam[];
  /** 响应 JSON 里的字段路径（点分）——输出抽取；缺省取整个 JSON 序列化。 */
  outputJsonPath?: string;
  /** 图片直链的 JSON 字段路径（outputKind=image 时必填）。 */
  imageUrlJsonPath?: string;
  timeoutMs?: number;
  requiresKey?: boolean;
  keyHeaderName?: string;
  healthCheck?: { endpoint?: string; expectStatus?: number };
}

export interface HttpCapabilityRuntimeOptions {
  getConfig: () => { capabilitiesHttp?: Record<string, { enabled?: boolean; apiKey?: string; fallbackEndpoint?: string }>; browserRender?: { allowPrivateHosts?: boolean } };
  logger?: StructuredLogger;
  /** SSRF 门：复用 browser-render 的私网拦截。 */
  assertSafeUrl: (raw: string, allowPrivate: boolean) => Promise<URL>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 8_000;

/** 配置驱动注册器：加载描述符集合并按需执行。 */
export class HttpCapabilityRegistry {
  private readonly descriptors = new Map<string, HttpCapabilityDescriptor>();

  constructor(private readonly options: HttpCapabilityRuntimeOptions) {}

  register(descriptor: HttpCapabilityDescriptor): void {
    const id = String(descriptor?.id || '').trim();
    if (!id) throw new Error('http_capability_id_required');
    this.descriptors.set(id, descriptor);
  }

  load(descriptors: HttpCapabilityDescriptor[]): number {
    let loaded = 0;
    for (const descriptor of descriptors) {
      try {
        this.register(descriptor);
        loaded += 1;
      } catch { /* 单个坏描述符不阻塞其余加载 */ }
    }
    return loaded;
  }

  list(): HttpCapabilityDescriptor[] {
    return [...this.descriptors.values()];
  }

  get(id: string): HttpCapabilityDescriptor | undefined {
    return this.descriptors.get(String(id));
  }

  isEnabled(id: string): boolean {
    return this.options.getConfig().capabilitiesHttp?.[id]?.enabled !== false;
  }

  /** 生成 capability descriptor（builtin-capabilities 同形态），接入 orchestration 注册表。 */
  toCapabilityDescriptor(id: string): { id: string; name: string; description: string; provider: string; mode: 'sync'; riskLevel: string; mergeable: boolean; outputKinds: string[]; inputSchema: unknown } | undefined {
    const descriptor = this.get(id);
    if (!descriptor) return undefined;
    const properties: Record<string, unknown> = {};
    for (const param of descriptor.params || []) {
      properties[param.name] = {
        type: param.type,
        description: param.description,
        ...(param.enumValues?.length ? { enum: param.enumValues } : {}),
        ...(param.default !== undefined ? { default: param.default } : {}),
      };
    }
    return {
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description,
      provider: 'http-generic',
      mode: 'sync',
      riskLevel: 'low',
      mergeable: true,
      outputKinds: [descriptor.outputKind],
      inputSchema: {
        type: 'object',
        properties,
        required: (descriptor.params || []).filter((p) => p.required).map((p) => p.name),
        additionalProperties: false,
      },
    };
  }

  /** 执行一次 HTTP 调用并按 kind 分类产出。 */
  async execute(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ outputs: Array<{ kind: string; text?: string; url?: string; priority: number; mergeable: boolean }>; degraded?: boolean; note?: string }> {
    const descriptor = this.get(id);
    if (!descriptor) throw new Error(`http_capability_unknown:${id}`);
    if (!this.isEnabled(id)) return { outputs: [{ kind: 'text', text: '该能力当前已停用。', priority: 10, mergeable: true }] };

    const url = await this.buildUrl(descriptor, args);
    const runtimeCfg = this.options.getConfig();
    const apiKey = this.options.getConfig().capabilitiesHttp?.[id]?.apiKey;
    const headers: Record<string, string> = { 'accept': 'application/json, text/plain, */*', 'user-agent': 'Miobot/2.0 (+http-capability)' };
    if (apiKey && descriptor.keyHeaderName) headers[descriptor.keyHeaderName] = apiKey;

    const timeoutMs = Math.max(1000, Math.trunc(Number(descriptor.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const method = descriptor.method === 'POST' ? 'POST' : 'GET';
    const allowPrivate = this.options.getConfig().browserRender?.allowPrivateHosts || false;
    try {
      const result = await fetchTextSafely(url.toString(), {
        assertSafeUrl: this.options.assertSafeUrl,
        allowPrivate,
        signal,
        timeoutMs,
        maxBytes: 2_000_000,
        init: { method, headers },
      });
      if (!result.response.ok) throw new Error(`HTTP ${result.response.status}`);
      return this.classify(descriptor, result.text);
    } catch (error) {
      const fallbackEndpoint = runtimeCfg.capabilitiesHttp?.[id]?.fallbackEndpoint;
      // F-7 互备：主站挂了走配置的备源；fallback 同样逐跳 SSRF 校验和超时。
      if (fallbackEndpoint) {
        try {
          const fallbackResult = await fetchTextSafely(this.renderEndpoint(fallbackEndpoint, descriptor, args), {
            assertSafeUrl: this.options.assertSafeUrl,
            allowPrivate,
            timeoutMs,
            maxBytes: 2_000_000,
            init: { method, headers },
          });
          if (!fallbackResult.response.ok) throw new Error(`HTTP ${fallbackResult.response.status}`);
          return this.classify(descriptor, fallbackResult.text);
        } catch { /* 落到下面的失败输出 */ }
      }
      return {
        outputs: [{ kind: 'text', text: `该能力当前不可用（${String((error as Error)?.message || error)}）。可稍后再试或换用其他同类能力。`, priority: 10, mergeable: true }],
        degraded: true,
      };
    }
  }

  private renderEndpoint(endpoint: string, descriptor: HttpCapabilityDescriptor, args: Record<string, unknown>): string {
    let url = String(endpoint || '');
    for (const param of descriptor.params || []) {
      const value = args[param.name] !== undefined ? args[param.name] : param.default;
      if (value !== undefined) {
        url = url.replace(new RegExp(`\\{${param.name}\\}`, 'g'), encodeURIComponent(String(value)));
      }
    }
    return url;
  }

  private async buildUrl(descriptor: HttpCapabilityDescriptor, args: Record<string, unknown>): Promise<URL> {
    const base = this.renderEndpoint(descriptor.endpoint, descriptor, args);
    const url = await this.options.assertSafeUrl(base, this.options.getConfig().browserRender?.allowPrivateHosts || false);
    // 未在路径模板里消耗掉的参数进 query string
    for (const param of descriptor.params || []) {
      if (base.includes(`{${param.name}}`)) continue;
      const value = args[param.name];
      if (value !== undefined && String(value).trim()) {
        url.searchParams.set(param.name, String(value));
      }
    }
    return url;
  }

  /** 产物分类纪律（12.1）：JSON → 抽字段→text；image 直链 → image（不把 URL 当文本发）。 */
  private classify(descriptor: HttpCapabilityDescriptor, bodyText: string): { outputs: Array<{ kind: string; text?: string; url?: string; priority: number; mergeable: boolean }> } {
    let parsed: any = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = null; }

    if (descriptor.outputKind === 'image') {
      const imageUrl = descriptor.imageUrlJsonPath ? pickPath(parsed, descriptor.imageUrlJsonPath) : (typeof parsed === 'string' ? parsed : null);
      if (imageUrl && /^https?:\/\//.test(String(imageUrl))) {
        return { outputs: [{ kind: 'image', url: String(imageUrl), priority: 9, mergeable: true }] };
      }
      return { outputs: [{ kind: 'text', text: '该能力没有返回有效图片，可稍后再试。', priority: 10, mergeable: true }], };
    }

    let text = '';
    if (descriptor.outputJsonPath && parsed) {
      text = String(pickPath(parsed, descriptor.outputJsonPath) ?? '');
    } else if (parsed) {
      text = flattenJsonText(parsed);
    } else {
      text = bodyText;
    }
    if (text.length > MAX_RESPONSE_CHARS) text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n[内容截断]`;
    return { outputs: [{ kind: 'text', text: text || '该能力没有返回有效内容。', priority: 10, mergeable: true }] };
  }
}

function pickPath(value: unknown, path: string): unknown {
  return String(path).split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), value);
}

function flattenJsonText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenJsonText(item)).filter(Boolean).join('\n').slice(0, MAX_RESPONSE_CHARS);
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${flattenJsonText(v)}`)
    .join('\n')
    .slice(0, MAX_RESPONSE_CHARS);
}