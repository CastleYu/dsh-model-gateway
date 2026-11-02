// OpenAI Chat Completions adapter for a supervised local gateway.
//
// The adapter is a plain object (not a subclass) because the installed
// LlmRuntime validates by duck typing.  It implements the same surface as
// LlmAdapter: providerInfo, providerRetryPolicy, imageRequestPricing,
// imageRequestTarget, listModels, resolveModel, prepareCall and stream.

import { randomUUID } from 'node:crypto'

const DEFAULT_CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_TOKENS = 8_192

export function gatewayError(message, code, { status, providerRetryAfterMs, requestId, cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  error.failure = {
    message,
    code,
    ...(status === undefined ? {} : { status }),
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
    ...(requestId === undefined ? {} : { requestId }),
  }
  return error
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function imageBlocks(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'image' && block.attachment !== undefined)
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'tool-call')
}

function joinURL(baseURL, suffix) {
  if (suffix === undefined || suffix === '') return baseURL
  const base = baseURL.replace(/\/+$/, '')
  if (base.endsWith(suffix)) return base
  return `${base}${suffix.startsWith('/') ? '' : '/'}${suffix}`
}

function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const inputTokens = Number.isFinite(raw.prompt_tokens) ? raw.prompt_tokens
    : Number.isFinite(raw.input_tokens) ? raw.input_tokens : 0
  const outputTokens = Number.isFinite(raw.completion_tokens) ? raw.completion_tokens
    : Number.isFinite(raw.output_tokens) ? raw.output_tokens : 0
  const totalTokens = Number.isFinite(raw.total_tokens) ? raw.total_tokens : inputTokens + outputTokens
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined
  const details = raw.prompt_tokens_details ?? {}
  const completionDetails = raw.completion_tokens_details ?? {}
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(Number.isFinite(details.cached_tokens) ? { cacheReadTokens: details.cached_tokens } : {}),
    ...(Number.isFinite(completionDetails.reasoning_tokens) ? { reasoningTokens: completionDetails.reasoning_tokens } : {}),
  }
}

function finishReasonFrom(wire, sawToolCall) {
  if (sawToolCall) return { kind: 'tool-calls' }
  switch (wire) {
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'content_filter':
    case 'stop':
    case null:
    case undefined:
      return { kind: 'stop' }
    default:
      return { kind: 'stop' }
  }
}

function mapHTTPError(status, body, headers) {
  const detail = body.slice(0, 2_000)
  let message = detail
  try {
    const parsed = JSON.parse(body)
    message = parsed?.error?.message ?? parsed?.message ?? detail
  } catch {}
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? 'RATE_LIMIT'
      : status === 408 || status === 504 ? 'TIMEOUT'
        : status >= 500 ? 'SERVER'
          : status === 400 || status === 422 ? 'INVALID_REQUEST'
            : 'PROVIDER_ERROR'
  const retryAfter = headers?.get?.('retry-after')
  const providerRetryAfterMs = retryAfter !== null && retryAfter !== undefined && /^\d+(\.\d+)?$/.test(retryAfter)
    ? Math.max(1, Math.round(Number(retryAfter) * 1000))
    : undefined
  return gatewayError(
    `gateway HTTP ${status}: ${String(message || 'request failed').trim()}`,
    code,
    {
      status,
      providerRetryAfterMs,
      requestId: headers?.get?.('x-opencode-log-id') ?? headers?.get?.('x-request-id') ?? undefined,
    },
  )
}

async function readBodyLimited(response, maxBytes = 8_192) {
  try {
    const reader = response.body?.getReader()
    if (reader === undefined) return ''
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    while (bytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    try { await reader.cancel() } catch {}
    return text.slice(0, maxBytes)
  } catch {
    return ''
  }
}

/**
 * Parse a `text/event-stream` body into data payload strings.
 * Tolerant of CRLF, comments, multiple data lines and keepalives.
 */
export async function* sseData(body, signal) {
  if (body === undefined || body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  let eventName

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const data = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = undefined
    return { data, event: name }
  }

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          const event = flush()
          if (event !== undefined) yield event
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      const line = buffer.replace(/\r$/, '')
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    const event = flush()
    if (event !== undefined) yield event
  } finally {
    try { await reader.cancel() } catch {}
  }
}

export function createOpenAIAdapter({ config, supervisor, ctx, log }) {
  const provider = config.provider
  if (provider === null) throw new Error(`gateway "${config.id}" has no provider config`)

  const trace = provider.trace
  const modelCache = { at: 0, models: [] }

  function providerInfo() {
    return { id: provider.route, name: provider.displayName }
  }

  function providerRetryPolicy() {
    return undefined
  }

  function imageRequestPricing() {
    return undefined
  }

  function imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  function modelConfig(model) {
    return provider.models.find((entry) => entry.id === model)
  }

  function resolveModel(providerName, model, signal) {
    signal?.throwIfAborted()
    const known = modelConfig(model)
    if (known !== undefined) {
      return Promise.resolve({
        provider: providerName,
        id: model,
        name: known.name,
        ...(known.description === undefined ? {} : { description: known.description }),
        context: { contextWindow: known.contextWindow },
        defaultMaxTokens: known.maxTokens,
        inputModalities: known.input ?? ['text'],
        ...(known.reasoningEfforts === false || known.reasoningEfforts === undefined ? {} : {
          reasoning: {
            efforts: Object.keys(known.reasoningEfforts).map((id) => ({ id, name: id })),
            ...(known.defaultReasoningEffort === undefined ? {} : { defaultEffort: known.defaultReasoningEffort }),
          },
        }),
      })
    }
    return Promise.resolve({
      provider: providerName,
      id: model,
      name: model,
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      inputModalities: ['text'],
    })
  }

  async function listModels() {
    const configured = provider.models.map((entry) => ({
      provider: provider.route,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.input,
    }))
    if (configured.length > 0 || !provider.discoverModels) return configured

    if (Date.now() - modelCache.at < 30_000) return modelCache.models
    const url = provider.modelsURL ?? joinURL(provider.baseURL, '/models')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('model list timeout')), provider.modelListTimeoutMs)
    try {
      const headers = await authHeaders(undefined, controller.signal)
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const data = Array.isArray(json?.data) ? json.data : []
      const models = []
      for (const item of data) {
        if (typeof item?.id !== 'string' || item.id.length === 0) continue
        models.push({ provider: provider.route, id: item.id, name: typeof item.name === 'string' ? item.name : item.id })
      }
      modelCache.at = Date.now()
      modelCache.models = models
      log.trace('models-discovered', { url, count: models.length })
      return models
    } catch (error) {
      log.trace('models-discovery-failed', { url, message: String(error?.message ?? error) })
      return configured
    } finally {
      clearTimeout(timer)
    }
  }

  async function resolveCredential(signal) {
    if (provider.apiKey !== undefined && provider.apiKey.length > 0) return provider.apiKey
    if (provider.apiKeyEnv !== undefined) {
      const value = process.env[provider.apiKeyEnv]
      if (value === undefined || value.trim() === '') {
        throw gatewayError(`gateway "${config.id}" requires credential ${provider.apiKeyEnv}, but it is not set`, 'MISSING_CREDENTIAL')
      }
      return value.trim()
    }
    return undefined
  }

  async function authHeaders(options, signal) {
    const headers = {
      'content-type': 'application/json',
      accept: options?.stream === false ? 'application/json' : 'text/event-stream',
      'user-agent': 'dsh-model-gateway/0.1',
      ...provider.headers,
    }
    const credential = await resolveCredential(signal)
    if (credential !== undefined && headers.Authorization === undefined && headers.authorization === undefined) {
      headers.Authorization = `Bearer ${credential}`
    }
    if (provider.sessionHeader !== undefined && provider.sendSessionHeader && options?.sessionId !== undefined) {
      headers[provider.sessionHeader] = String(options.sessionId)
    }
    return headers
  }

  async function imageDataURL(attachment, signal) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.readImageRequest !== 'function') {
      return undefined
    }
    const target = imageRequestTarget(provider.route, undefined, attachment)
    const image = await attachments.readImageRequest(attachment, target, signal)
    const mediaType = image.mediaType ?? attachment.mediaType ?? 'image/png'
    return `data:${mediaType};base64,${Buffer.from(image.data).toString('base64')}`
  }

  async function buildMessages(options, signal) {
    const messages = []
    const systemParts = []
    if (typeof options.system === 'string' && options.system.length > 0) systemParts.push(options.system)
    for (const message of options.messages) {
      if (message.role === 'system' || message.role === 'developer') {
        const text = textOfContent(message.content)
        if (text.length > 0) systemParts.push(text)
      }
    }
    if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n\n') })

    for (const message of options.messages) {
      if (message.role === 'system' || message.role === 'developer') continue
      if (message.role === 'user') {
        const parts = []
        for (const block of message.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
          else if (block?.type === 'image' && block.attachment !== undefined) {
            const dataURL = await imageDataURL({ ...block.attachment, offloaded: block.offloaded }, signal)
            if (dataURL === undefined) parts.push({ type: 'text', text: `[image ${block.attachment.name ?? block.attachment.attachmentId} unavailable]` })
            else parts.push({ type: 'image_url', image_url: { url: dataURL } })
          }
        }
        messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
        continue
      }
      if (message.role === 'assistant') {
        const text = textOfContent(message.content)
        const calls = toolCallsOf(message.content)
        const entry = { role: 'assistant', content: text.length > 0 ? text : null }
        if (calls.length > 0) {
          entry.tool_calls = calls.map((call) => ({
            id: String(call.id),
            type: 'function',
            function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
          }))
        }
        messages.push(entry)
        continue
      }
      if (message.role === 'tool') {
        const text = textOfContent(message.content)
        messages.push({ role: 'tool', tool_call_id: String(message.toolCallId ?? message.source?.callId ?? ''), content: text })
      }
    }
    return messages
  }

  function buildBody(options) {
    const known = modelConfig(options.model)
    const body = {
      model: options.model,
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
      ...provider.extraBody,
    }
    if (options.maxTokens !== undefined) body[provider.maxTokensField] = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
      body.tool_choice = 'auto'
    }
    if (options.reasoningEffort !== undefined) {
      const mapped = known?.reasoningEfforts?.[options.reasoningEffort] ?? options.reasoningEffort
      body.reasoning_effort = mapped
    }
    return body
  }

  function emitDelta(payload, state) {
    const chunks = []
    if (payload?.error !== undefined) {
      const message = payload.error?.message ?? JSON.stringify(payload.error)
      throw gatewayError(`gateway error: ${message}`, 'PROVIDER_ERROR', { requestId: payload.error?.request_id })
    }
    if (payload?.usage !== undefined) {
      const usage = normalizeUsage(payload.usage)
      if (usage !== undefined) state.usage = usage
    }
    const choice = payload?.choices?.[0]
    if (choice === undefined) return chunks
    const delta = choice.delta ?? choice.message ?? {}
    const reasoning = provider.reasoningFields
      .map((field) => delta[field])
      .find((value) => typeof value === 'string' && value.length > 0)
    if (reasoning !== undefined) {
      if (state.reasoningIndex === -1) {
        state.reasoningIndex = state.nextBlock++
        state.textIndex = -1
      }
      state.sawContent = true
      chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: reasoning })
    }
    let text = ''
    if (typeof delta.content === 'string') text = delta.content
    else if (Array.isArray(delta.content)) {
      text = delta.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
    }
    if (text.length > 0) {
      if (state.textIndex === -1) {
        state.textIndex = state.nextBlock++
        state.reasoningIndex = -1
      }
      state.sawContent = true
      chunks.push({ type: 'text-delta', index: state.textIndex, text })
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (let i = 0; i < toolCalls.length; i += 1) {
      const call = toolCalls[i] ?? {}
      const key = Number.isInteger(call.index) ? call.index : i
      let tool = state.tools.get(key)
      if (tool === undefined) {
        tool = {
          index: state.nextBlock++,
          id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: typeof call.function?.name === 'string' ? call.function.name : '',
        }
        state.tools.set(key, tool)
      } else {
        if (typeof call.id === 'string' && call.id.length > 0) tool.id = call.id
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) tool.name = call.function.name
      }
      const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
      state.sawToolCall = true
      state.sawContent = true
      chunks.push({
        type: 'tool-call-delta',
        index: tool.index,
        id: tool.id,
        ...(tool.name.length > 0 ? { name: tool.name } : {}),
        argumentsDelta,
      })
    }
    if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason
    return chunks
  }

  async function* stream(options) {
    const signal = options.signal
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    if (supervisor !== undefined) await supervisor.ensureRunning()
    const started = Date.now()
    const body = buildBody(options)
    body.messages = await buildMessages(options, signal)
    const url = joinURL(provider.baseURL, provider.requestPath)
    let headers
    try {
      headers = await authHeaders(options, signal)
    } catch (error) {
      log.trace('request-preflight-error', { url, message: String(error?.message ?? error) })
      throw error
    }

    const requestSummary = {
      url,
      model: options.model,
      messageCount: body.messages.length,
      toolCount: body.tools?.length ?? 0,
      stream: true,
    }
    if (trace !== 'off') log.trace('request', requestSummary)
    if (trace === 'verbose') log.trace('request-body', body)

    const controller = new AbortController()
    let abortedBy = undefined
    const onAbort = () => {
      abortedBy = 'caller'
      try { controller.abort(signal.reason ?? new Error('aborted')) } catch { controller.abort() }
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const connectTimer = setTimeout(() => {
      abortedBy = 'timeout'
      controller.abort(new Error(`connect timeout after ${provider.connectTimeoutMs}ms`))
    }, provider.connectTimeoutMs)
    let idleTimer
    const resetIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        abortedBy = 'idle-timeout'
        controller.abort(new Error(`stream idle timeout after ${provider.streamIdleTimeoutMs}ms`))
      }, provider.streamIdleTimeoutMs)
      idleTimer.unref?.()
    }

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(connectTimer)
      signal?.removeEventListener('abort', onAbort)
      if (isAbortError(error) || controller.signal.aborted) {
        const timedOut = abortedBy === 'timeout' || abortedBy === 'idle-timeout'
        throw gatewayError(
          timedOut ? `gateway request timed out after ${provider.connectTimeoutMs}ms` : 'gateway request aborted',
          timedOut ? 'TIMEOUT' : 'ABORTED',
          { cause: error },
        )
      }
      log.trace('transport-error', { url, message: String(error?.message ?? error), code: error?.code })
      throw gatewayError(`gateway transport error: ${String(error?.message ?? error)}`, 'TRANSPORT', { cause: error })
    }
    clearTimeout(connectTimer)
    resetIdle()

    try {
      if (!response.ok) {
        const text = await readBodyLimited(response)
        const error = mapHTTPError(response.status, text, response.headers)
        log.trace('http-error', {
          status: response.status,
          code: error.code,
          message: error.message,
          body: trace === 'verbose' ? text : undefined,
        })
        throw error
      }
      log.trace('response', {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        elapsedMs: Date.now() - started,
      })
      if (trace === 'verbose') log.trace('response-headers', Object.fromEntries(response.headers.entries()))

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('application/json')) {
        const text = await response.text()
        let payload
        try { payload = JSON.parse(text) } catch {
          throw gatewayError(`gateway returned invalid JSON: ${text.slice(0, 300)}`, 'INVALID_RESPONSE')
        }
        const state = {
          nextBlock: 0,
          textIndex: -1,
          reasoningIndex: -1,
          tools: new Map(),
          sawToolCall: false,
          sawContent: false,
          usage: undefined,
          finishReason: undefined,
        }
        for (const chunk of emitDelta(payload, state)) yield chunk
        if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
        if (!state.sawContent) throw gatewayError('gateway returned an empty response', 'EMPTY_RESPONSE')
        yield { type: 'finish', reason: finishReasonFrom(state.finishReason, state.sawToolCall) }
        log.trace('finish', { reason: finishReasonFrom(state.finishReason, state.sawToolCall), usage: state.usage, elapsedMs: Date.now() - started })
        return
      }

      const state = {
        nextBlock: 0,
        textIndex: -1,
        reasoningIndex: -1,
        tools: new Map(),
        sawToolCall: false,
        sawContent: false,
        usage: undefined,
        finishReason: undefined,
        done: false,
      }
      for await (const event of sseData(response.body, controller.signal)) {
        resetIdle()
        if (event.data === '[DONE]') {
          state.done = true
          break
        }
        let payload
        try {
          payload = JSON.parse(event.data)
        } catch {
          log.trace('sse-unparseable', { data: event.data.slice(0, 500) })
          continue
        }
        if (trace === 'verbose') log.trace('sse', payload)
        for (const chunk of emitDelta(payload, state)) yield chunk
        if (state.finishReason !== undefined && state.usage !== undefined) {
          // Keep consuming until [DONE]: some gateways send the usage chunk
          // after the finish_reason chunk.
        }
      }
      if (!state.done && state.finishReason === undefined) {
        throw gatewayError('gateway stream ended before a completion marker ([DONE] or finish_reason)', 'TRANSPORT')
      }
      if (!state.sawContent) throw gatewayError('gateway stream produced no content', 'EMPTY_RESPONSE')
      if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
      const reason = finishReasonFrom(state.finishReason, state.sawToolCall)
      yield { type: 'finish', reason }
      log.trace('finish', { reason, usage: state.usage, elapsedMs: Date.now() - started, sawToolCall: state.sawToolCall })
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        const timedOut = abortedBy === 'timeout' || abortedBy === 'idle-timeout'
        if (error?.failure !== undefined) throw error
        throw gatewayError(
          timedOut ? `gateway stream timed out after ${provider.streamIdleTimeoutMs}ms` : 'gateway stream aborted',
          timedOut ? 'TIMEOUT' : 'ABORTED',
          { cause: error },
        )
      }
      if (error?.failure !== undefined) throw error
      log.trace('stream-error', { message: String(error?.message ?? error), code: error?.code })
      throw gatewayError(`gateway stream error: ${String(error?.message ?? error)}`, error?.code ?? 'TRANSPORT', { cause: error })
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function prepareCall(_provider, model, signal) {
    return {
      model: await resolveModel(_provider, model, signal),
      stream: (options) => stream(options),
    }
  }

  return {
    id: config.id,
    provider,
    providerInfo,
    providerRetryPolicy,
    imageRequestPricing,
    imageRequestTarget,
    listModels,
    resolveModel,
    prepareCall,
    stream,
  }
}
