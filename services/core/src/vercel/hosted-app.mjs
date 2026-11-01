import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OnlineApp } from '../online/app.mjs'
import { DEFAULT_MAX_ACCOUNTS } from '../online/accounts.mjs'
import { SupabaseAdminClient } from '../storage/supabase-admin.mjs'
import { SupabaseAccountStore } from '../storage/supabase-account-store.mjs'
import { SupabaseAuditLedger } from '../storage/supabase-audit-ledger.mjs'
import { SupabaseMediaQueue } from '../storage/supabase-media-queue.mjs'
import { SupabaseProviderStore } from '../storage/supabase-provider-store.mjs'
import { SupabaseSessionStore } from '../storage/supabase-session-store.mjs'
import { SupabaseStyleStore } from '../storage/supabase-style-store.mjs'
import { createSupabaseContextStoreFactory } from '../online/supabase-context.mjs'
import { parseTrustedWebOrigins } from '../server.mjs'

function requireValue(value, code) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(code)
    error.code = code
    throw error
  }
  return value.trim()
}

function providerOrigins(env) {
  return [env.AETHERIS_TRUSTED_ORIGINS || '', env.AETHERIS_LITELLM_TRUSTED_ORIGINS || '']
    .join(',').split(',').map((origin) => origin.trim()).filter(Boolean)
}

/** Construct the hosted service only after Supabase schema, secrets and bootstrap policy exist. */
export async function createHostedOnlineApp({ env = process.env, logger = null } = {}) {
  requireValue(env.SUPABASE_URL, 'supabase_url_missing')
  requireValue(env.SUPABASE_SERVICE_ROLE_KEY, 'supabase_service_key_missing')
  const bootstrapEmail = requireValue(env.AETHERIS_OWNER_EMAIL, 'owner_bootstrap_email_missing')
  requireValue(env.AETHERIS_PROVIDER_ENCRYPTION_KEY, 'provider_encryption_key_missing')
  const trustedWebOrigins = parseTrustedWebOrigins(env.AETHERIS_TRUSTED_WEB_ORIGINS || '')
  const client = new SupabaseAdminClient({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY })
  const accountStore = new SupabaseAccountStore({
    client,
    maxAccounts: Number(env.AETHERIS_MAX_ACCOUNTS || DEFAULT_MAX_ACCOUNTS),
    bootstrapEmail,
    registrationEnabled: env.AETHERIS_ALLOW_ACCOUNT_REGISTRATION === 'true',
    // No mail transport is configured. Password reset remains disabled, rather than
    // leaking recovery codes through a response or serverless logs.
    onResetCode: null,
  })
  const sessionStore = new SupabaseSessionStore({ client, ttlMs: 8 * 60 * 60_000, perAccount: 8, installationLimit: 256 })
  const styleStore = new SupabaseStyleStore({ client })
  const providerStore = await SupabaseProviderStore.create({
    client,
    encryptionKey: env.AETHERIS_PROVIDER_ENCRYPTION_KEY,
  })
  const auditLedger = new SupabaseAuditLedger({ client })
  const contextStoreFactory = createSupabaseContextStoreFactory({
    client,
    mediaFactory: async ({ client: storageClient, accountId }) => new SupabaseMediaQueue({
      client: storageClient,
      accountId,
      ledger: auditLedger,
      timeoutMs: 45_000,
      maxArtifactBytes: 24 * 1024 * 1024,
    }),
  })
  const dataDir = mkdtempSync(join(tmpdir(), `ragam-core-${process.pid}-${randomUUID()}-`))
  try {
    return new OnlineApp({
      dataDir,
      trustedOrigins: providerOrigins(env),
      trustedWebOrigins,
      secureCookie: true,
      cookieSameSite: 'strict',
      timeoutMs: 45_000,
      maxAccounts: Number(env.AETHERIS_MAX_ACCOUNTS || DEFAULT_MAX_ACCOUNTS),
      onResetCode: null,
      logger,
      accountStore,
      sessionStore,
      styleStore,
      providerStore,
      auditLedger,
      contextStoreFactory,
    })
  } catch (error) {
    await Promise.allSettled([accountStore.close?.(), sessionStore.close?.(), providerStore.close?.(), auditLedger.close?.()])
    throw error
  }
}

/** Local model loading/training belongs on the user's own device, never a Vercel Function. */
export function blockLocalOnlyHostedRoutes(req, res) {
  const pathname = typeof req?.url === 'string' ? new URL(req.url, 'https://core.invalid').pathname : ''
  const localOnly = pathname.startsWith('/api/klyvaron/worker/')
    || pathname === '/api/klyvaron/worker'
    || pathname === '/api/klyvaron/qualification/run'
    || pathname === '/api/klyvaron/models/verify'
  const unsupported = pathname === '/api/skills' || pathname.startsWith('/api/skills/') || pathname.startsWith('/api/voice/')
  if (!localOnly && !unsupported) return false
  res.statusCode = 501
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify({
    error: pathname.startsWith('/api/voice/') ? 'hosted_voice_unavailable'
      : pathname === '/api/skills' || pathname.startsWith('/api/skills/') ? 'hosted_skills_unavailable'
        : 'local_runtime_required',
    message: pathname.startsWith('/api/voice/')
      ? 'Voice artifacts are not enabled on the hosted Functions runtime.'
      : pathname === '/api/skills' || pathname.startsWith('/api/skills/')
        ? 'Skill storage is local in this release; hosted skill changes are disabled rather than written to ephemeral Function storage.'
        : 'Klyvaron training and worker tasks run locally; use the local Core and worker instead.',
  }))
  return true
}
