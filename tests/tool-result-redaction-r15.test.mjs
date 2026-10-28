import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeStructuredPayload, redactSecrets, stripInlineImagePayloads } from '../dist/packages/agent-runtime/src/text-sanitize.js';

// ═══ R15/#10：工具结果回填前的秘钥脱敏 ═══

test('R15/N-3: secret keys in tool results are redacted before model roundtrip', () => {
  const payload = {
    callId: 'c1',
    ok: true,
    toolName: 'config.update',
    content: '配置已更新',
    config: {
      llm: { apiKey: 'sk-1234567890abcdef', chatModel: 'gpt-4o' },
      napcat: { token: 'napcat-secret-token', wsUrl: 'ws://localhost:3001' },
    },
    apiKey: 'sk-abcdef',
    Authorization: 'Bearer xyz',
    normalField: 'untouched',
  };
  const out = sanitizeStructuredPayload(payload);
  const cfg = (out).config;
  assert.equal(cfg.llm.apiKey, '[已脱敏]');
  assert.equal(cfg.napcat.token, '[已脱敏]');
  assert.equal((out).apiKey, '[已脱敏]');
  assert.equal((out).Authorization, '[已脱敏]');
  assert.equal(cfg.llm.chatModel, 'gpt-4o', '非秘钥字段不脱敏');
  assert.equal((out).normalField, 'untouched');
  assert.equal((out).content, '配置已更新');
  assert.equal(JSON.stringify(out).includes('sk-1234567890abcdef'), false, '原秘钥值不得出现在序列化结果中');
});

test('R15/N-3: redactSecrets handles arrays and nested structures', () => {
  const out = redactSecrets({
    nodes: [
      { name: 'n1', key: 'abc', password: 'p1' },
      { name: 'n2', key: 'def', password: 'p2' },
    ],
    list: ['x', { secret: 's3' }],
  });
  assert.equal(out.nodes[0].key, '[已脱敏]');
  assert.equal(out.nodes[0].password, '[已脱敏]');
  assert.equal(out.nodes[1].key, '[已脱敏]');
  assert.equal(out.list[1].secret, '[已脱敏]');
  assert.equal(out.list[0], 'x');
});

test('R15/N-3: empty-string secrets are preserved as-is (falsy passthrough)', () => {
  const out = sanitizeStructuredPayload({ apiKey: '', hint: 'k' });
  assert.equal(out.apiKey, '');
});

test('R15/N-3: image payload stripping still intact', () => {
  const out = sanitizeStructuredPayload({ content: 'before ![img](data:image/png;base64,AAAA) after' });
  assert.ok(!String(out.content).includes('base64'), 'base64 内联图必须被剥除');
  assert.ok(String(out.content).includes('before'), '周边文本保留');
});