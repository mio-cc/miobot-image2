import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplyPreferenceStore } from '../dist/apps/bot/src/reply-preference-store.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('reply-policy R6b: preference store persists records and enforces TTL', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-reply-pref-'));
  const file = path.join(dir, 'preferences.json');
  let now = new Date('2026-10-26T12:00:00.000Z');
  const clock = () => now;
  const store = new ReplyPreferenceStore({ filePath: file, clock });
  store.set('session', 'private:1', { voice: 'off', forwardStyle: 'flat' }, 1_000);
  store.set('user', '1', { mode: 'forward', reference: 'none' }, 0);
  assert.deepEqual(store.get('session', 'private:1'), { voice: 'off', forwardStyle: 'flat' });
  assert.deepEqual(store.get('user', '1'), { mode: 'forward', reference: 'none' });
  const restarted = new ReplyPreferenceStore({ filePath: file, clock });
  assert.deepEqual(restarted.get('user', '1'), { mode: 'forward', reference: 'none' });
  now = new Date('2026-10-26T12:00:02.000Z');
  assert.equal(restarted.get('session', 'private:1'), undefined);
  assert.deepEqual(restarted.get('user', '1'), { mode: 'forward', reference: 'none' });
  await fs.rm(dir, { recursive: true, force: true });
});

test('reply-policy R6b: user-scoped preference applies across sessions and respects allowUserPreferences', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.allowUserPreferences = true;
  cfg.replyPolicy.defaultVoice = 'on';
  const store = new ReplyPreferenceStore();
  let calls = 0;
  const host = createAgentHost({
    getConfig: () => cfg,
    replyPreferenceStore: store,
    client: { async chat() { calls += 1; return { text: `回复 ${calls}`, raw: {} }; } },
  });
  const first = await host({
    text: '第一次',
    chatType: 'private',
    userId: '1',
    sessionId: 'private:a',
    replyPreference: { scope: 'user', voice: 'off', forwardStyle: 'flat' },
  });
  assert.equal(first.replyPlan.policy.voice, 'off');
  assert.equal(first.replyPlan.policy.forwardStyle, 'flat');

  const second = await host({ text: '另一个会话', chatType: 'private', userId: '1', sessionId: 'private:b' });
  assert.equal(second.replyPlan.policy.voice, 'off');
  assert.equal(second.replyPlan.policy.forwardStyle, 'flat');

  cfg.replyPolicy.allowUserPreferences = false;
  const third = await host({ text: '禁用了用户偏好', chatType: 'private', userId: '1', sessionId: 'private:c' });
  assert.equal(third.replyPlan.policy.voice, 'on');
});

test('reply-policy R6b: turn scope is one-shot while default scope persists per session', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.allowSessionPreferences = true;
  cfg.replyPolicy.defaultVoice = 'on';
  const store = new ReplyPreferenceStore();
  let calls = 0;
  const host = createAgentHost({
    getConfig: () => cfg,
    replyPreferenceStore: store,
    client: { async chat() { calls += 1; return { text: `回复 ${calls}`, raw: {} }; } },
  });
  const oneShot = await host({
    text: '只本轮',
    chatType: 'private',
    userId: '2',
    sessionId: 'private:turn',
    replyPreference: { scope: 'turn', voice: 'off' },
  });
  assert.equal(oneShot.replyPlan.policy.voice, 'off');
  const nextTurn = await host({ text: '下一轮', chatType: 'private', userId: '2', sessionId: 'private:turn' });
  assert.equal(nextTurn.replyPlan.policy.voice, 'on');

  const sessionFirst = await host({
    text: '会话偏好',
    chatType: 'private',
    userId: '3',
    sessionId: 'private:session',
    replyPreference: { scope: 'session', voice: 'off', forwardStyle: 'flat' },
  });
  assert.equal(sessionFirst.replyPlan.policy.voice, 'off');
  const sessionNext = await host({ text: '继续', chatType: 'private', userId: '3', sessionId: 'private:session' });
  assert.equal(sessionNext.replyPlan.policy.voice, 'off');
  assert.equal(sessionNext.replyPlan.policy.forwardStyle, 'flat');
});
