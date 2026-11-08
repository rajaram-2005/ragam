#!/usr/bin/env node
// Derive the provider-by-provider live qualification register from the code.
//
//   node scripts/release/generate-provider-register.mjs
//
// Nothing here is hand-maintained: the provider list, wire, auth kind,
// credential kind, status, official docs URL and default endpoint are read from
// the same modules the running service uses. Every provider is BLOCKED until a
// real call is made with an explicitly authorized test/staging credential.

import { PROVIDERS, catalogueReport } from '../../services/core/src/providers/catalog.mjs'
import { wireFor } from '../../services/core/src/providers/wires/index.mjs'
import { runtimeFor } from '../../services/core/src/online/gateway.mjs'
import { atRoot, writeJson } from './lib.mjs'

const NO_CREDENTIAL = new Set(['none'])
const register = PROVIDERS.map((provider) => {
  const wire = provider.wire ? (wireFor(provider.wire) ?? {}) : {}
  let runtime = null
  try { runtime = runtimeFor(provider.id) } catch { runtime = null }
  const officialEndpoint = wire.defaultBaseUrl ?? null
  const keyRequired = runtime?.keyRequired ?? !NO_CREDENTIAL.has(provider.credential)
  const needsCredential = provider.credential !== 'none' && keyRequired

  const configField = [
    `PUT /api/providers/${provider.id} body fields: baseUrl, apiKey${provider.id === 'fireworks' ? ', options.accountId' : ''}`,
  ]
  const storedField = '.aetheris-data/online/provider.json → connections["' + provider.id + '"].key (AES-256-GCM sealed; master.key in the same 0700 directory)'
  const hostedField = 'PUT /hosted/provider body fields: provider, apiKey, baseUrl → Supabase byok_provider_connections.credential (sealed with AETHERIS_PROVIDER_ENCRYPTION_KEY)'

  const hostedEnv = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AETHERIS_PROVIDER_ENCRYPTION_KEY', 'AETHERIS_HOSTED_ORIGINS', 'AETHERIS_HOSTED_SITE_URL']
  const pending = provider.status === 'pending'
  const status = pending ? 'NOT APPLICABLE' : 'BLOCKED'
  const justification = pending
    ? `Catalogue status 'pending': no wire adapter exists in this build and selectProvider refuses '${provider.id}'. It is not a supported provider, so no live qualification applies.`
    : null
  const unblock = pending ? null : [
    `An explicitly authorized test/staging credential for ${provider.label} (never a production key) entered via ${configField[0]}.`,
    needsCredential
      ? `For self-hosted Core: ${storedField}. For hosted BYOK: ${hostedField}; required env: ${hostedEnv.join(', ')}.`
      : `This connection is a local/self-hosted runtime with no vendor key: start it on an operator-trusted loopback/private origin and configure it via ${configField[0]}.`,
    `Owner authorization to make one real request to ${officialEndpoint ?? 'the operator-configured endpoint'} (${provider.docsUrl}), then run the recorded success/error/retry/timeout/network-failure/malformed-response cases and capture the call log.`,
  ].join(' ')

  return {
    id: provider.id,
    label: provider.label,
    catalogueStatus: provider.status,
    category: provider.category,
    wire: provider.wire,
    auth: provider.auth,
    credentialKind: provider.credential,
    keyRequired: Boolean(keyRequired),
    officialEndpoint,
    endpointSource: officialEndpoint ? `services/core/src/providers/wires (${provider.wire}).defaultBaseUrl` : 'operator-supplied baseUrl; no default endpoint is hard-coded',
    officialDocumentation: provider.docsUrl,
    configField: configField[0],
    storedField,
    hostedConfigField: hostedField,
    hostedEnvironmentVariables: hostedEnv,
    status,
    justification,
    liveCredentialEvidence: { callLog: null, successSchemaVerified: false, errorCasesVerified: false, routingVerified: false, credentialNonExposureVerified: false, noSilentSubstitutionVerified: false },
    evidence: [
      { artifact: 'docs/release/provider-register.json', note: 'derived from services/core/src/providers/catalog.mjs' },
      { artifact: 'docs/release/evidence/e2e-qualification.json', note: 'loopback isolated-service E2E only; no live vendor call' },
    ],
    unblock,
  }
})

const report = {
  schema: 'ragam-provider-qualification/1',
  generatedAt: new Date().toISOString(),
  source: 'services/core/src/providers/catalog.mjs (46 entries) and services/core/src/providers/wires/index.mjs',
  catalogue: catalogueReport(),
  liveCallsMade: 0,
  authorizedTestCredentialsAvailable: false,
  statuses: { PASS: 0, FAIL: 0, BLOCKED: register.filter((p) => p.status === 'BLOCKED').length, 'NOT TESTED': 0, 'NOT APPLICABLE': register.filter((p) => p.status === 'NOT APPLICABLE').length },
  note: 'No provider was live-tested. Every supported provider is BLOCKED pending an explicitly authorized test/staging credential and owner approval for a real call. Contract-tested adapters and isolated-service E2E results are not live vendor evidence.',
  providers: register,
}
writeJson(atRoot('docs/release/provider-register.json'), report)
console.log(`provider register: ${register.length} providers, ${report.statuses.BLOCKED} BLOCKED, ${report.statuses['NOT APPLICABLE']} NOT APPLICABLE, ${report.liveCallsMade} live calls`)
