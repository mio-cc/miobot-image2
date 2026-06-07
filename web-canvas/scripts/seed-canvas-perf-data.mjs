import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const Database = apiRequire("better-sqlite3");
const sharp = apiRequire("sharp");

const dataDir = resolve(process.argv[2] ?? process.env.DATA_DIR ?? "./.perf-data");
const itemCount = Number.parseInt(process.argv[3] ?? process.env.PERF_CANVAS_ITEMS ?? "120", 10);
const safeItemCount = Number.isFinite(itemCount) ? Math.max(1, Math.min(500, itemCount)) : 120;

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(resolve(dataDir, "assets"), { recursive: true });
mkdirSync(resolve(dataDir, "asset-previews"), { recursive: true });

const db = new Database(resolve(dataDir, "gpt-image-canvas.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  cloud_provider TEXT,
  cloud_bucket TEXT,
  cloud_region TEXT,
  cloud_object_key TEXT,
  cloud_status TEXT,
  cloud_error TEXT,
  cloud_uploaded_at TEXT,
  cloud_etag TEXT,
  cloud_request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_records (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  prompt TEXT NOT NULL,
  effective_prompt TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  quality TEXT NOT NULL,
  output_format TEXT NOT NULL,
  count INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  reference_asset_id TEXT REFERENCES assets(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_outputs (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generation_records(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id),
  error TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS generation_outputs_created_at_idx ON generation_outputs(created_at);
CREATE INDEX IF NOT EXISTS generation_outputs_generation_id_idx ON generation_outputs(generation_id);
CREATE INDEX IF NOT EXISTS generation_outputs_asset_id_idx ON generation_outputs(asset_id);
`);

const insertAsset = db.prepare(`
  INSERT INTO assets (
    id, file_name, relative_path, mime_type, width, height, created_at
  ) VALUES (
    @id, @fileName, @relativePath, @mimeType, @width, @height, @createdAt
  )
`);

const insertGeneration = db.prepare(`
  INSERT INTO generation_records (
    id, mode, prompt, effective_prompt, preset_id, width, height, quality,
    output_format, count, status, created_at
  ) VALUES (
    @id, @mode, @prompt, @effectivePrompt, @presetId, @width, @height,
    @quality, @outputFormat, @count, @status, @createdAt
  )
`);

const insertOutput = db.prepare(`
  INSERT INTO generation_outputs (
    id, generation_id, status, asset_id, favorite, created_at
  ) VALUES (
    @id, @generationId, @status, @assetId, @favorite, @createdAt
  )
`);

const dimensions = [
  [768, 1024],
  [1024, 1024],
  [1024, 768],
  [896, 1152],
  [1152, 896],
  [832, 1216],
  [1216, 832]
];

const now = Date.now();
const transaction = db.transaction((rows) => {
  for (const row of rows) {
    insertAsset.run(row.asset);
    insertGeneration.run(row.generation);
    insertOutput.run(row.output);
  }
});

const rows = [];

for (let index = 0; index < safeItemCount; index += 1) {
  const [width, height] = dimensions[index % dimensions.length];
  const createdAt = new Date(now - index * 60_000).toISOString();
  const assetId = `perf-asset-${String(index + 1).padStart(4, "0")}`;
  const generationId = `perf-generation-${String(index + 1).padStart(4, "0")}`;
  const outputId = `perf-output-${String(index + 1).padStart(4, "0")}`;
  const fileName = `${assetId}.webp`;

  rows.push({
    asset: {
      id: assetId,
      fileName,
      relativePath: `assets/${fileName}`,
      mimeType: "image/webp",
      width,
      height,
      createdAt
    },
    generation: {
      id: generationId,
      mode: "generate",
      prompt: `Performance fixture ${index + 1}: layered editorial image with detail, color, texture, and enough prompt text to exercise card wrapping.`,
      effectivePrompt: `Performance fixture ${index + 1}: layered editorial image with detail, color, texture, and enough prompt text to exercise card wrapping.`,
      presetId: "perf",
      width,
      height,
      quality: "medium",
      outputFormat: "webp",
      count: 1,
      status: "succeeded",
      createdAt
    },
    output: {
      id: outputId,
      generationId,
      status: "succeeded",
      assetId,
      favorite: index % 9 === 0 ? 1 : 0,
      createdAt
    }
  });
}

transaction(rows);

await Promise.all(rows.map(async (row, index) => {
  const width = row.asset.width;
  const height = row.asset.height;
  const hue = (index * 37) % 360;
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="hsl(${hue}, 72%, 62%)"/>
          <stop offset="1" stop-color="hsl(${(hue + 72) % 360}, 76%, 38%)"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="${width * 0.72}" cy="${height * 0.24}" r="${Math.min(width, height) * 0.24}" fill="rgba(255,255,255,.28)"/>
      <rect x="${width * 0.08}" y="${height * 0.68}" width="${width * 0.76}" height="${height * 0.08}" rx="18" fill="rgba(255,255,255,.32)"/>
      <rect x="${width * 0.08}" y="${height * 0.8}" width="${width * 0.54}" height="${height * 0.045}" rx="14" fill="rgba(255,255,255,.22)"/>
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .webp({ quality: 56, effort: 2 })
    .toFile(resolve(dataDir, row.asset.relativePath));
}));

db.close();

console.log(JSON.stringify({
  dataDir,
  itemCount: safeItemCount,
  database: resolve(dataDir, "gpt-image-canvas.sqlite"),
  assetsDir: resolve(dataDir, "assets")
}, null, 2));
