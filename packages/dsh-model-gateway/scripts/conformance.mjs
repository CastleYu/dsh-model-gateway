#!/usr/bin/env node
// OpenAI Chat Completions conformance check for a gateway that wants to be
// supervised by dsh-model-gateway.
//
// Usage:
//   node scripts/conformance.mjs http://127.0.0.1:8099
//   node scripts/conformance.mjs http://127.0.0.1:8099 --model my-model
//
// Exit code 0 means every required check passed. Warnings do not fail the run.
// This script only uses the public HTTP surface, so it works against any
// language/runtime before DSH is involved.

import process from 'node:process'

const args = process.argv.slice(2)
let baseArg
let model
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--model') { model = args[++index]; continue }
  if (arg.startsWith('--')) continue
  if (baseArg === undefined) baseArg = arg
}

if (baseArg === undefined) {
  console.error('usage: node scripts/conformance.mjs <base-url> [--model <id>]')
  process.exit(2)
}

const base = baseArg.replace(/\/+$/, '')
const v1 = base.endsWith('/v1') ? base : `${base}/v1`
const root = v1.replace(/\/v1$/, '')

const results = []

function record(name, status, detail) {
  results.push({ name, status, detail })
  const tag = status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : 'FAIL'
  console.log(`[${tag}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function fail(name, detail) {
  record(name, 'FAIL', detail)
}

function pass(name, detail) {
  record(name, 'PASS', detail)
}

function warn(name, detail) {
  record(name, 'WARN', detail)
}

async function withTimeout(label, ms, work) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${ms}ms`)), ms)
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function readSSE(response, onEvent) {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response has no body')
  const decoder = new TextDecoder()
  let buffer = ''
  let sawDone = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).replace(/^ /, '')
      if (data === '[DONE]') { sawDone = true; continue }
      if (data.trim() === '') continue
      onEvent(data)
    }
  }
  return { sawDone, tail: buffer }
}

async function postChat(body, signal) {
  return await fetch(`${v1}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
}

// 1. health
try {
  await withTimeout('health', 10_000, async (signal) => {
    const response = await fetch(`${root}/health`, { signal })
    if (!response.ok) {
      fail('health endpoint', `GET /health -> HTTP ${response.status}`)
      return
    }
    pass('health endpoint', `GET /health -> HTTP ${response.status}`)
  })
} catch (error) {
  fail('health endpoint', `GET /health failed: ${String(error?.message ?? error)}`)
}

// 2. models
let discovered
try {
  await withTimeout('models', 15_000, async (signal) => {
    const response = await fetch(`${v1}/models`, { signal })
    if (!response.ok) {
      warn('model list', `GET /v1/models -> HTTP ${response.status} (only required when provider.models is empty)`)
      return
    }
    const json = await response.json()
    const data = Array.isArray(json?.data) ? json.data : []
    const ids = data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) {
      fail('model list', 'GET /v1/models returned no string ids in data[]')
      return
    }
    discovered = ids
    pass('model list', `${ids.length} model(s): ${ids.slice(0, 5).join(', ')}`)
  })
} catch (error) {
  warn('model list', `GET /v1/models failed: ${String(error?.message ?? error)}`)
}

const targetModel = model ?? discovered?.[0]
if (targetModel === undefined) {
  fail('chat target', 'no model id available; pass --model <id> or expose GET /v1/models')
}

// 3. streaming text
if (targetModel !== undefined) {
  let text = ''
  let usage
  let finishReason
  let sawEventStream = false
  let sawDone = false
  try {
    await withTimeout('stream', 90_000, async (signal) => {
      const response = await postChat({
        model: targetModel,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Reply with exactly: conformance ok' }],
      }, signal)
      if (!response.ok) {
        fail('streaming text', `POST /v1/chat/completions -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
        return
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      sawEventStream = contentType.includes('text/event-stream')
      if (!sawEventStream) {
        fail('streaming text', `expected content-type text/event-stream, got "${contentType}"`)
        return
      }
      const parsed = await readSSE(response, (data) => {
        let payload
        try { payload = JSON.parse(data) } catch {
          fail('sse framing', `data: line is not JSON: ${data.slice(0, 120)}`)
          return
        }
        if (payload?.error !== undefined) {
          fail('streaming text', `gateway error payload: ${JSON.stringify(payload.error).slice(0, 200)}`)
          return
        }
        if (payload?.usage !== undefined) usage = payload.usage
        const choice = payload?.choices?.[0]
        if (choice === undefined) return
        const delta = choice.delta ?? choice.message ?? {}
        if (typeof delta.content === 'string') text += delta.content
        else if (Array.isArray(delta.content)) {
          for (const part of delta.content) {
            if (part?.type === 'text' && typeof part.text === 'string') text += part.text
          }
        }
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      })
      sawDone = parsed.sawDone
      if (text.trim().length === 0) fail('streaming text', 'stream produced no text content')
      else pass('streaming text', `received ${text.trim().length} chars`)
    })
  } catch (error) {
    fail('streaming text', `stream failed: ${String(error?.message ?? error)}`)
  }
  if (text.trim().length > 0) {
    if (sawDone) pass('sse terminator', 'received data: [DONE]')
    else if (finishReason !== undefined) warn('sse terminator', `no [DONE] sentinel; finish_reason="${finishReason}"`)
    else fail('sse terminator', 'stream ended without [DONE] or finish_reason')
    if (finishReason !== undefined) pass('finish reason', `finish_reason="${finishReason}"`)
    else warn('finish reason', 'no choice.finish_reason observed')
    if (usage !== undefined) {
      const promptTokens = usage.prompt_tokens ?? usage.input_tokens
      const completionTokens = usage.completion_tokens ?? usage.output_tokens
      if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) {
        pass('usage chunk', `prompt=${promptTokens} completion=${completionTokens}`)
      } else warn('usage chunk', 'usage present but prompt/completion token counts are missing')
    } else warn('usage chunk', 'no usage observed (stream_options.include_usage may be ignored)')
  }
}

// 4. non-streaming fallback
if (targetModel !== undefined) {
  try {
    await withTimeout('non-stream', 90_000, async (signal) => {
      const response = await fetch(`${v1}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          stream: false,
          messages: [{ role: 'user', content: 'Reply with exactly: conformance ok' }],
        }),
        signal,
      })
      if (!response.ok) {
        fail('non-streaming fallback', `HTTP ${response.status}`)
        return
      }
      const json = await response.json()
      const message = json?.choices?.[0]?.message
      if (typeof message?.content !== 'string' || message.content.length === 0) {
        fail('non-streaming fallback', 'choices[0].message.content is missing or empty')
        return
      }
      pass('non-streaming fallback', `${message.content.length} chars`)
    })
  } catch (error) {
    fail('non-streaming fallback', String(error?.message ?? error))
  }
}

// 5. error shape
try {
  await withTimeout('error shape', 15_000, async (signal) => {
    const response = await fetch(`${v1}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '__conformance_missing_model__', stream: true, messages: [{ role: 'user', content: 'x' }] }),
      signal,
    })
    if (response.ok) {
      warn('error shape', 'unknown model was accepted; cannot verify the error envelope')
      return
    }
    const text = await response.text()
    try {
      const json = JSON.parse(text)
      if (json?.error !== undefined) pass('error shape', `HTTP ${response.status} with {"error": ...}`)
      else warn('error shape', `HTTP ${response.status} without an "error" object`)
    } catch {
      warn('error shape', `HTTP ${response.status} body is not JSON: ${text.slice(0, 120)}`)
    }
  })
} catch (error) {
  warn('error shape', String(error?.message ?? error))
}

const failed = results.filter((item) => item.status === 'FAIL')
const warned = results.filter((item) => item.status === 'WARN')
console.log(`\n${results.length - failed.length - warned.length} passed, ${warned.length} warnings, ${failed.length} failed`)
if (failed.length > 0) process.exit(1)
