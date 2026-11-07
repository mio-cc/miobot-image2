#!/usr/bin/env node
// 能力可用性实测（真实模型回合，2026-11-07）：
// 用真实 LLM 回合验证「能力是给模型调用的」这条链路——发现（loadout/capability.catalog）、
// 调用（参数构造/根工具 action 路由/结果回传）、拦截（权限 deny/审批/暴露级/预算淘汰）、
// 失败（未知 action/缺参/断连）四层的实际行为，全部采集真实证据（模型请求工具清单、
// 工具调用与结果、最终回复），不写 mock 断言。
//
// 隔离（生产零改动）：
// - 配置：读 .runtime/config.json → 副本深拷贝 → 内存修改（每场景另存 config-<场景>.json 留档）；
// - 数据：mcp-credentials/mcp-status/memory 全部指向 .runtime/capability-usability-<ts>/；
// - MCP 服务器：仓库自带 tests/fixtures/mcp-echo-server.mjs 以真实 stdio 子进程运行（真实 JSON-RPC 往返）。
//
// 用法：node scripts/capability-usability-live.mjs [--only=mcp|builtin|budget] [--no-song] [--skip-seed]
// 真实副作用（如实入账）：LLM 调用（deepseek-flash）、记忆 embedding 调用、SunoAPI 生成 1 首歌（--no-song 跳过）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { toModelNodes } from '../dist/apps/bot/src/config-bridge.js';
import { createBotApp } from '../dist/apps/bot/src/app.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { McpServerManager } from '../dist/apps/bot/src/mcp-server-manager.js';
import { McpCredentialStore } from '../dist/apps/bot/src/mcp-credential-store.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { createCapabilityToolBinding, inferCapabilityToolExposure } from '../dist/apps/bot/src/capability-tool-adapter.js';
import { filterCatalogDescriptors } from '../dist/apps/bot/src/capability-basic.js';
import { RuntimeAdapterCapabilityHandler } from '../dist/apps/bot/src/capability-runtime-adapters.js';
import { ChatMemoryService } from '../dist/apps/bot/src/memory-service.js';
import { createMemorySearchHandler } from '../dist/apps/bot/src/memory-search-handler.js';
import { isOwner } from '../dist/apps/bot/src/owner.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { resolveToolLoadout, inferExposure } from '../dist/packages/tool-runtime/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only='))?.split('=')[1] || 'all').split(',').map((s) => s.trim()).filter(Boolean);
const runSong = !args.includes('--no-song');
const doSeed = !args.includes('--skip-seed');
const TEST_USER = '10001';
const TEST_ADMIN = '10000';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const testRoot = path.join(root, '.runtime', `capability-usability-${stamp}`);
fs.mkdirSync(testRoot, { recursive: true });

const rawConfig = JSON.parse(fs.readFileSync(path.join(root, '.runtime', 'config.json'), 'utf8'));
const baseCfg = normalizeConfig(structuredClone(rawConfig.config || rawConfig));
// ── 副本基础调整（只作用于副本；生产文件不动）──
baseCfg.agent.enabled = true;
baseCfg.agent.mode = 'enforce';
baseCfg.agent.mainModel = String(baseCfg.llm.chatModel || '');
baseCfg.agent.mainNodeIndex = Number(baseCfg.llm.chatNodeIndex || 0);
baseCfg.agent.turnTimeoutMs = Math.max(Number(baseCfg.agent.turnTimeoutMs || 0), 600_000);
baseCfg.toolRegistry.enabled = true;
baseCfg.orchestration.memory = { ...baseCfg.orchestration.memory, enabled: true, dataDir: path.join(testRoot, 'memory') };
baseCfg.bot.botQqId = String(baseCfg.bot.botQqId || '') || 'harness-bot';
baseCfg.replyPolicy = { ...baseCfg.replyPolicy, defaultVoice: 'off' };
const ECHO_SERVER = () => ({ id: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [path.join(root, 'tests', 'fixtures', 'mcp-echo-server.mjs')] });

const evidence = {
  meta: {
    startedAt: new Date().toISOString(), testRoot, only, runSong,
    chatModel: baseCfg.llm.chatModel, chatNodeIndex: baseCfg.llm.chatNodeIndex,
    productionToolSearchEnabled: JSON.parse(JSON.stringify(rawConfig.config || rawConfig)).toolRegistry?.toolSearchEnabled,
    productionMaxToolsPerTurn: JSON.parse(JSON.stringify(rawConfig.config || rawConfig)).toolRegistry?.maxToolsPerTurn,
    permissions: { ...baseCfg.orchestration.permissions },
    sunoOfficialMcp: 'blocked_pending_user_oauth_authorization',
  },
  sideEffects: { modelCalls: 0, embeddingCalls: 0, songsCreated: [], approvalsProposed: 0 },
  scenarios: [],
};
const log = (msg, data) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);

let currentCfg = baseCfg;
const getConfig = () => currentCfg;
const silentLogger = { info() {}, warn() {}, error() {} };

const realClient = createModelClient({ nodes: () => toModelNodes(currentCfg) });
const app = createBotApp({ getConfig, client: realClient });

// ── memory（隔离 rootDir；embedding 走真实节点）──
const memoryService = new ChatMemoryService({ rootDir: () => currentCfg.orchestration.memory.dataDir, getConfig, logger: silentLogger });

// ── capability.catalog handler（复刻 start.ts:1004-1058 装配逻辑；mcpSearchIndex 指向当前场景 manager）──
const mcpRef = { manager: null };
const orchestrationHandlers = new Map();
orchestrationHandlers.set('capability.catalog', new RuntimeAdapterCapabilityHandler(async (invocation) => {
  const args2 = (invocation.step.args || {});
  const keyword = String(args2.keyword || '').trim().toLowerCase();
  const category = String(args2.category || '').trim();
  const CATEGORY_PATTERNS = [['生成', /^(image|video|audio|code|report)/], ['解析', /^(file|memory|ocr|interrogate)/], ['信息', /^(web|search|render|browser)/], ['输入', /^(session|reply|tts)/]];
  const categoryOf = (key) => CATEGORY_PATTERNS.find(([, re]) => re.test(key))?.[0] || '其他';
  const allCapabilities = enforcer.listCapabilities();
  const isOwnerContext = isOwner(invocation.request.user.qq, getConfig().bot.ownerQQs);
  let descriptors = filterCatalogDescriptors(allCapabilities, {
    hasHandler: (id) => Boolean(enforcer.getCapabilityHandler(id)),
    isHiddenFromModel: (id) => {
      const descriptor = allCapabilities.find((item) => item.id === id);
      const configuredExposure = getConfig().toolRegistry?.exposure?.[id];
      const exposure = inferCapabilityToolExposure(descriptor || ({ id }), configuredExposure)
        ?? inferExposure(id, descriptor?.enabled !== false, (descriptor?.riskLevel) || 'low');
      if (exposure === 'hidden') return true;
      return exposure === 'searchable' && getConfig().toolRegistry?.toolSearchEnabled !== true;
    },
    isOwnerContext,
  });
  if (category) descriptors = descriptors.filter((d) => categoryOf(String(d.id)) === category);
  if (keyword) descriptors = descriptors.filter((d) => `${d.id} ${d.name} ${d.description || ''}`.toLowerCase().includes(keyword));
  const mcpLines = keyword
    ? (mcpRef.manager?.searchIndex() || [])
      .filter((entry) => `${entry.rootId} ${entry.childName} ${entry.displayName || ''} ${entry.summary}`.toLowerCase().includes(keyword))
      .slice(0, 10)
      .map((entry) => `- ${entry.rootId} → ${entry.childName}${entry.displayName ? `（${entry.displayName}）` : ''}：${entry.summary}｜调用 ${entry.rootId} 并传 action=${entry.childName}`)
    : [];
  const lines = descriptors.slice(0, 40).map((d) => {
    const enabled = getConfig().orchestration.capabilityOverrides?.[d.id]?.enabled !== false;
    return `- ${d.id}（${d.name}）：${String(d.description || '').slice(0, 80)}${enabled ? '' : '［已停用］'}`;
  });
  const text = lines.length || mcpLines.length
    ? `可用能力目录（${descriptors.length} 项${mcpLines.length ? `，另含 ${mcpLines.length} 个 MCP 子操作` : ''}）：\n${[...lines, ...mcpLines].join('\n')}`
    : '没有匹配的能力。';
  return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: [{ kind: 'text', text, priority: 10, mergeable: true }] };
}));
orchestrationHandlers.set('memory.search', createMemorySearchHandler({ memoryService, getConfig }));

const enforcer = new OrchestrationEnforcer({ getConfig, app, client: realClient, logger: silentLogger, handlers: orchestrationHandlers });

// ── 场景执行器 ──
async function runScenario(sc) {
  log(`▶ ${sc.id}: ${sc.prompt}`);
  const cfg = structuredClone(baseCfg);
  sc.prepare?.(cfg);
  fs.writeFileSync(path.join(testRoot, `config-${sc.id}.json`), JSON.stringify(cfg, null, 2));
  currentCfg = cfg;
  enforcer.refreshConfig(cfg);

  let manager = null;
  if (cfg.orchestration.mcpServers?.length) {
    manager = new McpServerManager({
      getConfig,
      registerCapability: (d, h) => enforcer.registerCapability(d, h),
      unregisterCapability: (id) => enforcer.unregisterCapability(id),
      logger: silentLogger,
      credentialStore: new McpCredentialStore({ filePath: path.join(testRoot, 'mcp-credentials.json'), logger: silentLogger }),
      statusFilePath: path.join(testRoot, 'mcp-status.json'),
    });
    mcpRef.manager = manager;
    await manager.reload();
    if (sc.afterConnect) await sc.afterConnect(manager);
  }

  const approvalRuntime = new ApprovalRuntime({
    adminQqIds: () => [TEST_ADMIN, '10086'], ownerQqIds: () => [TEST_ADMIN, '10086'], allowGroupReply: () => false,
    sendPrivate: async () => ({ success: true, messageId: 'harness-noop' }),
    logger: silentLogger,
  });
  const preflight = createAgentToolPreflight({ getConfig, approvalRuntime, resolveRole: () => 'user', approvalMode: 'suspend' });

  const toolExec = [];
  const toolBindings = () => {
    if (!cfg.toolRegistry.enabled) return [];
    return enforcer.listCapabilities().flatMap((descriptor) => {
      const handler = enforcer.getCapabilityHandler(descriptor.id);
      if (!handler) return [];
      const configuredExposure = cfg.toolRegistry?.exposure?.[descriptor.id];
      if (descriptor.id === 'tts.speak' && !configuredExposure) return [];
      const inferredExposure = inferCapabilityToolExposure(descriptor, configuredExposure);
      const binding = createCapabilityToolBinding(descriptor, handler, {
        ...(inferredExposure ? { exposure: inferredExposure } : {}),
        ...(!descriptor.timeoutMs ? { timeoutMs: Math.max(1000, cfg.toolRegistry.defaultTimeoutMs) } : {}),
      });
      const original = binding.handler;
      binding.handler = async (call, spec, context) => {
        const startedAt = Date.now();
        const result = await original(call, spec, context);
        toolExec.push({
          tool: call.name, args: call.arguments, ok: result.ok,
          content: String(result.content || '').slice(0, 500),
          error: result.error ? { code: result.error.code, message: String(result.error.message || '').slice(0, 300) } : undefined,
          jobId: result.jobId, durationMs: Date.now() - startedAt,
          diagnostics: result.meta?.diagnostics,
        });
        return result;
      };
      return [binding];
    });
  };

  const modelCalls = [];
  const modelResponses = [];
  const recClient = {
    chat: async (nodeIndex, req) => {
      const tools = req.toolSpecs || [];
      modelCalls.push({ nodeIndex, model: req.model, toolNames: tools.map((t) => t.name), toolCount: tools.length, messageCount: req.messages?.length });
      evidence.sideEffects.modelCalls += 1;
      const res = await realClient.chat(nodeIndex, req);
      modelResponses.push({
        text: String(res.text || '').slice(0, 500),
        toolCalls: (res.toolCalls || []).map((c) => ({ name: c.name, arguments: c.arguments })),
      });
      return res;
    },
  };

  const host = createAgentHost({
    getConfig, client: recClient, logger: silentLogger,
    sessions: new InMemoryAgentSessionManager(),
    toolBindings,
    preflightToolCall: preflight,
    resolveApproval: (record) => {
      const broker = approvalRuntime.getBroker();
      broker.expire();
      const approval = broker.get(record.approvalId);
      return approval ? { approvalId: approval.approvalId, status: approval.status, payloadHash: approval.payloadHash } : { approvalId: record.approvalId, status: 'expired' };
    },
    isMigratedTool: () => true,
    isReadOnlyTool: (name) => {
      const binding = toolBindings().find((b) => b.spec.name === name);
      return !(binding?.spec.sideEffects?.length);
    },
  });

  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await host({ text: sc.prompt, chatType: 'private', userId: sc.userId || TEST_USER, userRole: sc.userRole || 'user' });
  } catch (error) {
    outcome = { status: 'thrown', handled: false, problem: { kind: 'harness', error: String(error?.message || error) } };
  }
  const brokerPending = approvalRuntime.getBroker().list('pending').map((a) => ({ approvalId: a.approvalId, capability: a.capability }));
  evidence.sideEffects.approvalsProposed += brokerPending.length;

  const specs = toolBindings().map((b) => b.spec);
  const loadout = resolveToolLoadout(specs, {
    exposures: cfg.toolRegistry.toolSearchEnabled ? ['core', 'domain', 'searchable'] : ['core', 'domain'],
    maxTools: cfg.toolRegistry.maxToolsPerTurn, maxSchemaBytes: cfg.toolRegistry.maxToolSchemaBytes,
  });

  const record = {
    id: sc.id, title: sc.title, layer: sc.layer, prompt: sc.prompt,
    configNotes: sc.notes || [],
    status: outcome.status, handled: outcome.handled, reason: outcome.reason,
    finalText: String(outcome.text || '').slice(0, 800),
    replyPlanKinds: outcome.replyPlan?.outputs?.map((o) => `${o.kind}${o.url ? '(url)' : ''}`) || [],
    pendingApproval: outcome.turn?.pendingApproval ? { approvalId: outcome.turn.pendingApproval.approvalId, toolName: outcome.turn.pendingApproval.toolName } : undefined,
    brokerPending,
    problem: outcome.problem,
    modelCalls, modelResponses, toolExec,
    loadout: { tools: loadout.tools.map((t) => t.name), omitted: loadout.omitted, schemaBytes: loadout.schemaBytes },
    durationMs: Date.now() - startedAt,
  };
  evidence.scenarios.push(record);
  log(`  = status=${record.status} tools_called=[${toolExec.map((t) => t.tool).join(',') || '-'}] text="${String(record.finalText || '').slice(0, 80)}"`);
  if (manager) await manager.close().catch(() => {});
  return record;
}

// ── 记忆种子（真实 embedding 调用入账）──
async function seedMemory() {
  const seeds = [
    { role: 'user', text: '对了跟你说，我最喜欢的颜色是青色。', messageId: 'seed-1' },
    { role: 'assistant', text: '记住了！你喜欢青色，之后推荐配色我会优先考虑。', messageId: 'seed-2' },
    { role: 'user', text: '我养了一只猫，名字叫团子，两岁。', messageId: 'seed-3' },
  ];
  for (const s of seeds) {
    const r = await memoryService.ingest({ botId: baseCfg.bot.botQqId, chatType: 'private', userId: TEST_USER, role: s.role, text: s.text, messageId: s.messageId });
    evidence.sideEffects.embeddingCalls += 1;
    if (!r.ok) log(`  记忆种子失败: ${s.messageId} ${r.error}`);
  }
  log(`记忆种子完成（${seeds.length} 条 → ${baseCfg.orchestration.memory.dataDir}）`);
}

// ── 场景清单 ──
const rootOn = (cfg, extra = {}) => { cfg.orchestration.capabilityOverrides = { ...cfg.orchestration.capabilityOverrides, 'mcp.echo': { name: 'Echo 回声', ...extra } }; };
const searchOn = (cfg) => { cfg.toolRegistry.toolSearchEnabled = true; };
const withEcho = (cfg) => { cfg.orchestration.mcpServers = [ECHO_SERVER()]; };

const SCENARIOS = [
  // ── 发现层 ──
  { id: 'mcp-invisible-search-off', layer: '发现', title: '生产默认（检索关闭）下 MCP 可见性', prompt: '你能用回声工具帮我做个测试吗？把「可见性测试」原样返回', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); }, notes: ['toolSearchEnabled=false（生产默认）', 'MCP 根默认 searchable'] },
  { id: 'mcp-discovery-search-on', layer: '发现', title: '检索开启后模型对 MCP 根的感知', prompt: '你现在有哪些和「回声」相关的能力？', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); }, notes: ['toolSearchEnabled=true'] },
  { id: 'mcp-catalog-search', layer: '发现', title: 'capability.catalog 关键词检索与 MCP 子项指引', prompt: '帮我查一下能力目录，搜索关键词「回声」，把查到的结果告诉我', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); } },
  // ── 调用层 ──
  { id: 'mcp-invoke', layer: '调用', title: '根工具 {action, params} 路由与结果回传', prompt: '用回声工具把「能力可用性实测」这句话原样返回给我', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); } },
  // ── 失败层 ──
  { id: 'mcp-unknown-action', layer: '失败', title: '不存在 的 action 的错误与自我纠正', prompt: '用回声工具执行一个叫 shout 的操作，内容是「你好」', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); } },
  { id: 'mcp-bad-params', layer: '失败', title: '缺少必填参数的错误与自我纠正', prompt: '用回声工具发一条消息，但这次不要提供任何文字内容', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); } },
  { id: 'mcp-disconnect', layer: '失败', title: '服务器断开（主动注销路径）后的可见性', prompt: '再用回声工具发一次「断开后测试」', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); }, afterConnect: async (manager) => { manager.disconnect('echo'); }, notes: ['manager.disconnect = 断开并注销根能力（配置移除/重连前语义）；意外崩溃路径见 mcp-crash'] },
  { id: 'mcp-crash', layer: '失败', title: 'stdio 子进程被杀（意外崩溃路径）的错误呈现', prompt: '用回声工具把「崩溃后测试」原样返回', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); }, afterConnect: async () => {
    // 外部杀掉 echo stdio 子进程（不经 manager.disconnect——模拟进程意外崩溃，客户端实例仍在）。
    const { execSync } = await import('node:child_process');
    const out = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'mcp-echo-server' }).ProcessId"`, { encoding: 'utf8' });
    const pids = String(out).split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) { try { execSync(`taskkill /F /PID ${pid}`); } catch { /* 已退出 */ } }
    console.log(`  [mcp-crash] 已杀死 echo 子进程: ${pids.join(',') || '未找到'}`);
  }, notes: ['杀进程后立即发起模型回合——观察传输错误文本与重启行为'] },
  { id: 'mcp-unknown-action-forced', layer: '失败', title: '强制不存在 action 的 mcp_unknown_action 错误文本', prompt: '用回声工具执行 action=shout、params 里 text=「你好」。要求：action 必须原样用 shout，禁止改用其他 action 名。', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); } },
  // ── 拦截层 ──
  { id: 'mcp-root-off', layer: '拦截', title: '根能力默认 deny（enabled 未开）', prompt: '用回声工具发「默认关闭测试」', prepare: (cfg) => { withEcho(cfg); rootOn(cfg); searchOn(cfg); }, notes: ['无 enabled 覆盖 → 根默认 deny'] },
  { id: 'mcp-approval', layer: '拦截', title: 'MCP 根 approvalRequired（user 角色）→ 实际被角色基线拒绝', prompt: '用回声工具发「审批测试」', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true, approvalRequired: true }); searchOn(cfg); cfg.orchestration.approval.enabled = true; }, notes: ['user 角色 + effectiveRisk=high → 命中角色基线 user-high-risk-deny（priority 90）→ deny，不走审批'] },
  { id: 'mcp-approval-admin', layer: '拦截', title: 'MCP 根 approvalRequired（admin 角色）→ ask_admin 审批挂起', prompt: '用回声工具发「管理员审批测试」', userId: TEST_ADMIN, userRole: 'admin', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true, approvalRequired: true }); searchOn(cfg); cfg.orchestration.approval.enabled = true; }, notes: ['admin 角色 + high → admin-high-risk-approval（ask_admin）→ propose → 挂起；预期 status=suspended + broker pending'] },
  { id: 'mcp-deny-rule', layer: '拦截', title: '权限规则显式 deny', prompt: '用回声工具发「拒绝测试」', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); cfg.orchestration.permissions.rules = [{ id: 'test-deny-echo', scope: 'capability', capability: 'mcp.echo', mode: 'deny', priority: 50, reason: '实测：显式拒绝 mcp.echo' }]; } },
  { id: 'mcp-budget', layer: '拦截', title: '预算淘汰机制（收紧到 8 工具/2.5KB 实证）', prompt: '简单介绍一下你自己能做什么', prepare: (cfg) => { withEcho(cfg); rootOn(cfg, { enabled: true }); searchOn(cfg); cfg.toolRegistry.maxToolsPerTurn = 8; cfg.toolRegistry.maxToolSchemaBytes = 2500; }, notes: ['harness 工具宇宙 16 个 < 默认 24，不收紧则不触发淘汰；收紧后实证 rank 淘汰顺序（core→domain→searchable）与 omitted 原因', '生产当前 100/48000 + 全量 handler 约 40 工具，默认预算同样不触发'] },
  // ── 内置抽检 ──
  { id: 'builtin-memory-read', layer: '内置·读', title: 'memory.search 真实检索', prompt: '你还记得我喜欢什么颜色吗？', prepare: (cfg) => { cfg.orchestration.mcpServers = []; } },
  ...(runSong ? [{ id: 'builtin-song-write', layer: '内置·写', title: 'audio.music.generate 真实生成（SunoAPI）', prompt: '帮我用 Suno 生成一段简短轻快的钢琴纯音乐，时长尽量短一些，纯音乐不要人声', prepare: (cfg) => { cfg.orchestration.mcpServers = []; cfg.orchestration.capabilityOverrides = { ...cfg.orchestration.capabilityOverrides, 'audio.music.generate': { timeoutMs: 600000 } }; }, notes: ['真实副作用：SunoAPI 创建 1 个生成任务'] }] : []),
  { id: 'builtin-approval', layer: '内置·拦截', title: '内置能力 approvalRequired → 审批挂起（不执行）', prompt: '帮我用 Suno 生成一首欢快的儿歌，名字叫《审批链路测试》', prepare: (cfg) => { cfg.orchestration.mcpServers = []; cfg.orchestration.capabilityOverrides = { ...cfg.orchestration.capabilityOverrides, 'audio.music.generate': { approvalRequired: true } }; cfg.orchestration.approval.enabled = true; }, notes: ['approvalRequired 覆盖 → 预期审批挂起，不产生真实生成'] },
];

// ── 主流程 ──
const filtered = SCENARIOS.filter((s) => {
  if (only.includes('all') || only.length === 0) return true;
  return only.some((o) => o === s.id || (o === 'mcp' && s.id.startsWith('mcp-')) || (o === 'builtin' && s.id.startsWith('builtin-')) || (o === 'budget' && s.id === 'mcp-budget'));
});
log(`能力可用性实测启动：${filtered.length} 个场景 → ${testRoot}`);
if (doSeed && filtered.some((s) => s.id === 'builtin-memory-read')) await seedMemory();
for (const sc of filtered) {
  try { await runScenario(sc); } catch (error) { log(`  场景异常 ${sc.id}: ${String(error?.message || error)}`); evidence.scenarios.push({ id: sc.id, error: String(error?.message || error) }); }
}
evidence.meta.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(testRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
log(`完成。证据：${path.join(testRoot, 'evidence.json')}`);
log(`副作用入账：${JSON.stringify(evidence.sideEffects)}`);
