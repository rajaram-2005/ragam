import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { gatewayUrl, failure } from './gateway.mjs'
import { RISK, SERVER_KINDS } from '../mcp/layer.mjs'
import { validateManifest } from '../plugins/manifest.mjs'

const MCP_PROTOCOL_VERSION = '2025-03-26'
const PLUGIN_PROTOCOL = 'ragam-plugin/1'
const SERVER_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/
const MAX_REMOTE_TOOLS = 100
const MAX_REMOTE_MANIFEST_BYTES = 256 * 1024

function safeId(value, label) {
  if (typeof value !== 'string' || !SERVER_ID.test(value)) throw failure('invalid_remote_id', `${label} must be 2–64 lowercase letters, numbers, dots, underscores or hyphens.`, 400)
  return value
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function responseError() { return failure('remote_server_error', 'The connected server returned an invalid or unsuccessful response.', 502) }

/**
 * Owner-managed connections to remote MCP Streamable HTTP servers and Ragam HTTP plugins.
 *
 * The file contains endpoint metadata and AES-GCM sealed credentials only. Remote handlers
 * are never code-loaded: MCP calls remain JSON-RPC, and HTTP plugins use the small, explicit
 * `ragam-plugin/1` request/response contract implemented below.
 */
export class RemoteServerManager {
  constructor({ dir, gateway, credentialStore, mcp, plugins, ledger = null }) {
    this.file = join(dir, 'remote-servers.json')
    this.gateway = gateway
    this.credentialStore = credentialStore
    this.mcp = mcp
    this.plugins = plugins
    this.ledger = ledger
    this.records = { schema: 1, mcp: {}, plugins: {} }
    this.#load()
  }

  #load() {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        if (raw?.schema === 1 && object(raw.mcp) && object(raw.plugins)) this.records = raw
      } catch { /* a damaged user-managed catalog is never allowed to stop the installation */ }
    }
    for (const [id, item] of Object.entries(this.records.mcp)) {
      try { this.#registerMcp(id, item) } catch { delete this.records.mcp[id] }
    }
    for (const [id, item] of Object.entries(this.records.plugins)) {
      try { this.#registerPlugin(id, item) } catch { delete this.records.plugins[id] }
    }
    this.#persist()
  }

  #persist() {
    const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.file)
  }

  #secret(item) { return item?.token ? this.credentialStore.unseal(item.token) : '' }
  #headers(item, accept = 'application/json, text/event-stream') {
    const token = this.#secret(item)
    return { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) }
  }

  #endpoint(endpoint, trustEndpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) throw failure('invalid_endpoint', 'Enter a valid server URL (maximum 2,048 characters).', 400)
    let origin = null
    try { origin = new URL(endpoint).origin } catch { throw failure('invalid_endpoint', 'Enter a valid absolute HTTP(S) server URL.', 400) }
    return gatewayUrl(endpoint, trustEndpoint ? [origin] : [])
  }

  async #mcpRpc(item, method, params = {}, { notification = false, signal = null } = {}) {
    const id = notification ? undefined : randomUUID()
    const headers = this.#headers(item)
    headers['mcp-protocol-version'] = MCP_PROTOCOL_VERSION
    if (item.sessionId) headers['mcp-session-id'] = item.sessionId
    const request = { jsonrpc: '2.0', method, ...(id ? { id } : {}), ...(params === undefined ? {} : { params }) }
    const reply = await this.gateway.requestRemote(item.endpoint, {
      method: 'POST', body: request, headers, signal, trustEndpoint: item.trustEndpoint,
      includeHeaders: true, allowEmpty: notification, maxResponseBytes: 1024 * 1024,
    })
    if (!object(reply)) throw responseError()
    const sessionId = reply.headers?.['mcp-session-id']
    if (typeof sessionId === 'string' && sessionId.length <= 512) item.sessionId = sessionId
    if (notification) return null
    const envelope = reply.body
    if (!object(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== id) throw responseError()
    if (envelope.error) throw failure('remote_server_error', 'The connected MCP server rejected the request.', 502)
    if (!Object.hasOwn(envelope, 'result')) throw responseError()
    return envelope.result
  }

  async #mcpInitialize(item) {
    const initialized = await this.#mcpRpc(item, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Ragam', version: '1.0.0' },
    })
    if (!object(initialized) || typeof initialized.protocolVersion !== 'string' || !object(initialized.serverInfo)) throw responseError()
    await this.#mcpRpc(item, 'notifications/initialized', {}, { notification: true })
  }

  async #discoverMcp(item) {
    await this.#mcpInitialize(item)
    const tools = []
    const seenCursors = new Set()
    let cursor = null
    for (let page = 0; page < 10; page += 1) {
      const listed = await this.#mcpRpc(item, 'tools/list', cursor ? { cursor } : {})
      if (!object(listed) || !Array.isArray(listed.tools)) throw responseError()
      for (const tool of listed.tools) {
        if (!object(tool) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 128
          || !object(tool.inputSchema)) throw responseError()
        const name = tool.name.trim()
        tools.push({
          name,
          description: typeof tool.description === 'string' ? tool.description.slice(0, 4000) : '',
          inputSchema: tool.inputSchema,
          outputSchema: object(tool.outputSchema) ? tool.outputSchema : null,
          risk: RISK.EXTERNAL,
          scopes: [],
          timeoutMs: 30_000,
        })
        if (tools.length > MAX_REMOTE_TOOLS) throw failure('remote_server_too_many_tools', `Remote MCP servers are limited to ${MAX_REMOTE_TOOLS} tools.`, 413)
      }
      if (listed.nextCursor == null) return tools
      if (typeof listed.nextCursor !== 'string' || !listed.nextCursor || listed.nextCursor.length > 1024 || seenCursors.has(listed.nextCursor)) throw responseError()
      seenCursors.add(listed.nextCursor)
      cursor = listed.nextCursor
    }
    throw failure('remote_server_too_many_pages', 'The MCP tool catalog exceeded ten pages.', 413)
  }

  #registerMcp(id, item) {
    if (!SERVER_ID.test(id) || typeof item?.name !== 'string' || typeof item.endpoint !== 'string'
      || !Array.isArray(item.tools) || item.tools.length > MAX_REMOTE_TOOLS) throw responseError()
    const endpoint = this.#endpoint(item.endpoint, Boolean(item.trustEndpoint))
    this.mcp.registerServer({
      id,
      name: item.name.slice(0, 100),
      kind: SERVER_KINDS.TRANSPORT,
      version: 'remote',
      endpoint,
      auth: { type: item.token ? 'bearer' : 'none', configured: true },
      enabled: item.enabled !== false,
      tools: item.tools.map((tool) => ({ ...tool, risk: RISK.EXTERNAL, scopes: [] })),
      transport: ({ method, params, signal }) => this.#callMcp(item, method, params, signal),
    })
  }

  async #callMcp(item, method, params, signal) {
    // Transport is only called for tools/call by McpRegistry. Re-negotiate after restart, which
    // also obtains a fresh session identifier from stateful MCP servers.
    if (!item.sessionReady) {
      delete item.sessionId
      await this.#mcpInitialize(item)
      item.sessionReady = true
    }
    return this.#mcpRpc(item, method, params, { signal })
  }

  async connectMcp({ id, name, endpoint, bearerToken = '', trustEndpoint = false }) {
    id = safeId(id, 'Server ID')
    if (this.records.mcp[id] || this.mcp.hasServer(id)) throw failure('remote_server_exists', `A server named '${id}' is already registered.`, 409)
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw failure('invalid_server_name', 'Enter a server name (maximum 100 characters).', 400)
    if (typeof bearerToken !== 'string' || bearerToken.length > 8192 || /[\r\n]/.test(bearerToken)) throw failure('invalid_token', 'The bearer token is invalid.', 400)
    const cleanEndpoint = this.#endpoint(endpoint, Boolean(trustEndpoint))
    const item = {
      name: name.trim(), endpoint: cleanEndpoint, trustEndpoint: Boolean(trustEndpoint), enabled: true,
      token: bearerToken ? this.credentialStore.seal(bearerToken) : null,
    }
    const tools = await this.#discoverMcp(item)
    if (!tools.length) throw failure('remote_server_empty', 'The MCP server did not advertise any tools.', 400)
    item.tools = tools.map(({ risk, scopes, timeoutMs, ...tool }) => tool)
    // Discovery's HTTP session is transient. The first live call negotiates a fresh session.
    delete item.sessionId
    delete item.sessionReady
    this.records.mcp[id] = item
    try { this.#registerMcp(id, item); this.#persist() } catch (error) { delete this.records.mcp[id]; throw error }
    this.#audit('mcp_connect', id, { endpoint: new URL(cleanEndpoint).origin, toolCount: tools.length })
    return this.mcp.describeServer(id)
  }

  isUserManagedMcp(id) { return Boolean(this.records.mcp[id]) }

  setMcpEnabled(id, enabled) {
    const item = this.records.mcp[id]
    if (!item) throw failure('remote_server_not_found', 'No user-managed MCP server has that ID.', 404)
    item.enabled = Boolean(enabled)
    const result = this.mcp.setEnabled(id, item.enabled)
    this.#persist()
    return result
  }

  async removeMcp(id) {
    if (!this.records.mcp[id]) throw failure('remote_server_not_found', 'No user-managed MCP server has that ID.', 404)
    this.mcp.unregisterServer(id)
    delete this.records.mcp[id]
    this.#persist()
    this.#audit('mcp_disconnect', id, {})
    return { removed: true, id }
  }

  #pluginManifest(raw) {
    if (!object(raw) || raw.protocol !== 'http_api') throw failure('invalid_plugin_protocol', 'User-managed HTTP plugins must use protocol "http_api".', 400)
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_REMOTE_MANIFEST_BYTES) throw failure('invalid_manifest', 'The plugin manifest is too large.', 413)
    const { manifest } = validateManifest(raw)
    // This surface authorizes only an external service call. It cannot grant filesystem,
    // terminal, credentials, device, network-local, or knowledge-write privileges.
    if (manifest.scopes.length !== 1 || manifest.scopes[0] !== 'service.external'
      || manifest.capabilities.some((cap) => !cap.requiredScopes.includes('service.external'))) {
      throw failure('plugin_scope_denied', 'Every HTTP plugin capability must declare only the service.external scope and require it explicitly.', 403)
    }
    return manifest
  }

  async #pluginRequest(item, body, signal = null) {
    const response = await this.gateway.requestRemote(item.endpoint, {
      method: 'POST', body, headers: this.#headers(item, 'application/json'),
      signal, trustEndpoint: item.trustEndpoint, maxResponseBytes: 1024 * 1024,
    })
    if (!object(response) || response.protocol !== PLUGIN_PROTOCOL || response.ok !== true) throw responseError()
    return response
  }

  #registerPlugin(id, item) {
    if (!SERVER_ID.test(id) || !object(item?.manifest) || typeof item.endpoint !== 'string') throw responseError()
    const manifest = this.#pluginManifest(item.manifest)
    const endpoint = this.#endpoint(item.endpoint, Boolean(item.trustEndpoint))
    if (manifest.id !== id || manifest.endpoint !== endpoint) throw responseError()
    const handlers = Object.fromEntries(manifest.capabilities.map((capability) => [capability.name, async (input, sandbox) => {
      const response = await this.#pluginRequest(item, {
        protocol: PLUGIN_PROTOCOL,
        operation: 'invoke',
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        capability: capability.name,
        invocationId: sandbox.invocationId,
        input,
      }, sandbox.signal)
      if (!Object.hasOwn(response, 'output')) throw responseError()
      return response.output
    }]))
    if (!this.plugins.has(id)) this.plugins.install(item.manifest, { handler: handlers })
    else this.plugins.bindHandlers(id, handlers)
    if (item.enabled === true && this.plugins.require(id).state !== 'enabled') this.plugins.enable(id)
  }

  async connectPlugin({ manifest: rawManifest, bearerToken = '', trustEndpoint = false }) {
    let manifest = this.#pluginManifest(rawManifest)
    const id = safeId(manifest.id, 'Plugin ID')
    if (this.records.plugins[id] || this.plugins.has(id)) throw failure('remote_plugin_exists', `A plugin named '${id}' is already registered.`, 409)
    if (typeof bearerToken !== 'string' || bearerToken.length > 8192 || /[\r\n]/.test(bearerToken)) throw failure('invalid_token', 'The bearer token is invalid.', 400)
    const endpoint = this.#endpoint(manifest.endpoint, Boolean(trustEndpoint))
    const storedManifest = { ...rawManifest, endpoint }
    manifest = this.#pluginManifest(storedManifest)
    const item = {
      endpoint,
      trustEndpoint: Boolean(trustEndpoint),
      enabled: false,
      token: bearerToken ? this.credentialStore.seal(bearerToken) : null,
      manifest: storedManifest,
    }
    await this.#pluginRequest(item, { protocol: PLUGIN_PROTOCOL, operation: 'handshake', pluginId: id, pluginVersion: manifest.version })
    this.records.plugins[id] = item
    try { this.#registerPlugin(id, item); this.#persist() } catch (error) { delete this.records.plugins[id]; throw error }
    this.#audit('plugin_connect', id, { endpoint: new URL(endpoint).origin, protocol: PLUGIN_PROTOCOL })
    return { ...this.plugins.get(id), userManaged: true, endpoint }
  }

  setPluginEnabled(id, enabled) {
    const item = this.records.plugins[id]
    if (!item) throw failure('remote_plugin_not_found', 'No user-managed HTTP plugin has that ID.', 404)
    item.enabled = Boolean(enabled)
    const result = item.enabled ? this.plugins.enable(id) : this.plugins.disable(id)
    this.#persist()
    return { ...result, userManaged: true, endpoint: item.endpoint }
  }

  async removePlugin(id) {
    if (!this.records.plugins[id]) throw failure('remote_plugin_not_found', 'No user-managed HTTP plugin has that ID.', 404)
    this.plugins.uninstall(id)
    delete this.records.plugins[id]
    this.#persist()
    this.#audit('plugin_disconnect', id, {})
    return { removed: true, id }
  }

  isUserManagedPlugin(id) { return Boolean(this.records.plugins[id]) }

  #audit(action, subject, detail) {
    this.ledger?.record({ category: 'remote_server', action, outcome: 'success', subject, detail })
  }
}

export const REMOTE_SERVER_PROTOCOLS = Object.freeze({ mcp: MCP_PROTOCOL_VERSION, plugin: PLUGIN_PROTOCOL })
