import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * P1 第三批：备用模型状态机（方案 §6）。
 * 覆盖：首次失败切备重试成功 / 下次成功回切 / 连续两败粘滞 / 粘滞冷却试探回切 /
 * 试探失败不计数 / 手动 override 优先于 sticky / 手动切回清零 / 无备用零行为变化。
 * 时钟注入（fake clock）驱动 120s 冷却窗口；client 脚本化驱动成败序列。
 */

const { createModelFallbackController, isFailoverWorthyError } = await import('../dist/apps/bot/src/model-fallback.js');
const { createAgentModelPort } = await import('../dist/apps/bot/src/agent-model-port.js');
const { createModelBindingService } = await import('../dist/apps/bot/src/model-binding.js');
const { parseOwnerCommand } = await import('../dist/apps/bot/src/owner.js');
const { normalizeConfig } = await import('../dist/packages/config/src/index.js');

function makeHarness({ fallbackModel = 'backup-model', fallbackNodeIndex = 2, modelOverride, script = [] } = {}) {
  let config = {
    agent: {
      mainNodeIndex: 1, mainModel: 'primary-model',
      ...(fallbackModel ? { fallbackModel, fallbackNodeIndex } : {}),
      ...(modelOverride ? { modelOverride } : {}),
    },
  };
  let now = 1_000_000;
  const calls = [];
  const logs = [];
  const logger = { info: (m, d) => logs.push([m, d]), warn: (m, d) => logs.push([m, d]) };
  const scriptQueue = [...script];
  const client = {
    async chat(nodeIndex, request) {
      calls.push({ nodeIndex, model: request.model, timeoutMs: request.timeoutMs });
      const step = scriptQueue.shift();
      if (!step) throw Object.assign(new Error('unexpected_call'), { status: 500 });
      if (step.throw) throw step.throw;
      return { text: step.text || 'ok', raw: {} };
    },
  };
  const controller = createModelFallbackController({ getConfig: () => config, logger, clock: () => now });
  const port = createAgentModelPort(client, { fallback: controller, defaultNodeIndex: 1 });
  const chat = (extra = {}) => port.chat({
    model: 'primary-model', nodeIndex: 1,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [], toolChoice: 'none', purpose: 'turn',
    ...extra,
  });
  return {
    config, calls, logs, controller, port, chat,
    advance: (ms) => { now += ms; },
    setConfig: (next) => { config = next; },
    setOverride: (value) => { config = { ...config, agent: { ...config.agent, ...(value ? { modelOverride: value } : {}) } }; if (!value) delete config.agent.modelOverride; },
  };
}

const netError = (message = 'HTTP 503') => Object.assign(new Error(message), { status: 503, category: 'upstream', retryable: true });
const authError = () => Object.assign(new Error('HTTP 401'), { status: 401, category: 'validation', retryable: false });

/* ── 1. 首次失败 → 切备用重试本次成功 ── */
test('fallback: first primary failure retries this request on secondary', async () => {
  const h = makeHarness({ script: [{ throw: netError() }, { text: 'backup ok' }] });
  const res = await h.chat();
  assert.equal(res.assistant.text, 'backup ok');
  assert.deepEqual(h.calls.map((c) => c.model), ['primary-model', 'backup-model'], '主失败后必须立即切备重试本次');
  assert.equal(h.controller.snapshot('main').consecutivePrimaryFailures, 1, '首败计数 1');
  assert.ok(h.logs.some(([, d]) => d.event === 'failover' && d.to === 'backup-model' && d.consecutiveFailures === 1), '切备要有结构化日志');
});

/* ── 2. 下一次请求回主；主成功即清零（回切） ── */
test('fallback: next request retries primary and success resets counter', async () => {
  const h = makeHarness({ script: [{ throw: netError() }, { text: 'b' }, { text: 'primary ok' }] });
  await h.chat();
  const res = await h.chat();
  assert.equal(res.assistant.text, 'primary ok');
  assert.deepEqual(h.calls.map((c) => c.model), ['primary-model', 'backup-model', 'primary-model'], '下一次请求回主');
  assert.equal(h.controller.snapshot('main').consecutivePrimaryFailures, 0, '成功清零');
});

/* ── 3. 连续两次请求级失败 → 第三次请求粘滞（不再碰主） ── */
test('fallback: two consecutive request failures make the third sticky on secondary', async () => {
  const h = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },   // 请求 1：主败（计数1）→ 备
    { throw: netError() }, { text: 'b2' },   // 请求 2：主败（计数2）→ 备
    { text: 'b3' },                          // 请求 3：粘滞，直接备（主不调用）
  ] });
  await h.chat();
  await h.chat();
  const res = await h.chat();
  assert.equal(res.assistant.text, 'b3');
  assert.deepEqual(h.calls.map((c) => c.model), ['primary-model', 'backup-model', 'primary-model', 'backup-model', 'backup-model'], '第三次请求起主模型不再被调用');
  assert.equal(h.controller.snapshot('main').stickyOnSecondary, true, '进入粘滞');
  assert.ok(h.logs.some(([, d]) => d.event === 'sticky'), '粘滞要打日志');
});

/* ── 4. 粘滞 + 冷却期满 → 借真实请求试探主；成功即回切 ── */
test('fallback: probe after cooldown succeeds and recovers to primary', async () => {
  const h = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },
    { throw: netError() }, { text: 'b2' },
    { text: 'b3' },                          // 请求 3：惰性转粘滞（本请求直接备）
    { text: 'probe ok' },                    // 冷却期满后的请求：试探主（成功）
    { text: 'primary ok 2' },                // 回切后：正常用主
  ] });
  await h.chat(); await h.chat();
  await h.chat();                            // 第三次请求起粘滞
  h.advance(120_001);                        // 120s 冷却窗口到期
  const res = await h.chat();
  assert.equal(res.assistant.text, 'probe ok');
  const probeCall = h.calls[5];
  assert.equal(probeCall.model, 'primary-model');
  assert.ok(probeCall.timeoutMs <= 8_000, '试探必须用短超时（8s 封顶）');
  const snap = h.controller.snapshot('main');
  assert.equal(snap.stickyOnSecondary, false, '一次成功即回切（粘滞解除）');
  assert.equal(snap.consecutivePrimaryFailures, 0);
  const res2 = await h.chat();
  assert.equal(res2.assistant.text, 'primary ok 2');
  assert.equal(h.calls[6].model, 'primary-model');
  assert.ok(h.logs.some(([, d]) => d.event === 'recover' && d.viaProbe === true), '回切要打日志');
});

/* ── 5. 冷却窗口内试探失败：不计数、不退出粘滞、备完成本次 ── */
test('fallback: probe failure does not punish counter and keeps sticky', async () => {
  const h = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },
    { throw: netError() }, { text: 'b2' },
    { text: 'b3' },                                       // 请求 3：惰性转粘滞
    { throw: netError('probe failed') }, { text: 'b4' },  // 冷却期满试探失败 → 落到备
    { text: 'b5' },                                       // 冷却重置后未到期 → 直接备
  ] });
  await h.chat(); await h.chat();
  await h.chat();                            // 粘滞置位
  h.advance(120_001);
  const res = await h.chat();
  assert.equal(res.assistant.text, 'b4');
  assert.equal(h.calls[5].model, 'primary-model', '冷却期满后先试探主');
  const snap = h.controller.snapshot('main');
  assert.equal(snap.consecutivePrimaryFailures, 2, '试探失败不增加惩罚计数');
  assert.equal(snap.stickyOnSecondary, true, '试探失败不退出粘滞');
  h.advance(60_000);                        // 新冷却窗口（120s）内
  const res2 = await h.chat();
  assert.equal(res2.assistant.text, 'b5');
  assert.equal(h.calls[7].model, 'backup-model', '冷却期内直接用备，不再试探');
  assert.ok(h.logs.some(([, d]) => d.event === 'probe_failed'), '试探失败要打日志');
});

/* ── 6. 手动 override 优先于 sticky（锁备不试探；锁主忽略粘滞） ── */
test('fallback: manual override beats sticky state', async () => {
  // 6a. 锁备：粘滞态 + 冷却期满也不试探，直接备。
  const h1 = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },
    { throw: netError() }, { text: 'b2' },
    { text: 'locked secondary' },
  ] });
  await h1.chat(); await h1.chat();
  h1.setOverride('secondary');
  h1.advance(600_000);                      // 远超冷却
  const res1 = await h1.chat();
  assert.equal(res1.assistant.text, 'locked secondary');
  assert.deepEqual(h1.calls.map((c) => c.model).slice(-1), ['backup-model'], '锁备时主模型绝不调用');
  assert.ok(!h1.calls.slice(4).some((c) => c.model === 'primary-model'), '锁备期间无试探');

  // 6b. 锁主：粘滞态仍从主开始（忽略粘滞），主失败按自动规则切备救本次。
  const h2 = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },
    { throw: netError() }, { text: 'b2' },
    { text: 'locked primary ok' },
  ] });
  await h2.chat(); await h2.chat();
  h2.setOverride('primary');
  const res2 = await h2.chat();
  assert.equal(res2.assistant.text, 'locked primary ok');
  assert.equal(h2.calls[4].model, 'primary-model', '锁主时忽略粘滞仍从主开始');
});

/* ── 7. 手动切回（解锁）清零失败计数 ── */
test('fallback: manual switch back to primary resets counter and sticky', async () => {
  const h = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },
    { throw: netError() }, { text: 'b2' },
    { text: 'b3' },                          // 请求 3：惰性转粘滞
    { text: 'primary back' },
  ] });
  await h.chat(); await h.chat();
  await h.chat();                            // 粘滞置位
  assert.equal(h.controller.snapshot('main').stickyOnSecondary, true);
  h.controller.reset('main');               // 模拟 ModelBindingService onBindingChanged 回调
  const snap = h.controller.snapshot('main');
  assert.equal(snap.stickyOnSecondary, false);
  assert.equal(snap.consecutivePrimaryFailures, 0);
  const res = await h.chat();
  assert.equal(res.assistant.text, 'primary back');
  assert.equal(h.calls[5].model, 'primary-model', '切回后立即生效走主');
});

/* ── 8. 无备用模型：零行为变化（状态机整体旁路） ── */
test('fallback: no secondary configured keeps today behavior exactly', async () => {
  const h = makeHarness({ fallbackModel: '', script: [{ throw: netError() }] });
  await assert.rejects(() => h.chat(), /HTTP 503/);
  assert.deepEqual(h.calls.map((c) => c.model), ['primary-model'], '无备用时绝不产生第二次调用');
  assert.equal(h.controller.selectSlot('main', true).mode, 'bypass');
  assert.equal(h.controller.snapshot('main').consecutivePrimaryFailures, 0, '无备用不计数');

  const h2 = makeHarness({ fallbackModel: '', script: [{ text: 'primary only' }] });
  const res = await h2.chat();
  assert.equal(res.assistant.text, 'primary only');
  assert.deepEqual(h2.calls.map((c) => c.model), ['primary-model']);
});

/* ── 9. 不可换备类错误（401 鉴权）：不切备、不计数 ── */
test('fallback: auth errors do not fail over nor count', async () => {
  const h = makeHarness({ script: [{ throw: authError() }] });
  await assert.rejects(() => h.chat(), /HTTP 401/);
  assert.deepEqual(h.calls.map((c) => c.model), ['primary-model'], '401 换备无意义，直接失败');
  assert.equal(h.controller.snapshot('main').consecutivePrimaryFailures, 0);
});

/* ── 10. 非 turn 调用（repair/safe-text）跟随档位：不决策不计数 ── */
test('fallback: non-turn calls follow current slot without deciding', async () => {
  // 10a. 自动态：repair 走主，主失败不切备。
  const h = makeHarness({ script: [{ throw: netError('repair primary down') }] });
  await assert.rejects(() => h.chat({ purpose: 'repair' }), /repair primary down/);
  assert.deepEqual(h.calls.map((c) => c.model), ['primary-model'], 'repair 调用不切备');
  assert.equal(h.controller.snapshot('main').consecutivePrimaryFailures, 0, 'repair 失败不计数');

  // 10b. 粘滞态：repair/safe-text 跟随走备。
  const h2 = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },
    { throw: netError() }, { text: 'b2' },
    { text: 'b3' },                          // 请求 3：惰性转粘滞
    { text: 'repair on backup' },
  ] });
  await h2.chat(); await h2.chat();
  await h2.chat();                           // 粘滞置位
  const res = await h2.chat({ purpose: 'safe-text' });
  assert.equal(res.assistant.text, 'repair on backup');
  assert.equal(h2.calls[4].model, 'backup-model', '粘滞态下非 turn 调用跟随走备');
});

/* ── 11. /切换 锁定/解锁 命令解析 ── */
test('fallback: owner command parses lock/unlock', () => {
  const ctx = { chatType: 'private' };
  assert.deepEqual(parseOwnerCommand('/切换 锁定 备', ctx), { command: 'switchModelLock', slot: 'secondary' });
  assert.deepEqual(parseOwnerCommand('/切换 锁定 主', ctx), { command: 'switchModelLock', slot: 'primary' });
  assert.deepEqual(parseOwnerCommand('/切换 解锁', ctx), { command: 'switchModelLock', slot: 'primary' });
  // 回归：旧语法不受影响（「锁定」不会被误当模型名——锁定在先）。
  assert.deepEqual(parseOwnerCommand('/切换 deepseek-chat', ctx), { command: 'switchModel', code: 'deepseek-chat', purpose: 'main', slot: 'primary' });
  assert.deepEqual(parseOwnerCommand('/切换 备 glm-4', ctx), { command: 'switchModel', code: 'glm-4', purpose: 'main', slot: 'secondary' });
});

/* ── 12. ModelBindingService.setOverride：写入/清除 + 联动回调 ── */
test('fallback: binding service setOverride writes config and notifies state machine', () => {
  const events = [];
  const nodes = { llm: { apiKeys: [{ name: 'n0', models: ['p'] }, { name: 'n1', models: ['b'] }] } };
  let config = { ...nodes, agent: { mainModel: 'p', mainNodeIndex: 0, fallbackModel: 'b', fallbackNodeIndex: 1 } };
  const service = createModelBindingService({
    getConfig: () => config,
    onBindingChanged: (purpose, slot) => events.push([purpose, slot]),
  });
  // 锁备。
  const lock = service.setOverride({ slot: 'secondary', source: 'command', actorId: '10001' });
  assert.equal(lock.ok, true);
  assert.equal(config.agent.modelOverride, 'secondary');
  assert.deepEqual(events.at(-1), ['main', 'override'], '档位操作必须触发状态机联动回调');
  // 解锁（切回主）。
  const unlock = service.setOverride({ slot: null, source: 'command', actorId: '10001' });
  assert.equal(unlock.ok, true);
  assert.equal(config.agent.modelOverride, undefined, '解锁要删除字段');
  // 未配置备用时锁备 → 明确拒绝。
  let bare = { agent: { mainModel: 'p', mainNodeIndex: 0 } };
  const bareService = createModelBindingService({ getConfig: () => bare });
  const rejected = bareService.setOverride({ slot: 'secondary', source: 'tool', actorId: '1' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /尚未配置备用模型/);
  // 手动换模型也触发清零回调（setBinding 成功路径）。
  const swap = service.setBinding({ purpose: 'main', slot: 'primary', target: 'p', source: 'command', actorId: '1' });
  assert.equal(swap.ok, true);
  assert.deepEqual(events.at(-1), ['main', 'primary']);
});

/* ── 13. 状态文本：粘滞/锁定可见 ── */
test('fallback: describe reflects sticky and locked states', async () => {
  const h = makeHarness({ script: [
    { throw: netError() }, { text: 'b1' },
    { throw: netError() }, { text: 'b2' },
    { text: 'b3' },                          // 第三次请求：惰性转粘滞
  ] });
  await h.chat(); await h.chat();
  assert.match(h.controller.describe('main'), /近期失败 2 次/, '粘滞置位前显示失败计数');
  await h.chat();                            // 本次请求起粘滞
  assert.match(h.controller.describe('main'), /粘滞中/);
  h.setOverride('secondary');
  assert.match(h.controller.describe('main'), /手动锁定：备用/);
  assert.ok(makeHarness({ fallbackModel: '' }).controller.describe('main').includes('未配置备用'));
});

/* ── 14. 错误分类单元 ── */
test('fallback: isFailoverWorthyError classification', () => {
  assert.equal(isFailoverWorthyError(Object.assign(new Error('x'), { status: 500 })), true);
  assert.equal(isFailoverWorthyError(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(isFailoverWorthyError(Object.assign(new Error('x'), { status: 404 })), true);
  assert.equal(isFailoverWorthyError(new Error('fetch failed')), true);
  assert.equal(isFailoverWorthyError(Object.assign(new Error('x'), { status: 401 })), false);
  assert.equal(isFailoverWorthyError(Object.assign(new Error('x'), { status: 403 })), false);
  assert.equal(isFailoverWorthyError(Object.assign(new Error('x'), { status: 400 })), false);
  assert.equal(isFailoverWorthyError(Object.assign(new Error('x'), { category: 'validation' })), false);
});

/* ── 15. v3 normalize：modelOverride 合法值保留、非法值清除 ── */
test('fallback: v3 normalize keeps valid modelOverride and drops invalid', () => {
  const base = { agent: { enabled: true, mode: 'enforce', mainModel: 'p' } };
  const kept = normalizeConfig({ ...base, agent: { ...base.agent, modelOverride: 'secondary' } });
  assert.equal(kept.agent.modelOverride, 'secondary');
  const cleared = normalizeConfig({ ...base, agent: { ...base.agent, modelOverride: 'whatever' } });
  assert.equal(cleared.agent.modelOverride, undefined);
  const absent = normalizeConfig(base);
  assert.equal(absent.agent.modelOverride, undefined);
});
