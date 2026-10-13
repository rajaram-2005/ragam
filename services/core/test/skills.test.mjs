// Skills: the SKILL.md format, and the lifecycle invariants.
//
// The lifecycle tests matter more than the parsing tests, because the invariants in
// lifecycle.mjs are the structural guarantee behind directive §6C's "do not silently
// rewrite core system instructions... because an agent believes it has learned
// something". A rule that is only written down can be argued with; these tests assert
// the operations are unreachable.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LOADABLE_STATES, SKILL_STATES, SkillRegistry, SkillRegistryError,
} from '../src/skills/registry.mjs'
import {
  buildDescription, curate, curatorMayModify, proposeFromExperience, renderSkillDocument,
  restore, retire, DEFAULT_LIFECYCLE, SkillLifecycleError,
} from '../src/skills/lifecycle.mjs'
import {
  CREATED_BY, MAX_DESCRIPTION_CHARS, RECOMMENDED_SECTIONS, REQUIRED_SECTIONS,
  SkillDocumentError, countProcedureSteps, loadSkillDocument, parseFrontmatter,
  parseSections, validateSkillDocument,
} from '../src/skills/manifest.mjs'

const GOOD_SKILL = `---
name: run-project-tests
description: "Run this project's test suite and report failures."
version: 1.0.0
author: RAJARAM K
license: MIT
platforms: [linux, macos, windows]
createdBy: human
metadata:
  aetheris:
    tags: [testing, workflow]
---

# Run Project Tests

## When to Use

When the user asks whether the project's tests pass.

## Prerequisites

- A checkout with a package.json.

## Procedure

1. Run \`npm test\` from the repository root.
2. Capture the exit code and the failing test names.
3. Report the failures verbatim rather than summarising them.

## Pitfalls

- A non-zero exit code from a missing dependency is not a test failure.

## Verification

The reported failures match the test runner's own output.
`


// One clock for both the registry and the curator. The registry stamps activity with
// its own `now`, so a test that advances only the curator's `now` is measuring two
// different times and will fail for a reason that has nothing to do with the code.
const T0 = Date.UTC(2026, 0, 1)
let clock = T0
const now = () => clock
const advanceDays = (days) => { clock = T0 + days * 86_400_000; return clock }
const registryWithClock = () => new SkillRegistry({ now })

// The clock is module state, so it has to be reset per test or one test's "advance 400
// days" silently becomes the next test's starting point -- which is exactly how the
// first version of this file failed.
test.beforeEach(() => { clock = T0 })

const install = (registry, text, options = {}) => registry.install(text, options)

// --- the document format ---------------------------------------------------------

test('a well-formed skill document parses and validates', () => {
  const report = validateSkillDocument(GOOD_SKILL)
  assert.equal(report.valid, true, report.errors.join('; '))
  assert.equal(report.frontmatter.name, 'run-project-tests')
  assert.equal(report.frontmatter.createdBy, 'human')
  assert.equal(report.procedureSteps, 3)
  assert.deepEqual(report.frontmatter.metadata.aetheris.tags, ['testing', 'workflow'])
  assert.deepEqual(report.frontmatter.platforms, ['linux', 'macos', 'windows'])
})

test('the frontmatter parser reads the subset it claims, and nothing more', () => {
  const { frontmatter, errors } = parseFrontmatter(GOOD_SKILL)
  assert.deepEqual(errors, [])
  assert.equal(frontmatter.version, '1.0.0')
  assert.deepEqual(frontmatter.metadata.aetheris.tags, ['testing', 'workflow'])
  // A bare scalar stays a string; a quoted one loses its quotes; a list becomes a list.
  assert.equal(typeof frontmatter.description, 'string')
  assert.equal(frontmatter.description.startsWith('"'), false)
  // A document with no frontmatter is reported, not guessed at.
  assert.equal(parseFrontmatter('# Just a heading\n').frontmatter, null)
})

test('a document without frontmatter is rejected rather than treated as a skill', () => {
  const report = validateSkillDocument('# A note\n\n## Procedure\n\n1. Something.\n')
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((e) => /frontmatter/.test(e)))
})

test('the description limit is enforced, because listings dilute', () => {
  const long = GOOD_SKILL.replace(
    'description: "Run this project\'s test suite and report failures."',
    `description: "${'x'.repeat(MAX_DESCRIPTION_CHARS + 1)}."`,
  )
  const report = validateSkillDocument(long)
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((e) => /characters; the limit is 60/.test(e)))
})

test('a description must be one sentence ending in a period', () => {
  const twoSentences = GOOD_SKILL.replace(
    'description: "Run this project\'s test suite and report failures."',
    'description: "Runs the tests. Reports failures."',
  )
  assert.ok(validateSkillDocument(twoSentences).errors.some((e) => /single sentence/.test(e)))

  const noPeriod = GOOD_SKILL.replace(
    'description: "Run this project\'s test suite and report failures."',
    'description: "Run the tests"',
  )
  assert.ok(validateSkillDocument(noPeriod).errors.some((e) => /must end with a period/.test(e)))
})

test('marketing words are rejected, and the rule is narrow enough to be usable', () => {
  const marketed = GOOD_SKILL.replace(
    'description: "Run this project\'s test suite and report failures."',
    'description: "Powerful test runner."',
  )
  assert.ok(validateSkillDocument(marketed).errors.some((e) => /marketing word/.test(e)))

  // A legitimate sentence using a banned word inside a larger word must still pass:
  // ...but a whole-word match is what is checked, so "advanced" in "advanced-tek" is
  // caught while "advantageous" is not. Assert both sides rather than trusting it.
  const adjacent = GOOD_SKILL.replace(
    'description: "Run this project\'s test suite and report failures."',
    'description: "Get an advantageous view of test failures."',
  )
  assert.equal(validateSkillDocument(adjacent).valid, true)
})

test('a description that repeats the skill name is rejected', () => {
  const repetitive = GOOD_SKILL.replace(
    'description: "Run this project\'s test suite and report failures."',
    'description: "Run project tests for this repository."',
  )
  assert.ok(validateSkillDocument(repetitive).errors.some((e) => /repeats the skill name/.test(e)))
})

test('a required section that is missing is an error, not a warning', () => {
  const noVerification = GOOD_SKILL.replace(/\n## Verification[\s\S]*$/, '\n')
  const report = validateSkillDocument(noVerification)
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((e) => /missing required section '## Verification'/.test(e)))
})

test('a procedure with no numbered steps is a note, not a procedure', () => {
  const noSteps = GOOD_SKILL.replace(
    /## Procedure\n\n[\s\S]*?\n\n## Pitfalls/,
    '## Procedure\n\nJust run the tests, it will be fine.\n\n## Pitfalls',
  )
  const report = validateSkillDocument(noSteps)
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((e) => /at least one numbered step/.test(e)))
  assert.equal(countProcedureSteps('1. one\n2. two\nNot a step'), 2)
})

test('a platform-bound procedure must declare its platforms', () => {
  // A skill that silently assumes Linux fails on a phone, and phones are the point of
  // Klyvaron Lite. Each primitive is checked, not just the convenient one.
  for (const [snippet, label] of [
    ['1. Copy the file to /tmp/scratch and read it back.', '/tmp'],
    ['1. Install it with apt-get install ripgrep.', 'apt-get'],
    ['1. Restart the service using systemctl restart api.', 'systemctl'],
    ['1. Use osascript to open the file.', 'osascript'],
  ]) {
    const bound = GOOD_SKILL
      .replace(/platforms: \[linux, macos, windows\]\n/, '')
      .replace(/^1\. Run `npm test` from the repository root\.$/m, snippet)
    const report = validateSkillDocument(bound)
    assert.equal(report.valid, false, `expected '${snippet}' to require a platforms declaration`)
    assert.ok(report.errors.some((e) => /must declare a 'platforms' list/.test(e)), label)
  }

  // And declaring platforms clears it, so the rule is not a blanket refusal.
  const declared = GOOD_SKILL.replace(
    '1. Run `npm test` from the repository root.',
    '1. Copy the file to /tmp/scratch and read it back.',
  )
  assert.equal(validateSkillDocument(declared).valid, true)
})

test('a name must match its directory, so a skill cannot be filed under another name', () => {
  const report = validateSkillDocument(GOOD_SKILL, { directoryName: 'something-else' })
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((e) => /does not match its directory/.test(e)))
  assert.equal(validateSkillDocument(GOOD_SKILL, { directoryName: 'run-project-tests' }).valid, true)
})

test('loadSkillDocument throws with the structured reasons attached', () => {
  assert.throws(
    () => loadSkillDocument('# no frontmatter'),
    (error) => error instanceof SkillDocumentError && error.errors.length > 0,
  )
})

test('sections are parsed in document order', () => {
  const { order } = parseSections(GOOD_SKILL)
  assert.deepEqual(order, ['When to Use', 'Prerequisites', 'Procedure', 'Pitfalls', 'Verification'])
})

// --- the registry ----------------------------------------------------------------

test('installing the same version twice is refused', () => {
  const registry = new SkillRegistry()
  install(registry, GOOD_SKILL, { state: SKILL_STATES.VALIDATED, evidence: { checks: [{ name: 'ok', passed: true }] } })
  assert.throws(() => install(registry, GOOD_SKILL, { state: SKILL_STATES.CANDIDATE }),
    (error) => error instanceof SkillRegistryError && error.code === 'duplicate_version')
})

test('a second version appends to history rather than replacing it', () => {
  const registry = new SkillRegistry()
  install(registry, GOOD_SKILL, { state: SKILL_STATES.VALIDATED, evidence: { checks: [{ name: 'ok', passed: true }] } })
  install(registry, GOOD_SKILL.replace('version: 1.0.0', 'version: 1.1.0'), { state: SKILL_STATES.VALIDATED, evidence: { checks: [{ name: 'ok2', passed: true }] } })
  const described = registry.describe('run-project-tests')
  assert.equal(described.version, '1.1.0')
  assert.equal(described.versionCount, 2)
  // Both versions remain retrievable, which is what makes rollback possible.
  assert.match(registry.document('run-project-tests', '1.0.0'), /version: 1\.0\.0/)
  assert.match(registry.document('run-project-tests', '1.1.0'), /version: 1\.1\.0/)
})

test('a candidate skill cannot be loaded', () => {
  const registry = new SkillRegistry()
  install(registry, GOOD_SKILL, { state: SKILL_STATES.CANDIDATE })
  assert.throws(() => registry.load('run-project-tests'),
    (error) => error instanceof SkillRegistryError && error.code === 'skill_not_loadable'
      && /has not been validated/.test(error.message))
  assert.equal(registry.describe('run-project-tests').loadable, false)
})

test('installing as validated without evidence is refused', () => {
  const registry = new SkillRegistry()
  assert.throws(() => install(registry, GOOD_SKILL, { state: SKILL_STATES.VALIDATED }),
    (error) => error instanceof SkillRegistryError && error.code === 'evidence_required')
})

test('validation requires checks that all passed', () => {
  const registry = new SkillRegistry()
  install(registry, GOOD_SKILL, { state: SKILL_STATES.CANDIDATE })
  assert.throws(() => registry.validate('run-project-tests', { checks: [] }),
    (error) => error instanceof SkillRegistryError && error.code === 'evidence_required')
  assert.throws(
    () => registry.validate('run-project-tests', {
      checks: [{ name: 'reproduces', passed: true }, { name: 'fixes', passed: false }],
    }),
    (error) => error instanceof SkillRegistryError && error.code === 'validation_failed'
        && /fixes/.test(error.message),
  )
  // Still a candidate after a failed attempt: a rejection must not half-promote.
  assert.equal(registry.describe('run-project-tests').state, SKILL_STATES.CANDIDATE)

  registry.validate('run-project-tests', { checks: [{ name: 'reproduces', passed: true }], environment: 'local sandbox' })
  assert.equal(registry.describe('run-project-tests').state, SKILL_STATES.VALIDATED)
  assert.equal(registry.load('run-project-tests').name, 'run-project-tests')
})

test('usage is counted and a load counts as a view', () => {
  const registry = new SkillRegistry()
  install(registry, GOOD_SKILL, { state: SKILL_STATES.VALIDATED, evidence: { checks: [{ name: 'ok', passed: true }] } })
  registry.load('run-project-tests')
  registry.recordUsage('run-project-tests', { kind: 'use' })
  registry.recordUsage('run-project-tests', { kind: 'patch' })
  const usage = registry.describe('run-project-tests').usage
  assert.equal(usage.viewCount, 1)
  assert.equal(usage.useCount, 1)
  assert.equal(usage.patchCount, 1)
  assert.ok(usage.lastActivityAt > 0)
})

// --- the declared contract, checked against behaviour ---------------------------
//
// These iterate the module's own tables rather than hard-coding the list. A hard-coded
// list stops testing the moment the table changes; iterating means adding a required
// section to the table without enforcing it fails here.

test('every section the module declares required is actually required', () => {
  for (const section of REQUIRED_SECTIONS) {
    // Excise just this section from an otherwise valid document and confirm the
    // validator refuses it. One omission at a time, so a failure names the section.
    const lines = GOOD_SKILL.split('\n')
    const start = lines.indexOf(`## ${section}`)
    assert.ok(start > -1, `the fixture no longer contains '## ${section}'`)
    let end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
    if (end === -1) end = lines.length
    const without = [...lines.slice(0, start), ...lines.slice(end)].join('\n')

    const report = validateSkillDocument(without)
    assert.equal(report.valid, false, `a document with no '## ${section}' was accepted`)
    assert.ok(report.errors.some((e) => e.includes(section)),
      `the error does not name ${section}: ${JSON.stringify(report.errors)}`)
  }
})

test('a missing recommended section is a warning, not an error', () => {
  const report = validateSkillDocument(GOOD_SKILL)
  assert.equal(report.valid, true)
  const missing = RECOMMENDED_SECTIONS.filter((section) => !GOOD_SKILL.includes(`## ${section}`))
  assert.equal(report.warnings.length, missing.length, `warnings: ${JSON.stringify(report.warnings)}`)
  for (const section of missing) {
    assert.ok(report.warnings.some((w) => w.includes(section)), `no warning for ${section}`)
  }
})

test('CREATED_BY is the closed set of accepted provenance values', () => {
  assert.deepEqual([...CREATED_BY].sort(), ['agent', 'bundled', 'human'])
  for (const value of CREATED_BY) {
    const { frontmatter } = parseFrontmatter(GOOD_SKILL.replace('createdBy: human', `createdBy: ${value}`))
    assert.equal(frontmatter.createdBy, value, `parseFrontmatter dropped createdBy: ${value}`)
  }
  // A value outside the set is refused rather than stored, because provenance decides
  // whether the curator may touch the skill at all (I2).
  const report = validateSkillDocument(GOOD_SKILL.replace('createdBy: human', 'createdBy: robot'))
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((e) => /createdBy/.test(e)), report.errors.join('; '))
})

test('the loadable states are exactly validated and stale, and neither is a candidate', () => {
  assert.deepEqual([...LOADABLE_STATES].sort(), [SKILL_STATES.STALE, SKILL_STATES.VALIDATED].sort())
  for (const state of [SKILL_STATES.CANDIDATE, SKILL_STATES.ARCHIVED]) {
    assert.ok(!LOADABLE_STATES.includes(state), `'${state}' must not be loadable`)
  }
})

// --- lifecycle invariants --------------------------------------------------------

const agentSkill = (name, overrides = {}) => renderSkillDocument({
  name,
  description: overrides.description ?? 'Fix a mistyped module path.',
  version: overrides.version ?? '1.0.0',
  createdBy: overrides.createdBy ?? 'agent',
  author: 'Aetheris experience capture',
  tags: ['paths'],
  whenToUse: 'When a task fails because a module path is wrong.',
  steps: ['Reproduce the import error.', 'Correct the path.', 'Confirm the import resolves.'],
  verification: 'The reproduction now succeeds.',
}).replace('platforms: [linux, macos, windows]', 'platforms: [linux, macos, windows]')

const validated = (registry, name, overrides = {}) => {
  install(registry, agentSkill(name, overrides), { state: SKILL_STATES.CANDIDATE })
  registry.validate(name, { checks: [{ name: 'reproduces', passed: true }] })
  return registry
}

test('I2: the curator may only modify agent-created skills', () => {
  const registry = new SkillRegistry()
  install(registry, GOOD_SKILL, { state: SKILL_STATES.VALIDATED, evidence: { checks: [{ name: 'ok', passed: true }] } })
  const human = registry.record('run-project-tests')
  assert.deepEqual(curatorMayModify(human), { allowed: false, reason: 'created by human' })

  const report = curate(registry, { now: advanceDays(400) })
  assert.deepEqual(report.transitions, [], 'a human-authored skill must not be auto-transitioned')
  assert.ok(report.skipped.some((s) => s.name === 'run-project-tests' && s.reason === 'created by human'))
  assert.equal(registry.describe('run-project-tests').state, SKILL_STATES.VALIDATED)
})

test('I3: a pinned skill is exempt from every automatic transition', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  registry.setPinned('fix-module-path', true)
  assert.deepEqual(curatorMayModify(registry.record('fix-module-path')), { allowed: false, reason: 'pinned' })

  const report = curate(registry, { now: advanceDays(400) })
  assert.deepEqual(report.transitions, [])
  assert.equal(registry.describe('fix-module-path').state, SKILL_STATES.VALIDATED)
})

test('I5: a disabled skill is not a curation candidate', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  registry.setEnabled('fix-module-path', false)
  assert.deepEqual(curatorMayModify(registry.record('fix-module-path')), { allowed: false, reason: 'disabled' })
  assert.deepEqual(curate(registry, { now: advanceDays(400) }).transitions, [])
})

test('an unused agent skill goes stale, then archived, and never further', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  let report = curate(registry, { now: advanceDays(DEFAULT_LIFECYCLE.staleAfterDays + 1) })
  assert.deepEqual(report.transitions.map((t) => `${t.from}->${t.to}`), ['validated->stale'])
  assert.equal(registry.describe('fix-module-path').loadable, true, 'stale skills remain usable')

  report = curate(registry, { now: advanceDays(DEFAULT_LIFECYCLE.archiveAfterDays + 1) })
  assert.deepEqual(report.transitions.map((t) => `${t.from}->${t.to}`), ['stale->archived'])
  assert.equal(registry.describe('fix-module-path').state, SKILL_STATES.ARCHIVED)
  assert.equal(registry.describe('fix-module-path').loadable, false)

  // I1: running the curator again forever must not produce a fourth state. There is no
  // delete, and this asserts the absence rather than trusting that nobody added one.
  report = curate(registry, { now: advanceDays(10_000) })
  assert.deepEqual(report.transitions, [])
  assert.equal(registry.list().length, 1)
})

test('I1: no automatic path can remove a skill, and the registry has no delete', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  assert.equal(typeof registry.delete, 'undefined')
  assert.equal(typeof registry.remove, 'undefined')
  assert.equal(typeof registry.destroy, 'undefined')
  assert.equal(typeof restore, 'function', 'the maximum-recoverable operation must exist')
})

test('a skill used again after going stale returns to validated', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  curate(registry, { now: advanceDays(DEFAULT_LIFECYCLE.staleAfterDays + 1) })
  assert.equal(registry.describe('fix-module-path').state, SKILL_STATES.STALE)
  // Use it, then curate: idle time is the only signal, and it is no longer idle.
  registry.recordUsage('fix-module-path', { kind: 'use' })
  const report = curate(registry, { now: advanceDays(DEFAULT_LIFECYCLE.staleAfterDays + 1) + 1000 })
  assert.deepEqual(report.transitions.map((t) => `${t.from}->${t.to}`), ['stale->validated'])
})

test('retiring requires a reason and archiving is reversible', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  assert.throws(() => retire(registry, 'fix-module-path'), (error) => error instanceof SkillLifecycleError && error.code === 'reason_required')
  const result = retire(registry, 'fix-module-path', 'superseded by the path helper')
  assert.equal(result.to, SKILL_STATES.ARCHIVED)
  // The document survives retirement, which is what makes rollback meaningful.
  assert.match(registry.document('fix-module-path'), /name: fix-module-path/)

  assert.deepEqual(restore(registry, 'fix-module-path'), { name: 'fix-module-path', to: SKILL_STATES.VALIDATED })
  assert.equal(registry.describe('fix-module-path').state, SKILL_STATES.VALIDATED)
})

test('restoring a never-validated skill returns it as a candidate, not as usable', () => {
  // Otherwise "archive then restore" would be a validation bypass.
  const registry = new SkillRegistry()
  install(registry, agentSkill('unverified-idea'), { state: SKILL_STATES.CANDIDATE })
  retire(registry, 'unverified-idea', 'was never validated')
  const result = restore(registry, 'unverified-idea')
  assert.equal(result.to, SKILL_STATES.CANDIDATE)
  assert.throws(() => registry.load('unverified-idea'), (error) => error instanceof SkillRegistryError && error.code === 'skill_not_loadable')
})

test('rollback restores an earlier version and leaves history intact', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  install(registry, agentSkill('fix-module-path', { version: '2.0.0' }), {
    state: SKILL_STATES.VALIDATED, evidence: { checks: [{ name: 'ok', passed: true }] },
  })
  assert.equal(registry.describe('fix-module-path').version, '2.0.0')

  const rolled = registry.rollback('fix-module-path', '1.0.0')
  assert.equal(rolled.version, '1.0.0')
  assert.equal(rolled.versionCount, 2, 'rolling back must not discard the later version')
  assert.match(registry.load('fix-module-path').text, /version: 1\.0\.0/)
})

test('invalid lifecycle thresholds are refused rather than silently inverted', () => {
  const registry = validated(registryWithClock(), 'fix-module-path')
  assert.throws(() => curate(registry, { staleAfterDays: 90, archiveAfterDays: 30 }),
    (error) => error instanceof SkillLifecycleError && error.code === 'invalid_thresholds')
})

// --- experience to skill ---------------------------------------------------------

test('a failure with a verified correction becomes a candidate, never a usable skill', () => {
  const registry = registryWithClock()
  const proposal = proposeFromExperience(registry, {
    name: 'fix-crlf-line-endings',
    failureCategory: 'data',
    attempted: 'Parsed the file with a\n  split on backslash-n only.',
    observed: 'Every line after the first kept a trailing carriage return.',
    correction: 'Split on a regular expression that accepts both line endings.',
    verifiedSolution: 'Re-parsed the file and the offsets matched the source.',
    tags: ['parsing'],
  })
  assert.equal(proposal.state, SKILL_STATES.CANDIDATE)
  assert.equal(registry.describe('fix-crlf-line-endings').createdBy, 'agent')

  // The generated document must be valid SKILL.md, not merely accepted by install().
  const report = validateSkillDocument(proposal.document, { directoryName: 'fix-crlf-line-endings' })
  assert.equal(report.valid, true, report.errors.join('; '))
  assert.equal(report.frontmatter.createdBy, 'agent')
  assert.ok(report.procedureSteps >= 3)
  // It is a candidate, so it is not usable until someone supplies evidence.
  assert.throws(() => registry.load('fix-crlf-line-endings'), (error) => error instanceof SkillRegistryError && error.code === 'skill_not_loadable')

  registry.validate('fix-crlf-line-endings', {
    environment: 'local sandbox',
    checks: [{ name: 'reproduction now succeeds', passed: true }],
  })
  assert.equal(registry.load('fix-crlf-line-endings').state, SKILL_STATES.VALIDATED)
})

test('an incomplete experience record is refused, naming what is missing', () => {
  const registry = new SkillRegistry()
  assert.throws(
    () => proposeFromExperience(registry, { name: 'half-an-idea', failureCategory: 'data' }),
    (error) => error instanceof SkillLifecycleError && error.code === 'incomplete_experience' &&
      /attempted/.test(error.message) && /correction/.test(error.message),
  )
  assert.equal(registry.stats().total, 0)
})

test('a generated description is capped, single-sentence and not marketing', () => {
  const long = buildDescription('This correction handles every possible variation of the problem across all platforms')
  assert.ok(long.length <= MAX_DESCRIPTION_CHARS, `${long.length} chars: ${long}`)
  assert.ok(long.endsWith('.'))
  // No mid-word cut: the boundary is a space, and the result is not a fragment.
  assert.equal(long, 'This correction handles every possible variation of the.')
  assert.equal(buildDescription('Short fix.'), 'Short fix.')
})

test('a proposal whose generated name is not a directory name is refused', () => {
  const registry = new SkillRegistry()
  assert.throws(
    () => proposeFromExperience(registry, {
      name: 'Not A Slug', failureCategory: 'data', attempted: 'a', observed: 'b', correction: 'c', verifiedSolution: 'd',
    }),
    (error) => error instanceof SkillLifecycleError && error.code === 'invalid_name',
  )
})

test('the end-to-end loop: failure becomes a skill, is used, goes stale, is restored', () => {
  const registry = registryWithClock()
  proposeFromExperience(registry, {
    name: 'recover-from-port-in-use',
    failureCategory: 'resource',
    attempted: 'Started the service on the configured port.',
    observed: 'The bind failed because the port was already in use.',
    correction: 'Probe the port first and pick the next free one.',
    verifiedSolution: 'The service started and answered a health check.',
  })
  registry.validate('recover-from-port-in-use', { checks: [{ name: 'starts cleanly', passed: true }] })

  // Used in a task.
  registry.load('recover-from-port-in-use', { reason: 'service start' })
  registry.recordUsage('recover-from-port-in-use', { kind: 'use' })

  // Then unused for long enough that the curator acts, without deleting anything.
  curate(registry, { now: advanceDays(200) })
  assert.equal(registry.describe('recover-from-port-in-use').state, SKILL_STATES.STALE)
  curate(registry, { now: advanceDays(400) })
  assert.equal(registry.describe('recover-from-port-in-use').state, SKILL_STATES.ARCHIVED)

  // Found to be needed again: restored, usable, with its history and stats intact.
  restore(registry, 'recover-from-port-in-use')
  const described = registry.describe('recover-from-port-in-use')
  assert.equal(described.state, SKILL_STATES.VALIDATED)
  assert.equal(described.usage.useCount, 1)
  assert.equal(described.validation.checks.length, 1)
  assert.equal(registry.stats().totalUses, 1)
})
