# 存储扫描与安全清理

脚本：

```text
scripts/storage-maintenance.mjs
scripts/storage-maintenance.sh
```

直接运行：

```bash
sudo bash scripts/storage-maintenance.sh scan
```

不想用 bash 包装也可以：

```bash
sudo node scripts/storage-maintenance.mjs scan
```

默认路径会自动读取 `/etc/miobot-v2.env` 中的 `DATA_DIR`、`MIOBOT_RUNTIME_DIR`、`LOG_DIR`，也可以用参数覆盖。

生产环境部署脚本会把应用时区固定为 `TZ=Asia/Shanghai`；记忆保留的日桶也显式按 Asia/Shanghai 计算，不依赖服务器本地时区。

## 扫描

```bash
sudo bash scripts/storage-maintenance.sh scan
sudo bash scripts/storage-maintenance.sh scan --json > /tmp/miobot-storage.json
```

扫描内容：

- 根分区和 data 分区容量
- data / runtime / logs / app 一级目录占用
- runtime 下最大的文件
- 记忆库目录、`retention-state.json`、retention 备份
- 部署备份、能力插件备份、tmp-files、generated-files、canvas-assets
- journald 当前占用

## 清理计划

默认只生成计划，不删除：

```bash
sudo bash scripts/storage-maintenance.sh clean
```

默认清理类别：

```text
deployment-backups          /var/lib/miobot-v2/backups
memory-retention-backups    runtime/memory/retention-backup-*.json
capability-backups          runtime/capabilities/backups/*.bak
temp-files                  runtime/tmp-files
```
可选类别：
```text
generated-files             runtime/generated-files      --include-generated
rotated-logs                log dir 中 *.log.* / *.ndjson.* --include-logs
```

默认保留时间：

```text
deployment backups      7 天
memory retention backup 14 天
capability backups      30 天
tmp-files               3 天
rotated logs            14 天（仅 --include-logs）
```

确认计划后执行：

```bash
sudo bash scripts/storage-maintenance.sh clean --apply --yes
```

## generated-files

`generated-files` 可能仍被消息或任务引用，默认不纳入删除。确认后显式加入：

```bash
sudo bash scripts/storage-maintenance.sh clean --include-generated
sudo bash scripts/storage-maintenance.sh clean --include-generated --apply --yes
```

## rotated logs

只匹配已轮转的 `*.log.*` 和 `*.ndjson.*`，活动的 `.log` / `.ndjson` 不会删除：

```bash
sudo bash scripts/storage-maintenance.sh clean --include-logs
sudo bash scripts/storage-maintenance.sh clean --include-logs --apply --yes
```

## 记忆保留清理

查看记忆目录和 retention 状态：

```bash
sudo bash scripts/storage-maintenance.sh memory
```

实际触发一次记忆保留清理：

```bash
sudo bash scripts/storage-maintenance.sh memory --apply --yes
```

脚本会向 `orchestration-memory-actions.jsonl` 投递 `retention_now`，等待结果并打印 `retention-state.json`。这需要 `miobot-v2` 服务正在运行。实际清理会自动备份被删文档，dry-run 不会写 retention 状态。

## journald

查看：

```bash
sudo bash scripts/storage-maintenance.sh journal
```

回收 7 天前：

```bash
sudo bash scripts/storage-maintenance.sh journal --apply --yes --journal-days 7
```

## 常用参数

```text
--include-logs
--log-days N
--data-dir PATH
--runtime-dir PATH
--memory-dir PATH
--log-dir PATH
--app-dir PATH
--backup-days N
--temp-days N
--retention-backup-days N
--capability-backup-days N
--generated-days N
--include-generated
--journal-days N
--apply
--yes
--json
--top N
```

## 安全规则

- 没有 `--apply` 永远不删除。
- `--apply` 必须 root。
- 非交互环境必须显式传 `--yes`。
- 删除前会再次检查文件是普通文件且位于允许的目录内。
- 不会自动删除 `memory` 主索引、`canvas-assets`、活动日志、当前配置或会话状态。
- `memory` 的实际过期清理由 `memory-retention` 调度任务负责；本脚本只清理它产生的旧 `retention-backup-*.json`。

## 为什么存储还会堆积

记忆保留策略默认每 3 天跑一次、滚动保留 3 天，所以最近 3 天的聊天记忆本来就会占空间。真正容易持续堆积的是：

```text
backups/
memory/retention-backup-*.json
capabilities/backups/
tmp-files/
generated-files/
journald
```

先运行 `scan` 找到最大项，再运行 `clean` 查看候选文件，最后才加 `--apply`。

## 建议的定期操作

可以先每天扫描、每周人工确认清理：

```bash
sudo bash /opt/1panel/docker/compose/root/miobot-image2/scripts/storage-maintenance.sh scan
sudo bash /opt/1panel/docker/compose/root/miobot-image2/scripts/storage-maintenance.sh clean
```

确认稳定后再考虑把 `clean --apply --yes` 放进 cron。
