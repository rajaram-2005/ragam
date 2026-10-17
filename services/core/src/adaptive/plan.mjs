// Planning: turning required capabilities into ordered steps, or refusing to.
//
// The plan is the contract between "what was asked" and "what will run". Two decisions here
// are deliberate and both were made against a plausible alternative:
//
//   * A plan whose step count exceeds the budget is **refused**, not truncated. GodCore's
//     `#plan` truncates and records a limitation, which is defensible for a fan-out where the
//     last step is an answer synthesis; here a truncated plan silently drops required work
//     from a task that still reports success, and a plan that cannot be run as written should
//     say so while a person can still change it.
//   * A step whose capability nothing implements is refused by name (`capability_unavailable`)
//     unless the step is marked optional, in which case it is kept in the plan marked
//     `optional: true` and the run reports it as skipped. "We could not do this part" and "we
//     did not need this part" are different sentences and the plan carries which one applies.
//
// The digest is what makes a checkpoint meaningful: resuming a checkpoint against a different
// plan is not a resume, and `checkpoint.mjs` compares this digest to the one it stored.

import { createHash } from 'node:crypto'

export const STEP_KINDS = Object.freeze({
  EXECUTE: 'execute',
})

export class PlanError extends Error {
  constructor(message, code = 'plan_error', detail = {}) {
    super(message)
    this.name = 'PlanError'
    this.code = code
    this.detail = detail
  }
}

/** Canonical JSON: sorted keys, so two equal plans have one digest. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function digestOf(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

/**
 * Build and check a plan from explicit steps.
 *
 * @param {object} options
 * @param {object} options.intent     a resolved intent from `readIntent`
 * @param {object} options.steps      [{ id, capability, dependsOn, optional, expected }]
 * @param {object} options.registry   a CapabilityRegistry
 * @param {object} [options.budget]   { maxSteps }
 */
export function planSteps({ intent, steps, registry, budget = {} }) {
  if (!intent?.resolved) {
    throw new PlanError(
      'refusing to plan an unresolved intent; ask the clarification question first, because a plan built on a guess encodes the guess as work',
      'intent_unresolved',
      { clarification: intent?.clarification ?? null },
    )
  }
  if (!registry) throw new PlanError('planning needs a capability registry', 'no_registry')
  if (!Array.isArray(steps) || !steps.length) {
    throw new PlanError('a plan needs at least one step', 'empty_plan')
  }
  const maxSteps = budget.maxSteps ?? Infinity
  if (steps.length > maxSteps) {
    throw new PlanError(
      `the plan has ${steps.length} steps and the budget allows ${maxSteps}; refused rather than truncated, because a truncated plan can drop required work while the run still reports success`,
      'plan_too_long',
      { steps: steps.length, maxSteps },
    )
  }

  const ids = new Set()
  const normalised = steps.map((step, index) => {
    const id = step.id ?? `step-${index + 1}`
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
      throw new PlanError(`step id '${id}' must be lowercase kebab-case`, 'invalid_step_id')
    }
    if (ids.has(id)) throw new PlanError(`two steps share the id '${id}'`, 'duplicate_step_id')
    ids.add(id)
    if (!step.capability) throw new PlanError(`step '${id}' names no capability`, 'missing_capability')
    return Object.freeze({
      id,
      kind: step.kind ?? STEP_KINDS.EXECUTE,
      capability: step.capability,
      operation: step.operation ?? null,
      dependsOn: Object.freeze([...(step.dependsOn ?? [])]),
      optional: step.optional === true,
      expected: Object.freeze({ ...(step.expected ?? {}) }),
    })
  })

  for (const step of normalised) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        throw new PlanError(`step '${step.id}' depends on '${dependency}', which is not in the plan`, 'unknown_dependency')
      }
      if (dependency === step.id) {
        throw new PlanError(`step '${step.id}' depends on itself`, 'cyclic_plan')
      }
    }
  }

  const order = topologicalOrder(normalised)

  // Where the plan asks for something this installation cannot do. The failure this prevents:
  // a plan that reaches a run, fails at step four, and reports a failure of the *task* when
  // the truth is that a capability was never installed.
  const required = [...new Set(normalised.filter((step) => !step.optional).map((step) => step.capability))]
  const missing = registry.unimplemented(required)
  if (missing.length) {
    throw new PlanError(
      `nothing installed implements ${missing.join(', ')}; this is a missing capability, not a failed task`,
      'capability_unavailable',
      { missing },
    )
  }
  const optionalMissing = [...new Set(
    normalised.filter((step) => step.optional).map((step) => step.capability),
  )].filter((tag) => !registry.has(tag))

  const plan = Object.freeze({
    intent: Object.freeze({ request: intent.request, capabilities: intent.capabilities, confidence: intent.confidence }),
    steps: Object.freeze(normalised),
    order: Object.freeze(order),
    optionalUnavailable: Object.freeze(optionalMissing.sort()),
    bounded: maxSteps !== Infinity,
  })
  return Object.freeze({ ...plan, digest: digestOf(plan) })
}

/** Depth-first order over `dependsOn`; a cycle is reported rather than silently ordered. */
function topologicalOrder(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const order = []
  const state = new Map()
  const visit = (step, trail) => {
    const seen = state.get(step.id)
    if (seen === 'done') return
    if (seen === 'visiting') {
      throw new PlanError(
        `the plan has a dependency cycle: ${[...trail, step.id].join(' -> ')}`,
        'cyclic_plan',
      )
    }
    state.set(step.id, 'visiting')
    for (const dependency of step.dependsOn) visit(byId.get(dependency), [...trail, step.id])
    state.set(step.id, 'done')
    order.push(step.id)
  }
  for (const step of steps) visit(step, [])
  return order
}

/**
 * One capability, one step: the shape almost every adaptive task has, kept as a builder so a
 * caller does not hand-write a plan object and accidentally leave out `dependsOn`.
 */
export function singleStepPlan({ intent, registry, budget = {}, expected = {} }) {
  const capability = intent.capabilities[0]
  return planSteps({
    intent,
    registry,
    budget,
    steps: [{ id: 'run', capability, operation: intent.request, expected }],
  })
}
