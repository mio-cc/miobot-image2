import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { applyCapabilityOverrides, builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';
import { toolSpecFromCapabilityDescriptor } from '../dist/packages/tool-runtime/src/index.js';
import { ExplicitExecutor } from '../dist/apps/bot/src/explicit-executor.js';

test('image routing: capability override hides image.generate before Agent loadout', () => {
  const descriptors = applyCapabilityOverrides(builtinCapabilityDescriptors(), {
    'image.generate': { enabled: false },
  });
  const byId = new Map(descriptors.map((item) => [item.id, item]));
  const image = toolSpecFromCapabilityDescriptor(byId.get('image.generate'));
  const code = toolSpecFromCapabilityDescriptor(byId.get('code.render'));
  assert.equal(image.enabled, false);
  assert.equal(image.exposure, 'hidden');
  assert.equal(code.enabled, true);
  assert.notEqual(code.exposure, 'hidden');
});

test('image routing: llm.imageEnabled=false falls back to chat and logs the reason', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.imageEnabled = false;
  cfg.llm.imageModel = 'krea-2-turbo';
  const warnings = [];
  const deps = {
    async chat() { return { text: 'fallback chat' }; },
    async generateImages() { return { images: ['should-not-run'] }; },
  };
  const executor = new ExplicitExecutor({
    deps,
    getConfig: () => cfg,
    registry: () => ({ can: () => true }),
    log: { info() {}, warn(message, data) { warnings.push({ message, data }); }, error() {} },
  });
  const result = await executor.handleExplicit('image.generate', { text: '画一只猫' }, { prompt: '画一只猫' });
  assert.equal(result.kind, 'chat');
  assert.equal(result.text, 'fallback chat');
  assert.equal(warnings[0]?.data?.reason, 'llm.imageEnabled=false');
});

test('image routing: enabled image.generate reaches the image deps provider boundary', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.imageEnabled = true;
  cfg.llm.imageModel = 'krea-2-turbo';
  let generated = false;
  const deps = {
    async chat() { return { text: 'unused' }; },
    async generateImages(req) { generated = true; assert.equal(req.model, 'krea-2-turbo'); return { images: ['https://fake.test/krea.png'] }; },
  };
  const executor = new ExplicitExecutor({
    deps,
    getConfig: () => cfg,
    registry: () => ({ can: () => true }),
  });
  const result = await executor.handleExplicit('image.generate', { text: '画一只猫' }, { prompt: '画一只猫' });
  assert.equal(generated, true);
  assert.equal(result.kind, 'image.generate');
  assert.deepEqual(result.images, ['https://fake.test/krea.png']);
});
