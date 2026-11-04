#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadKlyvaronEvidenceTrustStore } from '../src/klyvaron/evidence-trust.mjs'
import { evaluateKlyvaronProductionReleaseGate } from '../src/klyvaron/release/release-gate.mjs'
import { advanceKlyvaronModelRelease, MODEL_RELEASE_STATES } from '../src/klyvaron/model-registry.mjs'

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-klyvaron-release.mjs --policy-check',
    '  node scripts/verify-klyvaron-release.mjs --tag klyvaron-lite-v1.0.0 --package-dir release-evidence/lite/v1.0.0 --artifact-root <real-artifact-dir> --trust-store <public-trust.json> --registry-record <production-approved-record.json> [--output <report.json>]',
  ].join('\n')
}

function argsFrom(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new Error(`unexpected argument '${key}'`)
    if (key === '--policy-check') { values.policyCheck = true; continue }
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`)
    if (!['--tag', '--package-dir', '--artifact-root', '--trust-store', '--registry-record', '--output'].includes(key)) {
      throw new Error(`unknown option '${key}'`)
    }
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    values[name] = value
  }
  return values
}

function readJson(filePath, label) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch {
    throw new Error(`${label} is missing or invalid JSON`)
  }
}

function policyCheck() {
  const checks = []
  const makeRecord = (status) => ({ id: 'klyvaron-lite-assistant', tier: 'lite', version: '1.0.0', status })
  for (const source of [MODEL_RELEASE_STATES.TRAINED, MODEL_RELEASE_STATES.RELEASE_CANDIDATE]) {
    let rejected = false
    try { advanceKlyvaronModelRelease(makeRecord(source), MODEL_RELEASE_STATES.RELEASED) } catch { rejected = true }
    checks.push({ source, target: MODEL_RELEASE_STATES.RELEASED, rejected })
  }
  const requiredStates = [
    'PLANNED', 'TRAINING', 'TRAINED', 'EVALUATED', 'RELEASE_CANDIDATE',
    'PRODUCTION_APPROVED', 'RELEASED', 'SUSPENDED',
  ]
  const statesPresent = requiredStates.every((name) => typeof MODEL_RELEASE_STATES[name] === 'string')
  const passed = checks.every((item) => item.rejected) && statesPresent
  return {
    schema: 'klyvaron.production-policy-check.v1',
    status: passed ? 'passed' : 'blocked', passed,
    blockers: passed ? [] : ['direct trained/candidate-to-released transition is not fail-closed or required registry states are missing'],
    requiredStates: Object.fromEntries(requiredStates.map((name) => [name, MODEL_RELEASE_STATES[name] ?? null])),
    rejectedTransitions: checks,
  }
}

async function main() {
  const args = argsFrom(process.argv.slice(2))
  if (args.policyCheck) {
    if (Object.keys(args).length !== 1) throw new Error('--policy-check does not accept other options')
    const report = policyCheck()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.passed ? 0 : 2
  }
  const tag = /^klyvaron-(lite|pro|max)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(args.tag ?? '')
  if (!tag) throw new Error('production tag must be klyvaron-<lite|pro|max>-v<semver>')
  for (const required of ['packageDir', 'artifactRoot', 'trustStore', 'registryRecord']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required for production tags`)
  }
  const tier = tag[1]
  const version = tag[2]
  const trustStore = loadKlyvaronEvidenceTrustStore(resolve(args.trustStore))
  const modelRecord = args.registryRecord ? readJson(resolve(args.registryRecord), 'registry record') : null
  const report = await evaluateKlyvaronProductionReleaseGate({
    tier,
    version,
    packageDir: resolve(args.packageDir),
    artifactRoot: resolve(args.artifactRoot),
    trustStore,
    modelRecord,
  })
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (args.output) writeFileSync(resolve(args.output), output, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  process.stdout.write(output)
  return report.passed ? 0 : 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((status) => { process.exitCode = status }).catch((error) => {
    if (error?.code === 'EEXIST') {
      process.stderr.write('release verification output already exists; refusing to overwrite\n')
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : 'release verification failed'}\n${usage()}\n`)
    }
    process.exitCode = error instanceof Error && /Usage/.test(error.message) ? 64 : 2
  })
}
