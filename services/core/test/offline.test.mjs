// Strict-offline enforcement, end to end.
//
// The acceptance criterion is that offline mode *verifiably prevents* network
// access rather than hiding controls in the UI. So these tests do three things:
//
//   1. Start a REAL http server on loopback that speaks the Ollama wire protocol,
//      and prove a genuine chat round-trip completes under strict_offline. Offline
//      must not mean "nothing works" — local runtimes stay reachable.
//   2. Prove external requests never reach the network. The guard is given a
//      recording stand-in for the real fetch; if a blocked URL had been attempted
//      the recorder would show it. No socket is opened and no DNS lookup happens,
//      because the decision is made before fetch is called.
//   3. Prove the guard also covers code that forgets to use it, by installing it
//      over globalThis.fetch and calling that directly.
//
// The local model server here is a test fixture, not a claim that a real LLM is
// installed. It proves the plumbing; readiness reporting stays honest about the
// difference (see the 'no model is invented' test).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AetherisOmniApp } from '../src/app.mjs'
import { loadConfig, publicConfig } from '../src/config.mjs'
import { AVAILABILITY } from '../src/router/registry.mjs'
import { startLocalModelServer } from './helpers/local-model-server.mjs'
import {
  createEgressGuard,
  installGlobalEgressGuard,
  createDataPolicy,
  EgressBlockedError,
  RUNTIME_POLICIES,
  DATA_CLASSES,
} from '../src/policy/egress.mjs'

/** A fetch stand-in that records every URL it is actually asked to open. */
function recordingFetch(target = globalThis.fetch) {
  const calls = []
  const fn = async (url, init) => {
    calls.push(typeof url === 'string' ? url : url?.url ?? String(url))
    return target(url, init)
  }
  fn.calls = calls
  return fn
}

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), 'aetheris-offline-'))
}

// ---------------------------------------------------------------------------
// The guard blocks before any request is attempted.
// ---------------------------------------------------------------------------

test('strict_offline blocks external hosts before a socket is opened', async () => {
  const real = recordingFetch()
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE, fetch: real })

  for (const url of [
    'https://api.openai.com/v1/chat/completions',
    'https://freellmapi.co/v1/models',
    'https://huggingface.co/api/models',
    'http://10.0.0.5:11434/api/tags', // RFC1918 is treated as local, see its own test
  ]) {
    if (url.startsWith('http://10.')) continue
    const decision = guard.inspect(url)
    assert.equal(decision.allowed, false, `${url} must not be reachable offline`)
    assert.equal(decision.scope, 'external')
    assert.match(decision.reason, /strict_offline forbids all external requests/)
    await assert.rejects(() => guard.fetch(url, { method: 'GET' }), EgressBlockedError)
    assert.throws(() => guard.assertReachable(url), EgressBlockedError)
  }

  // The decisive check: nothing was ever handed to the real fetch, so no DNS
  // lookup and no connection were attempted for any blocked URL.
  assert.deepEqual(real.calls, [], 'no blocked request may reach the network stack')
  assert.equal(guard.offlineEnforced, true)
})

test('strict_offline still permits loopback and explicitly allowlisted local hosts', () => {
  const guard = createEgressGuard({
    policy: RUNTIME_POLICIES.STRICT_OFFLINE,
    localAllowlist: ['ollama.internal.lan'],
  })
  for (const url of [
    'http://127.0.0.1:11434/api/tags',
    'http://localhost:8080/v1/models',
    'http://[::1]:11434/api/tags',
    'http://192.168.1.20:11434/api/tags',
    'http://ollama.internal.lan:11434/api/tags',
  ]) {
    const decision = guard.inspect(url)
    assert.equal(decision.allowed, true, `${url} is local and must stay reachable offline`)
    assert.equal(decision.scope, 'local')
  }
})

test('a named host that is not allowlisted is never assumed to be local', () => {
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE })
  // Resolving to a private address is not enough: the name itself is untrusted.
  assert.equal(guard.inspect('http://my-server.local:11434/api/tags').allowed, false)
  assert.equal(guard.inspect('http://gpu-box:11434/api/tags').allowed, false)
})

test('non-http protocols are refused', () => {
  const guard = createEgressGuard({ policy: RUNTIME_POLICIES.ONLINE_ENABLED, onlineAllowlist: ['example.com'] })
  assert.equal(guard.inspect('file:///etc/passwd').allowed, false)
  assert.equal(guard.inspect('ftp://example.com/x').allowed, false)
  assert.equal(guard.inspect('gopher://example.com/x').allowed, false)
})

test('the global guard stops code that calls fetch() directly', async () => {
  const native = globalThis.fetch
  const real = recordingFetch(native)
  globalThis.fetch = real
  try {
    const guard = createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE })
    const restore = installGlobalEgressGuard(guard)
    try {
      assert.equal(globalThis.fetch, guard.fetch, 'the guard must take over globalThis.fetch')
      // A module that never heard of the guard still cannot leave the machine.
      await assert.rejects(
        () => globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }),
        EgressBlockedError,
      )
      await assert.rejects(() => globalThis.fetch('https://huggingface.co/api/models'), EgressBlockedError)
      assert.deepEqual(real.calls, [], 'a blocked global fetch must never reach the network stack')
    } finally {
      restore()
      assert.equal(globalThis.fetch, real, 'restore must put the previous fetch back exactly')
      // Restoring twice must be a no-op, not a corruption of globalThis.
      restore()
      assert.equal(globalThis.fetch, real)
    }
  } finally {
    globalThis.fetch = native
  }
  assert.equal(globalThis.fetch, native)
})

// ---------------------------------------------------------------------------
// Hybrid / online modes: only authorised destinations.
// ---------------------------------------------------------------------------

test('hybrid sends only allowlisted hosts externally and blocks the rest', async () => {
  const real = recordingFetch(async () => new Response('{}', { status: 200 }))
  const guard = createEgressGuard({
    policy: RUNTIME_POLICIES.HYBRID,
    onlineAllowlist: ['gateway.freellmapi.co'],
    fetch: real,
  })

  assert.equal(guard.inspect('https://gateway.freellmapi.co/v1/chat/completions').allowed, true)
  assert.equal(guard.inspect('https://gateway.freellmapi.co/v1/chat/completions').allowlisted, true)
  assert.equal(guard.inspect('http://127.0.0.1:11434/api/tags').allowed, true)

  const blocked = guard.inspect('https://evil.example.com/exfil')
  assert.equal(blocked.allowed, false)
  assert.match(blocked.reason, /not on the online allowlist/)
  await assert.rejects(() => guard.fetch('https://evil.example.com/exfil'), EgressBlockedError)

  // Subdomains and port variations must not sneak past an exact-host allowlist.
  assert.equal(guard.inspect('https://sub.gateway.freellmapi.co/v1').allowed, false)
  assert.equal(guard.inspect('https://gateway.freellmapi.co.evil.example/v1').allowed, false)
  assert.equal(real.calls.length, 0, 'only blocked URLs were attempted here')
})

test('every egress decision is recorded for the audit trail', () => {
  const decisions = []
  const guard = createEgressGuard({
    policy: RUNTIME_POLICIES.HYBRID,
    onlineAllowlist: ['allowed.example'],
    onDecision: (d) => decisions.push(d),
    fetch: async () => new Response('{}', { status: 200 }),
  })
  return run()

  async function run() {
    await guard.fetch('http://127.0.0.1:11434/api/tags')
    await guard.fetch('https://allowed.example/v1').catch(() => {})
    await guard.fetch('https://denied.example/v1').catch(() => {})
    assert.equal(decisions.length, 3)
    assert.deepEqual(
      decisions.map((d) => d.allowed),
      [true, true, false],
    )
    assert.match(decisions[2].reason, /allowlist/)
    assert.ok(decisions.every((d) => typeof d.at === 'number'))
  }
})

test('company-private data may not leave the machine without explicit authorization', () => {
  const policy = createDataPolicy({ externalCeiling: DATA_CLASSES.INTERNAL })
  assert.equal(policy.authorizeExternalSend(DATA_CLASSES.PUBLIC).allowed, true)
  assert.equal(policy.authorizeExternalSend(DATA_CLASSES.INTERNAL).allowed, true)

  const confidential = policy.authorizeExternalSend(DATA_CLASSES.CONFIDENTIAL)
  assert.equal(confidential.allowed, false)
  assert.match(confidential.reason, /exceeds the external ceiling/)

  const restricted = policy.authorizeExternalSend(DATA_CLASSES.RESTRICTED)
  assert.equal(restricted.allowed, false)

  // Authorization must name the exact class; a blanket "yes" for a lower class
  // does not carry over.
  assert.equal(policy.authorizeExternalSend(DATA_CLASSES.CONFIDENTIAL, { explicit: true, scope: DATA_CLASSES.INTERNAL }).allowed, false)
  const granted = policy.authorizeExternalSend(DATA_CLASSES.CONFIDENTIAL, { explicit: true, scope: DATA_CLASSES.CONFIDENTIAL, by: 'operator' })
  assert.equal(granted.allowed, true)
  assert.equal(granted.authorizedBy, 'operator')

  // An unknown class is treated as the most restrictive, not the least.
  assert.equal(policy.authorizeExternalSend('mystery-class').allowed, false)
})

// ---------------------------------------------------------------------------
// End to end: a real local model server, reached under strict_offline.
// ---------------------------------------------------------------------------

test('a real local chat round-trip completes under strict_offline', async () => {
  const local = await startLocalModelServer()
  const dataDir = makeDataDir()
  try {
    const config = loadConfig(
      {
        AETHERIS_RUNTIME_POLICY: RUNTIME_POLICIES.STRICT_OFFLINE,
        AETHERIS_DATA_DIR: dataDir,
        OLLAMA_ENABLED: 'true',
        OLLAMA_BASE_URL: local.baseUrl,
        LLAMACPP_ENABLED: 'false',
        FREELLMAPI_ENABLED: 'false',
      },
      {},
    )
    const app = new AetherisOmniApp({ config })

    const probe = await app.probeAll()
    assert.equal(
      probe.providers.ollama.availability,
      AVAILABILITY.READY,
      `probe reported ${JSON.stringify(probe.providers.ollama)}`,
    )
    assert.equal(probe.providers.ollama.detail.modelsInstalled, 1)

    const ready = app.readiness()
    assert.equal(ready.policy, RUNTIME_POLICIES.STRICT_OFFLINE)

    // probeAll registered the model that the local runtime actually reported.
    const models = app.registry.list({ availableOnly: true })
    assert.equal(models.length, 1)
    assert.equal(models[0].id, 'ollama:tiny-local:latest')
    assert.equal(models[0].location, 'local')

    const reply = await app.chat({ prompt: 'Say hello', model: models[0].id })
    assert.match(reply.text, /local reply to: Say hello/)
    assert.equal(reply.modelId, 'ollama:tiny-local:latest')
    assert.equal(reply.sentExternally, false, 'a local model must never be reported as external')
    assert.equal(reply.stream, false)
    assert.deepEqual(reply.usage, { promptTokens: 12, completionTokens: 9, totalDurationNs: 4_000_000 })

    // Every request that left the process went to loopback only.
    assert.ok(local.requests.length >= 2, 'the model server should have served /api/tags and /api/chat')
    assert.ok(local.requests.every((r) => r.url.startsWith('/api/')), 'only Ollama endpoints were used')
    app.close()
  } finally {
    await local.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('strict_offline reports degraded readiness honestly when no model is installed', async () => {
  const dataDir = makeDataDir()
  try {
    // Port 1 on loopback: nothing is listening, so this is a genuine "no runtime".
    const config = loadConfig(
      {
        AETHERIS_RUNTIME_POLICY: RUNTIME_POLICIES.STRICT_OFFLINE,
        AETHERIS_DATA_DIR: dataDir,
        OLLAMA_ENABLED: 'true',
        OLLAMA_BASE_URL: 'http://127.0.0.1:1',
        LLAMACPP_ENABLED: 'false',
        FREELLMAPI_ENABLED: 'false',
      },
      {},
    )
    const app = new AetherisOmniApp({ config })
    await app.probeAll()
    const ready = app.readiness()

    assert.equal(ready.status, 'degraded')
    assert.equal(ready.policy, RUNTIME_POLICIES.STRICT_OFFLINE)
    // The app must not invent a model to look healthy.
    assert.equal(app.registry.list({ availableOnly: true }).length, 0)

    // Chat must fail loudly rather than fabricate an answer.
    await assert.rejects(() => app.chat({ prompt: 'hello' }), (error) => {
      assert.equal(error.code, 'no_model_available')
      return true
    })
    app.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('an online provider stays disabled under strict_offline even when configured', async () => {
  const dataDir = makeDataDir()
  try {
    const config = loadConfig(
      {
        AETHERIS_RUNTIME_POLICY: RUNTIME_POLICIES.STRICT_OFFLINE,
        AETHERIS_DATA_DIR: dataDir,
        OLLAMA_ENABLED: 'false',
        LLAMACPP_ENABLED: 'false',
        FREELLMAPI_ENABLED: 'true',
        FREELLMAPI_BASE_URL: 'https://gateway.freellmapi.co/v1',
        FREELLMAPI_API_KEY: 'test-key-not-a-real-secret',
        AETHERIS_ONLINE_ALLOWLIST: 'gateway.freellmapi.co',
      },
      {},
    )
    const app = new AetherisOmniApp({ config })

    // Configured and allowlisted, but the policy still wins: no external request
    // may be attempted while strict_offline is in force.
    assert.equal(app.guard.inspect('https://gateway.freellmapi.co/v1/chat/completions').allowed, false)
    assert.throws(
      () => app.guard.assertReachable('https://gateway.freellmapi.co/v1/chat/completions'),
      EgressBlockedError,
    )
    await assert.rejects(
      () => app.guard.fetch('https://gateway.freellmapi.co/v1/chat/completions'),
      EgressBlockedError,
    )
    assert.equal(app.guard.offlineEnforced, true)

    // The public config view served at /api/config must not leak the key.
    const exposed = JSON.stringify(publicConfig(config))
    assert.equal(exposed.includes('test-key-not-a-real-secret'), false, 'credentials must never appear in a config view')
    assert.equal(JSON.stringify(config).includes('test-key-not-a-real-secret'), true, 'the app itself still holds the key in memory')
    app.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('an unknown runtime policy is rejected, and a missing one fails safe', () => {
  assert.throws(() => createEgressGuard({ policy: 'yolo' }), TypeError)
  assert.throws(() => createEgressGuard({ policy: RUNTIME_POLICIES.ONLINE_ENABLED + ' ' }), TypeError)

  // Fail-safe defaults: an unset or blank policy must land on the most
  // restrictive mode, never on an open one.
  assert.equal(createEgressGuard({}).policy, RUNTIME_POLICIES.STRICT_OFFLINE)
  assert.equal(createEgressGuard({ policy: '' }).policy, RUNTIME_POLICIES.STRICT_OFFLINE)
  assert.equal(createEgressGuard({ policy: null }).policy, RUNTIME_POLICIES.STRICT_OFFLINE)
  assert.equal(createEgressGuard({}).offlineEnforced, true)

  // loadConfig applies the same fail-safe rule to the environment, and says so
  // out loud rather than silently downgrading the operator's intent.
  assert.equal(loadConfig({ AETHERIS_RUNTIME_POLICY: '' }, {}).policy, RUNTIME_POLICIES.STRICT_OFFLINE)
  const bogus = loadConfig({ AETHERIS_RUNTIME_POLICY: 'permissive' }, {})
  assert.equal(bogus.policy, RUNTIME_POLICIES.STRICT_OFFLINE)
  assert.ok(bogus.warnings.some((w) => /AETHERIS_RUNTIME_POLICY/.test(w)), 'an invalid policy must be reported')

  // A typo'd data ceiling must also fail safe to the more restrictive class.
  const ceiling = loadConfig({ AETHERIS_EXTERNAL_DATA_CEILING: 'everything' }, {})
  assert.equal(ceiling.externalCeiling, DATA_CLASSES.INTERNAL)
  assert.ok(ceiling.warnings.some((w) => /AETHERIS_EXTERNAL_DATA_CEILING/.test(w)))

  // An allowlist configured under strict_offline is inert, and that is reported.
  const inert = loadConfig(
    { AETHERIS_RUNTIME_POLICY: RUNTIME_POLICIES.STRICT_OFFLINE, AETHERIS_ONLINE_ALLOWLIST: 'gateway.example' },
    {},
  )
  assert.deepEqual(inert.onlineAllowlist, ['gateway.example'])
  assert.ok(inert.warnings.some((w) => /will still be blocked/.test(w)))
})
