#!/usr/bin/env node
/**
 * Miobot 三层链路自检（doctor 探活）
 *
 * 用法（需先 npm run build）：
 *   node scripts/self-check.mjs           # 静态检查（配置层）
 *   node scripts/self-check.mjs --live    # 静态 + 在线探活（planner 模型最小调用、NapCat WS 端口）
 *
 * 回答一个问题：三层链路（接入→识别→功能）现在到底通不通。
 * 退出码：0=全部通过；1=存在 FAIL 项。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { normalizeConfig, createDefaultConfig } = await import(pathToFileURL(path.join(root, 'dist/packages/config/src/index.js')).href);
const { builtinCapabilityDescriptors, buildCapabilityManifest } = await import(pathToFileURL(path.join(root, 'dist/packages/orchestration/src/index.js')).href);

const live = process.argv.includes('--live');
const results = [];
const check = (ok, level, label, detail) => results.push({ ok, level, label, detail });

// ---------- 配置加载 ----------
const configPath = process.env.MIOBOT_CONFIG_PATH
  || path.join(root, '.runtime', 'config.json');
let cfg;
try {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg = normalizeConfig(raw.config && raw.config.napcat ? raw.config : raw);
  check(true, 'ok', `配置加载`, configPath);
} catch (error) {
  check(false, 'FAIL', '配置加载', `${configPath}: ${error.message}`);
  reportAndExit();
}
// ---------- 第一层：接入（NapCat） ----------
check(Boolean(String(cfg.napcat.wsUrl || '').trim()), 'FAIL-if-empty', 'NapCat WS 地址已配置', cfg.napcat.wsUrl || '(空)');
check((cfg.bot.ownerQQs || []).length > 0, 'WARN', 'owner 已配置', `${(cfg.bot.ownerQQs || []).length} 人`);
const whitelistEmpty = !(cfg.bot.whitelistGroups || []).length && !(cfg.bot.whitelistPrivate || []).length;
check(!whitelistEmpty, 'WARN', '群/私聊白名单非空', whitelistEmpty ? '空白名单=全放行，确认是有意暴露' : `${cfg.bot.whitelistGroups.length} 群 / ${cfg.bot.whitelistPrivate.length} 私聊`);

// ---------- 第二层：识别（编排/Planner） ----------
check(cfg.orchestration.enabled === true, 'FAIL-if-off', '编排已启用', `enabled=${cfg.orchestration.enabled}`);
check(cfg.orchestration.mode === 'enforce', 'WARN', '编排为 enforce 模式', `mode=${cfg.orchestration.mode}${cfg.orchestration.mode === 'shadow' ? '（影子模式，旧链路仍为主力）' : ''}`);
const plannerNode = cfg.llm.apiKeys?.[cfg.orchestration.planner.nodeIndex];
check(Boolean(plannerNode && plannerNode.baseUrl && cfg.orchestration.planner.model), 'FAIL', 'Planner 节点与模型已配置',
  `node=${cfg.orchestration.planner.nodeIndex} model=${cfg.orchestration.planner.model || '(空)'} url=${plannerNode?.baseUrl || '(节点不存在)'}`);
const rolePlannerNode = cfg.llm.apiKeys?.[cfg.orchestration.roles.planner.nodeIndex];
if (rolePlannerNode && cfg.orchestration.roles.planner.nodeIndex !== cfg.orchestration.planner.nodeIndex) {
  check(false, 'WARN', 'Planner 主/修复节点一致', `planner.nodeIndex=${cfg.orchestration.planner.nodeIndex} 但 roles.planner.nodeIndex=${cfg.orchestration.roles.planner.nodeIndex}（修复/追问轮会打到不同节点）`);
} else {
  check(true, 'ok', 'Planner 主/修复节点一致');
}
check((cfg.orchestration.approval.adminQqIds || []).length > 0, 'WARN', '审批管理员已配置', `${(cfg.orchestration.approval.adminQqIds || []).length} 人`);
check(Boolean(cfg.freeMode.enabled || cfg.intentRecognition.enabled), 'INFO', 'legacy 回退链路状态', freeModeText(cfg));

// ---------- 第三层：功能（能力注册表） ----------
const descriptors = builtinCapabilityDescriptors();
const manifest = buildCapabilityManifest(descriptors);
check(descriptors.length >= 30, 'FAIL', '能力注册表非空', `${descriptors.length} 个 descriptor，manifest 版本 ${manifest.version}`);
const disabled = descriptors.filter((item) => !item.enabled).map((item) => item.id);
check(true, 'INFO', '能力开关状态', disabled.length ? `禁用：${disabled.join(', ')}` : '全部启用');
const missingEffect = descriptors.filter((item) => !item.effect || item.effect === 'unknown').map((item) => item.id);
check(missingEffect.length === 0, 'WARN', '能力 effect 标注完整', missingEffect.length ? `缺少：${missingEffect.join(', ')}` : 'OK');

if (live) {
  await liveProbePlanner(cfg, plannerNode);
  await liveProbeNapcat(cfg.napcat.wsUrl);
}
reportAndExit();

function freeModeText(c) {
  const on = [c.freeMode.enabled ? 'freeMode' : '', c.intentRecognition.enabled ? 'intentRecognition' : ''].filter(Boolean);
  return on.length ? `${on.join(' + ')} 开启（planner 失败时的回退链路）` : '均已关闭（planner 失败将无回退）';
}

async function liveProbePlanner(c, node) {
  if (!node?.baseUrl || !c.orchestration.planner.model) return check(false, 'FAIL', '[live] Planner 模型可调', '未配置，跳过');
  const url = String(node.baseUrl).replace(/\/$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(node.key ? { authorization: `Bearer ${node.key}` } : {}) },
      body: JSON.stringify({ model: c.orchestration.planner.model, messages: [{ role: 'user', content: '回复一个字：通' }], max_tokens: 8 }),
    });
    const body = await response.json().catch(() => ({}));
    const text = body?.choices?.[0]?.message?.content || '';
    check(response.ok && Boolean(text), response.ok ? 'ok' : 'FAIL', '[live] Planner 模型可调', `HTTP ${response.status}${text ? ` 回复「${String(text).slice(0, 12)}」` : ' 无回复文本'}`);
  } catch (error) {
    check(false, 'FAIL', '[live] Planner 模型可调', String(error.message || error));
  } finally {
    clearTimeout(timer);
  }
}

function liveProbeNapcat(wsUrl) {
  return new Promise((resolve) => {
    const match = String(wsUrl || '').match(/^wss?:\/\/([^/:]+):(\d+)/) || String(wsUrl || '').match(/^wss?:\/\/([^/]+)\/?$/);
    if (!match) {
      check(false, 'FAIL', '[live] NapCat 端口可达', `wsUrl 无法解析: ${wsUrl}`);
      return resolve();
    }
    const host = match[1];
    const port = Number(match[2] || (String(wsUrl).startsWith('wss') ? 443 : 80));
    const socket = net.connect({ host, port, timeout: 5000 });
    const done = (ok, detail) => {
      socket.destroy();
      check(ok, ok ? 'ok' : 'FAIL', '[live] NapCat 端口可达', detail);
      resolve();
    };
    socket.on('connect', () => done(true, `${host}:${port} TCP 可达（协议/鉴权以运行为准）`));
    socket.on('timeout', () => done(false, `${host}:${port} 连接超时`));
    socket.on('error', (error) => done(false, String(error.message || error)));
  });
}

function reportAndExit() {
  let fail = 0;
  console.log('\n===== Miobot 三层链路自检 =====');
  for (const item of results) {
    const icon = item.level === 'FAIL' || item.level === 'FAIL-if-empty' || item.level === 'FAIL-if-off' ? (item.ok ? '✓' : '✗') : item.ok ? '✓' : '!';
    const effectiveFail = !item.ok && String(item.level).startsWith('FAIL');
    if (effectiveFail) fail += 1;
    console.log(`${icon} ${effectiveFail ? '[FAIL]' : item.level === 'WARN' && !item.ok ? '[WARN]' : '[OK]'} ${item.label} — ${item.detail ?? ''}`);
  }
  console.log(`\n结果：${fail === 0 ? '通过' : `${fail} 项失败`}（共 ${results.length} 项检查${live ? '，含在线探活' : ''}）`);
  process.exit(fail === 0 ? 0 : 1);
}
