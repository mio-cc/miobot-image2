import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { McpRootToolHandler, buildMcpChildTools, buildMcpRootDescriptor } = await import(pathToFileURL(path.join(ROOT, 'dist/apps/bot/src/mcp-root-tool.js')).href);
const { mcpContentToTexts } = await import(pathToFileURL(path.join(ROOT, 'dist/apps/bot/src/mcp-client.js')).href);
const { createBoxDryRunTransport, createBoxDryRunHarness, SYNTHETIC_TOOLS } = await import(pathToFileURL(path.join(ROOT, 'scripts/mcp-box-dry-run.mjs')).href);
const { createDefaultConfig, importConfig } = await import(pathToFileURL(path.join(ROOT, 'dist/packages/config/src/index.js')).href);
const { buildMcpRootPromptSection } = await import(pathToFileURL(path.join(ROOT, 'dist/apps/bot/src/agent-host.js')).href);

const SERVER_ID = 'box';
const ROOT_ID = `mcp.${SERVER_ID}`;
const GUIDE = '# Box 指南（测试）\n## 黄金规则\n1. 你看不到截图。';
const CHILDREN = buildMcpChildTools(SERVER_ID, SYNTHETIC_TOOLS, {});

function makeInvocation(args) {
  return { plan: { planId: 'dry-plan' }, step: { id: 'dry-step', capability: ROOT_ID, args } };
}

function makeHandler(behavior) {
  const calls = [];
  const client = {
    callTool: async (name, params) => {
      calls.push({ name, params });
      if (behavior === 'structured-only') return { content: [], isError: false, structuredContent: { box_id: 'cb-x', state: 'hibernated' } };
      if (behavior === 'image-only') return { content: [{ type: 'image', data: 'UklGRkQ', mimeType: 'image/webp' }], isError: false };
      if (behavior === 'empty') return { content: [], isError: false };
      return { content: [{ type: 'text', text: `dry-run:${name}` }], isError: false };
    },
  };
  return { calls, handler: new McpRootToolHandler(client, SERVER_ID, CHILDREN, {}, GUIDE) };
}

test('box 预置：默认配置含 box 内置项（默认停用、OAuth、带 L1 rootDescription）', () => {
  const cfg = createDefaultConfig();
  const preset = cfg.orchestration.mcpServers.find((item) => item.id === SERVER_ID);
  assert.ok(preset, '默认配置必须有 box 预置');
  assert.equal(preset.enabled, false, '默认 deny：未启用');
  assert.equal(preset.auth, 'oauth');
  assert.equal(preset.url, 'https://mcp.box.simular.ai/mcp');
  assert.ok(typeof preset.rootDescription === 'string' && preset.rootDescription.length > 50);
});

test('box 预置：normalizer 透传 rootDescription/guide 并截断', () => {
  const cfg = importConfig({ orchestration: { mcpServers: [
    { id: 'box', enabled: true, transport: 'http', url: 'https://mcp.box.simular.ai/mcp', auth: 'oauth',
      rootDescription: '  自定义简介  '.padEnd(700, '。'), guide: 'x'.repeat(70000) },
  ] } }).config;
  const server = cfg.orchestration.mcpServers.find((item) => item.id === SERVER_ID);
  assert.equal(server.rootDescription.length, 600, 'rootDescription 截断到 600');
  assert.equal(server.rootDescription.trim(), server.rootDescription, '已 trim');
  assert.equal(server.guide.length, 65536, 'guide 截断到 64KB');
});

test('box L1：rootDescription 覆写根描述，未配置时回退自动生成', () => {
  const override = '自定义根简介。';
  const withOverride = buildMcpRootDescriptor(SERVER_ID, CHILDREN, {}, undefined, undefined, override, true);
  assert.equal(withOverride.description.startsWith('自定义根简介'), true);
  assert.ok(withOverride.description.includes('guide'), '未自带 guide 提示时自动追加');

  const auto = buildMcpRootDescriptor(SERVER_ID, CHILDREN, {}, undefined, undefined, undefined, true);
  assert.ok(auto.description.includes('action=guide'), '自动描述含 guide 提示');
  assert.ok(auto.description.length <= 800);
  const noGuide = buildMcpRootDescriptor(SERVER_ID, CHILDREN, {}, undefined, undefined, undefined, false);
  assert.equal(noGuide.description.includes('action=guide'), false, '无指南时不出现 guide 提示');
});

test('box L2：action=guide 返回指南全文，无指南时回退目录', async () => {
  const { handler } = makeHandler();
  const result = await handler.execute(makeInvocation({ action: 'guide' }));
  assert.equal(result.status, 'success');
  const text = result.outputs[0].text;
  assert.ok(text.startsWith(`[mcp.${SERVER_ID}/guide]`));
  assert.ok(text.includes('你看不到截图'), '指南全文返回');

  const noGuide = new McpRootToolHandler({ callTool: async () => ({ content: [] }) }, SERVER_ID, CHILDREN, {});
  const fallback = await noGuide.execute(makeInvocation({ action: 'guide' }));
  assert.equal(fallback.status, 'success', '无指南不报错');
  assert.ok(fallback.outputs[0].text.includes('子操作清单'));
  assert.ok(fallback.outputs[0].text.includes('未配置使用指南'));
});

test('box 补丁 A：mcpContentToTexts 文本优先、structuredContent 兜底、image 不算文本', () => {
  assert.deepEqual(mcpContentToTexts([{ type: 'text', text: ' hello ' }]), ['hello']);
  assert.deepEqual(mcpContentToTexts([{ type: 'image', data: 'x' }], { state: 'running' }), ['{\n  "state": "running"\n}']);
  assert.equal(mcpContentToTexts([{ type: 'image', data: 'x' }]), null, '纯 image 无结构化 → null（补丁 C 前的已知缺口）');
  assert.equal(mcpContentToTexts([], {}), null, '空 content + 空 structuredContent → null');
});

test('box 补丁 A：纯 structuredContent 子项不再判 empty_output，isError 结构化错误透传', async () => {
  const structured = makeHandler('structured-only');
  const result = await structured.handler.execute(makeInvocation({ action: 'box_status', params: {} }));
  assert.equal(result.status, 'success', 'box_status 这类纯结构化工具必须成功');
  assert.ok(result.outputs[0].text.startsWith(`[mcp.${SERVER_ID}/box_status]`));
  assert.ok(result.outputs[0].text.includes('"state": "hibernated"'));

  const failed = new McpRootToolHandler(
    { callTool: async () => ({ content: [], isError: true, structuredContent: { error: 'box plans are not enabled' } }) },
    SERVER_ID, CHILDREN, {},
  );
  const errorResult = await failed.execute(makeInvocation({ action: 'usage', params: {} }));
  assert.equal(errorResult.status, 'failed');
  assert.match(errorResult.error, /mcp_tool_error:usage.*box plans are not enabled/s);
});

test('box 链路：guideResolver 兜底、目录含 guide hint、未知/缺参/截图边界（全链零网络）', async () => {
  const transport = createBoxDryRunTransport({ tools: SYNTHETIC_TOOLS, toolBehavior: { screenshot: { kind: 'image-only' } } });
  const overrides = { [ROOT_ID]: { enabled: true, riskLevel: 'medium', timeoutMs: 180000 } };
  const harness = await createBoxDryRunHarness({
    server: { id: SERVER_ID, enabled: true, transport: 'http', url: 'https://mcp.box.simular.ai/mcp', auth: 'oauth', rootDescription: '简介。' },
    overrides,
    transport,
    guideResolver: () => GUIDE,
  });
  assert.equal(Boolean(harness.root), true, '根能力注册');

  const guide = await harness.invoke({ action: 'guide' });
  assert.equal(guide.status, 'success');
  assert.equal(transport.ledger.filter((item) => item.method === 'tools/call').length, 0, 'guide 不触网');

  const catalog = await harness.invoke({ action: 'list_actions' });
  assert.ok(catalog.outputs[0].text.includes('action=guide 获取该服务的完整使用指南'), '目录含 guide hint');
  assert.equal(catalog.outputs[0].text.includes('action=guide'), true);

  const bad = await harness.invoke({ action: 'shell', params: {} });
  assert.match(bad.error, /mcp_action_params_invalid:shell/);

  const shot = await harness.invoke({ action: 'screenshot', params: {} });
  assert.match(shot.error, /mcp_tool_empty_output:screenshot/, 'image-only 是补丁 C 前的已知行为');
  await harness.manager.close();
});

test('box L0：buildMcpRootPromptSection 只含 mcp.* 根工具，无根工具时返回 null', () => {
  const content = buildMcpRootPromptSection([{ name: 'mcp.box' }, { name: 'mcp.box.shell' }, { name: 'web.search' }, { name: 'image.generate' }]);
  assert.ok(content.includes('## 远程 MCP 服务'));
  assert.ok(content.includes('mcp.box'));
  assert.equal(content.includes('mcp.box.shell'), false, '子项不进提示');
  assert.equal(content.includes('web.search'), false, '非 mcp 工具不进提示');
  assert.ok(content.includes('list_actions'));
  assert.ok(content.includes('优先用本地能力'));
  assert.equal(buildMcpRootPromptSection([{ name: 'web.search' }]), null);
});
