/**
 * Release-qualification regression guards.
 *
 * A release report is a claim, and a claim needs something that fails when it
 * stops being true. These tests pin the repairs made during remediation and
 * refuse reports that launder BLOCKED/NOT TESTED into PASS, providers that are
 * marked live-qualified without a call log, models declared operational without
 * weights, and signatures produced without an authorized key.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PYTHON_FALLBACKS, pythonCandidates, defaultPythonBinary, configuredPythonBinary } from '../src/klyvaron/python-executable.mjs'
import { LocalTrainingWorkerManager } from '../src/klyvaron/training-worker.mjs'
import { OperationalMonitor, OPERATIONAL_EVENTS, monitorFromEnv } from '../src/telemetry/monitor.mjs'
import { OnlineApp } from '../src/online/app.mjs'
import { PROVIDERS } from '../src/providers/catalog.mjs'
import {
  writeChecksums, verifyChecksumsWithSha256sum, collectSbom,
  validateQualificationReport, RELEASE_STATES, QUALIFICATION_SCHEMA, readJson,
} from '../../../scripts/release/lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const read = (path) => readFileSync(resolve(REPO, path), 'utf8')
const json = (path) => readJson(resolve(REPO, path))
const temp = () => mkdtempSync(join(tmpdir(), 'ragam-qualification-'))

// --- R1: clean-checkout Python runtime ------------------------------------

test('a clean checkout with an in-repo venv is a Python fallback, and a configured interpreter still wins', () => {
  assert.ok(DEFAULT_PYTHON_FALLBACKS.some((path) => path.endsWith(join('.venv', 'bin', 'python'))),
    'the repository-local .venv must be a fallback so a clean checkout needs no shell export')
  assert.equal(DEFAULT_PYTHON_FALLBACKS.at(-1), 'python3')
  assert.ok(read('services/core/src/klyvaron/training-worker.mjs').includes('pythonCandidates(DEFAULT_PYTHON_FALLBACKS)'),
    'the worker must use the shared fallback list, not a private literal')
  assert.deepEqual(pythonCandidates(DEFAULT_PYTHON_FALLBACKS, { AETHERIS_PYTHON: '/authorized/python' }), ['/authorized/python'])
  assert.equal(configuredPythonBinary({ AETHERIS_PYTHON: '  /authorized/python  ' }), '/authorized/python')
  assert.equal(defaultPythonBinary({}), 'python3')
  const root = temp()
  const manager = new LocalTrainingWorkerManager({ root })
  try {
    const environment = manager.inspectEnvironment()
    assert.equal(typeof environment.software.pythonAvailable, 'boolean')
    assert.ok(environment.hardware.logicalCpus >= 1)
  } finally {
    manager.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// --- R2: privacy-conscious telemetry --------------------------------------

test('telemetry records only allowlisted fields and redacts prompts, keys and datasets', () => {
  const monitor = new OperationalMonitor({ now: () => 1_700_000_000_000 })
  monitor.record('inference_latency', {
    durationMs: 42, component: 'openai', outcome: 'ok',
    prompt: 'a private prompt', apiKey: 'sk-private-value', dataset: 'private-data',
  })
  const snapshot = monitor.snapshot()
  assert.equal(snapshot.recordedEvents, 1)
  assert.equal(snapshot.redactedFields, 3)
  assert.equal(snapshot.counters.inference_latency, 1)
  const serialised = JSON.stringify(snapshot)
  for (const secret of ['a private prompt', 'sk-private-value', 'private-data']) {
    assert.ok(!serialised.includes(secret), `${secret} must never be stored`)
  }
  assert.equal(snapshot.privacy.transmission, 'none')
  assert.equal(snapshot.privacy.rawPrompts, false)
  assert.equal(snapshot.privacy.accountIdentifiers, false)
})

test('telemetry refuses unknown events, unsafe labels and unbounded samples', () => {
  const monitor = new OperationalMonitor()
  assert.equal(monitor.record('not_an_event', { component: 'x' }), false)
  assert.equal(monitor.snapshot().refusedEvents, 1)
  for (let i = 0; i < 100; i += 1) monitor.record('inference_latency', { durationMs: i, component: 'provider' })
  assert.equal(monitor.snapshot().latency.provider.samples, 32, 'latency samples must be bounded')
  monitor.record('job_completed', { component: '../etc/passwd' })
  assert.equal(monitor.snapshot().counters.job_completed, 1)
  assert.equal(monitor.snapshot().latency['../etc/passwd'], undefined)
  assert.equal(monitor.record('api_failure', { component: 42, outcome: 'free-form text' }), true)
  assert.equal(monitor.snapshot().counters.api_failure, 1)
  assert.ok(OPERATIONAL_EVENTS.includes('training_worker_failure'))
  assert.ok(OPERATIONAL_EVENTS.includes('deployment_health'))
})

test('optional telemetry has a real disable method', () => {
  for (const value of ['false', '0', 'no', 'off', 'FALSE']) {
    const disabled = monitorFromEnv({ AETHERIS_TELEMETRY_ENABLED: value })
    assert.equal(disabled.enabled, false, `${value} must disable telemetry`)
    assert.equal(disabled.record('api_failure', { outcome: 'failure' }), false)
    assert.equal(disabled.snapshot().recordedEvents, 0)
    assert.match(disabled.snapshot().disable, /AETHERIS_TELEMETRY_ENABLED=false/)
  }
  assert.equal(monitorFromEnv({ AETHERIS_TELEMETRY_ENABLED: 'true' }).enabled, true)
  assert.ok(read('.env.example').includes('AETHERIS_TELEMETRY_ENABLED=true'))
})

test('the running app exposes telemetry counters and records API failures without secrets', (t) => {
  const root = temp()
  const telemetry = new OperationalMonitor()
  const app = new OnlineApp({ dataDir: root, trustedOrigins: [], telemetry, logger: () => {} })
  t.after(() => { app.close(); rmSync(root, { recursive: true, force: true }) })
  assert.equal(app.readiness().telemetry.recordedEvents, 0)
  app.recordOperationalEvent('api_failure', { outcome: 'failure', component: 'core', prompt: 'private prompt' })
  const snapshot = app.readiness().telemetry
  assert.equal(snapshot.recordedEvents, 1)
  assert.equal(snapshot.redactedFields, 1)
  assert.equal(snapshot.counters.api_failure, 1)
  assert.ok(!JSON.stringify(snapshot).includes('private prompt'))
})

// --- R3: reproducible release tooling -------------------------------------

test('checksums are written by node:crypto and independently verified by sha256sum, and tampering is refused', () => {
  const dir = temp()
  try {
    const a = join(dir, 'artifact-a.bin')
    const b = join(dir, 'artifact-b.bin')
    writeFileSync(a, 'first artifact')
    writeFileSync(b, 'second artifact')
    const sums = writeChecksums(dir, [a, b])
    assert.equal(sums.entries, 2)
    assert.ok(verifyChecksumsWithSha256sum(dir).ok)
    writeFileSync(a, 'tampered artifact')
    assert.equal(verifyChecksumsWithSha256sum(dir).ok, false, 'a changed byte must fail independent verification')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the SBOM is derived from committed lockfiles, not installed node_modules', () => {
  const sbom = collectSbom(REPO, { version: '0.2.0', timestamp: '2026-10-17T00:00:00Z' })
  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.specVersion, '1.5')
  assert.ok(sbom.components.length > 100, `expected a real dependency list, got ${sbom.components.length}`)
  assert.ok(sbom.components.some((c) => c.name === 'react' && c.purl.startsWith('pkg:npm/')))
  assert.ok(sbom.components.some((c) => c.name === 'numpy' && c.purl.startsWith('pkg:pypi/')))
  assert.ok(sbom.ragamSources.every((source) => /sha256/i.test(JSON.stringify(source)) || source.sha256))
  for (const component of sbom.components) {
    assert.ok(component.purl && component['bom-ref'] && component.version)
  }
})

test('the release gate refuses laundered PASS, unsubstantiated BLOCKED and unauthorized live claims', () => {
  // A minimal all-PASS report is the only shape allowed to claim qualification.
  const base = {
    schema: QUALIFICATION_SCHEMA,
    finalVerdict: 'TECHNICALLY QUALIFIED',
    releasePublished: false,
    gates: [{ id: 'g1', name: 'one', mandatory: true, status: 'PASS', evidence: [{ command: 'node --test' }] }],
  }
  assert.equal(validateQualificationReport(base).ok, true)
  assert.ok(validateQualificationReport({ ...base, gates: [{ ...base.gates[0], evidence: [] }] }).problems.some((p) => /PASS without evidence/.test(p)))
  assert.ok(validateQualificationReport({ ...base, gates: [{ ...base.gates[0], status: 'BLOCKED' }] }).problems.some((p) => /BLOCKED without/.test(p)))
  assert.ok(validateQualificationReport({ ...base, gates: [{ ...base.gates[0], status: 'NOT APPLICABLE' }] }).problems.some((p) => /NOT APPLICABLE without/.test(p)))
  assert.ok(validateQualificationReport({ ...base, finalVerdict: 'NOT RELEASE READY' }).problems.some((p) => /finalVerdict/.test(p)))
  assert.ok(validateQualificationReport({
    ...base,
    gates: [{ ...base.gates[0], requiresLiveCredential: true, liveCredentialEvidence: { callLog: null } }],
  }).problems.some((p) => /live-credential gate marked PASS/.test(p)))
  assert.equal(validateQualificationReport({ ...base, releasePublished: true }).ok, false)
  assert.ok(RELEASE_STATES.every((state) => typeof state === 'string'))
})

test('release signing fails closed without an explicitly authorized key', () => {
  const dir = temp()
  try {
    writeFileSync(join(dir, 'SHA256SUMS'), '00  nothing\n')
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (name.startsWith('RAGAM_RELEASE_SIGNING_')) delete env[name]
    const result = spawnSync(process.execPath, [resolve(REPO, 'scripts/release/sign-release.mjs'), '--dir', dir], { env, encoding: 'utf8' })
    assert.equal(result.status, 2, `expected a fail-closed refusal, got ${result.status}: ${result.stderr}`)
    assert.match(result.stderr, /RAGAM_RELEASE_SIGNING_KEY_ID/)
    assert.match(result.stderr, /BLOCKED/)
    assert.equal(existsSync(join(dir, 'SHA256SUMS.asc')), false, 'no signature may be fabricated')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- R4: honest machine-readable registers --------------------------------

test('every catalogue provider is in the live register and none is claimed live-qualified', () => {
  const register = json('docs/release/provider-register.json')
  assert.equal(register.liveCallsMade, 0)
  assert.equal(register.providers.length, PROVIDERS.length)
  const ids = new Set(PROVIDERS.map((p) => p.id))
  for (const provider of register.providers) {
    assert.ok(ids.has(provider.id), `unknown provider ${provider.id}`)
    assert.ok(RELEASE_STATES.includes(provider.status))
    assert.ok(provider.configField.includes(`/api/providers/${provider.id}`))
    assert.equal(provider.liveCredentialEvidence.callLog, null)
    if (provider.status === 'BLOCKED') assert.ok(provider.unblock.includes('authorized'), `${provider.id} needs an exact unblock requirement`)
    if (provider.status === 'NOT APPLICABLE') assert.ok(provider.justification)
    assert.equal(provider.status === 'PASS', false, 'no provider was live-tested')
  }
})

test('model register does not classify metadata-only tiers as operational models', () => {
  const models = json('docs/release/model-register.json')
  assert.equal(models.models.length, 3)
  assert.deepEqual(models.models.map((m) => m.id), ['lite', 'pro', 'max'])
  assert.equal(models.operationalModelsVerified, 0)
  assert.equal(models.weightFilesTrackedInGit, 0)
  for (const model of models.models) {
    assert.equal(model.actualWeightsPresent, false)
    assert.equal(model.qualification.realInference.status, 'BLOCKED')
    assert.equal(model.qualification.weightsPresent.status, 'FAIL')
    assert.match(model.tierSemantics, /not a distinct model/)
    assert.equal(model.notFirstPartyClaim, false)
  }
})

test('training, E2E and security evidence files are real, passing and correctly scoped', () => {
  const training = json('docs/release/evidence/training-evidence.json')
  assert.equal(training.fail, 0)
  assert.ok(training.pass >= 10)
  assert.match(training.scope, /NOT a Klyvaron Pro\/Max foundation model/)
  const e2e = json('docs/release/evidence/e2e-qualification.json')
  assert.equal(e2e.fail, 0)
  assert.ok(e2e.pass >= 15)
  assert.equal(e2e.liveThirdPartyCalls, 0)
  assert.ok(e2e.results.every((r) => ['isolated_test_service', 'in_process', 'live', 'local_model', 'mock'].includes(r.mode)))
  assert.ok(e2e.results.every((r) => r.mode !== 'live'))
  const security = json('docs/release/evidence/security-scan.json')
  assert.equal(security.fail, 0)
  assert.ok(security.pass >= 8)
  assert.ok(security.checks.find((c) => c.id === 'no_hardcoded_credential_literals').detail.includes('0 unreviewed'))
})

test('the machine-readable release gate is valid, honest and still refuses publication', () => {
  const report = json('docs/release/qualification.json')
  assert.equal(report.schema, QUALIFICATION_SCHEMA)
  const verdict = validateQualificationReport(report)
  assert.equal(verdict.ok, true, verdict.problems.join('; '))
  assert.equal(report.finalVerdict, 'NOT RELEASE READY')
  assert.equal(report.releasePublished, false)
  assert.ok(verdict.nonPassMandatory > 0, 'live qualification, weights, signing and staging are not PASS')
  for (const gate of report.gates) {
    if (gate.requiresLiveCredential) assert.notEqual(gate.status, 'PASS', `${gate.id} cannot be PASS without a live call`)
    if (gate.status === 'BLOCKED') assert.ok(gate.unblock && gate.unblock.length > 20, `${gate.id} needs an exact unblock requirement`)
    if (gate.status === 'PASS') assert.ok(gate.evidence?.length > 0, `${gate.id} needs recorded evidence`)
  }
})
