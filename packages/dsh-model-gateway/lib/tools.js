// Model-facing lifecycle and diagnostics tools.
//
// The tools deliberately return compact, schema-stable JSON instead of the
// full internal snapshot, so a failed gateway is diagnosable without leaking
// environment values or unbounded logs into the transcript.

function summarize(snapshot) {
  return {
    id: snapshot.id,
    displayName: snapshot.displayName,
    state: snapshot.state,
    healthy: snapshot.healthy,
    enabled: snapshot.enabled,
    ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
    restarts: snapshot.restarts,
    ...(snapshot.startedAt === undefined ? {} : { startedAt: new Date(snapshot.startedAt).toISOString() }),
    ...(snapshot.uptimeMs > 0 ? { uptimeMs: snapshot.uptimeMs } : {}),
    ...(snapshot.lastError === undefined ? {} : { lastError: snapshot.lastError }),
    ...(snapshot.providerError === undefined ? {} : { providerError: snapshot.providerError }),
    ...(snapshot.lastExit === undefined ? {} : {
      lastExit: `code=${snapshot.lastExit.code ?? 'null'} signal=${snapshot.lastExit.signal ?? 'null'} at=${snapshot.lastExit.at}`,
    }),
    ...(snapshot.provider?.route === undefined ? {} : { provider: snapshot.provider.route }),
    ...(snapshot.provider === null ? {} : { models: snapshot.provider.models }),
    ...(snapshot.logFile === undefined ? {} : { logFile: snapshot.logFile }),
    health: snapshot.health,
  }
}

const gatewaySummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'state', 'healthy'],
  properties: {
    id: { type: 'string' },
    displayName: { type: 'string' },
    state: { type: 'string' },
    healthy: { type: 'boolean' },
    enabled: { type: 'boolean' },
    pid: { type: 'number' },
    restarts: { type: 'number' },
    startedAt: { type: 'string' },
    uptimeMs: { type: 'number' },
    lastError: { type: 'string' },
    providerError: { type: 'string' },
    lastExit: { type: 'string' },
    provider: { type: 'string' },
    models: { type: 'array', items: { type: 'string' } },
    logFile: { type: 'string' },
    health: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        detail: { type: 'string' },
        lastCheckAt: { type: 'number' },
        consecutiveFailures: { type: 'number' },
      },
    },
  },
}

const renderJSON = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

export function registerGatewayTools(ctx, manager) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'gateway_status',
    description: 'List model gateways managed by the DSH model-gateway plugin: lifecycle state, PID, health, restart count, model routes, and last error. Use this before controlling a gateway or when a gateway-backed model request fails.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['gateways'],
        properties: {
          gateways: { type: 'array', items: gatewaySummarySchema },
        },
      },
      render: renderJSON,
    },
    async execute() {
      return { gateways: manager.list().map(summarize) }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'gateway_control',
    description: 'Start, stop, or restart one managed model gateway process. The plugin already auto-starts, watches health, and restarts crashes; use this for deliberate maintenance or to recover a gateway whose restart budget is exhausted. Returns the resulting gateway status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'action'],
      properties: {
        id: { type: 'string', description: 'Gateway id from gateway_status.' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Lifecycle action to perform.' },
      },
    },
    output: {
      schema: gatewaySummarySchema,
      render: renderJSON,
    },
    async execute(args) {
      const supervisor = manager.require(args.id)
      if (args.action === 'start') await supervisor.start('tool')
      else if (args.action === 'stop') await supervisor.stop({ reason: 'tool' })
      else await supervisor.restart('tool')
      return summarize(supervisor.snapshot())
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'gateway_logs',
    description: 'Read the bounded internal log of one managed model gateway, including captured stdout/stderr, lifecycle traces, health failures, HTTP status, and protocol diagnostics. Use this when a gateway starts but model calls fail or behave unexpectedly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Gateway id from gateway_status.' },
        limit: { type: 'number', description: 'Maximum lines to return, 1-500. Defaults to 200.' },
        stream: { type: 'string', enum: ['stdout', 'stderr', 'system', 'trace'], description: 'Only return one log stream.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'lines'],
        properties: {
          id: { type: 'string' },
          logFile: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: renderJSON,
    },
    async execute(args) {
      const supervisor = manager.require(args.id)
      return {
        id: args.id,
        ...(supervisor.config.logs.file === undefined ? {} : { logFile: supervisor.config.logs.file }),
        lines: supervisor.logs.lines({ limit: args.limit ?? 200, stream: args.stream }),
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'gateway_selftest',
    description: 'Send one real streaming chat request through a managed gateway model route via the DSH LLM service, and return the assembled text, finish reason, usage, and latency. Use this to verify that the gateway process, OpenAI-compatible adapter, credentials, and streaming protocol all work end to end.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Gateway id. Defaults to the only gateway.' },
        model: { type: 'string', description: 'Model id to request. Defaults to the first configured model.' },
        prompt: { type: 'string', description: 'User prompt for the probe. Defaults to a short connectivity check.' },
        timeoutMs: { type: 'number', description: 'Probe timeout in milliseconds, 1000-120000. Defaults to 60000.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'model', 'text', 'finish', 'elapsedMs'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          text: { type: 'string' },
          reasoning: { type: 'string' },
          finish: { type: 'string' },
          usage: { type: 'string' },
          elapsedMs: { type: 'number' },
        },
      },
      render: renderJSON,
    },
    async execute(args, exec) {
      const all = manager.list()
      const id = args.id ?? (all.length === 1 ? all[0].id : undefined)
      if (id === undefined) throw new Error('gateway_selftest requires id when more than one gateway exists')
      const supervisor = manager.require(id)
      const provider = supervisor.config.provider
      if (provider === null) throw new Error(`gateway "${id}" has no provider configured`)
      const model = args.model ?? provider.models[0]?.id
      if (model === undefined) throw new Error(`gateway "${id}" has no configured model; add provider.models[0].id`)
      if (typeof ctx.llm?.stream !== 'function') throw new Error('the llm service is not available')

      const timeoutMs = Math.max(1_000, Math.min(120_000, args.timeoutMs ?? 60_000))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`gateway selftest timed out after ${timeoutMs}ms`)), timeoutMs)
      const onAbort = () => controller.abort(exec?.signal?.reason ?? new Error('gateway selftest cancelled'))
      if (exec?.signal?.aborted) onAbort()
      else exec?.signal?.addEventListener('abort', onAbort, { once: true })
      const started = Date.now()
      let text = ''
      let reasoning = ''
      let finish = 'none'
      let usage
      try {
        const sessionId = exec?.agent?.session?.id
        for await (const chunk of ctx.llm.stream({
          provider: provider.route,
          model,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: args.prompt ?? 'Reply with exactly: gateway ok' }],
          }],
          system: 'You are a connectivity probe. Answer briefly and directly.',
          maxTokens: 512,
          ...(sessionId === undefined ? {} : { sessionId }),
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') {
            finish = chunk.reason?.kind ?? 'unknown'
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
              const failure = chunk.reason.failure
              throw new Error(`${chunk.reason.kind}: ${failure?.message ?? 'model call failed'} (${failure?.code ?? 'UNKNOWN'})`)
            }
          }
        }
      } finally {
        clearTimeout(timer)
        exec?.signal?.removeEventListener('abort', onAbort)
      }
      return {
        ok: finish === 'stop' || finish === 'tool-calls' || finish === 'max-tokens',
        id,
        provider: provider.route,
        model,
        text,
        ...(reasoning.length === 0 ? {} : { reasoning }),
        finish,
        ...(usage === undefined ? {} : { usage: JSON.stringify(usage) }),
        elapsedMs: Date.now() - started,
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }
}
