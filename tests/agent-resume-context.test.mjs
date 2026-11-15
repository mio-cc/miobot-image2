// 续跑上下文注入回归（线上时测 2026-11-15）：
//   "转图表发我" 走 report.render 异步续跑。resume 分支只给 originalText，
//   群历史与记忆命中整段缺失，模型把上一轮自身的能力状态报告当成数据源画成图。
// 契约：
//   1) resume turn 的 groupContext / memoryContext 必须真正进入模型请求的 system 段；
//   2) start.ts 的 resume 分支必须注入这两项（源码接线断言，防回归退回只传 originalText）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { InMemoryToolIdempotencyStore } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

function baseConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  return cfg;
}

test('resume turn: groupContext and memoryContext reach the model system section', async () => {
  const cfg = baseConfig();
  const sessions = new InMemoryAgentSessionManager({
    initialSessions: [{
      sessionKey: 'group:1098867961:2238639363',
      turnId: 't0',
      messages: [{ role: 'user', content: '把本期三江发我' }],
      pinnedFacts: {},
      artifacts: [],
      configRevision: 'r',
      runtimeVersion: 'r5-agent-loop',
      pendingJobs: [{ jobId: 'job-x', toolName: 'report.render', callId: 'call-x', status: 'running', createdAt: '2026-11-15T11:04:34.000Z' }],
      pendingToolCalls: [{ id: 'call-x', name: 'report.render', arguments: {} }],
    }],
  });
  const seen = [];
  const client = {
    // createAgentModelPort 以 (nodeIndex, request) 调用底层 client。
    async chat(_nodeIndex, request) {
      seen.push(request);
      return { text: '好的，这次用三江数据出图。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: () => false,
    isMigratedTool: () => true,
    resolveJob: () => ({ jobId: 'job-x', status: 'succeeded', result: { ok: true, callId: 'call-x', toolName: 'report.render', content: 'rendered' } }),
  });
  const outcome = await host({
    text: '转图表发我',
    chatType: 'group', groupId: '1098867961', userId: '2238639363', sessionId: 'group:1098867961:2238639363', userRole: 'user',
    groupContext: '【群聊上下文】mio [QQ:2238639363]: 看本周三江带上每本书的月票数据',
    memoryContext: '【相关记忆】三江网文新风 2026.11.08~11.15 共 17 本',
    resumeJob: true, resumeJobId: 'job-x', availableToolNames: [],
  });
  assert.equal(outcome.status, 'completed');
  const lastRequest = seen.at(-1);
  const system = String((lastRequest?.messages || []).find((message) => message.role === 'system')?.content || '');
  assert.match(system, /看本周三江带上每本书的月票数据/, 'resume turn must see the group context');
  assert.match(system, /三江网文新风/, 'resume turn must see memory hits');
});

test('resume wiring: start.ts injects groupContext and memoryContext on the resume branch', () => {
  const startSource = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/start.ts'), 'utf8');
  assert.ok(/const buildResumeContext = async \(input: \{/.test(startSource),
    'start.ts 应提供续跑上下文组装器');
  assert.ok(/resumeContext = await buildResumeContext\(\{/.test(startSource),
    'resume 分支应调用续跑上下文组装器');
  assert.ok(/\.\.\.\(resumeContext\.groupContext \? \{ groupContext: resumeContext\.groupContext \} : \{\}\)/.test(startSource),
    'resume 分支应把 groupContext 传给 agentHost');
  assert.ok(/\.\.\.\(resumeContext\.memoryContext \? \{ memoryContext: resumeContext\.memoryContext \} : \{\}\)/.test(startSource),
    'resume 分支应把 memoryContext 传给 agentHost');
  assert.ok(/buildMemoryContext\(\{/.test(startSource), '记忆组装应复用同一实现，不另造一份');
});
