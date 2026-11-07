// Phases 3–9: one bounded task envelope, local-only workflow execution and honest evidence.
//
// This module extends the existing Core without a parallel stack. It performs no network I/O,
// reads no credentials, loads no model weights, executes no external tool, writes no files,
// publishes no release and performs no destructive action. Capabilities that need a live
// provider, a trained model, a sandbox, industrial actuation or production deployment are
// refused by name rather than silently substituted.

import { EVIDENCE_STATES, summarizeMeasurements } from '../providers/fabric.mjs'
import { KLYVARON_PROCESSOR_PROFILES } from '../klyvaron/processor.mjs'
export { EVIDENCE_STATES } from '../providers/fabric.mjs'

export const ORCHESTRATION_SCHEMA_VERSION = 1

export const TASK_KINDS = Object.freeze([
  'chat', 'research', 'coding', 'image', 'audio', 'video',
  'document', 'engineering', 'platform', 'benchmark',
])

export const CAPABILITY_IDS = Object.freeze({
  TEXT_GENERATE: 'text.generate',
  TEXT_STREAM: 'text.stream',
  TEXT_REASON: 'text.reason',
  TEXT_STRUCTURED_OUTPUT: 'text.structured-output',
  TEXT_LONG_CONTEXT: 'text.long-context',
  RESEARCH_WEB_SEARCH: 'research.web-search',
  RESEARCH_SOURCE_FETCH: 'research.source-fetch',
  RESEARCH_CITATIONS: 'research.citations',
  KNOWLEDGE_RETRIEVE: 'knowledge.retrieve',
  KNOWLEDGE_INDEX: 'knowledge.index',
  CODE_GENERATE: 'code.generate',
  CODE_REVIEW: 'code.review',
  CODE_EXECUTE_SANDBOXED: 'code.execute-sandboxed',
  TOOLS_FUNCTION_CALLING: 'tools.function-calling',
  TOOLS_MCP: 'tools.mcp',
  IMAGE_INPUT: 'image.input',
  IMAGE_UNDERSTAND: 'image.understand',
  IMAGE_OCR: 'image.ocr',
  IMAGE_GENERATE: 'image.generate',
  IMAGE_EDIT: 'image.edit',
  AUDIO_INPUT: 'audio.input',
  AUDIO_TRANSCRIBE: 'audio.transcribe',
  AUDIO_SPEAKER_DIARIZATION: 'audio.speaker-diarization',
  AUDIO_GENERATE: 'audio.generate',
  AUDIO_STREAM: 'audio.stream',
  VIDEO_INPUT: 'video.input',
  VIDEO_FRAME_EXTRACT: 'video.frame-extract',
  VIDEO_UNDERSTAND: 'video.understand',
  VIDEO_SUMMARIZE: 'video.summarize',
  VIDEO_GENERATE: 'video.generate',
  VIDEO_EDIT: 'video.edit',
  DOCUMENT_PARSE: 'document.parse',
  DOCUMENT_TABLE_EXTRACT: 'document.table-extract',
  DOCUMENT_RENDER: 'document.render',
  ENGINEERING_CALCULATE: 'engineering.calculate',
  ENGINEERING_SIGNAL_ANALYSIS: 'engineering.signal-analysis',
  ENGINEERING_TIMESERIES_ANOMALY: 'engineering.timeseries-anomaly',
  ENGINEERING_MAINTENANCE_REPORT: 'engineering.maintenance-report',
  PLATFORM_BACKUP: 'platform.backup',
  PLATFORM_RESTORE: 'platform.restore',
  PLATFORM_ROLLBACK: 'platform.rollback',
  PLATFORM_TELEMETRY: 'platform.telemetry',
  BENCHMARK_EVIDENCE: 'benchmark.evidence',
})
export const CAPABILITY_VALUES = Object.freeze(Object.values(CAPABILITY_IDS))
const CAPABILITY_SET = new Set(CAPABILITY_VALUES)

/** Capabilities this build can execute locally and deterministically. */
export const LOCAL_CAPABILITIES = Object.freeze([
  CAPABILITY_IDS.RESEARCH_SOURCE_FETCH,
  CAPABILITY_IDS.RESEARCH_CITATIONS,
  CAPABILITY_IDS.KNOWLEDGE_RETRIEVE,
  CAPABILITY_IDS.KNOWLEDGE_INDEX,
  CAPABILITY_IDS.CODE_REVIEW,
  CAPABILITY_IDS.IMAGE_INPUT,
  CAPABILITY_IDS.AUDIO_INPUT,
  CAPABILITY_IDS.VIDEO_INPUT,
  CAPABILITY_IDS.VIDEO_FRAME_EXTRACT,
  CAPABILITY_IDS.DOCUMENT_PARSE,
  CAPABILITY_IDS.DOCUMENT_TABLE_EXTRACT,
  CAPABILITY_IDS.ENGINEERING_CALCULATE,
  CAPABILITY_IDS.ENGINEERING_SIGNAL_ANALYSIS,
  CAPABILITY_IDS.ENGINEERING_TIMESERIES_ANOMALY,
  CAPABILITY_IDS.ENGINEERING_MAINTENANCE_REPORT,
  CAPABILITY_IDS.BENCHMARK_EVIDENCE,
])
const LOCAL_SET = new Set(LOCAL_CAPABILITIES)

/** Capabilities that must fail closed in this environment. */
export const BLOCKED_CAPABILITY_REASONS = Object.freeze({
  [CAPABILITY_IDS.RESEARCH_WEB_SEARCH]: 'live web search requires authorized external connectivity',
  [CAPABILITY_IDS.TEXT_GENERATE]: 'frontier/provider text generation requires an explicitly selected model',
  [CAPABILITY_IDS.TEXT_STREAM]: 'provider streaming requires an authorized live connection',
  [CAPABILITY_IDS.TEXT_REASON]: 'general reasoning is not provided by the deterministic processor',
  [CAPABILITY_IDS.TEXT_STRUCTURED_OUTPUT]: 'provider structured-output schema enforcement is not available',
  [CAPABILITY_IDS.TEXT_LONG_CONTEXT]: 'model context execution is not available',
  [CAPABILITY_IDS.CODE_GENERATE]: 'model code generation is not available',
  [CAPABILITY_IDS.CODE_EXECUTE_SANDBOXED]: 'no isolated code-execution sandbox is exposed',
  [CAPABILITY_IDS.TOOLS_FUNCTION_CALLING]: 'provider function calls are proposals only and never auto-executed',
  [CAPABILITY_IDS.TOOLS_MCP]: 'MCP side effects require explicit per-call approval',
  [CAPABILITY_IDS.IMAGE_UNDERSTAND]: 'vision understanding requires a qualified model adapter',
  [CAPABILITY_IDS.IMAGE_OCR]: 'OCR requires a qualified OCR adapter',
  [CAPABILITY_IDS.IMAGE_GENERATE]: 'image generation requires an authorized provider adapter',
  [CAPABILITY_IDS.IMAGE_EDIT]: 'image editing requires an authorized provider adapter',
  [CAPABILITY_IDS.AUDIO_TRANSCRIBE]: 'speech-to-text requires a qualified audio adapter',
  [CAPABILITY_IDS.AUDIO_SPEAKER_DIARIZATION]: 'speaker identity inference is not performed',
  [CAPABILITY_IDS.AUDIO_GENERATE]: 'speech generation requires an authorized provider adapter',
  [CAPABILITY_IDS.AUDIO_STREAM]: 'streaming audio is not implemented; buffered input only',
  [CAPABILITY_IDS.VIDEO_UNDERSTAND]: 'video understanding requires a qualified model adapter',
  [CAPABILITY_IDS.VIDEO_SUMMARIZE]: 'video summarization requires a qualified model adapter',
  [CAPABILITY_IDS.VIDEO_GENERATE]: 'video generation requires an authorized provider adapter',
  [CAPABILITY_IDS.VIDEO_EDIT]: 'video editing requires an authorized provider adapter',
  [CAPABILITY_IDS.DOCUMENT_RENDER]: 'document rendering is not exposed',
  [CAPABILITY_IDS.PLATFORM_BACKUP]: 'production backup requires a real deployment',
  [CAPABILITY_IDS.PLATFORM_RESTORE]: 'production restore requires a real deployment',
  [CAPABILITY_IDS.PLATFORM_ROLLBACK]: 'production rollback requires a real deployment and approval',
  [CAPABILITY_IDS.PLATFORM_TELEMETRY]: 'opt-in telemetry transmission is not implemented',
})

export class WorkflowError extends Error {
  constructor(message, code = 'invalid_workflow', status = 400, detail = null) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const PROFILE_IDS = Object.freeze(Object.keys(KLYVARON_PROCESSOR_PROFILES))
const PRIVACY_MODES = Object.freeze(['local-only', 'external'])
const MAX_STEPS = 12
const MAX_ASSETS = 8
const MAX_TEXT = 100_000
const FORBIDDEN_KEYS = new Set(['data', 'bytes', 'base64', 'apiKey', 'api_key', 'token', 'secret', 'password', 'credential', 'key'])

function fail(message, code = 'invalid_workflow', status = 400, detail = null) {
  throw new WorkflowError(message, code, status, detail)
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
  return result || fallback
}

function id(value, fallback = 'unknown') {
  const result = text(value, '').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120)
  return result || fallback
}

function finite(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function deepForbidden(value, path = '$') {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = deepForbidden(value[i], `${path}[${i}]`)
      if (found) return found
    }
    return null
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return `${path}.${key}`
    const found = deepForbidden(child, `${path}.${key}`)
    if (found) return found
  }
  return null
}

function keysWithin(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) fail(`${label} rejects unknown fields: ${unknown.join(', ')}`, 'unknown_field')
}

function normalizeAsset(value, index) {
  keysWithin(value, ['id', 'kind', 'name', 'byteSize', 'digest'], `assets[${index}]`)
  const byteSize = finite(value.byteSize, null)
  if (!value.id || !value.kind || byteSize === null || byteSize > 20 * 1024 * 1024
      || typeof value.digest !== 'string' || value.digest.length < 8) {
    fail(`assets[${index}] needs id, kind, byteSize <= 20 MiB and a digest`, 'invalid_asset')
  }
  return Object.freeze({
    id: id(value.id),
    kind: id(value.kind),
    name: text(value.name, id(value.id)),
    byteSize,
    digest: id(value.digest),
  })
}

function normalizeStep(value, index, assetIds) {
  keysWithin(value, ['id', 'capability', 'dependsOn', 'inputRefs', 'output', 'retention'], `steps[${index}]`)
  const capability = text(value.capability)
  if (!CAPABILITY_SET.has(capability)) fail(`steps[${index}] has unknown capability ${capability}`, 'unknown_capability')
  const dependsOn = Array.isArray(value.dependsOn) ? value.dependsOn.map(id) : []
  const inputRefs = Array.isArray(value.inputRefs) ? value.inputRefs.map(id) : []
  if (inputRefs.some((ref) => !assetIds.has(ref))) fail(`steps[${index}] references an unknown asset`, 'unknown_asset_ref')
  keysWithin(value.output ?? {}, ['format', 'maxBytes', 'classification', 'provenance'], `steps[${index}].output`)
  const output = Object.freeze({
    format: text(value.output?.format, 'json'),
    maxBytes: finite(value.output?.maxBytes, 256 * 1024),
    classification: text(value.output?.classification, 'internal'),
    provenance: value.output?.provenance === true,
  })
  return Object.freeze({
    id: id(value.id, `step-${index + 1}`),
    capability,
    dependsOn: Object.freeze(dependsOn),
    inputRefs: Object.freeze(inputRefs),
    output,
    retention: text(value.retention, 'session-only'),
  })
}

function validateDag(steps, profile) {
  const byId = new Map(steps.map((step) => [step.id, step]))
  if (byId.size !== steps.length) fail('step ids must be unique', 'duplicate_step')
  const state = new Map()
  const depth = new Map()
  const visit = (stepId, stack = []) => {
    if (state.get(stepId) === 'done') return depth.get(stepId)
    if (state.get(stepId) === 'visiting' || stack.includes(stepId)) fail(`workflow cycle at ${stepId}`, 'workflow_cycle')
    const step = byId.get(stepId)
    if (!step) fail(`unknown dependency ${stepId}`, 'unknown_dependency')
    state.set(stepId, 'visiting')
    let parentDepth = 0
    for (const dependency of step.dependsOn) parentDepth = Math.max(parentDepth, visit(dependency, [...stack, stepId]) + 1)
    if (parentDepth + 1 > profile.processingDepth) fail('workflow depth exceeds the selected Klyvaron profile', 'workflow_too_deep')
    state.set(stepId, 'done')
    depth.set(stepId, parentDepth)
    return parentDepth
  }
  for (const step of steps) visit(step.id)
  return { byId, depth }
}

/** Validate one versioned internal task envelope. Large binary content must remain asset references. */
export function validateTaskEnvelope(input = {}) {
  keysWithin(input, [
    'schemaVersion', 'taskId', 'traceId', 'kind', 'assets', 'requiredCapabilities',
    'profile', 'privacyMode', 'remoteExecutionConsent', 'allowedProviders',
    'costCeiling', 'latencyTargetMs', 'resourceBudget', 'steps', 'outputPolicy', 'retentionPolicy',
  ], 'task envelope')
  const forbidden = deepForbidden(input)
  if (forbidden) fail(`${forbidden} is forbidden in the task envelope`, 'binary_or_secret_field')
  if (input.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) fail('unsupported task envelope schema', 'unsupported_schema')
  if (!TASK_KINDS.includes(input.kind)) fail('unknown task kind', 'unknown_task_kind')
  if (!PROFILE_IDS.includes(input.profile)) fail('profile must be lite, pro or max', 'invalid_profile')
  if (!PRIVACY_MODES.includes(input.privacyMode)) fail('privacyMode must be local-only or external', 'invalid_privacy_mode')
  if (typeof input.remoteExecutionConsent !== 'boolean') fail('remoteExecutionConsent must be explicit', 'missing_consent')
  if (input.privacyMode === 'external' && input.remoteExecutionConsent !== true) {
    fail('external privacy mode requires explicit remote-execution consent', 'remote_consent_required')
  }
  const assets = Array.isArray(input.assets) ? input.assets : []
  if (assets.length > MAX_ASSETS) fail('too many assets', 'too_many_assets')
  const normalizedAssets = Object.freeze(assets.map(normalizeAsset))
  const assetIds = new Set(normalizedAssets.map((asset) => asset.id))
  const requiredCapabilities = Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities : []
  if (!requiredCapabilities.length || requiredCapabilities.length > MAX_STEPS
      || requiredCapabilities.some((capability) => !CAPABILITY_SET.has(capability))) {
    fail('requiredCapabilities must contain 1–12 known capability ids', 'invalid_capabilities')
  }
  const steps = Array.isArray(input.steps) ? input.steps : []
  if (!steps.length || steps.length > MAX_STEPS) fail('workflow must contain 1–12 steps', 'invalid_step_count')
  const normalizedSteps = Object.freeze(steps.map((step, index) => normalizeStep(step, index, assetIds)))
  const profile = KLYVARON_PROCESSOR_PROFILES[input.profile]
  validateDag(normalizedSteps, profile)
  keysWithin(input.outputPolicy ?? {}, ['format', 'maxBytes', 'classification', 'provenance'], 'outputPolicy')
  keysWithin(input.retentionPolicy ?? {}, ['mode', 'ttlSeconds'], 'retentionPolicy')
  keysWithin(input.resourceBudget ?? {}, ['maxSteps', 'maxChars', 'maxAssets'], 'resourceBudget')
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    taskId: id(input.taskId),
    traceId: id(input.traceId, 'unassigned'),
    kind: input.kind,
    assets: normalizedAssets,
    requiredCapabilities: Object.freeze([...new Set(requiredCapabilities)]),
    profile: input.profile,
    privacyMode: input.privacyMode,
    remoteExecutionConsent: input.remoteExecutionConsent,
    allowedProviders: Object.freeze((Array.isArray(input.allowedProviders) ? input.allowedProviders : []).map(id).slice(0, 12)),
    costCeiling: input.costCeiling === null || input.costCeiling === undefined ? null : finite(input.costCeiling, null),
    latencyTargetMs: input.latencyTargetMs === null || input.latencyTargetMs === undefined ? null : finite(input.latencyTargetMs, null),
    resourceBudget: Object.freeze({
      maxSteps: finite(input.resourceBudget?.maxSteps, profile.maxTasks),
      maxChars: finite(input.resourceBudget?.maxChars, profile.contextChars),
      maxAssets: finite(input.resourceBudget?.maxAssets, MAX_ASSETS),
    }),
    steps: normalizedSteps,
    outputPolicy: Object.freeze({
      format: text(input.outputPolicy?.format, 'json'),
      maxBytes: finite(input.outputPolicy?.maxBytes, 256 * 1024),
      classification: text(input.outputPolicy?.classification, 'internal'),
      provenance: input.outputPolicy?.provenance !== false,
    }),
    retentionPolicy: Object.freeze({
      mode: text(input.retentionPolicy?.mode, 'session-only'),
      ttlSeconds: finite(input.retentionPolicy?.ttlSeconds, 0),
    }),
  })
}

function capabilityState(capability, envelope) {
  if (envelope.privacyMode === 'external') {
    return Object.freeze({ status: 'BLOCKED', reason: 'external execution is not performed by this local-only build', evidenceState: EVIDENCE_STATES.CONTRACT_TESTED })
  }
  if (LOCAL_SET.has(capability)) {
    return Object.freeze({ status: 'PASS', reason: 'local deterministic implementation', evidenceState: EVIDENCE_STATES.CONTRACT_TESTED })
  }
  return Object.freeze({
    status: 'BLOCKED',
    reason: BLOCKED_CAPABILITY_REASONS[capability] ?? 'capability has no qualified implementation',
    evidenceState: EVIDENCE_STATES.PLANNED,
  })
}

export function planWorkflow(input = {}) {
  const envelope = validateTaskEnvelope(input)
  const states = Object.freeze(envelope.steps.map((step) => Object.freeze({
    id: step.id,
    capability: step.capability,
    dependsOn: step.dependsOn,
    inputRefs: step.inputRefs,
    ...capabilityState(step.capability, envelope),
    runtime: LOCAL_SET.has(step.capability) ? 'local-deterministic-v1' : null,
    requiresApproval: !LOCAL_SET.has(step.capability),
    externalDataTransfer: false,
    estimatedCost: null,
    liveCallPerformed: false,
  })))
  const blocked = Object.freeze(states.filter((state) => state.status !== 'PASS').map((state) => Object.freeze({
    id: state.id, capability: state.capability, reason: state.reason,
  })))
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    taskId: envelope.taskId,
    traceId: envelope.traceId,
    kind: envelope.kind,
    profile: envelope.profile,
    privacyMode: envelope.privacyMode,
    evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
    steps: states,
    blocked,
    noSilentSubstitution: true,
    providerCalls: 0,
    liveCallPerformed: false,
    releasePublished: false,
    note: 'Plan preview only: no provider call, credential, model weight, sandbox or side effect was used.',
  })
}

function safeContext(context = {}) {
  if (!context || typeof context !== 'object') return {}
  const forbidden = deepForbidden(context)
  if (forbidden) fail(`${forbidden} is forbidden in workflow context`, 'binary_or_secret_field')
  return context
}

function tokenSet(value) {
  return new Set(text(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2).slice(0, 200))
}

function overlapScore(a, b) {
  const left = tokenSet(a), right = tokenSet(b)
  let score = 0
  for (const token of left) if (right.has(token)) score += 1
  return score
}

function arithmetic(expressionText) {
  const source = typeof expressionText === 'string' ? expressionText : ''
  if (!/^[\d\s.+\-*/()]+$/.test(source)) fail('only bounded arithmetic is accepted', 'unsafe_expression')
  const tokens = source.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? []
  let position = 0
  const peek = () => tokens[position]
  const take = () => tokens[position++]
  const factor = () => {
    const token = peek()
    if (token === '-') { take(); return -factor() }
    if (token === '(') { take(); const value = parseExpression(); if (take() !== ')') fail('unbalanced parentheses', 'unsafe_expression'); return value }
    if (token === undefined || !/^\d/.test(token)) fail('invalid arithmetic token', 'unsafe_expression')
    take()
    return Number(token)
  }
  const term = () => {
    let value = factor()
    while (peek() === '*' || peek() === '/') {
      const operator = take(), right = factor()
      value = operator === '*' ? value * right : value / right
    }
    return value
  }
  const parseExpression = () => {
    let value = term()
    while (peek() === '+' || peek() === '-') {
      const operator = take(), right = term()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  const result = parseExpression()
  if (position !== tokens.length || !Number.isFinite(result)) fail('invalid arithmetic expression', 'unsafe_expression')
  return result
}

function stats(samples) {
  const values = (Array.isArray(samples) ? samples : []).map(Number).filter(Number.isFinite)
  if (!values.length) fail('numeric samples are required', 'invalid_samples')
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Object.freeze({
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean,
    rms: Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length),
    stddev: Math.sqrt(variance),
  })
}

function metadataResult(kind, context, required) {
  const asset = context.asset && typeof context.asset === 'object' ? context.asset : null
  const missing = required.filter((field) => asset?.[field] === undefined || asset?.[field] === null)
  return Object.freeze({
    status: missing.length ? 'FAIL' : 'PASS',
    kind,
    missing,
    metadata: asset ? Object.freeze({
      container: text(asset.container, 'unknown'),
      mimeType: text(asset.mimeType, 'unknown'),
      byteSize: finite(asset.byteSize, null),
      width: finite(asset.width, null),
      height: finite(asset.height, null),
      durationMs: finite(asset.durationMs, null),
      channels: finite(asset.channels, null),
      sampleRate: finite(asset.sampleRate, null),
      frameCount: finite(asset.frameCount, null),
      digest: asset.digest ? id(asset.digest) : null,
    }) : null,
    decoded: false,
    modelInference: false,
    identityInferred: false,
    note: 'Metadata validation only; no binary bytes were decoded and no model inference was performed.',
  })
}

function runLocalStep(step, envelope, context) {
  const profile = KLYVARON_PROCESSOR_PROFILES[envelope.profile]
  switch (step.capability) {
    case CAPABILITY_IDS.RESEARCH_SOURCE_FETCH: {
      const sources = Array.isArray(context.sources) ? context.sources.slice(0, profile.retrievalTopK) : []
      if (!sources.length) return Object.freeze({ status: 'BLOCKED', reason: 'no caller-supplied local sources', sources: Object.freeze([]) })
      return Object.freeze({
        status: 'PASS',
        sources: Object.freeze(sources.map((source) => Object.freeze({
          id: id(source?.id),
          title: text(source?.title, 'untitled'),
          freshness: text(source?.freshness, 'unknown'),
          byteSize: finite(source?.byteSize, null),
          digest: source?.digest ? id(source.digest) : null,
        }))),
        networkFetch: false,
      })
    }
    case CAPABILITY_IDS.RESEARCH_CITATIONS: {
      const sources = Array.isArray(context.sources) ? context.sources : []
      const claims = Array.isArray(context.claims) ? context.claims.map((claim) => text(claim)).filter(Boolean).slice(0, 20) : []
      const citations = Object.freeze(claims.map((claim) => {
        const ranked = sources.map((source) => Object.freeze({ id: id(source?.id), score: overlapScore(claim, text(source?.text)) }))
          .sort((a, b) => b.score - a.score)
        const best = ranked[0]
        return Object.freeze({ claim, sourceId: best && best.score > 0 ? best.id : null, score: best?.score ?? 0 })
      }))
      return Object.freeze({ status: citations.some((entry) => entry.sourceId) ? 'PASS' : 'BLOCKED', citations, unresolvedClaimsAreNotAnswers: true })
    }
    case CAPABILITY_IDS.KNOWLEDGE_RETRIEVE: {
      const documents = Array.isArray(context.documents) ? context.documents : []
      const ranked = Object.freeze(documents.map((document) => Object.freeze({
        id: id(document?.id),
        score: overlapScore(context.query, text(document?.text)),
      })).sort((a, b) => b.score - a.score).slice(0, profile.retrievalTopK))
      return Object.freeze({ status: ranked.length ? 'PASS' : 'BLOCKED', matches: ranked, deterministic: true, embeddingsUsed: false })
    }
    case CAPABILITY_IDS.KNOWLEDGE_INDEX:
      return Object.freeze({ status: 'PASS', indexed: Array.isArray(context.documents) ? context.documents.length : 0, durableWrite: false, note: 'Local lexical index only; no persistence side effect.' })
    case CAPABILITY_IDS.CODE_REVIEW: {
      const code = typeof context.code === 'string' ? context.code.slice(0, MAX_TEXT) : ''
      if (!code) return Object.freeze({ status: 'BLOCKED', reason: 'no caller-supplied code', findings: Object.freeze([]) })
      const patterns = Object.freeze([
        ['eval', /\beval\s*\(/],
        ['child_process', /child_process|execSync|spawnSync/],
        ['env_secret', /process\.env|api[_-]?key|secret|token|password/i],
        ['todo', /\bTODO\b|\bFIXME\b/],
        ['network', /\bfetch\s*\(|https?:\/\//i],
      ])
      const findings = Object.freeze(patterns.filter(([, pattern]) => pattern.test(code)).map(([name]) => name))
      return Object.freeze({ status: 'PASS', findings, executionPerformed: false, patchApplied: false, networkUsed: false })
    }
    case CAPABILITY_IDS.IMAGE_INPUT:
      return metadataResult('image', context, ['mimeType', 'byteSize', 'width', 'height', 'digest'])
    case CAPABILITY_IDS.AUDIO_INPUT:
      return metadataResult('audio', context, ['container', 'byteSize', 'durationMs', 'channels', 'sampleRate', 'digest'])
    case CAPABILITY_IDS.VIDEO_INPUT:
    case CAPABILITY_IDS.VIDEO_FRAME_EXTRACT:
      return metadataResult('video', context, ['container', 'byteSize', 'durationMs', 'width', 'height', 'frameCount', 'digest'])
    case CAPABILITY_IDS.DOCUMENT_PARSE: {
      const source = typeof context.text === 'string' ? context.text.slice(0, profile.contextChars) : ''
      if (!source) return Object.freeze({ status: 'BLOCKED', reason: 'no caller-supplied document text', headings: Object.freeze([]) })
      const headings = Object.freeze([...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => text(match[1])).slice(0, 50))
      const lines = source.split(/\r?\n/).length
      return Object.freeze({ status: 'PASS', headings, lineCount: lines, macrosExecuted: false, generatedInterpretation: false })
    }
    case CAPABILITY_IDS.DOCUMENT_TABLE_EXTRACT: {
      const table = typeof context.tableText === 'string' ? context.tableText.slice(0, profile.contextChars) : ''
      if (!table) return Object.freeze({ status: 'BLOCKED', reason: 'no caller-supplied table text', rows: Object.freeze([]) })
      const rows = Object.freeze(table.split(/\r?\n/).filter(Boolean).slice(0, 100).map((line) => Object.freeze(line.split(',').map((cell) => text(cell)))))
      return Object.freeze({ status: 'PASS', rows, macrosExecuted: false, archiveExpansion: false })
    }
    case CAPABILITY_IDS.ENGINEERING_CALCULATE:
      return Object.freeze({ status: 'PASS', expression: text(context.expression), value: arithmetic(context.expression), evalUsed: false, units: text(context.units, 'unspecified'), dimensionalCheck: text(context.units, '') ? 'declared' : 'not_declared' })
    case CAPABILITY_IDS.ENGINEERING_SIGNAL_ANALYSIS:
      return Object.freeze({ status: 'PASS', ...stats(context.samples), transform: 'time-domain summary only', fftPerformed: false })
    case CAPABILITY_IDS.ENGINEERING_TIMESERIES_ANOMALY: {
      const summary = stats(context.samples)
      const threshold = finite(context.threshold, 3)
      const anomalies = Object.freeze((Array.isArray(context.samples) ? context.samples : []).map(Number).filter(Number.isFinite)
        .map((value, index) => Object.freeze({ index, value, zScore: summary.stddev ? (value - summary.mean) / summary.stddev : 0 }))
        .filter((entry) => Math.abs(entry.zScore) >= threshold))
      return Object.freeze({ status: 'PASS', threshold, anomalies, method: 'z-score', trainedModelUsed: false })
    }
    case CAPABILITY_IDS.ENGINEERING_MAINTENANCE_REPORT: {
      const summary = stats(context.samples)
      const limit = finite(context.limit, summary.max)
      return Object.freeze({
        status: 'PASS',
        adviceOnly: true,
        actuationPerformed: false,
        scadaWrite: false,
        recommendation: summary.max > limit ? 'Inspect the sensor and correlate SCADA events; do not actuate automatically.' : 'No threshold breach in the supplied samples.',
        summary,
        limit,
      })
    }
    case CAPABILITY_IDS.BENCHMARK_EVIDENCE:
      return Object.freeze({ status: 'PASS', evidence: buildBenchmarkEvidence(context.benchmark) })
    default:
      return Object.freeze({ status: 'BLOCKED', reason: BLOCKED_CAPABILITY_REASONS[step.capability] ?? 'no qualified implementation' })
  }
}

/** Build explicit benchmark evidence; unsupported live/release states are refused. */
export function buildBenchmarkEvidence(input = {}) {
  keysWithin(input, [
    'version', 'datasetDigest', 'testSplit', 'providerId', 'endpointId', 'modelId', 'runtimeId',
    'hardware', 'software', 'qualityMetric', 'threshold', 'samples', 'measurementOptions',
    'safetyChecks', 'evidenceArtifact', 'evidenceState',
  ], 'benchmark evidence')
  const forbidden = deepForbidden(input)
  if (forbidden) fail(`${forbidden} is forbidden in benchmark evidence`, 'binary_or_secret_field')
  const measurement = summarizeMeasurements(input.samples, input.measurementOptions)
  const requestedState = text(input.evidenceState, EVIDENCE_STATES.CONTRACT_TESTED)
  if (![EVIDENCE_STATES.PLANNED, EVIDENCE_STATES.IMPLEMENTED, EVIDENCE_STATES.CONTRACT_TESTED, EVIDENCE_STATES.EVALUATED].includes(requestedState)) {
    fail(`${requestedState} requires explicit live/production evidence and approval`, 'unsupported_evidence_state')
  }
  if (requestedState === EVIDENCE_STATES.EVALUATED && (measurement.state !== 'measured' || finite(input.threshold, null) === null || text(input.qualityMetric, '') === '')) {
    fail('evaluated evidence needs a measured sample, quality metric and threshold', 'unsupported_evaluation')
  }
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    version: text(input.version),
    datasetDigest: id(input.datasetDigest),
    testSplit: text(input.testSplit),
    providerId: id(input.providerId),
    endpointId: id(input.endpointId),
    modelId: id(input.modelId),
    runtimeId: id(input.runtimeId),
    hardware: text(input.hardware),
    software: text(input.software),
    qualityMetric: text(input.qualityMetric),
    threshold: finite(input.threshold, null),
    measurement,
    safetyChecks: Object.freeze((Array.isArray(input.safetyChecks) ? input.safetyChecks : []).map((item) => text(item))),
    evidenceArtifact: input.evidenceArtifact ? id(input.evidenceArtifact) : null,
    evidenceState: requestedState,
    liveVerified: false,
    releasePublished: false,
    note: 'No live provider call, credential, model weight or quality superiority claim is included.',
  })
}

/** Execute only local deterministic steps; blocked capabilities are refusals, never substitutions. */
export function executeWorkflow(input = {}, context = {}) {
  const envelope = validateTaskEnvelope(input)
  const safe = safeContext(context)
  const assertNotAborted = () => {
    if (safe.signal?.aborted) throw Object.assign(new WorkflowError('Workflow cancelled.', 'cancelled', 499), { name: 'AbortError' })
  }
  assertNotAborted()
  const plan = planWorkflow(envelope)
  if (plan.blocked.length) {
    return Object.freeze({
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      taskId: envelope.taskId,
      traceId: envelope.traceId,
      status: 'BLOCKED',
      blocked: plan.blocked,
      steps: Object.freeze([]),
      summary: Object.freeze({ pass: 0, fail: 0, blocked: plan.blocked.length, notTested: 0 }),
      evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
      liveCallPerformed: false,
      providerCalls: 0,
      credentialIncluded: false,
      modelWeightsUsed: false,
      networkUsed: false,
      destructiveActions: 0,
      noSilentSubstitution: true,
      note: 'Refused before execution because at least one capability has no qualified local implementation.',
    })
  }
  const { byId } = validateDag(envelope.steps, KLYVARON_PROCESSOR_PROFILES[envelope.profile])
  const completed = new Set()
  const steps = []
  const run = (step) => {
    assertNotAborted()
    if (completed.has(step.id)) return
    for (const dependency of step.dependsOn) run(byId.get(dependency))
    const output = runLocalStep(step, envelope, safe)
    steps.push(Object.freeze({
      id: step.id,
      capability: step.capability,
      dependsOn: step.dependsOn,
      status: output.status ?? 'PASS',
      output,
      provenance: Object.freeze({
        runtime: 'local-deterministic-v1',
        profile: envelope.profile,
        traceId: envelope.traceId,
        schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
        credentialIncluded: false,
        rawEndpointIncluded: false,
        modelWeightsUsed: false,
        networkUsed: false,
      }),
      evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
      liveVerified: false,
    }))
    completed.add(step.id)
  }
  for (const step of envelope.steps) run(step)
  const summary = {
    pass: steps.filter((step) => step.status === 'PASS').length,
    fail: steps.filter((step) => step.status === 'FAIL').length,
    blocked: steps.filter((step) => step.status === 'BLOCKED').length,
    notTested: steps.filter((step) => step.status === 'NOT TESTED').length,
  }
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    taskId: envelope.taskId,
    traceId: envelope.traceId,
    status: summary.fail || summary.blocked ? 'BLOCKED' : 'PASS',
    steps: Object.freeze(steps),
    summary: Object.freeze(summary),
    evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
    liveCallPerformed: false,
    providerCalls: 0,
    credentialIncluded: false,
    modelWeightsUsed: false,
    networkUsed: false,
    destructiveActions: 0,
    noSilentSubstitution: true,
    note: 'Local deterministic execution only; no provider, model, sandbox, deployment or destructive action was used.',
  })
}

/** Honest platform-delivery evidence for Phase 7/9; no production action is performed. */
export function platformReadiness() {
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
    items: Object.freeze({
      dockerLoopback: Object.freeze({ status: 'PASS', evidence: 'CI Compose build, health, persistence and restore smoke' }),
      hostedByok: Object.freeze({ status: 'NOT TESTED', reason: 'no production deployment or credential change' }),
      desktop: Object.freeze({ status: 'PASS', evidence: 'CI packaged smoke on Linux, Windows, macOS Intel and macOS Apple Silicon; installers unsigned' }),
      mobile: Object.freeze({ status: 'NOT TESTED', reason: 'no mobile qualification run' }),
      cli: Object.freeze({ status: 'NOT TESTED', reason: 'no CLI qualification run' }),
      backupRestore: Object.freeze({ status: 'PASS', evidence: 'synthetic CI volume cold-backup/restore' }),
      productionRollback: Object.freeze({ status: 'NOT TESTED', reason: 'requires an actual release deployment' }),
      telemetry: Object.freeze({ status: 'BLOCKED', reason: 'opt-in telemetry transmission is not implemented' }),
      upgrade: Object.freeze({ status: 'NOT TESTED', reason: 'no upgrade rehearsal on a release deployment' }),
      releasePublication: Object.freeze({ status: 'BLOCKED', reason: 'explicit approval required' }),
    }),
    releasePublished: false,
    liveProviderCall: false,
    credentialChange: false,
    destructiveCleanup: false,
    note: 'PASS here means contract/CI evidence, not production deployment or release approval.',
  })
}

/** One combined Phase 3–9 report: plan, local execution, benchmark evidence and platform state. */
export function buildFullPhaseReport(input = {}, context = {}) {
  const envelope = validateTaskEnvelope(input)
  const plan = planWorkflow(envelope)
  const execution = executeWorkflow(envelope, context)
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    phases: Object.freeze(['3', '4', '5', '6', '7', '8', '9']),
    envelope,
    plan,
    execution,
    benchmark: context.benchmark ? buildBenchmarkEvidence(context.benchmark) : null,
    platform: platformReadiness(),
    evidenceState: EVIDENCE_STATES.CONTRACT_TESTED,
    liveVerified: false,
    releasePublished: false,
    noSilentSubstitution: true,
    note: 'Phases 3–9 are represented by local-only, contract-tested orchestration and explicit refusals; live/provider/model/deployment/release capabilities remain blocked or not tested.',
  })
}
