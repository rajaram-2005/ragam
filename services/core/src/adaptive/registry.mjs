// The capability registry: what this installation can actually do, indexed by capability tag.
//
// `router/registry.mjs` already exists and answers a different question -- which *model*
// record to use, scored by capability fit, privacy, latency, resources and quality. This is
// the layer below it: which implementations of a capability exist here at all, whether they
// are tools, skills or models, and which capability tags a plan asks for that nothing
// provides.
//
// The distinction matters because "no model record scored well enough" and "nothing here
// implements this capability" are different failures with different remedies, and a system
// that reports the first when the second is true sends its user to fix the wrong thing. The
// registry reports the second, and names the tag.
//
// Nothing here is a heartbeat. A registration is a claim that an implementation exists in
// this process, made by whoever built it and checked for shape by `validateCapability`. The
// registry does not test that a registered implementation works: that is what the loop's
// verification and the skill registry's evidence gates are for, and a registry that claimed
// otherwise would be reporting an intent as a fact.

import { CAPABILITY_KINDS, CapabilityError, validateCapability } from './capability.mjs'

export class RegistryError extends Error {
  constructor(message, code = 'registry_error', detail = {}) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
    this.detail = detail
  }
}

/** A stable fingerprint of a descriptor's identity and interface, not of its closure. */
export function descriptorShape(descriptor) {
  return JSON.stringify({
    id: descriptor.id,
    kind: descriptor.kind,
    provides: [...descriptor.provides].sort(),
    implementation: descriptor.implementation,
    permissions: {
      fsRead: [...(descriptor.permissions?.fsRead ?? [])].sort(),
      fsWrite: [...(descriptor.permissions?.fsWrite ?? [])].sort(),
      network: descriptor.permissions?.network === true,
    },
  })
}

export class CapabilityRegistry {
  #byTag = new Map()
  #byId = new Map()

  /**
   * Register one implementation. Re-registering the same id with the same interface is
   * idempotent (a process that builds its registry twice should not fail); re-registering an
   * id whose interface, capabilities or permissions differ is refused, because a second
   * meaning for a name is how a routing decision stops being reproducible.
   */
  register(input) {
    const descriptor = validateCapability(input)
    const existing = this.#byId.get(descriptor.id)
    if (existing) {
      if (descriptorShape(existing) === descriptorShape(descriptor)) return existing
      throw new RegistryError(
        `'${descriptor.id}' is already registered with a different interface; a capability id must mean one thing`,
        'duplicate_id',
        { id: descriptor.id },
      )
    }
    this.#byId.set(descriptor.id, descriptor)
    for (const tag of descriptor.provides) {
      if (!this.#byTag.has(tag)) this.#byTag.set(tag, [])
      this.#byTag.get(tag).push(descriptor.id)
    }
    return descriptor
  }

  registerAll(descriptors) {
    return descriptors.map((descriptor) => this.register(descriptor))
  }

  /** Ids that can serve this tag, in registration order. */
  idsFor(tag) {
    return [...(this.#byTag.get(tag) ?? [])]
  }

  descriptorsFor(tag) {
    return this.idsFor(tag).map((id) => this.#byId.get(id))
  }

  has(tag) {
    return this.idsFor(tag).length > 0
  }

  get(id) {
    return this.#byId.get(id) ?? null
  }

  get ids() {
    return [...this.#byId.keys()]
  }

  get tags() {
    return [...this.#byTag.keys()].sort()
  }

  /**
   * Candidates for a task, optionally narrowed by what the router's own constraints mean.
   * The registry does not apply routing constraints -- that is `routeTask`'s job -- it only
   * answers which descriptors provide every capability the task asks for. A task needing two
   * capabilities is served by implementations that provide both, or by the caller planning
   * those as two steps.
   */
  candidatesFor(capabilities) {
    const wanted = [...capabilities]
    if (!wanted.length) return []
    const first = new Set(this.idsFor(wanted[0]))
    for (const tag of wanted.slice(1)) {
      const others = new Set(this.idsFor(tag))
      for (const id of [...first]) if (!others.has(id)) first.delete(id)
    }
    return [...first].map((id) => this.#byId.get(id))
  }

  /**
   * The tags in `capabilities` that nothing here provides. Returned rather than thrown,
   * because a caller with optional work to skip needs the list, and a caller without needs a
   * refusal that names the tag -- which `planTask` builds from this.
   */
  unimplemented(capabilities) {
    return [...capabilities].filter((tag) => !this.has(tag)).sort()
  }

  /**
   * A summary for a status page or a plan check. `kinds` counts implementations by kind, so a
   * reader can see that a capability is served only by a skill that was promoted this week
   * rather than by nothing at all.
   */
  describe() {
    const kinds = Object.fromEntries(Object.values(CAPABILITY_KINDS).map((kind) => [kind, 0]))
    for (const descriptor of this.#byId.values()) kinds[descriptor.kind] += 1
    const byTag = {}
    for (const tag of this.tags) byTag[tag] = this.idsFor(tag)
    return Object.freeze({
      implementations: this.#byId.size,
      tags: Object.freeze(this.tags),
      kinds: Object.freeze(kinds),
      byTag: Object.freeze(byTag),
    })
  }
}

/** Build a registry from a list, failing loudly on the first bad descriptor. */
export function registryFrom(descriptors = []) {
  const registry = new CapabilityRegistry()
  registry.registerAll(descriptors)
  return registry
}

export { CapabilityError }
