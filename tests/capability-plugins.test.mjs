import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { loadCapabilityPlugins, pluginManifestPath } from '../dist/apps/bot/src/capability-plugins.js';

function writePlugin(dir, file, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body, 'utf8');
}

const GOOD_PLUGIN = `
export default (ctx) => ({
  descriptor: { id: 'plugin.echo', version: '1.0.0', name: '插件回声', description: '回显输入', provider: 'plugin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true } },
  handler: { async execute(invocation) { return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: [{ kind: 'text', text: '插件回声：' + String(invocation.step.args.text || '') }] }; } },
});
`;

const BROKEN_PLUGIN = 'export default 42;';

test('plugins T4.2: 目录加载器——好插件注册、坏插件跳过、清单落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-plugins-'));
  writePlugin(dir, 'echo.mjs', GOOD_PLUGIN);
  writePlugin(dir, 'zz-broken.mjs', BROKEN_PLUGIN);
  const registered = [];
  const manifest = await loadCapabilityPlugins(dir, { getConfig: () => ({}), client: {}, dataDir: dir }, (plugin) => registered.push(plugin), {});
  assert.equal(registered.length, 1, '坏插件不得注册');
  assert.equal(registered[0].descriptor.id, 'plugin.echo');
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].id, 'plugin.echo');
  assert.equal(manifest[0].source, 'echo.mjs');
  const saved = JSON.parse(fs.readFileSync(pluginManifestPath(dir), 'utf8'));
  assert.equal(saved.plugins.length, 1);
  assert.equal(saved.plugins[0].descriptor.id, 'plugin.echo');
  // 空目录：无插件、清单为空数组
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-plugins-empty-'));
  const manifest2 = await loadCapabilityPlugins(empty, { getConfig: () => ({}), client: {}, dataDir: empty }, () => {}, {});
  assert.equal(manifest2.length, 0);
});

test('plugins T4.2: enforcer.registerCapability——注册后可被规划执行且热重载存活', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.actionAlignmentGuardEnabled = false;
  cfg.orchestration.planner.nodeIndex = 1;
  cfg.orchestration.planner.model = 'planner-test';
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'chat', decision: { kind: 'chat', source: 'fallback', confidence: 1, reason: '', params: { prompt: '', tokens: [] }, usedPlanner: false } }),
    engine: { handleExplicit: async () => null },
    sessions: { clear() {} }, registry: () => ({}), client: {},
  };
  const fakeClient = {
    async chat() {
      return { text: JSON.stringify({ planId: 'p1', requestId: 'r1', goal: 'answer', steps: [{ id: 's1', capability: 'plugin.echo', args: { text: '你好' } }], confidence: 0.9 }) };
    },
  };
  const enforcer = new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient });
  // 注册插件能力
  enforcer.registerCapability(
    { id: 'plugin.echo', version: '1.0.0', name: '插件回声', provider: 'plugin', mode: 'sync', riskLevel: 'low', enabled: true, outputKinds: ['text'] },
    { async execute(invocation) { return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: [{ kind: 'text', text: '插件回声：' + String(invocation.step.args.text || '') }] }; } },
  );
  const result = await enforcer.handle({ text: '回声 你好', chatType: 'private', userId: '1' });
  assert.equal(result.handled, true);
  const text = (result.result?.text || '') + JSON.stringify(result.result?.replyPlan?.groups || []);
  assert.ok(text.includes('插件回声：你好'), '插件能力应被规划执行：' + text.slice(0, 200));
  // 配置热重载（fingerprint 变化触发 replaceAll）后插件能力仍存活
  cfg.orchestration.execution.maxSteps = (cfg.orchestration.execution.maxSteps || 5) + 1;
  const result2 = await enforcer.handle({ text: '再回声一次', chatType: 'private', userId: '1' });
  assert.equal(result2.handled, true);
  const text2 = (result2.result?.text || '') + JSON.stringify(result2.result?.replyPlan?.groups || []);
  assert.ok(text2.includes('插件回声'), 'refreshConfig replaceAll 不得冲掉插件能力');
  assert.ok(enforcer.listCapabilities().some((item) => item.id === 'plugin.echo'), 'listCapabilities 含插件');
});
