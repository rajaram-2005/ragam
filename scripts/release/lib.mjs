// Shared, dependency-free release primitives.
//
// Everything in scripts/release uses only the Node standard library, so the
// release tools themselves have no supply chain to pin. The checksum *writer*
// uses node:crypto, while the checksum *verifier* deliberately shells out to
// `sha256sum -c`: two independent implementations, so a bug in one cannot make
// an unverified artifact look verified.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export const RELEASE_STATES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT TESTED', 'NOT APPLICABLE'])
export const QUALIFICATION_SCHEMA = 'ragam-release-qualification/1'

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

export function sha256OfText(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Write a POSIX `sha256sum`-compatible checksum file for the named files. */
export function writeChecksums(outDir, filePaths) {
  const sorted = [...filePaths].sort((a, b) => basename(a).localeCompare(basename(b)))
  const lines = sorted.map((path) => `${sha256OfFile(path)}  ${basename(path)}`)
  const target = join(outDir, 'SHA256SUMS')
  writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
  return { path: target, entries: lines.length }
}

/** Independent verification: the system `sha256sum`, not our own hashing code. */
export function verifyChecksumsWithSha256sum(outDir) {
  const target = join(outDir, 'SHA256SUMS')
  if (!existsSync(target)) return { ok: false, output: 'SHA256SUMS is missing' }
  const result = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: outDir, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { ok: result.status === 0 && !result.error, output, status: result.status }
}

function purlFor(name, version, ecosystem) {
  const clean = name.replace(/[^A-Za-z0-9._@/-]/g, '')
  return `pkg:${ecosystem}/${clean}@${version}`
}

/** A CycloneDX 1.5 SBOM built from the committed lockfiles, never from node_modules. */
export function collectSbom(root = REPO_ROOT, { version = '0.2.0', timestamp = new Date().toISOString() } = {}) {
  const components = []
  const sources = []
  const add = (name, pkgVersion, ecosystem, source) => {
    if (!name || !pkgVersion) return
    components.push({
      type: 'library',
      name,
      version: String(pkgVersion),
      'bom-ref': purlFor(name, String(pkgVersion), ecosystem),
      purl: purlFor(name, String(pkgVersion), ecosystem),
      properties: [{ name: 'ragam:lockfile', value: source }],
    })
  }
  for (const [lockPath, ecosystem] of [
    ['apps/web/package-lock.json', 'npm'],
    ['apps/desktop/package-lock.json', 'npm'],
  ]) {
    const full = join(root, lockPath)
    if (!existsSync(full)) continue
    const lock = readJson(full)
    sources.push({ path: lockPath, sha256: sha256OfFile(full), entries: Object.keys(lock.packages ?? {}).length - 1 })
    for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
      if (!key) continue
      const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key
      add(name, pkg.version, ecosystem, lockPath)
    }
  }
  const requirementsPath = 'services/fabric/requirements.lock'
  const requirements = join(root, requirementsPath)
  if (existsSync(requirements)) {
    sources.push({ path: requirementsPath, sha256: sha256OfFile(requirements), entries: 0 })
    for (const line of readFileSync(requirements, 'utf8').split('\n')) {
      const text = line.trim()
      if (!text || text.startsWith('#')) continue
      const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$/.exec(text)
      if (!match) continue
      sources[sources.length - 1].entries += 1
      add(match[1], match[2], 'pypi', requirementsPath)
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: null,
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: 'Ragam', name: 'scripts/release/lib.mjs' }],
      component: { type: 'application', name: 'ragam', version, 'bom-ref': `pkg:generic/ragam@${version}` },
      properties: [{ name: 'ragam:dependency-source', value: 'committed lockfiles only' }],
    },
    components,
    ragamSources: sources,
  }
}

/** Record what was built, from which commit, with which inputs. No signature claim. */
export function buildProvenance({ root = REPO_ROOT, version, commit, artifacts = [], sbomPath = null, timestamp = new Date().toISOString() } = {}) {
  const tree = spawnSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: root, encoding: 'utf8' })
  const lockPaths = ['apps/web/package-lock.json', 'apps/desktop/package-lock.json', 'services/fabric/requirements.lock']
  return {
    schema: 'ragam-build-provenance/1',
    version,
    commit,
    tree: tree.status === 0 ? tree.stdout.trim() : null,
    cleanCheckout: true,
    cleanCheckoutMethod: 'git archive <commit> extracted into an empty temporary directory; no working-tree files are used',
    producedAt: timestamp,
    builder: {
      id: 'ragam-local-release-builder',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      npm: null,
    },
    inputs: lockPaths.map((path) => ({ path, sha256: existsSync(join(root, path)) ? sha256OfFile(join(root, path)) : null })),
    artifacts: artifacts.map((path) => ({
      name: basename(path),
      bytes: readFileSync(path).length,
      sha256: sha256OfFile(path),
    })),
    sbom: sbomPath ? { path: basename(sbomPath), sha256: sha256OfFile(sbomPath) } : null,
    signature: { status: 'UNSIGNED', reason: 'no authorized signing key configured', requirement: 'RAGAM_RELEASE_SIGNING_KEY_ID and RAGAM_RELEASE_SIGNING_KEY_FILE' },
    reproducibility: {
      strategy: 'git archive | gzip -n for the source artifact; sorted tar with fixed owner/mode/mtime | gzip -n for the web bundle',
      note: 'Rebuild from the recorded commit with the recorded lockfiles and compare SHA-256 digests.',
    },
  }
}

/**
 * Validate a machine-readable qualification report. A gate is a claim, so the
 * report is refused when a PASS has no evidence, when a BLOCKED has no exact
 * unblock requirement, or when a live-credential gate is marked PASS without a
 * real call log. This is what stops BLOCKED/NOT TESTED being laundered into PASS.
 */
export function validateQualificationReport(report) {
  const problems = []
  if (!report || typeof report !== 'object') return { ok: false, problems: ['report is not an object'] }
  if (report.schema !== QUALIFICATION_SCHEMA) problems.push(`schema must be ${QUALIFICATION_SCHEMA}`)
  if (!Array.isArray(report.gates) || report.gates.length === 0) problems.push('gates must be a non-empty array')
  const ids = new Set()
  let nonPassMandatory = 0
  for (const gate of report.gates ?? []) {
    if (!gate.id || ids.has(gate.id)) problems.push(`duplicate or missing gate id: ${gate.id}`)
    ids.add(gate.id)
    if (!RELEASE_STATES.includes(gate.status)) problems.push(`${gate.id}: invalid status '${gate.status}'`)
    if (typeof gate.mandatory !== 'boolean') problems.push(`${gate.id}: mandatory must be boolean`)
    if (!gate.name) problems.push(`${gate.id}: name is required`)
    if (gate.mandatory && gate.status !== 'PASS') nonPassMandatory += 1
    if (gate.status === 'PASS') {
      const evidence = gate.evidence ?? []
      if (!Array.isArray(evidence) || evidence.length === 0) problems.push(`${gate.id}: PASS without evidence`)
      else if (!evidence.some((item) => item && (item.command || item.log || item.testId || item.artifact || item.runId))) {
        problems.push(`${gate.id}: PASS evidence has no command, log, testId, artifact or runId`)
      }
    }
    if (gate.status === 'BLOCKED' && (!gate.unblock || !String(gate.unblock).trim())) {
      problems.push(`${gate.id}: BLOCKED without an exact unblock requirement`)
    }
    if (gate.status === 'NOT APPLICABLE' && (!gate.justification || !String(gate.justification).trim())) {
      problems.push(`${gate.id}: NOT APPLICABLE without justification`)
    }
    if (gate.requiresLiveCredential && gate.status === 'PASS' && !gate.liveCredentialEvidence?.callLog) {
      problems.push(`${gate.id}: live-credential gate marked PASS without a real call log`)
    }
    if (gate.status === 'PASS' && gate.live === true && !gate.liveCredentialEvidence?.callLog) {
      problems.push(`${gate.id}: live gate marked PASS without a real call log`)
    }
  }
  for (const provider of report.providers ?? []) {
    if (!RELEASE_STATES.includes(provider.status)) problems.push(`provider ${provider.id}: invalid status`)
    if (!provider.configField) problems.push(`provider ${provider.id}: no exact config field`)
    if (provider.status === 'PASS' && !provider.liveCredentialEvidence?.callLog) {
      problems.push(`provider ${provider.id}: live-qualified PASS without a real call log`)
    }
    if (provider.status === 'BLOCKED' && !provider.unblock) problems.push(`provider ${provider.id}: BLOCKED without unblock`)
  }
  const expectedVerdict = nonPassMandatory > 0 ? 'NOT RELEASE READY' : 'TECHNICALLY QUALIFIED'
  if (report.finalVerdict !== expectedVerdict) {
    problems.push(`finalVerdict must be ${expectedVerdict} with ${nonPassMandatory} non-PASS mandatory gates, got '${report.finalVerdict}'`)
  }
  if (report.releasePublished !== false) problems.push('releasePublished must be false; publication requires separate explicit owner authorization')
  return { ok: problems.length === 0, problems, nonPassMandatory }
}

/** Resolve a git-tracked path relative to the repository root. */
export const atRoot = (path) => resolve(REPO_ROOT, path)
