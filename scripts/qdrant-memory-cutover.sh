#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${MIOBOT_ENV_FILE:-/etc/miobot-v2.env}"

if [ -z "${QDRANT_API_KEY:-}" ] && ! grep -q '^QDRANT_API_KEY=' "$ENV_FILE" 2>/dev/null; then
  if [ ! -t 0 ]; then
    echo "QDRANT_API_KEY is missing and stdin is not interactive" >&2
    exit 2
  fi
  read -r -s -p "Qdrant API key: " QDRANT_API_KEY
  echo
  export QDRANT_API_KEY
fi

exec node "$SCRIPT_DIR/qdrant-memory-cutover.mjs" "$@"