import { randomUUID } from 'node:crypto';
import type { ComfyUiNodeConfig, ComfyUiProfile } from '../../config/src/index.js';

export interface ComfyUiRunOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  profile: ComfyUiProfile;
  params: Record<string, unknown>;
  node: Pick<ComfyUiNodeConfig, 'pollTimeoutMs' | 'pollIntervalMs' | 'maxBatchSize'>;
  outputNodeId?: string;
  maxImageBytes?: number;
}

export interface ComfyUiGeneratedImage {
  filename: string;
  subfolder: string;
  type: string;
  mime: string;
  buffer: Buffer;
}

export interface ComfyUiRunResult {
  promptId: string;
  seed?: number;
  images: ComfyUiGeneratedImage[];
  raw: unknown;
}

export class ComfyUiError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'ComfyUiError';
    this.status = opts.status;
    this.code = opts.code;
  }
}

function trimBase(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeHeaders(options: Pick<ComfyUiRunOptions, 'apiKey' | 'headers'>): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  return headers;
}

async function fetchText(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { response, text: await response.text() };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const { response, text } = await fetchText(url, init, timeoutMs);
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!response.ok) {
    const message = typeof body === 'string' ? body : (body as any)?.error?.message || (body as any)?.error || text;
    throw new ComfyUiError(`ComfyUI HTTP ${response.status}: ${String(message).slice(0, 400)}`, { status: response.status, code: 'http_error' });
  }
  return body;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** 只写入参数映射声明的路径，绝不接受模型直接提供的节点 ID。 */
export function setByPath(root: Record<string, any>, dottedPath: string, value: unknown): void {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  if (!parts.length) return;
  let current: any = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[parts[parts.length - 1]] = value;
}

function replaceNodeLink(value: unknown, nodeId: string, baseModel: [string, number]): unknown {
  if (Array.isArray(value)) {
    if (value.length === 2 && String(value[0]) === nodeId && Number(value[1]) === 0) return [...baseModel];
    return value.map((item) => replaceNodeLink(item, nodeId, baseModel));
  }
  if (value && typeof value === 'object') {
    const out = value as Record<string, unknown>;
    for (const key of Object.keys(out)) out[key] = replaceNodeLink(out[key], nodeId, baseModel);
    return out;
  }
  return value;
}

/** 根据 loraId 决定保留/移除 LoRA 节点；未选择时把下游连接回基础模型。 */
function applyComfyUiLora(profile: ComfyUiProfile, workflow: Record<string, any>, params: Record<string, unknown>): void {
  const config = profile.lora;
  if (!config?.nodeId) return;
  const loraNode = workflow[config.nodeId];
  const selectedId = String(params.loraId || 'none');
  const selected = selectedId !== 'none'
    ? (config.catalog || []).find((item) => item.id === selectedId || item.file === selectedId)
    : undefined;
  if (!selected) {
    const upstream = config.baseModel
      || (Array.isArray(loraNode?.inputs?.model) ? loraNode.inputs.model as [string, number] : undefined);
    if (upstream) {
      for (const [id, node] of Object.entries(workflow)) {
        if (id === config.nodeId || !node || typeof node !== 'object') continue;
        (node as Record<string, any>).inputs = replaceNodeLink((node as Record<string, any>).inputs, config.nodeId, upstream) as Record<string, unknown>;
      }
    }
    delete workflow[config.nodeId];
    return;
  }
  if (!loraNode || typeof loraNode !== 'object' || !loraNode.inputs) {
    throw new ComfyUiError(`ComfyUI 缺少 LoRA 节点 ${config.nodeId}`);
  }
  const min = selected.minStrength ?? 0;
  const max = selected.maxStrength ?? 2;
  const rawStrength = Number(params.loraStrength ?? selected.defaultStrength ?? 0.6);
  const strength = Math.max(min, Math.min(max, Number.isFinite(rawStrength) ? rawStrength : (selected.defaultStrength ?? 0.6)));
  loraNode.inputs.lora_name = selected.file;
  loraNode.inputs.strength_model = strength;
}

export function buildComfyUiWorkflow(profile: ComfyUiProfile, params: Record<string, unknown>, maxBatchSize = 4): { workflow: Record<string, any>; applied: Record<string, unknown>; seed?: number } {
  const workflow = JSON.parse(JSON.stringify(profile.workflow || {})) as Record<string, any>;
  const merged = { ...(profile.defaults || {}), ...(params || {}) } as Record<string, unknown>;
  if (merged.batchSize !== undefined) {
    const n = Math.trunc(Number(merged.batchSize));
    merged.batchSize = Number.isFinite(n) ? Math.min(maxBatchSize, Math.max(1, n)) : 1;
  }
  let seed: number | undefined;
  if (merged.seed !== undefined) {
    const n = Math.trunc(Number(merged.seed));
    seed = Number.isFinite(n) && n > 0 ? Math.min(4294967295, n) : Math.floor(Math.random() * 4294967294) + 1;
    merged.seed = seed;
  }
  const applied: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(profile.parameterMap || {})) {
    if (!path) continue;
    const value = merged[key];
    if (value === undefined) continue;
    if (key === 'batchSize' && !profile.parameterMap?.batchSize) continue;
    setByPath(workflow, path, value);
    applied[key] = value;
  }
  applyComfyUiLora(profile, workflow, merged);
  return { workflow, applied, seed };
}

export async function testComfyUiConnection(baseUrl: string, options: { apiKey?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<unknown> {
  return fetchJson(`${trimBase(baseUrl)}/system_stats`, { method: 'GET', headers: mergeHeaders(options) }, options.timeoutMs || 10000);
}

export async function fetchComfyUiObjectInfo(baseUrl: string, options: { apiKey?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<unknown> {
  return fetchJson(`${trimBase(baseUrl)}/object_info`, { method: 'GET', headers: mergeHeaders(options) }, options.timeoutMs || 20000);
}

async function downloadImage(baseUrl: string, image: Record<string, any>, headers: Record<string, string>, timeoutMs: number, maxBytes: number): Promise<ComfyUiGeneratedImage> {
  const filename = String(image.filename || '');
  if (!filename) throw new ComfyUiError('ComfyUI 输出缺少 filename');
  const query = new URLSearchParams({ filename, subfolder: String(image.subfolder || ''), type: String(image.type || 'output') });
  const response = await fetch(`${trimBase(baseUrl)}/view?${query.toString()}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new ComfyUiError(`ComfyUI 图片下载失败 HTTP ${response.status}`, { status: response.status });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new ComfyUiError(`ComfyUI 单张图片超过上限 ${maxBytes} bytes`, { code: 'image_too_large' });
  return { filename, subfolder: String(image.subfolder || ''), type: String(image.type || 'output'), mime: response.headers.get('content-type') || 'image/png', buffer };
}

export async function runComfyUiWorkflow(options: ComfyUiRunOptions): Promise<ComfyUiRunResult> {
  const baseUrl = trimBase(options.baseUrl);
  if (!baseUrl) throw new ComfyUiError('ComfyUI 节点缺少 Base URL');
  if (!options.profile?.workflow || !Object.keys(options.profile.workflow).length) throw new ComfyUiError('ComfyUI profile 没有 workflow');
  const headers = mergeHeaders(options);
  headers['Content-Type'] = 'application/json';
  const built = buildComfyUiWorkflow(options.profile, options.params, options.node.maxBatchSize);
  const clientId = `miobot-${randomUUID()}`;
  const submitted = await fetchJson(`${baseUrl}/prompt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: built.workflow, client_id: clientId }),
  }, Math.min(60000, options.node.pollTimeoutMs));
  const promptId = String(asRecord(submitted).prompt_id || '');
  if (!promptId) throw new ComfyUiError('ComfyUI 没有返回 prompt_id');
  if (asRecord(submitted).node_errors && Object.keys(asRecord(submitted).node_errors).length) {
    throw new ComfyUiError('ComfyUI workflow 节点参数错误', { code: 'node_errors' });
  }

  const deadline = Date.now() + options.node.pollTimeoutMs;
  let history: Record<string, any> = {};
  while (Date.now() < deadline) {
    const data = asRecord(await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { headers }, 30000));
    const entry = asRecord(data[promptId]);
    if (entry.outputs && Object.keys(asRecord(entry.outputs)).length) { history = entry; break; }
    const status = asRecord(entry.status);
    if (status.status_str === 'error' || status.completed === false && status.status_str === 'error') {
      throw new ComfyUiError('ComfyUI 任务执行失败', { code: 'execution_error' });
    }
    await sleep(options.node.pollIntervalMs);
  }
  if (!history.outputs) throw new ComfyUiError('ComfyUI 任务轮询超时', { code: 'poll_timeout' });

  const outputs = asRecord(history.outputs);
  let imageNodes: Record<string, any>[] = [];
  if (options.outputNodeId) {
    const selected = asRecord(outputs[options.outputNodeId]);
    imageNodes = Array.isArray(selected.images) ? selected.images : [];
  } else {
    for (const output of Object.values(outputs)) {
      const images = asRecord(output).images;
      if (Array.isArray(images)) imageNodes.push(...images);
    }
  }
  if (!imageNodes.length) throw new ComfyUiError('ComfyUI 没有返回图片', { code: 'no_images' });
  const images: ComfyUiGeneratedImage[] = [];
  for (const item of imageNodes.slice(0, options.node.maxBatchSize)) {
    images.push(await downloadImage(baseUrl, item, headers, Math.min(120000, options.node.pollTimeoutMs), options.maxImageBytes || 20 * 1024 * 1024));
  }
  return { promptId, seed: built.seed, images, raw: history };
}
