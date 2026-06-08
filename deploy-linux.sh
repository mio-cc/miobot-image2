#!/usr/bin/env bash
set -Eeuo pipefail

# Miobot v2 root-only Linux all-in-one operations script.
# Default interactive menu:
#   bash deploy-linux.sh
# Command mode:
#   bash deploy-linux.sh install
#   bash deploy-linux.sh rebuild
#   bash deploy-linux.sh git-update
#   bash deploy-linux.sh start|stop|restart|status|logs|health|doctor
# Common overrides:
#   APP_DIR=/opt/miobot-v2 PORT=3018 HOST=0.0.0.0 bash deploy-linux.sh install
#   RUN_TESTS=1 bash deploy-linux.sh rebuild

APP_NAME="${APP_NAME:-miobot-v2}"
SERVICE_NAME="${SERVICE_NAME:-miobot-v2}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
PORT="${PORT:-3018}"
HOST="${HOST:-0.0.0.0}"
NODE_MAJOR="${NODE_MAJOR:-22}"
INSTALL_NODE="${INSTALL_NODE:-auto}"
PNPM_VERSION="${PNPM_VERSION:-9.14.2}"
STRICT_LOCKFILE="${STRICT_LOCKFILE:-0}"
RUN_TESTS="${RUN_TESTS:-0}"
DATA_DIR="${DATA_DIR:-/var/lib/${APP_NAME}}"
RUNTIME_DIR="${MIOBOT_RUNTIME_DIR:-${DATA_DIR}}"
CONFIG_PATH="${MIOBOT_CONFIG_PATH:-${DATA_DIR}/config.json}"
CANVAS_STATE_PATH="${MIOBOT_CANVAS_STATE_PATH:-${RUNTIME_DIR}/canvas-state.json}"
CANVAS_ASSET_DIR="${MIOBOT_CANVAS_ASSET_DIR:-${RUNTIME_DIR}/canvas-assets}"
LOG_DIR="${LOG_DIR:-/var/log/${APP_NAME}}"
ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"
INSTALL_CODEX_SDK="${INSTALL_CODEX_SDK:-1}"
CODEX_VENV_DIR="${MIOBOT_CODEX_VENV_DIR:-${APP_DIR}/.venv-codex}"
CODEX_PYTHON_BIN="${MIOBOT_CODEX_PYTHON:-${CODEX_VENV_DIR}/bin/python}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-}"
GIT_ALLOW_DIRTY="${GIT_ALLOW_DIRTY:-0}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_SOURCE="${PROJECT_SOURCE:-$(cd -- "${SCRIPT_DIR}" && pwd)}"
NODE_BIN="${NODE_BIN:-}"
NPM_BIN="${NPM_BIN:-}"
PNPM_BIN="${PNPM_BIN:-}"

log() { printf '\033[1;34m[miobot]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[miobot]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[miobot]\033[0m %s\n' "$*" >&2; exit 1; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || fail "请用 root 执行：sudo bash deploy-linux.sh $ACTION"
}

detect_pm() {
  if have_cmd apt-get; then echo apt
  elif have_cmd dnf; then echo dnf
  elif have_cmd yum; then echo yum
  elif have_cmd pacman; then echo pacman
  elif have_cmd apk; then echo apk
  else echo unknown
  fi
}

node_major_version() {
  if ! have_cmd node; then echo 0; return; fi
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

resolve_bins() {
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  NPM_BIN="$(command -v npm 2>/dev/null || true)"
  PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
}

managed_path() {
  local node_dir pnpm_dir prefix
  node_dir="${NODE_BIN:+$(dirname "$NODE_BIN")}"
  pnpm_dir="${PNPM_BIN:+$(dirname "$PNPM_BIN")}"
  prefix=""
  if [ -n "$node_dir" ]; then prefix="$node_dir"; fi
  if [ -n "$pnpm_dir" ] && [ "$pnpm_dir" != "$node_dir" ]; then
    prefix="${prefix:+${prefix}:}${pnpm_dir}"
  fi
  printf '%s%s/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
    "${prefix}" \
    "${prefix:+:}"
}

ensure_os_packages() {
  log "检测并安装系统依赖"
  case "$(detect_pm)" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y ca-certificates curl git rsync bash tar gzip xz-utils build-essential python3 python3-venv python3-pip make g++
      ;;
    dnf)
      dnf install -y ca-certificates curl git rsync bash tar gzip xz gcc gcc-c++ make python3 python3-pip
      ;;
    yum)
      yum install -y ca-certificates curl git rsync bash tar gzip xz gcc gcc-c++ make python3 python3-pip
      ;;
    pacman)
      pacman -Sy --noconfirm --needed ca-certificates curl git rsync bash tar gzip xz base-devel python python-pip
      ;;
    apk)
      apk add --no-cache ca-certificates curl git rsync bash tar gzip xz build-base python3 py3-pip py3-virtualenv nodejs npm
      ;;
    *)
      fail "不支持的包管理器，请先安装 curl/git/rsync/bash/nodejs/npm/python3/make/g++。"
      ;;
  esac
}

ensure_node() {
  local current_major
  current_major="$(node_major_version)"

  if [ "$current_major" -ge 20 ] && have_cmd npm; then
    resolve_bins
    log "Node.js 可用：$(node -v) (${NODE_BIN})"
    return
  fi

  if [ "$INSTALL_NODE" = "0" ] || [ "$INSTALL_NODE" = "false" ]; then
    fail "Node.js 20+ 不存在，且 INSTALL_NODE=0。"
  fi

  log "安装 Node.js ${NODE_MAJOR}.x"
  case "$(detect_pm)" in
    apt)
      apt-get install -y nodejs npm
      ;;
    dnf)
      dnf install -y nodejs npm
      ;;
    yum)
      yum install -y nodejs npm
      ;;
    apk)
      apk add --no-cache nodejs npm
      ;;
    *)
      fail "无法自动安装 Node.js，请先安装 Node.js 20+。"
      ;;
  esac

  current_major="$(node_major_version)"
  [ "$current_major" -ge 20 ] || fail "Node.js 版本仍低于 20：$(node -v 2>/dev/null || echo not-found)"
  have_cmd npm || fail "npm 不存在，请检查 Node.js 安装。"
  resolve_bins
  log "Node.js 可用：$(node -v) (${NODE_BIN})"
}

ensure_pnpm() {
  log "安装/修复 pnpm ${PNPM_VERSION}"
  npm install -g "pnpm@${PNPM_VERSION}" --force
  resolve_bins
  [ -n "$PNPM_BIN" ] || fail "pnpm 安装失败。"
  log "pnpm 可用：$(pnpm -v) (${PNPM_BIN})"
}

ensure_dirs() {
  log "准备目录"
  install -d -m 0755 "$APP_DIR" "$DATA_DIR" "$RUNTIME_DIR" "$CANVAS_ASSET_DIR" "$LOG_DIR"
}

ensure_codex_python() {
  if [ "$INSTALL_CODEX_SDK" = "0" ] || [ "$INSTALL_CODEX_SDK" = "false" ] || [ "$INSTALL_CODEX_SDK" = "no" ]; then
    warn "INSTALL_CODEX_SDK=0，跳过 Codex Python SDK 安装。"
    CODEX_PYTHON_BIN="${MIOBOT_CODEX_PYTHON:-$(command -v python3 2>/dev/null || command -v python 2>/dev/null || echo python3)}"
    return
  fi

  local base_python
  base_python="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
  [ -n "$base_python" ] || fail "找不到 Python。请先安装 python3。"

  if [ -n "${MIOBOT_CODEX_PYTHON:-}" ]; then
    CODEX_PYTHON_BIN="$MIOBOT_CODEX_PYTHON"
    [ -x "$CODEX_PYTHON_BIN" ] || fail "MIOBOT_CODEX_PYTHON 不可执行：$CODEX_PYTHON_BIN"
    log "使用自定义 Codex Python：$CODEX_PYTHON_BIN"
  else
    log "准备 Codex Python 虚拟环境：$CODEX_VENV_DIR"
    if [ ! -x "${CODEX_VENV_DIR}/bin/python" ]; then
      "$base_python" -m venv "$CODEX_VENV_DIR" || fail "创建 Python venv 失败。Debian/Ubuntu 可手动执行：apt-get update && apt-get install -y python3-venv python3-pip"
    fi
    CODEX_PYTHON_BIN="${CODEX_VENV_DIR}/bin/python"
  fi

  log "安装/更新 Codex Python SDK：openai-codex"
  "$CODEX_PYTHON_BIN" -m ensurepip --upgrade >/dev/null 2>&1 || true
  "$CODEX_PYTHON_BIN" -m pip install --upgrade pip setuptools wheel
  "$CODEX_PYTHON_BIN" -m pip install --upgrade openai-codex
  "$CODEX_PYTHON_BIN" - <<'PY'
import openai_codex
print(f"openai-codex {openai_codex.__version__} ready")
PY
}

backup_config() {
  if [ ! -f "$CONFIG_PATH" ]; then
    warn "没有发现配置文件，跳过备份：$CONFIG_PATH"
    return
  fi
  local backup_dir backup_file
  backup_dir="${DATA_DIR}/backups"
  backup_file="${backup_dir}/config.$(date +%Y%m%d-%H%M%S).json"
  install -d -m 0755 "$backup_dir"
  cp -a "$CONFIG_PATH" "$backup_file"
  log "已备份配置：$backup_file"
}

backup_runtime_data() {
  local backup_dir stamp
  backup_dir="${DATA_DIR}/backups"
  stamp="$(date +%Y%m%d-%H%M%S)"
  install -d -m 0755 "$backup_dir"

  if [ -f "$CONFIG_PATH" ]; then
    cp -a "$CONFIG_PATH" "${backup_dir}/config.${stamp}.json"
    log "已备份配置：${backup_dir}/config.${stamp}.json"
  else
    warn "没有发现配置文件，跳过配置备份：$CONFIG_PATH"
  fi

  if [ -f "$CANVAS_STATE_PATH" ]; then
    cp -a "$CANVAS_STATE_PATH" "${backup_dir}/canvas-state.${stamp}.json"
    log "已备份画布/模板库状态：${backup_dir}/canvas-state.${stamp}.json"
  else
    warn "没有发现画布状态文件，跳过状态备份：$CANVAS_STATE_PATH"
  fi

  if [ -d "$CANVAS_ASSET_DIR" ] && [ -n "$(find "$CANVAS_ASSET_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    tar -C "$(dirname "$CANVAS_ASSET_DIR")" -czf "${backup_dir}/canvas-assets.${stamp}.tar.gz" "$(basename "$CANVAS_ASSET_DIR")"
    log "已备份画布/模板库图片资源：${backup_dir}/canvas-assets.${stamp}.tar.gz"
  fi
}

migrate_legacy_runtime_config() {
  if [ -f "$CONFIG_PATH" ]; then
    return
  fi

  local candidate
  for candidate in \
    "$APP_DIR/.runtime/config.json" \
    "$PROJECT_SOURCE/.runtime/config.json"
  do
    if [ -f "$candidate" ]; then
      install -d -m 0755 "$(dirname "$CONFIG_PATH")"
      cp -a "$candidate" "$CONFIG_PATH"
      chmod 0644 "$CONFIG_PATH"
      log "已迁移旧配置：$candidate -> $CONFIG_PATH"
      return
    fi
  done
}

merge_legacy_canvas_state_file() {
  local source_state="$1"
  [ -f "$source_state" ] || return

  if [ ! -f "$CANVAS_STATE_PATH" ]; then
    install -d -m 0755 "$(dirname "$CANVAS_STATE_PATH")"
    cp -a "$source_state" "$CANVAS_STATE_PATH"
    chmod 0644 "$CANVAS_STATE_PATH"
    log "已迁移旧画布/模板库状态：$source_state -> $CANVAS_STATE_PATH"
    return
  fi

  local merge_report
  merge_report="$("${NODE_BIN:-node}" - "$CANVAS_STATE_PATH" "$source_state" <<'NODE'
const fs = require('fs');
const [targetPath, sourcePath] = process.argv.slice(2);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function byId(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item && item.id || item && item.outputId || '');
    const key = id || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function interrogationsOf(state) {
  if (Array.isArray(state.interrogations)) return state.interrogations;
  if (Array.isArray(state.project?.interrogations)) return state.project.interrogations;
  return [];
}

const target = readJson(targetPath);
const source = readJson(sourcePath);
const mergedInterrogations = byId([...interrogationsOf(target), ...interrogationsOf(source)]);
const mergedGallery = byId([...(Array.isArray(target.gallery) ? target.gallery : []), ...(Array.isArray(source.gallery) ? source.gallery : [])]);
const mergedAssets = byId([...(Array.isArray(target.assets) ? target.assets : []), ...(Array.isArray(source.assets) ? source.assets : [])]);

const beforeInterrogations = interrogationsOf(target).length;
const beforeGallery = Array.isArray(target.gallery) ? target.gallery.length : 0;
target.version = target.version || source.version || 1;
target.savedAt = new Date().toISOString();
target.gallery = mergedGallery;
target.interrogations = mergedInterrogations;
target.assets = mergedAssets;
target.project = target.project && typeof target.project === 'object' ? target.project : {};
target.project.interrogations = mergedInterrogations;
target.project.history = Array.isArray(target.project.history)
  ? target.project.history
  : (Array.isArray(source.project?.history) ? source.project.history : []);
target.project.updatedAt = target.savedAt;
fs.writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  addedInterrogations: Math.max(0, mergedInterrogations.length - beforeInterrogations),
  addedGallery: Math.max(0, mergedGallery.length - beforeGallery),
}));
NODE
)"
  log "已合并旧画布/模板库状态：$source_state -> $CANVAS_STATE_PATH ${merge_report}"
}

migrate_legacy_canvas_runtime() {
  local candidate
  for candidate in \
    "$APP_DIR/.runtime" \
    "$PROJECT_SOURCE/.runtime"
  do
    [ -d "$candidate" ] || continue

    if [ -f "$candidate/canvas-state.json" ]; then
      merge_legacy_canvas_state_file "$candidate/canvas-state.json" || true
    fi

    if [ -d "$candidate/canvas-assets" ]; then
      install -d -m 0755 "$CANVAS_ASSET_DIR"
      rsync -a "$candidate/canvas-assets/" "$CANVAS_ASSET_DIR/"
      log "已合并旧画布/模板库图片资源：$candidate/canvas-assets/ -> $CANVAS_ASSET_DIR/"
    fi
  done
}

sync_source() {
  local source_real app_real
  source_real="$(cd -- "$PROJECT_SOURCE" && pwd -P)"
  app_real="$(mkdir -p "$APP_DIR" && cd -- "$APP_DIR" && pwd -P)"

  if [ "$source_real" = "$app_real" ]; then
    warn "源码目录就是 APP_DIR，跳过 rsync：$APP_DIR"
    return
  fi

  log "同步项目到 $APP_DIR"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude '.runtime/' \
    --exclude '.codex/' \
    --exclude '.codex-run/' \
    --exclude '.venv-codex/' \
    --exclude 'node_modules/' \
    --exclude 'web-panel/node_modules/' \
    --exclude 'web-canvas/node_modules/' \
    --exclude 'web-canvas/apps/*/node_modules/' \
    --exclude 'web-canvas/packages/*/node_modules/' \
    --exclude 'web-panel/dist/' \
    --exclude 'web-canvas/apps/web/dist/' \
    "$source_real/" "$APP_DIR/"
}

find_git_repo_dir() {
  local candidate
  for candidate in "$PROJECT_SOURCE" "$SCRIPT_DIR" "$APP_DIR"; do
    if [ -d "$candidate/.git" ]; then
      (cd -- "$candidate" && pwd -P)
      return 0
    fi
  done
  return 1
}

git_worktree_dirty() {
  local repo_dir="$1"
  [ -n "$(cd -- "$repo_dir" && git status --porcelain)" ]
}

git_pull_source() {
  have_cmd git || ensure_os_packages

  local repo_dir branch before after upstream
  repo_dir="$(find_git_repo_dir)" || fail "没有找到 Git 仓库，无法一键拉取。请在源码目录执行：git clone https://github.com/mio-cc/miobot-image2.git"

  log "准备拉取 Git 更新：$repo_dir"
  (cd -- "$repo_dir" && git rev-parse --is-inside-work-tree >/dev/null) || fail "不是有效 Git 仓库：$repo_dir"

  if git_worktree_dirty "$repo_dir"; then
    if [ "$GIT_ALLOW_DIRTY" = "stash" ] || [ "$GIT_ALLOW_DIRTY" = "1" ] || [ "$GIT_ALLOW_DIRTY" = "true" ]; then
      log "检测到本地未提交修改，自动 stash 后继续拉取"
      (cd -- "$repo_dir" && git stash push -u -m "miobot auto stash before update $(date +%Y%m%d-%H%M%S)")
    else
      (cd -- "$repo_dir" && git status --short)
      fail "源码目录存在未提交修改，为避免覆盖已停止。确认要自动暂存可执行：GIT_ALLOW_DIRTY=stash bash deploy-linux.sh git-update"
    fi
  fi

  branch="${GIT_BRANCH:-$(cd -- "$repo_dir" && git branch --show-current)}"
  [ -n "$branch" ] || fail "当前 Git 不在分支上，请设置 GIT_BRANCH=main 后重试。"

  before="$(cd -- "$repo_dir" && git rev-parse --short HEAD)"
  log "拉取远端：${GIT_REMOTE}/${branch}（当前 ${before}）"
  (cd -- "$repo_dir" && git fetch --prune "$GIT_REMOTE")
  upstream="$(cd -- "$repo_dir" && git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -n "$upstream" ]; then
    (cd -- "$repo_dir" && git pull --ff-only)
  else
    (cd -- "$repo_dir" && git pull --ff-only "$GIT_REMOTE" "$branch")
  fi
  after="$(cd -- "$repo_dir" && git rev-parse --short HEAD)"

  if [ "$before" = "$after" ]; then
    log "Git 已经是最新版本：$after"
  else
    log "Git 已更新：$before -> $after"
  fi

  PROJECT_SOURCE="$repo_dir"
}

npm_install_dir() {
  local dir="$1"
  if [ "$STRICT_LOCKFILE" = "1" ] || [ "$STRICT_LOCKFILE" = "true" ]; then
    (cd "$dir" && npm ci)
  else
    (cd "$dir" && npm install)
  fi
}

install_dependencies() {
  export PATH="$(managed_path)"

  log "安装根项目依赖"
  npm_install_dir "$APP_DIR"

  log "安装后台前端依赖"
  npm_install_dir "$APP_DIR/web-panel"

  log "安装画布前端依赖"
  if [ "$STRICT_LOCKFILE" = "1" ] || [ "$STRICT_LOCKFILE" = "true" ]; then
    (cd "$APP_DIR/web-canvas" && pnpm install --frozen-lockfile)
  else
    (cd "$APP_DIR/web-canvas" && pnpm install --no-frozen-lockfile)
  fi
}

build_project() {
  export PATH="$(managed_path)"

  log "构建根项目"
  (cd "$APP_DIR" && npm run build)

  if [ "$RUN_TESTS" = "1" ] || [ "$RUN_TESTS" = "true" ]; then
    log "运行测试"
    (cd "$APP_DIR" && npm test)
  fi

  log "构建后台前端"
  (cd "$APP_DIR/web-panel" && npm run build)
  install -d -m 0755 "$APP_DIR/apps/panel/static/admin"
  rsync -a --delete "$APP_DIR/web-panel/dist/" "$APP_DIR/apps/panel/static/admin/"

  log "构建画布前端"
  (cd "$APP_DIR/web-canvas" && pnpm --filter @gpt-image-canvas/shared build)
  (cd "$APP_DIR/web-canvas" && pnpm --filter @gpt-image-canvas/web build)
  install -d -m 0755 "$APP_DIR/apps/panel/static/canvas"
  rsync -a --delete "$APP_DIR/web-canvas/apps/web/dist/" "$APP_DIR/apps/panel/static/canvas/"
}

write_env_file() {
  resolve_bins
  [ -n "$NODE_BIN" ] || fail "找不到 node。"
  [ -n "$PNPM_BIN" ] || fail "找不到 pnpm。"

  log "写入环境文件：$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
MIOBOT_HOST=${HOST}
MIOBOT_PORT=${PORT}
MIOBOT_VERIFY_PORT=${PORT}
MIOBOT_ENABLE_BOT=${MIOBOT_ENABLE_BOT:-1}
MIOBOT_RUNTIME_DIR=${RUNTIME_DIR}
MIOBOT_CONFIG_PATH=${CONFIG_PATH}
MIOBOT_CANVAS_STATE_PATH=${CANVAS_STATE_PATH}
MIOBOT_CANVAS_ASSET_DIR=${CANVAS_ASSET_DIR}
MIOBOT_LOG_DIR=${LOG_DIR}
MIOBOT_SYSTEM_LOG_PATH=${LOG_DIR}/system.ndjson
MIOBOT_CANVAS_LOG_PATH=${LOG_DIR}/canvas.ndjson
MIOBOT_BOT_LOG_PATH=${LOG_DIR}/system.ndjson
MIOBOT_CODEX_PYTHON=${CODEX_PYTHON_BIN}
MIOBOT_CODEX_REMOTE_ENABLED=${MIOBOT_CODEX_REMOTE_ENABLED:-1}
DATA_DIR=${DATA_DIR}
LOG_DIR=${LOG_DIR}
PATH=$(managed_path)
EOF
  chmod 0644 "$ENV_FILE"
}

write_systemd_unit() {
  have_cmd systemctl || fail "当前系统没有 systemd/systemctl。"
  resolve_bins
  [ -n "$NODE_BIN" ] || fail "找不到 node。"

  log "写入 systemd 服务：${SERVICE_NAME}.service"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Miobot v2 Admin, Canvas and Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN} scripts/miobot-service.mjs
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
SyslogIdentifier=${SERVICE_NAME}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
}

service_exists() {
  [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]
}

service_start() {
  service_exists || { ensure_node; ensure_pnpm; ensure_dirs; write_env_file; write_systemd_unit; }
  systemctl start "$SERVICE_NAME"
  health_check || true
}

service_stop() {
  service_exists || { warn "服务不存在：${SERVICE_NAME}"; return; }
  systemctl stop "$SERVICE_NAME"
}

service_restart() {
  service_exists || { ensure_node; ensure_pnpm; ensure_dirs; write_env_file; write_systemd_unit; }
  systemctl restart "$SERVICE_NAME"
  health_check || true
}

service_status() {
  if have_cmd systemctl && service_exists; then
    systemctl status "$SERVICE_NAME" --no-pager
  else
    warn "服务不存在：${SERVICE_NAME}"
  fi
}

service_logs() {
  have_cmd journalctl || fail "journalctl 不存在。"
  journalctl -u "$SERVICE_NAME" -n "${LINES:-200}" -f
}

health_check() {
  local url ok
  url="http://localhost:${PORT}/canvas-api/health"
  ok=0
  log "健康检查：$url"
  for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -fsS "$url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = "1" ]; then
    log "健康检查通过：$url"
    return 0
  fi
  warn "健康检查未通过。查看日志：journalctl -u ${SERVICE_NAME} -n 120 --no-pager"
  return 1
}

doctor() {
  resolve_bins
  cat <<EOF
Miobot Linux Doctor
-------------------
User:             $(id -un) (uid=$(id -u))
OS:               $(uname -a)
Package manager:  $(detect_pm)
App name:         ${APP_NAME}
Service:          ${SERVICE_NAME}
App dir:          ${APP_DIR}
Source dir:       ${PROJECT_SOURCE}
Data dir:         ${DATA_DIR}
Runtime dir:      ${RUNTIME_DIR}
Config path:      ${CONFIG_PATH}
Canvas state:     ${CANVAS_STATE_PATH}
Canvas assets:    ${CANVAS_ASSET_DIR}
Log dir:          ${LOG_DIR}
System log:       ${LOG_DIR}/system.ndjson
Canvas log:       ${LOG_DIR}/canvas.ndjson
Env file:         ${ENV_FILE}
Host/Port:        ${HOST}:${PORT}
Codex venv:       ${CODEX_VENV_DIR}
Codex Python:     ${CODEX_PYTHON_BIN}
Codex SDK:        $("$CODEX_PYTHON_BIN" -c 'import openai_codex; print(openai_codex.__version__)' 2>/dev/null || echo not-installed)
Node:             ${NODE_BIN:-not-found} $(node -v 2>/dev/null || true)
npm:              ${NPM_BIN:-not-found} $(npm -v 2>/dev/null || true)
pnpm:             ${PNPM_BIN:-not-found} $(pnpm -v 2>/dev/null || true)
systemctl:        $(command -v systemctl 2>/dev/null || echo not-found)
curl:             $(command -v curl 2>/dev/null || echo not-found)
rsync:            $(command -v rsync 2>/dev/null || echo not-found)
Config exists:    $([ -f "$CONFIG_PATH" ] && echo yes || echo no)
Canvas state:     $([ -f "$CANVAS_STATE_PATH" ] && echo yes || echo no)
Canvas assets:    $([ -d "$CANVAS_ASSET_DIR" ] && echo yes || echo no)
Service exists:   $(service_exists && echo yes || echo no)
EOF
  if have_cmd systemctl && service_exists; then
    echo "Service active:   $(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
    echo "Service enabled:  $(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
  fi
  if have_cmd ss; then
    echo "Port listening:"
    ss -lntp 2>/dev/null | grep -E ":${PORT}\\b" || true
  fi
}

install_all() {
  require_root
  ensure_os_packages
  ensure_node
  ensure_pnpm
  ensure_dirs
  backup_runtime_data
  sync_source
  ensure_codex_python
  migrate_legacy_runtime_config
  migrate_legacy_canvas_runtime
  install_dependencies
  build_project
  write_env_file
  write_systemd_unit
  service_restart
  print_summary
}

rebuild_all() {
  require_root
  ensure_os_packages
  ensure_node
  ensure_pnpm
  ensure_dirs
  backup_runtime_data
  sync_source
  ensure_codex_python
  migrate_legacy_runtime_config
  migrate_legacy_canvas_runtime
  install_dependencies
  build_project
  write_env_file
  write_systemd_unit
  service_restart
  print_summary
}

git_update_all() {
  require_root
  git_pull_source
  rebuild_all
}

env_only() {
  require_root
  ensure_os_packages
  ensure_node
  ensure_pnpm
  ensure_dirs
  ensure_codex_python
  migrate_legacy_runtime_config
  migrate_legacy_canvas_runtime
  write_env_file
  write_systemd_unit
  doctor
}

restore_config() {
  require_root
  local source="${1:-}"
  [ -n "$source" ] || fail "用法：bash deploy-linux.sh restore-config /path/to/config.json"
  [ -f "$source" ] || fail "配置文件不存在：$source"
  ensure_dirs
  backup_config
  cp -a "$source" "$CONFIG_PATH"
  chmod 0644 "$CONFIG_PATH"
  log "已恢复配置到：$CONFIG_PATH"
  service_restart
}

uninstall_service() {
  require_root
  if have_cmd systemctl && service_exists; then
    systemctl stop "$SERVICE_NAME" || true
    systemctl disable "$SERVICE_NAME" || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
  fi
  rm -f "$ENV_FILE"
  if [ "${PURGE_DATA:-0}" = "1" ]; then
    rm -rf "$APP_DIR" "$DATA_DIR" "$LOG_DIR"
    warn "已删除 APP_DIR/DATA_DIR/LOG_DIR。"
  else
    warn "已移除服务，保留应用和数据目录。如需删除数据：PURGE_DATA=1 bash deploy-linux.sh uninstall"
  fi
}

print_summary() {
  cat <<EOF

完成。

访问地址：
  http://<服务器IP>:${PORT}/canvas/
  http://<服务器IP>:${PORT}/admin/

常用命令：
  bash deploy-linux.sh status
  bash deploy-linux.sh logs
  bash deploy-linux.sh restart
  bash deploy-linux.sh rebuild

配置持久化：
  ${CONFIG_PATH}
画廊/模板库持久化：
  ${CANVAS_STATE_PATH}
  ${CANVAS_ASSET_DIR}

服务：
  ${SERVICE_NAME}

EOF
}

usage() {
  cat <<EOF
Miobot v2 Linux 运维脚本（root-only）

用法：
  bash deploy-linux.sh <命令>

命令：
  install         首次部署：检测环境 -> 安装依赖 -> 构建 -> 写 systemd -> 启动
  deploy          同 install
  git-update      一键拉取 Git 更新：git pull -> 备份配置/画廊/模板库 -> 构建 -> 重启
  pull            同 git-update
  rebuild         一键重构：备份配置/画廊/模板库 -> 同步源码 -> 依赖 -> 构建 -> 重启（不拉 Git）
  env             只检测/安装系统环境并写 systemd/env
  doctor          打印环境诊断，不改动系统
  start           启动服务
  stop            停止服务
  restart         重启服务
  status          查看服务状态
  logs            追踪日志，LINES=300 可调整初始行数
  health          健康检查
  backup-config   仅备份 ${CONFIG_PATH}
  backup-data     备份配置、画廊、模板库状态和图片资源
  restore-config  恢复配置：restore-config /path/to/config.json
  uninstall       移除 systemd 服务；PURGE_DATA=1 时同时删应用和数据

常用变量：
  APP_DIR=${APP_DIR}
  PORT=${PORT}
  HOST=${HOST}
  DATA_DIR=${DATA_DIR}
  MIOBOT_CONFIG_PATH=${CONFIG_PATH}
  MIOBOT_CANVAS_STATE_PATH=${CANVAS_STATE_PATH}
  MIOBOT_CANVAS_ASSET_DIR=${CANVAS_ASSET_DIR}
  RUN_TESTS=1
  STRICT_LOCKFILE=1
  INSTALL_CODEX_SDK=1
  MIOBOT_CODEX_VENV_DIR=${CODEX_VENV_DIR}
  MIOBOT_CODEX_PYTHON=${CODEX_PYTHON_BIN}
  MIOBOT_CODEX_REMOTE_ENABLED=1
  GIT_REMOTE=${GIT_REMOTE}
  GIT_BRANCH=main
  GIT_ALLOW_DIRTY=stash

示例：
  bash deploy-linux.sh install
  bash deploy-linux.sh git-update
  bash deploy-linux.sh rebuild
  PORT=3018 HOST=0.0.0.0 bash deploy-linux.sh install
EOF
}

run_action() {
  ACTION="${1:-help}"
  shift || true
  case "$ACTION" in
    install|deploy) install_all "$@" ;;
    git-update|pull|git-pull|upgrade|update) git_update_all "$@" ;;
    rebuild|build) rebuild_all "$@" ;;
    env|doctor-fix) env_only "$@" ;;
    doctor|check) doctor "$@" ;;
    start) require_root; service_start "$@" ;;
    stop) require_root; service_stop "$@" ;;
    restart) require_root; service_restart "$@" ;;
    status) service_status "$@" ;;
    logs|log|tail) service_logs "$@" ;;
    health) health_check "$@" ;;
    backup-config) require_root; ensure_dirs; backup_config "$@" ;;
    backup-data|backup) require_root; ensure_dirs; backup_runtime_data "$@" ;;
    restore-config|restore) restore_config "$@" ;;
    uninstall|remove) uninstall_service "$@" ;;
    help|-h|--help) usage ;;
    *) usage; fail "未知命令：$ACTION" ;;
  esac
}

pause_menu() {
  printf '\n按回车返回菜单...'
  read -r _ || true
}

interactive_menu() {
  while true; do
    clear 2>/dev/null || true
    cat <<EOF
========================================
 Miobot v2 Linux 一体化运维菜单（root）
========================================
 当前配置：
   应用目录： ${APP_DIR}
   服务名称： ${SERVICE_NAME}
   监听端口： ${PORT}
   配置文件： ${CONFIG_PATH}
   画布状态： ${CANVAS_STATE_PATH}

  1) 首次部署 / 安装环境 / 构建 / 启动
  2) 启动服务
  3) 停止服务
  4) 重启服务
  5) 查看服务状态
  6) 查看实时日志
  7) 一键拉取 Git 更新 / 重新构建 / 重启
  8) 一键重构 / 重新构建 / 重启（不拉 Git）
  9) 环境检测
 10) 健康检查
 11) 备份配置/画廊/模板库
 12) 只修复环境和 systemd 配置
 13) 卸载 systemd 服务（默认保留数据）
  0) 退出

EOF
    printf '请输入序号：'
    read -r choice || exit 0
    case "$choice" in
      1) run_action install; pause_menu ;;
      2) run_action start; pause_menu ;;
      3) run_action stop; pause_menu ;;
      4) run_action restart; pause_menu ;;
      5) run_action status; pause_menu ;;
      6) run_action logs ;;
      7) run_action git-update; pause_menu ;;
      8) run_action rebuild; pause_menu ;;
      9) run_action doctor; pause_menu ;;
      10) run_action health; pause_menu ;;
      11) run_action backup-data; pause_menu ;;
      12) run_action env; pause_menu ;;
      13) run_action uninstall; pause_menu ;;
      0|q|Q|exit) exit 0 ;;
      *) warn "无效序号：$choice"; pause_menu ;;
    esac
  done
}

if [ "$#" -eq 0 ]; then
  interactive_menu
else
  run_action "$@"
fi
