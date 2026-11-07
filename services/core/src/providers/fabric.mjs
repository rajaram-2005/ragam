// Phase 2 provider fabric: local-only evidence, normalisation and explainable routing.
//
// This module deliberately performs no network I/O, reads no credentials, stores no endpoint
// URLs and loads no model weights. It turns catalogue, connection and caller-supplied evidence
// into one honest snapshot. A catalogue row is not implementation proof; a contract test is not
// live verification; a measurement without a cost input is not a fabricated cost.

import { PROVIDERS, PROVIDER_STATUS, validateCatalogue } from './catalog.mjs'
import { adviceFor, normaliseProviderError, redact } from './errors.mjs'
import { selectProvider } from './select.mjs'

export const PROVIDER_FABRIC_SCHEMA_VERSION = 1

export const EVIDENCE_STATES = Object.freeze({
  PLANNED: 'planned',
  IMPLEMENTED: 'implemented',
  CONTRACT_TESTED: 'contract-tested',
  LIVE_VERIFIED: 'live-verified',
  EVALUATED: 'evaluated',
  PRODUCTION_APPROVED: 'production-approved',
  RELEASED: 'released',
  SUSPENDED: 'suspended',
})

export const LOCALITY_STATES = Object.freeze({
  LOCAL: 'local',
  CLOUD: 'cloud',
  UNKNOWN: 'unknown',
})

export const HEALTH_STATES = Object.freeze({
  UNVERIFIED: 'unverified',
  CONTRACT_TESTED: 'contract_tested',
  LIVE_VERIFIED: 'live_verified',
  UNAVAILABLE: 'unavailable',
})

export const LIVE_QUALIFICATION_STATES = Object.freeze({
  NOT_REQUESTED: 'not_requested',
  BLOCKED: 'blocked',
  READY_FOR_AUTHORIZED_CALL: 'ready_for_authorized_call',
})

/** Explicit local runtime ids. Locality is never inferred from a provider brand or model name. */
export const LOCAL_RUNTIME_IDS = Object.freeze([
  'ollama', 'llamacpp', 'vllm', 'localai', 'comfyui', 'diffusers',
])
const LOCAL_RUNTIME_SET = new Set(LOCAL_RUNTIME_IDS)

const CAPABILITY_UNSET = Object.freeze({
  input: Object.freeze(['unknown']),
  output: Object.freeze(['unknown']),
  contextTokens: null,
  maxOutputTokens: null,
  streaming: 'unknown',
  tools: 'unknown',
  structuredOutput: 'unknown',
  imageInput: 'unknown',
})

function safeText(value, fallback = 'unknown') {
  const text = redact(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, 160)
  return text || fallback
}

function safeId(value) {
  const text = safeText(value, '').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120)
  return text || 'unknown'
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function stringArray(value, fallback = ['unknown']) {
  if (!Array.isArray(value) || !value.length) return Object.freeze([...fallback])
  return Object.freeze(value.slice(0, 24).map((entry) => safeText(entry)))
}

function capabilityValue(value, fallback = 'unknown') {
  return typeof value === 'string' && value.trim() ? safeText(value) : fallback
}

export function localityFor(provider) {
  if (!provider || typeof provider !== 'object') {
    return Object.freeze({ state: LOCALITY_STATES.UNKNOWN, evidence: 'provider_metadata_missing' })
  }
  if (LOCAL_RUNTIME_SET.has(provider.id)) {
    return Object.freeze({ state: LOCALITY_STATES.LOCAL, evidence: 'explicit_local_runtime_id' })
  }
  if (provider.egress?.https === true && provider.status !== PROVIDER_STATUS.PENDING) {
    return Object.freeze({ state: LOCALITY_STATES.CLOUD, evidence: 'catalogue_egress_metadata' })
  }
  return Object.freeze({ state: LOCALITY_STATES.UNKNOWN, evidence: 'insufficient_metadata' })
}

export function evidenceStateFor(provider, liveQualification = {}) {
  if (!provider || typeof provider !== 'object') return EVIDENCE_STATES.PLANNED
  const verified = liveQualification?.verified === true
    && liveQualification?.authorizedLiveCall === true
    && liveQualification?.explicitConsent === true
    && typeof liveQualification?.evidenceDigest === 'string'
    && liveQualification.evidenceDigest.length > 0
    && safeId(liveQualification.providerId) === safeId(provider.id)
  if (verified) return EVIDENCE_STATES.LIVE_VERIFIED
  if (provider.status === PROVIDER_STATUS.PENDING) return EVIDENCE_STATES.PLANNED
  if (provider.status === PROVIDER_STATUS.READY
      || provider.status === PROVIDER_STATUS.GATEWAY_ONLY
      || provider.adapterStatus === 'contract_tested') return EVIDENCE_STATES.CONTRACT_TESTED
  return EVIDENCE_STATES.IMPLEMENTED
}

export function healthStateFor(provider, healthChecks = {}, liveQualification = {}) {
  const explicit = healthChecks?.[provider?.id]
  if (explicit === 'unavailable') return HEALTH_STATES.UNAVAILABLE
  if (evidenceStateFor(provider, liveQualification) === EVIDENCE_STATES.LIVE_VERIFIED) return HEALTH_STATES.LIVE_VERIFIED
  if (evidenceStateFor(provider, liveQualification) === EVIDENCE_STATES.CONTRACT_TESTED) return HEALTH_STATES.CONTRACT_TESTED
  return HEALTH_STATES.UNVERIFIED
}

/** Normalise model-discovery records without inferring capability from a model name. */
export function normalizeModelDiscovery(entries = {}, context = {}) {
  const records = Array.isArray(entries) ? entries : []
  const providerId = safeId(context.providerId)
  const endpointConfigured = context.endpointConfigured === true
  return Object.freeze(records.map((entry, index) => {
    const id = typeof entry?.id === 'string' && entry.id.trim() ? safeId(entry.id) : null
    if (!id) return Object.freeze({ valid: false, index, reason: 'missing_model_id' })
    const raw = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {}
    const provenanceSource = capabilityValue(raw.provenance?.source, 'unavailable')
    const capabilityEvidenceState = provenanceSource === 'test'
      ? EVIDENCE_STATES.CONTRACT_TESTED
      : provenanceSource === 'vendor-doc' ? EVIDENCE_STATES.IMPLEMENTED : EVIDENCE_STATES.PLANNED
    return Object.freeze({
      valid: true,
      schemaVersion: PROVIDER_FABRIC_SCHEMA_VERSION,
      providerId,
      endpointId: safeId(context.endpointId ?? providerId),
      endpointConfigured,
      modelId: id,
      name: safeText(entry.name, id),
      capabilities: Object.freeze({
        input: stringArray(raw.input),
        output: stringArray(raw.output),
        contextTokens: finiteOrNull(raw.contextTokens),
        maxOutputTokens: finiteOrNull(raw.maxOutputTokens),
        streaming: capabilityValue(raw.streaming),
        tools: capabilityValue(raw.tools, 'not_exposed_by_ragam'),
        structuredOutput: capabilityValue(raw.structuredOutput, 'not_exposed_by_ragam'),
        imageInput: capabilityValue(raw.imageInput),
        provenance: Object.freeze({
          source: provenanceSource,
          provider: safeText(raw.provenance?.provider, providerId),
        }),
      }),
      capabilityEvidenceState,
      capabilityValuesAreInferred: false,
      liveVerified: false,
      credentialIncluded: false,
      note: 'Model id, endpoint and capability metadata are separate. Unknown capabilities remain unknown.',
    })
  }))
}

/** One normalized provider error envelope; no raw response body or credential is retained. */
export function normalizeFabricError(error = {}, context = {}) {
  const normalised = normaliseProviderError(error)
  const provider = context.provider && typeof context.provider === 'object' ? context.provider : { id: context.providerId }
  const locality = context.locality ?? localityFor(provider).state
  return Object.freeze({
    schemaVersion: PROVIDER_FABRIC_SCHEMA_VERSION,
    traceId: safeId(context.traceId ?? 'unassigned'),
    providerId: safeId(context.providerId ?? provider?.id),
    wire: safeText(context.wire ?? provider?.wire, 'unknown'),
    modelId: safeId(context.modelId ?? 'unassigned'),
    locality: Object.values(LOCALITY_STATES).includes(locality) ? locality : LOCALITY_STATES.UNKNOWN,
    evidenceState: evidenceStateFor(provider, context.liveQualification),
    code: normalised.code,
    status: normalised.status,
    retryable: normalised.retryable,
    retryAfterMs: normalised.retryAfterMs,
    message: safeText(normalised.message),
    detail: safeText(normalised.detail, ''),
    advice: safeText(adviceFor(normalised)),
    rawBodyIncluded: false,
    credentialIncluded: false,
    noSilentSubstitution: true,
    liveCallPerformed: false,
    note: 'Error normalized locally with provider/errors.mjs; no raw vendor body or credential is included.',
  })
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/** Summarise caller-supplied latency/cost samples without inventing missing values. */
export function summarizeMeasurements(samples = [], options = {}) {
  const list = Array.isArray(samples) ? samples : []
  if (!list.length) {
    return Object.freeze({
      state: 'not_measured',
      evidenceState: EVIDENCE_STATES.PLANNED,
      samples: 0,
      successes: 0,
      failures: 0,
      p50Ms: null,
      p95Ms: null,
      throughputPerSecond: null,
      costPerSuccessfulTask: null,
      costCoverage: 0,
      costCurrency: null,
      failureCategories: Object.freeze({}),
      qualityMetric: null,
      threshold: null,
      datasetDigest: null,
      testSplit: null,
      hardware: null,
      software: null,
      safetyChecks: Object.freeze([]),
      evidenceArtifact: null,
      note: 'No measurements were supplied; cost, quality and live verification remain unmeasured.',
    })
  }
  const latencies = []
  const failureCategories = {}
  let successes = 0
  let failures = 0
  let reportedCost = 0
  let successfulCostSamples = 0
  for (const sample of list) {
    if (!sample || typeof sample !== 'object'
        || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0
        || typeof sample.success !== 'boolean') {
      throw new TypeError('each measurement sample needs finite latencyMs >= 0 and boolean success')
    }
    latencies.push(sample.latencyMs)
    if (sample.success) {
      successes += 1
      if (sample.cost !== undefined && sample.cost !== null) {
        if (!Number.isFinite(sample.cost) || sample.cost < 0) throw new TypeError('reported cost must be finite and non-negative')
        reportedCost += sample.cost
        successfulCostSamples += 1
      }
    } else {
      failures += 1
      const category = safeText(sample.failureCategory, 'unclassified')
      failureCategories[category] = (failureCategories[category] ?? 0) + 1
    }
  }
  const sorted = latencies.slice().sort((a, b) => a - b)
  const windowMs = Number(options.windowMs)
  const throughputPerSecond = Number.isFinite(windowMs) && windowMs > 0
    ? list.length / (windowMs / 1000) : null
  const costIsComplete = successes > 0 && successfulCostSamples === successes
  return Object.freeze({
    state: 'measured',
    evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
    samples: list.length,
    successes,
    failures,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    throughputPerSecond,
    costPerSuccessfulTask: costIsComplete ? reportedCost / successes : null,
    costCoverage: successes ? successfulCostSamples / successes : 0,
    costCurrency: options.costCurrency ? safeText(options.costCurrency) : null,
    failureCategories: Object.freeze({ ...failureCategories }),
    qualityMetric: options.qualityMetric ? safeText(options.qualityMetric) : null,
    threshold: finiteOrNull(options.threshold),
    datasetDigest: options.datasetDigest ? safeText(options.datasetDigest) : null,
    testSplit: options.testSplit ? safeText(options.testSplit) : null,
    hardware: options.hardware ? safeText(options.hardware) : null,
    software: options.software ? safeText(options.software) : null,
    safetyChecks: stringArray(options.safetyChecks, []),
    evidenceArtifact: options.evidenceArtifact ? safeText(options.evidenceArtifact) : null,
    note: 'Operational measurements only; no quality evaluation or live provider verification is implied.',
  })
}

/** Fail-closed gate. It never performs a call and never receives a credential value. */
export function liveQualificationGate(input = {}) {
  const requested = input.requested === true
  const blockers = []
  if (input.explicitConsent !== true) blockers.push('consent_required')
  if (input.credentialsPresent !== true) blockers.push('credentials_missing')
  if (input.connectivity !== 'reachable') blockers.push('connectivity_unverified')
  if (input.wireImplemented !== true) blockers.push('wire_not_implemented')
  if (!input.providerId || safeId(input.providerId) === 'unknown') blockers.push('provider_id_missing')
  if (!input.modelId || safeId(input.modelId) === 'unknown') blockers.push('model_id_missing')
  if (input.locality === LOCALITY_STATES.CLOUD && input.remoteAllowed !== true) blockers.push('remote_not_allowed')
  if (input.provider?.status === PROVIDER_STATUS.PENDING) blockers.push('adapter_pending')
  const allowed = requested && blockers.length === 0
  const state = !requested
    ? LIVE_QUALIFICATION_STATES.NOT_REQUESTED
    : allowed ? LIVE_QUALIFICATION_STATES.READY_FOR_AUTHORIZED_CALL : LIVE_QUALIFICATION_STATES.BLOCKED
  return Object.freeze({
    state,
    allowed,
    reasons: Object.freeze(requested ? blockers : Object.freeze(['not_requested', ...blockers])),
    evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
    liveVerified: false,
    liveCallPerformed: false,
    credentialValueIncluded: false,
    externalDataTransferApproved: input.explicitConsent === true && input.remoteAllowed === true,
    note: 'This gate checks prerequisites only. No live provider call was performed.',
  })
}

/** Reuse the existing selector and annotate its decision with fabric evidence. */
export function explainableRoutingDecision(request = {}, policy = {}, healthChecks = {}, providers = PROVIDERS) {
  const decision = selectProvider(request, policy, healthChecks, providers)
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  const annotate = (id) => {
    const provider = byId.get(id)
    return Object.freeze({
      locality: localityFor(provider).state,
      evidenceState: evidenceStateFor(provider),
      health: healthStateFor(provider, healthChecks),
      liveVerified: false,
    })
  }
  const chosen = decision.chosen ? Object.freeze({ ...decision.chosen, fabric: annotate(decision.chosen.id) }) : null
  const rejected = Object.freeze(decision.rejected.map((entry) => Object.freeze({
    ...entry,
    fabric: annotate(entry.id),
  })))
  return Object.freeze({
    schemaVersion: PROVIDER_FABRIC_SCHEMA_VERSION,
    chosen,
    rejected,
    explanation: safeText(decision.explanation),
    noSilentSubstitution: true,
    liveCallPerformed: false,
    note: 'Routing is a local decision over catalogue evidence; no provider health probe or live call was made.',
  })
}

/** Build one read-only fabric snapshot from catalogue, connection and caller-supplied evidence. */
export function buildProviderFabricSnapshot({
  providers = PROVIDERS,
  connections = [],
  activeId = null,
  healthChecks = {},
  measurements = [],
  liveQualification = {},
  routingRequest = null,
  routingPolicy = {},
  measurementOptions = {},
} = {}) {
  const list = Array.isArray(providers) ? providers : PROVIDERS
  const catalogueValid = validateCatalogue(list).valid
  const connectionList = Array.isArray(connections) ? connections : []
  const byConnectionId = new Map(connectionList.map((connection) => [connection?.id, connection]))
  const measurementList = Array.isArray(measurements) ? measurements : []
  const counts = { total: list.length, local: 0, cloud: 0, unknown: 0, pending: 0, contractTested: 0, liveVerified: 0, configuredConnections: 0, modelRecords: 0, measuredProviders: 0 }

  const rows = Object.freeze(list.map((provider) => {
    const connection = byConnectionId.get(provider.id) ?? null
    const locality = localityFor(provider)
    const evidenceState = evidenceStateFor(provider, liveQualification)
    const health = healthStateFor(provider, healthChecks, liveQualification)
    const endpointConfigured = Boolean(connection?.baseUrl)
    const credentialConfigured = Boolean(connection?.keyConfigured || connection?.configured)
    const modelIds = Array.isArray(connection?.models) ? connection.models.filter((id) => typeof id === 'string').map(safeId).slice(0, 50) : []
    const models = normalizeModelDiscovery(connection?.modelDetails ?? [], {
      providerId: provider.id,
      endpointId: connection?.id ?? provider.id,
      endpointConfigured,
    })
    const providerMeasurements = measurementList.filter((sample) => safeId(sample?.providerId) === safeId(provider.id))
    const measurement = summarizeMeasurements(providerMeasurements, measurementOptions)
    const qualification = liveQualificationGate({
      requested: liveQualification.requested === true,
      explicitConsent: liveQualification.explicitConsent === true,
      credentialsPresent: credentialConfigured,
      connectivity: liveQualification.connectivity ?? 'unverified',
      wireImplemented: Boolean(connection?.wire) && !connection?.unsupported,
      providerId: provider.id,
      modelId: connection?.selectedModel || liveQualification.modelId,
      locality: locality.state,
      remoteAllowed: liveQualification.remoteAllowed === true,
      provider,
    })
    if (locality.state === LOCALITY_STATES.LOCAL) counts.local += 1
    else if (locality.state === LOCALITY_STATES.CLOUD) counts.cloud += 1
    else counts.unknown += 1
    if (provider.status === PROVIDER_STATUS.PENDING) counts.pending += 1
    if (evidenceState === EVIDENCE_STATES.CONTRACT_TESTED) counts.contractTested += 1
    if (evidenceState === EVIDENCE_STATES.LIVE_VERIFIED) counts.liveVerified += 1
    if (credentialConfigured) counts.configuredConnections += 1
    counts.modelRecords += models.length
    if (measurement.state === 'measured') counts.measuredProviders += 1
    return Object.freeze({
      id: safeId(provider.id),
      label: safeText(provider.label, safeId(provider.id)),
      status: safeText(provider.status, PROVIDER_STATUS.PENDING),
      wire: provider.wire ? safeText(provider.wire) : null,
      locality: locality.state,
      localityEvidence: locality.evidence,
      evidenceState,
      health,
      healthLiveVerified: false,
      endpointConfigured,
      credentialConfigured,
      rawEndpointIncluded: false,
      credentialValueIncluded: false,
      modelCount: modelIds.length,
      modelIds: Object.freeze(modelIds),
      models,
      capabilities: Object.freeze((provider.capabilities ?? []).map((capability) => Object.freeze({
        id: safeText(capability.id),
        source: safeText(capability.source, 'unknown'),
        ref: capability.ref ? safeText(capability.ref) : null,
      }))),
      liveQualification: qualification,
      measurement,
      liveVerified: false,
    })
  }))

  const activeConnection = byConnectionId.get(activeId) ?? null
  const activeProvider = list.find((provider) => provider.id === activeId) ?? null
  const overallQualification = liveQualificationGate({
    requested: liveQualification.requested === true,
    explicitConsent: liveQualification.explicitConsent === true,
    credentialsPresent: Boolean(activeConnection?.keyConfigured || activeConnection?.configured),
    connectivity: liveQualification.connectivity ?? 'unverified',
    wireImplemented: Boolean(activeConnection?.wire) && !activeConnection?.unsupported,
    providerId: activeId,
    modelId: activeConnection?.selectedModel || liveQualification.modelId,
    locality: localityFor(activeProvider).state,
    remoteAllowed: liveQualification.remoteAllowed === true,
    provider: activeProvider,
  })
  const overallMeasurements = summarizeMeasurements(measurementList, measurementOptions)
  const routing = routingRequest
    ? explainableRoutingDecision(routingRequest, routingPolicy, healthChecks, list)
    : Object.freeze({
      state: 'not_requested',
      chosen: null,
      rejected: Object.freeze([]),
      explanation: 'No routing request was made; no provider was selected or probed.',
      noSilentSubstitution: true,
      liveCallPerformed: false,
    })

  return Object.freeze({
    schemaVersion: PROVIDER_FABRIC_SCHEMA_VERSION,
    policy: Object.freeze({
      onlineOnly: true,
      localCloudBoundaryPreserved: true,
      noSilentSubstitution: true,
      explicitRemoteConsentRequired: true,
      loopbackDefaultsPreserved: true,
    }),
    evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
    evidenceStates: Object.freeze(Object.values(EVIDENCE_STATES)),
    catalogueValid,
    counts: Object.freeze(counts),
    activeProviderId: activeId ? safeId(activeId) : null,
    providers: rows,
    liveQualification: overallQualification,
    measurements: overallMeasurements,
    routing,
    errorNormalisation: Object.freeze({
      implementation: 'services/core/src/providers/errors.mjs',
      rawVendorBodyIncluded: false,
      credentialValueIncluded: false,
      retryAdviceIncluded: true,
    }),
    modelDiscovery: Object.freeze({
      providerEndpointModelSeparated: true,
      capabilityValuesInferredFromModelName: false,
      unknownCapabilitiesRemainUnknown: true,
      binaryOrWeightPayloadIncluded: false,
    }),
    liveCallPerformed: false,
    note: 'Provider fabric evidence is contract-tested metadata. No live provider call, credential value, raw endpoint, model weight or weight download is included.',
  })
}
