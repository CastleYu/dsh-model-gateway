// Gateway process supervisor: start, readiness, health watchdog, crash
// restart with a bounded budget, graceful stop, and process-tree cleanup.

import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'
import { GatewayLog } from './log-store.js'
import {
  delay,
  isPortFree,
  tcpCheck,
  httpCheck,
  killTree,
  waitForExit,
} from './process.js'

function errorWithCode(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping', 'restarting'])

// Best-effort last line of defence for a Host that exits without unwinding
// plugin effects (a normal DSH shutdown does unwind them).  A force-killed
// Host still cannot run this hook; a real Windows Job Object would be needed
// for that stronger guarantee.
const liveChildren = new Set()
let exitGuardInstalled = false

function installExitGuard() {
  if (exitGuardInstalled) return
  exitGuardInstalled = true
  process.once('exit', () => {
    for (const pid of liveChildren) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else {
          process.kill(-pid, 'SIGKILL')
        }
      } catch {}
    }
  })
}

function trackChild(child) {
  if (child?.pid === undefined) return
  liveChildren.add(child.pid)
  installExitGuard()
  child.once('exit', () => liveChildren.delete(child.pid))
}

function untrackChild(child) {
  if (child?.pid !== undefined) liveChildren.delete(child.pid)
}

export class GatewaySupervisor extends EventEmitter {
  constructor({ config, ctx, packageDir }) {
    super()
    this.config = config
    this.ctx = ctx
    this.packageDir = packageDir
    this.logger = ctx.logger
    this.logs = new GatewayLog({
      maxLines: config.logs.maxLines,
      maxBytes: config.logs.maxBytes,
      file: config.logs.file,
      logger: ctx.logger,
      prefix: `model-gateway:${config.id}`,
    })
    this.state = config.enabled ? 'idle' : 'disabled'
    this.child = undefined
    this.pid = undefined
    this.startedAt = undefined
    this.lastExit = undefined
    this.lastError = undefined
    this.providerError = undefined
    this.desiredRunning = false
    this.starting = undefined
    this.startAbort = undefined
    this.stopping = false
    this.disposed = false
    this.restartTimer = undefined
    this.nextRestartAt = undefined
    this.restartHistory = []
    this.healthTimer = undefined
    this.healthCheckInFlight = false
    this.health = {
      ok: false,
      detail: 'not checked',
      lastCheckAt: undefined,
      consecutiveFailures: 0,
    }
  }

  get route() {
    return this.config.provider?.route
  }

  get baseURL() {
    return this.config.provider?.baseURL
  }

  log(level, message) {
    const text = `[model-gateway:${this.config.id}] ${message}`
    const logger = this.ctx?.logger
    try {
      if (level === 'error') logger?.error?.(text)
      else if (level === 'warn') logger?.warn?.(text)
      else logger?.info?.(text)
    } catch {}
    this.logs.push(level === 'error' ? 'stderr' : 'system', message)
  }

  trace(event, data) {
    this.logs.trace(event, data)
  }

  snapshot() {
    const now = Date.now()
    return {
      id: this.config.id,
      displayName: this.config.displayName,
      description: this.config.description,
      enabled: this.config.enabled,
      state: this.state,
      pid: this.pid,
      desiredRunning: this.desiredRunning,
      healthy: this.health.ok,
      health: {
        ok: this.health.ok,
        detail: this.health.detail,
        lastCheckAt: this.health.lastCheckAt,
        consecutiveFailures: this.health.consecutiveFailures,
      },
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === undefined ? 0 : Math.max(0, now - this.startedAt),
      restarts: this.restartHistory.length,
      restartHistory: [...this.restartHistory],
      nextRestartAt: this.nextRestartAt,
      lastError: this.lastError,
      providerError: this.providerError,
      lastExit: this.lastExit,
      port: this.config.port || undefined,
      provider: this.config.provider === null ? null : {
        route: this.config.provider.route,
        displayName: this.config.provider.displayName,
        baseURL: this.config.provider.baseURL,
        models: this.config.provider.models.map((model) => model.id),
      },
      logFile: this.config.logs.file,
      command: this.config.script === undefined
        ? this.config.command
        : `${this.config.command} ${this.config.script}`,
    }
  }

  emitChange() {
    try { this.emit('change', this.snapshot()) } catch (error) { this.logger?.warn?.(error) }
  }

  /** Start and resolve once readiness passes. Idempotent while starting. */
  async start(reason = 'manual') {
    if (!this.config.enabled) throw errorWithCode(`gateway "${this.config.id}" is disabled`, 'GATEWAY_DISABLED')
    if (this.disposed) throw errorWithCode(`gateway "${this.config.id}" supervisor is disposed`, 'GATEWAY_DISPOSED')
    // Explicit operator recovery (and fresh boot) starts a new failure budget.
    // Automatic restart reasons keep the current budget.
    if (reason === 'manual' || reason === 'tool' || reason === 'autostart' || reason === 'manual-restart') {
      this.restartHistory = []
    }
    this.desiredRunning = true
    if (this.state === 'running') return this.snapshot()
    if (this.starting !== undefined) return await this.starting
    this.starting = this._start(reason).finally(() => {
      this.starting = undefined
    })
    return await this.starting
  }

  async _start(reason) {
    if (this.disposed) throw errorWithCode('supervisor disposed', 'GATEWAY_DISPOSED')
    if (this.stopping) throw errorWithCode('gateway is stopping', 'GATEWAY_STOPPING')
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
      this.nextRestartAt = undefined
    }
    await this._clearChildIfExited()

    if (this.config.checkPort && this.config.port > 0) {
      const probe = await isPortFree(this.config.host, this.config.port)
      if (!probe.free) {
        const code = probe.reason === 'EADDRINUSE' ? 'PORT_IN_USE' : 'PORT_CHECK_FAILED'
        throw this._startFailure(
          errorWithCode(`port ${this.config.host}:${this.config.port} is not available (${probe.detail ?? probe.reason})`, code),
          code,
        )
      }
    }

    if (!fs.existsSync(this.config.cwd)) {
      throw this._startFailure(
        errorWithCode(`working directory does not exist: ${this.config.cwd}`, 'CWD_MISSING'),
        'CWD_MISSING',
      )
    }
    if (this.config.script !== undefined && !fs.existsSync(this.config.script)) {
      throw this._startFailure(
        errorWithCode(`gateway script does not exist: ${this.config.script}`, 'SCRIPT_MISSING'),
        'SCRIPT_MISSING',
      )
    }

    const args = this.config.script === undefined
      ? [...this.config.args]
      : [this.config.script, ...this.config.args]
    const env = { ...process.env }
    for (const [key, value] of Object.entries(this.config.env)) {
      if (value === null) delete env[key]
      else env[key] = value
    }
    if (this.config.port > 0) {
      if (env.PORT === undefined) env.PORT = String(this.config.port)
      if (env.HOST === undefined) env.HOST = this.config.host
    }
    env.MODEL_GATEWAY_ID = this.config.id
    if (this.baseURL !== undefined && env.MODEL_GATEWAY_BASE_URL === undefined) env.MODEL_GATEWAY_BASE_URL = this.baseURL

    this.state = 'starting'
    this.startedAt = undefined
    this.lastError = undefined
    this.health = { ok: false, detail: 'starting', lastCheckAt: undefined, consecutiveFailures: 0 }
    this.startAbort = new AbortController()
    this.emitChange()
    this.log('info', `starting${reason === 'manual' ? '' : ` (${reason})`}: ${this.config.command}${this.config.script === undefined ? '' : ` ${this.config.script}`}`)
    this.trace('start', {
      reason,
      command: this.config.command,
      script: this.config.script,
      cwd: this.config.cwd,
      port: this.config.port,
    })

    const spawnStartedAt = Date.now()
    let child
    try {
      child = spawn(this.config.command, args, {
        cwd: this.config.cwd,
        env,
        shell: this.config.shell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw this._startFailure(error, 'SPAWN_FAILED')
    }

    this.child = child
    this.pid = child.pid
    trackChild(child)
    this.attachOutput(child, 'stdout', child.stdout)
    this.attachOutput(child, 'stderr', child.stderr)
    child.once('error', (error) => {
      this.lastError = String(error?.message ?? error)
      this.log('error', `spawn error: ${this.lastError}`)
      this.trace('spawn-error', { message: this.lastError, code: error?.code })
      this.startAbort?.abort(error)
    })
    child.once('exit', (code, signal) => this.onExit(child, code, signal))
    this.trace('spawned', { pid: child.pid })
    this.emitChange()

    try {
      await this.waitReady(this.startAbort.signal)
      // The child can exit between the readiness probe and the state commit.
      // Never overwrite the exit handler's failure state with a dead `running`.
      if (this.startAbort.signal.aborted || this.child !== child || child.exitCode !== null || child.signalCode !== null) {
        throw this.startAbort.signal.reason ?? errorWithCode('gateway process exited before startup committed', 'STARTUP_EXITED')
      }
    } catch (error) {
      this.log('error', `startup failed: ${String(error?.message ?? error)}`)
      this.trace('startup-failed', { message: String(error?.message ?? error), code: error?.code })
      await this.killCurrent({ force: true, reason: 'startup-failed' })
      const restartPending = this.restartTimer !== undefined || this.state === 'restarting'
      if (!restartPending) this.state = 'failed'
      this.lastError = String(error?.message ?? error)
      this.startAbort = undefined
      this.emitChange()
      if (!restartPending && this.desiredRunning && !this.stopping && !this.disposed) {
        this.scheduleRestart('startup-failed')
      }
      throw error
    }

    this.state = 'running'
    this.startedAt = Date.now()
    this.lastError = undefined
    this.lastExit = undefined
    this.health = { ok: true, detail: 'ready', lastCheckAt: Date.now(), consecutiveFailures: 0 }
    this.startAbort = undefined
    this.log('info', `ready (pid ${this.pid ?? 'external'}) on ${this.baseURL ?? `${this.config.host}:${this.config.port}`}`)
    this.trace('ready', { pid: this.pid, elapsedMs: Date.now() - spawnStartedAt })
    this._startHealthLoop()
    this.emitChange()
    return this.snapshot()
  }

  _startFailure(error, code) {
    const message = String(error?.message ?? error)
    this.state = 'failed'
    this.lastError = message
    this.log('error', `cannot start: ${message}`)
    this.trace('start-failure', { message, code })
    this.emitChange()
    if (this.desiredRunning && !this.stopping && !this.disposed) this.scheduleRestart('spawn-failed')
    const wrapped = errorWithCode(message, code)
    wrapped.cause = error
    return wrapped
  }

  attachOutput(child, stream, readable) {
    if (readable === undefined || readable === null) return
    try {
      const rl = readline.createInterface({ input: readable, crlfDelay: Infinity })
      rl.on('line', (line) => this.logs.push(stream, line))
      rl.on('error', (error) => this.logs.push('system', `${stream} reader: ${error.message}`))
    } catch (error) {
      this.logs.push('system', `cannot attach ${stream}: ${error.message}`)
    }
  }

  async waitReady(signal) {
    const health = this.config.health
    const started = Date.now()
    if (health.type === 'none') {
      await delay(200, signal)
      return
    }
    let lastDetail = 'not checked'
    while (Date.now() - started < health.startupTimeoutMs) {
      signal?.throwIfAborted()
      const result = await this.checkHealth()
      this.health.lastCheckAt = Date.now()
      this.health.detail = result.detail
      if (result.ok) return
      lastDetail = result.detail
      this.logs.push('system', `waiting for readiness: ${result.detail}`)
      await delay(Math.min(1_000, Math.max(100, health.intervalMs / 2)), signal)
    }
    throw errorWithCode(`gateway "${this.config.id}" did not become ready within ${health.startupTimeoutMs}ms (${lastDetail})`, 'STARTUP_TIMEOUT')
  }

  async checkHealth() {
    if (this.config.health.type === 'none') return { ok: true, detail: 'health check disabled', latencyMs: 0 }
    if (this.config.health.type === 'tcp') {
      return await tcpCheck(this.config.health.host, this.config.health.port, this.config.health.timeoutMs)
    }
    return await httpCheck(this.config.health.url, {
      timeoutMs: this.config.health.timeoutMs,
      expectStatus: this.config.health.expectStatus,
      bodyIncludes: this.config.health.bodyIncludes,
      allowAnyStatus: this.config.health.allowAnyStatus !== false,
    })
  }

  _startHealthLoop() {
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer)
    if (this.config.health.type === 'none') return
    this.healthTimer = setInterval(() => {
      this.runHealthCheck().catch((error) => {
        this.log('warn', `health loop error: ${String(error?.message ?? error)}`)
      })
    }, this.config.health.intervalMs)
    this.healthTimer.unref?.()
  }

  async runHealthCheck() {
    if (this.state !== 'running' || this.healthCheckInFlight || this.stopping || this.disposed) return
    this.healthCheckInFlight = true
    try {
      const result = await this.checkHealth()
      this.health.lastCheckAt = Date.now()
      this.health.detail = result.detail
      if (result.ok) {
        this.health.ok = true
        this.health.consecutiveFailures = 0
        return
      }
      this.health.ok = false
      this.health.consecutiveFailures += 1
      this.trace('health-failed', {
        detail: result.detail,
        failures: this.health.consecutiveFailures,
        threshold: this.config.health.failureThreshold,
      })
      this.log('warn', `health check failed (${this.health.consecutiveFailures}/${this.config.health.failureThreshold}): ${result.detail}`)
      if (this.health.consecutiveFailures >= this.config.health.failureThreshold) {
        await this.recoverFromUnhealthy(result.detail)
      }
    } finally {
      this.healthCheckInFlight = false
    }
  }

  async recoverFromUnhealthy(detail) {
    if (this.stopping || this.disposed || !this.desiredRunning) return
    if (!this.config.restart.enabled) {
      this.lastError = `health check failed and automatic restart is disabled: ${detail}`
      this.health.ok = false
      this.health.detail = detail
      this.health.consecutiveFailures = 0
      this.log('error', this.lastError)
      this.trace('watchdog-disabled', { detail })
      this.emitChange()
      return
    }
    this.log('warn', `health watchdog is recycling the gateway: ${detail}`)
    const now = Date.now()
    this.restartHistory = this.restartHistory.filter((at) => now - at < this.config.restart.windowMs)
    if (this.restartHistory.length >= this.config.restart.maxRestarts) {
      const message = `restart budget exhausted after repeated health failures; last health: ${detail}`
      this.log('error', message)
      this.trace('watchdog-budget-exhausted', { detail, attempts: this.restartHistory.length })
      this.desiredRunning = false
      try {
        await this.stop({ reason: 'watchdog-budget-exhausted' })
      } catch (error) {
        this.log('error', `cannot stop failed gateway: ${String(error?.message ?? error)}`)
      }
      this.state = 'failed'
      this.desiredRunning = false
      this.lastError = message
      this.health.ok = false
      this.health.detail = detail
      this.health.consecutiveFailures = 0
      this.emitChange()
      return
    }
    this.trace('watchdog-restart', { detail, attempt: this.restartHistory.length + 1 })
    this.health.consecutiveFailures = 0
    try {
      await this.stop({ reason: 'health-watchdog', keepDesired: true })
      await this.start('health-watchdog')
      // Count one recycle only after it actually started; a failed start is
      // counted once by scheduleRestart(), not again here.
      this.restartHistory.push(Date.now())
      this.trace('watchdog-recovered', { detail, attempt: this.restartHistory.length })
    } catch (error) {
      this.log('error', `watchdog restart failed: ${String(error?.message ?? error)}`)
      if (this.desiredRunning) this.scheduleRestart('watchdog-restart-failed')
    }
  }

  onExit(child, code, signal) {
    untrackChild(child)
    if (this.child !== child) return
    this.child = undefined
    this.pid = undefined
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
    const exit = { code, signal, at: new Date().toISOString() }
    this.lastExit = exit
    this.log('warn', `process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
    this.trace('exit', exit)

    if (this.stopping || this.disposed || !this.desiredRunning) {
      if (this.state !== 'stopped') this.state = 'stopped'
      this.health.ok = false
      this.health.detail = 'process exited'
      this.emitChange()
      return
    }

    // Readiness must not survive the process it is checking. Without this,
    // health:false would resolve start() as running after the 200ms settle
    // delay even though the child is already gone, and health-enabled
    // startups would keep polling a dead PID until the full timeout.
    if (this.state === 'starting') {
      try {
        this.startAbort?.abort(new Error(`gateway process exited during startup (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
      } catch {}
    }

    this.state = 'crashed'
    this.lastError = `process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    this.health.ok = false
    this.health.detail = 'process exited unexpectedly'
    this.emitChange()
    this.scheduleRestart('crash')
  }

  scheduleRestart(reason) {
    if (this.disposed || this.stopping || !this.desiredRunning) return
    const policy = this.config.restart
    if (!policy.enabled) {
      this.state = 'failed'
      this.lastError = `${this.lastError ?? 'gateway failed'}; automatic restart is disabled`
      this.emitChange()
      return
    }
    if (this.restartTimer !== undefined) return

    const now = Date.now()
    this.restartHistory = this.restartHistory.filter((at) => now - at < policy.windowMs)
    if (this.restartHistory.length >= policy.maxRestarts) {
      this.state = 'failed'
      this.lastError = `restart budget exhausted (${policy.maxRestarts} attempts in ${Math.round(policy.windowMs / 1000)}s)`
      this.log('error', this.lastError)
      this.trace('restart-budget-exhausted', { attempts: this.restartHistory.length, windowMs: policy.windowMs })
      this.emitChange()
      return
    }

    const exponent = Math.min(this.restartHistory.length, 10)
    const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * (2 ** exponent))
    const jitter = 0.85 + Math.random() * 0.3
    const delayMs = Math.max(100, Math.round(base * jitter))
    this.restartHistory.push(now)
    this.nextRestartAt = now + delayMs
    this.state = 'restarting'
    this.log('warn', `restart ${this.restartHistory.length}/${policy.maxRestarts} scheduled in ${delayMs}ms (${reason})`)
    this.trace('restart-scheduled', { reason, delayMs, attempt: this.restartHistory.length, maxRestarts: policy.maxRestarts })
    this.emitChange()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.nextRestartAt = undefined
      if (this.disposed || this.stopping || !this.desiredRunning) return
      this.start('auto-restart').catch((error) => {
        this.log('error', `restart attempt failed: ${String(error?.message ?? error)}`)
        // _start already schedules the next attempt for startup failures.
        if (this.state === 'failed' && this.desiredRunning) this.scheduleRestart('restart-failed')
      })
    }, delayMs)
    this.restartTimer.unref?.()
  }

  async _clearChildIfExited() {
    if (this.child !== undefined && (this.child.exitCode !== null || this.child.signalCode !== null)) {
      this.child = undefined
      this.pid = undefined
    }
  }

  async killCurrent({ force, reason }) {
    const child = this.child
    if (child === undefined) return
    this.trace('kill', { pid: child.pid, force, reason })
    // Windows console children do not reliably act on taskkill's graceful
    // close request, and a second pass can take many seconds. Force the tree
    // by default there; POSIX keeps SIGTERM grace before SIGKILL.
    const effectiveForce = force || process.platform === 'win32'
    const graceMs = effectiveForce ? 0 : Math.min(this.config.stopTimeoutMs, 30_000)
    if (effectiveForce && !force) this.log('info', 'force-stopping the Windows process tree')
    const result = await killTree(child, { force: effectiveForce, timeoutMs: Math.max(1_000, graceMs + 1_000) })
    if (!result.ok) this.log('warn', `kill reported: ${result.detail}`)
    const exited = await waitForExit(child, effectiveForce ? 3_000 : graceMs)
    if (!exited && !effectiveForce) {
      this.log('warn', `graceful stop timed out after ${graceMs}ms; forcing`)
      await killTree(child, { force: true, timeoutMs: 5_000 })
      await waitForExit(child, 2_000)
    }
    // The direct child can exit while descendants in the same process group
    // ignore SIGTERM. Re-check the group independently of that exit and force
    // any survivors, otherwise a documented process-tree cleanup leaks them.
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 0)
        await killTree(child, { force: true, timeoutMs: 5_000 })
        await waitForExit(child, 1_000)
      } catch {}
    }
    if (this.child === child) {
      this.child = undefined
      this.pid = undefined
    }
    untrackChild(child)
  }

  async stop({ reason = 'manual', keepDesired = false } = {}) {
    if (!keepDesired) this.desiredRunning = false
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
      this.nextRestartAt = undefined
    }
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
    if (this.config.enabled === false) {
      this.state = 'disabled'
      return this.snapshot()
    }
    this.stopping = true
    if (this.starting !== undefined) {
      try { this.startAbort?.abort(new Error('gateway stopped during startup')) } catch {}
      try { await this.starting } catch {}
    }
    if (this.child === undefined) {
      this.stopping = false
      if (this.state !== 'failed') this.state = 'stopped'
      this.health = { ok: false, detail: 'stopped', lastCheckAt: Date.now(), consecutiveFailures: 0 }
      this.emitChange()
      return this.snapshot()
    }

    this.state = 'stopping'
    this.emitChange()
    this.log('info', `stopping (${reason})`)
    this.trace('stop', { reason })
    try {
      await this.killCurrent({ force: false, reason })
    } finally {
      this.stopping = false
      this.state = keepDesired ? 'stopped' : 'stopped'
      this.health = { ok: false, detail: 'stopped', lastCheckAt: Date.now(), consecutiveFailures: 0 }
      this.emitChange()
    }
    return this.snapshot()
  }

  async restart(reason = 'manual-restart') {
    await this.stop({ reason, keepDesired: true })
    this.desiredRunning = true
    return await this.start(reason)
  }

  async ensureRunning() {
    if (this.state === 'running') return this.snapshot()
    if (this.config.provider?.startOnRequest === false) {
      throw errorWithCode(`gateway "${this.config.id}" is not running and startOnRequest is false`, 'GATEWAY_DOWN')
    }
    return await this.start('request')
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.desiredRunning = false
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer)
    this.healthTimer = undefined
    this.startAbort?.abort(new Error('supervisor disposed'))
    try { await this.starting } catch {}
    try { await this.stop({ reason: 'plugin-dispose' }) } catch (error) {
      this.logger?.warn?.(`[model-gateway:${this.config.id}] dispose error: ${String(error?.message ?? error)}`)
    }
    await this.logs.dispose()
    this.removeAllListeners()
  }
}

export class GatewayManager {
  constructor({ configs, ctx, packageDir }) {
    this.ctx = ctx
    this.packageDir = packageDir
    this.supervisors = new Map()
    for (const config of configs) {
      this.supervisors.set(config.id, new GatewaySupervisor({ config, ctx, packageDir }))
    }
  }

  list() {
    return [...this.supervisors.values()].map((supervisor) => supervisor.snapshot())
  }

  get(id) {
    return this.supervisors.get(id)
  }

  require(id) {
    const supervisor = this.supervisors.get(id)
    if (supervisor === undefined) {
      throw errorWithCode(`unknown gateway "${id}"; known: ${[...this.supervisors.keys()].join(', ') || '(none)'}`, 'UNKNOWN_GATEWAY')
    }
    return supervisor
  }

  async startAll() {
    const results = []
    for (const supervisor of this.supervisors.values()) {
      if (!supervisor.config.enabled || !supervisor.config.autoStart) continue
      try {
        await supervisor.start('autostart')
        results.push({ id: supervisor.config.id, ok: true })
      } catch (error) {
        supervisor.log?.('error', `autostart failed: ${String(error?.message ?? error)}`)
        results.push({ id: supervisor.config.id, ok: false, error: String(error?.message ?? error) })
      }
    }
    return results
  }

  async dispose() {
    await Promise.allSettled([...this.supervisors.values()].map((supervisor) => supervisor.dispose()))
  }
}
