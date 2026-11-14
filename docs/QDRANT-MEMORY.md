# Qdrant 外部记忆后端

## 目标

把长期记忆从 Node 进程内的 Orama JSON 索引迁移到 Qdrant Cloud：

```text
bot-runtime-v2
  -> QdrantMemoryService
  -> HTTPS Qdrant Cloud
```

这样 Node 不再在启动时解析 493MB 级 Orama JSON，MCP、memory.search、群/用户作用域和 retention 仍然保留。

## 当前 collection

```text
名称: miobot_memory
向量: 1536 维 / Cosine
payload indexes:
  botId, scope, groupId, userId, messageId, dayBucket, createdAt, text
```

如果 embeddingDimensions 不是 1536，需要按实际维度创建 collection。

## 环境变量

在 `/etc/miobot-v2.env` 中设置，不要把密钥写进仓库：

```text
MIOBOT_MEMORY_BACKEND=qdrant
QDRANT_URL=https://你的-qdrant-endpoint
QDRANT_API_KEY=你的-key
QDRANT_COLLECTION=miobot_memory
```

修改后：

```bash
sudo systemctl restart miobot-v2
```

## 从 Orama 迁移

先停 bot/web，避免迁移期间写入：

```bash
sudo systemctl stop miobot-v2
sudo cp -a /var/lib/miobot-v2/memory /var/lib/miobot-v2/memory.orama-backup-$(date +%Y%m%d-%H%M%S)
```

先 dry-run，确认能读取每个 namespace：

```bash
cd /opt/1panel/docker/compose/root/miobot-image2

node scripts/migrate-memory-to-qdrant.mjs \
  --source /var/lib/miobot-v2/memory \
  --collection miobot_memory \
  --dimensions 1536
```

确认后写入：

```bash
node scripts/migrate-memory-to-qdrant.mjs \
  --source /var/lib/miobot-v2/memory \
  --collection miobot_memory \
  --dimensions 1536 \
  --apply
```

脚本会：

- 读取 `namespaces.json`
- 一次恢复一个 Orama namespace
- 从 Orama 内部文档读取已有 embedding
- 批量 upsert 到 Qdrant
- 校验 Qdrant 总点数
- 不修改、不删除源 Orama 目录

## 切换并验证

迁移成功后设置：

```text
MIOBOT_MEMORY_BACKEND=qdrant
```

启动：

```bash
sudo systemctl start miobot-v2
sudo systemctl status miobot-v2 --no-pager
```

验证：

```bash
journalctl -u miobot-v2 -n 100 --no-pager
free -h
```

再通过后台或 `memory.search` 查询旧群聊，确认 scope 隔离和结果正常。

确认稳定前不要删除：

```text
/var/lib/miobot-v2/memory.orama-backup-*
```

## Qdrant 失败时的行为

- 检索失败返回空结果并记录日志，不影响 bot 正常运行
- 写入失败由 `MemoryObserver` 的 pending 队列兜底
- retention 清理使用 Qdrant payload filter，不加载完整索引
- 旧 Orama 数据保留为回滚备份

## 迁移内存风险

源索引单个文件可能接近 493MB，迁移进程仍需要在内存中恢复一个 Orama namespace。

如果服务器只有 1.9GB：

- 迁移时先停止 bot/web 和其他非必要服务
- 临时增加 swap
- 或在另一台内存更大的机器上迁移，再把数据写入同一个 Qdrant collection
- 不要在 bot 运行中直接迁移
