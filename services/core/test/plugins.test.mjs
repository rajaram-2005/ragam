import test from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest, compareSemver, parseSemver, ManifestError, SCOPES, ELEVATED_SCOPES, FORBIDDEN_SCOPES, PROTOCOLS } from '../src/plugins/manifest.mjs'
import { PluginRegistry, PLUGIN_STATES, PluginPermissionError, PluginApprovalRequiredError } from '../src/plugins/registry.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'

function validManifest(overrides = {}) {
  return {
    id: 'acme.repo-inspector',
    name: 'Repository Inspector',
    version: '1.0.0',
    protocol: PROTOCOLS.LOCAL_TOOL,
    description: 'Reads repository metadata.',
    scopes: [SCOPES.FS_READ],
    capabilities: [
      {
        name: 'summarize',
        description: 'Summarise a repository path.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', minLength: 1 }, depth: { type: 'integer', minimum: 1, maximum: 10, default: 2 } },
          required: ['path'],
          additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: { files: { type: 'integer' }, summary: { type: 'string' } }, required: ['files', 'summary'] },
        requiredScopes: [SCOPES.FS_READ],
        readOnly: true,
      },
    ],
    ...overrides,
  }
}

/** Manifest problems are collected on `error.errors`; the message is generic. */
function assertManifestErrors(fn, patterns) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ManifestError, `expected a ManifestError, got ${caught?.name ?? 'no error'}: ${caught?.message}`)
  for (const pattern of [].concat(patterns)) {
    assert.ok(caught.errors.some((entry) => pattern.test(entry)), `expected an error matching ${pattern}; got ${JSON.stringify(caught.errors)}`)
  }
}

function makeRegistry(options = {}) {
  const ledger = new AuditLedger(':memory:')
  const registry = new PluginRegistry({ ledger, ...options })
  return { registry, ledger }
}

// --- manifest validation ---------------------------------------------------

test('a well-formed manifest validates and is normalised', () => {
  const { valid, manifest } = validateManifest(validManifest())
  assert.equal(valid, true)
  assert.equal(manifest.manifestVersion, 1)
  assert.deepEqual(manifest.scopes, [SCOPES.FS_READ])
  assert.deepEqual(manifest.elevated, [], 'fs.read is not elevated')
  assert.equal(manifest.builtin, false)
  assert.equal(manifest.capabilities[0].timeoutMs, 30_000, 'a sane default timeout is applied')
  assert.equal(typeof manifest.validatedAt, 'number')
})

test('elevated scopes are identified for the approval gate', () => {
  const { manifest } = validateManifest(validManifest({ scopes: [SCOPES.FS_READ, SCOPES.FS_WRITE, SCOPES.TERMINAL] }))
  assert.deepEqual(manifest.elevated.sort(), [SCOPES.FS_WRITE, SCOPES.TERMINAL].sort())
})

test('every forbidden scope is rejected', () => {
  for (const scope of FORBIDDEN_SCOPES) {
    assert.throws(() => validateManifest(validManifest({ scopes: [scope] })), ManifestError, `${scope} must be forbidden`)
  }
})

test('malformed manifests are rejected with every problem listed', () => {
  assert.throws(() => validateManifest(null), ManifestError)
  assert.throws(() => validateManifest([]), ManifestError)
  assert.throws(() => validateManifest({}), /failed validation/)

  const cases = [
    [{ id: 'Bad_ID' }, /id must match/],
    [{ id: 'x' }, /id must match/],
    [{ version: '1.0' }, /valid semver/],
    [{ version: 'v1.0.0' }, /valid semver/],
    [{ protocol: 'telepathy' }, /protocol must be one of/],
    [{ scopes: 'fs.read' }, /scopes must be an array/],
    [{ scopes: ['fs.read', 'fs.explode'] }, /unknown scope/],
    [{ capabilities: [] }, /at least one callable capability/],
    [{ manifestVersion: 2 }, /unsupported manifestVersion/],
  ]
  for (const [overrides, pattern] of cases) {
    assertManifestErrors(() => validateManifest(validManifest(overrides)), pattern)
  }
  // Several problems are reported together, not one at a time.
  assertManifestErrors(() => validateManifest(validManifest({ id: 'BAD', version: '1.0', protocol: 'nope' })), [
    /id must match/,
    /valid semver/,
    /protocol must be one of/,
  ])
})

test('capability schemas are mandatory and duplicate names are rejected', () => {
  assertManifestErrors(() => validateManifest(validManifest({ capabilities: [{ name: 'nope', description: 'd' }] })), /must declare an inputSchema/)
  assertManifestErrors(() => validateManifest(validManifest({ capabilities: [{ name: 'Bad Name', description: 'd', inputSchema: { type: 'object' } }] })), /lowercase dotted identifier/)
  const duplicate = { name: 'summarize', description: 'dup', inputSchema: { type: 'object' } }
  assertManifestErrors(() => validateManifest(validManifest({ capabilities: [validManifest().capabilities[0], duplicate] })), /duplicate capability/)
})

test('a capability cannot require a scope the manifest does not declare', () => {
  const manifest = validManifest({
    scopes: [SCOPES.FS_READ],
    capabilities: [{ name: 'delete', description: 'd', inputSchema: { type: 'object' }, requiredScopes: [SCOPES.FS_WRITE] }],
  })
  assertManifestErrors(() => validateManifest(manifest), /requires scope 'fs.write' not declared in manifest scopes/)
})

test('protocol-specific requirements are enforced', () => {
  assertManifestErrors(() => validateManifest(validManifest({ protocol: PROTOCOLS.HTTP_API })), /absolute http\(s\) endpoint/)
  assertManifestErrors(() => validateManifest(validManifest({ protocol: PROTOCOLS.HTTP_API, endpoint: 'ftp://x/y' })), /absolute http\(s\) endpoint/)
  assert.doesNotThrow(() => validateManifest(validManifest({ protocol: PROTOCOLS.HTTP_API, endpoint: 'https://api.example.com/v1' })))
  assertManifestErrors(() => validateManifest(validManifest({ protocol: PROTOCOLS.MCP })), /must declare a server reference/)
  assert.doesNotThrow(() => validateManifest(validManifest({ protocol: PROTOCOLS.MCP, server: 'filesystem' })))
  // local_tool handlers are bound in code, so no manifest handler name is required.
  assert.doesNotThrow(() => validateManifest(validManifest({ protocol: PROTOCOLS.LOCAL_TOOL })))
  assertManifestErrors(() => validateManifest(validManifest({ protocol: PROTOCOLS.LOCAL_TOOL, handler: 42 })), /handler, when present, must be a string/)
})

test('semver comparison orders releases and pre-releases correctly', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1)
  assert.equal(compareSemver('1.1.0', '1.0.9'), 1)
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1, 'a pre-release sorts before its release')
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(parseSemver('1.2.3-rc.1+build.5').pre, 'rc.1')
  assert.equal(parseSemver('not-a-version'), null)
  assert.throws(() => compareSemver('1.0', '1.0.0'), TypeError)
})

// --- lifecycle -------------------------------------------------------------

test('install → enable → invoke → disable → uninstall', async () => {
  const { registry, ledger } = makeRegistry()
  const installed = registry.install(validManifest(), { handler: async (input) => ({ files: 12, summary: `${input.path} at depth ${input.depth}` }) })
  assert.equal(installed.state, PLUGIN_STATES.INSTALLED)
  assert.equal(installed.reinstalled, true)

  // Installed but not enabled: not callable yet.
  await assert.rejects(() => registry.invoke(installed.id, 'summarize', { path: '/repo' }), /must be 'enabled'/)

  registry.enable(installed.id)
  assert.equal(registry.get(installed.id).state, PLUGIN_STATES.ENABLED)

  const result = await registry.invoke(installed.id, 'summarize', { path: '/repo', depth: 3 })
  assert.equal(result.ok, true)
  assert.equal(result.untrusted, true, 'plugin output is always marked untrusted')
  assert.deepEqual(result.output, { files: 12, summary: '/repo at depth 3' })
  assert.equal(result.scopesUsed.length, 1)
  assert.match(result.invocationId, /^[0-9a-f-]{36}$/)

  registry.disable(installed.id)
  await assert.rejects(() => registry.invoke(installed.id, 'summarize', { path: '/repo' }), PluginPermissionError)

  registry.enable(installed.id)
  registry.uninstall(installed.id)
  assert.equal(registry.get(installed.id).state, PLUGIN_STATES.UNINSTALLED)
  await assert.rejects(() => registry.invoke(installed.id, 'summarize', { path: '/repo' }), /uninstalled/)

  const actions = ledger.query({ category: 'plugin', limit: 50 }).map((event) => event.action)
  assert.ok(actions.includes('install'))
  assert.ok(actions.includes('enable'))
  assert.ok(actions.includes('invoke:summarize'))
  assert.ok(actions.includes('disable'))
  assert.ok(actions.includes('uninstall'))
})

test('builtin plugins cannot be uninstalled', () => {
  const { registry, ledger } = makeRegistry()
  registry.install(validManifest({ id: 'aetheris.builtin', builtin: true }))
  assert.throws(() => registry.uninstall('aetheris.builtin'), PluginPermissionError)
  assert.equal(registry.get('aetheris.builtin').builtin, true)
  assert.ok(ledger.query({ category: 'plugin' }).some((event) => event.action === 'uninstall' && event.outcome === 'denied'))
})

test('updates are versioned and silent downgrades are refused', () => {
  const { registry } = makeRegistry()
  registry.install(validManifest({ version: '1.0.0' }))
  const updated = registry.install(validManifest({ version: '1.1.0' }))
  assert.equal(updated.version, '1.1.0')
  assert.equal(updated.previousVersion, '1.0.0')
  assert.ok(updated.history.some((entry) => entry.event === 'updated'))

  assert.throws(() => registry.install(validManifest({ version: '1.0.0' })), /refusing to downgrade/)
  // Explicit override is allowed but still audited.
  const downgraded = registry.install(validManifest({ version: '1.0.0' }), { allowDowngrade: true })
  assert.equal(downgraded.version, '1.0.0')

  // Re-installing the same version is a no-op, not a duplicate install.
  const same = registry.install(validManifest({ version: '1.0.0' }))
  assert.equal(same.reinstalled, false)
  assert.match(same.note, /same version already installed/)
})

test('scopes the installation refuses cannot be installed at all', () => {
  const { registry, ledger } = makeRegistry({ grantedScopes: [SCOPES.FS_READ, SCOPES.KNOWLEDGE_READ] })
  assert.throws(
    () => registry.install(validManifest({ scopes: [SCOPES.FS_READ, SCOPES.NETWORK_EXTERNAL] })),
    PluginPermissionError,
  )
  const discovery = registry.discover(validManifest({ scopes: [SCOPES.FS_READ, SCOPES.NETWORK_EXTERNAL] }))
  assert.deepEqual(discovery.ungrantableScopes, [SCOPES.NETWORK_EXTERNAL])
  assert.equal(discovery.requiresApproval, true)
  assert.ok(ledger.query({ category: 'plugin' }).some((event) => event.action === 'install' && event.outcome === 'denied'))
})

test('discovery reports update availability without installing', () => {
  const { registry } = makeRegistry()
  registry.install(validManifest({ version: '1.0.0' }))
  const discovery = registry.discover(validManifest({ version: '2.0.0' }))
  assert.equal(discovery.alreadyInstalled, true)
  assert.equal(discovery.installedVersion, '1.0.0')
  assert.equal(discovery.updateAvailable, true)
  assert.equal(discovery.downgradeAttempt, false)
  assert.equal(registry.get('acme.repo-inspector').version, '1.0.0', 'discovery must not install anything')
})

// --- permission enforcement ------------------------------------------------

test('elevated scopes require an explicit approval', async () => {
  const { registry, ledger } = makeRegistry()
  registry.install(
    validManifest({
      id: 'acme.writer',
      scopes: [SCOPES.FS_READ, SCOPES.FS_WRITE],
      capabilities: [{ name: 'write', description: 'Write a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, requiredScopes: [SCOPES.FS_WRITE] }],
    }),
    { handler: async () => ({ ok: true }) },
  )
  registry.enable('acme.writer')

  const preflight = registry.preflight('acme.writer', 'write')
  assert.equal(preflight.allowed, false)
  assert.deepEqual(preflight.needsApproval, [SCOPES.FS_WRITE])
  assert.deepEqual(preflight.elevated, [SCOPES.FS_WRITE])

  await assert.rejects(() => registry.invoke('acme.writer', 'write', { path: '/tmp/x' }), PluginApprovalRequiredError)

  // A per-call approval unblocks exactly that call.
  const approved = await registry.invoke('acme.writer', 'write', { path: '/tmp/x' }, { approvals: [SCOPES.FS_WRITE] })
  assert.equal(approved.ok, true)

  // A standing operator approval unblocks subsequent calls.
  const standing = makeRegistry({ standingApprovals: [SCOPES.FS_WRITE] })
  standing.registry.install(validManifest({ id: 'acme.writer2', scopes: [SCOPES.FS_WRITE], capabilities: [{ name: 'write', description: 'd', inputSchema: { type: 'object' }, requiredScopes: [SCOPES.FS_WRITE] }] }), { handler: async () => ({ ok: true }) })
  standing.registry.enable('acme.writer2')
  assert.equal(standing.registry.preflight('acme.writer2', 'write').allowed, true)
  assert.ok(ledger.query({ category: 'plugin' }).some((event) => event.outcome === 'denied'))
})

test('arguments are validated against the schema before the handler runs', async () => {
  const { registry } = makeRegistry()
  let handlerCalls = 0
  registry.install(validManifest(), {
    handler: async () => {
      handlerCalls += 1
      return { files: 1, summary: 'x' }
    },
  })
  registry.enable('acme.repo-inspector')

  // Missing required property.
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'summarize', {}), /missing required property 'path'/)
  // Wrong type.
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'summarize', { path: 42 }), /expected type string/)
  // Undeclared property.
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'summarize', { path: '/x', evil: true }), /unexpected propert/)
  // Out-of-range value.
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'summarize', { path: '/x', depth: 999 }), /maximum 10/)

  assert.equal(handlerCalls, 0, 'the handler must never see invalid input')
})

test('output violating the declared schema is rejected, not passed through', async () => {
  const { registry, ledger } = makeRegistry()
  registry.install(validManifest(), { handler: async () => ({ files: 'not-a-number' }) })
  registry.enable('acme.repo-inspector')
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'summarize', { path: '/x' }), /output violating its declared schema/)
  assert.equal(registry.get('acme.repo-inspector').failures, 1)
  assert.ok(ledger.query({ category: 'plugin' }).some((event) => event.action === 'invoke:summarize' && event.outcome === 'failure'))
})

test('a handler cannot bind a capability the manifest never declared', () => {
  const { registry } = makeRegistry()
  registry.install(validManifest())
  assert.throws(() => registry.bindHandlers('acme.repo-inspector', { exfiltrate: async () => ({}) }), PluginPermissionError)
})

test('a handler that exceeds its timeout is cut off', async () => {
  const { registry } = makeRegistry()
  registry.install(
    validManifest({
      capabilities: [{ name: 'slow', description: 'd', inputSchema: { type: 'object' }, timeoutMs: 60 }],
    }),
    { handler: { slow: async () => new Promise((resolve) => setTimeout(() => resolve({}), 5000)) } },
  )
  registry.enable('acme.repo-inspector')
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'slow', {}), /exceeded its 60ms timeout/)
})

test('a handler can be cancelled through an AbortSignal', async () => {
  const { registry } = makeRegistry()
  registry.install(validManifest({ capabilities: [{ name: 'long', description: 'd', inputSchema: { type: 'object' }, timeoutMs: 30_000 }] }), {
    handler: { long: async () => new Promise((resolve) => setTimeout(() => resolve({}), 5000)) },
  })
  registry.enable('acme.repo-inspector')
  const controller = new AbortController()
  const pending = registry.invoke('acme.repo-inspector', 'long', {}, { signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(() => pending, /was cancelled/)
})

test('a throwing handler is reported as a failure and counted', async () => {
  const { registry } = makeRegistry()
  registry.install(validManifest(), {
    handler: async () => {
      throw new Error('handler exploded')
    },
  })
  registry.enable('acme.repo-inspector')
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'summarize', { path: '/x' }), /handler exploded/)
  const view = registry.get('acme.repo-inspector')
  assert.equal(view.failures, 1)
  assert.equal(view.invocations, 0, 'a failed call is not a successful invocation')
})

test('unimplemented protocols say so instead of pretending', async () => {
  const { registry } = makeRegistry()
  registry.install(validManifest({ id: 'acme.remote', protocol: PROTOCOLS.HTTP_API, endpoint: 'https://api.example.com/v1' }))
  registry.enable('acme.remote')
  await assert.rejects(() => registry.invoke('acme.remote', 'summarize', { path: '/x' }), /no bound transport/)

  registry.install(validManifest({ id: 'acme.wasm', protocol: PROTOCOLS.SANDBOXED_WASM }))
  registry.enable('acme.wasm')
  await assert.rejects(() => registry.invoke('acme.wasm', 'summarize', { path: '/x' }), /not implemented in this build/)

  registry.install(validManifest({ id: 'acme.mcp', protocol: PROTOCOLS.MCP, server: 'filesystem' }))
  registry.enable('acme.mcp')
  await assert.rejects(() => registry.invoke('acme.mcp', 'summarize', { path: '/x' }), /through the MCP layer/)
})

test('capability discovery lists only enabled plugins and marks binding state', async () => {
  const { registry } = makeRegistry()
  registry.install(validManifest(), { handler: async () => ({ files: 0, summary: '' }) })
  assert.deepEqual(registry.capabilities(), [], 'an installed-but-disabled plugin is not discoverable')
  registry.enable('acme.repo-inspector')
  const capabilities = registry.capabilities()
  assert.equal(capabilities.length, 1)
  assert.equal(capabilities[0].bound, true)
  assert.equal(capabilities[0].pluginId, 'acme.repo-inspector')
  registry.disable('acme.repo-inspector')
  assert.deepEqual(registry.capabilities(), [])
})

test('the public view exposes scopes and audit counts but no handler internals', () => {
  const { registry } = makeRegistry()
  registry.install(validManifest(), { handler: async () => ({ files: 0, summary: '' }) })
  const view = registry.get('acme.repo-inspector')
  assert.deepEqual(view.scopes, [SCOPES.FS_READ])
  assert.equal(typeof view.invocations, 'number')
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('handler'), false, 'handlers must not be serialised to clients')
})

test('unknown plugins and capabilities are rejected cleanly', async () => {
  const { registry } = makeRegistry()
  assert.throws(() => registry.get('nope'), /unknown plugin/)
  assert.throws(() => registry.enable('nope'), /unknown plugin/)
  registry.install(validManifest())
  registry.enable('acme.repo-inspector')
  assert.equal(registry.preflight('acme.repo-inspector', 'nonexistent').allowed, false)
  await assert.rejects(() => registry.invoke('acme.repo-inspector', 'nonexistent', {}), /does not declare capability/)
  registry.list({ state: PLUGIN_STATES.ENABLED })
  assert.equal(registry.list({ protocol: PROTOCOLS.MCP }).length, 0)
})

test('every elevated scope is recognised as needing approval', () => {
  for (const scope of ELEVATED_SCOPES) {
    const { manifest } = validateManifest(validManifest({ scopes: [scope], capabilities: [{ name: 'act', description: 'd', inputSchema: { type: 'object' }, requiredScopes: [scope] }] }))
    assert.ok(manifest.elevated.includes(scope), `${scope} must be elevated`)
  }
})
