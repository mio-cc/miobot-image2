#!/usr/bin/env bash
set -Eeuo pipefail

# Miobot v2 root-only Linux all-in-one operations script.
# Default interactive menu:
#   bash deploy-linux.sh
# Command mode:
#   bash deploy-linux.sh install
#   bash deploy-linux.sh rebuild
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
LOG_DIR="${LOG_DIR:-/var/log/${APP_NAME}}"
ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"

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
      apt-get install -y ca-certificates curl git rsync bash tar gzip xz-utils build-essential python3 make g++
      ;;
    dnf)
      dnf install -y ca-certificates curl git rsync bash tar gzip xz gcc gcc-c++ make python3
      ;;
    yum)
      yum install -y ca-certificates curl git rsync bash tar gzip xz gcc gcc-c++ make python3
      ;;
    pacman)
      pacman -Sy --noconfirm --needed ca-certificates curl git rsync bash tar gzip xz base-devel python
      ;;
    apk)
      apk add --no-cache ca-certificates curl git rsync bash tar gzip xz build-base python3 nodejs npm
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
  install -d -m 0755 "$APP_DIR" "$DATA_DIR" "$RUNTIME_DIR" "$LOG_DIR"
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
    --exclude '.codex-run/' \
    --exclude 'node_modules/' \
    --exclude 'web-panel/node_modules/' \
    --exclude 'web-canvas/node_modules/' \
    --exclude 'web-canvas/apps/*/node_modules/' \
    --exclude 'web-canvas/packages/*/node_modules/' \
    --exclude 'web-panel/dist/' \
    --exclude 'web-canvas/apps/web/dist/' \
    "$source_real/" "$APP_DIR/"
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
MIOBOT_RUNTIME_DIR=${RUNTIME_DIR}
MIOBOT_CONFIG_PATH=${CONFIG_PATH}
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
Description=Miobot v2 Admin and Canvas
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN} scripts/local-verify-server.mjs
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
Log dir:          ${LOG_DIR}
Env file:         ${ENV_FILE}
Host/Port:        ${HOST}:${PORT}
Node:             ${NODE_BIN:-not-found} $(node -v 2>/dev/null || true)
npm:              ${NPM_BIN:-not-found} $(npm -v 2>/dev/null || true)
pnpm:             ${PNPM_BIN:-not-found} $(pnpm -v 2>/dev/null || true)
systemctl:        $(command -v systemctl 2>/dev/null || echo not-found)
curl:             $(command -v curl 2>/dev/null || echo not-found)
rsync:            $(command -v rsync 2>/dev/null || echo not-found)
Config exists:    $([ -f "$CONFIG_PATH" ] && echo yes || echo no)
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
  backup_config
  sync_source
  migrate_legacy_runtime_config
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
  backup_config
  sync_source
  migrate_legacy_runtime_config
  install_dependencies
  build_project
  write_env_file
  write_systemd_unit
  service_restart
  print_summary
}

env_only() {
  require_root
  ensure_os_packages
  ensure_node
  ensure_pnpm
  ensure_dirs
  migrate_legacy_runtime_config
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
  rebuild         一键重构：备份配置 -> 同步源码 -> 依赖 -> 构建 -> 重启
  env             只检测/安装系统环境并写 systemd/env
  doctor          打印环境诊断，不改动系统
  start           启动服务
  stop            停止服务
  restart         重启服务
  status          查看服务状态
  logs            追踪日志，LINES=300 可调整初始行数
  health          健康检查
  backup-config   备份 ${CONFIG_PATH}
  restore-config  恢复配置：restore-config /path/to/config.json
  uninstall       移除 systemd 服务；PURGE_DATA=1 时同时删应用和数据

常用变量：
  APP_DIR=${APP_DIR}
  PORT=${PORT}
  HOST=${HOST}
  DATA_DIR=${DATA_DIR}
  MIOBOT_CONFIG_PATH=${CONFIG_PATH}
  RUN_TESTS=1
  STRICT_LOCKFILE=1

示例：
  bash deploy-linux.sh install
  bash deploy-linux.sh rebuild
  PORT=3018 HOST=0.0.0.0 bash deploy-linux.sh install
EOF
}

run_action() {
  ACTION="${1:-help}"
  shift || true
  case "$ACTION" in
    install|deploy) install_all "$@" ;;
    rebuild|build|update) rebuild_all "$@" ;;
    env|doctor-fix) env_only "$@" ;;
    doctor|check) doctor "$@" ;;
    start) require_root; service_start "$@" ;;
    stop) require_root; service_stop "$@" ;;
    restart) require_root; service_restart "$@" ;;
    status) service_status "$@" ;;
    logs|log|tail) service_logs "$@" ;;
    health) health_check "$@" ;;
    backup-config|backup) require_root; ensure_dirs; backup_config "$@" ;;
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

  1) 首次部署 / 安装环境 / 构建 / 启动
  2) 启动服务
  3) 停止服务
  4) 重启服务
  5) 查看服务状态
  6) 查看实时日志
  7) 一键重构 / 更新代码 / 重新构建 / 重启
  8) 环境检测
  9) 健康检查
 10) 备份配置
 11) 只修复环境和 systemd 配置
 12) 卸载 systemd 服务（默认保留数据）
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
      7) run_action rebuild; pause_menu ;;
      8) run_action doctor; pause_menu ;;
      9) run_action health; pause_menu ;;
      10) run_action backup-config; pause_menu ;;
      11) run_action env; pause_menu ;;
      12) run_action uninstall; pause_menu ;;
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
