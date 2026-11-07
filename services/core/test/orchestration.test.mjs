import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_IDS,
  EVIDENCE_STATES,
  LOCAL_CAPABILITIES,
  ORCHESTRATION_SCHEMA_VERSION,
  WorkflowError,
  buildBenchmarkEvidence,
  buildFullPhaseReport,
  executeWorkflow,
  planWorkflow,
  platformReadiness,
  validateTaskEnvelope,
} from '../src/orchestration/full.mjs'

function envelope(overrides = {}) {
  const base = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    taskId: 'task-1',
    traceId: 'trace-1',
    kind: 'document',
    assets: [],
    requiredCapabilities: [CAPABILITY_IDS.DOCUMENT_PARSE],
    profile: 'lite',
    privacyMode: 'local-only',
    remoteExecutionConsent: false,
    allowedProviders: [],
    costCeiling: null,
    latencyTargetMs: null,
    resourceBudget: { maxSteps: 2, maxChars: 16000, maxAssets: 0 },
    steps: [{
      id: 'parse',
      capability: CAPABILITY_IDS.DOCUMENT_PARSE,
      dependsOn: [],
      inputRefs: [],
      output: { format: 'json', maxBytes: 262144, classification: 'internal', provenance: true },
      retention: 'session-only',
    }],
    outputPolicy: { format: 'json', maxBytes: 262144, classification: 'internal', provenance: true },
    retentionPolicy: { mode: 'session-only', ttlSeconds: 0 },
  }
  return { ...base, ...overrides }
}

test('task envelopes are bounded, reject unknown fields and refuse binary/credential payloads', () => {
  const valid = validateTaskEnvelope(envelope())
  assert.equal(valid.schemaVersion, 1)
  assert.equal(valid.profile, 'lite')
  assert.equal(valid.privacyMode, 'local-only')
  assert.equal(valid.remoteExecutionConsent, false)
  assert.equal(valid.steps.length, 1)
  assert.ok(LOCAL_CAPABILITIES.includes(CAPABILITY_IDS.DOCUMENT_PARSE))

  assert.throws(() => validateTaskEnvelope(envelope({ unexpected: true })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({ assets: [{ id: 'a', kind: 'image', byteSize: 10, digest: 'sha256:abc', data: 'bytes' }] })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({ schemaVersion: 2 })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({ profile: 'ultra' })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({ privacyMode: 'external', remoteExecutionConsent: false })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({ requiredCapabilities: ['not.real'] })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({ steps: Array.from({ length: 13 }, (_, index) => ({
    id: `s${index}`, capability: CAPABILITY_IDS.DOCUMENT_PARSE, dependsOn: [], inputRefs: [],
  })) })), WorkflowError)
})

test('DAG validation rejects cycles, unknown dependencies and excessive depth', () => {
  const step = (id, dependsOn = []) => ({ id, capability: CAPABILITY_IDS.DOCUMENT_PARSE, dependsOn, inputRefs: [] })
  assert.throws(() => validateTaskEnvelope(envelope({ steps: [step('a', ['b']), step('b', ['a'])] })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({ steps: [step('a', ['missing'])] })), WorkflowError)
  assert.throws(() => validateTaskEnvelope(envelope({
    profile: 'lite',
    steps: [step('a'), step('b', ['a']), step('c', ['b']), step('d', ['c'])],
  })), WorkflowError)
})

test('plan preview distinguishes local evidence from blocked live/model/side-effect capabilities', () => {
  const local = planWorkflow(envelope())
  assert.equal(local.steps[0].status, 'PASS')
  assert.equal(local.steps[0].runtime, 'local-deterministic-v1')
  assert.equal(local.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(local.providerCalls, 0)
  assert.equal(local.liveCallPerformed, false)
  assert.equal(local.releasePublished, false)
  assert.equal(local.noSilentSubstitution, true)

  const blocked = planWorkflow(envelope({ kind: 'research', requiredCapabilities: [CAPABILITY_IDS.RESEARCH_WEB_SEARCH], steps: [{
    id: 'search', capability: CAPABILITY_IDS.RESEARCH_WEB_SEARCH, dependsOn: [], inputRefs: [],
  }] }))
  assert.equal(blocked.steps[0].status, 'BLOCKED')
  assert.match(blocked.steps[0].reason, /live web search/)
  assert.equal(blocked.blocked.length, 1)
  assert.equal(blocked.liveCallPerformed, false)

  const external = planWorkflow(envelope({ privacyMode: 'external', remoteExecutionConsent: true }))
  assert.equal(external.steps[0].status, 'BLOCKED')
  assert.match(external.steps[0].reason, /external execution/)
  assert.equal(external.liveCallPerformed, false)
})

test('research and coding workflows stay local, explainable and side-effect free', () => {
  const research = executeWorkflow(envelope({
    kind: 'research',
    requiredCapabilities: [CAPABILITY_IDS.RESEARCH_CITATIONS],
    steps: [{ id: 'cite', capability: CAPABILITY_IDS.RESEARCH_CITATIONS, dependsOn: [], inputRefs: [] }],
  }), {
    claims: ['ragam stores local knowledge'],
    sources: [{ id: 'doc-1', text: 'Ragam stores account-local knowledge.', freshness: '2026-11-07' }],
  })
  assert.equal(research.status, 'PASS')
  assert.equal(research.steps[0].status, 'PASS')
  assert.equal(research.steps[0].output.citations[0].sourceId, 'doc-1')
  assert.equal(research.networkUsed, false)
  assert.equal(research.providerCalls, 0)

  const code = executeWorkflow(envelope({
    kind: 'coding',
    requiredCapabilities: [CAPABILITY_IDS.CODE_REVIEW],
    steps: [{ id: 'review', capability: CAPABILITY_IDS.CODE_REVIEW, dependsOn: [], inputRefs: [] }],
  }), { code: 'const x = eval("1"); // TODO' })
  assert.equal(code.status, 'PASS')
  assert.ok(code.steps[0].output.findings.includes('eval'))
  assert.ok(code.steps[0].output.findings.includes('todo'))
  assert.equal(code.steps[0].output.executionPerformed, false)
  assert.equal(code.steps[0].output.patchApplied, false)
  assert.equal(code.destructiveActions, 0)
})

test('multimodal and document capabilities validate metadata without decoding bytes or inferring identity', () => {
  const asset = {
    container: 'wav',
    mimeType: 'image/png',
    byteSize: 2048,
    width: 640,
    height: 480,
    durationMs: 1200,
    channels: 1,
    sampleRate: 16000,
    frameCount: 30,
    digest: 'sha256:fixture',
  }
  for (const capability of [CAPABILITY_IDS.IMAGE_INPUT, CAPABILITY_IDS.AUDIO_INPUT, CAPABILITY_IDS.VIDEO_INPUT, CAPABILITY_IDS.VIDEO_FRAME_EXTRACT]) {
    const result = executeWorkflow(envelope({
      kind: capability.startsWith('video') ? 'video' : capability.startsWith('audio') ? 'audio' : 'image',
      requiredCapabilities: [capability],
      steps: [{ id: 'meta', capability, dependsOn: [], inputRefs: [] }],
    }), { asset })
    assert.equal(result.steps[0].status, 'PASS')
    assert.equal(result.steps[0].output.decoded, false)
    assert.equal(result.steps[0].output.modelInference, false)
    assert.equal(result.steps[0].output.identityInferred, false)
  }
  const document = executeWorkflow(envelope(), { text: '# Heading\nline two' })
  assert.equal(document.steps[0].output.headings[0], 'Heading')
  assert.equal(document.steps[0].output.macrosExecuted, false)
  assert.equal(document.steps[0].output.generatedInterpretation, false)
})

test('engineering workflows use known-answer calculations, statistics and advice-only reports', () => {
  const calculate = executeWorkflow(envelope({
    kind: 'engineering',
    requiredCapabilities: [CAPABILITY_IDS.ENGINEERING_CALCULATE],
    steps: [{ id: 'calc', capability: CAPABILITY_IDS.ENGINEERING_CALCULATE, dependsOn: [], inputRefs: [] }],
  }), { expression: '2 + 3 * 4', units: 'dimensionless' })
  assert.equal(calculate.steps[0].output.value, 14)
  assert.equal(calculate.steps[0].output.evalUsed, false)

  const signal = executeWorkflow(envelope({
    kind: 'engineering',
    requiredCapabilities: [CAPABILITY_IDS.ENGINEERING_SIGNAL_ANALYSIS],
    steps: [{ id: 'signal', capability: CAPABILITY_IDS.ENGINEERING_SIGNAL_ANALYSIS, dependsOn: [], inputRefs: [] }],
  }), { samples: [1, 2, 3, 4] })
  assert.equal(signal.steps[0].output.mean, 2.5)
  assert.equal(signal.steps[0].output.fftPerformed, false)

  const anomaly = executeWorkflow(envelope({
    kind: 'engineering',
    requiredCapabilities: [CAPABILITY_IDS.ENGINEERING_TIMESERIES_ANOMALY],
    steps: [{ id: 'anomaly', capability: CAPABILITY_IDS.ENGINEERING_TIMESERIES_ANOMALY, dependsOn: [], inputRefs: [] }],
  }), { samples: [1, 1, 1, 10], threshold: 1.5 })
  assert.ok(anomaly.steps[0].output.anomalies.length > 0)
  assert.equal(anomaly.steps[0].output.trainedModelUsed, false)

  const report = executeWorkflow(envelope({
    kind: 'engineering',
    requiredCapabilities: [CAPABILITY_IDS.ENGINEERING_MAINTENANCE_REPORT],
    steps: [{ id: 'report', capability: CAPABILITY_IDS.ENGINEERING_MAINTENANCE_REPORT, dependsOn: [], inputRefs: [] }],
  }), { samples: [1, 2, 9], limit: 5 })
  assert.equal(report.steps[0].output.adviceOnly, true)
  assert.equal(report.steps[0].output.actuationPerformed, false)
  assert.equal(report.steps[0].output.scadaWrite, false)
})

test('benchmark evidence requires exact fields and refuses live/release claims', () => {
  const input = {
    version: '0.2.0',
    datasetDigest: 'sha256:fixture',
    testSplit: 'held-out-fixture',
    providerId: 'local-deterministic-v1',
    endpointId: 'local',
    modelId: 'none',
    runtimeId: 'node22',
    hardware: 'sandbox-cpu',
    software: 'node22-linux',
    qualityMetric: 'exact_match',
    threshold: 0.8,
    samples: [
      { latencyMs: 10, success: true, cost: 0.01 },
      { latencyMs: 20, success: true, cost: 0.02 },
    ],
    measurementOptions: { windowMs: 1000, costCurrency: 'USD', safetyChecks: ['redaction'], evidenceArtifact: 'artifact-1' },
    safetyChecks: ['credential-redaction'],
    evidenceArtifact: 'artifact-1',
    evidenceState: EVIDENCE_STATES.EVALUATED,
  }
  const evidence = buildBenchmarkEvidence(input)
  assert.equal(evidence.evidenceState, EVIDENCE_STATES.EVALUATED)
  assert.equal(evidence.measurement.state, 'measured')
  assert.equal(evidence.liveVerified, false)
  assert.equal(evidence.releasePublished, false)
  assert.equal(evidence.measurement.p50Ms, 10)
  assert.equal(evidence.measurement.p95Ms, 20)
  assert.throws(() => buildBenchmarkEvidence({ ...input, evidenceState: EVIDENCE_STATES.LIVE_VERIFIED }), WorkflowError)
  assert.throws(() => buildBenchmarkEvidence({ ...input, evidenceState: EVIDENCE_STATES.RELEASED }), WorkflowError)
})

test('full report, cancellation and platform readiness keep release/live claims fail-closed', () => {
  const report = buildFullPhaseReport(envelope(), { text: '# Local evidence' })
  assert.deepEqual(report.phases, ['3', '4', '5', '6', '7', '8', '9'])
  assert.equal(report.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  assert.equal(report.liveVerified, false)
  assert.equal(report.releasePublished, false)
  assert.equal(report.noSilentSubstitution, true)
  assert.equal(report.execution.liveCallPerformed, false)
  assert.equal(report.platform.releasePublished, false)
  assert.equal(report.platform.items.releasePublication.status, 'BLOCKED')
  assert.equal(report.platform.items.telemetry.status, 'BLOCKED')
  assert.equal(report.platform.items.hostedByok.status, 'NOT TESTED')

  const readiness = platformReadiness()
  assert.equal(readiness.items.dockerLoopback.status, 'PASS')
  assert.equal(readiness.items.desktop.status, 'PASS')
  assert.equal(readiness.items.backupRestore.status, 'PASS')
  assert.equal(readiness.items.productionRollback.status, 'NOT TESTED')
  assert.equal(readiness.liveProviderCall, false)
  assert.equal(readiness.destructiveCleanup, false)

  assert.throws(() => executeWorkflow(envelope(), { signal: { aborted: true }, text: 'x' }), (error) => error instanceof WorkflowError && error.code === 'cancelled')
})
