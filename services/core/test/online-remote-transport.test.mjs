import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OnlineGateway } from '../src/online/gateway.mjs'

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

test('remote endpoint transport reuses exact-origin trust, parses MCP SSE, and does not follow redirects', async (t) => {
  let received = 0
  const server = createServer(async (request, response) => {
    received += 1
    const body = await readJson(request)
    if (request.url === '/sse') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-mcp-session-id': 'session-a' })
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } })}\n\n`)
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/elsewhere' }); response.end(); return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'x-mcp-session-id': 'session-a' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }))
  })
  const origin = await listen(server)
  t.after(() => close(server))
  const gateway = new OnlineGateway({ timeoutMs: 1000 })
  const request = { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, includeHeaders: true }

  await assert.rejects(gateway.requestRemote(`${origin}/mcp`, request), { code: 'endpoint_blocked' })
  const json = await gateway.requestRemote(`${origin}/mcp`, { ...request, trustEndpoint: true })
  assert.equal(json.body.result.ok, true)
  assert.equal(json.headers['x-mcp-session-id'], 'session-a')
  const sse = await gateway.requestRemote(`${origin}/sse`, { ...request, trustEndpoint: true })
  assert.equal(sse.body.result.ok, true)
  assert.equal(sse.headers['x-mcp-session-id'], 'session-a')

  await assert.rejects(gateway.requestRemote(`${origin}/redirect`, { ...request, trustEndpoint: true }), { code: 'provider_request_rejected' })
  assert.equal(received, 3, 'the redirect target was not requested')
})
