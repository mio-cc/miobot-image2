import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * P0 装配一致性护栏（三表 join 审计）。
 * 背景（模型实证 2026-11-03）：能力"注册进目录" ≠ "装配进 agent 工具集"——
 * capability.catalog 把全部注册项列给模型，而 model.catalog.list（searchable 未进 loadout）、
 * owner.model.list（hidden）都调不动，模型如实报告"目录里有、工具里没有调用入口"。
 * 本文件锁定修复后的不变量：
 *   1. 目录可见集 ⊆ 默认 loadout 可调集（非 owner 上下文）；
 *   2. model.catalog.list 在默认 loadout（domain 修复）；
 *   3. owner.model.list：owner 上下文经 extraToolNames 放行，非 owner 不放行；
 *   4. 执行层 isOwner 纵深防御：非 owner 调 owner.model.list 被拒；
 *   5. hidden / 无 handler / searchable 未开检索 / 有意排除项不进目录。
 * 今后新增能力若"只登记不装配"，第 1 条会直接失败。
 */

const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { OrchestrationEnforcer } = await import('../dist/apps/bot/src/orchestration-enforce.js');
const { ModelCatalogCapabilityHandler, OwnerModelListCapabilityHandler, filterCatalogDescriptors } = await import('../dist/apps/bot/src/capability-basic.js');
const {
  resolveToolLoadout,
  inferExposure,
  toolSpecFromCapabilityDescriptor,
} = await import('../dist/packages/tool-runtime/src/index.js');
const { inferCapabilityToolExposure } = await import('../dist/apps/bot/src/capability-tool-adapter.js');

function makeConfig() {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  return cfg;
}

function makeEnforcer(cfg, handlers = new Map()) {
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'chat' }),
    engine: { handleExplicit: async () => null },
    sessions: { clear() {} }, registry: () => ({}), client: {},
  };
  const fakeClient = { chat: async () => ({ text: '{}' }) };
  return new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient, handlers });
}

/** 复刻 start.ts agentToolBindings 的 ToolSpec 组装（无 start 闭包依赖）。 */
function buildToolSpecs(enforcer, cfg) {
  return enforcer.listCapabilities()
    .flatMap((descriptor) => {
      const handler = enforcer.getCapabilityHandler(descriptor.id);
      if (!handler) return [];
      // 与 start.ts 一致：tts.speak 有意不装配（语音偏好走 reply.presentation）。
      const configuredExposure = cfg.toolRegistry?.exposure?.[descriptor.id];
      if (descriptor.id === 'tts.speak' && !configuredExposure) return [];
      const inferred = inferCapabilityToolExposure(descriptor, configuredExposure);
      const spec = toolSpecFromCapabilityDescriptor(descriptor, inferred ? { exposure: inferred } : {});
      return [spec];
    });
}

function makeInvocation(userId, args = {}) {
  return {
    request: { chat: { type: 'private' }, user: { qq: userId }, text: '', requestId: 'audit' },
    plan: { planId: 'p', requestId: 'audit', goal: 'g', steps: [], source: 'model' },
    step: { id: 's', capability: 'x', args },
    dependencyResults: {},
  };
}

test('三表审计：目录可见集 ⊆ 默认 loadout 可调集（非 owner）——新增能力只登记不装配会在此失败', () => {
  const cfg = makeConfig();
  const enforcer = makeEnforcer(cfg);
  const all = enforcer.listCapabilities();
  const specs = buildToolSpecs(enforcer, cfg);
  // 全上下文满足（image/file/video/audio/url/quote/forward）：缺上下文被 loadout 排除是正确行为
  // （无图不给改图工具），不属于"装配脱节"，因此审计时显式放开全部上下文，只测装配与 exposure。
  const ALL_CONTEXTS = ['image', 'file', 'video', 'audio', 'url', 'quote', 'forward'];
  const loadout = resolveToolLoadout(specs, { exposures: ['core', 'domain'], availableContext: ALL_CONTEXTS });
  const loadoutNames = new Set(loadout.tools.map((tool) => tool.name));

  // 目录可见集（与 start.ts capability.catalog handler 同源的三条过滤规则）
  const visible = filterCatalogDescriptors(all, {
    hasHandler: (id) => Boolean(enforcer.getCapabilityHandler(id)),
    isHiddenFromModel: (id) => {
      const descriptor = all.find((item) => item.id === id);
      const exposure = inferCapabilityToolExposure(descriptor, cfg.toolRegistry?.exposure?.[id])
        ?? inferExposure(id, descriptor?.enabled !== false, descriptor?.riskLevel || 'low');
      if (exposure === 'hidden') return true;
      return exposure === 'searchable' && cfg.toolRegistry?.toolSearchEnabled !== true;
    },
    isOwnerContext: false,
  });

  const dangling = visible.filter((d) => !loadoutNames.has(d.id));
  assert.deepEqual(dangling.map((d) => d.id), [],
    `目录列出但默认 loadout 调不到（注册了但没装配）：${dangling.map((d) => d.id).join(', ')}`);
});

test('model.catalog.list 修复后在默认 loadout 中可达（此前 searchable 被 core+domain 过滤）', () => {
  const cfg = makeConfig();
  const enforcer = makeEnforcer(cfg);
  const specs = buildToolSpecs(enforcer, cfg);
  const loadout = resolveToolLoadout(specs, { exposures: ['core', 'domain'], availableContext: ['image', 'file', 'video', 'audio', 'url', 'quote', 'forward'] });
  assert.ok(loadout.tools.some((tool) => tool.name === 'model.catalog.list'),
    'model.catalog.list 必须出现在默认 loadout（P0 装配修复）');
  assert.ok(enforcer.getCapabilityHandler('model.catalog.list'), 'handler 必须存在（enforcer 内部注册）');
});

test('owner.model.list：owner 上下文经 extraToolNames 放行；非 owner 不放行', () => {
  const cfg = makeConfig();
  // owner.model.list 的 handler 由 start.ts 的 orchestrationHandlers 注入（enforcer 内部不注册），
  // 测试模拟同款注入，验证装配链与执行链。
  const handlers = new Map([
    ['owner.model.list', new OwnerModelListCapabilityHandler({
      getConfig: () => cfg,
      isOwnerUser: () => true,
      buildText: async () => '【模型列表】',
    })],
  ]);
  const enforcer = makeEnforcer(cfg, handlers);
  assert.ok(enforcer.getCapabilityHandler('owner.model.list'), '注入的 owner.model.list handler 必须可达');
  const specs = buildToolSpecs(enforcer, cfg);

  const defaultLoadout = resolveToolLoadout(specs, { exposures: ['core', 'domain'] });
  assert.ok(!defaultLoadout.tools.some((tool) => tool.name === 'owner.model.list'),
    '非 owner：owner.model.list（hidden）不得出现在默认 loadout');

  const ownerLoadout = resolveToolLoadout(specs, { exposures: ['core', 'domain'], extraToolNames: ['owner.model.list'] });
  assert.ok(ownerLoadout.tools.some((tool) => tool.name === 'owner.model.list'),
    'owner：extraToolNames 必须放行 owner.model.list');
  // extraToolNames 只豁免 exposure：enabled=false 仍被挡（不越权）
  const disabledSpecs = specs.map((spec) => spec.name === 'owner.model.list' ? { ...spec, enabled: false } : spec);
  const disabledLoadout = resolveToolLoadout(disabledSpecs, { exposures: ['core', 'domain'], extraToolNames: ['owner.model.list'] });
  assert.ok(!disabledLoadout.tools.some((tool) => tool.name === 'owner.model.list'),
    'extraToolNames 不得绕过 enabled=false');
  // 其他 hidden 项（config.update / permission.update / session.clear）即使 owner 也不放行
  assert.ok(!ownerLoadout.tools.some((tool) => tool.name === 'config.update' || tool.name === 'permission.update' || tool.name === 'session.clear'),
    'owner 上下文也不得连带放行其他 hidden 项（critical/命令式）');
});

test('OwnerModelListCapabilityHandler：owner 成功；非 owner 执行层拒绝（纵深防御）', async () => {
  const cfg = makeConfig();
  cfg.bot.ownerQQs = ['10000'];
  const handler = new OwnerModelListCapabilityHandler({
    getConfig: () => cfg,
    isOwnerUser: (userId) => String(userId ?? '') === '10000',
    buildText: async () => '【模型列表】节点 1：...',
  });
  const ownerResult = await handler.execute(makeInvocation('10000'));
  assert.equal(ownerResult.status, 'success');
  assert.match(ownerResult.outputs[0].text, /【模型列表】/);

  const nonOwnerResult = await handler.execute(makeInvocation('2000'));
  assert.equal(nonOwnerResult.status, 'failed');
  assert.match(nonOwnerResult.error, /仅主人/);
});

test('ModelCatalogCapabilityHandler：输出含 agent.mainModel 真源（而非仅旧字段 llm.chatModel）', async () => {
  const cfg = makeConfig();
  cfg.llm.chatModel = 'legacy-chat-model';
  cfg.llm.chatNodeIndex = 0;
  cfg.agent.mainModel = 'agent-main-model';
  cfg.agent.mainNodeIndex = 1;
  cfg.llm.apiKeys = [
    { name: '节点A', baseUrl: 'https://a.example/v1', key: 'k', enabled: true, models: ['m-a1'] },
    { name: '节点B', baseUrl: 'https://b.example/v1', key: 'k', enabled: true, models: ['m-b1', 'agent-main-model'] },
  ];
  const handler = new ModelCatalogCapabilityHandler(() => cfg);
  const result = await handler.execute(makeInvocation('10000'));
  assert.equal(result.status, 'success');
  const text = result.outputs[0].text;
  assert.match(text, /当前主对话模型：agent-main-model（节点B）/);
  assert.match(text, /节点A/);
  assert.match(text, /m-b1/);
});

test('filterCatalogDescriptors：hidden / 无 handler / internal / tts.speak / searchable 不列；owner 只放行 owner.model.list', () => {
  const descriptors = [
    { id: 'chat.reply', permissions: undefined },        // searchable（未开检索）→ 不列
    { id: 'help', permissions: undefined },              // searchable → 不列
    { id: 'web.search', permissions: undefined },        // core → 列
    { id: 'model.catalog.list', permissions: undefined },// domain（修复后）→ 列
    { id: 'owner.model.list', permissions: ['owner'] },  // hidden → 仅 owner 列
    { id: 'owner.recall', permissions: ['owner'] },      // hidden → 恒不列（不在只读白名单）
    { id: 'session.clear', permissions: undefined },     // hidden → 不列
    { id: 'config.update', permissions: ['admin', 'owner'] }, // hidden → 不列
    { id: 'file.delete', permissions: undefined },       // searchable → 不列
    { id: 'tts.speak', permissions: undefined },         // 有意不装配 → 不列
    { id: 'memory.search', internal: true },             // internal → 不列
    { id: 'phantom.no-handler', permissions: undefined }, // 无 handler → 不列
  ];
  const hiddenFromModel = new Set(['chat.reply', 'help', 'owner.model.list', 'owner.recall', 'session.clear', 'config.update', 'file.delete']);
  const hasHandler = (id) => id !== 'phantom.no-handler';

  const nonOwner = filterCatalogDescriptors(descriptors, {
    hasHandler,
    isHiddenFromModel: (id) => hiddenFromModel.has(id),
    isOwnerContext: false,
  });
  assert.deepEqual(nonOwner.map((d) => d.id), ['web.search', 'model.catalog.list']);

  const owner = filterCatalogDescriptors(descriptors, {
    hasHandler,
    isHiddenFromModel: (id) => hiddenFromModel.has(id),
    isOwnerContext: true,
  });
  assert.deepEqual(owner.map((d) => d.id), ['web.search', 'model.catalog.list', 'owner.model.list']);
});
