import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { handleCodeRenderRequest } from '../dist/apps/bot/src/runtime.js';
import { builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';

function optionsFor(chat, logs = []) {
  const cfg = createDefaultConfig();
  cfg.codeRender.enabled = true;
  cfg.codeRender.nodeIndex = 0;
  cfg.codeRender.model = 'code-test';
  return {
    app: { client: { async chat(_node, request) { return chat(request); } } },
    getConfig: () => cfg,
    browserRenderer: { async renderCode(artifact) { return { path: 'C:/tmp/rendered.png' }; } },
    generatedFileDir: 'C:/tmp',
    uploadFile: async () => 'https://fake.test/code.png',
    logger: {
      info(message, data) { logs.push({ level: 'info', message, data }); },
      warn(message, data) { logs.push({ level: 'warn', message, data }); },
      error(message, data) { logs.push({ level: 'error', message, data }); },
    },
  };
}

test('code.render: fenced JSON is accepted after protocol noise', async () => {
  const options = optionsFor(async () => ({ text: 'Here is the result:\n```json\n{"format":"svg","title":"button","svg":"<svg/>"}\n```' }));
  const result = await handleCodeRenderRequest(options, '用 SVG 画按钮', 'private', undefined, '1', 's');
  assert.equal(result.result?.images?.[0], 'https://fake.test/code.png');
});

test('code.render: raw SVG markup is accepted when model ignores JSON protocol', async () => {
  const options = optionsFor(async () => ({ text: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>' }));
  const result = await handleCodeRenderRequest(options, '用 SVG 画圆形', 'private', undefined, '1', 's');
  assert.equal(result.result?.images?.length, 1);
});

test('code.render: empty model output retries once and then succeeds', async () => {
  let calls = 0;
  const options = optionsFor(async () => {
    calls += 1;
    return { text: calls === 1 ? '' : '{"format":"html","html":"<html><body>ok</body></html>"}' };
  });
  const result = await handleCodeRenderRequest(options, '用代码画一个按钮', 'private', undefined, '1', 's');
  assert.equal(calls, 2);
  assert.equal(result.result?.images?.length, 1);
});

test('code.render: malformed output gets one repair call', async () => {
  let calls = 0;
  const options = optionsFor(async () => {
    calls += 1;
    return { text: calls === 1 ? 'I cannot follow JSON' : '{"format":"canvas","html":"<canvas></canvas>","js":"window.__MIOBOT_READY__=true"}' };
  });
  const result = await handleCodeRenderRequest(options, '用 Canvas 画图', 'private', undefined, '1', 's');
  assert.equal(calls, 2);
  assert.equal(result.result?.images?.length, 1);
});

test('code.render: empty output twice fails with stage diagnostics, not silent success', async () => {
  const logs = [];
  const options = optionsFor(async () => ({ text: '' }), logs);
  await assert.rejects(
    () => handleCodeRenderRequest(options, '用代码画一只猫', 'private', undefined, '1', 's'),
    /代码模型返回空文本/,
  );
  assert.ok(logs.some((entry) => entry.message === '代码画图失败' && entry.data?.stage === 'parse'));
  assert.ok(logs.some((entry) => entry.message === '代码画图模型返回空文本，重试一次'));
});

test('code.render: node index auto-corrects when configured model belongs to another node', async () => {
  const options = optionsFor(async () => ({ text: '{"format":"svg","svg":"<svg/>"}' }));
  const cfg = options.getConfig();
  cfg.llm.apiKeys[0].models = ['other-model'];
  cfg.llm.apiKeys.push({ ...cfg.llm.apiKeys[0], name: 'code node', models: ['code-test'] });
  let seenNode = -1;
  options.app.client = { async chat(node, request) { seenNode = node; return { text: '{"format":"svg","svg":"<svg/>"}' }; } };
  const result = await handleCodeRenderRequest(options, '用 SVG 画按钮', 'private', undefined, '1', 's');
  assert.equal(seenNode, 1);
  assert.equal(result.result?.images?.length, 1);
});

test('code.render: empty/erroring primary model falls back to the Agent main model', async () => {
  const options = optionsFor(async () => ({ text: '' }));
  const cfg = options.getConfig();
  cfg.codeRender.model = 'broken-code-model';
  cfg.agent.mainNodeIndex = 1;
  cfg.agent.mainModel = 'good-agent-model';
  cfg.llm.apiKeys.push({ ...cfg.llm.apiKeys[0], name: 'agent-node', models: ['good-agent-model'] });
  const seenModels = [];
  options.app.client = {
    async chat(_node, request) {
      seenModels.push(request.model);
      if (request.model === 'broken-code-model') throw new Error('primary unavailable');
      return { text: '{"format":"svg","svg":"<svg><circle cx="50" cy="50" r="40"/></svg>"}' };
    },
  };
  const result = await handleCodeRenderRequest(options, '用代码画一个鲸鱼娘', 'private', undefined, '1', 's');
  assert.equal(result.result?.images?.length, 1);
  assert.deepEqual(seenModels, ['broken-code-model', 'good-agent-model']);
});

test('code.render: prompt carries the quality contract for generated illustrations', async () => {
  let prompt = '';
  const options = optionsFor(async (request) => {
    prompt = String(request.messages[0].content);
    return { text: '{"format":"svg","svg":"<svg/>"}' };
  });
  await handleCodeRenderRequest(options, '用代码画一个鲸鱼娘', 'private', undefined, '1', 's');
  assert.match(prompt, /代码画图质量要求/);
  assert.match(prompt, /完整.*构图/);
});


test('code.render: tool contract is semantic and describes artifact fit, not trigger words', () => {
  const descriptor = builtinCapabilityDescriptors().find((item) => item.id === 'code.render');
  assert.ok(descriptor);
  assert.match(descriptor.description, /可检查|可复现|源码/);
  assert.match(descriptor.description, /图像生成|位图/);
  assert.doesNotMatch(descriptor.description, /用户说|用代码画XX/);
  assert.deepEqual(descriptor.inputSchema?.required, ['userContent']);
});
