import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port, stderrRef) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/canvas-api/health`);
      if (response.ok) return;
    } catch {
      // server is still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`local verify server did not start: ${stderrRef.value.slice(-800)}`);
}

test('local verify server restores legacy template library from project.interrogations', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-legacy-interrogations-'));
  const modelPort = await getFreePort();
  const modelRequests = [];
  const modelServer = http.createServer((req, res) => {
    modelRequests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
      return;
    }
    if (req.url?.startsWith('/api/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 'org/chat-a',
          author: 'org',
          pipeline_tag: 'text-generation',
          inference: 'warm',
          gated: false,
          private: false,
          downloads: 10,
          likes: 2,
          tags: ['text-generation', 'chat'],
          lastModified: '2026-06-01T00:00:00.000Z',
          inferenceProviderMapping: { cerebras: {} },
        },
        {
          id: 'org/image-a',
          author: 'org',
          pipeline_tag: 'text-to-image',
          inference: 'warm',
          downloads: 5,
          likes: 1,
        },
      ]));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve) => modelServer.listen(modelPort, '127.0.0.1', resolve));

  const assetDir = path.join(runtime, 'canvas-assets');
  await fs.mkdir(assetDir, { recursive: true });
  const assetPath = path.join(assetDir, 'legacy-template.png');
  await fs.writeFile(
    assetPath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
  );

  const createdAt = new Date().toISOString();
  await fs.writeFile(path.join(runtime, 'canvas-state.json'), JSON.stringify({
    version: 1,
    savedAt: createdAt,
    gallery: [],
    project: {
      id: 'legacy-project',
      name: 'legacy',
      history: [],
      interrogations: [{
        id: 'legacy-template',
        prompt: 'legacy prompt',
        templatePrompt: 'legacy template {{prompt}}',
        fileName: 'legacy.png',
        createdAt,
        favorite: true,
        asset: {
          id: 'legacy-template',
          url: '/canvas-api/assets/legacy-template/download',
          fileName: 'legacy-template.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          storagePath: assetPath,
        },
      }],
      updatedAt: createdAt,
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(runtime, 'config.json'), JSON.stringify({
    panel: { passwordSeed: 'change-me-on-first-login' },
    huggingFace: {
      enabled: true,
      token: 'hf-test-token',
      hubApiUrl: `http://127.0.0.1:${modelPort}/api/models`,
      filters: { pipelineTag: 'text-generation', limit: 20, onlyChatCompatible: true },
    },
  }, null, 2), 'utf8');

  const port = await getFreePort();
  const stderrRef = { value: '' };
  const child = spawn(process.execPath, ['scripts/local-verify-server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MIOBOT_RUNTIME_DIR: runtime,
      MIOBOT_PORT: String(port),
      MIOBOT_HOST: '127.0.0.1',
      MIOBOT_CODEX_PYTHON: process.execPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderrRef.value += chunk.toString(); });

  t.after(async () => {
    child.kill('SIGTERM');
    modelServer.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.rm(runtime, { recursive: true, force: true });
  });

  await waitForHealth(port, stderrRef);

  const logResponse = await fetch(`http://127.0.0.1:${port}/api/logs?limit=20`, {
    headers: { authorization: 'Bearer change-me-on-first-login' },
  });
  assert.equal(logResponse.status, 200);
  const logs = await logResponse.json();
  assert.equal(logs.success, true);
  assert.ok(String(logs.stats.logFile).endsWith('system.ndjson'));
  assert.ok(logs.entries.some((entry) => entry.scope === 'server'));
  const systemLogRaw = await fs.readFile(path.join(runtime, 'logs', 'system.ndjson'), 'utf8');
  assert.match(systemLogRaw, /"scope":"server"/);

  const codexStatusResponse = await fetch(`http://127.0.0.1:${port}/api/codex/status`, {
    headers: { authorization: 'Bearer change-me-on-first-login' },
  });
  assert.equal(codexStatusResponse.status, 200);
  const codexStatus = await codexStatusResponse.json();
  assert.equal(codexStatus.success, true);
  assert.equal(codexStatus.enabled, true);
  assert.equal(codexStatus.workspace.ok, true);
  assert.ok(Array.isArray(codexStatus.sandboxPresets));

  const codexChatResponse = await fetch(`http://127.0.0.1:${port}/api/codex/chat`, {
    method: 'POST',
    headers: { authorization: 'Bearer change-me-on-first-login', 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'status only', sandbox: 'read_only' }),
  });
  assert.equal(codexChatResponse.status, 503);
  const codexChat = await codexChatResponse.json();
  assert.equal(codexChat.success, false);
  assert.match(codexChat.installCommand, /openai-codex/);

  const modelResponse = await fetch(`http://127.0.0.1:${port}/api/fetch-models`, {
    method: 'POST',
    headers: { authorization: 'Bearer change-me-on-first-login', 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${modelPort}/v1-密钥sk-test-local`, key: '' }),
  });
  assert.equal(modelResponse.status, 200);
  const modelBody = await modelResponse.json();
  assert.deepEqual(modelBody.models, ['model-a', 'model-b']);
  assert.equal(modelBody.normalized.baseUrl, `http://127.0.0.1:${modelPort}/v1`);
  assert.equal(modelBody.normalized.keyDetected, true);
  assert.equal(modelRequests[0].url, '/v1/models');
  assert.equal(modelRequests[0].authorization, 'Bearer sk-test-local');

  const hfResponse = await fetch(`http://127.0.0.1:${port}/api/huggingface/models`, {
    method: 'POST',
    headers: { authorization: 'Bearer change-me-on-first-login', 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  assert.equal(hfResponse.status, 200);
  const hfBody = await hfResponse.json();
  assert.equal(hfBody.success, true);
  assert.equal(hfBody.models.length, 1);
  assert.equal(hfBody.models[0].code, 'hf.1');
  assert.equal(hfBody.models[0].id, 'org/chat-a');
  assert.equal(hfBody.models[0].provider, 'cerebras');
  assert.equal(hfBody.config.huggingFace.cachedModels[0].id, 'org/chat-a');
  const hfRequest = modelRequests.find((request) => request.url?.startsWith('/api/models'));
  assert.ok(hfRequest);
  assert.equal(hfRequest.authorization, 'Bearer hf-test-token');

  const listResponse = await fetch(`http://127.0.0.1:${port}/canvas-api/interrogations`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, 'legacy-template');
  assert.equal(list.items[0].favorite, true);

  const assetResponse = await fetch(`http://127.0.0.1:${port}/canvas-api/assets/legacy-template/download`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get('content-type'), 'image/png');
});
