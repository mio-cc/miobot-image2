#!/usr/bin/env bash
# Miobot 数据备份脚本（T2.7）：打包关键状态文件。
# 用法: bash scripts/backup-data.sh [dataDir] [outDir] [--with-memory]
# 默认 dataDir=$MIOBOT_DATA_DIR 或 /var/lib/miobot-v2；输出到 dataDir/backups/。
set -euo pipefail

DATA_DIR="${1:-${MIOBOT_DATA_DIR:-/var/lib/miobot-v2}}"
OUT_DIR="${2:-$DATA_DIR/backups}"
WITH_MEMORY="${3:-}"

if [ ! -d "$DATA_DIR" ]; then
  echo "数据目录不存在: $DATA_DIR" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
TARGET="$OUT_DIR/miobot-data-$STAMP.tar.gz"
FILES=(config.json sessions.json pending-jobs.json approvals.json voice-preferences.json suno-song-history.json)
INCLUDE=()
for f in "${FILES[@]}"; do
  [ -f "$DATA_DIR/$f" ] && INCLUDE+=("$f")
done
if [ "$WITH_MEMORY" = "--with-memory" ] && [ -d "$DATA_DIR/memory" ]; then
  INCLUDE+=("memory")
fi
if [ "${#INCLUDE[@]}" -eq 0 ]; then
  echo "未发现任何关键状态文件，跳过备份" >&2
  exit 1
fi

tar -czf "$TARGET" -C "$DATA_DIR" "${INCLUDE[@]}"
chmod 600 "$TARGET"
echo "备份完成: $TARGET ($(du -h "$TARGET" | cut -f1)) 包含: ${INCLUDE[*]}"

# 保留最近 7 份
ls -1t "$OUT_DIR"/miobot-data-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f --
echo "已清理旧备份（保留最近 7 份）"
