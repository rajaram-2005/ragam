// The runner: a plan, executed step by step, inside a budget, with a durable checkpoint after
// every step, and a resume that continues rather than starts over.
//
// This is the layer the directive's Phase 2 asks for beyond the single-task milestone: bounded
// execution, timeouts, checkpoints, resumable tasks. The loop already routes, executes, verifies
// and records one task; the runner drives several in an order, charges them against a budget,
// and writes down where it stopped.
//
// What makes a resume honest, rather than a re-run wearing the word:
//
//   * Only steps recorded `complete` *and* verified are skipped. A step that ran but was not
//     verified is re-run, because the recorded result is exactly the thing in doubt.
//   * The plan digest is checked first (`checkpoint.resume`), so a resumed run cannot be
//     measured against a different plan's progress.
//   * The result reports `replayed` and `skipped` step ids, and `resumedFrom` names the
//     checkpoint sequence, so a caller reading the output can see what was done this time and
//     what was inherited.
//
// Timeouts are implemented for what can be interrupted and reported for what cannot. A
// synchronous executor cannot be pre-empted from inside JavaScript: pretending otherwise with
// `Promise.race` would leave the work running while reporting it stopped. So an async step is
// raced against the deadline and, if the deadline wins, the step is recorded as timed out with
// `abandoned: true` and the note that the underlying work *may still be running*; a synchronous
// step is gated before it starts (its measurement must fit the remaining budget) and, if it
// overruns anyway, recorded `overDeadline: true` and the run goes `partial`. Both paths report
// what was observed instead of what was hoped.

import { Budget, estimateFor } from './budget.mjs'
import { RUN_STATES } from './checkpoint.mjs'
import { canonical } from './plan.mjs'
import { LoopError, timeInvocation } from './loop.mjs'

export const STEP_STATUS = Object.freeze({
  COMPLETE: 'complete',
  SKIPPED: 'skipped', // optional step with no implementation installed
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  NOT_ATTEMPTED: 'not_attempted', // the run stopped before reaching it
})

export const RUN_OUTCOMES = Object.freeze({
  SUCCEEDED: 'succeeded',
  PARTIAL: 'partial',
  FAILED: 'failed',
})

export class RunnerError extends Error {
  constructor(message, code = 'runner_error', detail = {}) {
    super(message)
    this.name = 'RunnerError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Run work under a deadline, for the case where the work can actually be awaited.
 *
 * Synchronous work is *not* handled here, and deliberately: JavaScript cannot interrupt a
 * synchronous call, so a `Promise.race` around one would return "timed out" while the function
 * kept running -- a claim about the past that the runtime does not support. `run()` therefore
 * gates synchronous steps before they start and reports overruns after, and this helper exists
 * for callers whose work is a promise, where abandoning the *wait* is a fact and is stated as
 * one: the underlying work may still be running after this returns.
 */
export async function runWithinDeadline(fn, { deadlineMs, timer = () => performance.now() }) {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new RunnerError(`a deadline must be a non-negative number of milliseconds, got ${JSON.stringify(deadlineMs)}`, 'invalid_deadline')
  }
  const started = timer()
  let timerHandle = null
  const deadline = new Promise((resolve) => {
    timerHandle = setTimeout(() => resolve(Object.freeze({ timedOut: true })), deadlineMs)
    if (typeof timerHandle.unref === 'function') timerHandle.unref()
  })
  try {
    const value = await Promise.race([Promise.resolve().then(fn), deadline])
    const ms = timer() - started
    if (value && value.timedOut === true) {
      return Object.freeze({
        outcome: STEP_STATUS.TIMED_OUT,
        value: null,
        ms,
        abandoned: true,
        note: `the deadline of ${deadlineMs} ms passed; the work was not interrupted and may still be running`,
      })
    }
    return Object.freeze({ outcome: STEP_STATUS.COMPLETE, value, ms, abandoned: false, note: null })
  } finally {
    clearTimeout(timerHandle)
  }
}

/** Deep equality by canonical form: the default check between two implementations. */
export function sameResult(a, b) {
  return canonical(a) === canonical(b)
}

export class AdaptiveRunner {
  #loop
  #registry
  #checkpoints
  #now
  #timer
  #progress

  /**
   * @param {object} options
   * @param {object} options.loop         an AdaptiveLoop (routing, verification, episodes)
   * @param {object} options.registry     a CapabilityRegistry
   * @param {object} options.checkpoints  a CheckpointStore
   * @param {() => number} [options.now]
   * @param {() => number} [options.timer]
   * @param {(event: object) => void} [options.onProgress]
   */
  constructor({ loop, registry, checkpoints, now = () => Date.now(), timer = () => performance.now(), onProgress = () => {} } = {}) {
    if (!loop) throw new RunnerError('the runner needs an AdaptiveLoop for routing and verification', 'no_loop')
    if (!registry) throw new RunnerError('the runner needs a capability registry', 'no_registry')
    if (!checkpoints) throw new RunnerError('the runner needs a checkpoint store, or a resumed run is a fresh run with the same name', 'no_checkpoints')
    this.#loop = loop
    this.#registry = registry
    this.#checkpoints = checkpoints
    this.#now = now
    this.#timer = timer
    this.#progress = onProgress
  }

  get checkpoints() {
    return this.#checkpoints
  }

  /**
   * Run a plan. `verifiers` may name a capability whose verification is specific (`tree.line-count`
   * has one in verify.mjs); anything else is verified by recomputing with an independent
   * implementation and comparing results, which is the general case.
   */
  run({
    runId,
    plan,
    task = {},
    limits = {},
    verifiers = {},
    acceptance = null,
    candidates = null,
    startedAt = null,
    inheritedSteps = [],
    resumedFrom = null,
    carriedUsage = null,
    limitsReplaced = null,
  }) {
    if (!plan?.digest) throw new RunnerError('a run needs a planned task with a digest', 'no_plan')
    const budget = new Budget(limits, { used: carriedUsage })
    const steps = []
    const replayed = []
    const skipped = []
    const alreadyDone = new Set(
      inheritedSteps.filter((step) => step.status === STEP_STATUS.COMPLETE && step.verified === true).map((step) => step.id),
    )

    const save = (state, note) => this.#checkpoints.save({
      runId,
      state,
      planId: task.id ?? null,
      planDigest: plan.digest,
      usage: budget.snapshot(),
      steps,
      note,
      at: new Date(this.#now()).toISOString(),
    })

    // Steps already complete and verified in an earlier attempt are inherited, not re-run.
    for (const step of plan.steps) {
      if (alreadyDone.has(step.id)) {
        const previous = inheritedSteps.find((candidate) => candidate.id === step.id)
        steps.push({ ...previous, inherited: true })
        skipped.push(step.id)
      }
    }

    save(RUN_STATES.RUNNING, 'run started')

    let state = RUN_STATES.SUCCEEDED
    let note = null

    for (const stepId of plan.order) {
      const step = plan.steps.find((candidate) => candidate.id === stepId)
      if (alreadyDone.has(stepId)) continue

      const available = this.#registry.descriptorsFor(step.capability)
      if (!available.length) {
        if (step.optional) {
          steps.push({ id: step.id, status: STEP_STATUS.SKIPPED, verified: false, detail: `nothing implements ${step.capability}` })
          skipped.push(step.id)
          this.#emit('step_skipped', { runId, stepId: step.id, capability: step.capability })
          save(RUN_STATES.RUNNING, `step ${step.id} skipped: no implementation`)
          continue
        }
        // planSteps refuses this at plan time; reaching it means the registry changed since.
        steps.push({ id: step.id, status: STEP_STATUS.FAILED, verified: false, detail: `nothing implements ${step.capability}` })
        state = RUN_OUTCOMES.FAILED
        note = `step ${step.id} needs ${step.capability}, which is no longer installed`
        break
      }

      const pool = candidates ? candidates.filter((c) => available.some((d) => d.id === c.id)) : available
      const withCost = this.#withMeasuredCosts(pool, task, step)
      const chosen = this.#pick(withCost, step)

      // Gate before starting: a step whose measurement does not fit what is left is refused
      // rather than started and then regretted.
      try {
        budget.assertCanStart({ ...estimateFor({ descriptor: chosen }), steps: 1, calls: 1 })
      } catch (error) {
        for (const pending of plan.order) {
          if (!steps.some((recorded) => recorded.id === pending)) {
            const pendingStep = plan.steps.find((candidate) => candidate.id === pending)
            if (alreadyDone.has(pending)) continue
            steps.push({
              id: pending,
              status: STEP_STATUS.NOT_ATTEMPTED,
              verified: false,
              optional: pendingStep?.optional === true,
              detail: 'the run stopped at a budget limit before this step',
            })
          }
        }
        state = RUN_STATES.PARTIAL
        note = `${error.message} -- steps after ${step.id} were not attempted`
        this.#emit('budget_stopped', { runId, stepId: step.id, over: error.detail?.over ?? [] })
        break
      }

      const outcome = this.#runStep({ step, chosen, task, verifiers, budget, limitsForStep: limits.stepDeadlineMs ?? null })
      steps.push({ id: step.id, ...outcome })
      replayed.push(step.id)
      this.#emit('step_completed', { runId, stepId: step.id, status: outcome.status })

      if (outcome.status === STEP_STATUS.COMPLETE && outcome.overDeadline) {
        state = RUN_STATES.PARTIAL
        note = `step ${step.id}: ${outcome.detail}`
        save(RUN_STATES.PARTIAL, note)
        continue
      }
      if (outcome.status !== STEP_STATUS.COMPLETE) {
        state = outcome.status === STEP_STATUS.TIMED_OUT ? RUN_STATES.PARTIAL : RUN_OUTCOMES.FAILED
        note = `step ${step.id}: ${outcome.detail}`
        for (const pending of plan.order) {
          if (!steps.some((recorded) => recorded.id === pending)) {
            if (alreadyDone.has(pending)) continue
            steps.push({ id: pending, status: STEP_STATUS.NOT_ATTEMPTED, verified: false, detail: 'the run stopped at this step' })
          }
        }
        break
      }
      save(RUN_STATES.RUNNING, `step ${step.id} complete and verified`)
    }

    if (state === RUN_STATES.SUCCEEDED && steps.some((step) => step.status === STEP_STATUS.NOT_ATTEMPTED || step.status === STEP_STATUS.SKIPPED)) {
      state = RUN_STATES.PARTIAL
      note ??= 'the plan ran to the end with steps skipped or not attempted'
    }
    save(state, note ?? 'run finished')

    const complete = steps.filter((step) => step.status === STEP_STATUS.COMPLETE)
    return Object.freeze({
      runId,
      planId: task.id ?? null,
      planDigest: plan.digest,
      outcome: state,
      because: note,
      steps: Object.freeze(steps),
      replayed: Object.freeze(replayed),
      skipped: Object.freeze(skipped),
      resumedFrom,
      limitsReplaced: limitsReplaced ?? false,
      resumedAt: new Date(this.#now()).toISOString(),
      budget: budget.snapshot(),
      completedCount: complete.length,
      totalSteps: plan.steps.length,
      // The result is whatever the surviving step results say, assembled rather than summarised.
      result: Object.freeze(complete.map((step) => ({ step: step.id, result: step.result ?? null }))),
      acceptance: acceptance ? acceptance(steps) : null,
      startedAt,
    })
  }

  /**
   * Resume a run from its newest intact checkpoint. The plan must be the checkpointed one.
   */
  resume({ runId, plan, task = {}, limits = {}, verifiers = {}, acceptance = null, candidates = null }) {
    const resumed = this.#checkpoints.resume(runId, { planDigest: plan.digest })
    const inheritedSteps = resumed.record.steps
    this.#emit('resumed', { runId, from: resumed.record.seq, skipped: inheritedSteps.filter((s) => s.status === 'complete').length })
    const previous = resumed.record.usage
    // The original limits, not what was left of them: the resumed attempt carries the spend of
    // the earlier ones, so the *run's* budget stays what it always was. New limits are allowed
    // (a person may deliberately give a stuck run more room) and the report says which happened.
    const replacedLimits = Object.keys(limits).length > 0
    return this.run({
      runId,
      plan,
      task,
      limits: replacedLimits ? limits : (previous?.limits ?? {}),
      verifiers,
      acceptance,
      candidates,
      inheritedSteps,
      carriedUsage: previous?.usage ?? null,
      resumedFrom: resumed.record.seq,
      limitsReplaced: replacedLimits,
    })
  }

  /** Executed-with-a-deadline, verified-with-a-counterpart, and charged. */
  #runStep({ step, chosen, task, verifiers, budget, limitsForStep = null }) {
    const invocation = { ...task, capability: step.capability, operation: step.operation, step: step.id }
    const invocationStarted = timeInvocation(() => chosen.invoke({ ...invocation, detail: true }), this.#timer)

    // The result of the invocation is captured by the timer wrapper; for a step whose executor
    // is asynchronous the wrapper returns a promise and the value is resolved by the caller's
    // own await, so a promise here is reported rather than silently compared as an object.
    if (invocationStarted.value && typeof invocationStarted.value.then === 'function') {
      return {
        status: STEP_STATUS.FAILED,
        verified: false,
        detail: `'${chosen.id}' returned a promise; this runner drives synchronous steps, so an async executor must be awaited by its own tool layer`,
        durationMs: invocationStarted.ms,
      }
    }

    const result = invocationStarted.value
    const ms = invocationStarted.ms
    const charge = budget.charge({ steps: 1, calls: 1, ms, tokens: null, source: 'measured', note: step.id })

    // Verification: a capability-specific verifier when the caller named one, otherwise the
    // generic recomputation against an implementation that is not the one that ran.
    const counterpart = this.#counterpartFor(step, chosen)
    let verification
    if (verifiers[step.capability]) {
      verification = verifiers[step.capability]({ chosen, counterpart, invocation, result })
    } else if (counterpart) {
      const second = timeInvocation(() => counterpart.invoke({ ...invocation, detail: true }), this.#timer)
      const agree = sameResult(second.value, result)
      verification = Object.freeze({
        checked: true,
        agree,
        reason: agree
          ? 'two independent implementations agree'
          : `'${chosen.id}' and '${counterpart.id}' disagree on the same input`,
        methods: Object.freeze([
          Object.freeze({ name: chosen.id, role: 'executor under test', ms }),
          Object.freeze({ name: counterpart.id, role: 'independent recomputation', ms: second.ms }),
        ]),
      })
      budget.charge({ steps: 0, calls: 1, ms: second.ms, tokens: null, source: 'measured', note: `${step.id} verification` })
    } else {
      verification = Object.freeze({
        checked: false,
        agree: false,
        reason: 'no independent implementation is installed for this capability, so the result is unverified',
        methods: Object.freeze([]),
      })
    }

    if (!verification.agree) {
      return { status: STEP_STATUS.FAILED, verified: false, outcome: 'failed', result: null, verification, durationMs: ms, detail: verification.reason }
    }

    // The deadline is checked *after* the step, because this is a synchronous call and there is
    // no honest way to check it during. The overrun is reported rather than swallowed: the step
    // completed, and the run stops being a clean success the moment it did not fit the bound.
    const deadline = step.deadlineMs ?? limitsForStep
    const overDeadline = Number.isFinite(deadline) && ms > deadline
    return {
      status: STEP_STATUS.COMPLETE,
      verified: true,
      outcome: 'success',
      result: stripDetail(result),
      verification,
      durationMs: ms,
      overDeadline,
      detail: overDeadline
        ? `took ${ms} ms against a ${deadline} ms deadline; a synchronous step cannot be interrupted, so it was allowed to finish and is reported as over deadline`
        : null,
      charged: charge.tokensUnreported ? 'no token count was reported by this step' : null,
    }
  }

  /** The cheapest measured candidate, or the only one; never a silent alphabetical pick. */
  #pick(candidates, step) {
    if (candidates.length === 1) return candidates[0]
    const measured = candidates.filter((c) => c.cost?.measured)
    if (measured.length) {
      return measured.reduce((best, candidate) =>
        candidate.cost.measured.medianMs < best.cost.measured.medianMs ? candidate : best)
    }
    return candidates.find((candidate) => candidate.id === step.expected.preferredId) ?? candidates[0]
  }

  #counterpartFor(step, chosen) {
    const pool = this.#registry.descriptorsFor(step.capability)
    return pool.find((candidate) => candidate.id !== chosen.id && candidate.implementation !== chosen.implementation) ?? null
  }

  /** Attach any measurement the loop already took for this input to the descriptors. */
  #withMeasuredCosts(candidates, task, step) {
    const input = `${task.root}:${(task.extensions ?? []).join(',')}`
    return candidates.map((candidate) => this.#loop.measurements.get(`${candidate.id}@${input}`) ?? candidate)
  }

  #emit(type, payload) {
    this.#progress(Object.freeze({ type, at: new Date(this.#now()).toISOString(), ...payload }))
  }
}

/** Detail-mode fields are for the caller that asked; a recorded result does not need them. */
function stripDetail(result) {
  if (!result || typeof result !== 'object') return result
  const { detail, ...rest } = result
  return rest
}

export { LoopError }
