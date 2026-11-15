#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, '..');
const DEFAULTS = { service: process.env.MIOBOT_SERVICE || 'miobot-v2', samples: 2, interval: 1, top: 15, journalLines: 120 };

function help() {
  console.log('Usage: node scripts/runtime-diagnostics.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --service NAME       systemd service (default: miobot-v2)');
  console.log('  --samples N          CPU samples; minimum 2 (default: 2)');
  console.log('  --interval SEC       seconds between samples (default: 1)');
  console.log('  --top N              top processes to show (default: 15)');
  console.log('  --journal-lines N    recent journal lines, 0 disables (default: 120)');
  console.log('  --no-journal         disable journal output');
  console.log('  --json               print machine-readable JSON');
  console.log('  --save PATH          save the report to a file');
  console.log('  --help               show this help');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { ...DEFAULTS, json: false, save: '', noJournal: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i]);
    if (raw === '--json') { options.json = true; continue; }
    if (raw === '--no-journal') { options.noJournal = true; continue; }
    if (raw === '--help' || raw === '-h') { options.help = true; continue; }
    if (!raw.startsWith('--')) throw new Error('unknown argument: ' + raw);
    const eq = raw.indexOf('=');
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const known = ['--service', '--samples', '--interval', '--top', '--journal-lines', '--save'];
    if (!known.includes(name)) throw new Error('unknown option: ' + name);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value === '') throw new Error('missing value: ' + name);
    if (name === '--service') options.service = String(value);
    else if (name === '--samples') options.samples = Number(value);
    else if (name === '--interval') options.interval = Number(value);
    else if (name === '--top') options.top = Number(value);
    else if (name === '--journal-lines') options.journalLines = Number(value);
    else if (name === '--save') options.save = String(value);
    else throw new Error('unknown option: ' + name);
  }
  options.samples = Math.max(2, Math.min(30, Math.trunc(options.samples) || 2));
  options.interval = Math.max(0.2, Math.min(30, Number(options.interval) || 1));
  options.top = Math.max(1, Math.min(80, Math.trunc(options.top) || 15));
  options.journalLines = Math.max(0, Math.min(2000, Math.trunc(options.journalLines) || 0));
  return options;
}

function exec(command, args = [], opts = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 15000 });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || result.error?.message || "").trim(),
  };
}

export function redact(value) {
  return String(value || "")
    .replace(/([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Za-z0-9_]*=)[^\s]+/gi, "$1[redacted]")
    .replace(/(--(?:token|api-key|key|secret|password)[=\s]+)[^\s]+/gi, "$1[redacted]");
}

export function readLoad() {
  const value = fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/);
  return { load1: Number(value[0]) || 0, load5: Number(value[1]) || 0, load15: Number(value[2]) || 0, running: value[3] || "" };
}

export function readCpuStat() {
  const line = fs.readFileSync("/proc/stat", "utf8").split(/\r?\n/).find((item) => item.startsWith("cpu "));
  if (!line) return { total: 0, idle: 0 };
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const total = fields.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  const idle = (fields[3] || 0) + (fields[4] || 0);
  return { total, idle };
}

function readPressure(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function parsePs(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), user: match[3],
      cpu: Number(match[4]) || 0, mem: Number(match[5]) || 0,
      elapsed: match[6], stat: match[7], args: redact(match[8]),
    });
  }
  return rows;
}

function processRows() {
  return parsePs(exec("ps", ["-eo", "pid=,ppid=,user=,pcpu=,pmem=,etime=,stat=,args="]).stdout);
}

function systemdInfo(service) {
  const info = {};
  for (const key of ["MainPID", "NRestarts", "ActiveEnterTimestamp", "ExecMainStartTimestamp", "SubState", "MemoryCurrent", "Tasks"]) {
    const result = exec("systemctl", ["show", service, "-p", key, "--value"]);
    if (result.ok) info[key] = result.stdout;
  }
  const active = exec("systemctl", ["is-active", service]);
  info.active = active.stdout || "unknown";
  return info;
}

function serviceTree(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const lines = [];
  const seen = new Set();
  const walk = (pid, depth) => {
    if (seen.has(pid) || depth > 8) return;
    seen.add(pid);
    const children = byParent.get(pid) || [];
    for (const row of children) {
      lines.push("  ".repeat(depth) + String(row.pid).padStart(7) + " ppid=" + row.ppid + " cpu=" + row.cpu.toFixed(1) + "% mem=" + row.mem.toFixed(1) + "% " + row.args);
      walk(row.pid, depth + 1);
    }
  };
  if (rootPid) lines.push("  ".repeat(0) + String(rootPid).padStart(7) + " root");
  walk(rootPid, 1);
  return lines;
}

function listeners() {
  return exec("ss", ["-ltnp"]).stdout.split(/\r?\n/).filter((line) => /:(3018|3000)\b/.test(line));
}

function journal(service, lines) {
  if (!lines) return "";
  const result = exec("journalctl", ["-u", service, "-n", String(lines), "--no-pager", "-o", "short-iso"], { timeout: 20000 });
  return result.ok ? result.stdout : (result.stderr || "");
}

export async function collectDiagnostics(options = DEFAULTS) {
  if (process.platform !== "linux") throw new Error("runtime diagnostics require Linux /proc");
  const nproc = os.cpus().length;
  const samples = [];
  let previous = readCpuStat();
  for (let i = 0; i < options.samples; i += 1) {
    if (i > 0) await sleep(options.interval * 1000);
    const current = readCpuStat();
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    samples.push({ at: new Date().toISOString(), load: readLoad(), cpuUsagePct: totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : null });
    previous = current;
  }
  const rows = processRows();
  const service = systemdInfo(options.service);
  const mainPid = Number(service.MainPID) || 0;
  const threads = mainPid ? exec("ps", ["-L", "-p", String(mainPid), "-o", "tid=,pcpu=,stat=,comm=", "--sort=-pcpu"]).stdout.split(/\r?\n/).filter(Boolean).slice(0, options.top) : [];
  const memTotal = os.totalmem(); const memFree = os.freemem();
  return {
    generatedAt: new Date().toISOString(), hostname: os.hostname(), nproc, samples,
    latest: samples[samples.length - 1] || null,
    memory: { totalBytes: memTotal, freeBytes: memFree, usedPct: memTotal ? (1 - memFree / memTotal) * 100 : 0 },
    disk: exec("df", ["-hP", "/"]).stdout,
    pressure: { cpu: readPressure("/proc/pressure/cpu"), io: readPressure("/proc/pressure/io"), memory: readPressure("/proc/pressure/memory") },
    service,
    topProcesses: rows.sort((a, b) => b.cpu - a.cpu).slice(0, options.top),
    nodeProcesses: rows.filter((row) => /(?:^|\s)(?:\S*\/)?node(?:\.exe)?(?:\s|$)/.test(row.args)).slice(0, options.top),
    threads,
    tree: serviceTree(rows, mainPid),
    listeners: listeners(),
    journal: options.noJournal ? "" : redact(journal(options.service, options.journalLines)),
  };
}

export function formatDiagnostics(report) {
  const lines = [];
  lines.push("Miobot runtime diagnostics");
  lines.push("generated: " + report.generatedAt);
  lines.push("host: " + report.hostname + "  nproc: " + report.nproc);
  lines.push("service: " + report.service.active + "  MainPID: " + (report.service.MainPID || "?") + "  restarts: " + (report.service.NRestarts || "?"));
  lines.push("");
  lines.push("CPU SAMPLES");
  for (const sample of report.samples) lines.push("  " + sample.at + "  load=" + sample.load.load1.toFixed(2) + "/" + sample.load.load5.toFixed(2) + "/" + sample.load.load15.toFixed(2) + "  cpu=" + (sample.cpuUsagePct === null ? "?" : sample.cpuUsagePct.toFixed(1) + "%"));
  lines.push("memory: " + (report.memory.usedPct).toFixed(1) + "% used  total=" + (report.memory.totalBytes / 1024 / 1024).toFixed(0) + "MiB");
  lines.push(""); lines.push("DISK"); lines.push(report.disk);
  lines.push(""); lines.push("PRESSURE"); lines.push("cpu: " + (report.pressure.cpu || "(missing)")); lines.push("io: " + (report.pressure.io || "(missing)")); lines.push("memory: " + (report.pressure.memory || "(missing)"));
  lines.push(""); lines.push("TOP PROCESSES");
  for (const p of report.topProcesses) lines.push("  " + String(p.pid).padStart(7) + " ppid=" + p.ppid + " cpu=" + p.cpu.toFixed(1) + " mem=" + p.mem.toFixed(1) + " " + p.elapsed + " " + p.args);
  lines.push(""); lines.push("NODE PROCESSES");
  if (!report.nodeProcesses.length) lines.push("  (none)"); for (const p of report.nodeProcesses) lines.push("  " + String(p.pid).padStart(7) + " ppid=" + p.ppid + " cpu=" + p.cpu.toFixed(1) + " mem=" + p.mem.toFixed(1) + " " + p.args);
  lines.push(""); lines.push("PROCESS TREE"); lines.push(...(report.tree.length ? report.tree : ["  (MainPID not found)"]));
  lines.push(""); lines.push("THREADS OF MAINPID"); lines.push(...(report.threads.length ? report.threads : ["  (none)"]));
  lines.push(""); lines.push("LISTENERS"); lines.push(...(report.listeners.length ? report.listeners : ["  (3018/3000 not found)"]));
  if (report.journal) { lines.push(""); lines.push("RECENT JOURNAL"); lines.push(report.journal); }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(String(error.message || error)); help(); process.exitCode = 2; return; }
  if (options.help) { help(); return; }
  const report = await collectDiagnostics(options);
  const text = formatDiagnostics(report);
  const output = options.json ? JSON.stringify(report, null, 2) : text;
  if (options.save) {
    if (options.json) fs.writeFileSync(options.save, output + "\n", "utf8");
    else fs.writeFileSync(options.save, output + "\n", "utf8");
    console.error("saved: " + options.save);
  }
  console.log(output);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => { console.error(String(error?.message || error)); process.exitCode = 1; });
