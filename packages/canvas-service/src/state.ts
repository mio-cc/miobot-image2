import { CanvasStateStore } from '../../storage/src/index.js';

export interface CanvasOutput { id: string; url: string }
export interface GenerationRecord {
  id: string;
  mode: 'generate' | 'edit';
  prompt: string;
  model: string;
  size?: string;
  quality?: string;
  createdAt: string;
  outputs: CanvasOutput[];
}
export interface GalleryItem {
  id: string;          // = output id
  recordId: string;
  prompt: string;
  model: string;
  favorite: boolean;
  createdAt: string;
  asset: { url: string };
}
export interface InterrogationItem {
  id: string;
  text: string;
  sourceImage?: string;
  favorite: boolean;
  createdAt: string;
}
export interface ProjectState {
  name: string;
  snapshot: unknown;
  history: GenerationRecord[];
  updatedAt: string;
}
export interface CanvasData {
  project: ProjectState;
  gallery: GalleryItem[];
  interrogations: InterrogationItem[];
}

export function defaultCanvasData(): CanvasData {
  return {
    project: { name: 'Untitled', snapshot: null, history: [], updatedAt: new Date(0).toISOString() },
    gallery: [],
    interrogations: [],
  };
}

/**
 * 画布状态唯一权威实现：project / gallery / interrogations 集中在一处(取代脚本与 web-canvas 两份纠缠)。
 * 由 storage.CanvasStateStore 防抖落盘。
 */
export class CanvasStore {
  private readonly store: CanvasStateStore<CanvasData>;
  private readonly maxHistory: number;

  constructor(options: { filePath?: string; maxHistory?: number; debounceMs?: number } = {}) {
    this.maxHistory = Math.max(1, Math.trunc(options.maxHistory ?? 200));
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

  addRecord(record: GenerationRecord): void {
    this.store.update((d) => {
      d.project.history.unshift(record);
      if (d.project.history.length > this.maxHistory) d.project.history.length = this.maxHistory;
      d.project.updatedAt = new Date().toISOString();
      for (const output of record.outputs) {
        d.gallery.unshift({ id: output.id, recordId: record.id, prompt: record.prompt, model: record.model, favorite: false, createdAt: record.createdAt, asset: { url: output.url } });
      }
      if (d.gallery.length > this.maxHistory) d.gallery.length = this.maxHistory;
    });
  }

  addInterrogation(item: InterrogationItem): void {
    this.store.update((d) => {
      d.interrogations.unshift(item);
      if (d.interrogations.length > this.maxHistory) d.interrogations.length = this.maxHistory;
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
    });
    return removed;
  }

  flush(): void { this.store.flush(); }
}
