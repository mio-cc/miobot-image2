import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotEngine } from '../dist/packages/bot-engine/src/index.js';
import { createDefaultConfig, normalizeConfig } from '../dist/packages/config/src/index.js';
import { toEngineRoutingConfig } from '../dist/apps/bot/src/config-bridge.js';

test('bot engine: beforeDispatch receives feature id and release is always called', async () => {
  const cfg = normalizeConfig(createDefaultConfig());
  const calls = [];
  let released = false;
  const engine = createBotEngine({
    deps: {
      chat: async () => ({ text: 'ok' }),
      generateImages: async () => ({ images: ['data:image/png;base64,AAAA'] }),
      editImage: async () => ({ images: [] }),
      interrogate: async () => ({ text: 'ok' }),
      generateVideo: async () => ({ videos: [] }),
    },
    getConfig: () => toEngineRoutingConfig(cfg),
    beforeDispatch: async (decision, input) => {
      calls.push({ kind: decision.kind, featureId: input.featureId, groupId: input.featureContext?.groupId });
      return () => { released = true; };
    },
  });
  const result = await engine.handleExplicit('image.generate', {
    text: '猫',
    chatType: 'group',
    featureId: 'image.generate',
    featureContext: { chatType: 'group', groupId: '1', userId: '2', promptChars: 1 },
  }, { prompt: '猫' });
  assert.equal(result.kind, 'image.generate');
  assert.deepEqual(calls, [{ kind: 'image.generate', featureId: 'image.generate', groupId: '1' }]);
  assert.equal(released, true);
});
