import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 批 3 表驱动防接串测试（方案 6-P2）：接入点 → purpose → 期望读取的字段名。
 * 三层断言：
 * 1) 源码层：每个管线接入点的源码里 withPurposeFallback 以该 purpose 常量调用（不靠位置推断）；
 * 2) 用途表交叉核对：接入 purpose 在 MODEL_BINDING_PURPOSES 里解析出的备用字段名与表一致（防表被改错）；
 * 3) 配置读回层：全用途各配一个互不相同的备用 → fallbackBindingOf(purpose) 必须读到本用途容器里的那个
 *    （防「UI 写 A、运行时读 B」与跨用途继承）。
 * 另有红线：main 链不走 withPurposeFallback（agent-model-port 保持 P1 现状）。
 */

const root = path.resolve(process.cwd());
const src = (file) => readFileSync(path.join(root, file), 'utf8');
const { MODEL_BINDING_PURPOSES } = await import('../dist/apps/bot/src/model-binding.js');
const { fallbackBindingOf, withPurposeFallback } = await import('../dist/apps/bot/src/model-fallback.js');
const { createDefaultConfig, normalizeConfig } = await import('../dist/packages/config/src/index.js');

/** 表：接入点（文件） → purpose 常量 → 期望读取的 section 与备用字段名。 */
const WIRING = [
  { file: 'apps/bot/src/image-pipeline.ts', purpose: 'enhance', section: 'llm', fallbackNodeField: 'fallbackEnhanceNodeIndex', fallbackModelField: 'fallbackEnhanceModel' },
  { file: 'apps/bot/src/deps.ts', purpose: 'image', section: 'llm', fallbackNodeField: 'fallbackImageNodeIndex', fallbackModelField: 'fallbackImageModel' },
  { file: 'apps/bot/src/deps.ts', purpose: 'edit', section: 'llm', fallbackNodeField: 'fallbackEditNodeIndex', fallbackModelField: 'fallbackEditModel' },
  { file: 'apps/bot/src/deps.ts', purpose: 'interrogate', section: 'llm', fallbackNodeField: 'fallbackInterrogateNodeIndex', fallbackModelField: 'fallbackInterrogateModel' },
  { file: 'apps/bot/src/deps.ts', purpose: 'video', section: 'llm', fallbackNodeField: 'fallbackVideoNodeIndex', fallbackModelField: 'fallbackVideoModel' },
  { file: 'apps/bot/src/suno-composer.ts', purpose: 'suno', section: 'orchestration.suno', fallbackNodeField: 'fallbackComposerNodeIndex', fallbackModelField: 'fallbackComposerModel' },
  { file: 'apps/bot/src/trigger-intent.ts', purpose: 'trigger', section: 'bot.keywordTrigger', fallbackNodeField: 'fallbackIntentNodeIndex', fallbackModelField: 'fallbackIntentModel' },
  { file: 'apps/bot/src/memory-service.ts', purpose: 'memory', section: 'orchestration.memory', fallbackNodeField: 'fallbackEmbeddingNodeIndex', fallbackModelField: 'fallbackEmbeddingModel' },
  { file: 'apps/bot/src/runtime.ts', purpose: 'codeRender', section: 'codeRender', fallbackNodeField: 'fallbackNodeIndex', fallbackModelField: 'fallbackModel' },
  { file: 'apps/bot/src/comfyui.ts', purpose: 'comfyui', section: 'comfyuiTransform', fallbackNodeField: 'fallbackNodeIndex', fallbackModelField: 'fallbackModel' },
  { file: 'apps/bot/src/start.ts', purpose: 'tts', section: 'bot.tts.preprocess', fallbackNodeField: 'fallbackNodeIndex', fallbackModelField: 'fallbackModel' },
];

test('wiring: every pipeline exit calls withPurposeFallback with its explicit purpose constant', () => {
  for (const row of WIRING) {
    const source = src(row.file);
    const pattern = new RegExp(`withPurposeFallback\\([^,()]*,\\s*'${row.purpose}'\\s*,`);
    assert.ok(
      pattern.test(source),
      `${row.file} 应包含 withPurposeFallback(<controller>, '${row.purpose}', …)（purpose 常量显式，防接串）`,
    );
  }
});

test('wiring: purpose constants resolve to the expected fallback fields in MODEL_BINDING_PURPOSES', () => {
  for (const row of WIRING) {
    const def = MODEL_BINDING_PURPOSES.find((item) => item.key === row.purpose);
    assert.ok(def, `用途表缺少 purpose '${row.purpose}'`);
    assert.equal(def.section, row.section, `${row.purpose}.section 接串`);
    assert.equal(def.fallbackNodeField, row.fallbackNodeField, `${row.purpose}.fallbackNodeField 接串`);
    assert.equal(def.fallbackModelField, row.fallbackModelField, `${row.purpose}.fallbackModelField 接串`);
  }
});

test('wiring: each purpose reads its own container only (no cross-purpose inheritance)', () => {
  const base = createDefaultConfig();
  const cfg = normalizeConfig({
    ...base,
    agent: { ...base.agent, fallbackModel: 'fb-main', fallbackNodeIndex: 9 },
    llm: {
      ...base.llm,
      fallbackEnhanceModel: 'fb-enhance', fallbackEnhanceNodeIndex: 1,
      fallbackImageModel: 'fb-image', fallbackImageNodeIndex: 1,
      fallbackEditModel: 'fb-edit', fallbackEditNodeIndex: 1,
      fallbackInterrogateModel: 'fb-interrogate', fallbackInterrogateNodeIndex: 1,
      fallbackVideoModel: 'fb-video', fallbackVideoNodeIndex: 1,
    },
    orchestration: {
      ...base.orchestration,
      suno: { ...base.orchestration.suno, fallbackComposerModel: 'fb-suno', fallbackComposerNodeIndex: 2 },
      memory: { ...base.orchestration.memory, fallbackEmbeddingModel: 'fb-memory', fallbackEmbeddingNodeIndex: 2 },
    },
    codeRender: { ...base.codeRender, fallbackModel: 'fb-coderender', fallbackNodeIndex: 3 },
    comfyuiTransform: { ...base.comfyuiTransform, fallbackModel: 'fb-comfyui', fallbackNodeIndex: 3 },
    bot: {
      ...base.bot,
      tts: { ...base.bot.tts, preprocess: { ...base.bot.tts.preprocess, fallbackModel: 'fb-tts', fallbackNodeIndex: 4 } },
      keywordTrigger: { ...base.bot.keywordTrigger, fallbackIntentModel: 'fb-trigger', fallbackIntentNodeIndex: 4 },
    },
  });
  for (const row of WIRING) {
    const { secondary } = fallbackBindingOf(cfg, row.purpose);
    assert.ok(secondary, `${row.purpose} 应读到本用途的备用绑定`);
    assert.equal(secondary.model, `fb-${row.purpose === 'codeRender' ? 'coderender' : row.purpose}`, `${row.purpose} 读到了别的用途的备用（接串）`);
  }
  // main 不在 WIRING 表里，但同源核对：main 读 agent.fallback*。
  const mainBinding = fallbackBindingOf(cfg, 'main');
  assert.equal(mainBinding.secondary?.model, 'fb-main');
  // 未知用途 → 无备用（绝不跨用途继承）。
  assert.equal(fallbackBindingOf(cfg, 'unknown-purpose').secondary, null);
});

test('wiring: assembly chain hands the shared controller to every integration point', () => {
  const start = src('apps/bot/src/start.ts');
  // start.ts 装配：memory / suno(enforcer) / trigger / codeRender(runtime) / tts 四处 + createBotApp 已有。
  assert.ok(/new ChatMemoryService\(\{[\s\S]*?fallback: modelFallback/.test(start), 'ChatMemoryService 应接 modelFallback（purpose = memory）');
  assert.ok(/new OrchestrationEnforcer\(\{[\s\S]*?fallback: modelFallback/.test(start), 'OrchestrationEnforcer 应接 modelFallback（purpose = suno）');
  assert.ok(/new TriggerIntentChecker\(\{[\s\S]*?fallback: modelFallback/.test(start), 'TriggerIntentChecker 应接 modelFallback（purpose = trigger）');
  assert.ok(/createBotMessageRuntime\(\{[\s\S]*?fallback: modelFallback/.test(start), 'createBotMessageRuntime 应接 modelFallback（purpose = codeRender）');
  assert.ok(/createBotApp\(\{[\s\S]*?fallback: modelFallback/.test(start), 'createBotApp 应接 modelFallback（image/edit/interrogate/video/enhance/comfyui）');
  const app = src('apps/bot/src/app.ts');
  assert.ok(/createModelBackedDeps\(\{[\s\S]*?fallback: options\.fallback/.test(app), 'app.ts 应把 fallback 传给 createModelBackedDeps');
  assert.ok(/createImagePromptPipeline\(client, options\.getConfig, options\.fallback\)/.test(app), 'app.ts 应把 fallback 传给 createImagePromptPipeline（purpose = enhance）');
  const deps = src('apps/bot/src/deps.ts');
  assert.ok(/generateComfyUiImages\(\{ getConfig: getConfig!, client, fallback, logger \}/.test(deps), 'deps.ts ComfyUI 分支应把 fallback 传给 generateComfyUiImages（purpose = comfyui）');
});

test('wiring: repair/retry calls inside pipelines pass turn=false (follow semantics)', () => {
  const deps = src('apps/bot/src/deps.ts');
  assert.ok(/callGenerate\(safe, false\)/.test(deps), '生图安全改写重试应传 turn=false');
  assert.ok(/callGenerate\(prompt, true\)/.test(deps), '生图请求级首调应传 turn=true');
  const pipeline = src('apps/bot/src/image-pipeline.ts');
  assert.ok(/enhanceCall\(prompt, llm\.safeRewritePromptTemplate, false\)/.test(pipeline), '安全改写（enhance）应传 turn=false');
  const runtime = src('apps/bot/src/runtime.ts');
  assert.ok(/chat\(candidate, prompt, false\)/.test(runtime), '代码画图空文本重试应传 turn=false');
  assert.ok(/chat\(candidate, repairPrompt, false\)/.test(runtime), '代码画图解析修复应传 turn=false');
});

test('wiring red line: main chat chain stays on agent-model-port (no withPurposeFallback)', () => {
  const port = src('apps/bot/src/agent-model-port.ts');
  assert.ok(!port.includes('withPurposeFallback'), 'main 链不得改走 withPurposeFallback（P1 agent-model-port 现状即红线）');
});

/* ── 批 5 命令实测（表驱动）：/切换 各用途主/备切换、锁定、状态文案 ── */
const { createModelBindingService } = await import('../dist/apps/bot/src/model-binding.js');
const { createModelFallbackController } = await import('../dist/apps/bot/src/model-fallback.js');
const { parseOwnerCommand, MODEL_SWITCH_PURPOSE_WORDS } = await import('../dist/apps/bot/src/owner.js');

/** 11 个非 main 用途（与 MODEL_BINDING_PURPOSES 同源；main 的锁定走 setOverride）。 */
const COMMAND_PURPOSES = MODEL_BINDING_PURPOSES.filter((p) => p.key !== 'main');

function commandHarness() {
  const models = ['primary-model', ...COMMAND_PURPOSES.map((p) => `fb-${p.key}`)];
  const config = {
    agent: { mainNodeIndex: 0, mainModel: 'primary-model', fallbackModel: 'fb-main', fallbackNodeIndex: 0 },
    llm: { apiKeys: [{ name: '节点 1', baseUrl: 'https://a.test', key: 'k', enabled: true, models }] },
    orchestration: { suno: {}, memory: {} },
    codeRender: {},
    comfyuiTransform: {},
    bot: { tts: { preprocess: {} }, keywordTrigger: {} },
  };
  const controller = createModelFallbackController({ getConfig: () => config });
  const service = createModelBindingService({
    getConfig: () => config,
    onBindingChanged: (purpose) => controller.reset(purpose),
    runtimeStateText: (purpose) => controller.describe(purpose),
  });
  return { config, controller, service };
}

test('command: /切换 parses purpose + secondary slot for every purpose (含润色/enhance)', () => {
  const ctx = { chatType: 'private', botId: '10000' };
  for (const purpose of COMMAND_PURPOSES) {
    const word = MODEL_SWITCH_PURPOSE_WORDS.find((w) => purpose.keywords.includes(w) && w !== 'main');
    const parsed = parseOwnerCommand(`/切换 ${word} 备 fb-${purpose.key}`, ctx);
    assert.equal(parsed?.command, 'switchModel', `${word} 备 应解析为 switchModel`);
    assert.equal(parsed?.slot, 'secondary');
    assert.equal(parsed?.purpose, word);
    // 解析层既有口径：目标 token 小写化 + _→.（服务层 findModelCandidates 同规则匹配）。
    assert.equal(parsed?.code, `fb-${purpose.key}`.toLowerCase().replace(/_/g, '.'));
  }
  const lock = parseOwnerCommand('/切换 锁定 备', ctx);
  assert.equal(lock?.command, 'switchModelLock');
  assert.equal(lock?.slot, 'secondary');
  const status = parseOwnerCommand('/切换 状态', ctx);
  assert.equal(status?.command, 'switchModelStatus');
});

test('command: setBinding writes each purpose fallback into its own container fields', () => {
  const { config, service } = commandHarness();
  for (const purpose of COMMAND_PURPOSES) {
    const result = service.setBinding({ purpose: purpose.key, slot: 'secondary', target: `fb-${purpose.key}`, scope: 'persistent', source: 'command', actorId: '10001' });
    assert.equal(result.ok, true, `${purpose.key} 备用切换应成功：${result.ok ? '' : result.error}`);
    // 读回：必须落在该用途自己的容器字段里（与 UI roles.ts 表同源）。
    const obj = purpose.section.split('.').reduce((acc, key) => acc?.[key], config);
    assert.equal(String(obj[purpose.fallbackModelField]), `fb-${purpose.key}`, `${purpose.key} 备用模型写错容器/字段`);
    assert.equal(Number(obj[purpose.fallbackNodeField]), 0);
    assert.ok(result.reply.includes(purpose.label), '回复应带用途名');
  }
});

test('command: /切换 状态 shows 主｜备 for all 12 purposes with runtime slot text', async () => {
  const { config, controller, service } = commandHarness();
  // 先把 11 个用途的备用都配好（setBinding 已验证字段），粘滞态在 memory 用途上模拟。
  for (const purpose of COMMAND_PURPOSES) {
    service.setBinding({ purpose: purpose.key, slot: 'secondary', target: `fb-${purpose.key}`, scope: 'persistent', source: 'command', actorId: '10001' });
  }
  // 连续两次主模型失败 + 第三次调用 → 惰性转粘滞（粘滞在第三次 selectSlot 时落位，
  // 借 withPurposeFallback 驱动，走真实状态机路径；setBinding 已先行触发 reset 清零）。
  const invoke = async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); };
  for (let i = 0; i < 3; i += 1) {
    await withPurposeFallback(controller, 'memory', { nodeIndex: 0, model: 'primary-model' }, invoke).catch(() => undefined);
  }
  const text = service.getStatusText();
  assert.ok(text.includes('【模型绑定状态】'));
  for (const purpose of MODEL_BINDING_PURPOSES) {
    const fallbackModel = purpose.key === 'main' ? 'fb-main' : `fb-${purpose.key}`;
    assert.ok(text.includes(`${purpose.label}：主 `), `${purpose.label} 行缺失`);
    assert.ok(text.includes(`｜备 ${fallbackModel} @ `), `${purpose.label} 备用行缺失或错模型`);
  }
  // 粘滞文案：memory 行应显示「…备用（粘滞中，连续失败 N），约 Ns 后试探主模型」。
  assert.ok(/记忆摘要：.*粘滞中.*约 \d+s 后试探主模型/.test(text), 'memory 粘滞文案缺失');
  // 未受影响的用途仍是干净的「主模型」态。
  assert.ok(/提示词润色：.*（当前生效：主模型）/.test(text), 'enhance 应保持主模型态（计数不串）');
});

test('command: slot lock (锁定 备/解锁) is main-scoped and reflects in runtime text', () => {
  const { service } = commandHarness();
  const lock = service.setOverride({ slot: 'secondary', source: 'command', actorId: '10001' });
  assert.equal(lock.ok, true);
  const text = service.getStatusText();
  assert.ok(/主对话：.*（手动锁定：备用）/.test(text), '锁定后 main 行应显示手动锁定：备用');
  const unlock = service.setOverride({ slot: 'primary', source: 'command', actorId: '10001' });
  assert.equal(unlock.ok, true);
  assert.ok(/主对话：.*（当前生效：主模型）/.test(service.getStatusText()), '解锁后恢复自动（主模型）');
});

/* ── 方案 B（2026-11-06 拍板）：面板保存 → 绑定真变了 → onBindingChanged 同源清零 ── */
function reconcileHarness() {
  const config = {
    agent: { mainNodeIndex: 0, mainModel: 'primary-model', fallbackModel: 'fb-main', fallbackNodeIndex: 1 },
    llm: { chatNodeIndex: 0, chatModel: 'primary-model', imageModel: 'img-primary', fallbackImageModel: 'fb-image', fallbackImageNodeIndex: 1, apiKeys: [
      { name: 'N1', baseUrl: 'https://a.test', key: 'k', enabled: true, models: ['primary-model'] },
      { name: 'N2', baseUrl: 'https://b.test', key: 'k', enabled: true, models: ['fb-main', 'new-main', 'fb-image'] },
    ] },
    orchestration: { suno: {}, memory: {} },
    codeRender: {}, comfyuiTransform: {},
    bot: { tts: { preprocess: {} }, keywordTrigger: {} },
  };
  const controller = createModelFallbackController({ getConfig: () => config });
  const notifications = [];
  const service = createModelBindingService({
    getConfig: () => config,
    onBindingChanged: (purpose, slot) => { notifications.push([purpose, slot]); controller.reset(purpose); },
    runtimeStateText: (purpose) => controller.describe(purpose),
  });
  return { config, controller, service, notifications };
}

test('reconcile B: panel binding change routes through onBindingChanged and clears sticky immediately', async () => {
  const { config, controller, service, notifications } = reconcileHarness();
  // 前置：main 粘滞（3 次网络失败驱动，惰性转粘滞）。
  const invoke = async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); };
  for (let i = 0; i < 3; i += 1) {
    await withPurposeFallback(controller, 'main', { nodeIndex: 0, model: 'primary-model' }, invoke).catch(() => undefined);
  }
  assert.equal(controller.snapshot('main').stickyOnSecondary, true, '前置：粘滞中');
  // 面板路径：保存热重载后 reconcile 前后两份配置（主绑定换成 new-main——双写后的形态）。
  const next = JSON.parse(JSON.stringify(config));
  next.agent.mainModel = 'new-main'; next.agent.mainNodeIndex = 1;
  next.llm.chatModel = 'new-main'; next.llm.chatNodeIndex = 1;
  service.reconcileConfigChange(config, next);
  assert.deepEqual(notifications, [['main', 'primary']], '绑定变更应走 onBindingChanged 通道（与 /切换 同源）');
  const snap = controller.snapshot('main');
  assert.equal(snap.stickyOnSecondary, false, '面板切完立即解除粘滞（不等 120s 探测）');
  assert.equal(snap.consecutivePrimaryFailures, 0);
});

test('reconcile B: non-binding field changes never clear counters; per-purpose isolation holds', async () => {
  const { config, controller, service, notifications } = reconcileHarness();
  // image 计数 1（一次网络失败；harness 已配 image 备用，否则 bypass 不计数）。
  const invoke = async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); };
  await withPurposeFallback(controller, 'image', { nodeIndex: 0, model: 'img-primary' }, invoke).catch(() => undefined);
  assert.equal(controller.snapshot('image').consecutivePrimaryFailures, 1, '前置：image 计数 1');
  // 面板只改无关字段（llm.imageTimeoutMs）→ 不通知、不误清。
  const onlyTimeout = JSON.parse(JSON.stringify(config));
  onlyTimeout.llm.imageTimeoutMs = 90000;
  service.reconcileConfigChange(config, onlyTimeout);
  assert.equal(notifications.length, 0, '无关字段变化不得触发 onBindingChanged');
  assert.equal(controller.snapshot('image').consecutivePrimaryFailures, 1, '无关字段不得误清计数');
  // 面板只改 main 主绑定 → main 清零、image 计数保留（用途隔离）。
  const onlyMain = JSON.parse(JSON.stringify(config));
  onlyMain.agent.mainModel = 'new-main';
  service.reconcileConfigChange(config, onlyMain);
  assert.deepEqual(notifications, [['main', 'primary']]);
  assert.equal(controller.snapshot('image').consecutivePrimaryFailures, 1, 'main 的清零不得串到 image');
  // 面板改某用途备用（main fallback 换模型）→ ('main','secondary') 通知。
  const onlyFallback = JSON.parse(JSON.stringify(config));
  onlyFallback.agent.fallbackModel = 'fb-main-2';
  service.reconcileConfigChange(config, onlyFallback);
  assert.deepEqual(notifications.slice(-1), [['main', 'secondary']], '备用绑定变更也要通知对应用途');
});

test('reconcile B: start.ts wires hot-reload reconcile into getConfig (same channel as /切换)', () => {
  const start = src('apps/bot/src/start.ts');
  assert.ok(/reconcileConfigChange\(lastSyncedConfig, current\)/.test(start), 'getConfig 应在配置引用更替时调 reconcileConfigChange（面板热重载对账）');
  assert.ok(/buildBindingService\(\)\.reconcileConfigChange/.test(start), '对账必须走 ModelBindingService（与命令同一通知通道）');
});

/* ── 方案 C（2026-11-06 拍板）：面板主卡双写 chatModel，字段集与 /切换 逐字段一致 ── */
test('dual-write C: panel setMainBinding writes the exact field set of /切换 main+primary', () => {
  const roles = src('web-panel/src/shared/roles.ts');
  // 面板侧四字段（agent 双字段 + llm 双字段）。
  for (const field of ['agent.mainNodeIndex = nodeIndex', 'agent.mainModel = model', 'llm.chatNodeIndex = nodeIndex', 'llm.chatModel = model']) {
    assert.ok(roles.includes(field), `面板 setMainBinding 必须写 ${field}`);
  }
  const mb = src('apps/bot/src/model-binding.ts');
  // 命令侧 mutate main+primary 分支同样四字段（obj[purpose.nodeField/modelField] 对 main 即 agent.main*）。
  assert.ok(mb.includes('llm.chatModel = best.model') && mb.includes('llm.chatNodeIndex = targetNodeIndex'), '命令侧 main 双写 chatModel/chatNodeIndex');
  assert.ok(mb.includes('obj[purpose.nodeField] = targetNodeIndex') && mb.includes('obj[purpose.modelField] = best.model'), '命令侧主绑定写 agent.main*');
  assert.ok(!/slot === 'secondary'[\s\S]{0,200}chatModel/.test(mb), '命令切备不双写 chatModel——面板备用胶囊同口径');
});

test('dual-write C: no panel write path may set agent.main* without llm.chat* (guard against a third split)', () => {
  // 扫描 web-panel/src：唯一允许的 agent.main* 写入点是 roles.ts 的 setMainBinding（内部四字段同写）。
  const walk = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(vue|ts)$/.test(name)) out.push(full);
    }
    return out;
  };
  const panelRoot = path.join(root, 'web-panel/src');
  const offenders = [];
  for (const file of walk(panelRoot)) {
    if (file.replaceAll('\\', '/').endsWith('shared/roles.ts')) continue; // setMainBinding 本体（四字段）
    const source = readFileSync(file, 'utf8');
    // 直写形态：v-model 双向绑定（= 写入）或赋值语句，只碰 agent.mainModel/mainNodeIndex 而不经 setMainBinding。
    if (/v-model(?::[\w-]+)?="agent\.main(?:Model|NodeIndex)"/.test(source) || /agent\.main(?:Model|NodeIndex)\s*=/.test(source)) {
      offenders.push(file.replaceAll('\\', '/').split('web-panel/src/')[1]);
    }
  }
  assert.deepEqual(offenders, [], '面板写主绑定必须走 setMainBinding（agent.main* + llm.chat* 四字段同写）；不允许再出现只写 agent.* 的分裂入口');
});

test('dual-write C: AgentPage holds no main-binding entry (sole entry = ModelsPage main card via setMainBinding)', () => {
  const agentPage = src('web-panel/src/pages/AgentPage.vue');
  assert.ok(!agentPage.includes('setMainBinding'), 'AgentPage 已移除主绑定入口：不得再引用 setMainBinding');
  assert.ok(!/v-model(?::[\w-]+)?="agent\.main/.test(agentPage), 'AgentPage 不得再用 v-model 直写 agent.main*');
  assert.ok(!/agent\.main(?:Model|NodeIndex)\s*=/.test(agentPage), 'AgentPage 不得包含 agent.main* 赋值（重复入口，唯一来源是「模型与节点」主卡）');
});

test('dual-write C: chatModel consumers follow the panel switch (trigger fallback + prompt.enhance)', async () => {
  const { TriggerIntentChecker } = await import('../dist/apps/bot/src/trigger-intent.js');
  const { PromptCapabilityHandler } = await import('../dist/apps/bot/src/capability-basic.js');
  // 面板双写后的配置形态（setMainBinding 字段集已由上锁死）：agent.mainModel === llm.chatModel === 'new-main'。
  const cfg = {
    agent: { mainNodeIndex: 1, mainModel: 'new-main' },
    llm: { chatNodeIndex: 1, chatModel: 'new-main', apiKeys: [{ name: 'N2', baseUrl: 'https://b.test', key: 'k', enabled: true, models: ['new-main'] }] },
    bot: { keywordTrigger: { intentModel: '' } },
  };
  const calls = [];
  const client = { async chat(nodeIndex, req) { calls.push({ nodeIndex, model: req.model }); return { text: '{"intent": true}' }; } };
  // ① 触发判定回落位：intentModel 空 → 读 cfg.llm.chatModel（trigger-intent.ts chatNode 回落）。
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client });
  await checker.checkKeywordIntent({ userText: 'hi', userName: 'u', context: '', triggerWord: 't' });
  assert.equal(calls[0].model, 'new-main', '面板切换后，触发判定回落位必须用上新模型');
  assert.equal(calls[0].nodeIndex, 1);
  // ② prompt.enhance 能力：读 cfg.llm.chatModel（capability-basic.ts PromptCapabilityHandler）。
  const handler = new PromptCapabilityHandler(client, () => cfg, 'enhance');
  await handler.execute({ plan: { planId: 'p1' }, step: { id: 's1', args: { prompt: 'x' } }, request: { text: 'x' } });
  assert.equal(calls[1].model, 'new-main', '面板切换后，prompt.enhance 能力必须用上新模型');
  assert.equal(calls[1].nodeIndex, 1);
});
