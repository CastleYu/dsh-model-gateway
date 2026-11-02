# Quickstart

从 clone 到“DSH 里能用模型”，走下面任意一条路径。三条路径都不要把 API key 写进仓库。

- **A. 先跑通链路（不需要 API key）**：mock 网关，验证插件、进程、SSE、DSH 路由。
- **B. 接真实 OpenCode Go**：有订阅 key 时，代理真实上游。
- **C. 接自己的 server.py**：复制模板，做一个自己的 bundle。

> 适用环境：Windows + PowerShell 7，DSH Desktop 已启动。Linux/macOS 的 DSH 安装步骤相同，但下面的 PowerShell 命令需要换成对应 shell 写法（`$env:NAME` 换成 `export NAME=`，路径分隔符换成 `/`）。

---

## 0. 先确认三件事

```powershell
git --version
node --version     # 需要 >= 22
python --version   # 演示网关需要 Python 3.10+
```

然后在 DSH 中确认 Plugin Manager 可见（Settings → Plugins / 设置 → 插件）。如果只习惯让 Agent 操作，也可以把安装步骤直接交给它（见 A-2）。

```powershell
git clone https://github.com/CastleYu/dsh-model-gateway.git
cd dsh-model-gateway
$Repo = (Get-Location).Path
Write-Output $Repo
```

后面所有路径都用 `$Repo` 指代仓库根目录。**安装时不要输入 `$Repo` 字面量**——GUI 不会展开 PowerShell 变量。先打印实际路径：

```powershell
Write-Output "$Repo\packages\dsh-model-gateway"
Write-Output "$Repo\packages\dsh-model-gateway-demo"
```

把打印出来的两个路径分别复制到 DSH 的安装框里。

### 三条路径怎么选

| 你的目标 | 走法 |
|---|---|
| 先确认插件/进程/SSE/DSH 路由能通，没有 key | A |
| 有 OpenCode Go key，要真实模型 | A → B |
| 要接自己写的 `server.py` / 私有协议 | A → C |

---

## A. 零 API key 跑通链路（推荐第一次执行）

### A-1. 安装框架 bundle

在 DSH 的 **Plugin Manager → Install bundle** 中选择：

```text
$Repo\packages\dsh-model-gateway
```

它只插入一条空的 `model-gateway` 行，此时不会有网关进程，属于正常状态。

### A-2. 安装演示 bundle

再安装：

```text
$Repo\packages\dsh-model-gateway-demo
```

这条配置会启动：

```text
python <repo>\packages\dsh-model-gateway\examples\opencode-go\server.py
```

监听 `127.0.0.1:47180`，注册模型路由 `gateway-opencode-go`。

**如果不想点 UI**，把下面这段直接发给 DSH 里的 Agent，路径替换成 `$Repo` 的实际值：

```text
请用 plugin_manager 的 install_bundle，按顺序安装这两个本地 bundle：
1. <repo>\packages\dsh-model-gateway
2. <repo>\packages\dsh-model-gateway-demo
安装完成后调用 gateway_status 和 gateway_selftest，告诉我结果。
```

### A-3. 看状态

让 Agent 调用，或在工具面板中执行：

```json
gateway_status()
```

期望看到（PID、时间会不同）：

```json
{
  "gateways": [
    {
      "id": "opencode-go",
      "state": "running",
      "healthy": true,
      "pid": 327728,
      "provider": "gateway-opencode-go",
      "models": ["deepseek-v4.1-flash", "glm-5.3-flash", "kimi-k3"]
    }
  ]
}
```

只要 `state` 是 `running`、`healthy` 是 `true`，网关就已经被 DSH 托管。

### A-4. 端到端自测

```json
gateway_selftest({ "prompt": "Reply with exactly: gateway ok" })
```

期望：

```json
{
  "ok": true,
  "id": "opencode-go",
  "provider": "gateway-opencode-go",
  "model": "deepseek-v4.1-flash",
  "text": "Mock OpenCode Go gateway is reachable. ...",
  "finish": "stop"
}
```

判定标准不是 `text` 的内容，而是：

- `ok: true`
- `finish: "stop"`
- 没有 `AUTH` / `TRANSPORT` / `GATEWAY_DOWN` 错误

这已经证明：DSH LLM 服务 → 插件 adapter → 本地 Python 进程 → SSE → DSH StreamChunk 全链路通了。

### A-5. 顺手验证守护

```json
gateway_control({ "id": "opencode-go", "action": "restart" })
```

期望 `state: running`、`pid` 发生变化。然后再次 `gateway_selftest`。

---

## B. 接真实 OpenCode Go

前提：OpenCode Go 订阅和 API key（[OpenCode Go 文档](https://opencode.ai/docs/go/)）。

### B-1. 在启动 DSH 的环境里设置 key

关键点：**必须在启动 DSH 的那个环境里设置，而不是在另一个终端里设置后指望正在运行的 DSH 读到。**

最稳妥的做法是写用户级环境变量，然后完全退出 DSH（包括托盘/后台进程）再重新打开：

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_GO_API_KEY", "sk-...", "User")
# 完全退出 DSH，再从开始菜单/桌面重新启动
```

只有从命令行启动 DSH 时，当前窗口的 `$env:OPENCODE_GO_API_KEY` 才会继承给 DSH；桌面图标启动的 DSH 不继承你刚才随手开的终端变量。

演示配置通过 `${env:OPENCODE_GO_API_KEY}` 把它透传给子进程，YAML 里不出现明文 key。

### B-2. 确认模式

重启 DSH 后：

```json
gateway_logs({ "id": "opencode-go", "stream": "stderr", "limit": 20 })
```

期望看到类似：

```text
listening on http://127.0.0.1:47180 mode=live upstream=https://opencode.ai/inference/go/openai/v1
```

`mode=live` 表示 key 已被子进程读到。如果是 `mode=mock`，说明 DSH 进程环境里没有 key，回到 B-1。

### B-3. 真实调用

```json
gateway_selftest({
  "id": "opencode-go",
  "model": "deepseek-v4.1-flash",
  "prompt": "Reply with exactly: live ok"
})
```

期望 `ok: true`、`finish: "stop"`、`text: "live ok"`。也可以换 `glm-5.3-flash` 或 `kimi-k3`。

### B-4. 在模型选择器中使用

在 DSH 的模型选择器里选择 provider：

```text
OpenCode Go (local gateway)
```

再选 `DeepSeek V4.1 Flash` / `GLM-5.3 Flash` / `Kimi K3`。

> 演示路由名是 `gateway-opencode-go`，显示名是 `OpenCode Go (local gateway)`；两者不要混淆。

---

## C. 接自己的 `server.py`

### C-1. 复制最小骨架

```powershell
$My = "$HOME\my-model-gateway"
New-Item -ItemType Directory -Force $My | Out-Null
Copy-Item "$Repo\packages\dsh-model-gateway\examples\template\server.py" "$My\server.py"
```

编辑 `server.py` 中的 `complete()`，接你自己的上游；保持以下 HTTP 面：

| 方法 | 路径 | 要求 |
|---|---|---|
| GET | `/health` | 返回 2xx |
| GET | `/v1/models` | 可选，但 GUI 选择模型建议提供 |
| POST | `/v1/chat/completions` | `stream: true` 时返回 SSE |

先独立确认它能跑：

```powershell
cd $My
$env:PORT = "8099"
python server.py
# 另开一个 PowerShell：
Invoke-RestMethod http://127.0.0.1:8099/health
```

确认 `/health` 返回 200 后，回到运行 `python server.py` 的终端按 `Ctrl+C`，释放 8099 端口，再继续下一步。否则 C-3 安装 bundle 时，插件会正确报告 `PORT_IN_USE`，而你会误以为是配置问题。

### C-2. 创建 bundle 目录

```powershell
$My = (Resolve-Path $My).Path
Write-Output $My      # 把输出中的反斜杠替换成正斜杠，再填到下面的 YAML
New-Item -ItemType Directory -Force "$My\bundle" | Out-Null
```

`bundle\package.json`：

```json
{
  "name": "@local/my-model-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`bundle\cordis.patch.yml`：

```yaml
- insert:
    - id: my-model-gateway
      name: '@local/dsh-model-gateway'
      config:
        gateways:
          my-model:
            displayName: My Model
            command: python
            script: H:/Users/you/my-model-gateway/server.py
            cwd: H:/Users/you/my-model-gateway
            port: 8099
            health:
              type: http
              url: http://127.0.0.1:8099/health
              startupTimeoutMs: 30000
              intervalMs: 5000
              failureThreshold: 3
            restart:
              enabled: true
              maxRestarts: 5
              windowMs: 3600000
              initialDelayMs: 1000
              maxDelayMs: 30000
            provider:
              route: my-model
              displayName: My Model Gateway
              baseURL: http://127.0.0.1:8099/v1
              requestPath: /chat/completions
              models:
                - id: my-model
                  name: My Model
                  contextWindow: 131072
                  maxTokens: 8192
```

把 `script` / `cwd` 改成你的绝对路径。**Windows 路径写进 YAML 时推荐用正斜杠**（如 `C:/Users/you/my-model-gateway`）：双引号里的反斜杠会被 YAML 当作转义符，`C:\Users` 会直接解析失败。

### C-3. 安装并验证

先确保 A-1 的框架 bundle 已安装。如果之前走 A 时安装了 `dsh-model-gateway-demo`，现在请在 Plugin Manager 中**禁用或卸载它**，再安装 `$My\bundle`。

原因：每条 `model-gateway` 行都会注册同名的四个全局工具。一个部署应保持**一条活跃的网关配置行**；多条行会互相遮蔽 `gateway_status()` 的结果，`gateway_selftest`/`gateway_control` 也可能找不到另一个网关。多个网关进程应写进同一条 `gateways:` 映射。

```json
gateway_status()
gateway_selftest({ "id": "my-model", "prompt": "Reply with exactly: my gateway ok" })
```

如果 `gateway_selftest` 成功，模型选择器里会出现 `My Model Gateway` provider。

### C-4. 非标准协议怎么办

不要让 DSH 直接理解私有协议。让你的 `server.py` 负责翻译：

```text
私有上游 / SDK / WebSocket / gRPC / 本地进程
        ↓  你的 server.py
OpenAI Chat Completions（HTTP + SSE）
        ↓  dsh-model-gateway adapter
DSH llm StreamChunk
```

只要你的 server 最终输出 `data: {...}\n\n` 的 OpenAI Chat Completions 事件，DSH 侧不需要改代码。

---

## 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| `gateway_status` 为空或没有工具 | 插件未安装/未启用 | Plugin Manager 检查 `model-gateway` 行；确认 bundle 安装顺序（框架在前） |
| `state: failed`，`lastError` 含 `SCRIPT_MISSING` / `CWD_MISSING` / `ENOENT` | `script`/`cwd` 路径不存在，或 `command`（Python）不在 PATH | 检查 `script`/`cwd` 绝对路径；`python --version`；Windows 可试 `command: python` 或 `command: py` |
| `PORT_IN_USE` | 端口被占 | 先停掉 C-1 手动测试进程；仍占用再改 `port`，并同步 `provider.baseURL` 和 `health.url` |
| `STARTUP_TIMEOUT` | 进程没监听，或 `/health` 不对 | 先手动运行 server；看 `gateway_logs`；必要时增大 `startupTimeoutMs` |
| 启动日志有 `waiting for readiness: http TypeError: fetch failed` | 进程刚启动还没监听，第一次探测失败 | 通常下一次探测会成功；持续出现再查端口/健康地址 |
| `mode=mock` 但想要真实调用 | DSH 进程环境没有 key | 在**启动 DSH 的环境**设置 `OPENCODE_GO_API_KEY`，重启 DSH |
| `AUTH 401/403` | key 无效或过期 | 换 key；确认 OpenCode Go 订阅有效；看 `gateway_logs` 的 `http-error` |
| `MISSING_CREDENTIAL` | provider 配了 `apiKeyEnv` 但环境没有 | 设置对应环境变量，或本地网关不配 key |
| 模型选择器看不到 route | 没有配置 `provider.models`，或插件未激活 | 配 `models`；确认 `providerInfo` 对应 route；重新加载插件 |
| `GATEWAY_DOWN` | 网关被 stop，且 `startOnRequest: false` | `gateway_control start`，或打开 `startOnRequest` |
| `restart budget exhausted` | 短时间崩溃次数超过预算 | 先看日志修根因；禁用/启用插件行以重置预算 |
| Windows 停止时进程还在 | 停止逻辑走 `taskkill /T /F`，极少数权限场景失败 | 看 `gateway_logs` 的 `kill` 记录；必要时手动结束 PID |
| `gateway_logs` 没有内容 | 日志环为空或 stream 过滤错 | 去掉 `stream`；检查 `logs.file` 是否可写 |

常用诊断组合：

```json
gateway_status()
gateway_logs({ "id": "opencode-go", "limit": 100 })
gateway_logs({ "id": "opencode-go", "stream": "trace", "limit": 50 })
gateway_control({ "id": "opencode-go", "action": "restart" })
gateway_selftest({ "id": "opencode-go", "model": "deepseek-v4.1-flash" })
```

---

## 不要提交的东西

- `OPENCODE_GO_API_KEY` 或任何 `sk-...` 明文；
- `packages/dsh-model-gateway/logs/`（已在 `.gitignore`）；
- 网关进程的临时文件、`__pycache__`、用户 prompt 的 verbose trace。

`trace: verbose` 会记录截断后的请求体和 SSE 事件，只应在定位协议问题时临时打开。

---

## 完成检查表

复制这份清单逐项打勾：

```text
[ ] gateway_status 返回 state=running, healthy=true
[ ] gateway_selftest 返回 ok=true, finish=stop
[ ] gateway_logs 能看到进程启动和 trace:request / trace:finish
[ ] gateway_control restart 后 PID 变化且再次 selftest 成功
[ ] 模型选择器能看到对应的 provider / model
[ ] 日志里没有 AUTH / TRANSPORT / STARTUP_TIMEOUT
```

如果第 1 项失败，先看 `gateway_logs`，不要同时改配置和重启插件；项目里所有生命周期失败都会写 `lastError` 和 trace。

---

## 读下一层

- [框架完整配置与生命周期语义](packages/dsh-model-gateway/README.md)
- [OpenCode Go 示例实现](packages/dsh-model-gateway/examples/opencode-go/server.py)
- [最小网关模板](packages/dsh-model-gateway/examples/template/server.py)
- [演示 bundle 配置](packages/dsh-model-gateway-demo/cordis.patch.yml)
- [回归测试](packages/dsh-model-gateway/test/gateway.test.mjs)
