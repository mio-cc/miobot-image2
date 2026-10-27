import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { TtsCapabilityHandler } from '../dist/apps/bot/src/capability-basic.js';
import { builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';

test('tts.speak never falls back to the user request when text is missing', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.tts.enabled = true;
  const handler = new TtsCapabilityHandler(() => cfg);
  const result = await handler.execute({
    request: { text: '我要你用语音', chat: { type: 'group', groupId: '1098867961' }, user: { qq: '1' }, attachments: [] },
    plan: { planId: 'p', steps: [] }, step: { id: 's', capability: 'tts.speak', args: {} }, dependencyResults: {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'tts_text_required');
  assert.deepEqual(result.outputs, []);
});


test('tts.speak: contract requires explicit text and stays orthogonal to reply delivery mode', () => {
  const descriptor = builtinCapabilityDescriptors().find((item) => item.id === 'tts.speak');
  assert.ok(descriptor);
  assert.match(descriptor.description, /明确提供|明确文本/);
  assert.match(descriptor.description, /不改变最终回复的呈现方式|reply.presentation/);
  assert.deepEqual(descriptor.inputSchema?.required, ['text']);
});
