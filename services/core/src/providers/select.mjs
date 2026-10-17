// Capability-based provider selection.
//
// The rule this module is built around is the one the directive states twice, in two different
// forms: never silently switch to a remote provider when offline mode is active, and never silently
// send private content somewhere after a failure. Both are refusals, not preferences — so the
// selector's normal output is a *decision with reasons*, and its failure output is a list of why
// each candidate was rejected.
//
// It deliberately has no fallback ordering that skips a hard requirement. A candidate either meets
// every stated requirement or it is rejected with a code; the caller can then show that list. The
// alternative — "best available" — is how a request for tool calling quietly becomes a request that
// is answered without tools.
//
// It also refuses to infer. A provider with no recorded context limit does not satisfy a request
// that states a minimum context; unknown is not "probably enough".

import { PROVIDERS, PROVIDER_STATUS, CAPABILITIES, validateCatalogue } from './catalog.mjs'

export const REFUSAL_CODES = Object.freeze({
  ADAPTER_PENDING: 'adapter_pending',
  WIRE_NOT_IMPLEMENTED: 'wire_not_implemented',
  CAPABILITY_MISSING: 'capability_not_supported',
  CONTEXT_UNKNOWN: 'context_unknown',
  CONTEXT_TOO_SMALL: 'context_too_small',
  OFFLINE: 'blocked_by_offline_policy',
  REMOTE_NOT_ALLOWED: 'remote_not_allowed',
  UNHEALTHY: 'provider_unhealthy',
  AUTH_MISSING: 'credential_missing',
  UNKNOWN_PROVIDER: 'unknown_provider',
})

/** The status a provider must have before it may be selected at all. */
const SELECTABLE = new Set([PROVIDER_STATUS.READY])

/**
 * Choose a provider for a request.
 *
 * @param {object} request
 * @param {string[]} [request.capabilities]  capability ids the request needs
 * @param {number} [request.minContextTokens] a stated minimum; unknown context does not satisfy it
 * @param {boolean} [request.remote]          true when the request would leave this machine
 * @param {string[]} [request.ids]            restrict the field to these providers
 * @param {object} policy
 * @param {boolean} [policy.offline]          strict offline: no remote provider may be chosen
 * @param {boolean} [policy.allowRemote]      installation opt-in for external providers
 * @param {string[]} [policy.allowedHosts]    optional egress allowlist, by provider id
 * @param {object} [health]                   { [providerId]: 'ready' | 'unavailable' | 'unverified' }
 * @param {object[]} [providers]
 */
export function selectProvider(request = {}, policy = {}, health = {}, providers = PROVIDERS) {
  const { capabilities = [], minContextTokens = null, remote = null, ids = null } = request
  const rejected = []
  const eligible = []

  const reject = (id, code, why) => rejected.push(Object.freeze({ id, code, why }))

  if (policy.offline === true && remote !== false) {
    // Offline mode is a property of the request, not of the candidate list: even an in-process
    // provider is refused when the caller says the request is remote, because the caller is
    // describing where the content would go and the policy is about where content may go.
    if (remote === true) {
      return Object.freeze({
        chosen: null,
        rejected: Object.freeze(rejected),
        explanation: 'Refused: the request would leave this machine and strict offline policy is active.',
      })
    }
  }

  for (const provider of providers) {
    if (ids && !ids.includes(provider.id)) continue

    // Status first: a pending adapter is refused even if it advertises every capability, because
    // the advertisement is exactly what cannot be trusted.
    if (!SELECTABLE.has(provider.status)) {
      reject(provider.id, provider.status === PROVIDER_STATUS.PENDING ? REFUSAL_CODES.ADAPTER_PENDING : REFUSAL_CODES.WIRE_NOT_IMPLEMENTED,
        provider.status === PROVIDER_STATUS.PENDING
          ? 'no adapter in this build; it is listed, not implemented'
          : 'reachable only through an operator-configured compatible endpoint, which this selection cannot assume')
      continue
    }

    const missing = capabilities.filter((id) => !provider.capabilities.some((capability) => capability.id === id))
    if (missing.length) {
      reject(provider.id, REFUSAL_CODES.CAPABILITY_MISSING, `does not evidence ${missing.join(', ')}`)
      continue
    }

    // A capability that is claimed only by documentation is not enough for selection; `ready`
    // providers are all test-backed by validation, so this is a belt-and-braces check.
    const unevidenced = capabilities.filter((id) => provider.capabilities.find((capability) => capability.id === id)?.source !== 'test')
    if (unevidenced.length) {
      reject(provider.id, REFUSAL_CODES.CAPABILITY_MISSING, `${unevidenced.join(', ')} is documented but not tested here`)
      continue
    }

    if (minContextTokens !== null) {
      const limit = provider.limits?.contextTokens ?? null
      if (limit === null) {
        reject(provider.id, REFUSAL_CODES.CONTEXT_UNKNOWN, `needs ${minContextTokens} tokens of context; this provider's limit is not recorded`)
        continue
      }
      if (limit < minContextTokens) {
        reject(provider.id, REFUSAL_CODES.CONTEXT_TOO_SMALL, `context limit ${limit} is below the ${minContextTokens} required`)
        continue
      }
    }

    if (policy.offline === true && provider.status !== PROVIDER_STATUS.READY) {
      reject(provider.id, REFUSAL_CODES.OFFLINE, 'strict offline policy is active')
      continue
    }
    if (remote === true && policy.allowRemote !== true) {
      reject(provider.id, REFUSAL_CODES.REMOTE_NOT_ALLOWED, 'the installation has not opted in to external providers')
      continue
    }
    if (Array.isArray(policy.allowedHosts) && !policy.allowedHosts.includes(provider.id)) {
      reject(provider.id, REFUSAL_CODES.REMOTE_NOT_ALLOWED, 'not on the configured egress allowlist')
      continue
    }

    const state = health[provider.id] ?? 'unverified'
    if (state === 'unavailable') {
      reject(provider.id, REFUSAL_CODES.UNHEALTHY, 'health check failed')
      continue
    }

    eligible.push(provider)
  }

  if (eligible.length === 0) {
    return Object.freeze({
      chosen: null,
      rejected: Object.freeze(rejected),
      explanation: rejected.length
        ? `No provider can serve this request: ${rejected.map((entry) => `${entry.id} (${entry.code})`).join(', ')}.`
        : 'No provider was offered.',
    })
  }

  // Stable, explainable choice among equals: `ready` providers are the only ones here, and the
  // order is the catalogue's (which is the maintained order), not alphabetical or random.
  const chosen = eligible[0]
  return Object.freeze({
    chosen: Object.freeze({
      id: chosen.id,
      label: chosen.label,
      // Health is reported alongside the choice so a caller cannot mistake "selected" for "probed".
      health: health[chosen.id] ?? 'unverified',
      capabilities: Object.freeze(capabilities.map((id) => Object.freeze({ id, evidence: chosen.capabilities.find((c) => c.id === id).source }))),
    }),
    rejected: Object.freeze(rejected),
    explanation: `Selected ${chosen.label} (${chosen.id}): it is the first ready provider that evidences ${capabilities.join(', ') || 'the request'}.`,
  })
}

/** Human-readable capability summary for one provider, used by the API and the docs test. */
export function capabilityMatrix(providers = PROVIDERS) {
  const verdict = validateCatalogue(providers)
  return Object.freeze({
    valid: verdict.valid,
    rows: Object.freeze(providers.map((provider) => Object.freeze({
      id: provider.id,
      status: provider.status,
      capabilities: Object.freeze(provider.capabilities.map((capability) => capability.id)),
      tested: Object.freeze(provider.capabilities.filter((capability) => capability.source === 'test').map((capability) => capability.id)),
    }))),
    // The honest headline: how many providers have a tested path, and which.
    tested: Object.freeze(providers.filter((provider) => provider.status === PROVIDER_STATUS.READY).map((provider) => provider.id)),
    available: Object.freeze(Object.values(CAPABILITIES)),
  })
}
