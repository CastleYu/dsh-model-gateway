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
    const param = (name) => url.searchParams.get(name) === '1'
    const wantsTool = parsed?.tools?.length > 0 && JSON.stringify(parsed?.messages ?? []).includes('TOOL_CALL')
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const model = parsed?.model ?? 'mock-model'
    const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

    if (param('json')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'json fallback body' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      }))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const done = () => { res.write('data: [DONE]\n\n'); res.end() }

    if (param('cached_usage')) {
      send({ choices: [{ delta: { content: 'cached' } }] })
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } } })
      done()
      return
    }
    if (param('zero_usage')) {
      send({ choices: [{ delta: { content: 'zero' } }] })
      send({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
      done()
      return
    }
    if (param('sparse_usage')) {
      send({ choices: [{ delta: { content: 'sparse' } }] })
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
      send({ choices: [], usage: { completion_tokens: 25 } })
      done()
      return
    }
    if (param('usage_then_error')) {
      send({ choices: [{ delta: { content: 'partial' } }] })
      send({ choices: [], usage })
      send({ error: { message: 'upstream died' } })
      res.end()
      return
    }
    if (param('stop_with_tool')) {
      send({
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'call_stop', function: { name: parsed.tools?.[0]?.function?.name ?? 'probe', arguments: '{}' } }] },
          finish_reason: 'stop',
        }],
      })
      send({ choices: [], usage })
      done()
      return
    }
    if (param('length_then_stop')) {
      send({
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'call_len', function: { name: 'probe', arguments: '{"x":' } }] },
          finish_reason: 'length',
        }],
      })
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      send({ choices: [], usage })
      done()
      return
    }
    if (param('ping')) {
      // Longer than the 1s idle timeout used by the test: only keepalive
      // activity can prevent the false timeout.
      for (let index = 0; index < 20; index += 1) {
        res.write(': keepalive\n\n')
        await sleep(60)
      }
    }
    if (param('crlf')) {
      send({ choices: [{ delta: { content: 'crlf body' } }] })
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n')
      res.write('data: [DONE]\r\n\r\n')
      res.end()
      return
    }
    if (param('cr')) {
      // Legal SSE with lone CR line endings.
      res.write('data: {"choices":[{"delta":{"content":"cr body"}}]}\r\r')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\r')
      res.write('data: [DONE]\r\r')
      res.end()
      return
    }

    send({ choices: [{ delta: { reasoning_content: 'test reasoning' } }] })
    send({ choices: [{ delta: { content: 'hello from mock gateway' } }] })
    if (param('truncated')) {
      res.end()
      return
    }
    if (param('malformed')) {
      res.write('data: {broken-json}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (param('stream_error')) {
      // HTTP is already 200, so a mid-stream failure can only travel as an
      // in-band error event; emitting [DONE] instead would fake success.
      send({ error: { message: 'upstream disconnected', code: 'upstream' } })
      res.end()
      return
    }
    if (param('tool_length')) {
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
      send({ choices: [], usage })
      done()
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
      send({ choices: [], usage })
    } else {
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      send({ choices: [], usage })
    }
    done()
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
