import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 错误首诊通道（2026-11-06 二轮）：分类表驱动——progress 不算错误、规则类零调用、真失败首诊一次；
 * 副模型自身失败 → 用户侧规则兜底 + 管理员私聊（problemReporter）+ content.repair.self_failed 日志。
 */

const { createErrorTriage, TRIAGE_FALLBACK_NOTICE } = await import('../dist/apps/bot/src/error-triage.js');

function makeTriage({ sanitizeImpl, cfg } = {}) {
  const calls = [];
  const problems = [];
  const logs = [];
  const triage = createErrorTriage({
    getConfig: () => cfg ?? { llm: { sanitizeModel: 'san-model' }, bot: { errorTriage: { enabled: true, cooldownMinutes: 10, hourlyLimit: 20, customRules: [] } } },
    sanitize: async (input, opts) => { calls.push({ input, opts }); return sanitizeImpl ? sanitizeImpl(input, opts) : '{"actionable": true, "action": "explain", "userNotice": "上游网络暂时不稳定，稍后再试一下。"}'; },
    reportProblem: async (input) => { problems.push(input); },
    logger: { info: (m, d) => logs.push([m, d]), warn: (m, d) => logs.push([m, d]) },
  });
  return { triage, calls, problems, logs };
}

/* ── 1. 进度反例：长任务等待/排队/心跳绝不进首诊（Suno 出歌、ComfyUI/视频/代码画图等待提示）── */
test('triage: progress-like waits never enter triage (反例钉死)', async () => {
  const { triage, calls } = makeTriage();
  // Suno 出歌等待超时（120s 级）——任务在途有迟到投递，是进度不是失败。
  assert.equal(await triage.noticeFor(new Error('suno_wait_timeout')), undefined, 'suno_wait_timeout 不算错误');
  assert.equal(await triage.noticeFor(new Error('suno_wait_aborted')), undefined);
  // ComfyUI/视频/代码画图排队、生成中、退避等待。
  assert.equal(await triage.noticeFor(new Error('任务排队中，请稍候')), undefined, '排队中不算错误');
  assert.equal(await triage.noticeFor(new Error('comfyui generation in progress, heartbeat ok')), undefined, '生成中/心跳不算错误');
  assert.equal(await triage.noticeFor(new Error('等待完成中，正在重试')), undefined, '重试进度不算错误');
  assert.equal(await triage.noticeFor(new Error('已登记迟到投递 late_delivery')), undefined);
  assert.equal(calls.length, 0, '进度类绝不触发副模型调用');
});

/* ── 2. 已知类型走规则文案：零模型调用 ── */
test('triage: auth/quota fall to rule notices with zero model calls', async () => {
  const { triage, calls } = makeTriage();
  const auth = await triage.noticeFor(Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 }));
  assert.ok(auth?.includes('鉴权') || auth?.includes('Key'), '401 走规则文案');
  const forbidden = await triage.noticeFor(Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 }));
  assert.ok(forbidden?.includes('鉴权'));
  const quota = await triage.noticeFor(new Error('HTTP 429 rate limit exceeded'));
  assert.ok(quota?.includes('限流') || quota?.includes('配额'), '429 走规则文案');
  assert.equal(calls.length, 0, '规则类绝不调用副模型（不浪费一次调用）');
});

/* ── 3. 真失败进首诊且只调用一次 ── */
test('triage: real failure enters triage exactly once and returns readable verdict', async () => {
  const { triage, calls } = makeTriage();
  const notice = await triage.noticeFor(new Error('fetch failed: fetch failed'), { chatType: 'group', intentKind: 'freeMode' });
  assert.equal(calls.length, 1, '真失败首诊恰好一次');
  assert.ok(calls[0].opts?.systemHint?.includes('错误首诊助手'), '首诊走专用系统提示');
  assert.ok(!calls[0].input.includes('对话'), '不灌整段对话（控成本）');
  assert.equal(notice, '上游网络暂时不稳定，稍后再试一下。');
});

/* ── 4. 副模型不可处理 → 用户收到可读原因 ── */
test('triage: non-actionable verdict still yields a readable user notice', async () => {
  const { triage } = makeTriage({ sanitizeImpl: async () => '{"actionable": false, "action": "need_human", "userNotice": "上游模型服务出故障了，需要管理员处理；你可以稍后再试。"}' });
  const notice = await triage.noticeFor(new Error('HTTP 500 Internal error'));
  assert.ok(notice?.includes('管理员'), '不可处理也要给可读原因');
});

/* ── 5. 副模型自身失败 → 用户侧兜底 + 管理员私聊 + self_failed 日志 ── */
test('triage: sanitize self-failure hides repair errors from user and pings admin', async () => {
  const { triage, problems, logs } = makeTriage({ sanitizeImpl: async () => { throw new Error('sanitize provider down'); } });
  const notice = await triage.noticeFor(new Error('fetch failed: fetch failed'));
  assert.equal(notice, TRIAGE_FALLBACK_NOTICE, '用户侧只收规则兜底文案');
  assert.ok(!notice.toLowerCase().includes('repair') && !notice.includes('sanitize'), '用户看不到 repair 内部错误');
  assert.equal(problems.length, 1, '管理员推送恰好一次');
  assert.equal(problems[0].kind, 'triage-self-failed', '推送 kind 固定');
  assert.ok(logs.some(([m, d]) => m === 'content.repair' && d.event === 'self_failed'), '日志记 content.repair.self_failed');
  // 解析失败同样走 self_failed 链。
  const { triage: t2, problems: p2 } = makeTriage({ sanitizeImpl: async () => '这不是 JSON' });
  const n2 = await t2.noticeFor(new Error('HTTP 503 unavailable'));
  assert.equal(n2, TRIAGE_FALLBACK_NOTICE);
  assert.equal(p2.length, 1);
});

/* ── 6. 预算：全局小时上限超限 → 规则兜底 ── */
test('triage: hourly budget exceeded falls back without model call', async () => {
  const { triage, calls } = makeTriage({ cfg: { llm: { sanitizeModel: 'san-model' }, bot: { errorTriage: { enabled: true, cooldownMinutes: 10, hourlyLimit: 1, customRules: [] } } } });
  const first = await triage.noticeFor(new Error('fetch failed: A'));
  assert.equal(first, '上游网络暂时不稳定，稍后再试一下。');
  const second = await triage.noticeFor(new Error('ETIMEDOUT after 30000ms: B'));
  assert.equal(second, TRIAGE_FALLBACK_NOTICE, '超限走规则兜底');
  assert.equal(calls.length, 1, '超限后不再调副模型');
});

/* ── 7. 冷却：同错误 hash 复用首次结论 ── */
test('triage: same error hash within cooldown reuses cached verdict', async () => {
  const { triage, calls } = makeTriage();
  const first = await triage.noticeFor(new Error('fetch failed: X'));
  const second = await triage.noticeFor(new Error('fetch failed: X'));
  assert.equal(first, second, '冷却窗口内复用结论');
  assert.equal(calls.length, 1, '冷却命中不再调副模型');
});

/* ── 8. 审核耗尽透传（wrap 层已产出文案，不重复首诊）── */
test('triage: content_rejection_exhausted passes through wrap notice without triage', async () => {
  const { triage, calls } = makeTriage();
  const notice = await triage.noticeFor(new Error('content_rejection_exhausted:刚才那条消息触发了上游内容审核。'));
  assert.equal(notice, '刚才那条消息触发了上游内容审核。');
  assert.equal(calls.length, 0, '审核耗尽已有文案，不进首诊');
});

/* ── 9. 自定义规则优先 + 关闭开关 ── */
test('triage: custom rules take precedence and can disable the channel', async () => {
  const { triage, calls } = makeTriage({ cfg: { llm: { sanitizeModel: 'san-model' }, bot: { errorTriage: { enabled: true, cooldownMinutes: 10, hourlyLimit: 20, customRules: [{ pattern: 'my-provider-down', kind: 'rule', notice: '我的转接服务抽风了，等等再试。' }] } } } });
  assert.equal(await triage.noticeFor(new Error('my-provider-down: connect refused')), '我的转接服务抽风了，等等再试。');
  assert.equal(calls.length, 0);
  const { triage: off } = makeTriage({ cfg: { llm: { sanitizeModel: 'san-model' }, bot: { errorTriage: { enabled: false, cooldownMinutes: 10, hourlyLimit: 20, customRules: [] } } } });
  assert.equal(await off.noticeFor(new Error('fetch failed')), undefined, '通道关闭 = 行为与原先一致');
});
