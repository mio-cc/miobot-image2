# 能力开发规范（CAPABILITY-SPEC）

> 目标：新增一个能力不需要考古。本文是能力注册表、handler 契约、交互约定与防刷屏策略的唯一权威描述。
> 状态基线：2026-10-24（T0/T1/T2 批次改造后）。行为与本文不符时，以代码+测试为准并更新本文。

## 1. 一个能力由三部分组成

1. **Descriptor**（`packages/orchestration/src/builtin-capabilities.ts`）——模型看到的全部事实；
2. **Handler**（`apps/bot/src/capability-*.ts`）——执行逻辑，实现 `CapabilityHandler`；
3. **注册**（`orchestration-enforce.ts` 构造器）——`dispatcher.registerHandler(id, handler)`。

## 2. Descriptor 字段速查

| 字段 | 必填 | 说明 |
|---|---|---|
| id / name / version / provider | ✓ | provider 决定归属展示；suno 类需在 applyRuntimeCapabilityGates 里挂独立开关 |
| description | ✓ | **正向、客观**：说能做什么、产出什么。禁止 notFor/whenNotToUse/领域关键词/负向 few-shot |
| effect | ✓ | answer/retrieve/generate/transform/mutate/delete/notify/control。Planner 按"期望结果类型"匹配，不按话题词 |
| inputSchema | 建议 | JSON Schema；参数说明写进 properties[].description（Planner 会读） |
| requiredContext | 按需 | image/file/video/url/reply——执行前缺上下文会走确定性校验→模型追问 |
| outputKinds | ✓ | text/image/video/audio/file/link/card |
| sideEffects | 按需 | creates_artifact/modifies_state/deletes_data/sends_message/external_call（客观事实，不做适用性判断） |
| riskLevel | ✓ | low/medium=allow、high=ask_admin、critical=deny（默认权限策略） |
| approvalRequired | 按需 | true 时进入审批流（payloadHash 防篡改 + checkpoint 恢复） |
| costClass | ✓ | free/low/medium/high——**限流默认配额映射**（见 §5） |
| ttsPolicy | 建议 | skip=命令/查询类结果不进自动 TTS；auto=默认 |
| mode / queue | 建议 | sync/async_job/stream/interactive |
| modelRounds | 按需 | 消耗模型轮数（进执行预算） |

## 3. Handler 契约

```ts
interface CapabilityHandler {
  execute(invocation: CapabilityInvocation): Promise<ExecutionResult>;
}
```

**必须遵守**：
1. **幂等意识**：同 `planId+stepId+args` 可能因恢复/重试被再次调用；副作用已发生时要能识别并安全返回（重放前查远端状态）；
2. **retryable 如实**：瞬时故障 true（executor 会按 maxRetries 重试），确定性失败 false；
3. **副作用顺序**写入 diagnostics（恢复时判断能否安全重放）；
4. **缺信息返回 `needs_input`**：`outputs` 可携带带序号的选项列表（见 §4），`diagnostics.validationIssues`/`missingInformation` 给结构化事实——**不要自己拼用户文案**，追问由模型生成；
5. 全量 try/catch，异常不要抛出约定之外的内容（dispatcher 会把 throw 折成 retryable failed）；
6. 长任务监听 `invocation.signal`（步骤超时 abort）。

**dispatcher 在 handler 前已统一处理**（handler 不用重复做）：权限/审批校验、args 归一化、**输出引用渲染**（`{{steps.<id>.outputs[n].text|url}}`，见 §6）、**限流闸**（见 §5）。handler 拿到的 `invocation.step.args` 已是渲染后的最终参数。

## 4. 交互式能力约定（clarificationContext 模式）

需要用户选择时（选歌、选音色、选文件）：
1. 目标不明确 → 返回 `needs_input`，`outputs` 携带带稳定序号的文本列表，输出 meta 标记 `role: 'xxx_history'` 或 `clarificationContext: true`（enforce 会把它喂给追问合并器的 `{{context}}`）；
2. 用户回答 → 追问合并器把答案合并回原计划（保留已完成步骤），继续执行；
3. 额度：规划澄清与执行澄清各 `planner.maxClarifications` 次，独立计量；
4. 参考 `capability-suno-library.ts` 的 `missingSongResult` 与 enforce 的 `clarificationContext`。

## 5. 限流与成本

- dispatcher 对**每个能力执行**统一走 FeatureGate：冷却/日限额/并发；
- 面板 `bot.features[id].limits` 显式配置优先；未配置的**副作用类能力**（effect≠answer）按 costClass 兜底：free=3s、low=10s+日100、medium=30s+日30、high=60s+日10；
- answer 类对话能力不限流（正常聊天不误伤）；
- 限流触发=确定性失败（`feature_rate_limited:*`），不重试、handler 不执行；
- 消息层另有 `bot.messageRateLimitPerMinute`（默认 0=关）。

## 6. 多步数据流（输出引用）

后续步骤引用依赖步骤产出：args 字符串里写 `{{steps.<stepId>.outputs[0].text}}` 或 `.url`（dispatcher 执行前渲染）。引用缺失 → needs_input（`missing_step_reference`）。Planner 已在默认提示词中受过教育；能力参数说明里可提示可用引用。

## 7. 输出与防刷屏（静默降级原则）

| 失败/场景 | 用户侧 | 上报 |
|---|---|---|
| 只读能力失败 | 静默成功（空输出） | diagnostics |
| 副作用能力失败 | 有部分输出→发部分；零输出→确定性步骤摘要 | problem |
| 限流触发 | 静默丢弃 | 日志/trace |
| 权限/审批拒绝 | 静默 | problem |

- 文本输出保障链：超长文本按 `bot.textReply.maxChars` 拆块；多内容转发前核心文本首块直发；超预算内容进第二个合并转发（overflowPolicy=forward）；执行成功零输出时给确定性摘要（`buildDeterministicPlanSummary`）；
- 命令/查询类结果标记 `ttsPolicy: 'skip'` 防语音刷屏。

## 8. 新增能力五卡片 Checklist（对应面板能力模块骨架）

1. [ ] 注册卡：descriptor 进 `builtinCapabilityDescriptors()`（正向描述+effect+costClass+riskLevel+ttsPolicy）；需要独立开关的挂 `applyRuntimeCapabilityGates`；
2. [ ] 模型卡：用到模型的能力声明 modelRounds；节点/模型配置走面板，不硬编码；
3. [ ] 提示词卡：模板进 config P 注册表（支持占位符+恢复默认），不写领域关键词路由；
4. [ ] 执行卡：实现 handler（幂等/retryable/needs_input 约定）；注册到 dispatcher；高危补审批；
5. [ ] 测试卡：manifest 暴露断言 + happy path + 缺上下文追问 + 限流/权限路径。

## 9. 相关文档

- 三层架构与冲突分析：《Miobot-三层Bot架构深度分析与升级方案 v6》（桌面 任务/）
- 执行任务清单：《Miobot-实施方案-2026-10-24》（桌面 任务/）
- 本仓库：GROK.md（项目导航）、REBUILD_STATUS.md（已过期，以 git log 为准）
