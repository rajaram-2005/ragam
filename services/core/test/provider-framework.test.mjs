// The provider framework: a catalogue that cannot promote itself, a selector that refuses by
// name, and error normalisation that cannot leak the credential that caused the error.
//
// The acceptance tests here are the ones the master prompt's rules imply, restated as executable
// claims:
//
//   * a provider cannot claim a capability this build does not implement;
//   * strict offline policy never selects a remote provider;
//   * a successful connection is not evidence of a capability (so a `gateway_only` entry cannot be
//     selected even if a vendor documents the feature);
//   * nothing a catalogue returns can contain a credential.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTH_KINDS,
  CAPABILITIES,
  PROVIDER_STATUS,
  PROVIDERS,
  WIRE_FORMATS,
  catalogueReport,
  describeProvider,
  providerById,
  providersByStatus,
  validateCatalogue,
  validateProvider,
} from '../src/providers/catalog.mjs'
import { REFUSAL_CODES, capabilityMatrix, selectProvider } from '../src/providers/select.mjs'
import {
  PROVIDER_ERROR_CODES,
  adviceFor,
  normaliseProviderError,
  redact,
  retryAfterMs,
} from '../src/providers/errors.mjs'

const valid = {
  id: 'example',
  label: 'Example',
  category: 'vendor',
  wire: WIRE_FORMATS.OPENAI_CHAT,
  auth: AUTH_KINDS.BEARER,
  credential: 'api_key',
  status: PROVIDER_STATUS.PENDING,
  docsUrl: 'https://example.test/docs',
  capabilities: [],
  egress: { https: true, operatorConfigured: false },
  notes: 'fixture',
}

test('the shipped catalogue validates, with unique ids', () => {
  const verdict = validateCatalogue()
  assert.equal(verdict.valid, true, verdict.problems.join('; '))
  assert.equal(new Set(PROVIDERS.map((provider) => provider.id)).size, PROVIDERS.length)
  for (const provider of PROVIDERS) assert.match(provider.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('acceptance: a provider cannot claim a capability this build does not implement', () => {
  // A ready entry backed by a vendor document rather than a test is exactly the promotion this
  // framework exists to prevent.
  const advertised = validateProvider({
    ...valid,
    status: PROVIDER_STATUS.READY,
    capabilities: [{ id: CAPABILITIES.TOOLS, source: 'vendor-doc', ref: 'https://example.test/docs/tools' }],
  })
  assert.equal(advertised.valid, false)
  assert.match(advertised.problems.join('\n'), /ready but 'tools' is not backed by a test/)

  // And a ready entry on a wire with no adapter is refused too. Every wire this build publishes is
  // implemented now, so the fixture names one that is not in WIRE_FORMATS at all.
  const wrongWire = validateProvider({
    ...valid,
    wire: 'no_such_wire',
    credential: 'api_key',
    status: PROVIDER_STATUS.READY,
    capabilities: [{ id: CAPABILITIES.STREAMING, source: 'test', ref: 'test/example.test.mjs' }],
  })
  assert.equal(wrongWire.valid, false)
  assert.match(wrongWire.problems.join('\n'), /wire this build does not implement/)

  // A capability with no evidence at all is not a capability.
  const noEvidence = validateProvider({ ...valid, capabilities: [{ id: CAPABILITIES.STREAMING }] })
  assert.equal(noEvidence.valid, false)
  assert.match(noEvidence.problems.join('\n'), /no recognised evidence source/)
})

test('acceptance: strict offline policy never selects a remote provider', () => {
  const decision = selectProvider(
    { capabilities: [CAPABILITIES.STREAMING], remote: true },
    { offline: true },
  )
  assert.equal(decision.chosen, null)
  assert.match(decision.explanation, /strict offline policy/i)
})

test('acceptance: a successful connection is not evidence of a capability', () => {
  // Every OpenAI-compatible vendor is `gateway_only`: the wire is implemented, the vendor is not.
  // Asking one of them for a capability is refused even though the vendor documents it.
  for (const id of providersByStatus(PROVIDER_STATUS.GATEWAY_ONLY).slice(0, 3)) {
    const decision = selectProvider({ capabilities: [CAPABILITIES.STREAMING], ids: [id] })
    assert.equal(decision.chosen, null, `${id} should not be selectable`)
    assert.equal(decision.rejected[0].code, REFUSAL_CODES.WIRE_NOT_IMPLEMENTED)
  }
  // A pending adapter that hypothetically declares everything is still refused by status.
  const pending = [{ ...valid, status: PROVIDER_STATUS.PENDING, capabilities: [] }]
  const decision = selectProvider({ capabilities: [CAPABILITIES.STREAMING] }, {}, {}, pending)
  assert.equal(decision.chosen, null)
  assert.equal(decision.rejected[0].code, REFUSAL_CODES.ADAPTER_PENDING)
})

test('acceptance: nothing the catalogue returns can contain a credential', () => {
  // The guarantee is structural — descriptors have no credential field — so the validator must
  // refuse one that is smuggled in.
  for (const key of ['apiKey', 'key', 'token', 'secret']) {
    const verdict = validateProvider({ ...valid, [key]: 'sk-live-should-never-be-here' })
    assert.equal(verdict.valid, false, `${key} was accepted`)
    assert.match(verdict.problems.join('\n'), /unknown field/)
  }
  // `credential` is a kind, never a value: a secret pasted into it is refused as an unknown kind.
  const smuggled = validateProvider({ ...valid, credential: 'sk-live-should-never-be-here' })
  assert.equal(smuggled.valid, false)
  assert.match(smuggled.problems.join('\n'), /is not a known kind/)
  const described = describeProvider('litellm')
  assert.equal(described.credential, 'api_key')
  const { credential, ...rest } = described
  assert.ok(!/sk-|bearer [a-z0-9]{8,}|api[_-]?key/i.test(JSON.stringify(rest)))
})

test('a ready provider is chosen only for capabilities it evidences by test', () => {
  const decision = selectProvider({ capabilities: [CAPABILITIES.STREAMING] })
  assert.ok(decision.chosen)
  assert.equal(decision.chosen.id, 'litellm')
  assert.equal(decision.chosen.health, 'unverified', 'selection is not a health check')
  assert.deepEqual(decision.chosen.capabilities, [{ id: CAPABILITIES.STREAMING, evidence: 'test' }])
  assert.ok(decision.rejected.length > 0, 'the refused candidates must be reported, not dropped')
  for (const entry of decision.rejected) assert.ok(entry.code && entry.why)
})

test('an unknown context limit does not satisfy a stated requirement', () => {
  const decision = selectProvider({ capabilities: [CAPABILITIES.STREAMING], minContextTokens: 128_000 })
  assert.equal(decision.chosen, null)
  assert.ok(decision.rejected.some((entry) => entry.code === REFUSAL_CODES.CONTEXT_UNKNOWN))
})

test('remote selection requires the installation to opt in, and health is respected', () => {
  const remote = selectProvider({ capabilities: [CAPABILITIES.STREAMING], remote: true })
  assert.equal(remote.chosen, null)
  assert.ok(remote.rejected.every((entry) => [REFUSAL_CODES.REMOTE_NOT_ALLOWED, REFUSAL_CODES.WIRE_NOT_IMPLEMENTED, REFUSAL_CODES.ADAPTER_PENDING, REFUSAL_CODES.CAPABILITY_MISSING].includes(entry.code)))

  const healthy = selectProvider({ capabilities: [CAPABILITIES.STREAMING], remote: true }, { allowRemote: true }, { litellm: 'ready' })
  assert.equal(healthy.chosen.id, 'litellm')
  assert.equal(healthy.chosen.health, 'ready')

  // An unhealthy provider is removed from the field and the reason is reported. Selecting among
  // the remaining *ready* providers is not the forbidden fallback: the caller is choosing before
  // sending, and the decision names what it passed over. Retrying a different recipient *after* a
  // failure is forbidden, and that is a property of the caller, not of this function.
  const unhealthy = selectProvider({ capabilities: [CAPABILITIES.STREAMING] }, {}, { litellm: 'unavailable' })
  assert.equal(unhealthy.chosen.id, 'ollama')
  assert.ok(unhealthy.rejected.some((entry) => entry.id === 'litellm' && entry.code === REFUSAL_CODES.UNHEALTHY))
  // A caller that will not accept a substitution pins the id; then the refusal is total.
  const pinned = selectProvider({ capabilities: [CAPABILITIES.STREAMING], ids: ['litellm'] }, {}, { litellm: 'unavailable' })
  assert.equal(pinned.chosen, null)
  assert.deepEqual(pinned.rejected.map((entry) => entry.code), [REFUSAL_CODES.UNHEALTHY])
})

test('the allowlist is an allowlist: a provider off it is refused, not ranked lower', () => {
  const decision = selectProvider({ capabilities: [CAPABILITIES.STREAMING] }, { allowedHosts: ['ollama'] })
  assert.equal(decision.chosen.id, 'ollama')
  assert.ok(decision.rejected.some((entry) => entry.id === 'litellm' && entry.code === REFUSAL_CODES.REMOTE_NOT_ALLOWED))
})

test('an unknown provider id is refused rather than defaulted', () => {
  assert.throws(() => providerById('freellmapi'), (error) => error.code === 'unknown_provider')
  const decision = selectProvider({ ids: ['not-a-provider'] })
  assert.equal(decision.chosen, null)
  assert.match(decision.explanation, /No provider was offered/)
})

test('the catalogue refuses the excluded aggregator by name', () => {
  // The prompt excludes one specific aggregator; excluding it from the list is not the same as
  // making it unrepresentable, so this asserts it is absent and that a request for it fails.
  assert.equal(PROVIDERS.some((provider) => /freellm/i.test(provider.id + provider.label)), false)
})

test('the report states the three counts and the honest headline', () => {
  const report = catalogueReport()
  assert.equal(report.valid, true)
  assert.equal(report.counts.ready, 9)
  assert.equal(report.counts.gateway_only, 14)
  assert.equal(report.counts.pending, 10)
  assert.match(report.summary, /^9 ready/)
  const matrix = capabilityMatrix()
  assert.equal(matrix.valid, true)
  // Catalogue order, not alphabetical: the matrix is a table a reader compares row by row.
  assert.deepEqual(matrix.tested, [
    'litellm', 'ollama', 'llamacpp', 'anthropic', 'gemini',
    'cohere', 'azure-openai', 'vertex', 'bedrock',
  ])
  assert.ok(matrix.rows.every((row) => row.status !== PROVIDER_STATUS.READY || row.tested.length > 0))
})

test('429 is retryable and honours Retry-After', () => {
  const normalised = normaliseProviderError({ status: 429, headers: { 'retry-after': '7' }, body: 'slow down' })
  assert.equal(normalised.code, PROVIDER_ERROR_CODES.RATE_LIMITED)
  assert.equal(normalised.retryable, true)
  assert.equal(normalised.retryAfterMs, 7_000)
  assert.match(adviceFor(normalised), /7s/)
})

test('an auth failure is permanent, and its body is not echoed', () => {
  const normalised = normaliseProviderError({ status: 401, body: '{"error":"invalid key sk-live-abcdefghijklmnop"}' })
  assert.equal(normalised.code, PROVIDER_ERROR_CODES.AUTH_FAILED)
  assert.equal(normalised.retryable, false)
  // The secret pattern is redacted even inside the short excerpt we do keep.
  assert.ok(!normalised.detail.includes('sk-live-abcdefghijklmnop'))
  assert.match(normalised.detail, /\[redacted\]/)
})

test('a 429 whose body says the account is out of credit is not treated as a rate limit', () => {
  const normalised = normaliseProviderError({ status: 429, body: 'You exceeded your current quota, please check your billing details' })
  assert.equal(normalised.code, PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED)
  assert.equal(normalised.retryable, false)
  assert.match(adviceFor(normalised), /billing and quota/)
})

test('a context-length rejection is recognised and is not retryable', () => {
  const normalised = normaliseProviderError({ status: 400, body: "This model's maximum context length is 8192 tokens" })
  assert.equal(normalised.code, PROVIDER_ERROR_CODES.CONTEXT_LENGTH)
  assert.equal(normalised.retryable, false)
})

test('cancellation, socket failures and unknown errors each get their own code', () => {
  assert.equal(normaliseProviderError({ name: 'AbortError' }).code, PROVIDER_ERROR_CODES.CANCELLED)
  assert.equal(normaliseProviderError({ code: 'ECONNRESET', message: 'socket hang up' }).code, PROVIDER_ERROR_CODES.NETWORK)
  assert.equal(normaliseProviderError({ message: 'something odd' }).code, PROVIDER_ERROR_CODES.UNKNOWN)
  assert.equal(normaliseProviderError({ status: 503 }).retryable, true)
})

test('redaction covers the credential shapes vendors echo back', () => {
  for (const secret of ['sk-live-1234567890abcdef', 'Bearer abcdefghijklmnop', 'api_key=verysecretvalue', 'AKIAIOSFODNN7EXAMPLE', 'AIzaSyA1234567890abcdefghijklmnopqrstuv']) {
    assert.ok(!redact(`failure: ${secret}`).includes(secret), `${secret} survived redaction`)
  }
  // And it does not mangle ordinary prose into uselessness.
  assert.equal(redact('the model is busy'), 'the model is busy')
})

test('Retry-After parses both forms and is bounded', () => {
  assert.equal(retryAfterMs({ 'retry-after': '0' }), 0)
  assert.equal(retryAfterMs({ 'retry-after': '99999' }), 15 * 60_000)
  assert.equal(retryAfterMs({}), null)
  assert.ok(retryAfterMs({ 'retry-after': new Date(Date.now() + 5_000).toUTCString() }) > 0)
})
