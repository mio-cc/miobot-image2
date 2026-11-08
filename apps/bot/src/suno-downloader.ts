/**
 * Suno 音频下载器（匿名 rights 解密，方案 A）。
 *
 * 链路：
 *   GET  /api/clip/<clipId>            -> media_urls[0].url（短时有效，即取即用，不落库）
 *   POST /api/mango/rights             -> { key, iv, glt }
 *   SHA256(glt) 解 AES-GCM 包裹        -> 得到音频 AES key / counter
 *   音频 AES-CTR 本地解密               -> 明文 m4a（Opus）
 *   ffmpeg                             -> 本地 mp3
 *
 * 设计约束：
 *   - 全局单并发；每次出网请求间隔 2-5 秒（可配）。
 *   - 403/429 视为风控信号，立即停止，不重试。
 *   - 签名 URL 只在内存中使用，不写文件、不写日志。
 *   - 落盘按 clipId 前缀命名，短时缓存命中直接复用。
 *   - ffmpeg 缺失时抛明确错误，不做静默降级。
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://studio-api.prod.suno.com';
const SITE_BASE = 'https://suno.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export type SunoDownloadErrorCode =
  | 'invalid_clip_id'
  | 'not_found'
  | 'blocked'
  | 'http_error'
  | 'timeout'
  | 'decrypt_failed'
  | 'ffmpeg_missing'
  | 'ffmpeg_failed'
  | 'io_error'
  | 'aborted';

export class SunoDownloadError extends Error {
  code: SunoDownloadErrorCode;

  constructor(code: SunoDownloadErrorCode, message: string) {
    super(message);
    this.name = 'SunoDownloadError';
    this.code = code;
  }
}

export interface SunoDownloadInput {
  /** clip id / song 链接 / 带 UUID 的任意字符串。 */
  clipId: string;
  /** 已知标题（可选，缺失时用元数据标题）。 */
  title?: string;
}

export interface SunoDownloadLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface SunoDownloadOptions {
  /** 落盘目录（会在需要时创建）。 */
  cacheDir: string;
  /** ffmpeg 可执行文件；缺省依次尝试 MIOBOT_FFMPEG_PATH、PATH 中的 ffmpeg。 */
  ffmpegPath?: string;
  fetchImpl?: typeof fetch;
  logger?: SunoDownloadLogger;
  /** 出网请求间隔（毫秒），默认 2000-5000。 */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** mp3 缓存有效期，默认 30 分钟。 */
  cacheTtlMs?: number;
  /** 单次 HTTP 请求超时，默认元数据 30s、音频 120s。 */
  metadataTimeoutMs?: number;
  mediaTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface SunoDownloadResult {
  filePath: string;
  clipId: string;
  title: string;
  bytes: number;
  cached: boolean;
}

interface ClipMetadata {
  id: string;
  title: string;
  duration: number;
  mediaUrl: string;
  contentType: string;
}

interface RightsPayload {
  key: string;
  iv: string;
  glt: string;
}

/** 全局串行队列：同一进程内所有下载任务单并发。 */
let queueTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

const DEFAULT_MIN_INTERVAL_MS = 2000;
const DEFAULT_MAX_INTERVAL_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_METADATA_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MEDIA_TIMEOUT_MS = 120 * 1000;
const MAX_MEDIA_BYTES = 120 * 1024 * 1024;

export function sunoShareUrl(clipId: string): string {
  return `https://suno.com/song/${clipId}`;
}

export function normalizeSunoClipId(raw: string): string {
  const match = UUID_RE.exec(String(raw || ''));
  if (!match) {
    throw new SunoDownloadError('invalid_clip_id', `无效的 Suno clip id：${String(raw || '').slice(0, 80)}`);
  }
  return match[0].toLowerCase();
}

/** 入参 clip id 或 clip 对象，出参本地 mp3 路径。失败一律抛 SunoDownloadError。 */
export async function downloadSunoClipMp3(
  input: SunoDownloadInput,
  options: SunoDownloadOptions,
): Promise<SunoDownloadResult> {
  const clipId = normalizeSunoClipId(input.clipId);
  const cacheDir = path.resolve(options.cacheDir);
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  return withSerialQueue(async () => {
    const cached = await findCachedMp3(cacheDir, clipId, ttl);
    if (cached) {
      options.logger?.info('suno-download: 命中短时缓存', { clipId, file: path.basename(cached.filePath), bytes: cached.bytes });
      return cached;
    }

    const ffmpeg = await resolveFfmpeg(options.ffmpegPath);
    await fs.mkdir(cacheDir, { recursive: true });

    const meta = await fetchClipMetadata(clipId, options);
    const title = cleanTitle(input.title || meta.title);
    const plain = await fetchDecryptedAudio(meta, options);

    const host = await writeTempFile(cacheDir, `${clipId}.part.m4a`, plain);
    const mp3Name = buildMp3FileName(clipId, title);
    const mp3Path = path.join(cacheDir, mp3Name);
    const tempMp3 = path.join(cacheDir, `${clipId}.part.mp3`);
    try {
      await transcodeWithFfmpeg(ffmpeg, host, tempMp3, title);
      await fs.rename(tempMp3, mp3Path);
      const stat = await fs.stat(mp3Path);
      if (stat.size <= 0) throw new SunoDownloadError('ffmpeg_failed', `转码产物为空：${mp3Name}`);
      await cleanupStaleVariants(cacheDir, clipId, mp3Name);
      options.logger?.info('suno-download: mp3 已生成', { clipId, title, file: mp3Name, bytes: stat.size });
      return { filePath: mp3Path, clipId, title, bytes: stat.size, cached: false };
    } finally {
      await fs.rm(host, { force: true }).catch(() => undefined);
      await fs.rm(tempMp3, { force: true }).catch(() => undefined);
    }
  });
}

async function withSerialQueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = queueTail;
  let release: () => void = () => undefined;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

async function throttle(options: SunoDownloadOptions, signal?: AbortSignal): Promise<void> {
  const min = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const max = Math.max(min, options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS);
  const gap = min + Math.random() * (max - min);
  const wait = gap - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt = Date.now();
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SunoDownloadError('aborted', '下载已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SunoDownloadError('aborted', '下载已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchClipMetadata(clipId: string, options: SunoDownloadOptions): Promise<ClipMetadata> {
  const response = await requestJson(`${API_BASE}/api/clip/${clipId}`, options, DEFAULT_METADATA_TIMEOUT_MS, 'clip 元数据');
  const raw = response as Record<string, unknown>;
  const mediaList = Array.isArray(raw.media_urls) ? raw.media_urls : [];
  const candidates = mediaList
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      url: String(item.url || ''),
      contentType: String(item.content_type || ''),
      delivery: String(item.delivery || ''),
    }))
    .filter((item) => item.url && !/video|mp4/i.test(item.contentType));
  const preferred = candidates.find((item) => /m4a|opus|audio/i.test(item.contentType))
    || candidates.find((item) => item.delivery === 'progressive')
    || candidates[0];
  if (!preferred) {
    throw new SunoDownloadError('not_found', `「${String(raw.title || clipId)}」没有可下载的媒体地址`);
  }
  return {
    id: clipId,
    title: cleanTitle(String(raw.title || '')),
    duration: Number((raw.metadata as Record<string, unknown> | undefined)?.duration) || 0,
    mediaUrl: preferred.url,
    contentType: preferred.contentType,
  };
}

async function fetchDecryptedAudio(meta: ClipMetadata, options: SunoDownloadOptions): Promise<Buffer> {
  const blob = await requestBuffer(meta.mediaUrl, options, DEFAULT_MEDIA_TIMEOUT_MS, '音频媒体');
  if (isMp4Container(blob)) return blob;

  const rights = await fetchRights(meta.id, options);
  let plain: Buffer;
  try {
    plain = decryptAudio(blob, meta.id, rights);
  } catch (error) {
    throw new SunoDownloadError('decrypt_failed', `「${meta.title}」解密失败：${String((error as Error)?.message || error)}`);
  }
  if (!isMp4Container(plain)) {
    throw new SunoDownloadError('decrypt_failed', `「${meta.title}」解密后不是合法音频容器（头部 ${plain.subarray(0, 8).toString('hex')}），Suno 协议可能已变更`);
  }
  return plain;
}

async function fetchRights(clipId: string, options: SunoDownloadOptions): Promise<RightsPayload> {
  const payload = await requestJson(
    `${API_BASE}/api/mango/rights`,
    options,
    DEFAULT_METADATA_TIMEOUT_MS,
    'rights',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content_params: { content_id: clipId, content_type: 'clip' } }),
    },
  );
  const data = payload as Record<string, unknown>;
  const key = String(data.key || '');
  const iv = String(data.iv || '');
  const glt = String(data.glt || '');
  if (!key || !iv || !glt) {
    throw new SunoDownloadError('http_error', 'rights 返回缺少 key/iv/glt，Suno 接口可能已变更');
  }
  return { key, iv, glt };
}

function decryptAudio(blob: Buffer, clipId: string, rights: RightsPayload): Buffer {
  const userKey = createHash('sha256').update(rights.glt).digest();
  const unwrap = (encoded: string): Buffer => {
    const wrapped = Buffer.from(encoded, 'base64');
    if (wrapped.length < 28) throw new Error('包裹密钥长度异常');
    const nonce = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(wrapped.length - 16);
    const ciphertext = wrapped.subarray(12, wrapped.length - 16);
    const decipher = createDecipheriv(userKey.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', userKey, nonce);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(clipId, 'utf8'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  };
  const key = unwrap(rights.key);
  const counter = unwrap(rights.iv);
  const decipher = createDecipheriv(key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr', key, counter);
  return Buffer.concat([decipher.update(blob), decipher.final()]);
}

function isMp4Container(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;
}

async function requestJson(
  url: string,
  options: SunoDownloadOptions,
  timeoutMs: number,
  label: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await requestWithRetry(url, options, timeoutMs, label, init, false);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SunoDownloadError('http_error', `${label} 返回非 JSON 内容（HTTP ${response.status}）`);
  }
}

async function requestBuffer(
  url: string,
  options: SunoDownloadOptions,
  timeoutMs: number,
  label: string,
): Promise<Buffer> {
  const response = await requestWithRetry(url, options, timeoutMs, label, undefined, true);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_MEDIA_BYTES) {
    throw new SunoDownloadError('http_error', `${label} 文件过大（${contentLength} 字节）`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new SunoDownloadError('http_error', `${label} 文件过大（${buffer.length} 字节）`);
  }
  if (buffer.length === 0) throw new SunoDownloadError('http_error', `${label} 返回空内容`);
  return buffer;
}

async function requestWithRetry(
  url: string,
  options: SunoDownloadOptions,
  timeoutMs: number,
  label: string,
  init: RequestInit | undefined,
  stream: boolean,
): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal?.aborted) throw new SunoDownloadError('aborted', '下载已取消');
    await throttle(options, options.signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          'user-agent': USER_AGENT,
          accept: stream ? 'audio/*,*/*;q=0.8' : 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          origin: SITE_BASE,
          referer: `${SITE_BASE}/`,
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
      if (response.status === 403 || response.status === 429) {
        throw new SunoDownloadError('blocked', `${label} 返回 HTTP ${response.status}（风控/限速），已停止下载`);
      }
      if (response.status === 404) {
        throw new SunoDownloadError('not_found', `${label} 返回 HTTP 404（歌曲可能已删除或不可见）：${safeUrl(url)}`);
      }
      if (response.status >= 500) {
        lastError = new SunoDownloadError('http_error', `${label} 返回 HTTP ${response.status}`);
        if (attempt === 0) {
          await sleep(2000, options.signal);
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        throw new SunoDownloadError('http_error', `${label} 返回 HTTP ${response.status}：${safeUrl(url)}`);
      }
      return response;
    } catch (error) {
      if (error instanceof SunoDownloadError) throw error;
      if (options.signal?.aborted) throw new SunoDownloadError('aborted', '下载已取消');
      if ((error as Error)?.name === 'AbortError') {
        throw new SunoDownloadError('timeout', `${label} 请求超时（${timeoutMs}ms）：${safeUrl(url)}`);
      }
      lastError = error;
      if (attempt === 0) {
        await sleep(2000, options.signal);
        continue;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }
  throw new SunoDownloadError('http_error', `${label} 请求失败：${safeUrl(url)}（${String((lastError as Error)?.message || lastError)}）`);
}

function safeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(raw).slice(0, 120);
  }
}

async function resolveFfmpeg(explicit?: string): Promise<string> {
  const candidate = explicit || process.env.MIOBOT_FFMPEG_PATH || 'ffmpeg';
  const probe = await runCommand(candidate, ['-version'], 15 * 1000);
  if (probe.spawnError) {
    throw new SunoDownloadError(
      'ffmpeg_missing',
      `未找到 ffmpeg（尝试：${candidate}）。请安装 ffmpeg 或设置环境变量 MIOBOT_FFMPEG_PATH 指向可执行文件。`,
    );
  }
  if (probe.code !== 0) {
    throw new SunoDownloadError('ffmpeg_missing', `ffmpeg 不可用（${candidate}）：${probe.stderr || `退出码 ${probe.code}`}`);
  }
  return candidate;
}

async function transcodeWithFfmpeg(ffmpeg: string, source: string, target: string, title: string): Promise<void> {
  const args = [
    '-y',
    '-loglevel', 'error',
    '-i', source,
    '-map', '0:a',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-id3v2_version', '3',
    '-metadata', `title=${title}`,
    '-metadata', 'artist=Suno',
    '-metadata', 'album=Suno AI',
    target,
  ];
  const result = await runCommand(ffmpeg, args, 120 * 1000);
  if (result.spawnError) {
    throw new SunoDownloadError('ffmpeg_missing', `无法启动 ffmpeg：${ffmpeg}`);
  }
  if (result.code !== 0) {
    throw new SunoDownloadError('ffmpeg_failed', `ffmpeg 转码失败（退出码 ${result.code}）：${result.stderr.slice(-300)}`);
  }
}

interface CommandResult {
  code: number;
  stderr: string;
  spawnError: boolean;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      finish({ code: -1, stderr: '', spawnError: true });
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, stderr: '命令超时', spawnError: false });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', () => finish({ code: -1, stderr: '', spawnError: true }));
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on('close', (code: number | null) => finish({ code: code ?? -1, stderr, spawnError: false }));
  });
}

async function writeTempFile(dir: string, name: string, content: Buffer): Promise<string> {
  const filePath = path.join(dir, name);
  try {
    await fs.writeFile(filePath, content);
  } catch (error) {
    throw new SunoDownloadError('io_error', `写入临时音频失败：${String((error as Error)?.message || error)}`);
  }
  return filePath;
}

async function findCachedMp3(
  cacheDir: string,
  clipId: string,
  ttlMs: number,
): Promise<SunoDownloadResult | null> {
  let names: string[];
  try {
    names = await fs.readdir(cacheDir);
  } catch {
    return null;
  }
  const suffix = clipIdSuffix(clipId);
  const hit = names.find((name) => name.endsWith(suffix));
  if (!hit) return null;
  const filePath = path.join(cacheDir, hit);
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= 0 || Date.now() - stat.mtimeMs > ttlMs) return null;
    const title = hit.slice(0, hit.length - suffix.length) || clipId;
    return { filePath, clipId, title, bytes: stat.size, cached: true };
  } catch {
    return null;
  }
}

async function cleanupStaleVariants(cacheDir: string, clipId: string, keepName: string): Promise<void> {
  try {
    const names = await fs.readdir(cacheDir);
    const suffix = clipIdSuffix(clipId);
    await Promise.all(names
      .filter((name) => name.endsWith(suffix) && name !== keepName)
      .map((name) => fs.rm(path.join(cacheDir, name), { force: true }).catch(() => undefined)));
  } catch {
    // 清理失败不影响主流程
  }
}

function clipIdSuffix(clipId: string): string {
  return `-${clipId.slice(0, 8)}.mp3`;
}

function buildMp3FileName(clipId: string, title: string): string {
  return `${sanitizeTitle(title)}${clipIdSuffix(clipId)}`;
}

function cleanTitle(raw: string): string {
  return sanitizeTitle(raw) || 'untitled';
}

function sanitizeTitle(raw: string): string {
  const normalized = String(raw || '').normalize('NFC').trim();
  const safe = normalized
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  return safe.slice(0, 60) || 'untitled';
}
