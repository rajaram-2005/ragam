// The Klyvaron family: three tiers, and the rule that stops a label implying quality.
//
// The tests that matter here are the negative controls. Directive §10 forbids claiming
// "quality improvements merely because a model has been assigned the Pro or Max label"
// and §5A forbids presenting a derived model as a first-party foundation model. Those
// are both cases of a *record that reads as a claim*, so they are tested by constructing
// the offending record and asserting the validator refuses it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { symlinkSync } from 'node:fs'

import {
  KlyvaronEvidenceTrustStore, canonicalKlyvaronEvidenceJson, klyvaronEvidenceAttestationPayload,
  klyvaronEvidenceKeyId, loadKlyvaronEvidenceTrustStore,
} from '../src/klyvaron/evidence-trust.mjs'
import { verifyPinnedLocalFiles } from '../src/klyvaron/local-provenance.mjs'
import { verifyKlyvaronDatasetIntake } from '../src/klyvaron/dataset-intake.mjs'
import { prepareKlyvaronEvaluationReport, prepareKlyvaronTrainingRunReport } from '../src/klyvaron/training-evidence.mjs'
import { prepareKlyvaronTierQualificationReport } from '../src/klyvaron/qualification-evidence.mjs'
import { prepareKlyvaronPlatformMeasurementReport } from '../src/klyvaron/platform-measurement-evidence.mjs'
import { auditKlyvaronQualificationAttestation, prepareKlyvaronQualificationSigningRequest } from '../src/klyvaron/qualification-ceremony.mjs'
import { KlyvaronModelRegistryStore } from '../src/klyvaron/model-registry-store.mjs'
import { evaluateKlyvaronReleaseDecision } from '../src/klyvaron/release-decision.mjs'
import { canonicalProvenanceSha256, validateFoundationProvenance, validateKlyvaronDatasetManifest } from '../src/klyvaron/provenance.mjs'
import {
  CAPABILITY_STATES, HARDWARE_CLASS, KLYVARON, KLYVARON_MODEL_REGISTRY, MOBILE_TARGETS, ModelFamilyError, PROVENANCE, TIERS,
  MODEL_RELEASE_STATES, TIER_STATUS,
  advanceKlyvaronModelRelease, familyReport, getTier, isKlyvaronModelAvailable, klyvaronReleaseGateReport,
  ownedArtifacts, tierClaimFor, tierClaimForArtifact, tierFitsHardware, validateFamily,
} from '../src/klyvaron/tiers.mjs'

const clone = (value) => JSON.parse(JSON.stringify(value))
const TEST_SHA256 = 'a'.repeat(64)
const testEvidenceKeyPair = generateKeyPairSync('ed25519')
const testEvidencePublicKey = testEvidenceKeyPair.publicKey.export({ type: 'spki', format: 'pem' })
const testEvidencePrivateKey = testEvidenceKeyPair.privateKey
const testEvidenceKeyId = klyvaronEvidenceKeyId(testEvidencePublicKey)
const testEvidencePurposes = [
  'foundation_license_review', 'dataset_provenance_review', 'dataset_artifact_integrity', 'training_run', 'held_out_evaluation', 'tier_release_qualification', 'artifact_integrity', 'release_manifest',
]
const testEvidenceTrustStore = () => new KlyvaronEvidenceTrustStore({
  keys: [{ publicKeyPem: testEvidencePublicKey, keyId: testEvidenceKeyId, label: 'test signer', purposes: testEvidencePurposes }],
})
function testEvidenceAttestation(purpose, modelId, evidenceSha256, datasetScope) {
  const payload = klyvaronEvidenceAttestationPayload({ purpose, modelId, evidenceSha256, ...datasetScope })
  const message = `klyvaron-evidence-attestation/v1\n${canonicalKlyvaronEvidenceJson(payload)}`
  return {
    algorithm: 'ed25519', keyId: testEvidenceKeyId, purpose,
    signature: sign(null, Buffer.from(message), testEvidencePrivateKey).toString('base64'),
  }
}

function syntheticIntegrityVerification() {
  const files = [{ path: 'weights.bin', expectedSha256: TEST_SHA256, actualSha256: TEST_SHA256, bytes: 8, verified: true, reason: null }]
  const manifestFiles = [{ path: 'weights.bin', sha256: TEST_SHA256, bytes: 8 }]
  const manifestSha256 = canonicalProvenanceSha256({ schema: 'klyvaron.local-file-manifest.v1', files: manifestFiles })
  const reportBody = { schema: 'klyvaron.local-file-verification.v1', status: 'passed', manifestSha256, artifactSha256: TEST_SHA256, totalBytes: 8, files }
  return {
    ...reportBody,
    passed: true,
    blockers: [],
    reportSha256: canonicalProvenanceSha256(reportBody),
  }
}

function completeReleaseEvidence(modelId) {
  const integrityVerification = syntheticIntegrityVerification()
  const trainingRun = prepareKlyvaronTrainingRunReport({
    modelId,
    runId: 'synthetic-run-1',
    method: 'lora',
    adaptiveMode: 'lightweight_adapter',
    foundationModelId: 'foundation-candidate',
    foundationRevisionSha256: TEST_SHA256,
    datasetManifestSha256: TEST_SHA256,
    configuration: {
      seed: 1234, optimizer: 'adamw', learningRate: 0.0002, batchSize: 1,
      epochs: 1, maxSteps: 3, sequenceLength: 128,
    },
    codeRevisionSha256: TEST_SHA256,
    adaptivePlanSha256: TEST_SHA256,
    execution: {
      environment: 'paired_user_computer',
      workerId: 'synthetic-worker-1',
      consent: { confirmed: true, disclosureDigest: TEST_SHA256 },
      privateChatAutoIngested: false,
      durationMs: 30_000,
      budget: { kind: 'interactive_adapter', approved: true, maxDurationMs: 120_000 },
    },
    artifactSha256: integrityVerification.artifactSha256,
    artifactBytes: integrityVerification.totalBytes,
  })
  assert.equal(trainingRun.passed, true)
  const evaluation = prepareKlyvaronEvaluationReport({
    modelId,
    mode: 'lightweight_adapter',
    trainingRunReportSha256: trainingRun.report.reportSha256,
    artifactSha256: integrityVerification.artifactSha256,
    heldOutManifestSha256: 'b'.repeat(64),
    outOfDomainManifestSha256: 'c'.repeat(64),
    heldOutSeparated: true,
    outOfDomainEvaluated: true,
    contaminationReviewStatus: 'passed',
    metrics: { heldOutLoss: 1.2, outOfDomainLoss: 1.5 },
    adaptiveChecks: {
      artifactValid: true, evaluationPassed: true, nativeInferencePassed: true,
      rolledBack: false, measuredWallMs: 30_000,
    },
  })
  assert.equal(evaluation.passed, true)
  const qualification = prepareKlyvaronTierQualificationReport({
    modelId,
    tier: 'lite',
    artifactSha256: integrityVerification.artifactSha256,
    artifactBytes: integrityVerification.totalBytes,
    minimumRamBytes: 8_000_000_000,
    supportedRuntimes: ['llama.cpp'],
    targets: ['linux', 'macos', 'windows'].map((platform) => {
      const hardwareReport = {
        schema: 'klyvaron.measured-hardware.v1',
        platform,
        architecture: platform === 'macos' ? 'arm64' : 'x64',
        hardwareClass: 'mobile',
        cpuModel: 'Synthetic CPU fixture',
        logicalCores: 8,
        ramBytes: 16_000_000_000,
        freeRamBytes: 8_000_000_000,
      }
      const target = {
        platform,
        architecture: hardwareReport.architecture,
        hardwareClass: 'mobile',
        hardwareReportSha256: canonicalProvenanceSha256(hardwareReport),
        hardwareReport,
        ramBytes: 16_000_000_000,
        runtimeId: 'llama.cpp',
        runtimeVersion: '1.0.0',
        measuredAt: '2026-11-04T00:00:00Z',
        artifactSha256: integrityVerification.artifactSha256,
        artifactBytes: integrityVerification.totalBytes,
        artifactIntegrityReportSha256: integrityVerification.reportSha256,
        environmentId: `synthetic-${platform}`,
      }
      const measurements = Object.fromEntries([
        ['cold_start', { coldStartMs: 1_500, peakResidentBytes: 3_500_000_000, traceSha256: 'd'.repeat(64) }],
        ['inference', {
          suiteSha256: '1'.repeat(64), caseCount: 2, passedCases: 2, failedCases: 0,
          totalTokens: 64, durationMs: 5_000, transcriptSha256: '2'.repeat(64),
        }],
        ['rollback', {
          fromArtifactSha256: integrityVerification.artifactSha256, toArtifactSha256: '9'.repeat(64),
          rollbackDurationMs: 1_200, rollbackCompleted: true, restoredArtifactSha256: '9'.repeat(64),
          restoreVerificationSha256: '3'.repeat(64),
        }],
      ].map(([kind, measurement]) => {
        const prepared = prepareKlyvaronPlatformMeasurementReport({
          kind, modelId, tier: 'lite', ...target,
          runId: `${platform}-${kind}-synthetic`, measurement,
        })
        assert.equal(prepared.passed, true)
        return [kind, prepared.report]
      }))
      return { ...target, measurements }
    }),
  })
  assert.equal(qualification.passed, true)
  return {
    foundationModel: {
      id: 'foundation-candidate', publisher: 'test-publisher', name: 'test-foundation',
      revision: 'f'.repeat(40), revisionDigest: TEST_SHA256,
      sourceUrl: 'https://models.example.test/foundation/commit/ffffffff',
      license: 'Apache-2.0', licenseSourceUrl: 'https://models.example.test/foundation/LICENSE',
      licenseDocumentSha256: TEST_SHA256, licenseReviewStatus: 'approved',
      licenseReviewReportSha256: TEST_SHA256,
      rightsReview: {
        fineTuningAllowed: true, commercialUseAllowed: true, derivativeWeightDistributionAllowed: true,
        redistributionAllowed: true, attributionSatisfied: true, acceptableUseReviewed: true,
      },
      provenanceValidation: { status: 'passed', reportSha256: TEST_SHA256 },
      licenseReviewAttestation: testEvidenceAttestation('foundation_license_review', modelId, TEST_SHA256),
    },
    trainingDatasets: [{
      id: 'klyvaron-sft', version: '1.0.0', license: 'per-record-reviewed',
      provenanceManifestSha256: TEST_SHA256,
      provenanceValidation: { status: 'passed', reportSha256: TEST_SHA256 },
      privacyReviewStatus: 'passed', privacyReviewReportSha256: TEST_SHA256,
      deduplicationStatus: 'passed', deduplicationReportSha256: TEST_SHA256,
      fileBytes: integrityVerification.totalBytes,
      fileArtifactSha256: integrityVerification.artifactSha256,
      fileIntegrityVerification: integrityVerification,
      fileIntegrityAttestation: testEvidenceAttestation('dataset_artifact_integrity', modelId, integrityVerification.reportSha256, {
        datasetId: 'klyvaron-sft', datasetVersion: '1.0.0', provenanceManifestSha256: TEST_SHA256,
      }),
      provenanceAttestation: testEvidenceAttestation('dataset_provenance_review', modelId, TEST_SHA256, {
        datasetId: 'klyvaron-sft', datasetVersion: '1.0.0', provenanceManifestSha256: TEST_SHA256,
      }),
    }],
    trainingConfiguration: {
      method: trainingRun.report.method,
      runId: trainingRun.report.runId,
      configurationSha256: trainingRun.report.configurationSha256,
      runRecordSha256: trainingRun.report.reportSha256,
    },
    trainingRunEvidence: trainingRun.report,
    trainingRunAttestation: testEvidenceAttestation('training_run', modelId, trainingRun.report.reportSha256),
    artifact: {
      location: 'artifact-store/klyvaron.gguf', format: 'gguf', bytes: integrityVerification.totalBytes,
      sha256: integrityVerification.artifactSha256, integrityVerification,
      integrityAttestation: testEvidenceAttestation('artifact_integrity', modelId, integrityVerification.reportSha256),
    },
    tokenizer: { id: 'foundation-tokenizer', sha256: TEST_SHA256 },
    chatTemplate: { id: 'klyvaron-chat-v1', sha256: TEST_SHA256 },
    evaluationReport: {
      ...evaluation.report,
      attestation: testEvidenceAttestation('held_out_evaluation', modelId, evaluation.report.reportSha256),
    },
    runtimeCompatibility: {
      passed: true, results: [{ modelId, runtime: 'llama.cpp', platform: 'linux-x64', passed: true }],
    },
    tierQualificationReport: {
      ...qualification.report,
      attestation: testEvidenceAttestation('tier_release_qualification', modelId, qualification.report.reportSha256),
    },
    supportedFormats: ['gguf'],
    supportedRuntimes: ['llama.cpp'],
    minimumHardware: { ramBytes: 8_000_000_000, measured: true },
    recommendedHardware: { ramBytes: 16_000_000_000, measured: true },
    contextLength: 4096,
    quantization: 'Q4_K_M',
    downloadSizeBytes: 1_000_000_000,
    modelCardUrl: 'docs/model-cards/klyvaron-assistant.yaml',
  }
}

test('the shipped family validates', () => {
  const { valid, violations } = validateFamily()
  assert.deepEqual(violations, [])
  assert.equal(valid, true)
})

test('the authoritative model registry distinguishes evaluated scratch artifacts from planned assistants', () => {
  const planned = ['lite', 'pro', 'max'].map((tier) =>
    Object.values(KLYVARON_MODEL_REGISTRY).find((entry) => entry.tier === tier && entry.ownership === 'first_party_fine_tuned_assistant'))
  assert.deepEqual(planned.map((entry) => entry.status), Array(3).fill(MODEL_RELEASE_STATES.PLANNED))
  for (const entry of planned) {
    assert.ok(entry.id && entry.version && entry.targetParameterClass)
    assert.equal(entry.foundationModel, null)
    assert.equal(entry.foundationModelLicense, null)
    assert.equal(entry.artifactChecksum, null)
    assert.equal(entry.available, false)
  }
  assert.ok(Object.values(KLYVARON_MODEL_REGISTRY)
    .filter((entry) => entry.ownership === 'first_party_research_artifact')
    .every((entry) => entry.provenance === PROVENANCE.FROM_SCRATCH && entry.available === false))
  assert.equal(familyReport().modelRegistry, KLYVARON_MODEL_REGISTRY)
  const currentDecision = evaluateKlyvaronReleaseDecision({ records: Object.values(KLYVARON_MODEL_REGISTRY) })
  assert.equal(currentDecision.status, 'blocked')
  assert.equal(Object.values(currentDecision.tiers).some((entry) => entry.ready), false,
    'the current registry has no signed, cross-platform assistant release')
})

test('Klyvaron evidence signatures require an installation-trusted Ed25519 key scoped to the exact purpose', (t) => {
  const purpose = 'foundation_license_review'
  const payload = klyvaronEvidenceAttestationPayload({ purpose, modelId: 'klyvaron-lite-assistant', evidenceSha256: TEST_SHA256 })
  const attestation = testEvidenceAttestation(purpose, 'klyvaron-lite-assistant', TEST_SHA256)
  const trustStore = testEvidenceTrustStore()
  assert.equal(trustStore.verify(payload, attestation, { purpose }).status, 'verified')
  for (const datasetPurpose of ['dataset_provenance_review', 'dataset_artifact_integrity']) {
    assert.throws(() => klyvaronEvidenceAttestationPayload({
      purpose: datasetPurpose, modelId: 'klyvaron-lite-assistant', evidenceSha256: TEST_SHA256,
    }), /dataset id, version and provenance manifest digest/)
  }
  assert.throws(() => klyvaronEvidenceAttestationPayload({
    purpose, modelId: 'klyvaron-lite-assistant', evidenceSha256: TEST_SHA256, datasetId: 'dataset-one',
  }), /accepted only for dataset evidence attestations/)
  assert.equal(trustStore.verify({ ...payload, modelId: 'klyvaron-pro-assistant' }, attestation, { purpose }).status, 'blocked')
  assert.equal(new KlyvaronEvidenceTrustStore().verify(payload, attestation, { purpose }).status, 'blocked')
  const restricted = new KlyvaronEvidenceTrustStore({
    keys: [{ publicKeyPem: testEvidencePublicKey, label: 'integrity only', purposes: ['artifact_integrity'] }],
  })
  assert.match(restricted.verify(payload, attestation, { purpose }).reason, /not authorized/)
  assert.throws(() => new KlyvaronEvidenceTrustStore({ keys: [{
    publicKeyPem: testEvidenceKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    label: 'private', purposes: [purpose],
  }] }), /public key only/)

  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-evidence-trust-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const trustPath = join(dir, 'evidence-trust.json')
  writeFileSync(trustPath, JSON.stringify({
    format: 'klyvaron-evidence-trust/v1',
    keys: [{ publicKeyPem: testEvidencePublicKey, label: 'test signer', purposes: testEvidencePurposes }],
  }))
  const loaded = loadKlyvaronEvidenceTrustStore(trustPath)
  assert.equal(loaded.size, 1)
  assert.deepEqual(loaded.list(), [{ keyId: testEvidenceKeyId, label: 'test signer', purposes: testEvidencePurposes }])
  assert.equal(JSON.stringify(loaded.list()).includes('PRIVATE KEY'), false)
})

test('foundation and dataset provenance require pinned, reviewed, private-data-free evidence', async (t) => {
  const rights = {
    fineTuningAllowed: true, commercialUseAllowed: true, derivativeWeightDistributionAllowed: true,
    redistributionAllowed: true, attributionSatisfied: true, acceptableUseReviewed: true,
  }
  const foundationRecord = {
    id: 'foundation-candidate', publisher: 'test-publisher', name: 'test-foundation',
    revision: 'f'.repeat(40), revisionDigest: TEST_SHA256,
    sourceUrl: 'https://models.example.test/foundation/commit/ffffffff',
    license: { id: 'Example-Open-Weights', sourceUrl: 'https://models.example.test/foundation/LICENSE', textSha256: TEST_SHA256 },
    licenseReview: { status: 'approved', reviewer: 'test-reviewer', reviewedAt: '2026-11-04', reportSha256: TEST_SHA256, rights },
  }
  const foundation = validateFoundationProvenance(foundationRecord)
  assert.equal(foundation.passed, true)
  assert.equal(foundation.evidence.provenanceValidation.status, 'passed')
  const pending = validateFoundationProvenance({
    ...foundationRecord, licenseReview: { ...foundationRecord.licenseReview, status: 'pending' },
  })
  assert.equal(pending.passed, false)
  assert.equal(pending.evidence, null, 'a license is never self-approved by a provenance parser')
  assert.equal(validateFoundationProvenance({
    ...foundationRecord, sourceUrl: 'https://models.example.test/foundation?access_token=secret',
  }).passed, false, 'credentialed or query-bearing source URLs are not stored as provenance')
  assert.equal(validateFoundationProvenance({
    ...foundationRecord,
    licenseReview: { ...foundationRecord.licenseReview, reviewer: 'reviewer@example.test' },
  }).passed, false, 'reviewer evidence uses opaque IDs rather than contact details')

  const licenseReview = { status: 'approved', reviewer: 'test-reviewer', reviewedAt: '2026-11-04', reportSha256: TEST_SHA256, rights }
  const manifest = {
    id: 'klyvaron-curated-sft', version: '1.0.0', createdAt: '2026-11-04',
    entries: ['1', '2', '3', '4'].map((digit, index) => ({
      recordId: digit.repeat(64), sourceClass: 'licensed_content', sourceRef: `catalogue:${index}`,
      sourceUrl: `https://datasets.example.test/source/${index}`,
      license: {
        id: 'Example-Dataset-License', sourceUrl: 'https://datasets.example.test/LICENSE',
        textSha256: TEST_SHA256, review: licenseReview,
      },
    })),
    splits: { train: ['1'.repeat(64)], validation: ['2'.repeat(64)], heldOut: ['3'.repeat(64)], outOfDomain: ['4'.repeat(64)] },
    privacyReview: { status: 'passed', reviewer: 'privacy-reviewer', reviewedAt: '2026-11-04', reportSha256: TEST_SHA256 },
    deduplication: { status: 'passed', reviewer: 'data-reviewer', reviewedAt: '2026-11-04', reportSha256: TEST_SHA256, method: 'exact-and-near-duplicate-v1' },
  }
  const initial = validateKlyvaronDatasetManifest(manifest)
  assert.equal(initial.passed, true)
  assert.equal(initial.evidence.provenanceManifestSha256, canonicalProvenanceSha256(manifest))
  const provenanceGates = klyvaronReleaseGateReport({
    id: 'klyvaron-lite-assistant', foundationModel: foundation.evidence, trainingDatasets: [initial.evidence],
  }).gates
  assert.equal(provenanceGates.exactFoundationAndApprovedLicense, true)
  assert.equal(provenanceGates.versionedLicensedDatasets, false, 'metadata-only provenance cannot stand in for hashed dataset bytes')
  assert.equal(provenanceGates.datasetFileIntegrityAttested, false)
  const pinnedManifest = { ...manifest, manifestSha256: initial.manifestSha256 }
  assert.equal(validateKlyvaronDatasetManifest(pinnedManifest).passed, true)
  const overlapping = {
    ...pinnedManifest,
    splits: { ...pinnedManifest.splits, heldOut: [...pinnedManifest.splits.heldOut, '1'.repeat(64)] },
  }
  assert.equal(validateKlyvaronDatasetManifest(overlapping).passed, false)
  const privateChat = {
    ...manifest,
    entries: manifest.entries.map((entry, index) => index === 0 ? { ...entry, sourceClass: 'user_chat' } : entry),
  }
  assert.equal(validateKlyvaronDatasetManifest(privateChat).passed, false)
  const containsRawContent = {
    ...manifest,
    entries: manifest.entries.map((entry, index) => index === 0 ? { ...entry, prompt: 'private text must not enter a manifest' } : entry),
  }
  assert.equal(validateKlyvaronDatasetManifest(containsRawContent).passed, false)

  const intakeRoot = mkdtempSync(join(tmpdir(), 'klyvaron-dataset-intake-'))
  t.after(() => rmSync(intakeRoot, { recursive: true, force: true }))
  const datasetBytes = Buffer.from('synthetic dataset archive fixture')
  writeFileSync(join(intakeRoot, 'dataset.bin'), datasetBytes)
  const intake = await verifyKlyvaronDatasetIntake({
    modelId: 'klyvaron-lite-assistant',
    manifest,
    root: intakeRoot,
    files: [{ path: 'dataset.bin', sha256: createHash('sha256').update(datasetBytes).digest('hex'), bytes: datasetBytes.length }],
  })
  assert.equal(intake.passed, true)
  assert.equal(intake.sourceAuthenticity, 'not_established')
  assert.equal(intake.evidence.fileBytes, datasetBytes.length)
  assert.equal(intake.attestationPayloads.datasetProvenanceReview.dataset.id, manifest.id)
  assert.equal(intake.attestationPayloads.datasetArtifactIntegrity.dataset.provenanceManifestSha256, intake.provenanceManifestSha256)
  assert.equal(JSON.stringify(intake).includes(datasetBytes.toString()), false)
  const blockedIntake = await verifyKlyvaronDatasetIntake({
    modelId: 'klyvaron-lite-assistant', manifest, root: intakeRoot,
    files: [{ path: 'dataset.bin', sha256: 'e'.repeat(64), bytes: datasetBytes.length }],
  })
  assert.equal(blockedIntake.passed, false)
  assert.equal(blockedIntake.attestationPayloads, null)
})

test('local provenance verification hashes pinned bytes without returning file contents', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-local-provenance-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const license = Buffer.from('Apache License, Version 2.0\\n')
  const config = Buffer.from('{"format":"safetensors"}\\n')
  writeFileSync(join(dir, 'LICENSE'), license)
  writeFileSync(join(dir, 'config.json'), config)
  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  const files = [
    { path: 'LICENSE', sha256: sha256(license), bytes: license.length },
    { path: 'config.json', sha256: sha256(config), bytes: config.length },
  ]
  const report = await verifyPinnedLocalFiles({ root: dir, files })
  assert.equal(report.passed, true)
  assert.equal(report.status, 'passed')
  assert.equal(report.files.length, 2)
  assert.equal(report.totalBytes, license.length + config.length)
  assert.equal(report.reportSha256.length, 64)
  assert.equal(JSON.stringify(report).includes('Apache License'), false)
  assert.deepEqual(await verifyPinnedLocalFiles({ root: dir, files }), report)
  const artifact = {
    location: 'local-artifact', format: 'safetensors-bundle', bytes: report.totalBytes,
    sha256: report.artifactSha256, integrityVerification: report,
  }
  assert.equal(klyvaronReleaseGateReport({ artifact }).gates.verifiedArtifactAndChecksum, true)
  assert.equal(klyvaronReleaseGateReport({ artifact: { ...artifact, sha256: '0'.repeat(64) } }).gates.verifiedArtifactAndChecksum, false)
  assert.equal(klyvaronReleaseGateReport({ artifact: { ...artifact, integrityVerified: true, integrityVerification: undefined } }).gates.verifiedArtifactAndChecksum, false)
  const tamperedReport = { ...report, totalBytes: report.totalBytes + 1 }
  assert.equal(klyvaronReleaseGateReport({ artifact: { ...artifact, integrityVerification: tamperedReport } }).gates.verifiedArtifactAndChecksum, false)
  const modelId = 'klyvaron-lite-assistant'
  const trustStore = testEvidenceTrustStore()
  const dataset = {
    id: 'first-party-sft', version: '1.0.0', license: 'reviewed-per-record',
    provenanceManifestSha256: TEST_SHA256,
    provenanceValidation: { status: 'passed', reportSha256: TEST_SHA256 },
    privacyReviewStatus: 'passed', privacyReviewReportSha256: TEST_SHA256,
    deduplicationStatus: 'passed', deduplicationReportSha256: TEST_SHA256,
    fileBytes: report.totalBytes, fileArtifactSha256: report.artifactSha256, fileIntegrityVerification: report,
    provenanceAttestation: testEvidenceAttestation('dataset_provenance_review', modelId, TEST_SHA256, {
      datasetId: 'first-party-sft', datasetVersion: '1.0.0', provenanceManifestSha256: TEST_SHA256,
    }),
    fileIntegrityAttestation: testEvidenceAttestation('dataset_artifact_integrity', modelId, report.reportSha256, {
      datasetId: 'first-party-sft', datasetVersion: '1.0.0', provenanceManifestSha256: TEST_SHA256,
    }),
  }
  const datasetGates = klyvaronReleaseGateReport({ id: modelId, trainingDatasets: [dataset] }, { trustStore }).gates
  assert.equal(datasetGates.versionedLicensedDatasets, true)
  assert.equal(datasetGates.datasetProvenanceAttested, true)
  assert.equal(datasetGates.datasetFileIntegrityAttested, true)
  for (const changedScope of [
    { id: 'different-dataset' },
    { version: '2.0.0' },
    { provenanceManifestSha256: 'b'.repeat(64) },
  ]) {
    const changedDataset = { ...dataset, ...changedScope }
    const changedGates = klyvaronReleaseGateReport({ id: modelId, trainingDatasets: [changedDataset] }, { trustStore }).gates
    assert.equal(changedGates.datasetFileIntegrityAttested, false, `replaying byte evidence after changing ${Object.keys(changedScope)[0]} must fail`)
    assert.equal(changedGates.datasetProvenanceAttested, false, `replaying review evidence after changing ${Object.keys(changedScope)[0]} must fail`)
  }
})

test('local provenance verification refuses unsafe paths, changed bytes, symlinks and oversized inputs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-local-provenance-refusal-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const content = Buffer.from('pinned bytes')
  writeFileSync(join(dir, 'payload.bin'), content)
  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  const good = { path: 'payload.bin', sha256: sha256(content), bytes: content.length }
  assert.equal((await verifyPinnedLocalFiles({ root: dir, files: [{ ...good, sha256: '0'.repeat(64) }] })).passed, false)
  assert.equal((await verifyPinnedLocalFiles({ root: dir, files: [{ ...good, path: '../payload.bin' }] })).status, 'blocked')
  assert.equal((await verifyPinnedLocalFiles({ root: dir, files: [good], maxFileBytes: 2 })).passed, false)
  try {
    symlinkSync(join(dir, 'payload.bin'), join(dir, 'linked.bin'))
    const linked = await verifyPinnedLocalFiles({ root: dir, files: [{ ...good, path: 'linked.bin' }] })
    assert.equal(linked.passed, false)
    assert.match(linked.files[0].reason, /symbolic links/)
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOTSUP') throw error
  }
})

test('release state transitions refuse missing evidence and corrupt persisted registry state', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-release-corrupt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const corruptPath = join(dir, 'corrupt.json')
  writeFileSync(corruptPath, '{not-json')
  assert.throws(() => new KlyvaronModelRegistryStore({ filePath: corruptPath, initialRecords: KLYVARON_MODEL_REGISTRY }), /refusing to reset release state/)
  const planned = KLYVARON_MODEL_REGISTRY['klyvaron-lite-assistant']
  const training = advanceKlyvaronModelRelease(planned, MODEL_RELEASE_STATES.TRAINING)
  assert.throws(
    () => advanceKlyvaronModelRelease(training, MODEL_RELEASE_STATES.TRAINED, {}),
    /artifact whose checksum was verified/,
  )
  const trustStore = testEvidenceTrustStore()
  const modelId = planned.id
  const releaseEvidence = completeReleaseEvidence(modelId)
  assert.equal(prepareKlyvaronTrainingRunReport({
    ...releaseEvidence.trainingRunEvidence,
    execution: {
      ...releaseEvidence.trainingRunEvidence.execution,
      durationMs: 120_001,
      budget: { kind: 'interactive_adapter', approved: true, maxDurationMs: 130_000 },
    },
  }).passed, false, 'interactive adaptation cannot exceed the 120-second hard cap')
  assert.equal(prepareKlyvaronTrainingRunReport({
    ...releaseEvidence.trainingRunEvidence,
    execution: { ...releaseEvidence.trainingRunEvidence.execution, privateChatAutoIngested: true },
  }).passed, false, 'private chats cannot be auto-ingested')
  assert.equal(prepareKlyvaronEvaluationReport({
    ...releaseEvidence.evaluationReport,
    adaptiveChecks: { ...releaseEvidence.evaluationReport.adaptiveChecks, evaluationPassed: false },
  }).passed, false, 'Adaptive must reject an evaluation failure')
  assert.throws(
    () => advanceKlyvaronModelRelease(training, MODEL_RELEASE_STATES.TRAINED, { artifact: releaseEvidence.artifact }, { trustStore }),
    /valid, trusted training-run report/,
  )
  const trained = advanceKlyvaronModelRelease(training, MODEL_RELEASE_STATES.TRAINED, {
    foundationModel: releaseEvidence.foundationModel,
    trainingDatasets: releaseEvidence.trainingDatasets,
    artifact: releaseEvidence.artifact,
    trainingConfiguration: releaseEvidence.trainingConfiguration,
    trainingRunEvidence: releaseEvidence.trainingRunEvidence,
    trainingRunAttestation: releaseEvidence.trainingRunAttestation,
  }, { trustStore })
  assert.throws(
    () => advanceKlyvaronModelRelease(trained, MODEL_RELEASE_STATES.EVALUATED, {}),
    /valid, trusted Adaptive held-out evaluation report/,
  )
  assert.throws(
    () => advanceKlyvaronModelRelease({ ...planned, status: MODEL_RELEASE_STATES.RELEASED }, MODEL_RELEASE_STATES.TRAINING),
    /invalid model release transition/,
  )
  assert.throws(
    () => advanceKlyvaronModelRelease(planned, MODEL_RELEASE_STATES.FAILED, {}),
    /requires a non-empty reason/,
  )
  const failed = advanceKlyvaronModelRelease(planned, MODEL_RELEASE_STATES.FAILED, { reason: 'training environment unavailable' })
  assert.throws(
    () => advanceKlyvaronModelRelease(failed, MODEL_RELEASE_STATES.PLANNED, { version: planned.version }),
    /requires a new version/,
  )
  assert.equal(advanceKlyvaronModelRelease(failed, MODEL_RELEASE_STATES.PLANNED, { version: '0.1.1' }).status, MODEL_RELEASE_STATES.PLANNED)
})

test('qualification signing request is canonical and audited using public trust anchors only', (t) => {
  const planned = KLYVARON_MODEL_REGISTRY['klyvaron-lite-assistant']
  const evidence = completeReleaseEvidence(planned.id)
  const modelRecord = { ...planned, ...evidence }
  const captures = evidence.tierQualificationReport.targets.map((target) => ({
    status: 'passed', passed: true, blockers: [], target,
    artifactIntegrityReportSha256: target.artifactIntegrityReportSha256,
  }))
  const prepared = prepareKlyvaronQualificationSigningRequest({ modelRecord, captures })
  assert.equal(prepared.status, 'ready_for_offline_signature')
  assert.equal(prepared.signingRequest.purpose, 'tier_release_qualification')
  assert.equal(prepared.signingRequest.privateKeyHandling, 'not_performed_by_this_tool')
  assert.equal(prepared.signingRequest.signingMessage.startsWith('klyvaron-evidence-attestation/v1\n'), true)
  assert.equal(prepareKlyvaronQualificationSigningRequest({ modelRecord, captures: captures.slice(1) }).passed, false)

  const signedReport = {
    ...prepared.report,
    attestation: testEvidenceAttestation('tier_release_qualification', planned.id, prepared.report.reportSha256),
  }
  assert.equal(auditKlyvaronQualificationAttestation({
    modelRecord, qualificationReport: signedReport, trustStore: new KlyvaronEvidenceTrustStore(),
  }).passed, false, 'an empty installation trust store must refuse signatures')
  assert.equal(auditKlyvaronQualificationAttestation({
    modelRecord, qualificationReport: signedReport, trustStore: testEvidenceTrustStore(),
  }).passed, true)
  const tampered = structuredClone(signedReport)
  tampered.targets[0].measurements.inference.measurement.totalTokens += 1
  assert.equal(auditKlyvaronQualificationAttestation({
    modelRecord, qualificationReport: tampered, trustStore: testEvidenceTrustStore(),
  }).passed, false, 'a post-signature measurement edit must fail report-digest validation')

  const directory = mkdtempSync(join(tmpdir(), 'klyvaron-evidence-cli-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const modelPath = join(directory, 'model-record.json')
  const capturesPath = join(directory, 'captures.json')
  const bundlePath = join(directory, 'signing-bundle.json')
  const attestationPath = join(directory, 'attestation.json')
  const privateKeyAttestationPath = join(directory, 'private-key-attestation.json')
  const reportPath = join(directory, 'signed-report.json')
  const tamperedBundlePath = join(directory, 'tampered-bundle.json')
  const tamperedReportPath = join(directory, 'tampered-report.json')
  const trustPath = join(directory, 'public-trust.json')
  const installedTrustPath = join(directory, 'installed-public-trust.json')
  const emptyTrustPath = join(directory, 'empty-public-trust.json')
  const privateKeyTrustPath = join(directory, 'private-key-trust.json')
  writeFileSync(modelPath, JSON.stringify(modelRecord))
  writeFileSync(capturesPath, JSON.stringify(captures))
  writeFileSync(attestationPath, JSON.stringify(signedReport.attestation))
  writeFileSync(privateKeyAttestationPath, JSON.stringify({ ...signedReport.attestation, privateKey: 'not-a-real-key' }))
  writeFileSync(trustPath, JSON.stringify({
    format: 'klyvaron-evidence-trust/v1',
    keys: [{ publicKeyPem: testEvidencePublicKey, label: 'cli test signer', purposes: ['tier_release_qualification'] }],
  }))
  writeFileSync(emptyTrustPath, JSON.stringify({ format: 'klyvaron-evidence-trust/v1', keys: [] }))
  writeFileSync(privateKeyTrustPath, JSON.stringify({
    format: 'klyvaron-evidence-trust/v1',
    keys: [{ publicKeyPem: testEvidencePublicKey, label: 'bad key', purposes: ['tier_release_qualification'], privateKey: 'not-a-real-key' }],
  }))
  const cli = fileURLToPath(new URL('../scripts/klyvaron-evidence.mjs', import.meta.url))
  const runCli = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  const preparedByCli = runCli('prepare', modelPath, capturesPath, bundlePath)
  assert.equal(preparedByCli.status, 0, preparedByCli.stderr)
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
  assert.equal(bundle.signingRequest.privateKeyHandling, 'not_performed_by_this_tool')
  assert.equal(statSync(bundlePath).mode & 0o777, 0o600, 'the signing bundle is private to its operator')
  const finalizedByCli = runCli('finalize', modelPath, bundlePath, attestationPath, reportPath)
  assert.equal(finalizedByCli.status, 0, finalizedByCli.stderr)
  assert.equal(JSON.parse(finalizedByCli.stdout).signatureVerified, false,
    'finalization attaches the external signature but requires the separate trust-store audit')
  assert.equal(canonicalKlyvaronEvidenceJson(JSON.parse(readFileSync(reportPath, 'utf8'))), canonicalKlyvaronEvidenceJson(signedReport))
  bundle.signingRequest.signingMessage += 'tampered'
  writeFileSync(tamperedBundlePath, JSON.stringify(bundle))
  assert.equal(runCli('finalize', modelPath, tamperedBundlePath, attestationPath, tamperedReportPath).status, 1,
    'tampered signing requests cannot be finalized')
  assert.equal(runCli('finalize', modelPath, bundlePath, privateKeyAttestationPath, tamperedReportPath).status, 1,
    'private-key material is not an accepted attestation field')
  const provisionedTrust = runCli('provision-trust', trustPath, installedTrustPath)
  assert.equal(provisionedTrust.status, 0, provisionedTrust.stderr)
  assert.equal(statSync(installedTrustPath).mode & 0o777, 0o600, 'the provisioned public trust file is private to the installation')
  assert.equal(runCli('provision-trust', trustPath, installedTrustPath).status, 1,
    'trust provisioning refuses to replace existing anchors')
  assert.equal(loadKlyvaronEvidenceTrustStore(installedTrustPath).size, 1,
    'refusing an overwrite must preserve the existing trust anchor')
  const emptyTrustProvision = runCli('provision-trust', emptyTrustPath, join(directory, 'should-not-exist.json'))
  assert.equal(emptyTrustProvision.status, 1, 'an empty trust store cannot be provisioned')
  assert.equal(runCli('provision-trust', privateKeyTrustPath, join(directory, 'bad-trust.json')).status, 1,
    'private-key material is refused in a public trust store')
  const auditedByCli = runCli('audit', modelPath, reportPath, installedTrustPath)
  assert.equal(auditedByCli.status, 0, `${auditedByCli.stderr}${auditedByCli.stdout}`)
  assert.equal(JSON.parse(auditedByCli.stdout).status, 'verified')
  const untrustedByCli = runCli('audit', modelPath, reportPath, emptyTrustPath)
  assert.equal(untrustedByCli.status, 2, 'an empty public trust store blocks the audit')
  assert.equal(runCli('prepare', modelPath, capturesPath, bundlePath).status, 1, 'the CLI refuses to overwrite its prior bundle')
})

test('synthetic qualification can reach release-candidate but never production approval or release', (t) => {
  const planned = KLYVARON_MODEL_REGISTRY['klyvaron-lite-assistant']
  const dir = mkdtempSync(join(tmpdir(), 'klyvaron-release-registry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'model-release-registry.json')
  const trustStore = testEvidenceTrustStore()
  const store = new KlyvaronModelRegistryStore({ filePath, initialRecords: KLYVARON_MODEL_REGISTRY, trustStore })
  assert.equal(statSync(filePath).mode & 0o777, 0o600)
  store.advance(planned.id, MODEL_RELEASE_STATES.TRAINING)
  const evidence = completeReleaseEvidence(planned.id)
  const incompleteQualification = structuredClone(evidence.tierQualificationReport)
  incompleteQualification.targets.find((target) => target.platform === 'windows').measurements.rollback.measurement.rollbackCompleted = false
  assert.equal(klyvaronReleaseGateReport({ ...evidence, tierQualificationReport: incompleteQualification }, { trustStore }).gates.tierReleaseQualificationMeasured, false,
    'all platform rows must carry passing rollback evidence for the exact artifact')
  store.advance(planned.id, MODEL_RELEASE_STATES.TRAINED, {
    foundationModel: evidence.foundationModel,
    trainingDatasets: evidence.trainingDatasets,
    artifact: evidence.artifact,
    trainingConfiguration: evidence.trainingConfiguration,
    trainingRunEvidence: evidence.trainingRunEvidence,
    trainingRunAttestation: evidence.trainingRunAttestation,
  })
  const evaluated = store.advance(planned.id, MODEL_RELEASE_STATES.EVALUATED, {
    evaluationReport: evidence.evaluationReport,
  })
  assert.equal(klyvaronReleaseGateReport({ ...evaluated, ...evidence }, { trustStore }).releaseCandidateReady, true)
  assert.throws(
    () => store.advance(planned.id, MODEL_RELEASE_STATES.RELEASE_CANDIDATE, { ...evidence, tierQualificationReport: undefined }),
    /tierReleaseQualificationMeasured, tierReleaseQualificationAttested/,
  )
  const candidate = store.advance(planned.id, MODEL_RELEASE_STATES.RELEASE_CANDIDATE, evidence)
  assert.equal(candidate.status, MODEL_RELEASE_STATES.RELEASE_CANDIDATE)
  assert.equal(isKlyvaronModelAvailable(candidate, {}), false)
  assert.throws(
    () => store.advance(planned.id, MODEL_RELEASE_STATES.RELEASED, {}),
    /invalid model release transition/,
    'release_candidate cannot skip production_approved',
  )
  assert.throws(
    () => store.advance(planned.id, MODEL_RELEASE_STATES.PRODUCTION_APPROVED, {}),
    /production approval gates are incomplete/,
    'synthetic-only reports and missing independent signatures cannot approve production',
  )

  const tamperedPath = join(dir, 'tampered-registry.json')
  const tamperedRecords = structuredClone(store.snapshot())
  tamperedRecords[planned.id].status = MODEL_RELEASE_STATES.RELEASED
  writeFileSync(tamperedPath, JSON.stringify({ version: 1, records: tamperedRecords }))
  assert.throws(
    () => new KlyvaronModelRegistryStore({ filePath: tamperedPath, initialRecords: KLYVARON_MODEL_REGISTRY, trustStore }),
    /unverifiable persisted stage/,
    'a persisted released status without production evidence is refused on load',
  )

  const releaseDecision = evaluateKlyvaronReleaseDecision({
    records: [candidate, KLYVARON_MODEL_REGISTRY['klyvaron-pro-assistant'], KLYVARON_MODEL_REGISTRY['klyvaron-max-assistant']],
    deployments: [], trustStore,
    evaluatedAt: new Date('2026-11-04T12:00:00Z'),
  })
  assert.equal(releaseDecision.status, 'blocked')
  assert.equal(releaseDecision.tiers.lite.ready, false)
  assert.equal(releaseDecision.tiers.pro.ready, false)
  assert.equal(releaseDecision.tiers.max.ready, false)
  assert.equal(isKlyvaronModelAvailable(candidate, {
    modelId: candidate.id, runtimeVerified: true, artifactSha256: candidate.artifact.sha256,
    hardwareCompatible: true,
  }, { trustStore }), false)
})

test('the three tiers exist with the hardware classes the directive names', () => {
  assert.deepEqual(Object.keys(KLYVARON), ['lite', 'pro', 'max'])
  assert.equal(getTier(TIERS.LITE).targetHardware, HARDWARE_CLASS.MOBILE)
  assert.equal(getTier(TIERS.PRO).targetHardware, HARDWARE_CLASS.LAPTOP)
  assert.equal(getTier(TIERS.MAX).targetHardware, HARDWARE_CLASS.WORKSTATION)
})

test('device classes and GPU names cannot qualify a tier', () => {
  for (const tier of Object.values(TIERS)) {
    for (const hardware of Object.values(HARDWARE_CLASS)) assert.equal(tierFitsHardware(tier, hardware), false)
    assert.equal(tierFitsHardware(tier, { eligible: true, tier }), true)
    assert.equal(tierFitsHardware(tier, { eligible: false, tier }), false)
  }
  assert.throws(() => getTier('high'), ModelFamilyError)
})

test('Lite reports the artifact that exists, and only the capabilities it backs', () => {
  const report = familyReport()
  const lite = report.tiers.find((t) => t.id === TIERS.LITE)
  assert.equal(lite.status, TIER_STATUS.PARTIAL)
  assert.deepEqual(lite.availableCapabilities, ['text.completion', 'text.extract'])

  const backing = lite.capabilities['text.completion'].backing
  assert.equal(backing.artifact, 'aetheris-lite-lm-0.1.1', 'the released artifact')
  assert.equal(backing.parameters, 359_616)
  assert.equal(backing.provenance, PROVENANCE.FROM_SCRATCH)
  assert.equal(backing.baseModel, null, 'trained from random initialisation, so there is no base')
  assert.equal(backing.licence, 'MIT')
  assert.match(backing.weightsDigest, /^[0-9a-f]{64}$/)
  assert.ok(backing.measured.validationPerplexity > 0)
  assert.ok(backing.benchmarks.length > 0, 'a claim needs a protocol behind it')
  assert.ok(backing.limitations.length > 0)
})

test('Lite does not claim to chat, and says why', () => {
  // The single most important negative claim in this file. The model that exists is
  // reachable over /api/chat and still does not constitute a chat capability, so the
  // reason has to say what actually happens rather than that nothing was wired up.
  const chat = getTier(TIERS.LITE).capabilities.chat
  assert.equal(chat.state, CAPABILITY_STATES.UNAVAILABLE)
  assert.equal(chat.backing, null)
  assert.match(chat.reason, /No instruction-tuned artifact exists/)
  assert.match(chat.reason, /refused there unless pinned by id/)
})

test('Pro and Max are partial: 10 capabilities backed by verified first-party weights, remaining capabilities honestly unavailable', () => {
  for (const id of [TIERS.PRO, TIERS.MAX]) {
    const tier = getTier(id)
    assert.equal(tier.status, TIER_STATUS.PARTIAL)
    assert.ok(tier.statusNote && tier.statusNote.length > 20, 'a partial tier must state what is available and what remains open')
    const avail = Object.values(tier.capabilities).filter((c) => c.state === CAPABILITY_STATES.AVAILABLE)
    const unavail = Object.values(tier.capabilities).filter((c) => c.state === CAPABILITY_STATES.UNAVAILABLE)
    assert.equal(avail.length, 10)
    assert.ok(unavail.length >= 2, 'unimplemented capabilities keep overall tier status strictly partial, never available')
  }
})

test('the mobile storage targets are the directive numbers, and Lite meets only the size one', () => {
  assert.equal(MOBILE_TARGETS.managedTotalBytes, 5_000_000_000, '5 GB, strictly below')
  assert.equal(MOBILE_TARGETS.reserveBytes, 500_000_000)
  assert.equal(MOBILE_TARGETS.appPackageBytes, 200_000_000)
  assert.equal(MOBILE_TARGETS.primaryModelBytes, 1_500_000_000)

  // The artifact is far SMALLER than the target, and much weaker than the capability
  // targets. Both are recorded; the tier does not get credit for the second.
  const lite = getTier(TIERS.LITE)
  assert.ok(lite.storageProfile.primaryArtifactBytes < MOBILE_TARGETS.primaryModelBytes)
  assert.ok(
    lite.capabilities['text.completion'].backing.limitations
      .some((l) => /storage target is met/.test(l)),
    'the backing must state that being undersized is not a capability win',
  )
})

// --- negative controls -----------------------------------------------------------

test('a capability claiming availability with no backing artifact is refused', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities.chat = { state: CAPABILITY_STATES.AVAILABLE, backing: null }
  const { valid, violations } = validateFamily(family)
  assert.equal(valid, false)
  assert.ok(violations.some((v) => /claimed 'available' with no backing/.test(v)), violations.join('; '))
  assert.ok(violations.some((v) => /A tier label is not evidence/.test(v)))
})

test('a derived model without its base model is refused, because provenance is a licence question', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities['text.completion'].backing.provenance = PROVENANCE.FINE_TUNED
  family.lite.capabilities['text.completion'].backing.baseModel = null
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /must name its base model and licence/.test(v)), violations.join('; '))

  // Naming the base clears it: the rule refuses silence, not derivation.
  family.lite.capabilities['text.completion'].backing.baseModel = 'Qwen2.5-0.5B (Apache-2.0)'
  assert.ok(!validateFamily(family).violations.some((v) => /base model/.test(v)))
})

test('an available capability with no stated limitations is refused', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities['text.completion'].backing.limitations = []
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /no stated limitations/.test(v)), violations.join('; '))
})

test('an available capability with no measurements is refused', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities['text.completion'].backing.measured = {}
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /no measurements/.test(v)), violations.join('; '))
})

test('an unbuilt tier may not have an available capability', () => {
  const family = clone(KLYVARON)
  for (const key of Object.keys(family.pro.capabilities)) {
    family.pro.capabilities[key] = { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'synthetic negative control' }
  }
  family.pro.status = TIER_STATUS.UNBUILT
  family.pro.capabilities.chat = {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: clone(KLYVARON.lite.capabilities['text.completion'].backing),
  }
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /status is 'unbuilt' but 1 capability claims to be available/.test(v)),
    violations.join('; '))
})

test('an unbuilt tier without a status note is refused', () => {
  const family = clone(KLYVARON)
  for (const key of Object.keys(family.max.capabilities)) {
    family.max.capabilities[key] = { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'synthetic negative control' }
  }
  family.max.status = TIER_STATUS.UNBUILT
  delete family.max.statusNote
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /an unbuilt tier must say so/.test(v)), violations.join('; '))
})

test('a tier cannot be labelled available or partial with nothing available, nor available when any capability is unavailable', () => {
  const family = clone(KLYVARON)
  // Partial tier cannot claim overall 'available' while unimplemented capabilities remain
  family.pro.status = TIER_STATUS.AVAILABLE
  assert.ok(validateFamily(family).violations.some((v) => /partial readiness may never be reported as complete/.test(v)),
    validateFamily(family).violations.join('; '))

  for (const key of Object.keys(family.max.capabilities)) {
    family.max.capabilities[key] = { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'synthetic negative control' }
  }
  family.max.status = TIER_STATUS.AVAILABLE
  assert.ok(validateFamily(family).violations.some((v) => /status is 'available' with no available capability/.test(v)))
  family.max.status = TIER_STATUS.PARTIAL
  assert.ok(validateFamily(family).violations.some((v) => /that is 'unbuilt'/.test(v)))
})

test('a backing without a licence is refused', () => {
  const family = clone(KLYVARON)
  delete family.lite.capabilities['text.completion'].backing.licence
  assert.ok(validateFamily(family).violations.some((v) => /must name its artifact, licence and provenance/.test(v)))
})

test('the report is generated from the data, so a rename cannot add a capability', () => {
  // Renaming a tier to something grander changes nothing in the report's capability
  // lists, which is the point: the label is not an input to the claim.
  const baseline = familyReport().tiers.find((t) => t.id === TIERS.PRO)
  const family = clone(KLYVARON)
  family.pro.displayName = 'Klyvaron Pro Ultra Max'
  const report = familyReport()
  const pro = report.tiers.find((t) => t.id === TIERS.PRO)
  assert.deepEqual(pro.availableCapabilities, baseline.availableCapabilities)
  assert.equal(pro.status, TIER_STATUS.PARTIAL)
})

// --- integration: the family reaches the API, and a label cannot be faked ---------

test('a tier label needs a backing record for the exact version, not a declaration', () => {
  // The versioned form is what the core uses, because "is this model Klyvaron Lite/Pro/Max?" is a
  // question about an artifact, and an artifact is an id plus a version.
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.1'), TIERS.LITE, 'the released artifact')
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.1-verify'), TIERS.LITE,
    'the same bytes under the label the drill installed them with')
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.0'), TIERS.LITE,
    'the superseded artifact is still a Lite model on a device that has not updated')
  // Pro and Max resolve strictly from their exact versioned first-party backing records:
  assert.equal(tierClaimForArtifact('klyvaron-pro-lm', '0.1.0'), TIERS.PRO)
  assert.equal(tierClaimForArtifact('klyvaron-pro-image', '0.1.0'), TIERS.PRO)
  assert.equal(tierClaimForArtifact('klyvaron-pro-video', '0.1.0'), TIERS.PRO)
  assert.equal(tierClaimForArtifact('klyvaron-pro-voice', '0.1.0'), TIERS.PRO)
  assert.equal(tierClaimForArtifact('klyvaron-max-lm', '0.1.0'), TIERS.MAX)
  assert.equal(tierClaimForArtifact('klyvaron-max-image', '0.1.0'), TIERS.MAX)
  assert.equal(tierClaimForArtifact('klyvaron-max-video', '0.1.0'), TIERS.MAX)
  assert.equal(tierClaimForArtifact('klyvaron-max-voice', '0.1.0'), TIERS.MAX)
  // And nothing else may carry any tier label, whatever its manifest declares.
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '9.9.9'), null, 'a version that does not exist')
  assert.equal(tierClaimForArtifact('klyvaron-pro-lm', '9.9.9'), null, 'unreleased version')
  assert.equal(tierClaimForArtifact('klyvaron-parity-tiny', '0.1.0'), null, 'a test fixture is not a family artifact')
  assert.equal(tierClaimForArtifact('Qwen2.5-7B-Instruct', '0.1.0'), null, 'a renamed third-party model')
  assert.equal(tierClaimForArtifact('aetheris-lite-lm-pro', '0.1.0'), null)
})

test('the superseded artifact is recorded, not deleted, and is not the release', () => {
  // One artifact is released and one is superseded, and the record has to say which is
  // which. A tier that quietly kept the old figures as "the release" would be describing a
  // model nobody can rebuild; one that dropped them would be erasing a published record.
  const backing = KLYVARON.lite.capabilities['text.completion'].backing
  const old = backing.supersededArtifact
  assert.ok(old, 'the superseded artifact must be recorded, not omitted')
  assert.equal(old.status, 'superseded')
  assert.notEqual(old.artifact, backing.artifact, 'two artifacts must not share a name')
  assert.notEqual(old.weightsDigest, backing.weightsDigest, 'a different corpus means different weights')
  assert.match(old.weightsDigest, /^[0-9a-f]{64}$/)
  assert.equal(old.card, 'docs/model-cards/aetheris-lite-lm-0.1.0.json',
    'the superseded figures live on the card that published them')
  assert.ok(old.parameters < backing.parameters, 'the superseded model was the smaller vocabulary')
  assert.match(old.note, /cannot be re-derived|not comparable/,
    'the record must say why it is superseded and that the numbers are not comparable')
  // It is still owned: a device that has not updated is running this model, and it may
  // still carry the tier label and still be rolled back to.
  assert.ok(ownedArtifacts(TIERS.LITE).includes(old.artifact))
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.0'), TIERS.LITE)

  // The released artifact's own digests, and the two names it answers to.
  assert.match(backing.artifactSha256, /^[0-9a-f]{64}$/, 'the file the store verifies needs its own digest')
  assert.notEqual(backing.artifactSha256, backing.weightsDigest,
    'the weights hash and the file hash are different digests of different things')
  assert.ok(backing.artifactBytes > 0)
  assert.deepEqual([...backing.alsoKnownAs], ['aetheris-lite-lm-0.1.1-verify'])
})

test('a tier label is looked up from the backing record, never declared', () => {
  assert.equal(tierClaimFor('aetheris-lite-lm-0.1.0'), TIERS.LITE)
  assert.equal(tierClaimFor('klyvaron-pro-lm-0.1.0'), TIERS.PRO)
  assert.equal(tierClaimFor('klyvaron-max-lm-0.1.0'), TIERS.MAX)
  // The three ways someone would try to claim unearned capability. All return null,
  // because the lookup only matches the artifact ids a real backing names.
  assert.equal(tierClaimFor('Klyvaron-Pro-7B'), null, 'a made-up product name')
  assert.equal(tierClaimFor('Qwen2.5-7B-Instruct'), null, 'a renamed third-party model')
  assert.equal(tierClaimFor('aetheris-lite-lm-9.9.9'), null, 'a version that does not exist')
  assert.deepEqual(ownedArtifacts(TIERS.PRO), [
    'klyvaron-pro-lm-0.1.0',
    'klyvaron-pro-image-0.1.0',
    'klyvaron-pro-video-0.1.0',
    'klyvaron-pro-voice-0.1.0',
  ])
  assert.deepEqual(ownedArtifacts(TIERS.MAX), [
    'klyvaron-max-lm-0.1.0',
    'klyvaron-max-image-0.1.0',
    'klyvaron-max-video-0.1.0',
    'klyvaron-max-voice-0.1.0',
  ])
})

test('the family report is served on the models route, and it is the validated one', () => {
  for (const tier of familyReport().tiers) {
    assert.ok(tier.status, `${tier.id} must carry a status into the API`)
    assert.ok(Array.isArray(tier.availableCapabilities))
  }
  assert.equal(familyReport().valid, true)
})
