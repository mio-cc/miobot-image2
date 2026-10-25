// TriggerIntentChecker 单元回归：
// 锁住两个已实测的坑——
//   1) maxTokens 给太小（曾为 50）会被推理模型思维链耗尽，JSON 没输出就截断，
//      延续判断 fail-closed 静默失效（实测 deepseek-flash 26/27 用例被截断误杀）。
//   2) 两处失败语义必须保持不对称：关键词 fail-open（默认触发）、延续 fail-closed（默认沉默）。
// 以及 intentModel 为空时节点/模型必须跟随 chat 配置（intentNodeIndex 默认 0 的坑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { TriggerIntentChecker } from '../dist/apps/bot/src/trigger-intent.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeChecker(chatImpl, overrides = {}) {
  const cfg = createDefaultConfig();
  cfg.llm.chatNodeIndex = 2;
  cfg.llm.chatModel = 'chat-model';
  cfg.bot.keywordTrigger = { enabled: true, words: ['小喵'], contextMessages: 5, windowMs: 10000, intentModel: '', intentNodeIndex: 0 };
  cfg.bot.autoContinue = { enabled: true, windowMs: 60000, maxRounds: 3, cooldownMs: 5000, requireModelCheck: true };
  const calls = [];
  const client = { chat: async (nodeIndex, req) => { calls.push({ nodeIndex, req }); return chatImpl(req); } };
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client, ...overrides });
  return { checker, calls, cfg };
}

test('回归: maxTokens≥200、timeoutMs≥5000（关键词与延续共用）', async () => {
  for (const run of ['keyword', 'continue']) {
    const seen = [];
    const { checker } = makeChecker((req) => { seen.push(req); return { text: run === 'keyword' ? '{"intent": true}' : '{"continue": true}' }; });
    if (run === 'keyword') await checker.checkKeywordIntent({ userText: '小喵在吗', userName: 'u', context: '', triggerWord: '小喵' });
    else await checker.checkContinueIntent({ userText: '继续', userName: 'u', botLastReply: '好' });
    const req = seen[0];
    assert.ok(req.maxTokens >= 200, `${run} maxTokens=${req.maxTokens} < 200，推理模型会被思维链截断`);
    assert.ok(req.timeoutMs >= 5000, `${run} timeoutMs=${req.timeoutMs} < 5000`);
  }
});

test('回归: 延续判断 fail-closed——解析不出 JSON/调用异常都返回 false', async () => {
  const a = makeChecker(() => ({ text: '用户应该是在跟机器人说话吧' }));
  assert.equal(await a.checker.checkContinueIntent({ userText: '继续', userName: 'u', botLastReply: '好' }), false, '无 JSON 应回 false');
  const b = makeChecker(() => { throw new Error('model down'); });
  assert.equal(await b.checker.checkContinueIntent({ userText: '继续', userName: 'u', botLastReply: '好' }), false, '调用异常应回 false');
  const c = makeChecker(() => ({ text: '{"continue": false}' }));
  assert.equal(await c.checker.checkContinueIntent({ userText: '兄弟们晚上吃鸡吗', userName: 'u', botLastReply: '好' }), false);
  const d = makeChecker(() => ({ text: '好的，判断结果：{"continue": true}，完毕' }));
  assert.equal(await d.checker.checkContinueIntent({ userText: '继续', userName: 'u', botLastReply: '好' }), true, 'JSON 混在文本里也应能解析');
});

test('回归: 关键词判断 fail-open——解析不出 JSON/调用异常都默认触发(true)', async () => {
  const a = makeChecker(() => ({ text: '我觉得他是在叫机器人' }));
  assert.equal(await a.checker.checkKeywordIntent({ userText: '小喵在吗', userName: 'u', context: '', triggerWord: '小喵' }), true, '无 JSON 应默认触发');
  const b = makeChecker(() => { throw new Error('model down'); });
  assert.equal(await b.checker.checkKeywordIntent({ userText: '小喵在吗', userName: 'u', context: '', triggerWord: '小喵' }), true, '调用异常应默认触发');
  const c = makeChecker(() => ({ text: '{"intent": false}' }));
  assert.equal(await c.checker.checkKeywordIntent({ userText: '小喵是谁啊我不认识', userName: 'u', context: '', triggerWord: '小喵' }), false, '模型明确说 false 才不触发');
});

test('回归: intentModel 为空时节点/模型跟随 chat 配置；配置了则用 intent 专属', async () => {
  const seen = [];
  const a = makeChecker((req) => { seen.push({ node: null, req }); return { text: '{"continue": true}' }; });
  await a.checker.checkContinueIntent({ userText: '继续', userName: 'u', botLastReply: '好' });
  assert.equal(a.calls[0].nodeIndex, 2, '应使用 chatNodeIndex');
  assert.equal(a.calls[0].req.model, 'chat-model', '应使用 chatModel');

  a.cfg.bot.keywordTrigger.intentModel = 'mini-model';
  a.cfg.bot.keywordTrigger.intentNodeIndex = 1;
  await a.checker.checkContinueIntent({ userText: '继续', userName: 'u', botLastReply: '好' });
  assert.equal(a.calls[1].nodeIndex, 1, '配置 intentModel 后应使用 intentNodeIndex');
  assert.equal(a.calls[1].req.model, 'mini-model', '配置 intentModel 后应使用专属模型');
});

test('回归: requireModelCheck=false 时不发起模型调用直接返回 true', async () => {
  const a = makeChecker(() => { throw new Error('不应调用'); });
  a.cfg.bot.autoContinue.requireModelCheck = false;
  assert.equal(await a.checker.checkContinueIntent({ userText: '继续', userName: 'u', botLastReply: '好' }), true);
  assert.equal(a.calls.length, 0, '不应有模型调用');
});
