#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, '..');
const ENV_FILE = '/etc/miobot-v2.env';

export const DEFAULTS = {
  dataDir: '/var/lib/miobot-v2',
  logDir: '/var/log/miobot-v2',
  appDir: REPO_DIR,
  top: 20,
  backupDays: 7,
  tempDays: 3,
  retentionBackupDays: 14,
  capabilityBackupDays: 30,
  generatedDays: 7,
  logDays: 14,
  journalDays: 7,
};

const VALUE_OPTIONS = {
  '--data-dir': 'dataDir',
  '--runtime-dir': 'runtimeDir',
  '--memory-dir': 'memoryDir',
  '--log-dir': 'logDir',
  '--app-dir': 'appDir',
  '--top': 'top',
  '--backup-days': 'backupDays',
  '--temp-days': 'tempDays',
  '--retention-backup-days': 'retentionBackupDays',
  '--capability-backup-days': 'capabilityBackupDays',
  '--generated-days': 'generatedDays',
  '--log-days': 'logDays',
  '--journal-days': 'journalDays',
};
const BOOL_OPTIONS = {
  '--apply': 'apply',
  '--yes': 'yes',
  '--json': 'json',
  '--include-generated': 'includeGenerated',
  '--include-logs': 'includeLogs',
  '--help': 'help',
};
const COMMANDS = new Set(['scan', 'clean', 'journal', 'help']);

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { command: 'scan', apply: false, yes: false, json: false, includeGenerated: false, includeLogs: false, help: false, top: DEFAULTS.top, backupDays: DEFAULTS.backupDays, tempDays: DEFAULTS.tempDays, retentionBackupDays: DEFAULTS.retentionBackupDays, capabilityBackupDays: DEFAULTS.capabilityBackupDays, generatedDays: DEFAULTS.generatedDays, logDays: DEFAULTS.logDays, journalDays: DEFAULTS.journalDays };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i]);
    if (!raw.startsWith('-') && options.command === 'scan') { options.command = raw; continue; }
    const eq = raw.indexOf('=');
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    if (BOOL_OPTIONS[name]) { options[BOOL_OPTIONS[name]] = true; continue; }
    const key = VALUE_OPTIONS[name];
    if (!key) throw new Error(`unknown option: ${name}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value === '') throw new Error(`missing value: ${name}`);
    options[key] = value;
  }
  for (const key of ['top', 'backupDays', 'tempDays', 'retentionBackupDays', 'capabilityBackupDays', 'generatedDays', 'logDays', 'journalDays']) {
    const n = Number(options[key]);
    if (!Number.isFinite(n) || n < 1) throw new Error(`invalid positive number for ${key}: ${options[key]}`);
    options[key] = Math.trunc(n);
  }
  if (!COMMANDS.has(options.command)) throw new Error(`unknown command: ${options.command}`);
  return options;
}

function readEnvFile(file = ENV_FILE) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq);
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      out[key] = value;
    }
  } catch {}
  return out;
}

export function resolvePaths(options, env = process.env, envFile = readEnvFile()) {
  const pick = (...values) => values.map((v) => String(v || '').trim()).find(Boolean);
  const dataDir = path.resolve(pick(options.dataDir, env.DATA_DIR, envFile.DATA_DIR, DEFAULTS.dataDir));
  const runtimeDir = path.resolve(pick(options.runtimeDir, env.MIOBOT_RUNTIME_DIR, envFile.MIOBOT_RUNTIME_DIR, dataDir));
  const memoryDir = path.resolve(pick(options.memoryDir, env.MIOBOT_MEMORY_DIR, envFile.MIOBOT_MEMORY_DIR, path.join(runtimeDir, 'memory')));
  const logDir = path.resolve(pick(options.logDir, env.LOG_DIR, envFile.LOG_DIR, DEFAULTS.logDir));
  const appDir = path.resolve(pick(options.appDir, env.APP_DIR, envFile.APP_DIR, DEFAULTS.appDir));
  return { dataDir, runtimeDir, memoryDir, logDir, appDir };
}

export function formatBytes(value) {
  let n = Math.max(0, Number(value) || 0);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}
// helper: shell quote

function run(command, args = [], opts = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) {
    if (opts.allowFailure) return "";
    throw new Error(command + ": " + result.error.message);
  }
  if (result.status !== 0 && !opts.allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(command + " exited " + result.status + (detail ? ": " + detail : ""));
  }
  return result.stdout || "";
}

export function parseDu(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const bytes = Number(line.slice(0, tab));
    const target = line.slice(tab + 1);
    if (Number.isFinite(bytes) && target) rows.push({ path: target, bytes });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

function topLevelUsage(directory) {
  if (!fs.existsSync(directory)) return [];
  return parseDu(run("du", ["-xbd1", directory], { allowFailure: true }));
}

export function parseSizePath(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const bytes = Number(line.slice(0, tab));
    const target = line.slice(tab + 1);
    if (Number.isFinite(bytes) && target) rows.push({ path: target, bytes });
  }
  return rows;
}

function topFiles(directory, limit) {
  if (!fs.existsSync(directory)) return [];
  const rows = parseSizePath(run("find", [directory, "-xdev", "-type", "f", "-printf", "%s\\t%p\\n"], { allowFailure: true }));
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
}

export function parseFindOutput(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const first = line.indexOf("\t");
    const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
    if (first < 1 || second < first + 2) continue;
    const mtimeMs = Number(line.slice(0, first)) * 1000;
    const bytes = Number(line.slice(first + 1, second));
    const target = line.slice(second + 1);
    if (Number.isFinite(mtimeMs) && Number.isFinite(bytes) && target) rows.push({ path: target, bytes, mtimeMs });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

function findFiles(directory, opts = {}) {
  if (!fs.existsSync(directory)) return [];
  const args = [directory, "-xdev", "-type", "f"];
  if (opts.olderThanDays > 0) args.push("-mtime", "+" + Math.max(0, Number(opts.olderThanDays) || 0));
  if (opts.name) args.push("-name", opts.name);
  args.push("-printf", "%T@\\t%s\\t%p\\n");
  return parseFindOutput(run("find", args, { allowFailure: true }));
}

function findFilesPatterns(directory, patterns, olderThanDays) {
  const seen = new Map();
  for (const name of patterns) {
    for (const item of findFiles(directory, { olderThanDays, name })) seen.set(item.path, item);
  }
  return [...seen.values()].sort((a, b) => b.bytes - a.bytes);
}
function directorySummary(directory) {
  const files = findFiles(directory);
  const bytes = files.reduce((sum, item) => sum + item.bytes, 0);
  const times = files.map((item) => item.mtimeMs).filter((n) => Number.isFinite(n));
  return {
    exists: fs.existsSync(directory),
    path: directory,
    files: files.length,
    bytes,
    oldestAt: times.length ? new Date(Math.min(...times)).toISOString() : undefined,
    newestAt: times.length ? new Date(Math.max(...times)).toISOString() : undefined,
  };
}

function retentionState(memoryDir) {
  try { return JSON.parse(fs.readFileSync(path.join(memoryDir, "retention-state.json"), "utf8")); } catch { return undefined; }
}

function retentionBackups(memoryDir) {
  return findFiles(memoryDir, { name: "retention-backup-*.json" });
}

function journalUsage() {
  if (process.platform !== "linux") return "";
  return run("journalctl", ["--disk-usage"], { allowFailure: true }).trim();
}

function sumBytes(files) {
  return files.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
}

function diskInfo(directory) {
  if (process.platform !== "linux") return "";
  return run("df", ["-hP", directory], { allowFailure: true }).trim();
}

export function scanReport(paths, options) {
  const backupsDir = path.join(paths.dataDir, "backups");
  const tempDir = path.join(paths.runtimeDir, "tmp-files");
  const generatedDir = path.join(paths.runtimeDir, "generated-files");
  const canvasDir = path.join(paths.runtimeDir, "canvas-assets");
  const capabilityBackupsDir = path.join(paths.runtimeDir, "capabilities", "backups");
  const backupFiles = findFiles(backupsDir);
  const memoryFiles = retentionBackups(paths.memoryDir);
  const capabilityFiles = findFiles(capabilityBackupsDir, { name: "*.bak" });
  const rotatedLogs = findFilesPatterns(paths.logDir, ["*.log.*", "*.ndjson.*"], 0);
  return {
    generatedAt: new Date().toISOString(),
    paths,
    disk: { root: diskInfo("/"), data: diskInfo(paths.dataDir) },
    usage: {
      data: topLevelUsage(paths.dataDir),
      runtime: topLevelUsage(paths.runtimeDir),
      logs: topLevelUsage(paths.logDir),
      app: topLevelUsage(paths.appDir),
    },
    largestFiles: topFiles(paths.runtimeDir, options.top),
    memory: {
      retention: retentionState(paths.memoryDir),
      backupFiles: memoryFiles.length,
      backupBytes: sumBytes(memoryFiles),
      oldestBackupAt: memoryFiles.length ? new Date(Math.min(...memoryFiles.map((f) => f.mtimeMs))).toISOString() : undefined,
      directory: directorySummary(paths.memoryDir),
    },
    categories: {
      deploymentBackups: { directory: backupsDir, files: backupFiles.length, bytes: sumBytes(backupFiles) },
      memoryRetentionBackups: { directory: paths.memoryDir, files: memoryFiles.length, bytes: sumBytes(memoryFiles) },
      capabilityBackups: { directory: capabilityBackupsDir, files: capabilityFiles.length, bytes: sumBytes(capabilityFiles) },
      tempFiles: { directory: tempDir, files: findFiles(tempDir).length, bytes: directorySummary(tempDir).bytes },
      generatedFiles: { directory: generatedDir, files: findFiles(generatedDir).length, bytes: directorySummary(generatedDir).bytes },
      canvasAssets: { directory: canvasDir, files: findFiles(canvasDir).length, bytes: directorySummary(canvasDir).bytes },
      rotatedLogs: { directory: paths.logDir, files: rotatedLogs.length, bytes: sumBytes(rotatedLogs) },
    },
    journal: journalUsage(),
  };
}

function printRows(title, rows, limit) {
  console.log("");
  console.log(title);
  if (!rows || !rows.length) { console.log("  (not found)"); return; }
  for (const row of rows.slice(0, limit || 30)) console.log("  " + formatBytes(row.bytes).padStart(10) + "  " + row.path);
}

function printScan(report) {
  console.log("Miobot storage report");
  console.log("generated: " + report.generatedAt);
  console.log("data: " + report.paths.dataDir);
  console.log("runtime: " + report.paths.runtimeDir);
  console.log("logs: " + report.paths.logDir);
  console.log("app: " + report.paths.appDir);
  console.log("");
  console.log("DISK");
  if (report.disk.root) console.log(report.disk.root);
  if (report.disk.data && report.disk.data !== report.disk.root) console.log(report.disk.data);
  printRows("DATA TOP-LEVEL", report.usage.data);
  printRows("RUNTIME TOP-LEVEL", report.usage.runtime);
  printRows("LOG TOP-LEVEL", report.usage.logs);
  printRows("APP TOP-LEVEL", report.usage.app);
  printRows("LARGEST FILES", report.largestFiles, 30);
  console.log("");
  console.log("MEMORY");
  console.log("  directory: " + report.memory.directory.path);
  console.log("  files: " + report.memory.directory.files + ", bytes: " + formatBytes(report.memory.directory.bytes));
  console.log("  retention: " + (report.memory.retention ? JSON.stringify(report.memory.retention) : "no retention-state.json"));
  console.log("  retention backups: " + report.memory.backupFiles + ", " + formatBytes(report.memory.backupBytes));
  console.log("");
  console.log("CLEANUP CATEGORIES");
  for (const [name, item] of Object.entries(report.categories)) console.log("  " + name.padEnd(24) + " " + String(item.files).padStart(6) + " files  " + formatBytes(item.bytes).padStart(10) + "  " + item.directory);
  if (report.journal) { console.log(""); console.log("JOURNAL"); console.log(report.journal); }
  console.log("");
  console.log("Cleanup is dry-run by default. Use: clean --apply --yes");
}

export function buildCleanupPlan(paths, options) {
  const categories = [];
  const add = (name, directory, olderThanDays, namePattern, note) => {
    const files = findFiles(directory, { olderThanDays, name: namePattern || "" });
    categories.push({ name, directory, olderThanDays, files, bytes: sumBytes(files), note });
  };
  add("deployment-backups", path.join(paths.dataDir, "backups"), options.backupDays, "", "config/canvas/orchestration backups older than backup-days");
  add("memory-retention-backups", paths.memoryDir, options.retentionBackupDays, "retention-backup-*.json", "JSON snapshots created by memory retention");
  add("capability-backups", path.join(paths.runtimeDir, "capabilities", "backups"), options.capabilityBackupDays, "*.bak", "replaced bundled capability plugin backups");
  add("temp-files", path.join(paths.runtimeDir, "tmp-files"), options.tempDays, "", "temporary runtime files");
  if (options.includeLogs) {
    const rotated = findFilesPatterns(paths.logDir, ["*.log.*", "*.ndjson.*"], options.logDays);
    categories.push({ name: "rotated-logs", directory: paths.logDir, olderThanDays: options.logDays, files: rotated, bytes: sumBytes(rotated), note: "rotated/compressed logs only; active logs are never touched" });
  }  if (options.includeGenerated) add("generated-files", path.join(paths.runtimeDir, "generated-files"), options.generatedDays, "", "generated artifacts; opt-in only because they may still be referenced");
  return { generatedAt: new Date().toISOString(), paths, options, categories, totalFiles: categories.reduce((n, c) => n + c.files.length, 0), totalBytes: categories.reduce((n, c) => n + c.bytes, 0) };
}

function printCleanupPlan(plan) {
  console.log("Miobot cleanup plan");
  console.log("generated: " + plan.generatedAt);
  console.log("mode: " + (plan.options.apply ? "APPLY" : "DRY RUN"));
  console.log("total: " + plan.totalFiles + " files, " + formatBytes(plan.totalBytes));
  for (const category of plan.categories) {
    console.log("");
    console.log(category.name + ": " + category.files.length + " files, " + formatBytes(category.bytes));
    console.log("  " + category.note);
    for (const file of category.files.slice(0, plan.options.top)) console.log("  " + formatBytes(file.bytes).padStart(10) + "  " + new Date(file.mtimeMs).toISOString() + "  " + file.path);
  }
  console.log("");
  console.log(plan.options.apply ? "Deleting listed files." : "No files deleted. Re-run clean --apply --yes to delete.");
}

function isInside(file, root) {
  const rel = path.relative(root, file);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function confirmDelete() {
  if (!process.stdin.isTTY) throw new Error("refusing to delete without a TTY; pass --yes for non-interactive use");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("Type DELETE to permanently remove these files: ");
    return answer.trim() === "DELETE";
  } finally { rl.close(); }
}

export async function applyCleanup(plan) {
  if (process.platform !== "linux") throw new Error("--apply is supported on Linux only");
  if (typeof process.getuid === "function" && process.getuid() !== 0) throw new Error("--apply must run as root");
  if (!plan.options.yes) {
    const ok = await confirmDelete();
    if (!ok) return { canceled: true, removed: 0, failed: 0, categories: [] };
  }
  const result = { canceled: false, removed: 0, failed: 0, removedBytes: 0, categories: [] };
  for (const category of plan.categories) {
    let removed = 0; let failed = 0; let bytes = 0;
    for (const file of category.files) {
      try {
        const stat = fs.lstatSync(file.path);
        if (!stat.isFile() || !isInside(file.path, category.directory)) throw new Error("path guard rejected");
        fs.unlinkSync(file.path);
        removed += 1; bytes += file.bytes;
      } catch (error) { failed += 1; }
    }
    result.removed += removed; result.failed += failed; result.removedBytes += bytes;
    result.categories.push({ name: category.name, removed, failed, bytes });
  }
  return result;
}

function printHelp() {
  console.log("Usage: node scripts/storage-maintenance.mjs <scan|clean|journal> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  scan      show disk, top-level dirs, largest files, memory/retention and backup state (default)");
  console.log("  clean     build a cleanup plan; dry-run unless --apply is provided");
  console.log("  journal   show journald usage; vacuum only with --apply");
  console.log("");
  console.log("Options:");
  console.log("  --data-dir PATH            default /var/lib/miobot-v2 (or DATA_DIR from /etc/miobot-v2.env)");
  console.log("  --runtime-dir PATH         default MIOBOT_RUNTIME_DIR or data dir");
  console.log("  --log-dir PATH             default /var/log/miobot-v2");
  console.log("  --memory-dir PATH          default <runtime-dir>/memory");
  console.log("  --backup-days N            deployment backup retention (default 7)");
  console.log("  --temp-days N              tmp-files retention (default 3)");
  console.log("  --retention-backup-days N  memory retention JSON snapshots (default 14)");
  console.log("  --capability-backup-days N capability .bak files (default 30)");
  console.log("  --generated-days N         generated-files retention (default 7, opt-in)");
  console.log("  --log-days N               rotated log retention (default 14, opt-in)");
  console.log("  --include-logs             include rotated/compressed logs in clean plan");
  console.log("  --include-generated        include generated-files in clean plan");
  console.log("  --journal-days N           journalctl --vacuum-time days (default 7)");
  console.log("  --apply                    actually delete / vacuum");
  console.log("  --yes                      skip interactive DELETE confirmation");
  console.log("  --json                     machine-readable output");
  console.log("  --top N                    list at most N files per section (default 20)");
}

async function runJournal(options, paths) {
  const before = journalUsage();
  if (!options.apply) {
    if (!options.json) console.log("Journal usage for " + paths.dataDir);
    if (!options.json) console.log(before || "(journalctl unavailable)");
    if (!options.json) console.log("Dry run. Re-run: journal --apply --yes --journal-days " + options.journalDays);
    return { applied: false, before };
  }
  if (process.platform !== "linux") throw new Error("journal --apply is supported on Linux only");
  if (typeof process.getuid === "function" && process.getuid() !== 0) throw new Error("journal --apply must run as root");
  if (!options.yes) { const ok = await confirmDelete(); if (!ok) return { applied: false, canceled: true, before }; }
  const output = run("journalctl", ["--vacuum-time", options.journalDays + "d"], { allowFailure: false }).trim();
  const after = journalUsage();
  if (!options.json) { console.log(output); console.log("After:"); console.log(after || "(journalctl unavailable)"); }
  return { applied: true, before, after, vacuumDays: options.journalDays, output };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(String(error.message || error)); printHelp(); process.exitCode = 2; return; }
  if (options.command === "help" || options.help) { printHelp(); return; }
  const paths = resolvePaths(options);
  if (options.command === "scan") {
    const report = scanReport(paths, options);
    if (options.json) console.log(JSON.stringify(report, null, 2)); else printScan(report);
    return;
  }
  if (options.command === "clean") {
    const plan = buildCleanupPlan(paths, options);
    if (!options.apply) {
      if (options.json) console.log(JSON.stringify(plan, null, 2)); else printCleanupPlan(plan);
      return;
    }
    const result = await applyCleanup(plan);
    if (options.json) console.log(JSON.stringify({ plan, result }, null, 2)); else { printCleanupPlan(plan); console.log(""); console.log("removed=" + result.removed + " failed=" + result.failed + " bytes=" + formatBytes(result.removedBytes)); }
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (options.command === "journal") {
    const result = await runJournal(options, paths);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    return;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => { console.error(String(error?.message || error)); process.exitCode = 1; });
