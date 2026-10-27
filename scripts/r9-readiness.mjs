#!/usr/bin/env node
// R9 验收就绪检查：只读配置与持久化文件，不主动调用外部服务。
// 默认不因外部能力未配置而失败；--strict-externals 时要求 ComfyUI/Suno/视频全部已配置。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA_VERSION, normalizeConfig } from '../dist/packages/config/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const runtimeDir = process.env.MIOBOT_RUNTIME_DIR || path.join(root, '.runtime');
const configPath = process.env.MIOBOT_CONFIG_PATH || path.join(runtimeDir, 'config.json');
const strictExternals = process.argv.includes('--strict-externals');

let config;
let configError = '';
try {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config = normalizeConfig(raw);
} catch (error) {
  configError = String(error?.message || error);
  config = normalizeConfig({});
}

function exists(name, envName) {
  const file = process.env[envName] || path.join(runtimeDir, name);
  return { path: file, exists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 };
}

// P1-6 修复：coreReady 必须真实反映“Agent enforce 可上线”，不是三项都关也 ready 的假阳性。
const agentEnforce = config.agent?.enabled === true && config.agent?.mode === 'enforce';
const toolRegistryReady = agentEnforce && config.toolRegistry?.enabled === true;
const replyPolicyReady = agentEnforce && config.replyPolicy?.enabled === true;
// 至少一个工具可 loadout：静态推断 BUILTIN_ABILITY_IDS 与 enabled 描述符（不执行外部调用）。
const BUILTIN_ABILITY_IDS = new Set([
  'web.search', 'image.generate', 'image.edit', 'image.interrogate', 'image.stitch',
  'video.generate', 'audio.music.generate', 'audio.music.history', 'audio.music.replay',
  'audio.music.variant', 'audio.music.lyrics', 'audio.music.replace_section',
  'file.list', 'file.read', 'file.generate', 'file.delete',
  'code.render', 'browser.render', 'tts.speak', 'voice.current', 'voice.search',
  'voice.preview', 'voice.select', 'canvas.gallery', 'owner.recall', 'owner.model.list',
  'model.catalog.list', 'help', 'prompt.enhance', 'prompt.translate',
  'template.list', 'template.use', 'task.schedule', 'config.update', 'permission.update',
  'reply.presentation',
]);
// 不实例化 OrchestrationEnforcer（构造需要完整 BotApp，会拉起装配链）：
// 静态推断——内置能力常驻注册表；hidden/禁用 exposure 的工具不可 loadout。
const exposureHidden = (name) => {
  const mode = config.toolRegistry?.exposure?.[name];
  return mode === 'hidden';
};
let loadableTools = 0;
for (const id of BUILTIN_ABILITY_IDS) {
  if (!exposureHidden(id)) loadableTools += 1;
}


const comfyNodes = (config.llm?.apiKeys || [])
  .map((node, index) => ({ node, index }))
  .filter(({ node }) => node?.kind === 'comfyui' && node.enabled !== false && String(node.baseUrl || '').trim());
const videoNode = config.llm?.apiKeys?.[config.llm?.videoNodeIndex];
const videoConfigured = Boolean(config.llm?.videoEnabled && videoNode && String(videoNode.baseUrl || '').trim() && String(config.llm?.videoModel || '').trim());
const sunoConfigured = Boolean(config.orchestration?.suno?.enabled && String(config.orchestration?.suno?.baseUrl || '').trim() && String(config.orchestration?.suno?.apiKey || '').trim());

const checks = [
  { id: 'config-file', ok: !configError, detail: configError || configPath },
  { id: 'schema-v3', ok: CONFIG_SCHEMA_VERSION >= 3, detail: `schemaVersion=${CONFIG_SCHEMA_VERSION}` },
  {
    id: 'agent-owner',
    ok: !config.agent?.enabled || config.agent?.mode === 'off' || Boolean(String(config.agent?.mainModel || '').trim()),
    detail: `enabled=${config.agent?.enabled} mode=${config.agent?.mode} model=${config.agent?.mainModel || ''}`,
  },
  {
    id: 'tool-registry-gate',
    ok: !config.agent?.enabled || config.agent?.mode !== 'enforce' || Boolean(config.toolRegistry?.enabled),
    detail: `agentMode=${config.agent?.mode} toolRegistryEnabled=${config.toolRegistry?.enabled}`,
  },
  {
    id: 'reply-policy',
    ok: !config.agent?.enabled || config.agent?.mode === 'off' || Boolean(config.replyPolicy?.enabled),
    detail: `agentMode=${config.agent?.mode} replyPolicyEnabled=${config.replyPolicy?.enabled}`,
  },
  {
    id: 'agent-enforce',
    ok: !config.agent?.enabled || config.agent.mode === 'enforce',
    detail: `agentEnabled=${config.agent?.enabled} agentMode=${config.agent?.mode}（旧自然语言链路已删除：非 enforce 不可上线）`,
  },
  {
    id: 'agent-loadable-tools',
    ok: !config.agent?.enabled || config.agent.mode !== 'enforce' || !config.toolRegistry?.enabled || loadableTools > 0,
    detail: `loadableTools=${loadableTools}`,
  },
];

const stores = {
  agentSessions: exists('agent-sessions.json', 'MIOBOT_AGENT_SESSIONS_FILE'),
  toolJobs: exists('agent-tool-jobs.json', 'MIOBOT_TOOL_JOB_FILE'),
  approvals: exists('orchestration-approvals.json', 'MIOBOT_APPROVAL_FILE'),
  idempotency: exists('tool-idempotency.json', 'MIOBOT_TOOL_IDEMPOTENCY_FILE'),
  replyPreferences: exists('reply-preferences.json', 'MIOBOT_REPLY_PREFERENCES_FILE'),
  audit: exists('audit.jsonl', 'MIOBOT_AUDIT_FILE'),
};

const externals = {
  comfyui: {
    configured: comfyNodes.length > 0,
    nodes: comfyNodes.map(({ node, index }) => ({ index, name: node.name || `node-${index}`, baseUrl: node.baseUrl })),
  },
  suno: {
    configured: sunoConfigured,
    enabled: Boolean(config.orchestration?.suno?.enabled),
    baseUrl: config.orchestration?.suno?.baseUrl || '',
  },
  video: {
    configured: videoConfigured,
    enabled: Boolean(config.llm?.videoEnabled),
    nodeIndex: config.llm?.videoNodeIndex,
    model: config.llm?.videoModel || '',
  },
};

const coreReady = checks.every((check) => check.ok)
  && agentEnforce && toolRegistryReady && replyPolicyReady && loadableTools > 0;
const externalsReady = externals.comfyui.configured && externals.suno.configured && externals.video.configured;
const report = {
  phase: 'R9-readiness',
  generatedAt: new Date().toISOString(),
  runtimeDir,
  configPath,
  coreReady,
  externalsReady,
  strictExternals,
  checks,
  stores,
  externals,
  flags: {
    agentEnabled: config.agent?.enabled,
    agentMode: config.agent?.mode,
    toolRegistryEnabled: config.toolRegistry?.enabled,
    replyPolicyEnabled: config.replyPolicy?.enabled,
    freeModeEnabled: config.freeMode?.enabled,
  },
};
console.log(JSON.stringify(report, null, 2));
process.exit(coreReady && (!strictExternals || externalsReady) ? 0 : 1);
