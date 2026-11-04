import { validateKlyvaronProductionEvidencePackage } from './evidence-validator.mjs'
import { klyvaronProductionModelId } from './evidence-schema.mjs'
import { klyvaronReleaseGateReport } from '../model-registry.mjs'

/**
 * Tier-scoped production gate. This validates every signed report and real artifact byte,
 * and optionally binds the result to an existing registry record. It never makes a release
 * decision or changes registry state.
 */
export async function evaluateKlyvaronProductionReleaseGate({
  tier, version, packageDir, artifactRoot, trustStore, modelRecord = null, now = new Date(),
} = {}) {
  const evidence = await validateKlyvaronProductionEvidencePackage({
    tier, version, packageDir, artifactRoot, trustStore, now,
  })
  const blockers = [...evidence.blockers]
  let registryBinding = null
  if (modelRecord !== null) {
    const registryManifestSha256 = modelRecord?.productionEvidencePackage?.manifest?.manifestSha256
    const registryGateReport = klyvaronReleaseGateReport(modelRecord, { trustStore })
    const registryStateVerified = modelRecord?.status === 'production_approved'
      ? registryGateReport.productionApprovalReady
      : modelRecord?.status === 'released' && registryGateReport.releasedReady
    const matches = registryStateVerified
      && modelRecord?.id === klyvaronProductionModelId(tier)
      && modelRecord?.tier === tier
      && modelRecord?.version === version
      && modelRecord?.artifact?.sha256 === evidence.artifactSha256
      && modelRecord?.modelRevisionSha256 === evidence.modelRevisionSha256
      && ['production_approved', 'released'].includes(modelRecord?.status)
      && registryManifestSha256 === evidence.evidenceManifestSha256
    registryBinding = {
      passed: matches,
      status: matches ? 'matched' : 'blocked',
      evidenceManifestSha256: registryManifestSha256 ?? null,
      registryGatesPassed: Boolean(registryStateVerified),
    }
    if (!matches) blockers.push('registry record is not production-approved for this exact current evidence manifest, model revision, artifact and version')
  }
  const passed = evidence.passed && blockers.length === 0
  return {
    schema: 'klyvaron.production-release-gate.v1',
    tier,
    version,
    modelId: evidence.modelId,
    modelRevisionSha256: evidence.modelRevisionSha256,
    artifactSha256: evidence.artifactSha256,
    evidenceManifestSha256: evidence.evidenceManifestSha256,
    passed,
    status: passed ? 'passed' : 'blocked',
    blockers: [...new Set(blockers)],
    evidence,
    registryBinding,
  }
}
