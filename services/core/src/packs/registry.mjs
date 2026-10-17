// The pack registry: what an installation will apply, and what it reports first.
//
// A pack has two questions asked of it, and they are answered separately because they have
// different fixes:
//
//   1. **Is it valid?** `manifest.mjs`. A pack that asks to relax a control is refused at install.
//   2. **Can this installation honour it?** `readiness()`. The pack's required capabilities are
//      intersected with the *measured* providers (Phase 6). A pack whose required capability no
//      provider serves is reported `unavailable`, naming the capability, and is not applied.
//
// The third rule is the one that keeps packs from becoming a side door: applying a pack produces a
// *profile* — restrictions, vocabulary, disclaimers — and a profile is data. It cannot mint an
// authority (Phase 7), execute a skill, or widen a permission, and the registry has no method that
// would let it.

import { PackError, compareSemver, strictestRestrictions, validatePack } from './manifest.mjs'
import { DATA_CLASS_RANK, dataClassRank } from '../policy/egress.mjs'

export const PACK_STATES = Object.freeze({ INSTALLED: 'installed', ENABLED: 'enabled', DISABLED: 'disabled' })

/** Which capabilities a pack is allowed to require; anything else is a claim the product cannot check. */
export const KNOWN_CAPABILITIES = Object.freeze([
  'chat.completion',
  'image.generate',
  'video.generate',
  'image.understand',
  'tree.line-count',
  'repo.read',
])

export class PackRegistry {
  #packs = new Map()

  /**
   * @param {object} options
   * @param {object} [options.fabric]  ProviderFabric from Phase 6; without it, readiness is 'unknown'
   * @param {object} [options.ledger]
   * @param {() => number} [options.now]
   */
  constructor({ fabric = null, ledger = null, now = () => Date.now() } = {}) {
    this.fabric = fabric
    this.ledger = ledger
    this.now = now
  }

  #audit(action, outcome, detail, subject = null) {
    this.ledger?.record({ category: 'packs', action, outcome, subject, detail })
  }

  /**
   * Install a pack.
   *
   * Installing twice with the same version is refused; a higher version replaces; a lower version
   * is refused unless `allowDowngrade` — the same direction of travel as the plugin registry,
   * because a downgrade is how a known-bad pack comes back.
   */
  install(document, { allowDowngrade = false } = {}) {
    const pack = validatePack(document, { now: this.now })
    const existing = this.#packs.get(pack.id)
    if (existing) {
      const order = compareSemver(pack.version, existing.pack.version)
      if (order === 0) {
        throw new PackError(`'${pack.id}@${pack.version}' is already installed`, 'duplicate_pack', [])
      }
      if (order < 0 && !allowDowngrade) {
        throw new PackError(
          `'${pack.id}@${pack.version}' is older than the installed '${existing.pack.version}'; a downgrade has to be asked for`,
          'downgrade_refused',
          [],
        )
      }
    }
    this.#packs.set(pack.id, {
      pack,
      state: PACK_STATES.INSTALLED,
      installedAt: this.now(),
      history: [...(existing?.history ?? []), { version: pack.version, at: this.now() }],
    })
    this.#audit('install', 'info', { id: pack.id, version: pack.version, industry: pack.industry, replaced: existing?.pack.version ?? null }, pack.id)
    return this.describe(pack.id)
  }

  enable(id) {
    const record = this.#require(id)
    record.state = PACK_STATES.ENABLED
    this.#audit('enable', 'info', { id }, id)
    return this.describe(id)
  }

  disable(id) {
    const record = this.#require(id)
    record.state = PACK_STATES.DISABLED
    this.#audit('disable', 'info', { id }, id)
    return this.describe(id)
  }

  uninstall(id) {
    const record = this.#require(id)
    this.#packs.delete(id)
    this.#audit('uninstall', 'info', { id, version: record.pack.version }, id)
    return { uninstalled: true, id, version: record.pack.version }
  }

  #require(id) {
    const record = this.#packs.get(id)
    if (!record) throw new PackError(`unknown pack '${id}'`, 'unknown_pack', [])
    return record
  }

  has(id) {
    return this.#packs.has(id)
  }

  /** The stored pack document, frozen. A copy, not the registry's state. */
  get(id) {
    return this.#require(id).pack
  }

  /** The registry's view of one pack: identity, state, and whether this build can honour it. */
  describe(id) {
    const record = this.#require(id)
    return Object.freeze({
      pack: record.pack,
      state: record.state,
      installedAt: record.installedAt,
      history: Object.freeze(record.history.map((entry) => Object.freeze({ ...entry }))),
      readiness: this.readiness(id),
    })
  }

  list({ industry = null, enabledOnly = false } = {}) {
    return [...this.#packs.values()]
      .filter((record) => (!industry || record.pack.industry === industry) && (!enabledOnly || record.state === PACK_STATES.ENABLED))
      .map((record) => this.describe(record.pack.id))
      .sort((a, b) => a.pack.id.localeCompare(b.pack.id))
  }

  /**
   * Whether this installation can honour the pack, measured against the provider fabric.
   *
   * `complete` needs every required capability served by a ready provider and no capability the
   * pack admits is unimplemented. `partial` means something is missing and the pack may still be
   * *read* — a user can see the vocabulary and the refusals — but `profileFor` refuses to apply it
   * unless the caller asks to proceed with the gaps named. `unknown` is the state without a
   * fabric: it is not a claim that everything works.
   */
  readiness(id) {
    const { pack } = this.#require(id)
    const required = pack.capabilities.filter((capability) => !capability.unimplemented)
    const unimplemented = pack.capabilities.filter((capability) => capability.unimplemented).map((capability) => capability.tag)
    const missing = []
    const served = []

    for (const capability of required) {
      if (!this.fabric) {
        missing.push({ tag: capability.tag, why: 'no provider fabric is configured, so nothing here knows whether it is served' })
        continue
      }
      try {
        const routed = this.fabric.route([capability.tag])
        served.push({ tag: capability.tag, provider: routed.chosen.id, privacy: routed.chosen.privacy })
      } catch (error) {
        missing.push({ tag: capability.tag, why: error.message, code: error.code ?? 'unavailable' })
      }
    }

    // Four states, because they have four different answers:
    //   unknown      no fabric, so nothing here can know -- not a claim that it works
    //   unavailable  a capability the pack *relies on* is not served; the pack cannot be applied
    //   partial      everything it relies on is served, but it declares capabilities it admits
    //                are not implemented. A declared gap is not a broken pack, and refusing to
    //                apply one would make honesty about gaps a liability
    //   complete     everything it relies on is served and there are no declared gaps
    const state = !this.fabric
      ? 'unknown'
      : missing.length > 0
        ? 'unavailable'
        : unimplemented.length > 0
          ? 'partial'
          : 'complete'

    return Object.freeze({
      id: pack.id,
      version: pack.version,
      state,
      served: Object.freeze(served),
      missing: Object.freeze(missing.map((entry) => Object.freeze(entry))),
      unimplemented: Object.freeze(unimplemented),
      // Stated on every readiness result: the pack's restrictions apply whether or not its
      // capabilities do, because a restriction is enforceable without any model at all.
      note: 'Restrictions and refusals are enforceable without any provider; missing capabilities are reported, not substituted.',
    })
  }

  /**
   * The profile a task runs under, with the pack's restrictions applied.
   *
   * `strictestRestrictions` means a second pack can only tighten the first. `requireHumanReview`
   * and `requireSources` are disjunctions because either pack asking for review is enough.
   */
  profileFor(id, { allowPartial = false } = {}) {
    const readiness = this.readiness(id)
    if (readiness.state === 'unavailable' && !allowPartial) {
      throw new PackError(
        `'${id}' cannot be applied: ${readiness.missing.map((entry) => entry.tag).join(', ') || 'a required capability'} ` +
          `is not available on this installation`,
        'pack_unavailable',
        readiness.missing.map((entry) => `${entry.tag}: ${entry.why}`),
      )
    }
    const { pack } = this.#require(id)
    const restrictions = strictestRestrictions(pack.restrictions)
    this.#audit('profile', 'info', { id, version: pack.version, readiness: readiness.state, gaps: readiness.missing.length }, id)
    return Object.freeze({
      pack: Object.freeze({ id: pack.id, version: pack.version, industry: pack.industry }),
      restrictions,
      // Data, not behaviour: a renderer may show these and may quote them, and nothing in the
      // system is permitted to treat them as instructions or as an authorisation.
      vocabulary: pack.vocabulary,
      refusals: pack.refuses,
      disclaimers: pack.disclaimers,
      requiresHumanReview: restrictions.requireHumanReview,
      sources: pack.sources,
      readiness,
      at: this.now(),
    })
  }

  /**
   * Every enabled pack whose industry matches, as profiles.
   *
   * The intersection is the strictest of all of them, so enabling two packs cannot produce a
   * profile weaker than either.
   */
  profilesFor({ industry = null, allowPartial = false } = {}) {
    const enabled = [...this.#packs.values()].filter((record) => record.state === PACK_STATES.ENABLED && (!industry || record.pack.industry === industry))
    if (!enabled.length) {
      return Object.freeze({
        industry,
        profiles: Object.freeze([]),
        restrictions: strictestRestrictions(),
        note: 'no pack is enabled; the installation\'s own policy is the only restriction in force',
      })
    }
    const profiles = enabled.map((record) => this.profileFor(record.pack.id, { allowPartial }))
    return Object.freeze({
      industry,
      profiles: Object.freeze(profiles),
      restrictions: strictestRestrictions(...profiles.map((profile) => profile.restrictions)),
      refusals: Object.freeze([...new Set(profiles.flatMap((profile) => profile.refusals))]),
      disclaimers: Object.freeze([...new Set(profiles.flatMap((profile) => profile.disclaimers))]),
      requiresHumanReview: profiles.some((profile) => profile.requiresHumanReview),
    })
  }

  /**
   * Does this profile let an action proceed?
   *
   * A pack never *allows* — the absence of a refusal is not permission. This answers only whether
   * the pack forbids an action, so a caller's own policy still owns the allow decision.
   */
  forbids(profile, action) {
    if (!profile?.restrictions) throw new PackError('forbids() needs a profile', 'invalid_profile', [])
    if (profile.restrictions.refusedActions.includes(action)) {
      return { forbidden: true, because: `the '${profile.pack.id}' pack refuses '${action}'` }
    }
    return { forbidden: false, because: 'the pack does not refuse this action; permission is decided elsewhere' }
  }

  /** The data class a task must be handled at once a profile applies. Raises, never lowers. */
  dataClassFor(profile, current) {
    const floor = profile?.restrictions?.dataClassFloor ?? 'internal'
    return dataClassRank(floor) > dataClassRank(current) ? floor : current
  }
}

export { DATA_CLASS_RANK }
