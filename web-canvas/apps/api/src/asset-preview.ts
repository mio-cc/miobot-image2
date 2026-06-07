import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import sharp from "sharp";
import { getStoredAssetFile, readStoredAsset } from "./image-generation.js";
import { runtimePaths } from "./runtime.js";

const PREVIEW_WIDTHS = [256, 512, 1024, 2048] as const;
const MAX_PREVIEW_WIDTH = PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1];
const PREVIEW_WEBP_EFFORT = 2;
const PREVIEW_WEBP_QUALITY = 76;
const previewBuilds = new Map<string, Promise<Buffer>>();

export type PreviewWidthResult =
  | {
      ok: true;
      width: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export interface StoredAssetPreview {
  bytes: Buffer;
  width: number;
}

export function parsePreviewWidth(value: string | undefined): PreviewWidthResult {
  if (!value || !/^\d+$/u.test(value)) {
    return {
      ok: false,
      code: "invalid_width",
      message: "Preview width must be an integer."
    };
  }

  const requestedWidth = Number.parseInt(value ?? "", 10);

  if (!Number.isInteger(requestedWidth)) {
    return {
      ok: false,
      code: "invalid_width",
      message: "Preview width must be an integer."
    };
  }

  if (requestedWidth < 1 || requestedWidth > MAX_PREVIEW_WIDTH) {
    return {
      ok: false,
      code: "invalid_width",
      message: `Preview width must be between 1 and ${MAX_PREVIEW_WIDTH}.`
    };
  }

  return {
    ok: true,
    width: PREVIEW_WIDTHS.find((width) => width >= requestedWidth) ?? MAX_PREVIEW_WIDTH
  };
}

export async function readStoredAssetPreview(assetId: string, width: number): Promise<StoredAssetPreview | undefined> {
  const assetFile = getStoredAssetFile(assetId);
  if (!assetFile) {
    return undefined;
  }

  const previewPath = resolvePreviewPath(assetFile.id, width);
  const cached = await readCachedPreview(previewPath);
  if (cached) {
    return {
      bytes: cached,
      width
    };
  }

  const inFlight = previewBuilds.get(previewPath);
  if (inFlight) {
    return {
      bytes: await inFlight,
      width
    };
  }

  const asset = await readStoredAsset(assetId);
  if (!asset) {
    return undefined;
  }

  const build = buildStoredAssetPreview(asset.bytes, previewPath, width);
  previewBuilds.set(previewPath, build);

  try {
    return {
      bytes: await build,
      width
    };
  } finally {
    previewBuilds.delete(previewPath);
  }
}

async function buildStoredAssetPreview(assetBytes: Buffer, previewPath: string, width: number): Promise<Buffer> {
  const bytes = await sharp(assetBytes)
    .rotate()
    .resize({
      width,
      withoutEnlargement: true
    })
    .webp({
      effort: PREVIEW_WEBP_EFFORT,
      quality: PREVIEW_WEBP_QUALITY
    })
    .toBuffer();

  await writeFile(previewPath, bytes);
  return bytes;
}

async function readCachedPreview(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch {
    return undefined;
  }
}

function resolvePreviewPath(assetId: string, width: number): string {
  const filePath = resolve(runtimePaths.assetPreviewsDir, `${safeFileSegment(assetId)}-${width}.webp`);
  if (!isInsideDirectory(filePath, runtimePaths.assetPreviewsDir)) {
    throw new Error("Invalid preview cache path.");
  }

  return filePath;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const localPath = relative(directory, filePath);
  return Boolean(localPath) && !localPath.startsWith("..") && !isAbsolute(localPath);
}
