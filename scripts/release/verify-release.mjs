#!/usr/bin/env node
// Independently verify a staged release bundle.
//
//   node scripts/release/verify-release.mjs --dir build/release/0.2.0
//
// Checksums are checked with the system `sha256sum -c` (a different
// implementation from the writer), then every manifest digest is recomputed,
// provenance is checked against the git object database, and the machine-
// readable qualification report is validated for status/evidence integrity.

import { existsSync, readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, atRoot, readJson, sha256OfFile, verifyChecksumsWithSha256sum, validateQualificationReport } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const out = resolve(flag('dir', 'build/release'))
const problems = []
const checks = []

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (!ok) problems.push(`${name}: ${detail}`)
}

if (!existsSync(out)) {
  console.error(`release directory does not exist: ${out}`)
  process.exit(2)
}

// 1. Independent checksum verification.
const sums = verifyChecksumsWithSha256sum(out)
check('sha256sum -c SHA256SUMS', sums.ok, sums.output.split('\n').slice(-3).join(' | '))

// 2. Manifest digests recomputed with node:crypto.
const manifestPath = `${out}/manifest.json`
if (!existsSync(manifestPath)) {
  check('manifest.json exists', false, 'missing')
} else {
  const manifest = readJson(manifestPath)
  check('manifest declares UNSIGNED', manifest.signed === false && manifest.unsigned === true, `signed=${manifest.signed}`)
  check('manifest declares no publication', manifest.published === false, `published=${manifest.published}`)
  for (const entry of manifest.artifacts ?? []) {
    const path = `${out}/${entry.name}`
    const ok = existsSync(path) && sha256OfFile(path) === entry.sha256
    check(`artifact ${entry.name}`, ok, ok ? `${entry.bytes} bytes` : 'digest mismatch or missing')
  }
  const sumsPath = `${out}/${manifest.checksumFile?.name ?? 'SHA256SUMS'}`
  check('SHA256SUMS digest', existsSync(sumsPath) && sha256OfFile(sumsPath) === manifest.checksumFile.sha256,
    existsSync(sumsPath) ? sha256OfFile(sumsPath) : 'missing')
  check('SBOM digest', existsSync(`${out}/${manifest.sbom.name}`) && sha256OfFile(`${out}/${manifest.sbom.name}`) === manifest.sbom.sha256, 'sbom.cdx.json')
  check('provenance digest', existsSync(`${out}/${manifest.provenance.name}`) && sha256OfFile(`${out}/${manifest.provenance.name}`) === manifest.provenance.sha256, 'provenance.json')

  // 3. Provenance commit must be a real object in this repository.
  const provenance = readJson(`${out}/${manifest.provenance.name}`)
  const object = spawnSync('git', ['cat-file', '-e', `${provenance.commit}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' })
  check('provenance commit resolves', object.status === 0, provenance.commit)
  const tree = spawnSync('git', ['rev-parse', `${provenance.commit}^{tree}`], { cwd: REPO_ROOT, encoding: 'utf8' })
  check('provenance tree matches commit', tree.status === 0 && tree.stdout.trim() === provenance.tree, `${provenance.tree} vs ${tree.stdout.trim()}`)
  check('provenance clean checkout', provenance.cleanCheckout === true, provenance.cleanCheckoutMethod)
  check('VERSION matches manifest', readFileSync(atRoot('VERSION'), 'utf8').trim() === manifest.version, manifest.version)
}

// 4. Qualification report integrity (PASS evidence, BLOCKED unblock, no laundering).
const reportPath = flag('report', 'docs/release/qualification.json')
const fullReport = atRoot(reportPath)
if (!existsSync(fullReport)) {
  check('qualification report exists', false, reportPath)
} else {
  const report = readJson(fullReport)
  const verdict = validateQualificationReport(report)
  check('qualification report schema and statuses', verdict.ok, verdict.problems.slice(0, 6).join('; '))
  check('no mandatory gate laundered to PASS', verdict.nonPassMandatory > 0 ? report.finalVerdict === 'NOT RELEASE READY' : true,
    `${verdict.nonPassMandatory} non-PASS mandatory gates`)
}

for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
if (problems.length) {
  console.error(`\nverification refused: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`\nverified ${checks.length} independent checks for ${basename(out)}`)
