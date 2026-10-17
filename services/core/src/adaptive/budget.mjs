// Budgets: bounding a run by steps, calls, wall time and tokens -- and being honest about
// which of those was actually measured.
//
// The load-bearing decision in this module is what to do when a step does not report its
// token use. The tempting answer is to estimate it and carry on, which turns a limit into a
// guess that reads like a measurement. The answer here: the charge is recorded as
// `tokens: null`, `tokensUnreported` counts it, and `remainingTokens` is reported as an upper
// bound with `tokensExact: false`. A caller that needs a hard guarantee has to supply
// measurements, and `snapshot()` distinguishes the two cases instead of averaging them.
//
// Time is read through an injectable clock for the same reason the loop's timer is: a budget
// whose behaviour can only be observed by waiting is a budget nobody tests.
//
// `assertCanStart` is the part that actually bounds anything. Measuring a step after it ran
// tells you what it cost; refusing to start one whose *measured* cost on this input exceeds
// what is left is what stops a run from being over budget at the moment it matters. A step
// with no measurement is admitted (it may be the first run of anything) and recorded as
// admitted-without-a-measurement, so the report never implies a check that did not happen.

export class BudgetExhausted extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'BudgetExhausted'
    this.code = 'budget_exhausted'
    this.detail = detail
  }
}

export const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 12,
  maxCalls: 20,
  maxWallMs: 300_000,
  maxTokens: null, // null means "this installation does not bound tokens", which is not the same as zero
  // Per-step bound, checked after a synchronous step and enforced as a race for an asynchronous
  // one. null means each step is bounded only by the run's wall budget.
  stepDeadlineMs: null,
})

export class Budget {
  #limits
  #usage = { steps: 0, calls: 0, wallMs: 0, tokens: 0 }
  #charges = []
  #clock

  /**
   * `used` carries spend from an earlier attempt of the same run. A resumed run starts with a
   * limit, not a fresh allowance: passing the *remaining* figure as the new limit looks
   * equivalent and is not, because the resumed attempt then charges nothing for what the first
   * attempt already spent -- and passing a full allowance means the run had no budget at all.
   */
  constructor(limits = {}, { clock = () => Date.now(), used = null } = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [key, value] of Object.entries(this.#limits)) {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new BudgetExhausted(`budget limit '${key}' must be a non-negative number or null`, { key, value })
      }
    }
    this.#clock = clock
    this.startedAt = clock()
    if (used) {
      this.#carried = Object.freeze({
        steps: used.steps ?? 0,
        calls: used.calls ?? 0,
        wallMs: used.wallMs ?? 0,
        tokens: used.tokens ?? 0,
        tokensUnreported: used.tokensUnreported ?? 0,
      })
      this.#usage.steps += this.#carried.steps
      this.#usage.calls += this.#carried.calls
      this.#usage.wallMs += this.#carried.wallMs
      this.#usage.tokens += this.#carried.tokens
      this.#unreported += this.#carried.tokensUnreported
    }
  }

  #carried = null

  /** Spend carried in from an earlier attempt, or null when this is the first one. */
  get carried() {
    return this.#carried
  }

  get limits() {
    return Object.freeze({ ...this.#limits })
  }

  get usage() {
    return Object.freeze({ ...this.#usage })
  }

  get charges() {
    return Object.freeze([...this.#charges])
  }

  get elapsedMs() {
    return this.#clock() - this.startedAt
  }

  /**
   * Would starting this work stay inside the limits? `estimate` may carry any of
   * `{ steps, calls, ms, tokens, measured }`. Nothing is charged.
   */
  check(estimate = {}) {
    const steps = estimate.steps ?? 0
    const calls = estimate.calls ?? 0
    const tokens = estimate.tokens ?? 0
    const ms = estimate.ms ?? 0
    const over = []
    const exceeds = (label, wouldBe, limit) => {
      if (limit === null || limit === undefined) return
      if (wouldBe > limit) over.push({ limit: label, wouldBe, allowed: limit, over: wouldBe - limit })
    }
    exceeds('maxSteps', this.#usage.steps + steps, this.#limits.maxSteps)
    exceeds('maxCalls', this.#usage.calls + calls, this.#limits.maxCalls)
    exceeds('maxTokens', this.#usage.tokens + tokens, this.#limits.maxTokens)
    exceeds('maxWallMs', this.elapsedMs + ms, this.#limits.maxWallMs)
    return Object.freeze({
      ok: over.length === 0,
      over: Object.freeze(over),
      measured: estimate.measured === true,
    })
  }

  /**
   * Refuse to start work the budget cannot cover. The message names the limit, what is left
   * and what was asked for, because "budget exceeded" without numbers cannot be acted on.
   */
  assertCanStart(estimate = {}) {
    const verdict = this.check(estimate)
    if (verdict.ok) return verdict
    const first = verdict.over[0]
    throw new BudgetExhausted(
      `refusing to start: ${first.limit} allows ${first.allowed}, ${first.over} beyond what would remain ` +
        `(already used ${this.#usage[first.limit.replace('max', '').toLowerCase()] ?? '?'}); ` +
        `${verdict.measured ? 'the estimate is a measurement of this exact input' : 'the estimate is declared, not measured'}`,
      { over: verdict.over, measured: verdict.measured, usage: this.usage },
    )
  }

  /**
   * Charge what happened. `source` says where the numbers came from, and a charge with no
   * token count is recorded as unreported rather than as zero.
   */
  charge({ steps = 0, calls = 0, ms = 0, tokens = null, source = 'declared', note = null } = {}) {
    if (tokens !== null && (typeof tokens !== 'number' || tokens < 0)) {
      throw new BudgetExhausted(`a token charge must be a non-negative number or null, got ${JSON.stringify(tokens)}`)
    }
    this.#usage.steps += steps
    this.#usage.calls += calls
    this.#usage.wallMs += ms
    if (tokens === null) this.#unreported += 1
    else this.#usage.tokens += tokens
    const record = Object.freeze({
      at: this.#clock(),
      steps, calls, ms, tokens,
      source,
      note,
      tokensUnreported: tokens === null,
    })
    this.#charges.push(record)
    return record
  }

  #unreported = 0

  /**
   * The state of the budget, with the difference between a measured total and a partial one
   * kept visible. `tokensExact` is false as soon as one charge had no token count, and
   * `remainingTokensAtMost` is an upper bound in that case -- not an estimate dressed as one.
   */
  snapshot() {
    const remaining = {
      steps: this.#limits.maxSteps === null ? null : this.#limits.maxSteps - this.#usage.steps,
      calls: this.#limits.maxCalls === null ? null : this.#limits.maxCalls - this.#usage.calls,
      wallMs: this.#limits.maxWallMs === null ? null : this.#limits.maxWallMs - this.elapsedMs,
      tokens: this.#limits.maxTokens === null ? null : this.#limits.maxTokens - this.#usage.tokens,
    }
    return Object.freeze({
      limits: this.limits,
      usage: this.usage,
      carried: this.#carried,
      remaining: Object.freeze(remaining),
      elapsedMs: this.elapsedMs,
      charges: this.charges.length,
      tokensUnreported: this.#unreported,
      tokensExact: this.#unreported === 0,
      remainingTokensAtMost: remaining.tokens,
      note: this.#unreported
        ? `${this.#unreported} charge(s) reported no token count; the token total is a lower bound and the remaining figure an upper bound`
        : 'every charge reported a token count',
    })
  }
}

/** The estimate a step carries: measured cost if it has one, declared expectation otherwise. */
export function estimateFor({ descriptor = null, expected = {} } = {}) {
  const measured = descriptor?.cost?.measured
  if (measured && Number.isFinite(measured.medianMs)) {
    return Object.freeze({ ms: measured.medianMs, calls: 1, measured: true })
  }
  return Object.freeze({ ms: expected.ms ?? 0, calls: 1, tokens: expected.tokens ?? 0, measured: false })
}
