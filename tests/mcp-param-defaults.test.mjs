// MCP 参数默认值机制（2026-11-07 拍板）：
// 数据模型（mcpServers[].paramDefaults / childParamDefaults 规整）→ 解析（子项级整条覆盖根级）
// → 注入展示（description 尾句 / list_actions 行尾说明）→ handler 确定性合并（默认填缺失 / 锁定强制覆盖）
// → 失败可诊断（锁定值违 schema 报带来源的可读错误；上游拒绝透传错误文本）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrchestrationConfig } from '../dist/packages/orchestration/src/config.js';
import {
  buildMcpChildTools,
  buildMcpRootDescriptor,
  formatChildCatalog,
  formatParamDefaultsNote,
  resolveChildParamDefaults,
  McpRootToolHandler,
} from '../dist/apps/bot/src/mcp-root-tool.js';

const makeInvocation = (args) => ({ plan: { planId: 'p1' }, step: { id: 's1', capability: 'mcp.demo', args } });

const CHILDREN = buildMcpChildTools('demo', [
  { name: 'generate', description: 'Generate a song', inputSchema: { type: 'object', properties: { lyrics: { type: 'string' }, model: { type: 'string', enum: ['v6-mini', 'v6'] }, duration: { type: 'number' } }, required: ['lyrics'] } },
  { name: 'query', description: 'Query library', inputSchema: { type: 'object', properties: { keywords: { type: 'string' } } } },
]);

test('param defaults: normalize——value 类型校验、键清洗、空对象丢弃、上限', () => {
  const cfg = normalizeOrchestrationConfig({
    mcpServers: [{
      id: 'demo', enabled: true, transport: 'http', url: 'https://x/mcp',
      paramDefaults: {
        model: { value: 'v6-mini' },
        duration: { value: 120 },
        instrumental: { value: false, locked: true },
        bad: { value: { nested: true } },
        '  ': { value: 1 },
      },
      childParamDefaults: {
        generate: { model: { value: 'v6', locked: true } },
        '': { model: { value: 'v6' } },
      },
    }],
  });
  const server = cfg.mcpServers[0];
  assert.deepEqual(server.paramDefaults, { model: { value: 'v6-mini' }, duration: { value: 120 }, instrumental: { value: false, locked: true } }, '非法 value 丢弃、合法保留');
  assert.deepEqual(server.childParamDefaults, { generate: { model: { value: 'v6', locked: true } } }, '空工具名丢弃');
  // 空配置不落键。
  const bare = normalizeOrchestrationConfig({ mcpServers: [{ id: 'bare', enabled: true, transport: 'http', url: 'https://x/mcp', paramDefaults: {}, childParamDefaults: {} }] });
  assert.equal(bare.mcpServers[0].paramDefaults, undefined);
  assert.equal(bare.mcpServers[0].childParamDefaults, undefined);
});

test('param defaults: resolveChildParamDefaults——子项级同键整条覆盖根级（含锁定标志）', () => {
  const resolved = resolveChildParamDefaults(
    { model: { value: 'v6-mini' }, duration: { value: 120, locked: true } },
    { model: { value: 'v6' } },
  );
  assert.deepEqual(resolved, { model: { value: 'v6' }, duration: { value: 120, locked: true } }, '子项 model 覆盖根级（锁→非锁）；根级 duration 保留');
});

test('param defaults: formatParamDefaultsNote——默认/锁定标签与 4 键截断', () => {
  assert.equal(formatParamDefaultsNote(undefined), '');
  assert.equal(formatParamDefaultsNote({}), '');
  assert.equal(formatParamDefaultsNote({ model: { value: 'v6-mini' } }), '参数默认：model=v6-mini。');
  assert.equal(formatParamDefaultsNote({ model: { value: 'v6-mini', locked: true } }), '参数默认/锁定：model=v6-mini（锁定）。');
  const many = formatParamDefaultsNote({ a: { value: 1 }, b: { value: 2 }, c: { value: 3 }, d: { value: 4 }, e: { value: 5 } });
  assert.ok(many.includes('a=1、b=2、c=3、d=4…'), '最多 4 键 + …');
});

test('param defaults: 根 description 注入说明（800 上限内）', () => {
  const descriptor = buildMcpRootDescriptor('demo', CHILDREN, {}, { model: { value: 'v6-mini' } });
  assert.ok(descriptor.description.includes('参数默认：model=v6-mini'), '根描述带默认值说明');
  assert.ok(descriptor.description.includes('歌词/文本参数规范'), '歌词规范仍在（lyrics 字段子项存在）');
  assert.ok(descriptor.description.length <= 800, '上限 800');
  const locked = buildMcpRootDescriptor('demo', CHILDREN, {}, { model: { value: 'v6-mini', locked: true } });
  assert.ok(locked.description.includes('参数默认/锁定：model=v6-mini（锁定）'), '锁定标签可见');
  const none = buildMcpRootDescriptor('demo', CHILDREN, {}, {});
  assert.ok(!none.description.includes('参数默认'), '无配置零注入');
});

test('param defaults: list_actions 子项行带各自默认值说明', () => {
  const catalog = formatChildCatalog('demo', CHILDREN, {
    generate: { model: { value: 'v6-mini' } },
    query: { keywords: { value: '默认词', locked: true } },
  });
  const generateLine = catalog.split('\n').find((line) => line.startsWith('- generate'));
  const queryLine = catalog.split('\n').find((line) => line.startsWith('- query'));
  assert.ok(generateLine.includes('｜参数默认：model=v6-mini。'), 'generate 行带默认说明');
  assert.ok(queryLine.includes('｜参数默认/锁定：keywords=默认词（锁定）。'), 'query 行带锁定说明');
});

test('param defaults: handler 合并——默认填缺失、锁定强制覆盖、子项覆盖根级', async () => {
  const calls = [];
  const client = { callTool: async (name, params) => { calls.push({ name, params }); return { content: [{ type: 'text', text: 'ok:' + JSON.stringify(params) }], isError: false }; } };
  const handler = new McpRootToolHandler(client, 'demo', CHILDREN, {
    generate: resolveChildParamDefaults({ model: { value: 'v6-mini' }, duration: { value: 90, locked: true } }, { model: { value: 'v6' } }),
  });
  // 模型没传 model：根级默认被子项级覆盖为 v6（仅默认）→ 填 v6；duration 锁定 → 覆盖模型传的 999。
  const result = await handler.execute(makeInvocation({ action: 'generate', params: { lyrics: '[Verse 1]\n测试', duration: 999 } }));
  assert.equal(result.status, 'success');
  assert.equal(calls[0].params.model, 'v6', '子项级默认覆盖根级并填入缺失键');
  assert.equal(calls[0].params.duration, 90, '锁定键强制覆盖模型传参');
  assert.deepEqual(result.diagnostics.appliedParamDefaults, { locked: ['duration'], default: ['model'] }, '诊断记录实际生效来源');
  // 模型显式传 model（非锁定）→ 模型值生效。
  await handler.execute(makeInvocation({ action: 'generate', params: { lyrics: '[Verse 1]\n测试', model: 'v6-mini' } }));
  assert.equal(calls[1].params.model, 'v6-mini', '非锁定默认可被模型显式覆盖');
});

test('param defaults: 锁定值违 schema → 校验层报带来源的可读错误', async () => {
  const client = { callTool: async () => ({ content: [], isError: false }) };
  // model 枚举只有 v6-mini/v6——锁定成 v3.5 必然违 schema。
  const handler = new McpRootToolHandler(client, 'demo', CHILDREN, {
    generate: { model: { value: 'v3.5', locked: true } },
  });
  const result = await handler.execute(makeInvocation({ action: 'generate', params: { lyrics: '[Verse 1]\n测试', model: 'v6' } }));
  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('mcp_action_params_invalid:generate'), '错误码保留');
  assert.ok(result.error.includes('［来自锁定配置］'), '标注来源=锁定配置');
  assert.ok(result.error.includes('$.params.model'), '带字段路径');
});

test('param defaults: 上游拒绝时透传错误文本（不退化成一句参数错误）', async () => {
  const client = { callTool: async () => ({ content: [{ type: 'text', text: 'Error: model v6-mini not available for this account (credits/plan)' }], isError: true }) };
  const handler = new McpRootToolHandler(client, 'demo', CHILDREN, {
    generate: { model: { value: 'v6-mini', locked: true } },
  });
  const result = await handler.execute(makeInvocation({ action: 'generate', params: { lyrics: '[Verse 1]\n测试' } }));
  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('mcp_tool_error:generate'), '错误码保留');
  assert.ok(result.error.includes('model v6-mini not available'), '上游错误原文透传（≤200 字符）');
  assert.deepEqual(result.diagnostics.appliedParamDefaults, { locked: ['model'], default: [] }, '诊断记录 model 来自锁定配置');
});
