import { CanvasStateStore } from '../../storage/src/index.js';

/**
 * 画布状态 schema —— 严格对齐 local-verify-server 的富契约(web-canvas 前端据此构建，不可变)。
 * 字段命名/形状与 monolith 的 gallery / interrogations / project.history 完全一致，
 * 保证 canvas-service 切流后前端无需改动。
 */

/** 画布资产：内部以 {contentType,base64} 存；对外按 monolith publicAsset 暴露 {id,url,fileName,mimeType,width,height}。 */
export interface CanvasAsset {
  id: string;
  /** 下载/预览链接(/canvas-api/assets/:id/download) 或外链原样。 */
  url: string;
  fileName?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

/** 单条生成输出(monolith outputs[]：id=out_<assetId>, status, favorite, asset)。 */
export interface GenerationOutput {
  id: string;
  status: 'succeeded' | 'failed';
  favorite: boolean;
  asset: CanvasAsset;
}

/** 生成记录(monolith record：含 effectivePrompt/presetId/size{w,h}/outputFormat/count/status/outputs)。 */
export interface GenerationRecord {
  id: string;
  mode: 'generate' | 'edit';
  prompt: string;
  effectivePrompt: string;
  presetId: string;
  size: { width: number; height: number };
  quality?: string;
  outputFormat: string;
  count: number;
  status: 'succeeded' | 'failed';
  referenceAssetIds: string[];
  createdAt: string;
  outputs: GenerationOutput[];
  /** bot 入库记录额外携带的来源/上下文(原生 runCanvasGeneration 不写)。 */
  source?: string;
  botContext?: { chatType?: string; groupId?: string; userId?: string };
}

/** 画廊条目(monolith galleryItemsForRecord：outputId 作为 id, 平铺 record 字段 + asset)。 */
export interface GalleryItem {
  id: string;            // = output.id (= out_<assetId>)
  generationId: string;
  mode: 'generate' | 'edit';
  prompt: string;
  effectivePrompt: string;
  presetId: string;
  size: { width: number; height: number };
  quality?: string;
  outputFormat: string;
  status: 'succeeded' | 'failed';
  favorite: boolean;
  createdAt: string;
  asset: CanvasAsset;
}

/** 反推条目(monolith interrogations：prompt + templatePrompt + fileName + asset)。 */
export interface InterrogationItem {
  id: string;
  /** 第一步反推得到的图像描述。 */
  prompt: string;
  /** 第二步模板化后的可复用模板(含 {{prompt}} 占位符)。 */
  templatePrompt: string;
  fileName?: string;
  createdAt: string;
  favorite: boolean;
  asset: CanvasAsset;
}

export interface ProjectState {
  name: string;
  snapshot: unknown;
  history: GenerationRecord[];
  /** monolith project 上也挂了 interrogations 引用(对外 publicProjectState 展开)。 */
  interrogations: InterrogationItem[];
  updatedAt: string;
}

export interface CanvasData {
  project: ProjectState;
  gallery: GalleryItem[];
  interrogations: InterrogationItem[];
}

export function defaultCanvasData(): CanvasData {
  return {
    project: { name: 'Untitled', snapshot: null, history: [], interrogations: [], updatedAt: new Date(0).toISOString() },
    gallery: [],
    interrogations: [],
  };
}

/**
 * 画布状态唯一权威实现：project / gallery / interrogations 集中在一处(取代脚本与 web-canvas 两份纠缠)。
 * 由 storage.CanvasStateStore 防抖落盘。schema 对齐 monolith 富契约。
 */
export class CanvasStore {
  private readonly store: CanvasStateStore<CanvasData>;
  private readonly maxHistory: number;
  private readonly maxGallery: number;

  constructor(options: { filePath?: string; maxHistory?: number; maxGallery?: number; debounceMs?: number } = {}) {
    this.maxHistory = Math.max(1, Math.trunc(options.maxHistory ?? 200));
    this.maxGallery = Math.max(1, Math.trunc(options.maxGallery ?? 500));
    this.store = new CanvasStateStore<CanvasData>(options.filePath || ':memory:', {
      defaultValue: defaultCanvasData(),
      debounceMs: options.debounceMs ?? 200,
      // 无文件路径时用内存 store(测试/无落盘)。
      store: options.filePath ? undefined : { exists: () => false, load: () => defaultCanvasData(), save: () => {} },
    });
  }

  data(): CanvasData { return this.store.get(); }
  project(): ProjectState { return this.store.get().project; }
  gallery(): GalleryItem[] { return this.store.get().gallery; }
  interrogations(): InterrogationItem[] { return this.store.get().interrogations; }

  setProject(patch: Partial<Pick<ProjectState, 'name' | 'snapshot'>>): ProjectState {
    this.store.update((d) => {
      d.project = { ...d.project, ...patch, updatedAt: new Date().toISOString() };
    });
    return this.project();
  }

  /** 落库一条生成记录：写 history 头部 + 把 outputs 平铺进 gallery 头部(对齐 galleryItemsForRecord)。 */
  addRecord(record: GenerationRecord): void {
    this.store.update((d) => {
      d.project.history = [record, ...d.project.history].slice(0, this.maxHistory);
      d.project.updatedAt = record.createdAt;
      const items: GalleryItem[] = record.outputs
        .filter((o) => o.status === 'succeeded' && o.asset)
        .map((o) => ({
          id: o.id,
          generationId: record.id,
          mode: record.mode,
          prompt: record.prompt,
          effectivePrompt: record.effectivePrompt,
          presetId: record.presetId,
          size: record.size,
          quality: record.quality,
          outputFormat: record.outputFormat,
          status: o.status,
          favorite: false,
          createdAt: record.createdAt,
          asset: o.asset,
        }));
      d.gallery = items.concat(d.gallery).slice(0, this.maxGallery);
    });
  }

  addInterrogation(item: InterrogationItem): void {
    this.store.update((d) => {
      d.interrogations = [item, ...d.interrogations].slice(0, this.maxHistory);
      d.project.interrogations = d.interrogations;
      d.project.updatedAt = item.createdAt;
    });
  }

  setGalleryFavorite(id: string, favorite: boolean): boolean {
    let found = false;
    this.store.update((d) => {
      const item = d.gallery.find((g) => g.id === id);
      if (item) { item.favorite = favorite; found = true; }
    });
    return found;
  }

  deleteGalleryItem(id: string): boolean {
    let removed = false;
    this.store.update((d) => {
      const before = d.gallery.length;
      d.gallery = d.gallery.filter((g) => g.id !== id);
      removed = d.gallery.length !== before;
    });
    return removed;
  }

  setInterrogationFavorite(id: string, favorite: boolean): boolean {
    let found = false;
    this.store.update((d) => {
      const item = d.interrogations.find((i) => i.id === id);
      if (item) { item.favorite = favorite; found = true; }
    });
    return found;
  }

  deleteInterrogationItem(id: string): boolean {
    let removed = false;
    this.store.update((d) => {
      const before = d.interrogations.length;
      d.interrogations = d.interrogations.filter((i) => i.id !== id);
      removed = d.interrogations.length !== before;
      d.project.interrogations = d.interrogations;
    });
    return removed;
  }

  flush(): void { this.store.flush(); }
}
