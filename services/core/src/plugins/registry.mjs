// Plugin registry: lifecycle, permission enforcement and audit.
//
// Directive §10: "Require additional authorization for destructive operations,
// external data transfer, production deployment, credential access" and "Treat
// repository contents, documents, web pages, model outputs and tool results as
// untrusted inputs."
//
// Enforcement model:
//   • A capability runs only if every scope it requires is both *declared in the
//     validated manifest* and *granted to this installation*.
//   • Elevated scopes need an approval, either a standing grant or a per-call one.
//   • Handlers are sandboxed by contract: they receive a capability-limited context
//     object, never the process, and their return value is schema-checked and
//     marked untrusted before it can influence anything else.

import { randomUUID } from 'node:crypto'
import { validateManifest, compareSemver, ELEVATED_SCOPES, SCOPES, PROTOCOLS, ManifestError } from './manifest.mjs'
import { validateAgainstSchema } from '../mcp/schema.mjs'
import { PluginSignatureError, SIGNATURE_STATE, canonicalJson, verifyManifest } from './signing.mjs'
import { TRUST, provenanceOf } from '../mcp/authority.mjs'
import { withTimeout } from '../shared/timeout.mjs'

export const PLUGIN_STATES = Object.freeze({
  DISCOVERED: 'discovered',
  INSTALLED: 'installed',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  UNINSTALLED: 'uninstalled',
})

export class PluginPermissionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PluginPermissionError'
    this.code = 'plugin_permission_denied'
    Object.assign(this, details)
  }
}

export class PluginApprovalRequiredError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PluginApprovalRequiredError'
    this.code = 'approval_required'
    Object.assign(this, details)
  }
}

export class PluginRegistry {
  /**
   * @param {object} options
   * @param {object} [options.ledger]      audit ledger
   * @param {string[]} [options.grantedScopes] scopes this installation permits at all
   * @param {string[]} [options.standingApprovals] elevated scopes pre-approved by the operator
   * @param {(e:object)=>void} [options.onEvent]
   * @param {object} [options.trustStore]    public keys this host has chosen to trust
   * @param {boolean} [options.requireSignature] refuse unsigned manifests outright
   */
  constructor({ ledger = null, grantedScopes = null, standingApprovals = [], onEvent = () => {}, trustStore = null, requireSignature = false } = {}) {
    /** @type {Map<string, object>} */
    this.plugins = new Map()
    /** @type {Map<string, Function>} capability key -> handler */
    this.handlers = new Map()
    this.ledger = ledger
    this.standingApprovals = new Set(standingApprovals)
    // null means "all declared scopes are grantable"; an array restricts them.
    this.grantedScopes = grantedScopes ? new Set(grantedScopes) : null
    this.onEvent = onEvent
    this.trustStore = trustStore
    this.requireSignature = requireSignature
  }

  // --- discovery & installation -------------------------------------------

  /** Validate a manifest without installing it (§2 capability discovery). */
  discover(manifest) {
    const { manifest: normalized } = validateManifest(manifest)
    const known = this.plugins.get(normalized.id)
    return {
      ...normalized,
      alreadyInstalled: Boolean(known),
      installedVersion: known?.version ?? null,
      updateAvailable: known ? compareSemver(normalized.version, known.version) > 0 : false,
      downgradeAttempt: known ? compareSemver(normalized.version, known.version) < 0 : false,
      requiresApproval: normalized.elevated.length > 0,
      ungrantableScopes: this.#ungrantable(normalized.scopes),
      // Reported before anything is installed, so a person can see what they are about to
      // trust rather than discovering it afterwards.
      signature: this.#signatureView(manifest),
      signatureRequired: this.requireSignature,
    }
  }

  /**
   * The signature state of a manifest **as presented**, plus what this installation would
   * do about it.
   *
   * Presented, not normalised: `validateManifest` fills in defaults and stamps
   * `validatedAt: Date.now()`, so a digest over its output changes on every call and could
   * never match anything a publisher signed. The signature covers the bytes as they were
   * distributed, which is also what makes the publisher's job one line of documentation.
   */
  #signatureView(manifest) {
    const result = verifyManifest(manifest, { trustStore: this.trustStore })
    return {
      state: result.state,
      keyId: result.keyId,
      reason: result.reason ?? null,
      digest: result.digest,
      accepted: this.#signatureAcceptable(result.state),
    }
  }

  /**
   * Is the manifest a capability would run from the normalisation of the bytes that were
   * signed?
   *
   * The signature covers what was presented; the record normalises that into the form the
   * rest of the class reads `scopes` and `capabilities` from. Those two have to stay tied
   * together, or a later edit to the normalised copy -- the one that decides which scopes a
   * capability needs -- would run with the signature untouched.
   */
  #behaviourMatchesSignature(record) {
    const renormalised = validateManifest(structuredClone(record.signedManifest)).manifest
    const strip = ({ validatedAt, ...rest }) => rest
    try {
      return canonicalJson(strip(renormalised)) === canonicalJson(strip(record.manifest))
    } catch {
      return false
    }
  }

  #signatureAcceptable(state) {
    if (state === SIGNATURE_STATE.VERIFIED) return true
    if (state === SIGNATURE_STATE.UNSIGNED) return !this.requireSignature
    return false
  }

  #ungrantable(scopes) {
    if (!this.grantedScopes) return []
    return scopes.filter((scope) => !this.grantedScopes.has(scope))
  }

  /**
   * Install a plugin. Refuses manifests that fail validation, that request scopes
   * this installation will never grant, or that attempt a silent downgrade.
   */
  install(manifest, { handler = null, allowDowngrade = false } = {}) {
    const { manifest: normalized } = validateManifest(manifest)
    // A private copy of what was presented. It is what gets verified, what the digest is
    // taken over, and what the normalised form above is checked back against before a
    // capability runs.
    const signedManifest = structuredClone(manifest)
    const signature = this.#signatureView(signedManifest)
    if (!signature.accepted) {
      this.#audit('install', 'denied', {
        pluginId: normalized.id, version: normalized.version, reason: 'signature', signature,
      }, normalized.id)
      throw new PluginSignatureError(
        signature.reason
          ?? `plugin '${normalized.id}' is ${signature.state} and this host requires a trusted signature`,
        {
          pluginId: normalized.id,
          signatureState: signature.state,
          keyId: signature.keyId,
          signatureRequired: this.requireSignature,
          // A malformed block is a bad request; an untrusted key or a missing signature is
          // this host refusing to install. Two different answers, so two statuses.
          status: signature.state === SIGNATURE_STATE.MALFORMED ? 400 : 403,
        },
      )
    }
    const ungrantable = this.#ungrantable(normalized.scopes)
    if (ungrantable.length) {
      this.#audit('install', 'denied', { pluginId: normalized.id, version: normalized.version, ungrantable }, normalized.id)
      throw new PluginPermissionError(`plugin '${normalized.id}' requests scopes this installation does not grant: ${ungrantable.join(', ')}`, {
        pluginId: normalized.id,
        ungrantable,
      })
    }

    const existing = this.plugins.get(normalized.id)
    if (existing) {
      const comparison = compareSemver(normalized.version, existing.version)
      if (comparison < 0 && !allowDowngrade) {
        this.#audit('install', 'denied', { pluginId: normalized.id, from: existing.version, to: normalized.version, reason: 'downgrade' }, normalized.id)
        throw new PluginPermissionError(
          `refusing to downgrade '${normalized.id}' from ${existing.version} to ${normalized.version}; pass allowDowngrade to override`,
          { pluginId: normalized.id, from: existing.version, to: normalized.version },
        )
      }
      if (comparison === 0 && existing.state !== PLUGIN_STATES.UNINSTALLED) {
        return { ...this.publicView(existing), reinstalled: false, note: 'same version already installed' }
      }
    }

    const record = {
      id: normalized.id,
      version: normalized.version,
      manifest: normalized,
      // Pinned at install: the state that was accepted, the key that signed it, and the
      // digest of the bytes that were signed.
      signature,
      signedManifest,
      state: PLUGIN_STATES.INSTALLED,
      installedAt: Date.now(),
      updatedAt: existing ? Date.now() : null,
      previousVersion: existing?.version ?? null,
      invocations: 0,
      failures: 0,
      lastInvokedAt: null,
      history: [
        {
          at: Date.now(),
          event: existing ? 'updated' : 'installed',
          from: existing?.version ?? null,
          to: normalized.version,
        },
      ],
    }
    this.plugins.set(normalized.id, record)
    if (handler) this.bindHandlers(normalized.id, handler)
    this.#audit(existing ? 'update' : 'install', 'success', { pluginId: normalized.id, version: normalized.version, protocol: normalized.protocol, scopes: normalized.scopes }, normalized.id)
    this.onEvent({ type: existing ? 'plugin_updated' : 'plugin_installed', pluginId: normalized.id, version: normalized.version })
    return { ...this.publicView(record), reinstalled: true }
  }

  /**
   * Bind an implementation. `handler` is either a function (for a single-capability
   * local_tool) or a map of capability name → function.
   */
  bindHandlers(pluginId, handler) {
    const record = this.require(pluginId)
    if (typeof handler === 'function') {
      for (const capability of record.manifest.capabilities) {
        this.handlers.set(`${pluginId}:${capability.name}`, handler)
      }
      return Object.keys(this.#handlerNames(pluginId))
    }
    if (handler && typeof handler === 'object') {
      const declared = new Set(record.manifest.capabilities.map((capability) => capability.name))
      for (const [name, fn] of Object.entries(handler)) {
        if (!declared.has(name)) {
          throw new PluginPermissionError(`plugin '${pluginId}' tried to bind undeclared capability '${name}'`, { pluginId, capability: name })
        }
        if (typeof fn !== 'function') throw new TypeError(`handler for '${name}' must be a function`)
        this.handlers.set(`${pluginId}:${name}`, fn)
      }
      return Object.keys(handler)
    }
    throw new TypeError('bindHandlers requires a function or an object map of handlers')
  }

  #handlerNames(pluginId) {
    const out = {}
    for (const key of this.handlers.keys()) if (key.startsWith(`${pluginId}:`)) out[key.slice(pluginId.length + 1)] = true
    return out
  }

  enable(pluginId) {
    return this.#setState(pluginId, PLUGIN_STATES.ENABLED, 'enable')
  }

  disable(pluginId) {
    return this.#setState(pluginId, PLUGIN_STATES.DISABLED, 'disable')
  }

  /**
   * Uninstall. Builtin plugins cannot be removed (§2: "built-in plugins cannot be
   * removed"), and uninstalling drops every bound handler so a removed plugin can
   * never be invoked again.
   */
  uninstall(pluginId) {
    const record = this.require(pluginId)
    if (record.manifest.builtin) {
      this.#audit('uninstall', 'denied', { pluginId, reason: 'builtin' }, pluginId)
      throw new PluginPermissionError(`plugin '${pluginId}' is builtin and cannot be uninstalled`, { pluginId })
    }
    record.state = PLUGIN_STATES.UNINSTALLED
    record.history.push({ at: Date.now(), event: 'uninstalled', from: record.version })
    for (const key of [...this.handlers.keys()]) if (key.startsWith(`${pluginId}:`)) this.handlers.delete(key)
    this.#audit('uninstall', 'success', { pluginId, version: record.version }, pluginId)
    this.onEvent({ type: 'plugin_uninstalled', pluginId })
    return this.publicView(record)
  }

  #setState(pluginId, state, event) {
    const record = this.require(pluginId)
    if (record.state === PLUGIN_STATES.UNINSTALLED) {
      throw new PluginPermissionError(`plugin '${pluginId}' is uninstalled`, { pluginId })
    }
    record.state = state
    record.history.push({ at: Date.now(), event, to: record.version })
    this.#audit(event, 'success', { pluginId, version: record.version }, pluginId)
    this.onEvent({ type: `plugin_${event}d`, pluginId })
    return this.publicView(record)
  }

  /**
   * Existence check that does not throw. `require`/`get` are for callers that expect
   * the plugin to be there; registration paths need a plain boolean so they can be
   * idempotent instead of failing on a second call.
   */
  has(pluginId) {
    return this.plugins.has(pluginId)
  }

  require(pluginId) {
    const record = this.plugins.get(pluginId)
    if (!record) throw new Error(`unknown plugin '${pluginId}'`)
    return record
  }

  get(pluginId) {
    return this.publicView(this.require(pluginId))
  }

  list({ state = null, protocol = null } = {}) {
    return [...this.plugins.values()]
      .filter((record) => (!state || record.state === state) && (!protocol || record.manifest.protocol === protocol))
      .map((record) => this.publicView(record))
  }

  /** Capability discovery across all enabled plugins (§2). */
  capabilities({ pluginId = null } = {}) {
    const out = []
    for (const record of this.plugins.values()) {
      if (pluginId && record.id !== pluginId) continue
      if (record.state !== PLUGIN_STATES.ENABLED) continue
      for (const capability of record.manifest.capabilities) {
        out.push({
          pluginId: record.id,
          version: record.version,
          protocol: record.manifest.protocol,
          name: capability.name,
          description: capability.description,
          inputSchema: capability.inputSchema,
          requiredScopes: capability.requiredScopes,
          readOnly: capability.readOnly,
          bound: this.handlers.has(`${record.id}:${capability.name}`),
        })
      }
    }
    return out
  }

  // --- invocation with enforcement ----------------------------------------

  /**
   * Dry-run permission check without executing. Used by approval UIs so a user can
   * see exactly what a call would touch before consenting.
   */
  preflight(pluginId, capabilityName, { approvals = [] } = {}) {
    const record = this.require(pluginId)
    const capability = record.manifest.capabilities.find((entry) => entry.name === capabilityName)
    if (!capability) {
      // Same shape as every other preflight result, so callers never have to
      // special-case the "unknown capability" path.
      return {
        allowed: false,
        reasons: [`plugin '${pluginId}' does not declare capability '${capabilityName}'`],
        needsApproval: [],
        requiredScopes: [],
        elevated: [],
        timeoutMs: null,
        readOnly: false,
      }
    }
    const reasons = []
    if (record.state !== PLUGIN_STATES.ENABLED) reasons.push(`plugin state is '${record.state}', must be 'enabled'`)
    if (record.manifest.protocol === PROTOCOLS.LOCAL_TOOL && !this.handlers.has(`${pluginId}:${capabilityName}`)) {
      reasons.push('no handler is bound for this capability')
    }
    const missing = capability.requiredScopes.filter((scope) => !record.manifest.scopes.includes(scope))
    if (missing.length) reasons.push(`manifest does not declare required scopes: ${missing.join(', ')}`)
    const ungrantable = this.#ungrantable(capability.requiredScopes)
    if (ungrantable.length) reasons.push(`installation does not grant scopes: ${ungrantable.join(', ')}`)

    const granted = new Set(approvals)
    for (const scope of this.standingApprovals) granted.add(scope)
    const needsApproval = capability.requiredScopes.filter((scope) => ELEVATED_SCOPES.includes(scope) && !granted.has(scope))
    if (needsApproval.length) reasons.push(`explicit approval required for: ${needsApproval.join(', ')}`)

    return {
      allowed: reasons.length === 0,
      reasons,
      needsApproval,
      requiredScopes: capability.requiredScopes,
      elevated: capability.requiredScopes.filter((scope) => ELEVATED_SCOPES.includes(scope)),
      timeoutMs: capability.timeoutMs,
      readOnly: capability.readOnly,
    }
  }

  /**
   * Invoke a capability.
   *
   * @param {string} pluginId
   * @param {string} capabilityName
   * @param {object} input        validated against the declared inputSchema
   * @param {object} [options]
   * @param {string[]} [options.approvals] per-call approvals for elevated scopes
   * @param {AbortSignal} [options.signal]
   * @param {object} [options.context]  extra read-only context handed to the handler
   */
  async invoke(pluginId, capabilityName, input = {}, { approvals = [], signal = null, context = {}, subject = null } = {}) {
    const check = this.preflight(pluginId, capabilityName, { approvals })
    const record = this.require(pluginId)
    const capability = record.manifest.capabilities.find((entry) => entry.name === capabilityName)

    // Re-verified here, not only at install: the installed record is an object in this
    // process, and "it was signed when we installed it" is a weaker statement than "the
    // manifest this capability is running from is the one that was signed".
    const current = this.#signatureView(record.signedManifest)
    // Which of the three failed is worth saying: "the signature is gone", "the signed bytes
    // were replaced" and "the manifest the capability would read was edited" are three
    // different incidents with three different responses.
    const signatureCheck = !current.accepted
      ? 'signature'
      : current.digest !== record.signature.digest ? 'digest' : 'behaviour'
    if (signatureCheck !== 'behaviour' || !this.#behaviourMatchesSignature(record)) {
      this.#audit(`invoke:${capabilityName}`, 'denied', {
        pluginId,
        reason: 'signature_changed_since_install',
        check: signatureCheck,
        installed: record.signature.digest,
        current: current.digest,
        signatureState: current.state,
      }, subject ?? pluginId)
      throw new PluginSignatureError(
        `refusing to run '${pluginId}:${capabilityName}': the manifest no longer matches the one that was signed and installed (${signatureCheck})`,
        { pluginId, capability: capabilityName, check: signatureCheck, installedDigest: record.signature.digest, currentDigest: current.digest, signatureState: current.state },
      )
    }

    if (!check.allowed) {
      const needsApproval = check.needsApproval ?? []
      const outcome = needsApproval.length && !check.reasons.some((reason) => !/approval required/.test(reason)) ? 'approval_required' : 'denied'
      this.#audit(`invoke:${capabilityName}`, 'denied', { pluginId, reasons: check.reasons, input: summarize(input) }, subject ?? pluginId)
      if (outcome === 'approval_required') {
        throw new PluginApprovalRequiredError(`capability '${capabilityName}' needs approval for: ${needsApproval.join(', ')}`, {
          pluginId,
          capability: capabilityName,
          needsApproval,
        })
      }
      throw new PluginPermissionError(`cannot invoke '${pluginId}:${capabilityName}': ${check.reasons.join('; ')}`, { pluginId, capability: capabilityName, reasons: check.reasons })
    }

    // Argument validation happens BEFORE any handler code runs.
    const schemaResult = validateAgainstSchema(input, capability.inputSchema)
    if (!schemaResult.valid) {
      this.#audit(`invoke:${capabilityName}`, 'denied', { pluginId, reason: 'input_schema_violation', errors: schemaResult.errors }, subject ?? pluginId)
      throw new PluginPermissionError(`invalid arguments for '${pluginId}:${capabilityName}': ${schemaResult.errors.join('; ')}`, {
        pluginId,
        capability: capabilityName,
        schemaErrors: schemaResult.errors,
      })
    }

    const handler = this.handlers.get(`${pluginId}:${capabilityName}`)
    const startedAt = Date.now()
    const invocationId = randomUUID()

    // The handler receives a capability-limited context, not the process.
    const sandbox = Object.freeze({
      pluginId,
      capability: capabilityName,
      invocationId,
      scopes: Object.freeze([...capability.requiredScopes]),
      signal,
      ...Object.freeze(context),
    })

    try {
      const raw = handler
        ? await withTimeout(
          () => handler(schemaResult.value, sandbox),
          {
            timeoutMs: capability.timeoutMs,
            label: `${pluginId}:${capabilityName}`,
            signal,
            onTimeout: () => {
              const error = new Error(`plugin '${pluginId}:${capabilityName}' exceeded its ${capability.timeoutMs}ms timeout`)
              error.code = 'plugin_timeout'
              return error
            },
            onCancelled: () => {
              const error = new Error(`plugin '${pluginId}:${capabilityName}' was cancelled`)
              error.code = 'plugin_cancelled'
              return error
            },
          },
        )
        : await this.#protocolInvoke(record, capability, schemaResult.value, sandbox)

      // Output is untrusted until schema-checked (§10).
      const outputCheck = capability.outputSchema ? validateAgainstSchema(raw, capability.outputSchema) : { valid: true, value: raw, errors: [] }
      if (!outputCheck.valid) {
        // NB: the catch block below owns the failure counter; do not double-count.
        this.#audit(`invoke:${capabilityName}`, 'failure', { pluginId, invocationId, reason: 'output_schema_violation', errors: outputCheck.errors }, subject ?? pluginId)
        throw new PluginPermissionError(`plugin '${pluginId}' returned output violating its declared schema: ${outputCheck.errors.join('; ')}`, {
          pluginId,
          capability: capabilityName,
          invocationId,
        })
      }

      record.invocations += 1
      record.lastInvokedAt = Date.now()
      // A plugin's output is data for the same reason a tool's is, and it gets the same label
      // from the same function, so the authority boundary cannot be bypassed by calling a
      // plugin instead of a tool.
      const provenance = provenanceOf(outputCheck.value, { kind: TRUST.TOOL_OUTPUT, origin: `plugin:${pluginId}:${capabilityName}` })
      const result = {
        ok: true,
        invocationId,
        pluginId,
        capability: capabilityName,
        version: record.version,
        protocol: record.manifest.protocol,
        // Consumers must treat this as untrusted data, not as instructions.
        untrusted: provenance.untrusted,
        provenance,
        output: outputCheck.value,
        scopesUsed: capability.requiredScopes,
        durationMs: Date.now() - startedAt,
      }
      this.#audit(`invoke:${capabilityName}`, 'success', {
        pluginId, invocationId, durationMs: result.durationMs, scopes: capability.requiredScopes,
        instructionShaped: provenance.instruction.instructionShaped,
      }, subject ?? pluginId)
      this.onEvent({ type: 'plugin_invoked', ...result, output: undefined })
      return result
    } catch (error) {
      record.failures += 1
      if (!(error instanceof PluginPermissionError) && !(error instanceof PluginApprovalRequiredError)) {
        this.#audit(`invoke:${capabilityName}`, 'failure', { pluginId, invocationId, error: error?.message, code: error?.code }, subject ?? pluginId)
      }
      throw error
    }
  }

  /** Non-local protocols are described, not silently faked. */
  async #protocolInvoke(record, capability, input, sandbox) {
    const protocol = record.manifest.protocol
    if (protocol === PROTOCOLS.MCP) {
      // Delegated to the MCP layer by the caller; a plugin cannot reach a server itself.
      throw new PluginPermissionError(`mcp plugin '${record.id}' must be invoked through the MCP layer, not directly`, { pluginId: record.id })
    }
    if (protocol === PROTOCOLS.HTTP_API) {
      throw new PluginPermissionError(
        `http_api plugin '${record.id}' has no bound transport; bind a handler that performs the call through the egress guard`,
        { pluginId: record.id, endpoint: record.manifest.endpoint },
      )
    }
    if (protocol === PROTOCOLS.SANDBOXED_WASM) {
      throw new PluginPermissionError(`sandboxed_wasm runtime is not implemented in this build (planned); plugin '${record.id}' cannot execute`, {
        pluginId: record.id,
      })
    }
    throw new PluginPermissionError(`no handler bound for '${record.id}:${capability.name}'`, { pluginId: record.id, protocol, sandbox: Boolean(sandbox) })
  }

  #audit(action, outcome, detail, subject) {
    this.ledger?.record({ category: 'plugin', action, outcome, subject: subject ?? null, detail })
  }

  publicView(record) {
    return {
      id: record.id,
      name: record.manifest.name,
      version: record.version,
      previousVersion: record.previousVersion,
      protocol: record.manifest.protocol,
      state: record.state,
      builtin: record.manifest.builtin,
      signature: { state: record.signature.state, keyId: record.signature.keyId, digest: record.signature.digest },
      description: record.manifest.description,
      author: record.manifest.author,
      license: record.manifest.license,
      scopes: record.manifest.scopes,
      elevated: record.manifest.elevated,
      capabilities: record.manifest.capabilities.map((capability) => ({
        name: capability.name,
        description: capability.description,
        requiredScopes: capability.requiredScopes,
        readOnly: capability.readOnly,
        bound: this.handlers.has(`${record.id}:${capability.name}`),
      })),
      invocations: record.invocations,
      failures: record.failures,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      lastInvokedAt: record.lastInvokedAt,
      history: record.history.slice(-20),
    }
  }
}

/** Keep audit payloads small and free of large blobs. */
function summarize(input) {
  if (!input || typeof input !== 'object') return { type: typeof input }
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value.length > 120 ? `${value.slice(0, 120)}…(${value.length} chars)` : value
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
    else out[key] = `[${Array.isArray(value) ? `array:${value.length}` : typeof value}]`
  }
  return out
}

export { ManifestError, SCOPES, ELEVATED_SCOPES, PROTOCOLS }
