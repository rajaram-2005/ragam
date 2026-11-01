import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
const inputSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
const pluginManifest = {
  manifestVersion: 1, id: 'test-plugin', name: 'Test plugin', version: '1.0.0', protocol: 'http_api',
  endpoint: 'https://plugins.example.test/ragam', scopes: ['service.external'],
  capabilities: [{ name: 'echo.text', description: 'Echo a text.', inputSchema, outputSchema: inputSchema, requiredScopes: ['service.external'], readOnly: true }],
}

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-remote-routes-'))
  const app = new OnlineApp({ dataDir: dir, secureCookie: true, timeoutMs: 2000 })
  const server = app.server(); const origin = await listen(server)
  let cookie = ''
  const request = async (method, path, body, opts = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { cookie: opts.cookie ?? cookie, ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    if (opts.captureCookie) cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    return { status: response.status, data }
  }
  const login = async (email = 'owner@example.test', password = 'correct horse battery staple') => {
    const result = await request('POST', '/api/auth/login', { email, password }, { captureCookie: true })
    assert.equal(result.status, 200, JSON.stringify(result.data))
  }
  const owner = await request('POST', '/api/auth/register', { email: 'owner@example.test', password: 'correct horse battery staple' })
  assert.equal(owner.status, 201)
  const member = await request('POST', '/api/auth/register', { email: 'member@example.test', password: 'correct horse battery staple' })
  assert.equal(member.status, 201)
  t.after(async () => { await close(server); app.close(); rmSync(dir, { recursive: true, force: true }) })
  return { app, request, login, member }
}

test('owner can connect MCP and Ragam HTTP plugin servers; every remote invocation needs explicit approval', async (t) => {
  const f = await fixture(t)
  await f.login()
  f.app.gateway.requestRemote = async (_endpoint, options) => {
    const body = options.body
    if (body.method === 'initialize') return { body: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' } } }, headers: { 'mcp-session-id': 'session-1' }, statusCode: 200 }
    if (body.method === 'notifications/initialized') return { body: null, headers: {}, statusCode: 202 }
    if (body.method === 'tools/list') return { body: { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', description: 'Echo input.', inputSchema }] } }, headers: {}, statusCode: 200 }
    if (body.method === 'tools/call') return { body: { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: body.params.arguments.text }] } }, headers: {}, statusCode: 200 }
    if (body.protocol === 'ragam-plugin/1' && body.operation === 'handshake') return { protocol: 'ragam-plugin/1', ok: true }
    if (body.protocol === 'ragam-plugin/1' && body.operation === 'invoke') return { protocol: 'ragam-plugin/1', ok: true, output: { text: body.input.text } }
    throw new Error(`unexpected remote request ${JSON.stringify(body)}`)
  }

  const mcp = await f.request('POST', '/api/mcp/servers/connect', { id: 'route-mcp', name: 'Route MCP', endpoint: 'https://mcp.example.test/rpc', trustEndpoint: true })
  assert.equal(mcp.status, 201, JSON.stringify(mcp.data))
  assert.equal(mcp.data.tools[0].risk, 'external')
  const preflight = await f.request('POST', '/api/mcp/preflight', { server: 'route-mcp', tool: 'echo' })
  assert.equal(preflight.data.allowed, false)
  assert.equal(preflight.data.needsApproval, true)
  const call = await f.request('POST', '/api/mcp/call', { server: 'route-mcp', tool: 'echo', arguments: { text: 'approved' }, approvals: ['external'] })
  assert.equal(call.status, 200, JSON.stringify(call.data))
  assert.equal(call.data.output.content[0].text, 'approved')

  const plugin = await f.request('POST', '/api/plugins/connect', { manifest: pluginManifest, trustEndpoint: true })
  assert.equal(plugin.status, 201, JSON.stringify(plugin.data))
  assert.equal(plugin.data.userManaged, true)
  const enabled = await f.request('POST', '/api/plugins/test-plugin/enable', {})
  assert.equal(enabled.status, 200)
  const pluginGate = await f.request('POST', '/api/plugins/test-plugin/preflight', { capability: 'echo.text' })
  assert.equal(pluginGate.data.allowed, false)
  const pluginCall = await f.request('POST', '/api/plugins/test-plugin/invoke', { capability: 'echo.text', input: { text: 'approved' }, approvals: ['service.external'] })
  assert.equal(pluginCall.status, 200, JSON.stringify(pluginCall.data))
  assert.equal(pluginCall.data.output.text, 'approved')
})

test('only the installation owner can connect or disconnect remote servers', async (t) => {
  const f = await fixture(t)
  await f.login('member@example.test')
  assert.equal((await f.request('POST', '/api/mcp/servers/connect', {})).status, 403)
  assert.equal((await f.request('POST', '/api/plugins/connect', {})).status, 403)
  await f.login()
  const missingMcp = await f.request('DELETE', '/api/mcp/servers/not-managed', {})
  assert.equal(missingMcp.status, 404, JSON.stringify(missingMcp.data))
  const missingPlugin = await f.request('POST', '/api/plugins/not-managed/uninstall', {})
  assert.equal(missingPlugin.status, 404, JSON.stringify(missingPlugin.data))
})
