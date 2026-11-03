# 适配指南：把任意模型服务接进 DSH

这份文档面向**二次开发者**：你有一个模型服务（自研 `server.py`、公司内部网关、私有 SDK、gRPC 服务、别人的 API），想让它出现在 DSH 的模型选择器里，并且由 DSH 负责进程生命周期。

读完你应该能回答四个问题：

1. 我需要写什么？（一个本地 HTTP 服务）
2. 它必须输出什么格式？（OpenAI Chat Completions + SSE）
3. DSH 收不到流式 / 工具调用 / reasoning 时，是哪一层的问题？
4. 我改完怎么在 30 秒内自证它对？

---

## 0. 先选边界：你只需要写一个网关进程

```
你的私有上游（SDK / WebSocket / gRPC / 数据库 / 本地模型）
        │
        │  ① 你的 server.py 负责翻译（任意语言）
        ▼
OpenAI Chat Completions（HTTP + SSE）
        │
        │  ② dsh-model-gateway 的 adapter 负责翻译（不用你写）
        ▼
DSH llm StreamChunk（block-start / text-delta / tool-call-delta / block-end / usage / finish）
```

**不要**让 DSH 直接理解私有协议。②这一层已经做好且经过测试；你要做的只有①。

只有一种情况需要改②：你的上游**本身就是** OpenAI Chat Completions，但你想要的映射和内置 adapter 不同（例如不同的 reasoning 字段、不同的 `max_tokens` 字段名、需要额外请求头）。这些多数是配置项，见第 6 节；确实要改行为时才复制 `lib/openai-adapter.js`。

---

## 1. 最小契约：三个端点

| 方法 | 路径 | 必须 | 说明 |
|---|---|---|---|
| GET | `/health` | 是* | 2xx 表示就绪。*如果配 `health.type: tcp`，可以没有 |
| GET | `/v1/models` | 否 | `{"data":[{"id":"..."}]}`。只在 `provider.models` 为空且 `discoverModels: true` 时被调用 |
| POST | `/v1/chat/completions` | 是 | 核心端点，必须支持 `stream: true` 的 SSE |

网关监听地址来自环境变量：插件会注入 `PORT` 和 `HOST`（若 YAML 的 `env` 里没显式覆盖）。所以网关应该写：

```python
PORT = int(os.environ.get("PORT", "8099"))
HOST = os.environ.get("HOST", "127.0.0.1")
```

路径前缀必须是 `/v1`，因为 `provider.baseURL` 默认是 `http://host:port/v1`，`requestPath` 默认 `/chat/completions`。想用别的路径就同时改这两个配置，不要只改一边。

---

## 2. 请求长什么样

DSH 发来的是标准 Chat Completions 请求体。你可以先用 `curl` 观察真实流量，或把 `provider.trace` 设为 `verbose` 后看 `gateway_logs`。

```json
{
  "model": "my-model",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": null, "tool_calls": [
      {"id": "call_1", "type": "function", "function": {"name": "read", "arguments": "{\"path\":\"a.txt\"}"}}
    ]},
    {"role": "tool", "tool_call_id": "call_1", "content": "file body"}
  ],
  "stream": true,
  "stream_options": {"include_usage": true},
  "max_tokens": 8192,
  "temperature": 0.7,
  "stop": ["..."],
  "tools": [
    {"type": "function", "function": {"name": "read", "description": "...", "parameters": {"type": "object", "properties": {}}}}
  ],
  "tool_choice": "auto",
  "reasoning_effort": "high"
}
```

要点：

- **`stream` 恒为 `true`**：DSH 只走流式。你的网关仍然应该实现非流式分支（第 5 节），因为自检脚本和人工 `curl` 会用到。
- **`messages` 里的 `content` 可能是字符串，也可能是数组**（多模态）：`[{"type":"text","text":"..."},{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]`。
- **`tools` 只在有工具时出现**；`tool_choice` 出现即表示可以调用。
- **`reasoning_effort` 只在模型声明了 `reasoningEfforts` 且调用方选了时才出现**，值已被映射成你要的字符串。
- **`max_tokens` vs `max_completion_tokens`**：由 `provider.maxTokensField` 决定，默认 `max_tokens`。上游只认另一个时改这个配置，不要改代码。
- **`system` 消息恒为第一条**，且只有一条（DSH 会把多个 system/developer 片段合并）。

---

## 3. 响应：SSE 事件语法

这是整个适配里唯一容易写错的部分。逐条对照。

### 3.1 响应头

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
```

`Content-Type` 必须包含 `text/event-stream`。插件靠它判断走 SSE 还是走 JSON 回退；写错会直接进 JSON 分支然后报 `INVALID_RESPONSE`。

### 3.2 一个完整的最小流

```
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}

data: {"choices":[{"index":0,"delta":{"reasoning_content":"I should greet."}}]}

data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"choices":[{"index":0,"delta":{"content":", world"}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}

data: [DONE]

```

规则：

| 规则 | 原因 |
|---|---|
| 每行以 `data: ` 开头，事件以**空行**结束 | SSE 语法；空行才是事件边界 |
| 允许 `\r\n`，允许 `: keepalive` 注释行，允许一个事件多行 `data:` | 解析器已兼容；但不要依赖它 |
| 最后一个事件必须是 `data: [DONE]` | 缺 `[DONE]` 且无 `finish_reason` 会被判为 `TRANSPORT`（截断） |
| `usage` 事件没有 `choices`，或 `choices: []` | OpenAI 的 usage-only chunk 形态 |
| `delta.content` 可为空字符串、可省略 | 空 delta 被忽略，不会产生空块 |
| 首块可以带 `"role":"assistant"`，也可以不带 | 插件只看 `content` / `reasoning` / `tool_calls` |

### 3.3 结束语义

- `finish_reason: "stop"` → DSH 正常结束。
- `finish_reason: "tool_calls"`（或 `"function_call"`）→ DSH 执行工具，然后带着工具结果再请求一次。
- `finish_reason: "length"` / `"max_tokens"` → DSH 标记 `max-tokens`；**此时不完整的工具调用不会被执行**（这是刻意的保护）。
- `finish_reason: "content_filter"` → 按 `stop` 处理。
- 没有 `finish_reason` 也没有 `[DONE]` → `TRANSPORT` 错误。不要用“连接关闭”当结束信号。

> `[DONE]` 之后**不要再发任何事件**。DSH 在 `[DONE]` 处停止读取，但多发的数据可能污染连接复用。

### 3.4 错误

HTTP 非 2xx 时，插件读取响应体并按状态码归类：

| 状态码 | DSH 错误码 | 建议 |
|---|---|---|
| 401 / 403 | `AUTH` | 凭据无效 |
| 429 | `RATE_LIMIT` | 同时发 `Retry-After: <秒>`，插件会转成 `providerRetryAfterMs` |
| 408 / 504 | `TIMEOUT` | |
| 400 / 422 | `INVALID_REQUEST` | 请求体不合法 |
| ≥ 500 | `SERVER` | 上游故障 |
| 其它 | `PROVIDER_ERROR` | |

响应体推荐标准形状，插件会提取 `error.message` 作为错误文本：

```json
{"error": {"message": "model not found", "type": "invalid_request_error", "code": "model_not_found"}}
```

**流中途出错**：HTTP 已经 200 了才发现问题，此时不能再改状态码。发一个错误事件，插件会抛出 `PROVIDER_ERROR`：

```
data: {"error":{"message":"upstream disconnected","code":"upstream"}}

```

不要用 `data: [DONE]` 假装成功——那会让 DSH 收到一条空回复并报 `EMPTY_RESPONSE`，掩盖真实原因。

### 3.5 工具调用流（最容易写错）

工具调用按 **index 分槽**、增量拼接：

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

```

必须遵守：

- `index` 是**工具槽位**，不是数组下标；同一槽位的后续事件可以省略 `id` / `name`，只发 `arguments`。
- `arguments` 是**字符串**，被逐段拼接成完整 JSON。不要发已解析的对象。
- `id` 必须在第一个事件里给出且非空；缺失时插件会生成一个（`call_<uuid>`），但 replay 和工具结果关联会变差。
- 想并行调用多个工具，用不同的 `index`，可以交错发送。

### 3.6 reasoning / 思考内容

在 `delta` 里放以下任一字段，插件会转成 `reasoning-delta` 并渲染为“思考中”：

```
reasoning_content（默认优先）
reasoning
reasoning_text
thinking
```

上游字段名不同时，用 `provider.reasoningFields` 改顺序或增加字段，不必改代码。

reasoning 和 text **可以交替**：插件会各自开新块。先 reasoning 后 text 是最常见的顺序。

---

## 4. DSH 侧看到什么：chunk 映射表

| OpenAI SSE | DSH StreamChunk |
|---|---|
| 首次出现 reasoning 字段 | `{type:'block-start', index, blockType:'reasoning'}` |
| `delta.reasoning_content` | `{type:'reasoning-delta', index, text}` |
| 首次出现 `delta.content` | `{type:'block-start', index, blockType:'text'}` |
| `delta.content` | `{type:'text-delta', index, text}` |
| 首次出现某工具槽位 | `{type:'block-start', index, blockType:'tool-call'}` |
| `delta.tool_calls[n].function.arguments` | `{type:'tool-call-delta', index, id, name?, argumentsDelta}` |
| 流结束 | 每个块一条 `{type:'block-end', index, block}`（携带拼好的完整块） |
| `payload.usage` | `{type:'usage', usage:{inputTokens,outputTokens,totalTokens,cacheReadTokens?,reasoningTokens?}}` |
| `finish_reason` / `[DONE]` | `{type:'finish', reason:{kind:'stop'\|'tool-calls'\|'max-tokens'}}` |

`block-end` 是**权威最终块**：UI 用它替换累积的草稿，replay 用它复原消息。所以你不需要额外发“完整内容”，插件会用累积的 delta 生成它。

---

## 5. 非流式分支

`stream: false`（或省略 `stream`）时应返回普通 JSON：

```json
{
  "id": "chatcmpl-1",
  "model": "my-model",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "hello", "tool_calls": []},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
}
```

插件会把它展开成同样的 chunk 序列，所以 DSH 侧行为一致。实现非流式分支的收益：`curl` 调试简单、一致性脚本能覆盖、有些客户端只支持非流式。

---

## 6. 配置：九成差异都在这里

完整字段表见 [README 的配置参考](README.md#配置参考)。这里只列**适配时真正会改**的：

| 你的情况 | 改这个 |
|---|---|
| 上游路径不是 `/v1/chat/completions` | `provider.baseURL` + `provider.requestPath` |
| 上游不认 `max_tokens`，只认 `max_completion_tokens` | `provider.maxTokensField: max_completion_tokens` |
| reasoning 字段叫别的名字 | `provider.reasoningFields: [my_reasoning_field]` |
| 需要自定义请求头（版本号、租户 id） | `provider.headers` |
| 需要把 DSH 会话 id 传给上游做会话亲和 | `provider.sessionHeader: x-my-session` |
| 网关需要 API key（服务端鉴权） | `provider.apiKeyEnv: MY_GATEWAY_KEY`，**不要**写 `apiKey` |
| 模型列表由网关动态提供 | 留空 `models` + `discoverModels: true`，并实现 `GET /v1/models` |
| 上游慢，30 秒连不上 | `provider.connectTimeoutMs` |
| 上游思考很久不吐字，被判超时 | `provider.streamIdleTimeoutMs`（默认 300000，即 5 分钟） |
| 想看到完整 SSE 事件 | `provider.trace: verbose`，然后 `gateway_logs` |

`verbose` 会记录截断后的请求体和每条 SSE 事件，**只在排障时临时打开**：它包含用户 prompt 的副本。

---

## 7. 把网关交给 DSH 托管：配置骨架

```yaml
- insert:
    - id: my-gateway
      name: '@local/dsh-model-gateway'
      config:
        gateways:
          my-model:
            displayName: My Model
            command: python
            script: server.py          # 相对 cwd
            cwd: H:/work/my-gateway    # 绝对路径，正斜杠
            port: 8099
            health:
              type: http
              path: /health            # 以 provider.baseURL 的 origin 拼接
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
              models:
                - id: my-model
                  name: My Model
                  contextWindow: 131072
                  maxTokens: 8192
```

字段语义：

- `command` 是**可执行文件**，`script` 是它的**第一个参数**，`args` 是其余参数。所以 `command: node` + `script: gateway.mjs` 就是 `node gateway.mjs`。
- `cwd` 决定相对路径的基准，也决定子进程工作目录。**用绝对路径最稳**。
- `port` 会注入 `PORT` 环境变量，并用于默认的 `baseURL` 和端口占用检查。
- `health.type`：`http` / `tcp` / `none`。有 `port` 时默认 `tcp`；显式给了 `path` 或 `url` 时自动按 `http`。
- `autoStart: false` + `startOnRequest: true`：第一次模型请求才启动，适合重资源网关。
- 一个部署只应有一条 `model-gateway` 配置行；多个网关写进同一个 `gateways:` 映射。

---

## 8. 30 秒自证：一致性脚本

写完网关，先**不装 DSH**，直接手动跑起来，然后：

```powershell
cd H:\Documents\Abyss\DSHAbility
node packages/dsh-model-gateway/scripts/conformance.mjs http://127.0.0.1:8099
```

输出示例：

```
[PASS] health endpoint — GET /health -> HTTP 200
[PASS] model list — 1 model(s): my-model
[PASS] streaming text — received 40 chars
[PASS] sse terminator — received data: [DONE]
[PASS] finish reason — finish_reason="stop"
[PASS] usage chunk — prompt=1 completion=1
[PASS] non-streaming fallback — 40 chars
[WARN] error shape — unknown model was accepted; cannot verify the error envelope

7 passed, 1 warnings, 0 failed
```

它检查的正是 DSH 依赖的契约：健康端点、模型列表、SSE 头、`data:` 帧、`[DONE]`、`finish_reason`、usage、非流式回退、错误信封。`WARN` 不阻断，`FAIL` 退出码为 1。

`WARN` 的含义通常是“能跑但不够好”：

| 输出 | 含义 | 要不要管 |
|---|---|---|
| `no usage observed` | 没发 usage 事件 | 建议补：DSH 的 token 统计会缺一块 |
| `no [DONE] sentinel` | 只靠 `finish_reason` 结束 | 建议补：更接近 OpenAI 行为 |
| `usage present but ... counts are missing` | usage 字段名不对 | 要：应使用 `prompt_tokens`/`completion_tokens` |
| `unknown model was accepted` | 不校验模型名 | 可不管；校验不严格不算错 |
| `GET /v1/models -> HTTP 404` | 没实现模型列表 | 只有依赖 `discoverModels` 时才要补 |

脚本跑通后再装 bundle：

```json
gateway_status()
gateway_selftest({ "id": "my-model", "prompt": "Reply with exactly: my gateway ok" })
```

`gateway_selftest` 走的是真实 DSH 链路（`ctx.llm.stream()` → adapter → 你的网关 → SSE → chunk），它成功就说明第 2、3 节的契约全部成立。

---

## 9. 排障：按层定位

先看 `gateway_logs`（`stream: "trace"`）。每条请求都会留下 `request` / `response` / `finish` 三类 trace。

| 现象 | 最可能的原因 | 查什么 |
|---|---|---|
| `STARTUP_TIMEOUT` | 进程没监听，或健康路径不对 | 手动跑网关；`curl /health`；`startupTimeoutMs` |
| `PORT_IN_USE` | 端口被占 | 停掉手动测试进程；或改 `port` 并同步 `baseURL`/`health.url` |
| `SCRIPT_MISSING` / `CWD_MISSING` | 路径错 | `script` 相对 `cwd`；`cwd` 用绝对路径 |
| `TRANSPORT` + `completion marker` | 没有 `[DONE]` 也没有 `finish_reason` | 网关的结束分支；是否 flush 了最后一行 |
| `INVALID_RESPONSE` + `non-JSON SSE` | 把日志/心跳当 SSE 发了 | 只发 `data: {json}`，不要发裸文本 |
| `EMPTY_RESPONSE` | 只发了 reasoning，没有 content | 确认 `delta.content` 非空；纯思考模型要同时给 content |
| `AUTH` | key 没传到网关 | `apiKeyEnv` 读的是 **DSH Host 进程**环境；桌面启动的 DSH 不继承终端变量 |
| 流式变成“一次性出现” | 网关做了缓冲（`Content-Length`、压缩、框架整包发送） | 关闭响应压缩；每帧显式 flush；禁用反向代理缓冲 |
| 工具调用参数 JSON 解析失败 | `arguments` 拼接不是合法 JSON | 逐段拼接后必须是完整 JSON；别在片段里加空格 |
| 模型选择器看不到路由 | `provider.models` 为空且 `/v1/models` 不可用 | 配 `models`，或实现模型列表 |
| 请求一直挂到 5 分钟 | 上游长时间不吐字 | `streamIdleTimeoutMs`；或在网关侧发 keepalive `: ping` 注释 |

### 关于“流式没有生效”

最常见的三个原因，按概率排序：

1. **网关缓冲了输出**：Python 的 `wfile` 要 `flush()`；Node 的 `res.write()` 后不要等 `end()`；Flask/FastAPI 要用流式响应对象，不要先 `json.dumps` 整体。
2. **中间层压缩**：不要在 SSE 响应上启用 gzip；`Content-Length` 不要设。
3. **代理/隧道缓冲**：如果你在本机前面又套了一层（nginx、Cloudflare tunnel），关掉 `proxy_buffering`。

判断方法：手动 `curl -N` 看是否逐行到达。如果 `curl -N` 是一次性到达，问题在你的网关，不在 DSH。

```powershell
curl.exe -N -X POST http://127.0.0.1:8099/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"my-model\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"count to 5 slowly\"}]}"
```

---

## 10. 自己实现 adapter（少数情况）

当你的协议**不是** OpenAI Chat Completions，且你不想在中间加一个翻译进程时，可以复制 `lib/openai-adapter.js` 改成自己的 adapter。必须实现这些成员：

| 成员 | 作用 |
|---|---|
| `providerInfo()` | 返回 `{id, name}`，`id` 即路由名 |
| `listModels()` | 返回模型列表 |
| `resolveModel(provider, model)` | 返回 `{provider, id, name, context:{contextWindow}, defaultMaxTokens?, inputModalities?}` |
| `prepareCall(provider, model)` | 返回 `{model, stream}` |
| `stream(options)` | **async generator**，产出第 4 节的 chunk |
| `providerRetryPolicy()` | 返回 `undefined` 表示用默认重试策略 |
| `imageRequestPricing()` / `imageRequestTarget()` | 仅图片请求需要 |

流式实现的三条硬性要求：

1. 每个 delta 之前必须先发对应的 `block-start`（index 从 0 递增，同类型块可复用 index）。
2. 结束前为每个打开的块发 `block-end`，且 `block.type` 与 `block-start` 的 `blockType` 一致。
3. `usage` 在 `finish` 之前，`finish` 之后什么都不能再发。

然后把它注册进插件（`index.js` 里 `ctx.llm.registerAdapter` 的位置），并在配置里加一个 `protocol: custom` 之类的分支。**这是唯一需要改框架代码的场景**；能走 OpenAI 兼容面就不要走这条路。

---

## 11. 提交前检查清单

**协议**

- [ ] `GET /health` 返回 2xx，且进程 kill 后能重新监听
- [ ] `POST /v1/chat/completions` 在 `stream: true` 时返回 `text/event-stream`
- [ ] 每帧 `data: ` + 空行；最后有 `data: [DONE]`
- [ ] 有 `finish_reason`；`tool_calls` 场景发 `tool_calls`
- [ ] usage 事件在 finish 之前，字段是 `prompt_tokens` / `completion_tokens`
- [ ] 非 2xx 有 `{"error":{"message":...}}`
- [ ] 工具调用的 `arguments` 是逐段拼接的字符串，拼完是合法 JSON
- [ ] reasoning 字段名与 `provider.reasoningFields` 一致

**流式**

- [ ] 每帧 flush，不设 `Content-Length`，不压缩
- [ ] `curl -N` 能看到逐行到达
- [ ] 上游断开时发错误事件，不发假 `[DONE]`

**托管**

- [ ] `cwd` 是绝对路径，YAML 里用正斜杠
- [ ] `port` 与 `provider.baseURL`、`health.url` 一致
- [ ] 网关能处理 `PORT` / `HOST` 环境变量
- [ ] 有 SIGTERM（POSIX）或能被 `taskkill /T /F`（Windows）终止
- [ ] 密钥只通过 `apiKeyEnv` 传入，不写进 YAML、不打印到 stdout

**验证**

- [ ] `node packages/dsh-model-gateway/scripts/conformance.mjs <url>` 无 FAIL
- [ ] `gateway_status()` 为 `running` / healthy
- [ ] `gateway_selftest({id})` 成功
- [ ] 手动 kill 进程后能自动重启（`restarts` 增加）
