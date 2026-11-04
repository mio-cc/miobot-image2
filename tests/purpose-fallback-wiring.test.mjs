import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
