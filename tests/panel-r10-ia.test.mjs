import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routerSource = fs.readFileSync(path.join(root, 'web-panel/src/router/index.ts'), 'utf8');

test('panel R11 IA: routing redirects to models, planner remains a redirect', () => {
  // R19：RoutingPage 的模型分工职责被 ModelsPage 用途分配取代——旧路由 redirect 到 /models。
  assert.match(routerSource, /path:\s*'\/planner',[\s\S]*?redirect:\s*'\/agent'/);
  assert.match(routerSource, /path:\s*'\/routing',[\s\S]*?redirect:\s*'\/models'/);
  assert.match(routerSource, /path:\s*'\/models',[\s\S]*?name:\s*'models',[\s\S]*?ModelsPage\.vue/);
  assert.match(routerSource, /path:\s*'\/orchestration',\s*redirect:\s*'\/agent'/);
  // P1 技术债收敛（legacy 三页删除）：PlannerPage/NodesPage/RoutingPage 的独占字段已全部
  // 迁入对应新页（AgentPage / ModelsPage / CapImagePage / 提示词注册表），三个页面文件与
  // /legacy/* 直达路由一并删除，/nodes /routing /planner 旧路径仍 redirect。
  assert.equal(/PlannerPage\.vue|NodesPage\.vue|RoutingPage\.vue/.test(routerSource), false, '三个 legacy 页面不许再被路由 import');
  assert.equal(/path:\s*'\/legacy\//.test(routerSource), false, '/legacy/* 直达路由应随页删除');
  for (const page of ['PlannerPage.vue', 'NodesPage.vue', 'RoutingPage.vue']) {
    assert.equal(fs.existsSync(path.join(root, 'web-panel/src/pages', page)), false, `旧页面文件应删除: ${page}`);
  }
  // 迁移落点回归：AgentPage 接收编排模式/规划器/多角色/提示词版本（拆分批后落进两个面板组件，
  // AgentPage 负责挂载）；ModelsPage 接收节点级配置/能力覆盖（节点级字段随抽屉批落进 NodeEditDrawer——
  // 点卡片主体打开，仍是从节点池进出的唯一编辑入口）。
  const agent = fs.readFileSync(path.join(root, 'web-panel/src/pages/AgentPage.vue'), 'utf8');
  const models = fs.readFileSync(path.join(root, 'web-panel/src/pages/ModelsPage.vue'), 'utf8');
  const drawer = fs.readFileSync(path.join(root, 'web-panel/src/components/NodeEditDrawer.vue'), 'utf8');
  const orchPanel = fs.readFileSync(path.join(root, 'web-panel/src/components/OrchestrationPanel.vue'), 'utf8');
  const legacyPanel = fs.readFileSync(path.join(root, 'web-panel/src/components/LegacyEnginePanel.vue'), 'utf8');
  for (const needle of ['OrchestrationPanel', 'LegacyEnginePanel']) {
    assert.ok(agent.includes(needle), `AgentPage 应挂载拆分面板: ${needle}`);
  }
  for (const needle of ['orchestration.mode', 'roleKeys']) {
    assert.ok(orchPanel.includes(needle), `OrchestrationPanel 应包含迁移字段: ${needle}`);
  }
  for (const needle of ['config.llm.reasoningEffort', 'config.freeMode.enabled', 'config.llm.videoTimeoutMs']) {
    assert.ok(legacyPanel.includes(needle), `LegacyEnginePanel 应包含迁移字段: ${needle}`);
  }
  for (const needle of ['runLatencyTest', 'fetchAllModels', 'saveOverride', 'NodeEditDrawer']) {
    assert.ok(models.includes(needle), `ModelsPage 应包含迁移能力: ${needle}`);
  }
  for (const needle of ['NODE_KINDS', 'PROVIDERS', 'ensureComfyui', 'node.headers']) {
    assert.ok(drawer.includes(needle), `NodeEditDrawer 应包含节点级字段: ${needle}`);
  }
  for (const comp of ['NodeCard.vue', 'NodeEditDrawer.vue']) {
    assert.ok(fs.existsSync(path.join(root, 'web-panel/src/components', comp)), `missing component: ${comp}`);
  }
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

test('panel: render page exposes code model output budget and timeout', () => {
  const source = fs.readFileSync(path.join(root, 'web-panel/src/pages/RenderPage.vue'), 'utf8');
  assert.match(source, /config\.codeRender\.maxTokens/);
  assert.match(source, /config\.codeRender\.timeoutMs/);
  assert.match(source, /32768/);
  assert.match(source, /180000/);
});
