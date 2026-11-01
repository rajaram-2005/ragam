import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpRegistry, RISK } from '../src/mcp/layer.mjs'
import { PluginRegistry } from '../src/plugins/registry.mjs'
import { OnlineStore } from '../src/online/store.mjs'
import { RemoteServerManager, REMOTE_SERVER_PROTOCOLS } from '../src/online/remote-servers.mjs'

const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
const manifest = {
  manifestVersion: 1,
  id: 'example-plugin',
  name: 'Example plugin',
  version: '1.0.0',
  protocol: 'http_api',
  endpoint: 'https://plugins.example.test/ragam',
  scopes: ['service.external'],
  capabilities: [{
    name: 'echo.text',
    description: 'Echo a text value.',
    inputSchema: schema,
    outputSchema: schema,
    requiredScopes: ['service.external'],
    readOnly: true,
  }],
}

function harness(t, requestRemote) {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-remote-test-'))
  const store = new OnlineStore(dir)
  const mcp = new McpRegistry({ allowedRisks: [RISK.READ_ONLY, RISK.EXTERNAL] })
  const plugins = new PluginRegistry({ grantedScopes: ['service.external'], requireSignature: false })
  const manager = new RemoteServerManager({ dir, gateway: { requestRemote }, credentialStore: store, mcp, plugins })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, store, mcp, plugins, manager }
}

const jsonRpc = (body, result, extraHeaders = {}) => ({
  body: { jsonrpc: '2.0', id: body.id, result },
  headers: extraHeaders,
  statusCode: 200,
})

test('MCP Streamable HTTP connects, discovers external tools, gates calls, and seals credentials', async (t) => {
  const calls = []
  const fakeGateway = { async requestRemote(endpoint, options) {
    calls.push({ endpoint, ...options })
    const body = options.body
    if (body.method === 'initialize') return jsonRpc(body, { protocolVersion: REMOTE_SERVER_PROTOCOLS.mcp, serverInfo: { name: 'fixture', version: '1' } }, { 'mcp-session-id': 'session-1' })
    if (body.method === 'notifications/initialized') return { body: null, headers: {}, statusCode: 202 }
    if (body.method === 'tools/list') return jsonRpc(body, { tools: [{ name: 'echo', description: 'Echo text.', inputSchema: schema }] })
    if (body.method === 'tools/call') return jsonRpc(body, { content: [{ type: 'text', text: body.params.arguments.text }] })
    throw new Error(`unexpected method ${body.method}`)
  } }
  const h = harness(t, fakeGateway.requestRemote.bind(fakeGateway))
  const server = await h.manager.connectMcp({ id: 'example-mcp', name: 'Example MCP', endpoint: 'https://mcp.example.test/rpc', bearerToken: 'never-write-this-token', trustEndpoint: false })
  assert.equal(server.kind, 'transport')
  assert.equal(server.tools[0].risk, 'external')
  assert.equal(server.auth.configured, true)
  assert.equal(h.mcp.preflight('example-mcp', 'echo').allowed, false)
  assert.equal(h.mcp.preflight('example-mcp', 'echo', { approvals: ['external'] }).allowed, true)
  const result = await h.mcp.callTool('example-mcp', 'echo', { text: 'hello' }, { approvals: ['external'] })
  assert.equal(result.untrusted, true)
  assert.equal(result.output.content[0].text, 'hello')
  assert.ok(calls.some((call) => call.body.method === 'tools/call' && call.headers.authorization === 'Bearer never-write-this-token'))
  assert.ok(calls.every((call) => call.trustEndpoint === false))
  const persisted = readFileSync(join(h.dir, 'remote-servers.json'), 'utf8')
  assert.ok(!persisted.includes('never-write-this-token'))
  assert.equal(h.store.unseal(JSON.parse(persisted).mcp['example-mcp'].token), 'never-write-this-token')
})

test('Ragam HTTP plugin contract requires service.external approval and validates output', async (t) => {
  const operations = []
  const fakeGateway = { async requestRemote(endpoint, options) {
    operations.push(options.body)
    if (options.body.operation === 'handshake') return { protocol: REMOTE_SERVER_PROTOCOLS.plugin, ok: true, server: { name: 'fixture' } }
    return { protocol: REMOTE_SERVER_PROTOCOLS.plugin, ok: true, output: { text: options.body.input.text } }
  } }
  const h = harness(t, fakeGateway.requestRemote.bind(fakeGateway))
  const plugin = await h.manager.connectPlugin({ manifest, bearerToken: 'plugin-secret', trustEndpoint: false })
  assert.equal(plugin.userManaged, true)
  assert.equal(plugin.state, 'installed')
  assert.equal(operations[0].operation, 'handshake')
  h.plugins.enable('example-plugin')
  assert.equal(h.plugins.preflight('example-plugin', 'echo.text').allowed, false)
  const allowed = h.plugins.preflight('example-plugin', 'echo.text', { approvals: ['service.external'] })
  assert.equal(allowed.allowed, true)
  const result = await h.plugins.invoke('example-plugin', 'echo.text', { text: 'hello' }, { approvals: ['service.external'] })
  assert.equal(result.output.text, 'hello')
  assert.equal(result.untrusted, true)
  assert.equal(operations[1].protocol, REMOTE_SERVER_PROTOCOLS.plugin)
  assert.equal(operations[1].operation, 'invoke')
  assert.ok(operations[1].invocationId)
  const persisted = readFileSync(join(h.dir, 'remote-servers.json'), 'utf8')
  assert.ok(!persisted.includes('plugin-secret'))
})

test('HTTP plugins cannot acquire scopes beyond external service access', async (t) => {
  const h = harness(t, async () => ({ protocol: REMOTE_SERVER_PROTOCOLS.plugin, ok: true }))
  const unsafe = structuredClone(manifest)
  unsafe.scopes = ['service.external', 'fs.read']
  await assert.rejects(h.manager.connectPlugin({ manifest: unsafe }), { code: 'plugin_scope_denied' })
  const unsafeCapability = structuredClone(manifest)
  unsafeCapability.capabilities[0].requiredScopes = []
  await assert.rejects(h.manager.connectPlugin({ manifest: unsafeCapability }), { code: 'plugin_scope_denied' })
})

test('remote server configuration restores MCP tools and does not persist plaintext credentials', async (t) => {
  const gateway = { async requestRemote(endpoint, options) {
    const body = options.body
    if (body.method === 'initialize') return jsonRpc(body, { protocolVersion: REMOTE_SERVER_PROTOCOLS.mcp, serverInfo: { name: 'fixture', version: '1' } })
    if (body.method === 'notifications/initialized') return { body: null, headers: {}, statusCode: 202 }
    if (body.method === 'tools/list') return jsonRpc(body, { tools: [{ name: 'echo', inputSchema: schema }] })
    if (body.method === 'tools/call') return jsonRpc(body, { ok: true })
    return { protocol: REMOTE_SERVER_PROTOCOLS.plugin, ok: true }
  } }
  const h = harness(t, gateway.requestRemote.bind(gateway))
  await h.manager.connectMcp({ id: 'persisted-mcp', name: 'Persisted', endpoint: 'https://mcp.example.test', bearerToken: 'persist-secret' })
  const mcp = new McpRegistry({ allowedRisks: [RISK.READ_ONLY, RISK.EXTERNAL] })
  const plugins = new PluginRegistry({ grantedScopes: ['service.external'] })
  const restored = new RemoteServerManager({ dir: h.dir, gateway, credentialStore: h.store, mcp, plugins })
  assert.equal(mcp.describeServer('persisted-mcp').tools[0].name, 'echo')
  assert.equal(restored.isUserManagedPlugin('persisted-mcp'), false)
})
