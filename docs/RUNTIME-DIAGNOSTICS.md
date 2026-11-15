# 运行时诊断

脚本：

```text
scripts/runtime-diagnostics.sh
scripts/runtime-diagnostics.mjs
```

## 快速查询

```bash
cd /opt/1panel/docker/compose/root/miobot-image2
sudo bash scripts/runtime-diagnostics.sh
```

默认会采集两次 CPU 样本，间隔 1 秒，并输出：

- CPU 使用率、load average、CPU/IO/memory pressure
- 内存和根分区
- `miobot-v2` systemd 状态、MainPID、重启次数
- CPU 最高的进程
- Node 进程完整启动参数
- MainPID 进程树
- MainPID 线程 CPU
- 3018/3000 端口监听
- 最近 120 行 journal

## 常用参数

```bash
# 采样 5 次，每次 2 秒
sudo bash scripts/runtime-diagnostics.sh --samples 5 --interval 2

# 保存文本报告
sudo bash scripts/runtime-diagnostics.sh --save /tmp/miobot-runtime.txt

# JSON 输出
sudo bash scripts/runtime-diagnostics.sh --json --save /tmp/miobot-runtime.json

# 不读取 journal
sudo bash scripts/runtime-diagnostics.sh --no-journal

# 更改服务名或显示条数
sudo bash scripts/runtime-diagnostics.sh --service miobot-v2 --top 20
```

## 怎么读

先看 CPU samples：

```text
load=0.50/0.60/0.70  cpu=12.3%
load=1.90/1.70/1.20  cpu=94.8%
```

`nproc=2` 时 load 2.0 表示两个核心基本满载。

再看 Top processes 里两个 Node：

```text
local-verify-server-v2.mjs   web/admin/canvas
bot-runtime-v2.mjs           QQ bot
```

它们都是 `miobot-v2.service` 的正常子进程。重点看是否持续高 CPU，而不是启动瞬间的初始化。

如果 `bot-runtime-v2.mjs` 持续高 CPU，检查 JOURNAL 里的 memory/embedding/mcp/agent/render 日志；如果 `local-verify-server-v2.mjs` 持续高 CPU，检查后台轮询、MCP 状态接口和端口请求。
