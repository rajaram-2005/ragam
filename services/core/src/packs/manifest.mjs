// Industry packs: what a domain adds to the system, and what it is not allowed to add.
//
// Phase 9 of the adaptive-intelligence directive. A pack is a document — vocabulary, refused
// claims, review requirements, sources, disclaimers — that a user may apply to a task so the
// system behaves as a competent practitioner in that field would expect. It is **content and
// restriction**, never capability and never authority. That distinction is the whole design:
//
//   * a pack cannot grant a permission, approve an action, or mint authority (Phase 7: data
//     cannot authorise anything, and a pack is data);
//   * a pack cannot weaken a policy. `restrictions` are floors, not settings: a pack may raise
//     the data class a task is handled at and add actions it refuses, and every attempt to
//     lower either is refused at validation rather than clamped, because a pack that asks to
//     relax a control is a pack whose author believed it could, and that belief is the bug;
//   * a pack cannot claim a capability the installation does not have. Each required capability
//     either cites the test that evidences it or is marked `unimplemented` — and the registry
//     then reports the pack as partial, which is a fact the product shows rather than a warning
//     it logs.
//
// Regulated industries carry the rule that makes them safe to ship at all: `requireHumanReview`
// must be true and `refuses` must name what the pack will not do. A legal pack that does not say
// "this is not legal advice" is not a cautious legal pack; it is a liability with a version number.

import { DATA_CLASS_RANK } from '../policy/egress.mjs'

export const INDUSTRIES = Object.freeze([
  'engineering',
  'finance',
  'healthcare',
  'legal',
  'education',
  'manufacturing',
  'public-sector',
  'retail',
])

/** Industries where an answer can cause harm that a disclaimer has to bound. */
export const REGULATED_INDUSTRIES = Object.freeze(['finance', 'healthcare', 'legal', 'public-sector'])

/** Actions a pack may refuse. Closed list, so a pack cannot invent a control nothing enforces. */
export const REFUSABLE_ACTIONS = Object.freeze([
  'fs.write',
  'fs.delete',
  'network.external',
  'media.generate',
  'skill.execute',
  'plugin.invoke',
])

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,62}$/
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i
const TOP_LEVEL_KEYS = new Set([
  'id', 'name', 'industry', 'version', 'description', 'restrictions', 'refuses', 'capabilities',
  'vocabulary', 'disclaimers', 'sources', 'provenance',
])
const RESTRICTION_KEYS = new Set(['dataClassFloor', 'refusedActions', 'requireHumanReview', 'requireSources'])

export class PackError extends Error {
  constructor(message, code = 'pack_invalid', problems = []) {
    super(message)
    this.name = 'PackError'
    this.code = code
    this.problems = problems
  }
}

export function compareSemver(a, b) {
  const pa = SEMVER.exec(String(a))
  const pb = SEMVER.exec(String(b))
  if (!pa || !pb) throw new PackError(`cannot compare '${!pa ? a : b}': not a semantic version`, 'invalid_version')
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/**
 * Validate a pack document and return a frozen, normalised copy.
 *
 * Every refusal names the field, because "invalid pack" tells a pack author nothing and the
 * authors are the people this check is for.
 */
export function validatePack(document, { now = () => Date.now() } = {}) {
  const problems = []
  const fail = (field, message) => problems.push(`${field}: ${message}`)

  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new PackError('a pack must be an object', 'pack_invalid', ['document: must be an object'])
  }
  for (const key of Object.keys(document)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(key, `unknown key; a pack may declare ${[...TOP_LEVEL_KEYS].join(', ')}`)
  }

  if (!ID_PATTERN.test(String(document.id ?? ''))) fail('id', `'${document.id}' must match ${ID_PATTERN}`)
  if (!INDUSTRIES.includes(document.industry)) fail('industry', `'${document.industry}' is not one of ${INDUSTRIES.join(', ')}`)
  if (!SEMVER.test(String(document.version ?? ''))) fail('version', `'${document.version}' is not a semantic version`)
  if (!String(document.name ?? '').trim()) fail('name', 'a pack must be named')
  if (String(document.description ?? '').trim().length < 20) fail('description', 'must be at least 20 characters; a pack whose purpose is a word is not reviewable')

  const restrictions = document.restrictions ?? {}
  if (typeof restrictions !== 'object' || Array.isArray(restrictions)) {
    fail('restrictions', 'must be an object')
  } else {
    for (const key of Object.keys(restrictions)) {
      if (!RESTRICTION_KEYS.has(key)) fail(`restrictions.${key}`, `unknown restriction; a pack may set ${[...RESTRICTION_KEYS].join(', ')}`)
    }
    if (restrictions.dataClassFloor !== undefined) {
      if (!(restrictions.dataClassFloor in DATA_CLASS_RANK)) {
        fail('restrictions.dataClassFloor', `'${restrictions.dataClassFloor}' is not one of ${Object.keys(DATA_CLASS_RANK).join(', ')}`)
      } else if (DATA_CLASS_RANK[restrictions.dataClassFloor] < DATA_CLASS_RANK.internal) {
        // A pack that lowers the floor below internal is asking to handle material at a class
        // the installation does not treat as a floor at all. Refused rather than clamped.
        fail('restrictions.dataClassFloor', `'${restrictions.dataClassFloor}' would lower the data-class floor; a pack may raise it and never lower it`)
      }
    }
    if (restrictions.refusedActions !== undefined) {
      if (!Array.isArray(restrictions.refusedActions)) fail('restrictions.refusedActions', 'must be an array')
      else {
        for (const action of restrictions.refusedActions) {
          if (!REFUSABLE_ACTIONS.includes(action)) fail('restrictions.refusedActions', `'${action}' is not one of ${REFUSABLE_ACTIONS.join(', ')}`)
        }
      }
    }
    for (const flag of ['requireHumanReview', 'requireSources']) {
      if (restrictions[flag] !== undefined && typeof restrictions[flag] !== 'boolean') fail(`restrictions.${flag}`, 'must be a boolean')
    }
  }

  const refuses = document.refuses ?? []
  if (!Array.isArray(refuses) || refuses.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    fail('refuses', 'must be an array of non-empty sentences')
  }

  const capabilities = document.capabilities ?? []
  if (!Array.isArray(capabilities)) {
    fail('capabilities', 'must be an array')
  } else {
    for (const [index, capability] of capabilities.entries()) {
      const field = `capabilities[${index}]`
      if (typeof capability?.tag !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(capability.tag)) {
        fail(`${field}.tag`, `'${capability?.tag}' must be a dotted capability tag such as 'image.generate'`)
      }
      // The rule from the family's own tier records: a capability with no artifact behind it is
      // a claim, not a capability. Here the artifact is either a test path that must exist or an
      // explicit admission that the capability is not implemented.
      if (capability?.unimplemented === true) continue
      if (typeof capability?.evidence !== 'string' || !capability.evidence.trim()) {
        fail(`${field}.evidence`, 'a capability must cite the file that evidences it, or set unimplemented: true')
      }
    }
  }

  const vocabulary = document.vocabulary ?? {}
  if (typeof vocabulary !== 'object' || Array.isArray(vocabulary)) fail('vocabulary', 'must be an object of term -> definition')
  else {
    for (const [term, definition] of Object.entries(vocabulary)) {
      if (typeof definition !== 'string' || definition.trim().length < 3) fail(`vocabulary.${term}`, 'each definition must be a sentence')
    }
  }

  const disclaimers = document.disclaimers ?? []
  if (!Array.isArray(disclaimers) || disclaimers.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    fail('disclaimers', 'must be an array of non-empty sentences')
  }

  const sources = document.sources ?? []
  if (!Array.isArray(sources)) {
    fail('sources', 'must be an array')
  } else {
    for (const [index, source] of sources.entries()) {
      const field = `sources[${index}]`
      if (!String(source?.title ?? '').trim()) fail(`${field}.title`, 'required')
      if (!/^https?:\/\//.test(String(source?.url ?? ''))) fail(`${field}.url`, 'must be an http(s) URL')
      if (!String(source?.licence ?? '').trim()) fail(`${field}.licence`, 'required; an unlicensed source is not a source')
      if (!Number.isFinite(source?.checkedAt) || source.checkedAt > now()) fail(`${field}.checkedAt`, 'must be a timestamp not in the future')
    }
  }

  const regulated = REGULATED_INDUSTRIES.includes(document.industry)
  if (regulated) {
    if (restrictions.requireHumanReview !== true) {
      fail('restrictions.requireHumanReview', `a '${document.industry}' pack must require human review; that is what makes a regulated pack shippable`)
    }
    if (!refuses.length) {
      fail('refuses', `a '${document.industry}' pack must state what it will not do`)
    }
  }
  if (restrictions.requireSources === true && sources.length === 0) {
    fail('sources', 'requireSources is set and the pack cites none')
  }

  if (problems.length) {
    throw new PackError(`pack '${document.id ?? '(unnamed)'}' has ${problems.length} problem${problems.length === 1 ? '' : 's'}`, 'pack_invalid', problems)
  }

  return Object.freeze({
    id: document.id,
    name: String(document.name),
    industry: document.industry,
    version: document.version,
    description: String(document.description),
    restrictions: Object.freeze({
      // Internal is the least a pack may ask for: the floor exists to be raised.
      dataClassFloor: restrictions.dataClassFloor ?? 'internal',
      refusedActions: Object.freeze([...(restrictions.refusedActions ?? [])].sort()),
      requireHumanReview: restrictions.requireHumanReview ?? regulated,
      requireSources: restrictions.requireSources ?? false,
    }),
    refuses: Object.freeze([...refuses]),
    capabilities: Object.freeze(capabilities.map((capability) => Object.freeze({
      tag: capability.tag,
      evidence: capability.unimplemented === true ? null : capability.evidence,
      unimplemented: capability.unimplemented === true,
      purpose: capability.purpose ? String(capability.purpose) : null,
    }))),
    vocabulary: Object.freeze({ ...vocabulary }),
    disclaimers: Object.freeze([...disclaimers]),
    sources: Object.freeze(sources.map((source) => Object.freeze({
      title: String(source.title),
      url: String(source.url),
      licence: String(source.licence),
      checkedAt: Number(source.checkedAt),
    }))),
    provenance: Object.freeze({
      author: String(document.provenance?.author ?? 'unknown'),
      created: Number(document.provenance?.created ?? now()),
      licence: String(document.provenance?.licence ?? 'unspecified'),
    }),
  })
}

/**
 * Combine two restriction sets.
 *
 * Every operation here takes the *stricter* of the two. There is deliberately no function in
 * this module that relaxes a restriction, so a pack cannot be composed into a weaker state by
 * applying it after another one.
 */
export function strictestRestrictions(...sets) {
  const floors = sets.map((set) => set?.dataClassFloor ?? 'internal')
  const floor = floors.reduce((a, b) => (DATA_CLASS_RANK[b] > DATA_CLASS_RANK[a] ? b : a), 'internal')
  const refused = [...new Set(sets.flatMap((set) => set?.refusedActions ?? []))].sort()
  return Object.freeze({
    dataClassFloor: floor,
    refusedActions: Object.freeze(refused),
    requireHumanReview: sets.some((set) => set?.requireHumanReview === true),
    requireSources: sets.some((set) => set?.requireSources === true),
  })
}
