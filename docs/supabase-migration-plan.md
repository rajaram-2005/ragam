# Supabase + Vercel migration status

## Target architecture

The migration target uses two Vercel projects connected to this repository:

- **Web project:** Root Directory `apps/web`, builds the Vite frontend and serves the same-origin `/api/*` proxy.
- **Core project:** Root Directory `services/core`, runs `api/[...path].js` as a Node.js Function. Its handler reuses one `OnlineApp` per warm Function instance and does not start a listening server.
- **Supabase:** Postgres is the durable system of record; a private `ragam-media` Storage bucket holds validated image/video artifacts.

The web project's `CORE_API_URL` is a bare exact HTTPS origin for the Core project (no path and no trailing slash). Browser code continues to call relative `/api/*` paths, preserving HttpOnly cookies and same-origin browser behavior. The Core Vercel project must trust the exact web Preview/Production origins.

The user chose to keep Supabase project `ragam-core` on the Free plan in London (`eu-west-2`). No plan or region changes are recommended.

## Hosted implementation now present in the repository

- `services/core/api/[...path].js`, `services/core/vercel.json`, and `services/core/src/vercel/handler.mjs` provide the Vercel Function entry point, warm-instance app reuse, body-size checks, bounded Node request dispatch, and safe startup errors. `readBody()` accepts Vercel's parsed JSON body while preserving the 2 MiB limit and overwriting caller-supplied ownership fields.
- `SupabaseAdminClient` is server-only, pins an exact HTTPS Supabase origin, limits endpoints/headers, bounds requests, sanitizes errors, and supports binary Storage downloads.
- `SupabaseAccountStore` and `SupabaseSessionStore` persist accounts, auth throttles, revocation, and hashes of opaque session tokens. Hosted signup requires `AETHERIS_OWNER_EMAIL` for the first account and remains disabled afterward unless explicitly enabled. Reset delivery remains disabled without a real channel.
- `SupabaseProviderStore` keeps provider credentials AES-GCM encrypted with `AETHERIS_PROVIDER_ENCRYPTION_KEY`; an optimistic revision-checked SQL RPC prevents stale warm Functions from silently overwriting newer settings. Each request refreshes the provider snapshot; queued provider and audit writes are flushed before the response is ended.
- `SupabaseAuditLedger` queues append-only events and retains failed events for safe retry.
- `SupabaseMemoryStore`, `SupabaseKnowledgeStore`, `SupabaseKnowledgePipeline`, and `createSupabaseContextStoreFactory` provide account-scoped durable memory, session history, knowledge, ACL checks, deletion, bounded pagination, and grounded citations.
- `SupabaseMediaQueue` stores image/video metadata in Postgres and validated artifacts in the private Storage bucket. Generation runs synchronously inside a bounded request (maximum 45 seconds and 24 MiB artifact size); it is **not** a background worker. It accepts abort from a disconnected request, verifies stored bytes by SHA-256, and filters every operation by account.
- Local Klyvaron training/worker and hosted Voice routes are blocked in the Vercel adapter. Model training and its artifacts remain local; the Functions runtime does not claim to train or host those local weights.

## Supabase migration state

The user reports that the first migration, `20261030000100_initial_core.sql`, was run in the Supabase SQL Editor and returned **“Success. No rows returned.”** That is the normal result for schema DDL. The hosted baseline is therefore user-applied according to that report, but the agent has not independently queried Supabase to verify its objects.

The remaining staged SQL files, to be run **one at a time in this order** after reviewing the code, are:

1. `supabase/migrations/20261031000100_memory_rpcs.sql`
2. `supabase/migrations/20261101000100_knowledge_rpcs.sql`
3. `supabase/migrations/20261102000100_provider_snapshot.sql` — adds the revision-checked provider snapshot RPC and creates the private Storage bucket.

Do not rerun the baseline. No local application data has been exported or transferred. SQL Editor execution does not create a local CLI migration-history record; keep a record of which files were applied in the dashboard and avoid applying one twice. No hosted migration after the baseline has been confirmed by the user yet.

## Remaining readiness gates

1. Apply the three follow-on migrations in order and verify the expected tables, RPCs, RLS, and private bucket in the Supabase Dashboard.
2. Add the Core and Web Vercel projects from the correct repository directories. Set server-only Core variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AETHERIS_PROVIDER_ENCRYPTION_KEY`, and `AETHERIS_OWNER_EMAIL`. Never add the service-role or encryption key to the Web project or a `VITE_*` variable.
3. In Web Preview variables set `CORE_API_URL` to the Core Preview's exact HTTPS origin. In Core Preview, allow the exact Web Preview origin through `AETHERIS_TRUSTED_WEB_ORIGINS`. Production uses its own exact origins and should remain untouched until Preview passes.
4. Run live Preview checks for first-owner bootstrap, login/logout and revocation across cold starts, account isolation, provider configuration, chat, knowledge ingest/search/purge, and private media upload/download/delete. Current automated tests use mocked PostgREST/Storage or disposable local databases; they are not live-hosted evidence.
5. Decide separately whether any existing local data should be migrated. Nothing is copied automatically, and no data deletion is part of this plan.

## Known limitations (do not imply production parity)

- The current database adapters for account/session, provider, audit, memory/knowledge, and image/video media have automated coverage, but no live Supabase round-trip or Vercel Preview deployment has been tested.
- Password-reset email delivery is not configured, so hosted reset remains unavailable.
- The Vercel media operation is bounded and synchronous. A long provider operation can time out; no detached job or durable worker is claimed. A later Function invocation cannot forcibly stop a provider request running in another invocation.
- Local Klyvaron training, qualifications, and private model artifacts are intentionally not moved to Vercel. Hosted Voice endpoints are disabled. Skill content and user-managed plugin/MCP persistence have not been migrated as hosted durable stores.
- The user has not authorized changing Vercel project settings, creating deployments, transferring data, or applying additional SQL. No such external changes have been made by the agent.

## Credentials and cost controls

Keep the Supabase database password, service-role key, provider credentials, and provider-encryption key in a password manager and their appropriate hosted secret settings only. Do not paste them into chat or commit them. Keep both services on the chosen Free plans; check current quotas in the dashboards before relying on availability. Do not upgrade, delete, pause, or change the region of any project without explicit authorization.
