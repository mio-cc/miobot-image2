import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolRegistry,
  ToolExecutor,
  normalizeToolSpec,
  toolSpecFromCapabilityDescriptor,
  validateToolArguments,
  validateToolCallBatch,
  makeToolError,
  toolErrorFingerprint,
} from '../dist/packages/tool-runtime/src/index.js';
import { OutputRepairBudgetTracker, ASK_USER_TOOL_SPEC, UPDATE_PLAN_TOOL_SPEC } from '../dist/packages/agent-runtime/src/index.js';

function spec(name, overrides = {}) {
  return normalizeToolSpec({
    name,
    title: name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    riskLevel: 'low',
    outputKinds: ['text'],
    ...overrides,
  });
}

test('tool-runtime R1: legacy capability descriptor adapts to canonical ToolSpec', () => {
  const adapted = toolSpecFromCapabilityDescriptor({
    id: 'image.generate',
    name: '图片生成',
    description: '生成图片',
    provider: 'comfyui',
    enabled: true,
    version: '2.1.0',
    riskLevel: 'medium',
    sideEffects: ['creates_artifact', 'external_call'],
    outputKinds: ['image', 'text', 'unsupported-kind'],
    requiredContext: ['reply', 'thread', 'image'],
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: true },
    aliases: ['画图', '画图'],
    permissions: ['user'],
    mode: 'async_job',
  });
  assert.equal(adapted.name, 'image.generate');
  assert.equal(adapted.exposure, 'core');
  assert.equal(adapted.riskLevel, 'medium');
  assert.equal(adapted.idempotency, 'turn');
  assert.deepEqual(adapted.outputKinds, ['image', 'text']);
  assert.deepEqual(adapted.requiredContext, ['quote', 'forward', 'image']);
  assert.equal(adapted.inputSchema.additionalProperties, true);
  assert.deepEqual(adapted.metadata.aliases, ['画图']);
  assert.equal(adapted.metadata.capabilityId, 'image.generate');

  const critical = toolSpecFromCapabilityDescriptor({ id: 'config.update', name: '修改配置', riskLevel: 'critical', enabled: true, sideEffects: ['modifies_state'] });
  assert.equal(critical.exposure, 'hidden');
  assert.equal(critical.idempotency, 'payload');
});

test('tool-runtime R1: schema validation covers required/type/enum/additional-property errors', () => {
  const schema = {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      count: { type: 'number', minimum: 1, maximum: 4 },
      quality: { type: 'string', enum: ['low', 'high'] },
    },
    required: ['prompt', 'count'],
    additionalProperties: false,
  };
  assert.deepEqual(validateToolArguments(schema, { prompt: 'a', count: 2, quality: 'high' }), []);
  const missing = validateToolArguments(schema, { count: 2 });
  assert.ok(missing.some((item) => item.code === 'missing_required_argument' && item.path === '$.prompt'));
  const wrongType = validateToolArguments(schema, { prompt: 'a', count: '2' });
  assert.ok(wrongType.some((item) => item.code === 'invalid_argument_type' && item.path === '$.count'));
  const enumError = validateToolArguments(schema, { prompt: 'a', count: 2, quality: 'ultra' });
  assert.ok(enumError.some((item) => item.code === 'invalid_enum_value' && item.path === '$.quality'));
  const extra = validateToolArguments(schema, { prompt: 'a', count: 2, extra: true });
  assert.ok(extra.some((item) => item.code === 'invalid_arguments' && item.path === '$.extra'));
  const range = validateToolArguments(schema, { prompt: 'a', count: 20 });
  assert.ok(range.some((item) => item.code === 'invalid_arguments' && item.path === '$.count'));
});

test('tool-runtime R1: batch envelope rejects too many, duplicate and conflicting calls before execution', () => {
  const tooMany = validateToolCallBatch([
    { id: 'a', name: 'one', arguments: {} },
    { id: 'b', name: 'two', arguments: {} },
  ], { maxCalls: 1 });
  assert.ok(tooMany.some((item) => item.code === 'too_many_tool_calls'));

  const duplicate = validateToolCallBatch([
    { id: 'same', name: 'one', arguments: { x: 1 } },
    { id: 'same', name: 'two', arguments: { x: 2 } },
  ]);
  assert.ok(duplicate.some((item) => item.code === 'duplicate_tool_call_id'));
  assert.ok(duplicate.some((item) => item.code === 'conflicting_tool_calls'));

  const invalid = validateToolCallBatch([{ id: '', name: '', arguments: {} }]);
  assert.ok(invalid.some((item) => item.code === 'invalid_envelope'));
});

test('tool-runtime R1: registry loadout is deterministic and enforces exposure/context/budget', () => {
  const registry = new ToolRegistry();
  registry.register(spec('core.tool', { exposure: 'core' }));
  registry.register(spec('domain.ctx', { exposure: 'domain', requiredContext: ['image'] }));
  registry.register(spec('search.tool', { exposure: 'searchable' }));
  registry.register(spec('hidden.tool', { exposure: 'hidden' }));
  const normal = registry.resolveLoadout();
  assert.deepEqual(normal.tools.map((item) => item.name), ['core.tool']);
  const withImage = registry.resolveLoadout({ availableContext: ['image'] });
  assert.deepEqual(withImage.tools.map((item) => item.name), ['core.tool', 'domain.ctx']);
  const searched = registry.resolveLoadout({ exposures: ['core', 'searchable'] });
  assert.deepEqual(searched.tools.map((item) => item.name), ['core.tool', 'search.tool']);
  assert.ok(searched.omitted.some((item) => item.name === 'domain.ctx' && item.reason === 'exposure'));
  const limited = registry.resolveLoadout({ availableContext: ['image'], maxTools: 1 });
  assert.deepEqual(limited.tools.map((item) => item.name), ['core.tool']);
  assert.ok(limited.omitted.some((item) => item.name === 'domain.ctx' && item.reason === 'max_tools'));
});

test('tool-runtime R1: executor fails closed on truncation/unknown/hidden/schema errors and dispatches valid calls once', async () => {
  const registry = new ToolRegistry();
  registry.register(spec('echo.tool', { exposure: 'core' }));
  registry.register(spec('hidden.tool', { exposure: 'hidden' }));
  const executor = new ToolExecutor({ registry, maxCallsPerBatch: 2 });
  let calls = 0;
  executor.registerHandler('echo.tool', async (call) => {
    calls += 1;
    return { ok: true, content: String(call.arguments.prompt) };
  });
  executor.registerHandler('hidden.tool', () => {
    throw new Error('must not execute');
  });
  const ctx = { sessionKey: 'private:1', turnId: 'turn-1' };

  const truncated = await executor.execute({ id: 'c0', name: 'echo.tool', arguments: { prompt: 'x' } }, { ...ctx, truncatedOutput: true });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.error.code, 'truncated_output');
  assert.equal(calls, 0);

  const unknown = await executor.execute({ id: 'c1', name: 'missing.tool', arguments: {} }, ctx);
  assert.equal(unknown.error.code, 'unknown_tool');

  const hidden = await executor.execute({ id: 'c2', name: 'hidden.tool', arguments: { prompt: 'x' } }, ctx);
  assert.equal(hidden.error.code, 'unavailable_tool');

  const invalid = await executor.execute({ id: 'c3', name: 'echo.tool', arguments: {} }, ctx);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'missing_required_argument');

  const valid = await executor.execute({ id: 'c4', name: 'echo.tool', arguments: { prompt: 'hello' } }, ctx);
  assert.equal(valid.ok, true);
  assert.equal(valid.content, 'hello');
  assert.equal(calls, 1);

  const batch = await executor.executeBatch([
    { id: 'dup', name: 'echo.tool', arguments: { prompt: 'a' } },
    { id: 'dup', name: 'echo.tool', arguments: { prompt: 'b' } },
  ], ctx);
  assert.equal(batch.length, 2);
  assert.ok(batch.every((item) => item.ok === false && item.error.code === 'duplicate_tool_call_id'));
  assert.equal(calls, 1);
});

test('agent-runtime R1: repair budget uses fingerprints and enforces all caps', () => {
  const error = makeToolError({ code: 'malformed_json', message: 'bad json', toolName: 'image.generate' });
  assert.equal(error.fingerprint, toolErrorFingerprint(error));
  const repeated = new OutputRepairBudgetTracker({ maxRepeatedErrorCount: 2, maxProtocolRepairs: 10, maxSchemaRepairsPerCall: 10, maxTotalOutputRepairs: 10 });
  assert.equal(repeated.requestRepair(error, 'protocol').allowed, true);
  const second = repeated.requestRepair(error, 'protocol');
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'max_repeated_error_count');

  const protocol = new OutputRepairBudgetTracker({ maxProtocolRepairs: 1, maxRepeatedErrorCount: 10, maxTotalOutputRepairs: 10 });
  assert.equal(protocol.requestRepair(makeToolError({ code: 'invalid_envelope', message: 'one' }), 'protocol').allowed, true);
  const protocolSecond = protocol.requestRepair(makeToolError({ code: 'invalid_envelope', message: 'two' }), 'protocol');
  assert.equal(protocolSecond.allowed, false);
  assert.equal(protocolSecond.reason, 'max_protocol_repairs');

  const schema = new OutputRepairBudgetTracker({ maxSchemaRepairsPerCall: 1, maxRepeatedErrorCount: 10, maxTotalOutputRepairs: 10 });
  assert.equal(schema.requestRepair(makeToolError({ code: 'invalid_arguments', message: 'a' }), 'schema', 'call_1').allowed, true);
  const schemaSecond = schema.requestRepair(makeToolError({ code: 'invalid_argument_type', message: 'b' }), 'schema', 'call_1');
  assert.equal(schemaSecond.allowed, false);
  assert.equal(schemaSecond.reason, 'max_schema_repairs_per_call');
});

test('agent-runtime R1: ask_user/update_plan are strict core tools', () => {
  assert.equal(ASK_USER_TOOL_SPEC.exposure, 'core');
  assert.equal(ASK_USER_TOOL_SPEC.idempotency, 'none');
  assert.equal(ASK_USER_TOOL_SPEC.inputSchema.required.includes('missingFields'), true);
  assert.equal(ASK_USER_TOOL_SPEC.inputSchema.additionalProperties, false);
  assert.equal(UPDATE_PLAN_TOOL_SPEC.exposure, 'core');
  assert.equal(UPDATE_PLAN_TOOL_SPEC.riskLevel, 'low');
  assert.equal(UPDATE_PLAN_TOOL_SPEC.inputSchema.additionalProperties, false);
});
