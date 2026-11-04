import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { canonicalProvenanceSha256 } from '../../src/klyvaron/provenance.mjs'
import {
  KlyvaronEvidenceTrustStore, canonicalKlyvaronEvidenceJson, klyvaronEvidenceAttestationPayload,
  klyvaronEvidenceKeyId,
} from '../../src/klyvaron/evidence-trust.mjs'
import {
  KLYVARON_PRODUCTION_EVIDENCE_FILES,
  klyvaronEvidenceManifestBody,
  klyvaronProductionReleaseDecisionDigest,
  validateKlyvaronProductionEvidenceDocuments,
} from '../../src/klyvaron/release/evidence-schema.mjs'
import { evaluateKlyvaronProductionDecisions } from '../../src/klyvaron/release/decision-engine.mjs'
import { validateKlyvaronProductionEvidencePackage } from '../../src/klyvaron/release/evidence-validator.mjs'
import { verifyKlyvaronProductionEvidenceSignatures } from '../../src/klyvaron/release/signature-verifier.mjs'

const sha = (text) => canonicalProvenanceSha256(text)
const digestA = sha('test fixture A')
const digestB = sha('test fixture B')
const digestC = sha('test fixture C')
const digestD = sha('test fixture D')
const now = '2026-11-04T12:00:00Z'

function syntheticPackageDocuments(tier = 'lite') {
  const modelId = `klyvaron-${tier}-assistant`
  const version = '1.0.0'
  const modelRevisionSha256 = digestA
  const configurationSha256 = digestB
  const files = [
    { path: 'weights/model.bin', sha256: digestC, bytes: 101, role: 'weights' },
    { path: 'tokenizer/tokenizer.json', sha256: digestD, bytes: 202, role: 'tokenizer' },
  ]
  const artifactSha256 = canonicalProvenanceSha256({
    schema: 'klyvaron.production-artifact-files.v1',
    files: [...files].map(({ path, sha256: fileSha, bytes, role }) => ({ path, sha256: fileSha.toLowerCase(), bytes, role }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  })
  const common = {
    tier, modelId, version, modelRevisionSha256, artifactSha256,
    evidenceClass: 'test_fixture', synthetic: true, mockedResponses: false,
  }
  const artifactManifest = {
    schema: 'klyvaron.production-artifact-manifest.v1', ...common,
    formats: ['safetensors'],
    tokenizer: { name: 'fixture-tokenizer', version: '1.0.0', format: 'json' },
    files,
  }
  const identity = {
    schema: 'klyvaron.production-model-identity.v1', tier, modelId, version,
    modelRevisionSha256, configurationSha256, artifactSha256,
    artifactManifestSha256: canonicalProvenanceSha256(artifactManifest),
  }
  const checksums = [...files].map((file) => `${file.sha256}  ${file.path}`).sort().join('\n') + '\n'
  const report = (schema, value = {}) => ({ schema, ...common, ...value })
  const documents = {
    'model-identity.json': identity,
    'artifact-manifest.json': artifactManifest,
    'artifact-checksums.sha256': checksums,
    'training-provenance.json': report('klyvaron.production-training-provenance.v1', {
      sourceType: 'licensed_open_weight_foundation', method: 'first_party_fine_tuning',
      thirdPartyBasePresentedAsOriginal: false,
      foundationModel: {
        id: 'open-foundation-fixture', isOpenWeight: true, revision: 'r1', revisionSha256: digestA,
        license: 'fixture-license', licenseReviewStatus: 'approved', licenseReviewReportSha256: digestB,
      },
      trainingEnvironment: { hostId: 'test-host', resourceClass: 'local_low_resource' },
      datasets: [{ id: 'fixture-data', version: '1.0.0', sourceClass: 'first_party_authored', license: 'fixture-license', manifestSha256: digestC, contentSha256: digestD }],
      trainingConfigurationSha256: configurationSha256, trainingRunSha256: digestB,
      trainingRunId: 'synthetic-run', completedAt: now, privateChatAutoIngested: false, privateChatsIncluded: false,
    }),
    'evaluation-report.json': report('klyvaron.production-evaluation-report.v1', {
      passed: true, evaluationSuiteSha256: digestA, runId: 'synthetic-eval', completedAt: now,
      qualityMetrics: { score: 0.9 }, safetyMetrics: { score: 0.99 },
      mandatoryChecks: [{ id: 'held-out', passed: true, resultSha256: digestB }],
    }),
    'performance-report.json': report('klyvaron.production-performance-report.v1', {
      passed: true, runs: [{ deviceId: 'fixture-device', os: 'linux', runtimeId: 'llama.cpp', runtimeVersion: '1.0.0', measuredAt: now, runSha256: digestC,
        metrics: { p50LatencyMs: 10, p95LatencyMs: 20, tokensPerSecond: 30, peakResidentBytes: 4_000_000 } }],
    }),
    'hardware-compatibility.json': report('klyvaron.production-hardware-compatibility.v1', {
      passed: true, devices: [{ deviceId: 'fixture-device', os: 'linux', architecture: 'x64', runtimeId: 'llama.cpp', runtimeVersion: '1.0.0', compatible: true, measurementReportSha256: digestD, verifiedAt: now }],
    }),
    'security-report.json': report('klyvaron.production-security-report.v1', {
      decision: 'pass', reviewerId: 'security-reviewer', reviewedAt: now, testSuiteSha256: digestA, findings: [],
    }),
    'deployment-evidence.json': report('klyvaron.production-deployment-evidence.v1', {
      passed: true, verificationMode: 'independent_pipeline', verifierId: 'deployment-reviewer',
      verifierOrganization: 'independent test org', independentOfTraining: true, independentOfDeployment: true,
      deploymentId: 'synthetic-deployment', verifiedAt: now, testSuiteSha256: digestB,
      targets: [{ targetId: 'fixture-device', targetKind: 'local_consumer_device', deviceClass: 'consumer', deviceVerified: true,
        os: 'linux', architecture: 'x64', runtimeId: 'llama.cpp', runtimeVersion: '1.0.0', actualInference: true,
        inferenceRunSha256: digestC, hardwareReportSha256: digestD,
        observedMetrics: { p95LatencyMs: 20, tokensPerSecond: 30, peakResidentBytes: 4_000_000 },
        tests: ['artifact_retrieval', 'artifact_signature_verification', 'artifact_checksum_verification', 'model_revision_match',
          'inference', 'streaming', 'cancellation', 'model_selection_routing', 'access_control', 'request_isolation', 'failure_handling', 'recovery']
          .map((id) => ({ id, passed: true, traceSha256: digestA })),
      }],
    }),
    'rollback-test.json': report('klyvaron.production-rollback-test.v1', {
      passed: true, rollbackCompleted: true, recoveryVerified: true, testRunId: 'synthetic-rollback', completedAt: now,
      previousArtifactSha256: digestA, restoredArtifactSha256: digestA, recoveryProbeSha256: digestB,
    }),
    'independent-review.json': report('klyvaron.production-independent-review.v1', {
      decision: 'approve', independent: true, involvedInTraining: false, involvedInDeployment: false,
      involvedInArtifactAuthoring: false, reviewerId: 'independent-reviewer', organization: 'independent test org',
      reviewedAt: now, findings: [],
    }),
    'release-decision.json': report('klyvaron.production-release-decision.v1', {
      decision: 'approve', authorized: true, approverId: 'release-approver', authorityRole: 'release authority',
      reason: 'synthetic unit-test fixture only', approvedAt: now,
    }),
  }
  return documents
}

function signedSyntheticBundle(root) {
  const packageDir = join(root, 'v1.0.0')
  const artifactRoot = join(root, 'artifact')
  const signatureDir = join(packageDir, 'signatures')
  mkdirSync(signatureDir, { recursive: true })
  mkdirSync(artifactRoot, { recursive: true })
  const documents = syntheticPackageDocuments()
  const artifactManifest = documents['artifact-manifest.json']
  for (const file of artifactManifest.files) {
    const content = Buffer.from(`SYNTHETIC TEST ARTIFACT ${file.role}: ${file.path}\n`)
    const fullPath = join(artifactRoot, file.path)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content)
    file.sha256 = createHash('sha256').update(content).digest('hex')
    file.bytes = content.length
  }
  const artifactSha256 = canonicalProvenanceSha256({
    schema: 'klyvaron.production-artifact-files.v1',
    files: [...artifactManifest.files].map(({ path, sha256: fileSha, bytes, role }) => ({ path, sha256: fileSha.toLowerCase(), bytes, role }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  })
  for (const value of Object.values(documents)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'artifactSha256')) value.artifactSha256 = artifactSha256
  }
  documents['model-identity.json'].artifactSha256 = artifactSha256
  documents['artifact-manifest.json'].artifactSha256 = artifactSha256
  documents['model-identity.json'].artifactManifestSha256 = canonicalProvenanceSha256(artifactManifest)
  documents['artifact-checksums.sha256'] = [...artifactManifest.files]
    .map((file) => `${file.sha256}  ${file.path}`).sort().join('\n') + '\n'

  for (const filename of KLYVARON_PRODUCTION_EVIDENCE_FILES) {
    const value = documents[filename]
    const content = filename === 'artifact-checksums.sha256' ? value : `${JSON.stringify(value, null, 2)}\n`
    writeFileSync(join(packageDir, filename), content)
  }
  const fileEntries = KLYVARON_PRODUCTION_EVIDENCE_FILES.map((path) => {
    const content = Buffer.from(filenameContent(packageDir, path), 'utf8')
    return { path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const manifestBody = {
    schema: 'klyvaron.production-evidence-manifest.v1', tier: 'lite', modelId: 'klyvaron-lite-assistant',
    version: '1.0.0', modelRevisionSha256: digestA, artifactSha256,
    issuedAt: now, expiresAt: '2026-12-04T12:00:00Z', files: fileEntries,
  }
  const manifest = { ...manifestBody, manifestSha256: canonicalProvenanceSha256(klyvaronEvidenceManifestBody(manifestBody)) }
  const keySpecs = [
    ['evidence-custodian', 'release_evidence_custodian', 'klyvaron_release_evidence', 'evidence.attestation.json', manifest.manifestSha256],
    ['deployment-reviewer', 'deployment_verifier', 'klyvaron_deployment_verification', 'deployment.attestation.json', canonicalProvenanceSha256(documents['deployment-evidence.json'])],
    ['independent-reviewer', 'independent_reviewer', 'klyvaron_independent_review', 'independent-review.attestation.json', canonicalProvenanceSha256(documents['independent-review.json'])],
    ['release-approver', 'release_approver', 'klyvaron_release_decision', 'release-decision.attestation.json', klyvaronProductionReleaseDecisionDigest({ manifestSha256: manifest.manifestSha256, releaseDecision: documents['release-decision.json'] })],
  ]
  const trustedKeys = []
  for (const [principalId, role, purpose, filename, evidenceSha256] of keySpecs) {
    const pair = generateKeyPairSync('ed25519')
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' })
    const keyId = klyvaronEvidenceKeyId(publicKeyPem)
    trustedKeys.push({ publicKeyPem, keyId, label: `synthetic ${role}`, principalId, roles: [role], purposes: [purpose] })
    const payload = klyvaronEvidenceAttestationPayload({ purpose, modelId: manifest.modelId, evidenceSha256 })
    const message = `klyvaron-evidence-attestation/v1\n${canonicalKlyvaronEvidenceJson(payload)}`
    const attestation = {
      algorithm: 'ed25519', keyId, purpose,
      signature: sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('base64'),
    }
    writeFileSync(join(signatureDir, filename), `${JSON.stringify(attestation, null, 2)}\n`)
  }
  writeFileSync(join(signatureDir, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { packageDir, artifactRoot, documents, manifest, trustStore: new KlyvaronEvidenceTrustStore({ keys: trustedKeys }) }
}

function filenameContent(root, filename) {
  return readFileSync(join(root, filename), 'utf8')
}

test('production evidence schema explicitly rejects labelled synthetic reports', () => {
  const documents = syntheticPackageDocuments()
  const result = validateKlyvaronProductionEvidenceDocuments({ tier: 'lite', version: '1.0.0', documents })
  assert.equal(result.passed, false)
  assert.ok(result.blockers.some((blocker) => blocker.includes('explicitly production evidence, not synthetic or mocked')))
  const mismatched = syntheticPackageDocuments()
  mismatched['evaluation-report.json'].artifactSha256 = 'f'.repeat(64)
  const mismatchResult = validateKlyvaronProductionEvidenceDocuments({ tier: 'lite', version: '1.0.0', documents: mismatched })
  assert.ok(mismatchResult.blockers.some((blocker) => blocker.includes('targets a different model, revision, version or artifact')))
  assert.equal(KLYVARON_PRODUCTION_EVIDENCE_FILES.length, 12)
})

test('Pro/Max production training evidence rejects low-resource-host training', () => {
  for (const tier of ['pro', 'max']) {
    const result = validateKlyvaronProductionEvidenceDocuments({
      tier, version: '1.0.0', documents: syntheticPackageDocuments(tier),
    })
    assert.ok(result.blockers.some((blocker) => blocker.includes('Pro and Max cannot train on a low-resource host')))
  }
})

test('release evidence verifier rejects placeholder-only packages and missing trust anchors', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-release-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const packageDir = join(dir, 'v1.0.0')
  const artifactRoot = join(dir, 'artifact')
  mkdirSync(packageDir)
  mkdirSync(join(packageDir, 'signatures'))
  mkdirSync(artifactRoot)
  writeFileSync(join(packageDir, 'README.md'), 'Evidence not supplied.\n')
  const result = await validateKlyvaronProductionEvidencePackage({
    tier: 'lite', version: '1.0.0', packageDir, artifactRoot,
    trustStore: new KlyvaronEvidenceTrustStore(),
  })
  assert.equal(result.passed, false)
  assert.ok(result.blockers.some((blocker) => blocker.includes('directory must contain exactly the required files')))
})

test('signed synthetic reports and real fixture bytes verify cryptographically but never pass production acceptance', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-signed-synthetic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bundle = signedSyntheticBundle(dir)
  const result = await validateKlyvaronProductionEvidencePackage({
    tier: 'lite', version: '1.0.0', packageDir: bundle.packageDir, artifactRoot: bundle.artifactRoot,
    trustStore: bundle.trustStore, now: new Date(now),
  })
  assert.equal(result.passed, false)
  assert.equal(result.artifactVerification.passed, true, 'the temporary fixture artifact bytes are actually hashed')
  assert.equal(result.signatures.length, 4)
  assert.ok(result.signatures.every((item) => item.status === 'verified'), 'each ephemeral test key signs only its scoped fixture role')
  assert.ok(result.blockers.some((blocker) => blocker.includes('explicitly production evidence, not synthetic or mocked')))
  assert.equal(result.package, null, 'synthetic evidence cannot produce a registry package object')

  const deploymentSignaturePath = join(bundle.packageDir, 'signatures', 'deployment.attestation.json')
  const originalDeploymentSignature = readFileSync(deploymentSignaturePath, 'utf8')
  const invalidSignature = JSON.parse(originalDeploymentSignature)
  invalidSignature.signature = Buffer.alloc(64).toString('base64')
  writeFileSync(deploymentSignaturePath, `${JSON.stringify(invalidSignature, null, 2)}\n`)
  const invalidSignatureResult = await validateKlyvaronProductionEvidencePackage({
    tier: 'lite', version: '1.0.0', packageDir: bundle.packageDir, artifactRoot: bundle.artifactRoot,
    trustStore: bundle.trustStore, now: new Date(now),
  })
  assert.ok(invalidSignatureResult.blockers.some((blocker) => blocker.includes('deployment signature: evidence signature does not match the payload')))
  writeFileSync(deploymentSignaturePath, originalDeploymentSignature)

  const evaluationPath = join(bundle.packageDir, 'evaluation-report.json')
  const edited = JSON.parse(readFileSync(evaluationPath, 'utf8'))
  edited.qualityMetrics.score = 0.91
  writeFileSync(evaluationPath, `${JSON.stringify(edited, null, 2)}\n`)
  const changed = await validateKlyvaronProductionEvidencePackage({
    tier: 'lite', version: '1.0.0', packageDir: bundle.packageDir, artifactRoot: bundle.artifactRoot,
    trustStore: bundle.trustStore, now: new Date(now),
  })
  assert.ok(changed.blockers.some((blocker) => blocker.includes("does not match file bytes for 'evaluation-report.json'")))
})

test('production tag CLI rejects a placeholder package even when paths and registry inputs are supplied', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-release-tag-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const packageDir = join(dir, 'v1.0.0')
  const artifactRoot = join(dir, 'artifact')
  const signatureDir = join(packageDir, 'signatures')
  mkdirSync(signatureDir, { recursive: true })
  mkdirSync(artifactRoot)
  writeFileSync(join(packageDir, 'README.md'), 'NOT RELEASED: no evidence.\n')
  writeFileSync(join(signatureDir, 'README.md'), 'No signatures.\n')
  const trustPath = join(dir, 'public-trust.json')
  writeFileSync(trustPath, JSON.stringify({ format: 'klyvaron-evidence-trust/v1', keys: [] }))
  const registryPath = join(dir, 'registry-record.json')
  writeFileSync(registryPath, JSON.stringify({
    id: 'klyvaron-lite-assistant', tier: 'lite', version: '1.0.0', status: 'production_approved',
    modelRevisionSha256: digestA, artifact: { sha256: digestB },
  }))
  const script = fileURLToPath(new URL('../../scripts/verify-klyvaron-release.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script,
    '--tag', 'klyvaron-lite-v1.0.0', '--package-dir', packageDir, '--artifact-root', artifactRoot,
    '--trust-store', trustPath, '--registry-record', registryPath,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).status, 'blocked')
})

test('production trust anchors require scoped principal identities and production roles', () => {
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  assert.throws(() => new KlyvaronEvidenceTrustStore({ keys: [{
    publicKeyPem: key, label: 'unassigned test key', purposes: ['klyvaron_release_decision'],
  }] }), /principal id and matching production role/)
  const store = new KlyvaronEvidenceTrustStore({ keys: [{
    keyId: klyvaronEvidenceKeyId(key), publicKeyPem: key, label: 'test approver',
    principalId: 'release-approver', roles: ['release_approver'], purposes: ['klyvaron_release_decision'],
  }] })
  assert.equal(store.size, 1)
})

test('expired and superseded evidence manifests are blocked even with no report payload', () => {
  const makeManifest = (issuedAt, expiresAt) => {
    const body = {
      schema: 'klyvaron.production-evidence-manifest.v1', tier: 'lite', modelId: 'klyvaron-lite-assistant',
      version: '1.0.0', modelRevisionSha256: digestA, artifactSha256: digestB,
      issuedAt, expiresAt, files: [],
    }
    return { ...body, manifestSha256: canonicalProvenanceSha256(klyvaronEvidenceManifestBody(body)) }
  }
  const expired = makeManifest('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')
  const expiredResult = verifyKlyvaronProductionEvidenceSignatures({
    manifest: expired, signatures: {}, documents: {}, trustStore: new KlyvaronEvidenceTrustStore(), now: new Date(now),
  })
  assert.ok(expiredResult.blockers.includes('production evidence package has expired'))

  const superseded = makeManifest('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')
  const supersededResult = verifyKlyvaronProductionEvidenceSignatures({
    manifest: superseded, signatures: {}, documents: {},
    trustStore: new KlyvaronEvidenceTrustStore({ supersededEvidenceManifestSha256: [superseded.manifestSha256] }),
    now: new Date(now),
  })
  assert.ok(supersededResult.blockers.includes('production evidence manifest has been superseded or revoked'))
})

test('Lite, Pro and Max decisions remain independent and fail closed without evidence', () => {
  const report = evaluateKlyvaronProductionDecisions()
  assert.equal(report.status, 'provisional')
  assert.equal(report.decisions.lite.decision, 'HOLD')
  assert.equal(report.decisions.pro.decision, 'NOT RELEASED')
  assert.equal(report.decisions.max.decision, 'NOT RELEASED')
  const fabricatedPass = { schema: 'klyvaron.production-release-gate.v1', tier: 'lite', status: 'passed', passed: true }
  const withOneUnboundTier = evaluateKlyvaronProductionDecisions({ gateReports: { lite: fabricatedPass } })
  assert.equal(withOneUnboundTier.decisions.lite.decision, 'HOLD')
  assert.equal(withOneUnboundTier.decisions.pro.decision, 'NOT RELEASED')
  assert.equal(withOneUnboundTier.decisions.max.decision, 'NOT RELEASED')
})

test('release policy verifier denies direct production transitions', () => {
  const script = fileURLToPath(new URL('../../scripts/verify-klyvaron-release.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--policy-check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.passed, true)
  assert.deepEqual(report.rejectedTransitions.map((item) => item.rejected), [true, true])
})
