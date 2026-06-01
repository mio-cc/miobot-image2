import {
  AlertTriangle,
  ArrowRight,
  Brush,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eraser,
  FileImage,
  ImageIcon,
  ImagePlus,
  Loader2,
  Maximize2,
  Paperclip,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  UploadCloud,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type PointerEvent } from "react";
import {
  AUTO_SIZE_PRESET_ID,
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  OUTPUT_FORMATS,
  SIZE_PRESETS,
  type GalleryImageItem,
  type GalleryResponse,
  type GenerationCount,
  type GenerationRecord,
  type GenerationResponse,
  type ImageQuality,
  type ImageSize,
  type InterrogateImageResult,
  type InterrogationItem,
  type InterrogationResponse,
  type OutputFormat,
  type ReferenceImageInput,
  type SizePreset
} from "@gpt-image-canvas/shared";
import { apiPath } from "./api";

type AppTab = "gallery" | "interrogate";
type GenerationMode = "text" | "image" | "edit" | "mask";
type NoticeTone = "info" | "success" | "warning" | "error";
type UploadTarget = "reference";
type LightboxState = { kind: AppTab; index: number };
type ClientCardStatus = "queued" | "running" | "failed";
type GalleryCardItem = GalleryImageItem & {
  clientStatus?: ClientCardStatus;
  progress?: number;
  error?: string;
};
type InterrogationCardItem = InterrogationItem & {
  clientStatus?: ClientCardStatus;
  progress?: number;
  error?: string;
};

interface Notice {
  tone: NoticeTone;
  message: string;
}

interface UploadedImage extends ReferenceImageInput {
  id: string;
  fileName: string;
  width: number;
  height: number;
  previewUrl: string;
}

interface CanvasRuntimeConfig {
  model: string;
  models: string[];
  sizePresets: SizePreset[];
  qualities: ImageQuality[];
  outputFormats: OutputFormat[];
  counts: GenerationCount[];
  defaults: {
    quality: ImageQuality;
    outputFormat: OutputFormat;
    count: GenerationCount;
    sizePresetId: string;
  };
}

interface GenerationRequestSnapshot {
  endpoint: string;
  mode: GenerationMode;
  body: {
    prompt: string;
    presetId: string;
    sizePresetId?: string;
    size: ImageSize;
    quality: ImageQuality;
    outputFormat: OutputFormat;
    count: GenerationCount;
    referenceImages?: ReferenceImageInput[];
    maskImage?: ReferenceImageInput;
  };
}

type GenerationJobStatus = "queued" | "running" | "succeeded" | "failed";

interface GenerationJob {
  id: string;
  mode: "generate" | "edit";
  status: GenerationJobStatus;
  progress?: number;
  createdAt: string;
  updatedAt: string;
  record?: GenerationRecord;
  error?: string;
}

interface GenerationJobResponse {
  job: GenerationJob;
}

interface PrettySelectOption {
  value: string;
  label: string;
}

interface PrettySelectProps {
  value: string;
  options: PrettySelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}

interface InterrogationJob {
  id: string;
  status: GenerationJobStatus;
  progress?: number;
  createdAt: string;
  updatedAt: string;
  item?: InterrogationItem;
  error?: string;
}

interface InterrogationJobResponse {
  job: InterrogationJob;
}

const MAX_REFERENCE_IMAGES = 3;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const GENERATION_JOB_POLL_INTERVAL_MS = 2000;
const GENERATION_JOB_MAX_POLLS = 600;
const MASONRY_PREVIEW_WIDTHS = [256, 512, 1024] as const;
const LIGHTBOX_PREVIEW_WIDTHS = [512, 1024, 2048] as const;
const MASONRY_IMAGE_SIZES = "(max-width: 640px) 46vw, (max-width: 1180px) 30vw, 240px";
const LIGHTBOX_IMAGE_SIZES = "100vw";
const LIGHTBOX_MIN_ZOOM = 0.25;
const LIGHTBOX_MAX_ZOOM = 6;
const COLLECTION_FETCH_LIMIT = 120;
type ReferenceStatusFilter = "all" | "done" | "failed";

const fallbackRuntimeConfig: CanvasRuntimeConfig = {
  model: "gpt-image-2",
  models: ["gpt-image-2"],
  sizePresets: SIZE_PRESETS,
  qualities: IMAGE_QUALITIES,
  outputFormats: OUTPUT_FORMATS,
  counts: [...GENERATION_COUNTS],
  defaults: {
    quality: "auto",
    outputFormat: "png",
    count: 1,
    sizePresetId: "square-1k"
  }
};

function PrettySelect({ value, options, onChange, ariaLabel, className = "", disabled = false }: PrettySelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`pretty-select ${className}`.trim()} data-open={open} ref={rootRef}>
      <button
        type="button"
        className="pretty-select__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedOption?.label ?? value}</span>
        <ChevronDown className="icon pretty-select__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="pretty-select__menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="pretty-select__option"
              role="option"
              aria-selected={option.value === value}
              data-active={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}


const modeOptions: Array<{
  id: GenerationMode;
  label: string;
  short: string;
  description: string;
  icon: typeof WandSparkles;
}> = [
  { id: "text", label: "文生图", short: "文", description: "只用提示词生成图片", icon: WandSparkles },
  { id: "image", label: "图生图", short: "图", description: "参考上传图片重新生成", icon: ImagePlus },
  { id: "edit", label: "编辑图", short: "编", description: "按提示词修改参考图", icon: Brush },
  { id: "mask", label: "遮罩改图", short: "遮", description: "在参考图上涂抹要改的区域", icon: FileImage }
];

export function App() {
  const [runtimeConfig, setRuntimeConfig] = useState<CanvasRuntimeConfig>(fallbackRuntimeConfig);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [highResLoaded, setHighResLoaded] = useState(false);
  const [lightboxRevealReady, setLightboxRevealReady] = useState(false);
  const [lightboxPreviewReady, setLightboxPreviewReady] = useState(false);
  const [lightboxNaturalSize, setLightboxNaturalSize] = useState<ImageSize | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(() => window.location.hash.toLowerCase().includes("interrogate") ? "interrogate" : "gallery");
  const [galleryItems, setGalleryItems] = useState<GalleryCardItem[]>([]);
  const [galleryQuery, setGalleryQuery] = useState("");
  const [interrogateItems, setInterrogateItems] = useState<InterrogationCardItem[]>([]);
  const [interrogateQuery, setInterrogateQuery] = useState("");
  const deferredGalleryQuery = useDeferredValue(galleryQuery);
  const deferredInterrogateQuery = useDeferredValue(interrogateQuery);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ReferenceStatusFilter>("all");
  const [isGenerationOpen, setIsGenerationOpen] = useState(true);
  const [mobileInputCollapsed, setMobileInputCollapsed] = useState(true);
  const [inputHoverExpanded, setInputHoverExpanded] = useState(false);
  const [inputHoverSuppressed, setInputHoverSuppressed] = useState(false);
  const [mobileView, setMobileView] = useState<"gallery" | "generate">("gallery");
  const [isGalleryLoading, setIsGalleryLoading] = useState(true);
  const [isInterrogateLoading, setIsInterrogateLoading] = useState(true);
  const [galleryError, setGalleryError] = useState("");
  const [interrogateError, setInterrogateError] = useState("");
  const [interrogateStatus, setInterrogateStatus] = useState("");
  const [mode, setMode] = useState<GenerationMode>("text");
  const [prompt, setPrompt] = useState("");
  const [sizePresetId, setSizePresetId] = useState(fallbackRuntimeConfig.defaults.sizePresetId);
  const [size, setSize] = useState<ImageSize>(() => sizeForPreset(fallbackRuntimeConfig.sizePresets, fallbackRuntimeConfig.defaults.sizePresetId));
  const [quality, setQuality] = useState<ImageQuality>(fallbackRuntimeConfig.defaults.quality);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(fallbackRuntimeConfig.defaults.outputFormat);
  const [count, setCount] = useState<GenerationCount>(fallbackRuntimeConfig.defaults.count);
  const [referenceImages, setReferenceImages] = useState<UploadedImage[]>([]);
  const [maskImage, setMaskImage] = useState<UploadedImage | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isInterrogating, setIsInterrogating] = useState(false);
  const [interrogateImage, setInterrogateImage] = useState<UploadedImage | null>(null);
  const [latestRecord, setLatestRecord] = useState<GenerationRecord | null>(null);
  const [lastRequest, setLastRequest] = useState<GenerationRequestSnapshot | null>(null);
  const [lightboxState, setLightboxState] = useState<LightboxState | null>(null);
  const [lightboxPan, setLightboxPan] = useState({ x: 0, y: 0 });
  const [dragTarget, setDragTarget] = useState<UploadTarget | "panel" | null>(null);
  const [interrogateDragActive, setInterrogateDragActive] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const lightboxPanStartRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const lightboxPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const lightboxPinchRef = useRef<{ distance: number; centerX: number; centerY: number; startZoom: number; originX: number; originY: number } | null>(null);
  const lightboxUserZoomedRef = useRef(false);
  const scrollMomentumRef = useRef<{ velocity: number; frame: number | null }>({ velocity: 0, frame: null });
  const galleryPaneRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const interrogateInputRef = useRef<HTMLInputElement | null>(null);

  const filteredGalleryItems = useMemo(() => {
    const query = normalizeSearch(deferredGalleryQuery);
    return galleryItems.filter((item) => {
      if (favoritesOnly && !item.favorite) return false;
      if (!matchesStatusFilter(item.status, statusFilter, item.clientStatus)) return false;
      if (!query) return true;
      return normalizeSearch(`${item.prompt} ${item.effectivePrompt} ${item.presetId} ${item.outputFormat}`).includes(query);
    });
  }, [deferredGalleryQuery, favoritesOnly, galleryItems, statusFilter]);

  const filteredInterrogateItems = useMemo(() => {
    const query = normalizeSearch(deferredInterrogateQuery);
    return interrogateItems.filter((item) => {
      if (favoritesOnly && !item.favorite) return false;
      if (statusFilter === "failed") return item.clientStatus === "failed";
      if (!query) return true;
      return normalizeSearch(`${item.prompt} ${item.templatePrompt} ${item.fileName ?? ""}`).includes(query);
    });
  }, [deferredInterrogateQuery, favoritesOnly, interrogateItems, statusFilter]);


  const visibleGalleryItems = useMemo(() => {
    if (galleryItems.length) return filteredGalleryItems;
    return [];
  }, [filteredGalleryItems, galleryItems.length]);

  const visibleInterrogateItems = useMemo(() => {
    if (interrogateItems.length) return filteredInterrogateItems;
    return [];
  }, [filteredInterrogateItems, interrogateItems.length]);

  const selectedLightboxItem = lightboxState?.kind === "gallery" ? visibleGalleryItems[lightboxState.index] ?? null : null;
  const selectedInterrogateLightboxItem = lightboxState?.kind === "interrogate" ? visibleInterrogateItems[lightboxState.index] ?? null : null;
  const lightboxAsset = selectedLightboxItem?.asset ?? selectedInterrogateLightboxItem?.asset ?? null;
  const lightboxAlt = selectedLightboxItem?.prompt ?? selectedInterrogateLightboxItem?.prompt ?? "";
  const activeLightboxCount = lightboxState?.kind === "interrogate" ? visibleInterrogateItems.length : visibleGalleryItems.length;
  const activeLightboxIndex = lightboxState?.index ?? 0;
  const lightboxTransform = `translate3d(${lightboxPan.x}px, ${lightboxPan.y}px, 0) scale(${lightboxZoom})`;
  const canRevealHighResLightbox = highResLoaded && lightboxRevealReady && lightboxPreviewReady;
  const inputHoverAutoExpanded = mobileInputCollapsed && inputHoverExpanded && !inputHoverSuppressed;
  const isInputBarCollapsed = mobileInputCollapsed && !inputHoverAutoExpanded;
  const validationMessage = validateForm({ mode, prompt, size, sizePresetId, referenceImages, maskImage });
  const canGenerate = !isGenerating && !validationMessage;
  const galleryStatusText = isGalleryLoading
    ? "图库同步中"
    : galleryError
      ? "图库暂不可用"
    : filteredGalleryItems.length === galleryItems.length
      ? `${galleryItems.length} 张作品`
      : `${filteredGalleryItems.length}/${galleryItems.length} 张作品`;
  const interrogateStatusText = isInterrogateLoading
    ? "模板库同步中"
    : interrogateError
      ? "模板库暂不可用"
      : filteredInterrogateItems.length === interrogateItems.length
        ? `${interrogateItems.length} 张反推`
        : `${filteredInterrogateItems.length}/${interrogateItems.length} 张反推`;
  const activeSearchValue = galleryQuery || interrogateQuery;
  const statusFilterOptions = useMemo<PrettySelectOption[]>(
    () => [
      { value: "all", label: "全部状态" },
      { value: "done", label: "已完成" },
      { value: "failed", label: "失败" }
    ],
    []
  );
  const sizeOptions = useMemo<PrettySelectOption[]>(
    () => [
      { value: AUTO_SIZE_PRESET_ID, label: "自动" },
      ...runtimeConfig.sizePresets.map((preset) => ({ value: preset.id, label: shortSizeLabel(preset) })),
      { value: "custom", label: "自定" }
    ],
    [runtimeConfig.sizePresets]
  );
  const qualityOptions = useMemo<PrettySelectOption[]>(
    () => runtimeConfig.qualities.map((item) => ({ value: item, label: qualityLabel(item) })),
    [runtimeConfig.qualities]
  );
  const outputFormatOptions = useMemo<PrettySelectOption[]>(
    () => runtimeConfig.outputFormats.map((item) => ({ value: item, label: item.toUpperCase() })),
    [runtimeConfig.outputFormats]
  );
  const countOptions = useMemo<PrettySelectOption[]>(
    () => runtimeConfig.counts.map((item) => ({ value: String(item), label: String(item) })),
    [runtimeConfig.counts]
  );
  const promptCharacterCount = prompt.trim().length;
  const primaryReferenceImage = referenceImages[0] ?? null;

  const refreshGallery = useCallback(async (signal?: AbortSignal) => {
    setIsGalleryLoading(true);
    setGalleryError("");
    try {
      const response = await fetch(apiPath(`/gallery${collectionQueryString({
        query: deferredGalleryQuery,
        favoritesOnly,
        statusFilter
      })}`), { signal });
      if (!response.ok) throw new Error(await readApiError(response, "图库加载失败"));
      const body = (await response.json()) as GalleryResponse;
      setGalleryItems(Array.isArray(body.items) ? body.items : []);
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : "图库加载失败";
      setGalleryError(message);
      setNotice({ tone: "error", message });
    } finally {
      if (!signal?.aborted) setIsGalleryLoading(false);
    }
  }, [deferredGalleryQuery, favoritesOnly, statusFilter]);

  const refreshInterrogations = useCallback(async (signal?: AbortSignal) => {
    setIsInterrogateLoading(true);
    setInterrogateError("");
    try {
      const response = await fetch(apiPath(`/interrogations${collectionQueryString({
        query: deferredInterrogateQuery,
        favoritesOnly,
        statusFilter
      })}`), { signal });
      if (!response.ok) throw new Error(await readApiError(response, "模板库加载失败"));
      const body = (await response.json()) as InterrogationResponse;
      setInterrogateItems(Array.isArray(body.items) ? body.items : []);
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : "模板库加载失败";
      setInterrogateError(message);
      setInterrogateStatus(message);
    } finally {
      if (!signal?.aborted) setIsInterrogateLoading(false);
    }
  }, [deferredInterrogateQuery, favoritesOnly, statusFilter]);

  useEffect(() => {
    let disposed = false;

    async function loadConfig() {
      try {
        const response = await fetch(apiPath("/config"));
        if (!response.ok) throw new Error(await readApiError(response, "画布配置加载失败"));
        const nextConfig = normalizeRuntimeConfig(await response.json());
        if (disposed) return;
        setRuntimeConfig(nextConfig);
        setQuality(nextConfig.defaults.quality);
        setOutputFormat(nextConfig.defaults.outputFormat);
        setCount(nextConfig.defaults.count);
        setSizePresetId(nextConfig.defaults.sizePresetId);
        setSize(sizeForPreset(nextConfig.sizePresets, nextConfig.defaults.sizePresetId));
      } catch (error) {
        if (!disposed) {
          setNotice({ tone: "warning", message: error instanceof Error ? error.message : "画布配置加载失败，已使用本地默认值" });
        }
      }
    }

    void loadConfig();

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshGallery(controller.signal);
    void refreshInterrogations(controller.signal);
    return () => controller.abort();
  }, [refreshGallery, refreshInterrogations]);

  useEffect(() => {
    if (!lightboxState) return;
    const itemCount = lightboxState.kind === "interrogate" ? visibleInterrogateItems.length : visibleGalleryItems.length;
    if (itemCount <= 0) {
      setLightboxState(null);
    } else if (lightboxState.index >= itemCount) {
      setLightboxState({ kind: lightboxState.kind, index: itemCount - 1 });
    }
  }, [visibleGalleryItems.length, visibleInterrogateItems.length, lightboxState]);

  useLayoutEffect(() => {
    lightboxUserZoomedRef.current = false;
    lightboxPointersRef.current.clear();
    lightboxPinchRef.current = null;
    lightboxPanStartRef.current = null;
    setLightboxZoom(lightboxAsset ? defaultLightboxCoverZoom(lightboxAsset) : 1);
    setLightboxPan({ x: 0, y: 0 });
    setHighResLoaded(false);
    setLightboxRevealReady(false);
    setLightboxPreviewReady(false);
    setLightboxNaturalSize(null);
  }, [lightboxState?.index, lightboxState?.kind, lightboxAsset?.id]);

  useEffect(() => {
    if (!lightboxAsset || !lightboxState) return;
    setLightboxRevealReady(false);
    const timer = window.setTimeout(() => {
      setLightboxRevealReady(true);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [lightboxState?.index, lightboxState?.kind, lightboxAsset?.id]);

  useEffect(() => {
    if (!lightboxAsset || !lightboxState) return;
    const handleResize = () => {
      if (lightboxUserZoomedRef.current) return;
      setLightboxZoom(defaultLightboxCoverZoom(lightboxNaturalSize ?? lightboxAsset));
      setLightboxPan({ x: 0, y: 0 });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [lightboxAsset, lightboxNaturalSize, lightboxState]);

  useEffect(() => {
    if (lightboxZoom <= 1) {
      setLightboxPan({ x: 0, y: 0 });
    }
  }, [lightboxZoom]);

  useEffect(() => {
    if (galleryPaneRef.current) galleryPaneRef.current.scrollTop = 0;
    stopScrollMomentum(scrollMomentumRef.current);
  }, [activeTab, deferredGalleryQuery, deferredInterrogateQuery, favoritesOnly, galleryItems.length, interrogateItems.length, statusFilter]);

  useEffect(() => {
    if (!lightboxState) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightboxState(null);
      } else if (event.key === "ArrowLeft") {
        navigateLightbox(-1);
      } else if (event.key === "ArrowRight") {
        navigateLightbox(1);
      }
    };

    const handleWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".lightbox__floating-prompt, .lightbox__floating-prompt-group, .lightbox__zoom-control")) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      const direction = event.deltaY < 0 ? 1 : -1;
      const step = event.ctrlKey || event.metaKey ? 0.2 : 0.1;
      lightboxUserZoomedRef.current = true;
      setLightboxZoom((current) => clamp(Number((current + direction * step).toFixed(2)), LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM));
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("wheel", handleWheel);
    };
  }, [visibleGalleryItems.length, visibleInterrogateItems.length, lightboxState]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setMaskImage(null);
  }, [primaryReferenceImage?.id]);

  useEffect(() => {
    const pane = galleryPaneRef.current;
    if (!pane || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const momentum = scrollMomentumRef.current;

    const step = () => {
      if (!pane.isConnected || Math.abs(momentum.velocity) < 0.35) {
        stopScrollMomentum(momentum);
        return;
      }

      const previousTop = pane.scrollTop;
      pane.scrollTop += momentum.velocity;
      if (pane.scrollTop === previousTop) {
        stopScrollMomentum(momentum);
        return;
      }

      momentum.velocity *= 0.91;
      momentum.frame = window.requestAnimationFrame(step);
    };

    const start = () => {
      if (momentum.frame === null) {
        momentum.frame = window.requestAnimationFrame(step);
      }
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.deltaY || event.ctrlKey) return;
      event.preventDefault();
      momentum.velocity = clamp(momentum.velocity + normalizeWheelDelta(event) * 0.17, -76, 76);
      start();
    };

    const stop = () => stopScrollMomentum(momentum);
    pane.addEventListener("wheel", handleWheel, { passive: false });
    pane.addEventListener("pointerdown", stop);
    pane.addEventListener("click", stop);

    return () => {
      pane.removeEventListener("wheel", handleWheel);
      pane.removeEventListener("pointerdown", stop);
      pane.removeEventListener("click", stop);
      stop();
    };
  }, [activeTab]);

  useEffect(() => {
    const pane = galleryPaneRef.current;
    if (!pane) return;
    const update = () => setShowBackToTop(pane.scrollTop > 520);
    update();
    pane.addEventListener("scroll", update, { passive: true });
    return () => pane.removeEventListener("scroll", update);
  }, [activeTab]);

  function selectMode(nextMode: GenerationMode) {
    setMode(nextMode);
    if (nextMode === "text") {
      setNotice(null);
    } else if (!referenceImages.length) {
      setNotice({ tone: "info", message: "上传一张参考图后就可以生成。" });
    } else if (nextMode === "mask") {
      setNotice({ tone: "info", message: "在参考图上涂抹要改的区域，系统会自动生成遮罩图。" });
    }
  }

  function selectSizePreset(nextPresetId: string) {
    setSizePresetId(nextPresetId);
    if (nextPresetId === AUTO_SIZE_PRESET_ID) {
      return;
    }
    const nextPreset = runtimeConfig.sizePresets.find((preset) => preset.id === nextPresetId);
    if (nextPreset) setSize({ width: nextPreset.width, height: nextPreset.height });
  }

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(event.target.value);
  }

  function updateCustomSize(nextSize: Partial<ImageSize>) {
    setSize((current) => ({ ...current, ...nextSize }));
    setSizePresetId("custom");
  }

  async function addFiles(files: FileList | File[], _target: UploadTarget) {
    const selectedFiles = Array.from(files).filter(Boolean);
    if (!selectedFiles.length) return;

    const invalidFile = selectedFiles.find((file) => !SUPPORTED_UPLOAD_TYPES.has(file.type.toLowerCase()) || file.size > MAX_UPLOAD_BYTES);
    if (invalidFile) {
      setNotice({ tone: "error", message: `${invalidFile.name} 不是可用图片，支持 PNG/JPEG/WebP 且不超过 50MB。` });
      return;
    }

    try {
      const uploaded = await Promise.all(selectedFiles.map(fileToUploadedImage));
      setReferenceImages((current) => [...current, ...uploaded].slice(0, MAX_REFERENCE_IMAGES));
      if (mode === "text") setMode("image");
      setNotice({
        tone: "success",
        message: uploaded.length > MAX_REFERENCE_IMAGES ? `已载入前 ${MAX_REFERENCE_IMAGES} 张参考图。` : "参考图已载入。"
      });
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "图片读取失败" });
    }
  }

  function removeReferenceImage(id: string) {
    setReferenceImages((current) => current.filter((image) => image.id !== id));
  }

  function updateActiveSearch(value: string) {
    setGalleryQuery(value);
    setInterrogateQuery(value);
  }

  async function addInterrogateFiles(files: FileList | File[]) {
    const selectedFile = Array.from(files).filter(Boolean)[0];
    if (!selectedFile) return;
    if (!SUPPORTED_UPLOAD_TYPES.has(selectedFile.type.toLowerCase()) || selectedFile.size > MAX_UPLOAD_BYTES) {
      setInterrogateError(`${selectedFile.name} 不是可用图片，支持 PNG/JPEG/WebP 且不超过 50MB。`);
      return;
    }

    try {
      const uploaded = await fileToUploadedImage(selectedFile);
      setInterrogateImage(uploaded);
      setInterrogateError("");
      setInterrogateStatus("图片已载入。");
      setActiveTab("interrogate");
    } catch (error) {
      setInterrogateError(error instanceof Error ? error.message : "图片读取失败");
    }
  }

  async function submitInterrogation() {
    if (!interrogateImage) {
      setInterrogateError("请先上传一张图片。");
      return;
    }

    const pendingItem = createPendingInterrogationItem(interrogateImage);
    setIsInterrogating(true);
    setInterrogateError("");
    setInterrogateStatus("");
    setActiveTab("interrogate");
    setMobileView("gallery");
    setInterrogateItems((current) => [pendingItem, ...current]);
    try {
      const response = await fetch(apiPath("/interrogate?async=1"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: toReferenceImageInput(interrogateImage) })
      });
      if (!response.ok) throw new Error(await readApiError(response, "反推失败"));
      const data = (await response.json()) as InterrogateImageResult | InterrogationJobResponse;
      const item = isInterrogationJobResponse(data)
        ? await waitForInterrogationJob(data.job.id, (job) => {
          updatePendingInterrogationItem(pendingItem.id, {
            clientStatus: job.status === "queued" ? "queued" : "running",
            progress: clamp(Math.round(job.progress ?? 10), 6, 98)
          });
        })
        : data.item;
      setInterrogateItems((current) => [item, ...current.filter((entry) => entry.id !== item.id && entry.id !== pendingItem.id)]);
      setInterrogateImage(null);
      setInterrogateStatus("已反推并保存到模板库。");
    } catch (error) {
      updatePendingInterrogationItem(pendingItem.id, {
        clientStatus: "failed",
        progress: 100,
        error: error instanceof Error ? error.message : "反推失败"
      });
      scheduleRemovePendingInterrogationItem(pendingItem.id);
      setInterrogateError("");
      setInterrogateStatus("");
    } finally {
      setIsInterrogating(false);
    }
  }

  function buildRequestSnapshot(): GenerationRequestSnapshot {
    const trimmedPrompt = prompt.trim();
    const body: GenerationRequestSnapshot["body"] = {
      prompt: trimmedPrompt,
      presetId: "none",
      sizePresetId,
      size,
      quality,
      outputFormat,
      count
    };

    if (mode !== "text") {
      body.referenceImages = referenceImages.map(toReferenceImageInput);
    }
    if (mode === "mask" && maskImage) {
      body.maskImage = toReferenceImageInput(maskImage);
    }

    return {
      endpoint: mode === "text" ? "/images/generate" : "/images/edit",
      mode,
      body
    };
  }

  function createPendingGalleryItem(snapshot: GenerationRequestSnapshot): GalleryCardItem {
    const id = `pending-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return {
      outputId: id,
      generationId: id,
      mode: snapshot.mode === "text" ? "generate" : "edit",
      prompt: snapshot.body.prompt,
      effectivePrompt: snapshot.body.prompt,
      presetId: snapshot.body.presetId,
      size: snapshot.body.size,
      quality: snapshot.body.quality,
      outputFormat: snapshot.body.outputFormat,
      createdAt: new Date().toISOString(),
      favorite: false,
      clientStatus: "queued",
      progress: 6,
      asset: {
        id,
        url: "",
        fileName: `${id}.${snapshot.body.outputFormat === "jpeg" ? "jpg" : snapshot.body.outputFormat}`,
        mimeType: `image/${snapshot.body.outputFormat === "jpeg" ? "jpeg" : snapshot.body.outputFormat}`,
        width: snapshot.body.size.width,
        height: snapshot.body.size.height
      }
    };
  }

  function createPendingInterrogationItem(image: UploadedImage): InterrogationCardItem {
    const id = `pending-int-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return {
      id,
      prompt: "正在分析图片内容…",
      templatePrompt: "正在生成可复用模板…",
      fileName: image.fileName,
      createdAt: new Date().toISOString(),
      favorite: false,
      clientStatus: "queued",
      progress: 6,
      asset: {
        id,
        url: image.previewUrl,
        fileName: image.fileName,
        mimeType: imageMimeFromDataUrl(image.dataUrl),
        width: image.width,
        height: image.height
      }
    };
  }

  function updatePendingGalleryItem(id: string, patch: Partial<GalleryCardItem>) {
    setGalleryItems((current) => current.map((item) => (item.outputId === id ? { ...item, ...patch } : item)));
  }

  function updatePendingInterrogationItem(id: string, patch: Partial<InterrogationCardItem>) {
    setInterrogateItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function scheduleRemovePendingGalleryItem(id: string) {
    window.setTimeout(() => {
      setGalleryItems((current) => current.filter((item) => item.outputId !== id));
    }, 1000);
  }

  function scheduleRemovePendingInterrogationItem(id: string) {
    window.setTimeout(() => {
      setInterrogateItems((current) => current.filter((item) => item.id !== id));
    }, 1000);
  }

  function mergeRecoveredGalleryItems(recoveredItems: GalleryImageItem[], pendingId: string) {
    if (!recoveredItems.length) return;
    setGalleryItems((current) => [
      ...recoveredItems,
      ...current.filter((item) => item.outputId !== pendingId && !recoveredItems.some((recovered) => recovered.outputId === item.outputId))
    ]);
  }

  async function recoverCompletedGeneration(snapshot: GenerationRequestSnapshot, pendingItem: GalleryCardItem): Promise<boolean> {
    const startedAt = Date.now();
    const timeoutMs = 180_000;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(apiPath(`/gallery?limit=${COLLECTION_FETCH_LIMIT}&recover=${Date.now()}`), { cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as GalleryResponse;
          const recoveredItems = findRecoveredGenerationItems(Array.isArray(body.items) ? body.items : [], snapshot, pendingItem);
          if (recoveredItems.length) {
            mergeRecoveredGalleryItems(recoveredItems, pendingItem.outputId);
            setLastRequest(snapshot);
            setToast({ tone: "success", message: "生成已完成，已自动同步到图库。" });
            return true;
          }
        }
      } catch {
        // Keep the pending card alive while the backend may still be finishing the real image job.
      }
      await sleep(3000);
    }

    return false;
  }

  async function submitGeneration(snapshot = buildRequestSnapshot()) {
    const currentValidation = validateForm({
      mode: snapshot.mode,
      prompt: snapshot.body.prompt,
      size: snapshot.body.size,
      sizePresetId: snapshot.body.sizePresetId,
      referenceImages: snapshot.body.referenceImages ?? [],
      maskImage: snapshot.body.maskImage ?? null
    });
    if (currentValidation) {
      setNotice({ tone: "error", message: currentValidation });
      return;
    }

    const pendingItem = createPendingGalleryItem(snapshot);
    setIsGenerating(true);
    setNotice(null);
    setLatestRecord(null);
    setActiveTab("gallery");
    setMobileView("gallery");
    setGalleryItems((current) => [pendingItem, ...current]);

    try {
      const response = await fetch(apiPath(`${snapshot.endpoint}?async=1`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot.body)
      });
      if (!response.ok) throw new Error(await readApiError(response, "生成失败"));
      const data = (await response.json()) as GenerationResponse | GenerationJobResponse;
      const record = isGenerationJobResponse(data)
        ? await waitForGenerationJob(data.job.id, (job) => {
          updatePendingGalleryItem(pendingItem.outputId, {
            clientStatus: job.status === "queued" ? "queued" : "running",
            progress: clamp(Math.round(job.progress ?? 10), 6, 98)
          });
        })
        : data.record;
      setLatestRecord(record);
      setLastRequest(snapshot);

      const nextGalleryItems = galleryItemsForRecord(record);
      if (nextGalleryItems.length) {
        setGalleryItems((current) => [
          ...nextGalleryItems,
          ...current.filter((item) => item.outputId !== pendingItem.outputId && !nextGalleryItems.some((nextItem) => nextItem.outputId === item.outputId))
        ]);
      }

      const succeededCount = nextGalleryItems.length;
      const failedCount = record.outputs.filter((output) => output.status === "failed").length;
      if (succeededCount > 0 && activeTab === "interrogate") {
        setActiveTab("gallery");
        setMobileView("gallery");
      }
      if (succeededCount <= 0) {
        updatePendingGalleryItem(pendingItem.outputId, {
          clientStatus: "failed",
          progress: 100,
          error: generationFailureText(record),
          status: "failed"
        });
        scheduleRemovePendingGalleryItem(pendingItem.outputId);
      } else if (failedCount > 0) {
        setToast({ tone: "warning", message: `${failedCount} 张生成失败，其余已保存到画廊。` });
      }
    } catch (error) {
      updatePendingGalleryItem(pendingItem.outputId, {
        clientStatus: "running",
        progress: 96,
        error: undefined,
        status: undefined
      });
      const recovered = await recoverCompletedGeneration(snapshot, pendingItem);
      if (!recovered) {
        updatePendingGalleryItem(pendingItem.outputId, {
          clientStatus: "failed",
          progress: 100,
          error: error instanceof Error ? error.message : "生成失败",
          status: "failed"
        });
        scheduleRemovePendingGalleryItem(pendingItem.outputId);
      }
    } finally {
      setIsGenerating(false);
    }
  }

  function reuseGalleryItem(item: GalleryImageItem) {
    setPrompt(item.prompt);
    setQuality(item.quality);
    setOutputFormat(item.outputFormat);
    setSize(item.size);
    setSizePresetId(sizePresetIdForSize(runtimeConfig.sizePresets, item.size));
    setCount(1);
    setMode(item.mode === "edit" ? "edit" : "text");
    setNotice({ tone: "success", message: "已把这张图的参数填回右侧面板。" });
  }

  async function copyPrompt(value: string, label = "提示词") {
    try {
      const copied = await writeClipboardText(value);
      if (!copied) throw new Error("剪贴板复制被拒绝");
      setToast({ tone: "success", message: `${label}已复制。` });
    } catch {
      setToast({ tone: "error", message: "复制失败，请手动复制。" });
    }
  }

  async function toggleGalleryFavorite(item: GalleryImageItem) {
    const favorite = !item.favorite;

    setGalleryItems((current) =>
      current.map((entry) => (entry.outputId === item.outputId ? { ...entry, favorite } : entry))
    );

    try {
      const response = await fetch(apiPath(`/gallery/${encodeURIComponent(item.outputId)}/favorite`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite })
      });
      if (!response.ok) throw new Error(await readApiError(response, "收藏状态保存失败"));
      setToast({ tone: "success", message: favorite ? "已加入收藏。" : "已取消收藏。" });
    } catch (error) {
      setGalleryItems((current) =>
        current.map((entry) => (entry.outputId === item.outputId ? { ...entry, favorite: item.favorite } : entry))
      );
      setToast({ tone: "error", message: error instanceof Error ? error.message : "收藏状态保存失败" });
    }
  }

  async function toggleInterrogationFavorite(item: InterrogationItem) {
    const favorite = !item.favorite;
    setInterrogateItems((current) =>
      current.map((entry) => (entry.id === item.id ? { ...entry, favorite } : entry))
    );

    try {
      const response = await fetch(apiPath(`/interrogations/${encodeURIComponent(item.id)}/favorite`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite })
      });
      if (!response.ok) throw new Error(await readApiError(response, "收藏状态保存失败"));
      setToast({ tone: "success", message: favorite ? "已加入收藏。" : "已取消收藏。" });
    } catch (error) {
      setInterrogateItems((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, favorite: item.favorite } : entry))
      );
      setToast({ tone: "error", message: error instanceof Error ? error.message : "收藏状态保存失败" });
    }
  }

  function openLightbox(item: GalleryImageItem) {
    const index = visibleGalleryItems.findIndex((galleryItem) => galleryItem.outputId === item.outputId);
    prepareLightboxAsset(item.asset);
    setLightboxState({ kind: "gallery", index: index >= 0 ? index : 0 });
  }

  function openInterrogateLightbox(item: InterrogationItem) {
    const index = visibleInterrogateItems.findIndex((entry) => entry.id === item.id);
    prepareLightboxAsset(item.asset);
    setLightboxState({ kind: "interrogate", index: index >= 0 ? index : 0 });
  }

  function navigateLightbox(direction: -1 | 1) {
    if (!lightboxState) return;
    const items = lightboxState.kind === "interrogate" ? visibleInterrogateItems : visibleGalleryItems;
    const itemCount = items.length;
    if (!itemCount) {
      setLightboxState(null);
      return;
    }
    const nextIndex = (lightboxState.index + direction + itemCount) % itemCount;
    prepareLightboxAsset(items[nextIndex]?.asset ?? null);
    setLightboxState({
      kind: lightboxState.kind,
      index: nextIndex
    });
  }

  function prepareLightboxAsset(asset: ImageSize | null | undefined) {
    lightboxUserZoomedRef.current = false;
    setLightboxZoom(asset ? defaultLightboxCoverZoom(asset) : 1);
    setLightboxPan({ x: 0, y: 0 });
    setHighResLoaded(false);
    setLightboxRevealReady(false);
    setLightboxPreviewReady(false);
    setLightboxNaturalSize(null);
  }

  function resetLightboxView() {
    const baseSize = lightboxNaturalSize ?? lightboxAsset;
    lightboxUserZoomedRef.current = false;
    setLightboxZoom(baseSize ? defaultLightboxCoverZoom(baseSize) : 1);
    setLightboxPan({ x: 0, y: 0 });
  }

  function handleInputBarMouseEnter() {
    if (!mobileInputCollapsed || inputHoverSuppressed) return;
    setInputHoverExpanded(true);
  }

  function handleInputBarMouseLeave() {
    setInputHoverExpanded(false);
    setInputHoverSuppressed(false);
  }

  function toggleInputBarCollapsed() {
    if (isInputBarCollapsed || inputHoverAutoExpanded) {
      setMobileInputCollapsed(false);
      setInputHoverExpanded(false);
      setInputHoverSuppressed(false);
      return;
    }

    setMobileInputCollapsed(true);
    setInputHoverExpanded(false);
    setInputHoverSuppressed(true);
  }

  function showGalleryView() {
    setMobileView("gallery");
  }

  function handlePanelDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragTarget(null);
    setInterrogateDragActive(false);
    const files = event.dataTransfer.files;
    if (activeTab === "interrogate") {
      void addInterrogateFiles(files);
      return;
    }
    void addFiles(files, "reference");
  }

  function handleDropZone(event: DragEvent<HTMLElement>, target: UploadTarget) {
    event.preventDefault();
    event.stopPropagation();
    setDragTarget(null);
    void addFiles(event.dataTransfer.files, target);
  }

  function handleLightboxPointerDown(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, .lightbox__floating-prompt, .lightbox__floating-prompt-group, .lightbox__zoom-control")) return;
    lightboxPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (lightboxPointersRef.current.size >= 2) {
      const pinch = getPinchGesture(lightboxPointersRef.current);
      if (pinch) {
        lightboxPinchRef.current = {
          ...pinch,
          startZoom: lightboxZoom,
          originX: lightboxPan.x,
          originY: lightboxPan.y
        };
        lightboxPanStartRef.current = null;
        lightboxUserZoomedRef.current = true;
        event.preventDefault();
      }
      return;
    }

    if (lightboxZoom <= 1) return;
    lightboxPanStartRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: lightboxPan.x,
      originY: lightboxPan.y
    };
  }

  function handleLightboxPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (lightboxPointersRef.current.has(event.pointerId)) {
      lightboxPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const pinchStart = lightboxPinchRef.current;
    if (pinchStart && lightboxPointersRef.current.size >= 2) {
      const pinch = getPinchGesture(lightboxPointersRef.current);
      if (!pinch) return;
      event.preventDefault();
      const nextZoom = clamp(Number((pinchStart.startZoom * (pinch.distance / Math.max(1, pinchStart.distance))).toFixed(3)), LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM);
      setLightboxZoom(nextZoom);
      setLightboxPan({
        x: pinchStart.originX + pinch.centerX - pinchStart.centerX,
        y: pinchStart.originY + pinch.centerY - pinchStart.centerY
      });
      return;
    }

    const start = lightboxPanStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    setLightboxPan({
      x: start.originX + event.clientX - start.startX,
      y: start.originY + event.clientY - start.startY
    });
  }

  function handleLightboxPointerUp(event: PointerEvent<HTMLDivElement>) {
    lightboxPointersRef.current.delete(event.pointerId);
    if (lightboxPointersRef.current.size < 2) {
      lightboxPinchRef.current = null;
    }
    const start = lightboxPanStartRef.current;
    if (start?.pointerId === event.pointerId) {
      lightboxPanStartRef.current = null;
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function handleLightboxBackdropPointerUp(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        ".lightbox__content, .lightbox__close, .lightbox__floating-prompt, .lightbox__floating-prompt-group, .lightbox__header-actions, .lightbox__floating-counter, .lightbox__zoom-control"
      )
    ) return;
    setLightboxState(null);
  }

  return (
    <main className="canvas-workspace" data-active-tab={activeTab} data-mobile-view={mobileView} data-panel-open={isGenerationOpen}>
      <header
        data-no-drag-select
        className="safe-area-top fixed top-0 left-0 right-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200 transition-transform duration-300 ease-in-out"
      >
        <div className="safe-area-x safe-header-inner canvas-header-main max-w-7xl mx-auto flex items-center justify-between relative">
          <div className="flex-1 min-w-0 pr-2 flex items-center gap-2">
            <h1 className="inline-flex items-start relative mr-2">
              <span className="text-[17px] sm:text-lg font-bold tracking-tight text-gray-800 hover:text-gray-600 transition-colors">
                Mio
              </span>
            </h1>
          </div>

          <div className="hidden sm:flex items-center gap-1 rounded-xl border border-gray-200 bg-gray-100/70 p-1">
            <button
              type="button"
              onClick={() => { setActiveTab("gallery"); showGalleryView(); }}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${activeTab === "gallery" ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500 hover:text-gray-800"}`}
            >
              画廊
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab("interrogate"); showGalleryView(); }}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${activeTab === "interrogate" ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500 hover:text-gray-800"}`}
            >
              模板库
            </button>
          </div>
        </div>

        <div className="safe-area-x sm:hidden overflow-hidden transition-all duration-300 ease-in-out max-h-20 opacity-100 pb-2">
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-gray-100/70 p-1 mx-2">
            <button
              type="button"
              onClick={() => { setActiveTab("gallery"); showGalleryView(); }}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${activeTab === "gallery" ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500 hover:text-gray-800"}`}
            >
              画廊
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab("interrogate"); showGalleryView(); }}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${activeTab === "interrogate" ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500 hover:text-gray-800"}`}
            >
              模板库
            </button>
          </div>
        </div>
      </header>

      <div className="safe-area-top canvas-reference-spacer" aria-hidden="true">
        <div className="safe-header-inner" />
        <div className="canvas-mobile-tab-spacer sm:hidden h-[3rem]" />
      </div>

      <section className="gallery-pane" aria-label={activeTab === "interrogate" ? "模板库" : "画廊"} ref={galleryPaneRef}>
        <div data-no-drag-select className="reference-search-bar">
          <div className="reference-search-leading">
            <button
              type="button"
              className="reference-favorite-button"
              data-active={favoritesOnly}
              aria-pressed={favoritesOnly}
              aria-label="只看收藏"
              data-ui-tooltip={favoritesOnly ? "显示全部作品与模板" : "只看收藏"}
              data-tooltip-placement="bottom"
              onClick={() => setFavoritesOnly((current) => !current)}
            >
              <Star className="icon" aria-hidden="true" />
            </button>
            <div className="reference-status-select">
              <PrettySelect
                ariaLabel="筛选状态"
                value={statusFilter}
                options={statusFilterOptions}
                onChange={(nextValue) => setStatusFilter(nextValue as ReferenceStatusFilter)}
              />
            </div>
          </div>
          <div className="reference-search-input" role="search">
            <Search className="icon" aria-hidden="true" />
            <input
              value={activeSearchValue}
              onChange={(event) => updateActiveSearch(event.target.value)}
              type="text"
              placeholder="搜索提示词、参数..."
            />
          </div>
        </div>

        {activeTab === "gallery" ? (
          isGalleryLoading ? (
            <div className="gallery-skeleton" role="status" aria-label="正在加载图库">
              {Array.from({ length: 8 }, (_, index) => (
                <div className="gallery-skeleton__card" key={index}>
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : visibleGalleryItems.length ? (
            <div className="masonry-gallery">
              {visibleGalleryItems.map((item) => (
                <article className="masonry-card" data-client-status={item.clientStatus || "ready"} key={item.outputId}>
                  {item.clientStatus ? (
                    <div
                      className="masonry-card__image masonry-card__pending-visual"
                      style={{ aspectRatio: `${Math.max(item.asset.width, 1)} / ${Math.max(item.asset.height, 1)}` }}
                    >
                      <div className="card-progress-orb" data-state={item.clientStatus}>
                        {item.clientStatus === "failed" ? <AlertTriangle className="icon" aria-hidden="true" /> : <Loader2 className="icon spin" aria-hidden="true" />}
                        <strong>{item.clientStatus === "failed" ? "失败" : `${Math.round(item.progress ?? 8)}%`}</strong>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="masonry-card__image"
                      type="button"
                      aria-label={`查看作品：${promptExcerpt(item.prompt, 40)}`}
                      style={{ aspectRatio: `${Math.max(item.asset.width, 1)} / ${Math.max(item.asset.height, 1)}` }}
                      onClick={() => openLightbox(item)}
                    >
                      <img
                        src={assetPreviewUrl(item.asset.id, 256, item.asset.url)}
                        srcSet={assetPreviewSrcSet(item.asset.id, item.asset.url, MASONRY_PREVIEW_WIDTHS)}
                        sizes={MASONRY_IMAGE_SIZES}
                        alt={item.prompt}
                        width={item.asset.width}
                        height={item.asset.height}
                        decoding="async"
                        loading="lazy"
                      />
                      <span className="zoom-pill">
                        <Maximize2 className="icon" aria-hidden="true" />
                      </span>
                    </button>
                  )}
                  {!item.clientStatus ? (
                    <button
                      type="button"
                      className="masonry-card__favorite"
                      data-active={Boolean(item.favorite)}
                      aria-pressed={Boolean(item.favorite)}
                      aria-label={item.favorite ? "取消收藏" : "收藏作品"}
                      data-ui-tooltip={item.favorite ? "取消收藏" : "收藏作品"}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleGalleryFavorite(item);
                      }}
                    >
                      <Star className="icon" aria-hidden="true" />
                    </button>
                  ) : null}
                  <div className="masonry-card__body">
                    <button
                      type="button"
                      className="masonry-card__prompt-copy"
                      title="点击复制完整提示词"
                      aria-label={`复制完整提示词：${promptExcerpt(item.prompt, 40)}`}
                      onClick={() => void copyPrompt(item.prompt, "提示词")}
                    >
                      {item.prompt}
                    </button>
                    <div className="masonry-card__meta">
                      <span>{item.clientStatus === "failed" ? "生成失败" : item.clientStatus ? "生成中" : `${item.size.width}x${item.size.height}`}</span>
                      <span>{item.clientStatus === "failed" ? promptExcerpt(item.error || "请稍后重试", 18) : item.outputFormat.toUpperCase()}</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-gallery" data-tone={galleryError ? "error" : "empty"}>
              {galleryError ? <AlertTriangle className="icon" aria-hidden="true" /> : <ImageIcon className="icon" aria-hidden="true" />}
              <span>{galleryError || (galleryItems.length ? "没有匹配的作品" : "输入提示词开始生成图片")}</span>
            </div>
          )
        ) : (
          <div className="interrogate-page">
            {interrogateError ? (
              <div className="notice" data-tone="error" role="alert">
                <AlertTriangle className="icon" aria-hidden="true" />
                <span>{interrogateError}</span>
              </div>
            ) : interrogateStatus ? (
              <div className="notice" data-tone="success" role="status">
                <span>{interrogateStatus}</span>
              </div>
            ) : null}

            {isInterrogateLoading ? (
              <div className="gallery-skeleton" role="status" aria-label="正在加载模板库">
                {Array.from({ length: 6 }, (_, index) => (
                  <div className="gallery-skeleton__card" key={index}>
                    <span />
                    <span />
                  </div>
                ))}
              </div>
            ) : visibleInterrogateItems.length ? (
              <div className="masonry-gallery masonry-gallery--interrogate">
                {visibleInterrogateItems.map((item) => (
                  <article className="masonry-card" data-client-status={item.clientStatus || "ready"} key={item.id}>
                    {item.clientStatus ? (
                      <div
                        className="masonry-card__image masonry-card__pending-visual"
                        style={{ aspectRatio: `${Math.max(item.asset.width, 1)} / ${Math.max(item.asset.height, 1)}` }}
                      >
                        {item.asset.url ? <img src={item.asset.url} alt="" aria-hidden="true" /> : null}
                        <div className="card-progress-orb" data-state={item.clientStatus}>
                          {item.clientStatus === "failed" ? <AlertTriangle className="icon" aria-hidden="true" /> : <Loader2 className="icon spin" aria-hidden="true" />}
                          <strong>{item.clientStatus === "failed" ? "失败" : `${Math.round(item.progress ?? 8)}%`}</strong>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="masonry-card__image"
                        type="button"
                        aria-label={`查看模板：${promptExcerpt(item.prompt, 40)}`}
                        style={{ aspectRatio: `${Math.max(item.asset.width, 1)} / ${Math.max(item.asset.height, 1)}` }}
                        onClick={() => openInterrogateLightbox(item)}
                      >
                        <img
                          src={assetPreviewUrl(item.asset.id, 256, item.asset.url)}
                          srcSet={assetPreviewSrcSet(item.asset.id, item.asset.url, MASONRY_PREVIEW_WIDTHS)}
                          sizes={MASONRY_IMAGE_SIZES}
                          alt={item.prompt}
                          width={item.asset.width}
                          height={item.asset.height}
                          decoding="async"
                          loading="lazy"
                        />
                        <span className="zoom-pill">
                          <Maximize2 className="icon" aria-hidden="true" />
                        </span>
                      </button>
                    )}
                    {!item.clientStatus ? (
                      <button
                        type="button"
                        className="masonry-card__favorite"
                        data-active={Boolean(item.favorite)}
                        aria-pressed={Boolean(item.favorite)}
                        aria-label={item.favorite ? "取消收藏" : "收藏模板"}
                        data-ui-tooltip={item.favorite ? "取消收藏" : "收藏模板"}
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleInterrogationFavorite(item);
                        }}
                      >
                        <Star className="icon" aria-hidden="true" />
                      </button>
                    ) : null}
                    <div className="masonry-card__body">
                      <button
                        type="button"
                        className="masonry-card__prompt-copy"
                        title="点击复制完整模板提示词"
                        aria-label={`复制完整模板提示词：${promptExcerpt(item.templatePrompt || item.prompt, 40)}`}
                        onClick={() => void copyPrompt(item.templatePrompt || item.prompt, "模板提示词")}
                      >
                        {item.templatePrompt || item.prompt}
                      </button>
                      <div className="masonry-card__meta">
                        <span>{item.clientStatus === "failed" ? "反推失败" : item.clientStatus ? "反推中" : "反推"}</span>
                        <span>{item.clientStatus === "failed" ? promptExcerpt(item.error || "请稍后重试", 18) : "模板"}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-gallery" data-tone={interrogateError ? "error" : "empty"}>
                {interrogateError ? <AlertTriangle className="icon" aria-hidden="true" /> : <ImageIcon className="icon" aria-hidden="true" />}
                  <span>{interrogateError || (interrogateItems.length ? "没有匹配的反推记录" : "模板库为空")}</span>
              </div>
            )}
          </div>
        )}
      </section>

      <aside
        className="control-pane playground-input-bar"
        data-dragging={dragTarget === "panel"}
        data-open={isGenerationOpen}
        data-hover-expanded={inputHoverAutoExpanded}
        data-hover-suppressed={inputHoverSuppressed}
        data-manual-collapsed={mobileInputCollapsed}
        onMouseEnter={handleInputBarMouseEnter}
        onMouseLeave={handleInputBarMouseLeave}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragTarget("panel");
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragTarget(null);
            setInterrogateDragActive(false);
          }
        }}
        onDrop={handlePanelDrop}
      >
        <div
          className="playground-input-card"
          data-mode={activeTab}
          data-mobile-collapsed={isInputBarCollapsed}
          data-hover-suppressed={inputHoverSuppressed}
        >
          <button
            type="button"
            className="playground-mobile-handle"
            aria-label={isInputBarCollapsed ? "展开输入栏" : "收起输入栏"}
            aria-expanded={!isInputBarCollapsed}
            onClick={toggleInputBarCollapsed}
          >
            <span aria-hidden="true" />
          </button>

          {activeTab === "interrogate" ? (
            <div className="playground-interrogate-card">
              <button
                className="playground-interrogate-drop"
                type="button"
                data-has-image={Boolean(interrogateImage)}
                data-drag-active={interrogateDragActive || dragTarget === "panel"}
                onClick={() => interrogateInputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDragTarget("panel");
                  setInterrogateDragActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setInterrogateDragActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setInterrogateDragActive(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDragTarget(null);
                  setInterrogateDragActive(false);
                  void addInterrogateFiles(event.dataTransfer.files);
                }}
              >
                {interrogateImage ? (
                  <img src={interrogateImage.previewUrl} alt={interrogateImage.fileName} />
                ) : (
                  <UploadCloud className="icon" aria-hidden="true" />
                )}
                <span className="playground-interrogate-copy">
                  <strong>{interrogateImage ? interrogateImage.fileName : "上传图片反推"}</strong>
                  <small>{interrogateImage ? "点击可更换图片，右侧开始反推" : "拖入或选择 PNG/JPEG/WebP 图片"}</small>
                </span>
                {interrogateImage ? (
                  <button
                    className="playground-interrogate-clear"
                    type="button"
                    aria-label="移除反推图片"
                    data-ui-tooltip="移除图片"
                    onClick={(event) => {
                      event.stopPropagation();
                      setInterrogateImage(null);
                    }}
                  >
                    <X className="icon" aria-hidden="true" />
                  </button>
                ) : null}
              </button>
              <div className="playground-interrogate-actions">
                <button
                  className="playground-mobile-submit playground-interrogate-submit"
                  disabled={isInterrogating || !interrogateImage}
                  data-ui-tooltip={interrogateImage ? "开始反推" : "请先上传图片"}
                  type="button"
                  onClick={() => void submitInterrogation()}
                >
                  {isInterrogating ? <Loader2 className="icon spin" aria-hidden="true" /> : <WandSparkles className="icon" aria-hidden="true" />}
                  <span>{isInterrogating ? "反推中" : "开始反推"}</span>
                </button>
              </div>
              <input
                ref={interrogateInputRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  if (event.target.files) void addInterrogateFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          ) : (

            <>
              {referenceImages.length ? (
                <div className="playground-reference-strip" aria-label="参考图">
                  {referenceImages.map((image, index) => (
                    <div className="playground-reference-thumb" key={image.id}>
                      <img src={image.previewUrl} alt={`参考图 ${index + 1}`} />
                      <button type="button" aria-label="移除参考图" onClick={() => removeReferenceImage(image.id)}>
                        <X className="icon" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="playground-input-main-row">
                <button
                  className="playground-attach-button"
                  type="button"
                  aria-label="上传参考图"
                  data-ui-tooltip="上传参考图"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="icon" aria-hidden="true" />
                </button>
                <textarea
                  className="playground-prompt-input"
                  id="prompt"
                  rows={1}
                  placeholder="填入提示词"
                  value={prompt}
                  onChange={handlePromptChange}
                />
                <div className="playground-input-main-actions">
                  <button
                    className="playground-submit-button"
                    disabled={!canGenerate}
                    data-ui-tooltip={validationMessage || "生成图像"}
                    type="button"
                    onClick={() => void submitGeneration()}
                    aria-label="生成图像"
                  >
                    {isGenerating ? <Loader2 className="icon spin" aria-hidden="true" /> : <ArrowRight className="icon" aria-hidden="true" />}
                  </button>
                </div>
              </div>

              <div className="playground-param-roll" aria-hidden={isInputBarCollapsed}>
                <div className={`playground-param-row${sizePresetId === "custom" ? " playground-param-row--custom-size" : ""}`}>
                <label
                  className={`playground-param-field playground-param-field--size${
                    sizePresetId === "custom" ? " playground-param-field--custom-size" : ""
                  }`}
                >
                  <span>尺寸</span>
                  <div className="playground-custom-size-container">
                    <PrettySelect
                      ariaLabel="选择尺寸比例"
                      className="playground-size-select"
                      value={sizePresetId}
                      options={sizeOptions}
                      onChange={selectSizePreset}
                    />
                    {sizePresetId === "custom" && (
                      <div className="playground-custom-size-inputs">
                        <input
                          type="number"
                          value={size.width}
                          min={512}
                          max={3840}
                          step={16}
                          onChange={(event) => updateCustomSize({ width: Math.max(0, parseInt(event.target.value) || 0) })}
                          title="宽度"
                          placeholder="宽"
                        />
                        <span className="playground-size-separator">x</span>
                        <input
                          type="number"
                          value={size.height}
                          min={512}
                          max={3840}
                          step={16}
                          onChange={(event) => updateCustomSize({ height: Math.max(0, parseInt(event.target.value) || 0) })}
                          title="高度"
                          placeholder="高"
                        />
                      </div>
                    )}
                  </div>
                </label>

                <label className="playground-param-field">
                  <span>质量</span>
                  <PrettySelect
                    ariaLabel="选择质量"
                    value={quality}
                    options={qualityOptions}
                    onChange={(nextValue) => setQuality(nextValue as ImageQuality)}
                  />
                </label>

                <label className="playground-param-field">
                  <span>格式</span>
                  <PrettySelect
                    ariaLabel="选择格式"
                    value={outputFormat}
                    options={outputFormatOptions}
                    onChange={(nextValue) => setOutputFormat(nextValue as OutputFormat)}
                  />
                </label>
                
                <label className="playground-param-field playground-param-field--count">
                  <span>数量</span>
                  <PrettySelect
                    ariaLabel="选择数量"
                    value={String(count)}
                    options={countOptions}
                    onChange={(nextValue) => setCount(Number(nextValue) as GenerationCount)}
                  />
                </label>
              </div>
              </div>

              {notice ? (
                <div className="notice notice--main playground-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
                  {notice.tone === "error" || notice.tone === "warning" ? <AlertTriangle className="icon" aria-hidden="true" /> : null}
                  <span>{notice.message}</span>
                </div>
              ) : null}

              <input
                ref={fileInputRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={(event) => {
                  if (event.target.files) void addFiles(event.target.files, "reference");
                  event.target.value = "";
                }}
              />
            </>
          )}
        </div>
      </aside>

      <button
        type="button"
        className="canvas-back-top"
        data-visible={showBackToTop}
        aria-label="返回最顶部"
        data-ui-tooltip="返回顶部"
        onClick={() => {
          galleryPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          stopScrollMomentum(scrollMomentumRef.current);
        }}
      >
        <ChevronDown className="icon" aria-hidden="true" />
      </button>

      {toast ? (
        <div className="copy-toast" data-tone={toast.tone} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.tone === "error" ? <AlertTriangle className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
          <span>{toast.message}</span>
        </div>
      ) : null}

      {lightboxAsset ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="图片全屏预览"
          onPointerUp={handleLightboxBackdropPointerUp}
        >
          <img className="lightbox__blur" src={assetPreviewUrl(lightboxAsset.id, 512, lightboxAsset.url)} alt="" aria-hidden="true" />
          
          {selectedLightboxItem ? (
            <div 
              className="lightbox__floating-prompt" 
              title="点击复制提示词" 
              onClick={() => void copyPrompt(selectedLightboxItem.prompt, "提示词")}
            >
              <span className="lightbox__floating-prompt-label">提示词：</span>
              <span className="lightbox__floating-prompt-text">{selectedLightboxItem.prompt}</span>
            </div>
          ) : selectedInterrogateLightboxItem ? (
            <div className="lightbox__floating-prompt-group">
              <div 
                className="lightbox__floating-prompt-item" 
                title="点击复制原图反推提示词" 
                onClick={() => void copyPrompt(selectedInterrogateLightboxItem.prompt, "原图反推提示词")}
              >
                <span className="lightbox__floating-prompt-item-label">反推提示词:</span>
                <span className="lightbox__floating-prompt-item-text">{selectedInterrogateLightboxItem.prompt}</span>
              </div>
              <div 
                className="lightbox__floating-prompt-item" 
                title="点击复制模板提示词" 
                onClick={() => void copyPrompt(selectedInterrogateLightboxItem.templatePrompt || selectedInterrogateLightboxItem.prompt, "模板提示词")}
              >
                <span className="lightbox__floating-prompt-item-label">模板提示词:</span>
                <span className="lightbox__floating-prompt-item-text">{selectedInterrogateLightboxItem.templatePrompt || selectedInterrogateLightboxItem.prompt}</span>
              </div>
            </div>
          ) : null}

          <div className="lightbox__header-actions">
            {selectedLightboxItem ? (
              <>
                <button
                  type="button"
                  className="lightbox__action-btn"
                  title="复用提示词与参数"
                  onClick={() => reuseGalleryItem(selectedLightboxItem)}
                >
                  <RefreshCw className="icon" aria-hidden="true" />
                </button>
                <a
                  className="lightbox__action-btn"
                  title="下载图片"
                  href={apiPath(`/assets/${encodeURIComponent(selectedLightboxItem.asset.id)}/download`)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Download className="icon" aria-hidden="true" />
                </a>
              </>
            ) : selectedInterrogateLightboxItem ? (
              <a
                className="lightbox__action-btn"
                title="下载图片"
                href={apiPath(`/assets/${encodeURIComponent(selectedInterrogateLightboxItem.asset.id)}/download`)}
                target="_blank"
                rel="noreferrer"
              >
                <Download className="icon" aria-hidden="true" />
              </a>
            ) : null}
            <button 
              className="lightbox__action-btn lightbox__action-btn--close" 
              type="button" 
              aria-label="关闭预览" 
              onClick={() => setLightboxState(null)}
            >
              <X className="icon" aria-hidden="true" />
            </button>
          </div>

          <span className="lightbox__floating-counter">
            {activeLightboxIndex + 1} / {activeLightboxCount}
          </span>

          <div className="lightbox__content">
            <div
              className="lightbox__stage"
              data-zoomed={lightboxZoom > 1}
              data-fit="contain"
              onPointerDown={handleLightboxPointerDown}
              onPointerMove={handleLightboxPointerMove}
              onPointerUp={handleLightboxPointerUp}
              onPointerCancel={() => {
                lightboxPanStartRef.current = null;
                lightboxPinchRef.current = null;
                lightboxPointersRef.current.clear();
              }}
            >
              <button 
                className="lightbox__nav lightbox__nav--prev" 
                type="button" 
                aria-label="上一张" 
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={() => navigateLightbox(-1)}
              >
                <ChevronLeft className="icon" aria-hidden="true" />
              </button>
              <div className="lightbox__media" data-preview-ready={lightboxPreviewReady}>
                <div
                  className="lightbox__loading-indicator"
                  data-visible={!canRevealHighResLightbox}
                  role="status"
                  aria-live="polite"
                >
                  <span aria-hidden="true" />
                  <strong>加载高清图</strong>
                </div>
                <img 
                  className="lightbox__media-placeholder"
                  key={`${lightboxAsset.id}-preview`}
                  src={assetPreviewUrl(lightboxAsset.id, 512, lightboxAsset.url)}
                  alt="" 
                  draggable={false} 
                  decoding="async"
                  data-high-res-loaded={canRevealHighResLightbox}
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    const naturalSize = {
                      width: image.naturalWidth || lightboxAsset.width,
                      height: image.naturalHeight || lightboxAsset.height
                    };
                    setLightboxNaturalSize(naturalSize);
                    if (!lightboxUserZoomedRef.current) {
                      setLightboxZoom(defaultLightboxCoverZoom(naturalSize));
                      setLightboxPan({ x: 0, y: 0 });
                    }
                    setLightboxPreviewReady(true);
                  }}
                  onError={() => {
                    setLightboxNaturalSize(lightboxAsset);
                    if (!lightboxUserZoomedRef.current) {
                      setLightboxZoom(defaultLightboxCoverZoom(lightboxAsset));
                      setLightboxPan({ x: 0, y: 0 });
                    }
                    setLightboxPreviewReady(true);
                  }}
                  style={{ 
                    transform: lightboxTransform,
                    opacity: 1,
                    pointerEvents: "none"
                  }} 
                />
                <img 
                  className="lightbox__media-original"
                  key={`${lightboxAsset.id}-original`}
                  src={lightboxAsset.url} 
                  alt={lightboxAlt} 
                  draggable={false}
                  decoding="async"
                  loading="eager"
                  data-loaded={canRevealHighResLightbox}
                  onLoad={() => {
                    setHighResLoaded(true);
                  }}
                  onError={(event) => {
                    const fallbackSrc = assetPreviewUrl(lightboxAsset.id, 2048, lightboxAsset.url);
                    const fallbackHref = new URL(fallbackSrc, window.location.href).href;
                    if (event.currentTarget.src !== fallbackHref) {
                      event.currentTarget.src = fallbackSrc;
                    }
                  }}
                  style={{ transform: lightboxTransform }} 
                />
              </div>
              <button 
                className="lightbox__nav lightbox__nav--next" 
                type="button" 
                aria-label="下一张" 
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={() => navigateLightbox(1)}
              >
                <ChevronRight className="icon" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div 
            className="lightbox__zoom-control" 
            onPointerDown={(e) => e.stopPropagation()} 
            onPointerUp={(e) => e.stopPropagation()}
          >
            <button 
              type="button" 
              onClick={() => {
                lightboxUserZoomedRef.current = true;
                setLightboxZoom((prev) => Math.max(LIGHTBOX_MIN_ZOOM, prev - 0.25));
              }}
              title="缩小"
            >
              <ZoomOut className="icon" aria-hidden="true" />
            </button>
            <input 
              type="range" 
              min={LIGHTBOX_MIN_ZOOM}
              max={LIGHTBOX_MAX_ZOOM}
              step="0.05"
              value={lightboxZoom} 
              onChange={(e) => {
                lightboxUserZoomedRef.current = true;
                setLightboxZoom(clamp(parseFloat(e.target.value), LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM));
              }}
              title="调整缩放"
            />
            <button 
              type="button" 
              onClick={() => {
                lightboxUserZoomedRef.current = true;
                setLightboxZoom((prev) => Math.min(LIGHTBOX_MAX_ZOOM, prev + 0.25));
              }}
              title="放大"
            >
              <ZoomIn className="icon" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={resetLightboxView}
              title="复原"
              aria-label="复原预览"
            >
              <RefreshCw className="icon" aria-hidden="true" />
            </button>
            <span className="lightbox__zoom-percent">{Math.round(lightboxZoom * 100)}%</span>
          </div>
        </div>
      ) : null}
    </main>
  );

}

function MaskBrushEditor({ image, onMaskChange }: { image: UploadedImage; onMaskChange: (mask: UploadedImage | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [brushSize, setBrushSize] = useState(44);
  const [tool, setTool] = useState<"paint" | "erase">("paint");
  const [hasMask, setHasMask] = useState(false);
  const canvasWidth = Math.max(1, Math.round(image.width || 1024));
  const canvasHeight = Math.max(1, Math.round(image.height || 1024));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    drawingRef.current = null;
    setHasMask(false);
    onMaskChange(null);
  }, [canvasHeight, canvasWidth, image.id, onMaskChange]);

  function pointForEvent(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
      scale: canvas.width / rect.width
    };
  }

  function drawDot(x: number, y: number, radius: number) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.save();
    context.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    context.fillStyle = "#5eead4";
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawLine(fromX: number, fromY: number, toX: number, toY: number, lineWidth: number) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.save();
    context.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    context.strokeStyle = "#5eead4";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.restore();
  }

  function exportMask() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    if (!canvasContainsPaint(context, canvas.width, canvas.height)) {
      setHasMask(false);
      onMaskChange(null);
      return;
    }

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = canvas.width;
    outputCanvas.height = canvas.height;
    const outputContext = outputCanvas.getContext("2d");
    if (!outputContext) return;
    outputContext.fillStyle = "#ffffff";
    outputContext.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
    outputContext.globalCompositeOperation = "destination-out";
    outputContext.drawImage(canvas, 0, 0);
    const dataUrl = outputCanvas.toDataURL("image/png");
    setHasMask(true);
    onMaskChange({
      id: `${image.id}-mask-${Date.now()}`,
      dataUrl,
      fileName: `${image.fileName.replace(/\.[^.]+$/u, "") || "image"}-mask.png`,
      width: canvas.width,
      height: canvas.height,
      previewUrl: dataUrl
    });
  }

  function clearMask() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    drawingRef.current = null;
    setHasMask(false);
    onMaskChange(null);
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    const point = pointForEvent(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const radius = Math.max(2, (brushSize * point.scale) / 2);
    drawDot(point.x, point.y, radius);
    drawingRef.current = { pointerId: event.pointerId, x: point.x, y: point.y };
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const drawing = drawingRef.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    const point = pointForEvent(event);
    if (!point) return;
    event.preventDefault();
    drawLine(drawing.x, drawing.y, point.x, point.y, Math.max(4, brushSize * point.scale));
    drawingRef.current = { pointerId: event.pointerId, x: point.x, y: point.y };
  }

  function handlePointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (drawingRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    drawingRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    exportMask();
  }

  return (
    <section className="mask-editor" aria-label="遮罩画笔">
      <div className="mask-editor__header">
        <div>
          <h4>遮罩画笔</h4>
          <span>{hasMask ? "已涂抹改图区域" : "涂抹需要重绘的位置"}</span>
        </div>
        <button className="mask-editor__clear" type="button" disabled={!hasMask} onClick={clearMask}>
          <X className="icon" aria-hidden="true" />
          清空
        </button>
      </div>
      <div className="mask-editor__frame" style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}` }}>
        <img src={image.previewUrl} alt={image.fileName} draggable={false} />
        <canvas
          ref={canvasRef}
          aria-label="在图片上涂抹遮罩区域"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
      <div className="mask-editor__tools" aria-label="遮罩工具">
        <div className="mask-editor__tool-group">
          <button type="button" data-active={tool === "paint"} onClick={() => setTool("paint")}>
            <Brush className="icon" aria-hidden="true" />
            画笔
          </button>
          <button type="button" data-active={tool === "erase"} onClick={() => setTool("erase")}>
            <Eraser className="icon" aria-hidden="true" />
            擦除
          </button>
        </div>
        <label className="mask-editor__size">
          <span>{brushSize}px</span>
          <input
            type="range"
            min="12"
            max="120"
            step="2"
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
          />
        </label>
      </div>
    </section>
  );
}

function normalizeRuntimeConfig(value: unknown): CanvasRuntimeConfig {
  const record = isRecord(value) ? value : {};
  const defaults = isRecord(record.defaults) ? record.defaults : {};
  const sizePresets = normalizeSizePresets(record.sizePresets);
  const qualities = normalizeArray(record.qualities, IMAGE_QUALITIES, isImageQuality);
  const outputFormats = normalizeArray(record.outputFormats, OUTPUT_FORMATS, isOutputFormat);
  const counts = normalizeArray(record.counts, GENERATION_COUNTS, isGenerationCount);
  const defaultSizePresetId = typeof defaults.sizePresetId === "string" && (
    defaults.sizePresetId === AUTO_SIZE_PRESET_ID || sizePresets.some((preset) => preset.id === defaults.sizePresetId)
  )
    ? defaults.sizePresetId
    : fallbackRuntimeConfig.defaults.sizePresetId;
  const defaultQuality = isImageQuality(defaults.quality) ? defaults.quality : fallbackRuntimeConfig.defaults.quality;
  const defaultOutputFormat = isOutputFormat(defaults.outputFormat) ? defaults.outputFormat : fallbackRuntimeConfig.defaults.outputFormat;
  const defaultCount = isGenerationCount(defaults.count) ? defaults.count : fallbackRuntimeConfig.defaults.count;

  return {
    model: typeof record.model === "string" ? record.model : fallbackRuntimeConfig.model,
    models: Array.isArray(record.models) ? record.models.map(String).filter(Boolean) : fallbackRuntimeConfig.models,
    sizePresets,
    qualities,
    outputFormats,
    counts,
    defaults: {
      quality: qualities.includes(defaultQuality) ? defaultQuality : qualities[0] ?? "auto",
      outputFormat: outputFormats.includes(defaultOutputFormat) ? defaultOutputFormat : outputFormats[0] ?? "png",
      count: counts.includes(defaultCount) ? defaultCount : counts[0] ?? 1,
      sizePresetId: defaultSizePresetId
    }
  };
}

function normalizeSizePresets(value: unknown): SizePreset[] {
  if (!Array.isArray(value)) return SIZE_PRESETS;
  const presets = value.filter((item): item is SizePreset => (
    isRecord(item) &&
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    Number.isFinite(Number(item.width)) &&
    Number.isFinite(Number(item.height))
  )).map((item) => ({
    id: item.id,
    label: item.label,
    width: Number(item.width),
    height: Number(item.height),
    description: typeof item.description === "string" ? item.description : ""
  }));
  return presets.length ? presets : SIZE_PRESETS;
}

function normalizeArray<T>(value: unknown, fallback: readonly T[], guard: (item: unknown) => item is T): T[] {
  const items = Array.isArray(value) ? value.filter(guard) : [];
  return items.length ? items : [...fallback];
}

function isImageQuality(value: unknown): value is ImageQuality {
  return IMAGE_QUALITIES.includes(value as ImageQuality);
}

function isOutputFormat(value: unknown): value is OutputFormat {
  return OUTPUT_FORMATS.includes(value as OutputFormat);
}

function isGenerationCount(value: unknown): value is GenerationCount {
  return GENERATION_COUNTS.includes(Number(value) as GenerationCount);
}

function sizeForPreset(presets: SizePreset[], presetId: string): ImageSize {
  const preset = presets.find((item) => item.id === presetId) ?? presets[0] ?? SIZE_PRESETS[0];
  return { width: preset.width, height: preset.height };
}

function validateForm(input: {
  mode: GenerationMode;
  prompt: string;
  size: ImageSize;
  sizePresetId?: string;
  referenceImages: Array<ReferenceImageInput | UploadedImage>;
  maskImage: ReferenceImageInput | UploadedImage | null;
}): string {
  if (!input.prompt.trim()) return "请输入提示词。";
  if (input.sizePresetId !== AUTO_SIZE_PRESET_ID) {
    const sizeMessage = validateSizeForUi(input.size);
    if (sizeMessage) return sizeMessage;
  }
  if (input.mode !== "text" && input.referenceImages.length < 1) return "请先上传参考图。";
  if (input.mode === "mask" && !input.maskImage) return "请在参考图上涂抹要改的区域。";
  return "";
}

function validateSizeForUi(size: ImageSize): string {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height)) return "宽高必须是整数。";
  if (size.width < 512 || size.height < 512) return "宽高不能小于 512px。";
  if (size.width > 3840 || size.height > 3840) return "宽高不能大于 3840px。";
  if (size.width % 16 !== 0 || size.height % 16 !== 0) return "宽高必须是 16 的倍数。";
  if (Math.max(size.width, size.height) / Math.min(size.width, size.height) > 3) return "长短边比例不能超过 3:1。";
  const pixels = size.width * size.height;
  if (pixels < 655_360) return "总像素过低。";
  if (pixels > 8_294_400) return "总像素过高。";
  return "";
}

function toReferenceImageInput(image: UploadedImage | ReferenceImageInput): ReferenceImageInput {
  return {
    dataUrl: image.dataUrl,
    fileName: image.fileName
  };
}

function imageMimeFromDataUrl(dataUrl: string): string {
  return dataUrl.match(/^data:([^;,]+)/i)?.[1] || "image/png";
}

function isGenerationJobResponse(value: GenerationResponse | GenerationJobResponse): value is GenerationJobResponse {
  return Boolean((value as GenerationJobResponse).job);
}

function isInterrogationJobResponse(value: InterrogateImageResult | InterrogationJobResponse): value is InterrogationJobResponse {
  return Boolean((value as InterrogationJobResponse).job);
}

async function waitForGenerationJob(jobId: string, onPoll?: (job: GenerationJob) => void): Promise<GenerationRecord> {
  let transientFailures = 0;
  for (let attempt = 0; attempt < GENERATION_JOB_MAX_POLLS; attempt += 1) {
    await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
    let data: GenerationJobResponse;
    try {
      const response = await fetch(apiPath(`/images/jobs/${encodeURIComponent(jobId)}?t=${Date.now()}`), { cache: "no-store" });
      if (!response.ok) throw new Error(await readApiError(response, "读取生成任务失败"));
      data = (await response.json()) as GenerationJobResponse;
      transientFailures = 0;
    } catch (error) {
      transientFailures += 1;
      if (transientFailures <= 6) {
        onPoll?.({
          id: jobId,
          mode: "generate",
          status: "running",
          progress: 96,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : undefined
        });
        continue;
      }
      throw error;
    }
    const job = data.job;
    onPoll?.(job);
    if (job.status === "succeeded" && job.record) return job.record;
    if (job.status === "failed") throw new Error(job.error || "生成失败");
  }
  throw new Error("生成任务等待超时，请稍后刷新作品库查看结果。");
}

async function waitForInterrogationJob(jobId: string, onPoll?: (job: InterrogationJob) => void): Promise<InterrogationItem> {
  for (let attempt = 0; attempt < GENERATION_JOB_MAX_POLLS; attempt += 1) {
    await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
    const response = await fetch(apiPath(`/interrogate/jobs/${encodeURIComponent(jobId)}`), { cache: "no-store" });
    if (!response.ok) throw new Error(await readApiError(response, "读取反推任务失败"));
    const data = (await response.json()) as InterrogationJobResponse;
    const job = data.job;
    onPoll?.(job);
    if (job.status === "succeeded" && job.item) return job.item;
    if (job.status === "failed") throw new Error(job.error || "反推失败");
  }
  throw new Error("反推任务等待超时，请稍后刷新模板库查看结果。");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function galleryItemsForRecord(record: GenerationRecord): GalleryImageItem[] {
  return record.outputs
    .filter((output) => output.status === "succeeded" && output.asset)
    .map((output) => ({
      outputId: output.id,
      generationId: record.id,
      mode: record.mode,
      prompt: record.prompt,
      effectivePrompt: record.effectivePrompt,
      presetId: record.presetId,
      size: record.size,
      quality: record.quality,
      outputFormat: record.outputFormat,
      createdAt: record.createdAt,
      status: output.status,
      favorite: false,
      asset: output.asset!
    }));
}

function findRecoveredGenerationItems(items: GalleryImageItem[], snapshot: GenerationRequestSnapshot, pendingItem: GalleryCardItem): GalleryImageItem[] {
  const pendingCreatedAt = Date.parse(pendingItem.createdAt) || 0;
  const expectedPrompt = normalizeSearch(snapshot.body.prompt);
  const expectedFormat = String(snapshot.body.outputFormat || "").toLowerCase();
  const expectedWidth = Number(snapshot.body.size.width);
  const expectedHeight = Number(snapshot.body.size.height);
  const expectedCount = Math.max(1, Number(snapshot.body.count) || 1);

  const strictMatches = items.filter((item) => {
    const createdAt = Date.parse(item.createdAt) || 0;
    const promptMatches = normalizeSearch(item.prompt) === expectedPrompt || normalizeSearch(item.effectivePrompt || "") === expectedPrompt;
    const sizeMatches = Number(item.size?.width) === expectedWidth && Number(item.size?.height) === expectedHeight;
    const formatMatches = String(item.outputFormat || "").toLowerCase() === expectedFormat;
    const timeMatches = !pendingCreatedAt || createdAt >= pendingCreatedAt - 10_000;
    return promptMatches && sizeMatches && formatMatches && timeMatches;
  });

  if (strictMatches.length) return strictMatches.slice(0, expectedCount);

  return items
    .filter((item) => {
      const createdAt = Date.parse(item.createdAt) || 0;
      const timeMatches = !pendingCreatedAt || createdAt >= pendingCreatedAt - 10_000;
      return timeMatches && normalizeSearch(`${item.prompt} ${item.effectivePrompt || ""}`).includes(expectedPrompt);
    })
    .slice(0, expectedCount);
}

function generationFailureText(record: GenerationRecord): string {
  const outputError = record.outputs.find((output) => output.status === "failed" && output.error)?.error;
  return outputError || record.error || "没有成功生成图片。";
}

function assetPreviewUrl(assetId: string, width: number, fallbackUrl?: string): string {
  if (assetId.startsWith("data:image/")) return assetId;
  if (fallbackUrl && !isServerStoredAssetId(assetId)) return staticAssetPreviewUrl(fallbackUrl, width) ?? fallbackUrl;
  return apiPath(`/assets/${encodeURIComponent(assetId)}/preview?width=${width}`);
}

function assetPreviewSrcSet(assetId: string, fallbackUrl?: string, widths: readonly number[] = MASONRY_PREVIEW_WIDTHS): string | undefined {
  if (assetId.startsWith("data:image/")) return undefined;
  if (fallbackUrl && !isServerStoredAssetId(assetId)) {
    const previews = widths
      .map((width) => {
        const preview = staticAssetPreviewUrl(fallbackUrl, width);
        return preview ? `${preview} ${width}w` : undefined;
      })
      .filter(Boolean);
    return previews.length ? previews.join(", ") : undefined;
  }
  return widths
    .map((width) => `${assetPreviewUrl(assetId, width)} ${width}w`)
    .join(", ");
}

function staticAssetPreviewUrl(fallbackUrl: string, width: number): string | undefined {
  if (!/^\.\/[^?#]+\.(?:jpe?g|png|webp)$/iu.test(fallbackUrl)) return undefined;
  const fileName = fallbackUrl
    .replace(/^\.\/+/u, "")
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/u, ".webp");
  if (!fileName) return undefined;

  const closestWidth = [...MASONRY_PREVIEW_WIDTHS, ...LIGHTBOX_PREVIEW_WIDTHS]
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .sort((left, right) => left - right)
    .find((candidate) => candidate >= width) ?? 2048;
  return `./thumbs/${closestWidth}/${fileName}`;
}

function isServerStoredAssetId(assetId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(assetId);
}


function canvasContainsPaint(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 8) return true;
  }
  return false;
}

function fileToUploadedImage(file: File): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} 读取失败。`));
    reader.onload = async () => {
      const dataUrl = String(reader.result || "");
      if (!dataUrl.startsWith("data:image/")) {
        reject(new Error(`${file.name} 不是有效图片。`));
        return;
      }
      const dimensions = await loadImageDimensions(dataUrl).catch(() => ({ width: 1024, height: 1024 }));
      resolve({
        id: createId(),
        dataUrl,
        fileName: file.name || "image.png",
        width: dimensions.width,
        height: dimensions.height,
        previewUrl: dataUrl
      });
    };
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({
      width: image.naturalWidth || image.width || 1024,
      height: image.naturalHeight || image.height || 1024
    });
    image.onerror = () => reject(new Error("无法读取图片尺寸。"));
    image.src = src;
  });
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string | { message?: string; code?: string } };
    const upstream = typeof body.error === "string" ? body.error : body.error?.message || body.error?.code;
    return upstream ? `${fallback}: ${upstream}` : `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}

async function writeClipboardText(value: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // WebView / localhost permission policies can reject the async Clipboard API; fall back below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function collectionQueryString(input: {
  query: string;
  favoritesOnly: boolean;
  statusFilter: ReferenceStatusFilter;
}): string {
  const params = new URLSearchParams();
  const query = input.query.trim();
  if (query) params.set("query", query);
  if (input.favoritesOnly) params.set("favorite", "1");
  if (input.statusFilter !== "all") params.set("status", input.statusFilter);
  params.set("limit", String(COLLECTION_FETCH_LIMIT));
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function matchesStatusFilter(status: GalleryImageItem["status"], filter: ReferenceStatusFilter, clientStatus?: ClientCardStatus): boolean {
  if (filter === "all") return true;
  if (filter === "failed") return status === "failed" || clientStatus === "failed";
  return !clientStatus && (status === undefined || status === "succeeded");
}

function sizePresetIdForSize(presets: SizePreset[], size: ImageSize): string {
  return presets.find((preset) => preset.width === size.width && preset.height === size.height)?.id ?? "custom";
}

function qualityLabel(value: ImageQuality): string {
  const labels: Record<ImageQuality, string> = {
    auto: "自动",
    low: "草稿",
    medium: "标准",
    high: "高质量"
  };
  return labels[value];
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function shortSizeLabel(preset: SizePreset): string {
  if (/^\d+:\d+$/u.test(preset.label.trim())) return preset.label.trim();

  const w = preset.width;
  const h = preset.height;
  const ratio = w / h;

  if (Math.abs(ratio - 1) < 0.02) return "1:1";
  if (Math.abs(ratio - 9/16) < 0.02) return "9:16";
  if (Math.abs(ratio - 16/9) < 0.02) return "16:9";
  if (Math.abs(ratio - 3/4) < 0.02) return "3:4";
  if (Math.abs(ratio - 4/3) < 0.02) return "4:3";
  if (Math.abs(ratio - 2/3) < 0.02) return "2:3";
  if (Math.abs(ratio - 3/2) < 0.02) return "3:2";

  const divisor = gcd(w, h);
  return `${w / divisor}:${h / divisor}`;
}

function promptExcerpt(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function normalizeSearch(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function normalizeWheelDelta(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function stopScrollMomentum(momentum: { velocity: number; frame: number | null }): void {
  momentum.velocity = 0;
  if (momentum.frame !== null) {
    window.cancelAnimationFrame(momentum.frame);
    momentum.frame = null;
  }
}

function getPinchGesture(points: Map<number, { x: number; y: number }>): { distance: number; centerX: number; centerY: number } | null {
  const [first, second] = Array.from(points.values());
  if (!first || !second) return null;
  const deltaX = second.x - first.x;
  const deltaY = second.y - first.y;
  return {
    distance: Math.hypot(deltaX, deltaY),
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function defaultLightboxCoverZoom(size: ImageSize): number {
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  const imageRatio = Math.max(0.01, size.width / Math.max(1, size.height));
  const viewportRatio = viewportWidth / viewportHeight;
  const coverScale = viewportRatio > imageRatio
    ? viewportRatio / imageRatio
    : imageRatio / viewportRatio;
  const safeCoverScale = Math.ceil(Math.max(1, coverScale * 1.015) * 100) / 100;
  return clamp(safeCoverScale, LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM);
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
