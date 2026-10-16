// The model and provider fabric: who can be asked, who may be asked, and what happens when
// nobody can.
//
// Phase 6 of the directive, and the acceptance criteria it was written down with are the two
// behaviours this file exists to guarantee:
//
//   1. "routing refuses a request the available capabilities cannot serve rather than degrading
//      silently";
//   2. "offline mode makes no network call".
//
// Both are properties of *this* layer rather than of the router, because the router's job is to
// choose between things it has been given, and the interesting failures happen before that:
//
//   * a capability nothing declares at all,
//   * a capability only an external provider declares, while the policy says nothing leaves this
//     machine,
//   * a request whose requirements are covered by two providers but by no single one of them,
//   * an adapter that has never been probed, or that probed as not installed,
//   * a request that exceeds the declared limits of every adapter that could serve it.
//
// Each of those has a name here, and none of them has a fallback. There is no "closest match",
// no partial-credit candidate and no truncation-to-fit, because every one of those is a way for
// a request to be answered by something that cannot answer it -- which is exactly the silent
// degradation the directive forbids. The refusal carries the list of what *is* available, so the
// message can say what is missing rather than only that something is.
//
// The second criterion is enforced by sharing one eligibility function between `candidates()`
// and `probe()`. That is not tidiness: `probe()` is itself a network call for an external
// adapter, so a fabric that filtered correctly when routing and probed everything when reporting
// would still contact the network in offline mode -- and would report the contact as a
// *status*, which is the most invisible form the violation could take. An adapter that is not
// eligible is not probed, keeps the status `unverified`, and says in the report that it was
// skipped and why.
//
// The limits are declared, not measured: `limits` says what the adapter claims it can take, and
// a request whose needs are not stated cannot be checked against them. A request that states its
// needs and does not fit is refused rather than trimmed, because a silently truncated context is
// an answer to a question nobody asked.

import { AVAILABILITY } from '../router/registry.mjs'
import { CAPABILITY_KINDS, PRIVACY_MODES, validateCapability } from './capability.mjs'

export const PROVIDER_KINDS = Object.freeze({
  IN_PROCESS: 'in-process',
  LOCAL: 'local',
  EXTERNAL: 'external',
})

/** Availability as reported here: the router's states, plus the honest "nobody looked". */
export const FABRIC_AVAILABILITY = Object.freeze({
  ...AVAILABILITY,
  UNVERIFIED: 'unverified',
})

/** Why an adapter was not a candidate. Every rejection is reported with one of these. */
export const REJECTION_CODES = Object.freeze({
  EXTERNAL_NOT_ALLOWED: 'external_not_allowed',
  EGRESS_POLICY: 'egress_policy',
  NO_EGRESS_GUARD: 'no_egress_guard',
  UNAVAILABLE: 'provider_unavailable',
  UNVERIFIED: 'unverified_provider',
  LIMITS: 'capability_exceeds_limits',
  PRIVACY: 'privacy_required',
  DISABLED: 'provider_disabled',
})

export class ProviderFabricError extends Error {
  constructor(message, code = 'provider_fabric_error', detail = {}) {
    super(message)
    this.name = 'ProviderFabricError'
    this.code = code
    this.detail = detail
  }
}

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/

/** `allowExternal` is not a policy: it is one caller's decision, and the policy can still forbid it. */
function policyBlocksExternal(policy, guard) {
  if (guard?.blocksExternal === true) return true
  // No guard at all is not the same as an offline policy: with no guard there is nothing
  // enforcing the or the other, and the fabric treats that as "external is not available"
  // rather than assuming somebody else is watching.
  if (!guard) return true
  return policy === 'strict_offline'
}

export class ProviderFabric {
  #bindings = new Map()
  #status = new Map()

  /**
   * @param {object} [options]
   * @param {object|null} [options.guard]  the egress guard; every external request goes through it
   * @param {string} [options.policy]      the runtime policy this fabric is operating under
   * @param {() => number} [options.now]
   */
  constructor({ guard = null, policy = 'strict_offline', now = () => Date.now() } = {}) {
    this.guard = guard
    this.policy = policy
    this.now = now
  }

  /**
   * Declare an adapter and what it can serve.
   *
   * `capabilities` are the dotted tags the adaptive core routes on, and they have to be declared
   * here rather than discovered later: a provider that is asked for something it never claimed
   * would either fail deep inside a request or, worse, answer something adjacent.
   */
  register({
    id, kind, capabilities, provider = null, model = null, limits = {}, notes = [],
    cost = null, implementation = null, privacy = null, invoke = null, enabled = true,
  }) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ProviderFabricError(
        `provider id '${id}' must be a valid capability id -- lowercase letters, digits, dots and ` +
          "hyphens, e.g. 'ollama.llama3'. The router routes on this id, so a colon (which reads " +
          'naturally in a model name) would be refused later by the capability validator instead of here.',
        'invalid_id',
      )
    }
    if (!Object.values(PROVIDER_KINDS).includes(kind)) {
      throw new ProviderFabricError(
        `provider '${id}' has kind '${kind}'; expected one of ${Object.values(PROVIDER_KINDS).join(', ')}`,
        'invalid_kind',
      )
    }
    if (!Array.isArray(capabilities) || !capabilities.length) {
      throw new ProviderFabricError(`provider '${id}' must declare at least one capability tag`, 'no_capabilities')
    }
    for (const tag of capabilities) {
      if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
        throw new ProviderFabricError(
          `provider '${id}' declares '${tag}'; capability tags are dotted, e.g. 'chat.completion'`,
          'invalid_capability_tag',
        )
      }
    }
    const resolvedPrivacy = privacy
      ?? (kind === PROVIDER_KINDS.EXTERNAL ? PRIVACY_MODES.EXTERNAL : PRIVACY_MODES.LOCAL_ONLY)
    if (kind === PROVIDER_KINDS.EXTERNAL && resolvedPrivacy !== PRIVACY_MODES.EXTERNAL) {
      throw new ProviderFabricError(
        `provider '${id}' is external and claims privacy '${resolvedPrivacy}'; a request that leaves ` +
          'this machine is not local-only, and a card that says otherwise is a false claim',
        'privacy_mismatch',
      )
    }
    if (kind !== PROVIDER_KINDS.EXTERNAL && resolvedPrivacy === PRIVACY_MODES.EXTERNAL) {
      throw new ProviderFabricError(
        `provider '${id}' is ${kind} and declares external privacy; that would make it ineligible ` +
          'offline while nothing about it leaves the machine',
        'privacy_mismatch',
      )
    }
    if (this.#bindings.has(id)) {
      throw new ProviderFabricError(`provider '${id}' is already registered`, 'duplicate_provider')
    }
    const binding = Object.freeze({
      id,
      kind,
      provider,
      model,
      capabilities: Object.freeze([...capabilities]),
      limits: Object.freeze({ ...limits }),
      notes: Object.freeze([...notes]),
      cost,
      implementation: implementation ?? id,
      privacy: resolvedPrivacy,
      invoke,
      enabled: enabled !== false,
      registeredAt: this.now(),
    })
    this.#bindings.set(id, binding)
    this.#status.set(id, Object.freeze({
      availability: FABRIC_AVAILABILITY.UNVERIFIED,
      detail: 'not probed yet: availability is unknown, which is not the same as available',
      at: null,
    }))
    return binding
  }

  has(id) {
    return this.#bindings.has(id)
  }

  get(id) {
    return this.#bindings.get(id) ?? null
  }

  list() {
    return [...this.#bindings.values()]
  }

  /** Capability tags no registered adapter declares. */
  missing(capabilities) {
    const declared = new Set(this.list().flatMap((binding) => binding.capabilities))
    return [...capabilities].filter((tag) => !declared.has(tag)).sort()
  }

  /** Every capability tag the fabric knows about, for a message that says what *is* available. */
  declaredCapabilities() {
    return [...new Set(this.list().flatMap((binding) => binding.capabilities))].sort()
  }

  /**
   * Why this binding is not a candidate, or null when it is.
   *
   * Shared by `candidates()` and `probe()` so the two cannot disagree about who may be contacted.
   */
  eligibility(binding, { policy = this.policy, allowExternal = false, requireLocal = false } = {}) {
    if (!binding.enabled) {
      return { code: REJECTION_CODES.DISABLED, reason: `'${binding.id}' is registered but disabled` }
    }
    if (requireLocal && binding.kind === PROVIDER_KINDS.EXTERNAL) {
      return { code: REJECTION_CODES.PRIVACY, reason: `'${binding.id}' runs off this machine and the request requires a local provider` }
    }
    if (binding.kind === PROVIDER_KINDS.EXTERNAL) {
      if (!this.guard) {
        return {
          code: REJECTION_CODES.NO_EGRESS_GUARD,
          reason: `'${binding.id}' is external and no egress guard is installed, so nothing would be enforcing the policy`,
        }
      }
      if (policyBlocksExternal(policy, this.guard)) {
        return {
          code: REJECTION_CODES.EGRESS_POLICY,
          reason: `'${binding.id}' is external and the runtime policy is '${policy}', where no request leaves this machine`,
        }
      }
      if (allowExternal !== true) {
        return {
          code: REJECTION_CODES.EXTERNAL_NOT_ALLOWED,
          reason: `'${binding.id}' is external and this request did not opt in to external providers`,
        }
      }
    }
    return null
  }

  /**
   * Requests larger than the adapter says it can take.
   *
   * A request with no stated needs cannot be checked, and this returns null rather than guessing:
   * the alternative is a fabric that refuses small requests because it assumed they were large.
   */
  limitsProblem(binding, needs = {}) {
    const limits = binding.limits ?? {}
    const pairs = [
      ['contextTokens', 'contextTokens'],
      ['maxOutputTokens', 'maxOutputTokens'],
    ]
    for (const [need, limit] of pairs) {
      if (needs[need] === undefined || limits[limit] === undefined) continue
      if (needs[need] > limits[limit]) {
        return {
          code: REJECTION_CODES.LIMITS,
          reason: `the request needs ${need} ${needs[need]}, above the ${limits[limit]} '${binding.id}' declares`,
        }
      }
    }
    return null
  }

  /**
   * The adapters that could serve every requested tag, with the rejections that removed the rest.
   *
   * A tag nothing declares is reported separately: "no provider offers this" and "the provider
   * that offers it is not allowed right now" are different problems with different fixes.
   */
  candidates(capabilities, { policy = this.policy, allowExternal = false, requireLocal = false, needs = {}, allowUnverified = false } = {}) {
    const wanted = [...capabilities]
    const covered = new Map()
    for (const binding of this.list()) {
      for (const tag of wanted) {
        if (!binding.capabilities.includes(tag)) continue
        if (!covered.has(tag)) covered.set(tag, [])
        covered.get(tag).push(binding.id)
      }
    }
    const missing = wanted.filter((tag) => !covered.has(tag))

    const rejected = []
    const candidates = []
    for (const binding of this.list()) {
      const servesAll = wanted.every((tag) => binding.capabilities.includes(tag))
      const servesSome = wanted.some((tag) => binding.capabilities.includes(tag))
      if (!servesSome) continue
      if (!servesAll) {
        rejected.push({
          id: binding.id,
          code: 'partial_coverage',
          reason: `'${binding.id}' serves ${wanted.filter((t) => binding.capabilities.includes(t)).join(', ')} ` +
            `but not ${wanted.filter((t) => !binding.capabilities.includes(t)).join(', ')}`,
        })
        continue
      }
      const problem = this.eligibility(binding, { policy, allowExternal, requireLocal }) ?? this.limitsProblem(binding, needs)
      if (problem) {
        rejected.push({ id: binding.id, ...problem })
        continue
      }
      const problem2 = this.#readinessProblem(binding, allowUnverified)
      if (problem2) {
        rejected.push({ id: binding.id, ...problem2 })
        continue
      }
      candidates.push(binding)
    }
    return Object.freeze({
      candidates: Object.freeze(candidates),
      rejected: Object.freeze(rejected),
      missing: Object.freeze(missing),
      coveredBy: Object.freeze(Object.fromEntries([...covered].map(([tag, ids]) => [tag, Object.freeze([...new Set(ids)])]))),
    })
  }

  /**
   * Whether a probed status permits this adapter to be a candidate.
   *
   * Anything that is not a clean READY is either a known failure or an unknown, and the two are
   * reported differently because they have different fixes. `allowUnverified` is for a caller who
   * knows the adapter was never probed -- it does not turn a *failed* probe into a candidate,
   * because that would be the fabric overruling its own measurement.
   */
  #readinessProblem(binding, allowUnverified) {
    const status = this.#status.get(binding.id)
    if (status?.availability === AVAILABILITY.READY) return null
    if (allowUnverified && (!status || status.availability === FABRIC_AVAILABILITY.UNVERIFIED)) return null
    const probed = Boolean(status) && status.availability !== FABRIC_AVAILABILITY.UNVERIFIED
    return {
      code: probed ? REJECTION_CODES.UNAVAILABLE : REJECTION_CODES.UNVERIFIED,
      reason: probed
        ? `'${binding.id}' probed as ${status.availability}: ${status.detail}`
        : `'${binding.id}' has not been probed, so nothing here knows whether it works; ${status?.detail ?? 'no probe was run'}`,
    }
  }

  /** Build the descriptor the adaptive router and planner read, or refuse an unrunnable adapter. */
  #descriptorFor(binding, permissions) {
    if (typeof binding.invoke !== 'function') {
      throw new ProviderFabricError(
        `'${binding.id}' has no invoke, so it can be chosen but not run; register an adapter or use route() ` +
          'to inspect eligibility without building candidates',
        'no_invoke',
        { id: binding.id },
      )
    }
    return validateCapability({
      id: binding.id,
      kind: CAPABILITY_KINDS.MODEL,
      version: binding.model ?? null,
      provides: [...binding.capabilities],
      permissions: {
        ...permissions,
        network: binding.kind === PROVIDER_KINDS.EXTERNAL ? true : permissions.network === true,
      },
      privacy: binding.privacy,
      determinism: binding.notes.some((note) => /sampled|temperature/i.test(note)) ? 'sampled' : 'deterministic',
      cost: binding.cost,
      limitations: [
        ...binding.notes,
        `Availability measured by probe(): ${this.#status.get(binding.id)?.availability ?? FABRIC_AVAILABILITY.UNVERIFIED}.`,
      ],
      implementation: binding.implementation,
      description: `${binding.kind} provider ${binding.id}`,
      invoke: binding.invoke,
    })
  }

  /**
   * Choose one adapter, or refuse by name.
   *
   * The refusal is the product here. Every branch below is a case where the system could have
   * produced *an* answer and the answer would have been for a different question.
   */
  route(capabilities, options = {}) {
    const wanted = [...capabilities]
    if (!wanted.length) {
      throw new ProviderFabricError('a request with no capability is not a request', 'no_capabilities')
    }
    const attempt = this.candidates(wanted, options)

    if (attempt.missing.length) {
      throw new ProviderFabricError(
        `no provider declares ${attempt.missing.join(', ')}. This fabric knows about ` +
          `${this.declaredCapabilities().join(', ') || 'nothing'} and will not substitute one for another.`,
        'no_capability',
        { missing: attempt.missing, declared: this.declaredCapabilities(), rejected: attempt.rejected },
      )
    }
    if (!attempt.candidates.length) {
      const externalOnly = attempt.rejected.filter((each) => each.code === REJECTION_CODES.EGRESS_POLICY)
      const code = externalOnly.length === attempt.rejected.length && externalOnly.length ? 'only_external_capability'
        : attempt.rejected.some((each) => each.code === REJECTION_CODES.LIMITS) ? REJECTION_CODES.LIMITS
          : attempt.rejected.some((each) => each.code === REJECTION_CODES.UNAVAILABLE) ? 'provider_unavailable'
            : 'no_eligible_provider'
      const because = attempt.rejected.map((each) => each.reason).join('; ')
      throw new ProviderFabricError(
        `nothing can serve ${wanted.join(', ')} right now: ${because}`,
        code,
        { wanted, rejected: attempt.rejected, coveredBy: attempt.coveredBy },
      )
    }
    // More than one adapter serving the same tags is not a problem -- it is the router's choice
    // to make, on measurement, and the fabric hands it all of them. What the fabric refuses is
    // the case where *no single* adapter covers everything, because that request would otherwise
    // be answered by combining two providers, which is a different request.
    const chosen = options.prefer
      ? attempt.candidates.find((binding) => binding.id === options.prefer)
      : attempt.candidates[0]
    if (!chosen) {
      throw new ProviderFabricError(
        `the request named '${options.prefer}' and that provider is not eligible for it`,
        'preference_not_eligible',
        { rejected: attempt.rejected, eligible: attempt.candidates.map((binding) => binding.id) },
      )
    }
    return Object.freeze({
      chosen,
      candidates: attempt.candidates,
      rejected: attempt.rejected,
      because: attempt.candidates.length === 1
        ? `the only eligible provider for ${wanted.join(', ')}`
        : `${attempt.candidates.length} providers serve this request; the adaptive router chooses between them by measurement`,
    })
  }

  /**
   * Measure availability for the adapters the policy allows, and only those.
   *
   * Never throws: a probe that raises is recorded as UNREACHABLE with the message. A fabric that
   * could not report an unreachable provider would have to either claim it works or crash, and
   * both of those are worse than a status field.
   */
  async probe({ policy = this.policy, allowExternal = false, requireLocal = false, timeoutMs = 5_000 } = {}) {
    const probed = []
    const skipped = []
    for (const binding of this.list()) {
      const problem = this.eligibility(binding, { policy, allowExternal, requireLocal })
      if (problem) {
        skipped.push(Object.freeze({ id: binding.id, code: problem.code, reason: problem.reason }))
        continue
      }
      if (!binding.provider?.probe) {
        this.#status.set(binding.id, Object.freeze({
          availability: FABRIC_AVAILABILITY.UNVERIFIED,
          detail: 'registered without an adapter to probe, so nothing here knows whether it works',
          at: this.now(),
        }))
        probed.push(Object.freeze({ id: binding.id, availability: FABRIC_AVAILABILITY.UNVERIFIED, detail: 'no adapter' }))
        continue
      }
      let outcome
      try {
        outcome = await binding.provider.probe({ timeoutMs })
      } catch (error) {
        outcome = { availability: AVAILABILITY.UNREACHABLE, detail: `probe raised: ${error?.message ?? 'unknown'}` }
      }
      const status = Object.freeze({
        availability: outcome?.availability ?? AVAILABILITY.UNREACHABLE,
        detail: String(outcome?.detail ?? 'the adapter returned no detail, which is not a readiness claim'),
        at: this.now(),
      })
      this.#status.set(binding.id, status)
      probed.push(Object.freeze({ id: binding.id, ...status }))
    }
    return Object.freeze({ probed: Object.freeze(probed), skipped: Object.freeze(skipped) })
  }

  status(id) {
    if (id) {
      return Object.freeze({ ...(this.#bindings.get(id) ?? null), status: this.#status.get(id) ?? null })
    }
    return Object.freeze(this.list().map((binding) => Object.freeze({
      id: binding.id,
      kind: binding.kind,
      privacy: binding.privacy,
      capabilities: binding.capabilities,
      limits: binding.limits,
      enabled: binding.enabled,
      hasAdapter: Boolean(binding.provider),
      status: this.#status.get(binding.id),
    })))
  }

  /**
   * Candidate descriptors for the adaptive router, built from what is eligible right now.
   *
   * An adapter with no `invoke` is refused rather than returned: a route that can be measured and
   * chosen but cannot run is a route that turns a routing decision into a failure later, with the
   * measurement in hand and nothing to do with it.
   */
  executors(capabilities = null, { policy = this.policy, allowExternal = false, requireLocal = false, needs = {}, allowUnverified = false, permissions = { fsRead: [], fsWrite: [], network: false } } = {}) {
    const options = { policy, allowExternal, requireLocal, needs, allowUnverified }
    if (capabilities === null || capabilities === undefined) {
      // No request given: every adapter this policy allows, judged on its own declared tags.
      // This is what a planner's registry is built from -- a request-shaped list would leave out
      // every adapter that serves a different tag, and an adapter declaring two tags would be
      // registered twice.
      const descriptors = []
      const rejected = []
      for (const binding of this.list()) {
        const problem = this.eligibility(binding, options) ?? this.limitsProblem(binding, needs) ?? this.#readinessProblem(binding, allowUnverified)
        if (problem) {
          rejected.push(Object.freeze({ id: binding.id, ...problem }))
          continue
        }
        descriptors.push(this.#descriptorFor(binding, permissions))
      }
      return Object.freeze({
        descriptors: Object.freeze(descriptors),
        rejected: Object.freeze(rejected),
        missing: Object.freeze([]),
      })
    }
    const attempt = this.candidates(capabilities, options)
    const descriptors = attempt.candidates.map((binding) => this.#descriptorFor(binding, permissions))
    return Object.freeze({ descriptors: Object.freeze(descriptors), rejected: attempt.rejected, missing: attempt.missing })
  }

  /** Register the same descriptors into the adaptive capability registry (Phase 2). */
  /**
   * Publish eligible adapters into a capability registry.
   *
   * `capabilities` may be `null` to publish every adapter the policy allows, which is how the
   * planner's registry is built: a plan may then only be built against providers that are
   * registered *and* measured, and a step naming anything else is refused at planning time.
   */
  toCapabilityRegistry(registry, capabilities = null, options = {}) {
    const { descriptors } = this.executors(capabilities, options)
    return descriptors.map((descriptor) => registry.register(descriptor))
  }
}
