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
  seeds?: Partial<Record<'seed' | 'detailerSeed' | 'upscaleSeed', number>>;
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
function isKrea2Profile(profile: ComfyUiProfile): boolean {
  return profile.promptPolicy?.modelFamily === 'krea-2' || /krea[-_ ]?2/i.test(`${profile.id} ${profile.name}`);
}

/** Krea 2 Turbo 的本地 KSampler 不接受 CFG 0；旧配置或模型输出 0 时强制回到 1。 */
function normalizeKreaKsamplerCfg(profile: ComfyUiProfile, workflow: Record<string, any>): void {
  if (!isKrea2Profile(profile)) return;
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, any>;
    if (record.class_type !== 'KSampler' || !record.inputs) continue;
    const cfg = Number(record.inputs.cfg);
    if (Number.isFinite(cfg) && cfg <= 0) record.inputs.cfg = 1;
  }
}

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

function getByPath(root: unknown, dottedPath: string): unknown {
  let current: any = root;
  for (const part of String(dottedPath || '').split('.').filter(Boolean)) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function hasByPath(root: unknown, dottedPath: string): boolean {
  let current: any = root;
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  if (!parts.length) return false;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object' || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

function replaceNodeReference(value: unknown, nodeId: string, replacement: [string, number]): unknown {
  if (Array.isArray(value)) {
    if (value.length === 2 && String(value[0]) === nodeId) return [...replacement];
    return value.map((item) => replaceNodeReference(item, nodeId, replacement));
  }
  if (value && typeof value === 'object') {
    const out = value as Record<string, unknown>;
    for (const key of Object.keys(out)) out[key] = replaceNodeReference(out[key], nodeId, replacement);
    return out;
  }
  return value;
}

/** Krea2 原始工作流的 negative 是 ConditioningZeroOut；配置负向文本后把它改接到提示词节点。 */
function rewireConfiguredNegativePrompt(profile: ComfyUiProfile, workflow: Record<string, any>, negativeText: string): void {
  const negativeNodeId = String(profile.negativePromptNodeIds?.[0] || '').trim();
  if (!negativeNodeId || !negativeText.trim()) return;
  for (const [id, node] of Object.entries(workflow)) {
    if (id === negativeNodeId || !node || typeof node !== 'object') continue;
    if (node.class_type !== 'ConditioningZeroOut') continue;
    for (const [targetId, target] of Object.entries(workflow)) {
      if (targetId === id || !target || typeof target !== 'object') continue;
      const inputs = target.inputs;
      if (!inputs || typeof inputs !== 'object') continue;
      const negative = inputs.negative;
      const directlyUsedAsNegative = Array.isArray(negative) && negative.length === 2 && String(negative[0]) === id;
      if (!directlyUsedAsNegative) continue;
      target.inputs = replaceNodeReference(inputs, id, [negativeNodeId, 0]) as Record<string, unknown>;
    }
    delete workflow[id];
  }
}
/** 只替换显式声明的文本节点，不改任何采样、尺寸或 LoRA 参数。 */
function applyPromptNodes(profile: ComfyUiProfile, workflow: Record<string, any>, params: Record<string, unknown>): void {
  const positive = String(params.prompt || '').trim();
  const negative = String(params.negativePrompt || '').trim();
  for (const nodeId of profile.promptNodeIds || []) {
    const node = workflow[nodeId];
    if (!node || typeof node !== 'object') throw new ComfyUiError(`ComfyUI 正向提示词节点不存在: ${nodeId}`);
    node.inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
    if (!('text' in node.inputs)) throw new ComfyUiError(`ComfyUI 节点 ${nodeId} 没有 text 输入`);
    node.inputs.text = positive;
  }
  for (const nodeId of profile.negativePromptNodeIds || []) {
    if (!negative) continue;
    const node = workflow[nodeId];
    if (!node || typeof node !== 'object') throw new ComfyUiError(`ComfyUI 负向提示词节点不存在: ${nodeId}`);
    node.inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
    if (!('text' in node.inputs)) throw new ComfyUiError(`ComfyUI 节点 ${nodeId} 没有 text 输入`);
    node.inputs.text = negative;
  }
  rewireConfiguredNegativePrompt(profile, workflow, negative);
}

export interface ComfyUiWorkflowValidation {
  ok: boolean;
  nodeCount: number;
  errors: string[];
  warnings: string[];
}

export function validateComfyUiProfile(profile: ComfyUiProfile): ComfyUiWorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const workflow = profile.workflow && typeof profile.workflow === 'object' ? profile.workflow as Record<string, any> : {};
  const nodeIds = Object.keys(workflow);
  if (!nodeIds.length) errors.push('workflow_empty');
  for (const nodeId of profile.promptNodeIds || []) {
    const node = workflow[nodeId];
    if (!node || typeof node !== 'object') errors.push(`prompt_node_missing:${nodeId}`);
    else if (!node.inputs || !('text' in node.inputs)) errors.push(`prompt_node_text_missing:${nodeId}`);
  }
  for (const nodeId of profile.negativePromptNodeIds || []) {
    const node = workflow[nodeId];
    if (!node || typeof node !== 'object') errors.push(`negative_prompt_node_missing:${nodeId}`);
    else if (!node.inputs || !('text' in node.inputs)) errors.push(`negative_prompt_node_text_missing:${nodeId}`);
  }
  if (profile.outputNodeId && !workflow[profile.outputNodeId]) errors.push(`output_node_missing:${profile.outputNodeId}`);
  for (const [key, path] of Object.entries(profile.parameterMap || {})) {
    if (!path) { errors.push(`parameter_path_empty:${key}`); continue; }
    const first = path.split('.')[0];
    if (!workflow[first]) { errors.push(`parameter_node_missing:${key}:${first}`); continue; }
    if (!hasByPath(workflow, path)) warnings.push(`parameter_path_not_present:${key}:${path}`);
  }
  if (!(profile.promptNodeIds || []).length && !profile.parameterMap?.prompt) warnings.push('prompt_node_not_configured');
  return { ok: errors.length === 0, nodeCount: nodeIds.length, errors, warnings };
}

export interface ComfyUiWorkflowNodeInfo {
  id: string;
  classType: string;
  title: string;
  inputs: string[];
  text?: string;
}

export function inspectComfyUiWorkflow(workflow: Record<string, unknown>): ComfyUiWorkflowNodeInfo[] {
  return Object.entries(workflow || {}).map(([id, value]) => {
    const node = value && typeof value === 'object' ? value as Record<string, any> : {};
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs as Record<string, unknown> : {};
    return {
      id,
      classType: String(node.class_type || node.type || ''),
      title: String(node._meta?.title || ''),
      inputs: Object.keys(inputs),
      text: typeof inputs.text === 'string' ? inputs.text.slice(0, 500) : undefined,
    };
  });
}

function isConditioningNode(node: any): boolean {
  return Boolean(node && /CLIPTextEncode|TextEncode|Conditioning/i.test(String(node.class_type || node.type || '')));
}

export function detectComfyUiPromptNodeIds(workflow: Record<string, unknown>, negativeNodeIds: string[] = []): string[] {
  const candidates = inspectComfyUiWorkflow(workflow)
    .filter((node) => isConditioningNode((workflow as any)[node.id]) && !negativeNodeIds.includes(node.id));
  const referencedPositive = new Set<string>();
  for (const node of Object.values(workflow || {})) {
    const inputs = (node as any)?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const key of ['positive', 'negative', 'conditioning']) {
      const link = inputs[key];
      if (Array.isArray(link) && link.length === 2) referencedPositive.add(String(link[0]));
    }
  }
  const preferred = candidates.filter((node) => referencedPositive.has(node.id));
  return (preferred.length ? preferred : candidates).map((node) => node.id);
}
function bypassFaceDetailerNodes(workflow: Record<string, any>): void {
  for (const [detailerId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || node.class_type !== 'FaceDetailer') continue;
    const upstream = node.inputs?.image;
    if (!Array.isArray(upstream) || upstream.length !== 2) continue;
    for (const [targetId, target] of Object.entries(workflow)) {
      if (targetId === detailerId || !target || typeof target !== 'object') continue;
      if (!target.inputs || typeof target.inputs !== 'object') continue;
      target.inputs = replaceNodeReference(target.inputs, detailerId, [String(upstream[0]), Number(upstream[1] || 0)]) as Record<string, unknown>;
    }
    delete workflow[detailerId];
  }
}
const COMFY_SEED_KEYS = ['seed', 'detailerSeed', 'upscaleSeed'] as const;
type ComfySeedKey = typeof COMFY_SEED_KEYS[number];

function randomComfySeed(): number {
  return Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 2)) + 1;
}

function deriveComfySeed(base: number, offset: number): number {
  return ((base - 1 + offset) % (Number.MAX_SAFE_INTEGER - 1)) + 1;
}

function positiveSeed(value: unknown): number | undefined {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(Number.MAX_SAFE_INTEGER, n) : undefined;
}

export function buildComfyUiWorkflow(profile: ComfyUiProfile, params: Record<string, unknown>, maxBatchSize = 4): {
  workflow: Record<string, any>;
  applied: Record<string, unknown>;
  seed?: number;
  seeds?: Partial<Record<ComfySeedKey, number>>;
} {
  const workflow = JSON.parse(JSON.stringify(profile.workflow || {})) as Record<string, any>;
  if (profile.skipFaceDetailer) bypassFaceDetailerNodes(workflow);
  const merged = { ...(profile.defaults || {}), ...(params || {}) } as Record<string, unknown>;
  if (merged.batchSize !== undefined) {
    const n = Math.trunc(Number(merged.batchSize));
    merged.batchSize = Number.isFinite(n) ? Math.min(maxBatchSize, Math.max(1, n)) : 1;
  }
  const seedKeys = COMFY_SEED_KEYS.filter((key) => merged[key] !== undefined || profile.parameterMap?.[key]);
  let seeds: Partial<Record<ComfySeedKey, number>> | undefined;
  if (seedKeys.length) {
    const requestedMainSeed = positiveSeed(merged.seed);
    const baseSeed = requestedMainSeed || randomComfySeed();
    const offsets: Record<ComfySeedKey, number> = { seed: 0, detailerSeed: 1, upscaleSeed: 2 };
    seeds = {};
    for (const key of seedKeys) {
      const requested = key === 'seed' ? requestedMainSeed : positiveSeed(merged[key]);
      const value = requested || deriveComfySeed(baseSeed, offsets[key]);
      merged[key] = value;
      seeds[key] = value;
    }
  }
  const applied: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(profile.parameterMap || {})) {
    if (!path) continue;
      if (profile.skipFaceDetailer && (key.startsWith('detailer') || key === 'guideSize')) continue;
    const value = merged[key];
    if (value === undefined) continue;
    if (key === 'batchSize' && !profile.parameterMap?.batchSize) continue;
    setByPath(workflow, path, value);
    applied[key] = value;
  }
  applyComfyUiLora(profile, workflow, merged);
  applyPromptNodes(profile, workflow, merged);
  normalizeKreaKsamplerCfg(profile, workflow);
  return { workflow, applied, seed: seeds?.seed, seeds };
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

async function cancelQueuedComfyPrompt(baseUrl: string, headers: Record<string, string>, promptId: string): Promise<void> {
  try {
    await fetchJson(`${baseUrl}/queue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ delete: [promptId] }),
    }, 10000);
  } catch { /* 取消失败不能掩盖原始超时 */ }
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
  const nodeErrors = asRecord(submitted).node_errors;
  if (nodeErrors && Object.keys(nodeErrors).length) {
    throw new ComfyUiError('ComfyUI workflow 节点参数错误', { code: 'node_errors' });
  }
  const promptId = String(asRecord(submitted).prompt_id || '');
  if (!promptId) throw new ComfyUiError('ComfyUI 没有返回 prompt_id', { code: 'node_errors' });

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
    if (!history.outputs) {
      await cancelQueuedComfyPrompt(baseUrl, headers, promptId);
      throw new ComfyUiError('ComfyUI 任务轮询超时', { code: 'poll_timeout' });
    }

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
  return { promptId, seed: built.seed, seeds: built.seeds, images, raw: history };
}
