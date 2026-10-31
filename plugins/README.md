# Miobot 内置能力插件

`novel-platform.mjs`：起点 / 番茄 / 七猫网文榜单、书籍查询与跨天对比能力。

安装方式：

- 本地：复制到数据目录的 `capabilities/novel-platform.mjs`，重启 bot。
- Linux 部署：`deploy-linux.sh` 会把本目录的 `*.mjs` 安装到 `RUNTIME_DIR/capabilities/`（已存在的同名文件不会被覆盖）。
- 插件配置文件：`capabilities/novel-platform.config.json`。
- 插件清单：`capabilities/plugins.json`，后台能力中心可读取。
