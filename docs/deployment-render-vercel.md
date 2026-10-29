# Render Core + Vercel deployment runbook

## Status and scope

This is the deployment procedure for the checked-in configuration; it is not evidence of a live deployment. No Render service, disk, Vercel project, production URL, production account, backup, or restore has been provisioned or verified by this repository change. Render's Starter service and persistent disk may incur charges. Review the plan, disk capacity, and account permissions before applying the Blueprint.

The deployment must be performed manually after the GitHub checks are green. `render.yaml` sets `autoDeploy: false`; pushing source does not authorize or trigger a production deploy.

## Go/no-go security blocker

**Do not make this service publicly available for real users yet.** `POST /api/auth/register` remains open, and the first account becomes owner. The current app has no invitation-only mode, registration-off switch, or out-of-band owner bootstrap. `AETHERIS_TRUSTED_WEB_ORIGINS` is a browser CSRF check, not an access-control boundary: a direct HTTP client can forge an `Origin` header. Deploying Core and racing to register the intended owner would therefore leave a first-account takeover window. Implement and test controlled owner bootstrap/registration policy before public production use. Until then, this Blueprint is an infrastructure template for an isolated validation environment only; the runbook does not claim launch readiness.

## Audited application facts

- Active Core entry point: `node services/core/src/server.mjs`; it starts the real `OnlineApp` in `services/core/src/online/app.mjs`.
- Runtime: Node 22. `services/core` uses Node built-ins only, including `node:sqlite`; no Core `npm ci` is required. Vercel's `apps/web` project is pinned to Node 22 by its package `engines` field.
- Frontend: React/Vite in `apps/web`; `npm ci`, `npm run build`, output `dist/`. Browser API calls are relative `/api/...` paths.
- Active account data: `accounts.sqlite` (SQLite), provider configuration and its master key, audit ledger, and per-account memory/knowledge stores under `AETHERIS_ONLINE_DATA_DIR`. Parent directory is created with restrictive permissions; SQLite account DB is WAL-backed and mode 0600.
- Authentication routes: `GET /api/auth`, `POST /api/auth/register`, `POST /api/auth/login`, and authenticated `POST /api/auth/logout`. `GET /api/health` is a public liveness check; `/api/ready` is authenticated and reports application readiness, so Render uses `/api/health`.
- Session tokens are held in process memory, not in SQLite. Core restart invalidates sessions; users must sign in again. Account/provider/app data persists only when the configured directory is actually on the mounted disk.
- Registration is currently open: the first account becomes owner and later accounts become members. There is no secure out-of-band owner bootstrap or registration lock; treat this as the go/no-go blocker above, not as a race that can be solved by quickly registering after a public deploy.

## Request path

```text
Browser (HTTPS, Vercel origin)
  └─ relative /api/* request + session cookie + CSRF marker
      └─ Vercel Node function (fixed CORE_API_URL, 58 s proxy ceiling)
          └─ HTTPS Render origin (55 s Core gateway budget)
              └─ Core API + SQLite/files under /var/data/online
```

The proxy does not take an upstream host from the incoming request. It forwards the browser `Origin`, `Sec-Fetch-Site`, CSRF marker and cookies; it preserves multiple `Set-Cookie` headers and streams response bodies. It sets `private, no-store`, bounds the JSON/body payload to Core's 2 MiB limit, rejects unsafe paths and unsupported methods, and rejects non-HTTPS upstreams outside explicit local development/tests. The proxy is not a general-purpose open proxy.

## 1. Pre-deploy checks

1. Review this branch and wait for the repository's GitHub CI checks to pass. The Render Blueprint is manual (`autoDeploy: false`).
2. Confirm the Render account, region, Starter plan and persistent disk are approved. The Blueprint requests a 1 GB disk; production data/media volume has not been measured. Set an appropriate capacity before real use.
3. Confirm the repository's root-level `render.yaml` is the Blueprint source. Render runs build/start commands from the repository root; there is intentionally no root lockfile or Core install command.
4. Resolve the public-registration/owner-bootstrap blocker above before any public production rollout. For isolated validation only, use a dedicated synthetic owner and a separate dedicated smoke-test member; never use a personal account for automated smoke checks.

## 2. Render Core and persistent disk

1. In Render, create a Blueprint deployment from the reviewed GitHub branch and inspect the service plan and disk before applying it. Do not accept charges without approval.
2. Confirm the service is named `ragam-core`, runs Node 22 in Singapore, has one instance, has `autoDeploy` disabled, and mounts the named disk at `/var/data`.
3. Confirm the Core data directory is `/var/data/online`. Render injects `PORT`; Core binds `AETHERIS_CORE_HOST=0.0.0.0` and uses `PORT` when `AETHERIS_CORE_PORT` is unset.
4. Set `AETHERIS_TRUSTED_WEB_ORIGINS` to the exact production Vercel origin after the Vercel project and production domain are known, for example `https://ragam.example`. Use no wildcard, path, trailing slash, or preview hostname. This is a browser-origin allowlist, separate from provider destination allowlists.
5. Keep `AETHERIS_COOKIE_SECURE=true` and `AETHERIS_COOKIE_SAMESITE=strict`. Do not set `AETHERIS_COOKIE_SAMESITE=none` for this same-origin proxy design.
6. Check Render logs for the structured `core_started` event and confirm its `dataDir` is `/var/data/online`. The current configuration does not set `AETHERIS_CORE_PORT`, so the injected `PORT` is used.
7. Check `https://<render-service-host>/api/health` returns HTTP 200 with the non-sensitive `status: ok` response. This proves the process is answering, not that a mounted disk has been tested for durability.

## 3. Vercel frontend and API function

1. Create/import the Vercel project from this repository with project root `apps/web`.
2. Use Node 22, `npm ci`, `npm run build`, and output directory `dist` (also recorded in `apps/web/vercel.json`).
3. In the Vercel project, add the **server-side runtime** variable:

   ```text
   CORE_API_URL=https://<render-service-host>
   ```

   Use the exact HTTPS origin Render assigned, without a path or trailing slash. Set it for Production. Do not prefix it with `VITE_` and do not put it into browser build-time variables. Preview domains are not trusted by Render unless each exact origin is deliberately added to `AETHERIS_TRUSTED_WEB_ORIGINS`.

4. Deploy the frontend only after the intended production Vercel origin is added to Render's trusted web origins. Verify `https://<vercel-production-host>/api/health` returns the Core health response through the Vercel function.
5. Do not use permissive CORS as a workaround. The same-origin `/api` proxy is the browser-facing API route.

## 4. Smoke checks (only after owner bootstrap is secured)

The smoke script logs in to an already-created dedicated account. It does not register or delete accounts and does not print the password. Supply credentials through environment variables, not command-line arguments or shell history:

```bash
export RAGAM_PUBLIC_URL='https://<vercel-production-host>'
read -r -p 'Dedicated smoke account email: ' RAGAM_SMOKE_EMAIL
read -r -s -p 'Dedicated smoke account password: ' RAGAM_SMOKE_PASSWORD; printf '\n'
export RAGAM_SMOKE_EMAIL RAGAM_SMOKE_PASSWORD
node scripts/production-smoke.mjs
```

It checks public health, signed-out status, rejects an untrusted-origin logout mutation, validates sign-in and `HttpOnly; Secure; SameSite=Strict; Path=/api` session attributes, calls authenticated `/api/providers`, and verifies sign-out cookie clearing plus server-side session invalidation. It makes requests only to the supplied exact HTTPS origin and reports statuses without printing response payloads or credentials.

### Verify persistent storage across a real Core restart

Use a dedicated smoke-test **member** account and a unique non-secret marker id. The first command writes a synthetic approved memory record and reads it back. Restart the Render Core service using the approved operator procedure, then run the verify mode with the same id. The verify mode reads the marker after restart and removes it; deletion leaves the application's non-content tombstone/audit metadata. Do not use a real user's account or memory for this check.

```bash
export RAGAM_SMOKE_MARKER_ID='replace-with-a-unique-8-to-80-character-id'
node scripts/production-smoke.mjs --persistence-write
# Restart Core through the approved Render operator workflow.
node scripts/production-smoke.mjs --persistence-verify
```

This is the production write/read/restart proof. A local test using a temporary directory verifies the application behavior but cannot prove that Render mounted or retained the actual volume. If marker verification fails, stop before entering real user data and investigate the mount path, service configuration, and logs.

## 5. Backups, restore, and rollback

No automated backup or restore workflow is configured by this repository. Persistent storage is not a backup. Before real data is accepted, choose and test a backup method supported by the actual Render service/plan; do not assume a provider snapshot feature exists or is enabled.

If the chosen method is a file-level export, stop Core first so SQLite is quiescent, then copy the **entire** `/var/data/online` tree while preserving permissions. It includes SQLite databases and any `-wal`/`-shm` sidecars, encrypted provider configuration, and the `master.key` needed to decrypt that configuration. Treat the backup as highly sensitive; never commit it or include it in logs. Restore the whole tree to `/var/data/online` while Core is stopped, then test the restored copy in an isolated service before returning it to production. Do not copy an actively-written SQLite database file alone.

Rollback the service code to a previously reviewed commit through Render's supported deploy controls; leave the persistent disk attached and untouched. The current app initializes its SQLite schemas in code and has no separate destructive migration command. Any future schema change must be reviewed for backward/forward compatibility and tested against a copied database before deployment. A code rollback is not a data rollback.

## 6. Logs and troubleshooting

Core emits JSON records for startup, shutdown, configuration failures, and API errors. API logs carry a request id, method, status, and a bounded error code; they do not include request bodies, emails, passwords, cookies, or provider credentials. The proxy emits a request id and generic upstream error class rather than logging upstream URLs or bodies. The human startup banner reports account count and owner presence without printing an email. Keep `AETHERIS_PRINT_RESET_CODES=false` in production: its explicit opt-in mode prints reset codes and email addresses to stdout.

| Symptom | Check |
|---|---|
| Render health check fails | Render logs for `core_startup_failed`; check Node 22, injected `PORT`, mount permissions, and `AETHERIS_ONLINE_DATA_DIR` |
| Vercel `/api/health` returns 503 | `CORE_API_URL` is missing, malformed, non-HTTPS, or has a path/trailing slash |
| Mutations return 403 | `AETHERIS_TRUSTED_WEB_ORIGINS` must exactly match the browser's production origin; keep the CSRF marker and `Sec-Fetch-Site` forwarding enabled |
| Sign-in works but next request is 401 | Confirm the browser receives the `Secure`, `HttpOnly`, `SameSite=Strict`, `/api` cookie through Vercel; sign in again after a Core restart |
| Authenticated requests are slow or time out | Core gateway timeout is 55 seconds; the Vercel proxy limit is 58 seconds and the function cap is 60 seconds |
| User state disappears after restart | Confirm `core_started.dataDir` is `/var/data/online`, run the explicit marker/restart/verify procedure, and do not treat local temp-directory tests as a disk durability check |

## Verification status

Repository-level verification includes the Core port/cookie/origin/sign-in/API/logout/restart smoke test, a proxy test for body/cookie/status/streaming/path/timeout/error behavior, the web suite, and the Vite build. It does not prove Render Blueprint acceptance, Vercel deployment, a production URL, real persistent-disk durability, backups, or live authentication. Run the deployment and persistence steps above before claiming production readiness.
