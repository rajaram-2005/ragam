// A release is a claim, and these tests are the cross-examination.
//
// Two halves: the pure verifier, tested against crafted states that *should* fail (a version
// disagreement, an undated changelog entry, a total the suite does not have, a pack citing
// evidence that is not there), and the repository itself, which must pass.
//
// The crafted failures matter more than the pass. A verifier that has only ever seen a good
// release is indistinguishable from one that returns `ok: true`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  verifyRelease,
  parseStatusTotals,
  parseReadmeTotals,
  parseChangelogEntry,
  collectReleaseState,
  assertReleasable,
  ReleaseError,
  RELEASE_ARTEFACTS,
} from '../src/release/manifest.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const GOOD_CHANGELOG = `# Changelog

## [9.9.9] — 2026-10-17

- one thing
- another thing
- a third thing
`

const GOOD_STATUS = `| Suite | Command | Tests |
|---|---|---|
| \`services/core\` | \`npm run test:core\` | **700 / 700** |
| \`services/fabric\` | \`pytest\` | **800 / 800** |
| \`apps/web\` | \`npm run test:web\` | **90 / 90** |

**Test totals: 1,590 passing**
`

const GOOD_README = '**1,590 tests: core 700, web 90, fabric 800.**\n'

const state = (overrides = {}) => ({
  version: '9.9.9',
  packageVersions: { 'package.json': '9.9.9' },
  changelog: GOOD_CHANGELOG,
  statusDoc: GOOD_STATUS,
  readme: GOOD_README,
  requiredFiles: { VERSION: true, 'CHANGELOG.md': true },
  measured: { core: 700, web: 90, fabric: 800 },
  packs: [],
  ...overrides,
})

test('a consistent release verifies', () => {
  const verdict = verifyRelease(state())
  assert.equal(verdict.ok, true, verdict.problems.join('; '))
  assert.equal(verdict.facts.totals.total, 1_590)
})

test('a version that disagrees with a package is refused', () => {
  const verdict = verifyRelease(state({ packageVersions: { 'package.json': '9.9.9', 'services/core/package.json': '0.1.0' } }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /services\/core\/package\.json: version '0\.1\.0' does not match VERSION '9\.9\.9'/)
})

test('a missing, undated or empty changelog entry is refused', () => {
  assert.equal(verifyRelease(state({ changelog: '# Changelog\n\n## [9.9.8] — 2026-01-01\n\n- old\n' })).ok, false)
  const undated = verifyRelease(state({ changelog: GOOD_CHANGELOG.replace(' — 2026-10-17', '') }))
  assert.equal(undated.ok, false)
  assert.match(undated.problems.join('\n'), /no date/)
  const empty = verifyRelease(state({ changelog: '# Changelog\n\n## [9.9.9] — 2026-10-17\n\nNothing changed.\n' }))
  assert.equal(empty.ok, false)
  assert.match(empty.problems.join('\n'), /0 bullets/)
})

test('a documented total the suites do not have is refused, in either direction', () => {
  const tooHigh = verifyRelease(state({ statusDoc: GOOD_STATUS.replace('**700 / 700**', '**701 / 701**') }))
  assert.equal(tooHigh.ok, false)
  assert.match(tooHigh.problems.join('\n'), /core total is 701, the measured suite has 700/)

  const staleGrandTotal = verifyRelease(state({ statusDoc: GOOD_STATUS.replace('**Test totals: 1,590 passing**', '**Test totals: 1,589 passing**') }))
  assert.equal(staleGrandTotal.ok, false)
  assert.match(staleGrandTotal.problems.join('\n'), /grand total is 1589, the measured suites sum to 1590/)

  const readmeDrift = verifyRelease(state({ readme: GOOD_README.replace('core 700', 'core 699') }))
  assert.equal(readmeDrift.ok, false)
  assert.match(readmeDrift.problems.join('\n'), /README\.md: states 699\/90\/800/)
})

test('documents that agree with each other but not with the suite are still refused', () => {
  // The failure mode this exists for: two documents share a stale number, so they corroborate
  // each other. Measured totals are the only authority.
  const bothWrong = verifyRelease(state({
    statusDoc: GOOD_STATUS.replace('**700 / 700**', '**650 / 650**').replace('**Test totals: 1,590 passing**', '**Test totals: 1,540 passing**'),
    readme: GOOD_README.replace('core 700', 'core 650').replace('1,590', '1,540'),
  }))
  assert.equal(bothWrong.ok, false)
  assert.equal(bothWrong.problems.filter((p) => /measured suite has 700|sum to 1590/.test(p)).length, 2)
})

test('a release with no measurements cannot verify its own numbers', () => {
  const verdict = verifyRelease(state({ measured: null }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /no suite totals were supplied/)
})

test('a required artefact that is missing is refused', () => {
  const verdict = verifyRelease(state({ requiredFiles: { VERSION: true, 'CHANGELOG.md': false } }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /CHANGELOG\.md: required for the release and missing/)
})

test('a pack citing evidence that is not in the release is refused', () => {
  const verdict = verifyRelease(state({
    packs: [{
      id: 'x.y',
      name: 'X pack',
      industry: 'engineering',
      version: '1.0.0',
      description: 'a test pack that cites evidence which is not present',
      restrictions: { dataClassFloor: 'internal' },
      capabilities: [{ tag: 'tree.line-count', evidence: 'src/does-not-exist.mjs' }],
      sources: [],
    }],
    evidenceExists: () => false,
  }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /cites 'src\/does-not-exist\.mjs', which is not in the release/)
})

test('a pack that does not validate is refused', () => {
  const verdict = verifyRelease(state({ packs: [{ id: 'x.y', name: 'X' }] }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /pack 'x\.y'/)
})

test('a malformed version is refused', () => {
  assert.equal(verifyRelease(state({ version: 'latest', packageVersions: {} })).ok, false)
  assert.equal(verifyRelease(state({ version: '9.9', packageVersions: {} })).ok, false)
})

test('assertReleasable throws a ReleaseError carrying every problem', () => {
  assert.throws(() => assertReleasable(state({ version: 'nope', measured: null })), (error) => {
    assert.ok(error instanceof ReleaseError)
    assert.equal(error.code, 'release_refused')
    assert.ok(error.problems.length >= 2)
    return true
  })
})

test('the parsers read the documented forms exactly and report absence rather than guessing', () => {
  assert.deepEqual(parseStatusTotals(GOOD_STATUS), { core: 700, total: 1_590, suites: { 'services/core': 700, 'services/fabric': 800, 'apps/web': 90 } })
  const inventoryStatus = readFileSync(resolve(REPO, 'docs/03-status.md'), 'utf8')
  assert.deepEqual(parseStatusTotals(inventoryStatus), { core: 952, total: 1_875, suites: { 'services/core': 952, 'services/fabric': 822, 'apps/web': 101 } })
  assert.deepEqual(parseStatusTotals('nothing here'), { core: null, total: null, suites: {} })
  assert.deepEqual(parseReadmeTotals(GOOD_README), { total: 1_590, core: 700, web: 90, fabric: 800 })
  assert.equal(parseReadmeTotals('no numbers'), null)
  assert.deepEqual(parseChangelogEntry(GOOD_CHANGELOG, '9.9.9'), { present: true, dated: true, bullets: 3, heading: '## [9.9.9] — 2026-10-17' })
  assert.equal(parseChangelogEntry(GOOD_CHANGELOG, '9.9.8').present, false)
})

test('this repository is releasable at the version it declares', async () => {
  // The measured totals come from the suites: run them with `--core`, `--web` and `--fabric`.
  // Here the repository's own documents are checked for internal consistency, and the version
  // identity is checked against the files. The totals check is exercised by the documents test
  // and the release script, which are given the measurements.
  const version = readFileSync(resolve(REPO, 'VERSION'), 'utf8').trim()
  assert.match(version, /^\d+\.\d+\.\d+$/)

  const collected = collectReleaseState(REPO, { measured: null })
  assert.equal(collected.version, version)
  for (const path of Object.keys(collected.packageVersions)) {
    assert.equal(collected.packageVersions[path], version, `${path} declares ${collected.packageVersions[path]}`)
  }
  for (const path of RELEASE_ARTEFACTS) {
    assert.equal(collected.requiredFiles[path], true, `${path} is required by the release and missing`)
  }
  const entry = parseChangelogEntry(collected.changelog, version)
  assert.equal(entry.present, true)
  assert.equal(entry.dated, true)
  assert.ok(entry.bullets >= 3)
})

test('the status document states every suite the release reports', () => {
  const statusDoc = readFileSync(resolve(REPO, 'docs/03-status.md'), 'utf8')
  const totals = parseStatusTotals(statusDoc)
  assert.ok(totals.core > 0)
  assert.ok(totals.total > totals.core)
  assert.equal(totals.suites['services/core'], totals.core)
  assert.equal(totals.suites['services/fabric'] + totals.suites['apps/web'] + totals.suites['services/core'], totals.total)
})
