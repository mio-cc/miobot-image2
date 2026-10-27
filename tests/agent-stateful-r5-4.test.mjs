import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileToolIdempotencyStore,
  ToolExecutor,
  ToolRegistry,
  normalizeToolSpec,
  toolSpecFromCapabilityDescriptor,
} from '../dist/packages/tool-runtime/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import {
  MIGRATED_CAPABILITY_TOOLS,
  SIDE_EFFECT_CAPABILITY_TOOLS,
  STATEFUL_CAPABILITY_TOOLS,
} from '../dist/apps/bot/src/capability-tool-adapter.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('tool-idempotency R5.4: persisted ledger replays a completed side effect after recreating store and executor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-idem-'));
  const filePath = path.join(dir, 'tool-idempotency.json');
  let executions = 0;
  const spec = normalizeToolSpec({
    name: 'file.delete',
    title: '删除文件',
    description: '删除文件',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string' } }, required: ['artifactId'], additionalProperties: false },
    riskLevel: 'high',
    sideEffects: ['deletes_data'],
    idempotency: 'payload',
    exposure: 'core',
  });
  const run = async (store) => {
    const registry = new ToolRegistry();
    registry.register(spec);
    const executor = new ToolExecutor({ registry, idempotencyStore: store });
    executor.registerHandler('file.delete', async () => {
      executions += 1;
      return { ok: true, content: 'deleted' };
    });
    return executor.execute(
      { id: 'call-delete-1', name: 'file.delete', arguments: { artifactId: 'a1' } },
      { turnId: 'turn-1', sessionKey: 'private:1' },
    );
  };
  const first = await run(new FileToolIdempotencyStore({ filePath }));
  assert.equal(first.ok, true);
  assert.equal(executions, 1);
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.ok(Array.isArray(persisted.records));
  assert.equal(persisted.records.length, 1);

  const replay = await run(new FileToolIdempotencyStore({ filePath }));
  assert.equal(replay.ok, true);
  assert.equal(replay.meta.idempotencyReplay, true);
  assert.equal(executions, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('tool-spec R5.4: stateful capabilities infer real side effects and remain visible as core tools', () => {
  for (const name of ['file.delete', 'config.update', 'permission.update', 'owner.recall', 'task.schedule']) {
    assert.equal(STATEFUL_CAPABILITY_TOOLS.has(name), true);
    assert.equal(SIDE_EFFECT_CAPABILITY_TOOLS.has(name), true);
    assert.equal(MIGRATED_CAPABILITY_TOOLS.has(name), true);
  }
  const configSpec = toolSpecFromCapabilityDescriptor({
    id: 'config.update', name: '修改配置', provider: 'admin', enabled: true, effect: 'mutate', riskLevel: 'critical', approvalRequired: true,
  }, { exposure: 'core' });
  assert.deepEqual(configSpec.sideEffects, ['modifies_state']);
  assert.equal(configSpec.exposure, 'core');
  assert.equal(configSpec.idempotency, 'payload');

  const recallSpec = toolSpecFromCapabilityDescriptor({
    id: 'owner.recall', name: '撤回消息', provider: 'napcat', enabled: true, effect: 'delete', riskLevel: 'medium',
  }, { exposure: 'core' });
  assert.deepEqual(recallSpec.sideEffects, ['deletes_data']);

  const scheduleSpec = toolSpecFromCapabilityDescriptor({
    id: 'task.schedule', name: '定时提醒', provider: 'builtin', enabled: true, effect: 'notify', riskLevel: 'low',
  }, { exposure: 'core' });
  assert.deepEqual(scheduleSpec.sideEffects, ['sends_message']);
});

test('agent-interactive R5.4: concurrent same-session host calls are serialized before ask_user resume', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  const requests = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const client = {
    async chat(_nodeIndex, request) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      requests.push(request);
      calls += 1;
      try {
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            text: '',
            raw: {},
            toolCalls: [{ id: 'ask_lock', name: 'ask_user', arguments: { question: '哪个颜色？', missingFields: ['color'] } }],
            finishReason: 'tool_calls',
          };
        }
        return { text: '好的，红色。', raw: {} };
      } finally {
        active -= 1;
      }
    },
  };
  const host = createAgentHost({ getConfig: () => cfg, client });
  const firstPromise = host({ text: '选个颜色', chatType: 'private', userId: '1', sessionId: 'private:lock' });
  const secondPromise = host({ text: '红色', chatType: 'private', userId: '1', sessionId: 'private:lock' });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.status, 'suspended');
  assert.equal(first.text, '哪个颜色？');
  assert.equal(second.status, 'completed');
  assert.equal(second.text, '好的，红色。');
  assert.equal(maxActive, 1);
  const resumeTool = requests[1].messages.find((message) => message.role === 'tool' && message.toolCallId === 'ask_lock');
  assert.ok(resumeTool);
  assert.match(resumeTool.content, /红色/);
});

test('agent-stateful R5.4: config.update mutation is terminal if the following model call fails', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  let calls = 0;
  let updates = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'cfg_1', name: 'config.update', arguments: { ownerAction: 'ttsOn' } }],
          finishReason: 'tool_calls',
        };
      }
      throw new Error('model down after config mutation');
    },
  };
  const spec = toolSpecFromCapabilityDescriptor({
    id: 'config.update', name: '修改配置', provider: 'admin', enabled: true, effect: 'mutate', riskLevel: 'critical', approvalRequired: true,
  }, { exposure: 'core' });
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [{
      spec,
      handler: async () => {
        updates += 1;
        return { ok: true, content: '配置已更新' };
      },
    }],
    preflightToolCall: () => ({ allowed: true }),
  });
  const outcome = await host({ text: '开启语音', chatType: 'private', userId: '1', sessionId: 'private:cfg' });
  assert.equal(updates, 1);
  assert.equal(outcome.handled, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.reason, 'agent_side_effect_terminal');
});

test('agent-approval R5.4: pending approval is terminal-handoff and never executes the side effect', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  let executed = 0;
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      return {
        text: '',
        raw: {},
        toolCalls: [{ id: 'cfg_pending', name: 'config.update', arguments: { ownerAction: 'ttsOn' } }],
        finishReason: 'tool_calls',
      };
    },
  };
  const spec = toolSpecFromCapabilityDescriptor({
    id: 'config.update', name: '修改配置', provider: 'admin', enabled: true, effect: 'mutate', riskLevel: 'critical', approvalRequired: true,
  }, { exposure: 'core' });
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [{
      spec,
      handler: async () => {
        executed += 1;
        return { ok: true, content: 'should not run' };
      },
    }],
    preflightToolCall: () => ({
      allowed: false,
      pendingApproval: {
        approvalId: 'approval-1',
        status: 'pending',
        toolName: 'config.update',
        callId: 'cfg_pending',
        payloadHash: 'hash-1',
        createdAt: '2026-10-26T12:00:00.000Z',
      },
    }),
  });
  const outcome = await host({ text: '开启语音', chatType: 'private', userId: '1', sessionId: 'private:approval' });
  assert.equal(calls, 1);
  assert.equal(executed, 0);
  assert.equal(outcome.status, 'suspended');
  assert.equal(outcome.handled, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.reason, 'agent_approval_pending');
  assert.match(outcome.text, /审批/);
  assert.ok(outcome.replyPlan);
});