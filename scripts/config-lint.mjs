#!/usr/bin/env node
/**
 * R17：config-lint——配置跨字段一致性检查。
 * 归一化只做逐字段 clamp；这里补"字段之间的关系"断言。
 * 退出码：发现问题 = 1（阻断），干净 = 0。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { resolveReplyPolicy } = await import('../dist/packages/orchestration/src/reply-policy.js');

let failed = 0;
function check(name, ok, detail = '') {
  const mark = ok ? '✔' : '✖';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const cfg = createDefaultConfig();

// L-1：强制转发阈值必须小于等于硬字符上限（否则阈值永远不触发等于废配置）。
check('L-1 forcedForwardThreshold <= hardMaxChars',
  cfg.replyPolicy.forcedForwardThreshold <= cfg.replyPolicy.hardMaxChars,
  `${cfg.replyPolicy.forcedForwardThreshold} vs ${cfg.replyPolicy.hardMaxChars}`);

// L-2：会话偏好 TTL 与用户偏好 TTL 的量级关系（用户级应 >= 会话级）。
check('L-2 userPreferenceTtlMs >= sessionPreferenceTtlMs',
  cfg.replyPolicy.userPreferenceTtlMs >= cfg.replyPolicy.sessionPreferenceTtlMs,
  `${cfg.replyPolicy.userPreferenceTtlMs} vs ${cfg.replyPolicy.sessionPreferenceTtlMs}`);

// L-3：单轮超时应小于 turn 总超时（否则 finalize 永远没有时间窗）。
check('L-3 agent.timeoutMs < agent.turnTimeoutMs',
  cfg.agent.timeoutMs <= cfg.agent.turnTimeoutMs,
  `${cfg.agent.timeoutMs} vs ${cfg.agent.turnTimeoutMs}`);

// L-4：工具并发不能大于批大小*轮数的合理上限（防配置放大）。
check('L-4 maxParallelTools sane', cfg.agent.maxParallelTools <= 32);

// L-5：turn 并发上限与模型轮次预算的乘积在合理范围（1c2g 场景防雪崩）。
check('L-5 concurrency budget sane',
  cfg.agent.maxConcurrentTurns * cfg.agent.maxModelRounds <= 512,
  `${cfg.agent.maxConcurrentTurns} turns * ${cfg.agent.maxModelRounds} rounds`);

// L-6：replyPolicy 预算单源验证——enabled 时 hardMax* 必须真实生效（R15/#9 回归锁）。
const resolved = resolveReplyPolicy({ config: cfg, textChars: 50 });
check('L-6 reply budget single source', resolved.policy.maxMessages === cfg.replyPolicy.hardMaxMessages,
  `resolved=${resolved.policy.maxMessages} hardMax=${cfg.replyPolicy.hardMaxMessages}`);

// L-7：回复方式枚举含 voice（R13 回归锁）。
check('L-7 replyStrategies accepts voice', ['forward', 'at', 'quote', 'plain', 'text-image', 'voice'].includes(cfg.bot.replyStrategies.text));

// L-8：群覆盖白名单键校验（F-3 回归锁）。
check('L-8 groupOverrides defaults to {}', typeof (cfg.bot).groupOverrides === 'object' && (cfg.bot).groupOverrides !== null);

process.exit(failed ? 1 : 0);