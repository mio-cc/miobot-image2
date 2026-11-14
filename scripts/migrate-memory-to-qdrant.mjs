#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { search } from '@orama/orama';
import { restoreFromFile } from '@orama/plugin-data-persistence/server';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/migrate-memory-to-qdrant.mjs --source DIR --url URL --api-key KEY [--collection miobot_memory] [--dimensions 1536] [--apply]');
  console.log('Default is dry-run. --apply writes to Qdrant. The source path is never modified.');
  process.exit(0);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const source = path.resolve(option('--source', '/var/lib/miobot-v2/memory'));
const manifestPath = path.resolve(option('--manifest', path.join(source, 'namespaces.json')));
const url = String(option('--url', process.env.QDRANT_URL || '')).replace(/\/+$/, '');
const apiKey = String(option('--api-key', process.env.QDRANT_API_KEY || ''));
const collection = String(option('--collection', process.env.QDRANT_COLLECTION || 'miobot_memory'));
const dimensions = Math.max(1, Number(option('--dimensions', process.env.MIOBOT_EMBEDDING_DIMENSIONS || 1536)) || 1536);
const pageSize = Math.max(10, Number(option('--page-size', 500)) || 500);
const batchSize = Math.max(1, Number(option('--batch', 64)) || 64);
const maxDocs = Math.max(0, Number(option('--limit', 0)) || 0);
const apply = args.includes('--apply');
if (!args.includes('--source') && !fs.existsSync(source)) {
  console.error('source not found: ' + source);
  process.exit(2);
}
if (!url || !apiKey) {
  console.error('missing QDRANT_URL or QDRANT_API_KEY');
  process.exit(2);
}

function hash16(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}
function pointId(value) {
  const hex = createHash('sha256').update(String(value)).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}
function dayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return part('year') + '-' + part('month') + '-' + part('day');
}
async function request(method, route, body) {
  const response = await fetch(url + route, {
    method,
    headers: { 'api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error('qdrant_http_' + response.status + ':' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}
async function ensureCollection() {
  let info;
  try { info = await request('GET', '/collections/' + encodeURIComponent(collection)); } catch { info = {}; }
  const size = Number(info?.result?.config?.params?.vectors?.size || 0);
  if (size && size !== dimensions) throw new Error('qdrant_dimension_mismatch:' + size + '!=' + dimensions);
  if (!size) {
    await request('PUT', '/collections/' + encodeURIComponent(collection) + '?wait=true', {
      vectors: { size: dimensions, distance: 'Cosine' },
      optimizers_config: { default_segment_number: 2 },
    });
  }
  for (const [field, schema] of [['botId','keyword'],['scope','keyword'],['groupId','keyword'],['userId','keyword'],['messageId','keyword'],['dayBucket','keyword'],['createdAt','datetime'],['text','text']]) {
    try { await request('PUT', '/collections/' + encodeURIComponent(collection) + '/index?wait=true', { field_name: field, field_schema: schema }); } catch {}
  }
}
async function upsert(points) {
  for (let i = 0; i < points.length; i += batchSize) {
    await request('PUT', '/collections/' + encodeURIComponent(collection) + '/points?wait=true', { points: points.slice(i, i + batchSize) });
  }
}

async function main() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (error) { throw new Error("cannot read manifest " + manifestPath + ": " + String(error?.message || error)); }
  const entries = Object.entries(manifest || {});
  if (!entries.length) throw new Error("manifest has no namespaces: " + manifestPath);
  console.log("source=" + source);
  console.log("manifest=" + manifestPath);
  console.log("target=" + url + " collection=" + collection + " dimensions=" + dimensions);
  console.log("mode=" + (apply ? "APPLY" : "DRY RUN") + " namespaces=" + entries.length + " page=" + pageSize + " batch=" + batchSize);
  if (apply) await ensureCollection();
  let sourceTotal = 0; let migrated = 0; let skipped = 0; let pageCount = 0;
  for (const [namespaceKey, namespace] of entries) {
    const file = path.join(source, hash16(namespaceKey) + ".json");
    if (!fs.existsSync(file)) { console.log("skip missing " + file); continue; }
    console.log("namespace " + namespaceKey + " file " + file);
    const db = await restoreFromFile("json", file);
    const allDocs = Object.values(db.data?.docs?.docs || {});
    let offset = 0; let namespaceCount = 0;
    while (offset < allDocs.length) {
      const docs = allDocs.slice(offset, offset + pageSize);
      const points = [];
      for (const doc of docs) {
        sourceTotal += 1;
        if (maxDocs > 0 && sourceTotal > maxDocs) break;
        const vector = Array.isArray(doc.embedding) ? doc.embedding.map(Number) : [];
        if (!doc.id || vector.length !== dimensions) { skipped += 1; continue; }
        const createdAt = String(doc.createdAt || new Date().toISOString());
        points.push({
          id: pointId(doc.id),
          vector,
          payload: {
            id: String(doc.id), botId: String(doc.botId || ""), scope: String(doc.scope || (namespace.kind === "private" ? "private_user" : "group_shared")),
            groupId: String(doc.groupId || ""), userId: String(doc.userId || ""), authorName: String(doc.authorName || doc.userId || ""),
            role: String(doc.role || "user"), text: String(doc.text || ""), createdAt, dayBucket: dayKey(createdAt),
            messageId: String(doc.messageId || ""), embeddingModel: String(doc.embeddingModel || ""), embeddingDimensions: dimensions,
            source: "migration", attachments: [],
          },
        });
      }
      if (apply && points.length) await upsert(points);
      namespaceCount += points.length; migrated += points.length; pageCount += 1;
      if (maxDocs > 0 && sourceTotal >= maxDocs) break;
      offset += pageSize;
      if (maxDocs > 0 && sourceTotal >= maxDocs) break;
    }
    console.log("  docs=" + namespaceCount + (apply ? " upserted=" + namespaceCount : " (dry)") + (skipped ? " skipped=" + skipped : ""));
    if (maxDocs > 0 && sourceTotal >= maxDocs) break;
  }
  if (apply) {
    const count = await request("POST", "/collections/" + encodeURIComponent(collection) + "/points/count", { exact: true });
    console.log("qdrant_count=" + (count?.result?.count ?? 0));
  }
  console.log("done source_docs=" + sourceTotal + " points=" + migrated + " skipped=" + skipped + " pages=" + pageCount);
}

main().catch((error) => { console.error(String(error?.message || error)); process.exitCode = 1; });
