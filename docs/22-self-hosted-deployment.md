# Self-hosted deployment (Docker Compose)

This deployment model is **one independent instance per end user**: each person runs the
Compose stack on their own computer using its Docker Engine, rather than connecting to the
maintainer's computer or a shared cloud backend. It deploys the **existing** online Core and
Vite-built web app. Caddy serves the web bundle and proxies `/api/*` to Core. Each instance's
app databases, generated files, and Caddy state live in that person's local Docker volumes
(`ragam-data`, `ragam-caddy-data`, and `ragam-caddy-config`). Docker Compose is the repository's
only deployment path; the app's databases and files stay on the user's computer. This does
not add local model inference or migrate any externally hosted data.

## Scope and safety

- The stack uses one durable named volume, `ragam-data`, for Core's SQLite databases,
  provider key material, settings, conversation/context data and generated files.
  Caddy state lives in separate named volumes.
- This Docker deployment is a single-user local workspace with no email, registration,
  password or sign-in screen. Its HTTP UI/API is published only on `127.0.0.1:80` and
  Core rejects non-loopback Host headers. Do not expose it to a LAN, public network or
  remote reverse proxy: local-only access is the security boundary when there is no login.
- The repository no longer contains Vercel or Supabase deployment integrations or
  migrations. This repository cleanup does **not** delete, pause, or modify any external
  project, deployment, account, or data. No hosted-data export or migration is included.
- Provider URLs are opened by the Core **container**. A host's `127.0.0.1` is not the
  Core container; configure a provider on an address reachable from that container (or
  within the same Docker network) and add only its exact origin to
  `AETHERIS_TRUSTED_ORIGINS` when required. The container does not bundle or download
  model weights.
- No hosting, DNS, firewall, operating-system, hardware or external-account changes are
  performed by this repository work. The operator chooses whether and where to deploy.

## Configure and start

This is one independent local instance per end user. Each person's Docker Desktop runs
Core, the web UI and persistent storage on that person's own computer. No developer-hosted
service or shared credentials are involved.

**Windows + Docker Desktop, without typing commands:** open Docker Desktop and wait for
its Engine to be running. From File Explorer, double-click `scripts/Start-Ragam.cmd`. It
creates default local settings if needed, builds the containers and opens `http://localhost`.
There is no email, account creation, sign-in or password recovery. To stop the containers without deleting local
data, double-click `scripts/Stop-Ragam.cmd`; named volumes are retained. For a backup or
restore, use the double-click `scripts/Backup-Ragam.cmd` and `scripts/Restore-Ragam.cmd`
launchers below; they use file pickers, stop Core for a cold archive, and keep a safety
copy before a restore. Choose a BitLocker-protected location because the archive contains
private conversations and provider credentials.

For another Docker Compose UI, open this repository's `compose.yaml`, build and start the
project with its default settings. Keep the published address on `127.0.0.1`; do not change
the bind to a LAN/public interface, add a remote reverse proxy, or place this no-login
workspace on a hosted server. The app intentionally refuses non-loopback Host headers.

To use a model, open **Provider Settings**, choose a supported provider (including OpenAI
for ChatGPT, Gemini, Anthropic Claude, xAI for Grok, and others), enter your own provider
API key, then test the connection. Ragam fetches the model IDs returned by that connection;
models are not pre-filled or fabricated. Provider API usage may incur charges from the
provider. No provider is contacted until you configure it and explicitly test or send a
request.

## Health and persistence checks

- `GET /api/health` through the Caddy site must return HTTP 200 with `status: "ok"`.
- Core and web are not directly exposed on host ports. The Compose health checks gate the
  edge proxy startup; Caddy's `/healthz` reports proxy process health, not data durability.
- Open `http://localhost` after starting or restarting the stack. The local workspace
  identity and its conversation/context data must remain available; no sign-in session is used.
- Keep the named volume `ragam-data`. `docker compose down -v` deletes persistent app and
  Caddy volumes; do not use it for routine updates or shutdown.

The checked-in CI workflow builds both images, validates Compose, starts the stack, tests
health and the localhost-only single-user API through Caddy, stops Core for a cold volume
backup, restores that archive into the named volume, and verifies both the workspace
identity and a SQLite conversation-history marker. These are synthetic CI checks, not
live-provider inference or evidence of a production deployment.

## Cold backup and restore

The Core is stopped before copying so SQLite's WAL files and the rest of the volume form
one quiescent snapshot. The whole volume contains sensitive data, including conversation
history, provider settings and the provider-encryption key. Encrypt backups at rest, restrict
access, retain them according to your privacy policy, and never attach an unencrypted archive
to a public issue. Do not copy SQLite files while Core is running.

For Windows + Docker Desktop, double-click `scripts/Backup-Ragam.cmd` in File Explorer.
Choose a save location on an encrypted drive, approve the pause, and keep the generated
`.tar.gz` archive and matching `.sha256` file together. Core is stopped only for the cold
copy and the launcher restarts it afterward. Double-click `scripts/Restore-Ragam.cmd` to
choose an archive; it checks the archive/checksum, creates a safety backup of the current
volume beside it, restores the selected volume, and confirms health plus workspace identity.
If validation fails, it attempts to restore the pre-restore safety copy. Do not delete either
archive until you have checked the restored workspace.

For other Compose platforms or an advanced manual workflow, from a terminal on the deployment
host and the directory containing `compose.yaml`:

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

The Caddy volumes hold regenerable proxy runtime state only. This localhost HTTP setup
obtains no ACME certificate; the app data that matters is in `ragam-data`. A successful
backup command is not a restore verification.

For a restore drill, first stop Core and restore into a **separate test volume** while
leaving the original volume untouched. To replace a volume, confirm the archive and
retention copy before proceeding; then stop the full stack, empty/replace the intended
volume, extract the archive, and restore ownership to UID/GID `1000:1000` (the `node`
user in `Dockerfile.core`). Start the stack and verify the local workspace opens, a
known non-sensitive marker remains, provider connection configuration is present and
required files are intact. Do not experiment on the only copy of valuable data. The exact
destructive volume replacement commands depend on the chosen Compose UI/volume name; review
them before execution. Preserve the prior volume until every restore check passes.

## Updating and cutover gates

Rebuild from reviewed repository source with `docker compose up -d --build`; back up first
and keep the previous known-good images/backup until health and local workspace checks pass. There is no
automatic migration from external hosting or hosted-account export in this Docker-only
repository. The removal of deployment integrations here is repository-only: any external
service, project, deployment and data remains under its owner's control and is unchanged.
