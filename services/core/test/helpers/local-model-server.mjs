// Shared test fixture: a REAL http server on loopback that speaks the Ollama
// wire protocol (/api/tags, /api/chat, /api/embed).
//
// This is a development fixture, not a model. It exists so the tests can prove
// the plumbing works end to end against a genuine local runtime over a genuine
// socket. It never appears in a production success path: with no such server
// running, readiness() reports 'degraded' and chat returns no_model_available,
// which test/offline.test.mjs asserts explicitly.

import { createServer } from 'node:http'

/** Real HTTP server on loopback speaking the Ollama /api/tags + /api/chat contract. */
async function startLocalModelServer({ models = ['tiny-local:latest'] } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw })
      const url = new URL(req.url, 'http://127.0.0.1')

      if (req.method === 'GET' && url.pathname === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({
            models: models.map((name) => ({
              name,
              model: name,
              size: 268_435_456,
              details: { family: 'llama', parameter_size: '124M', quantization_level: 'Q4_0' },
            })),
          }),
        )
      }

      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = JSON.parse(raw || '{}')
        const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null
        const reply = `local reply to: ${last?.content ?? ''}`
        const model = body.model ?? models[0]

        // Ollama streams newline-delimited JSON when stream is true.
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          for (const word of reply.split(' ')) {
            res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: `${word} ` }, done: false })}\n`)
          }
          return res.end(`${JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 9 })}\n`)
        }

        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({
            model,
            message: { role: 'assistant', content: reply },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 12,
            eval_count: 9,
            total_duration: 4_000_000,
          }),
        )
      }

      if (req.method === 'POST' && url.pathname === '/api/embed') {
        const body = JSON.parse(raw || '{}')
        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ model: body.model, embeddings: inputs.map((_, i) => [0.1 * i, 0.2, 0.3, 0.4]) }))
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export { startLocalModelServer }
