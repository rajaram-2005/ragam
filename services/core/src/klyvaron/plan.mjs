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

import { KLYVARON, CAPABILITY_STATES, TIER_STATUS, MOBILE_TARGETS, validateFamily } from './tiers.mjs'

export const GATE_STATES = Object.freeze({ MET: 'met', OPEN: 'open' })

export const GATES = Object.freeze({
  ARTIFACT: 'artifact',
  PROVENANCE: 'provenance',
  MEASUREMENTS: 'measurements',
  CHAT: 'chat',
  COVERAGE: 'capability_coverage',
  STORAGE: 'storage_target',
  HARDWARE: 'hardware_qualification',
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
