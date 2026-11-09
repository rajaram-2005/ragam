// Privacy-conscious operational monitoring for the Core service.
//
// This module keeps *counters and numeric samples in memory*. It transmits nothing,
// writes nothing to disk, and never stores a prompt, a dataset, an API key, an
// account id, an email address or a free-form error message. Every field that can
// be recorded is on an allowlist and is shape-checked before it is kept; anything
// else is dropped and counted as a redaction. That makes the privacy property a
// property of the code rather than of a logging convention.
//
// Optional telemetry is disabled with AETHERIS_TELEMETRY_ENABLED=false (also 0,
// no, off). When disabled, record() is a no-op and snapshot() reports that state.
// No network sink exists: this monitor is read through readiness() and can be
// switched off completely by the operator.

export const TELEMETRY_DISABLE_ENV = 'AETHERIS_TELEMETRY_ENABLED'

export const OPERATIONAL_EVENTS = Object.freeze([
  'health_check',
  'api_failure',
  'provider_unavailable',
  'provider_available',
  'model_load_failure',
  'inference_latency',
  'training_worker_failure',
  'job_completed',
  'job_cancelled',
  'resource_sample',
  'deployment_health',
])

const EVENT_SET = new Set(OPERATIONAL_EVENTS)
const OUTCOMES = Object.freeze(['ok', 'failure', 'timeout', 'cancelled', 'refused', 'unavailable'])
const OUTCOME_SET = new Set(OUTCOMES)
const SAFE_LABEL = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_SAMPLES = 32
const MAX_DURATION_MS = 3_600_000

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off'])

function safeLabel(value, fallback = 'unknown') {
  return typeof value === 'string' && SAFE_LABEL.test(value) ? value : fallback
}

function safeDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(Math.round(value), MAX_DURATION_MS)
}

/** An in-memory, bounded, allowlisted operational counter set. */
export class OperationalMonitor {
  constructor({ enabled = true, now = () => Date.now() } = {}) {
    this.enabled = enabled === true
    this.now = now
    this.startedAt = new Date(this.now()).toISOString()
    this.total = 0
    this.redacted = 0
    this.refused = 0
    this.counters = Object.create(null)
    this.latency = Object.create(null)
    this.privacy = Object.freeze({
      transmission: 'none',
      storage: 'in_memory_only',
      rawPrompts: false,
      privateDatasets: false,
      apiKeys: false,
      accountIdentifiers: false,
      freeFormText: false,
      fieldAllowlist: Object.freeze(['event', 'outcome', 'component', 'durationMs']),
    })
    for (const event of OPERATIONAL_EVENTS) this.counters[event] = 0
  }

  /**
   * Record one operational event. Unknown events, unparseable labels and every
   * extra field are refused or dropped, never stored. Returns a boolean so a
   * caller can see that recording happened without inspecting the snapshot.
   */
  record(event, detail = {}) {
    if (!this.enabled) return false
    if (!EVENT_SET.has(event)) {
      this.refused += 1
      return false
    }
    const input = detail && typeof detail === 'object' ? detail : {}
    const extra = Object.keys(input).filter((key) => !['outcome', 'component', 'durationMs'].includes(key))
    if (extra.length) this.redacted += extra.length
    const outcome = OUTCOME_SET.has(input.outcome) ? input.outcome : 'ok'
    const component = safeLabel(input.component, 'core')
    const durationMs = safeDuration(input.durationMs)
    this.counters[event] += 1
    this.total += 1
    if (event === 'inference_latency' && durationMs !== null) {
      const samples = this.latency[component] ?? []
      samples.push(durationMs)
      if (samples.length > MAX_SAMPLES) samples.shift()
      this.latency[component] = samples
    }
    return true
  }

  /** JSON-safe, bounded snapshot. Never contains a value supplied by a user. */
  snapshot() {
    const latency = Object.create(null)
    for (const [component, samples] of Object.entries(this.latency)) {
      const sorted = [...samples].sort((a, b) => a - b)
      latency[component] = {
        samples: sorted.length,
        minMs: sorted[0] ?? null,
        maxMs: sorted[sorted.length - 1] ?? null,
        meanMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
      }
    }
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      recordedEvents: this.total,
      redactedFields: this.redacted,
      refusedEvents: this.refused,
      counters: { ...this.counters },
      latency,
      events: [...OPERATIONAL_EVENTS],
      disable: `set ${TELEMETRY_DISABLE_ENV}=false and restart the Core process`,
      privacy: { ...this.privacy },
    }
  }
}

/** Build the monitor from the deployment environment. Default: enabled locally, no sink. */
export function monitorFromEnv(env = process.env) {
  // The literal process.env form is intentional: the deployment-variable inventory
  // scans source for exactly this, so the switch cannot become undocumented.
  const raw = env?.AETHERIS_TELEMETRY_ENABLED ?? process.env.AETHERIS_TELEMETRY_ENABLED
  const enabled = raw === undefined || !DISABLED_VALUES.has(String(raw).trim().toLowerCase())
  return new OperationalMonitor({ enabled })
}
