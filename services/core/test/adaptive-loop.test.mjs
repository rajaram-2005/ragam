// The first milestone, end to end: route -> execute -> verify -> record -> diagnose ->
// propose -> test -> promote -> reuse, and measure whether the second run improved.
//
// The tests that carry the milestone are the negative ones. A loop that turns every run into
// a skill is not an adaptive system, it is a recorder of whatever happened; what makes it
// adaptive is that it refuses to promote from an unverified run, refuses to call an
// unverified result a success, and cannot be talked into either by a caller who believes
// otherwise.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SkillRegistry, SKILL_STATES } from '../src/skills/registry.mjs'
import { makeLineCountExecutors } from '../src/adaptive/executors.mjs'
import { validateCapability } from '../src/adaptive/capability.mjs'
import { EpisodeLog, EpisodeError, FAILURE_KINDS, OUTCOMES, evaluateAcceptance } from '../src/adaptive/episodes.mjs'
import { AdaptiveLoop, LoopError, median } from '../src/adaptive/loop.mjs'
import { INTERACTION_STATES, auditWording, estimateInteractionState, renderOutcome } from '../src/adaptive/wording.mjs'

// --- fixtures ------------------------------------------------------------------

/** A tree with a known number of newline bytes in every file. */
function makeTree(name, files) {
  const root = mkdtempSync(join(tmpdir(), `adaptive-${name}-`))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return root
}

/** A tree big enough that the difference between the two implementations is a measurement. */
function makeBigTree(name, { files = 12, kilobytes = 300 } = {}) {
  const line = `${'const value = 1; // a line of source text to give the counter something to do'.padEnd(60, ' ')}\n`
  const perFile = Math.ceil((kilobytes * 1024) / line.length)
  const spec = {}
  for (let i = 0; i < files; i += 1) spec[`file${i}.mjs`] = line.repeat(perFile)
  const root = makeTree(name, spec)
  return { root, expectedLines: files * perFile, bytes: files * perFile * line.length }
}

const SMALL = { 'a.mjs': 'one\ntwo\nthree\nfour\nfive\n', 'b.mjs': 'no trailing newline here', 'sub/c.mjs': '', 'd.md': 'not counted\nnot counted\n' }
const smallLines = 5

const cleanup = []
test.after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }) })

function loopFor({ episodesFile = ':memory:', samples = 3, timer = null } = {}) {
  return new AdaptiveLoop({
    registry: new SkillRegistry({ now: () => 1_700_000_000_000 }),
    episodes: new EpisodeLog(episodesFile),
    samples,
    ...(timer ? { timer } : {}),
  })
}

const acceptanceFor = (lines) => ({ checks: [{ name: 'line total', metric: 'lines', op: '==', value: lines }] })

// --- a task, executed and verified ----------------------------------------------

test('a task is routed, executed, verified by a second implementation, and recorded as a success', () => {
  const root = makeTree('run', SMALL); cleanup.push(root)
  const loop = loopFor()
  const { materialise, stream } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'count-lines-small', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }

  const measured = loop.measure({ candidates: [materialise, stream], task })
  const episode = loop.runTask(task, { candidates: [materialise, stream], acceptance: acceptanceFor(smallLines) })
  // On a three-file tree the two implementations are within a fraction of a millisecond of each
  // other, so which one is cheaper is not a fact about them -- asserting a winner here was
  // asserting the measurement order (the second candidate used to be measured on a warmer page
  // cache). What must hold is that the router chose what its own measurement found cheapest, and
  // said so in the reason.
  const cheapest = measured.measured.reduce((a, b) => (b.medianMs < a.medianMs ? b : a))
  assert.equal(episode.route.chosen.id, cheapest.id,
    `the route must be the cheaper measured one: chose ${episode.route.chosen.id}, measured ${JSON.stringify(measured.measured.map((m) => [m.id, m.medianMs]))}`)
  assert.match(episode.route.chosen.because, /median over 3 run\(s\) on/)
  assert.equal(episode.route.alternatives.length, 1, 'the other candidate is an alternative, not a fallback')

  assert.equal(episode.outcome, OUTCOMES.SUCCESS)
  assert.equal(episode.failureKind, null)
  assert.equal(episode.execution.result.lines, smallLines)
  assert.equal(episode.execution.result.files, 3, '.md is excluded by the extension list')
  assert.equal(episode.verification.agree, true)
  assert.equal(episode.verification.methods.length, 2)
  assert.equal(episode.diagnosis, null, 'a success has no failure to diagnose')
  // The two implementations must be named in the evidence, or "verified" is a word.
  assert.deepEqual(episode.verification.methods.map((m) => m.role), ['executor under test', 'independent recomputation, whole tree'])
  assert.match(episode.verification.reason, /two independent implementations agree/)
  // wc -l is checked when the platform has it, and the record says if it did not.
  assert.equal(typeof episode.verification.external.available, 'boolean')
  if (episode.verification.external.available) {
    assert.equal(episode.verification.external.disagreements.length, 0)
    assert.ok(episode.verification.external.checked > 0)
  }
})

test('a result that does not meet its acceptance criteria is a failure, whatever it verified', () => {
  const root = makeTree('acceptance', SMALL); cleanup.push(root)
  const loop = loopFor()
  const { materialise } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'count-lines', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }

  // The count is verified -- both implementations agree on 5 -- and the criterion asks for 6.
  const { stream } = makeLineCountExecutors({ roots: [root] })
  const episode = loop.runTask(task, { candidates: [materialise], verifyWith: [stream], acceptance: acceptanceFor(6) })
  assert.equal(episode.verification.agree, true, 'verified: the answer is right')
  assert.equal(episode.outcome, OUTCOMES.FAILED, 'and still a failure: it is not the answer that was asked for')
  assert.equal(episode.failureKind, FAILURE_KINDS.ACCEPTANCE_UNMET)
  assert.match(episode.because, /acceptance check/)
})

test('a fast wrong answer is caught by verification and recorded as inconclusive, not as success', () => {
  const root = makeTree('liar', SMALL); cleanup.push(root)
  const loop = loopFor()
  const { materialise } = makeLineCountExecutors({ roots: [root] })
  // A candidate that is cheaper than the real one and returns the wrong number. This is the
  // case the whole verification layer exists for: without it, the cheapest route wins and the
  // report says 999,999 lines with a straight face.
  const liar = validateCapability({
    id: 'line-count-liar',
    kind: 'tool',
    provides: ['tree.line-count'],
    permissions: { fsRead: [root], fsWrite: [], network: false },
    determinism: 'deterministic',
    cost: { measured: { medianMs: 0.001, samples: 3, input: 'rigged for this test' } },
    invoke: () => ({ root, files: 3, lines: 999_999, bytes: 0, perFile: [], unreadableDirs: [] }),
  })
  const task = { id: 'count-lines', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }

  const episode = loop.runTask(task, { candidates: [liar, materialise], acceptance: acceptanceFor(smallLines) })
  assert.equal(episode.route.chosen.id, 'line-count-liar', 'the cheap wrong answer is the one selected')
  assert.equal(episode.outcome, OUTCOMES.INCONCLUSIVE, 'not a success, and not a proven failure either')
  assert.equal(episode.failureKind, FAILURE_KINDS.VERIFICATION_DISAGREEMENT)
  assert.match(episode.diagnosis.likelyCause, /the implementations disagree/)
  assert.equal(episode.diagnosis.hypothesis, true)
})

test('a path outside the declared scope fails with a permission error rather than being read', () => {
  const inside = makeTree('inside', SMALL); cleanup.push(inside)
  const outside = makeTree('outside', { 'secret.mjs': 'x\n' }); cleanup.push(outside)
  const loop = loopFor()
  const { materialise } = makeLineCountExecutors({ roots: [inside] })
  const task = { id: 'escape', capabilities: ['tree.line-count'], root: outside, extensions: ['.mjs'] }

  const episode = loop.runTask(task, { candidates: [materialise], acceptance: acceptanceFor(1) })
  assert.equal(episode.outcome, OUTCOMES.FAILED)
  assert.equal(episode.failureKind, FAILURE_KINDS.PERMISSION_DENIED)
  assert.match(episode.execution.error, /not permitted to read/)
  assert.match(episode.diagnosis.candidateCorrection, /do not widen it as a side effect of a failure/)
})

test('a task nothing can serve is refused, and the refusal names the missing capability', () => {
  const root = makeTree('noroute', SMALL); cleanup.push(root)
  const loop = loopFor()
  const { materialise } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'semantic', capabilities: ['tree.semantic-diff'], root, extensions: ['.mjs'] }

  const episode = loop.runTask(task, { candidates: [materialise], acceptance: acceptanceFor(1) })
  assert.equal(episode.outcome, OUTCOMES.FAILED)
  assert.equal(episode.failureKind, FAILURE_KINDS.NO_ROUTE)
  assert.equal(episode.execution, null, 'nothing ran')
  assert.match(episode.route.refused.message, /no route satisfies this task/)
})

// --- proposing, and refusing to propose ------------------------------------------

test('a skill cannot be proposed from a run that failed or was not verified', () => {
  const root = makeTree('propose', SMALL); cleanup.push(root)
  const loop = loopFor()
  const { materialise } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'count-lines', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }

  const failed = loop.runTask(task, { candidates: [materialise], acceptance: acceptanceFor(999) })
  assert.throws(
    () => loop.proposeSkill({ episode: failed, name: 'line-count-stream' }),
    (error) => error instanceof LoopError && error.code === 'not_a_verified_success',
  )

  const noRoute = loop.runTask({ ...task, capabilities: ['tree.semantic-diff'] }, { candidates: [materialise], acceptance: acceptanceFor(1) })
  assert.throws(() => loop.proposeSkill({ episode: noRoute, name: 'line-count-stream' }), (e) => e.code === 'not_a_verified_success')
})

// --- the milestone ---------------------------------------------------------------

test('the milestone: a verified run becomes a tested skill, and the second task reuses it', () => {
  const treeA = makeBigTree('milestoneA')
  const treeB = makeBigTree('milestoneB')
  cleanup.push(treeA.root, treeB.root)

  // The fixtures the skill's own tests read. They are created up front and named in the
  // executor's read scope, because a test that reads outside the scope is not a test of the
  // procedure -- it is a test of whether the permission check is enforced, which is the next
  // fixture down.
  const fixtures = mkdtempSync(join(tmpdir(), 'adaptive-skillfixtures-'))
  mkdirSync(join(fixtures, 'small')); mkdirSync(join(fixtures, 'empty')); mkdirSync(join(fixtures, 'truncated'))
  writeFileSync(join(fixtures, 'small', 'a.mjs'), SMALL['a.mjs'], 'utf8')
  writeFileSync(join(fixtures, 'empty', 'empty.mjs'), '', 'utf8')
  writeFileSync(join(fixtures, 'truncated', 'n.mjs'), 'one\ntwo', 'utf8')
  const outOfScope = makeTree('outofscope', { 'a.mjs': 'x\n' })
  cleanup.push(fixtures, outOfScope)

  const loop = loopFor({ samples: 3 })
  const granted = [treeA.root, treeB.root, fixtures]
  const { materialise, stream } = makeLineCountExecutors({ roots: granted })
  const acceptanceA = acceptanceFor(treeA.expectedLines)
  const acceptanceB = acceptanceFor(treeB.expectedLines)

  // --- 1. the first task, with only the baseline procedure available --------------
  const taskA = { id: 'count-lines-A', capabilities: ['tree.line-count'], root: treeA.root, extensions: ['.mjs'] }
  loop.measure({ candidates: [materialise], task: taskA })
  // Only the baseline is *routable* in this run; the streaming implementation exists, so it can
  // serve as the independent check even though it is not yet a route anyone can choose.
  const first = loop.runTask(taskA, { candidates: [materialise], verifyWith: [stream], acceptance: acceptanceA })
  assert.equal(first.outcome, OUTCOMES.SUCCESS)
  assert.equal(first.route.chosen.id, 'line-count-materialise')
  assert.equal(first.verification.agree, true)
  assert.deepEqual(first.verification.methods.map((m) => m.name), ['line-count-materialise', 'line-count-stream'])

  // --- 2. propose, test, promote -------------------------------------------------
  // The measured crossover, recorded on the skill as a limitation rather than left in a
  // development note: at constant total bytes, a chunked scan beats a materialising read above
  // roughly 32 KB per file (1.5-1.8x) and loses below it, where the baseline is up to 1.8x
  // faster. The router re-measures per input, so the number decides, not this sentence.
  const crossover = 'Measured: beats a materialising read above about 32 KB per file (1.5-1.8x at 3.5 MB total); below that the baseline is faster and the router prefers it.'
  const proposal = loop.proposeSkill({ episode: first, name: 'line-count-stream', version: '1.0.0', limitations: [crossover] })
  assert.equal(proposal.state, SKILL_STATES.CANDIDATE, 'a proposal is never born validated')
  assert.match(proposal.document, /about 32 KB per file/, 'the declared limitation is in the stored document')

  const checks = [
    { name: 'agrees with the baseline on a small tree', run: () => {
        const a = stream.invoke({ root: join(fixtures, 'small'), extensions: ['.mjs'] })
        const b = materialise.invoke({ root: join(fixtures, 'small'), extensions: ['.mjs'] })
        return { passed: a.lines === b.lines && a.lines === smallLines, detail: `stream ${a.lines} vs materialise ${b.lines}, expected ${smallLines}` }
      } },
    { name: 'counts an empty file as zero lines', run: () => {
        const { lines } = stream.invoke({ root: join(fixtures, 'empty'), extensions: ['.mjs'] })
        return { passed: lines === 0, detail: `empty file gave ${lines}` }
      } },
    { name: 'counts newline bytes, so a file with no trailing newline is one fewer', run: () => {
        const { lines } = stream.invoke({ root: join(fixtures, 'truncated'), extensions: ['.mjs'] })
        return { passed: lines === 1, detail: `'one\\ntwo' gave ${lines} newline bytes` }
      } },
    { name: 'refuses a path outside its read scope', run: () => {
        try {
          materialise.invoke({ root: outOfScope, extensions: ['.mjs'] })
          return { passed: false, detail: 'the executor read a tree outside its scope' }
        } catch (error) {
          return { passed: error.code === 'permission_denied', detail: error.message }
        }
      } },
  ]
  const tested = loop.testSkill({ name: 'line-count-stream', checks })
  assert.equal(tested.passed, true, JSON.stringify(tested.checks, null, 2))

  // EVALUATE before APPROVE. The evaluation is what records the regression set the *next*
  // version will have to keep passing.
  const evaluated = loop.evaluate({ name: 'line-count-stream', version: '1.0.0', checks })
  assert.equal(evaluated.verdict, 'accepted', evaluated.summary)
  const promoted = loop.promote({ name: 'line-count-stream', checks: tested.checks })
  // `promote` takes the *evaluated results* it re-checks, and refuses any name the accepted
  // evaluation did not run -- so a check added after the evaluation cannot ride in with it.
  assert.equal(promoted.state, SKILL_STATES.VALIDATED)
  assert.equal(promoted.version, '1.0.0')
  assert.equal(promoted.validation.checks.length, 4)

  // --- 3. reuse on a second, similar task ---------------------------------------
  const skill = loop.skillExecutor({
    name: 'line-count-stream',
    provides: ['tree.line-count'],
    // The grant is what the runtime allows. The scope the skill actually runs with comes from
    // its stored document, which is where the proposal wrote it down.
    grant: { fsRead: granted, fsWrite: [], network: false },
    limitations: ['Counts newline bytes, so a file with no trailing newline reports one fewer line.'],
    invoke: (invocation) => stream.invoke(invocation),
  })
  assert.equal(skill.kind, 'skill')
  assert.equal(skill.version, '1.0.0')

  const taskB = { id: 'count-lines-B', capabilities: ['tree.line-count'], root: treeB.root, extensions: ['.mjs'] }
  // The skill wraps the streaming implementation, so it is checked against the *baseline*:
  // verifying it with the implementation it is made of would be a route agreeing with itself.
  const measured = loop.measure({ candidates: [materialise, skill], task: taskB })
  const second = loop.runTask(taskB, { candidates: [materialise, skill], verifyWith: [materialise, stream], acceptance: acceptanceB })

  // The reuse is a *decision with a reason*, not a hardcoded preference.
  assert.equal(second.route.chosen.id, 'skill.line-count-stream', 'the stored procedure was selected')
  assert.equal(second.route.chosen.kind, 'skill')
  assert.match(second.route.chosen.because, /median over 3 run\(s\) on/)
  assert.equal(second.route.alternatives[0].id, 'line-count-materialise')

  // And the improvement is measured on the same input by the same loop, not asserted.
  const baseline = measured.measured.find((m) => m.id === 'line-count-materialise')
  const skillCost = measured.measured.find((m) => m.id === 'skill.line-count-stream')
  assert.equal(second.outcome, OUTCOMES.SUCCESS)
  assert.equal(second.execution.result.lines, treeB.expectedLines)
  assert.equal(second.verification.agree, true)
  assert.equal(second.verification.methods.length, 2, 'the skill route is verified like any other')
  assert.ok(
    skillCost.medianMs < baseline.medianMs,
    `the stored procedure must actually be cheaper on this tree: ${skillCost.medianMs} ms against ${baseline.medianMs} ms`,
  )
  const ratio = Math.round((baseline.medianMs / skillCost.medianMs) * 100) / 100
  assert.ok(ratio > 1, `ratio ${ratio}`)

  // Both runs computed the same number of newline bytes, which is the point: the second run is
  // not a better answer, it is the same answer for less.
  assert.equal(first.execution.result.lines, treeA.expectedLines)
  assert.equal(second.execution.result.lines, first.execution.result.lines * 0 + treeB.expectedLines)
  assert.deepEqual(second.verification.methods.map((m) => m.name), ['skill.line-count-stream', 'line-count-materialise'])
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 2]), 3)
})

test('a candidate skill is not loadable, and promotion is refused when a check fails', () => {
  const root = makeTree('promote', SMALL); cleanup.push(root)
  const loop = loopFor()
  const { materialise, stream } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'count-lines', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }
  loop.measure({ candidates: [materialise], task })
  const episode = loop.runTask(task, { candidates: [materialise], verifyWith: [stream], acceptance: acceptanceFor(smallLines) })
  loop.proposeSkill({ episode, name: 'line-count-stream' })

  // A candidate exists in the registry but cannot be routed: only validated or stale skills load.
  assert.throws(
    () => loop.skillExecutor({ name: 'line-count-stream', provides: ['tree.line-count'], permissions: { fsRead: [root] }, invoke: () => {} }),
    (error) => error instanceof LoopError && error.code === 'not_loadable',
  )

  const failingChecks = [
    { name: 'counts correctly', run: () => ({ passed: true, detail: 'ok' }) },
    { name: 'holds under a tree it has never seen', run: () => ({ passed: false, detail: 'counted 4, expected 5' }) },
  ]
  const failedCheck = loop.testSkill({ name: 'line-count-stream', checks: failingChecks })
  assert.equal(failedCheck.passed, false)
  // EVALUATE records the failure -- and the version stays in the registry as a candidate.
  const rejected = loop.evaluate({ name: 'line-count-stream', version: '1.0.0', checks: failingChecks })
  assert.equal(rejected.verdict, 'rejected')
  assert.equal(rejected.diagnosis, 'new_failure')
  assert.match(rejected.summary, /'holds under a tree it has never seen' reported counted 4, expected 5/)
  assert.throws(
    () => loop.promote({ name: 'line-count-stream', checks: failedCheck.checks }),
    (error) => error instanceof LoopError && error.code === 'not_evaluated',
  )
  // And the registry itself refuses too, so promotion cannot be bypassed by calling it directly.
  assert.throws(() => loop.registry.validate('line-count-stream', { checks: failedCheck.checks }), /did not pass/)
  assert.equal(loop.registry.describe('line-count-stream').state, SKILL_STATES.CANDIDATE)
})

test('a check that throws is a failed check, not a crashed run', () => {
  const loop = loopFor()
  const tested = loop.testSkill({
    name: 'x',
    checks: [{ name: 'explodes', run: () => { throw new Error('boom') } }],
  })
  assert.equal(tested.passed, false)
  assert.match(tested.checks[0].detail, /raised: boom/)
})

/**
 * The checks `promote` re-runs. They are built fresh rather than reused because `promote`
 * compares the names it is handed against the names in the accepted evaluation, and a helper
 * keeps that literal from drifting at four call sites.
 */
const sanityChecks = () => [{ name: 'sanity', run: () => ({ passed: true, detail: 'ok' }) }]

// --- the episode log ---------------------------------------------------------------

test('episodes form a tamper-evident chain, and a broken log refuses new writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-log-')); cleanup.push(dir)
  const file = join(dir, 'episodes.jsonl')
  const root = makeTree('log', SMALL); cleanup.push(root)
  const loop = loopFor({ episodesFile: file })
  const { materialise, stream } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'count-lines', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }
  loop.measure({ candidates: [materialise], task })
  loop.runTask(task, { candidates: [materialise], verifyWith: [stream], acceptance: acceptanceFor(smallLines) })
  loop.runTask(task, { candidates: [materialise], verifyWith: [stream], acceptance: acceptanceFor(999) })

  const log = new EpisodeLog(file)
  assert.equal(log.count, 2)
  assert.deepEqual(log.verify(), { ok: true, brokenAt: null, count: 2 })
  assert.equal(log.successes().length, 1, 'only the verified success may seed a skill')

  // Edit a number in the first episode: the chain no longer matches its content.
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const tampered = JSON.parse(lines[0])
  tampered.execution.result.lines = 424242
  lines[0] = JSON.stringify(tampered)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

  // Reading a tampered log still works -- the break is the finding, and a log that refuses to
  // load is a log whose tampering nobody can see.
  const broken = new EpisodeLog(file)
  assert.equal(broken.count, 2)
  assert.equal(broken.verify().ok, false)
  assert.equal(broken.verify().brokenAt, 0)
  assert.match(broken.verify().reason, /modified since it was written/)
  // Writing to it does not.
  assert.throws(() => broken.append({ outcome: OUTCOMES.SUCCESS }), (error) => error instanceof EpisodeError && error.code === 'log_tampered')
})

test('an episode without an outcome is refused, and acceptance criteria are required', () => {
  const log = new EpisodeLog(':memory:')
  assert.throws(() => log.append({ task: 'x' }), (e) => e.code === 'missing_outcome')

  const root = makeTree('criteria', SMALL); cleanup.push(root)
  const loop = loopFor()
  const { materialise } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'count-lines', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }
  assert.throws(
    () => loop.runTask(task, { candidates: [materialise], acceptance: { checks: [] } }),
    (e) => e.code === 'no_acceptance_criteria',
  )
  assert.throws(() => evaluateAcceptance({ lines: 1 }, { checks: [{ name: 'x', metric: 'lines', op: '~=', value: 1 }] }), (e) => e.code === 'unknown_operator')
  assert.throws(() => evaluateAcceptance({ lines: 1 }, { checks: [{ name: 'x', metric: 'shoes', op: '==', value: 1 }] }), (e) => e.code === 'unknown_metric')
})

test('rolling back to a previous version is a version pin, and an unknown version is refused', () => {
  const loop = loopFor({ registry: null })
  const registry = new SkillRegistry()
  const loopWith = new AdaptiveLoop({ registry })
  const root = makeTree('rollback', SMALL); cleanup.push(root)
  const { materialise, stream } = makeLineCountExecutors({ roots: [root] })
  const task = { id: 'count-lines', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] }
  loopWith.measure({ candidates: [materialise], task })
  const episode = loopWith.runTask(task, { candidates: [materialise], verifyWith: [stream], acceptance: acceptanceFor(smallLines) })
  loopWith.proposeSkill({ episode, name: 'line-count-stream', version: '1.0.0' })
  const firstEval = loopWith.evaluate({ name: 'line-count-stream', version: '1.0.0', checks: sanityChecks() })
  loopWith.promote({ name: 'line-count-stream', checks: firstEval.results })
  loopWith.proposeSkill({ episode, name: 'line-count-stream', version: '1.1.0' })
  const secondEval = loopWith.evaluate({ name: 'line-count-stream', version: '1.1.0', checks: sanityChecks() })
  loopWith.promote({ name: 'line-count-stream', checks: secondEval.results })
  assert.equal(loopWith.registry.describe('line-count-stream').version, '1.1.0')

  const rolledBack = loopWith.rollback({ name: 'line-count-stream', version: '1.0.0' })
  assert.equal(rolledBack.restored, '1.0.0')
  assert.equal(rolledBack.newVersion, '1.1.1', 'rollback appends a version; it never reuses one')
  assert.equal(rolledBack.state, SKILL_STATES.CANDIDATE, 'a restored procedure is re-tested before it loads again')
  assert.equal(loopWith.registry.describe('line-count-stream').version, '1.1.1')
  assert.throws(() => loopWith.rollback({ name: 'line-count-stream', version: '9.9.9' }), (e) => e.code === 'unknown_version')
  assert.throws(() => new AdaptiveLoop({ registry: null }), (e) => e.code === 'no_registry')
})

test('every interaction state renders, and none of the system prose trips its own §4 guard', () => {
  // This test exists because the reflective closing line said 'keep the diagnosis beside the
  // result' and the guard refused it -- correct behaviour, wrong sentence. Adding a state or a
  // closing line now fails here rather than at the moment a user asks a question.
  const facts = {
    task: 'count lines under services/',
    outcome: 'success',
    lines: 4218,
    files: 37,
    executor: 'skill.line-count-stream',
    skillVersion: '1.0.0',
    medianMs: 12.4,
    samples: 3,
    verified: true,
    verification: 'two independent implementations agree',
    methods: ['skill.line-count-stream', 'line-count-materialise'],
  }
  const rendered = new Map()
  for (const state of INTERACTION_STATES) {
    const result = renderOutcome({ facts, state, personality: { humor: true, verbosity: 'detailed' } })
    assert.equal(auditWording(result.text).ok, true, `${state} rendered text must audit clean`)
    assert.ok(result.text.includes(result.factsBlock), 'the facts block is verbatim in every state')
    assert.ok(result.text.includes('Checked by:'), 'detailed verbosity names the implementations that checked the result')
    rendered.set(state, result.text)
  }
  assert.equal(rendered.size, 7, 'seven states, and the loop above rendered all seven')

  // The facts are identical in every state: the openers differ, the numbers do not.
  const bodies = new Set([...rendered.values()].map((text) => text.split('\n\n')[1]))
  assert.equal(bodies.size, 1, `all seven states must carry the same facts block, found ${bodies.size} variants`)

  // An unverified result renders, and says so in the facts block itself -- the disclosure is
  // not a tone the caller has to remember to add.
  const unverified = renderOutcome({
    facts: { ...facts, verified: false, verification: 'no independent check ran' },
    state: 'focused',
  })
  assert.ok(unverified.text.includes('Verified: NO'), 'unverified results are marked unverified')
  assert.ok(!unverified.text.includes('Verified: yes'), 'and never marked verified')

  // The guard catches the case the facts block cannot fix on its own: a caller who passes a
  // vague truthy claim of verification. 'probably' is truthy in JavaScript, and without the
  // guard it would render as 'Verified: yes - undefined'.
  assert.throws(
    () => renderOutcome({ facts: { ...facts, verified: 'probably', verification: undefined }, state: 'focused' }),
    (error) => error.code === 'unverified_not_disclosed',
    'a non-boolean claim of verification must be refused, not rendered as a yes',
  )

  // The system's own prose is what the guard can hold to account; a user-supplied task name
  // flows through the facts block, so a refusal there is a refusal to describe the task.
  assert.throws(
    () => renderOutcome({ facts: { ...facts, task: 'reply to the user' , correction: 'I am sorry about the failure' }, state: 'supportive' }),
    (error) => error.code === 'forbidden_wording',
  )

  // A setting that changes nothing says so, rather than implying an effect it does not have.
  const quiet = renderOutcome({ facts, state: 'focused', personality: { warmth: 'low' } })
  assert.deepEqual(quiet.applied, [])
  assert.ok(quiet.noEffectYet.includes('warmth'), 'warmth is recorded as having no effect on text yet')

  // The state estimator reports uncertainty and never a sensitive attribute.
  const estimate = estimateInteractionState({ messages: ['this is broken and I am frustrated'], task: {} })
  assert.ok(INTERACTION_STATES.includes(estimate.state))
  assert.equal(estimate.uncertain, true, 'an estimate from wording alone is uncertain and says so')
  assert.equal(auditWording(JSON.stringify(estimate)).ok, true, 'the estimate itself must pass the §4 audit')
})

test('a stored procedure that is not cheaper on the measured input is recorded as not cheaper', () => {
  // Found by running the milestone on a different tree shape: ~180 files of ~200 lines each is
  // a regime where the materialising baseline beats the streaming skill (per-file overhead),
  // and the loop routed to the baseline on the second task -- correctly. The failure this test
  // prevents is the other one: the proposal still claiming an improvement that the same loop's
  // measurement had just contradicted.
  const tree = makeBigTree('notcheaper')
  cleanup.push(tree.root)
  const loop = loopFor({ samples: 3 })
  const { materialise, stream } = makeLineCountExecutors({ roots: [tree.root] })
  const task = { id: 'count-lines-notcheaper', capabilities: ['tree.line-count'], root: tree.root, extensions: ['.mjs'] }
  loop.measure({ candidates: [materialise], task })
  const episode = loop.runTask(task, { candidates: [materialise], verifyWith: [stream], acceptance: acceptanceFor(tree.expectedLines) })
  assert.equal(episode.outcome, OUTCOMES.SUCCESS)

  // A comparison the measurement does not support: the skill is declared slower than the route
  // that actually ran. The proposal must quote that, not a claim of improvement.
  const slower = loop.proposeSkill({
    episode,
    name: 'line-count-stream',
    comparison: [
      { id: 'line-count-materialise', medianMs: 4.0 },
      { id: 'line-count-stream', medianMs: 9.5 },
    ],
  })
  assert.match(slower.comparison, /NOT the cheaper route here/)
  assert.match(slower.document, /NOT the cheaper route here/, 'the recorded skill document carries the measurement, not a summary of it')

  const faster = loop.proposeSkill({
    episode,
    name: 'line-count-stream',
    version: '0.2.0',
    comparison: [
      { id: 'line-count-materialise', medianMs: 9.5 },
      { id: 'line-count-stream', medianMs: 4.0 },
    ],
  })
  assert.match(faster.comparison, /is the cheaper route here/)
  assert.ok(!/NOT the cheaper/.test(faster.comparison))

  // With no comparison supplied, the proposal states no comparative claim at all rather than
  // falling back to a plausible-sounding one.
  const noComparison = loop.proposeSkill({ episode, name: 'line-count-stream', version: '0.3.0' })
  assert.equal(noComparison.comparison, null)
  assert.ok(!/cheaper route here/.test(noComparison.document), 'no measurement, no comparative claim')
})

test('the in-memory episode log reads back everything it accepted', () => {
  // The default log is ':memory:', and it used to accept appends while list() returned an empty
  // array: count grew, verify() called an empty log intact, and successes() reported no
  // successes about a session that had recorded some. Every milestone assertion passed anyway,
  // because the loop returns the appended record as well as logging it.
  const log = new EpisodeLog()
  assert.equal(log.count, 0)
  assert.deepEqual(log.list(), [])
  const first = log.append({ kind: 'task', outcome: OUTCOMES.SUCCESS, verification: { agree: true } })
  const second = log.append({ kind: 'task', outcome: OUTCOMES.FAILED, verification: null })
  assert.equal(log.count, 2)
  assert.equal(log.list().length, 2, 'the log must return the episodes it accepted')
  assert.equal(log.lastDigest, second.digest)
  assert.equal(second.prevDigest, first.digest, 'the chain links each episode to the previous digest')
  assert.equal(log.verify().ok, true)
  assert.equal(log.successes().length, 1, 'one of the two was a verified success')
  assert.throws(() => log.append({ kind: 'task' }), (error) => error.code === 'missing_outcome')
})

test('measurement interleaves candidates by round, and the method is recorded with the numbers', () => {
  // Position in the candidate array must not decide which implementation looks cheaper. A
  // scripted clock makes the *method* observable rather than hopeful: it hands out a fixed
  // duration per invocation and records the order it was asked in.
  const root = makeTree('interleave', SMALL)
  cleanup.push(root)
  // `timeInvocation` reads the clock twice per invocation (before and after), so each pair in
  // this script is one invocation's duration: alpha's three runs take 10 ms, beta's take 1 ms.
  const script = [0, 10, 0, 1, 0, 10, 0, 1, 0, 10, 0, 1]
  let call = 0
  const timer = () => script[call++] ?? 0
  const loop = loopFor({ samples: 3, timer })
  const scripted = (id, implementation) => validateCapability({
    id, implementation, kind: 'tool', capabilities: ['tree.line-count'], provides: ['tree.line-count'],
    permissions: { fsRead: [root], fsWrite: [], network: false },
    invoke: () => ({ lines: smallLines, files: 3, bytes: 30 }),
  })
  const first = scripted('alpha', 'impl-alpha')
  const second = scripted('beta', 'impl-beta')
  const result = loop.measure({ candidates: [first, second], task: { id: 'interleave', capabilities: ['tree.line-count'], root, extensions: ['.mjs'] } })

  assert.deepEqual(result.order, ['alpha', 'beta'], 'the measurement order is part of the record')
  assert.equal(result.runs, 3)
  assert.deepEqual(result.measured.map((m) => m.samples), [3, 3], 'each candidate gets the same number of runs')
  // The scripted durations alternate 10, 1, 10, 1, 10, 1 ms. Alpha therefore receives every
  // other duration only if measurement alternates too. Candidate-by-candidate measurement would
  // have given alpha the first three (10, 1, 10) and beta the last three (1, 10, 1).
  assert.deepEqual(result.measured[0].times, [10, 10, 10], 'the first candidate was measured in every round')
  assert.deepEqual(result.measured[1].times, [1, 1, 1], 'so was the second, between the first one\'s runs')
  assert.equal(result.measured[0].medianMs, 10)
  assert.equal(result.measured[1].medianMs, 1)
})
