#!/usr/bin/env node
// R9 live soak。默认 dry-run；只有显式 --spend 才提交会消耗额度的外部生成。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { toModelNodes } from '../dist/apps/bot/src/config-bridge.js';
import { generateComfyUiImages } from '../dist/apps/bot/src/comfyui.js';
import { SunoClient } from '../dist/packages/orchestration/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const runtimeDir = process.env.MIOBOT_RUNTIME_DIR || path.join(root, '.runtime');
const configPath = process.env.MIOBOT_CONFIG_PATH || path.join(runtimeDir, 'config.json');
const args = process.argv.slice(2);
const spend = args.includes('--spend');
const wait = args.includes('--wait');
const targetArg = args.find((item) => item.startsWith('--target='))?.split('=')[1] || 'all';
const countArg = Number(args.find((item) => item.startsWith('--count='))?.split('=')[1] || 1);
const count = Math.max(1, Math.min(20, Math.trunc(countArg) || 1));
const targets = targetArg === 'all' ? ['comfyui', 'suno', 'video'] : targetArg.split(',').map((item) => item.trim()).filter(Boolean);
if (!targets.every((item) => ['comfyui', 'suno', 'video'].includes(item))) {
  console.error('target must be one of: comfyui,suno,video,all');
  process.exit(2);
}

let cfg;
try {
  cfg = normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: `config_read_failed:${String(error?.message || error)}`, configPath }, null, 2));
  process.exit(1);
}

const comfyNodes = [];
for (let index = 0; index < cfg.llm.apiKeys.length; index += 1) {
  const node = cfg.llm.apiKeys[index];
  if (node?.kind !== 'comfyui' || node.enabled === false) continue;
  const profiles = Array.isArray(node.comfyui?.profiles) ? node.comfyui.profiles.map((profile) => String(profile?.id || '')).filter(Boolean) : [];
  comfyNodes.push({ index, name: node.name || `comfy-${index}`, profiles });
}
const sunoConfigured = Boolean(cfg.orchestration.suno.enabled && cfg.orchestration.suno.baseUrl && cfg.orchestration.suno.apiKey);
const videoNode = cfg.llm.apiKeys[cfg.llm.videoNodeIndex];
const videoConfigured = Boolean(cfg.llm.videoEnabled && videoNode && videoNode.baseUrl && cfg.llm.videoModel);

const plan = {
  phase: 'R9-live-soak',
  mode: spend ? 'spend' : 'dry-run',
  wait,
  count,
  configPath,
  targets,
  externals: {
    comfyui: { configured: comfyNodes.length > 0, nodes: comfyNodes },
    suno: { configured: sunoConfigured, enabled: Boolean(cfg.orchestration.suno.enabled), model: cfg.orchestration.suno.model },
    video: { configured: videoConfigured, nodeIndex: cfg.llm.videoNodeIndex, model: cfg.llm.videoModel },
  },
};
if (!spend) {
  console.log(JSON.stringify({ ...plan, ok: true, note: 'dry-run only; pass --spend to submit live generation' }, null, 2));
  process.exit(0);
}

const client = createModelClient({ nodes: () => toModelNodes(cfg) });
const results = [];
const runOne = async (target, index) => {
  const startedAt = Date.now();
  try {
    if (target === 'comfyui') {
      const node = comfyNodes[index % Math.max(1, comfyNodes.length)];
      if (!node || !node.profiles.length) throw new Error('comfyui_node_or_profile_unavailable');
      const imageResult = await generateComfyUiImages(
        { getConfig: () => cfg, client },
        {
          nodeIndex: node.index,
          profileId: node.profiles[index % node.profiles.length],
          prompt: `R9 live soak ${Date.now()}，一只坐在窗边的橘猫，柔和自然光`,
          count: 1,
          timeoutMs: Math.max(30_000, Number(cfg.llm.imageTimeoutMs) || 300_000),
        },
      );
      results.push({ target, index, ok: true, durationMs: Date.now() - startedAt, images: imageResult.images.length });
      return;
    }
    if (target === 'suno') {
      const suno = new SunoClient({
        baseUrl: cfg.orchestration.suno.baseUrl,
        apiKey: cfg.orchestration.suno.apiKey,
        model: cfg.orchestration.suno.model,
        requestMode: cfg.orchestration.suno.requestMode,
        callbackUrl: cfg.orchestration.suno.callbackUrl,
        createPath: cfg.orchestration.suno.createPath,
        statusPath: cfg.orchestration.suno.statusPath,
        authHeader: cfg.orchestration.suno.authHeader,
        authPrefix: cfg.orchestration.suno.authPrefix,
        timeoutMs: cfg.orchestration.suno.timeoutMs,
        pollIntervalMs: cfg.orchestration.suno.pollIntervalMs,
      });
      const created = await suno.create({ prompt: `R9 live soak ${Date.now()}，轻柔钢琴与温暖人声`, instrumental: false });
      const task = wait ? await suno.wait(created.id, { timeoutMs: Math.max(60_000, Number(cfg.orchestration.suno.pollTimeoutMs) || 600_000) }) : { id: created.id, status: 'unknown', outputs: [] };
      results.push({ target, index, ok: task.status !== 'failed', durationMs: Date.now() - startedAt, taskId: created.id, status: task.status, outputs: task.outputs?.length || 0 });
      return;
    }
    if (target === 'video') {
      const submitted = [];
      const video = await client.generateVideo(cfg.llm.videoNodeIndex, {
        model: cfg.llm.videoModel,
        prompt: `R9 live soak ${Date.now()}，海边日落，镜头缓慢推进`,
        duration: 6,
        resolution: '720p',
        timeoutMs: Math.max(10_000, Number(cfg.llm.videoTimeoutMs) || 120_000),
        pollTimeoutMs: Math.max(30_000, Number(cfg.llm.videoPollTimeoutMs) || 600_000),
        pollIntervalMs: Math.max(200, Number(cfg.llm.videoPollIntervalMs) || 5_000),
        waitForCompletion: wait,
        onExternalTask: (taskId) => submitted.push(taskId),
      });
      results.push({ target, index, ok: Boolean(video.pending || video.videos?.some((item) => item.data)), durationMs: Date.now() - startedAt, pending: Boolean(video.pending), taskIds: submitted, videos: video.videos?.filter((item) => item.data).length || 0 });
    }
  } catch (error) {
    results.push({ target, index, ok: false, durationMs: Date.now() - startedAt, error: String(error?.message || error).slice(0, 500) });
  }
};

for (const target of targets) {
  const configured = target === 'comfyui' ? comfyNodes.length > 0 : target === 'suno' ? sunoConfigured : videoConfigured;
  if (!configured) {
    results.push({ target, ok: false, error: `${target}_not_configured` });
    continue;
  }
  for (let index = 0; index < count; index += 1) await runOne(target, index);
}
const ok = results.every((item) => item.ok);
console.log(JSON.stringify({ ...plan, ok, results }, null, 2));
process.exit(ok ? 0 : 1);
