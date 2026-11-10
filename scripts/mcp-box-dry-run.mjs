#!/usr/bin/env node
/**
 * Box MCP 干跑（dry-run）工具链——验证 box 接入的三层信息架构与结构化兜底，全程零网络。
 *
 * 子命令：
 *   flow   离线干跑（默认）：合成 box 工具目录，拦截 McpClient.fetchImpl（位于 HTTP 传输最底层，
 *          任何 socket 写出之前），走完整链路 config（内置 box 预置）→ McpServerManager →
 *          根能力注册（L1 描述覆写）→ action=guide 指南递送（L2）→ 子项校验 → tools/call
 *          拦截/响应映射（含纯 structuredContent 兜底），输出结构化核对记录。
 *   probe  只读真实网络：initialize + tools/list，把真实工具 schema（含 annotations）落盘到
 *          tests/fixtures/box-mcp-tools.json。**不调用 tools/call**。需要先在面板完成 box 授权
 *          （读取 .runtime/mcp-credentials.json 的 box 条目）。
 *
 * 安全边界（flow 为什么不会产生任何真实调用）：
 *   - 拦截层位于 McpClient 的 fetchImpl；flow 同时把 globalThis.fetch 换成抛错哨兵，
 *     任何绕过拦截层的代码路径都会立即失败；
 *   - 代码中不存在 flow 路径上的真实 tools/call；只有 probe 发真实请求且只读。
 *
 * 用法：
 *   node scripts/mcp-box-dry-run.mjs flow [--json]
 *   node scripts/mcp-box-dry-run.mjs probe
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREDENTIALS_PATH = sessionArg('--credentials', path.join(ROOT, '.runtime', 'mcp-credentials.json'));
const FIXTURE_PATH = sessionArg('--fixture', path.join(ROOT, 'tests', 'fixtures', 'box-mcp-tools.json'));
const SERVER_ID = 'box';
const ROOT_ID = `mcp.${SERVER_ID}`;

/** 脚本内合成的 box 工具目录（flow 用；与真实服务的工具子集一致，含 annotations 供风险推断）。 */
export const SYNTHETIC_TOOLS = [
  {
    name: 'box_status',
    description: 'Show the state of your box: running or hibernated, its image, whether an upgrade is available, and when your files were last saved.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { box: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'usage',
    description: 'Show the model usage gw metered for your account, all your boxes together.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'shell',
    description: 'Run a bash command in the agent\'s persistent shell session (cwd /workspace). Returns merged stdout/stderr and the exit status; output over ~30 KB keeps only its head and tail. Keep each command\'s wait well under the time left.',
    annotations: { destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_s: { type: 'number' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_fetch',
    description: 'Read a web page without showing it: the box\'s Chrome loads the URL in a hidden tab with the user\'s cookies, waits, and returns the page title, final URL and visible text, up to 20000 characters, then closes the tab.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'script_run',
    description: 'Run a script for desktop work a single gui_plan cannot hold: loops over many items, data between apps, logic. Node 24 runs the ES module; a module exporting main(params) is called with them and its return value comes back as result.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, script: { type: 'string' }, params: { type: 'object' }, timeout_s: { type: 'number' }, screenshot: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: 'Look at the desktop: a read-only screenshot of the whole screen, scaled to a long edge of 1024 pixels unless max_edge says otherwise.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { max_edge: { type: 'number' }, region: { type: 'object' } }, additionalProperties: false },
  },
];

function sessionArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** ==================== flow：离线干跑 ==================== */

function rpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'box-dry-run-session' },
  });
}

/**
 * 拦截传输层：tools/call 的响应行为由 toolBehavior 指定，模拟 box 服务实测到的三类返回——
 * 纯文本（browser_fetch / shell）、纯 structuredContent 无文本（box_status / usage）、image 块无文本（screenshot）。
 */
export function createBoxDryRunTransport({ tools, toolBehavior = {} }) {
  const ledger = [];
  const fetchImpl = async (url, init = {}) => {
    const bodyText = typeof init.body === 'string' ? init.body : '';
    let message = null;
    try { message = bodyText ? JSON.parse(bodyText) : null; } catch { message = null; }
    const method = String(message?.method || '');
    const entry = { seq: ledger.length + 1, method, network: false, url: String(url), body: bodyText, at: new Date().toISOString() };
    if (method === 'tools/call') {
      entry.tool = String(message?.params?.name || '');
      entry.args = message?.params?.arguments || {};
    }
    ledger.push(entry);

    if (method === 'initialize') {
      return rpcResult(message?.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'Box (dry-run)', version: 'dry-run' },
      });
    }
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (method === 'tools/list') return rpcResult(message?.id, { tools });
    if (method === 'tools/call') {
      const name = entry.tool;
      const behavior = toolBehavior[name] || { kind: 'ok' };
      if (behavior.kind === 'hang') return new Promise(() => { /* 永不 resolve，由 client 超时兜底 */ });
      if (behavior.kind === 'isError-text') {
        return rpcResult(message?.id, { content: [{ type: 'text', text: behavior.text || 'list /nope: No such file or directory (os error 2)' }], isError: true });
      }
      if (behavior.kind === 'isError-structured') {
        return rpcResult(message?.id, { content: [], isError: true, structuredContent: behavior.payload || { error: 'box plans are not enabled' } });
      }
      if (behavior.kind === 'structured-only') {
        return rpcResult(message?.id, { content: [], isError: false, structuredContent: behavior.payload });
      }
      if (behavior.kind === 'image-only') {
        return rpcResult(message?.id, { content: [{ type: 'image', data: 'UklGRkQAAABXRUJQ', mimeType: 'image/webp' }], isError: false });
      }
      return rpcResult(message?.id, {
        content: [{ type: 'text', text: `DRY_RUN_BLOCKED（未发出 HTTP）\n工具：${name}\n参数：${JSON.stringify(entry.args, null, 2)}` }],
        isError: false,
        structuredContent: { dryRun: true, tool: name, argumentsReceived: entry.args },
      });
    }
    return rpcResult(message?.id, {});
  };
  return { fetchImpl, ledger };
}

async function loadRuntimeModules() {
  const managerModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'apps', 'bot', 'src', 'mcp-server-manager.js')).href);
  const clientModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'apps', 'bot', 'src', 'mcp-client.js')).href);
  const hostModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'apps', 'bot', 'src', 'agent-host.js')).href);
  const configModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'packages', 'config', 'src', 'index.js')).href);
  return { McpServerManager: managerModule.McpServerManager, McpClient: clientModule.McpClient, buildMcpRootPromptSection: hostModule.buildMcpRootPromptSection, createDefaultConfig: configModule.createDefaultConfig };
}

function createSyntheticCredentialStore(serverId) {
  const credentials = new Map([[serverId, { accessToken: 'box-dry-run-token' }]]);
  return {
    filePath: '(box-dry-run://synthetic-credentials)',
    get: (id) => credentials.get(String(id)),
    set: (id, credential) => credentials.set(String(id), credential),
    clear: (id) => credentials.delete(String(id)),
    getClient: () => undefined,
    setClient: () => undefined,
  };
}

/**
 * 取 box 服务器配置：.runtime/config.json 有带 rootDescription 的 box 条目时用它（真实配置），
 * 否则回退 createDefaultConfig() 的内置预置（经 normalizer 合并，必带 L1 rootDescription）。
 */
async function loadBoxServer() {
  const { createDefaultConfig } = await loadRuntimeModules();
  const runtimeConfig = path.join(ROOT, '.runtime', 'config.json');
  if (fs.existsSync(runtimeConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(runtimeConfig, 'utf8'));
      const server = (cfg.orchestration?.mcpServers || []).find((item) => item.id === SERVER_ID);
      if (server && server.rootDescription) return { config: cfg, server };
    } catch { /* fall through */ }
  }
  const cfg = createDefaultConfig();
  const server = cfg.orchestration.mcpServers.find((item) => item.id === SERVER_ID);
  if (!server) throw new Error(`默认配置中找不到内置 mcpServers[id=${SERVER_ID}]`);
  return { config: cfg, server };
}

export async function createBoxDryRunHarness({ server, overrides = {}, transport, guideResolver, timeoutMs }) {
  const { McpServerManager, McpClient } = await loadRuntimeModules();
  const registry = new Map();
  const manager = new McpServerManager({
    getConfig: () => ({ orchestration: { mcpServers: [server], capabilityOverrides: overrides } }),
    registerCapability: (descriptor, handler) => registry.set(descriptor.id, { descriptor, handler }),
    unregisterCapability: (capabilityId) => registry.delete(capabilityId),
    credentialStore: createSyntheticCredentialStore(server.id),
    ...(guideResolver ? { guideResolver } : {}),
    createClient: (config, options) => new McpClient(config, { ...options, fetchImpl: transport.fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) }),
  });
  await manager.connect(server);
  const root = registry.get(ROOT_ID);
  const invoke = (args) => {
    if (!root) throw new Error('根能力未注册');
    return root.handler.execute({ plan: { planId: 'box-dry-plan' }, step: { id: 'box-dry-step', capability: ROOT_ID, args } });
  };
  return { manager, registry, root, invoke };
}

const GUIDE_TEXT = '# Box 云桌面 · 指南（dry-run 摘要）\n## 黄金规则\n1. 你看不到截图。\n2. refs 一次性。\n3. 超时是硬的。';

async function flow() {
  const asJson = process.argv.includes('--json');
  const { server } = await loadBoxServer();
  const { buildMcpRootPromptSection, createDefaultConfig } = await loadRuntimeModules();
  const tools = SYNTHETIC_TOOLS;
  const overrides = {
    [ROOT_ID]: { enabled: true, riskLevel: 'medium', timeoutMs: 180000 },
    [`${ROOT_ID}.shell`]: { riskLevel: 'high' },
    [`${ROOT_ID}.script_run`]: { riskLevel: 'high' },
    [`${ROOT_ID}.box_delete`]: { riskLevel: 'critical' },
  };
  const checks = [];
  const findings = [];
  const scenarios = [];
  let globalFetchHits = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    globalFetchHits += 1;
    throw new Error(`box_dry_run_network_forbidden:${String(input)}`);
  };

  function check(name, ok, detail = '') {
    checks.push({ name, ok: Boolean(ok), detail });
    return Boolean(ok);
  }
  function finding(id, title, detail = '') {
    findings.push({ id, title, detail });
  }
  function record(id, ledger, extra = {}) {
    scenarios.push({ id, calls: ledger.filter((item) => item.method === 'tools/call'), control: ledger.filter((item) => item.method !== 'tools/call'), ...extra });
  }

  try {
    // ---- 0. 内置预置与 L1 根描述覆写 ----
    {
      const defaultCfg = createDefaultConfig();
      const preset = defaultCfg.orchestration.mcpServers.find((item) => item.id === SERVER_ID);
      check('默认配置含 box 内置预置', Boolean(preset), `id=${preset?.id}`);
      check('box 预置默认停用（默认 deny 纪律）', preset?.enabled === false, `enabled=${preset?.enabled}`);
      check('box 预置走 OAuth', preset?.auth === 'oauth' && preset?.url === 'https://mcp.box.simular.ai/mcp');
      check('box 预置带 L1 rootDescription', typeof preset?.rootDescription === 'string' && preset.rootDescription.length > 50, `len=${preset?.rootDescription?.length}`);

      const transport = createBoxDryRunTransport({ tools });
      const harness = await createBoxDryRunHarness({ server, overrides, transport, guideResolver: () => GUIDE_TEXT });
      const descriptor = harness.root?.descriptor;
      check('根能力已注册', Boolean(harness.root), ROOT_ID);
      check('L1 生效：根描述 = rootDescription 覆写', descriptor?.description === server.rootDescription, `len=${descriptor?.description?.length}`);
      check('L1 含 action=guide 提示（文案自带，不重复追加）', /guide/.test(String(descriptor?.description || '')));
      check('指南已配置时根描述不再二次追加 guideHint', descriptor?.description === server.rootDescription);
      check('根 enabled 来自覆盖配置', descriptor?.enabled === true, `enabled=${descriptor?.enabled}`);
      check('根工具入参 {action, params}', Boolean(descriptor?.inputSchema?.properties?.action && descriptor?.inputSchema?.properties?.params));
      record('root-descriptor', transport.ledger, { description: descriptor?.description });
      await harness.manager.close();
    }

    // ---- 1. action=guide 按需递送（L2）----
    {
      const transport = createBoxDryRunTransport({ tools });
      const harness = await createBoxDryRunHarness({ server, overrides, transport, guideResolver: () => GUIDE_TEXT });
      const result = await harness.invoke({ action: 'guide' });
      const text = result.outputs?.[0]?.text || '';
      check('action=guide 成功', result.status === 'success');
      check('guide 输出带来源前缀', text.startsWith(`[mcp.${SERVER_ID}/guide]`));
      check('guide 内容 = 指南全文', text.includes('你看不到截图'));
      check('guide 不触网（无 tools/call）', transport.ledger.filter((item) => item.method === 'tools/call').length === 0);
      record('guide', transport.ledger, { guidePreview: text.slice(0, 120) });
      await harness.manager.close();
    }

    // ---- 1b. 未配置指南时 action=guide 回退目录（不报错）----
    {
      const transport = createBoxDryRunTransport({ tools });
      const harness = await createBoxDryRunHarness({ server, overrides, transport }); // 无 guideResolver
      const result = await harness.invoke({ action: 'guide' });
      const text = result.outputs?.[0]?.text || '';
      check('无指南时 action=guide 仍成功', result.status === 'success');
      check('回退输出为子项目录', text.includes('子操作清单'));
      check('回退输出含未配置提示', text.includes('未配置使用指南'));
      record('guide-fallback', transport.ledger);
      await harness.manager.close();
    }

    // ---- 2. list_actions 目录含 guide hint ----
    {
      const transport = createBoxDryRunTransport({ tools });
      const harness = await createBoxDryRunHarness({ server, overrides, transport, guideResolver: () => GUIDE_TEXT });
      const result = await harness.invoke({ action: 'list_actions' });
      const text = result.outputs?.[0]?.text || '';
      const names = text.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split('：')[0].trim());
      check('list_actions 成功', result.status === 'success');
      check('目录覆盖全部合成工具', names.length === tools.length, `目录=${names.length} 工具=${tools.length}`);
      check('目录含 action=guide hint', text.includes('action=guide 获取该服务的完整使用指南'));
      check('目录含必填参数提示（shell）', /shell.*必填参数：command/.test(text.replace(/\s+/g, ' ')) || text.includes('command'));
      record('catalog', transport.ledger, { nameCount: names.length });
      await harness.manager.close();
    }

    // ---- 3. 补丁 A：纯 structuredContent 兜底（box_status 实测无 text 块）----
    {
      const transport = createBoxDryRunTransport({
        tools,
        toolBehavior: { box_status: { kind: 'structured-only', payload: { box_id: 'cb-x', name: 'main', state: 'hibernated', image: 'sbxdesk:v14' } } },
      });
      const harness = await createBoxDryRunHarness({ server, overrides, transport, guideResolver: () => GUIDE_TEXT });
      const result = await harness.invoke({ action: 'box_status', params: {} });
      const text = result.outputs?.[0]?.text || '';
      check('纯 structuredContent 不再判 empty_output', result.status === 'success', result.error || '');
      check('结构化内容序列化为 JSON 文本', text.includes('"state": "hibernated"') && text.startsWith(`[mcp.${SERVER_ID}/box_status]`));
      check('调用体正确（工具名+空 params）', transport.ledger.some((item) => item.method === 'tools/call' && item.tool === 'box_status'));
      record('structured-fallback', transport.ledger, { output: text });
      await harness.manager.close();
    }

    // ---- 3b. 补丁 A：isError 且只有 structuredContent（billing 实测形态）----
    {
      const transport = createBoxDryRunTransport({
        tools,
        toolBehavior: { usage: { kind: 'isError-structured', payload: { error: 'box plans are not enabled' } } },
      });
      const harness = await createBoxDryRunHarness({ server, overrides, transport, guideResolver: () => GUIDE_TEXT });
      const result = await harness.invoke({ action: 'usage', params: {} });
      check('isError 映射 mcp_tool_error', result.status === 'failed' && String(result.error || '').startsWith('mcp_tool_error:usage'));
      check('错误文本兜底含 structuredContent', String(result.error || '').includes('box plans are not enabled'), String(result.error || '').slice(0, 120));
      check('isError 不可重试', result.retryable === false);
      record('iserror-structured', transport.ledger, { error: result.error });
      await harness.manager.close();
    }

    // ---- 4. 纯文本工具正常 + 参数校验 ----
    {
      const transport = createBoxDryRunTransport({ tools });
      const harness = await createBoxDryRunHarness({ server, overrides, transport, guideResolver: () => GUIDE_TEXT });
      const ok = await harness.invoke({ action: 'browser_fetch', params: { url: 'https://example.com' } });
      check('文本工具成功并带前缀', ok.status === 'success' && String(ok.outputs?.[0]?.text || '').startsWith(`[mcp.${SERVER_ID}/browser_fetch]`));

      const bad = await harness.invoke({ action: 'shell', params: {} });
      check('缺必填参数 → mcp_action_params_invalid', bad.status === 'failed' && String(bad.error || '').startsWith('mcp_action_params_invalid:shell'), String(bad.error || '').slice(0, 140));
      const unknown = await harness.invoke({ action: 'box_delete', params: {} });
      check('未知 action（allowlist 外）→ mcp_unknown_action', unknown.status === 'failed' && String(unknown.error || '').startsWith('mcp_unknown_action'));
      record('text-and-validation', transport.ledger, { okStatus: ok.status, badError: bad.error, unknownError: unknown.error });
      await harness.manager.close();
    }

    // ---- 5. 已知缺口记录：image-only 返回（截图看不到，补丁 C 未上线前）----
    {
      const transport = createBoxDryRunTransport({ tools, toolBehavior: { screenshot: { kind: 'image-only' } } });
      const harness = await createBoxDryRunHarness({ server, overrides, transport, guideResolver: () => GUIDE_TEXT });
      const result = await harness.invoke({ action: 'screenshot', params: {} });
      check('image-only 仍判 empty_output（补丁 C 前的已知行为）', result.status === 'failed' && String(result.error || '').startsWith('mcp_tool_empty_output'), result.error || '');
      finding('image-output-dropped', 'screenshot/computer_* 的 image content block 当前被丢弃', '补丁 C（image→Canvas URL）上线前，主脑看不到截图；指南已引导用文本层或 desk ask/decide。');
      record('image-only', transport.ledger, { status: result.status, error: result.error });
      await harness.manager.close();
    }

    // ---- 6. L0 系统提示段（纯函数，不依赖 manager）----
    {
      const content = buildMcpRootPromptSection([{ name: 'mcp.box' }, { name: 'web.search' }, { name: 'mcpbox' }, { name: 'mcp.box.shell' }]);
      check('L0：含 mcp.* 根工具时生成提示段', content !== null && content.includes('mcp.box'));
      check('L0：不含子项/非 mcp 工具', content !== null && !content.includes('mcp.box.shell') && !content.includes('web.search') && !content.includes('mcpbox'));
      check('L0：提示模型先 list_actions / guide', content !== null && content.includes('list_actions') && content.includes('guide'));
      const empty = buildMcpRootPromptSection([{ name: 'web.search' }]);
      check('L0：无 mcp 根工具时返回 null', empty === null);
      record('l0-prompt', [], { content });
    }

    // ---- 7. 全程零网络 ----
    check('globalThis.fetch 哨兵从未被绕过', globalFetchHits === 0, `hits=${globalFetchHits}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  const report = {
    script: 'mcp-box-dry-run',
    mode: 'flow',
    at: new Date().toISOString(),
    server: { id: SERVER_ID, url: server.url, rootDescriptionLength: server.rootDescription?.length },
    checks,
    findings,
    scenarios,
    summary: { total: checks.length, passed: checks.filter((item) => item.ok).length, failed: checks.filter((item) => !item.ok).length, networkHits: globalFetchHits },
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of checks) console.log(`${item.ok ? '✔' : '✖'} ${item.name}${item.detail ? `｜${item.detail}` : ''}`);
    if (findings.length) {
      console.log('\n== 发现（已知缺口记录） ==');
      for (const item of findings) console.log(`- [${item.id}] ${item.title}\n    ${item.detail}`);
    }
    console.log(`\nflow 结果：${report.summary.passed}/${report.summary.total} 通过，${report.summary.failed} 失败，网络请求 ${report.summary.networkHits} 次（必须为 0）`);
  }
  if (report.summary.failed) process.exitCode = 1;
}

/** ==================== probe：只读真实网络 ==================== */

function parsePayload(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try { return JSON.parse(data); } catch { /* next */ }
  }
  return null;
}

async function probe() {
  const { server } = await loadBoxServer();
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error(`缺少凭据文件 ${CREDENTIALS_PATH}（请先在面板完成 box 授权）`);
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')).credentials?.[SERVER_ID];
  if (!credentials?.accessToken) throw new Error('缺少 box OAuth accessToken，请先在面板完成授权');
  let sessionId = null;
  const callCount = { initialize: 0, 'notifications/initialized': 0, 'tools/list': 0, 'tools/call': 0 };

  async function rpc(method, params, notify = false) {
    callCount[method] = (callCount[method] || 0) + 1;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${credentials.accessToken}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const body = JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id: callCount[method] }), method, ...(params ? { params } : {}) });
    const response = await fetch(server.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
    const sid = response.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (notify) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`mcp_http_${response.status}:${text.slice(0, 200)}`);
    const parsed = parsePayload(text);
    if (parsed?.error) throw new Error(`mcp_error:${parsed.error.message || parsed.error.code}`);
    return parsed?.result;
  }

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'miobot', version: '2' } });
  await rpc('notifications/initialized', undefined, true);
  const tools = [];
  let cursor;
  do {
    const result = await rpc('tools/list', cursor ? { cursor } : undefined);
    if (Array.isArray(result?.tools)) tools.push(...result.tools);
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
  } while (cursor);

  const payload = {
    source: server.url,
    serverId: SERVER_ID,
    capturedAt: new Date().toISOString(),
    protocolVersion: init?.protocolVersion,
    serverInfo: init?.serverInfo,
    toolCount: tools.length,
    calls: callCount,
    tools,
  };
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`probe 完成：${tools.length} 个工具 → ${path.relative(ROOT, FIXTURE_PATH)}`);
  console.log(`调用明细：${JSON.stringify(callCount)}（tools/call 必须为 0）`);
  console.log(`serverInfo=${JSON.stringify(init?.serverInfo)} protocol=${init?.protocolVersion}`);
}

/** ==================== 入口 ==================== */

const command = process.argv[2] || 'flow';
if (command === 'flow') {
  await flow();
} else if (command === 'probe') {
  await probe();
} else {
  console.error('用法：node scripts/mcp-box-dry-run.mjs [flow [--json] | probe]');
  process.exitCode = 2;
}
