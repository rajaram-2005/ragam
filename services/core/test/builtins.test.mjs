// Built-in plugins and the in-process MCP server.
//
// These exist so the Plugins and MCP product areas have something real to inspect:
// a browser cannot bind a `local_tool` handler, so the handlers must be bound in
// code at boot. That makes them production surface, not fixtures, and they are
// tested as such.
//
// What matters most here is that the built-ins do not weaken the permission model
// they are meant to demonstrate. So beyond "they register and return data", these
// tests prove:
//   - every capability has a genuinely bound handler (no "bound: false" decoration)
//   - input schemas are enforced against the built-ins themselves
//   - the elevated-scope and destructive-tier approval gates bite on built-in tools
//   - disabling a built-in actually stops it being invocable
//   - a built-in cannot be uninstalled, and the refusal is audited
//   - invoking every built-in capability opens no network connection at all
//   - handler output is plain data, never a live internal reference

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join } from 'node:path'

import { AetherisOmniApp } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { registerBuiltins, BUILTIN_PLUGIN_IDS, BUILTIN_SERVER_ID } from '../src/builtins.mjs'
import { PluginRegistry, PLUGIN_STATES, PluginPermissionError, PluginApprovalRequiredError } from '../src/plugins/registry.mjs'
import { McpRegistry, McpError, RISK, SERVER_KINDS } from '../src/mcp/layer.mjs'
import { SCOPES, ELEVATED_SCOPES } from '../src/plugins/manifest.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'

const INSIGHT = 'aetheris.insight'
const KNOWLEDGE = 'aetheris.knowledge'

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), 'aetheris-builtins-'))
}

async function makeApp(env = {}) {
  const dataDir = makeDataDir()
  const app = new AetherisOmniApp({ config: loadConfig({ AETHERIS_DATA_DIR: dataDir, ...env }) })
  return {
    app,
    dataDir,
    async close() {
      await app.close?.()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** True if any value in the tree is a function, symbol, or class instance with methods. */
function containsLiveReference(value, seen = new Set()) {
  if (typeof value === 'function' || typeof value === 'symbol') return true
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (value instanceof AbortController || value instanceof Promise) return true
  for (const entry of Object.values(value)) if (containsLiveReference(entry, seen)) return true
  return false
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('both built-in plugins register at boot, enabled, with every capability bound', async () => {
  const { app, close } = await makeApp()
  try {
    assert.deepEqual(app.builtins.plugins.sort(), [`${INSIGHT}@1.0.0`, `${KNOWLEDGE}@1.0.0`])
    assert.equal(app.builtins.server, BUILTIN_SERVER_ID)

    const plugins = app.plugins.list()
    assert.deepEqual(plugins.map((plugin) => plugin.id).sort(), [...BUILTIN_PLUGIN_IDS].sort())
    for (const plugin of plugins) {
      assert.equal(plugin.state, PLUGIN_STATES.ENABLED, `${plugin.id} must be enabled at boot`)
      assert.equal(plugin.builtin, true, `${plugin.id} must be marked builtin`)
      assert.equal(plugin.protocol, 'local_tool')
      assert.equal(plugin.license, 'MIT')
      assert.ok(plugin.capabilities.length > 0)
      for (const capability of plugin.capabilities) {
        assert.equal(capability.bound, true, `${plugin.id}:${capability.name} has no handler bound`)
        assert.equal(capability.readOnly, true, `${plugin.id}:${capability.name} must be read-only`)
      }
    }
  } finally {
    await close()
  }
})

test('built-in plugins request only non-elevated scopes', async () => {
  const { app, close } = await makeApp()
  try {
    const insight = app.plugins.get(INSIGHT)
    assert.deepEqual(insight.scopes, [], 'introspection needs nothing granted')
    assert.deepEqual(insight.elevated, [])

    const knowledge = app.plugins.get(KNOWLEDGE)
    assert.deepEqual(knowledge.scopes, [SCOPES.KNOWLEDGE_READ])
    assert.deepEqual(knowledge.elevated, [], 'knowledge.read is not an elevated scope')
    assert.ok(!ELEVATED_SCOPES.includes(SCOPES.KNOWLEDGE_READ))

    // Every declared capability scope is covered by the manifest, or preflight would
    // deny the plugin it ships with.
    for (const plugin of app.plugins.list()) {
      for (const capability of plugin.capabilities) {
        for (const scope of capability.requiredScopes ?? []) {
          assert.ok(plugin.scopes.includes(scope), `${plugin.id}:${capability.name} requires an undeclared scope ${scope}`)
        }
      }
    }
  } finally {
    await close()
  }
})

test('registerBuiltins is idempotent', async () => {
  const { app, close } = await makeApp()
  try {
    const again = registerBuiltins(app)
    assert.deepEqual(again, { plugins: [], server: null }, 'a second registration must be a no-op')
    assert.equal(app.plugins.list().length, 2)
    assert.equal(app.mcp.listServers().length, 1)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// The handlers return real platform state
// ---------------------------------------------------------------------------

test('insight capabilities report real measured state, not placeholders', async () => {
  const { app, close } = await makeApp()
  try {
    const hardware = await app.plugins.invoke(INSIGHT, 'system.hardware', {})
    assert.equal(hardware.ok, true)
    assert.equal(hardware.untrusted, true, 'plugin output is always flagged untrusted')
    assert.equal(hardware.output.cpuCount, cpus().length, 'hardware must be the measured profile')
    assert.equal(hardware.output.gpuDetected, false)
    assert.equal(typeof hardware.output.ramGb, 'number')

    const readiness = await app.plugins.invoke(INSIGHT, 'system.readiness', {})
    assert.equal(readiness.output.policy, app.config.policy)
    assert.equal(readiness.output.offlineEnforced, app.config.policy === 'strict_offline')
    assert.ok('chat' in readiness.output.capabilities)
    assert.ok('videoGeneration' in readiness.output.capabilities)

    const audit = await app.plugins.invoke(INSIGHT, 'audit.tail', { limit: 5 })
    assert.ok(Array.isArray(audit.output))
    assert.equal(audit.output.length, 5, 'the limit is honoured')
    assert.ok(audit.output.every((entry) => typeof entry.category === 'string' && typeof entry.action === 'string'))
    // query() returns the most recent rows first, so the startup entry only appears
    // once the window reaches back past built-in registration.
    const wide = await app.plugins.invoke(INSIGHT, 'audit.tail', { limit: 100 })
    assert.ok(wide.output.some((entry) => entry.action === 'startup'), 'the startup entry is in the ledger')
    assert.ok(wide.output.length > audit.output.length)

    const media = await app.plugins.invoke(INSIGHT, 'media.jobs', {})
    assert.deepEqual(media.output, [], 'a fresh installation has no media jobs')
  } finally {
    await close()
  }
})

test('audit.tail category filter reaches the ledger', async () => {
  const { app, close } = await makeApp()
  try {
    const all = await app.plugins.invoke(INSIGHT, 'audit.tail', { limit: 50 })
    const pluginsOnly = await app.plugins.invoke(INSIGHT, 'audit.tail', { limit: 50, category: 'plugin' })
    assert.ok(all.output.length >= pluginsOnly.output.length)
    assert.ok(pluginsOnly.output.every((entry) => entry.category === 'plugin'))
    assert.ok(pluginsOnly.output.some((entry) => String(entry.action).startsWith('install')), 'built-in installation is audited')
  } finally {
    await close()
  }
})

test('knowledge capabilities reflect a real ingestion', async () => {
  const { app, close } = await makeApp()
  try {
    await app.knowledge.ingestText({
      title: 'Coolant Procedure',
      text: 'The coolant loop pressure must stay between 2.1 and 2.4 bar during idle. Escalate to facilities if it drifts outside that band.',
      classification: 'internal',
      owner: 'facilities',
    })

    const search = await app.plugins.invoke(KNOWLEDGE, 'knowledge.search', { query: 'coolant loop pressure during idle', topK: 3 })
    assert.equal(search.ok, true)
    assert.equal(search.scopesUsed.length, 1)
    assert.equal(search.output.method, 'bm25')
    assert.equal(search.output.count, 1)
    assert.equal(search.output.results[0].title, 'Coolant Procedure')
    assert.match(search.output.results[0].text, /2\.1 and 2\.4 bar/)
    assert.equal(search.output.results[0].sha256.length, 64, 'citations carry a content hash')

    const stats = await app.plugins.invoke(KNOWLEDGE, 'knowledge.stats', {})
    assert.equal(stats.output.store.documents, 1)
    assert.ok(stats.output.store.chunks >= 1)
    assert.ok(stats.output.index.uniqueTerms > 0)

    const documents = await app.plugins.invoke(KNOWLEDGE, 'knowledge.documents', { limit: 10 })
    assert.equal(documents.output.length, 1)
    assert.equal(documents.output[0].title, 'Coolant Procedure')
    assert.equal(documents.output[0].classification, 'internal')
    assert.equal(documents.output[0].owner, 'facilities')

    // Access control is enforced by the pipeline, not by the plugin: a principal
    // without a grant gets nothing back.
    const denied = await app.plugins.invoke(KNOWLEDGE, 'knowledge.search', { query: 'coolant pressure', principal: 'someone-else' })
    assert.equal(denied.output.count, 0, 'a principal without a grant must not see the chunk')
  } finally {
    await close()
  }
})

test('built-in input schemas are enforced against the built-ins themselves', async () => {
  const { app, close } = await makeApp()
  try {
    // additionalProperties: false means an unexpected key is a refusal, not a shrug.
    await assert.rejects(
      app.plugins.invoke(INSIGHT, 'audit.tail', { limit: 3, wat: true }),
      (error) => error instanceof PluginPermissionError && /unexpected property/.test(error.message),
    )
    // A required property is required.
    await assert.rejects(
      app.plugins.invoke(KNOWLEDGE, 'knowledge.search', {}),
      (error) => error instanceof PluginPermissionError && /missing required property/.test(error.message),
    )
    // Types are checked, not coerced silently.
    await assert.rejects(
      app.plugins.invoke(KNOWLEDGE, 'knowledge.search', { query: 42 }),
      (error) => error instanceof PluginPermissionError,
    )
    // Bounds are checked.
    await assert.rejects(
      app.plugins.invoke(INSIGHT, 'audit.tail', { limit: 99999 }),
      (error) => error instanceof PluginPermissionError && /maximum/.test(error.message),
    )
    // An undeclared capability is refused by preflight and by invoke alike.
    assert.equal(app.plugins.preflight(INSIGHT, 'system.reboot').allowed, false)
    await assert.rejects(app.plugins.invoke(INSIGHT, 'system.reboot', {}), PluginPermissionError)
  } finally {
    await close()
  }
})

test('an installation that does not grant knowledge.read cannot install the knowledge plugin', () => {
  const registry = new PluginRegistry({ ledger: new AuditLedger(':memory:'), grantedScopes: [SCOPES.FS_READ] })
  assert.throws(
    () => registry.install({
      manifestVersion: 1,
      id: KNOWLEDGE,
      name: 'Knowledge',
      version: '1.0.0',
      protocol: 'local_tool',
      description: 'test',
      scopes: [SCOPES.KNOWLEDGE_READ],
      capabilities: [
        { name: 'knowledge.search', description: 'search', inputSchema: { type: 'object', properties: {} }, requiredScopes: [SCOPES.KNOWLEDGE_READ] },
      ],
    }),
    (error) => error instanceof PluginPermissionError && /requests scopes this installation does not grant: knowledge\.read/.test(error.message),
  )
})

// ---------------------------------------------------------------------------
// Lifecycle: disable, uninstall refusal
// ---------------------------------------------------------------------------

test('disabling a built-in stops it being invocable, and re-enabling restores it', async () => {
  const { app, close } = await makeApp()
  try {
    app.plugins.disable(INSIGHT)
    const preflight = app.plugins.preflight(INSIGHT, 'system.hardware')
    assert.equal(preflight.allowed, false)
    assert.ok(preflight.reasons.some((reason) => /must be 'enabled'/.test(reason)))
    await assert.rejects(app.plugins.invoke(INSIGHT, 'system.hardware', {}), PluginPermissionError)

    app.plugins.enable(INSIGHT)
    assert.equal(app.plugins.preflight(INSIGHT, 'system.hardware').allowed, true)
    assert.equal((await app.plugins.invoke(INSIGHT, 'system.hardware', {})).ok, true)
  } finally {
    await close()
  }
})

test('a built-in cannot be uninstalled and the refusal is audited', async () => {
  const { app, close } = await makeApp()
  try {
    assert.throws(
      () => app.plugins.uninstall(INSIGHT),
      (error) => error instanceof PluginPermissionError && /builtin/.test(error.message),
    )
    assert.equal(app.plugins.get(INSIGHT).state, PLUGIN_STATES.ENABLED, 'the plugin survives the refused uninstall')
    const entries = app.ledger.query({ limit: 50, category: 'plugin' })
    assert.ok(
      entries.some((entry) => entry.action === 'uninstall' && entry.outcome === 'denied'),
      'a refused uninstall must be audited, not silent',
    )
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

test('the in-process MCP server registers with the declared risk tiers', async () => {
  const { app, close } = await makeApp()
  try {
    assert.equal(app.mcp.hasServer(BUILTIN_SERVER_ID), true)
    const server = app.mcp.describeServer(BUILTIN_SERVER_ID)
    assert.equal(server.kind, SERVER_KINDS.IN_PROCESS)
    assert.equal(server.enabled, true)
    assert.equal(server.auth.type, 'none')
    assert.equal(server.auth.configured, false, 'no credential is claimed for an in-process server')

    const tiers = Object.fromEntries(server.tools.map((tool) => [tool.name, tool.risk]))
    assert.deepEqual(tiers, {
      'aetheris.hardware': RISK.READ_ONLY,
      'aetheris.knowledge.search': RISK.READ_ONLY,
      'aetheris.knowledge.ingest': RISK.WRITE,
      'aetheris.task.cancel': RISK.DESTRUCTIVE,
    })
    assert.ok(server.tools.every((tool) => tool.hasHandler), 'every built-in tool has a handler')

    // The two tiers this build cannot honestly offer are absent, not stubbed.
    assert.ok(!server.tools.some((tool) => tool.risk === RISK.SYSTEM), 'system risk is refused by allowedRisks, so nothing may advertise it')
    assert.ok(!server.tools.some((tool) => tool.risk === RISK.EXTERNAL), 'no external endpoint is configured')

    assert.equal(server.resources.length, 1)
    assert.equal(server.resources[0].uri, 'aetheris://status')
    assert.equal(server.prompts.length, 1)
    assert.equal(server.prompts[0].name, 'grounded_answer')
  } finally {
    await close()
  }
})

test('read-only MCP tools run and their output is flagged untrusted', async () => {
  const { app, close } = await makeApp()
  try {
    const preflight = app.mcp.preflight(BUILTIN_SERVER_ID, 'aetheris.hardware')
    assert.equal(preflight.allowed, true)
    assert.equal(preflight.needsApproval, false)

    const call = await app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.hardware', {})
    assert.equal(call.ok, true)
    assert.equal(call.untrusted, true)
    assert.equal(call.risk, RISK.READ_ONLY)
    assert.equal(call.output.hardware.cpuCount, cpus().length)
    assert.equal(call.output.readiness.policy, app.config.policy)
    assert.ok(!containsLiveReference(call.output), 'a tool must not hand out live internal objects')
  } finally {
    await close()
  }
})

test('the write tier needs an approval naming the elevated scope, and then really ingests', async () => {
  const { app, close } = await makeApp()
  try {
    const tool = 'aetheris.knowledge.ingest'
    const withoutApproval = app.mcp.preflight(BUILTIN_SERVER_ID, tool)
    assert.equal(withoutApproval.allowed, false)
    assert.equal(withoutApproval.needsApproval, true)
    assert.deepEqual(withoutApproval.elevatedScopes, [SCOPES.KNOWLEDGE_WRITE])
    assert.ok(withoutApproval.reasons.some((reason) => /explicit approval required for scopes: knowledge\.write/.test(reason)))

    await assert.rejects(
      app.mcp.callTool(BUILTIN_SERVER_ID, tool, { title: 'Torque Spec', text: 'Torque the flange bolts to 14 Nm in a star pattern.' }),
      (error) => error instanceof McpError && error.code === 'permission_denied',
    )

    // An installation-level grant alone is not consent; the approval must name the scope.
    const grantedOnly = app.mcp.preflight(BUILTIN_SERVER_ID, tool, { grantedScopes: [SCOPES.KNOWLEDGE_WRITE] })
    assert.equal(grantedOnly.allowed, false, 'granting the scope is not the same as approving its use')

    // And a restricted grant list still denies even with the approval.
    const restricted = app.mcp.preflight(BUILTIN_SERVER_ID, tool, {
      approvals: [SCOPES.KNOWLEDGE_WRITE],
      grantedScopes: [SCOPES.KNOWLEDGE_READ],
    })
    assert.equal(restricted.allowed, false)
    assert.ok(restricted.reasons.some((reason) => /installation does not grant scopes/.test(reason)))

    const approved = await app.mcp.callTool(
      BUILTIN_SERVER_ID,
      tool,
      { title: 'Torque Spec', text: 'Torque the flange bolts to 14 Nm in a star pattern.', classification: 'internal' },
      { approvals: [SCOPES.KNOWLEDGE_WRITE] },
    )
    assert.equal(approved.ok, true)
    assert.equal(approved.output.duplicate, false)
    assert.equal(approved.output.chunks, 1)
    assert.equal(approved.output.sha256.length, 64)

    // The write really happened — verify through an independent path.
    const stats = app.knowledge.stats()
    assert.equal(stats.store.documents, 1)
    const found = app.knowledge.search({ query: 'flange bolts torque star pattern' })
    assert.equal(found.results.length, 1)
    assert.equal(found.results[0].citation.title, 'Torque Spec')

    // Ingesting identical content again is deduplicated rather than duplicated.
    const again = await app.mcp.callTool(
      BUILTIN_SERVER_ID,
      tool,
      { title: 'Torque Spec', text: 'Torque the flange bolts to 14 Nm in a star pattern.', classification: 'internal' },
      { approvals: [SCOPES.KNOWLEDGE_WRITE] },
    )
    assert.equal(again.output.duplicate, true)
    assert.equal(app.knowledge.stats().store.documents, 1)
  } finally {
    await close()
  }
})

test('the destructive tier refuses without approval and cancels a real task with it', async () => {
  const { app, close } = await makeApp()
  try {
    const tool = 'aetheris.task.cancel'
    const key = `${BUILTIN_SERVER_ID}:${tool}`

    const preflight = app.mcp.preflight(BUILTIN_SERVER_ID, tool)
    assert.equal(preflight.allowed, false)
    assert.equal(preflight.needsApproval, true)
    assert.equal(preflight.risk, RISK.DESTRUCTIVE)

    const task = app.godCore.submit({ prompt: 'a task to cancel' })
    await assert.rejects(
      app.mcp.callTool(BUILTIN_SERVER_ID, tool, { taskId: task.id }),
      (error) => error.code === 'approval_required',
    )
    assert.notEqual(app.godCore.get(task.id).state, 'cancelled', 'nothing happened without approval')

    const cancelled = await app.mcp.callTool(BUILTIN_SERVER_ID, tool, { taskId: task.id, reason: 'operator cancelled it' }, { approvals: [key] })
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.output.cancelled, true)
    // cancelReason is not part of the task's public view; the reason comes back on
    // the action summary the handler spreads into the output.
    assert.equal(cancelled.output.reason, 'operator cancelled it')
    assert.equal(cancelled.output.task.state, 'cancelled')
    assert.equal(app.godCore.get(task.id).state, 'cancelled')

    // Approving by risk tier works too, which is how a batch approval is expressed.
    const second = app.godCore.submit({ prompt: 'another task' })
    const byRisk = await app.mcp.callTool(BUILTIN_SERVER_ID, tool, { taskId: second.id }, { approvals: [RISK.DESTRUCTIVE] })
    assert.equal(byRisk.output.task.state, 'cancelled')

    // An unknown task propagates as a coded domain error, which the HTTP layer maps
    // to a 404 rather than a 500 — the built-in must not swallow it or flatten it.
    await assert.rejects(
      app.mcp.callTool(BUILTIN_SERVER_ID, tool, { taskId: 'does-not-exist' }, { approvals: [key] }),
      (error) => error.code === 'unknown_task' && /unknown task/.test(error.message),
    )
  } finally {
    await close()
  }
})

test('disabling the MCP server denies every built-in tool', async () => {
  const { app, close } = await makeApp()
  try {
    app.mcp.setEnabled(BUILTIN_SERVER_ID, false)
    const preflight = app.mcp.preflight(BUILTIN_SERVER_ID, 'aetheris.hardware')
    assert.equal(preflight.allowed, false)
    assert.ok(preflight.reasons.some((reason) => /is disabled/.test(reason)))
    await assert.rejects(app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.hardware', {}), McpError)
    // Discovery skips disabled servers entirely.
    assert.deepEqual(app.mcp.listTools({ serverId: BUILTIN_SERVER_ID }), [])

    app.mcp.setEnabled(BUILTIN_SERVER_ID, true)
    assert.equal(app.mcp.preflight(BUILTIN_SERVER_ID, 'aetheris.hardware').allowed, true)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// The guarantees that matter most
// ---------------------------------------------------------------------------

test('invoking every built-in capability opens no network connection', async () => {
  const { app, close } = await makeApp({ AETHERIS_POLICY: 'strict_offline' })
  const guarded = globalThis.fetch
  const attempted = []
  globalThis.fetch = async (url) => {
    attempted.push(typeof url === 'string' ? url : url?.url ?? String(url))
    throw new Error('a built-in capability reached for the network')
  }
  try {
    await app.knowledge.ingestText({ title: 'Offline Note', text: 'Nothing here needs the network.', classification: 'internal' })
    app.godCore.submit({ prompt: 'a task to cancel offline' })

    for (const plugin of app.plugins.list()) {
      for (const capability of plugin.capabilities) {
        const input = capability.name === 'knowledge.search' ? { query: 'network' } : {}
        const result = await app.plugins.invoke(plugin.id, capability.name, input)
        assert.equal(result.ok, true, `${plugin.id}:${capability.name} should succeed offline`)
      }
    }

    const taskId = app.godCore.list()[0].id
    await app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.hardware', {})
    await app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.knowledge.search', { query: 'network' })
    await app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.knowledge.ingest', { title: 'Another', text: 'Still local.' }, { approvals: [SCOPES.KNOWLEDGE_WRITE] })
    await app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.task.cancel', { taskId }, { approvals: [`${BUILTIN_SERVER_ID}:aetheris.task.cancel`] })

    assert.deepEqual(attempted, [], 'no built-in capability may touch the network')
  } finally {
    globalThis.fetch = guarded
    await close()
  }
})

test('built-in handler output is plain serialisable data', async () => {
  const { app, close } = await makeApp()
  try {
    await app.knowledge.ingestText({ title: 'Shape Check', text: 'Some text to index for the shape check.', classification: 'internal' })
    const outputs = []
    for (const plugin of app.plugins.list()) {
      for (const capability of plugin.capabilities) {
        const input = capability.name === 'knowledge.search' ? { query: 'shape check' } : {}
        outputs.push((await app.plugins.invoke(plugin.id, capability.name, input)).output)
      }
    }
    outputs.push((await app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.hardware', {})).output)
    outputs.push((await app.mcp.callTool(BUILTIN_SERVER_ID, 'aetheris.knowledge.search', { query: 'shape' })).output)

    for (const output of outputs) {
      assert.ok(!containsLiveReference(output), 'handler output must not contain a function, controller or promise')
      // A JSON round-trip must be lossless, which is what makes the output safe to
      // send to a browser or into a model prompt.
      assert.deepEqual(JSON.parse(JSON.stringify(output)), output)
    }
  } finally {
    await close()
  }
})

test('built-in registration is recorded in the audit ledger', async () => {
  const { app, close } = await makeApp()
  try {
    const entries = app.ledger.query({ limit: 100 })
    const startupIndex = entries.findIndex((entry) => entry.action === 'startup')
    assert.ok(startupIndex >= 0)
    const registrations = entries.filter((entry) => entry.action === 'server_register' || (entry.category === 'plugin' && entry.action === 'install'))
    assert.ok(registrations.length >= 3, `expected two plugin installs and one server registration, got ${registrations.length}`)
    assert.ok(
      registrations.some((entry) => entry.action === 'server_register' && entry.detail?.server === BUILTIN_SERVER_ID),
      'the MCP server registration is audited',
    )
  } finally {
    await close()
  }
})
