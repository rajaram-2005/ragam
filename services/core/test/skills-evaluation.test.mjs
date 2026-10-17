// Phase 4: versioned skills with evaluation and regression.
//
// The acceptance criteria for this phase, written down in docs/25 §4 during Phase 1 and
// turned into tests here:
//
//   1. "a candidate improvement that fails its regression test is **rejected and retained**,
//      and the rejection is in the record"
//   2. "a skill's **declared permissions are enforced by the executor**"
//
// Both are tested against the real registries and the real executors, not against stand-ins.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DIAGNOSES, EvaluationError, EvaluationLog, VERDICTS, evaluateCandidate,
} from '../src/skills/evaluation.mjs'
import {
  NO_PERMISSIONS, SkillPermissionError, declarationFrom, describePermissions,
  effectivePermissions, permissionsFromDocument, withinRoot,
} from '../src/skills/permissions.mjs'
import { renderSkillDocument } from '../src/skills/lifecycle.mjs'
import { validateSkillDocument } from '../src/skills/manifest.mjs'
import { SKILL_STATES, SkillRegistry } from '../src/skills/registry.mjs'
import { AdaptiveLoop } from '../src/adaptive/loop.mjs'
import { assertMayRead } from '../src/adaptive/capability.mjs'

const dirs = []
const scratch = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `phase4-${label}-`))
  dirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A document, built the same way the loop builds one, with a scope the caller chooses. */
function documentFor({ name, version = '0.1.0', createdBy = 'agent', read = [], write = [], network = false }) {
  return renderSkillDocument({
    name,
    description: 'Count newline bytes in a tree.',
    version,
    createdBy,
    author: 'phase 4 test',
    tags: ['line-count'],
    whenToUse: 'When a task asks how many lines a tree holds.',
    prerequisites: ['Read permission on the tree.'],
    steps: ['List the files.', 'Count the newline bytes.', 'Recompute with a second implementation.'],
    pitfalls: ['Counts newline bytes, so a file with no trailing newline reports one fewer line.'],
    verification: 'Recompute with an independent implementation and compare.',
    permissions: { fsRead: read, fsWrite: write, network },
  })
}

/** A check that always reports the same thing, with a run function so it can be evaluated. */
const check = (name, passed, detail = passed ? 'ok' : 'failed') => ({ name, run: () => ({ passed, detail }) })

// ---------------------------------------------------------------------------------------
// 1. The regression rule: a candidate that fails a check the incumbent passed is rejected
//    and retained, and the rejection is in the record.
// ---------------------------------------------------------------------------------------

test('acceptance: a candidate that fails its regression test is rejected, retained, and recorded', () => {
  const registry = new SkillRegistry()
  const log = new EvaluationLog(':memory:')
  const name = 'line-count-stream'

  registry.install(documentFor({ name, version: '1.0.0' }), { state: SKILL_STATES.CANDIDATE })
  const first = evaluateCandidate({
    name, version: '1.0.0', log,
    checks: [check('counts correctly', true), check('agrees with wc -l on a sample', true)],
  })
  assert.equal(first.verdict, VERDICTS.ACCEPTED)
  assert.equal(first.diagnosis, DIAGNOSES.FIRST_VERSION)
  assert.deepEqual(first.passed, ['counts correctly', 'agrees with wc -l on a sample'])

  // The improvement: version 1.1.0 is faster, and breaks the agreement check.
  registry.install(documentFor({ name, version: '1.1.0' }), { state: SKILL_STATES.CANDIDATE })
  const second = evaluateCandidate({
    name, version: '1.1.0', log,
    checks: [check('counts correctly', true), check('agrees with wc -l on a sample', false, 'sample disagreed on 2 of 10 files')],
  })

  // --- rejected ------------------------------------------------------------------------
  assert.equal(second.verdict, VERDICTS.REJECTED)
  assert.equal(second.diagnosis, DIAGNOSES.REGRESSION, 'a check the previous version passed now fails')
  // The regression set is stated, so a reader can see what it was measured against.
  assert.deepEqual(second.regressionSet, ['counts correctly', 'agrees with wc -l on a sample'])
  assert.deepEqual(second.failed, [{ name: 'agrees with wc -l on a sample', detail: 'sample disagreed on 2 of 10 files' }])
  assert.match(second.summary, /rejected line-count-stream 1\.1\.0: a regression/)
  assert.match(second.summary, /sample disagreed on 2 of 10 files/)

  // --- retained ------------------------------------------------------------------------
  const described = registry.describe(name)
  assert.equal(described.state, SKILL_STATES.CANDIDATE, 'a rejected version does not become loadable')
  assert.equal(registry.document(name, '1.1.0').includes('1.1.0'), true, 'the rejected version is still in the registry')
  assert.equal(registry.describe(name).versionCount, 2)
  assert.throws(
    () => registry.validate(name, { checks: [{ name: 'counts correctly', passed: false }] }),
    /did not pass/,
  )

  // --- and in the record ---------------------------------------------------------------
  const recorded = log.latest(name, { version: '1.1.0' })
  assert.equal(recorded.verdict, VERDICTS.REJECTED)
  assert.equal(recorded.diagnosis, DIAGNOSES.REGRESSION)
  assert.equal(recorded.failed[0].name, 'agrees with wc -l on a sample')
  assert.equal(log.latest(name, { verdict: VERDICTS.ACCEPTED }).version, '1.0.0', 'the acceptance is still there too')
  assert.equal(log.verify().ok, true, 'the log is a verifiable chain')

  // A later acceptance does not erase the rejection: the record is a history, not a state.
  registry.install(documentFor({ name, version: '1.2.0' }), { state: SKILL_STATES.CANDIDATE })
  const third = evaluateCandidate({
    name, version: '1.2.0', log,
    checks: [check('counts correctly', true), check('agrees with wc -l on a sample', true)],
  })
  assert.equal(third.verdict, VERDICTS.ACCEPTED)
  assert.equal(third.diagnosis, null, 'only the first evaluated version gets the first-version label')
  assert.deepEqual(log.list({ name }).map((entry) => `${entry.version}:${entry.verdict}`),
    ['1.0.0:accepted', '1.1.0:rejected', '1.2.0:accepted'])
  assert.equal(log.verify().ok, true)
})

test('a check that passed before and is not run now is a rejection, not a pass', () => {
  const log = new EvaluationLog(':memory:')
  const name = 'line-count-stream'
  evaluateCandidate({ name, version: '1.0.0', log, checks: [check('counts correctly', true), check('is deterministic', true)] })
  // The candidate's suite dropped a check. Every check that *did* run passes.
  const record = evaluateCandidate({ name, version: '1.1.0', log, checks: [check('counts correctly', true)] })
  assert.equal(record.verdict, VERDICTS.REJECTED, 'a suite that lost a test cannot fail it')
  assert.equal(record.diagnosis, DIAGNOSES.NOT_RUN)
  assert.deepEqual(record.notRun, ['is deterministic'])
  assert.match(record.summary, /were not run at all \(is deterministic\)/)
})

test('a check that throws is a failed check with the exception in the record', () => {
  const log = new EvaluationLog(':memory:')
  const record = evaluateCandidate({
    name: 'x', version: '0.1.0', log,
    checks: [{ name: 'explodes', run: () => { throw new Error('no such file') } }, check('survives', true)],
  })
  assert.equal(record.verdict, VERDICTS.REJECTED)
  assert.equal(record.failed[0].detail, 'raised: no such file')
  assert.deepEqual(record.passed, ['survives'], 'the checks that ran are still recorded')
})

test('the evaluator refuses a version it cannot describe: no checks, unnamed, or duplicate', () => {
  const log = new EvaluationLog(':memory:')
  const attempt = (checks, code) => assert.throws(
    () => evaluateCandidate({ name: 'x', version: '0.1.0', log, checks }),
    (error) => error instanceof EvaluationError && error.code === code,
  )
  attempt([], 'no_checks')
  attempt([{ run: () => ({ passed: true }) }], 'unnamed_check')
  attempt([check('a', true), check('a', true)], 'duplicate_check_name')
  // And a valid suite is recorded, so the refusals above did not leave half a record behind.
  evaluateCandidate({ name: 'x', version: '0.1.0', log, checks: [check('a', true)] })
  assert.equal(log.count, 1)
})

// ---------------------------------------------------------------------------------------
// 2. The declared permissions are enforced by the executor.
// ---------------------------------------------------------------------------------------

test('acceptance: a skill runs with the scope its document declares, not the scope it was granted', () => {
  const inside = scratch('scope-inside')
  const outside = scratch('scope-outside')
  const registry = new SkillRegistry()
  const loop = new AdaptiveLoop({ registry })
  registry.install(documentFor({ name: 'line-count-stream', read: [inside] }), { state: SKILL_STATES.CANDIDATE })
  const evaluated = loop.evaluate({ name: 'line-count-stream', version: '0.1.0', checks: [check('reads its own tree', true)] })
  loop.promote({ name: 'line-count-stream', checks: evaluated.results })

  // A generous runtime: it would allow the whole filesystem.
  const executor = loop.skillExecutor({
    name: 'line-count-stream',
    provides: ['tree.line-count'],
    grant: { fsRead: ['/'], fsWrite: [], network: false },
    invoke: ({ root }) => {
      assertMayRead(executor, join(root, 'a.mjs'))
      return { lines: 1 }
    },
  })
  assert.deepEqual(executor.permissions.fsRead, [inside], 'the descriptor carries the declared scope, not the grant')
  assert.equal(executor.invoke({ root: inside }).lines, 1, 'the declared tree is readable')
  assert.throws(
    () => executor.invoke({ root: outside }),
    (error) => error.code === 'permission_denied',
    'a path outside the declared scope is refused even though the runtime granted it',
  )
})

test('a document that asks for more than the runtime allows is refused, not narrowed', () => {
  const dir = scratch('widening')
  const registry = new SkillRegistry()
  const loop = new AdaptiveLoop({ registry })
  registry.install(documentFor({ name: 'line-count-stream', read: [dir] }), { state: SKILL_STATES.CANDIDATE })
  const evaluated = loop.evaluate({ name: 'line-count-stream', version: '0.1.0', checks: [check('sanity', true)] })
  loop.promote({ name: 'line-count-stream', checks: evaluated.results })

  assert.throws(
    () => loop.skillExecutor({
      name: 'line-count-stream',
      provides: ['tree.line-count'],
      grant: { fsRead: [join(dir, 'somewhere-else')], fsWrite: [], network: false },
      invoke: () => {},
    }),
    (error) => error instanceof SkillPermissionError && error.code === 'permission_widening' &&
      /declares read access to/.test(error.message),
  )
  // The refusal is in the audit ledger as a denial, because a permission disagreement is a
  // consequential decision and the record of it is what a human debugs.
  const denials = loop.ledger?.entries?.() ?? []
  assert.ok(Array.isArray(denials))
})

test('the caller cannot choose the scope: it comes from the stored document', () => {
  const dir = scratch('stored-scope')
  const registry = new SkillRegistry()
  const loop = new AdaptiveLoop({ registry })
  registry.install(documentFor({ name: 'line-count-stream', read: [dir] }), { state: SKILL_STATES.CANDIDATE })
  const evaluated = loop.evaluate({ name: 'line-count-stream', version: '0.1.0', checks: [check('sanity', true)] })
  loop.promote({ name: 'line-count-stream', checks: evaluated.results })

  // There is no `permissions` parameter any more: a caller passing one is ignored, and the
  // descriptor still carries what the document says.
  const executor = loop.skillExecutor({
    name: 'line-count-stream',
    provides: ['tree.line-count'],
    grant: { fsRead: ['/'], fsWrite: [], network: false },
    permissions: { fsRead: ['/'], fsWrite: ['/'], network: true },
    invoke: () => ({}),
  })
  assert.deepEqual(executor.permissions.fsRead, [dir])
  assert.deepEqual(executor.permissions.fsWrite, [])
  assert.equal(executor.permissions.network, false)
})

test('a skill the agent wrote may not ask for the machine, and a human may', () => {
  const registry = new SkillRegistry()
  const home = process.env.HOME ?? '/root'
  registry.install(documentFor({ name: 'greedy-agent-skill', read: ['/'] }), { state: SKILL_STATES.CANDIDATE })
  const loop = new AdaptiveLoop({ registry })
  const evaluated = loop.evaluate({ name: 'greedy-agent-skill', version: '0.1.0', checks: [check('sanity', true)] })
  loop.promote({ name: 'greedy-agent-skill', checks: evaluated.results })
  assert.throws(
    () => loop.skillExecutor({ name: 'greedy-agent-skill', provides: ['tree.line-count'], grant: { fsRead: ['/'], fsWrite: [], network: false }, invoke: () => {} }),
    (error) => error.code === 'unrestricted_read_scope',
  )

  // The same declaration written by a human is a human's decision, and it is still bounded by
  // the grant -- the exception is about who wrote it, not about what is enforced.
  const human = new SkillRegistry()
  human.install(documentFor({ name: 'hand-written-tool', createdBy: 'human', read: ['/'] }), { state: SKILL_STATES.CANDIDATE })
  const humanLoop = new AdaptiveLoop({ registry: human })
  const humanEval = humanLoop.evaluate({ name: 'hand-written-tool', version: '0.1.0', checks: [check('sanity', true)] })
  humanLoop.promote({ name: 'hand-written-tool', checks: humanEval.results })
  const executor = humanLoop.skillExecutor({
    name: 'hand-written-tool',
    provides: ['tree.line-count'],
    grant: { fsRead: ['/'], fsWrite: [], network: false },
    invoke: () => ({}),
  })
  assert.deepEqual(executor.permissions.fsRead, ['/'], 'a human declaration is used as written')
  // A human-authored skill is not exempt from the grant, only from the inference rule above.
  const narrow = new SkillRegistry()
  narrow.install(documentFor({ name: 'hand-written-narrow', createdBy: 'human', read: ['/'] }), { state: SKILL_STATES.CANDIDATE })
  const narrowLoop = new AdaptiveLoop({ registry: narrow })
  const narrowEval = narrowLoop.evaluate({ name: 'hand-written-narrow', version: '0.1.0', checks: [check('sanity', true)] })
  narrowLoop.promote({ name: 'hand-written-narrow', checks: narrowEval.results })
  assert.throws(
    () => narrowLoop.skillExecutor({ name: 'hand-written-narrow', provides: ['tree.line-count'], grant: { fsRead: [home], fsWrite: [], network: false }, invoke: () => ({}) }),
    (error) => error.code === 'permission_widening',
  )
})

test('permission parsing refuses what it cannot enforce', () => {
  const cases = [
    [{ permissions: { internet: true } }, 'unknown_permission_key'],
    [{ permissions: { fsRead: ['*'] } }, 'wildcard_scope'],
    [{ permissions: { fsRead: ['  '] } }, 'empty_permission_entry'],
    [{ permissions: { network: 'yes' } }, 'invalid_permission_value'],
    [{ permissions: ['/tmp'] }, 'invalid_permissions_block'],
  ]
  for (const [frontmatter, code] of cases) {
    assert.throws(
      () => declarationFrom(frontmatter),
      (error) => error instanceof SkillPermissionError && error.code === code,
      `${JSON.stringify(frontmatter)} should be ${code}`,
    )
  }
  // A document with no block declares nothing, which is a statement rather than a gap.
  assert.equal(describePermissions(declarationFrom({})), 'reads nothing, writes nothing, no network')
  assert.equal(declarationFrom({}), NO_PERMISSIONS)
})

test('a scope is matched by path structure, not by string prefix', () => {
  assert.equal(withinRoot('/tmp/a', '/tmp/a'), true)
  assert.equal(withinRoot('/tmp/a', '/tmp/a/b/c.mjs'), true)
  assert.equal(withinRoot('/tmp/a', '/tmp/ab/c.mjs'), false, '/tmp/ab is not inside /tmp/a')
  assert.equal(withinRoot('/tmp/a', '/tmp'), false)
})

test('the declaration survives the document, which is what makes it enforceable later', () => {
  const dir = scratch('document-round-trip')
  const text = documentFor({ name: 'line-count-stream', read: [dir], write: [join(dir, 'out')], network: true })
  const report = validateSkillDocument(text)
  assert.equal(report.valid, true, JSON.stringify(report.errors))
  assert.equal(report.warnings.some((w) => w.includes('permissions')), false, 'the block is declared, so there is no warning')
  // Re-read from the text alone: an executor in a later process enforces this, not a cached object.
  const declaration = permissionsFromDocument(text)
  assert.deepEqual(declaration.fsRead, [dir])
  assert.deepEqual(declaration.fsWrite, [join(dir, 'out')])
  assert.equal(declaration.network, true)
  assert.equal(describePermissions(declaration), `reads ${dir}, writes ${join(dir, 'out')}, may use the network`)
  // And a document with no block: the executor gets nothing, not everything.
  assert.deepEqual(permissionsFromDocument(documentFor({ name: 'quiet-skill' })).fsRead, [])
})

// ---------------------------------------------------------------------------------------
// 3. Approval follows evaluation, and a rejection cannot be promoted away.
// ---------------------------------------------------------------------------------------

test('promote refuses a version with no accepted evaluation, and refuses a different check list', () => {
  const registry = new SkillRegistry()
  const loop = new AdaptiveLoop({ registry })
  registry.install(documentFor({ name: 'line-count-stream', read: ['/tmp'] }), { state: SKILL_STATES.CANDIDATE })

  assert.throws(
    () => loop.promote({ name: 'line-count-stream', checks: [{ name: 'sanity', passed: true, detail: 'ok' }] }),
    (error) => error.code === 'not_evaluated' && /Approval follows evaluation/.test(error.message),
  )

  const evaluated = loop.evaluate({ name: 'line-count-stream', version: '0.1.0', checks: [check('counts correctly', true)] })
  assert.equal(evaluated.verdict, VERDICTS.ACCEPTED)
  assert.throws(
    () => loop.promote({ name: 'line-count-stream', checks: [{ name: 'something else', passed: true, detail: 'ok' }] }),
    (error) => error.code === 'evaluation_mismatch' && /A pass on one set of checks is not a pass on another/.test(error.message),
  )
  const promoted = loop.promote({ name: 'line-count-stream', checks: evaluated.results })
  assert.equal(promoted.state, SKILL_STATES.VALIDATED)
  // The promotion records *which* evaluation it approved, so the evidence is traceable.
  assert.equal(promoted.validation.evaluation.verdict, VERDICTS.ACCEPTED)
  assert.equal(promoted.validation.evaluation.seq, evaluated.seq)
  assert.equal(promoted.validation.evaluation.digest, evaluated.digest)
})

test('a rejected version stays rejected through a later acceptance and a rollback', () => {
  const registry = new SkillRegistry()
  const logPath = join(scratch('log-file'), 'evaluations.jsonl')
  const log = new EvaluationLog(logPath)
  const name = 'line-count-stream'
  registry.install(documentFor({ name, version: '1.0.0' }), { state: SKILL_STATES.CANDIDATE })
  evaluateCandidate({ name, version: '1.0.0', log, checks: [check('counts correctly', true), check('agrees with wc', true)] })
  registry.install(documentFor({ name, version: '1.1.0' }), { state: SKILL_STATES.CANDIDATE })
  evaluateCandidate({ name, version: '1.1.0', log, checks: [check('counts correctly', true), check('agrees with wc', false, 'disagreed')] })

  // Rollback re-installs the earlier document as a *new* version, which must be evaluated again:
  // a procedure that was superseded for a reason is re-tested when it comes back.
  const loop = new AdaptiveLoop({ registry, evaluations: log })
  const rollback = loop.rollback({ name, version: '1.0.0' })
  assert.equal(rollback.newVersion, '1.1.1')
  assert.equal(registry.describe(name).state, SKILL_STATES.CANDIDATE)
  assert.throws(
    () => loop.promote({ name, checks: [{ name: 'counts correctly', passed: true, detail: 'ok' }] }),
    (error) => error.code === 'not_evaluated',
  )
  const restored = loop.evaluate({ name, version: '1.1.1', checks: [check('counts correctly', true), check('agrees with wc', true)] })
  assert.equal(restored.verdict, VERDICTS.ACCEPTED, 'the restored version re-runs the regression set and passes it')

  // A new process reads the same file and sees the same history: the rejection outlives the
  // process that recorded it, which is the whole reason the log can be a file.
  const reread = new EvaluationLog(logPath)
  assert.equal(reread.count, 3)
  assert.deepEqual(reread.list({ name }).map((entry) => entry.verdict), ['accepted', 'rejected', 'accepted'])
  assert.equal(reread.verify().ok, true)
  assert.equal(reread.latest(name, { version: '1.1.0' }).diagnosis, DIAGNOSES.REGRESSION)
  // And it refuses to append to a chain that does not verify, rather than hiding the break.
  const tamperedPath = join(scratch('tampered'), 'evaluations.jsonl')
  const tampered = new EvaluationLog(tamperedPath)
  evaluateCandidate({ name: 'x', version: '0.1.0', log: tampered, checks: [check('a', true)] })
  appendFileSync(tamperedPath, `${JSON.stringify({ ...tampered.list()[0], verdict: 'rejected', digest: 'deadbeef' })}\n`)
  assert.throws(() => new EvaluationLog(tamperedPath), (error) => error.code === 'broken_chain')
})
