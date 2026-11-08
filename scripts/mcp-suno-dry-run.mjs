#!/usr/bin/env node
/**
 * Suno MCP 干跑（dry-run）工具链——全程默认零额度消耗。
 *
 * 子命令：
 *   probe  只读探测：initialize + notifications/initialized + tools/list（分页），把工具 schema
 *          落盘到 tests/fixtures/suno-mcp-tools.json。**不调用 tools/call**。
 *   audit  离线审计：只读 fixture，扫描 format/output_format/audio_format/file_format/mime/extension
 *          等参数，输出参数名/取值/默认值/所在工具。
 *   flow   离线干跑：把 McpClient 的 fetchImpl 换成拦截层（不触网），走完整链路
 *          config → McpServerManager → 根工具 action 路由 → 参数默认值合并 → 子项 schema 校验
 *          → tools/call 请求体拦截 → 响应/错误映射，逐步输出可核对的结构化记录。
 *
 * 安全边界（为什么不会扣额度）：
 *   - 拦截层位于 McpClient 的 fetchImpl——HTTP 传输最底层，发生在任何 socket 写出之前；
 *   - flow 默认把 globalThis.fetch 替换成「抛错哨兵」，任何绕过拦截层的代码路径都会立即失败；
 *   - 只有 probe 子命令允许真实网络，且只发 initialize/tools/list（只读、不计费）；
 *     代码中不存在真实 tools/call 的调用路径。
 *
 * 用法：
 *   node scripts/mcp-suno-dry-run.mjs probe
 *   node scripts/mcp-suno-dry-run.mjs audit [--json]
 *   node scripts/mcp-suno-dry-run.mjs flow [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = sessionArg('--config', path.join(ROOT, '.runtime', 'config.json'));
const CREDENTIALS_PATH = sessionArg('--credentials', path.join(ROOT, '.runtime', 'mcp-credentials.json'));
const FIXTURE_PATH = sessionArg('--fixture', path.join(ROOT, 'tests', 'fixtures', 'suno-mcp-tools.json'));
const REPORT_PATH = path.join(ROOT, '.runtime', 'suno-mcp-dry-run-report.json');
const SERVER_ID = 'suno-official';
const ROOT_ID = `mcp.${SERVER_ID}`;

function sessionArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function loadServer() {
  const config = readJson(CONFIG_PATH);
  const server = (config.orchestration?.mcpServers || []).find((item) => item.id === SERVER_ID);
  if (!server) throw new Error(`config 中找不到 mcpServers[id=${SERVER_ID}]`);
  return { config, server };
}

/** ==================== probe：只读真实网络 ==================== */

async function probe() {
  const { server } = loadServer();
  const credentials = readJson(CREDENTIALS_PATH).credentials?.[SERVER_ID];
  if (!credentials?.accessToken) throw new Error('缺少 OAuth accessToken，请先在面板完成授权');
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

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'miobot', version: '2' },
  });
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

/** ==================== audit：离线扫描 schema ==================== */

const FORMAT_KEYWORDS = [
  'format', 'outputformat', 'audioformat', 'fileformat', 'mimetype', 'mime',
  'extension', 'codec', 'container', 'bitrate', 'samplerate',
];

function walkProperties(schema, prefix = '') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  const props = schema.properties;
  if (props && typeof props === 'object') {
    for (const [name, value] of Object.entries(props)) {
      if (value && typeof value === 'object') {
        out.push({ path: prefix ? `${prefix}.${name}` : name, node: value });
        out.push(...walkProperties(value, prefix ? `${prefix}.${name}` : name));
      }
    }
  }
  if (schema.items && typeof schema.items === 'object') out.push(...walkProperties(schema.items, `${prefix}[]`));
  if (Array.isArray(schema.anyOf)) for (const item of schema.anyOf) out.push(...walkProperties(item, prefix));
  if (Array.isArray(schema.oneOf)) for (const item of schema.oneOf) out.push(...walkProperties(item, prefix));
  return out;
}

function looksFormatRelated(name, node) {
  const normalized = String(name).toLowerCase().replace(/[_-]/g, '');
  if (FORMAT_KEYWORDS.some((keyword) => normalized.includes(keyword))) return true;
  const description = String(node?.description || '').toLowerCase();
  return /\b(mp3|wav|flac|aac|ogg|audio format|file format|mime)\b/.test(description);
}

function audit(fixture = readJson(FIXTURE_PATH)) {
  const findings = [];
  const toolIndex = [];
  for (const tool of fixture.tools || []) {
    const rows = walkProperties(tool.inputSchema);
    toolIndex.push({
      name: tool.name,
      description: (tool.description || '').slice(0, 110),
      required: tool.inputSchema?.required || [],
      propertyCount: Object.keys(tool.inputSchema?.properties || {}).length,
      annotations: tool.annotations || {},
      outputSchema: Boolean(tool.outputSchema),
    });
    for (const row of rows) {
      if (!looksFormatRelated(row.path.split('.').pop(), row.node)) continue;
      findings.push({
        tool: tool.name,
        path: row.path,
        type: row.node.type || (Array.isArray(row.node.enum) ? 'enum' : 'unknown'),
        enum: row.node.enum,
        default: row.node.default,
        description: row.node.description,
      });
    }
  }
  return { fixture, findings, toolIndex };
}

function printAudit(result) {
  const { fixture, findings, toolIndex } = result;
  console.log(`schema 来源：${fixture.source}｜抓取于 ${fixture.capturedAt}｜工具数 ${fixture.toolCount}`);
  console.log(`\n== 格式类参数命中（${findings.length}） ==`);
  if (!findings.length) console.log('未发现任何 format / output_format / audio_format / file_format / mime / extension 类参数。');
  for (const item of findings) {
    console.log(`- ${item.tool} :: ${item.path}｜type=${item.type}｜enum=${JSON.stringify(item.enum ?? null)}｜default=${JSON.stringify(item.default ?? null)}`);
    console.log(`    描述：${item.description || '（无）'}`);
  }
  console.log(`\n== 工具目录（${toolIndex.length}） ==`);
  for (const tool of toolIndex) {
    console.log(`- ${tool.name}｜参数 ${tool.propertyCount}｜必填 ${tool.required.join(', ') || '无'}｜annotations=${JSON.stringify(tool.annotations)}`);
    console.log(`    ${tool.description || '（无描述）'}`);
  }
}

/** ==================== flow：离线干跑完整链路 ==================== */

const LYRICS = [
  '[Intro]',
  '雨の粒が　窓辺でほどける',
  '古いレコードが　静かに回る',
  '',
  '[Verse 1]',
  '傘を忘れた　帰り道',
  '水たまりに　街の灯が揺れる',
  '君の声は　まだ遠いまま',
  '',
  '[Pre-Chorus]',
  '選ばなかった　言葉のかけら',
  'ポストカードに　書ききれずに',
  '',
  '[Chorus]',
  '雨上がりのレコード　針を落として',
  'もう一度だけ　夜を巻き戻して',
  '雨上がりのレコード　溝に残るのは',
  '君と僕の　小さなリフレイン',
  '',
  '[Verse 2]',
  '濡れたセーター　肩に掛けたまま',
  '窓の外には　名前のない朝',
  '',
  '[Bridge]',
  '再生ボタンは　壊れたままでも',
  '記憶は　まだ歌える',
  '',
  '[Outro]',
  '雨の粒が　窓辺でほどける',
  'レコードは　ゆっくり止まる',
].join('\n');

const ORIGINAL_TITLE = '雨上がりのレコード';
const REFERENCED_TITLE = '雨粒のポストカード';
export const SUNO_DRY_RUN_LYRICS = LYRICS;

export function createDryRunTransport({ tools, initializeStatus = 200, toolBehavior = {} }) {
  const ledger = [];
  const fetchImpl = async (url, init = {}) => {
    const bodyText = typeof init.body === 'string' ? init.body : '';
    let message = null;
    try { message = bodyText ? JSON.parse(bodyText) : null; } catch { message = null; }
    const method = String(message?.method || '');
    const entry = {
      seq: ledger.length + 1,
      method,
      network: false,
      url: String(url),
      body: bodyText,
      at: new Date().toISOString(),
    };
    if (method === 'tools/call') {
      entry.tool = String(message?.params?.name || '');
      entry.args = message?.params?.arguments || {};
      entry.nonReadOnly = toolsMap(tools).get(entry.tool)?.annotations?.readOnlyHint !== true;
    }
    ledger.push(entry);

    if (method === 'initialize') {
      if (initializeStatus !== 200) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: initializeStatus, headers: { 'content-type': 'application/json' } });
      return rpcResult(message?.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Suno (dry-run)', version: 'dry-run' },
      });
    }
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (method === 'tools/list') return rpcResult(message?.id, { tools });
    if (method === 'tools/call') {
      const name = entry.tool;
      const behavior = toolBehavior[name] || { kind: 'ok' };
      if (behavior.kind === 'hang') return new Promise(() => { /* 永不 resolve，由 client 超时兜底 */ });
      if (behavior.kind === 'http') return new Response(JSON.stringify({ error: 'http_error' }), { status: behavior.status, headers: { 'content-type': 'application/json' } });
      if (behavior.kind === 'jsonrpc-error') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message?.id, error: { code: behavior.code ?? -32603, message: behavior.message || 'upstream error' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (behavior.kind === 'isError') {
        return rpcResult(message?.id, { content: [{ type: 'text', text: behavior.text || 'upstream business error' }], isError: true });
      }
      if (behavior.kind === 'empty') return rpcResult(message?.id, { content: [], isError: false });
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

export function toolsMap(tools) {
  const map = new Map();
  for (const tool of tools) map.set(String(tool.name), tool);
  return map;
}

function rpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'dry-run-session' },
  });
}

async function loadRuntimeModules() {
  const managerModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'apps', 'bot', 'src', 'mcp-server-manager.js')).href);
  const clientModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'apps', 'bot', 'src', 'mcp-client.js')).href);
  return { McpServerManager: managerModule.McpServerManager, McpClient: clientModule.McpClient };
}

/**
 * 合成凭据存储：干跑默认使用，确保不读取真实凭据、不触发 token 续期（续期会真实出网）。
 * 显式 `useRealCredentials: true` 时才读取 `.runtime/mcp-credentials.json`（真实链路脚本用）。
 */
function createSyntheticCredentialStore(serverId) {
  const credentials = new Map(serverId ? [[serverId, { accessToken: 'dry-run-token' }]] : []);
  return {
    filePath: '(dry-run://synthetic-credentials)',
    get: (id) => credentials.get(String(id)),
    set: (id, credential) => credentials.set(String(id), credential),
    clear: (id) => credentials.delete(String(id)),
    getClient: () => undefined,
    setClient: () => undefined,
  };
}

export async function createDryRunHarness({ server, overrides = {}, transport, timeoutMs, credentialStore, useRealCredentials = false }) {
  const { McpServerManager, McpClient } = await loadRuntimeModules();
  const registry = new Map();
  let store = credentialStore;
  if (!store && server.auth === 'oauth') {
    if (useRealCredentials) {
      const storeModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'apps', 'bot', 'src', 'mcp-credential-store.js')).href);
      store = new storeModule.McpCredentialStore({ filePath: path.join(ROOT, '.runtime', 'mcp-credentials.json') });
    } else {
      store = createSyntheticCredentialStore(server.id);
    }
  }
  const manager = new McpServerManager({
    getConfig: () => ({ orchestration: { mcpServers: [server], capabilityOverrides: overrides } }),
    registerCapability: (descriptor, handler) => registry.set(descriptor.id, { descriptor, handler }),
    unregisterCapability: (capabilityId) => registry.delete(capabilityId),
    ...(store ? { credentialStore: store } : {}),
    createClient: (config, options) => new McpClient(config, { ...options, fetchImpl: transport.fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) }),
  });
  await manager.connect(server);
  const root = registry.get(ROOT_ID);
  const invoke = (args) => {
    if (!root) throw new Error('根能力未注册');
    return root.handler.execute({ plan: { planId: 'dry-plan' }, step: { id: 'dry-step', capability: ROOT_ID, args } });
  };
  return { manager, registry, root, invoke };
}

function tagLines(lyrics) {
  return lyrics.split('\n').map((line, index) => ({ index, line })).filter((item) => item.line.trim().startsWith('['));
}

function isTagOnlyLine(line) {
  return /^\[[^\[\]]+\]$/.test(line.trim());
}

function summarizeCaptured(entry) {
  if (!entry) return '（未捕获到 tools/call）';
  return JSON.stringify(entry.args, null, 2);
}

async function flow() {
  const fixture = readJson(FIXTURE_PATH);
  const { config, server } = loadServer();
  const baseOverrides = config.orchestration?.capabilityOverrides || {};
  const tools = fixture.tools || [];
  const toolByName = toolsMap(tools);
  const checks = [];
  const findings = [];
  const scenarios = [];
  let globalFetchHits = 0;
  const globalFetchHitUrls = [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    globalFetchHits += 1;
    globalFetchHitUrls.push(String(input));
    throw new Error(`dry_run_network_forbidden:${String(input)}`);
  };

  function check(name, ok, detail = '') {
    checks.push({ name, ok: Boolean(ok), detail });
    return Boolean(ok);
  }

  function finding(id, title, detail = '') {
    findings.push({ id, title, detail });
  }

  function recordScenario(id, ledger, extra = {}) {
    scenarios.push({ id, calls: ledger.filter((item) => item.method === 'tools/call'), control: ledger.filter((item) => item.method !== 'tools/call'), ...extra });
  }

  try {
    // ---- 0. 目录与根描述 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const descriptor = harness.root?.descriptor;
      check('根能力已注册', Boolean(harness.root), ROOT_ID);
      check('根工具默认语义：{action, params}', Boolean(descriptor?.inputSchema?.properties?.action && descriptor?.inputSchema?.properties?.params), '');
      check('action 为必填', Array.isArray(descriptor?.inputSchema?.required) && descriptor.inputSchema.required.includes('action'));
      check('根描述含 41 个子操作', String(descriptor?.description || '').includes(`${tools.length} 个子操作`));
      check('根描述注入歌词结构规范', String(descriptor?.description || '').includes('[Verse 1]') || String(descriptor?.description || '').includes('结构标记'));
      check('根描述暴露参数默认值', String(descriptor?.description || '').includes('参数默认') || String(descriptor?.description || '').includes('audio-create'));
      check('根描述长度 ≤ 800', String(descriptor?.description || '').length <= 800, `len=${String(descriptor?.description || '').length}`);
      check('根 enabled 来自覆盖配置', descriptor?.enabled === true, `enabled=${descriptor?.enabled}`);
      recordScenario('root-descriptor', transport.ledger, {
        descriptor: descriptor
          ? {
            id: descriptor.id,
            enabled: descriptor.enabled,
            riskLevel: descriptor.riskLevel,
            descriptionLength: descriptor.description.length,
            description: descriptor.description,
          }
          : null,
      });
      await harness.manager.close();
    }

    // ---- 1. list_actions 目录 vs 真实 schema ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const result = await harness.invoke({ action: 'list_actions' });
      const text = result.outputs?.[0]?.text || '';
      const lines = text.split('\n');
      const catalogNames = lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split('：')[0].replace(/（.*$/, '').trim());
      check('list_actions 成功', result.status === 'success');
      check('list_actions 覆盖全部工具（不再截断 40）', catalogNames.length === tools.length, `目录行=${catalogNames.length}，真实工具=${tools.length}`);
      const missing = tools.map((tool) => tool.name).filter((name) => !catalogNames.includes(name));
      check('目录不漏任何子项', missing.length === 0, missing.join(', ') || '全部可见');
      check('list_actions 展示 audio-download 默认格式', /format=mp3/.test(text), '行内含 format=mp3');
      check('目录行内展示 format 枚举 mp3|wav', /format:\s*mp3\|wav/.test(text), `命中：${(text.match(/format:\s*[^｜\n]+/) || [])[0] || '无'}`);
      check('目录行内展示 audio-create 条件必填', text.includes('任一必填：description 或 lyrics 或 instrumental=true 或 midi_upload_id'), '任一必填：description 或 lyrics 或 instrumental=true 或 midi_upload_id');
      check('目录可直接读出工具名与必填参数', lines.filter((item) => item.startsWith('- ')).length === catalogNames.length);
      const requiredMismatch = [];
      for (const line of lines.filter((item) => item.startsWith('- '))) {
        const name = line.slice(2).split('：')[0].replace(/（.*$/, '').trim();
        const tool = toolByName.get(name);
        if (!tool) continue;
        const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
        const marker = '必填参数：';
        const listed = line.includes(marker) ? line.split(marker)[1].split('｜')[0].split(', ').map((item) => item.trim()).filter(Boolean) : [];
        if (JSON.stringify(required) !== JSON.stringify(listed)) requiredMismatch.push(`${name} schema=[${required}] catalog=[${listed}]`);
      }
      check('目录必填参数与真实 schema 一致', requiredMismatch.length === 0, requiredMismatch.slice(0, 3).join('；'));
      check('目录含歌词规范提示', text.includes('结构标记'));
      recordScenario('catalog', transport.ledger, { catalogPreview: lines.slice(0, 6), catalogText: text, nameCount: catalogNames.length, missing });
      await harness.manager.close();
    }

    // ---- 2. 生成链路：默认模型注入 + lyrics 原样透传 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const result = await harness.invoke({ action: 'audio-create', params: { lyrics: LYRICS, style: 'city pop, rainy night, mellow', title: ORIGINAL_TITLE, duration: 120 } });
      const call = transport.ledger.find((item) => item.method === 'tools/call');
      check('生成链路成功（拦截层合成响应）', result.status === 'success', result.error || '');
      check('输出带子项前缀', String(result.outputs?.[0]?.text || '').startsWith(`[${ROOT_ID}/audio-create]`));
      check('模型默认值已注入 model=v6-mini', call?.args?.model === 'v6-mini', `实际 model=${String(call?.args?.model)}`);
      check('默认值来源被标注', JSON.stringify(result.diagnostics?.appliedParamDefaults?.default || []).includes('model'));
      check('lyrics 逐字节一致（无清洗/无拍平）', call?.args?.lyrics === LYRICS, `长度 ${String(call?.args?.lyrics || '').length}/${LYRICS.length}`);
      check('结构标记独占一行', tagLines(String(call?.args?.lyrics || '')).every((item) => isTagOnlyLine(item.line)), JSON.stringify(tagLines(String(call?.args?.lyrics || '')).filter((item) => !isTagOnlyLine(item.line))));
      check('换行数保留', String(call?.args?.lyrics || '').split('\n').length === LYRICS.split('\n').length);
      check('歌词结构标记数量完整', tagLines(LYRICS).length === tagLines(String(call?.args?.lyrics || '')).length, `${tagLines(LYRICS).length}`);
      check('歌名与风格字段原样到达上游', call?.args?.title === ORIGINAL_TITLE && call?.args?.style === 'city pop, rainy night, mellow');
      check('生成类调用被拦截（未出网）', call?.network === false && transport.ledger.every((item) => item.network === false));
      recordScenario('generate-default-model', transport.ledger, { requestBody: call?.body, parsedArgs: call?.args, rootResult: { status: result.status, error: result.error, diagnostics: result.diagnostics } });
      await harness.manager.close();
    }

    // ---- 3. 显式 model 覆盖默认值 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const result = await harness.invoke({ action: 'audio-create', params: { lyrics: LYRICS, title: ORIGINAL_TITLE, model: 'v6' } });
      const call = transport.ledger.find((item) => item.method === 'tools/call');
      check('显式 model 覆盖默认值', call?.args?.model === 'v6', `实际 model=${String(call?.args?.model)}`);
      check('显式覆盖时不标注默认值来源', !JSON.stringify(result.diagnostics?.appliedParamDefaults?.default || []).includes('model'));
      recordScenario('generate-explicit-model', transport.ledger, { parsedArgs: call?.args });
      await harness.manager.close();
    }

    // ---- 4. 锁定模型（子项级 locked=true）----
    {
      const lockedServer = { ...server, childParamDefaults: { ...(server.childParamDefaults || {}), 'audio-create': { model: { value: 'v6-mini', locked: true } } } };
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server: lockedServer, overrides: baseOverrides, transport });
      const result = await harness.invoke({ action: 'audio-create', params: { lyrics: LYRICS, model: 'v6' } });
      const call = transport.ledger.find((item) => item.method === 'tools/call');
      check('锁定值强制覆盖模型显式传值', call?.args?.model === 'v6-mini', `实际 model=${String(call?.args?.model)}`);
      check('锁定来源被标注', JSON.stringify(result.diagnostics?.appliedParamDefaults?.locked || []).includes('model'));
      recordScenario('generate-locked-model', transport.ledger, { parsedArgs: call?.args });
      await harness.manager.close();
    }

    // ---- 5. 生成时传格式参数 → schema 拒绝 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const result = await harness.invoke({ action: 'audio-create', params: { lyrics: LYRICS, output_format: 'wav' } });
      check('生成工具不接受 output_format', result.status === 'failed' && String(result.error || '').includes('mcp_action_params_invalid'));
      check('错误定位到额外参数路径', String(result.error || '').includes('$.params.output_format'));
      check('被拒绝的请求未触达 tools/call', transport.ledger.filter((item) => item.method === 'tools/call').length === 0);
      const both = await harness.invoke({ action: 'audio-create', params: { lyrics: LYRICS, duration: 999 } });
      check('数值越界被 schema 拒绝', both.status === 'failed' && String(both.error || '').includes('$.params.duration') && String(both.error || '').includes('不能大于 360'), String(both.error || ''));
      const emptyParams = await harness.invoke({ action: 'audio-create', params: {} });
      check('空 params 被本地条件必填拒绝', emptyParams.status === 'failed' && String(emptyParams.error || '').includes('需满足任一条件'), String(emptyParams.error || ''));
      check('空 params 未触达 tools/call', transport.ledger.filter((item) => item.method === 'tools/call').length === 0);
      recordScenario('schema-reject-format', transport.ledger, { error: result.error, outOfRangeError: both.error, emptyParamsError: emptyParams.error || null });
      await harness.manager.close();
    }

    // ---- 6. 下载格式：默认值 + 显式覆盖 + 非法枚举 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const defaultCall = await harness.invoke({ action: 'audio-download', params: { id: 'clip-dry-1' } });
      const defaultEntry = transport.ledger.find((item) => item.method === 'tools/call');
      check('audio-download 默认格式已注入', defaultEntry?.args?.format === 'mp3', `实际 format=${String(defaultEntry?.args?.format)}（期望来自 childParamDefaults）`);
      check('默认格式来源被标注', JSON.stringify(defaultCall.diagnostics?.appliedParamDefaults?.default || []).includes('format'));
      const wavCall = await harness.invoke({ action: 'audio-download', params: { id: 'clip-dry-1', format: 'wav' } });
      const wavEntry = transport.ledger.filter((item) => item.method === 'tools/call')[1];
      check('显式 format=wav 覆盖默认 mp3', wavEntry?.args?.format === 'wav');
      const badCall = await harness.invoke({ action: 'audio-download', params: { id: 'clip-dry-1', format: 'flac' } });
      check('非法格式被 schema 拒绝', badCall.status === 'failed' && String(badCall.error || '').includes('必须是 mp3, wav 之一'));
      check('下载（可能耗下载额度）也被拦截', transport.ledger.filter((item) => item.method === 'tools/call').every((item) => item.network === false));
      recordScenario('download-format', transport.ledger, { wavArgs: wavEntry?.args, invalidError: badCall.error });
      await harness.manager.close();
    }

    // ---- 7. 未知 action / 停用子项 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const unknown = await harness.invoke({ action: 'audio-created', params: {} });
      check('未知 action 报可读错误', unknown.status === 'failed' && String(unknown.error || '').includes('mcp_unknown_action'));
      check('未知 action 给出近似建议', String(unknown.error || '').includes('audio-create'));
      const disabledOverrides = { ...baseOverrides, [`${ROOT_ID}.audio-create`]: { enabled: false } };
      const disabledHarness = await createDryRunHarness({ server, overrides: disabledOverrides, transport });
      const disabled = await disabledHarness.invoke({ action: 'audio-create', params: { lyrics: LYRICS } });
      check('停用子项被门禁拒绝', disabled.status === 'failed' && String(disabled.error || '').includes('mcp_action_disabled'));
      check('停用子项未发出 tools/call', transport.ledger.filter((item) => item.method === 'tools/call').length === 0);
      recordScenario('routing-and-gating', transport.ledger, { unknownError: unknown.error, disabledError: disabled.error });
      await harness.manager.close();
      await disabledHarness.manager.close();
    }

    // ---- 8. 上游业务错误 / JSON-RPC 错误 / HTTP 错误 / 限流 / 超时 ----
    {
      const cases = [
        { id: 'isError', behavior: { kind: 'isError', text: 'insufficient_credits: monthly 100 credits exhausted' }, expect: 'mcp_tool_error:audio-create' },
        { id: 'jsonrpc-error', behavior: { kind: 'jsonrpc-error', message: 'forbidden: model not on plan' }, expect: 'mcp_error:forbidden' },
        { id: 'http-403', behavior: { kind: 'http', status: 403 }, expect: 'mcp_http_403' },
        { id: 'http-429', behavior: { kind: 'http', status: 429 }, expect: 'mcp_http_429' },
      ];
      for (const item of cases) {
        const transport = createDryRunTransport({ tools, toolBehavior: { 'audio-create': item.behavior } });
        const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
        const result = await harness.invoke({ action: 'audio-create', params: { lyrics: LYRICS } });
        check(`${item.id} 错误可诊断`, result.status === 'failed' && String(result.error || '').includes(item.expect), String(result.error || ''));
        recordScenario(item.id, transport.ledger, { error: result.error, retryable: result.retryable });
        await harness.manager.close();
      }
      // 超时：client 超时下限 5s
      const transport = createDryRunTransport({ tools, toolBehavior: { 'audio-create': { kind: 'hang' } } });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport, timeoutMs: 5000 });
      const startedAt = Date.now();
      const result = await harness.invoke({ action: 'audio-create', params: { lyrics: LYRICS } });
      const elapsed = Date.now() - startedAt;
      check('超时得到明确错误', result.status === 'failed' && String(result.error || '').includes('mcp_tools/call_timeout'), String(result.error || ''));
      check('超时在配置时限内返回', elapsed >= 4800 && elapsed < 9000, `${elapsed}ms`);
      recordScenario('timeout', transport.ledger, { error: result.error, elapsedMs: elapsed });
      await harness.manager.close();
      // 空输出
      const emptyTransport = createDryRunTransport({ tools, toolBehavior: { 'audio-create': { kind: 'empty' } } });
      const emptyHarness = await createDryRunHarness({ server, overrides: baseOverrides, transport: emptyTransport });
      const empty = await emptyHarness.invoke({ action: 'audio-create', params: { lyrics: LYRICS } });
      check('空输出可诊断且可重试', empty.status === 'failed' && String(empty.error || '').includes('mcp_tool_empty_output') && empty.retryable === true, String(empty.error || ''));
      recordScenario('empty-output', emptyTransport.ledger, { error: empty.error, retryable: empty.retryable });
      await emptyHarness.manager.close();
    }

    // ---- 9. 授权/权限拒绝时模型看到什么 ----
    {
      const transport = createDryRunTransport({ tools, initializeStatus: 401 });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const status = harness.manager.statusOf(SERVER_ID);
      check('401 时进入 needs-auth', status?.state === 'needs-auth', JSON.stringify(status));
      check('401 时根能力未注册', harness.registry.size === 0, `registry=${harness.registry.size}`);
      recordScenario('connect-401', transport.ledger, { status, registrySize: harness.registry.size });
      await harness.manager.close();

      const disabledRoot = await createDryRunHarness({ server, overrides: { ...baseOverrides, [ROOT_ID]: { enabled: false } }, transport: createDryRunTransport({ tools }) });
      check('根能力停用时 descriptor.enabled=false（不会进 loadout）', disabledRoot.root?.descriptor?.enabled === false);
      recordScenario('root-disabled', [], { enabled: disabledRoot.root?.descriptor?.enabled });
      await disabledRoot.manager.close();
    }

    // ---- 10. 并发隔离 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const payloads = Array.from({ length: 6 }, (_, index) => LYRICS.replace('[Intro]', `[Intro]\n（并发测试 ${index + 1}）`));
      const results = await Promise.all(payloads.map((lyrics, index) => harness.invoke({ action: 'audio-create', params: { lyrics, title: `并发测试曲目 ${index + 1}` } })));
      const calls = transport.ledger.filter((item) => item.method === 'tools/call');
      check('并发调用全部成功进入拦截层', results.every((item) => item.status === 'success'));
      check('并发请求数一致', calls.length === payloads.length, `${calls.length}/${payloads.length}`);
      check('并发参数无串扰', calls.every((call, index) => call.args.lyrics === payloads[index] && call.args.model === 'v6-mini'));
      check('并发全程零出网', transport.ledger.every((item) => item.network === false));
      recordScenario('concurrency', transport.ledger, { callCount: calls.length });
      await harness.manager.close();
    }

    // ---- 11. 透传但无修复：不独占一行的标记 / 沿用原歌名 ----
    {
      const transport = createDryRunTransport({ tools });
      const harness = await createDryRunHarness({ server, overrides: baseOverrides, transport });
      const glued = LYRICS.replace('[Chorus]\n', '[Chorus]');
      const gluedResult = await harness.invoke({ action: 'audio-create', params: { lyrics: glued, title: REFERENCED_TITLE } });
      const call = transport.ledger.find((item) => item.method === 'tools/call');
      check('MCP 链路不改写歌词（无清洗层，原样透传）', call?.args?.lyrics === glued);
      check('标记粘连不会被修复（缺口：依赖生成端自检）', !tagLines(glued).every((item) => isTagOnlyLine(item.line)), '标记与正文同行');
      check('沿用已有歌名不会被纠正（缺口：仅提示词约束）', call?.args?.title === REFERENCED_TITLE);
      check('透传场景仍零出网', call?.network === false);
      {
        const descriptorText = String(harness.root?.descriptor?.description || '');
        check('根描述含人设隔离规则', descriptorText.includes('人设隔离'), '复用 suno-lyrics-spec 共享常量');
        check('根描述含审核规避规则', descriptorText.includes('规避内容审核'), '复用 suno-lyrics-spec 共享常量');
        check('根描述仍在 800 字符内', descriptorText.length <= 800, `当前 ${descriptorText.length}`);
      }
      recordScenario('passthrough-gaps', transport.ledger, { parsedArgs: { title: call?.args?.title, lyricsHead: String(call?.args?.lyrics || '').slice(0, 60) } });
      await harness.manager.close();
    }

    // ---- 12. 效果/风险分类自查（读取 fixture annotations + 现有推断规则）----
    {
      const SPEND_TOOLS = ['audio-create', 'audio-covers-create', 'audio-extensions-create', 'audio-mashups-create', 'audio-download', 'sounds-create', 'speech-create', 'audio-midi', 'audio-stems-create'];
      const rootToolModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'apps', 'bot', 'src', 'mcp-root-tool.js')).href);
      const children = rootToolModule.buildMcpChildTools(SERVER_ID, tools, {});
      const misclassified = [];
      const spendDetails = [];
      const readonlyMisclassified = [];
      for (const tool of tools) {
        const child = children.find((item) => item.name === tool.name);
        if (!child) continue;
        if (tool.annotations?.readOnlyHint === false && child.riskLevel !== 'high') {
          readonlyMisclassified.push(`${tool.name}→risk=${child.riskLevel}`);
        }
        if (!SPEND_TOOLS.includes(child.name)) continue;
        spendDetails.push(`${child.name}(effect=${child.effect},risk=${child.riskLevel},enabled=${child.enabled})`);
        if (child.effect === 'retrieve' || child.riskLevel === 'low') misclassified.push(`${child.name}→effect=${child.effect}/risk=${child.riskLevel}`);
      }
      check('annotations 校正后计费类不再判 retrieve/low', misclassified.length === 0, misclassified.join('；'));
      check('所有 readOnlyHint=false 子项均为高风险', readonlyMisclassified.length === 0, readonlyMisclassified.join('；'));
      check('计费/生成类子项已识别', spendDetails.length === SPEND_TOOLS.length, `识别 ${spendDetails.length}/${SPEND_TOOLS.length}`);
      const unknownCount = tools.filter((tool) => !tool.description).length;
      check('41 个工具均有可读描述', unknownCount === 0);
      const dupes = tools.length - new Set(tools.map((tool) => tool.name)).size;
      check('工具名唯一', dupes === 0);
      recordScenario('classification', [], { misclassified, spendDetails });
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  const zeroNetwork = globalFetchHits === 0 && scenarios.every((scenario) => [...scenario.calls, ...scenario.control].every((item) => item.network === false));
  check('全流程零真实出网（globalThis.fetch 哨兵未被触发）', zeroNetwork, `sentinel hits=${globalFetchHits}${globalFetchHitUrls.length ? `｜${globalFetchHitUrls.slice(0, 3).join(' , ')}` : ''}`);

  const failed = checks.filter((item) => !item.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    fixture: { capturedAt: fixture.capturedAt, toolCount: fixture.toolCount, source: fixture.source },
    network: { realFetchCalls: globalFetchHits, realFetchUrls: globalFetchHitUrls.slice(), ledgerNetworkTrue: scenarios.reduce((sum, scenario) => sum + scenario.calls.filter((item) => item.network).length, 0) },
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, findings: findings.length },
    checks,
    findings,
    scenarios,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printFlowReport(report);
  }
  if (failed.length) process.exitCode = 1;
}

function printFlowReport(report) {
  console.log(`Suno MCP 干跑报告｜fixture ${report.fixture.toolCount} 工具（${report.fixture.capturedAt}）`);
  console.log(`真实网络调用：${report.network.realFetchCalls} 次｜拦截层标记 network=true：${report.network.ledgerNetworkTrue} 次`);
  console.log(`检查项：${report.summary.passed}/${report.summary.checks} 通过｜发现项：${report.summary.findings}\n`);
  for (const check of report.checks) {
    console.log(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.name}${check.detail ? `｜${check.detail}` : ''}`);
  }
  if (report.findings.length) {
    console.log('\n== 发现项（需要产品/配置决策） ==');
    for (const item of report.findings) {
      console.log(`- [${item.id}] ${item.title}`);
      console.log(`    ${item.detail}`);
    }
  }
  console.log(`\n明细已写入 ${path.relative(ROOT, REPORT_PATH)}（含每个子项的完整请求体与响应）`);
  const generate = report.scenarios.find((item) => item.id === 'generate-default-model');
  if (generate?.parsedArgs) {
    console.log('\n== 最终 tools/call 请求体（audio-create）==');
    console.log(`model=${generate.parsedArgs.model}｜title=${generate.parsedArgs.title}｜duration=${generate.parsedArgs.duration}`);
    console.log('lyrics:');
    for (const line of String(generate.parsedArgs.lyrics).split('\n')) console.log(`  │ ${line}`);
  }
}

/** ==================== 入口 ==================== */

const command = process.argv[2] || 'help';
const wantsJson = process.argv.includes('--json');

const isMainModule = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMainModule) {
  try {
    if (command === 'probe') {
      await probe();
    } else if (command === 'audit') {
      const result = audit();
      if (wantsJson) console.log(JSON.stringify({ findings: result.findings, toolIndex: result.toolIndex }, null, 2));
      else printAudit(result);
    } else if (command === 'flow') {
      await flow();
    } else {
      console.log('用法：node scripts/mcp-suno-dry-run.mjs <probe|audit|flow> [--json]');
      console.log('  probe  真实网络，只做 initialize + tools/list（零额度）');
      console.log('  audit  离线扫描已落盘 schema 的格式类参数');
      console.log('  flow   离线干跑完整链路（默认零网络）');
      process.exitCode = command === 'help' ? 0 : 1;
    }
  } catch (error) {
    console.error(`[mcp-suno-dry-run] ${command} 失败：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
