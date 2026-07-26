import type { AppConfig } from '../../config/src/index.js';
import type { PackageDescriptor } from '@miobot-v2/shared';
import { CanvasStore, type CanvasAsset, type GenerationOutput, type GenerationRecord, type GalleryItem, type InterrogationItem } from './state.js';
import { InMemoryAssetStore, parseDataUrl, extensionFor, type AssetStore, type StoredAsset } from './assets.js';

export interface CanvasResponse<T = unknown> { status: number; body: T; binary?: { contentType: string; base64: string } }
import { RateLimiter, canvasRouteGuard, checkCanvasAccess } from './access.js';

export interface CanvasRequest { method: string; path: string; headers?: Record<string, string | undefined>; body?: unknown }

/**
 * 画布下游生成能力(由 apps/canvas 用 ModelClient 实现，复用加固后的方言/能力/参数规整)。
 * 两步反推对齐 monolith runCanvasInterrogation：先 interrogate 拿描述，再 templateConvert 套 {{prompt}} 模板。
 */
export interface CanvasGenerator {
  generate(input: { nodeIndex: number; model: string; prompt: string; size?: string; count?: number; quality?: string }): Promise<{ images: GenerationArtifact[] }>;
  edit(input: { nodeIndex: number; model: string; prompt: string; images: string[]; size?: string; quality?: string }): Promise<{ images: GenerationArtifact[] }>;
  /** 第一步：反推图像 → 描述文本。 */
  interrogate(input: { nodeIndex: number; model: string; image: string; prompt?: string }): Promise<{ text: string }>;
  /** 第二步(可选)：把描述改写成含 {{prompt}} 占位符的可复用模板；未实现时回退用第一步文本。 */
  interrogateTemplate?(input: { nodeIndex: number; model: string; image: string; prompt: string }): Promise<{ text: string }>;
}

/** 上游图像产物(对齐 monolith artifact：base64 / url 两种)。 */
export interface GenerationArtifact {
  kind: 'base64' | 'url';
  data: string;
  mimeType?: string;
  revisedPrompt?: string;
}

export interface CanvasServiceOptions {
  getConfig: () => AppConfig;
  generator: CanvasGenerator;
  store?: CanvasStore;
  assets?: AssetStore;
  now?: () => Date;
  idFactory?: () => string;
  /** 鉴权回调(/bot/gallery 需要)；默认不鉴权(单体对 /canvas-api 其余路由也不鉴权)。 */
  isAuthorized?: (headers?: Record<string, string | undefined>) => boolean;
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
  { id: 'portrait-3-4', label: '竖图 3:4', size: '1152x1536' },
  { id: 'social-portrait', label: '社交竖图 4:5', size: '1024x1280' },
  { id: 'story', label: '竖屏故事 9:16', size: '1152x2048' },
  { id: 'video-cover', label: '视频封面 16:9', size: '2048x1152' },
  { id: 'landscape-4-3', label: '横图 4:3', size: '1536x1152' },
  { id: 'landscape-5-4', label: '横图 5:4', size: '1280x1024' },
  { id: 'ultrawide', label: '超宽屏 21:9', size: '2688x1152' },
];
const STYLE_PRESETS = [{ id: 'none', label: '无', prompt: '' }];
const MAX_GALLERY = 500;
const MAX_HISTORY = 50;
const MAX_INTERROGATIONS = 50;
const JOB_TTL_MS = 30 * 60 * 1000;

/** 后台任务(monolith job：kind/id/mode?/status/progress/createdAt/updatedAt/record?|item?/error?/queue)。 */
interface CanvasJob {
  kind: 'image' | 'interrogation';
  id: string;
  mode?: 'generate' | 'edit';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  createdAt: string;
  updatedAt: string;
  record?: GenerationRecord;
  item?: InterrogationItem;
  error?: string;
  queue?: { running: number; queued: number; limit: number; position: number };
}

/**
 * 画布后端：项目/画廊/反推状态 + 生成/改图/反推(统一走 model 层) + 异步任务 + provider/storage 配置 + bot 入库。
 * 严格对齐 local-verify-server.handleCanvasApi 的路由与响应形状，web-canvas 前端无需改动。
 * 传输无关；二进制资产以内联 base64 持有(AssetStore)，对外按 monolith publicAsset 暴露下载链接。
 */
export /** 从 PNG/JPEG/WebP 文件头解析实际图片尺寸（对齐 monolith readImageDimensions）。 */
function readImageDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return undefined;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xFF) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      offset += 2 + length;
    }
  }
  if (buffer.length >= 30 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buffer.slice(12, 16).toString('ascii');
    if (chunk === 'VP8 ') {
      const width = buffer.readUInt16LE(26) & 0x3FFF;
      const height = buffer.readUInt16LE(28) & 0x3FFF;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (chunk === 'VP8L') {
      const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24];
      const width = 1 + ((b1 & 0x3F) << 8 | b0);
      const height = 1 + ((b3 & 0x0F) << 10 | b2 << 2 | (b1 & 0xC0) >> 6);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (chunk === 'VP8X') {
      const width = 1 + (buffer[24] | buffer[25] << 8 | buffer[26] << 16);
      const height = 1 + (buffer[27] | buffer[28] << 8 | buffer[29] << 16);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
  }
  return undefined;
}

/**
 * 项目快照的体积上限。
 * 快照会常驻内存，并且画布每发生一次状态变更（每次生图、每条反推、每次收藏）
 * 都会把它整个 JSON.stringify 一遍写盘。没有上限的话，一次 PUT 就能让之后
 * 每一次操作都卡住主线程几百毫秒，重启回读还会重现。
 */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function snapshotTooLarge(snapshot: unknown): string | undefined {
  if (snapshot === undefined || snapshot === null) return undefined;
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(snapshot) ?? '', 'utf8');
  } catch {
    return '项目快照无法序列化（可能存在循环引用）。';
  }
  if (size <= MAX_SNAPSHOT_BYTES) return undefined;
  return `项目快照 ${(size / 1024 / 1024).toFixed(1)}MB，超过上限 ${MAX_SNAPSHOT_BYTES / 1024 / 1024}MB。`;
}

export class CanvasService {
  private readonly getConfig: () => AppConfig;
  private readonly generator: CanvasGenerator;
  private readonly store: CanvasStore;
  private readonly assets: AssetStore;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly isAuthorized: (headers?: Record<string, string | undefined>) => boolean;
  private readonly limiter = new RateLimiter();
  private readonly imageJobs = new Map<string, CanvasJob>();
  private readonly interrogationJobs = new Map<string, CanvasJob>();

  constructor(options: CanvasServiceOptions) {
    this.getConfig = options.getConfig;
    this.generator = options.generator;
    this.store = options.store || new CanvasStore();
    this.assets = options.assets || new InMemoryAssetStore();
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || defaultIdFactory();
    this.isAuthorized = options.isAuthorized || (() => true);
  }

  getStore(): CanvasStore { return this.store; }
  getAssets(): AssetStore { return this.assets; }

  async handle(req: CanvasRequest): Promise<CanvasResponse> {
    const method = String(req.method || 'GET').toUpperCase();
    const { path, query } = splitPath(req.path);
    const body = req.body as Record<string, any> | undefined;

    // 所有会改变状态的路由都要过访问控制：画布前台没有登录态，
    // 不拦的话任何能访问端口的人都能消耗上游额度、甚至把画廊连同磁盘资产删空。
    const guard = canvasRouteGuard(method, path);
    if (guard.guarded) {
      const decision = checkCanvasAccess({
        config: this.getConfig(),
        headers: req.headers,
        isAuthorized: this.isAuthorized,
        limiter: this.limiter,
        countsAgainstLimit: guard.countsAgainstLimit,
      });
      if (!decision.allowed) {
        return { status: decision.status, body: { error: { code: decision.code, message: decision.message } } };
      }
    }

    if (method === 'GET' && path === '/health') return { status: 200, body: { status: 'ok' } };
    if (method === 'GET' && path === '/config') return { status: 200, body: this.configView() };
    if (method === 'GET' && path === '/auth/status') return { status: 200, body: { signedIn: false, source: 'canvas-service', available: true } };
    if (method === 'GET' && path === '/provider-config') return { status: 200, body: { sources: [{ id: 'local', label: 'Local canvas provider', configured: true, available: true }], current: 'local', model: this.getConfig().canvas.imageModel } };
    if (method === 'PUT' && path === '/provider-config') return { status: 200, body: { ok: true, source: 'local' } };
    if (method === 'GET' && path === '/storage/config') return { status: 200, body: { enabled: this.assets instanceof InMemoryAssetStore ? false : true } };
    if (method === 'PUT' && path === '/storage/config') return { status: 200, body: { enabled: this.assets instanceof InMemoryAssetStore ? false : true } };
    if (method === 'POST' && path === '/storage/config/test') return { status: 200, body: { ok: true, message: 'Canvas storage ok.' } };

    if (method === 'GET' && path === '/project') return { status: 200, body: this.publicProject() };
    if (method === 'PUT' && path === '/project') {
      // 只把**确实提交了**的字段放进 patch。
      // 原来写的是 { name: body?.name, snapshot: 有就取没有就 undefined }——
      // 对象展开会把值为 undefined 的键一起覆盖过去，于是 PUT {name:'x'} 会把
      // 已有的 snapshot 抹成 undefined，只改个名字就把整个画布内容清空了。
      const patch: { name?: string; snapshot?: unknown } = {};
      const raw = (body || {}) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(raw, 'name')) patch.name = String(raw.name ?? '');
      if (Object.prototype.hasOwnProperty.call(raw, 'snapshot')) {
        const oversized = snapshotTooLarge(raw.snapshot);
        if (oversized) {
          return { status: 413, body: { error: { code: 'snapshot_too_large', message: oversized } } };
        }
        patch.snapshot = raw.snapshot;
      }
      this.store.setProject(patch);
      return { status: 200, body: this.publicProject() };
    }

    if (method === 'POST' && path === '/bot/gallery') {
      if (!this.isAuthorized(req.headers)) return { status: 401, body: { error: { code: 'unauthorized', message: 'Unauthorized' } } };
      try {
        const record = this.addBotGalleryRecord(body || {});
        return { status: 200, body: { ok: true, record: this.publicRecord(record) } };
      } catch (error) {
        return { status: 400, body: { error: { code: 'bot_gallery_import_failed', message: errMsg(error) } } };
      }
    }

    if (method === 'GET' && path === '/gallery') {
      const items = filterGallery(this.store.gallery(), query).map(this.publicGalleryItem);
      return { status: 200, body: { items, total: this.store.gallery().length } };
    }
    if (method === 'GET' && path === '/interrogations') {
      const items = filterInterrogations(this.store.interrogations(), query).map(this.publicInterrogationItem);
      return { status: 200, body: { items, total: this.store.interrogations().length } };
    }

    const galFav = path.match(/^\/gallery\/(.+)\/favorite$/);
    if (method === 'PATCH' && galFav) {
      const ok = this.store.setGalleryFavorite(decodeURIComponent(galFav[1]), Boolean(body?.favorite));
      return ok ? { status: 200, body: { ok: true, favorite: Boolean(body?.favorite) } } : notFound('Gallery image record not found');
    }
    const galDel = path.match(/^\/gallery\/(.+)$/);
    if (method === 'DELETE' && galDel) {
      const id = decodeURIComponent(galDel[1]);
      const ok = this.store.deleteGalleryItem(id);
      if (ok) this.assets.delete(id.replace(/^out_/, '')); // gallery item.id = out_<assetId>；asset key 为 <assetId>
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

    const imageJobMatch = path.match(/^\/images\/jobs\/([^/]+)$/);
    if (method === 'GET' && imageJobMatch) {
      const job = this.publicJob(this.imageJobs.get(decodeURIComponent(imageJobMatch[1])));
      return job ? { status: 200, body: { job } } : notFound('Image job not found');
    }
    const intJobMatch = path.match(/^\/interrogate\/jobs\/([^/]+)$/);
    if (method === 'GET' && intJobMatch) {
      const job = this.publicJob(this.interrogationJobs.get(decodeURIComponent(intJobMatch[1])));
      return job ? { status: 200, body: { job } } : notFound('Interrogation job not found');
    }

    if (method === 'POST' && (path === '/images/generate' || path === '/images/edit')) {
      const mode = path.endsWith('/edit') ? 'edit' : 'generate';
      if (query.async === '1' || query.async === 'true') {
        const job = this.createImageJob(mode, body || {});
        return { status: 202, body: { job } };
      }
      try {
        const record = await this.runGeneration(mode, body || {});
        return { status: 200, body: { record: this.publicRecord(record) } };
      } catch (error) {
        return { status: 502, body: { error: { code: 'generation_failed', message: errMsg(error) } } };
      }
    }
    if (method === 'POST' && path === '/interrogate') {
      if (query.async === '1' || query.async === 'true') {
        const job = this.createInterrogationJob((body || {}).image);
        return { status: 202, body: { job } };
      }
      try {
        const item = await this.runInterrogation((body || {}).image);
        return { status: 200, body: { item: this.publicInterrogationItem(item) } };
      } catch (error) {
        return { status: 502, body: { error: { code: 'interrogate_failed', message: errMsg(error) } } };
      }
    }

    const assetMatch = path.match(/^\/assets\/([^/]+)\/(download|preview)$/);
    if (method === 'GET' && assetMatch) {
      const id = decodeURIComponent(assetMatch[1]);
      const mode = assetMatch[2];
      const asset = this.assets.get(id);
      if (!asset) return notFound('Asset not found');
      // preview 暂等同 download(未做缩略图，与 monolith 无 sharp 时回退一致)。
      void mode;
      return { status: 200, body: null, binary: { contentType: asset.contentType, base64: asset.base64 } };
    }

    return notFound('Canvas API route not found');
  }

  private async runGeneration(mode: 'generate' | 'edit', body: Record<string, any>): Promise<GenerationRecord> {
    const canvas = this.getConfig().canvas;
    const isEdit = mode === 'edit';
    const rawPrompt = String(body.prompt || '').trim();
    if (!rawPrompt) throw new Error('请输入提示词。');
    const model = isEdit ? (canvas.editModel || canvas.imageModel) : canvas.imageModel;
    if (!model) throw new Error(`画布${isEdit ? '改图' : '生图'}没有配置模型。请在后台「画布配置」选择模型。`);
    const nodeIndex = isEdit ? canvas.editNodeIndex : canvas.imageNodeIndex;
    // body.size 可能是 {width,height} 对象（web-canvas 前端）或 "WxH"/"auto" 字符串（bot/旧客户端）。
    // 统一归一化为 sizeApi 字符串，避免 String(对象) 变成 "[object Object]" 导致 resolveSize 回退默认 1024x1024。
    const sizeApi = normalizeSizeInput(body.size);
    const size = resolveSize(sizeApi);
    const outputFormat = normalizeOutputFormat(body.outputFormat, canvas.defaultOutputFormat || 'png');
    const quality = normalizeQuality(body.quality || canvas.defaultQuality);
    const count = Math.max(1, Math.min(16, Math.trunc(Number(body.count || canvas.defaultCount || 1) || 1)));

    let images: GenerationArtifact[];
    if (isEdit) {
      const refs = (Array.isArray(body.referenceImages) ? body.referenceImages : body.referenceImage ? [body.referenceImage] : [])
        .map((r: any) => String(r?.dataUrl || r?.url || r || '').trim()).filter(Boolean);
      if (!refs.length) throw new Error('改图缺少参考图。');
      ({ images } = await this.generator.edit({ nodeIndex, model, prompt: rawPrompt, images: refs, size: sizeApi, quality }));
    } else {
      ({ images } = await this.generator.generate({ nodeIndex, model, prompt: rawPrompt, size: sizeApi, count, quality }));
    }
    if (!Array.isArray(images) || images.length === 0) throw new Error('上游没有返回图片数据。');

    const createdAt = this.now().toISOString();
    const id = `gen_${this.idFactory()}`;
    const outputs = images.map((artifact, index) => this.storeOutput(artifact, `${id}_${index + 1}`, createdAt, size, outputFormat));
    const firstAsset = outputs.find((o) => o.asset)?.asset;
    // meta 卡片显示的尺寸必须与图片实际尺寸一致：始终优先用 firstAsset 解码出的真实尺寸，
    // 仅在解码失败(外链/无法解析)时回退到请求尺寸。原逻辑仅在 size=auto 时取实际尺寸，
    // 导致选具体尺寸(如1024x1024)但模型返回不同尺寸时 meta 显示与图片不符。
    const recordSize = firstAsset?.width
      ? { width: firstAsset.width, height: firstAsset.height || 0 }
      : size;
    const effectivePrompt = images.find((a) => a.revisedPrompt)?.revisedPrompt || rawPrompt;

    const record: GenerationRecord = {
      id, mode, prompt: rawPrompt, effectivePrompt,
      presetId: String(body.presetId || 'none'),
      size: recordSize, quality: body.quality || canvas.defaultQuality || 'auto',
      outputFormat, count: outputs.length, status: 'succeeded',
      referenceAssetIds: [], createdAt, outputs,
    };
    this.store.addRecord(record);
    return record;
  }

  private async runInterrogation(image: any): Promise<InterrogationItem> {
    const dataUrl = String(image?.dataUrl || image?.url || image || '').trim();
    if (!dataUrl) throw new Error('缺少上传图片数据。');
    const canvas = this.getConfig().canvas;
    const nodeIndex = canvas.interrogateNodeIndex;
    const model = canvas.interrogateModel || 'gpt-4o-mini';
    const { text: firstText } = await this.generator.interrogate({ nodeIndex, model, image: dataUrl, prompt: canvas.interrogatePromptTemplate });

    // 第二步：套 {{prompt}} 模板。generator 未实现 interrogateTemplate 时回退用第一步文本做模板。
    let templatePrompt = firstText;
    if (typeof this.generator.interrogateTemplate === 'function') {
      const tplNodeIndex = canvas.interrogateTemplateNodeIndex ?? nodeIndex;
      const tplModel = canvas.interrogateTemplateModel || model;
      const tplPromptTemplate = canvas.interrogateTemplatePromptTemplate || `请把下面的图像描述改写为包含 {{prompt}} 占位符的图像生成模板：\n${firstText}`;
      try {
        const { text } = await this.generator.interrogateTemplate({ nodeIndex: tplNodeIndex, model: tplModel, image: dataUrl, prompt: tplPromptTemplate });
        templatePrompt = text || firstText;
      } catch { /* 第二步失败不阻塞，回退第一步文本 */ }
    }

    const createdAt = this.now().toISOString();
    const id = `int_${this.idFactory()}`;
    const asset = this.assetFromImage(dataUrl, id, image?.fileName, 'png');
    const item: InterrogationItem = {
      id, prompt: String(firstText || '').trim(), templatePrompt: String(templatePrompt || firstText || '').trim(),
      fileName: image?.fileName, createdAt, favorite: false, asset,
    };
    this.store.addInterrogation(item);
    return item;
  }

  /** bot 入库：把 bot 生成结果导入画廊(对齐 monolith addBotGalleryRecord)。 */
  private addBotGalleryRecord(input: Record<string, any>): GenerationRecord {
    const artifacts = normalizeBotArtifacts(input);
    if (!artifacts.length) throw new Error('Bot image result is empty');
    const outputFormat = normalizeOutputFormat(input.outputFormat, 'png');
    const mode = input.mode === 'edit' ? 'edit' : 'generate';
    const createdAt = this.now().toISOString();
    const id = `bot_${this.idFactory()}`;
    const prompt = String(input.prompt || input.rawPrompt || '').trim() || '[Bot image]';
    const effectivePrompt = String(input.effectivePrompt || input.prompt || input.rawPrompt || '').trim() || prompt;
    const requestedSize = resolveSize(normalizeSizeInput(input.sizeApiValue) || normalizeSizeInput(input.size)) || { width: 1024, height: 1024 };

    const outputs: GenerationOutput[] = artifacts.map((artifact, index) => {
      const assetId = `${id}_${index + 1}`;
      const asset = this.assetFromImage(artifact.kind === 'url' ? artifact.data : this.toDataUrl(artifact, outputFormat), assetId, undefined, outputFormat);
      return { id: `out_${assetId}`, status: 'succeeded', favorite: false, asset };
    });
    // 同步生成路径：优先用首张实际解码尺寸，回退请求尺寸。
    const firstAsset = outputs.find((o) => o.asset)?.asset;
    const recordSize = firstAsset?.width
      ? { width: firstAsset.width, height: firstAsset.height || 0 }
      : requestedSize;
    const record: GenerationRecord = {
      id, mode, prompt, effectivePrompt, presetId: 'bot', size: recordSize,
      quality: input.quality, outputFormat, count: outputs.length, status: 'succeeded',
      referenceAssetIds: [], createdAt, outputs, source: 'bot',
      botContext: input.context && typeof input.context === 'object'
        ? { chatType: String(input.context.chatType || ''), groupId: String(input.context.groupId || ''), userId: String(input.context.userId || '') }
        : undefined,
    };
    this.store.addRecord(record);
    return record;
  }

  /** artifact → 资产：base64/dataUrl 转存为可下载资产，外链原样保留(对齐 monolith assetFromArtifact)。 */
  private storeOutput(artifact: GenerationArtifact, assetId: string, createdAt: string, size: { width: number; height: number }, outputFormat: string): GenerationOutput {
    const asset = this.assetFromImage(artifact.kind === 'url' ? artifact.data : this.toDataUrl(artifact, outputFormat), assetId, undefined, outputFormat, size);
    return { id: `out_${assetId}`, status: 'succeeded', favorite: false, asset };
  }

  private toDataUrl(artifact: GenerationArtifact, outputFormat: string): string {
    if (artifact.kind === 'url') return artifact.data;
    const mime = artifact.mimeType || mimeFromOutputFormat(outputFormat);
    return `data:${mime};base64,${artifact.data}`;
  }

  /** data URL/外链 → CanvasAsset。data URL 转存进 AssetStore 并改写为下载链接；外链原样。 */
  private assetFromImage(dataUrlOrUrl: string, assetId: string, fileName: string | undefined, outputFormat: string, fallbackSize?: { width: number; height: number }): CanvasAsset {
    const raw = String(dataUrlOrUrl || '').trim();
    const parsed = parseDataUrl(raw);
    if (parsed) {
      this.assets.put(assetId, { contentType: parsed.contentType, base64: parsed.base64, createdAt: this.now().toISOString() });
      const ext = extensionFor(parsed.contentType);
      const dims = readImageDimensions(Buffer.from(parsed.base64, 'base64'));
      return {
        id: assetId,
        url: `/canvas-api/assets/${encodeURIComponent(assetId)}/download`,
        fileName: fileName || `${assetId}.${ext}`,
        mimeType: parsed.contentType,
        width: dims?.width || fallbackSize?.width,
        height: dims?.height || fallbackSize?.height,
      };
    }
    // 外链或 base64:// 前缀：原样保留 url。
    const data = raw.startsWith('base64://') ? raw.slice('base64://'.length) : raw;
    const mime = imageMimeFromDataUrl(raw) || mimeFromOutputFormat(outputFormat);
    return { id: assetId, url: data, fileName: fileName || `${assetId}.${extensionFor(mime)}`, mimeType: mime };
  }

  // —— 异步任务系统(对齐 monolith startBackgroundJob/createImageJob/createInterrogationJob) ——
  private createImageJob(mode: 'generate' | 'edit', body: Record<string, any>): CanvasJob {
    const now = this.now().toISOString();
    const job: CanvasJob = { kind: 'image', id: `img_job_${this.idFactory()}`, mode, status: 'queued', progress: 5, createdAt: now, updatedAt: now };
    return this.startJob(this.imageJobs, job, () => this.runGeneration(mode, body), 'record');
  }
  private createInterrogationJob(image: any): CanvasJob {
    const now = this.now().toISOString();
    const job: CanvasJob = { kind: 'interrogation', id: `int_job_${this.idFactory()}`, status: 'queued', progress: 5, createdAt: now, updatedAt: now };
    return this.startJob(this.interrogationJobs, job, () => this.runInterrogation(image), 'item');
  }
  private startJob(map: Map<string, CanvasJob>, job: CanvasJob, runner: () => Promise<GenerationRecord | InterrogationItem>, resultKey: 'record' | 'item'): CanvasJob {
    map.set(job.id, job);
    job.queue = { running: 0, queued: 0, limit: 1, position: 1 };
    queueMicrotask(() => {
      void (async () => {
        try {
          job.status = 'running'; job.progress = 12; job.updatedAt = this.now().toISOString(); job.queue = { running: 1, queued: 0, limit: 1, position: 0 };
          const result = await runner();
          (job as any)[resultKey] = result;
          job.status = 'succeeded'; job.progress = 100; job.updatedAt = this.now().toISOString();
        } catch (error) {
          job.status = 'failed'; job.progress = 100; job.error = errMsg(error); job.updatedAt = this.now().toISOString();
        } finally {
          setTimeout(() => map.delete(job.id), JOB_TTL_MS).unref?.();
        }
      })();
    });
    return this.publicJob(job)!;
  }

  // —— 对外形状投影(对齐 monolith public* 系列) ——
  private publicJob(job: CanvasJob | undefined): CanvasJob | undefined {
    if (!job) return undefined;
    const out: CanvasJob = { ...job };
    if (out.record) out.record = this.publicRecord(out.record);
    if (out.item) out.item = this.publicInterrogationItem(out.item);
    return out;
  }
  private publicRecord(record: GenerationRecord): GenerationRecord {
    return { ...record, outputs: record.outputs.map((o) => ({ ...o, asset: this.publicAsset(o.asset) })) };
  }
  /**
   * 画廊条目对外的形状。
   *
   * 前台（web-canvas）按 shared 里的 GalleryImageItem 写死了 **outputId**：
   * 去重、pending 判定、收藏/删除的 URL 全读它。而这边内部主键叫 id
   * （state.ts 建条目时用的是 output.id），于是前台拿到的每条都是 outputId=undefined：
   *   · 去重时 seen.add(undefined)，第一条之后全被跳过 → 作品库永远只显示 1 张
   *   · 筛选/搜索触发再次合并时 item.outputId.startsWith(...) 抛 TypeError，
   *     而这个异常出在 React setState 内部、前台又没有 ErrorBoundary → 整页白屏
   *   · 收藏/删除的 URL 变成 /gallery/undefined/... → 404
   * 这里补一个同值别名，id 保留不动（admin 侧读的是 store 内部结构，不经过这个投影）。
   */
  private publicGalleryItem = (item: GalleryItem): GalleryItem & { outputId: string } => ({
    ...item,
    outputId: item.id,
    asset: this.publicAsset(item.asset),
  });
  private publicInterrogationItem = (item: InterrogationItem): InterrogationItem => ({ ...item, asset: this.publicAsset(item.asset) });
  /** publicAsset：data URL/存储资产改写为下载链接，剥离内部存储字段(对齐 monolith)。 */
  private publicAsset(asset: CanvasAsset): CanvasAsset {
    if (!asset || typeof asset !== 'object') return asset;
    const out = { ...asset };
    if (out.id && (String(out.url || '').startsWith('data:image/') || this.assets.get(out.id))) {
      out.url = `/canvas-api/assets/${encodeURIComponent(out.id)}/download`;
    }
    return out;
  }

  private publicProject() {
    const project = this.store.project();
    return {
      ...project,
      history: project.history.map((r) => this.publicRecord(r)),
      interrogations: this.store.interrogations().map(this.publicInterrogationItem),
    };
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
}

export function createCanvasService(options: CanvasServiceOptions): CanvasService {
  return new CanvasService(options);
}

// —— 工具函数(对齐 monolith：路径拆分/过滤/尺寸/格式/错误/id) ——

function splitPath(rawPath: string): { path: string; query: Record<string, string> } {
  const noQuery = String(rawPath || '/').split('?')[0];
  const stripped = (noQuery.replace(/^\/canvas-api/, '') || '/');
  const path = stripped.length > 1 && stripped.endsWith('/') ? stripped.slice(0, -1) : stripped;
  const search = String(rawPath || '').split('?')[1] || '';
  const params = new URLSearchParams(search);
  const query: Record<string, string> = {};
  for (const key of ['async', 'limit', 'favorite', 'query', 'status', 'recover']) {
    const v = params.get(key);
    if (v !== null) query[key] = v;
  }
  return { path, query };
}

function collectionQuery(query: Record<string, string>) {
  return {
    query: String(query.query || '').trim().toLowerCase(),
    favorite: ['1', 'true'].includes(String(query.favorite || '').toLowerCase()),
    status: ['done', 'failed'].includes(query.status || '') ? query.status : 'all',
    limit: Math.max(1, Math.min(240, Number.parseInt(query.limit || '120', 10) || 120)),
  };
}

function filterGallery(items: GalleryItem[], query: Record<string, string>): GalleryItem[] {
  const q = collectionQuery(query);
  if (q.status === 'failed') return [];
  return items
    .filter((item) => !q.favorite || item.favorite)
    .filter((item) => !q.query || `${item.prompt} ${item.effectivePrompt} ${item.presetId} ${item.outputFormat}`.toLowerCase().includes(q.query))
    .slice(0, q.limit);
}

function filterInterrogations(items: InterrogationItem[], query: Record<string, string>): InterrogationItem[] {
  const q = collectionQuery(query);
  if (q.status === 'failed') return [];
  return items
    .filter((item) => !q.favorite || item.favorite)
    .filter((item) => !q.query || `${item.prompt} ${item.templatePrompt} ${item.fileName || ''}`.toLowerCase().includes(q.query))
    .slice(0, q.limit);
}

function resolveSize(sizeApi?: string): { width: number; height: number } {
  if (!sizeApi || sizeApi === 'auto') return { width: 1024, height: 1024 };
  const m = String(sizeApi).match(/^(\d+)x(\d+)$/);
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return { width: 1024, height: 1024 };
}

/**
 * 归一化 size 输入为 sizeApi 字符串。
 * 接受 {width,height} 对象（web-canvas 前端发送）、"WxH" 字符串、"auto" 或 undefined。
 * 修复：原 String(body.size) 对对象返回 "[object Object]"，导致 resolveSize 误回退 1024x1024，
 * 且传给上游模型的 size 也是错误字符串。
 */
function normalizeSizeInput(size: unknown): string | undefined {
  if (size == null) return undefined;
  if (typeof size === 'string') return size;
  if (typeof size === 'object' && size !== null) {
    const obj = size as { width?: unknown; height?: unknown };
    const w = Number(obj.width);
    const h = Number(obj.height);
    if (w > 0 && h > 0) return `${w}x${h}`;
  }
  return undefined;
}

function normalizeOutputFormat(value: unknown, fallback = 'png'): string {
  const format = String(value || fallback || 'png').toLowerCase();
  return ['png', 'jpeg', 'webp'].includes(format) ? format : 'png';
}

function normalizeQuality(value: unknown): string | undefined {
  const quality = String(value || '').toLowerCase();
  return ['low', 'medium', 'high'].includes(quality) ? quality : undefined;
}

function mimeFromOutputFormat(format: string): string {
  const normalized = String(format || '').toLowerCase();
  if (normalized === 'jpeg' || normalized === 'jpg') return 'image/jpeg';
  if (normalized === 'webp') return 'image/webp';
  return 'image/png';
}

function imageMimeFromDataUrl(dataUrl: string): string {
  const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
  return match?.[1] || 'image/png';
}

function normalizeBotArtifacts(input: Record<string, any>): GenerationArtifact[] {
  const source = Array.isArray(input.artifacts) ? input.artifacts : Array.isArray(input.images) ? input.images : [];
  return source
    .map((item: any) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) return undefined;
        if (text.startsWith('base64://')) return { kind: 'base64', data: text.slice('base64://'.length), mimeType: 'image/png' };
        if (/^data:image\//i.test(text)) return { kind: 'url', data: text };
        return { kind: 'url', data: text };
      }
      if (!item || typeof item !== 'object') return undefined;
      const data = String(item.data || item.url || '').trim();
      if (!data) return undefined;
      if (/^data:image\//i.test(data)) return { kind: 'url', data, mimeType: item.mimeType };
      if (item.kind === 'url') return { kind: 'url', data, mimeType: item.mimeType };
      return { kind: 'base64', data: data.startsWith('base64://') ? data.slice('base64://'.length) : data, mimeType: item.mimeType };
    })
    .filter(Boolean) as GenerationArtifact[];
}

function notFound(message: string): CanvasResponse {
  return { status: 404, body: { error: { code: 'not_found', message } } };
}

function errMsg(error: unknown): string {
  return (error as any)?.normalized?.message || (error instanceof Error ? error.message : String(error));
}

function defaultIdFactory(): () => string {
  let counter = 0;
  return () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export { MAX_GALLERY, MAX_HISTORY, MAX_INTERROGATIONS };
