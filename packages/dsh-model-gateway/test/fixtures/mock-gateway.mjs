// Test fixture: a tiny OpenAI-compatible gateway with controllable failure.
import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.env.PORT ?? 0)
const failFile = process.env.FAIL_FILE ?? ''
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/health') {
    if (failFile && fs.existsSync(failFile)) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pid: process.pid }))
    return
  }
  if (url.pathname === '/crash') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    setTimeout(() => process.exit(17), 40)
    return
  }
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'Mock Model' }] }))
    return
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const wantsTool = parsed?.tools?.length > 0 && JSON.stringify(parsed?.messages ?? []).includes('TOOL_CALL')
    const truncated = url.searchParams.get('truncated') === '1'
    const malformed = url.searchParams.get('malformed') === '1'
    const toolLength = url.searchParams.get('tool_length') === '1'
    const streamError = url.searchParams.get('stream_error') === '1'
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    send({ choices: [{ delta: { reasoning_content: 'test reasoning' } }] })
    send({ choices: [{ delta: { content: 'hello from mock gateway' } }] })
    if (truncated) {
      res.end()
      return
    }
    if (malformed) {
      res.write('data: {broken-json}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (streamError) {
      // HTTP is already 200, so a mid-stream failure can only travel as an
      // in-band error event; emitting [DONE] instead would fake success.
      send({ error: { message: 'upstream disconnected', code: 'upstream' } })
      res.end()
      return
    }
    if (toolLength) {
      send({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_truncated',
              function: {
                name: parsed.tools?.[0]?.function?.name ?? 'probe',
                arguments: '{"x":',
              },
            }],
          },
          finish_reason: 'length',
        }],
      })
      send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (wantsTool) {
      send({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_mock_1',
              function: { name: parsed.tools[0].function.name, arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })
      send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
    } else {
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})
server.listen(port, '127.0.0.1', () => {
  console.log(`fixture listening on ${server.address().port}`)
})
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
