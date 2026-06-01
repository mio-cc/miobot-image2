import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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

  const port = await getFreePort();
  const stderrRef = { value: '' };
  const child = spawn(process.execPath, ['scripts/local-verify-server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MIOBOT_RUNTIME_DIR: runtime,
      MIOBOT_PORT: String(port),
      MIOBOT_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderrRef.value += chunk.toString(); });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.rm(runtime, { recursive: true, force: true });
  });

  await waitForHealth(port, stderrRef);

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
