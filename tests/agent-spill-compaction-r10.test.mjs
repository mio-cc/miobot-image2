import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRuntime,
  DefaultAgentContextBuilder,
  InMemoryAgentSessionManager,
} from '../dist/packages/agent-runtime/src/index.js';
import { ToolExecutor, ToolRegistry, normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';
import { createAgentModelPort } from '../dist/apps/bot/src/agent-model-port.js';

test('R10: large tool results spill to disk and preserve the full content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'miobot-spill-'));
  try {
    const registry = new ToolRegistry();
    registry.register(normalizeToolSpec({
      name: 'echo', title: 'echo', description: 'echo', exposure: 'core',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputKinds: ['text'], riskLevel: 'low',
    }));
    const executor = new ToolExecutor({ registry });
    const full = 'X'.repeat(500);
    executor.registerHandler('echo', async () => ({ ok: true, content: full, outputs: [] }));
    let round = 0;
    const runtime = new AgentRuntime({
      model: createAgentModelPort({ async chat() {
        round += 1;
        return round === 1
          ? { text: '', raw: {}, toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }], finishReason: 'tool_calls' }
          : { text: 'done', raw: {} };
      } }),
      sessions: new InMemoryAgentSessionManager(),
      mainModel: 'fake',
      featureFlag: { enabled: true, mode: 'enforce' },
      toolRegistry: registry,
      toolExecutor: executor,
      toolResultMaxChars: 40,
      spillEnabled: true,
      spillDir: dir,
    });
    const result = await runtime.runTurn({ sessionKey: 'private:1', turnId: 't1', userText: 'echo', configRevision: 'r', runtimeVersion: 'v' });
    const toolMessage = (result.messages || []).find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    assert.match(String(toolMessage.content), /tool-result-[a-f0-9]+\.txt/);
    const match = String(toolMessage.content).match(/tool-result-[a-f0-9]+\.txt/);
    const spilled = await readFile(path.join(dir, match[0]), 'utf8');
    assert.match(spilled, /X{500}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R10: compaction keeps pinned facts and emits a compacted conversation summary', () => {
  const builder = new DefaultAgentContextBuilder();
  const session = {
    sessionKey: 'private:1', turnId: 't', messages: Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `old message ${i} ` + 'x'.repeat(100),
    })), pinnedFacts: {}, artifacts: [], configRevision: 'r', runtimeVersion: 'v',
  };
  const result = builder.build({
    session,
    userText: 'current',
    maxChars: 900,
    compactionEnabled: true,
    pinnedFacts: { song: 'song-1', approval: 'pending' },
  });
  const content = result.messages.map((message) => String(message.content || '')).join('\n');
  assert.match(content, /Compacted earlier conversation/);
  assert.match(content, /Pinned facts/);
  assert.match(content, /song-1/);
});
