import test from 'node:test';
import assert from 'node:assert/strict';

import { applyFix, diagnose, describeLearned, healingKey, resetLearned } from '../dist/packages/model/src/capability/healing.js';
import { createModelClient } from '../dist/packages/model/src/client.js';
import { createCapabilityRegistry } from '../dist/packages/model/src/capability/registry.js';
import { CHAT_PROFILE } from '../dist/packages/model/src/capability/profiles.js';
import { parseOpenAiText } from '../dist/packages/model/src/dialects/shared.js';

/**
 * 参数自愈。让"没见过的中转"也能跑通的机制，
 * 但它必须只在**参数问题**上重试——把服务故障或鉴权失败当参数问题重试，
 * 只会放大故障、拖慢失败反馈。
 */

function errorBody(message) {
  return { error: { message } };
}

test('diagnose: 识别被拒的参数名', () => {
  assert.deepEqual(
    diagnose(400, errorBody("Unsupported parameter: 'max_tokens' is not supported with this model."), { model: 'x', max_tokens: 100 }),
    { action: 'drop', param: 'max_tokens' },
  );
});

test('diagnose: 上游给了替代名就改名而不是剔除', () => {
  assert.deepEqual(
    diagnose(400, errorBody("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."), { model: 'x', max_tokens: 100 }),
    { action: 'rename', param: 'max_tokens', to: 'max_completion_tokens' },
  );
});

test('diagnose: Unknown parameter 形态同样识别', () => {
  assert.deepEqual(
    diagnose(400, errorBody("Unknown parameter: 'response_format'."), { model: 'x', response_format: 'b64_json' }),
    { action: 'drop', param: 'response_format' },
  );
});

test('diagnose: 参数不在本次请求体里就不处理', () => {
  assert.equal(diagnose(400, errorBody("Unsupported parameter: 'audio'."), { model: 'x', max_tokens: 1 }), undefined);
});

test('diagnose: 服务故障与鉴权失败不算参数问题', () => {
  assert.equal(diagnose(503, errorBody('service unavailable'), { model: 'x', max_tokens: 1 }), undefined);
  assert.equal(diagnose(401, errorBody('Invalid API key provided'), { model: 'x', max_tokens: 1 }), undefined);
  assert.equal(diagnose(429, errorBody('rate limit exceeded'), { model: 'x', max_tokens: 1 }), undefined);
});

test('applyFix: 改名保留取值, 剔除不伤其它字段', () => {
  assert.deepEqual(
    applyFix({ model: 'm', max_tokens: 2000 }, { action: 'rename', param: 'max_tokens', to: 'max_completion_tokens' }),
    { model: 'm', max_completion_tokens: 2000 },
  );
  assert.deepEqual(
    applyFix({ model: 'm', n: 1, response_format: 'b64_json' }, { action: 'drop', param: 'response_format' }),
    { model: 'm', n: 1 },
  );
});

/** 构造一个可控上游：按模型名决定拒收哪个参数。 */
function makeTransport(reject) {
  const seen = [];
  const transport = async (request) => {
    seen.push({ ...request.body });
    const bad = reject(request.body);
    if (bad) return { status: 400, data: errorBody(bad) };
    return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } };
  };
  return { transport, seen };
}

function makeClient(transport) {
  return createModelClient({
    nodes: [{ name: 'n', baseUrl: 'https://api.example.com/v1', apiKey: 'k', dialect: 'openai' }],
    registry: createCapabilityRegistry({ fallback: CHAT_PROFILE }),
    transport,
  });
}

test('自愈: 按提示改名后重试成功, 并记住结论', async () => {
  resetLearned();
  const { transport, seen } = makeTransport((body) =>
    'max_tokens' in body ? "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." : null);
  const client = makeClient(transport);

  const result = await client.chat(0, { model: 'mystery-model', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000 });
  assert.equal(result.text, 'ok');
  assert.equal(seen.length, 2, '第一轮被拒, 第二轮改名后成功');
  assert.equal(seen[1].max_completion_tokens, 2000);
  assert.deepEqual(describeLearned(healingKey(0, 'mystery-model')).renamed, { max_tokens: 'max_completion_tokens' });
});

test('自愈: 学到之后第二次请求一轮直达', async () => {
  resetLearned();
  const reject = (body) => ('max_tokens' in body ? "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." : null);

  const first = makeTransport(reject);
  await makeClient(first.transport).chat(0, { model: 'mystery-model', messages: [], maxTokens: 2000 });
  assert.equal(first.seen.length, 2);

  const second = makeTransport(reject);
  await makeClient(second.transport).chat(0, { model: 'mystery-model', messages: [], maxTokens: 2000 });
  assert.equal(second.seen.length, 1, '第二次应直接用正确形态');
});

test('自愈: 无替代名时剔除该参数', async () => {
  resetLearned();
  const { transport, seen } = makeTransport((body) =>
    'response_format' in body ? "Unknown parameter: 'response_format'." : null);
  const client = createModelClient({
    nodes: [{ name: 'n', baseUrl: 'https://api.example.com/v1', apiKey: 'k', dialect: 'openai' }],
    registry: createCapabilityRegistry({ fallback: { operations: ['image.generate'] } }),
    transport: async (req) => {
      const r = await transport(req);
      return r.status === 200 ? { status: 200, data: { data: [{ b64_json: 'AAA' }] } } : r;
    },
  });

  const result = await client.generateImages(0, { model: 'weird-image-model', prompt: 'cat' });
  assert.equal(result.images.length, 1);
  assert.equal(seen.length, 2);
  assert.equal('response_format' in seen[1], false);
});

test('自愈: 非参数错误不重试, 立即上抛', async () => {
  resetLearned();
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return { status: 503, data: errorBody('upstream is temporarily unavailable') };
  });
  await assert.rejects(() => client.chat(0, { model: 'gpt-4o', messages: [] }), /unavailable/i);
  assert.equal(calls, 1);
});

test('自愈: 鉴权失败不会被反复重试', async () => {
  resetLearned();
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return { status: 401, data: errorBody('Invalid API key provided') };
  });
  await assert.rejects(() => client.chat(0, { model: 'gpt-4o', messages: [] }), /Invalid API key/);
  assert.equal(calls, 1);
});

test('自愈: 轮数有上限, 不会无限打转', async () => {
  resetLearned();
  let calls = 0;
  const client = makeClient(async (request) => {
    calls += 1;
    const extra = Object.keys(request.body).filter((k) => k !== 'model' && k !== 'messages')[0];
    return { status: 400, data: errorBody(`Unsupported parameter: '${extra || 'model'}'.`) };
  });
  await assert.rejects(() => client.chat(0, {
    model: 'greedy-model', messages: [], maxTokens: 1, temperature: 0.5,
  }));
  assert.ok(calls <= 5, `自愈轮数应有上限, 实际 ${calls}`);
});

/** 响应校验：这两种情况以前只会给一句看不懂的 "missing choices"。 */
test('响应校验: Gemini 安全拦截的空 choices 给出明确原因', () => {
  assert.throws(
    () => parseOpenAiText({ choices: [], prompt_feedback: { blockReason: 'SAFETY' } }),
    (err) => err.code === 'content_filtered' && /安全策略/.test(err.message),
  );
});

test('响应校验: 输出被 token 上限截断有专门提示', () => {
  assert.throws(
    () => parseOpenAiText({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    (err) => err.code === 'output_truncated' && /截断/.test(err.message),
  );
});

test('响应校验: 正文在 reasoning_content 里时能兜底取到', () => {
  const result = parseOpenAiText({ choices: [{ message: { content: '', reasoning_content: '推理正文' } }] });
  assert.equal(result.text, '推理正文');
});
