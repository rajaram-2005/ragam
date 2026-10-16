// The development plan for the Klyvaron family: what must be true before each tier can move.
//
// tiers.mjs records what each tier IS today. This module records what each tier still needs,
// as explicit gates, so "develop Pro and Max" has a checkable definition instead of a
// direction. Every gate status is DERIVED from the tier record. Nothing here can mark a gate
// met by declaration, because a plan that could assert its own progress would be the same
// overclaim the family validator exists to refuse.
//
// Gate states:
//   met   - the tier record shows it. The evidence field says where.
//   open  - the tier record does not show it yet. The reason says what is missing.
//
// A gate that the record cannot express at all (hardware qualification, today) is `open`
// for every tier. Absence of evidence is reported as absence, not as a pending success.

import { KLYVARON, CAPABILITY_STATES, TIER_STATUS, MOBILE_TARGETS, FAMILY_STANCE, SEPARATE_MODALITIES, modalityArtifacts, validateFamily } from './tiers.mjs'
import { backingPathGates } from './composition.mjs'

export const GATE_STATES = Object.freeze({ MET: 'met', OPEN: 'open' })

export const GATES = Object.freeze({
  ARTIFACT: 'artifact',
  PROVENANCE: 'provenance',
  MEASUREMENTS: 'measurements',
  CHAT: 'chat',
  COVERAGE: 'capability_coverage',
  STORAGE: 'storage_target',
  HARDWARE: 'hardware_qualification',
  // What this family is for, rather than how large it is. Each of these is derived from the
  // tier record exactly like the gates above, so none of them can be marked met by writing
  // a document: the differentiators move only when an artifact with measurements backs them,
  // and modality separation moves only when image and video have artifacts of their own.
  DIFFERENTIATION: 'differentiation_stance',
  TREND_AWARENESS: 'trend_awareness',
  AFFECT_HISTORY: 'affect_history',
  MODALITY_SEPARATION: 'modality_separation',
  // Whose model this is: weights trained from random initialisation in this repository, with
  // nothing third-party underneath them. Met only by a released artifact -- an architecture and a
  // config are not an artifact, and a composed tier can never satisfy it.
  OWN_WEIGHTS: 'own_weights',
  ACCELERATED: 'accelerated_runtime',
})

const gate = (id, label, met, evidence, reason) => ({ id, label, status: met ? GATE_STATES.MET : GATE_STATES.OPEN, evidence: met ? evidence : null, reason: met ? null : reason })

// A capability counts only when it is AVAILABLE *and* has a backing. A bare `available` label is
// what the validator refuses, so the plan must not count it as progress either.
function availableOf(tier) {
  return Object.entries(tier.capabilities).filter(([, claim]) => claim.state === CAPABILITY_STATES.AVAILABLE && claim.backing)
}

/**
 * The gates for one tier. The same ids are returned for every tier, so a comparison across
 * tiers is a comparison of the same questions.
 */
export function tierGates(tier, { violations = [] } = {}) {
  const available = availableOf(tier)
  const total = Object.keys(tier.capabilities).length
  // Read from THIS tier record, not from the built-in family, so a plan of another record is honest.
  const backings = available.map(([, claim]) => claim.backing)
  const owned = [...new Set(backings.flatMap((b) => [b.artifact, b.supersededArtifact?.artifact]).filter(Boolean))]
  const tierViolations = violations.filter((v) => v.startsWith(`${tier.id}`))
  const profile = tier.storageProfile ?? {}
  // The 1.5 GB per-model figure is the MOBILE budget. A laptop or workstation tier has no such target
  // in the record, so its size is not evidence of meeting one.
  const storageMet = tier.targetHardware === 'mobile' && profile.primaryArtifactBytes != null && profile.primaryArtifactBytes <= MOBILE_TARGETS.primaryModelBytes

  // The differentiating capabilities are the family's purpose. They are read from the same
  // place as everything else: a state, a backing and measurements, or an open gate.
  const differentiatorState = (name) => {
    const claim = tier.capabilities[name]
    return claim?.state === CAPABILITY_STATES.AVAILABLE && claim.backing ? claim : null
  }
  const trend = differentiatorState('trend.awareness')
  const affect = differentiatorState('affect.history')
  // Modalities this tier actually names. A modality with no artifact is an open gate, and the
  // reason names the modality so a reader sees which one is missing.
  const roles = modalityArtifacts(tier)
  const namedModalities = SEPARATE_MODALITIES.filter((modality) => roles[modality])
  const missingModalities = namedModalities.filter((modality) => !roles[modality].artifact)
  // An artifact being present is not enough: the validator also refuses one artifact serving
  // both text and image/video. A plan that read only the presence would call a relabelled text
  // model separated, so a violation on that modality keeps the gate open too.
  const sharedArtifact = tierViolations.filter((v) => namedModalities.some((modality) => v.startsWith(`${tier.id}.${modality}:`)))
  const separated = missingModalities.length === 0 && sharedArtifact.length === 0
  // Derived from the tier's recorded backing path, so a composed tier cannot be reported as
  // verified, and a trained tier cannot be reported as training-free.
  const pathGates = backingPathGates(tier.backingPath)

  return [
    gate(GATES.ARTIFACT, 'A model artifact backs at least one capability', owned.length > 0,
      [...new Set(backings.map((b) => b.artifact))].join(', ') || null, 'No artifact has been produced for this tier.'),
    gate(GATES.PROVENANCE, 'Every backing names its provenance and licence', backings.length > 0 && backings.every((b) => b.provenance && b.licence),
      [...new Set(backings.map((b) => `${b.artifact}: ${b.provenance}, ${b.licence}`))].join('; ') || null,
      'Nothing is backed, so there is no provenance or licence to record.'),
    gate(GATES.MEASUREMENTS, 'Every available capability has measurements and stated limitations',
      available.length > 0 && tierViolations.length === 0 && available.every(([, c]) => c.backing?.measured && c.backing?.limitations?.length),
      `${available.length} capability record(s) with measurements`,
      'No capability is available, so there is nothing to measure.'),
    gate(GATES.CHAT, 'Chat is backed by an instruction-tuned artifact', available.some(([name]) => name === 'chat'),
      tier.capabilities.chat?.backing?.artifact ?? null, tier.capabilities.chat?.reason ?? 'chat is not available at this tier.'),
    gate(GATES.COVERAGE, 'Every capability the directive names is available', available.length === total,
      `${available.length} of ${total}`, `${total - available.length} of ${total} capabilities are not yet available.`),
    gate(GATES.STORAGE, 'Primary artifact fits the 1.5 GB per-model target', storageMet,
      profile.primaryArtifactBytes != null ? `${profile.primaryArtifactBytes} bytes` : null,
      tier.targetHardware === 'mobile' ? 'No artifact size is recorded for this tier.' : `The 1.5 GB per-model target is the mobile budget. No storage target is recorded for ${tier.targetHardware} hardware.`),
    gate(GATES.HARDWARE, 'Qualified on the target hardware class', false, null,
      `The family record has no hardware qualification for ${tier.targetHardware} devices. Tier targeting is not evidence of eligibility.`),
    // The stance is a record, so it is already met and the evidence says what it forbids.
    // It is on this list because a stance nobody checks is a slogan.
    gate(GATES.DIFFERENTIATION, 'The family records what it is for and refuses competitive claims',
      FAMILY_STANCE.competitive === false && FAMILY_STANCE.forbiddenClaims.length > 0,
      'stance: not competitive; allowed comparisons are computed baselines and this family\'s own earlier artifacts',
      'No stance is recorded.'),
    gate(GATES.TREND_AWARENESS, 'Trend awareness is backed: dated, sourced and scored on held-out questions', Boolean(trend),
      trend?.backing?.artifact ?? null,
      'No artifact backs trend.awareness at this tier. Three pieces exist and none of them is enough on its own: '
      + 'the dated-source mechanism in klyvaron/trends.mjs, the age-bucket input and verdict head in '
      + 'architecture.mjs, and a measured prototype of those parts on generated data '
      + '(docs/experiments/differentiator-prototype.json). This gate moves on an artifact trained on real '
      + 'sources and scored on held-out questions, because a mechanism is not a model capability.'),
    gate(GATES.AFFECT_HISTORY, 'Understanding the user\'s expressed history is backed and evaluated', Boolean(affect),
      affect?.backing?.artifact ?? null,
      'No artifact backs affect.history at this tier. The evidence-linked signal reader in klyvaron/affect.mjs '
      + 'abstains without consent, the state input and state head are parts of the model, and the prototype '
      + 'measured the head on generated text. A model capability still needs an artifact evaluated on real '
      + 'messages, including the abstention cases, and that is what stays open here.'),
    gate(GATES.MODALITY_SEPARATION, 'Image and video have artifacts of their own, not a relabelled text model', separated,
      separated ? (namedModalities.join(', ') || 'no image or video capability is named at this tier') : null,
      missingModalities.length > 0
        ? `No artifact exists for the ${missingModalities.join(' and ')} modalit${missingModalities.length > 1 ? 'ies' : 'y'} this tier names. `
          + 'A text artifact is never relabelled as an image or video model; the validator refuses that outright.'
        : sharedArtifact.join(' ')),
    // Last, because these two are about how the tier is *backed* rather than what it can do:
    // whose weights these are, and whether a measured run on a confirmed accelerator exists.
    gate(GATES.OWN_WEIGHTS, 'The weights are this family\'s own, trained from random initialisation here', pathGates.ownWeights.met,
      pathGates.ownWeights.evidence, pathGates.ownWeights.reason),
    gate(GATES.ACCELERATED, 'A confirmed accelerator has been measured running this tier', pathGates.accelerated.met,
      pathGates.accelerated.evidence, pathGates.accelerated.reason),
  ]
}

/**
 * The development plan for the whole family.
 *
 * `family` defaults to the real record. A different one may be passed for a test, and the
 * validation is run on that same family, so a plan is never built on an invalid record.
 */
export function developmentPlan(family = KLYVARON) {
  const { valid, violations } = validateFamily(family)
  return {
    valid,
    violations,
    tiers: Object.values(family).map((tier) => {
      const gates = tierGates(tier, { violations })
      return {
        id: tier.id,
        displayName: tier.displayName,
        status: tier.status,
        targetHardware: tier.targetHardware,
        met: gates.filter((g) => g.status === GATE_STATES.MET).length,
        open: gates.filter((g) => g.status === GATE_STATES.OPEN).length,
        gates,
        // Only an unbuilt tier has nothing to say about itself beyond its gates; a partial
        // one has an artifact and a list of what it still lacks.
        summary: tier.status === TIER_STATUS.UNBUILT
          ? 'Unbuilt. Nothing in this tier can be used yet.'
          : 'Partial. Available capabilities are listed in the family report; the open gates are what stand between this and a complete tier.',
      }
    }),
  }
}

/** A human-readable table, for the CLI. Gate reasons are printed because a bare "open" hides why. */
export function formatPlan(plan) {
  const lines = []
  lines.push(plan.valid ? 'Family record: valid' : `Family record: INVALID (${plan.violations.length} violation(s))`)
  for (const violation of plan.violations) lines.push(`  ! ${violation}`)
  for (const tier of plan.tiers) {
    lines.push('', `${tier.displayName} [${tier.status}] — ${tier.met} met, ${tier.open} open`, `  ${tier.summary}`)
    for (const g of tier.gates) {
      lines.push(`  ${g.status === GATE_STATES.MET ? '[x]' : '[ ]'} ${g.label}`)
      if (g.status === GATE_STATES.MET) { if (g.evidence) lines.push(`        evidence: ${g.evidence}`) } else lines.push(`        open: ${g.reason}`)
    }
  }
  return lines.join('\n')
}
