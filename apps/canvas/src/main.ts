import { createCanvasService, CanvasStore, InMemoryAssetStore, type AssetStore, type StoredAsset, type CanvasGenerator, type CanvasService, type GenerationArtifact } from '../../../packages/canvas-service/src/index.js';
import { createCapabilityRegistry, createModelClient, type CapabilityRegistry, type ImageArtifact, type ImageResult, type ModelClient } from '../../../packages/model/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';
import fs from 'node:fs';
import path from 'node:path';

export const CANVAS_APP: PackageDescriptor = { name: '@miobot-v2/app-canvas', phase: 'P6-canvas-service' };

/** 文件后端资产仓储。
 *  v2 格式：{id}.json（{contentType,base64,createdAt}）。
 *  兼容 monolith 格式：{id}.{png,jpg,jpeg,webp,gif} 二进制文件（自动转 base64 返回）。 */
export class FileAssetStore implements AssetStore {
  private readonly dir: string;
  constructor(dir: string) { this.dir = path.resolve(dir); }
  private file(id: string): string { return path.join(this.dir, `${encodeURIComponent(id)}.json`); }
  put(id: string, asset: StoredAsset): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(id), JSON.stringify(asset), 'utf8');
  }
  get(id: string): StoredAsset | undefined {
    // 1. v2 格式：{id}.json
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as StoredAsset; } catch { /* fallthrough */ }
    // 2. monolith 兼容：{id}.{png,jpg,jpeg,webp,gif}
    const safeId = encodeURIComponent(id);
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      const binPath = path.join(this.dir, `${safeId}.${ext}`);
      try {
        const buf = fs.readFileSync(binPath);
        const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'webp' ? 'image/webp'
          : ext === 'gif' ? 'image/gif'
          : 'image/png';
        return { contentType, base64: buf.toString('base64'), createdAt: new Date().toISOString() };
      } catch { /* try next ext */ }
    }
    return undefined;
  }
  delete(id: string): boolean {
    let removed = false;
    try { fs.rmSync(this.file(id), { force: true }); removed = true; } catch { /* ignore */ }
    const safeId = encodeURIComponent(id);
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      try { fs.rmSync(path.join(this.dir, `${safeId}.${ext}`), { force: true }); removed = true; } catch { /* ignore */ }
    }
    return removed;
  }
}

function artifactToGenerationArtifact(artifact: ImageArtifact): GenerationArtifact {
  if (artifact.kind === 'url') return { kind: 'url', data: artifact.data, mimeType: artifact.mimeType };
  return { kind: 'base64', data: artifact.data, mimeType: artifact.mimeType || 'image/png' };
}
function artifactsToGeneration(result: ImageResult): GenerationArtifact[] {
  return (result.images || []).map(artifactToGenerationArtifact);
}

/** 用统一 ModelClient 实现画布生成能力——与 bot 共用方言/能力/参数规整(同一兼容性逻辑)。 */
export function createModelCanvasGenerator(client: ModelClient): CanvasGenerator {
  return {
    async generate(input) {
      const res = await client.generateImages(input.nodeIndex, { model: input.model, prompt: input.prompt, size: input.size, count: input.count, quality: input.quality });
      return { images: artifactsToGeneration(res) };
    },
    async edit(input) {
      const res = await client.editImage(input.nodeIndex, { model: input.model, prompt: input.prompt, images: input.images, size: input.size, quality: input.quality });
      return { images: artifactsToGeneration(res) };
    },
    async interrogate(input) {
      const res = await client.interrogate(input.nodeIndex, { model: input.model, imageUrls: [input.image], prompt: input.prompt });
      return { text: res.text };
    },
    async interrogateTemplate(input) {
      // 第二步：复用视觉通道(interrogate 走 buildVision)把描述套成含 {{prompt}} 占位符的可复用模板(对齐 monolith createVision)。
      const res = await client.interrogate(input.nodeIndex, { model: input.model, imageUrls: [input.image], prompt: input.prompt });
      return { text: res.text };
    },
  };
}

export interface CanvasAppOptions {
  getConfig: () => AppConfig;
  client?: ModelClient;
  registry?: CapabilityRegistry;
  /** 画布状态文件(JSON)；不给则内存。 */
  stateFilePath?: string;
  /** 资产目录;给定则二进制产物落盘可下载,否则内存。 */
  assetDir?: string;
  maxHistory?: number;
  /** 鉴权回调(/bot/gallery 需要)；默认不鉴权。可延迟注入(闭包在请求时解析 admin 仓储)。 */
  isAuthorized?: (headers?: Record<string, string | undefined>) => boolean;
}

export interface CanvasApp {
  service: CanvasService;
  client: ModelClient;
}

/**
 * 装配画布应用：ModelClient(节点表来自配置) → CanvasGenerator → canvas-service(状态+路由+资产)。
 * 取代 web-canvas/apps/api 独立的一套 provider 选择。
 */
export function createCanvasApp(options: CanvasAppOptions): CanvasApp {
  const registry = options.registry || createCapabilityRegistry();
  const client = options.client || createModelClient({ nodes: toModelNodes(options.getConfig()), registry });
  const generator = createModelCanvasGenerator(client);
  const store = new CanvasStore({ filePath: options.stateFilePath, maxHistory: options.maxHistory ?? options.getConfig().canvas?.maxHistory });
  const assets: AssetStore = options.assetDir ? new FileAssetStore(options.assetDir) : new InMemoryAssetStore();
  const service = createCanvasService({ getConfig: options.getConfig, generator, store, assets, isAuthorized: options.isAuthorized });
  return { service, client };
}

/** 画布节点表：与 bot 一致从 llm.apiKeys 取(方言默认 openai，可被 provider/dialect 覆盖)。 */
function toModelNodes(cfg: AppConfig) {
  const known = ['openai', 'anthropic', 'gemini', 'huggingface', 'custom'];
  return (cfg.llm?.apiKeys || []).map((node) => {
    const raw = node as unknown as Record<string, unknown>;
    const explicit = String(raw.dialect || '').trim().toLowerCase();
    const provider = String(raw.provider || '').trim().toLowerCase();
    const dialect = (known.includes(explicit) ? explicit : known.includes(provider) ? provider : 'openai') as 'openai' | 'anthropic' | 'gemini' | 'huggingface' | 'custom';
    return { name: node.name, dialect, baseUrl: node.baseUrl, apiKey: node.key, headers: node.headers, models: node.models, enabled: node.enabled };
  });
}

export function describeCanvasApp() {
  return { app: '@miobot-v2/app-canvas', phase: 'P6-canvas-service' as const, packages: ['@miobot-v2/canvas-service', '@miobot-v2/model', '@miobot-v2/storage'] };
}
