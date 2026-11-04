import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureKlyvaronPlatformQualification } from '../src/klyvaron/qualification-capture.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fixedDate = () => new Date('2026-11-04T10:00:00.000Z')

function fixture(t, { inference = {}, rollbackFails = false, expectedSha256 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-qualification-capture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bytes = Buffer.from('synthetic qualification fixture; not model weights')
  writeFileSync(join(root, 'artifact.bin'), bytes)
  const actualSha256 = sha256(bytes)
  const modelRecord = {
    id: 'klyvaron-lite-assistant',
    tier: 'lite',
    artifact: { sha256: expectedSha256 ?? actualSha256, bytes: bytes.length },
    minimumHardware: { ramBytes: 1 },
    supportedRuntimes: ['llama.cpp'],
  }
  const runtimeAdapter = {
    id: 'llama.cpp',
    version: '1.0.0',
    inferenceSuiteSha256: 'a'.repeat(64),
    async coldStart() {
      return { session: { synthetic: true }, peakResidentBytes: 1024 * 1024, traceSha256: 'b'.repeat(64) }
    },
    async runInferenceSuite() {
      return {
        caseCount: 3, passedCases: 3, failedCases: 0, totalTokens: 96,
        transcriptSha256: 'c'.repeat(64), ...inference,
      }
    },
  }
  let active = 'd'.repeat(64)
  const deploymentAdapter = {
    async readActiveArtifactSha256() { return active },
    async activateArtifact() { active = actualSha256 },
    async restoreArtifact(previous) {
      if (!rollbackFails) active = previous
    },
  }
  return {
    root,
    artifactRoot: root,
    actualSha256,
    modelRecord,
    runtimeAdapter,
    deploymentAdapter,
    pinnedArtifactFiles: [{ path: 'artifact.bin', sha256: actualSha256, bytes: bytes.length }],
    activeArtifactSha256: () => active,
  }
}

test('qualification capture binds real host facts and emits all three metric-bearing reports after exact byte verification', async (t) => {
  const input = fixture(t)
  const result = await captureKlyvaronPlatformQualification({
    ...input,
    now: fixedDate,
  })
  assert.equal(result.passed, true)
  assert.equal(result.target.artifactSha256, input.actualSha256)
  assert.equal(result.target.measurements.cold_start.measurement.peakResidentBytes, 1024 * 1024)
  assert.equal(result.target.measurements.inference.measurement.passedCases, 3)
  assert.equal(result.target.measurements.rollback.measurement.restoredArtifactSha256, 'd'.repeat(64))
  assert.equal(input.activeArtifactSha256(), 'd'.repeat(64), 'the deployment is restored to the known-good digest')
  assert.equal(result.attestationRequired, true)

  // This CLI integration exercises synthetic adapters only; it is not OS qualification evidence.
  const modelPath = join(input.root, 'model-record.json')
  const pinnedPath = join(input.root, 'pinned-files.json')
  const adapterPath = join(input.root, 'test-adapters.mjs')
  const capturePath = join(input.root, 'capture-result.json')
  writeFileSync(modelPath, JSON.stringify(input.modelRecord))
  writeFileSync(pinnedPath, JSON.stringify(input.pinnedArtifactFiles))
  writeFileSync(adapterPath, `
    export const runtimeAdapter = {
      id: 'llama.cpp', version: '1.0.0', inferenceSuiteSha256: '${'a'.repeat(64)}',
      async coldStart() { return { session: {}, peakResidentBytes: 1048576, traceSha256: '${'b'.repeat(64)}' } },
      async runInferenceSuite() { return { caseCount: 3, passedCases: 3, failedCases: 0, totalTokens: 96, transcriptSha256: '${'c'.repeat(64)}' } },
    }
    let active = '${'d'.repeat(64)}'
    export const deploymentAdapter = {
      async readActiveArtifactSha256() { return active },
      async activateArtifact({ artifact }) { active = artifact.sha256 },
      async restoreArtifact(previous) { active = previous },
    }
  `)
  const cli = fileURLToPath(new URL('../scripts/klyvaron-evidence.mjs', import.meta.url))
  const cliResult = spawnSync(process.execPath, [
    cli, 'capture', modelPath, input.artifactRoot, pinnedPath, adapterPath, capturePath,
  ], { encoding: 'utf8' })
  assert.equal(cliResult.status, 0, cliResult.stderr)
  const cliCapture = JSON.parse(readFileSync(capturePath, 'utf8'))
  assert.equal(cliCapture.passed, true)
  assert.equal(cliCapture.target.artifactSha256, input.actualSha256)
  assert.equal(cliCapture.attestationRequired, true)
})

test('capture refuses an artifact whose measured bytes do not match the release record before calling the runtime', async (t) => {
  const input = fixture(t, { expectedSha256: 'e'.repeat(64) })
  let calls = 0
  input.runtimeAdapter.coldStart = async () => { calls += 1 }
  const result = await captureKlyvaronPlatformQualification({ ...input, now: fixedDate })
  assert.equal(result.passed, false)
  assert.match(result.blockers[0], /artifact bytes do not match/)
  assert.equal(calls, 0)
})

test('capture emits no qualification target when the inference suite has a failure', async (t) => {
  const input = fixture(t, { inference: { passedCases: 2, failedCases: 1 } })
  const result = await captureKlyvaronPlatformQualification({ ...input, now: fixedDate })
  assert.equal(result.passed, false)
  assert.equal(result.target, null)
  assert.equal(input.activeArtifactSha256(), 'd'.repeat(64))
})

test('capture refuses to certify deployment when rollback cannot restore and verify the known-good artifact', async (t) => {
  const input = fixture(t, { rollbackFails: true })
  const result = await captureKlyvaronPlatformQualification({ ...input, now: fixedDate })
  assert.equal(result.passed, false)
  assert.match(result.blockers[0], /restoration could not be verified/)
  assert.equal(result.target, null)
})
