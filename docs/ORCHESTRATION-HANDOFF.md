# Miobot V3 实现交接与验收

## 角色

- **实现会话**：负责改代码、补测试、运行构建；不要自行 commit/push。
- **当前会话（验收会话）**：负责对比方案文档、检查调用链、跑测试、审查 diff、阻止重复实现。

## 仓库与基线

- 仓库：`D:\整理\miobot-v2\online-repo`
- 当前 HEAD：`a90e2a2`
- 当前工作区有大量未提交修改，必须保留，不要 reset/checkout 覆盖。
- 最新验证基线：`tests 723 pass`，web-panel build 成功。
- 设计文档：`C:\Users\Administrator\Desktop\Miobot-v3-三层智能编排架构与权限配置方案.docx`

## 必须先读的方案约束

1. 自然语言意图必须由模型语义规划，禁止关键词前置路由。
2. 精确命令可绕过模型，但必须按配置的前缀/别名匹配，并进入统一 IntentPlan/权限/审批链路。
3. 模型层只理解、检索、规划；功能层校验、权限、审批、执行；用户层接入、身份、会话、回复。
4. 所有高风险动作必须经过 `allow / ask_admin / deny`。
5. owner 默认 allow；admin 高风险 ask_admin；普通用户高风险 deny；硬拒绝优先于 owner allow。
6. 所有最终结果统一走 ReplyPlan；优先嵌套合并转发；文件/语音不可嵌套；默认最多 3 条消息，超限截断并告知。
7. 所有运行异常统一私聊管理员 QQ，用户侧静默。
8. 群聊上下文必须用稳定 QQ 身份区分，同名用户不能合并。
9. 语音 `record` 成功/不确定/超时后不得再文字兜底，避免双回复。
10. 不破坏现有 `replyFormat` / `replyStrategies`。
11. Suno 使用官方 API，不做对外计费；保留配额、并发、超时、重试、停用开关。
12. 在验收会话确认全部完成前，禁止 commit/push。

## 当前真实完成度（实现会话不要重复造轮子）

### 已接入或已有实现

- `UserRequest` / `IntentPlan` / `CapabilityDescriptor` / `ExecutionResult` / `ReplyPlan` 契约
- Planner、CapabilityRegistry、CapabilityDispatcher
- `executeIntentPlan` 已实际被 enforcer 使用，支持 initialResults/approvedStepIds/maxDuration/failurePolicy
- 精确命令到 IntentPlan 的 command-plan 映射（已映射核心命令）
- capability input schema 校验（validation.ts）
- 三态权限基线、硬拒绝开关和能力列表
- 管理员审批 Broker/Runtime、持久化、文件桥接、后台手动操作、quorum、超时、权限上限
- pending clarification 持久化、续跑、待补全任务 API/UI
- trace 文件/API/UI
- 核心能力 handler：chat/image/video、file、code/browser、search、prompt、template、tts、suno、image.stitch、canvas.gallery、owner.recall、help
- 群聊身份区分、异常私聊管理员、语音双发修复
- 能力健康状态与后台能力目录

### 已知仍是部分完成/未完成

- 多模型角色 retriever/specialist/critic/safety/composer 未实际参与
- `maxCost`、`maxModelRounds`、`maxParallelSteps` 未完整执行
- ReplyPlan 尚未成为唯一发送入口；maxMessages 还未在最终发送层严格闭环
- Prompt Optimizer 只有纯函数，没有运行时评估/灰度/回滚
- Suno maxConcurrent/maxQueue/quota 未执行，官方 API 未实机验证
- 部分精确命令仍在旧链路；旧 router 和旧 intent 链尚未彻底移除
- 权限作用域矩阵（用户/群/能力/provider）和后台矩阵仍不完整
- 后台完整 trace 回放、能力测试/安装/回滚、提示词版本 diff 仍缺
- 真实 Napcat、审批、Suno、shadow/enforce soak 测试仍缺

## 实现会话任务顺序（按验收目标，不要扩散）

### P0-1 统一精确命令链路

- 用 command-plan 覆盖剩余可映射命令
- 命令不经过模型，但必须生成 IntentPlan 并进入 Dispatcher
- 统一权限/审批；未映射命令回退旧链路的条件必须明确且可测试
- 增加 runtime 级命令网关测试

### P0-2 完成执行预算

- 让 `maxCost`、`maxModelRounds`、`maxParallelSteps` 有真实执行语义
- `maxParallelSteps` 可以按拓扑层并行，必须有并发上限
- 步骤 timeout/retry、loop detection 至少要有硬约束
- 预算超限返回 partial/failed，不重复执行成功步骤

### P0-3 ReplyPlan 唯一发送入口

- 由 ReplyPlan 决定 groups、消息数和截断
- 文本/图片/视频优先嵌套转发；文件/音频直接发送
- maxMessages 在最终发送层强制执行
- 文件/语音超限保留主结果并给用户可见说明
- 保持现有 replyStrategies 行为

### P0-4 权限矩阵与硬拒绝收口

- 完成用户/群/能力/provider 规则
- 后台提供规则矩阵和最终策略预览
- 确保 hardDeny 覆盖 owner allow，并写测试

### P1 多模型与 Prompt Optimizer

- retriever 先筛 TopK 能力，不把全目录塞给 planner
- specialist/critic/safety/composer 按配置串行/并行，失败可降级
- Prompt 版本存储、候选评估、shadow、canary、回滚
- 系统提示词修改必须有 owner 审批

### P1 Suno 与后台

- Suno 并发/队列/配额/重试
- 官方 API 字段实机适配
- 完整 trace 回放、审批详情、能力健康测试、配置版本回滚

## 实现会话验收标准

每个任务完成必须提供：

- 修改了哪些文件
- 行为变化
- 新增测试和完整测试结果
- web-panel build 结果
- 是否破坏旧 replyFormat/replyStrategies
- 是否仍有关键词路由
- 是否有重复执行、重复发送、用户可见异常
- 是否提交（必须为否，等待验收）

## 验收会话检查清单

- 对照设计文档，而不是只看实现会话总结
- 检查新代码是否真的接入 start/runtime，而不是只有模块
- 检查是否重复实现已有能力
- 检查精确命令是否绕过模型且进入权限/审批
- 检查高风险动作不可被 owner allow 绕过 hard deny
- 检查审批恢复不重跑已成功步骤
- 检查 ReplyPlan 最终发送预算
- 检查错误只私聊管理员
- 检查群聊身份不混用
- 检查语音不确定结果不双发
- 运行 `npm test`、`npm --prefix web-panel run build`
- 最后才允许讨论 commit/push

## 新会话启动提示词（复制给新会话）

```text
你是 Miobot v3 实现会话。请先读取仓库 D:\整理\miobot-v2\online-repo\docs\ORCHESTRATION-HANDOFF.md，
并读取设计文档 C:\Users\Administrator\Desktop\Miobot-v3-三层智能编排架构与权限配置方案.docx。
在开始编码前先核对当前 git status 和已有实现，禁止重复实现已存在的模块。
按 handoff 中 P0-1、P0-2、P0-3、P0-4 的顺序推进；每完成一项先运行测试和后台构建，不要 commit/push。
不要用关键词前置路由，不要回复用户异常，不要破坏 replyFormat/replyStrategies。
完成后只汇报：修改文件、行为变化、测试结果、未解决阻塞。
```
