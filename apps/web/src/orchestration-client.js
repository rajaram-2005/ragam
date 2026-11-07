// Client-side construction of the local-only Phase 3–9 task envelope.
// No credential, binary payload, absolute host, provider call or model weight is included.

export const ORCHESTRATION_CAPABILITY_OPTIONS = Object.freeze([
  { id: 'document.parse', label: 'Document parse' },
  { id: 'document.table-extract', label: 'Table extract' },
  { id: 'research.citations', label: 'Claim-to-source mapping' },
  { id: 'knowledge.retrieve', label: 'Local knowledge retrieval' },
  { id: 'code.review', label: 'Static code review' },
  { id: 'engineering.calculate', label: 'Bounded calculation' },
  { id: 'engineering.signal-analysis', label: 'Signal summary' },
  { id: 'engineering.timeseries-anomaly', label: 'Timeseries anomaly' },
  { id: 'engineering.maintenance-report', label: 'Maintenance report' },
  { id: 'benchmark.evidence', label: 'Benchmark evidence' },
])

const KIND_FOR_CAPABILITY = Object.freeze({
  'document.parse': 'document',
  'document.table-extract': 'document',
  'research.citations': 'research',
  'knowledge.retrieve': 'chat',
  'code.review': 'coding',
  'engineering.calculate': 'engineering',
  'engineering.signal-analysis': 'engineering',
  'engineering.timeseries-anomaly': 'engineering',
  'engineering.maintenance-report': 'engineering',
  'benchmark.evidence': 'benchmark',
})

export function buildLocalOrchestrationContext(prompt, capability) {
  const value = typeof prompt === 'string' ? prompt.slice(0, 100000) : ''
  const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number).slice(0, 256) ?? []
  return {
    text: value,
    tableText: value,
    query: value,
    claims: value ? value.split(/\n+/).filter(Boolean).slice(0, 20) : [],
    sources: [],
    documents: [],
    code: value,
    expression: value,
    samples: numbers,
    asset: null,
    threshold: 3,
    limit: numbers.length ? Math.max(...numbers) : 0,
    benchmark: null,
  }
}

export function buildLocalOrchestrationEnvelope({ prompt = '', capability = 'document.parse', profile = 'lite' } = {}) {
  const known = ORCHESTRATION_CAPABILITY_OPTIONS.some((option) => option.id === capability)
  const selected = known ? capability : 'document.parse'
  const stepId = `local-${selected.replace(/[^a-z0-9]+/gi, '-')}`
  return {
    schemaVersion: 1,
    taskId: 'chat-local-workflow',
    traceId: 'chat-local-trace',
    kind: KIND_FOR_CAPABILITY[selected] ?? 'chat',
    assets: [],
    requiredCapabilities: [selected],
    profile: ['lite', 'pro', 'max'].includes(profile) ? profile : 'lite',
    privacyMode: 'local-only',
    remoteExecutionConsent: false,
    allowedProviders: [],
    costCeiling: null,
    latencyTargetMs: null,
    resourceBudget: { maxSteps: 2, maxChars: 16000, maxAssets: 0 },
    steps: [{
      id: stepId,
      capability: selected,
      dependsOn: [],
      inputRefs: [],
      output: { format: 'json', maxBytes: 262144, classification: 'internal', provenance: true },
      retention: 'session-only',
    }],
    outputPolicy: { format: 'json', maxBytes: 262144, classification: 'internal', provenance: true },
    retentionPolicy: { mode: 'session-only', ttlSeconds: 0 },
  }
}
