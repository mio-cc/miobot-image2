# miohh OneBot 适配说明（miobot → miohh）

## 1. 连接配置

`config.json`（或后台配置）里的 `napcat` 段现在支持 `backend` 字段：

```json
{
  "napcat": {
    "backend": "miohh",
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "<miohh OneBot WS accessToken>",
    "mountOutputDir": "/var/lib/miobot/out",
    "mountOutputContainerDir": "/var/lib/miobot/out"
  }
}
```

- `backend: "miohh"`：miobot 与 miohh 部署在**同一台主机**，文件路径直传宿主路径；
- `backend: "napcat"`（默认）：保持原有 NapCat 容器语义，`mountOutputContainerDir` 写容器内路径。

## 2. Token 从哪来

miohh 的 OneBot token 在运行时数据目录：

```
/opt/miohh/data/runtime/config/onebot_<uin>.json
```

对应字段：

- WS Server：`networks.wsServers[0].accessToken`（默认端口 3001）
- HTTP Server：`networks.httpServers[0].accessToken`（默认端口 3000）

## 3. 环境变量覆盖（便于部署）

```bash
MIOBOT_ONEBOT_BACKEND=miohh
MIOBOT_ONEBOT_WS_URL=ws://127.0.0.1:3001
MIOBOT_ONEBOT_TOKEN=<ws accessToken>
```

兼容旧变量名：`MIOBOT_NAPCAT_WS_URL` / `MIOBOT_NAPCAT_TOKEN`。

## 4. 文件/图片/语音路径

miohh 与 miobot 同机时：

- `mountOutputDir` 与 `mountOutputContainerDir` 填**同一个宿主目录**（如 `/var/lib/miobot/out`）；
- 出站图片/语音会落到该目录，miobot 发送 `file:///var/lib/miobot/out/...`，miohh runtime 直接读取；
- 无需 NapCat 容器映射。

## 5. 验收

```bash
# OneBot HTTP 探活（用 HTTP token）
curl -H "Authorization: Bearer <httpToken>" http://127.0.0.1:3000/get_status

# miobot 启动后日志应出现：
#   OneBot 适配器初始化 backend="miohh" wsUrl="ws://127.0.0.1:3001"
#   napcat 连接成功（协议 v11）
```

> 说明：miobot 内部包名仍叫 `@miobot-v2/napcat`（历史命名），它是通用 OneBot v11 适配器；miohh 通过 `backend: "miohh"` 复用同一实现。
