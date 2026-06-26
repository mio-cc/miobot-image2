import type { AppConfig } from '../../config/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';
import { CanvasStore, type GenerationRecord, type InterrogationItem } from './state.js';
import { InMemoryAssetStore, parseDataUrl, type AssetStore } from './assets.js';

export interface CanvasResponse<T = unknown> { status: number; body: T; binary?: { contentType: string; base64: string } }
export interface CanvasRequest { method: string; path: string; headers?: Record<string, string | undefined>; body?: unknown }

/** 画布下游生成能力(由 apps/canvas 用 ModelClient 实现，复用加固后的方言/能力/参数规整)。 */
export interface CanvasGenerator {
  generate(input: { nodeIndex: number; model: string; prompt: string; size?: string; count?: number; quality?: string }): Promise<{ images: string[] }>;
  edit(input: { nodeIndex: number; model: string; prompt: string; images: string[]; size?: string; quality?: string }): Promise<{ images: string[] }>;
  interrogate(input: { nodeIndex: number; model: string; image: string; prompt?: string }): Promise<{ text: string }>;
}

export interface CanvasServiceOptions {
  getConfig: () => AppConfig;
  generator: CanvasGenerator;
  store?: CanvasStore;
  assets?: AssetStore;
  now?: () => Date;
  idFactory?: () => string;
}

export const CANVAS_SERVICE_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/canvas-service',
  phase: 'P6-canvas-service',
};

const SIZE_PRESETS = [
  { id: 'auto', label: '自动', size: 'auto' },
  { id: 'square', label: '正方形 1:1', size: '1024x1024' },
  { id: 'portrait', label: '竖图 2:3', size: '1024x1536' },
  { id: 'landscape', label: '横图 3:2', size: '1536x1024' },
];
const STYLE_PRESETS = [{ id: 'none', label: '无', prompt: '' }];

/**
 * 画布后端：项目/画廊/反推状态 + 生成/改图/反推(统一走 model 层)。
 * 取代 web-canvas/apps/api 与 local-verify-server 两处画布逻辑，合为一处权威实现。
 * 传输无关；二进制资产/缩略图暂以内联 data URL 处理(后续可接 storage 二进制层)。
 */
export class CanvasService {
  private readonly getConfig: () => AppConfig;
  private readonly generator: CanvasGenerator;
  private readonly store: CanvasStore;
  private readonly assets: AssetStore;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: CanvasServiceOptions) {
    this.getConfig = options.getConfig;
    this.generator = options.generator;
    this.store = options.store || new CanvasStore();
    this.assets = options.assets || new InMemoryAssetStore();
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || defaultIdFactory();
  }

  getStore(): CanvasStore { return this.store; }
  getAssets(): AssetStore { return this.assets; }

  async handle(req: CanvasRequest): Promise<CanvasResponse> {
    const method = String(req.method || 'GET').toUpperCase();
    const path = stripPrefix(req.path);
    const body = req.body as Record<string, any> | undefined;

    if (method === 'GET' && path === '/health') return { status: 200, body: { status: 'ok' } };
    if (method === 'GET' && path === '/config') return { status: 200, body: this.configView() };
    if (method === 'GET' && path === '/project') return { status: 200, body: this.publicProject() };
    if (method === 'PUT' && path === '/project') {
      this.store.setProject({ name: body?.name, snapshot: Object.prototype.hasOwnProperty.call(body || {}, 'snapshot') ? body!.snapshot : undefined });
      return { status: 200, body: this.publicProject() };
    }
    if (method === 'GET' && path === '/gallery') return { status: 200, body: { items: this.store.gallery(), total: this.store.gallery().length } };
    if (method === 'GET' && path === '/interrogations') return { status: 200, body: { items: this.store.interrogations(), total: this.store.interrogations().length } };

    const galFav = path.match(/^\/gallery\/(.+)\/favorite$/);
    if (method === 'PATCH' && galFav) {
      const ok = this.store.setGalleryFavorite(decodeURIComponent(galFav[1]), Boolean(body?.favorite));
      return ok ? { status: 200, body: { ok: true, favorite: Boolean(body?.favorite) } } : notFound('Gallery image record not found');
    }
    const galDel = path.match(/^\/gallery\/(.+)$/);
    if (method === 'DELETE' && galDel) {
      const id = decodeURIComponent(galDel[1]);
      const ok = this.store.deleteGalleryItem(id);
      if (ok) this.assets.delete(id);
      return ok ? { status: 200, body: { ok: true, deleted: id } } : notFound('Gallery image record not found');
    }
    const intFav = path.match(/^\/interrogations\/(.+)\/favorite$/);
    if (method === 'PATCH' && intFav) {
      const ok = this.store.setInterrogationFavorite(decodeURIComponent(intFav[1]), Boolean(body?.favorite));
      return ok ? { status: 200, body: { ok: true, favorite: Boolean(body?.favorite) } } : notFound('Interrogation record not found');
    }
    const intDel = path.match(/^\/interrogations\/(.+)$/);
    if (method === 'DELETE' && intDel) {
      const ok = this.store.deleteInterrogationItem(decodeURIComponent(intDel[1]));
      return ok ? { status: 200, body: { ok: true, deleted: intDel[1] } } : notFound('Interrogation record not found');
    }

    if (method === 'POST' && (path === '/images/generate' || path === '/images/edit')) {
      return this.runGeneration(path.endsWith('/edit') ? 'edit' : 'generate', body || {});
    }
    if (method === 'POST' && path === '/interrogate') return this.runInterrogation(body || {});

    const assetMatch = path.match(/^\/assets\/([^/]+)\/(download|preview)$/);
    if (method === 'GET' && assetMatch) {
      const asset = this.assets.get(decodeURIComponent(assetMatch[1]));
      if (!asset) return notFound('Asset not found');
      // preview 暂等同 download(未做缩略图)。
      return { status: 200, body: null, binary: { contentType: asset.contentType, base64: asset.base64 } };
    }

    return notFound('Canvas API route not found');
  }

  private async runGeneration(mode: 'generate' | 'edit', body: Record<string, any>): Promise<CanvasResponse> {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return { status: 400, body: { error: { code: 'invalid', message: '请输入提示词。' } } };
    const canvas = this.getConfig().canvas;
    const isEdit = mode === 'edit';
    const model = isEdit ? (canvas.editModel || canvas.imageModel) : canvas.imageModel;
    if (!model) return { status: 400, body: { error: { code: 'no_model', message: `画布${isEdit ? '改图' : '生图'}未配置模型。` } } };
    const nodeIndex = isEdit ? canvas.editNodeIndex : canvas.imageNodeIndex;
    const size = body.size ? String(body.size) : undefined;
    const quality = body.quality || canvas.defaultQuality;
    const count = Math.max(1, Math.min(16, Math.trunc(Number(body.count || canvas.defaultCount || 1) || 1)));

    try {
      let images: string[];
      if (isEdit) {
        const refs = (Array.isArray(body.referenceImages) ? body.referenceImages : body.referenceImage ? [body.referenceImage] : [])
          .map((r: any) => String(r?.dataUrl || r?.url || r || '').trim()).filter(Boolean);
        if (!refs.length) return { status: 400, body: { error: { code: 'no_reference', message: '改图缺少参考图。' } } };
        ({ images } = await this.generator.edit({ nodeIndex, model, prompt, images: refs, size, quality }));
      } else {
        ({ images } = await this.generator.generate({ nodeIndex, model, prompt, size, count, quality }));
      }
      const createdAt = this.now().toISOString();
      const record: GenerationRecord = {
        id: this.idFactory(), mode, prompt, model, size, quality, createdAt,
        outputs: images.map((image) => this.storeOutput(image, createdAt)),
      };
      this.store.addRecord(record);
      return { status: 200, body: { record } };
    } catch (error) {
      return { status: 502, body: { error: { code: 'generation_failed', message: errMsg(error) } } };
    }
  }

  /** data URL 输出转存为二进制资产并改用下载链接;外链原样保留。 */
  private storeOutput(image: string, createdAt: string): { id: string; url: string } {
    const id = this.idFactory();
    const parsed = parseDataUrl(image);
    if (parsed) {
      this.assets.put(id, { contentType: parsed.contentType, base64: parsed.base64, createdAt });
      return { id, url: `/canvas-api/assets/${encodeURIComponent(id)}/download` };
    }
    return { id, url: image };
  }

  private async runInterrogation(body: Record<string, any>): Promise<CanvasResponse> {
    const image = String(body.image?.dataUrl || body.image?.url || body.image || '').trim();
    if (!image) return { status: 400, body: { error: { code: 'no_image', message: '反推缺少图片。' } } };
    const canvas = this.getConfig().canvas;
    try {
      const { text } = await this.generator.interrogate({ nodeIndex: canvas.interrogateNodeIndex, model: canvas.interrogateModel, image, prompt: canvas.interrogatePromptTemplate });
      const item: InterrogationItem = { id: this.idFactory(), text, sourceImage: image, favorite: false, createdAt: this.now().toISOString() };
      this.store.addInterrogation(item);
      return { status: 200, body: { item } };
    } catch (error) {
      return { status: 502, body: { error: { code: 'interrogate_failed', message: errMsg(error) } } };
    }
  }

  private configView() {
    const canvas = this.getConfig().canvas;
    const brand = canvas.brand || { logoText: 'Mio', pageTitle: 'Mio 图像画布', faviconUrl: '/canvas/favicon.ico' };
    return {
      model: canvas.imageModel,
      models: [canvas.imageModel, canvas.editModel].filter(Boolean),
      brand: { logoText: brand.logoText, pageTitle: brand.pageTitle, faviconUrl: brand.faviconUrl },
      sizePresets: SIZE_PRESETS,
      stylePresets: STYLE_PRESETS,
      qualities: ['auto', 'low', 'medium', 'high'],
      outputFormats: ['png', 'jpeg', 'webp'],
      counts: [1, 2, 4, 8, 16],
      defaults: { quality: canvas.defaultQuality, outputFormat: canvas.defaultOutputFormat, count: canvas.defaultCount, sizePresetId: canvas.defaultSizePresetId || 'auto', stylePresetId: canvas.defaultStylePresetId },
    };
  }

  private publicProject() {
    const project = this.store.project();
    return { ...project, interrogations: this.store.interrogations() };
  }
}

export function createCanvasService(options: CanvasServiceOptions): CanvasService {
  return new CanvasService(options);
}

function stripPrefix(path: string): string {
  const noQuery = String(path || '/').split('?')[0];
  const stripped = noQuery.replace(/^\/canvas-api/, '') || '/';
  return stripped.length > 1 && stripped.endsWith('/') ? stripped.slice(0, -1) : stripped;
}

function notFound(message: string): CanvasResponse {
  return { status: 404, body: { error: { code: 'not_found', message } } };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultIdFactory(): () => string {
  let counter = 0;
  return () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
