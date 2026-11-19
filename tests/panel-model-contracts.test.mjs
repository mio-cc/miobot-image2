// 面板「模型参数契约」（2026-11-19）：端点只读、缺文件不 500、路由已注册
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('后端：GET /api/models/contracts 读的是 data/model-contracts.json，且支持环境变量覆盖', () => {
  const src = fs.readFileSync('packages/web-api/src/index.ts', 'utf8');
  assert.match(src, /path === '\/api\/models\/contracts'/);
  assert.match(src, /MIOBOT_MODEL_CONTRACTS_FILE/);
  // 读不到文件时必须是 200 + 空数组，不能 500
  assert.match(src, /if \(!content\) return ok\(\{ success: true, entries: \[\], updatedAt: '' \}\)/);
  // JSON 坏了也要 200
  assert.match(src, /entries: \[\], updatedAt: '' \}/);
});

test('后端：契约行里把尺寸枚举/约束/质量枚举/修正都摊平给面板', () => {
  const src = fs.readFileSync('packages/web-api/src/index.ts', 'utf8');
  for (const key of ['paramNames', 'sizeEnum', 'sizeLimits', 'qualityEnum', 'transforms', 'notes']) {
    assert.match(src, new RegExp(key + ':'), key + ' 应出现在返回结构里');
  }
});

test('前端：路由已注册 meta（否则侧边栏看不见）', () => {
  const src = fs.readFileSync('web-panel/src/router/index.ts', 'utf8');
  assert.match(src, /name: 'model-contracts'/);
  assert.match(src, /path: '\/models\/contracts'/);
  assert.match(src, /title: '模型参数', group: '运行'/);
});

test('前端：页面用现有 UiKit 组件，不引新依赖', () => {
  const src = fs.readFileSync('web-panel/src/pages/ModelContractsPage.vue', 'utf8');
  assert.match(src, /SectionCard/);
  assert.match(src, /client\.get\('\/models\/contracts'\)/);
  // 来源优先级要在界面上写清楚
  assert.match(src, /文档 schema > 文档正文 > 422 探测 > 运行时学到/);
  // 空态要给可执行提示，不能只显示"暂无数据"
  assert.match(src, /还没有契约/);
  assert.doesNotMatch(src, /from 'element-plus'|from 'ant-design-vue'/);
});

test('前后端字段名一致（sizeEnum/sizeLimits/qualityEnum 两边同名）', () => {
  const api = fs.readFileSync('packages/web-api/src/index.ts', 'utf8');
  const page = fs.readFileSync('web-panel/src/pages/ModelContractsPage.vue', 'utf8');
  for (const field of ['sizeEnum', 'sizeLimits', 'qualityEnum', 'fetchedAt', 'paramNames']) {
    assert.ok(api.includes(field + ':'), 'API 缺 ' + field);
    assert.ok(page.includes(field), '页面缺 ' + field);
  }
});
test('面板动作：refresh/delete 都只写动作文件，不直接抓取/删文件', () => {
  const api = fs.readFileSync('packages/web-api/src/index.ts', 'utf8');
  assert.match(api, /path === '\/api\/models\/contracts\/refresh'/);
  assert.match(api, /path === '\/api\/models\/contracts'/);
  assert.match(api, /MIOBOT_MODEL_CONTRACT_ACTIONS/);
  // 必须是 appendFile 写 jsonl，而不是直接改 model-contracts.json
  assert.match(api, /fs\.appendFile\(actionFile/);
  assert.doesNotMatch(api, /unlink.*model-contracts\.json/, '面板不能直接删契约文件');
  // 缺 key 必须 400，而不是静默排队
  assert.match(api, /error: 'missing_key'/);
});

test('bot 侧消费：轮询动作文件并用游标避免重放', () => {
  const bot = fs.readFileSync('apps/bot/src/start.ts', 'utf8');
  assert.match(bot, /startContractActionPoller/);
  assert.match(bot, /loadJsonlActionCursor/);
  assert.match(bot, /readJsonlActionBatch/);
  assert.match(bot, /saveJsonlActionCursor/);
  assert.match(bot, /modelContractStore\.delete\(key\)/);
  assert.match(bot, /modelContractStore\.flush\(\)/);
  // 删除后该模型会退回保守模式：契约没了 → resolveContract 回退弱契约/保守
  assert.match(bot, /action === 'delete'/);
});

test('刷新走 fal 文档页解析，失败只告警不崩', () => {
  const bot = fs.readFileSync('apps/bot/src/start.ts', 'utf8');
  assert.match(bot, /async function fetchFalContract/);
  assert.match(bot, /extractFalSpecFromHtml/);
  assert.match(bot, /contractFromOpenApi/);
  assert.match(bot, /AbortSignal\.timeout\(20_000\)/);
  assert.match(bot, /模型参数契约刷新失败/);
});

test('试算端点：纯函数返回将发送的尺寸/是否 snap/被丢弃的参数', () => {
  const api = fs.readFileSync('packages/web-api/src/index.ts', 'utf8');
  assert.match(api, /path === '\/api\/models\/contracts\/explain'/);
  assert.match(api, /shapeImageParams\(/);
  assert.match(api, /describeShapedParams\(/);
  assert.match(api, /snapped: shaped\.snapped/);
  assert.match(api, /sentSize: shaped\.size \|\| ''/);
  // 试算绝不能发网络请求
  assert.doesNotMatch(api, /explain[\s\S]{0,800}await fetch\(/, '试算必须纯函数，不联网');
});

test('面板：重新抓取/删除/试算三个按钮都在，且删除要二次确认', () => {
  const src = fs.readFileSync('web-panel/src/pages/ModelContractsPage.vue', 'utf8');
  assert.match(src, /重新抓取/);
  assert.match(src, /删除/);
  assert.match(src, /试算/);
  assert.match(src, /window\.confirm\(/, '删除契约必须二次确认');
  assert.match(src, /client\.post\('\/models\/contracts\/refresh'/);
  assert.match(src, /client\.delete\('\/models\/contracts\?key='/);
  assert.match(src, /client\.post\('\/models\/contracts\/explain'/);
});

test('面板：试算结果要显示 snap 原因与未下发参数（含「已调整」文案）', () => {
  const src = fs.readFileSync('web-panel/src/pages/ModelContractsPage.vue', 'utf8');
  assert.match(src, /已调整：请求/);
  assert.match(src, /snapReason/);
  assert.match(src, /未下发/);
  assert.match(src, /保守模式/);
});
