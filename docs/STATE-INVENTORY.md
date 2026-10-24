# 状态资产清单与备份策略（STATE-INVENTORY）

> dataDir（Linux 默认 `/var/lib/miobot-v2`，本地 `.runtime/`）下所有持久化状态一览。
> 原则：每类状态必须有增长上界与保留策略；无上界即 bug（T2.7 治理后全部有界）。

| 文件/目录 | 内容 | 写入频率 | 增长上界 | 保留策略 | 进备份 |
|---|---|---|---|---|---|
| `config.json` | 全量配置（含密钥） | 面板/owner 命令保存 | 固定大小 | 版本回滚由面板 config versions 管理 | ✅ 必须 |
| `sessions.json` | 会话上下文快照（T2.3） | 每 60s + 退出 | 会话数×裁剪上限；TTL 过滤 | TTL 到期自动清 | ✅ |
| `pending-jobs.json` | 编排任务 DAG/审批检查点 | 每步骤变更 | 每会话 1 条活跃；惰性过期 | expiresAt 过期删除 + 每日 retention | ✅ |
| `approvals.json`（或等价） | 审批记录 | 审批变更 | sweepExpired + pruneTerminal | 终态修剪 | ✅ |
| `voice-preferences.json` | 每用户音色偏好 | 选择时 | 用户数×小对象 | 无需清理 | ✅ |
| `suno-song-history.json` | 歌曲历史 | 每次生成 | 每范围 ≤historyMaxRecords(100)，全局 ≤20×（T2.7） | 写入时裁剪 | ✅ |
| `memory/`（Orama 索引×N） | 向量记忆 | 防抖 5s（T3.4a） | retentionDays(30) prune + 每日修剪 | 夜间/每日 prune | ✅（可选，大） |
| `managed-artifacts.json` | 生成物索引（软删） | 每次登记/删除 | 活跃 ≤5000；软删 30 天清（T2.7） | 加载时治理 | ❌ 可再生 |
| `metrics.json` | 小时分桶×24 | 防抖 10s | 固定窗口滚动 | 自动滚动 | ❌ |
| `audit.jsonl` | 审计日志 | 追加 | retentionDays 清理 | 24h 定时 | ❌ 可选 |
| `*.log` / `system.ndjson` | 运行日志 | 追加 | 5MB 轮转 | 轮转 | ❌ |
| `orchestration-suno-callbacks.jsonl` | Suno 回调留档 | 回调时 | 按 taskId 去重，随任务量 | 可定期归档删除 | ❌ |
| `tmp-files/` `generated/` | 临时/生成文件 | 每次任务 | 每日巡检清理（1h/3d）（T2.5） | mtime 清理 | ❌ |

## 备份

- 脚本：`bash scripts/backup-data.sh [dataDir] [outDir]`——打包上表"进备份"项（memory 可用 `--with-memory` 包含）。
- 建议频率：每日 cron（`0 4 * * *`），保留最近 7 份。
- 恢复：停止服务 → 解包覆盖 dataDir 对应文件 → 启动（sessions/pendingJobs 均为原子写快照，可直接覆盖）。
- 密钥提醒：备份包含 config.json（含 API Key），备份目录权限应 0700，勿入 git。
