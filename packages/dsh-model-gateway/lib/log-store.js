// Bounded in-memory log + optional JSONL persistence + redacted traces.
//
// The ring buffer is deliberately independent of ctx.logger: the log tool is
// the way an operator diagnoses a gateway whose protocol does not match DSH's
// expectations, and ctx.logger lines are not queryable from the model.

import fs from 'node:fs'
import path from 'node:path'

const SECRET_KEY_RE = /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|cookie|set-cookie)$/i

export function redact(value, depth = 0) {
  if (depth > 8) return '[depth-limit]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (value.length > 4_000) return `${value.slice(0, 4_000)}…[truncated]`
    return value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => redact(entry, depth + 1))
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redact(entry, depth + 1)
  }
  return out
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

export class GatewayLog {
  constructor({ maxLines = 2_000, maxBytes = 1_048_576, file, logger, prefix }) {
    this.maxLines = maxLines
    this.maxBytes = maxBytes
    this.file = file
    this.logger = logger
    this.prefix = prefix
    this.entries = []
    this.bytes = 0
    this.disposed = false
    this.stream = undefined
    this.fileErrorReported = false
    if (file) this.openFile()
  }

  openFile() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      this.stream = fs.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' })
      this.stream.on('error', (error) => this.reportFileError(error))
    } catch (error) {
      this.reportFileError(error)
    }
  }

  reportFileError(error) {
    if (this.fileErrorReported) return
    this.fileErrorReported = true
    this.logger?.warn?.(`[${this.prefix}] cannot write log file ${this.file}: ${String(error?.message ?? error)}`)
  }

  push(stream, text) {
    if (this.disposed) return
    const raw = String(text ?? '')
    const lines = raw.replace(/\r\n/g, '\n').split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      if (line.length === 0) continue
      this.append({ ts: new Date().toISOString(), stream, text: line })
    }
  }

  trace(event, data) {
    if (this.disposed) return
    this.append({
      ts: new Date().toISOString(),
      stream: 'trace',
      event,
      data: redact(data),
    })
  }

  append(entry) {
    const line = JSON.stringify(entry)
    const size = byteLength(line) + 1
    this.entries.push({ entry, size })
    this.bytes += size
    while (this.entries.length > this.maxLines || this.bytes > this.maxBytes) {
      const removed = this.entries.shift()
      if (removed === undefined) break
      this.bytes -= removed.size
    }
    if (this.stream) {
      try {
        this.stream.write(`${line}\n`)
      } catch (error) {
        this.reportFileError(error)
      }
    }
  }

  tail({ limit = 200, stream, event, since } = {}) {
    const count = Math.max(1, Math.min(5_000, Number.isInteger(limit) ? limit : 200))
    const sinceMs = since === undefined ? undefined : Date.parse(since)
    const selected = []
    for (let i = this.entries.length - 1; i >= 0 && selected.length < count; i -= 1) {
      const item = this.entries[i].entry
      if (stream !== undefined && item.stream !== stream) continue
      if (event !== undefined && item.event !== event) continue
      if (sinceMs !== undefined && Number.isFinite(sinceMs) && Date.parse(item.ts) < sinceMs) continue
      selected.push(item)
    }
    return selected.reverse()
  }

  lines(options = {}) {
    return this.tail(options).map((entry) => {
      if (entry.stream === 'trace') {
        return `${entry.ts} [trace:${entry.event}] ${JSON.stringify(entry.data)}`
      }
      return `${entry.ts} [${entry.stream}] ${entry.text}`
    })
  }

  text(options = {}) {
    return this.lines(options).join('\n')
  }

  async dispose() {
    this.disposed = true
    const stream = this.stream
    this.stream = undefined
    if (stream) {
      await new Promise((resolve) => {
        stream.end(resolve)
      })
    }
  }
}
