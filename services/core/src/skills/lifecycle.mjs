// The skill lifecycle: where "learn from experience" stops being a claim.
//
// Directive §6C is the governing text:
//
//   "When a workflow fails, capture the failure category, what was attempted, the
//    observed result, the correction and the eventual verified solution. If the task
//    is likely to recur, create a candidate skill improvement. Validate it in a safe
//    environment before making it available for future use. Track skill versions,
//    tests, provenance and performance. Retain the ability to roll back a harmful
//    change.
//
//    Do not silently rewrite core system instructions, grant new permissions or
//    install arbitrary code because an agent believes it has learned something."
//
// The last paragraph is the hard part, and it is a structural problem rather than a
// prompt-engineering one. A rule that says "do not do X" can be argued with; a rule
// that makes X unreachable cannot. So the invariants below are enforced by making the
// dangerous operations **unreachable rather than forbidden**:
//
//   I1  There is no delete. The registry has no delete method, and this module never
//       removes a record. ARCHIVED is the terminal state and it is reversible.
//
//   I2  Automatic transitions apply only to `agent`-created skills. A procedure a
//       human wrote is retired by a human. This is deliberately STRICTER than the
//       Hermes curator, whose deterministic inactivity walk can also archive bundled
//       skills; the narrower rule is the one that cannot surprise a user.
//
//   I3  A pinned skill is exempt from every automatic transition, unconditionally.
//
//   I4  No automatic path validates a skill. Promotion from candidate to validated
//       happens only through `validate()`, which requires recorded checks that all
//       passed. There is no "trust the agent" branch, because the agent is the thing
//       being governed.
//
//   I5  A disabled skill is not a curation candidate. A skill that cannot be loaded
//       must not be silently rewritten either.
//
// Adoption note: I1, I3 and the provenance gate of I2 are taken from Hermes Agent's
// documented curator invariants ("never deletes -- archive is the maximum"; "pinned
// skills are exempt from every auto-transition"; "touches only created_by: agent
// skills"). See docs/10-hermes-audit.md §3.1.

import { SKILL_STATES } from './registry.mjs'
import { NO_PERMISSIONS } from './permissions.mjs'

export const DEFAULT_LIFECYCLE = Object.freeze({
  staleAfterDays: 30,
  archiveAfterDays: 90,
})

export class SkillLifecycleError extends Error {
  constructor(message, code = 'skill_lifecycle_error') {
    super(message)
    this.name = 'SkillLifecycleError'
    this.code = code
  }
}

const DAY_MS = 86_400_000
const idleDays = (skill, now) => {
  const last = skill.usage.lastActivityAt ?? skill.updatedAt ?? skill.installedAt
  return (now - last) / DAY_MS
}

/**
 * Whether the curator may modify this skill without a human asking.
 *
 * Exported because it is the single decision the invariants reduce to, and a test can
 * assert it directly rather than inferring it from a transition that did not happen.
 */
export function curatorMayModify(skill) {
  if (skill.pinned) return { allowed: false, reason: 'pinned' }
  if (!skill.enabled) return { allowed: false, reason: 'disabled' }
  if (skill.createdBy !== 'agent') return { allowed: false, reason: `created by ${skill.createdBy}` }
  return { allowed: true, reason: 'agent-created, enabled, unpinned' }
}

/**
 * The deterministic inactivity walk.
 *
 * Idle time is the only input, so the result is reproducible and auditable: given the
 * same registry and the same clock, the same transitions happen. Nothing here uses a
 * model, which is the point -- a curation decision that cannot be re-derived is a
 * curation decision that cannot be reviewed.
 */
export function curate(registry, { now = Date.now(), staleAfterDays = DEFAULT_LIFECYCLE.staleAfterDays,
                                    archiveAfterDays = DEFAULT_LIFECYCLE.archiveAfterDays } = {}) {
  if (archiveAfterDays <= staleAfterDays) {
    throw new SkillLifecycleError('archiveAfterDays must be greater than staleAfterDays', 'invalid_thresholds')
  }
  const transitions = []
  const skipped = []

  for (const name of registry.names()) {
    const skill = registry.record(name)
    const permission = curatorMayModify(skill)
    if (!permission.allowed) {
      skipped.push({ name, state: skill.state, reason: permission.reason })
      continue
    }
    const idle = idleDays(skill, now)

    // Only forward transitions. A stale skill that is used again returns to validated
    // through `recordUsage` + the reverse transition below, not by resetting the clock.
    // NOTE: `updatedAt` is deliberately NOT touched here. It records when the skill's
    // content or metadata last changed, which is what "idle" is measured from; writing
    // it on a transition would reset the clock and make the archive threshold measure
    // from the moment the skill went stale rather than from its last activity. That bug
    // was caught by the tests below rather than by reading.
    if (skill.state === SKILL_STATES.VALIDATED && idle >= staleAfterDays) {
      skill.state = SKILL_STATES.STALE
      transitions.push({ name, from: SKILL_STATES.VALIDATED, to: SKILL_STATES.STALE, idleDays: round(idle) })
    } else if (skill.state === SKILL_STATES.STALE && idle >= archiveAfterDays) {
      skill.state = SKILL_STATES.ARCHIVED
      transitions.push({ name, from: SKILL_STATES.STALE, to: SKILL_STATES.ARCHIVED, idleDays: round(idle) })
    } else if (skill.state === SKILL_STATES.STALE && idle < staleAfterDays) {
      // Used again since it went stale. Back to validated: idle time is the only
      // signal, so a skill that was just used is not stale.
      skill.state = SKILL_STATES.VALIDATED
      transitions.push({ name, from: SKILL_STATES.STALE, to: SKILL_STATES.VALIDATED, idleDays: round(idle) })
    }
  }

  return { transitions, skipped, evaluatedAt: now, thresholds: { staleAfterDays, archiveAfterDays } }
}

const round = (value) => Math.round(value * 1000) / 1000

/**
 * Turn an observed failure and its verified correction into a candidate skill.
 *
 * This is the "experience-driven skill improvement" path, and every field it requires
 * is one the directive names: the failure category, what was attempted, what was
 * observed, the correction, and the verified solution. A record missing any of them
 * cannot be turned into a procedure, because a procedure assembled from a guess is a
 * guess with numbered steps.
 *
 * The result is ALWAYS a candidate. This function cannot validate, by construction:
 * it returns the installed name, and promotion requires evidence through `validate()`.
 */
export function proposeFromExperience(registry, experience, { now = Date.now() } = {}) {
  const required = ['failureCategory', 'attempted', 'observed', 'correction', 'verifiedSolution', 'name']
  const missing = required.filter((field) => !experience?.[field])
  if (missing.length) {
    throw new SkillLifecycleError(
      `cannot propose a skill without ${missing.join(', ')}; an unverified correction is not a procedure`,
      'incomplete_experience',
    )
  }
  const { name } = experience
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
    throw new SkillLifecycleError(
      `skill name '${name}' must be lowercase kebab-case; it becomes a directory name`,
      'invalid_name',
    )
  }

  const description = buildDescription(experience.description ?? experience.correction)
  const text = renderSkillDocument({
    name,
    description,
    version: experience.version ?? '0.1.0',
    createdBy: 'agent',
    author: experience.author ?? 'Aetheris experience capture',
    tags: experience.tags ?? [experience.failureCategory],
    whenToUse: experience.whenToUse ?? `When a task fails with the same category: ${experience.failureCategory}.`,
    prerequisites: experience.prerequisites ?? ['The tools named in the recorded failure are available.'],
    steps: experience.steps ?? [
      `Reproduce the failure ${experience.failureCategory} using the recorded input, and confirm it fails.`,
      `Record what was attempted: ${oneLine(experience.attempted)}`,
      `Record what was observed: ${oneLine(experience.observed)}`,
      `Apply the correction: ${oneLine(experience.correction)}`,
      `Confirm the corrected behaviour: ${oneLine(experience.verifiedSolution)}`,
    ],
    pitfalls: experience.pitfalls ?? [`The original failure: ${oneLine(experience.observed)}`],
    verification: experience.verification ?? 'Re-run the recorded reproduction and confirm it now succeeds.',
    permissions: experience.permissions ?? NO_PERMISSIONS,
    observedAt: new Date(now).toISOString(),
  })

  // The rendered document is validated by install(), so a malformed proposal is
  // rejected here rather than discovered when a task tries to load it.
  registry.install(text, { state: SKILL_STATES.CANDIDATE })
  return { name, state: SKILL_STATES.CANDIDATE, document: text }
}

/**
 * A description of at most 60 characters, one sentence, ending with a period.
 *
 * Truncation is deliberate and lossy, and it is visible in the document rather than
 * hidden: a 60-character summary that cuts mid-word would be worse than a short one,
 * so the cut happens at a word boundary and an ellipsis is never added to fake
 * completeness.
 */
export function buildDescription(source) {
  const cleaned = String(source ?? '').replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
  if (cleaned.length <= 59) return `${cleaned}.`
  const cut = cleaned.slice(0, 59)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > 20 ? cut.slice(0, boundary) : cut).trim()}.`
}

const oneLine = (value) => String(value).replace(/\s+/g, ' ').trim()

/** Render a SKILL.md document that satisfies manifest.mjs. */
export function renderSkillDocument(fields) {
  const {
    name, description, version, createdBy, author, tags = [],
    whenToUse, prerequisites = [], steps, pitfalls = [], verification, observedAt,
    permissions = NO_PERMISSIONS,
  } = fields
  const lines = [
    '---',
    `name: ${name}`,
    `description: "${description.replace(/"/g, "'")}"`,
    `version: ${version}`,
    `author: ${author}`,
    'license: MIT',
    'platforms: [linux, macos, windows]',
    'metadata:',
    '  aetheris:',
    `    tags: [${tags.map((t) => String(t).replace(/[^a-z0-9-]/gi, '-')).join(', ')}]`,
    `createdBy: ${createdBy}`,
    // Declared in the document, not passed at run time: this block is what a human reviews and
    // what the executor enforces, and it is rendered even when it is empty so that "reads
    // nothing" is a statement somebody made rather than a field that was forgotten.
    'permissions:',
    `  fsRead: [${(permissions.fsRead ?? []).join(', ')}]`,
    `  fsWrite: [${(permissions.fsWrite ?? []).join(', ')}]`,
    `  network: ${permissions.network === true}`,
    '---',
    '',
    `# ${name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')}`,
    '',
    '## When to Use',
    '',
    whenToUse,
    '',
  ]
  if (prerequisites.length) {
    lines.push('## Prerequisites', '', ...prerequisites.map((p) => `- ${p}`), '')
  }
  lines.push('## Procedure', '', ...steps.map((s, i) => `${i + 1}. ${s}`), '')
  if (pitfalls.length) {
    lines.push('## Pitfalls', '', ...pitfalls.map((p) => `- ${p}`), '')
  }
  lines.push('## Verification', '', verification, '')
  if (observedAt) {
    lines.push(`<!-- proposed from an observed failure on ${observedAt} -->`, '')
  }
  return lines.join('\n')
}

/**
 * Retire a skill explicitly, with a reason.
 *
 * There is no delete counterpart and no `hard` option: the entire point of I1 is that
 * the option does not exist to be passed. A retired skill's text is still retrievable
 * through `registry.document()`, which is what makes rollback meaningful.
 */
export function retire(registry, name, reason) {
  if (!reason) throw new SkillLifecycleError('retiring a skill requires a reason for the audit record', 'reason_required')
  const skill = registry.record(name)
  const from = skill.state
  if (from === SKILL_STATES.ARCHIVED) return { name, from, to: from, note: 'already archived' }
  skill.state = SKILL_STATES.ARCHIVED
  skill.updatedAt = Date.now()
  return { name, from, to: SKILL_STATES.ARCHIVED, reason }
}

/** Bring an archived skill back, provided it was validated at some point. */
export function restore(registry, name) {
  const skill = registry.record(name)
  if (skill.state !== SKILL_STATES.ARCHIVED) {
    throw new SkillLifecycleError(`skill '${name}' is ${skill.state}, not archived`, 'not_archived')
  }
  if (!skill.validation) {
    // Never validated means it was archived from candidate. Restoring it straight to
    // usable would be a validation bypass through the back door.
    skill.state = SKILL_STATES.CANDIDATE
    return { name, to: SKILL_STATES.CANDIDATE, note: 'never validated; restored as a candidate' }
  }
  skill.state = SKILL_STATES.VALIDATED
  skill.updatedAt = Date.now()
  return { name, to: SKILL_STATES.VALIDATED }
}
