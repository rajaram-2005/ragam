# 30 — Hosted BYOK edition

The repo includes an opt-in hosted web/API edition alongside the default local Docker workspace. The hosted edition uses per-user Supabase Auth accounts, stores one provider connection per user in Supabase Postgres, and serves the API through Vercel Node functions. It is selected at Web build time with `VITE_HOSTED_BYOK=true`; the local Docker build does not use this path.

## Data and credential boundary

- Supabase Auth owns account passwords, email confirmation and recovery. The API holds access/refresh tokens only in `HttpOnly`, `Secure`, `SameSite=Lax` cookies scoped to `/api/hosted`; tokens are not returned to the React app.
- Each account has one provider row keyed by its authenticated Supabase user id. The API obtains identity from a validated Supabase session, never from a request-supplied user id. Every read/write query filters by that identity.
- Provider API keys are sealed with AES-256-GCM and a 32-byte server-only `AETHERIS_PROVIDER_ENCRYPTION_KEY`; the authenticated-encryption additional data binds the ciphertext to both the account id and provider id. Plaintext keys are not stored in Postgres or returned by API responses.
- The Supabase service-role key and encryption key belong only in sensitive Vercel Core environment variables. They must never use a `VITE_` prefix or be added to the web project.
- Provider endpoints are HTTPS and pinned to the catalogue wire's documented origin/path (Azure OpenAI accepts only an `*.openai.azure.com` resource host). The shared gateway blocks private-address resolution and redirects. Local Ollama/llama.cpp endpoints are intentionally unavailable from this public backend.
- Chat prompts and completions are held in browser memory only. The hosted API does not save chat history, memory, file uploads or provider payloads. Requests go to exactly the saved provider/model after per-turn approval; native Search has separate per-turn consent and there is no fallback.
- Provider model discovery is an explicit user action. Provider usage and any Search charges are billed by that provider to the user's account, not by Ragam.

## Database migration

Apply [`supabase/migrations/202611030001_byok_provider_connections.sql`](../supabase/migrations/202611030001_byok_provider_connections.sql) to the intended Supabase project before enabling the hosted Web build. It creates only `public.byok_provider_connections`, enables RLS, grants no table access to `anon` or `authenticated`, and grants the backend `service_role` only. The Auth user foreign key cascades deletion of a user's provider row. No chat text is part of the schema.

## Required backend environment

Set these as encrypted/sensitive variables on the **Core** Vercel project in Production (and Preview only when intentionally testing a separate preview service):

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project's HTTPS API URL |
| `SUPABASE_ANON_KEY` | Supabase Auth API key used by the server for Auth calls |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend-only PostgREST access; never expose to the browser |
| `AETHERIS_PROVIDER_ENCRYPTION_KEY` | Exactly 32 random bytes encoded as base64 or 64 hex characters |
| `AETHERIS_HOSTED_SITE_URL` | Exact public Web origin used for password recovery redirects |
| `AETHERIS_HOSTED_ORIGINS` | Comma-separated exact HTTPS origins allowed to submit mutations |
| `NODE_ENV` | Vercel supplies `production`; this enables Secure cookies |

Set `VITE_HOSTED_BYOK=true` as a non-secret **Web build** variable to expose the hosted account/chat interface. The Web project rewrites only `/api/hosted/*` to the fixed Core project URL. Provider keys are entered by each account holder after sign-in; they are not deployment variables.

## Auth email delivery is a launch prerequisite

Supabase Auth currently requires email confirmation and password-recovery email links for this flow. Configure a production SMTP provider in the Supabase Auth settings, verify a sender/domain, and test confirmation plus recovery links before opening public registration. Supabase's default test mailer is not a public transactional mail service. Do not disable email confirmation merely to make sign-up appear to work: that would allow unverified addresses and leave users without reliable recovery.

Set Supabase's Site URL to the public Web origin and allow only the exact production origin plus intentional local/preview callback origins. Protect preview deployments; do not add broad wildcard redirects. Keep account signup enabled only after email delivery and rate limits are configured.

## Current scope and limits

The hosted interface intentionally starts with Chat and Provider Settings. It does not expose the full local Docker workspace's Image, Video, Plugins, MCP, memory, knowledge or server-side conversation history. Provider lists are limited to implemented Chat wires accepting a single API key. Tests use mocked Supabase/provider transports and never contact a live AI provider.
