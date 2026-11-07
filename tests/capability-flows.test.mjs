// 流程编排（2026-11-07 拍板）：capabilityFlows 数据模型 + 派生函数单测。
// - normalize：steps 清洗（capability 必填/hint≤120/when≤200）、空链丢弃、上限（≤64 链 × ≤12 步）；
// - 派生：单步=自己 → 无链零提示；目录标记紧凑截断；description 尾拼恒带「可按需调整」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCapabilityFlows } from '../dist/packages/orchestration/src/config.js';
import { formatFlowHint, formatFlowCatalogMarker, hasEffectiveFlow } from '../dist/packages/orchestration/src/capability-flows.js';

test('capability flows: normalize——steps 清洗与无效条目丢弃', () => {
  const flows = normalizeCapabilityFlows({
    'mcp.suno-official': { steps: [{ capability: 'mcp.suno-official', hint: '按规范创作' }, { capability: 'audio.music.history', hint: '', when: '生成成功' }] },
    'bad.empty': { steps: [] },
    'bad.nosteps': {},
    'bad.inner': { steps: [{ capability: '   ' }, { capability: 'ok.step' }] },
    'bad.stepshape': 'not-an-object',
  });
  assert.deepEqual(Object.keys(flows), ['mcp.suno-official', 'bad.inner']);
  assert.equal(flows['mcp.suno-official'].steps.length, 2);
  assert.equal(flows['mcp.suno-official'].steps[0].hint, '按规范创作');
  assert.equal(flows['mcp.suno-official'].steps[1].hint, undefined, '空 hint 不落键');
  assert.equal(flows['mcp.suno-official'].steps[1].when, '生成成功');
  assert.equal(flows['bad.inner'].steps.length, 1, '无 capability 的步被丢弃，其余保留');
  assert.equal(flows['bad.inner'].steps[0].capability, 'ok.step');
});

test('capability flows: normalize——hint/when 截断与链数上限', () => {
  const longHint = 'x'.repeat(300);
  const flows = normalizeCapabilityFlows({
    a: { steps: [{ capability: 'cap', hint: longHint, when: longHint }] },
  });
  assert.equal(flows.a.steps[0].hint.length, 120, 'hint ≤120');
  assert.equal(flows.a.steps[0].when.length, 200, 'when ≤200');
  const many = {};
  for (let i = 0; i < 80; i += 1) many[`cap${i}`] = { steps: [{ capability: 'x' }] };
  assert.equal(Object.keys(normalizeCapabilityFlows(many)).length, 64, '≤64 条链');
  const manySteps = { big: { steps: Array.from({ length: 20 }, (_, i) => ({ capability: `s${i}` })) } };
  assert.equal(normalizeCapabilityFlows(manySteps).big.steps.length, 12, '≤12 步');
});

test('capability flows: 派生——单步=自己 视为无链；未配置无链', () => {
  const flows = {
    'self.only': { steps: [{ capability: 'self.only' }] },
    'real.chain': { steps: [{ capability: 'a' }, { capability: 'b' }] },
  };
  assert.equal(hasEffectiveFlow('self.only', flows), false, '单步=自己 → 无链');
  assert.equal(hasEffectiveFlow('real.chain', flows), true);
  assert.equal(hasEffectiveFlow('unknown', flows), false);
  assert.equal(formatFlowHint('self.only', flows), '', '无链零提示');
  assert.equal(formatFlowCatalogMarker('self.only', flows), '');
  assert.equal(formatFlowHint('nothing', flows), '');
  assert.equal(formatFlowHint('real.chain', undefined), '', 'flows 未配置');
});

test('capability flows: 派生——description 尾拼与目录标记形态', () => {
  const flows = {
    'mcp.suno-official': {
      steps: [
        { capability: 'mcp.suno-official', hint: '按规范创作并提交' },
        { capability: 'audio.music.history', hint: '查询确认', when: '生成成功' },
      ],
    },
    'chain.of.three': { steps: [{ capability: 'a' }, { capability: 'b' }, { capability: 'c' }] },
  };
  const hint = formatFlowHint('mcp.suno-official', flows);
  assert.ok(hint.startsWith('默认调用组合：'));
  assert.ok(hint.includes('mcp.suno-official（按规范创作并提交）'));
  assert.ok(hint.includes('audio.music.history（查询确认）｜当：生成成功'));
  assert.ok(hint.endsWith('（默认路径，可按需调整）'), '恒带「可按需调整」后缀——不锁死');
  const marker = formatFlowCatalogMarker('mcp.suno-official', flows);
  assert.equal(marker, '［默认链：mcp.suno-official → audio.music.history］', '2 步完整显示');
  assert.equal(formatFlowCatalogMarker('chain.of.three', flows), '［默认链：a → b → …］', '>2 步截断');
});
