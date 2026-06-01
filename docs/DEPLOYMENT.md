# Linux 运维部署说明

本项目使用一个中文菜单脚本 `deploy-linux.sh` 管理 Linux 部署，目标是直接以 `root` 安装和运行，不创建额外的 `miobot` 用户。

## 交互菜单

```bash
cd Napcat-OmniBot-v2
bash deploy-linux.sh
```

菜单包含启动、停止、重启、状态、日志、一键重构、环境检测、健康检查、卸载 systemd 服务等选项。

## 常用非交互命令

```bash
bash deploy-linux.sh install    # 首次安装 / 同步 / 构建 / 写入 systemd / 启动
bash deploy-linux.sh rebuild    # 一键重构：同步代码、安装依赖、重新构建并重启
bash deploy-linux.sh start      # 启动服务
bash deploy-linux.sh stop       # 停止服务
bash deploy-linux.sh restart    # 重启服务
bash deploy-linux.sh status     # 查看状态
bash deploy-linux.sh logs       # 查看日志
bash deploy-linux.sh doctor     # 自动检测环境
bash deploy-linux.sh health     # 检查 Web 健康状态
```

## 默认路径和端口

- 运行用户：`root`
- systemd 服务：`miobot-v2`
- 应用目录：`/opt/miobot-v2`
- 数据目录：`/var/lib/miobot-v2`
- 配置文件：`/var/lib/miobot-v2/config.json`
- 日志目录：`/var/log/miobot-v2`
- 环境文件：`/etc/miobot-v2.env`
- Web 监听：`0.0.0.0:3018`

## Bot 运行时

`npm start` 和 systemd 默认启动 `scripts/miobot-service.mjs`，它会同时拉起：

- `scripts/local-verify-server.mjs`：后台和画布 Web 服务
- `scripts/bot-runtime.mjs`：Napcat Bot 连接和消息处理

如需临时只启动 Web，不启动 Bot：

```bash
MIOBOT_ENABLE_BOT=0 bash deploy-linux.sh restart
```

## 可覆盖环境变量

```bash
APP_DIR=/opt/miobot-v2 PORT=3018 HOST=0.0.0.0 bash deploy-linux.sh install
RUN_TESTS=1 bash deploy-linux.sh rebuild
STRICT_LOCKFILE=1 bash deploy-linux.sh rebuild
```

后台导入配置后会保存到 `/var/lib/miobot-v2/config.json`，请不要把真实 API Key、Token、域名或 IP 提交到 Git。
