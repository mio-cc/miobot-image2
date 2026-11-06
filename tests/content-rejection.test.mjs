import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * 内容审核污染治理（方案 1/2/3/D，2026-11-06 拍板）。
 * 1. 被拒登记 → 群历史占位剥离（保留说话人与时序）→ 修复重试成功，一条完整链路；
 * 2. 记忆侧：被拒消息精确单删 + 摘要/检索输入侧排除；
 * 3. 网络类失败绝不进入登记与剥离（反例钉死）；
 * 4. D 顺序：主拒备拒 → 修复一次 → 重试一次；修复调用恒为 1（缓存）；
 * 5. 探针失败 → 降级纯占位剥离；
 * 6. sanitize 用途表驱动（绑定/备用/命令/面板字段）；
 * 7. Suno 400 审核识别 → 修复歌词 → 显式新一次提交（成功/仍失败两分支）。
 */

const {
  createContentRejectionRegistry, hashRejectionContent, CONTENT_REJECTION_PLACEHOLDER,
} = await import('../dist/apps/bot/src/content-rejection.js');
const {
  wrapModelPortWithContentRepair, createSanitizeCall, CONTENT_REJECTION_EXHAUSTED_PREFIX,
  CONTENT_REJECTION_EXHAUSTED_NOTICE, SANITIZE_PROBE_SAMPLE, SUNO_LYRICS_SYSTEM_HINT,
} = await import('../dist/apps/bot/src/content-repair.js');
const { buildGroupContext } = await import('../dist/apps/bot/src/group-context.js');
const { ChatMemoryService } = await import('../dist/apps/bot/src/memory-service.js');
const { SunoCapabilityHandler, isSunoModerationRejection } = await import('../dist/apps/bot/src/capability-suno.js');
const { MODEL_BINDING_PURPOSES } = await import('../dist/apps/bot/src/model-binding.js');

/** 实测事故形态的审核错误（与 model-fallback.test.mjs 同构，见 shared.ts empty_choices 分支）。 */
const moderationError = () => Object.assign(
  new Error('上游返回了空 choices："data: {\\"error\\":{\\"message\\":\\"The request contains sensitive content. Please modify your input and try again.\\",\\"type\\":\\"content_check_error\\",\\"code\\":\\"content_check_rejected\\"}}"'),
  { category: 'upstream', retryable: false, code: 'empty_choices' },
);
const netError = () => Object.assign(new Error('HTTP 503'), { status: 503, category: 'upstream', retryable: true });

function makePort(scripts) {
  const calls = [];
  const port = {
    modelMeta: 'kept-by-proxy',
    async chat(req) {
      calls.push(req);
      const step = scripts.shift();
      if (!step) throw netError();
      if (step.throw) throw step.throw;
      return { assistant: { text: step.text || 'ok' } };
    },
  };
  return { port, calls };
}

const userRequest = () => ({ messages: [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '这条消息很敏感会被拒' },
], tools: [] });

/** 探针/修复分流的 fake sanitize：探针样本走 probeResult，其余计为修复调用。
 *  注意 probeCalls 必须以函数暴露（闭包 let 直接放返回对象会是创建时的快照 0）。 */
function makeSanitizer({ rewrite = '改写后的含蓄说法', probeResult = '探针改写结果' } = {}) {
  const repairCalls = [];
  let probeCalls = 0;
  const fn = async (input) => {
    if (input === SANITIZE_PROBE_SAMPLE) {
      probeCalls += 1;
      if (typeof probeResult === 'string' && probeResult !== '__throw__') return probeResult;
      if (probeResult === '__throw__') throw new Error('sanitize provider down');
      return probeResult; // null → 探针失败
    }
    repairCalls.push(input);
    if (rewrite === '__throw__') throw new Error('repair failed');
    return rewrite;
  };
  return { fn, repairCalls, probeCalls: () => probeCalls };
}

/* ── 3. 反例：网络类失败绝不进入登记与剥离 ── */
test('content pipeline: network failures never enter registry or stripping (反例钉死)', async () => {
  const registry = createContentRejectionRegistry({});
  const { port, calls } = makePort([{ throw: netError() }]);
  const wrapped = wrapModelPortWithContentRepair(port, { registry, sanitize: makeSanitizer().fn });
  await assert.rejects(() => wrapped.chat(userRequest()), /HTTP 503/);
  assert.equal(calls.length, 1, '网络错误不得触发任何重试');
  assert.equal(registry.size(), 0, '网络错误不得写入登记表');
});

/* ── 4. D 顺序：审核拒绝 →（切备已在 port 内发生）→ 修复一次 → 重试一次 ── */
test('content repair D: moderation rejection repairs once and retries with rewritten culprit', async () => {
  const registry = createContentRejectionRegistry({});
  const sanitize = makeSanitizer({ rewrite: '改写后的含蓄说法' });
  const { port, calls } = makePort([{ throw: moderationError() }, { text: 'rescued' }]);
  const wrapped = wrapModelPortWithContentRepair(port, { registry, sanitize: sanitize.fn });
  const res = await wrapped.chat(userRequest());
  assert.equal(res.assistant.text, 'rescued', '修复重试后应成功');
  assert.equal(sanitize.repairCalls.length, 1, '修复调用恰好一次');
  assert.equal(calls[1].messages[1].content, '改写后的含蓄说法', '重试请求用改写版替换疑似元凶（旁挂映射）');
  assert.equal(calls[0].messages[1].content, '这条消息很敏感会被拒', '原始请求的原文不动（留痕在首次请求里）');
  const entry = registry.entryOf('这条消息很敏感会被拒');
  assert.equal(entry?.rewrite, '改写后的含蓄说法', '改写结果按原文 hash 缓存进登记表');
});

test('content repair D: still rejected after repair → register + explicit user notice, repair count stays 1', async () => {
  const registry = createContentRejectionRegistry({});
  const sanitize = makeSanitizer({ rewrite: '改写后的含蓄说法' });
  const { port, calls } = makePort([{ throw: moderationError() }, { throw: moderationError() }]);
  const wrapped = wrapModelPortWithContentRepair(port, { registry, sanitize: sanitize.fn });
  await assert.rejects(() => wrapped.chat(userRequest()), (error) => String(error.message).startsWith(CONTENT_REJECTION_EXHAUSTED_PREFIX), '仍拒必须抛可识别的告知错误');
  assert.ok(registry.entryOf('这条消息很敏感会被拒'), '仍拒必须登记原文（供下一轮剥离+记忆清理）');
  // 第二次同内容请求：改写缓存命中 → 不再调修复模型，重试后仍拒 → 修复调用恒为 1。
  const { port: port2, calls: calls2 } = makePort([{ throw: moderationError() }, { throw: moderationError() }]);
  const wrapped2 = wrapModelPortWithContentRepair(port2, { registry, sanitize: sanitize.fn });
  await assert.rejects(() => wrapped2.chat(userRequest()));
  assert.equal(sanitize.repairCalls.length, 1, '同类内容二次命中缓存，修复模型调用恒为 1');
  assert.equal(calls2[1].messages[1].content, '改写后的含蓄说法', '缓存命中的重试仍使用改写版');
  assert.equal(calls2.length, 2, '绝不再递归修复（每请求只允许一次重试）');
});

test('content repair D: primary succeeds directly → zero repair calls (备过审/正常时不触发)', async () => {
  const registry = createContentRejectionRegistry({});
  const sanitize = makeSanitizer();
  const { port, calls } = makePort([{ text: 'fine' }]);
  const wrapped = wrapModelPortWithContentRepair(port, { registry, sanitize: sanitize.fn });
  const res = await wrapped.chat(userRequest());
  assert.equal(res.assistant.text, 'fine');
  assert.equal(calls.length, 1);
  assert.equal(sanitize.repairCalls.length, 0, '成功请求零修复调用');
  assert.equal(registry.size(), 0);
});

/* ── 5. 探针失败 → 降级纯剥离 ── */
test('content repair D: probe failure degrades to placeholder-only retry (no repair model call)', async () => {
  const registry = createContentRejectionRegistry({});
  const sanitize = makeSanitizer({ probeResult: '__throw__' });
  const { port, calls } = makePort([{ throw: moderationError() }, { text: 'rescued by placeholder' }]);
  const wrapped = wrapModelPortWithContentRepair(port, { registry, sanitize: sanitize.fn });
  const res = await wrapped.chat(userRequest());
  assert.equal(res.assistant.text, 'rescued by placeholder');
  assert.equal(sanitize.repairCalls.length, 0, '探针降级后绝不能调修复模型');
  assert.equal(sanitize.probeCalls(), 1, '探针只做一次');
  assert.equal(calls[1].messages[1].content, CONTENT_REJECTION_PLACEHOLDER, '降级路径用占位符替换元凶');
});

test('content repair D: probe failure on second request still degrades (process-level latch)', async () => {
  const registry = createContentRejectionRegistry({});
  const sanitize = makeSanitizer({ probeResult: null });
  const { port, calls } = makePort([{ throw: moderationError() }, { throw: moderationError() }]);
  const wrapped = wrapModelPortWithContentRepair(port, { registry, sanitize: sanitize.fn });
  await assert.rejects(() => wrapped.chat(userRequest()));
  assert.equal(sanitize.probeCalls(), 1, '降级闩锁后不再重复探针');
  assert.equal(sanitize.repairCalls.length, 0);
  assert.equal(calls[1].messages[1].content, CONTENT_REJECTION_PLACEHOLDER);
});

/* ── 1. 完整链路：登记 → 群历史占位（保留说话人与时序）── */
test('content pipeline: registered message is masked in group history with speaker and order intact', () => {
  const registry = createContentRejectionRegistry({});
  registry.register({ text: '敏感原文', messageId: '111', reason: 'moderation' });
  const messages = [
    { message_id: 111, user_id: '100', sender: { user_id: '100', nickname: '甲' }, message: [{ type: 'text', data: { text: '敏感原文' } }] },
    { message_id: 222, user_id: '200', sender: { user_id: '200', nickname: '乙' }, message: [{ type: 'text', data: { text: '正常消息' } }] },
  ];
  const ctx = buildGroupContext({
    messages,
    options: { messageCount: 10, maxChars: 4000, skipForward: true, includeImages: false },
    isRejected: (msg) => registry.isRejected({ messageId: String(msg.message_id ?? '') }),
    placeholder: CONTENT_REJECTION_PLACEHOLDER,
  });
  const lines = ctx.split('\n');
  assert.equal(lines.length, 2, '占位不删行：说话人与时序都保留');
  assert.ok(lines[0].includes('甲'), '被拒行保留说话人');
  assert.ok(lines[0].includes(CONTENT_REJECTION_PLACEHOLDER), '被拒行正文替换为占位符');
  assert.ok(!lines[0].includes('敏感原文'), '被拒原文不得回流');
  assert.ok(lines[1].includes('乙') && lines[1].includes('正常消息'), '其余消息原样保留');
});

/* ── 2. 记忆侧：精确单删 + 检索/摘要输入侧排除 ── */
test('content memory: rejected message is excluded from retrieval, summary input, and purgeable by messageId', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-rejection-'));
  try {
    const registry = createContentRejectionRegistry({});
    const dimensions = 4;
    const memoryConfig = {
      enabled: true, autoIngest: true, summarizeEvery: 2, retentionDays: 7,
      embeddingModel: 'fake-embed', embeddingDimensions: dimensions, embeddingNodeIndex: 0,
      recentTurns: 0, hybridSearch: false, userGlobalProfileEnabled: false, dataDir: dir,
    };
    const summarizeInputs = [];
    const service = new ChatMemoryService({
      rootDir: dir,
      getConfig: () => ({ llm: { apiKeys: [{ name: 'N', baseUrl: 'https://x', key: 'k', enabled: true, models: [] }] }, orchestration: { memory: memoryConfig }, contextPolicy: { memoryTopK: 10, memoryMinScore: 0, memoryMaxChars: 4000 } }),
      embedding: { model: 'fake-embed', dimensions, embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4]) },
      isRejectedMessageId: (id) => registry.isRejected({ messageId: id }),
      summarize: async ({ messages }) => { summarizeInputs.push(messages); return '摘要内容'; },
    });
    // 先登记再入库：真实时序是「入库（路由前观察）→ 模型拒绝 → 登记」，这里把登记前置以稳定测试——
    // isRejectedMessageId 只过滤检索/摘要/巩固，不影响 ingest，坏消息仍会入库（removeByMessageId 的前提）。
    registry.register({ text: '坏消息内容原文', messageId: 'bad-1', reason: 'moderation' });
    await service.ingest({ botId: 'b', chatType: 'group', groupId: 'g', userId: '100', authorName: '甲', role: 'user', text: '坏消息内容', messageId: 'bad-1' });
    await service.ingest({ botId: 'b', chatType: 'group', groupId: 'g', userId: '200', authorName: '乙', role: 'user', text: '好消息内容', messageId: 'ok-1' });
    // 检索输入侧：被拒消息不得从记忆库回流（删除清理前的双保险）。
    const retrieved = await service.retrieve({ botId: 'b', chatType: 'group', groupId: 'g', userId: '100', query: '消息内容' });
    assert.ok(!retrieved.hits.some((hit) => hit.messageId === 'bad-1'), '被拒消息不得出现在检索结果');
    assert.ok(retrieved.hits.some((hit) => hit.messageId === 'ok-1'), '正常消息保留');
    // 摘要输入侧：滚动摘要的输入不含被拒内容（一旦洗进摘要就追不回）。
    await service.ingest({ botId: 'b', chatType: 'group', groupId: 'g', userId: '300', authorName: '丙', role: 'user', text: '第三条消息', messageId: 'ok-2' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const messages of summarizeInputs) {
      assert.ok(!messages.some((m) => m.messageId === 'bad-1'), '摘要输入不得包含被拒消息');
    }
    // 精确单删：按 messageId 反查删除（复用 remove(db, id) 路径）。
    const removed = await service.removeByMessageId('bad-1');
    assert.ok(removed >= 1, '按 messageId 精确删除应至少删掉一条（多 namespace 副本）');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/* ── 6. sanitize 用途表驱动：绑定/备用/命令/面板字段一条不落 ── */
test('sanitize purpose D: full wiring (table + command words + panel row + repair pipeline constant)', async () => {
  const def = MODEL_BINDING_PURPOSES.find((p) => p.key === 'sanitize');
  assert.ok(def, '用途表必须有 sanitize（第 13 行）');
  assert.equal(def.section, 'llm');
  assert.equal(def.nodeField, 'sanitizeNodeIndex');
  assert.equal(def.modelField, 'sanitizeModel');
  assert.equal(def.fallbackNodeField, 'fallbackSanitizeNodeIndex');
  assert.equal(def.fallbackModelField, 'fallbackSanitizeModel');
  // 修复管线的 purpose 常量显式（防接串）。
  const repairSource = readFileSync(path.resolve('apps/bot/src/content-repair.ts'), 'utf8');
  assert.ok(repairSource.includes(`withPurposeFallback(fallback, 'sanitize'`), '修复调用必须显式 purpose = \'sanitize\'');
  // 面板 ROLES 行（主绑定 + 备用字段 + 同源提示）。
  const roles = readFileSync(path.resolve('web-panel/src/shared/roles.ts'), 'utf8');
  assert.ok(roles.includes("key: 'sanitize'") && roles.includes('sanitizeNodeIndex') && roles.includes('fallbackSanitizeNodeIndex'), '面板 ROLES 需有 sanitize 行');
  assert.ok(roles.includes('与主模型不同提供商'), '面板行需明示「选与主模型不同提供商」（同源审核坑）');
  // createSanitizeCall：sanitizeModel 空 → 返回 null（修复关闭，降级占位剥离）。
  const client = { async chat() { throw new Error('must not be called'); } };
  const call = createSanitizeCall(client, () => ({ llm: { sanitizeModel: '', sanitizeNodeIndex: 0 } }), undefined);
  assert.equal(await call('任何内容'), null, 'sanitizeModel 空 = 不启用修复');
});

/* ── 7. Suno：400 审核识别 → 修复歌词 → 显式新一次提交（成功 / 仍失败两分支）── */
test('suno moderation: isSunoModerationRejection classification', () => {
  assert.ok(isSunoModerationRejection('suno_http_400:{"error":{"message":"歌词包含敏感内容"}}'));
  assert.ok(isSunoModerationRejection('suno_http_400:The request contains sensitive content'));
  assert.ok(!isSunoModerationRejection('suno_http_400:invalid request params'), '普通参数 400 不得误判为审核');
  assert.ok(!isSunoModerationRejection('suno_http_500:server error'));
  assert.ok(!isSunoModerationRejection('suno_queue_full'));
});

function sunoHandler(createImpl, repairLyrics) {
  const createCalls = [];
  const client = {
    create: async (input) => { createCalls.push(input.lyrics); return createImpl(createCalls.length, input); },
    wait: async () => ({ status: 'success', outputs: [{ url: 'https://x/1.mp3', audioId: 'a1', title: 't', lyrics: 'l', duration: 60 }] }),
    get: async () => ({ status: 'success', raw: {} }),
  };
  const handler = new SunoCapabilityHandler({
    getConfig: () => ({ orchestration: { suno: { enabled: true, baseUrl: 'https://s', apiKey: 'k', model: 'm', timeoutMs: 60000, maxRetries: 0, quotaPerUserPerDay: 0, maxConcurrent: 4, callbackUrl: '' } } }),
    createClient: () => client,
    ...(repairLyrics ? { repairLyrics } : {}),
  });
  return { handler, createCalls };
}

const sunoInvocation = () => ({
  plan: { planId: 'p1' },
  step: { id: 's1', args: { lyrics: '敏感歌词段落', request: '写一首歌' } },
  request: { text: '写一首歌', user: { qq: '1' }, chat: { type: 'private' } },
  reportExternalTask: () => undefined,
});

test('suno moderation: 400 → repair lyrics → explicit resubmit succeeds (withRetry 4xx 语义保留)', async () => {
  const repairs = [];
  const { handler, createCalls } = sunoHandler(
    (attempt) => (attempt === 1
      ? Promise.reject(new Error('suno_http_400:{"error":{"message":"歌词包含敏感内容"}}'))
      : Promise.resolve({ id: 'task-1' })),
    async ({ lyrics }) => { repairs.push(lyrics); return '改写后的安全歌词'; },
  );
  const result = await handler.execute(sunoInvocation());
  assert.equal(result.status, 'success', '修复后二次提交成功');
  assert.equal(createCalls.length, 2, '显式新一次提交（不是盲目重试）');
  assert.deepEqual(repairs, ['敏感歌词段落'], '修复模型只收到原歌词一次');
  assert.equal(createCalls[1], '改写后的安全歌词', '第二次提交用改写版歌词');
});

test('suno moderation: repair still rejected → explicit failed with user-visible advice (not raw 400 body)', async () => {
  const { handler, createCalls } = sunoHandler(
    () => Promise.reject(new Error('suno_http_400:{"error":{"message":"歌词包含敏感内容"}}')),
    async () => '改写后的安全歌词',
  );
  const result = await handler.execute(sunoInvocation());
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'suno_lyrics_moderation_rejected');
  assert.equal(createCalls.length, 2, '修复只再提交一次，绝不循环');
  const text = String(result.outputs?.[0]?.text || '');
  assert.ok(text.includes('内容审核') && text.includes('建议'), '用户可见文案要说明审核原因并给出可操作建议');
  assert.ok(!text.includes('suno_http_400'), '不得把原始 400 体甩给用户');
});

test('suno moderation: 400 without repairLyrics keeps legacy behavior (structured failure, no repair)', async () => {
  const { handler, createCalls } = sunoHandler(() => Promise.reject(new Error('suno_http_400:{"error":{"message":"歌词包含敏感内容"}}')));
  const result = await handler.execute(sunoInvocation());
  // 现行为：外层 catch 把 400 转成结构化 failed；无修复回调 → 只提交一次、不隐藏错误语义。
  assert.equal(result.status, 'failed');
  assert.ok(String(result.error || '').includes('suno_http_400'), '未注入修复时保持现行为（结构化失败而非吞掉）');
  assert.equal(createCalls.length, 1, '无修复回调绝不二次提交');
});

/* ── 二分裁切（2026-11-06 二轮，升级路径②）：改写/占位重试仍拒 → 逐段二分定位元凶 ── */
test('content bisect: repair retry still rejected → bisect locates culprit segment (≤4 probes), register + masked retry succeeds', async () => {
  const registry = createContentRejectionRegistry({});
  const CULPRIT = '第四段藏着敏感触发词X的内容';
  const segments = ['第一段正常。', '第二段正常。', '第三段正常。', CULPRIT, '第五段正常。', '第六段正常。', '第七段正常。', '第八段正常。'];
  const longText = segments.join('\n\n');
  const calls = [];
  const port = {
    async chat(req) {
      calls.push(req);
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user.content === 'string' ? user.content : '';
      if (text.includes('X')) throw moderationError();
      return { assistant: { text: 'ok' } };
    },
  };
  const sanitize = makeSanitizer({ rewrite: `改写后但仍带触发词X的版本` });
  const wrapped = wrapModelPortWithContentRepair(port, {
    registry,
    sanitize: sanitize.fn,
    bisectEnabled: () => true,
  });
  const res = await wrapped.chat({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: longText }], tools: [] });
  assert.equal(res.assistant.text, 'ok', '二分剥离段落后重试成功');
  const probes = calls.filter((c) => c.maxTokens === 64);
  assert.ok(probes.length >= 3 && probes.length <= 4, `二分探测必须收敛且 ≤4 次（实际 ${probes.length}）`);
  assert.ok(registry.entryOf(CULPRIT), '定位到的元凶段必须登记（供下一轮装配剥离）');
  const bisectRetry = calls[calls.length - 1];
  const retryText = String(bisectRetry.messages.find((m) => m.role === 'user').content);
  assert.ok(!retryText.includes('X'), '剥离重试不得再含元凶段');
  assert.ok(retryText.includes('第三段正常。') && retryText.includes('第五段正常。'), '其余段落保留');
});

test('content bisect: switch off → skip bisect and go straight to exhausted', async () => {
  const registry = createContentRejectionRegistry({});
  const calls = [];
  const port = {
    async chat(req) {
      calls.push(req);
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user.content === 'string' ? user.content : '';
      if (text.includes('X')) throw moderationError();
      return { assistant: { text: 'ok' } };
    },
  };
  const sanitize = makeSanitizer({ rewrite: '改写后仍带触发词X的版本' });
  const wrapped = wrapModelPortWithContentRepair(port, { registry, sanitize: sanitize.fn, bisectEnabled: () => false });
  await assert.rejects(() => wrapped.chat({ messages: [{ role: 'user', content: ['a', 'b', 'c', '带X的段'].join('\n\n') }], tools: [] }), (error) => String(error.message).startsWith('content_rejection_exhausted:'));
  assert.equal(calls.length, 2, '开关关闭：零探测调用（原请求 + 修复重试各一次）');
});
