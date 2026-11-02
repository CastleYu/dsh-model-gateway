// Configuration normalization for the model-gateway framework.
//
// Everything is validated here, once, so the supervisor, adapter and tools can
// assume a complete shape.  The plugin intentionally keeps no dependency on
// DSH packages: profile-local ESM packages cannot reliably resolve the
// @deepseek-ai/* tree on Windows, so runtime services are reached through the
// Cordis context and everything else is Node built-ins.

import path from 'node:path'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class GatewayConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GatewayConfigError'
    this.code = 'MODEL_GATEWAY_CONFIG'
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message) {
  throw new GatewayConfigError(message)
}

function asString(value, field, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    fail(`${field} is required`)
  }
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value
}

function asOptionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value
}

function asBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

function asInteger(value, field, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    fail(`${field} is required`)
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

function asStringArray(value, field, fallback = []) {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') fail(`${field}[${index}] must be a string`)
    return entry
  })
}

function expandString(value, vars) {
  return value.replace(/\$\{([^}]+)\}/g, (whole, expression) => {
    const expr = expression.trim()
    if (expr.startsWith('env:')) {
      const name = expr.slice(4)
      return process.env[name] ?? ''
    }
    if (Object.hasOwn(vars, expr)) return String(vars[expr] ?? '')
    return whole
  })
}

function expandDeep(value, vars) {
  if (typeof value === 'string') return expandString(value, vars)
  if (Array.isArray(value)) return value.map((entry) => expandDeep(entry, vars))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = expandDeep(entry, vars)
    return out
  }
  return value
}

function normalizeEnv(raw, field, vars) {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) fail(`${field} must be an object`)
  const env = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`${field}.${key} is not a valid environment variable name`)
    if (value === null) {
      env[key] = null
      continue
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail(`${field}.${key} must be a string, number, boolean or null`)
    }
    env[key] = expandString(String(value), vars)
  }
  return env
}

function normalizeRestart(raw, field) {
  if (raw === false) {
    return {
      enabled: false,
      maxRestarts: 0,
      windowMs: 3_600_000,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
    }
  }
  const source = isPlainObject(raw) ? raw : {}
  return {
    enabled: asBoolean(source.enabled, `${field}.enabled`, true),
    maxRestarts: asInteger(source.maxRestarts, `${field}.maxRestarts`, 5, { min: 0 }),
    windowMs: asInteger(source.windowMs, `${field}.windowMs`, 3_600_000, { min: 1 }),
    initialDelayMs: asInteger(source.initialDelayMs, `${field}.initialDelayMs`, 1_000, { min: 1 }),
    maxDelayMs: asInteger(source.maxDelayMs, `${field}.maxDelayMs`, 30_000, { min: 1 }),
  }
}

function normalizeHealth(raw, field, { host, port, baseURL }) {
  if (raw === false) return { type: 'none' }
  let source = {}
  if (typeof raw === 'string') source = { url: raw }
  else if (isPlainObject(raw)) source = raw
  else if (raw !== undefined && raw !== null) fail(`${field} must be an object, URL string or false`)

  let type = asOptionalString(source.type, `${field}.type`) ?? (port > 0 ? 'tcp' : 'http')
  if (type !== 'http' && type !== 'tcp' && type !== 'none') fail(`${field}.type must be "http", "tcp" or "none"`)
  if (type === 'none') return { type }

  let url = asOptionalString(source.url, `${field}.url`)
  if (url !== undefined) {
    type = 'http'
    url = expandString(url, {})
  }
  if (type === 'http' && url === undefined) {
    const base = source.path !== undefined
      ? `${originOf(baseURL ?? '')}${asString(source.path, `${field}.path`)}`
      : (baseURL ?? '')
    if (!base) fail(`${field} needs a URL, a path, or a provider baseURL`)
    url = base
  }
  const expectStatus = source.expectStatus === undefined
    ? undefined
    : (() => {
        const values = Array.isArray(source.expectStatus) ? source.expectStatus : [source.expectStatus]
        return values.map((value, index) => asInteger(value, `${field}.expectStatus[${index}]`, undefined, { min: 100, max: 599 }))
      })()

  if (type === 'tcp' && (source.port === undefined ? port : source.port) <= 0) {
    fail(`${field} needs a positive port for a TCP health check`)
  }

  return {
    type,
    ...(url === undefined ? {} : { url }),
    ...(type === 'tcp' ? {
      host: asOptionalString(source.host, `${field}.host`) ?? host,
      port: asInteger(source.port, `${field}.port`, port, { min: 1, max: 65_535 }),
    } : {}),
    intervalMs: asInteger(source.intervalMs, `${field}.intervalMs`, 5_000, { min: 250 }),
    timeoutMs: asInteger(source.timeoutMs, `${field}.timeoutMs`, 2_500, { min: 100 }),
    startupTimeoutMs: asInteger(source.startupTimeoutMs, `${field}.startupTimeoutMs`, 30_000, { min: 100 }),
    failureThreshold: asInteger(source.failureThreshold, `${field}.failureThreshold`, 3, { min: 1 }),
    ...(source.bodyIncludes === undefined ? {} : { bodyIncludes: asString(source.bodyIncludes, `${field}.bodyIncludes`) }),
    ...(expectStatus === undefined ? {} : { expectStatus }),
    ...(asBoolean(source.allowAnyStatus, `${field}.allowAnyStatus`, true) === false ? { allowAnyStatus: false } : {}),
  }
}

function originOf(value) {
  try {
    const url = new URL(value)
    return url.origin
  } catch {
    return ''
  }
}

function normalizeModels(raw, field) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail(`${field} must be an array`)
  const seen = new Set()
  return raw.map((entry, index) => {
    const at = `${field}[${index}]`
    if (!isPlainObject(entry)) fail(`${at} must be an object`)
    const id = asString(entry.id, `${at}.id`)
    if (seen.has(id)) fail(`${at}.id "${id}" is duplicated`)
    seen.add(id)
    const input = entry.input === undefined
      ? ['text']
      : asStringArray(entry.input, `${at}.input`).map((modality, i) => {
          if (modality !== 'text' && modality !== 'image') fail(`${at}.input[${i}] must be "text" or "image"`)
          return modality
        })
    if (!input.includes('text')) input.unshift('text')
    return {
      id,
      name: asOptionalString(entry.name, `${at}.name`) ?? id,
      ...(entry.description === undefined ? {} : { description: asString(entry.description, `${at}.description`) }),
      contextWindow: asInteger(entry.contextWindow, `${at}.contextWindow`, 131_072, { min: 1 }),
      maxTokens: asInteger(entry.maxTokens, `${at}.maxTokens`, 8_192, { min: 1 }),
      input,
      ...(entry.reasoningEfforts === undefined ? {} : { reasoningEfforts: normalizeReasoningEfforts(entry.reasoningEfforts, `${at}.reasoningEfforts`) }),
      ...(entry.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: asString(entry.defaultReasoningEffort, `${at}.defaultReasoningEffort`) }),
    }
  })
}

function normalizeReasoningEfforts(raw, field) {
  if (raw === false) return false
  if (!isPlainObject(raw)) fail(`${field} must be an object mapping effort id to wire value, or false`)
  const out = {}
  for (const [effort, wire] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9._-]+$/.test(effort)) fail(`${field} key "${effort}" is invalid`)
    if (typeof wire !== 'string' || wire.length === 0) fail(`${field}.${effort} must be a non-empty string`)
    out[effort] = wire
  }
  return out
}

function normalizeProvider(raw, field, { id, host, port, displayName }) {
  if (raw === false || raw === null) return null
  const source = raw === undefined ? {} : raw
  if (!isPlainObject(source)) fail(`${field} must be an object or false`)

  const route = asOptionalString(source.route, `${field}.route`) ?? `gateway-${id}`
  if (route.length === 0) fail(`${field}.route must be non-empty`)
  const rawBaseURL = asOptionalString(source.baseURL, `${field}.baseURL`)
  const baseURL = rawBaseURL === undefined
    ? (port > 0 ? `http://${host}:${port}/v1` : undefined)
    : expandString(rawBaseURL, { host, port })
  if (baseURL === undefined) fail(`${field}.baseURL is required when no port is configured`)
  if (!/^https?:\/\//i.test(baseURL)) fail(`${field}.baseURL must start with http:// or https://`)

  const models = normalizeModels(source.models, `${field}.models`)
  const requestPath = asOptionalString(source.requestPath, `${field}.requestPath`) ?? '/chat/completions'
  if (!requestPath.startsWith('/')) fail(`${field}.requestPath must start with "/"`)

  const headers = {}
  if (source.headers !== undefined) {
    if (!isPlainObject(source.headers)) fail(`${field}.headers must be an object`)
    for (const [name, value] of Object.entries(source.headers)) {
      if (typeof value !== 'string') fail(`${field}.headers.${name} must be a string`)
      headers[name] = value
    }
  }

  return {
    route,
    displayName: asOptionalString(source.displayName, `${field}.displayName`) ?? displayName,
    baseURL: baseURL.replace(/\/+$/, ''),
    requestPath,
    modelsURL: asOptionalString(source.modelsURL, `${field}.modelsURL`),
    apiKeyEnv: asOptionalString(source.apiKeyEnv, `${field}.apiKeyEnv`),
    apiKey: asOptionalString(source.apiKey, `${field}.apiKey`),
    headers,
    models,
    sessionHeader: asOptionalString(source.sessionHeader, `${field}.sessionHeader`),
    modelListTimeoutMs: asInteger(source.modelListTimeoutMs, `${field}.modelListTimeoutMs`, 10_000, { min: 100 }),
    connectTimeoutMs: asInteger(source.connectTimeoutMs, `${field}.connectTimeoutMs`, 30_000, { min: 100 }),
    streamIdleTimeoutMs: asInteger(source.streamIdleTimeoutMs, `${field}.streamIdleTimeoutMs`, 300_000, { min: 1_000 }),
    maxTokensField: (() => {
      const value = asOptionalString(source.maxTokensField, `${field}.maxTokensField`) ?? 'max_tokens'
      if (value !== 'max_tokens' && value !== 'max_completion_tokens') fail(`${field}.maxTokensField must be "max_tokens" or "max_completion_tokens"`)
      return value
    })(),
    reasoningFields: asStringArray(source.reasoningFields, `${field}.reasoningFields`, ['reasoning_content', 'reasoning', 'reasoning_text', 'thinking']),
    extraBody: isPlainObject(source.extraBody) ? source.extraBody : {},
    sendSessionHeader: asBoolean(source.sendSessionHeader, `${field}.sendSessionHeader`, true),
    discoverModels: asBoolean(source.discoverModels, `${field}.discoverModels`, true),
    startOnRequest: asBoolean(source.startOnRequest, `${field}.startOnRequest`, true),
    trace: (() => {
      const value = asOptionalString(source.trace, `${field}.trace`) ?? 'summary'
      if (value !== 'off' && value !== 'summary' && value !== 'verbose') fail(`${field}.trace must be "off", "summary" or "verbose"`)
      return value
    })(),
  }
}

/**
 * Normalize the whole plugin config.
 * @param {unknown} raw raw Cordis row config.
 * @param {{ packageDir: string }} options module directory for resolveFrom: package.
 * @returns {{ gateways: object[] }}
 */
export function normalizeConfig(raw, { packageDir }) {
  const source = isPlainObject(raw) ? raw : {}
  const rawGateways = source.gateways
  if (rawGateways === undefined || rawGateways === null) return { gateways: [] }
  if (!isPlainObject(rawGateways)) fail('config.gateways must be an object keyed by gateway id')

  const gateways = []
  const routes = new Set()

  for (const [id, entry] of Object.entries(rawGateways)) {
    const at = `gateways.${id}`
    if (!ID_RE.test(id)) fail(`gateway id "${id}" must match ${ID_RE}`)
    if (!isPlainObject(entry)) fail(`${at} must be an object`)

    const enabled = asBoolean(entry.enabled, `${at}.enabled`, true)
    const host = asOptionalString(entry.host, `${at}.host`) ?? '127.0.0.1'
    const port = asInteger(entry.port, `${at}.port`, 0, { min: 0, max: 65_535 })
    const displayName = asOptionalString(entry.displayName, `${at}.displayName`) ?? id
    const resolveFrom = asOptionalString(entry.resolveFrom, `${at}.resolveFrom`) ?? 'cwd'
    if (resolveFrom !== 'cwd' && resolveFrom !== 'package') fail(`${at}.resolveFrom must be "cwd" or "package"`)

    const cwdBase = resolveFrom === 'package' ? packageDir : process.cwd()
    const rawCwd = asOptionalString(entry.cwd, `${at}.cwd`) ?? cwdBase
    const cwd = path.resolve(cwdBase, expandString(rawCwd, { id, host, port, packageDir }))

    const rawScript = asOptionalString(entry.script, `${at}.script`)
    const script = rawScript === undefined ? undefined : path.resolve(cwd, expandString(rawScript, { id, host, port, packageDir, cwd }))
    const args = asStringArray(entry.args, `${at}.args`)

    const vars = { id, host, port, packageDir, cwd, script: script ?? '' }
    const env = normalizeEnv(entry.env, `${at}.env`, vars)
    const provider = normalizeProvider(entry.provider, `${at}.provider`, { id, host, port, displayName })
    if (provider !== null) {
      if (routes.has(provider.route)) fail(`${at}.provider.route "${provider.route}" is used by more than one gateway`)
      routes.add(provider.route)
    }

    const autoStart = asBoolean(entry.autoStart, `${at}.autoStart`, true)
    const restart = normalizeRestart(entry.restart, `${at}.restart`)
    const health = normalizeHealth(entry.health, `${at}.health`, { host, port, baseURL: provider?.baseURL })
    const logs = isPlainObject(entry.logs) ? entry.logs : {}
    const logFile = asOptionalString(logs.file, `${at}.logs.file`)

    gateways.push({
      id,
      enabled,
      displayName,
      description: asOptionalString(entry.description, `${at}.description`),
      command: asString(entry.command, `${at}.command`),
      args,
      script,
      cwd,
      env,
      resolveFrom,
      shell: asBoolean(entry.shell, `${at}.shell`, false),
      host,
      port,
      checkPort: asBoolean(entry.checkPort, `${at}.checkPort`, true),
      reuseExisting: asBoolean(entry.reuseExisting, `${at}.reuseExisting`, false),
      autoStart,
      stopTimeoutMs: asInteger(entry.stopTimeoutMs, `${at}.stopTimeoutMs`, 5_000, { min: 100 }),
      health,
      restart,
      provider,
      logs: {
        maxLines: asInteger(logs.maxLines, `${at}.logs.maxLines`, 2_000, { min: 1 }),
        maxBytes: asInteger(logs.maxBytes, `${at}.logs.maxBytes`, 1_048_576, { min: 1_024 }),
        file: logFile === undefined ? undefined : path.resolve(cwd, logFile),
      },
      packageDir,
    })
  }

  return { gateways }
}

export function interpolate(value, vars) {
  return expandString(value, vars)
}
