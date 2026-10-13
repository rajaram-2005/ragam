// Plugin manifest validation.
//
// Directive §2 (Plugins): "validated manifests, versioning, capability discovery,
// installation, updates, disablement, removal and audit records" and "Require
// explicit permission boundaries for filesystem, terminal, network, credentials,
// external services and device access."
//
// A manifest that does not validate is rejected outright. There is no "trusted by
// default" path: scopes are an allowlist, and anything undeclared is denied at
// invocation time (see registry.mjs).

export const PROTOCOLS = Object.freeze({
  MCP: 'mcp',
  LOCAL_TOOL: 'local_tool',
  HTTP_API: 'http_api',
  SANDBOXED_WASM: 'sandboxed_wasm',
})

/**
 * Permission scopes. Deliberately coarse and few, so a reviewer can read a
 * plugin's blast radius at a glance.
 */
export const SCOPES = Object.freeze({
  FS_READ: 'fs.read',
  FS_WRITE: 'fs.write',
  TERMINAL: 'terminal.exec',
  NETWORK_LOCAL: 'network.local',
  NETWORK_EXTERNAL: 'network.external',
  CREDENTIALS_READ: 'credentials.read',
  EXTERNAL_SERVICE: 'service.external',
  DEVICE: 'device.access',
  KNOWLEDGE_READ: 'knowledge.read',
  KNOWLEDGE_WRITE: 'knowledge.write',
  MEDIA_WRITE: 'media.write',
})

/** Scopes that always require an explicit human approval gate, per directive §10. */
export const ELEVATED_SCOPES = Object.freeze([
  SCOPES.FS_WRITE,
  SCOPES.TERMINAL,
  SCOPES.NETWORK_EXTERNAL,
  SCOPES.CREDENTIALS_READ,
  SCOPES.EXTERNAL_SERVICE,
  SCOPES.DEVICE,
  SCOPES.KNOWLEDGE_WRITE,
])

/** Scopes that can never be granted to a plugin under any circumstances. */
export const FORBIDDEN_SCOPES = Object.freeze(['credentials.write', 'policy.override', 'godcore.bypass', 'audit.erase'])

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/

export class ManifestError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'ManifestError'
    this.code = 'invalid_manifest'
    this.errors = errors
  }
}

/**
 * Validate a plugin manifest.
 * @returns {{valid:true, manifest:object}} or throws ManifestError with every problem found.
 */
export function validateManifest(input) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ManifestError('manifest must be a JSON object', ['manifest is not an object'])
  }

  // --- identity -----------------------------------------------------------
  if (typeof input.id !== 'string' || !PLUGIN_ID.test(input.id)) {
    errors.push(`id must match ${PLUGIN_ID} (lowercase, 2-64 chars)`)
  }
  if (typeof input.name !== 'string' || !input.name.trim()) errors.push('name is required')
  if (typeof input.version !== 'string' || !SEMVER.test(input.version ?? '')) {
    errors.push('version must be valid semver (e.g. 1.2.0)')
  }
  if (input.manifestVersion !== undefined && input.manifestVersion !== 1) {
    errors.push(`unsupported manifestVersion '${input.manifestVersion}'; this build understands 1`)
  }

  // --- protocol -----------------------------------------------------------
  if (!Object.values(PROTOCOLS).includes(input.protocol)) {
    errors.push(`protocol must be one of ${Object.values(PROTOCOLS).join(', ')}`)
  }
  if (input.protocol === PROTOCOLS.HTTP_API) {
    if (typeof input.endpoint !== 'string' || !/^https?:\/\//.test(input.endpoint ?? '')) {
      errors.push('http_api plugins must declare an absolute http(s) endpoint')
    }
  }
  if (input.protocol === PROTOCOLS.MCP) {
    if (typeof input.server !== 'string' || !input.server.trim()) {
      errors.push('mcp plugins must declare a server reference')
    }
  }
  // local_tool handlers are bound in code at install time (registry.bindHandlers),
  // so the manifest does not need to name one. http_api and mcp DO need routing info.
  if (input.protocol === PROTOCOLS.LOCAL_TOOL && input.handler !== undefined && typeof input.handler !== 'string') {
    errors.push('handler, when present, must be a string')
  }

  // --- scopes -------------------------------------------------------------
  if (!Array.isArray(input.scopes)) {
    errors.push('scopes must be an array (use [] for a plugin that needs nothing)')
  } else {
    for (const scope of input.scopes) {
      if (FORBIDDEN_SCOPES.includes(scope)) errors.push(`scope '${scope}' can never be granted`)
      else if (!Object.values(SCOPES).includes(scope)) errors.push(`unknown scope '${scope}'`)
    }
  }

  // --- capabilities -------------------------------------------------------
  if (!Array.isArray(input.capabilities) || !input.capabilities.length) {
    errors.push('capabilities must declare at least one callable capability')
  } else {
    const seen = new Set()
    for (const capability of input.capabilities) {
      if (!capability || typeof capability !== 'object') {
        errors.push('each capability must be an object')
        continue
      }
      if (typeof capability.name !== 'string' || !/^[a-z][a-z0-9_.]{1,63}$/.test(capability.name)) {
        errors.push(`capability name '${capability?.name}' must be lowercase dotted identifier`)
      } else if (seen.has(capability.name)) {
        errors.push(`duplicate capability '${capability.name}'`)
      } else {
        seen.add(capability.name)
      }
      if (typeof capability.description !== 'string' || !capability.description.trim()) {
        errors.push(`capability '${capability?.name}' needs a description`)
      }
      // A schema is required so arguments can be validated before invocation.
      if (!capability.inputSchema || typeof capability.inputSchema !== 'object') {
        errors.push(`capability '${capability?.name}' must declare an inputSchema`)
      }
      if (Array.isArray(capability.requiredScopes)) {
        for (const scope of capability.requiredScopes) {
          if (!Object.values(SCOPES).includes(scope)) errors.push(`capability '${capability.name}' requires unknown scope '${scope}'`)
          else if (!Array.isArray(input.scopes) || !input.scopes.includes(scope)) {
            errors.push(`capability '${capability.name}' requires scope '${scope}' not declared in manifest scopes`)
          }
        }
      }
    }
  }

  // --- provenance / trust -------------------------------------------------
  if (input.author !== undefined && typeof input.author !== 'string') errors.push('author must be a string')
  if (input.license !== undefined && typeof input.license !== 'string') errors.push('license must be a string')
  if (input.repository !== undefined && typeof input.repository !== 'string') errors.push('repository must be a string')
  if (Array.isArray(input.permissions?.dangerous)) {
    errors.push('permissions.dangerous is not a supported manifest field')
  }

  if (errors.length) throw new ManifestError(`manifest for '${input.id ?? '(unknown)'}' failed validation`, errors)

  const scopes = [...new Set(input.scopes)]
  return {
    valid: true,
    manifest: {
      manifestVersion: 1,
      id: input.id,
      name: input.name.trim(),
      version: input.version,
      protocol: input.protocol,
      description: typeof input.description === 'string' ? input.description.trim() : '',
      author: input.author ?? null,
      license: input.license ?? null,
      repository: input.repository ?? null,
      endpoint: input.endpoint ?? null,
      server: input.server ?? null,
      handler: input.handler ?? null,
      scopes,
      elevated: scopes.filter((scope) => ELEVATED_SCOPES.includes(scope)),
      capabilities: input.capabilities.map((capability) => ({
        name: capability.name,
        description: capability.description.trim(),
        inputSchema: capability.inputSchema,
        outputSchema: capability.outputSchema ?? null,
        requiredScopes: [...new Set(capability.requiredScopes ?? [])],
        readOnly: Boolean(capability.readOnly),
        timeoutMs: Number.isInteger(capability.timeoutMs) && capability.timeoutMs > 0 ? capability.timeoutMs : 30_000,
      })),
      // Builtin plugins ship with the product and cannot be uninstalled (§2).
      builtin: Boolean(input.builtin),
      checksum: typeof input.checksum === 'string' ? input.checksum : null,
      validatedAt: Date.now(),
    },
  }
}

/** Compare two semver strings. Returns -1, 0 or 1. */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) throw new TypeError('compareSemver requires valid semver strings')
  for (let i = 0; i < 3; i += 1) {
    if (pa.main[i] !== pb.main[i]) return pa.main[i] < pb.main[i] ? -1 : 1
  }
  // A pre-release sorts before its release.
  if (pa.pre && !pb.pre) return -1
  if (!pa.pre && pb.pre) return 1
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0
  return 0
}

function parseSemver(value) {
  const match = SEMVER.exec(String(value ?? ''))
  if (!match) return null
  return { main: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null, build: match[5] ?? null }
}

export { parseSemver }
