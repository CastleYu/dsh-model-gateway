# DSH Model Gateway

在 DSH 内托管“任意自定义模型网关进程”，并把它注册成 DSH 的模型路由。

它解决的是同一类重复劳动：二次开发者写了一个 `server.py` / `gateway.mjs` / 自研二进制，运行后在本机开放一个模型服务；过去用户必须自己开终端启动它，再在 DSH 里配置 endpoint，进程挂了也要手动重启。这个插件把“进程 + endpoint + 模型路由 + 日志”收进一个 Cordis Host 插件：

- 随 DSH 启动自动拉起网关；
- 启动时做 readiness 探测，就绪后才接模型请求；
- 运行中做健康检查，连续失败自动回收并重启；
- 进程崩溃按指数退避重启，并带重启预算；
- 插件卸载 / DSH 正常退出时停掉整个进程树（并额外安装进程退出兜底）；
- 为每个网关注册一条 OpenAI Chat Completions 模型路由；
- 提供 `gateway_status` / `gateway_control` / `gateway_logs` / `gateway_selftest` 工具；
- 内部日志同时捕获 stdout/stderr、生命周期 trace、HTTP 状态和协议诊断，支持落盘 JSONL 与敏感字段脱敏。

> 网关进程负责“把非标准上游翻译成 OpenAI Chat Completions”。插件负责进程和 DSH 路由。这样任何语言、任何私有协议都可以用“写一个本地 server + 一份 YAML”接入，而不需要修改 DSH 本身。

## 组成

```
packages/
  dsh-model-gateway/                 # 框架 bundle
    index.js                         # Host 插件入口
    lib/config.js                    # 配置归一化/校验
    lib/supervisor.js                # 启动/健康检查/崩溃重启/停止
    lib/openai-adapter.js            # OpenAI Chat Completions -> DSH StreamChunk
    lib/log-store.js                 # 环形日志 + JSONL + 脱敏 trace
    lib/tools.js                     # 4 个生命周期/诊断工具
    examples/opencode-go/server.py   # 可运行的 OpenCode Go 网关
    test/                             # node:test 单元/集成测试
  dsh-model-gateway-demo/            # 演示 bundle：一条真实配置
```

框架包本身不依赖 `@deepseek-ai/*` 的 ESM 导入，只使用 Node 内置模块和 Cordis `ctx`。这是刻意设计：profile 本地包在 Windows 下通过 junction 解析 DSH 包时不可靠；运行时服务走 `ctx` 更稳。

## 快速开始

> 想要“照着命令复制就能跑”的版本：见仓库根目录 [QUICKSTART.md](../../QUICKSTART.md)。下面保留配置与生命周期细节。

### 1. 安装框架

在 DSH 里对 `packages/dsh-model-gateway` 执行 Plugin Manager 的 `install_bundle`。它只插入一个空的 `model-gateway` 行，此时插件处于 dormant 状态。

### 2. 安装演示配置

对 `packages/dsh-model-gateway-demo` 执行 `install_bundle`。它插入第二条 `model-gateway` 行：

- 网关 id：`opencode-go`
- 进程：`python examples/opencode-go/server.py`（相对框架包目录）
- 监听：`127.0.0.1:47180`
- 健康检查：`GET /health`
- DSH 模型路由：`gateway-opencode-go`
- 模型：`deepseek-v4.1-flash`、`glm-5.3-flash`、`kimi-k3`

演示网关是 `auto` 模式：

- 如果 DSH 启动环境里有 `OPENCODE_GO_API_KEY`，它直接代理真实 OpenCode Go API；
- 没有 key 时自动进入 mock 模式，仍然按真实 SSE 协议返回 reasoning/text/usage，可以完整验证 DSH 链路。

真实模式使用：

```powershell
# 在启动 DSH 的同一环境里设置，之后重启 DSH
$env:OPENCODE_GO_API_KEY = "sk-..."
```

OpenCode Go 文档要求客户端发送稳定会话头，演示配置已经设置：

```yaml
provider:
  sessionHeader: x-opencode-session
```

适配器会把 DSH 的 `sessionId` 放进该头，`server.py` 再转发给上游；没有 session 时网关会生成一个稳定的进程级 id。

### 3. 选择模型

模型路由注册后，在 DSH 的模型选择器里选择 provider `OpenCode Go (local gateway)`，模型 `DeepSeek V4.1 Flash` / `GLM-5.3 Flash` / `Kimi K3` 即可。

即使不切换默认模型，也可以直接让 Agent 调用：

```json
gateway_selftest({ "prompt": "Reply with exactly: gateway ok" })
```

它会通过 DSH 的 `ctx.llm.stream()` 走完整链路：DSH LLM 服务 → 插件注册的 adapter → 本地 `server.py` → OpenCode Go（或 mock）→ SSE → DSH StreamChunk。

## 接入自己的网关

以二次开发者的 `server.py` 为例，只需要让本地服务提供最小 OpenAI 兼容面：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 返回 2xx 表示就绪；也可改用 TCP 检查 |
| GET | `/v1/models` | 可选；返回 `{ "data": [{ "id": "..." }] }` |
| POST | `/v1/chat/completions` | 接收 Chat Completions，`stream: true` 时返回 SSE |

然后在 `cordis.patch.yml` 里增加一条配置（不要直接改 profile 的 `cordis.patch.yml`；把它放进自己的 bundle，或作为更高层 patch）：

```yaml
- insert:
    - id: my-gateway
      name: '@local/dsh-model-gateway'
      config:
        gateways:
          my-model:
            displayName: My Model
            command: python
            script: path/to/server.py
            cwd: H:/path/to/project
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

重启 DSH 后，`my-model` 就会作为 `my-model` provider 路由出现；进程由插件自动拉起。

最小骨架可以直接复制：

- `examples/template/server.py`：只依赖标准库的 OpenAI 兼容 echo 网关；
- `examples/template/cordis.patch.yml`：对应的插件配置模板。

### 用法要点

- `command` 可以不是 Python：Node、Go、Rust、Java、.NET、自研 exe 都可以。
- `script` 是相对于 `cwd` 的脚本路径，会作为第一个参数追加到命令行；`args` 是其余参数。
- `port` 会自动注入环境变量 `PORT`（若 `env.PORT` 未显式设置）和 `HOST`。
- `env` 支持 `${env:NAME}` 展开；示例把 `OPENCODE_GO_API_KEY` 透传给子进程，而不是写进 YAML。
- `health.type` 可为 `http`、`tcp`、`none`。不配置时：有端口用 `tcp`，否则用 `http` 检查 `baseURL`。
- `restart.maxRestarts` 是滑动窗口内的重启预算；预算耗尽会进入 `failed`，可通过 `gateway_control` 手动恢复。
- `autoStart: false` 时插件不主动启动；首次模型请求会通过 `startOnRequest`（默认 true）启动。

## 配置参考

顶层：

```yaml
config:
  gateways:
    <id>:
      ...
```

每个网关：

| 字段 | 默认 | 说明 |
|---|---|---|
| `displayName` | id | 展示名 |
| `description` | 无 | 展示描述 |
| `command` | 必填 | 可执行文件 |
| `script` | 无 | 脚本路径，相对 `cwd` |
| `args` | `[]` | 额外参数 |
| `cwd` | 进程当前目录 | 工作目录 |
| `resolveFrom` | `cwd` | `package` 表示以插件包目录为相对路径基准 |
| `env` | `{}` | 子进程环境变量；`null` 表示删除 |
| `shell` | `false` | 是否经 shell 启动（`.cmd`/`.bat` 时需要） |
| `port` | `0` | 注入 `PORT`；0 表示不注入 |
| `host` | `127.0.0.1` | 注入 `HOST`，健康检查使用 |
| `autoStart` | `true` | 插件加载后自动启动 |
| `checkPort` | `true` | 启动前检查端口占用 |
| `reuseExisting` | `false` | 端口已被占用时复用现有监听者（不推荐） |
| `stopTimeoutMs` | 5000 | 停止超时；Windows 上直接强杀进程树 |
| `health` | 见下 | 就绪/存活检查 |
| `restart` | 见下 | 崩溃/看门狗重启策略 |
| `logs` | 见下 | 日志环和落盘 |
| `provider` | 有 | 模型路由；`false` 表示只托管进程 |

`health`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `type` | 有端口 `tcp`，否则 `http` | `http` / `tcp` / `none` |
| `url` | 无 | HTTP 检查地址 |
| `path` | 无 | 以 `baseURL` 的 origin 拼接 |
| `intervalMs` | 5000 | 运行期检查间隔 |
| `timeoutMs` | 2500 | 单次检查超时 |
| `startupTimeoutMs` | 30000 | 启动就绪总超时 |
| `failureThreshold` | 3 | 连续失败多少次触发回收 |
| `successThreshold` | 1 | 连续成功多少次视为健康 |
| `expectStatus` | 2xx-4xx | 期望状态码 |
| `bodyIncludes` | 无 | 响应体必须包含的标记 |
| `allowAnyStatus` | `true` | 2xx-4xx 都算存活 |

`restart`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否自动重启 |
| `maxRestarts` | `5` | 窗口内最多重启次数 |
| `windowMs` | `3600000` | 滑动窗口 |
| `initialDelayMs` | `1000` | 首次退避 |
| `maxDelayMs` | `30000` | 退避上限 |
| `stableAfterMs` | `60000` | 保留字段；重启预算按 `windowMs` 滑动窗口计算 |

`logs`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxLines` | `2000` | 环形缓冲最大行数 |
| `maxBytes` | `1048576` | 环形缓冲最大字节 |
| `file` | 无 | JSONL 落盘路径，相对 `cwd` |

`provider`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `route` | `gateway-<id>` | DSH provider 路由名 |
| `displayName` | 网关 displayName | 模型选择器展示名 |
| `baseURL` | `http://host:port/v1` | 网关 OpenAI 根地址 |
| `requestPath` | `/chat/completions` | 请求路径 |
| `models` | `[]` | 模型元数据；GUI 选择依赖它 |
| `modelsURL` | 自动 | `/models` 地址覆盖 |
| `discoverModels` | `true` | 未配置 models 时是否请求 `/models` |
| `apiKeyEnv` | 无 | 转发给网关的 Bearer key 的环境变量名 |
| `apiKey` | 无 | 直接写 key（不推荐） |
| `headers` | `{}` | 额外请求头 |
| `sessionHeader` | 无 | 把 DSH sessionId 发到该请求头，如 `x-opencode-session` |
| `sendSessionHeader` | `true` | 是否发送 sessionHeader |
| `connectTimeoutMs` | 30s | 建立连接超时 |
| `streamIdleTimeoutMs` | 300s | 流空闲超时 |
| `maxTokensField` | `max_tokens` | `max_tokens` / `max_completion_tokens` |
| `reasoningFields` | 常见字段 | 从 delta 中提取 reasoning 的字段名 |
| `trace` | `summary` | `off` / `summary` / `verbose` |
| `startOnRequest` | `true` | 模型请求到来时自动启动 |

模型项：

```yaml
models:
  - id: my-model
    name: My Model
    contextWindow: 131072
    maxTokens: 8192
    input: [text, image]       # 只有真实支持图片时才声明 image
    reasoningEfforts:
      low: low
      high: high
    defaultReasoningEffort: low
```

## 生命周期与故障语义

状态机：

```
disabled -> idle -> starting -> running -> stopping -> stopped
                         |          |
                         +-> failed  +-> crashed -> restarting -> starting
```

- 启动：先检查端口，spawn 子进程，轮询 readiness；超时/子进程提前退出 → 杀掉进程，进入 `failed` 并按预算安排重启。
- 运行：独立看门狗定时检查 health；连续失败达到阈值后停止并重新启动。
- 崩溃：非主动停止的退出计入重启预算，指数退避 + 抖动；预算耗尽后 `failed`，不会无限重启。
- 停止：Windows 使用 `taskkill /T /F` 杀掉整个进程树；POSIX 先 `SIGTERM` 进程组，超时再 `SIGKILL`。
- 卸载：插件 effect 清理时停止所有网关、取消定时器、关闭日志流；另外注册了 `process.once('exit')` 进程树兜底。正常 DSH 退出不会留下孤儿进程；DSH 被强杀（如任务管理器结束进程）时，Node 无法执行任何清理，这种极端情况仍可能留下子进程。
- 请求时网关未运行：`startOnRequest` 打开时自动启动；关闭时返回 `GATEWAY_DOWN` 失败。

## 内部日志（进阶）

每个网关有两个日志面：

1. 进程输出：stdout/stderr 按行捕获，带时间戳；
2. 协议 trace：启动/退出/健康失败/重启、HTTP 状态、内容类型、耗时、token usage、错误码、可选的请求体和 SSE 事件（`trace: verbose`）。

通过 `gateway_logs` 读取：

```json
gateway_logs({ "id": "opencode-go", "limit": 120, "stream": "trace" })
```

也可以直接看落盘文件：

```
packages/dsh-model-gateway/logs/opencode-go.jsonl
```

安全约束：

- trace 对 `authorization`、`apiKey`、`token`、`cookie` 等**精确键名**做脱敏；
- 默认 `summary` 不记录完整 prompt/响应体；
- `verbose` 会记录截断后的请求体和 SSE 事件，只应在定位协议问题时临时打开；
- 日志环有行数/字节上限，落盘文件不做轮转，生产环境建议配合外部轮转。

## 工具

| 工具 | 作用 |
|---|---|
| `gateway_status` | 状态、PID、健康、重启次数、模型、日志路径 |
| `gateway_control` | `start` / `stop` / `restart` 指定网关 |
| `gateway_logs` | 读取 stdout/stderr/system/trace 日志 |
| `gateway_selftest` | 通过 DSH LLM 服务做一次真实流式调用，返回 text/finish/usage/耗时 |

工具注册为全局 Host 工具，因此任何 Agent（受各自 preset 限制）都能看到它们。

## OpenCode Go 示例

`examples/opencode-go/server.py` 是一个不依赖第三方库的本地网关：

- `GET /health`：模式、上游、模型、会话 id；
- `GET /v1/models`：模型列表；
- `POST /v1/chat/completions`：
  - `mock`：确定性 reasoning + text + usage SSE；
  - `live`：透传 `https://opencode.ai/inference/go/openai/v1/chat/completions`，自动带 `Authorization`、`x-opencode-session`、自定义 User-Agent；
- 上游 HTTP 错误原样转发；流式响应逐行 flush；日志写 stderr，由插件捕获。

真实 OpenCode Go 需要付费订阅的 API key；如果没有 key，`auto` 模式会退回 mock，协议形态保持一致。DSH 侧不需要知道当前是 mock 还是 live。

## 验证结果

本仓库完成时已实际验证：

- `node --test packages/dsh-model-gateway/test/gateway.test.mjs`：13/13 通过（启动/流式、截断流、损坏 SSE、length 工具调用、启动预检、启动期退出、崩溃重启、重启预算耗尽、健康看门狗、禁用重启、配置、SSE、脱敏）；
- `gateway_status`：`running`、健康、PID、模型路由；
- `gateway_selftest`：真实 OpenCode Go 流式响应，返回 `gateway ok` / `restart ok` / `autostart ok`；
- 手动 `taskkill` 网关进程后：插件在约 1 秒内拉起新 PID，`restarts: 1`，随后自测成功；
- `gateway_control stop` 后：下一次模型请求触发 `startOnRequest` 自动拉起并成功；
- 启动日志、health 失败、上游 HTTP 状态、SSE 完成、token usage 均进入内部日志。

## 已知边界

- 适配器只实现 **OpenAI Chat Completions**。Anthropic Messages、Responses API、Gemini 原生协议等，需要在网关进程里翻译成 Chat Completions；也可以复制 `openai-adapter.js` 扩展。
- 不支持多路复用/负载均衡；一个网关 id 对应一个进程和一个 endpoint。
- `apiKeyEnv` 读取的是 DSH Host 进程环境，不读取 OpenCode/其他客户端的 auth.json。
- 没有 Web 设置页；配置入口是 Cordis patch / bundle。工具和日志是给 Agent 和运维用的。
- Windows 停止采用强杀进程树；若网关需要优雅落盘，建议在 POSIX 或 WSL 下运行，或把状态写到外部存储。
- 日志文件不轮转；`verbose` trace 可能包含用户 prompt 的截断副本。
