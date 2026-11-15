@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0..\.."

REM 面板预览：隔离 runtime（不碰线上配置），固定登录密码 verify-seed
REM 双击本文件即可，窗口关掉服务就停。

set MIOBOT_PORT=3018
set MIOBOT_HOST=127.0.0.1
set MIOBOT_RUNTIME_DIR=%~dp0..\.verify\runtime
set MIOBOT_CONFIG_PATH=%~dp0..\.verify\runtime\config.json
set MIOBOT_LOG_DIR=%~dp0..\.verify\runtime\logs
set MIOBOT_SYSTEM_LOG_PATH=%~dp0..\.verify\runtime\logs\system.ndjson
set MIOBOT_CANVAS_LOG_PATH=%~dp0..\.verify\runtime\logs\canvas.ndjson

if not exist "%~dp0..\.verify\runtime" mkdir "%~dp0..\.verify\runtime"
if not exist "%~dp0..\.verify\runtime\config.json" (
  echo {"panel":{"port":3018,"passwordSeed":"verify-seed"}} > "%~dp0..\.verify\runtime\config.json"
)

echo.
echo   面板地址: http://127.0.0.1:3018/admin/
echo   登录密码: verify-seed
echo.
echo   关闭此窗口即停止服务。
echo.

node scripts\local-verify-server.mjs
pause
