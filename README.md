# Miobot Image Bot v2

Miobot Image Bot v2 是一个面向 Napcat / QQ 场景的图像机器人与 Web 管理面板项目。它把后台配置、画布生成、模板库反推、Bot 消息处理和 Linux 运维脚本整合到一个仓库中，目标是让部署、配置和日常维护尽量简单。

> 默认 Web 端口：`3018`  
> 默认 Linux 服务名：`miobot-v2`  
> 默认配置文件：`/var/lib/miobot-v2/config.json`

## 功能概览

- **后台管理**：节点、模型、Bot、自由模式、提示词模板、画布日志和卡片管理。
- **图像画布**：文生图、参考图改图、遮罩改图、画廊、模板库、收藏、预览和下载。
- **图片反推 / 模板库**：上传图片后反推出可复用提示词模板，并保存到模板库。
- **Napcat Bot 接入**：支持群聊/私聊命令、自由模式规划、图片生成、改图、反推、模板调用等能力。
- **异步任务反馈**：生图、改图、反推等耗时操作会以任务卡片形式展示进度。
- **Linux 一体化运维**：中文菜单脚本支持安装、启动、停止、重启、日志、健康检查、重构、拉取 Git 更新。

## 项目来源与声明

本项目的画布前端相关能力基于 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 进行二次开发、重构与集成。上游项目是基于 OpenAI `gpt-image-2` API 的图片生成与编辑工具，仓库页面标注为 MIT License。

本仓库在其基础上加入了适配 Miobot / Napcat Bot 的后台配置、模板库、反推流程、异步任务、卡片管理、运维脚本和 Bot 运行时等能力。使用、分发或二次开发时请同时尊重上游项目的许可证与作者声明。

## 目录结构

```text
.
├── apps/                         # 服务静态资源挂载目录
├── packages/                     # Bot、配置、LLM、Napcat、Web API 等核心包
├── scripts/                      # 本地验证服务、Bot runtime、组合启动服务
├── tests/                        # Node.js 测试
├── web-canvas/                   # 图像画布前端/接口，二开自 gpt_image_playground
├── web-panel/                    # Vue 后台管理面板
├── deploy-linux.sh               # Linux 中文一体化运维脚本
├── package.json
└── README.md
```

## 快速部署（Linux / root）

项目按 root-only 部署设计，不会创建 `miobot` 用户。

```bash
git clone https://github.com/mio-cc/miobot-image2.git
cd miobot-image2
bash deploy-linux.sh
```

进入中文菜单后常用选项：

```text
1) 首次部署 / 安装环境 / 构建 / 启动
7) 一键拉取 Git 更新 / 重新构建 / 重启
8) 一键重构 / 重新构建 / 重启（不拉 Git）
```

也可以直接执行命令：

```bash
bash deploy-linux.sh install      # 首次安装并启动
bash deploy-linux.sh git-update  # 拉取 Git 更新、重新构建并重启
bash deploy-linux.sh rebuild     # 不拉 Git，仅重新构建并重启
bash deploy-linux.sh start       # 启动服务
bash deploy-linux.sh stop        # 停止服务
bash deploy-linux.sh restart     # 重启服务
bash deploy-linux.sh status      # 查看 systemd 状态
bash deploy-linux.sh logs        # 查看实时日志
bash deploy-linux.sh doctor      # 环境诊断
bash deploy-linux.sh health      # 健康检查
```

如果服务器源码目录有未提交修改，`git-update` 默认会停止以避免覆盖。确认要自动暂存后再更新可执行：

```bash
GIT_ALLOW_DIRTY=stash bash deploy-linux.sh git-update
```

## 访问地址

部署完成后访问：

```text
http://<服务器IP>:3018/canvas/
http://<服务器IP>:3018/admin/
```

如需改端口：

```bash
PORT=3018 HOST=0.0.0.0 bash deploy-linux.sh install
```

## 默认路径

| 项目 | 默认值 |
| --- | --- |
| 应用目录 | `/opt/miobot-v2` |
| 数据目录 | `/var/lib/miobot-v2` |
| 配置文件 | `/var/lib/miobot-v2/config.json` |
| 画布/图库状态 | `/var/lib/miobot-v2/canvas-state.json` |
| 图库图片资产 | `/var/lib/miobot-v2/canvas-assets/` |
| 日志目录 | `/var/log/miobot-v2` |
| 环境文件 | `/etc/miobot-v2.env` |
| systemd 服务 | `miobot-v2` |
| Web 端口 | `3018` |


## Bot 生图回图与图库（Napcat 容器）

v2 Bot 生图/改图成功后会先把结果写入 Canvas 图库，再把图库里的图片 URL 交给 Napcat。这样图片可以同时出现在前端图库和 QQ 回复中，并避免通过 WebSocket 传输很大的 base64 图片帧。

图库数据默认位于：

```text
/var/lib/miobot-v2/canvas-state.json
/var/lib/miobot-v2/canvas-assets/
```

图库同步和图片下载由 Miobot 自身提供：

```text
POST /canvas-api/bot/gallery
GET  /canvas-api/assets/<assetId>/download
```


### QQ 输入图片内联

部分 OpenAI 兼容网关不接受 QQ 多媒体签名 URL，会报：

```text
Unsupported image_url format
```

v2 Bot 默认会先把 QQ 消息中的 http(s) 图片下载并转成 `data:image/...;base64,...`，再交给意图路由和视觉模型。默认上限：

```bash
MIOBOT_INLINE_REMOTE_IMAGES=1
MIOBOT_INLINE_IMAGE_MAX_BYTES=20971520
MIOBOT_INLINE_IMAGE_TIMEOUT_MS=15000
```

如果上游模型可以直接读取远程 URL，可设置 `MIOBOT_INLINE_REMOTE_IMAGES=0` 关闭内联。下载失败、超时或不是图片时会保留原 URL，不阻断消息处理。

排查图片输入时，日志会给出脱敏后的引用类型：

```text
收到消息 ... imageRefs: [ "https://multimedia.nt.qq.com.cn" ]
输入图片已内联为 data URL
模型输入图片准备完成 ... imageRefs: [ "data-url" ]
```

如果 `imageRefs` 显示 `local:xxx.image`，说明 Napcat 没有提供可访问的图片 URL，需要检查 Napcat 的图片上报格式。

### 配置 Napcat 可访问的图片 URL

Miobot 和 Napcat 不在同一个容器/网络命名空间时，必须配置一个 **Napcat 容器能够访问的 Miobot 地址**：

```bash
# 首次安装时设置
MIOBOT_PUBLIC_BASE_URL=http://host.docker.internal:3018 bash deploy-linux.sh install

# 已安装后拉取更新时一并写入环境文件并重启
MIOBOT_PUBLIC_BASE_URL=http://host.docker.internal:3018 bash deploy-linux.sh git-update
```

或者编辑 `/etc/miobot-v2.env`：

```bash
MIOBOT_PUBLIC_BASE_URL=http://host.docker.internal:3018
MIOBOT_SYNC_BOT_GALLERY=1
MIOBOT_CANVAS_SYNC_TIMEOUT_MS=15000
```

然后重启：

```bash
bash deploy-linux.sh restart
```

Napcat Compose 需要让容器能解析宿主机地址：

```yaml
services:
  napcat:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

也可以把 `MIOBOT_PUBLIC_BASE_URL` 换成宿主机内网 IP，例如：

```text
http://192.168.1.10:3018
```

不要使用 `http://127.0.0.1:3018`：在 Napcat 容器内部，`127.0.0.1` 指的是 Napcat 容器自己。

如果 Miobot Web 和 Bot 不在同一个网络里，还可以单独指定图库同步接口：

```bash
MIOBOT_CANVAS_SYNC_URL=http://miobot-web:3018/canvas-api/bot/gallery
```

部署后发一次 `画 一只猫`，Miobot 日志应出现 `Bot images synced to canvas gallery`，前端画布图库应出现新图，Napcat 日志应出现 `send_group_msg`，且图片字段是 HTTP URL。

`MIOBOT_SYNC_BOT_GALLERY=0` 可以关闭生图自动入库。未配置 `MIOBOT_PUBLIC_BASE_URL` 时，图片仍会尝试写入图库，但回复会回退到原始 base64 图片；大图可能仍会遇到 Napcat WebSocket 帧限制。

## 本地开发 / 验证

```bash
npm install
npm run build
npm test
npm start
```

单独构建后台：

```bash
npm --prefix web-panel install
npm --prefix web-panel run build
```

单独构建画布：

```bash
npm install -g pnpm@9.14.2 --force
pnpm --dir web-canvas install --no-frozen-lockfile
pnpm --dir web-canvas build
```

本地启动后：

```text
http://127.0.0.1:3018/canvas/
http://127.0.0.1:3018/admin/
```

## 配置与安全

- 后台导入/保存的配置会持久化到 `MIOBOT_CONFIG_PATH`，Linux 默认是 `/var/lib/miobot-v2/config.json`。
- 请不要把真实 API Key、Token、私有域名、服务器 IP、Cookie、数据库或运行时日志提交到 Git。
- `.runtime/`、`.codex-run/`、`node_modules/`、构建产物和本地图片等目录已在 `.gitignore` 中排除。
- 如果已经泄露真实密钥，请先去上游服务商处轮换密钥，再清理 Git 历史。

## 常见问题

### 端口打不开

先检查服务状态和监听端口：

```bash
bash deploy-linux.sh status
bash deploy-linux.sh logs
bash deploy-linux.sh health
ss -lntp | grep 3018
```

确认服务器防火墙、安全组或面板放行了 `3018`。

### Bot 无响应

确认 Napcat WebSocket 地址和 Token 已在后台配置，并检查日志：

```bash
bash deploy-linux.sh logs
```

如果日志出现 `ECONNREFUSED 127.0.0.1:3001`，表示当前机器连接不到 Napcat WebSocket，需要先启动 Napcat 或修正后台配置的 Napcat 地址。

### 拉取 Git 更新

```bash
cd /opt/miobot-v2   # 或你的源码目录
bash deploy-linux.sh git-update
```

如果你是从另一个源码目录同步到 `/opt/miobot-v2`，在源码目录执行脚本即可，脚本会同步到 `APP_DIR`。

## License / Credits

- 画布前端二次开发来源：[CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)
- 上游许可证：MIT License（请以该上游仓库当前许可证文件为准）
- 本项目包含对上游画布能力的集成与二次开发，以及 Miobot / Napcat 相关后台、Bot runtime 与部署脚本。
