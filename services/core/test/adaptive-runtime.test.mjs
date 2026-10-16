// Budgets, checkpoints and resumable runs. The test that matters most is the last one: a run is
// started, killed on purpose by a budget that cannot cover the second step, and resumed in a
// *fresh* process-shaped object that has nothing in memory -- only the checkpoint on disk. If
// that test passes, "resumable" means something.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Budget, BudgetExhausted, DEFAULT_LIMITS, estimateFor } from '../src/adaptive/budget.mjs'
import { CheckpointStore, RUN_STATES, verifyChain } from '../src/adaptive/checkpoint.mjs'
import { AdaptiveRunner, RUN_OUTCOMES, STEP_STATUS, sameResult } from '../src/adaptive/runner.mjs'
import { AdaptiveLoop } from '../src/adaptive/loop.mjs'
import { CapabilityRegistry, registryFrom } from '../src/adaptive/registry.mjs'
import { readIntent } from '../src/adaptive/intent.mjs'
import { planSteps } from '../src/adaptive/plan.mjs'
import { makeLineCountExecutors } from '../src/adaptive/executors.mjs'
import { SkillRegistry } from '../src/skills/registry.mjs'
import { EpisodeLog } from '../src/adaptive/episodes.mjs'

const cleanup = []
test.after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }) })

const SMALL = { 'a.mjs': 'one\ntwo\nthree\n', 'b.mjs': 'four\nfive\n', 'c.md': 'not counted\n' }
const smallLines = 5

function makeTree(name, files = SMALL) {
  const root = mkdtempSync(join(tmpdir(), `adaptive-runtime-${name}-`))
  for (const [relative, content] of Object.entries(files)) writeFileSync(join(root, relative), content, 'utf8')
  cleanup.push(root)
  return root
}

function harness(options = {}) {
  const root = makeTree(options.name ?? 'tree')
  const { materialise, stream } = makeLineCountExecutors({ roots: [root] })
  const registry = registryFrom([materialise, stream])
  const loop = new AdaptiveLoop({
    registry: new SkillRegistry({ now: () => 1_700_000_000_000 }),
    episodes: new EpisodeLog(':memory:'),
    samples: options.samples ?? 3,
  })
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-checkpoints-'))
  cleanup.push(dir)
  const checkpoints = new CheckpointStore(dir, { clock: () => 1_700_000_000_000 })
  const runner = new AdaptiveRunner({ loop, registry, checkpoints, now: () => 1_700_000_000_000, onProgress: options.onProgress ?? (() => {}) })
  const task = { id: options.taskId ?? 'count-lines', root, extensions: ['.mjs'] }
  const intent = readIntent({ utterance: 'count the lines under the tree' })
  const plan = (budget = {}, steps = null) => planSteps({
    intent,
    registry,
    budget,
    steps: steps ?? [{ id: 'count', capability: 'tree.line-count', operation: 'count', expected: { preferredId: 'line-count-stream' } }],
  })
  return { root, registry, loop, checkpoints, runner, task, plan, materialise, stream }
}

const acceptance = (lines) => ({ checks: [{ name: 'line total', metric: 'lines', op: '==', value: lines }] })

// --- budgets ---------------------------------------------------------------------

test('the budget refuses to start work it cannot cover, and names the limit', () => {
  const budget = new Budget({ maxSteps: 2, maxCalls: 2, maxWallMs: 1000, maxTokens: 100 })
  assert.equal(budget.check({ steps: 1, calls: 1 }).ok, true)
  budget.charge({ steps: 1, calls: 1, ms: 10, tokens: 40, source: 'measured' })
  assert.equal(budget.check({ steps: 2, calls: 1 }).ok, false)
  assert.throws(() => budget.assertCanStart({ steps: 2, calls: 1 }), (error) => {
    assert.equal(error.code, 'budget_exhausted')
    assert.match(error.message, /maxSteps allows 2, 1 beyond what would remain/)
    assert.match(error.message, /declared, not measured/)
    return true
  })
  assert.equal(budget.check({ steps: 1, calls: 1, tokens: 60 }).ok, true)
  assert.equal(budget.check({ steps: 1, calls: 1, tokens: 61 }).ok, false, '61 + 40 is over the token limit')
  assert.deepEqual(budget.usage, { steps: 1, calls: 1, wallMs: 10, tokens: 40 })
})

test('a charge with no token count is unreported, not zero', () => {
  const budget = new Budget({ maxTokens: 100 })
  budget.charge({ steps: 1, calls: 1, ms: 5, tokens: 10, source: 'measured' })
  budget.charge({ steps: 1, calls: 1, ms: 5, tokens: null, source: 'measured', note: 'the executor reported nothing' })
  const snapshot = budget.snapshot()
  assert.equal(snapshot.usage.tokens, 10, 'the unreported charge must not be counted as a measurement')
  assert.equal(snapshot.tokensExact, false)
  assert.equal(snapshot.tokensUnreported, 1)
  assert.match(snapshot.note, /1 charge\(s\) reported no token count/)
  assert.equal(snapshot.remainingTokensAtMost, 90, 'and the remaining figure is an upper bound')
  // An exact total stays exact.
  const clean = new Budget({ maxTokens: 100 })
  clean.charge({ steps: 1, calls: 1, ms: 5, tokens: 10, source: 'measured' })
  assert.equal(clean.snapshot().tokensExact, true)
  assert.equal(clean.snapshot().note, 'every charge reported a token count')
  assert.throws(() => clean.charge({ tokens: -1 }), (error) => error.code === 'budget_exhausted')
})

test('a null limit means unbounded here, which is not the same as zero', () => {
  const budget = new Budget({ maxTokens: null })
  budget.charge({ calls: 1, tokens: 10_000_000, source: 'measured' })
  const snapshot = budget.snapshot()
  assert.equal(snapshot.remaining.tokens, null)
  assert.equal(snapshot.limits.maxTokens, null)
  assert.equal(DEFAULT_LIMITS.maxTokens, null)
  assert.equal(snapshot.remaining.steps, DEFAULT_LIMITS.maxSteps)
  assert.throws(() => new Budget({ maxSteps: 'many' }), (error) => error.code === 'budget_exhausted')
  assert.throws(() => new Budget({ maxWallMs: -5 }), (error) => error.code === 'budget_exhausted')
})

test('an estimate is a measurement when the descriptor carries one, and says so when it does not', () => {
  const measured = estimateFor({ descriptor: { cost: { measured: { medianMs: 12.5 } } } })
  assert.deepEqual(measured, { ms: 12.5, calls: 1, measured: true })
  const declared = estimateFor({ expected: { ms: 3, tokens: 9 } })
  assert.equal(declared.measured, false)
  assert.equal(declared.ms, 3)
  const nothing = estimateFor({})
  assert.deepEqual(nothing, { ms: 0, calls: 1, tokens: 0, measured: false })
})

// --- checkpoints ------------------------------------------------------------------

test('every checkpoint is chained to the one before it, and a broken chain is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-chain-')); cleanup.push(dir)
  const store = new CheckpointStore(dir, { clock: () => 1_700_000_000_000 })
  const first = store.save({ runId: 'run-alpha', state: RUN_STATES.RUNNING, planDigest: 'a'.repeat(64), steps: [] })
  const second = store.save({ runId: 'run-alpha', state: RUN_STATES.SUCCEEDED, planDigest: 'a'.repeat(64), steps: [{ id: 'count', status: 'complete', verified: true }] })
  assert.equal(first.prevDigest, null)
  assert.equal(second.prevDigest, first.digest)
  assert.equal(store.history('run-alpha').length, 2)
  assert.equal(store.latest('run-alpha').intact, true)
  assert.equal(store.progress('run-alpha').completedCount, 1)
  assert.equal(store.progress('run-alpha').state, RUN_STATES.SUCCEEDED)

  // Edit the second record on disk: reading it is still allowed -- the edit is the finding --
  // and the chain reports where it broke.
  const path = join(dir, 'run-alpha', '000001.json')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, `${JSON.stringify({ ...record, note: 'edited after the fact' })}\n`, 'utf8')
  const latest = store.latest('run-alpha')
  assert.equal(latest.intact, false)
  assert.equal(latest.brokenAt, 1)
  assert.match(latest.reason, /has been modified since it was written/)
  assert.equal(latest.record.note, 'edited after the fact', 'the tampered record is readable: reporting it beats deleting it')
  assert.equal(verifyChain(store.history('run-alpha')).ok, false)
})

test('checksums are not required to trust a checkpoint, but a torn write is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-torn-')); cleanup.push(dir)
  const store = new CheckpointStore(dir)
  store.save({ runId: 'run-beta', state: RUN_STATES.RUNNING, planDigest: 'b'.repeat(64), steps: [] })
  // Exactly what a crash mid-write leaves behind: a .tmp that was never renamed.
  writeFileSync(join(dir, 'run-beta', '.000001.json.tmp'), '{"runId":"run-beta","seq":1,"stat', 'utf8')
  const latest = store.latest('run-beta')
  assert.equal(latest.count, 1, 'the incomplete write is not a record')
  assert.equal(latest.record.seq, 0)
  assert.deepEqual(latest.skipped.map((entry) => entry.file), ['.000001.json.tmp'])
  assert.equal(latest.skipped[0].reason, 'write did not complete')
  assert.equal(latest.intact, true)
  // A save after that writes sequence 1, not sequence 2: the temp file never counted as a record.
  const next = store.save({ runId: 'run-beta', state: RUN_STATES.SUCCEEDED, planDigest: 'b'.repeat(64), steps: [] })
  assert.equal(next.seq, 1)
  assert.deepEqual(store.runs(), ['run-beta'])
  assert.throws(() => store.save({ runId: 'Run Beta', state: RUN_STATES.RUNNING, planDigest: 'x' }), (error) => error.code === 'invalid_run_id')
  assert.throws(() => store.save({ runId: 'run-beta', state: 'finished' }), (error) => error.code === 'invalid_state')
  assert.throws(() => store.save({ runId: 'run-beta', state: RUN_STATES.RUNNING }), (error) => error.code === 'missing_plan_digest')
})

test('resuming against a different plan is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-mismatch-')); cleanup.push(dir)
  const store = new CheckpointStore(dir)
  store.save({ runId: 'run-gamma', state: RUN_STATES.PARTIAL, planDigest: 'c'.repeat(64), steps: [] })
  assert.equal(store.resume('run-gamma', { planDigest: 'c'.repeat(64) }).record.seq, 0)
  assert.throws(() => store.resume('run-gamma', { planDigest: 'd'.repeat(64) }), (error) => {
    assert.equal(error.code, 'checkpoint_mismatch')
    assert.match(error.message, /is not a resume/)
    return true
  })
  assert.throws(() => store.resume('run-missing', { planDigest: 'c'.repeat(64) }), (error) => error.code === 'no_checkpoint')
})

// --- the runner --------------------------------------------------------------------

test('a plan runs step by step, is verified at every step, charged, and checkpointed after each', () => {
  const { loop, registry, plan, task, checkpoints } = harness({ name: 'run', taskId: 'count-two' })
  const events = []
  const withEvents = new AdaptiveRunner({
    loop, registry, checkpoints,
    now: () => 1_700_000_000_000, onProgress: (event) => events.push(event),
  })
  const result = withEvents.run({ runId: 'run-delta', plan: plan(), task })
  assert.equal(result.outcome, RUN_OUTCOMES.SUCCEEDED)
  assert.equal(result.completedCount, 1)
  assert.equal(result.steps[0].status, STEP_STATUS.COMPLETE)
  assert.equal(result.steps[0].verified, true)
  assert.equal(result.steps[0].result.lines, smallLines)
  assert.equal(result.steps[0].verification.agree, true)
  assert.equal(result.steps[0].verification.methods.length, 2, 'a step is verified by a second implementation')
  assert.equal(result.steps[0].charged, 'no token count was reported by this step', 'the executors report no tokens, and the step says so')
  assert.equal(result.budget.tokensExact, false)
  assert.equal(result.result[0].result.lines, smallLines)
  assert.deepEqual(result.replayed, ['count'])
  assert.equal(checkpoints.progress('run-delta').state, RUN_STATES.SUCCEEDED)
  assert.equal(checkpoints.history('run-delta').length, 3, 'started, one per step, finished')
  assert.ok(events.some((event) => event.type === 'step_completed'))
  assert.equal(result.budget.usage.steps, 1)
  assert.equal(result.budget.usage.calls, 2, 'the executor and its verifier are both calls')
})

test('a step whose result is not verified is a failure, and the run stops there', () => {
  const { root } = harness({ name: 'liar' })
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-liar-')); cleanup.push(dir)
  const lying = {
    id: 'line-count-liar', kind: 'tool', provides: ['tree.line-count'], implementation: 'liar',
    permissions: { fsRead: [root], fsWrite: [], network: false },
    invoke: () => ({ lines: 999, files: 3, bytes: 30 }),
  }
  const honest = {
    id: 'line-count-honest', kind: 'tool', provides: ['tree.line-count'], implementation: 'honest',
    permissions: { fsRead: [root], fsWrite: [], network: false },
    invoke: () => ({ lines: smallLines, files: 3, bytes: 30 }),
  }
  const registry = registryFrom([lying, honest])
  const loop = new AdaptiveLoop({ registry: new SkillRegistry({}), episodes: new EpisodeLog(':memory:') })
  const runner = new AdaptiveRunner({ loop, registry, checkpoints: new CheckpointStore(dir) })
  const intent = readIntent({ utterance: 'count the lines' })
  const plan = planSteps({ intent, registry, steps: [{ id: 'count', capability: 'tree.line-count', expected: { preferredId: 'line-count-liar' } }] })
  const result = runner.run({ runId: 'run-liar', plan, task: { id: 'liar', root, extensions: ['.mjs'] }, candidates: [lying, honest] })
  assert.equal(result.outcome, RUN_OUTCOMES.FAILED)
  assert.equal(result.steps[0].status, STEP_STATUS.FAILED)
  assert.match(result.steps[0].detail, /disagree on the same input/)
  assert.equal(result.completedCount, 0)
})

test('a step that overruns its budget stops the run with the remaining steps recorded as not attempted', () => {
  const { runner, plan, task } = harness({ name: 'budget' })
  const result = runner.run({
    runId: 'run-epsilon',
    plan: plan({}, [
      { id: 'first', capability: 'tree.line-count' },
      { id: 'second', capability: 'tree.line-count', dependsOn: ['first'] },
    ]),
    task,
    limits: { maxSteps: 1, maxCalls: 10 },
  })
  assert.equal(result.outcome, RUN_OUTCOMES.PARTIAL)
  assert.equal(result.steps.find((step) => step.id === 'first')?.status, STEP_STATUS.COMPLETE)
  assert.equal(result.steps.find((step) => step.id === 'second')?.status, STEP_STATUS.NOT_ATTEMPTED)
  assert.match(result.because, /steps after second were not attempted|not attempted/)
  assert.equal(result.completedCount, 1)
  assert.equal(result.totalSteps, 2)
})

test('an optional step with nothing installed is skipped and does not fail the run', () => {
  const { runner, plan, task, registry } = harness({ name: 'optional' })
  // Registered after the plan was built, so the plan's optional-missing list is honest.
  const intent = readIntent({ utterance: 'count the lines' })
  const planned = planSteps({
    intent,
    registry,
    steps: [
      { id: 'count', capability: 'tree.line-count' },
      { id: 'diff', capability: 'tree.semantic-diff', optional: true },
    ],
  })
  const result = runner.run({ runId: 'run-zeta', plan: planned, task })
  assert.equal(result.outcome, RUN_OUTCOMES.PARTIAL)
  assert.equal(result.steps.find((step) => step.id === 'diff').status, STEP_STATUS.SKIPPED)
  assert.equal(result.steps.find((step) => step.id === 'count').status, STEP_STATUS.COMPLETE)
  assert.deepEqual(result.skipped, ['diff'])
  assert.ok(plan().digest)
})

// --- the test this file exists for --------------------------------------------------

test('a run that stopped at its budget resumes from the checkpoint in a fresh object and finishes', () => {
  const { root, runner, plan, task, checkpoints, materialise, stream } = harness({ name: 'resume' })
  const intent = readIntent({ utterance: 'count the lines under the tree' })
  const twoStep = (budget) => planSteps({
    intent,
    registry: registryFrom([materialise, stream]),
    budget,
    steps: [
      { id: 'first', capability: 'tree.line-count', expected: { preferredId: 'line-count-stream' } },
      { id: 'second', capability: 'tree.line-count', dependsOn: ['first'], expected: { preferredId: 'line-count-stream' } },
    ],
  })

  const firstAttempt = runner.run({
    runId: 'run-resume',
    plan: twoStep({ maxSteps: 2 }),
    task,
    limits: { maxSteps: 1, maxCalls: 10 },
  })
  assert.equal(firstAttempt.outcome, RUN_OUTCOMES.PARTIAL)
  assert.deepEqual(firstAttempt.replayed, ['first'], 'only the step that fitted the budget ran')
  assert.equal(firstAttempt.steps.find((step) => step.id === 'second').status, STEP_STATUS.NOT_ATTEMPTED)

  // A fresh runner and a fresh loop: nothing in memory from the first attempt. The only state
  // carried across is the checkpoint directory.
  const freshDir = checkpoints.dir
  const store = new CheckpointStore(freshDir)
  const lastSeq = store.latest('run-resume').record.seq
  assert.equal(lastSeq, 2, 'started, step one, and the partial state that stopped the run')
  const fresh = new AdaptiveRunner({
    loop: new AdaptiveLoop({ registry: new SkillRegistry({}), episodes: new EpisodeLog(':memory:'), samples: 3 }),
    registry: registryFrom([materialise, stream]),
    checkpoints: store,
    now: () => 1_700_000_000_200,
  })
  const resumed = fresh.resume({ runId: 'run-resume', plan: twoStep({ maxSteps: 2 }), task, limits: { maxSteps: 5, maxCalls: 10 } })
  assert.equal(resumed.resumedFrom, lastSeq, 'the resume named the checkpoint it continued from')
  assert.equal(resumed.outcome, RUN_OUTCOMES.SUCCEEDED)
  assert.deepEqual(resumed.replayed, ['second'], 'the completed step was not re-run')
  assert.deepEqual(resumed.skipped, ['first'], 'and it is reported as inherited, not as work done now')
  assert.equal(resumed.steps.find((step) => step.id === 'first').inherited, true)
  assert.equal(resumed.completedCount, 2)
  assert.equal(resumed.result.length, 2)
  assert.equal(resumed.limitsReplaced, true, 'this resume was given new limits deliberately')
  assert.equal(resumed.budget.carried.steps, 1, 'and it carries what the earlier attempt spent, so the run has one budget')

  // Resuming against a different plan is refused, so progress cannot be transplanted.
  const other = planSteps({
    intent,
    registry: registryFrom([materialise, stream]),
    steps: [{ id: 'first', capability: 'tree.line-count', operation: 'different operation' }],
  })
  assert.throws(() => fresh.resume({ runId: 'run-resume', plan: other, task }), (error) => {
    assert.equal(error.code, 'checkpoint_mismatch')
    return true
  })
  assert.equal(sameResult({ lines: 1 }, { lines: 1 }), true)
  assert.equal(sameResult({ lines: 1 }, { lines: 2 }), false)
  assert.equal(sameResult({ a: 1, b: 2 }, { b: 2, a: 1 }), true, 'key order is not a disagreement')
})

test('a resumed run carries the earlier spend, so the run has one budget rather than several', () => {
  const { runner, plan, task, checkpoints, loop, registry } = harness({ name: 'inherit' })
  // A run that spends its whole step allowance on the first step and stops.
  const stopped = runner.run({
    runId: 'run-eta',
    plan: plan({}, [
      { id: 'first', capability: 'tree.line-count' },
      { id: 'second', capability: 'tree.line-count', dependsOn: ['first'] },
    ]),
    task,
    limits: { maxSteps: 1, maxCalls: 6 },
  })
  assert.equal(stopped.outcome, RUN_OUTCOMES.PARTIAL)
  const stored = checkpoints.latest('run-eta').record.usage
  assert.equal(stored.usage.steps, 1)
  assert.equal(stored.remaining.calls, 4, 'two calls were spent: the step and its verifier')
  assert.equal(stored.tokensExact, false, 'the executors report no token counts, and the budget says so')

  // Resuming with no new limits inherits the original ones and the spend against them: the
  // remaining work still does not fit, and the run says so instead of quietly finding room.
  const sameRoom = new AdaptiveRunner({ loop, registry, checkpoints: new CheckpointStore(checkpoints.dir) })
  const again = sameRoom.resume({
    runId: 'run-eta',
    plan: plan({}, [
      { id: 'first', capability: 'tree.line-count' },
      { id: 'second', capability: 'tree.line-count', dependsOn: ['first'] },
    ]),
    task,
  })
  assert.equal(again.outcome, RUN_OUTCOMES.PARTIAL)
  assert.match(again.because, /maxSteps allows 1/)
  assert.equal(again.limitsReplaced, false)
  assert.equal(again.steps.find((step) => step.id === 'second').status, STEP_STATUS.NOT_ATTEMPTED)
  assert.equal(again.steps.find((step) => step.id === 'first').inherited, true, 'the completed step is still inherited')
})

test('the runner refuses to exist without the parts that make a run mean something', () => {
  const { loop, registry, checkpoints } = harness({ name: 'parts' })
  assert.throws(() => new AdaptiveRunner({ registry, checkpoints }), (error) => error.code === 'no_loop')
  assert.throws(() => new AdaptiveRunner({ loop, checkpoints }), (error) => error.code === 'no_registry')
  assert.throws(() => new AdaptiveRunner({ loop, registry }), (error) => {
    assert.equal(error.code, 'no_checkpoints')
    assert.match(error.message, /a resumed run is a fresh run with the same name/)
    return true
  })
  assert.throws(() => loop.runTask({ id: 'x' }, { candidates: [], acceptance: null }), (error) => error.code === 'no_acceptance')
})

test('acceptance is evaluated over the recorded steps, and a failed step contributes no result', () => {
  const { runner, plan, task } = harness({ name: 'acceptance' })
  const passing = runner.run({
    runId: 'run-theta',
    plan: plan(),
    task,
    acceptance: (steps) => ({
      passed: steps.every((step) => step.status === STEP_STATUS.COMPLETE && step.result?.lines === smallLines),
      detail: `expected ${smallLines} lines from every step`,
    }),
  })
  assert.equal(passing.acceptance.passed, true)
  assert.equal(passing.result.length, 1)

  // The same run judged against the wrong expectation: the steps still ran and verified, and the
  // acceptance check says the answer is not the one that was asked for. Both facts are reported,
  // which is the difference between "the work failed" and "the result is wrong".
  const failing = runner.run({
    runId: 'run-iota',
    plan: plan(),
    task,
    acceptance: (steps) => ({
      passed: steps.every((step) => step.result?.lines === 999),
      detail: 'expected every step to report 999 lines',
    }),
  })
  assert.equal(failing.acceptance.passed, false)
  assert.equal(failing.steps[0].status, STEP_STATUS.COMPLETE)
  assert.equal(failing.steps[0].result.lines, smallLines)

  // And a step whose verification disagreed is not in `result` at all, so a caller reading the
  // results cannot find a number that nothing checked.
  const liar = {
    id: 'line-count-liar2', kind: 'tool', provides: ['tree.line-count'], implementation: 'liar',
    permissions: { fsRead: [task.root], fsWrite: [], network: false },
    invoke: () => ({ lines: 999, files: 3, bytes: 30 }),
  }
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-liar2-')); cleanup.push(dir)
  const liarRegistry = registryFrom([liar, makeLineCountExecutors({ roots: [task.root] }).materialise])
  const liarRunner = new AdaptiveRunner({
    loop: new AdaptiveLoop({ registry: new SkillRegistry({}), episodes: new EpisodeLog(':memory:') }),
    registry: liarRegistry,
    checkpoints: new CheckpointStore(dir),
  })
  const refused = liarRunner.run({
    runId: 'run-kappa',
    plan: planSteps({ intent: readIntent({ utterance: 'count the lines' }), registry: liarRegistry, steps: [{ id: 'count', capability: 'tree.line-count', expected: { preferredId: 'line-count-liar2' } }] }),
    task,
  })
  assert.equal(refused.outcome, RUN_OUTCOMES.FAILED)
  assert.deepEqual(refused.result, [], 'an unverified step produces no result, only an outcome and a reason')
})

// --- timeouts ---------------------------------------------------------------------

test('a synchronous step that overruns its deadline still finishes, and the run is no longer a clean success', () => {
  // There is no honest way to interrupt a synchronous call from JavaScript. The runner
  // therefore refuses to *start* a step whose measurement does not fit the wall budget, and
  // reports an overrun after the fact instead of claiming it stopped something.
  const root = makeTree('deadline', SMALL)
  const slow = {
    id: 'line-count-slow', kind: 'tool', provides: ['tree.line-count'], implementation: 'slow',
    permissions: { fsRead: [root], fsWrite: [], network: false },
    invoke: () => {
      const until = performance.now() + 25
      while (performance.now() < until) { /* a real overrun, not a mocked duration */ }
      return { lines: smallLines, files: 3, bytes: 30 }
    },
  }
  const fast = {
    id: 'line-count-fast', kind: 'tool', provides: ['tree.line-count'], implementation: 'fast',
    permissions: { fsRead: [root], fsWrite: [], network: false },
    invoke: () => ({ lines: smallLines, files: 3, bytes: 30 }),
  }
  const registry = registryFrom([slow, fast])
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-deadline-')); cleanup.push(dir)
  const runner = new AdaptiveRunner({
    loop: new AdaptiveLoop({ registry: new SkillRegistry({}), episodes: new EpisodeLog(':memory:') }),
    registry,
    checkpoints: new CheckpointStore(dir),
  })
  const plan = planSteps({
    intent: readIntent({ utterance: 'count the lines' }),
    registry,
    steps: [{ id: 'count', capability: 'tree.line-count', expected: { preferredId: 'line-count-slow' } }],
  })
  const result = runner.run({
    runId: 'run-deadline',
    plan,
    task: { id: 'deadline', root, extensions: ['.mjs'] },
    limits: { stepDeadlineMs: 5 },
  })
  const step = result.steps[0]
  assert.equal(step.status, STEP_STATUS.COMPLETE, 'the work did finish')
  assert.equal(step.verified, true, 'and it was still verified')
  assert.equal(step.overDeadline, true)
  assert.match(step.detail, /a synchronous step cannot be interrupted, so it was allowed to finish/)
  assert.equal(result.outcome, RUN_OUTCOMES.PARTIAL, 'a run with an over-deadline step is not a clean success')
  assert.ok(step.durationMs >= 20, 'the step really did take longer than the deadline it was given')
})

test('a deadline is a race when the work can be awaited, and abandoning the wait is stated', async () => {
  const { runWithinDeadline } = await import('../src/adaptive/runner.mjs')
  const quick = await runWithinDeadline(async () => 'answered', { deadlineMs: 500 })
  assert.equal(quick.outcome, STEP_STATUS.COMPLETE)
  assert.equal(quick.value, 'answered')
  assert.equal(quick.abandoned, false)

  let finished = false
  const slow = runWithinDeadline(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
    finished = true
    return 'too late'
  }, { deadlineMs: 10 })
  const timedOut = await slow
  assert.equal(timedOut.outcome, STEP_STATUS.TIMED_OUT)
  assert.equal(timedOut.abandoned, true)
  assert.match(timedOut.note, /was not interrupted and may still be running/)
  assert.equal(timedOut.value, null)
  // And the promise really did run to completion: the note is a fact, not a figure of speech.
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(finished, true, 'the abandoned work kept running, which is exactly what the note says')

  await assert.rejects(() => runWithinDeadline(async () => 1, { deadlineMs: -1 }), (error) => error.code === 'invalid_deadline')
})

test('the wall budget stops a step before it starts, and the gate uses a measurement when there is one', () => {
  const { runner, plan, task, loop, registry, materialise } = harness({ name: 'wallgate' })
  // A step with no measurement is gated on its declared estimate; a step that has been measured
  // is gated on what it actually cost here. The second case is the one that bounds anything.
  loop.measure({ candidates: [materialise], task, runs: 3 })
  const key = `${materialise.id}@${task.root}:${task.extensions.join(',')}`
  const measuredMs = loop.measurements.get(key).cost.measured.medianMs
  assert.ok(measuredMs >= 0)

  const beyond = runner.run({ runId: 'run-lambda', plan: plan(), task, limits: { maxWallMs: 0, maxCalls: 10, maxSteps: 10 } })
  assert.equal(beyond.outcome, RUN_OUTCOMES.PARTIAL)
  assert.match(beyond.because, /maxWallMs/)
  assert.equal(beyond.steps[0].status, STEP_STATUS.NOT_ATTEMPTED)
  assert.equal(beyond.completedCount, 0)
  assert.equal(beyond.budget.usage.steps, 0, 'a step that was refused costs nothing -- it never ran')

  // With room, the same plan runs: the refusal was about the budget, not about the work.
  const inside = runner.run({ runId: 'run-mu', plan: plan(), task, limits: { maxWallMs: 60_000, maxCalls: 10, maxSteps: 10 } })
  assert.equal(inside.outcome, RUN_OUTCOMES.SUCCEEDED)
  assert.equal(inside.steps[0].status, STEP_STATUS.COMPLETE)
  assert.ok(registry.describe().tags.includes('tree.line-count'))

  // And the refusal message states which kind of estimate it refused on.
  const budget = new Budget({ maxWallMs: 1 })
  assert.throws(() => budget.assertCanStart({ ms: 500, measured: true }), (error) => {
    assert.match(error.message, /the estimate is a measurement of this exact input/)
    return true
  })
  assert.throws(() => budget.assertCanStart({ ms: 500, measured: false }), (error) => {
    assert.match(error.message, /the estimate is declared, not measured/)
    return true
  })
})
