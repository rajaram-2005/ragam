// Release verification.
//
// Phase 10's "release" is not a tag with a date on it. The rules this project has been held to
// make a release a *claim*, and a claim has to be checkable by somebody who does not trust the
// person making it. So the release tool answers one question: **can every number in the release
// documentation be reproduced from the repository and the measured suites?**
//
// A release is refused when:
//
//   * the version in `VERSION` and the versions in the three packages disagree — a release with
//     three versions is three releases;
//   * `CHANGELOG.md` has no entry for the version, or an entry with no date or nothing in it;
//   * a document states a suite total that the measured run does not have, or the documents
//     disagree with each other about it;
//   * a file the release notes rely on is missing;
//   * a shipped pack cites evidence that is not there, or does not validate;
//   * any of the required release artefacts is absent.
//
// The verifier is pure: everything it needs is passed in. `collectReleaseState()` is the thin
// layer that reads the filesystem, and it exists separately so the checks can be tested against
// crafted documents without a repository — including the documents that *should* fail.

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { BUILTIN_PACKS } from '../packs/builtin.mjs'
import { validatePack } from '../packs/manifest.mjs'

export const RELEASE_ARTEFACTS = Object.freeze([
  'VERSION',
  'CHANGELOG.md',
  'README.md',
  'LICENSE',
  'package.json',
  'docs/02-architecture.md',
  'docs/03-status.md',
  'docs/04-setup.md',
  'docs/25-adaptive-intelligence.md',
  'docs/26-release.md',
  // The benchmark is evidence for a claim in the release note, so its absence is a release
  // problem rather than a missing convenience file.
  'docs/experiments/phase10-benchmark.json',
  'docs/model-cards/klyvaron-pro-lm-0.1.0.json',
  'docs/model-cards/klyvaron-max-lm-0.1.0.json',
  'docs/model-cards/klyvaron-pro-image-0.1.0.json',
  'docs/model-cards/klyvaron-max-image-0.1.0.json',
  'docs/model-cards/klyvaron-pro-video-0.1.0.json',
  'docs/model-cards/klyvaron-max-video-0.1.0.json',
  'docs/model-cards/klyvaron-pro-voice-0.1.0.json',
  'docs/model-cards/klyvaron-max-voice-0.1.0.json',
  'docs/experiments/klyvaron-pro-lm-run.json',
  'docs/experiments/klyvaron-max-lm-run.json',
  'docs/experiments/klyvaron-pro-image-run.json',
  'docs/experiments/klyvaron-max-image-run.json',
  'docs/experiments/klyvaron-pro-video-run.json',
  'docs/experiments/klyvaron-max-video-run.json',
  'docs/experiments/klyvaron-pro-voice-run.json',
  'docs/experiments/klyvaron-max-voice-run.json',
  'third-party/NOTICES.md',
])

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i

export class ReleaseError extends Error {
  constructor(message, problems = []) {
    super(message)
    this.name = 'ReleaseError'
    this.code = 'release_refused'
    this.problems = problems
  }
}

/** Read a file as text, or null when it is not there. */
function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function digestOf(text) {
  return createHash('sha256').update(text ?? '').digest('hex')
}

/**
 * Extract the suite totals a status document states.
 *
 * Accepts the historical pass-count form (`**775 / 775**`, `**Test totals: 1681 passing`) and
 * the inventory form (`**775 tests**`, `**Test inventory: 1681 cases**`). The latter avoids
 * claiming every test passed when a local run was blocked by environment prerequisites. A verifier
 * that guessed at near-misses would pass documents whose numbers were nearly right.
 */
export function parseStatusTotals(statusDoc = '') {
  const legacyCore = /\*\*(\d[\d,]*) \/ \1\*\*/.exec(statusDoc)
  const total = /\*\*(?:Test totals: (\d[\d,]*) passing|Test inventory: (\d[\d,]*) cases)\b/.exec(statusDoc)
  const perSuite = [...statusDoc.matchAll(/\| `(services\/core|services\/fabric|apps\/web)` \|[^|]*\| \*\*(?:(\d[\d,]*) \/ \2|(\d[\d,]*) tests?)\*\*/g)]
    .map((match) => [match[1], Number((match[2] ?? match[3]).replace(/,/g, ''))])
  const suites = Object.fromEntries(perSuite)
  return {
    core: suites['services/core'] ?? (legacyCore ? Number(legacyCore[1].replace(/,/g, '')) : null),
    total: total ? Number((total[1] ?? total[2]).replace(/,/g, '')) : null,
    suites,
  }
}

/** Extract the README's one-line totals, in the form the docs tests require. */
export function parseReadmeTotals(readme = '') {
  const line = /(\d[\d,]*) tests: core (\d[\d,]*), web (\d[\d,]*), fabric (\d[\d,]*)/.exec(readme)
  if (!line) return null
  return {
    total: Number(line[1].replace(/,/g, '')),
    core: Number(line[2].replace(/,/g, '')),
    web: Number(line[3].replace(/,/g, '')),
    fabric: Number(line[4].replace(/,/g, '')),
  }
}

/** Does the changelog carry a real entry for this version? */
export function parseChangelogEntry(changelog = '', version) {
  const lines = String(changelog).split('\n')
  const start = lines.findIndex((line) => new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`).test(line))
  if (start === -1) return { present: false, dated: false, bullets: 0 }
  const heading = lines[start]
  const dated = / — \d{4}-\d{2}-\d{2}\s*$/.test(heading)
  let bullets = 0
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## \[/.test(lines[i])) break
    if (/^\s*[-*] \S/.test(lines[i])) bullets += 1
  }
  return { present: true, dated, bullets, heading: heading.trim() }
}

/**
 * Verify a release from its parts. Pure: no filesystem, no clock beyond what is passed.
 *
 * @param {object} state
 * @param {string} state.version
 * @param {Record<string,string>} state.packageVersions  { 'package.json': '0.2.0', ... }
 * @param {string} state.changelog
 * @param {string} state.statusDoc
 * @param {string} state.readme
 * @param {Record<string,boolean>} state.requiredFiles  path -> exists
 * @param {{core:number,web:number,fabric:number}} state.measured
 * @param {object[]} [state.packs]
 */
export function verifyRelease(state) {
  const problems = []
  const { version, packageVersions = {}, changelog = '', statusDoc = '', readme = '', requiredFiles = {}, measured = null, packs = BUILTIN_PACKS } = state ?? {}

  if (!SEMVER.test(String(version ?? ''))) problems.push(`VERSION: '${version}' is not a semantic version`)

  // One version, or it is not one release.
  for (const [path, claimed] of Object.entries(packageVersions)) {
    if (claimed !== version) problems.push(`${path}: version '${claimed}' does not match VERSION '${version}'`)
  }

  const entry = parseChangelogEntry(changelog, version)
  if (!entry.present) problems.push(`CHANGELOG.md: no entry for '${version}'`)
  else {
    if (!entry.dated) problems.push(`CHANGELOG.md: the '${version}' heading has no date ("— YYYY-MM-DD")`)
    if (entry.bullets < 3) problems.push(`CHANGELOG.md: the '${version}' entry has ${entry.bullets} bullet${entry.bullets === 1 ? '' : 's'}; a release with less to say than that is not a release`)
  }

  for (const [path, exists] of Object.entries(requiredFiles)) {
    if (!exists) problems.push(`${path}: required for the release and missing`)
  }

  // The numbers. Stated documents are checked against the measured run, not against each other
  // alone: two documents agreeing on a wrong number is exactly how a total drifts.
  if (!measured) {
    problems.push('measured: no suite totals were supplied, so the documented totals cannot be checked')
  } else {
    const total = measured.core + measured.web + measured.fabric
    const stated = parseStatusTotals(statusDoc)
    if (stated.suites['services/core'] !== measured.core) {
      problems.push(`docs/03: core total is ${stated.suites['services/core'] ?? 'unstated'}, the measured suite has ${measured.core}`)
    }
    if (stated.suites['services/fabric'] !== undefined && stated.suites['services/fabric'] !== measured.fabric) {
      problems.push(`docs/03: fabric total is ${stated.suites['services/fabric']}, the measured suite has ${measured.fabric}`)
    }
    if (stated.suites['apps/web'] !== undefined && stated.suites['apps/web'] !== measured.web) {
      problems.push(`docs/03: web total is ${stated.suites['apps/web']}, the measured suite has ${measured.web}`)
    }
    if (stated.total !== total) {
      problems.push(`docs/03: grand total is ${stated.total ?? 'unstated'}, the measured suites sum to ${total}`)
    }
    const readmeTotals = parseReadmeTotals(readme)
    if (!readmeTotals) {
      problems.push('README.md: no suite totals line in the documented form')
    } else {
      if (readmeTotals.total !== total || readmeTotals.core !== measured.core || readmeTotals.web !== measured.web || readmeTotals.fabric !== measured.fabric) {
        problems.push(`README.md: states ${readmeTotals.core}/${readmeTotals.web}/${readmeTotals.fabric} (${readmeTotals.total}), measured ${measured.core}/${measured.web}/${measured.fabric} (${total})`)
      }
    }
  }

  // A pack is a capability claim, so the release carries the same rule the tier records do:
  // no claim without an artifact.
  for (const pack of packs) {
    try {
      const validated = validatePack(pack)
      for (const capability of validated.capabilities) {
        if (capability.unimplemented) continue
        if (state.evidenceExists && !state.evidenceExists(capability.evidence)) {
          problems.push(`pack '${validated.id}': capability '${capability.tag}' cites '${capability.evidence}', which is not in the release`)
        }
      }
    } catch (error) {
      problems.push(`pack '${pack?.id ?? '(unnamed)'}': ${(error.problems ?? [error.message]).join('; ')}`)
    }
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    facts: Object.freeze({
      version,
      totals: measured ? Object.freeze({ ...measured, total: measured.core + measured.web + measured.fabric }) : null,
      changelog: Object.freeze({ ...entry }),
      artefacts: Object.keys(requiredFiles).length,
      packs: packs.length,
    }),
  })
}

/** Read the repository into the shape `verifyRelease` takes. */
export function collectReleaseState(repoRoot, { measured, packs = BUILTIN_PACKS } = {}) {
  const packageVersions = {}
  for (const path of ['package.json', 'services/core/package.json', 'apps/web/package.json']) {
    const text = read(join(repoRoot, path))
    if (text === null) continue
    try {
      packageVersions[path] = JSON.parse(text).version ?? null
    } catch {
      packageVersions[path] = '(unparseable)'
    }
  }
  const requiredFiles = Object.fromEntries(RELEASE_ARTEFACTS.map((path) => [path, existsSync(join(repoRoot, path))]))
  return {
    version: (read(join(repoRoot, 'VERSION')) ?? '').trim(),
    packageVersions,
    changelog: read(join(repoRoot, 'CHANGELOG.md')) ?? '',
    statusDoc: read(join(repoRoot, 'docs/03-status.md')) ?? '',
    readme: read(join(repoRoot, 'README.md')) ?? '',
    requiredFiles,
    measured,
    packs,
    evidenceExists: (path) => existsSync(join(repoRoot, path)),
  }
}

/** Verify, and refuse with an exception when the release cannot be supported. */
export function assertReleasable(state) {
  const verdict = verifyRelease(state)
  if (!verdict.ok) throw new ReleaseError(`release refused: ${verdict.problems.length} problem${verdict.problems.length === 1 ? '' : 's'}`, verdict.problems)
  return verdict
}

/**
 * A release manifest: what was released, and the digest of every artefact the release notes cite.
 *
 * The digests are what make the manifest worth committing: a reader can recompute them and see
 * whether the release they received is the one that was verified.
 */
export function buildReleaseManifest(state, { paths = [], root = null } = {}) {
  const verdict = assertReleasable(state)
  const digests = {}
  for (const path of paths) {
    const text = read(path)
    // Keys are repo-relative when a root is supplied: an absolute path in a committed manifest
    // records this machine rather than this release.
    const key = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    digests[key] = text === null ? null : digestOf(text)
  }
  return Object.freeze({
    // A release manifest is only meaningful if it says *what* it verified.
    schema: 'aetheris-release-manifest/1',
    version: verdict.facts.version,
    totals: verdict.facts.totals,
    changelog: verdict.facts.changelog,
    artefacts: Object.freeze(digests),
    verified: true,
    problems: verdict.problems,
  })
}
