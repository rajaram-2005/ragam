# 10 — Staging deployment and rollback evidence

**Result: BLOCKED. No isolated staging environment exists, so no deployment, rollback, failure recovery or staging verification was performed.** No production deployment and no destructive cleanup were performed.

## What actually exists

| Item | State | Evidence |
|---|---|---|
| Docker Compose single-user deployment (loopback, Caddy, named volume) | Code + CI smoke | `compose.yaml`, `.github/workflows/ci.yml` job `Docker Compose build, health, persistence and restore smoke` in `main` CI `42396395722` |
| LAN overlay (private bind, Basic Auth, internal TLS) | Code, not deployed | `compose.lan.yaml`, `deploy/Caddyfile.lan` |
| Cold backup / restore scripts | Code + CI smoke | `scripts/Backup-Ragam.ps1`, `scripts/Restore-Ragam.ps1`, CI job above |
| Hosted BYOK (Vercel + Supabase) | Code path only; no production deployment | `services/core/src/hosted/byok.mjs`, `supabase/migrations/`, `docs/30-hosted-byok.md` |
| Isolated staging environment | **Does not exist** | [evidence/baseline.json](evidence/baseline.json): GitHub Environments `total_count: 0`; no staging host/DNS/TLS/DB/volume/monitoring provided |

The CI smoke verifies a synthetic local single-user workspace: cold backup of the named volume, restore, persistence of a synthetic workspace id and a SQLite conversation-history marker, plus health and auth-disabled checks. It is **build/runtime CI evidence**, not a staging deployment and not production restore evidence.

## Required staging qualification (all BLOCKED)

| Gate | Status | What must be executed |
|---|---|---|
| Clean deployment, environment configuration, database migrations, health checks | **BLOCKED** | Deploy the recorded version into an isolated staging host and capture health output |
| Authentication | **BLOCKED** | Sign in / single-user boundary on the staging origin |
| Real provider connectivity | **BLOCKED** | Requires authorized test/staging credentials from [03-provider-qualification.md](03-provider-qualification.md) |
| Model availability | **BLOCKED** | Requires licensed weights from [04-model-qualification.md](04-model-qualification.md) |
| Persistent storage, backup and restore | **BLOCKED** | Real volume backup → restore → identity/history verification on staging |
| Monitoring / deployment health | **BLOCKED** | Staging telemetry feed and health dashboard |
| Failure recovery | **BLOCKED** | Induce a failed deploy and verify recovery |
| **Executed rollback** to the previous known-good version | **BLOCKED** | Actually deploy the prior version after the staging deploy, restore its data volume if needed, and verify health — documentation alone is not evidence |

**Exact unblock requirement:** provision an isolated staging environment (host, DNS, TLS, database, storage volume, monitoring, and a previous known-good version), supply the authorized test/staging credentials and licensed model artifacts, and obtain explicit owner approval to deploy and roll back. Production deployment requires a separate explicit approval and was not requested or performed.
