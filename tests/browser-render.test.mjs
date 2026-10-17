import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { CHROMIUM_LAUNCH_ARGS, assertSafePublicUrl, buildCodeDocument, normalizeCodeArtifact } from '../dist/packages/browser-render/src/index.js';

test('browser render: config defaults and hard limits', () => {
  const config = normalizeConfig({});
  assert.equal(config.browserRender.enabled, true);
  assert.equal(config.browserRender.maxConcurrency, 1);
  assert.equal(config.browserRender.maxQueue, 3);
  assert.equal(config.codeRender.enabled, true);
  assert.equal(config.codeRender.timeoutMs, 30000);
});

test('browser render: Chromium arguments include resource limits and exclude dangerous flags', () => {
  const args = CHROMIUM_LAUNCH_ARGS.join(' ');
  assert.match(args, /--disable-dev-shm-usage/);
  assert.match(args, /--renderer-process-limit=1/);
  assert.match(args, /--js-flags=--max-old-space-size=512/);
  assert.match(args, /--disable-background-networking/);
  assert.doesNotMatch(args, /--disable-web-security/);
  assert.doesNotMatch(args, /--allow-file-access-from-files/);
});

test('browser render: code artifact is clamped and validated', () => {
  const config = normalizeConfig({});
  const spec = normalizeCodeArtifact({ format: 'canvas', width: 99999, height: 1, js: 'const c=document.querySelector("canvas")' }, config.browserRender);
  assert.equal(spec.width, config.browserRender.maxWidth);
  assert.equal(spec.height, 128);
  assert.throws(() => normalizeCodeArtifact({ format: 'svg', svg: '' }, config.browserRender), /SVG/);
  assert.throws(() => normalizeCodeArtifact({ format: 'html', html: '' }, config.browserRender), /HTML/);
});

test('browser render: SVG and Three.js documents are self-contained', async () => {
  const config = normalizeConfig({});
  const svg = normalizeCodeArtifact({ format: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"/></svg>' }, config.browserRender);
  const svgHtml = await buildCodeDocument(svg);
  assert.match(svgHtml, /<circle/);
  const three = normalizeCodeArtifact({ format: 'three', js: 'window.__MIOBOT_READY__=true;' }, config.browserRender);
  const threeHtml = await buildCodeDocument(three);
  assert.match(threeHtml, /THREE/);
  assert.match(threeHtml, /__MIOBOT_READY__/);
});

test('browser render: SSRF guard rejects local/private/file URLs', async () => {
  await assert.rejects(() => assertSafePublicUrl('http://127.0.0.1/'), /本机|内网|保留/);
  await assert.rejects(() => assertSafePublicUrl('http://localhost/'), /本机|内网|保留/);
  await assert.rejects(() => assertSafePublicUrl('file:///etc/passwd'), /http\/https/);
  await assert.rejects(() => assertSafePublicUrl('http://user:pass@example.com/'), /用户名|密码/);
});
