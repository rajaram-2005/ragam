// The training-free path: a tier composed at run time from a pinned third-party base, the user's
// own accelerator, and the mechanisms in this repository.
//
// WHY THIS EXISTS
//
// Training a from-scratch frontier assistant needs data, compute and a licence review that this
// project does not have. Pretending otherwise is what the family validator exists to refuse. But
// a tier does not have to be a trained model to be a real, checkable product: it can be a
// *composition* -- an unmodified, licence-checked third-party base running on the user's GPU or
// NPU, wrapped in this repository's retrieval, evidence and policy mechanisms. That path needs
// **no training at all**, and every step of it can be verified before a user is told it works.
//
// WHY PRO AND MAX DO NOT TAKE IT
//
// This path was the plan for Pro and Max, and it was rejected: it delivers someone else's weights
// with our tier label on them, and a model of this family has to be *this family's* model. Pro
// and Max are therefore trained from random initialisation on this repository's own architecture
// (`klyvaron/architecture.mjs`), which is what Lite already is. The module is kept because the
// technique is real, validated and tested -- and because a future tier that genuinely cannot be
// trained should have a checked path rather than an improvised one -- but no tier of the family
// is composed today, and `backingPathGates` says so: a composed tier can never be the family's
// own model, so it cannot satisfy `own_weights`.
//
// WHAT THIS IS NOT
//
// The base is not a Klyvaron model and never gets the tier label. `tierClaimForArtifact()` looks
// a label up in the backings of *available* capabilities, and a composed tier has none, so an
// unchanged third-party model cannot be relabelled as Pro or Max. Directive §5A is enforced by
// that lookup, not by this paragraph.
//
// THE STEPS ARE THE PLAN
//
// A composed tier is usable only when every step below is satisfied. Each step either holds (with
// the evidence that says why) or it does not, with the reason. `measure` stays unsatisfied until a
// real run on a real device records tokens per second and peak memory -- a plan is not a
// measurement, and this repository has no GPU to produce one.

import { ACCELERATORS, eligibleAccelerators, placementFor } from '../hardware/accelerators.mjs'
import { RECIPE_STEP_IDS } from './architecture.mjs'

/** Licences a composed base may carry. Mirrors `services/fabric/fabric/training/policy.py`. */
export const LICENCES_ALLOWED = Object.freeze([
  'Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'CC-BY-4.0',
])

export const BACKING_PATHS = Object.freeze({
  TRAINED: 'trained_from_scratch',
  COMPOSED: 'composed_no_training',
})

export const STEP_STATES = Object.freeze({
  SATISFIED: 'satisfied',
  REQUIRED: 'required',
  BLOCKED: 'blocked',
  NOT_APPLICABLE: 'not_applicable',
})

/** The ordered steps. `machine: true` marks what only the user's own computer can do. */
export const COMPOSITION_STEPS = Object.freeze([
  { id: 'licence', label: 'The base licence is on the allowlist, read at the pinned revision', machine: false },
  { id: 'pin', label: 'The base is pinned to one revision and its weight hash is recorded', machine: false },
  { id: 'fetch', label: 'The weights are fetched on the user\'s machine; this repository ships none', machine: true },
  { id: 'convert', label: 'Optional quantisation, with a parity check against the unquantised model', machine: true, optional: true },
  { id: 'runtime', label: 'A runtime the accelerator probe confirmed serves it', machine: true },
  { id: 'fit', label: 'Model and context fit that accelerator\'s measured memory', machine: false },
  { id: 'mechanisms', label: 'The retrieval and evidence mechanisms are attached (they are not weights)', machine: false },
  { id: 'measure', label: 'One real run records device, tokens/s and peak memory; until then nothing is claimed', machine: true },
])

export const COMPOSITION_STEP_IDS = Object.freeze(COMPOSITION_STEPS.map((step) => step.id))

const step = (id, status, reason = null, evidence = null) => ({ id, status, reason, evidence })

function licenceStep(base) {
  if (!base) return step('licence', STEP_STATES.BLOCKED, 'no base has been chosen; choosing one is a licence decision with a record')
  if (!base.licence) return step('licence', STEP_STATES.BLOCKED, 'the base names no licence, and an unnamed licence cannot be checked')
  if (!LICENCES_ALLOWED.includes(base.licence)) {
    return step('licence', STEP_STATES.BLOCKED, `licence ${base.licence} is not on the allowlist ${LICENCES_ALLOWED.join(', ')}`)
  }
  return step('licence', STEP_STATES.SATISFIED, null, `${base.id ?? 'the base'} is ${base.licence}`)
}

function pinStep(base) {
  if (!base) return step('pin', STEP_STATES.BLOCKED, 'no base has been chosen')
  if (!base.revision) return step('pin', STEP_STATES.BLOCKED, 'the base is not pinned to a revision; a moving ref is not a base')
  if (!base.weightsSha256) return step('pin', STEP_STATES.BLOCKED, 'the base records no weight hash, so a download could not be verified')
  return step('pin', STEP_STATES.SATISFIED, null, `${base.id}@${String(base.revision).slice(0, 12)} · ${String(base.weightsSha256).slice(0, 12)}…`)
}

/**
 * The composition plan for one tier.
 *
 * @param {string} tierId
 * @param {{ base?: object|null, device?: object|null, contextTokens?: number,
 *           quantisation?: { format?: string, parityChecked?: boolean },
 *           weightsPresent?: boolean, measured?: object|null,
 *           requiresAccelerator?: boolean }} [options]
 */
export function compositionPlan(tierId, {
  base = null, device = null, contextTokens = 4096, quantisation = { format: 'none' },
  weightsPresent = false, measured = null, requiresAccelerator = true,
} = {}) {
  const steps = [licenceStep(base), pinStep(base)]

  steps.push(weightsPresent
    ? step('fetch', STEP_STATES.SATISFIED, null, 'weights present on this machine')
    : step('fetch', STEP_STATES.REQUIRED, 'the user\'s machine fetches the weights; nothing is redistributed from here'))

  const format = quantisation?.format ?? 'none'
  if (format === 'none') {
    steps.push(step('convert', STEP_STATES.NOT_APPLICABLE, 'running unquantised; no conversion to check'))
  } else if (!['int8', 'int4'].includes(format)) {
    steps.push(step('convert', STEP_STATES.BLOCKED, `unknown quantisation ${format}; supported formats are none, int8 and int4`))
  } else if (quantisation?.parityChecked) {
    steps.push(step('convert', STEP_STATES.SATISFIED, null, `${format}, parity checked against the unquantised model`))
  } else {
    steps.push(step('convert', STEP_STATES.REQUIRED, `${format} needs a parity check: a conversion that is not compared with its source is a different model nobody measured`))
  }

  const found = device ? eligibleAccelerators(device) : { confirmed: [], candidates: [], cpuAvailable: true }
  const accelerated = found.confirmed.find((entry) => entry.accelerator !== 'cpu') ?? null
  if (accelerated) {
    steps.push(step('runtime', STEP_STATES.SATISFIED, null, `${accelerated.accelerator} via ${ACCELERATORS[accelerated.accelerator].runtimes[0]}`))
  } else if (requiresAccelerator) {
    steps.push(step('runtime', STEP_STATES.BLOCKED, device
      ? `no runtime probe confirmed an accelerator on this device (${found.candidates.map((c) => `${c.accelerator}: ${c.probe}`).join('; ') || 'no candidate detected'})`
      : 'no device record, so no runtime can be confirmed'))
  } else {
    steps.push(step('runtime', STEP_STATES.REQUIRED, 'no accelerator confirmed; this tier may run on the CPU, which is slower and is not the GPU path'))
  }

  if (!base || !device) {
    steps.push(step('fit', STEP_STATES.BLOCKED, !base ? 'no base is chosen, so there is nothing to fit' : 'no device record, so there is no measured memory to fit into'))
  } else {
    const placement = placementFor({
      device, contextTokens, requiresAccelerator, bitsPerWeight: format === 'int4' ? 4 : format === 'int8' ? 8 : 16,
      model: {
        parameters: base.parameters, layers: base.layers, kvHeads: base.kvHeads, headDim: base.headDim,
        maxContextTokens: base.maxContextTokens ?? contextTokens,
      },
    })
    steps.push(placement.eligible
      ? step('fit', STEP_STATES.SATISFIED, null, `${accelerated ? accelerated.accelerator : 'cpu'}: ${placement.envelope.totalBytes} bytes for ${contextTokens} tokens`)
      : step('fit', STEP_STATES.BLOCKED, placement.reasons.join(' ')))
  }

  // These mechanisms exist, are tested, and are *not* weights: they lower the amount a composed
  // tier has to rely on the base for, and they are the reason the family is not just a wrapper.
  steps.push(step('mechanisms', STEP_STATES.SATISFIED, null,
    'klyvaron/trends.mjs (dated observations that expire and abstain), klyvaron/affect.mjs (consent-gated, cited, abstaining)'))

  steps.push(measured && measured.tokensPerSecond > 0 && measured.peakBytes > 0 && measured.device
    ? step('measure', STEP_STATES.SATISFIED, null, `${measured.device}: ${measured.tokensPerSecond} tokens/s, peak ${measured.peakBytes} bytes`)
    : step('measure', STEP_STATES.REQUIRED, 'a plan is not a measurement: the first real run on the user\'s device has to record device, tokens/s and peak memory'))

  const blockers = steps.filter((s) => s.status === STEP_STATES.BLOCKED)
  const outstanding = steps.filter((s) => s.status === STEP_STATES.REQUIRED)
  return {
    tier: tierId,
    path: BACKING_PATHS.COMPOSED,
    trainingRequired: false, // the whole point: no step here trains anything
    steps: steps.map((s) => ({ ...COMPOSITION_STEPS.find((c) => c.id === s.id), ...s })),
    ready: blockers.length === 0 && outstanding.length === 0,
    blockedOn: blockers.map((s) => s.id),
    waitingOn: outstanding.map((s) => s.id),
  }
}

/** Human-readable plan, for the CLI. Every unsatisfied step prints its reason. */
export function formatComposition(plan) {
  const lines = [`${plan.tier}: ${plan.path} — training required: ${plan.trainingRequired ? 'yes' : 'no'}`]
  for (const item of plan.steps) {
    const mark = item.status === STEP_STATES.SATISFIED ? '[x]' : item.status === STEP_STATES.NOT_APPLICABLE ? '[-]' : '[ ]'
    lines.push(`  ${mark} ${item.label}`)
    if (item.evidence) lines.push(`        evidence: ${item.evidence}`)
    if (item.reason) lines.push(`        ${item.status}: ${item.reason}`)
  }
  lines.push(`  ready: ${plan.ready}${plan.blockedOn.length ? ` (blocked on ${plan.blockedOn.join(', ')})` : ''}`
    + `${plan.waitingOn.length ? ` (waiting on ${plan.waitingOn.join(', ')})` : ''}`)
  return lines.join('\n')
}

/**
 * Validate a tier's recorded backing path, so a record cannot claim the training-free path while
 * hiding a trained one behind it, or describe a composed tier as though its base were ours.
 */
export function backingPathViolations(backingPath, where) {
  if (!backingPath || typeof backingPath !== 'object') return [`${where}: every tier must record a backing path (${Object.values(BACKING_PATHS).join(' or ')})`]
  const problems = []
  if (!Object.values(BACKING_PATHS).includes(backingPath.path)) {
    return [`${where}.path: unknown backing path ${JSON.stringify(backingPath.path)}`]
  }
  if (typeof backingPath.trainingRequired !== 'boolean') problems.push(`${where}.trainingRequired: must be stated as a boolean`)
  if (backingPath.path === BACKING_PATHS.TRAINED) {
    // The family's own model. The rule that makes it the family's own is that nothing else is
    // underneath it: a from-scratch model with a base checkpoint is a composed model wearing a
    // from-scratch label.
    if (backingPath.trainingRequired !== true) problems.push(`${where}.trainingRequired: a trained tier must state that training is required`)
    if (!backingPath.requires) problems.push(`${where}.requires: a trained tier must say what the training runs on`)
    if (!backingPath.architecture) problems.push(`${where}.architecture: a trained tier must name the architecture of this family it is a preset of`)
    if (!Array.isArray(backingPath.steps) || backingPath.steps.length === 0) problems.push(`${where}.steps: a trained tier must list the recipe steps`)
    else {
      const unknown = backingPath.steps.filter((id) => !RECIPE_STEP_IDS.includes(id))
      if (unknown.length) problems.push(`${where}.steps: unknown step(s) ${unknown.join(', ')}`)
    }
    for (const [index, base] of (backingPath.bases ?? []).entries()) {
      problems.push(`${where}.bases[${index}]: a from-scratch model has no base, and this one names ${JSON.stringify(base?.id ?? base?.artifact ?? 'one')}`)
    }
  }
  if (backingPath.path === BACKING_PATHS.COMPOSED) {
    if (backingPath.trainingRequired !== false) problems.push(`${where}.trainingRequired: a composed tier must state that no training is required`)
    if (!backingPath.requires) problems.push(`${where}.requires: a composed tier must say what the user\'s machine has to provide`)
    if (!Array.isArray(backingPath.steps) || backingPath.steps.length === 0) problems.push(`${where}.steps: a composed tier must list the composition steps`)
    else {
      const unknown = backingPath.steps.filter((id) => !COMPOSITION_STEP_IDS.includes(id))
      if (unknown.length) problems.push(`${where}.steps: unknown step(s) ${unknown.join(', ')}`)
    }
    // The base, when one is named, is third-party by definition and must say so.
    for (const [index, base] of (backingPath.bases ?? []).entries()) {
      if (base?.provenance !== 'third_party') problems.push(`${where}.bases[${index}]: a composed tier's base must be recorded as third_party`)
      if (!base?.licence || !base?.revision) problems.push(`${where}.bases[${index}]: a base must name its licence and its pinned revision`)
      if (base?.licence && !LICENCES_ALLOWED.includes(base.licence)) problems.push(`${where}.bases[${index}]: licence ${base.licence} is not on the allowlist`)
    }
  }
  return problems
}

/** The plan gates a backing path implies. Derived, so they cannot be declared satisfied. */
export function backingPathGates(backingPath) {
  const trained = backingPath?.path === BACKING_PATHS.TRAINED
  const composed = backingPath?.path === BACKING_PATHS.COMPOSED
  // Own weights means entirely this family's: trained from random initialisation here, released,
  // and with nothing underneath it. A composed tier is the clearest counter-example, and it is
  // why Pro and Max are not composed.
  const own = trained && backingPath?.verified === true && (backingPath?.bases ?? []).length === 0
  return {
    ownWeights: {
      met: own,
      evidence: own
        ? `${backingPath.architecture ?? 'the family architecture'} weights, trained from random initialisation and released with a model card`
        : null,
      reason: own ? null : composed
        ? 'This tier is composed from a third-party base, so the weights are not this family\'s own. Pro and Max are not composed: a model of this family has to be this family\'s model.'
        : 'The architecture and the exact config are recorded and digested, but no weights of this family exist yet. An architecture is not an artifact, and a plan is not a measurement.',
    },
    accelerated: {
      met: Boolean(backingPath?.accelerator?.measured),
      evidence: backingPath?.accelerator?.measured ? `${backingPath.accelerator.id} measured` : null,
      reason: composed
        ? `No measured run on a confirmed accelerator${backingPath?.accelerator?.id ? ` (${backingPath.accelerator.id} is recorded, unmeasured)` : ''}. `
          + 'The runtime probe is what confirms an accelerator; a hardware name is not a measurement.'
        : trained
          ? backingPath?.verified
            ? 'This tier was trained and evaluated on the CPU, and no accelerator has been measured running it. The gate stays open rather than being credited for hardware it could in principle use.'
            : 'No accelerator has been measured, because there is nothing to run yet: the weights do not exist. When they do, the runtime probe on the machine that trains and serves them is what confirms an accelerator -- a hardware name is not a measurement.'
          : 'No accelerated runtime has been measured for this tier.',
    },
  }
}
