# Miobot v2 验收报告问题修复追踪（2026-10-26）

来源：`Miobot-v2重构验收排查与全链路模拟测试报告-20261026.md`

| ID | 状态 | 修复 |
|---|---|---|
| BUG-1 / P1 | 已修复 | AgentLoop preflight 传完整 turn metadata；loop 级审批测试覆盖 pendingApproval |
| BUG-2 / P2 | 已修复 | AgentSessionManager 增加 session 数、消息数、字符数、TTL；pending 会话不淘汰/不裁剪；落盘改为 200ms 合并，stop 时 flush |
| BUG-3 / P2 | 已修复 | start 追问桥同时检查 AgentSession.pendingQuestion；纯图无文本回答也可进入 AgentRuntime |
| BUG-4 / P2 | 已修复（spill 预留） | history/groupContext/memory/compaction/toolResult/pinnedFacts 已接线；spillEnabled 在后台标注预留 |
| BUG-5 / P2 | 已修复 | agent.timeoutMs/reasoningEffort/fallback*/toolChoice 接入真实模型调用 |
| BUG-6 / P2 | 已修复 | toolRegistry 默认超时/重试/并发/检索开关进入运行时；空注册表写启动告警 |
| BUG-7 / P3 | 已修复 | OpenAI 数组响应正文使用真实换行 |
| BUG-8 / P3 | 已关闭 | 旧包、旧别名、旧启动器已物理删除 |
| BUG-9 / P3 | 已修复 | preflight deny 以 tool result 回填模型；审批 pending 仍挂起恢复 |
| BUG-10 / P3 | 保持现状 | 自定义 role prompt 显式使用 catalog 变量；属于兼容行为记录 |
| 单管理员自审批 | 已登记 | 权限页提示候选排除发起人；单管理员本人操作无人可审 |

## 关键回归

```text
tests/agent-loop-r3.test.mjs
tests/agent-session-limits-r9.test.mjs
tests/agent-clarification-bridge-r9.test.mjs
tests/agent-runtime-r4.test.mjs
tests/tool-registry-defaults-r9.test.mjs
tests/context-policy-r9.test.mjs
tests/model-tools-r2.test.mjs
tests/agent-approval-r5-4b.test.mjs
tests/agent-approval-r5-4c.test.mjs
```
