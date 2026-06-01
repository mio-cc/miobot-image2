#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { importConfig } from '../dist/packages/config/src/index.js';
import { createOpenAICompatibleAdapter } from '../dist/packages/llm/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config || process.env.MIOBOT_TRACE_CONFIG || '');

if (!configPath) {
  console.error('用法：node scripts/trace-canvas-generation.mjs --config <配置.json> [--prompt "测试提示词"]');
  process.exit(2);
}

const timings = [];
const transportTimings = [];
const startedAt = performance.now();
let lastMark = startedAt;

function mark(name, details = {}) {
  const now = performance.now();
  timings.push({
    step: name,
    ms: Math.round(now - lastMark),
    totalMs: Math.round(now - startedAt),
    ...details,
  });
  lastMark = now;
}

try {
  const raw = await fs.readFile(configPath, 'utf8');
  const payload = JSON.parse(raw.replace(/^\uFEFF/u, ''));
  mark('读取配置文件');

  const imported = importConfig(payload);
  const config = imported.config;
  mark('导入并迁移配置', {
    migrations: imported.migrations.length,
    warnings: imported.warnings.length,
  });

  const canvas = config.canvas || {};
  const node = resolveEnabledNode(config.llm?.apiKeys, canvas.imageNodeIndex);
  if (!node?.baseUrl) {
    throw new Error('默认生图节点没有可用 baseUrl，请先在后台配置并启用节点。');
  }

  const model = canvas.imageModel || config.llm?.imageModel;
  if (!model) throw new Error('默认生图模型为空。');

  const size = args.size || sizeFromPreset(canvas.defaultSizePresetId);
  const count = Number(args.count || canvas.defaultCount || 1);
  const quality = args.quality || canvas.defaultQuality || undefined;
  const prompt = args.prompt || process.env.MIOBOT_TRACE_PROMPT || '一只白色小猫坐在窗边，清晨柔光，干净背景';
  const timeoutMs = Number(args.timeout || canvas.imageTimeoutMs || config.llm?.imageTimeoutMs || 300000);
  mark('解析默认生图节点', {
    node: safeNodeName(node),
    model,
    size,
    count,
    quality: quality || 'auto',
    timeoutMs,
  });

  const adapter = createOpenAICompatibleAdapter({
    node: {
      name: node.name,
      provider: node.provider,
      baseUrl: node.baseUrl,
      apiKey: node.apiKey ?? node.key,
      key: node.key,
      headers: node.headers,
    },
    timeoutMs,
    retryPolicy: { retries: 0, delayMs: 0 },
    transport: async (request) => {
      const transportStart = performance.now();
      const body = JSON.stringify(request.body);
      transportTimings.push({ step: '序列化请求体', ms: Math.round(performance.now() - transportStart), bytes: Buffer.byteLength(body) });

      const fetchStart = performance.now();
      let response;
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body,
        });
      } catch (error) {
        transportTimings.push({
          step: '等待上游响应头',
          ms: Math.round(performance.now() - fetchStart),
          status: 'network-error',
          error: error?.cause?.code || error?.message || String(error),
        });
        throw error;
      }
      transportTimings.push({ step: '等待上游响应头', ms: Math.round(performance.now() - fetchStart), status: response.status });

      const readStart = performance.now();
      const text = await response.text();
      transportTimings.push({ step: '读取上游响应体', ms: Math.round(performance.now() - readStart), bytes: Buffer.byteLength(text) });

      const parseStart = performance.now();
      const data = (response.headers.get('content-type') || '').includes('application/json') ? JSON.parse(text) : text;
      transportTimings.push({ step: '解析上游响应 JSON', ms: Math.round(performance.now() - parseStart) });

      return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
    },
  });

  const requestStartedAt = performance.now();
  const result = await adapter.generateImages({
    model,
    prompt,
    size,
    count,
    quality: quality === 'auto' ? undefined : quality,
    timeoutMs,
  });
  mark('上游生图 API 完成', {
    apiTotalMs: Math.round(performance.now() - requestStartedAt),
    status: result.status,
    imageCount: result.images.length,
  });

  const outputDir = path.resolve(args.out || process.env.MIOBOT_TRACE_OUT || path.join(root, '.runtime', 'trace-output'));
  await fs.mkdir(outputDir, { recursive: true });
  const files = [];
  for (const image of result.images) {
    if (image.kind !== 'base64') {
      files.push({ kind: image.kind, saved: false });
      continue;
    }
    const extension = extensionFromMime(image.mimeType);
    const file = path.join(outputDir, `trace-${Date.now()}-${image.index + 1}.${extension}`);
    await fs.writeFile(file, image.data, 'base64');
    files.push({ kind: image.kind, saved: true, file, bytes: Buffer.byteLength(image.data, 'base64') });
  }
  mark('落盘验证图片', { outputDir, saved: files.filter((item) => item.saved).length });

  const summary = {
    success: true,
    configFile: configPath,
    node: safeNodeName(node),
    model,
    size,
    count,
    quality: quality || 'auto',
    totalMs: Math.round(performance.now() - startedAt),
    timings,
    transportTimings,
    outputs: files,
  };

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    success: false,
    message: error?.cause?.code ? `${error.message}: ${error.cause.code}` : (error?.message || String(error)),
    totalMs: Math.round(performance.now() - startedAt),
    timings,
    transportTimings,
  }, null, 2));
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = '1';
    }
  }
  if (!out.config && argv[0] && !argv[0].startsWith('--')) out.config = argv[0];
  return out;
}

function resolveEnabledNode(nodes, index) {
  const list = Array.isArray(nodes) ? nodes : [];
  const preferred = list[Math.max(0, Math.min(list.length - 1, Number(index) || 0))];
  return preferred && preferred.enabled !== false ? preferred : list.find((node) => node?.enabled !== false);
}

function safeNodeName(node) {
  return {
    name: node?.name || '未命名节点',
    provider: node?.provider || '',
    baseUrl: node?.baseUrl ? '[redacted-url]' : '',
    keyConfigured: Boolean(node?.key || node?.apiKey),
  };
}

function sizeFromPreset(presetId) {
  const id = String(presetId || '');
  if (id === 'auto') return 'auto';
  if (id.includes('portrait')) return '1024x1536';
  if (id.includes('landscape')) return '1536x1024';
  if (id.includes('wide')) return '1536x864';
  return '1024x1024';
}

function extensionFromMime(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}
