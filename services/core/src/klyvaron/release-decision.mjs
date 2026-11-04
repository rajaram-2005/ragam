import { MODEL_RELEASE_STATES, isKlyvaronModelAvailable, klyvaronReleaseGateReport } from './model-registry.mjs'
import { canonicalProvenanceSha256 } from './provenance.mjs'

const TIERS = Object.freeze({
  lite: 'klyvaron-lite-assistant',
  pro: 'klyvaron-pro-assistant',
  max: 'klyvaron-max-assistant',
})
const PLATFORMS = Object.freeze(['linux', 'macos', 'windows'])
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function blocked(reason) { return { status: 'blocked', ready: false, blockers: [reason], tiers: {}, decisionSha256: null } }

/**
 * Produce an explicit per-tier family release decision. A tier is ready only after its
 * signed release gates pass and deployment evidence matches each measured OS target.
 * This evaluator consumes evidence; it does not run model or deployment tests.
 */
export function evaluateKlyvaronReleaseDecision({ records, deployments = [], trustStore = null, evaluatedAt = new Date() } = {}) {
  if (!Array.isArray(deployments) || !(evaluatedAt instanceof Date) || Number.isNaN(evaluatedAt.getTime())) {
    return blocked('deployment evidence must be an array and evaluation time must be a valid Date')
  }
  const entries = Array.isArray(records)
    ? records
    : (isRecord(records) ? Object.values(records) : [])
  if (!entries.every(isRecord)) return blocked('model release records must be plain records')

  const tiers = {}
  const deploymentKeys = new Set()
  const duplicateDeployments = new Set()
  for (const deployment of deployments) {
    const key = `${deployment?.tier ?? ''}|${deployment?.platform ?? ''}`
    if (deploymentKeys.has(key)) duplicateDeployments.add(key)
    deploymentKeys.add(key)
  }

  for (const [tier, modelId] of Object.entries(TIERS)) {
    const matching = entries.filter((record) => record.id === modelId && record.tier === tier)
    const blockers = []
    const platforms = {}
    if (matching.length !== 1) {
      blockers.push(matching.length === 0 ? 'canonical release record is missing' : 'duplicate canonical release records are present')
      for (const platform of PLATFORMS) platforms[platform] = { status: 'blocked', available: false, blocker: 'release record is ambiguous' }
      tiers[tier] = { modelId, status: 'blocked', ready: false, blockers, platforms }
      continue
    }

    const record = matching[0]
    const gate = klyvaronReleaseGateReport(record, { trustStore })
    if (!gate.releasedReady) blockers.push(...gate.blockers.map((name) => `release gate: ${name}`))
    if (record.status !== MODEL_RELEASE_STATES.RELEASED) blockers.push(`registry state is '${record.status}', not released`)

    for (const platform of PLATFORMS) {
      const key = `${tier}|${platform}`
      const target = record.tierQualificationReport?.targets?.find((entry) => entry?.platform === platform)
      const deployment = deployments.find((entry) => entry?.tier === tier && entry?.platform === platform)
      if (duplicateDeployments.has(key)) {
        platforms[platform] = { status: 'blocked', available: false, blocker: 'duplicate deployment records are present' }
        blockers.push(`${platform}: duplicate deployment records`)
      } else if (!target) {
        platforms[platform] = { status: 'blocked', available: false, blocker: 'no qualified target report' }
        blockers.push(`${platform}: no qualified target report`)
      } else if (!deployment) {
        platforms[platform] = { status: 'blocked', available: false, blocker: 'no matching deployment evidence' }
        blockers.push(`${platform}: no matching deployment evidence`)
      } else {
        const matched = isKlyvaronModelAvailable(record, deployment, { trustStore })
        platforms[platform] = {
          status: matched ? 'available' : 'blocked',
          available: matched,
          blocker: matched ? null : 'deployment does not match its signed qualified target',
        }
        if (!matched) blockers.push(`${platform}: deployment does not match its signed qualified target`)
      }
    }
    const ready = blockers.length === 0 && PLATFORMS.every((platform) => platforms[platform]?.available === true)
    tiers[tier] = { modelId, status: ready ? 'ready' : 'blocked', ready, blockers, platforms }
  }

  const readyTiers = Object.values(tiers).filter((entry) => entry.ready).length
  const status = readyTiers === Object.keys(TIERS).length ? 'ready' : readyTiers > 0 ? 'partial' : 'blocked'
  const body = {
    schema: 'klyvaron.family-release-decision.v1',
    evaluatedAt: evaluatedAt.toISOString(),
    status,
    tiers,
    blockers: Object.entries(tiers).filter(([, entry]) => !entry.ready)
      .map(([tier, entry]) => `${tier}: ${entry.blockers.join('; ')}`),
  }
  return {
    ...body,
    ready: status === 'ready',
    decisionSha256: canonicalProvenanceSha256(body),
  }
}
