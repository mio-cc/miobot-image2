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