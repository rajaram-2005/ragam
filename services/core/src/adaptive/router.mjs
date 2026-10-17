// Task routing: pick the least expensive route that is allowed to run and can do the job.
//
// This is deliberately not the model router (`router/registry.mjs`). That one chooses a
// language model for a request; this one chooses *anything* that provides a capability --
// a tool, a stored skill, or a model -- because from the task's point of view they are
// interchangeable and only the constraints differ.
//
// Two rules shape every decision here:
//
//   * **Refuse rather than degrade.** If nothing satisfies the constraints, the answer is a
//     refusal naming each candidate and why it was rejected. Quietly running something that
//     failed a privacy or permission constraint is how a system ends up doing the wrong
//     thing competently.
//   * **A measurement outranks an estimate, and an estimate outranks nothing.** A candidate
//     with no cost data is not treated as free; it is treated as unknown, and it is only
//     selected when nothing measured is available -- with the decision record saying so.

import { PRIVACY_MODES, PRIVACY_MODES as _PRIVACY, providesAll, validateCapability, withinScope } from './capability.mjs'
import { DETERMINISM } from './capability.mjs'

export const REFUSAL_CODES = Object.freeze({
  NO_CAPABILITY: 'no_capability',
  PRIVACY: 'privacy',
  LATENCY: 'latency',
  PERMISSION: 'permission',
  DETERMINISM: 'determinism',
  EXCLUDED: 'excluded',
  NO_CANDIDATES: 'no_candidates',
})

export class RoutingError extends Error {
  constructor(message, code = 'routing_error', detail = {}) {
    super(message)
    this.name = 'RoutingError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Why a single candidate cannot serve the request. Returns null when it can.
 *
 * Order matters for the report, not for correctness: each check is independent, and the
 * record names the first reason that applied. A candidate that fails two constraints is
 * reported against the first, which is why the checks run from "cannot do it at all"
 * outward to "may not do it in this mode".
 */
function reject(descriptor, request, options) {
  if (!providesAll(descriptor, request.capabilities)) {
    return { code: REFUSAL_CODES.NO_CAPABILITY, reason: `does not provide ${request.capabilities.join(', ')}` }
  }
  if (request.exclude.includes(descriptor.id)) {
    return { code: REFUSAL_CODES.EXCLUDED, reason: 'excluded by the request' }
  }
  const allowExternal = options.allowExternal === true
  if (!allowExternal && descriptor.privacy !== PRIVACY_MODES.LOCAL_ONLY) {
    return {
      code: REFUSAL_CODES.PRIVACY,
      reason:
        `runs externally and this request is local-only. External execution is opt-in per request; ` +
        `pass allowExternal to permit it.`,
    }
  }
  if (request.requireDeterministic && descriptor.determinism !== DETERMINISM.DETERMINISTIC) {
    return {
      code: REFUSAL_CODES.DETERMINISM,
      reason: `is ${descriptor.determinism} and the request requires a deterministic result`,
    }
  }
  if (request.within !== undefined) {
    const allowed =
      withinScope(descriptor.permissions.fsRead, request.within) ||
      withinScope(descriptor.permissions.fsWrite, request.within)
    if (!allowed) {
      return {
        code: REFUSAL_CODES.PERMISSION,
        reason: `is not permitted to touch ${request.within}`,
      }
    }
  }
  if (request.maxLatencyMs !== undefined) {
    const measured = descriptor.cost?.measured ?? null
    if (!measured) {
      return {
        code: REFUSAL_CODES.LATENCY,
        reason:
          `has no measured cost against a ${request.maxLatencyMs} ms budget. An unmeasured route ` +
          `cannot be shown to meet a latency bound, so it is refused rather than assumed fast.`,
      }
    }
    if (measured.medianMs > request.maxLatencyMs) {
      return {
        code: REFUSAL_CODES.LATENCY,
        reason: `measured ${measured.medianMs} ms against a ${request.maxLatencyMs} ms budget`,
      }
    }
  }
  return null
}

/**
 * Route one task.
 *
 * @param {object} task
 * @param {string[]} task.capabilities      capability tags the task needs
 * @param {string}  [task.within]           a path the route must be permitted to touch
 * @param {number}  [task.maxLatencyMs]     budget; unmeasured candidates are refused
 * @param {boolean} [task.requireDeterministic]
 * @param {string[]} [task.exclude]         capability ids never to choose
 * @returns {object} a decision record. Never throws for "nothing fits" -- a refusal is a
 *                   result, and it is returned with the evidence that produced it.
 */
export function routeTask(task, candidates, { allowExternal = false, preferId = null, allowUnmeasured = true } = {}) {
  if (!task || !Array.isArray(task.capabilities) || !task.capabilities.length) {
    throw new RoutingError('a task must name at least one capability', 'no_capabilities')
  }
  if (!Array.isArray(candidates)) {
    throw new RoutingError('routeTask needs a list of candidates', 'no_candidates', {})
  }

  const request = Object.freeze({
    capabilities: Object.freeze([...task.capabilities]),
    within: task.within,
    maxLatencyMs: task.maxLatencyMs,
    requireDeterministic: task.requireDeterministic === true,
    exclude: Object.freeze([...(task.exclude ?? [])]),
  })

  const rejected = []
  const accepted = []
  for (const raw of candidates) {
    const descriptor = validateCapability(raw)
    const reason = reject(descriptor, request, { allowExternal })
    if (reason) {
      rejected.push({ id: descriptor.id, code: reason.code, reason: reason.reason })
      continue
    }
    accepted.push(descriptor)
  }

  if (!accepted.length) {
    return Object.freeze({
      task: { capabilities: request.capabilities },
      chosen: null,
      considered: rejected,
      refused: Object.freeze({
        code: rejected.length ? 'constraints_unsatisfied' : REFUSAL_CODES.NO_CANDIDATES,
        message: rejected.length
          ? `no route satisfies this task: ${rejected.length} candidate(s) considered, each rejected for a named reason`
          : 'no candidates were offered for this task',
      }),
    })
  }

  const measured = accepted.filter((d) => d.cost?.measured)
  const unmeasured = accepted.filter((d) => !d.cost?.measured)

  // Preference is honoured only among candidates that survived the same gates, so a pinned
  // id can never smuggle in something the constraints rejected.
  const pinned = preferId ? accepted.find((d) => d.id === preferId) : null
  let pool = measured
  let basis = 'measured cost on this machine'
  if (!pool.length) {
    pool = unmeasured
    basis = 'no candidate has a measured cost, so an unmeasured one was chosen and is marked as unmeasured'
    if (!allowUnmeasured) {
      return Object.freeze({
        task: { capabilities: request.capabilities },
        chosen: null,
        considered: rejected,
        refused: Object.freeze({
          code: 'unmeasured',
          message: `every candidate that satisfies the constraints is unmeasured, and this call sets allowUnmeasured: false`,
        }),
      })
    }
  }

  const ranked = [...pool].sort((a, b) => {
    const am = a.cost?.measured?.medianMs ?? Number.POSITIVE_INFINITY
    const bm = b.cost?.measured?.medianMs ?? Number.POSITIVE_INFINITY
    if (am !== bm) return am - bm
    return a.id.localeCompare(b.id) // deterministic tie-break, so two runs agree
  })

  const chosen = pinned ?? ranked[0]
  const alternatives = ranked.filter((d) => d.id !== chosen.id)

  return Object.freeze({
    task: { capabilities: request.capabilities },
    chosen: Object.freeze({
      id: chosen.id,
      kind: chosen.kind,
      version: chosen.version,
      because: describeChoice(chosen, alternatives, { basis, pinned: Boolean(pinned), measured: chosen.cost?.measured ?? null }),
      measuredMedianMs: chosen.cost?.measured?.medianMs ?? null,
      unmeasured: !chosen.cost?.measured,
    }),
    alternatives: Object.freeze(
      alternatives.map((d) => ({
        id: d.id,
        measuredMedianMs: d.cost?.measured?.medianMs ?? null,
        relativeCost: relativeCost(chosen, d),
      })),
    ),
    considered: Object.freeze(rejected),
    refused: null,
  })
}

function describeChoice(chosen, alternatives, { basis, pinned, measured }) {
  if (pinned) {
    return `pinned by the caller and allowed by every constraint; basis ${basis}`
  }
  if (!measured) {
    return `the only candidate satisfying the constraints with cost data available: none. Basis: ${basis}`
  }
  const cheaper = alternatives
    .filter((d) => d.cost?.measured)
    .map((d) => `${d.id} ${d.cost.measured.medianMs} ms`)
  const comparison = cheaper.length ? `; measured against ${cheaper.join(', ')}` : ''
  return `${measured.medianMs} ms median over ${measured.samples} run(s) on ${measured.input}${comparison}`
}

function relativeCost(chosen, other) {
  const a = chosen.cost?.measured?.medianMs
  const b = other.cost?.measured?.medianMs
  if (a == null || b == null || b === 0) return null
  return Math.round((a / b) * 1000) / 1000
}
