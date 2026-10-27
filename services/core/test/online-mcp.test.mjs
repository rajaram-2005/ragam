// Product tests for the MCP and plugin surfaces.
//
// The tools are the ones this build actually registers: an in-process documentation reader and a
// connection-status reader. Nothing here reaches a network or a vendor. What is asserted is the
// gate: who can toggle a server, what preflight says before a call, that argument validation runs
// before the handler, that output is labelled untrusted, and that a call cannot widen anything.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-mcp-test-'))
  const app = new OnlineApp({ dataDir: dir, secureCookie: true, timeoutMs: 2000 })
  const server = app.server(); const url = await listen(server)
  let cookie = ''
  const request = async (method, path, body, opts = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { cookie: opts.cookie ?? cookie, ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  const owner = { email: 'mcp-owner@example.test', password: 'a-long-mcp-password' }
  const member = { email: 'mcp-member@example.test', password: 'a-long-other-password' }
  const login = async (account = owner) => {
    let r = await request('POST', '/api/auth/register', account)
    if (r.status !== 201) r = await request('POST', '/api/auth/login', account)
    cookie = r.headers.get('set-cookie').split(';')[0]
    return r
  }
  t.after(async () => { await close(server); app.close(); rmSync(dir, { recursive: true, force: true }) })
  return { request, login, owner, member, app }
}

test('the installation exposes its reviewed in-process servers and read-only tools', async (t) => {
  const f = await fixture(t); await f.login()
  const servers = await f.request('GET', '/api/mcp/servers')
  assert.equal(servers.status, 200)
  assert.deepEqual(servers.data.servers.map((server) => server.id).sort(), ['aetheris.online', 'installation-docs'])
  for (const server of servers.data.servers) {
    assert.equal(server.kind, 'in_process')
    assert.ok(server.enabled)
  }

  const tools = await f.request('GET', '/api/mcp/tools')
  assert.equal(tools.status, 200)
  const names = tools.data.tools.map((tool) => tool.name)
  assert.ok(names.includes('list-documents'))
  assert.ok(names.includes('read-document'))
  assert.ok(names.includes('connection.status'))
  for (const tool of tools.data.tools) assert.equal(tool.risk, 'read_only', `${tool.name} must be read-only`)

  // A member can read the catalogue; only the owner can change whether a server is enabled.
  await f.login(f.member)
  assert.equal((await f.request('GET', '/api/mcp/tools')).status, 200)
})

test('preflight states the gate before a call and names an unknown tool', async (t) => {
  const f = await fixture(t); await f.login()
  const allowed = await f.request('POST', '/api/mcp/preflight', { server: 'installation-docs', tool: 'read-document' })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.data.allowed, true)
  assert.equal(allowed.data.risk, 'read_only')
  assert.equal(allowed.data.needsApproval, false)

  const unknown = await f.request('POST', '/api/mcp/preflight', { server: 'installation-docs', tool: 'nope' })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.data.allowed, false)
  assert.match(unknown.data.reasons.join(' '), /no tool 'nope'/)
})

test('a tool call validates arguments and returns untrusted data, never permissions', async (t) => {
  const f = await fixture(t); await f.login()
  const listed = await f.request('POST', '/api/mcp/call', { server: 'installation-docs', tool: 'list-documents', arguments: {} })
  assert.equal(listed.status, 200, JSON.stringify(listed.data))
  assert.equal(listed.data.untrusted, true)
  assert.equal(listed.data.risk, 'read_only')
  assert.ok(listed.data.output.documents.some((doc) => doc.name === '03-status.md'))

  const read = await f.request('POST', '/api/mcp/call', { server: 'installation-docs', tool: 'read-document', arguments: { name: '03-status.md' } })
  assert.equal(read.status, 200)
  assert.match(read.data.output.text, /Test totals/)
  assert.ok(read.data.output.text.length <= 20_000, 'the read is bounded')
  assert.equal(read.data.output.truncated, true, 'the status document is larger than the bound')

  // A path is not a document name. Both the schema and the handler refuse it.
  const traversal = await f.request('POST', '/api/mcp/call', { server: 'installation-docs', tool: 'read-document', arguments: { name: '../package.json' } })
  assert.equal(traversal.status, 400)

  const missing = await f.request('POST', '/api/mcp/call', { server: 'installation-docs', tool: 'read-document', arguments: { name: 'no-such-doc.md' } })
  assert.equal(missing.status, 400)
  assert.match(missing.data.message, /No such document/)

  // The tool result carries no authority: it is not a route, a scope or a setting.
  assert.equal(read.data.untrusted, true)
  assert.equal(read.data.provenance.untrusted, true)
})

test('only the owner can disable a server, and a disabled server is refused', async (t) => {
  const f = await fixture(t); await f.login()
  await f.login(f.member)
  const denied = await f.request('POST', '/api/mcp/servers/installation-docs/toggle', { enabled: false })
  assert.equal(denied.status, 403)
  assert.equal(denied.data.error, 'owner_required')

  await f.login()
  const disabled = await f.request('POST', '/api/mcp/servers/installation-docs/toggle', { enabled: false })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.data.enabled, false)
  const tools = await f.request('GET', '/api/mcp/tools')
  assert.ok(!tools.data.tools.some((tool) => tool.serverId === 'installation-docs'))
  const refused = await f.request('POST', '/api/mcp/call', { server: 'installation-docs', tool: 'list-documents', arguments: {} })
  assert.equal(refused.status, 400)
  assert.match(refused.data.message, /disabled/)

  await f.request('POST', '/api/mcp/servers/installation-docs/toggle', { enabled: true })
  assert.ok((await f.request('GET', '/api/mcp/tools')).data.tools.some((tool) => tool.serverId === 'installation-docs'))
})

test('the plugin surface lists the reviewed built-in and installs nothing custom', async (t) => {
  const f = await fixture(t); await f.login()
  const listed = await f.request('GET', '/api/plugins')
  assert.equal(listed.status, 200)
  assert.ok(listed.data.plugins.length >= 1)
  const plugin = listed.data.plugins.find((entry) => entry.id === 'aetheris.online-status')
  assert.ok(plugin, 'the reviewed connection-status plugin is installed')
  assert.equal(plugin.protocol, 'local_tool')

  const preflight = await f.request('POST', '/api/plugins/aetheris.online-status/preflight', { capability: 'status' })
  assert.equal(preflight.status, 200)
  assert.equal(preflight.data.allowed, true)

  const result = await f.request('POST', '/api/plugins/aetheris.online-status/invoke', { capability: 'status', input: {} })
  assert.equal(result.status, 200)
  assert.equal(result.data.ok, true)
  assert.ok(result.data.output, 'the status capability returns the readiness record')

  const install = await f.request('POST', '/api/plugins/install', { manifestVersion: 1 })
  assert.equal(install.status, 403)
  assert.equal(install.data.error, 'extension_installation_disabled')
})

test('a member can run read-only plugin tools; state changes and writing tools stay owner-only', async (t) => {
  const f = await fixture(t); await f.login()
  // A writing capability, installed the same way the app installs its
  // built-in, so the member boundary has something real to refuse.
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  f.app.plugins.install({
    manifestVersion: 1, id: 'aetheris.test-writer', name: 'Test writer', version: '1.0.0',
    protocol: 'local_tool', builtin: true, author: 'Aetheris', license: 'MIT', scopes: [],
    description: 'Test-only writing capability.',
    capabilities: [{ name: 'write', description: 'Pretend to write.', readOnly: false, inputSchema: schema }],
  }, { handler: { write: () => ({ wrote: true }) } })
  f.app.plugins.enable('aetheris.test-writer')

  await f.login(f.member)
  // Read-only preflight + invoke: the Plugins page offers these to every
  // signed-in account, and they cannot mutate state (regression: the route
  // used to refuse members outright with owner_required).
  const preflight = await f.request('POST', '/api/plugins/aetheris.online-status/preflight', { capability: 'status' })
  assert.equal(preflight.status, 200)
  assert.equal(preflight.data.allowed, true)
  assert.equal(preflight.data.readOnly, true)
  const invoked = await f.request('POST', '/api/plugins/aetheris.online-status/invoke', { capability: 'status', input: {} })
  assert.equal(invoked.status, 200)
  assert.equal(invoked.data.ok, true)

  // A capability that is not read-only stays owner-only for members.
  const writing = await f.request('POST', '/api/plugins/aetheris.test-writer/invoke', { capability: 'write', input: {} })
  assert.equal(writing.status, 403)
  assert.equal(writing.data.error, 'owner_required')

  // Changing what is runnable stays owner-only too.
  const disable = await f.request('POST', '/api/plugins/aetheris.online-status/disable', {})
  assert.equal(disable.status, 403)
  assert.equal(disable.data.error, 'owner_required')

  // Naming a plugin that does not exist is a client error, not a 500.
  const missing = await f.request('POST', '/api/plugins/no-such-plugin/preflight', { capability: 'status' })
  assert.equal(missing.status, 404)
  assert.equal(missing.data.error, 'unknown_plugin')

  // The owner can still do all of it.
  await f.login()
  const ownerWrite = await f.request('POST', '/api/plugins/aetheris.test-writer/invoke', { capability: 'write', input: {} })
  assert.equal(ownerWrite.status, 200)
  assert.equal(ownerWrite.data.ok, true)
})
