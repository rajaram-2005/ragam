// Capability descriptors: what a thing can do, what it costs, and what it may touch.
//
// Every routing decision in this service is a decision over these descriptors, and every
// field here exists because a decision needs it. `provides` is what a task asks for.
// `permissions` is the boundary the executor must not cross, and it is enforced by the
// executor rather than promised in prose. `cost` is what the thing measured last time, on
// this machine, on a named input -- not what its author estimated. `limitations` is what it
// does not do, carried on the descriptor so that a route which ignores one is visibly
// ignoring it rather than silently inheriting a limitation it never read.
//
// The three kinds are separate on purpose. A tool runs here and now; a skill is a stored
// procedure with its own version and tests; a model is a network with weights. They are
// routable through the same interface because a task does not care which of them answers it,
// and they are distinguishable because a card, a plan and a privacy decision all care.

import { relative, resolve, sep } from 'node:path'

export const CAPABILITY_KINDS = Object.freeze({
  TOOL: 'tool',
  SKILL: 'skill',
  MODEL: 'model',
})

/** Where a capability runs. Anything not `local-only` leaves this machine. */
export const PRIVACY_MODES = Object.freeze({
  LOCAL_ONLY: 'local-only',
  EXTERNAL: 'external',
})

export const DETERMINISM = Object.freeze({
  DETERMINISTIC: 'deterministic',
  SAMPLED: 'sampled',
})

export class CapabilityError extends Error {
  constructor(message, code = 'capability_error', detail = {}) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
    this.detail = detail
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,62}$/

/**
 * Normalise and check a descriptor. Returns a frozen copy; the caller's object is not
 * retained, so a later mutation of it cannot change what the router decided on.
 *
 * Refusals are specific because the caller has to act on them: a missing `provides` means
 * the thing cannot be routed at all, while a bad `cost` means it can be routed but must be
 * treated as unmeasured.
 */
export function validateCapability(input) {
  if (!input || typeof input !== 'object') {
    throw new CapabilityError('a capability descriptor must be an object', 'not_an_object')
  }
  const { id, kind, provides } = input
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new CapabilityError(`capability id '${id}' must be lowercase kebab-case`, 'invalid_id')
  }
  if (!Object.values(CAPABILITY_KINDS).includes(kind)) {
    throw new CapabilityError(
      `capability '${id}' has kind '${kind}'; expected one of ${Object.values(CAPABILITY_KINDS).join(', ')}`,
      'invalid_kind',
    )
  }
  if (!Array.isArray(provides) || !provides.length) {
    throw new CapabilityError(`capability '${id}' must provide at least one capability tag`, 'no_capabilities')
  }
  for (const tag of provides) {
    if (typeof tag !== 'string' || !tag.includes('.')) {
      throw new CapabilityError(
        `capability tag '${tag}' must be dotted, e.g. 'tree.line-count'`,
        'invalid_capability_tag',
      )
    }
  }

  const permissions = input.permissions ?? {}
  const fsRead = (permissions.fsRead ?? []).map((root) => resolve(String(root)))
  const fsWrite = (permissions.fsWrite ?? []).map((root) => resolve(String(root)))
  const network = permissions.network === true

  const privacy = input.privacy ?? PRIVACY_MODES.LOCAL_ONLY
  if (!Object.values(PRIVACY_MODES).includes(privacy)) {
    throw new CapabilityError(`capability '${id}' has unknown privacy mode '${privacy}'`, 'invalid_privacy')
  }

  const determinism = input.determinism ?? DETERMINISM.DETERMINISTIC
  if (!Object.values(DETERMINISM).includes(determinism)) {
    throw new CapabilityError(`capability '${id}' has unknown determinism '${determinism}'`, 'invalid_determinism')
  }

  return Object.freeze({
    id,
    kind,
    provides: Object.freeze([...provides]),
    requires: Object.freeze([...(input.requires ?? [])]),
    permissions: Object.freeze({ fsRead: Object.freeze(fsRead), fsWrite: Object.freeze(fsWrite), network }),
    privacy,
    determinism,
    cost: normalizeCost(id, input.cost),
    limitations: Object.freeze([...(input.limitations ?? [])]),
    version: input.version ?? null,
    description: input.description ?? '',
    //: Which piece of code actually runs. Two routes that wrap the same implementation --
    //: a tool and a skill built around it, say -- are not independent checks of each other,
    //: and verification compares this field rather than the route ids to notice.
    implementation: input.implementation ?? id,
    // Free-form pointer to whatever implements it. Kept opaque here: this module decides
    // whether something *may* run, and the caller decides what running it means.
    invoke: input.invoke ?? null,
  })
}

function normalizeCost(id, cost) {
  if (cost == null) return null
  const measured = cost.measured
  if (measured == null) {
    throw new CapabilityError(
      `capability '${id}' declares a cost with no measurement. A declared cost is an estimate ` +
        `wearing a measurement's name; pass the median of runs taken here, or omit the cost and ` +
        `let the router treat it as unmeasured.`,
      'unmeasured_cost',
    )
  }
  const { medianMs, samples, input } = measured
  if (!Number.isFinite(medianMs) || medianMs < 0) {
    throw new CapabilityError(`capability '${id}' has a non-numeric measured medianMs`, 'invalid_cost')
  }
  if (!Number.isInteger(samples) || samples < 1) {
    throw new CapabilityError(
      `capability '${id}' measured a median from ${samples} runs; a median needs at least one`,
      'invalid_cost',
    )
  }
  return Object.freeze({
    measured: Object.freeze({ medianMs, samples, input: input ?? 'unspecified input', at: cost.at ?? null }),
    arithmetic: Object.freeze({ ...(cost.arithmetic ?? {}) }),
    note: cost.note ?? null,
  })
}

/**
 * Is `target` inside one of `roots`? Used for both read and write scopes.
 *
 * A prefix comparison on strings is the classic way to get this wrong -- `/data/backup`
 * starts with `/data/back` -- so the check is on resolved paths with a separator boundary.
 */
export function withinScope(roots, target) {
  const resolved = resolve(String(target))
  return roots.some((root) => {
    if (resolved === root) return true
    const rest = relative(root, resolved)
    return rest !== '' && !rest.startsWith(`..${sep}`) && rest !== '..' && !rest.startsWith(sep)
  })
}

/**
 * The permission check an executor must perform before it touches the filesystem.
 * Throws rather than returning false: a caller that ignores a boolean is the bug this
 * is written to prevent.
 */
export function assertMayRead(descriptor, path) {
  if (!withinScope(descriptor.permissions.fsRead, path)) {
    throw new CapabilityError(
      `'${descriptor.id}' is not permitted to read ${path}; its declared read scope is ` +
        `[${descriptor.permissions.fsRead.join(', ') || 'nothing'}]`,
      'permission_denied',
      { path, scope: descriptor.permissions.fsRead },
    )
  }
}

export function assertMayWrite(descriptor, path) {
  if (!withinScope(descriptor.permissions.fsWrite, path)) {
    throw new CapabilityError(
      `'${descriptor.id}' is not permitted to write ${path}; its declared write scope is ` +
        `[${descriptor.permissions.fsWrite.join(', ') || 'nothing'}]`,
      'permission_denied',
      { path, scope: descriptor.permissions.fsWrite },
    )
  }
}

/**
 * Does this descriptor satisfy every capability the request names?
 * Capability tags are exact; near-misses are refusals, not fuzzy matches, because
 * "close enough" is how a task gets routed to something that cannot do it.
 */
export function providesAll(descriptor, capabilities) {
  return capabilities.every((tag) => descriptor.provides.includes(tag))
}
