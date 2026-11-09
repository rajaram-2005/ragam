#!/usr/bin/env node
// Fail-closed commercial SAST/DAST qualification workflow.
//
//   npm run release:sast-dast
//
// This repository contains no commercial SAST/DAST product, license or
// credential. Without every explicit owner-authorized input this script exits
// 2, writes no evidence and names the exact requirements. It NEVER runs a tool
// or claims a scan on its own.
//
// With all inputs, it executes the owner-provided licensed tool command, reads
// its normalized JSON report from outside the repository, verifies the exact
// commit, the expected SHA-256, zero critical/high findings and the completed
// scan flag, then writes only a privacy-preserving summary evidence file. Raw
// tool output, raw findings, credentials and prompts are never written into
// the repository.
//
// Required environment variables:
//   RAGAM_SAST_DAST_AUTHORIZED_BY     repository owner who authorized the scan
//   RAGAM_SAST_DAST_PRODUCT           commercial product name/version
//   RAGAM_SAST_DAST_LICENSE_CONFIRM   exactly YES
//   RAGAM_SAST_DAST_COMMAND           shell command invoking the licensed tool
//   RAGAM_SAST_DAST_REPORT            absolute report path outside the repo
//   RAGAM_SAST_DAST_REPORT_SHA256     expected SHA-256 of that report
//   RAGAM_SAST_DAST_COMMIT            exact 40-character commit SHA scanned
//   RAGAM_SAST_DAST_CONFIRM           exactly YES

import { existsSync, rmSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, readJson, writeJson, sha256OfFile } from './lib.mjs'

const repoRoot = resolve(REPO_ROOT)
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const out = resolve(flag('out', 'docs/release/evidence/commercial-sast-dast.json'))
const requestedCommit = flag('commit', null)

const REQUIRED = [
  ['RAGAM_SAST_DAST_AUTHORIZED_BY', 'identity of the repository owner who authorized this scan'],
  ['RAGAM_SAST_DAST_PRODUCT', 'commercial SAST/DAST product name and version'],
  ['RAGAM_SAST_DAST_LICENSE_CONFIRM', 'must be exactly YES after verifying the license entitlement'],
  ['RAGAM_SAST_DAST_COMMAND', 'shell command that runs the licensed tool and writes the normalized JSON report'],
  ['RAGAM_SAST_DAST_REPORT', 'absolute path to the normalized JSON report, outside this repository'],
  ['RAGAM_SAST_DAST_REPORT_SHA256', 'expected SHA-256 of the normalized JSON report, supplied independently'],
  ['RAGAM_SAST_DAST_COMMIT', 'exact 40-character commit SHA that the tool scanned'],
  ['RAGAM_SAST_DAST_CONFIRM', 'must be exactly YES to confirm explicit owner authorization'],
]

function refuse(missing) {
  console.error('commercial SAST/DAST refused: no authorized product/license/report is configured.')
  for (const [name, why] of missing) console.error(`  missing ${name} — ${why}`)
  console.error('  No scan was executed and no evidence file was written. The gate remains NOT TESTED.')
  console.error('  Exact requirement: set all eight RAGAM_SAST_DAST_* variables listed above, run the licensed tool against the exact commit, then re-run this script.')
  rmSync(out, { force: true })
  process.exit(2)
}

const missing = REQUIRED.filter(([name]) => !process.env[name]?.trim())
if (missing.length) refuse(missing)
for (const name of ['RAGAM_SAST_DAST_LICENSE_CONFIRM', 'RAGAM_SAST_DAST_CONFIRM']) {
  if (process.env[name] !== 'YES') {
    console.error(`commercial SAST/DAST refused: ${name} must be exactly 'YES'.`)
    rmSync(out, { force: true })
    process.exit(2)
  }
}

const commit = requestedCommit ?? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error('commercial SAST/DAST refused: the resolved commit is not a 40-character SHA.')
  rmSync(out, { force: true })
  process.exit(2)
}
if (process.env.RAGAM_SAST_DAST_COMMIT !== commit) {
  console.error(`commercial SAST/DAST refused: report commit ${process.env.RAGAM_SAST_DAST_COMMIT} does not match ${commit}.`)
  rmSync(out, { force: true })
  process.exit(2)
}
const reportPath = resolve(process.env.RAGAM_SAST_DAST_REPORT)
if (reportPath === repoRoot || reportPath.startsWith(`${repoRoot}/`)) {
  console.error('commercial SAST/DAST refused: the raw report must stay outside the repository.')
  rmSync(out, { force: true })
  process.exit(2)
}
if (!/^[0-9a-f]{64}$/.test(process.env.RAGAM_SAST_DAST_REPORT_SHA256)) {
  console.error('commercial SAST/DAST refused: RAGAM_SAST_DAST_REPORT_SHA256 must be a 64-character SHA-256 digest.')
  rmSync(out, { force: true })
  process.exit(2)
}

// The owner-provided command is intentionally not logged: it may contain a
// license token or endpoint credential. Only its exit status is recorded.
const tool = spawnSync('/bin/sh', ['-c', process.env.RAGAM_SAST_DAST_COMMAND], {
  cwd: repoRoot,
  env: process.env,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 30 * 60 * 1000,
})
if (tool.error) {
  console.error(`commercial SAST/DAST failed: could not start the licensed tool (${tool.error.message}).`)
  rmSync(out, { force: true })
  process.exit(1)
}
if (tool.status !== 0) {
  console.error(`commercial SAST/DAST failed: licensed tool exited ${tool.status}; raw output withheld.`)
  rmSync(out, { force: true })
  process.exit(1)
}
if (!existsSync(reportPath)) {
  console.error('commercial SAST/DAST failed: the authorized report was not produced; raw command withheld.')
  rmSync(out, { force: true })
  process.exit(1)
}

const actualSha256 = sha256OfFile(reportPath)
if (actualSha256 !== process.env.RAGAM_SAST_DAST_REPORT_SHA256) {
  console.error(`commercial SAST/DAST failed: report SHA-256 ${actualSha256} does not match the independently supplied digest.`)
  rmSync(out, { force: true })
  process.exit(1)
}

let report
try {
  report = readJson(reportPath)
} catch (error) {
  console.error(`commercial SAST/DAST failed: report could not be parsed (${error.message}).`)
  rmSync(out, { force: true })
  process.exit(1)
}
const findings = Array.isArray(report.findings) ? report.findings : null
const problems = []
if (report.schema !== 'ragam-commercial-sast-dast-report/1') problems.push('unexpected report schema')
if (report.product !== process.env.RAGAM_SAST_DAST_PRODUCT) problems.push('product does not match the authorized product')
if (report.commit !== commit) problems.push('report commit does not match the exact commit')
if (report.authorizedBy !== process.env.RAGAM_SAST_DAST_AUTHORIZED_BY) problems.push('authorizedBy does not match the owner')
if (report.licenseConfirmed !== true) problems.push('license is not confirmed in the report')
if (report.scanCompleted !== true) problems.push('scan is not marked completed')
if (report.criticalFindings !== 0) problems.push(`${report.criticalFindings} critical findings`)
if (report.highFindings !== 0) problems.push(`${report.highFindings} high findings`)
if (!findings) problems.push('findings array is missing')
else if (findings.some((entry) => ['critical', 'high'].includes(String(entry?.severity).toLowerCase()))) problems.push('findings array contains a critical/high severity entry')
if (problems.length) {
  console.error(`commercial SAST/DAST failed: ${problems.join('; ')}.`)
  rmSync(out, { force: true })
  process.exit(1)
}

writeJson(out, {
  schema: 'ragam-commercial-sast-dast-evidence/1',
  status: 'PASS',
  product: report.product,
  commit,
  authorizedBy: report.authorizedBy,
  scanCompleted: true,
  licenseConfirmed: true,
  criticalFindings: 0,
  highFindings: 0,
  totalFindings: findings.length,
  reportFile: basename(reportPath),
  reportSha256: actualSha256,
  toolExitCode: 0,
  commandRedacted: true,
  rawToolOutputStored: false,
  rawFindingsStored: false,
  verifiedAt: new Date().toISOString(),
  note: 'Produced only after an owner-authorized licensed commercial tool ran against the exact commit. No credentials, raw prompts or raw findings are stored here.',
})
console.log(`commercial SAST/DAST verified: ${report.product} on ${commit}; 0 critical / 0 high findings; evidence ${out}`)
