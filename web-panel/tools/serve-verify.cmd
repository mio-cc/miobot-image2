@echo off
REM Phase-UI 验证服务：隔离 runtime + 固定登录种子，供无头浏览器核查使用。
REM 用法： web-panel\tools\serve-verify.cmd
setlocal
cd /d "%~dp0..\.."

set MIOBOT_PORT=3018
set MIOBOT_HOST=127.0.0.1
set MIOBOT_RUNTIME_DIR=%~dp0..\.verify\runtime
set MIOBOT_CONFIG_PATH=%~dp0..\.verify\runtime\config.json
set MIOBOT_LOG_DIR=%~dp0..\.verify\runtime\logs
set MIOBOT_SYSTEM_LOG_PATH=%~dp0..\.verify\runtime\logs\system.ndjson
set MIOBOT_CANVAS_LOG_PATH=%~dp0..\.verify\runtime\logs\canvas.ndjson
set MIOBOT_CANVAS_STATE_PATH=%~dp0..\.verify\runtime\canvas-state.json
set MIOBOT_CANVAS_ASSET_DIR=%~dp0..\.verify\runtime\canvas-assets

if not exist "%~dp0..\.verify\runtime" mkdir "%~dp0..\.verify\runtime"
if not exist "%~dp0..\.verify\runtime\config.json" (
  echo {"panel":{"port":3018,"passwordSeed":"verify-seed"}} > "%~dp0..\.verify\runtime\config.json"
)

echo [serve-verify] http://127.0.0.1:3018/admin/  (password: verify-seed)
node scripts\local-verify-server.mjs
