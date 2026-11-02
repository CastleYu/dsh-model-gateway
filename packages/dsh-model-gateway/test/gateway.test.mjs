import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, GatewayConfigError } from '../lib/config.js'
import { GatewaySupervisor } from '../lib/supervisor.js'
import { createOpenAIAdapter, sseData } from '../lib/openai-adapter.js'
import { redact } from '../lib/log-store.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(testDir, 'fixtures', 'mock-gateway.mjs')
const packageDir = path.resolve(testDir, '..')

function logger() {
  return { info() {}, warn() {}, error() {} }
}

function fakeCtx() {
  return {
    logger: logger(),
    get() { return undefined },
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

async function waitFor(check, { timeout = 15_000, interval = 100, label = 'condition' } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out waiting for ${label}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

function rawConfig(port, { failFile = '', health = {}, restart = {}, requestPath = '/chat/completions' } = {}) {
  return {
    gateways: {
      test: {
        displayName: 'Test Gateway',
        command: process.execPath,
        script: fixture,
        cwd: testDir,
        port,
        host: '127.0.0.1',
        env: failFile === '' ? {} : { FAIL_FILE: failFile },
        autoStart: false,
        checkPort: true,
        stopTimeoutMs: 3_000,
        health: {
          type: 'http',
          url: `http://127.0.0.1:${port}/health`,
          intervalMs: 400,
          timeoutMs: 1_000,
          startupTimeoutMs: 10_000,
          failureThreshold: 2,
          ...health,
        },
        restart: {
          enabled: true,
          maxRestarts: 10,
          windowMs: 60_000,
          initialDelayMs: 150,
          maxDelayMs: 800,
          ...restart,
        },
        logs: { maxLines: 500, maxBytes: 65_536 },
        provider: {
          route: 'gateway-test',
          displayName: 'Test Route',
          baseURL: `http://127.0.0.1:${port}/v1`,
          requestPath,
          models: [{
            id: 'mock-model',
            name: 'Mock Model',
            contextWindow: 32_000,
            maxTokens: 1_024,
            input: ['text'],
          }],
          trace: 'summary',
          discoverModels: false,
        },
      },
    },
  }
}

test('normalizes a valid gateway and rejects invalid routes', () => {
  const config = { gateways: { one: { command: 'python', script: 'server.py', port: 12345, provider: { models: [{ id: 'm' }] } } } }
  const normalized = normalizeConfig(config, { packageDir })
  assert.equal(normalized.gateways.length, 1)
  assert.equal(normalized.gateways[0].provider.route, 'gateway-one')
  assert.equal(normalized.gateways[0].provider.baseURL, 'http://127.0.0.1:12345/v1')
  assert.equal(normalized.gateways[0].script, path.resolve(process.cwd(), 'server.py'))

  assert.throws(
    () => normalizeConfig({ gateways: { x: { command: 'a' }, y: { command: 'b' } } }, { packageDir }),
    (error) => error instanceof GatewayConfigError && /provider\.baseURL is required/.test(error.message),
  )
  assert.throws(
    () => normalizeConfig({ gateways: { 'bad id': { command: 'a' } } }, { packageDir }),
    (error) => error instanceof GatewayConfigError,
  )
})

test('redacts credentials but preserves token counts', () => {
  const redacted = redact({
    authorization: 'Bearer secret',
    apiKey: 'sk-secret',
    access_token: 'secret',
    inputTokens: 51,
    outputTokens: 31,
    nested: { cookie: 'session=1', reasoningTokens: 26 },
    message: 'upstream rejected Authorization: Bearer REVIEW_SYNTHETIC_SECRET',
    detail: 'api_key=sk-abcdefghijklmnop',
  })
  assert.equal(redacted.authorization, '[redacted]')
  assert.equal(redacted.apiKey, '[redacted]')
  assert.equal(redacted.access_token, '[redacted]')
  assert.equal(redacted.inputTokens, 51)
  assert.equal(redacted.outputTokens, 31)
  assert.equal(redacted.nested.cookie, '[redacted]')
  assert.equal(redacted.nested.reasoningTokens, 26)
  assert.ok(!redacted.message.includes('REVIEW_SYNTHETIC_SECRET'))
  assert.ok(!redacted.detail.includes('abcdefghijklmnop'))
})

test('parses SSE blocks with CRLF, comments and multiple data lines', async () => {
  const body = new Response('data: {"a":1}\r\n\r\n: keepalive\r\nevent: x\r\ndata: {"b":\r\ndata: 2}\r\n\r\ndata: [DONE]\r\n\r\n').body
  const events = []
  for await (const event of sseData(body)) events.push(event)
  assert.deepEqual(events.map((event) => event.data), ['{"a":1}', '{"b":\n2}', '[DONE]'])
  assert.equal(events[1].event, 'x')
})

test('supervisor starts, adapter streams reasoning/text/usage, and stop releases the process', async (t) => {
  const port = await freePort()
  const config = normalizeConfig(rawConfig(port), { packageDir }).gateways[0]
  const ctx = fakeCtx()
  const supervisor = new GatewaySupervisor({ config, ctx, packageDir })
  t.after(async () => { await supervisor.dispose() })

  await supervisor.start('test')
  assert.equal(supervisor.snapshot().state, 'running')
  assert.equal(supervisor.snapshot().healthy, true)
  assert.equal(typeof supervisor.snapshot().pid, 'number')

  const adapter = createOpenAIAdapter({ config, supervisor, ctx, log: supervisor.logs })
  const models = await adapter.listModels()
  assert.deepEqual(models.map((model) => model.id), ['mock-model'])
  const resolved = await adapter.resolveModel('gateway-test', 'mock-model')
  assert.equal(resolved.context.contextWindow, 32_000)

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'gateway-test',
    model: 'mock-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxTokens: 128,
  })) {
    chunks.push(chunk)
  }
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('')
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(text, 'hello from mock gateway')
  assert.equal(reasoning, 'test reasoning')
  assert.equal(finish.reason.kind, 'stop')
  assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 })
  assert.ok(supervisor.logs.lines().some((line) => line.includes('[trace:request]')))

  const toolChunks = []
  for await (const chunk of adapter.stream({
    provider: 'gateway-test',
    model: 'mock-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'TOOL_CALL' }] }],
    tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }],
    maxTokens: 128,
  })) {
    toolChunks.push(chunk)
  }
  assert.ok(toolChunks.some((chunk) => chunk.type === 'tool-call-delta' && chunk.name === 'probe'))
  assert.equal(toolChunks.find((chunk) => chunk.type === 'finish').reason.kind, 'tool-calls')

  const pid = supervisor.snapshot().pid
  await supervisor.stop({ reason: 'test' })
  assert.equal(supervisor.snapshot().state, 'stopped')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid, 0), /ESRCH|invalid argument/)
})

test('truncated SSE without [DONE] or finish_reason is a transport failure', async (t) => {
  const port = await freePort()
  const config = normalizeConfig(rawConfig(port, { requestPath: '/chat/completions?truncated=1' }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => { await supervisor.dispose() })

  await supervisor.start('test')
  const adapter = createOpenAIAdapter({ config, supervisor, ctx: fakeCtx(), log: supervisor.logs })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'gateway-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        maxTokens: 128,
      })) {
        // consume until the truncated stream ends
      }
    },
    (error) => error.code === 'TRANSPORT' && /completion marker/.test(error.message),
  )
})

test('malformed SSE data is a protocol failure instead of silently dropped content', async (t) => {
  const port = await freePort()
  const config = normalizeConfig(rawConfig(port, { requestPath: '/chat/completions?malformed=1' }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => { await supervisor.dispose() })

  await supervisor.start('test')
  const adapter = createOpenAIAdapter({ config, supervisor, ctx: fakeCtx(), log: supervisor.logs })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'gateway-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        maxTokens: 128,
      })) {
        // consume until the malformed event
      }
    },
    (error) => error.code === 'INVALID_RESPONSE' && /non-JSON SSE/.test(error.message),
  )
})

test('explicit length finish wins over incomplete tool-call deltas', async (t) => {
  const port = await freePort()
  const config = normalizeConfig(rawConfig(port, { requestPath: '/chat/completions?tool_length=1' }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => { await supervisor.dispose() })

  await supervisor.start('test')
  const adapter = createOpenAIAdapter({ config, supervisor, ctx: fakeCtx(), log: supervisor.logs })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'gateway-test',
    model: 'mock-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'TOOL_CALL' }] }],
    tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }],
    maxTokens: 128,
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'max-tokens')
  assert.ok(chunks.some((chunk) => chunk.type === 'tool-call-delta' && chunk.id === 'call_truncated'))
})

test('preflight failure records state and lastError instead of staying idle', async (t) => {
  const config = normalizeConfig({
    gateways: {
      missing: {
        command: process.execPath,
        script: path.join(testDir, 'missing-server.py'),
        cwd: testDir,
        health: false,
        restart: false,
        provider: false,
        logs: { maxLines: 50 },
      },
    },
  }, { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => { await supervisor.dispose() })

  await assert.rejects(
    supervisor.start('test'),
    (error) => error.code === 'SCRIPT_MISSING' && /script does not exist/.test(error.message),
  )
  assert.equal(supervisor.snapshot().state, 'failed')
  assert.match(supervisor.snapshot().lastError, /script does not exist/)
  assert.equal(supervisor.snapshot().pid, undefined)
})

test('child exit during readiness aborts start instead of reporting running', async (t) => {
  const config = normalizeConfig({
    gateways: {
      early: {
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        cwd: testDir,
        health: false,
        restart: false,
        provider: false,
        logs: { maxLines: 50 },
      },
    },
  }, { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => { await supervisor.dispose() })

  await assert.rejects(supervisor.start('test'), /exited during startup|startup/i)
  assert.equal(supervisor.snapshot().state, 'failed')
  assert.equal(supervisor.snapshot().pid, undefined)
})

test('crashed gateway is automatically restarted with a new pid', async (t) => {
  const port = await freePort()
  const config = normalizeConfig(rawConfig(port, { restart: { initialDelayMs: 100, maxDelayMs: 300 } }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => { await supervisor.dispose() })

  await supervisor.start('test')
  const firstPid = supervisor.snapshot().pid
  await fetch(`http://127.0.0.1:${port}/crash`)
  await waitFor(() => supervisor.snapshot().restarts >= 1, { label: 'restart scheduled' })
  await waitFor(() => supervisor.snapshot().state === 'running' && supervisor.snapshot().pid !== firstPid, {
    label: 'restarted process',
    timeout: 15_000,
  })
  assert.ok(supervisor.snapshot().restarts >= 1)
  assert.equal(supervisor.snapshot().healthy, true)
})

test('restart budget stops an endlessly crashing gateway in failed state', async (t) => {
  const port = await freePort()
  const config = normalizeConfig(rawConfig(port, {
    restart: { maxRestarts: 1, initialDelayMs: 100, maxDelayMs: 200 },
  }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => { await supervisor.dispose() })

  await supervisor.start('test')
  await fetch(`http://127.0.0.1:${port}/crash`)
  await waitFor(() => supervisor.snapshot().state === 'running' && supervisor.snapshot().restarts === 1, {
    label: 'first restart',
    timeout: 10_000,
  })
  await fetch(`http://127.0.0.1:${port}/crash`)
  await waitFor(() => supervisor.snapshot().state === 'failed', { label: 'failed after budget', timeout: 10_000 })
  assert.match(supervisor.snapshot().lastError, /restart budget exhausted/)
})

test('disabled restart policy is honored by the health watchdog', async (t) => {
  const port = await freePort()
  const failFile = path.join(os.tmpdir(), `dsh-gateway-no-restart-${process.pid}-${Date.now()}`)
  const config = normalizeConfig(rawConfig(port, {
    failFile,
    health: { intervalMs: 250, failureThreshold: 2, startupTimeoutMs: 5_000 },
    restart: { enabled: false },
  }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => {
    try { fs.rmSync(failFile, { force: true }) } catch {}
    await supervisor.dispose()
  })

  await supervisor.start('test')
  const pid = supervisor.snapshot().pid
  fs.writeFileSync(failFile, 'fail')
  await waitFor(() => supervisor.snapshot().health.ok === false && /automatic restart is disabled/.test(supervisor.snapshot().lastError ?? ''), {
    label: 'disabled watchdog diagnostic',
    timeout: 10_000,
  })
  assert.equal(supervisor.snapshot().state, 'running')
  assert.equal(supervisor.snapshot().pid, pid)
  assert.equal(supervisor.snapshot().restarts, 0)
})

test('exhausted health restart budget stops the unhealthy child and reports failed', async (t) => {
  const port = await freePort()
  const failFile = path.join(os.tmpdir(), `dsh-gateway-health-budget-${process.pid}-${Date.now()}`)
  const config = normalizeConfig(rawConfig(port, {
    failFile,
    health: { intervalMs: 250, failureThreshold: 2, startupTimeoutMs: 5_000 },
    restart: { maxRestarts: 0, initialDelayMs: 50, maxDelayMs: 100 },
  }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => {
    try { fs.rmSync(failFile, { force: true }) } catch {}
    await supervisor.dispose()
  })

  await supervisor.start('test')
  fs.writeFileSync(failFile, 'fail')
  await waitFor(() => supervisor.snapshot().state === 'failed' && supervisor.snapshot().pid === undefined, {
    label: 'failed and stopped after health budget',
    timeout: 10_000,
  })
  assert.match(supervisor.snapshot().lastError, /restart budget exhausted/)
})

test('health watchdog recycles a gateway that stops answering health checks', async (t) => {
  const port = await freePort()
  const failFile = path.join(os.tmpdir(), `dsh-gateway-fail-${process.pid}-${Date.now()}`)
  const config = normalizeConfig(rawConfig(port, {
    failFile,
    health: { intervalMs: 250, failureThreshold: 2, startupTimeoutMs: 5_000 },
    restart: { initialDelayMs: 100, maxDelayMs: 300 },
  }), { packageDir }).gateways[0]
  const supervisor = new GatewaySupervisor({ config, ctx: fakeCtx(), packageDir })
  t.after(async () => {
    try { fs.rmSync(failFile, { force: true }) } catch {}
    await supervisor.dispose()
  })

  await supervisor.start('test')
  const firstPid = supervisor.snapshot().pid
  fs.writeFileSync(failFile, 'fail')
  await waitFor(() => supervisor.snapshot().restarts >= 1, { label: 'watchdog restart', timeout: 10_000 })
  fs.rmSync(failFile, { force: true })
  await waitFor(() => supervisor.snapshot().state === 'running' && supervisor.snapshot().pid !== firstPid, {
    label: 'watchdog recovered process',
    timeout: 15_000,
  })
  assert.equal(supervisor.snapshot().healthy, true)
})
