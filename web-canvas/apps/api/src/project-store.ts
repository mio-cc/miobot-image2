import { and, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import type {
  GeneratedAsset,
  GalleryImageItem,
  GalleryResponse,
  GenerationRecord as ApiGenerationRecord,
  GenerationStatus,
  ImageMode,
  ImageQuality,
  InterrogationItem,
  InterrogationResponse,
  OutputFormat,
  OutputStatus,
  ProjectState
} from "./contracts.js";
import { db } from "./database.js";
import { assets, generationOutputs, generationRecords, generationReferenceAssets, interrogations, projects } from "./schema.js";

export const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PROJECT_NAME = "Default Project";
const fallbackWarnings = new Set<string>();
const DEFAULT_COLLECTION_LIMIT = 120;
const MAX_COLLECTION_LIMIT = 240;

interface ProjectSnapshotInput {
  name?: string;
  snapshotJson: string;
}

interface CollectionQuery {
  query?: string;
  favorite?: boolean;
  status?: "all" | "done" | "failed";
  limit?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseSnapshot(snapshotJson: string): unknown | null {
  return JSON.parse(snapshotJson) as unknown;
}

export function ensureDefaultProject(): void {
  const existing = getDefaultProjectRow();

  if (existing) {
    return;
  }
  if (defaultProjectRowExists()) {
    return;
  }

  const createdAt = nowIso();
  db.insert(projects)
    .values({
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      snapshotJson: "null",
      createdAt,
      updatedAt: createdAt
    })
    .run();
}

export function saveProjectSnapshot(input: ProjectSnapshotInput): ProjectState {
  ensureDefaultProject();

  const updatedAt = nowIso();
  const current = getDefaultProjectRow();

  db.update(projects)
    .set({
      name: input.name ?? current?.name ?? DEFAULT_PROJECT_NAME,
      snapshotJson: input.snapshotJson,
      updatedAt
    })
    .where(eq(projects.id, DEFAULT_PROJECT_ID))
    .run();

  return getProjectState();
}

export function getProjectState(): ProjectState {
  ensureDefaultProject();

  const project = getDefaultProjectRow();

  if (!project) {
    return {
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      snapshot: null,
      history: getGenerationHistory(),
      updatedAt: nowIso()
    };
  }

  return {
    id: project.id,
    name: project.name,
    snapshot: parseSnapshot(project.snapshotJson),
    history: getGenerationHistory(),
    updatedAt: project.updatedAt
  };
}

export function getGalleryImages(options: CollectionQuery = {}): GalleryResponse {
  if (options.status === "failed") {
    return {
      items: [],
      total: 0
    };
  }

  const limit = clampCollectionLimit(options.limit);
  const conditions: SQL[] = [eq(generationOutputs.status, "succeeded")];
  if (options.favorite) {
    conditions.push(eq(generationOutputs.favorite, true));
  }

  const query = normalizeQuery(options.query);
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(
      or(
        like(generationRecords.prompt, pattern),
        like(generationRecords.effectivePrompt, pattern),
        like(generationRecords.presetId, pattern),
        like(generationRecords.outputFormat, pattern)
      )!
    );
  }

  const rows = db
    .select({
      output: generationOutputs,
      generation: generationRecords,
      asset: assets
    })
    .from(generationOutputs)
    .innerJoin(generationRecords, eq(generationOutputs.generationId, generationRecords.id))
    .innerJoin(assets, eq(generationOutputs.assetId, assets.id))
    .where(and(...conditions))
    .orderBy(desc(generationOutputs.createdAt))
    .limit(limit)
    .all();

  return {
    items: rows
      .map(({ output, generation, asset }): GalleryImageItem | undefined => {
        const generatedAsset = toGeneratedAsset(asset);
        if (!generatedAsset) return undefined;
        return {
          outputId: output.id,
          generationId: generation.id,
          mode: generation.mode as ImageMode,
          prompt: generation.prompt,
          effectivePrompt: generation.effectivePrompt,
          presetId: generation.presetId,
          size: {
            width: generation.width,
            height: generation.height
          },
          quality: generation.quality as ImageQuality,
          outputFormat: generation.outputFormat as OutputFormat,
          createdAt: output.createdAt,
          status: output.status as OutputStatus,
          favorite: Boolean(output.favorite),
          asset: generatedAsset
        };
      })
      .filter((item): item is GalleryImageItem => Boolean(item))
  };
}

export function setGalleryOutputFavorite(outputId: string, favorite: boolean): boolean {
  const result = db
    .update(generationOutputs)
    .set({ favorite })
    .where(eq(generationOutputs.id, outputId))
    .run();
  return result.changes > 0;
}

export function deleteGalleryOutput(outputId: string): boolean {
  const result = db.delete(generationOutputs).where(eq(generationOutputs.id, outputId)).run();
  return result.changes > 0;
}

export function getInterrogations(options: CollectionQuery = {}): InterrogationResponse {
  if (options.status === "failed") {
    return {
      items: [],
      total: 0
    };
  }

  const limit = clampCollectionLimit(options.limit);
  const conditions: SQL[] = [];
  if (options.favorite) {
    conditions.push(eq(interrogations.favorite, true));
  }

  const query = normalizeQuery(options.query);
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(
      or(
        like(interrogations.prompt, pattern),
        like(interrogations.templatePrompt, pattern),
        like(interrogations.fileName, pattern)
      )!
    );
  }

  const rows = db
    .select({
      interrogation: interrogations,
      asset: assets
    })
    .from(interrogations)
    .innerJoin(assets, eq(interrogations.assetId, assets.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(interrogations.createdAt))
    .limit(limit)
    .all();

  return {
    items: rows
      .map(({ interrogation, asset }): InterrogationItem | undefined => {
        const generatedAsset = toGeneratedAsset(asset);
        if (!generatedAsset) return undefined;
        return {
          id: interrogation.id,
          prompt: interrogation.prompt,
          templatePrompt: interrogation.templatePrompt,
          fileName: interrogation.fileName ?? undefined,
          createdAt: interrogation.createdAt,
          favorite: Boolean(interrogation.favorite),
          asset: generatedAsset
        };
      })
      .filter((item): item is InterrogationItem => Boolean(item))
  };
}

export function setInterrogationFavorite(id: string, favorite: boolean): boolean {
  const result = db
    .update(interrogations)
    .set({ favorite })
    .where(eq(interrogations.id, id))
    .run();
  return result.changes > 0;
}

function clampCollectionLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_COLLECTION_LIMIT;
  }

  return Math.max(1, Math.min(MAX_COLLECTION_LIMIT, Math.trunc(value)));
}

function normalizeQuery(value: string | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function getDefaultProjectRow(): (typeof projects.$inferSelect) | undefined {
  try {
    return db.select().from(projects).where(eq(projects.id, DEFAULT_PROJECT_ID)).get();
  } catch (error) {
    warnOnce(
      "project-read-fallback",
      `Project row could not be read; returning a blank canvas fallback. ${formatErrorSummary(error)}`
    );
    return undefined;
  }
}

function defaultProjectRowExists(): boolean {
  try {
    const row = db.select({ id: projects.id }).from(projects).where(eq(projects.id, DEFAULT_PROJECT_ID)).get();
    return Boolean(row);
  } catch {
    return true;
  }
}

function getGenerationHistory(): ApiGenerationRecord[] {
  try {
    return readGenerationHistory();
  } catch (error) {
    warnOnce(
      "history-read-fallback",
      `Generation history could not be read; returning an empty history. ${formatErrorSummary(error)}`
    );
    return [];
  }
}

function warnOnce(key: string, message: string): void {
  if (fallbackWarnings.has(key)) {
    return;
  }

  fallbackWarnings.add(key);
  console.warn(message);
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const codeValue = (error as { code?: unknown }).code;
    const code = typeof codeValue === "string" ? `${codeValue}: ` : "";
    return `${code}${error.message}`;
  }

  return String(error);
}

function readGenerationHistory(): ApiGenerationRecord[] {
  const records = db.select().from(generationRecords).orderBy(desc(generationRecords.createdAt)).limit(20).all();
  if (records.length === 0) {
    return [];
  }

  const generationIds = records.map((record) => record.id);
  const outputs = db
    .select()
    .from(generationOutputs)
    .where(inArray(generationOutputs.generationId, generationIds))
    .orderBy(generationOutputs.createdAt)
    .all();
  const referenceRows = db
    .select()
    .from(generationReferenceAssets)
    .where(inArray(generationReferenceAssets.generationId, generationIds))
    .all()
    .sort((left, right) =>
      left.generationId === right.generationId
        ? left.position - right.position
        : left.generationId.localeCompare(right.generationId)
    );

  const assetIds = outputs.flatMap((output) => (output.assetId ? [output.assetId] : []));
  const assetRows =
    assetIds.length > 0 ? db.select().from(assets).where(inArray(assets.id, assetIds)).all() : [];
  const assetById = new Map(assetRows.map((asset) => [asset.id, asset]));

  const outputsByGenerationId = new Map<string, typeof outputs>();
  for (const output of outputs) {
    const existing = outputsByGenerationId.get(output.generationId) ?? [];
    existing.push(output);
    outputsByGenerationId.set(output.generationId, existing);
  }
  const referenceAssetIdsByGenerationId = new Map<string, string[]>();
  for (const referenceRow of referenceRows) {
    const existing = referenceAssetIdsByGenerationId.get(referenceRow.generationId) ?? [];
    existing.push(referenceRow.assetId);
    referenceAssetIdsByGenerationId.set(referenceRow.generationId, existing);
  }

  return records.flatMap((record) => {
    const mappedOutputs = (outputsByGenerationId.get(record.id) ?? []).map((output) => ({
      id: output.id,
      status: output.status as OutputStatus,
      asset: output.assetId ? toGeneratedAsset(assetById.get(output.assetId)) : undefined,
      error: output.error ?? undefined
    }));

    if (mappedOutputs.length === 0) {
      return [];
    }

    return [
      {
        id: record.id,
        mode: record.mode as ImageMode,
        prompt: record.prompt,
        effectivePrompt: record.effectivePrompt,
        presetId: record.presetId,
        size: {
          width: record.width,
          height: record.height
        },
        quality: record.quality as ImageQuality,
        outputFormat: record.outputFormat as OutputFormat,
        count: record.count,
        status: record.status as GenerationStatus,
        error: record.error ?? undefined,
        referenceAssetIds: referenceAssetIdsByGenerationId.get(record.id) ?? (record.referenceAssetId ? [record.referenceAssetId] : undefined),
        referenceAssetId: record.referenceAssetId ?? undefined,
        createdAt: record.createdAt,
        outputs: mappedOutputs
      }
    ];
  });
}

function toGeneratedAsset(asset: (typeof assets.$inferSelect) | undefined): GeneratedAsset | undefined {
  if (!asset) {
    return undefined;
  }

  return {
    id: asset.id,
    url: `/api/assets/${asset.id}`,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    cloud:
      asset.cloudProvider === "cos" && (asset.cloudStatus === "uploaded" || asset.cloudStatus === "failed")
        ? {
            provider: asset.cloudProvider,
            status: asset.cloudStatus,
            lastError: asset.cloudError ?? undefined,
            uploadedAt: asset.cloudUploadedAt ?? undefined
          }
        : undefined
  };
}
