import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';

const { createBotMessageRuntime } = await import('../dist/apps/bot/src/main.js');
const { createAgentHost } = await import('../dist/apps/bot/src/agent-host.js');
const { ToolJobRuntime } = await import('../dist/apps/bot/src/tool-job-runtime.js');
const { createBrowserRenderer } = await import('../dist/packages/browser-render/src/index.js');
const { renderReport } = await import('../dist/apps/bot/src/report-render.js');
const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { InMemoryAgentSessionManager } = await import('../dist/packages/agent-runtime/src/index.js');
const { normalizeToolSpec, toolPending, toolSuccess } = await import('../dist/packages/tool-runtime/src/index.js');
const { NapcatAdapter } = await import('../dist/packages/napcat/src/index.js');

const chromeCandidates = [
  process.env.MIOBOT_CHROMIUM_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(String(candidate)));
if (chrome) process.env.MIOBOT_CHROMIUM_PATH = String(chrome);

async function waitUntil(predicate, timeoutMs = 10000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for ' + label);
}

async function createFakeNapcat() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  let peer;
  let nextMessageId = 8000;
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      let action;
      try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      socket.send(JSON.stringify({
        echo: action.echo,
        self_id: 10000,
        status: 'ok',
        retcode: 0,
        data: { message_id: nextMessageId++, forward_id: 'forward-' + nextMessageId },
      }));
    });
  });
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://127.0.0.1:' + port,
    token: 'sim-token',
    actionTimeoutMs: 3000,
    textSendTimeoutMs: 3000,
    imageSendTimeoutMs: 3000,
    forwardSendTimeoutMs: 3000,
    fileSendTimeoutMs: 3000,
    getMessageTimeoutMs: 3000,
    autoReconnect: false,
  });
  adapter.connect();
  await waitUntil(() => Boolean(peer), 3000, 'fake napcat peer');
  return {
    adapter,
    actions,
    async qq(event) { peer.send(JSON.stringify({ self_id: 10000, ...event })); },
    async close() {
      adapter.disconnect();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

test('R24 harness e2e: QQ group message -> model-designed HTML report.render async -> Napcat send, no gallery sync', async (t) => {
  if (!chrome) t.skip('local Chromium not available');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-html-e2e-'));
  const originalChrome = process.env.MIOBOT_CHROMIUM_PATH;
  const sim = await createFakeNapcat();
  const browserRenderer = createBrowserRenderer({
    getConfig: () => cfg,
    logger: { info() {}, warn() {} },
  });
  const renderedHtmls = [];
  const originalRenderCode = browserRenderer.renderCode.bind(browserRenderer);
  browserRenderer.renderCode = async (artifact, outputDir) => {
    renderedHtmls.push(String(artifact.html || ''));
    return originalRenderCode(artifact, outputDir);
  };
  let completedJob;
  const jobs = new ToolJobRuntime({ onComplete: (job) => { completedJob = job; } });
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.maxModelRounds = 4;
  cfg.bot.replyStrategies.text = 'plain';
  cfg.browserRender.enabled = true;
  cfg.browserRender.maxHeight = 12000;
  const sessions = new InMemoryAgentSessionManager({});
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;background:#f3f0e8;color:#2b2118;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;padding:40px}h1{font-size:38px}table{width:100%;border-collapse:collapse;background:#fffdf8}th,td{padding:12px;border-bottom:1px solid #ded5c7;text-align:left}th{background:#ece5d8}</style></head><body><h1>本周网文热度榜</h1><p>真实数据 · 模型设计 HTML</p><table><thead><tr><th>排名</th><th>书名</th><th>热度</th></tr></thead><tbody><tr><td>01</td><td>长夜将明</td><td>52,000</td></tr><tr><td>02</td><td>山河旧梦</td><td>38,600</td></tr></tbody></table></body></html>';
  let modelCalls = 0;
  let sawToolResult = false;
  const client = {
    async chat(_nodeIndex, request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          text: '',
          raw: {},
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'html_page_call', name: 'report.render', arguments: { html, width: 1080, fullPage: true, title: '本周网文热度榜' } }],
        };
      }
      const toolMessage = (request?.messages || []).find((message) => message.role === 'tool' && message.toolCallId === 'html_page_call');
      assert.ok(toolMessage, 'resume must provide the report.render tool result');
      assert.match(String(toolMessage.content || ''), /file:|页面图片/);
      sawToolResult = true;
      return { text: '页面已按真实数据设计并生成。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  const reportSpec = normalizeToolSpec({
    name: 'report.render',
    title: '页面渲染',
    description: '直接渲染模型设计的 HTML',
    mode: 'async_job',
    exposure: 'core',
    riskLevel: 'low',
    sideEffects: ['creates_artifact'],
    outputKinds: ['image'],
    inputSchema: { type: 'object', properties: { html: { type: 'string' }, width: { type: 'number' }, fullPage: { type: 'boolean' }, title: { type: 'string' } }, required: ['html'], additionalProperties: true },
  });
  const binding = {
    spec: reportSpec,
    handler: async (call, _spec, context) => {
      const job = jobs.create({ toolName: call.name, callId: call.id, sessionKey: context.sessionKey });
      const outputDir = path.join(dir, job.jobId);
      await fs.mkdir(outputDir, { recursive: true });
      const promise = renderReport(call.arguments, {
        browserRenderer,
        outputDir,
        uploadFile: async (filePath) => 'file://' + filePath,
        logger: { info() {}, warn() {} },
      }).then((result) => toolSuccess(call.id, call.name, {
        content: '页面图片：' + result.images.join(', '),
        outputs: result.images.map((url) => ({ kind: 'image', url, meta: { readOnlyArtifact: true } })),
        meta: { pages: result.pages, readOnlyArtifact: true },
      }));
      void jobs.run(job.jobId, promise, 60000);
      return toolPending(call.id, job.jobId, { toolName: call.name, content: '页面生成中' });
    },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    toolBindings: () => [binding],
    preflightToolCall: () => ({ allowed: true }),
    resolveJob: (record) => {
      const job = jobs.get(record.jobId);
      return { jobId: record.jobId, status: job?.status || 'running', ...(job?.result ? { result: job.result } : {}) };
    },
  });
  const galleryCalls = [];
  const runtime = createBotMessageRuntime({
    app: {
      handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }),
      engine: { async handleExplicit() { return null; } },
      sessions: { clear() {}, get: () => [], append() {} },
      registry: () => ({}), client: {},
    },
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    syncImagesToGallery: async (input) => { galleryCalls.push(input); return input.images; },
    agentRuntime: async (input) => {
      const outcome = await host({ ...input, userRole: 'user' });
      return {
        handled: outcome.handled,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.silent ? { silent: true } : {}),
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      };
    },
  });
  runtime.attach(sim.adapter);
  try {
    await sim.qq({
      post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001,
      message_id: 91001, raw_message: '[CQ:at,qq=10000] 按真实数据做一张本周热度榜页面',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 按真实数据做一张本周热度榜页面' } }],
      sender: { nickname: '测试用户' },
    });
    await waitUntil(() => sessions.snapshot().some((session) => (session.pendingJobs || []).length > 0), 5000, 'pending report job');
    const session = sessions.snapshot().find((candidate) => (candidate.pendingJobs || []).length > 0);
    const jobId = session.pendingJobs[0].jobId;
    await waitUntil(() => jobs.get(jobId)?.status === 'succeeded', 15000, 'report job succeeded');
    assert.equal(sim.actions.some((action) => action.action === 'send_group_msg' || action.action === 'send_group_forward_msg'), false, '挂起期间不得发送 QQ 消息');
    assert.ok(completedJob?.result, 'job result should exist');
    const imageOutput = completedJob.result.outputs.find((output) => output.kind === 'image');
    assert.ok(imageOutput?.url?.startsWith('file://'), 'report should produce a local image');
    const imagePath = imageOutput.url.slice('file://'.length);
    const metadata = await sharp(imagePath).metadata();
    assert.equal(metadata.width, 1080);
    assert.ok(Number(metadata.height) >= 1000);
    assert.ok(renderedHtmls.some((value) => value.includes('本周网文热度榜')), 'model-designed HTML must be rendered');
    assert.ok(renderedHtmls.every((value) => !value.includes('2024年度经营数据看板')), 'default sample must never be used');
    const resumed = await host({
      text: '页面已经生成，请发送给用户。', resumeJob: true, resumeJobId: jobId,
      chatType: 'group', groupId: 3000, userId: 2001, sessionId: 'group:3000:2001',
    });
    assert.equal(resumed.handled, true);
    assert.ok(resumed.replyPlan, 'resume should produce a reply plan');
    await runtime.sendAgentOutcome({
      chatType: 'group', groupId: 3000, userId: 2001,
      text: resumed.text, replyPlan: resumed.replyPlan, reason: resumed.reason,
    });
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_group_msg' || action.action === 'send_group_forward_msg'), 5000, 'napcat send');
    const outbound = sim.actions.find((action) => action.action === 'send_group_msg' || action.action === 'send_group_forward_msg');
    const payload = JSON.stringify(outbound.params || {});
    assert.ok(/image|file|本周网文热度榜|页面图片/.test(payload), 'outbound QQ payload should contain the generated image or text');
    assert.equal(galleryCalls.length, 0, 'render screenshot must not be synced to Canvas gallery');
    assert.equal(modelCalls, 2, 'model must see the completed tool result once during resume');
    assert.equal(sawToolResult, true);
  } finally {
    await browserRenderer.close();
    await sim.close();
    await fs.rm(dir, { recursive: true, force: true });
    if (originalChrome === undefined) delete process.env.MIOBOT_CHROMIUM_PATH;
    else process.env.MIOBOT_CHROMIUM_PATH = originalChrome;
  }
});