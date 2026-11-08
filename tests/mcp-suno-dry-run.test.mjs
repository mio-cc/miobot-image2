import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'suno-mcp-tools.json'), 'utf8'));

const { McpRootToolHandler, buildMcpChildTools, buildMcpRootDescriptor, resolveChildParamDefaults } = await import(pathToFileURL(path.join(ROOT, 'dist/apps/bot/src/mcp-root-tool.js')).href);
const { McpClient } = await import(pathToFileURL(path.join(ROOT, 'dist/apps/bot/src/mcp-client.js')).href);
const { createDryRunTransport, createDryRunHarness, SUNO_DRY_RUN_LYRICS } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'mcp-suno-dry-run.mjs')).href);

const SERVER_ID = 'suno-official';
const ROOT_ID = `mcp.${SERVER_ID}`;
const CHILDREN = buildMcpChildTools(SERVER_ID, FIXTURE.tools, {});

const LYRICS = ['[Intro]', '雨の粒が　窓辺でほどける', '', '[Verse 1]', '傘を忘れた　帰り道', '', '[Chorus]', '雨上がりのレコード　針を落として'].join('\n');

function makeInvocation(args) {
  return { plan: { planId: 'dry-plan' }, step: { id: 'dry-step', capability: ROOT_ID, args } };
}

function makeHandler(childDefaults = {}) {
  const calls = [];
  const client = {
    callTool: async (name, params) => {
      calls.push({ name, params });
      return { content: [{ type: 'text', text: `dry-run:${name}` }], isError: false, structuredContent: { argumentsReceived: params } };
    },
  };
  return { calls, handler: new McpRootToolHandler(client, SERVER_ID, CHILDREN, childDefaults) };
}

test('suno dry-run fixture：41 个工具，生成类工具无输出格式参数', () => {
  assert.equal(FIXTURE.toolCount, 41, 'fixture 应为 41 个工具');
  assert.equal(FIXTURE.tools.length, 41);
  const generationTools = FIXTURE.tools.filter((tool) => ['audio-create', 'audio-covers-create', 'audio-extensions-create', 'audio-mashups-create', 'sounds-create', 'speech-create'].includes(tool.name));
  assert.equal(generationTools.length, 6, '生成类工具齐全');
  for (const tool of generationTools) {
    const props = Object.keys(tool.inputSchema?.properties || {}).map((name) => name.toLowerCase());
    const hasFormatProp = props.some((name) => /format|mime|extension|codec|container/.test(name));
    assert.equal(hasFormatProp, false, `${tool.name} 不应有生成时格式参数：${props.join(',')}`);
  }
  assert.equal(FIXTURE.tools.some((tool) => tool.outputSchema), false, '服务器未提供 outputSchema');
});

test('suno dry-run fixture：audio-download 是唯一格式选择点（mp3/wav，默认 mp3）', () => {
  const hits = [];
  for (const tool of FIXTURE.tools) {
    for (const [name, schema] of Object.entries(tool.inputSchema?.properties || {})) {
      if (/format|mime|extension|codec|container/.test(name.toLowerCase())) hits.push({ tool: tool.name, name, schema });
    }
  }
  assert.deepEqual(hits.map((item) => `${item.tool}.${item.name}`), ['audio-download.format']);
  const format = hits[0].schema;
  assert.deepEqual(format.enum, ['mp3', 'wav']);
  assert.equal(format.default, 'mp3');
  assert.equal(hits[0].tool.includes('download'), true);
});

test('suno dry-run：默认模型注入在转发前完成，歌词逐字节透传且标记独占一行', async () => {
  const { calls, handler } = makeHandler({ 'audio-create': { model: { value: 'v6-mini' } } });
  const result = await handler.execute(makeInvocation({ action: 'audio-create', params: { lyrics: LYRICS, title: '雨上がりのレコード' } }));
  assert.equal(result.status, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'audio-create');
  assert.equal(calls[0].params.model, 'v6-mini');
  assert.equal(calls[0].params.lyrics, LYRICS, '歌词必须逐字节一致（无清洗层）');
  assert.equal(calls[0].params.lyrics.split('\n').length, LYRICS.split('\n').length);
  for (const line of calls[0].params.lyrics.split('\n')) {
    if (line.trim().startsWith('[')) assert.match(line.trim(), /^\[[^\[\]]+\]$/, `结构标记必须独占一行：${line}`);
  }
});

test('suno dry-run：显式 model 覆盖非锁定默认，锁定默认强制覆盖显式值', async () => {
  const unlocked = makeHandler({ 'audio-create': { model: { value: 'v6-mini' } } });
  await unlocked.handler.execute(makeInvocation({ action: 'audio-create', params: { lyrics: LYRICS, model: 'v6' } }));
  assert.equal(unlocked.calls[0].params.model, 'v6');

  const locked = makeHandler({ 'audio-create': { model: { value: 'v6-mini', locked: true } } });
  await locked.handler.execute(makeInvocation({ action: 'audio-create', params: { lyrics: LYRICS, model: 'v6' } }));
  assert.equal(locked.calls[0].params.model, 'v6-mini');
});

test('suno dry-run：生成时传 output_format 被 schema 拒绝，不会触达 client', async () => {
  const { calls, handler } = makeHandler({ 'audio-create': { model: { value: 'v6-mini' } } });
  const result = await handler.execute(makeInvocation({ action: 'audio-create', params: { lyrics: LYRICS, output_format: 'wav' } }));
  assert.equal(result.status, 'failed');
  assert.match(result.error, /mcp_action_params_invalid:audio-create/);
  assert.match(result.error, /\$\.params\.output_format/);
  assert.equal(calls.length, 0, '校验失败不得调用 client');
});

test('suno dry-run：audio-download 默认 format=mp3，显式 wav 覆盖，非法枚举被拒', async () => {
  const { calls, handler } = makeHandler({ 'audio-download': { format: { value: 'mp3' } } });
  await handler.execute(makeInvocation({ action: 'audio-download', params: { id: 'clip-1' } }));
  assert.equal(calls[0].params.format, 'mp3');

  await handler.execute(makeInvocation({ action: 'audio-download', params: { id: 'clip-1', format: 'wav' } }));
  assert.equal(calls[1].params.format, 'wav');

  const bad = await handler.execute(makeInvocation({ action: 'audio-download', params: { id: 'clip-1', format: 'flac' } }));
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /必须是 mp3, wav 之一/);
  assert.equal(calls.length, 2, '非法格式不得调用 client');
});

test('suno dry-run：根描述暴露已配置默认值，且歌词规范仍在 800 字符内', () => {
  const descriptor = buildMcpRootDescriptor(SERVER_ID, CHILDREN, {}, undefined, { 'audio-create': { model: { value: 'v6-mini' } }, 'audio-download': { format: { value: 'mp3' } } });
  assert.ok(descriptor.description.includes('audio-create(model=v6-mini)'));
  assert.ok(descriptor.description.includes('audio-download(format=mp3)'));
  assert.ok(descriptor.description.includes('歌词/文本参数规范'));
  assert.ok(descriptor.description.includes('人设隔离'), '人设隔离规则进入根描述');
  assert.ok(descriptor.description.includes('规避内容审核'), '审核规避规则进入根描述');
  assert.ok(descriptor.description.length <= 800, `当前 ${descriptor.description.length}`);
});

test('suno dry-run：空 params 被 audio-create 条件必填拒绝，不触达 client', async () => {
  const { calls, handler } = makeHandler({ 'audio-create': { model: { value: 'v6-mini' } } });
  const empty = await handler.execute(makeInvocation({ action: 'audio-create', params: {} }));
  assert.equal(empty.status, 'failed');
  assert.match(empty.error, /mcp_action_params_invalid:audio-create/);
  assert.match(empty.error, /需满足任一条件：description 或 lyrics 或 instrumental=true 或 midi_upload_id/);
  assert.equal(calls.length, 0);

  const instrumental = await handler.execute(makeInvocation({ action: 'audio-create', params: { instrumental: true } }));
  assert.equal(instrumental.status, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.model, 'v6-mini');
});

test('suno dry-run：list_actions 覆盖全部 41 项，并暴露关键枚举与条件必填', async () => {
  const { handler } = makeHandler({ 'audio-download': { format: { value: 'mp3' } } });
  const result = await handler.execute(makeInvocation({ action: 'list_actions' }));
  assert.equal(result.status, 'success');
  const text = result.outputs[0].text;
  for (const tool of FIXTURE.tools) assert.ok(text.includes(`- ${tool.name}`), `目录漏掉 ${tool.name}`);
  assert.ok(text.includes('format: mp3|wav'));
  assert.ok(text.includes('任一必填：description 或 lyrics 或 instrumental=true 或 midi_upload_id'));
});

test('suno dry-run：写操作按 annotations 判高风险，audio-create 归为 generate', () => {
  const create = CHILDREN.find((child) => child.name === 'audio-create');
  const download = CHILDREN.find((child) => child.name === 'audio-download');
  assert.equal(create.riskLevel, 'high', `audio-create risk=${create.riskLevel}`);
  assert.equal(download.riskLevel, 'high', `audio-download risk=${download.riskLevel}`);
  assert.equal(create.effect, 'generate', `audio-create effect=${create.effect}`);
  for (const tool of FIXTURE.tools) {
    if (tool.annotations?.readOnlyHint !== false) continue;
    const child = CHILDREN.find((item) => item.name === tool.name);
    assert.equal(child.riskLevel, 'high', `${tool.name} 应为 high，实际 ${child.riskLevel}`);
  }
});

test('suno dry-run：McpClient 的 HTTP 传输唯一出口是 fetchImpl——注入哨兵后无法出网', async () => {
  let sentinelCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    sentinelCalls += 1;
    throw new Error('real_fetch_forbidden');
  };
  try {
    const client = new McpClient(
      { id: SERVER_ID, enabled: true, transport: 'http', url: 'https://api.suno.com/mcp', auth: 'oauth' },
      { fetchImpl: async () => { throw new Error('dry_run_forbidden'); }, timeoutMs: 5000 },
    );
    await assert.rejects(() => client.callTool('audio-create', { lyrics: LYRICS }), /dry_run_forbidden/);
    assert.equal(sentinelCalls, 0, 'globalThis.fetch 不得被触达');
  } finally {
    globalThis.fetch = realFetch;
  }
});
