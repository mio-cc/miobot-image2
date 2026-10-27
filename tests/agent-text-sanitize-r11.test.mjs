import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStructuredPayload, stripInlineImagePayloads } from '../dist/packages/agent-runtime/src/index.js';
import { sendResult } from '../dist/apps/bot/src/runtime.js';

test('agent text sanitize: inline image data URLs never leak into visible text', () => {
  const input = '画好了 data:image/png;base64,AAAAAA== 请看';
  assert.equal(stripInlineImagePayloads(input), '画好了 [图片数据已省略] 请看');
  assert.equal(stripInlineImagePayloads('![结果](data:image/png;base64,BBBBBB==)'), '![结果](图片)');
  assert.equal(stripInlineImagePayloads('base64://CCCCCC=='), '[图片数据已省略]');
});

test('agent text sanitize: structured tool payload keeps shape but strips image payload fields', () => {
  const result = sanitizeStructuredPayload({
    content: 'data:image/jpeg;base64,DDDDDD==',
    outputs: [{ kind: 'image', url: 'data:image/png;base64,EEEEEE==', meta: { ok: true } }],
  });
  assert.deepEqual(result, {
    content: '[图片数据已省略]',
    outputs: [{ kind: 'image', url: '[图片数据已省略]', meta: { ok: true } }],
  });
});


test('reply plan: data image URLs are stripped before the engine sends text', async () => {
  const received = [];
  const engine = {
    async replyPlan(_ctx, plan) { received.push(plan); return { success: true, sentCount: 1, truncatedCount: 0 }; },
    async replyText() { return { success: true, messageId: 1 }; },
  };
  const result = {
    kind: 'chat', handled: true,
    replyPlan: { groups: [{ outputs: [{ kind: 'text', text: '结果 data:image/png;base64,AAAA== 完成' }], messageCount: 1 }], messageCount: 1 },
  };
  await sendResult(engine, { chatType: 'private', userId: '1', senderId: '1', botName: 'Miobot' }, result);
  assert.equal(received.length, 1);
  assert.doesNotMatch(received[0].groups[0].outputs[0].text, /base64/i);
});
