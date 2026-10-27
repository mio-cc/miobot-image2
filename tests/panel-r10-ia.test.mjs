import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routerSource = fs.readFileSync(path.join(root, 'web-panel/src/router/index.ts'), 'utf8');

test('panel R11 IA: routing page is visible while planner remains a redirect', () => {
  // 规划器仍然留给 Agent；能力分工必须保留可导航入口，否则每项能力的节点/模型配置无处可找。
  assert.match(routerSource, /path:\s*'\/planner',\s*\n\s*redirect:\s*'\/agent',/);
  assert.match(routerSource, /path:\s*'\/routing',[\s\S]*?name:\s*'routing',[\s\S]*?RoutingPage\.vue/);
  assert.match(routerSource, /path:\s*'\/orchestration',\s*redirect:\s*'\/agent'/);
  assert.equal(/component:\s*\(\)\s*=>\s*import\('\.\.\/pages\/PlannerPage\.vue'\)/.test(routerSource), false);
});

test('panel R10 IA: new tools/jobs/prompts pages registered', () => {
  assert.match(routerSource, /path:\s*'\/tools',\s*\n\s*name:\s*'tools',\s*\n\s*component:\s*\(\)\s*=>\s*import\('\.\.\/pages\/ToolsPage\.vue'\)/);
  assert.match(routerSource, /path:\s*'\/tools\/:id',\s*\n\s*name:\s*'tool-detail',\s*\n\s*component:\s*\(\)\s*=>\s*import\('\.\.\/pages\/ToolDetailPage\.vue'\)/);
  assert.match(routerSource, /path:\s*'\/jobs',[\s\S]*?import\('\.\.\/pages\/JobsPage\.vue'\)/);
  assert.match(routerSource, /path:\s*'\/prompts',[\s\S]*?import\('\.\.\/pages\/PromptRegistryPage\.vue'\)/);
  // 新页面文件存在
  for (const page of ['ToolsPage.vue', 'ToolDetailPage.vue', 'JobsPage.vue', 'PromptRegistryPage.vue']) {
    assert.ok(fs.existsSync(path.join(root, 'web-panel/src/pages', page)), `missing page: ${page}`);
  }
});

test('panel R10 IA: new pages reuse existing visual components (no new visual language)', () => {
  const tools = fs.readFileSync(path.join(root, 'web-panel/src/pages/ToolsPage.vue'), 'utf8');
  const detail = fs.readFileSync(path.join(root, 'web-panel/src/pages/ToolDetailPage.vue'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'web-page/src/pages/JobsPage.vue'.replace('web-page', 'web-panel')), 'utf8');
  const prompts = fs.readFileSync(path.join(root, 'web-panel/src/pages/PromptRegistryPage.vue'), 'utf8');
  for (const source of [tools, detail, jobs, prompts]) {
    assert.match(source, /components\/SectionCard\.vue/);
    assert.equal(/linear-gradient|bg-gradient/.test(source), false, '新页面不得引入渐变');
    assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(source), false, '新页面不得使用 emoji 图标');
  }
});

test('panel R10 IA: canvas frontend untouched (router untouched / canvas pages absent)', () => {
  const canvasDir = path.join(root, 'web-canvas');
  assert.ok(fs.existsSync(canvasDir));
  assert.equal(/canvas/i.test(routerSource), true, '画布管理路由应保留');
});