import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, PROVIDER_STATUS } from '../src/providers/catalog.mjs'
import {
  EVIDENCE_STATES,
  HEALTH_STATES,
  LIVE_QUALIFICATION_STATES,
  LOCALITY_STATES,
  LOCAL_RUNTIME_IDS,
  PROVIDER_FABRIC_SCHEMA_VERSION,
  buildProviderFabricSnapshot,
  evidenceStateFor,
  explainableRoutingDecision,
  healthStateFor,
  liveQualificationGate,
  localityFor,
  normalizeFabricError,
  normalizeModelDiscovery,
  summarizeMeasurements,
} from '../src/providers/fabric.mjs'

const provider = (id) => PROVIDERS.find((entry) => entry.id === id)

test('Phase 2 evidence vocabulary and local/cloud state stay explicit', () => {
  assert.equal(PROVIDER_FABRIC_SCHEMA_VERSION, 1)
  assert.deepEqual(Object.values(EVIDENCE_STATES), [
    'planned', 'implemented', 'contract-tested', 'live-verified',
    'evaluated', 'production-approved', 'released', 'suspended',
  ])
  assert.ok(LOCAL_RUNTIME_IDS.includes('ollama'))
  assert.equal(localityFor(provider('ollama')).state, LOCALITY_STATES.LOCAL)
  assert.equal(localityFor(provider('openai')).state, LOCALITY_STATES.CLOUD)
  assert.equal(localityFor(provider('diffusers')).state, LOCALITY_STATES.LOCAL)
  assert.equal(localityFor(null).state, LOCALITY_STATES.UNKNOWN)
  assert.equal(evidenceStateFor(provider('openai')), EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(evidenceStateFor(provider('diffusers')), EVIDENCE_STATES.PLANNED)
  assert.equal(evidenceStateFor(provider('openai'), {
    verified: true,
    authorizedLiveCall: true,
    explicitConsent: true,
    evidenceDigest: 'sha256:contract-fixture',
    providerId: 'openai',
  }), EVIDENCE_STATES.LIVE_VERIFIED)
  assert.equal(healthStateFor(provider('openai'), { openai: 'unavailable' }), HEALTH_STATES.UNAVAILABLE)
  assert.equal(healthStateFor(provider('openai')), HEALTH_STATES.CONTRACT_TESTED)
})

test('model discovery separates provider, endpoint and model without inferring capabilities', () => {
  const records = normalizeModelDiscovery([
    {
      id: 'gpt-4o-mini',
      name: 'gpt-4o-mini',
      capabilities: {
        input: ['text'],
        output: ['text'],
        contextTokens: null,
        maxOutputTokens: null,
        streaming: 'unknown',
        tools: 'not_exposed_by_ragam',
        structuredOutput: 'not_exposed_by_ragam',
        imageInput: 'unknown',
        provenance: { source: 'unavailable', provider: 'openai' },
      },
    },
    { name: 'missing-id' },
  ], { providerId: 'openai', endpointId: 'connection-1', endpointConfigured: true })
  assert.equal(records.length, 2)
  assert.equal(records[0].valid, true)
  assert.equal(records[0].providerId, 'openai')
  assert.equal(records[0].endpointId, 'connection-1')
  assert.equal(records[0].modelId, 'gpt-4o-mini')
  assert.equal(records[0].capabilities.contextTokens, null)
  assert.equal(records[0].capabilities.maxOutputTokens, null)
  assert.deepEqual(records[0].capabilities.input, ['text'])
  assert.equal(records[0].capabilityEvidenceState, EVIDENCE_STATES.PLANNED)
  assert.equal(records[0].capabilityValuesAreInferred, false)
  assert.equal(records[0].liveVerified, false)
  assert.equal(records[0].credentialIncluded, false)
  assert.equal(records[1].valid, false)
  assert.equal(records[1].reason, 'missing_model_id')
  assert.doesNotMatch(JSON.stringify(records), /https?:\/\/|"apiKey"|"token"|"secret"|Bearer /i)
})

test('fabric error envelope redacts credentials and preserves explainable retry advice', () => {
  const envelope = normalizeFabricError({
    status: 401,
    body: 'Authorization: Bearer sk-synthetic-test-1234567890',
    headers: {},
  }, {
    provider: provider('openai'),
    providerId: 'openai',
    wire: 'openai_chat',
    modelId: 'gpt-4o-mini',
    traceId: 'trace-phase-2',
  })
  assert.equal(envelope.schemaVersion, 1)
  assert.equal(envelope.code, 'provider_auth_failed')
  assert.equal(envelope.retryable, false)
  assert.equal(envelope.providerId, 'openai')
  assert.equal(envelope.modelId, 'gpt-4o-mini')
  assert.equal(envelope.locality, LOCALITY_STATES.CLOUD)
  assert.equal(envelope.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.match(envelope.advice, /Check the key/)
  assert.equal(envelope.rawBodyIncluded, false)
  assert.equal(envelope.credentialIncluded, false)
  assert.equal(envelope.noSilentSubstitution, true)
  assert.equal(envelope.liveCallPerformed, false)
  const text = JSON.stringify(envelope)
  assert.doesNotMatch(text, /sk-synthetic-test|Bearer sk-/i)
})

test('latency and cost measurements are computed only from supplied samples', () => {
  const summary = summarizeMeasurements([
    { providerId: 'openai', modelId: 'm', latencyMs: 100, success: true, cost: 0.01 },
    { providerId: 'openai', modelId: 'm', latencyMs: 200, success: true, cost: 0.02 },
    { providerId: 'openai', modelId: 'm', latencyMs: 300, success: false, failureCategory: 'timeout' },
  ], { windowMs: 1000, costCurrency: 'USD', safetyChecks: ['redaction'], evidenceArtifact: 'artifact-1' })
  assert.equal(summary.state, 'measured')
  assert.equal(summary.samples, 3)
  assert.equal(summary.successes, 2)
  assert.equal(summary.failures, 1)
  assert.equal(summary.p50Ms, 200)
  assert.equal(summary.p95Ms, 300)
  assert.equal(summary.throughputPerSecond, 3)
  assert.equal(summary.costPerSuccessfulTask, 0.015)
  assert.equal(summary.costCoverage, 1)
  assert.equal(summary.costCurrency, 'USD')
  assert.deepEqual(summary.failureCategories, { timeout: 1 })
  assert.equal(summary.evidenceArtifact, 'artifact-1')
  assert.equal(summary.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(summary.qualityMetric, null)
})

test('benchmark evidence fields remain null when no evaluation was supplied', () => {
  const empty = summarizeMeasurements([], {})
  assert.equal(empty.state, 'not_measured')
  assert.equal(empty.evidenceState, EVIDENCE_STATES.PLANNED)
  assert.equal(empty.p50Ms, null)
  assert.equal(empty.p95Ms, null)
  assert.equal(empty.costPerSuccessfulTask, null)
  assert.equal(empty.qualityMetric, null)
  assert.equal(empty.threshold, null)
  assert.equal(empty.datasetDigest, null)
  assert.equal(empty.testSplit, null)
  assert.equal(empty.hardware, null)
  assert.equal(empty.software, null)
  assert.deepEqual(empty.safetyChecks, [])
  assert.equal(empty.evidenceArtifact, null)

  const incomplete = summarizeMeasurements([
    { latencyMs: 10, success: true },
    { latencyMs: 20, success: true, cost: 0.01 },
  ])
  assert.equal(incomplete.costPerSuccessfulTask, null)
  assert.equal(incomplete.costCoverage, 0.5)
  assert.throws(() => summarizeMeasurements([{ latencyMs: -1, success: true }]), TypeError)
  assert.throws(() => summarizeMeasurements([{ latencyMs: 10, success: 'yes' }]), TypeError)
})

test('live qualification fails closed and never performs a provider call', () => {
  const blocked = liveQualificationGate({
    requested: true,
    explicitConsent: false,
    credentialsPresent: false,
    connectivity: 'unverified',
    wireImplemented: true,
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    locality: LOCALITY_STATES.CLOUD,
    remoteAllowed: true,
    provider: provider('openai'),
  })
  assert.equal(blocked.state, LIVE_QUALIFICATION_STATES.BLOCKED)
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.reasons.includes('consent_required'))
  assert.ok(blocked.reasons.includes('credentials_missing'))
  assert.ok(blocked.reasons.includes('connectivity_unverified'))
  assert.equal(blocked.liveVerified, false)
  assert.equal(blocked.liveCallPerformed, false)
  assert.equal(blocked.credentialValueIncluded, false)

  const notRequested = liveQualificationGate({})
  assert.equal(notRequested.state, LIVE_QUALIFICATION_STATES.NOT_REQUESTED)
  assert.equal(notRequested.allowed, false)
  assert.equal(notRequested.liveCallPerformed, false)

  const ready = liveQualificationGate({
    requested: true,
    explicitConsent: true,
    credentialsPresent: true,
    connectivity: 'reachable',
    wireImplemented: true,
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    locality: LOCALITY_STATES.CLOUD,
    remoteAllowed: true,
    provider: provider('openai'),
  })
  assert.equal(ready.state, LIVE_QUALIFICATION_STATES.READY_FOR_AUTHORIZED_CALL)
  assert.equal(ready.allowed, true)
  assert.equal(ready.liveVerified, false)
  assert.equal(ready.liveCallPerformed, false)
})

test('explainable routing reuses the selector and refuses unsupported capabilities', () => {
  const local = explainableRoutingDecision(
    { capabilities: ['streaming'], remote: false },
    { offline: true },
    {},
    PROVIDERS,
  )
  assert.ok(local.chosen)
  assert.equal(local.chosen.id, 'ollama')
  assert.equal(local.chosen.fabric.locality, LOCALITY_STATES.LOCAL)
  assert.equal(local.chosen.fabric.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(local.chosen.fabric.health, HEALTH_STATES.CONTRACT_TESTED)
  assert.equal(local.chosen.fabric.liveVerified, false)
  assert.equal(local.noSilentSubstitution, true)
  assert.equal(local.liveCallPerformed, false)

  const refused = explainableRoutingDecision(
    { capabilities: ['text.reason'], remote: false },
    { offline: true },
    {},
    PROVIDERS,
  )
  assert.equal(refused.chosen, null)
  assert.ok(refused.rejected.length > 0)
  assert.match(refused.explanation, /No provider can serve this request/)
  assert.equal(refused.noSilentSubstitution, true)
  assert.equal(refused.liveCallPerformed, false)
})

test('provider fabric snapshot contains no credentials, endpoints or live-verification claims', () => {
  const connections = [{
    id: 'openai',
    wire: 'openai_chat',
    unsupported: null,
    baseUrl: 'https://gateway.example/v1',
    keyConfigured: true,
    configured: true,
    models: ['model-a', 'model-b'],
    selectedModel: 'model-a',
    modelDetails: [{
      id: 'model-a',
      name: 'model-a',
      capabilities: {
        input: ['text'],
        output: ['text'],
        contextTokens: 8192,
        maxOutputTokens: 1024,
        streaming: 'unknown',
        tools: 'not_exposed_by_ragam',
        structuredOutput: 'not_exposed_by_ragam',
        imageInput: 'unknown',
        provenance: { source: 'test', provider: 'openai' },
      },
    }],
  }]
  const snapshot = buildProviderFabricSnapshot({
    providers: PROVIDERS,
    connections,
    activeId: 'openai',
    healthChecks: {},
    measurements: [],
    liveQualification: { requested: false },
    routingRequest: null,
  })
  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.catalogueValid, true)
  assert.equal(snapshot.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(snapshot.liveCallPerformed, false)
  assert.equal(snapshot.activeProviderId, 'openai')
  assert.ok(snapshot.counts.total > 40)
  assert.ok(snapshot.counts.local >= 2)
  assert.ok(snapshot.counts.cloud > 0)
  assert.equal(snapshot.counts.liveVerified, 0)
  assert.equal(snapshot.counts.measuredProviders, 0)
  assert.equal(snapshot.liveQualification.state, LIVE_QUALIFICATION_STATES.NOT_REQUESTED)
  assert.equal(snapshot.liveQualification.liveVerified, false)
  assert.equal(snapshot.measurements.state, 'not_measured')
  assert.equal(snapshot.routing.state, 'not_requested')
  assert.equal(snapshot.modelDiscovery.capabilityValuesInferredFromModelName, false)
  assert.equal(snapshot.modelDiscovery.binaryOrWeightPayloadIncluded, false)

  const openai = snapshot.providers.find((entry) => entry.id === 'openai')
  assert.equal(openai.locality, LOCALITY_STATES.CLOUD)
  assert.equal(openai.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(openai.endpointConfigured, true)
  assert.equal(openai.credentialConfigured, true)
  assert.equal(openai.rawEndpointIncluded, false)
  assert.equal(openai.credentialValueIncluded, false)
  assert.equal(openai.modelCount, 2)
  assert.equal(openai.models[0].modelId, 'model-a')
  assert.equal(openai.models[0].capabilities.contextTokens, 8192)
  assert.equal(openai.models[0].capabilityEvidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(openai.liveVerified, false)

  const text = JSON.stringify(snapshot)
  assert.doesNotMatch(text, /gateway\.example|https?:\/\/gateway/i)
  assert.doesNotMatch(text, /synthetic-gateway-secret|"apiKey"|"token"|"secret"|Authorization:/i)
  assert.doesNotMatch(text, /"evidenceState":"live-verified"|"liveVerified":true/)
})
