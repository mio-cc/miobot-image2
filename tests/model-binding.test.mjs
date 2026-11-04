import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * P1 第一批：/切换 命令修复（7a）+ model.binding.switch 工具（7b）+ 模型位空值保留（问题二）。
 * 双路径一致性核心断言：命令与工具共用同一个 ModelBindingService（同一份校验/写入/审计）。
 */

const { importConfig, createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { parseOwnerCommand } = await import('../dist/apps/bot/src/owner.js');
const { createModelBindingService, findModelCandidates, MODEL_BINDING_PURPOSES } = await import('../dist/apps/bot/src/model-binding.js');
const { ModelBindingSwitchCapabilityHandler } = await import('../dist/apps/bot/src/capability-basic.js');

function makeLogger() {
  const entries = [];
  return { entries, info: (m, d) => entries.push(['info', m, d]), warn: (m, d) => entries.push(['warn', m, d]), error: (m, d) => entries.push(['error', m, d]) };
}

function makeConfig() {
  const cfg = createDefaultConfig();
  cfg.llm.apiKeys = [
    { name: '节点A', baseUrl: 'https://a.example/v1', key: 'k', enabled: true, models: ['gpt-4o-mini', 'deepseek-chat', 'deepseek-reasoner'] },
    { name: '节点B', baseUrl: 'https://b.example/v1', key: 'k', enabled: true, models: ['deepseek-chat', 'claude-3-5'] },
  ];
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.agent.mainNodeIndex = 0;
  cfg.llm.chatModel = 'gpt-4o-mini';
  cfg.llm.chatNodeIndex = 0;
  return cfg;
}

// ── 7a：命令解析（纯函数，旧语法兼容 + 扩展） ──────────────────────────

test('命令解析：/切换 X 旧语法兼容（默认主对话 primary）', () => {
  const oc = parseOwnerCommand('/切换 deepseek-chat', { chatType: 'private' });
  assert.deepEqual(oc, { command: 'switchModel', code: 'deepseek-chat', purpose: 'main', slot: 'primary' });
  const q = parseOwnerCommand('/q deepseek-chat', { chatType: 'private' });
  assert.equal(q.command, 'switchModel');
  assert.equal(q.purpose, 'main');
});

test('命令解析：/切换 状态 → switchModelStatus', () => {
  assert.equal(parseOwnerCommand('/切换 状态', { chatType: 'private' }).command, 'switchModelStatus');
  assert.equal(parseOwnerCommand('/切换 status', { chatType: 'private' }).command, 'switchModelStatus');
});

test('命令解析：备 档位 + 指定用途', () => {
  assert.deepEqual(
    parseOwnerCommand('/切换 备 deepseek-chat', { chatType: 'private' }),
    { command: 'switchModel', code: 'deepseek-chat', purpose: 'main', slot: 'secondary' },
  );
  assert.deepEqual(
    parseOwnerCommand('/切换 图片 deepseek-chat', { chatType: 'private' }),
    { command: 'switchModel', code: 'deepseek-chat', purpose: '图片', slot: 'primary' },
  );
  assert.deepEqual(
    parseOwnerCommand('/切换 主对话 备 claude-3-5', { chatType: 'private' }),
    { command: 'switchModel', code: 'claude-3-5', purpose: '主对话', slot: 'secondary' },
  );
  // 词序兼容：备 在前
  assert.deepEqual(
    parseOwnerCommand('/切换 备 图片 deepseek-chat', { chatType: 'private' }),
    { command: 'switchModel', code: 'deepseek-chat', purpose: '图片', slot: 'secondary' },
  );
});

test('命令解析：缺目标 → code 空（上层回用法提示，不猜）', () => {
  const oc = parseOwnerCommand('/切换 图片', { chatType: 'private' });
  assert.equal(oc.command, 'switchModel');
  assert.equal(oc.code, '');
  assert.equal(oc.purpose, '图片');
});

// ── ModelBindingService（命令与工具的同源层） ──────────────────────────

test('service.setBinding：main primary → 写 agent.mainModel/mainNodeIndex 并双写 llm.chatModel（7a 核心修复）', () => {
  const cfg = makeConfig();
  const logger = makeLogger();
  const service = createModelBindingService({ getConfig: () => cfg, logger });
  const result = service.setBinding({ purpose: 'main', slot: 'primary', target: 'claude-3-5', scope: 'persistent', source: 'command', actorId: '10000' });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(cfg.agent.mainModel, 'claude-3-5');
  assert.equal(cfg.agent.mainNodeIndex, 1, '节点索引必须跟随模型所在节点（旧实现漏切节点）');
  assert.equal(cfg.llm.chatModel, 'claude-3-5', '双写旧字段兼容');
  assert.equal(cfg.llm.chatNodeIndex, 1);
  assert.match(result.reply, /已切换「主对话」模型为 claude-3-5/);
  assert.match(result.reply, /原 gpt-4o-mini/);
  assert.ok(logger.entries.some(([, m, d]) => m.includes('model.binding.switch 审计') && d.to === 'claude-3-5' && d.source === 'command'), '审计日志必须留痕');
});

test('service.setBinding：main secondary → 写 agent.fallbackModel（结构预留，不动 primary）', () => {
  const cfg = makeConfig();
  const service = createModelBindingService({ getConfig: () => cfg, logger: makeLogger() });
  const result = service.setBinding({ purpose: 'main', slot: 'secondary', target: 'deepseek-reasoner', scope: 'persistent', source: 'command', actorId: '10000' });
  assert.ok(result.ok);
  assert.equal(cfg.agent.fallbackModel, 'deepseek-reasoner');
  assert.equal(cfg.agent.fallbackNodeIndex, 0);
  assert.equal(cfg.agent.mainModel, 'gpt-4o-mini', '备用写入不得影响主绑定');
});

test('service.setBinding：嵌套 section（orchestration.memory）', () => {
  const cfg = makeConfig();
  const service = createModelBindingService({ getConfig: () => cfg, logger: makeLogger() });
  const result = service.setBinding({ purpose: 'memory', slot: 'primary', target: 'deepseek-reasoner', scope: 'persistent', source: 'tool', actorId: '10000' });
  assert.ok(result.ok);
  assert.equal(cfg.orchestration.memory.embeddingModel, 'deepseek-reasoner');
  assert.equal(cfg.orchestration.memory.embeddingNodeIndex, 0);
});

test('service.setBinding：错误分支——未找到 / 歧义（禁止猜）/ 不支持 secondary / 不支持 once / 未知用途', () => {
  const cfg = makeConfig();
  const service = createModelBindingService({ getConfig: () => cfg, logger: makeLogger() });

  const notFound = service.setBinding({ purpose: 'main', slot: 'primary', target: 'gpt-99', scope: 'persistent', source: 'command', actorId: '1' });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.kind, 'not_found');

  // 同名模型跨两个节点 → 歧义（候选带节点名）
  const ambiguousNode = service.setBinding({ purpose: 'main', slot: 'primary', target: 'deepseek-chat', scope: 'persistent', source: 'command', actorId: '1' });
  assert.equal(ambiguousNode.ok, false);
  assert.equal(ambiguousNode.kind, 'ambiguous_model');
  assert.ok(ambiguousNode.candidates.some((c) => c.includes('节点A') || c.includes('节点B')));

  // 模糊包含命中多个不同模型 → 歧义
  const ambiguousFuzzy = service.setBinding({ purpose: 'main', slot: 'primary', target: 'deepseek', scope: 'persistent', source: 'command', actorId: '1' });
  assert.equal(ambiguousFuzzy.ok, false);
  assert.equal(ambiguousFuzzy.kind, 'ambiguous_model');

  // P2（方案 6-P2）：全部用途都支持备用——旧的「仅主对话」拒绝分支已废止。
  // 非 main 用途的备用现在应写入用途容器自己的 fallback 字段。
  const secondary = service.setBinding({ purpose: 'image', slot: 'secondary', target: 'claude-3-5', scope: 'persistent', source: 'command', actorId: '1' });
  assert.equal(secondary.ok, true, 'P2 起 image 备用必须可写');
  assert.equal(cfg.llm.fallbackImageModel, 'claude-3-5', '写入 llm 容器的用途级 fallback 字段');
  assert.equal(cfg.llm.fallbackImageNodeIndex, 1, 'claude-3-5 在节点B（下标 1）');

  const once = service.setBinding({ purpose: 'main', slot: 'primary', target: 'deepseek-chat', scope: 'once', source: 'command', actorId: '1' });
  assert.equal(once.ok, false);
  assert.equal(once.kind, 'unsupported_once');

  const unknown = service.setBinding({ purpose: '虚无用途', slot: 'primary', target: 'deepseek-chat', scope: 'persistent', source: 'command', actorId: '1' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.kind, 'unknown_purpose');
});

test('service.setBinding：防竞态——磁盘有更新时按最新配置重放（不回滚面板改动）', () => {
  const cfg = makeConfig();
  const fresh = makeConfig();
  fresh.bot.staleMessageMaxAgeSeconds = 300; // 模拟面板并发改动
  const store = { loadIfChanged: () => fresh, save: (c) => { store.saved = c; } };
  const service = createModelBindingService({ getConfig: () => cfg, store, logger: makeLogger() });
  const result = service.setBinding({ purpose: 'main', slot: 'primary', target: 'claude-3-5', scope: 'persistent', source: 'command', actorId: '1' });
  assert.ok(result.ok);
  assert.equal(store.saved.agent.mainModel, 'claude-3-5', '变更重放到 fresh');
  assert.equal(store.saved.bot.staleMessageMaxAgeSeconds, 300, '面板并发改动不被回滚');
});

test('service.getStatusText：列出全部用途绑定与用法提示', () => {
  const cfg = makeConfig();
  const service = createModelBindingService({ getConfig: () => cfg, logger: makeLogger() });
  const text = service.getStatusText();
  for (const purpose of MODEL_BINDING_PURPOSES) assert.ok(text.includes(purpose.label), `缺 ${purpose.label}`);
  assert.match(text, /主对话：主 gpt-4o-mini @ 节点A｜备 （未设置）/);
  assert.match(text, /\/切换 \{用途\} \{模型名\}/);
});

test('findModelCandidates：精确 > 后缀 > 包含', () => {
  const cfg = makeConfig();
  const exact = findModelCandidates(cfg, 'deepseek-chat');
  assert.equal(exact[0].rank, 0);
  const suffix = findModelCandidates(cfg, 'chat');
  assert.ok(suffix.length >= 1 && suffix.every((c) => c.rank <= 1));
});

// ── 7b：model.binding.switch 工具执行体 ────────────────────────────────

function makeInvocation(userId, args) {
  return {
    request: { chat: { type: 'private' }, user: { qq: userId }, text: '', requestId: 't' },
    plan: { planId: 'p', requestId: 't', goal: 'g', steps: [], source: 'model' },
    step: { id: 's', capability: 'model.binding.switch', args },
    dependencyResults: {},
  };
}

function makeToolHandler(cfg, ownerIds = ['10000']) {
  const logger = makeLogger();
  return {
    logger,
    handler: new ModelBindingSwitchCapabilityHandler({
      isOwnerUser: (userId) => ownerIds.includes(String(userId ?? '')),
      service: createModelBindingService({ getConfig: () => cfg, logger }),
      logger,
    }),
  };
}

test('工具：owner 切换成功（与命令同源——同一 service 写同一字段）', async () => {
  const cfg = makeConfig();
  const { handler } = makeToolHandler(cfg);
  const result = await handler.execute(makeInvocation('10000', { purpose: 'main', target: 'claude-3-5' }));
  assert.equal(result.status, 'success');
  assert.match(result.outputs[0].text, /已切换「主对话」模型为 claude-3-5/);
  assert.equal(result.outputs[0].meta.status, 'ok');
  assert.equal(cfg.agent.mainModel, 'claude-3-5');
});

test('工具：非 owner → permission_denied 结构化拒绝 + warn 审计（不静默）', async () => {
  const cfg = makeConfig();
  const { handler, logger } = makeToolHandler(cfg);
  const result = await handler.execute(makeInvocation('2000', { purpose: 'main', target: 'claude-3-5' }));
  assert.equal(result.status, 'failed');
  assert.match(result.error, /permission_denied/);
  assert.equal(cfg.agent.mainModel, 'gpt-4o-mini', '配置不得被改动');
  assert.ok(logger.entries.some(([, m]) => m.includes('非 owner 调用')));
});

test('工具：用途缺省 → ambiguous purpose（列各用途绑定，由模型追问，禁止猜）', async () => {
  const cfg = makeConfig();
  const { handler } = makeToolHandler(cfg);
  const result = await handler.execute(makeInvocation('10000', { target: 'deepseek-chat' }));
  assert.equal(result.status, 'success');
  assert.equal(result.outputs[0].meta.status, 'ambiguous');
  assert.equal(result.outputs[0].meta.kind, 'purpose');
  assert.match(result.outputs[0].text, /未指定用途/);
  assert.match(result.outputs[0].text, /请向用户确认/);
  assert.equal(cfg.agent.mainModel, 'gpt-4o-mini', '歧义时不得写入');
});

test('工具：模型名多候选 → ambiguous model（列候选，由模型追问）', async () => {
  const cfg = makeConfig();
  const { handler } = makeToolHandler(cfg);
  const result = await handler.execute(makeInvocation('10000', { purpose: 'main', target: 'deepseek-chat' }));
  // deepseek-chat 在两个节点同名 → ambiguous
  assert.equal(result.outputs[0].meta.status, 'ambiguous');
  assert.equal(result.outputs[0].meta.kind, 'model');
  assert.ok(Array.isArray(result.outputs[0].meta.candidates) && result.outputs[0].meta.candidates.length >= 2);
});

test('工具：scope=once → 明确失败（状态机未实现，不假装生效）', async () => {
  const cfg = makeConfig();
  const { handler } = makeToolHandler(cfg);
  const result = await handler.execute(makeInvocation('10000', { purpose: 'main', target: 'claude-3-5', scope: 'once' }));
  assert.equal(result.status, 'failed');
  assert.match(result.error, /尚未实现/);
});

// ── 问题二：模型位空值保留（normalize 不再静默回填默认） ────────────────

test('normalize：显式空串保留为空（继承语义），缺键才用默认值', () => {
  const base = createDefaultConfig();
  // agent.mainModel 显式清空 → 保留空（此前回填 'gpt-4o-mini'）
  const cleared = importConfig({ ...base, agent: { ...base.agent, mainModel: '' } }).config;
  assert.equal(cleared.agent.mainModel, '', '显式清空必须保留为空');
  // 缺键（undefined）→ 默认值
  const missing = JSON.parse(JSON.stringify(base));
  delete missing.agent.mainModel;
  assert.equal(importConfig(missing).config.agent.mainModel, 'gpt-4o-mini', '缺键用默认值');

  // 其余用途模型位同构：videoModel / intentRecognition.model / codeRender.model / comfyuiTransform.model / tts.preprocess.model / memory.embeddingModel
  const cleared2 = importConfig({ ...base, llm: { ...base.llm, videoModel: '' }, intentRecognition: { ...base.intentRecognition, model: '' }, codeRender: { ...base.codeRender, model: '' }, comfyuiTransform: { ...base.comfyuiTransform, model: '' }, bot: { ...base.bot, tts: { ...base.bot.tts, preprocess: { ...base.bot.tts.preprocess, model: '' } } }, orchestration: { ...base.orchestration, memory: { ...base.orchestration.memory, embeddingModel: '' } } }).config;
  assert.equal(cleared2.llm.videoModel, '', 'videoModel 空保留');
  assert.equal(cleared2.intentRecognition.model, '', 'intentRecognition.model 空保留');
  assert.equal(cleared2.codeRender.model, '', 'codeRender.model 空保留');
  assert.equal(cleared2.comfyuiTransform.model, '', 'comfyuiTransform.model 空保留');
  assert.equal(cleared2.bot.tts.preprocess.model, '', 'tts.preprocess.model 空保留');
  assert.equal(cleared2.orchestration.memory.embeddingModel, '', 'memory.embeddingModel 空保留');

  // 空值后的运行时兜底链仍然可用（消费点都有 || fallback）
  assert.equal(cleared2.intentRecognition.model || cleared2.freeMode.model || cleared2.llm.chatModel, cleared2.freeMode.model);
});
