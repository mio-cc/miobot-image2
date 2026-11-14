#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const DEFAULTS = {
  envFile: '/etc/miobot-v2.env',
  service: 'miobot-v2',
  collection: 'miobot_memory',
  dimensions: 1536,
  heapMb: 2048,
  healthUrl: 'http://127.0.0.1:3018/canvas-api/health',
};

function usage() {
  console.log('Usage: node scripts/qdrant-memory-cutover.mjs --apply [options]');
  console.log('');
  console.log('Checks Qdrant, stops miobot, backs up Orama, dry-runs + applies migration,');
  console.log('switches MIOBOT_MEMORY_BACKEND=qdrant, starts the service and verifies health.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                 perform migration and switch (default is check only)');
  console.log('  --source PATH           Orama memory dir (default: runtimeDir/memory)');
  console.log('  --env-file PATH         environment file (default: /etc/miobot-v2.env)');
  console.log('  --url URL               Qdrant URL (or QDRANT_URL from env file)');
  console.log('  --collection NAME       default miobot_memory');
  console.log('  --dimensions N          default from config or 1536');
  console.log('  --heap-mb N             migration Node heap, default 2048');
  console.log('  --service NAME          systemd service, default miobot-v2');
  console.log('  --enable-bot            set MIOBOT_ENABLE_BOT=1 after cutover');
  console.log('  --no-start              do not start service after cutover');
  console.log('  --skip-dry-run          skip migration dry-run (not recommended)');
  console.log('  --help                  print this help');
}

function parseArgs(argv) {
  const o = { ...DEFAULTS, dimensions: 0, apply: false, enableBot: false, start: true, skipDryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--apply') { o.apply = true; continue; }
    if (arg === '--enable-bot') { o.enableBot = true; continue; }
    if (arg === '--no-start') { o.start = false; continue; }
    if (arg === '--skip-dry-run') { o.skipDryRun = true; continue; }
    if (arg === '--help' || arg === '-h') { o.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error('unknown argument: ' + arg);
    const value = argv[++i];
    if (value === undefined) throw new Error('missing value: ' + arg);
    if (arg === '--source') o.source = value;
    else if (arg === '--env-file') o.envFile = value;
    else if (arg === '--url') o.url = value;
    else if (arg === '--collection') o.collection = value;
    else if (arg === '--dimensions') o.dimensions = Number(value);
    else if (arg === '--heap-mb') o.heapMb = Number(value);
    else if (arg === '--service') o.service = value;
    else throw new Error('unknown option: ' + arg);
  }
  o.dimensions = Math.max(0, Math.trunc(o.dimensions) || 0);
  o.heapMb = Math.max(512, Math.trunc(o.heapMb) || 2048);
  return o;
}

function readEnv(file) {
  const values = {};
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch {}
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return { values, lines };
}

function valueOr(values, keys, fallback = '') {
  for (const key of keys) if (values[key] !== undefined && String(values[key]).trim()) return String(values[key]).trim();
  return fallback;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || APP_DIR,
    env: opts.env || process.env,
    stdio: opts.stdio || 'inherit',
    encoding: 'utf8',
    timeout: opts.timeout || 0,
  });
  if (result.error) throw new Error(command + ': ' + result.error.message);
  if (result.status !== 0 && !opts.allowFailure) throw new Error(command + ' exited ' + result.status);
  return result;
}

function updateEnv(file, updates) {
  const { lines } = readEnv(file);
  const keys = new Set(Object.keys(updates));
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    const eq = trimmed.indexOf("=");
    return eq < 1 || !keys.has(trimmed.slice(0, eq));
  });
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  for (const [key, value] of Object.entries(updates)) kept.push(key + "=" + value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".qdrant-" + process.pid + ".tmp";
  fs.writeFileSync(temp, kept.join("\\n") + "\\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function configDimensions(configPath, envValues, optionDimensions) {
  if (optionDimensions > 0) return optionDimensions;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const value = Number(config?.orchestration?.memory?.embeddingDimensions || 0);
    if (value > 0) return value;
  } catch {}
  return Number(envValues.MIOBOT_EMBEDDING_DIMENSIONS || DEFAULTS.dimensions) || DEFAULTS.dimensions;
}

async function fetchQdrant(baseUrl, apiKey, collection) {
  const headers = { "api-key": apiKey, "content-type": "application/json" };
  const collectionUrl = baseUrl.replace(/\/+$/, "") + "/collections/" + encodeURIComponent(collection);
  const info = await fetch(collectionUrl, { headers, signal: AbortSignal.timeout(10000) });
  if (info.status === 404) return { exists: false };
  if (!info.ok) throw new Error("qdrant_http_" + info.status);
  let points = 0;
  try {
    const count = await fetch(collectionUrl + "/points/count", { method: "POST", headers, body: JSON.stringify({ exact: true }), signal: AbortSignal.timeout(10000) });
    if (count.ok) points = Number((await count.json())?.result?.count || 0);
  } catch {}
  const json = await info.json();
  return { exists: true, vectorSize: Number(json?.result?.config?.params?.vectors?.size || 0), points };
}

function isActive(service) {
  const result = spawnSync("systemctl", ["is-active", "--quiet", service], { stdio: "ignore" });
  return result.status === 0;
}

function waitHealth(url, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const result = spawnSync("curl", ["-fsS", "--max-time", "3", url], { encoding: "utf8" });
      if (result.status === 0) return true;
    } catch {}
    spawnSync("sleep", ["2"]);
  }
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { usage(); return; }
  const env = readEnv(opts.envFile).values;
  const dataDir = valueOr(env, ["MIOBOT_RUNTIME_DIR", "DATA_DIR"], "/var/lib/miobot-v2");
  const source = path.resolve(opts.source || path.join(dataDir, "memory"));
  const configPath = valueOr(env, ["MIOBOT_CONFIG_PATH"], path.join(dataDir, "config.json"));
  const url = String(opts.url || env.QDRANT_URL || process.env.QDRANT_URL || "").replace(/\/+$/, "");
  const key = String(process.env.QDRANT_API_KEY || env.QDRANT_API_KEY || "");
  const collection = String(opts.collection || env.QDRANT_COLLECTION || DEFAULTS.collection);
  const dimensions = configDimensions(configPath, env, opts.dimensions);
  const migration = path.join(APP_DIR, "scripts/migrate-memory-to-qdrant.mjs");
  const service = opts.service || env.MIOBOT_SERVICE || DEFAULTS.service;
  const qdrantUrl = url || "(missing)";
  console.log("Qdrant memory cutover");
  console.log("env-file=" + opts.envFile);
  console.log("source=" + source);
  console.log("qdrant=" + qdrantUrl);
  console.log("collection=" + collection + " dimensions=" + dimensions);
  console.log("mode=" + (opts.apply ? "APPLY" : "CHECK"));
  if (!url) throw new Error("QDRANT_URL missing (pass --url or add QDRANT_URL to " + opts.envFile + ")");
  if (!key) throw new Error("QDRANT_API_KEY missing (set it in the environment or " + opts.envFile + ")");
  if (!fs.existsSync(source)) throw new Error("source memory directory missing: " + source);
  if (!fs.existsSync(migration)) throw new Error("migration script missing: " + migration);
  const before = await fetchQdrant(url, key, collection);
  console.log("qdrant-exists=" + Boolean(before.exists) + " vector-size=" + (before.vectorSize || "?") + " points=" + (before.points || 0));
  if (before.exists && before.vectorSize && before.vectorSize !== dimensions) throw new Error("vector dimension mismatch: qdrant=" + before.vectorSize + " config=" + dimensions);
  if (!opts.apply) {
    console.log("CHECK OK. Re-run with --apply to migrate and switch.");
    return;
  }
  if (process.platform !== "linux") throw new Error("--apply is supported on Linux only");
  if (typeof process.getuid === "function" && process.getuid() !== 0) throw new Error("--apply must run as root");
  const wasActive = isActive(service);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const memoryBackup = source + ".orama-backup-" + stamp;
  const envBackup = opts.envFile + ".qdrant-backup-" + stamp;
  console.log("service-active=" + wasActive + " memory-backup=" + memoryBackup);
  let envChanged = false;
  try {
    if (wasActive) run("systemctl", ["stop", service]);
    fs.cpSync(source, memoryBackup, { recursive: true, force: false, errorOnExist: true });
    fs.copyFileSync(opts.envFile, envBackup);
    try { fs.chmodSync(envBackup, 0o600); } catch {}
    const migrationEnv = { ...process.env, QDRANT_URL: url, QDRANT_API_KEY: key };
    if (!opts.skipDryRun) {
      console.log("migration dry-run...");
      run(process.execPath, ["--max-old-space-size=" + opts.heapMb, migration, "--source", source, "--url", url, "--collection", collection, "--dimensions", String(dimensions)], { env: migrationEnv, stdio: "inherit" });
    }
    console.log("migration apply...");
    run(process.execPath, ["--max-old-space-size=" + opts.heapMb, migration, "--source", source, "--url", url, "--collection", collection, "--dimensions", String(dimensions), "--apply"], { env: migrationEnv, stdio: "inherit" });
    const updates = { MIOBOT_MEMORY_BACKEND: "qdrant", QDRANT_URL: url, QDRANT_API_KEY: key, QDRANT_COLLECTION: collection };
    if (opts.enableBot) updates.MIOBOT_ENABLE_BOT = "1";
    updateEnv(opts.envFile, updates);
    envChanged = true;
    if (opts.start) {
      run("systemctl", ["start", service], { allowFailure: false });
      if (!waitHealth(opts.healthUrl)) throw new Error("service health check failed: " + opts.healthUrl);
    }
    const after = await fetchQdrant(url, key, collection);
    console.log("qdrant-after-exists=" + Boolean(after.exists) + " points=" + (after.points || 0));
    console.log("CUTOVER OK");
    console.log("memory backup: " + memoryBackup);
    console.log("env backup: " + envBackup);
    console.log("backend=qdrant collection=" + collection);
  } catch (error) {
    console.error("CUTOVER FAILED: " + String(error?.message || error));
    if (envChanged && fs.existsSync(envBackup)) {
      fs.copyFileSync(envBackup, opts.envFile);
      try { fs.chmodSync(opts.envFile, 0o600); } catch {}
      console.error("restored " + opts.envFile);
    }
    if (opts.start) {
      try { run("systemctl", ["start", service], { allowFailure: true }); } catch {}
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(String(error?.message || error)); process.exitCode = 1; });
}

