// Model Context Protocol integration layer.
//
// Directive §2 (MCP): schema validation, authentication, timeouts, cancellation,
// audit events, capability restrictions and approval gates. "Do not assume every
// MCP server or tool is trustworthy. Treat all tool output as untrusted data until
// validated."
//
// Two kinds of server are supported and they are never conflated:
//   • 'in_process'  — a handler function registered in this service. Honest about
//                     being in-process; it does not claim to speak the wire protocol.
//   • 'transport'   — an external MCP server reached through a caller-supplied
//                     transport that goes through the egress guard. This build ships
//                     the contract and validation; no external server is reachable
//                     from the audit sandbox, so none is pre-registered.
//
// Every tool result is returned wrapped as {untrusted:true, …} and sanitised, so a
// downstream model prompt cannot be hijacked by text that arrived from a tool.

import { randomUUID } from 'node:crypto'
import { assertValidSchema, validateAgainstSchema } from './schema.mjs'
import { ELEVATED_SCOPES } from '../plugins/manifest.mjs'

export const SERVER_KINDS = Object.freeze({ IN_PROCESS: 'in_process', TRANSPORT: 'transport' })

/** Risk tiers drive whether a call needs an approval gate. */
export const RISK = Object.freeze({
  READ_ONLY: 'read_only', // no state change
  WRITE: 'write', // changes local state
  DESTRUCTIVE: 'destructive', // deletes/overwrites; always needs approval
  EXTERNAL: 'external', // sends data off-machine; always needs approval
  SYSTEM: 'system', // terminal/process/device; always needs approval
})

const ALWAYS_APPROVED = new Set([RISK.DESTRUCTIVE, RISK.EXTERNAL, RISK.SYSTEM])

export class McpError extends Error {
  constructor(message, { code = 'mcp_error', server = null, tool = null } = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.server = server
    this.tool = tool
  }
}

export class ApprovalRequiredError extends McpError {
  constructor(message, details = {}) {
    super(message, { code: 'approval_required', ...details })
    this.name = 'ApprovalRequiredError'
  }
}

export class McpRegistry {
  /**
   * @param {object} options
   * @param {object} [options.ledger]  audit ledger
   * @param {string[]} [options.allowedRisks] risk tiers permitted at all (default: all but SYSTEM)
   * @param {(e:object)=>void} [options.onEvent]
   * @param {number} [options.maxOutputBytes] hard cap on tool output size
   */
  constructor({ ledger = null, allowedRisks = null, onEvent = () => {}, maxOutputBytes = 256 * 1024 } = {}) {
    /** @type {Map<string, object>} */
    this.servers = new Map()
    this.ledger = ledger
    this.allowedRisks = allowedRisks ? new Set(allowedRisks) : null
    this.onEvent = onEvent
    this.maxOutputBytes = maxOutputBytes
  }

  /**
   * Register a server.
   * @param {object} spec
   * @param {string} spec.id
   * @param {string} spec.name
   * @param {'in_process'|'transport'} spec.kind
   * @param {Array} spec.tools     [{name, description, inputSchema, outputSchema?, risk, scopes?, handler?}]
   * @param {Array} [spec.resources]
   * @param {Array} [spec.prompts]
   * @param {object} [spec.auth]   {type:'none'|'bearer'|'mtls'} — never stores the secret itself
   */
  registerServer(spec) {
    if (!spec?.id || typeof spec.id !== 'string') throw new McpError('server requires an id')
    if (!Object.values(SERVER_KINDS).includes(spec.kind)) {
      throw new McpError(`server kind must be one of ${Object.values(SERVER_KINDS).join(', ')}`, { server: spec.id })
    }
    if (this.servers.has(spec.id)) throw new McpError(`server '${spec.id}' is already registered`, { server: spec.id })
    if (!Array.isArray(spec.tools)) throw new McpError(`server '${spec.id}' must declare a tools array`, { server: spec.id })

    const tools = spec.tools.map((tool) => normalizeTool(tool, spec))
    const resources = (spec.resources ?? []).map((resource) => {
      if (!resource?.uri || !resource?.name) throw new McpError(`resource on '${spec.id}' needs uri and name`, { server: spec.id })
      return { uri: String(resource.uri), name: String(resource.name), description: String(resource.description ?? ''), mimeType: resource.mimeType ?? null, handler: resource.handler ?? null }
    })
    const prompts = (spec.prompts ?? []).map((prompt) => {
      if (!prompt?.name) throw new McpError(`prompt on '${spec.id}' needs a name`, { server: spec.id })
      if (prompt.arguments) assertValidSchema({ type: 'object', properties: prompt.arguments }, `#/prompts/${prompt.name}`)
      return { name: String(prompt.name), description: String(prompt.description ?? ''), arguments: prompt.arguments ?? null, handler: prompt.handler ?? null }
    })

    const record = {
      id: spec.id,
      name: spec.name ?? spec.id,
      kind: spec.kind,
      version: spec.version ?? '0.0.0',
      // Authentication *mode* is recorded; the credential itself never lives here.
      auth: { type: spec.auth?.type ?? 'none', configured: Boolean(spec.auth?.configured) },
      endpoint: spec.endpoint ?? null,
      transport: spec.transport ?? null,
      tools,
      resources,
      prompts,
      enabled: spec.enabled !== false,
      registeredAt: Date.now(),
      calls: 0,
      failures: 0,
    }
    this.servers.set(spec.id, record)
    this.#audit('server_register', 'success', { server: spec.id, kind: spec.kind, tools: tools.length, resources: resources.length, prompts: prompts.length }, spec.id)
    return this.describeServer(spec.id)
  }

  unregisterServer(id) {
    if (!this.servers.has(id)) return false
    this.servers.delete(id)
    this.#audit('server_unregister', 'success', { server: id }, id)
    return true
  }

  setEnabled(id, enabled) {
    const server = this.#server(id)
    server.enabled = Boolean(enabled)
    this.#audit('server_toggle', 'success', { server: id, enabled: server.enabled }, id)
    return this.describeServer(id)
  }

  #server(id) {
    const server = this.servers.get(id)
    if (!server) throw new McpError(`unknown MCP server '${id}'`, { server: id, code: 'unknown_server' })
    return server
  }

  /** Existence check that does not throw, so registration can be idempotent. */
  hasServer(id) {
    return this.servers.has(id)
  }

  describeServer(id) {
    const server = this.#server(id)
    return {
      id: server.id,
      name: server.name,
      kind: server.kind,
      version: server.version,
      auth: server.auth,
      endpoint: server.endpoint,
      enabled: server.enabled,
      registeredAt: server.registeredAt,
      calls: server.calls,
      failures: server.failures,
      tools: server.tools.map((tool) => publicTool(tool)),
      resources: server.resources.map(({ handler, ...rest }) => rest),
      prompts: server.prompts.map(({ handler, ...rest }) => rest),
    }
  }

  listServers({ enabledOnly = false } = {}) {
    return [...this.servers.values()]
      .filter((server) => !enabledOnly || server.enabled)
      .map((server) => this.describeServer(server.id))
  }

  /** Capability discovery across every enabled server. */
  listTools({ serverId = null, risk = null, query = null } = {}) {
    const out = []
    for (const server of this.servers.values()) {
      if (!server.enabled) continue
      if (serverId && server.id !== serverId) continue
      for (const tool of server.tools) {
        if (risk && tool.risk !== risk) continue
        if (query && !`${tool.name} ${tool.description}`.toLowerCase().includes(String(query).toLowerCase())) continue
        out.push({ serverId: server.id, serverKind: server.kind, ...publicTool(tool) })
      }
    }
    return out
  }

  listResources({ serverId = null } = {}) {
    const out = []
    for (const server of this.servers.values()) {
      if (!server.enabled) continue
      if (serverId && server.id !== serverId) continue
      for (const resource of server.resources) out.push({ serverId: server.id, ...(({ handler, ...rest }) => rest)(resource) })
    }
    return out
  }

  listPrompts({ serverId = null } = {}) {
    const out = []
    for (const server of this.servers.values()) {
      if (!server.enabled) continue
      if (serverId && server.id !== serverId) continue
      for (const prompt of server.prompts) out.push({ serverId: server.id, ...(({ handler, ...rest }) => rest)(prompt) })
    }
    return out
  }

  /**
   * Pre-flight a call: what it needs, whether it is permitted, whether it needs
   * approval. Safe to expose to a UI before the user consents.
   */
  preflight(serverId, toolName, { approvals = [], grantedScopes = null } = {}) {
    const server = this.#server(serverId)
    const tool = server.tools.find((entry) => entry.name === toolName)
    if (!tool) return { allowed: false, reasons: [`server '${serverId}' has no tool '${toolName}'`] }
    const reasons = []
    if (!server.enabled) reasons.push(`server '${serverId}' is disabled`)
    if (this.allowedRisks && !this.allowedRisks.has(tool.risk)) reasons.push(`risk tier '${tool.risk}' is not permitted by this installation`)
    if (server.auth.type !== 'none' && !server.auth.configured) reasons.push(`server '${serverId}' requires ${server.auth.type} authentication which is not configured`)
    if (server.kind === SERVER_KINDS.TRANSPORT && typeof server.transport !== 'function') {
      reasons.push(`server '${serverId}' declares a transport but none is bound`)
    }
    if (server.kind === SERVER_KINDS.IN_PROCESS && typeof tool.handler !== 'function') {
      reasons.push(`tool '${toolName}' has no in-process handler bound`)
    }
    const missingScopes = tool.scopes.filter((scope) => grantedScopes && !grantedScopes.includes(scope))
    if (missingScopes.length) reasons.push(`installation does not grant scopes: ${missingScopes.join(', ')}`)

    const needsApproval = ALWAYS_APPROVED.has(tool.risk) && !approvals.includes(`${serverId}:${toolName}`) && !approvals.includes(tool.risk)
    const elevatedScopes = tool.scopes.filter((scope) => ELEVATED_SCOPES.includes(scope))
    const missingApprovals = elevatedScopes.filter((scope) => !approvals.includes(scope))
    if (missingApprovals.length) reasons.push(`explicit approval required for scopes: ${missingApprovals.join(', ')}`)

    return {
      allowed: reasons.length === 0 && !needsApproval,
      reasons,
      needsApproval: needsApproval || missingApprovals.length > 0,
      risk: tool.risk,
      scopes: tool.scopes,
      elevatedScopes,
      timeoutMs: tool.timeoutMs,
      serverKind: server.kind,
    }
  }

  /**
   * Call a tool.
   *
   * @param {string} serverId
   * @param {string} toolName
   * @param {object} args          validated against the tool's inputSchema before execution
   * @param {object} [options]
   * @param {string[]} [options.approvals]      granted approvals for this call
   * @param {string[]} [options.grantedScopes]
   * @param {AbortSignal} [options.signal]
   * @param {string} [options.subject]          audit subject (conversation/task id)
   */
  async callTool(serverId, toolName, args = {}, { approvals = [], grantedScopes = null, signal = null, subject = null, timeoutMs = null } = {}) {
    const server = this.#server(serverId)
    const tool = server.tools.find((entry) => entry.name === toolName)
    if (!tool) throw new McpError(`server '${serverId}' has no tool '${toolName}'`, { code: 'unknown_tool', server: serverId, tool: toolName })

    const check = this.preflight(serverId, toolName, { approvals, grantedScopes })
    if (check.needsApproval && !check.reasons.length) {
      this.#audit(`call:${toolName}`, 'denied', { server: serverId, reason: 'approval_required', risk: tool.risk }, subject ?? serverId)
      throw new ApprovalRequiredError(`tool '${serverId}:${toolName}' (risk=${tool.risk}) requires explicit approval`, {
        server: serverId,
        tool: toolName,
        risk: tool.risk,
      })
    }
    if (!check.allowed) {
      this.#audit(`call:${toolName}`, 'denied', { server: serverId, reasons: check.reasons }, subject ?? serverId)
      throw new McpError(`cannot call '${serverId}:${toolName}': ${check.reasons.join('; ')}`, { code: 'permission_denied', server: serverId, tool: toolName })
    }

    // Argument validation before execution — an untrusted caller cannot reach the
    // handler with malformed or out-of-range input.
    const inputCheck = validateAgainstSchema(args, tool.inputSchema)
    if (!inputCheck.valid) {
      this.#audit(`call:${toolName}`, 'denied', { server: serverId, reason: 'input_schema_violation', errors: inputCheck.errors }, subject ?? serverId)
      throw new McpError(`invalid arguments for '${serverId}:${toolName}': ${inputCheck.errors.join('; ')}`, { code: 'invalid_arguments', server: serverId, tool: toolName })
    }

    const callId = randomUUID()
    const startedAt = Date.now()
    const budget = Math.min(timeoutMs ?? tool.timeoutMs, tool.timeoutMs)
    server.calls += 1

    try {
      const raw = await withTimeout(
        server.kind === SERVER_KINDS.TRANSPORT
          ? server.transport({ method: 'tools/call', params: { name: toolName, arguments: inputCheck.value }, serverId, callId })
          : tool.handler(inputCheck.value, { serverId, callId, signal, risk: tool.risk, scopes: tool.scopes }),
        budget,
        `${serverId}:${toolName}`,
        signal,
      )

      // Output is untrusted. Validate against the declared schema when there is one,
      // then sanitise regardless: bound the size and neutralise control characters.
      let output = raw
      let outputValidated = false
      if (tool.outputSchema) {
        const outputCheck = validateAgainstSchema(raw, tool.outputSchema)
        if (!outputCheck.valid) {
          // NB: the catch block below owns the failure counter; do not double-count.
          this.#audit(`call:${toolName}`, 'failure', { server: serverId, callId, reason: 'output_schema_violation', errors: outputCheck.errors }, subject ?? serverId)
          throw new McpError(`tool '${serverId}:${toolName}' returned output violating its schema: ${outputCheck.errors.join('; ')}`, {
            code: 'invalid_output',
            server: serverId,
            tool: toolName,
          })
        }
        output = outputCheck.value
        outputValidated = true
      }

      const sanitised = sanitizeUntrusted(output, this.maxOutputBytes)
      const result = {
        ok: true,
        callId,
        serverId,
        serverKind: server.kind,
        tool: toolName,
        risk: tool.risk,
        // Consumers MUST treat this as data. It is never an instruction source.
        untrusted: true,
        outputValidated,
        output: sanitised.value,
        truncated: sanitised.truncated,
        durationMs: Date.now() - startedAt,
        isError: Boolean(raw && typeof raw === 'object' && raw.isError === true),
      }
      this.#audit(`call:${toolName}`, result.isError ? 'failure' : 'success', {
        server: serverId,
        callId,
        risk: tool.risk,
        durationMs: result.durationMs,
        outputBytes: sanitised.bytes,
        truncated: result.truncated,
      }, subject ?? serverId)
      this.onEvent({ type: 'mcp_call', ...result, output: undefined })
      return result
    } catch (error) {
      server.failures += 1
      if (!(error instanceof McpError)) {
        this.#audit(`call:${toolName}`, 'failure', { server: serverId, callId, error: error?.message, code: error?.code }, subject ?? serverId)
      }
      throw error
    }
  }

  /** Read a resource. Resources are untrusted content too. */
  async readResource(serverId, uri, { subject = null, signal = null } = {}) {
    const server = this.#server(serverId)
    const resource = server.resources.find((entry) => entry.uri === uri)
    if (!resource) throw new McpError(`server '${serverId}' has no resource '${uri}'`, { code: 'unknown_resource', server: serverId })
    if (!server.enabled) throw new McpError(`server '${serverId}' is disabled`, { code: 'permission_denied', server: serverId })
    if (typeof resource.handler !== 'function') {
      throw new McpError(`resource '${uri}' has no handler bound`, { code: 'not_implemented', server: serverId })
    }
    const startedAt = Date.now()
    const raw = await withTimeout(resource.handler({ uri, signal }), 30_000, `${serverId}:resource:${uri}`, signal)
    const sanitised = sanitizeUntrusted(raw, this.maxOutputBytes)
    this.#audit('resource_read', 'success', { server: serverId, uri, bytes: sanitised.bytes, durationMs: Date.now() - startedAt }, subject ?? serverId)
    return { ok: true, serverId, uri, untrusted: true, content: sanitised.value, truncated: sanitised.truncated }
  }

  /** Expand a prompt template. Arguments are schema-validated first. */
  async getPrompt(serverId, name, args = {}, { subject = null } = {}) {
    const server = this.#server(serverId)
    const prompt = server.prompts.find((entry) => entry.name === name)
    if (!prompt) throw new McpError(`server '${serverId}' has no prompt '${name}'`, { code: 'unknown_prompt', server: serverId })
    if (prompt.arguments) {
      const check = validateAgainstSchema(args, { type: 'object', properties: prompt.arguments, additionalProperties: false })
      if (!check.valid) {
        throw new McpError(`invalid arguments for prompt '${name}': ${check.errors.join('; ')}`, { code: 'invalid_arguments', server: serverId })
      }
    }
    if (typeof prompt.handler !== 'function') throw new McpError(`prompt '${name}' has no handler bound`, { code: 'not_implemented', server: serverId })
    const raw = await prompt.handler(args)
    const sanitised = sanitizeUntrusted(raw, this.maxOutputBytes)
    this.#audit('prompt_get', 'success', { server: serverId, prompt: name }, subject ?? serverId)
    return { ok: true, serverId, prompt: name, untrusted: true, messages: sanitised.value, truncated: sanitised.truncated }
  }

  #audit(action, outcome, detail, subject) {
    this.ledger?.record({ category: 'mcp', action, outcome, subject: subject ?? null, detail })
  }
}

function normalizeTool(tool, spec) {
  if (!tool?.name || typeof tool.name !== 'string') throw new McpError(`tool on '${spec.id}' needs a name`, { server: spec.id })
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(tool.name)) {
    throw new McpError(`tool name '${tool.name}' on '${spec.id}' is not a valid identifier`, { server: spec.id })
  }
  if (!tool.inputSchema) throw new McpError(`tool '${tool.name}' on '${spec.id}' must declare an inputSchema`, { server: spec.id, tool: tool.name })
  // Fail at registration, not at first call, if the schema itself is unusable.
  assertValidSchema(tool.inputSchema, `#/servers/${spec.id}/tools/${tool.name}/inputSchema`)
  if (tool.outputSchema) assertValidSchema(tool.outputSchema, `#/servers/${spec.id}/tools/${tool.name}/outputSchema`)
  if (!Object.values(RISK).includes(tool.risk)) {
    throw new McpError(`tool '${tool.name}' on '${spec.id}' must declare a risk tier (${Object.values(RISK).join(', ')})`, { server: spec.id, tool: tool.name })
  }
  const scopes = Array.isArray(tool.scopes) ? [...new Set(tool.scopes)] : []
  return {
    name: tool.name,
    description: String(tool.description ?? ''),
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    risk: tool.risk,
    scopes,
    handler: typeof tool.handler === 'function' ? tool.handler : null,
    timeoutMs: Number.isInteger(tool.timeoutMs) && tool.timeoutMs > 0 ? Math.min(tool.timeoutMs, 300_000) : 30_000,
    // Annotations advertised to callers so an approver can see intent.
    annotations: {
      readOnlyHint: tool.risk === RISK.READ_ONLY,
      destructiveHint: tool.risk === RISK.DESTRUCTIVE,
      openWorldHint: tool.risk === RISK.EXTERNAL,
    },
  }
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    risk: tool.risk,
    scopes: tool.scopes,
    timeoutMs: tool.timeoutMs,
    annotations: tool.annotations,
    requiresApproval: ALWAYS_APPROVED.has(tool.risk),
    hasHandler: typeof tool.handler === 'function',
  }
}

/**
 * Neutralise tool output before it can reach a model prompt.
 *
 * Tool results are attacker-controllable in the general case (a repository, a web
 * page, another server). This bounds their size and strips control characters so
 * they cannot forge terminal escapes or smuggle structure. It does NOT try to
 * detect "prompt injection" by keyword — that is not reliably solvable, and
 * pretending otherwise would be worse than saying so. The real defence is that
// callers treat `untrusted:true` payloads as data, and that elevated actions need
// a human approval gate.
 */
export function sanitizeUntrusted(value, maxBytes = 256 * 1024) {
  const walk = (node, depth = 0) => {
    if (depth > 16) return '[max depth exceeded]'
    if (typeof node === 'string') {
      // Remove C0/C1 control characters except \n and \t.
      const cleaned = node.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
      return cleaned
    }
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1))
    if (node && typeof node === 'object') {
      const out = {}
      for (const [key, entry] of Object.entries(node)) out[String(key).slice(0, 200)] = walk(entry, depth + 1)
      return out
    }
    if (typeof node === 'bigint') return node.toString()
    if (typeof node === 'function' || typeof node === 'symbol') return `[unserialisable ${typeof node}]`
    return node
  }

  const cleaned = walk(value)
  let serialized
  try {
    serialized = JSON.stringify(cleaned) ?? 'null'
  } catch {
    return { value: '[unserialisable output]', truncated: true, bytes: 0 }
  }
  if (serialized.length <= maxBytes) return { value: cleaned, truncated: false, bytes: serialized.length }

  // Truncate deterministically and say so, rather than silently dropping data.
  const clipped = serialized.slice(0, maxBytes)
  return { value: { _truncated: true, originalBytes: serialized.length, preview: clipped }, truncated: true, bytes: maxBytes }
}

async function withTimeout(promise, timeoutMs, label, signal) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new McpError(`tool '${label}' exceeded its ${timeoutMs}ms timeout`, { code: 'timeout' })
          reject(error)
        }, timeoutMs)
      }),
      new Promise((_, reject) => {
        if (!signal) return
        if (signal.aborted) return reject(new McpError(`tool '${label}' was cancelled`, { code: 'cancelled' }))
        signal.addEventListener('abort', () => reject(new McpError(`tool '${label}' was cancelled`, { code: 'cancelled' })), { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
