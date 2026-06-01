# Napcat-OmniBot v2

## Linux 一键部署

以 `root` 运行即可，脚本不会创建 `miobot` 用户。默认服务名为 `miobot-v2`，默认端口为 `3018`，同一个 systemd 服务会同时启动后台、画布和 Bot 运行时。

```bash
bash deploy-linux.sh
```

也可以直接执行常用动作：

```bash
bash deploy-linux.sh install
bash deploy-linux.sh rebuild
bash deploy-linux.sh restart
bash deploy-linux.sh logs
bash deploy-linux.sh doctor
```

配置保存位置默认为 `/var/lib/miobot-v2/config.json`。后台导入配置并保存后，Bot 会自动检测 Napcat 地址/Token 变化并重连；更新代码或依赖后建议执行 `rebuild`。

更多运维命令见 `docs/DEPLOYMENT.md`。
