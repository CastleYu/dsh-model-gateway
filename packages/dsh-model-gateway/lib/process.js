// OS helpers for the gateway supervisor.  No DSH imports: these are pure
// Node primitives so the framework can be unit-tested outside the Harness.

import net from 'node:net'
import { spawn } from 'node:child_process'

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function isPortFree(host, port, timeoutMs = 1_000) {
  if (!Number.isInteger(port) || port <= 0) return { free: true }
  return await new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    server.once('error', (error) => {
      finish({
        free: false,
        reason: error?.code ?? 'ERROR',
        detail: String(error?.message ?? error),
      })
    })
    server.listen({ host, port, exclusive: true }, () => {
      // Resolve only after close: the probe itself must release the port
      // before the supervisor is allowed to spawn the real listener.
      server.close(() => finish({ free: true }))
    })
    timer = setTimeout(() => {
      try {
        server.close(() => finish({ free: false, reason: 'TIMEOUT', detail: `port probe timed out after ${timeoutMs}ms` }))
      } catch {
        finish({ free: false, reason: 'TIMEOUT', detail: `port probe timed out after ${timeoutMs}ms` })
      }
    }, timeoutMs)
    timer.unref?.()
  })
}

export function tcpCheck(host, port, timeoutMs = 2_500) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (ok, detail) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, detail, latencyMs: Date.now() - started })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, `tcp ${host}:${port}`))
    socket.once('timeout', () => finish(false, `tcp timeout after ${timeoutMs}ms`))
    socket.once('error', (error) => finish(false, `tcp ${error.code ?? error.message}`))
  })
}

export async function httpCheck(url, {
  timeoutMs = 2_500,
  expectStatus,
  bodyIncludes,
  allowAnyStatus = true,
} = {}) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`health timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json,text/plain,*/*', 'user-agent': 'dsh-model-gateway/health' },
    })
    let body = ''
    if (bodyIncludes !== undefined || !allowAnyStatus) {
      body = (await response.text()).slice(0, 8_192)
    } else {
      try { await response.body?.cancel() } catch {}
    }
    const statusOk = Array.isArray(expectStatus)
      ? expectStatus.includes(response.status)
      : allowAnyStatus
        ? response.status < 500
        : response.status >= 200 && response.status < 300
    const bodyOk = bodyIncludes === undefined ? true : body.includes(bodyIncludes)
    return {
      ok: statusOk && bodyOk,
      status: response.status,
      latencyMs: Date.now() - started,
      detail: `http ${response.status}${bodyOk ? '' : ' (body marker missing)'}${statusOk ? '' : ' (unexpected status)'}`,
    }
  } catch (error) {
    const message = controller.signal.aborted
      ? `http timeout after ${timeoutMs}ms`
      : `http ${error?.code ?? error?.name ?? 'error'}: ${String(error?.message ?? error)}`
    return { ok: false, detail: message, latencyMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

export function waitForExit(child, timeoutMs) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(value)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    timer.unref?.()
    child.once('exit', onExit)
  })
}

async function run(command, args, timeoutMs) {
  return await new Promise((resolve) => {
    let settled = false
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve({ ok: false, code: null, detail: 'helper timeout' })
    }, Math.max(500, timeoutMs))
    timer.unref?.()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: null, detail: error.message })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, detail: signal ?? undefined })
    })
  })
}

/**
 * Kill one child and its descendants.
 * Windows uses taskkill /T because Node's kill() reaches only the direct
 * process; POSIX uses the detached process group.
 */
export async function killTree(child, { force = false, timeoutMs = 8_000 } = {}) {
  if (child === undefined || child.pid === undefined) return { ok: true, detail: 'no process' }

  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return { ok: true, detail: 'already exited' }
    const args = ['/PID', String(child.pid), '/T']
    if (force) args.push('/F')
    const result = await run('taskkill', args, timeoutMs)
    if (result.ok) return { ok: true, detail: `taskkill${force ? ' /F' : ''}` }
    // 128 = process not found; treat as already gone.
    if (result.code === 128) return { ok: true, detail: 'already exited' }
    if (force) {
      try { child.kill('SIGKILL') } catch {}
      return { ok: false, detail: result.detail ?? 'taskkill failed' }
    }
    return { ok: false, detail: result.detail ?? 'taskkill failed' }
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM'
  try {
    process.kill(-child.pid, signal)
    return { ok: true, detail: `process-group ${signal}` }
  } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, detail: 'already exited' }
    try {
      child.kill(signal)
      return { ok: true, detail: signal }
    } catch (fallback) {
      return { ok: false, detail: String(fallback?.message ?? fallback) }
    }
  }
}
