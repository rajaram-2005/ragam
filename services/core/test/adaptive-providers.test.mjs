// Phase 6: the model and provider fabric.
//
// The acceptance criteria this phase was written down with, and both are about refusal:
//
//   1. "routing refuses a request the available capabilities cannot serve rather than degrading
//      silently";
//   2. "offline mode makes no network call (already tested for the existing path)".
//
// The second criterion applies to the *new* path here, and the new path has a trap the existing
// one does not: the fabric's own status reporting probes providers, and probing an external
// provider is a network call. So the tests use the real egress guard and a probe counter, and
// assert on the counter -- not on the absence of an exception, which would pass even if a request
// had gone out and failed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { FABRIC_AVAILABILITY, PROVIDER_KINDS, ProviderFabric, ProviderFabricError } from '../src/adaptive/providers.mjs'
import { CapabilityRegistry } from '../src/adaptive/registry.mjs'
import { planSteps } from '../src/adaptive/plan.mjs'
import { createEgressGuard, RUNTIME_POLICIES, ALLOW_ALL_HOSTS } from '../src/policy/egress.mjs'

const guardFor = (policy, { onlineAllowlist = [] } = {}) => createEgressGuard({ policy, onlineAllowlist })

/** An adapter whose probe records that it was called, which is what "no network call" means. */
function spyProvider({ availability = 'ready', detail = 'stub', raise = null } = {}) {
  const calls = []
  return {
    calls,
    probe: async () => {
      calls.push(Date.now())
      if (raise) throw raise
      return { availability, detail }
    },
  }
}

const CHAT_ONLY = ['chat.completion']

// ---------------------------------------------------------------------------------------
// 1. Registration: what an adapter is allowed to declare.
// ---------------------------------------------------------------------------------------

test('an adapter declares what it can serve, and a declaration that misleads is refused', () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  const registered = fabric.register({
    id: 'ollama.llama3',
    kind: PROVIDER_KINDS.LOCAL,
    capabilities: ['chat.completion', 'chat.stream'],
    provider: spyProvider(),
    limits: { contextTokens: 8192 },
    notes: ['sampled output at temperature 0.7'],
  })
  assert.deepEqual(registered.capabilities, ['chat.completion', 'chat.stream'])
  assert.equal(registered.privacy, 'local-only')

  const refusals = [
    [{ id: 'Bad.Id', kind: 'local', capabilities: CHAT_ONLY }, 'invalid_id'],
    [{ id: 'ok.local', kind: 'peer', capabilities: CHAT_ONLY }, 'invalid_kind'],
    [{ id: 'ok.local', kind: 'local', capabilities: [] }, 'no_capabilities'],
    [{ id: 'ok.local', kind: 'local', capabilities: ['chat'] }, 'invalid_capability_tag'],
    // An external adapter claiming to be local-only is a false claim about where data goes.
    [{ id: 'ok.remote', kind: 'external', capabilities: CHAT_ONLY, privacy: 'local-only' }, 'privacy_mismatch'],
    [{ id: 'ok.local', kind: 'local', capabilities: CHAT_ONLY, privacy: 'external' }, 'privacy_mismatch'],
  ]
  for (const [input, code] of refusals) {
    assert.throws(() => fabric.register(input), (error) => error instanceof ProviderFabricError && error.code === code,
      `${JSON.stringify(input)} should be ${code}`)
  }
  fabric.register({ id: 'ok.local', kind: PROVIDER_KINDS.LOCAL, capabilities: CHAT_ONLY })
  assert.throws(() => fabric.register({ id: 'ok.local', kind: 'local', capabilities: CHAT_ONLY }), (e) => e.code === 'duplicate_provider')
  // Model names contain colons, capability ids do not, and the refusal says why rather than
  // failing later inside the capability validator.
  assert.throws(
    () => fabric.register({ id: 'ollama:llama3', kind: 'local', capabilities: CHAT_ONLY }),
    (error) => error.code === 'invalid_id' && /colon/.test(error.message),
  )
})

// ---------------------------------------------------------------------------------------
// 2. Acceptance: routing refuses what the available capabilities cannot serve.
// ---------------------------------------------------------------------------------------

test('acceptance: a capability nothing declares is refused, with the list of what is declared', () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({ id: 'inproc.klyvaron-mini', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: ['chat.completion'], invoke: () => ({}) })
  assert.deepEqual(fabric.missing(['image.generate', 'video.generate']), ['image.generate', 'video.generate'])
  assert.throws(
    () => fabric.route(['image.generate']),
    (error) => error.code === 'no_capability'
      && /no provider declares image\.generate/.test(error.message)
      && /knows about chat\.completion/.test(error.message)
      && error.detail.missing[0] === 'image.generate',
    'the refusal must name the missing capability and what is available instead',
  )
  // And nothing was substituted: the refusal happened instead of routing to the chat provider.
  assert.equal(fabric.get('inproc.klyvaron-mini').capabilities.includes('image.generate'), false)
})

test('acceptance: nothing is probed that policy forbids, so offline mode makes no call', async () => {
  const guard = guardFor(RUNTIME_POLICIES.STRICT_OFFLINE)
  const fabric = new ProviderFabric({ guard, policy: RUNTIME_POLICIES.STRICT_OFFLINE })
  const external = spyProvider({ availability: 'ready', detail: 'would have answered' })
  const local = spyProvider({ availability: 'ready', detail: 'loopback runtime' })
  fabric.register({ id: 'gateway.faraway', kind: PROVIDER_KINDS.EXTERNAL, capabilities: ['chat.completion', 'image.generate'], provider: external, invoke: () => ({}) })
  fabric.register({ id: 'ollama.local', kind: PROVIDER_KINDS.LOCAL, capabilities: ['chat.completion'], provider: local, invoke: () => ({}) })

  const report = await fabric.probe()
  // The counter is the assertion. `probe()` returning a status for the external adapter would
  // mean a request went out; reporting "unreachable" after failing is exactly the invisible
  // violation this test exists to catch.
  assert.equal(external.calls.length, 0, 'offline mode must not probe an external provider')
  assert.equal(local.calls.length, 1, 'a loopback runtime is not egress, and stays reachable offline')
  assert.deepEqual(report.skipped.map((entry) => entry.id), ['gateway.faraway'])
  assert.equal(report.skipped[0].code, 'egress_policy')
  assert.match(report.skipped[0].reason, /strict_offline/)
  assert.equal(fabric.status('gateway.faraway').status.availability, FABRIC_AVAILABILITY.UNVERIFIED,
    'an unprobed adapter is unverified, never presumed ready')

  // The capability the external adapter would have served is refused rather than degraded to
  // the local one that cannot serve it.
  assert.throws(
    () => fabric.route(['image.generate']),
    (error) => error.code === 'only_external_capability' && /no request leaves this machine/.test(error.message),
  )
  // Naming the provider explicitly gets the reason by name, rather than a generic refusal.
  assert.throws(
    () => fabric.route(CHAT_ONLY, { prefer: 'gateway.faraway' }),
    (error) => error.code === 'preference_not_eligible' && error.detail.rejected[0].code === 'egress_policy',
  )
  // And the same request with the same fabric routes locally without touching the network.
  const routed = fabric.route(CHAT_ONLY)
  assert.equal(routed.chosen.id, 'ollama.local')
  assert.equal(external.calls.length, 0)
})

test('acceptance: the fabric has no way to make a network call of its own', () => {
  // The test above proves that the adapters policy forbids are never contacted. This proves the
  // stronger property that makes the proof survive future edits: the module does no I/O at all,
  // so there is no path in it that could reach the network whatever the policy says. Every byte
  // that leaves this machine leaves it through an adapter, and adapters are only asked when
  // `eligibility()` -- the same function `candidates()` uses -- allows it.
  const source = readFileSync(new URL('../src/adaptive/providers.mjs', import.meta.url), 'utf8')
  const ioPrimitives = [
    /[^.\w]fetch\s*\(/,
    /from\s+['"]node:(http|https|net|tls|dgram|dns)['"]/,
    /require\(['"]node:(http|https|net|tls|dgram|dns)['"]\)/,
    /\bundici\b/,
    /XMLHttpRequest/,
  ]
  for (const pattern of ioPrimitives) {
    assert.doesNotMatch(source, pattern, `providers.mjs must not contain ${pattern}; I/O belongs in the adapter`)
  }
})

test('with an external policy and explicit opt-in, the external adapter is probed once', async () => {
  const guard = guardFor(RUNTIME_POLICIES.ONLINE_ENABLED, { onlineAllowlist: [ALLOW_ALL_HOSTS] })
  const fabric = new ProviderFabric({ guard, policy: RUNTIME_POLICIES.ONLINE_ENABLED })
  const external = spyProvider({ availability: 'ready', detail: 'gateway answered' })
  fabric.register({ id: 'gateway.faraway', kind: PROVIDER_KINDS.EXTERNAL, capabilities: ['image.generate'], provider: external, invoke: () => ({}) })

  // Without the opt-in: eligible by policy, still not used, and the reason says which of the two
  // it was -- "the policy forbids it" and "you did not ask for it" are different problems.
  assert.throws(() => fabric.route(['image.generate']), (error) => error.code === 'no_eligible_provider'
    && /did not opt in to external providers/.test(error.message))
  await fabric.probe({ allowExternal: false })
  assert.equal(external.calls.length, 0)

  await fabric.probe({ allowExternal: true })
  assert.equal(external.calls.length, 1)
  const routed = fabric.route(['image.generate'], { allowExternal: true })
  assert.equal(routed.chosen.id, 'gateway.faraway')
  assert.equal(routed.chosen.privacy, 'external')
})

test('an external adapter with no egress guard is refused, because nothing would be enforcing the policy', () => {
  const fabric = new ProviderFabric({ guard: null, policy: RUNTIME_POLICIES.ONLINE_ENABLED })
  fabric.register({ id: 'gateway.faraway', kind: PROVIDER_KINDS.EXTERNAL, capabilities: ['image.generate'], invoke: () => ({}) })
  assert.throws(
    () => fabric.route(['image.generate'], { allowExternal: true }),
    (error) => error.code === 'no_eligible_provider' && /no egress guard is installed/.test(error.message),
  )
})

test('a request no single adapter covers is refused rather than split across two', () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({ id: 'inproc.klyvaron-mini', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: ['chat.completion'], invoke: () => ({}) })
  fabric.register({ id: 'ollama.vision', kind: PROVIDER_KINDS.LOCAL, capabilities: ['image.understand'], invoke: () => ({}) })
  // Both capabilities exist; they exist in different places. Combining them would answer a
  // different request than the one that was made.
  assert.deepEqual(fabric.missing(['chat.completion', 'image.understand']), [])
  assert.throws(
    () => fabric.route(['chat.completion', 'image.understand']),
    (error) => error.code === 'no_eligible_provider'
      && /but not image\.understand/.test(error.message)
      && error.detail.rejected.some((each) => each.code === 'partial_coverage'),
  )
})

// ---------------------------------------------------------------------------------------
// 3. Availability is measured, never assumed.
// ---------------------------------------------------------------------------------------

test('an adapter that probed as unavailable is excluded with the probe detail, not offered as maybe', async () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({
    id: 'ollama.llama3',
    kind: PROVIDER_KINDS.LOCAL,
    capabilities: CHAT_ONLY,
    provider: spyProvider({ availability: 'not_installed', detail: 'model llama3 is not pulled' }),
    invoke: () => ({}),
  })
  await fabric.probe()
  assert.throws(
    () => fabric.route(CHAT_ONLY),
    (error) => error.code === 'provider_unavailable' && /model llama3 is not pulled/.test(error.message),
  )
  assert.equal(fabric.status('ollama.llama3').status.availability, 'not_installed')
  // A probe that raises is recorded as unreachable with the message, never as ready.
  // `allowUnverified` is the escape hatch for an adapter nobody has probed yet. It must not become
  // a way to route to one whose probe said it does not work: that would overrule the fabric's own
  // measurement, which is the thing the measurement exists to prevent.
  const escape = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  escape.register({ id: 'ollama.not-pulled', kind: PROVIDER_KINDS.LOCAL, capabilities: CHAT_ONLY, provider: spyProvider({ availability: 'not_installed', detail: 'model llama3 is not pulled' }), invoke: () => ({}) })
  escape.register({ id: 'inproc.never-probed', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: CHAT_ONLY, invoke: () => ({}) })
  await escape.probe()
  const allowUnverified = escape.route(CHAT_ONLY, { allowUnverified: true })
  assert.equal(allowUnverified.chosen.id, 'inproc.never-probed', 'an unprobed adapter may be routed to when the caller says so')
  assert.deepEqual(allowUnverified.rejected.map((each) => each.code), ['provider_unavailable'],
    'a failed probe stays a refusal, whatever the caller allows')

  const raising = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  raising.register({ id: 'ollama.broken', kind: PROVIDER_KINDS.LOCAL, capabilities: CHAT_ONLY, provider: spyProvider({ raise: new Error('socket hang up') }), invoke: () => ({}) })
  const report = await raising.probe()
  assert.equal(report.probed[0].availability, 'unreachable')
  assert.match(report.probed[0].detail, /probe raised: socket hang up/)
  assert.throws(() => raising.route(CHAT_ONLY), (error) => error.code === 'provider_unavailable')
})

test('an adapter that was never probed cannot be routed to by accident', async () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({ id: 'inproc.klyvaron-mini', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: CHAT_ONLY, invoke: () => ({}) })
  assert.throws(
    () => fabric.route(CHAT_ONLY),
    (error) => error.code === 'no_eligible_provider' && error.detail.rejected[0].code === 'unverified_provider',
  )
  // Without an adapter there is nothing to probe, and the status says that instead of "ready".
  const report = await fabric.probe()
  assert.equal(report.probed[0].availability, FABRIC_AVAILABILITY.UNVERIFIED)
  assert.match(fabric.status('inproc.klyvaron-mini').status.detail, /nothing here knows whether it works/)
  assert.throws(() => fabric.route(CHAT_ONLY), (error) => error.detail.rejected[0].code === 'unverified_provider')
})

test('declared limits are enforced instead of a context being quietly truncated', async () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({
    id: 'ollama.small',
    kind: PROVIDER_KINDS.LOCAL,
    capabilities: CHAT_ONLY,
    limits: { contextTokens: 2048, maxOutputTokens: 512 },
    provider: spyProvider(),
    invoke: () => ({}),
  })
  await fabric.probe()
  assert.equal(fabric.route(CHAT_ONLY, { needs: { contextTokens: 1024 } }).chosen.id, 'ollama.small')
  assert.throws(
    () => fabric.route(CHAT_ONLY, { needs: { contextTokens: 4096 } }),
    (error) => error.code === 'capability_exceeds_limits' && /needs contextTokens 4096, above the 2048/.test(error.message),
  )
  assert.throws(() => fabric.route(CHAT_ONLY, { needs: { maxOutputTokens: 900 } }), (error) => error.code === 'capability_exceeds_limits')
  // A request that states no needs cannot be checked, and is not assumed to be oversized.
  assert.equal(fabric.route(CHAT_ONLY).chosen.id, 'ollama.small')
})

// ---------------------------------------------------------------------------------------
// 4. Delivery to the adaptive core: descriptors, and the registry the planner reads.
// ---------------------------------------------------------------------------------------

test('eligible adapters become capability descriptors the router and planner can use', async () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({
    id: 'inproc.klyvaron-mini',
    kind: PROVIDER_KINDS.IN_PROCESS,
    capabilities: CHAT_ONLY,
    model: 'klyvaron-mini-lm@0.1.0',
    notes: ['sampled output at temperature 0.7'],
    provider: spyProvider(),
    invoke: () => ({ ok: true }),
  })
  fabric.register({ id: 'ollama.offline-only', kind: PROVIDER_KINDS.LOCAL, capabilities: CHAT_ONLY, provider: spyProvider(), invoke: () => ({}) })
  fabric.register({ id: 'gateway.faraway', kind: PROVIDER_KINDS.EXTERNAL, capabilities: CHAT_ONLY, provider: spyProvider(), invoke: () => ({}) })
  await fabric.probe()

  const { descriptors, rejected, missing } = fabric.executors(CHAT_ONLY)
  assert.equal(missing.length, 0)
  assert.deepEqual(descriptors.map((each) => each.id), ['inproc.klyvaron-mini', 'ollama.offline-only'])
  assert.equal(rejected.length, 1, 'the external adapter is not a candidate offline')
  assert.equal(rejected[0].code, 'egress_policy')
  const descriptor = descriptors[0]
  assert.equal(descriptor.kind, 'model')
  assert.equal(descriptor.privacy, 'local-only')
  assert.equal(descriptor.version, 'klyvaron-mini-lm@0.1.0')
  assert.equal(descriptor.determinism, 'sampled', 'a note saying sampled output must not be described as deterministic')
  assert.deepEqual(descriptor.provides, CHAT_ONLY)
  assert.match(descriptor.limitations.at(-1), /Availability measured by probe\(\): ready/)

  // The planner's registry (Phase 2) accepts them, so a plan can be checked against real
  // providers rather than against a list of intentions.
  const registry = new CapabilityRegistry()
  const registered = fabric.toCapabilityRegistry(registry, CHAT_ONLY)
  assert.deepEqual(registered.map((each) => each.id), ['inproc.klyvaron-mini', 'ollama.offline-only'])
  assert.deepEqual(registry.idsFor('chat.completion'), ['inproc.klyvaron-mini', 'ollama.offline-only'])
  assert.deepEqual(registry.unimplemented(['chat.completion', 'video.generate']), ['video.generate'])
})

test('acceptance: the planner refuses a step whose provider the fabric did not measure', async () => {
  // Criterion (i) again, one layer up: the descriptors come from `executors()`, so a plan can
  // only be built against providers that are registered, eligible and measured -- and a step
  // naming a capability nothing measured is refused at planning time, not answered by a
  // substitute or discovered as a "task failure" after work has been done.
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({
    id: 'inproc.klyvaron-mini',
    kind: PROVIDER_KINDS.IN_PROCESS,
    capabilities: ['chat.completion'],
    provider: spyProvider(),
    invoke: () => ({ ok: true }),
  })
  fabric.register({ id: 'gateway.faraway', kind: PROVIDER_KINDS.EXTERNAL, capabilities: ['image.generate'], provider: spyProvider(), invoke: () => ({}) })
  await fabric.probe()

  const registry = new CapabilityRegistry()
  // Publishing without a request publishes everything the policy allows. The external adapter
  // is left out by the same eligibility check that excludes it from routing, so the planner's
  // registry contains what was measured and nothing else.
  const published = fabric.toCapabilityRegistry(registry, null)
  assert.deepEqual(published.map((each) => each.id), ['inproc.klyvaron-mini'])
  assert.equal(registry.has('image.generate'), false, 'a capability only an external provider offers is not in the planner registry')
  const resolvable = Object.freeze({
    resolved: true,
    request: 'answer a question about this repository',
    capabilities: ['chat.completion'],
    confidence: 'stated',
  })
  const plan = planSteps({ intent: resolvable, registry, steps: [{ id: 'answer', capability: 'chat.completion' }] })
  assert.equal(plan.steps.length, 1)

  const unresolvable = Object.freeze({ ...resolvable, capabilities: ['image.generate'], request: 'draw a diagram' })
  assert.throws(
    () => planSteps({ intent: unresolvable, registry, steps: [{ id: 'draw', capability: 'image.generate' }] }),
    (error) => error.code === 'capability_unavailable' && /image\.generate/.test(error.message)
      && /missing capability, not a failed task/.test(error.message),
  )
})

test('a route that can be chosen but not run is refused, and the refusal says which adapter', async () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({ id: 'inproc.no-invoke', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: CHAT_ONLY, provider: spyProvider() })
  await fabric.probe()
  // Ready and eligible, so `route()` would hand it out and nothing would happen when called.
  assert.equal(fabric.route(CHAT_ONLY).chosen.id, 'inproc.no-invoke')
  assert.throws(
    () => fabric.executors(CHAT_ONLY),
    (error) => error.code === 'no_invoke' && /has no invoke/.test(error.message),
  )
})

test('the status view reports what is registered, what was skipped, and why', async () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({ id: 'inproc.klyvaron-mini', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: CHAT_ONLY, provider: spyProvider() })
  fabric.register({ id: 'gateway.faraway', kind: PROVIDER_KINDS.EXTERNAL, capabilities: ['image.generate'], provider: spyProvider() })
  fabric.register({ id: 'ollama.off', kind: PROVIDER_KINDS.LOCAL, capabilities: CHAT_ONLY, enabled: false })
  await fabric.probe()
  const status = fabric.status()
  assert.deepEqual(status.map((each) => each.id).sort(), ['gateway.faraway', 'inproc.klyvaron-mini', 'ollama.off'])
  const byId = new Map(status.map((each) => [each.id, each]))
  assert.equal(byId.get('inproc.klyvaron-mini').status.availability, 'ready')
  assert.equal(byId.get('gateway.faraway').status.availability, FABRIC_AVAILABILITY.UNVERIFIED)
  assert.equal(byId.get('gateway.faraway').privacy, 'external')
  assert.equal(byId.get('ollama.off').enabled, false)
  assert.deepEqual(fabric.declaredCapabilities(), ['chat.completion', 'image.generate'])
  // A disabled adapter is refused by name rather than disappearing from the list.
  assert.throws(() => fabric.route(CHAT_ONLY, { prefer: 'ollama.off' }), (error) => error.code === 'preference_not_eligible'
    && error.detail.rejected.some((each) => each.code === 'provider_disabled'))
})

test('a preference for an eligible provider is honoured, and an ineligible one is refused by name', async () => {
  const fabric = new ProviderFabric({ guard: guardFor(RUNTIME_POLICIES.STRICT_OFFLINE) })
  fabric.register({ id: 'inproc.a', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: CHAT_ONLY, provider: spyProvider(), invoke: () => ({}) })
  fabric.register({ id: 'inproc.b', kind: PROVIDER_KINDS.IN_PROCESS, capabilities: CHAT_ONLY, provider: spyProvider(), invoke: () => ({}) })
  await fabric.probe()
  const routed = fabric.route(CHAT_ONLY, { prefer: 'inproc.b' })
  assert.equal(routed.chosen.id, 'inproc.b')
  assert.equal(routed.candidates.length, 2, 'both are handed to the router, which chooses by measurement')
  assert.match(routed.because, /2 providers serve this request/)
  assert.throws(() => fabric.route(CHAT_ONLY, { prefer: 'inproc.c' }), (error) => error.code === 'preference_not_eligible')
  assert.throws(() => fabric.route([]), (error) => error.code === 'no_capabilities')
})
