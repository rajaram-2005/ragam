# Self-hosted deployment (Docker Compose)

This deployment model is **one independent instance per end user**: each person runs the
Compose stack on their own computer using its Docker Engine, rather than connecting to the
maintainer's computer or a shared cloud backend. It deploys the **existing** online Core and
Vite-built web app. Caddy serves the web bundle and proxies `/api/*` to Core. Each instance's
app databases, generated files, and Caddy state live in that person's local Docker volumes
(`ragam-data`, `ragam-caddy-data`, and `ragam-caddy-config`). Nothing here redirects app
storage to Supabase. This does not add local model inference, migrate hosted data, or change
any external account.

## Scope and safety

- The stack uses one durable named volume, `ragam-data`, for the Core's existing
  SQLite databases, provider key material, settings, account data and generated files.
  Caddy certificate/config state lives in separate named volumes.
- The Core and web containers have no published host ports. Caddy publishes 80/443 to
  loopback by default; public binding is a deliberate post-bootstrap change.
- The first self-host account is restricted to `AETHERIS_OWNER_EMAIL`. Member registration
  stays closed unless `AETHERIS_ALLOW_ACCOUNT_REGISTRATION=true` is deliberately set.
  The self-host account cap defaults to one.
- Vercel and Supabase code/configuration remain intact. There is no hosted-data export or
  migration in this deployment. Do not retire, delete, pause or modify the hosted stack
  until its data has been inventoried/exported, imported, reconciled and verified with a
  successful self-host backup and restore.
- Provider URLs are opened by the Core **container**. A host's `127.0.0.1` is not the
  Core container; configure a provider on an address reachable from that container (or
  within the same Docker network) and add only its exact origin to
  `AETHERIS_TRUSTED_ORIGINS` when required. The container does not bundle or download
  model weights.
- No hosting, DNS, firewall, operating-system, hardware or external-account changes are
  performed by this repository work. The operator chooses whether and where to deploy.

## Configure and start

On your computer, open Docker Desktop (or another Docker Compose UI) and ensure its local
Docker Engine is running. Arena cannot reach or start containers on your physical computer;
this repository's CI only validates a temporary stack in GitHub Actions. Use the Compose UI
to build and run this repository with persistent named volumes; no separate server or cloud
storage is required. Keep the same environment values and backup cautions below.

**Windows + Docker Desktop, without typing commands:** from File Explorer, double-click
`scripts/Start-Ragam.cmd`. On first run it creates `.env` from `.env.example` and opens it in
Notepad. Fill in `AETHERIS_OWNER_EMAIL`, save and close Notepad, then double-click the
launcher again. It builds and starts the stack and opens `http://localhost`. To stop the
containers later without deleting local data, double-click `scripts/Stop-Ragam.cmd`; it
keeps all named volumes. Docker Desktop must be open and its Engine running.

For a Compose UI or other platform, use these manual configuration steps instead:

1. Copy `.env.example` to `.env` using your host's file manager or deployment UI.
2. Set `AETHERIS_OWNER_EMAIL` to the one address allowed to create the first account.
   Do not put a password, provider key, Supabase key or database password in this file.
   The address match is an operator allowlist, **not** email verification or proof of
   mailbox control. Keep the first-owner page reachable only from a trusted machine/network
   until the owner account has been created.
3. Leave `RAGAM_BIND_ADDRESS=127.0.0.1` and `RAGAM_SITE_ADDRESS=http://localhost` for the
   initial bootstrap. This binds published ports to loopback only.
4. Build and start the Compose project:

   ```sh
   docker compose -f compose.yaml up -d --build
   ```

5. Open `http://localhost` on the host and create the owner using the configured email
   and a strong password; a different email is refused. After that first account, the
   registration endpoint returns `registration_closed` unless the operator explicitly
   enables member signup. The browser UI states this policy before submission.
6. Only after owner bootstrap, for public HTTPS access set `RAGAM_BIND_ADDRESS=0.0.0.0`
   and `RAGAM_SITE_ADDRESS` to a DNS name such as `ragam.example` (no scheme). Arrange
   DNS and inbound port 80/443 reachability separately, then restart the stack. Caddy
   obtains and renews certificates automatically when that domain is publicly reachable.
   Do not use Caddy's local HTTP address on an unencrypted LAN or public deployment.

For local development over HTTP, `AETHERIS_COOKIE_SECURE=false` may be used only when
access is restricted to the same machine. Restore `true` for HTTPS. The Core defaults to
secure cookies and `SameSite=Strict`; do not weaken either setting to compensate for a
misconfigured public proxy.

## Health and persistence checks

- `GET /api/health` through the Caddy site must return HTTP 200 with `status: "ok"`.
- Core and web are not directly exposed on host ports. The Compose health checks gate the
  edge proxy startup; Caddy's `/healthz` reports proxy process health, not data durability.
- Sign in after creation, then restart Core with `docker compose restart core` and sign in
  again. Sessions are in memory and are intentionally revoked at restart; the account and
  its data must remain.
- Keep the named volume `ragam-data`. `docker compose down -v` deletes persistent app and
  Caddy volumes; do not use it for routine updates or shutdown.

The checked-in CI workflow builds both images, validates Compose, starts the stack, tests
health and owner/member registration through Caddy, stops Core for a cold volume backup,
restores that archive into the named volume and verifies owner sign-in again. These are
synthetic CI checks, not live-provider inference or evidence of a production deployment.

## Cold backup and restore

The Core is stopped before copying so SQLite's WAL files and the rest of the volume form
one quiescent snapshot. The whole volume contains sensitive data, including account
records, conversation/history stores, provider settings and the provider-encryption key.
Encrypt backups at rest, restrict access, retain them according to your privacy policy,
and never attach an unencrypted archive to a public issue. Do not copy only `accounts.sqlite`
while Core is running.

With a terminal on the deployment host, from the directory containing `compose.yaml`:

```sh
mkdir -p backups
# Stop only Core; Caddy and the static web container can remain up.
docker compose -f compose.yaml stop core
# Create a cold archive without mounting the data volume read/write in the helper.
docker run --rm \
  -v ragam-data:/source:ro \
  -v "$PWD/backups:/backup" \
  busybox:1.36 tar -czf /backup/ragam-data.tar.gz -C /source .
docker compose -f compose.yaml start core
```

The separate `ragam-caddy-data` volume contains ACME account/certificate state. To
preserve it as well, stop Caddy before taking a second archive, then start it again:

```sh
docker compose -f compose.yaml stop caddy
docker run --rm \
  -v ragam-caddy-data:/source:ro \
  -v "$PWD/backups:/backup" \
  busybox:1.36 tar -czf /backup/ragam-caddy-data.tar.gz -C /source .
docker compose -f compose.yaml start caddy
```

The Caddyfile and its static site configuration are versioned in this repository; the
certificate volume can be re-created, but preserving it avoids unnecessary certificate
re-issuance. `ragam-caddy-config` is runtime config state and can be rebuilt from the
checked-in Caddyfile.

Keep both archives encrypted and off the host only through a storage location you have
explicitly authorized. A successful backup command is not a restore verification.

For a restore drill, first stop Core and restore into a **separate test volume** while
leaving the original volume untouched. To replace a volume, confirm the archive and
retention copy before proceeding; then stop the full stack, empty/replace the intended
volume, extract the archive, and restore ownership to UID/GID `1000:1000` (the `node`
user in `Dockerfile.core`). Start the stack and test login, account cap/registration
policy, a known non-sensitive marker, provider connection configuration and required
files. Do not experiment on the only copy of production data. The exact destructive
volume replacement commands depend on the chosen Compose UI/volume name; review them
before execution. Preserve the prior volume until every restore check passes.

## Updating and cutover gates

Rebuild from reviewed repository source with `docker compose up -d --build`; back up first
and keep the previous known-good images/backup until health and sign-in pass. No automatic
migration from Vercel/Supabase, hosted-account export, or data reconciliation is included.
Before any cutover, separately verify hosted exports, account ownership, provider secrets,
per-account history/knowledge, consent/retention requirements and restore recovery. Until
all of those checks pass, keep the existing hosted paths and data intact.
