import { evaluateKlyvaronProductionReleaseGate } from './release-gate.mjs'

export const KLYVARON_PRODUCTION_TIERS = Object.freeze(['lite', 'pro', 'max'])
export const KLYVARON_PROVISIONAL_DECISIONS = Object.freeze({
  lite: Object.freeze({ decision: 'HOLD', status: 'provisional', basis: 'production evidence not supplied or not independently verified' }),
  pro: Object.freeze({ decision: 'NOT RELEASED', status: 'provisional', basis: 'production evidence not supplied or not independently verified' }),
  max: Object.freeze({ decision: 'NOT RELEASED', status: 'provisional', basis: 'production evidence not supplied or not independently verified' }),
})

function validGate(report, tier) {
  return report?.schema === 'klyvaron.production-release-gate.v1'
    && report.tier === tier && report.passed === true && report.status === 'passed'
}

/** Decide independently per tier. Missing/blocked evidence never inherits another tier's pass. */
export function evaluateKlyvaronProductionDecision({ tier, gateReport = null, registryRecord = null } = {}) {
  const provisional = KLYVARON_PROVISIONAL_DECISIONS[tier]
  if (!provisional) return { tier, decision: 'NOT RELEASED', status: 'blocked', blockers: ['unknown tier'] }
  if (!validGate(gateReport, tier)) {
    return {
      tier,
      decision: provisional.decision,
      status: 'provisional',
      basis: provisional.basis,
      blockers: Array.isArray(gateReport?.blockers) && gateReport.blockers.length
        ? [...gateReport.blockers]
        : ['no passing, tier-specific production evidence gate report'],
    }
  }
  if (!registryRecord || registryRecord.id !== gateReport.modelId
    || registryRecord.version !== gateReport.version
    || registryRecord.modelRevisionSha256 !== gateReport.modelRevisionSha256
    || registryRecord.artifact?.sha256 !== gateReport.artifactSha256) {
    return { tier, decision: provisional.decision, status: 'provisional', basis: 'production evidence is not bound to the current registry artifact', blockers: ['registry and evidence identity mismatch'] }
  }
  if (registryRecord.status === 'released') {
    return { tier, decision: 'RELEASED', status: 'verified', basis: 'tier-specific production evidence and released registry state verified', blockers: [] }
  }
  if (registryRecord.status === 'production_approved') {
    return { tier, decision: 'PRODUCTION APPROVED', status: 'verified', basis: 'tier-specific production evidence and authorized approval verified', blockers: [] }
  }
  return {
    tier,
    decision: provisional.decision,
    status: 'provisional',
    basis: 'production evidence passed but the registry lifecycle has not reached an authorized production state',
    blockers: [`registry status '${registryRecord.status ?? 'missing'}' is not production_approved or released`],
  }
}

/** Evaluate Lite, Pro and Max separately, retaining the fail-closed provisional policy. */
export function evaluateKlyvaronProductionDecisions({ gateReports = {}, registryRecords = {} } = {}) {
  const decisions = Object.fromEntries(KLYVARON_PRODUCTION_TIERS.map((tier) => [tier,
    evaluateKlyvaronProductionDecision({
      tier,
      gateReport: gateReports[tier] ?? null,
      registryRecord: registryRecords[tier] ?? null,
    }),
  ]))
  return {
    schema: 'klyvaron.production-decisions.v1',
    status: Object.values(decisions).every((item) => item.status === 'verified') ? 'verified' : 'provisional',
    decisions,
  }
}

/** Run all three gates without sharing identity, signatures or approval across tiers. */
export async function evaluateKlyvaronProductionFamily({ tiers, trustStore, now = new Date() } = {}) {
  const entries = Object.fromEntries(await Promise.all(KLYVARON_PRODUCTION_TIERS.map(async (tier) => {
    const input = tiers?.[tier]
    if (!input) return [tier, null]
    return [tier, await evaluateKlyvaronProductionReleaseGate({ ...input, tier, trustStore, now })]
  })))
  return entries
}

/** Verify supplied tier packages before producing the corresponding independent decisions. */
export async function evaluateKlyvaronProductionFamilyDecision({ tiers, registryRecords = {}, trustStore, now = new Date() } = {}) {
  const gateReports = await evaluateKlyvaronProductionFamily({ tiers, trustStore, now })
  const decisions = evaluateKlyvaronProductionDecisions({ gateReports, registryRecords })
  return {
    schema: 'klyvaron.production-family-decision.v1',
    status: decisions.status,
    gateReports,
    decisions,
  }
}
