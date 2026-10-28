import test from 'node:test';
import assert from 'node:assert/strict';

const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { resolveReplyPolicy, textCharsOf } = await import('../dist/packages/orchestration/src/reply-policy.js');
const { WebFetchCapabilityHandler } = await import('../dist/apps/bot/src/capability-web-fetch.js');
const { importConfig } = await import('../dist/packages/config/src/index.js');

// ═══ R16/F-3：群级覆盖链（turn > 窗口 > user > 群 > 后台默认）═══

test('R16/F-3: group preference fills in between user and backend default', async () => {
  const cfg = createDefaultConfig();
  cfg.replyPolicy.enabled = true;
  cfg.bot.replyStrategies.text = 'forward';
  cfg.bot.groupOverrides = {
    '3000': { replyMode: 'quote', voice: 'on' },
  };
  const base = resolveReplyPolicy({ config: cfg, textChars: 10 });
  assert.equal(base.policy.mode, 'forward', '无群无偏好：走后台默认 forward');
  const inGroup = resolveReplyPolicy({ config: cfg, textChars: 10, groupPreference: { mode: 'quote', voice: 'on' } });
  assert.equal(inGroup.policy.mode, 'quote', '群覆盖应替代后台默认');
  assert.equal(inGroup.policy.voice, 'on', '群 voice 覆盖生效');
  const otherGroup = resolveReplyPolicy({ config: cfg, textChars: 10, groupPreference: undefined });
  assert.equal(otherGroup.policy.mode, 'forward', '无群覆盖回后台默认');
  // user 压过群
  const userWins = resolveReplyPolicy({ config: cfg, textChars: 10, userPreference: { mode: 'plain' }, groupPreference: { mode: 'quote' } });
  assert.equal(userWins.policy.mode, 'plain', '用户偏好必须压过群默认（F-3 裁定链）');
  const turnWins = resolveReplyPolicy({ config: cfg, textChars: 10, turnPreference: { mode: 'direct' }, groupPreference: { mode: 'quote' }, sessionPreference: { mode: 'plain' } });
  assert.equal(turnWins.policy.mode, 'direct', 'turn 压过一切');
});

test('R16/F-3: groupOverrides normalization only accepts whitelisted keys', () => {
  const cfg = createDefaultConfig();
  const raw = {
    bot: {
      groupOverrides: {
        '': { replyMode: 'forward' },
        '3000': { replyMode: 'bogus-mode', voice: 'on' },
        '4000': { replyMode: 'plain', persona: { name: '阿福', systemPrompt: '你是阿福。' } },
      },
    },
  };
  const result = importConfig(raw);
  const overrides = result.config.bot.groupOverrides;
  assert.equal(overrides[''], undefined, '空群号丢弃');
  assert.equal(overrides['3000'].replyMode, undefined, '非法枚举丢弃');
  assert.equal(overrides['3000'].voice, 'on');
  assert.equal(overrides['4000'].replyMode, 'plain');
  assert.equal(overrides['4000'].persona.name, '阿福');
  assert.equal(overrides['4000'].persona.systemPrompt, '你是阿福。');
});

// ═══ R16/5.3：web.fetch ═══

test('R16/web.fetch: static page extraction + degraded suggestions for empty content', async (t) => {
  const html = '<html><head><title>测试页</title></head><body><script>alert(1)</script>' + '<p>这是一段足够长的正文内容。'.repeat(30) + '</p></body></html>';
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (url) => ({ ok: true, status: 200, text: async () => html }));
  const handler = new WebFetchCapabilityHandler({});
  const res = await handler.execute({ url: 'https://example.test/page' }, {});
  assert.ok(res.text.includes('测试页'), '标题应带出');
  assert.ok(res.text.length > 200, '正文抽取应保留内容');
  assert.ok(!res.text.includes('<script'), '脚本应被剥除');
  // 近空正文 → 返回换路建议而不是静默失败（S-1 闭环）
  globalThis.fetch = (async (url) => ({ ok: true, status: 200, text: async () => '<html><body><div></div></body></html>' }));
  const empty = await handler.execute({ url: 'https://example.test/spa' }, {});
  assert.ok(empty.text.includes('正文为空或过短') || empty.text.includes('动态页面'), '近空正文应给结构化换路建议');
});

test('R16/web.fetch: SSRF gate blocks private hosts', async () => {
  const handler = new WebFetchCapabilityHandler({});
  await assert.rejects(
    () => handler.execute({ url: 'http://127.0.0.1:8080/admin' }, {}),
    { message: /内网|private|internal|blocked|拒绝/i },
  );
  await assert.rejects(
    () => handler.execute({ url: 'http://localhost/x' }, {}),
    { message: /内网|private|internal|blocked|拒绝/i },
  );
});