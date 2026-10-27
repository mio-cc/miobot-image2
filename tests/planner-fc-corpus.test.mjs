import test from 'node:test';
import assert from 'node:assert/strict';

import { planWithModel } from '../dist/packages/orchestration/src/planner.js';
import { parseOpenAiText } from '../dist/packages/model/src/dialects/shared.js';

/**
 * T3.2 planner 双通道语料：同一组用户输入，Function Calling 通道与 JSON 通道
 * 必须产出等价的规范化计划（capability/步骤结构）——通道只是出参格式的差别。
 *
 * 旧意图路由模块已删除；本语料只验证当前 planner 的 function-calling 契约。
 * （不接模型的正则/词库直判），这份测 planner 的两条模型出参通道。
 */
const corpus = [
  { text: '今天北京天气怎么样', capability: 'web.search', goal: 'answer' },
  { text: '画一只柴犬', capability: 'image.generate', goal: 'generate' },
  { text: '把这张图改成赛博朋克风格', capability: 'image.edit', goal: 'transform' },
  { text: '给我写一首关于夏天的歌', capability: 'audio.music.generate', goal: 'generate' },
  { text: '查一下 gpt-5 的发布日期并总结要点', capability: 'web.search', goal: 'answer', second: 'chat.reply' },
  { text: '搜柴犬图片然后画一张类似的', capability: 'web.search', goal: 'generate', second: 'image.generate' },
  { text: '帮我看看这张图里有什么', capability: 'image.interrogate', goal: 'answer' },
  { text: '生成一个 10 秒的烟花视频', capability: 'video.generate', goal: 'generate' },
  { text: '帮我读取这个文件的内容', capability: 'file.read', goal: 'answer' },
  { text: '润色一下这段提示词', capability: 'prompt.enhance', goal: 'transform' },
];

function planFor(item) {
  const steps = [{ id: 'step1', capability: item.capability, args: { prompt: item.text }, dependsOn: [] }];
  if (item.second) steps.push({ id: 'step2', capability: item.second, args: { prompt: item.text }, dependsOn: ['step1'] });
  return {
    planId: 'plan_corpus', requestId: 'req_corpus', goal: item.goal,
    understanding: { goal: item.goal, desiredOutcome: item.goal, constraints: [], missingInformation: [], confidence: 0.9 },
    steps, confidence: 0.9,
  };
}

function makeClient(mode) {
  return {
    async chat(nodeIndex, request) {
      const item = corpus.find((entry) => String(request.messages[request.messages.length - 1].content).includes(entry.text));
      assert.ok(item, '语料外的输入不应出现');
      const plan = planFor(item);
      if (mode === 'fc' && request.tools) {
        return { text: '', toolCalls: [{ name: 'submit_plan', arguments: plan }] };
      }
      if (mode === 'fc-degrade' && request.tools) {
        // 节点不支持 FC：忽略 tools 直接回纯文本 JSON（planWithModel 应复用该文本，不再重发请求）
        return { text: JSON.stringify(plan) };
      }
      return { text: JSON.stringify(plan) };
    },
  };
}

const options = {
  nodeIndex: 0, model: 'planner-test', systemPrompt: 'sys', capabilityCatalog: [], maxSteps: 5,
};

test('planner FC corpus T3.2: FC 通道与 JSON 通道对同一语料产出等价计划', async () => {
  for (const item of corpus) {
    const request = { requestId: 'req_corpus', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: item.text };
    const viaFc = await planWithModel(makeClient('fc'), request, { ...options, useTools: true });
    const viaJson = await planWithModel(makeClient('json'), request, { ...options, useTools: false });
    assert.equal(viaFc.channel, 'function_calling', item.text + ' 应走 FC 通道');
    assert.equal(viaJson.channel, undefined, item.text + ' JSON 通道不带 channel');
    assert.deepEqual(viaFc.steps.map((step) => step.capability), viaJson.steps.map((step) => step.capability), item.text);
    assert.equal(viaFc.steps[0].capability, item.capability, item.text);
    assert.equal(viaFc.goal, item.goal, item.text);
    if (item.second) assert.equal(viaFc.steps[1]?.capability, item.second, item.text);
    assert.equal(viaFc.steps[0].dependsOn.length, 0, item.text);
    assert.equal(viaFc.modelRoundsUsed, 1, item.text + ' FC 一轮出计划');
    assert.equal(viaJson.modelRoundsUsed, 1, item.text + ' JSON 一轮出计划');
  }
});

test('planner FC corpus T3.2: 节点不支持 FC 时自动回落 JSON 通道且复用已回文本', async () => {
  const item = corpus[0];
  const request = { requestId: 'req_corpus', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: item.text };
  let calls = 0;
  const counting = {
    async chat(nodeIndex, req) {
      calls += 1;
      const found = corpus.find((entry) => String(req.messages[req.messages.length - 1].content).includes(entry.text));
      return req.tools ? { text: JSON.stringify(planFor(found)) } : { text: JSON.stringify(planFor(found)) };
    },
  };
  const plan = await planWithModel(counting, request, { ...options, useTools: true });
  assert.equal(plan.channel, undefined, '回落后不带 FC channel');
  assert.equal(plan.steps[0].capability, item.capability);
  assert.equal(calls, 1, 'FC 失败带回的文本应被复用，不得重发请求');
  assert.equal(plan.modelRoundsUsed, 1, '复用文本不额外消耗模型轮数');
});

test('planner FC corpus T3.2: parseOpenAiText 解析 tool_calls 出参', () => {
  const result = parseOpenAiText({
    choices: [{ message: { content: null, tool_calls: [{ function: { name: 'submit_plan', arguments: '{"goal":"answer"}' } }] } }],
  });
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, [{ name: 'submit_plan', arguments: { goal: 'answer' } }]);
  // arguments 为对象（部分中转）与损坏 JSON 的容错
  const objectArgs = parseOpenAiText({
    choices: [{ message: { content: null, tool_calls: [{ function: { name: 'submit_plan', arguments: { goal: 'answer' } } }] } }],
  });
  assert.deepEqual(objectArgs.toolCalls, [{ name: 'submit_plan', arguments: { goal: 'answer' } }]);
  const broken = parseOpenAiText({
    choices: [{ message: { content: 'fallback text', tool_calls: [{ function: { name: 'submit_plan', arguments: 'not-json' } }] } }],
  });
  assert.deepEqual(broken.toolCalls, [{ name: 'submit_plan', arguments: {} }]);
  // 纯文本响应不受影响
  const plain = parseOpenAiText({ choices: [{ message: { content: 'hello' } }] });
  assert.equal(plain.text, 'hello');
  assert.equal(plain.toolCalls, undefined);
});
