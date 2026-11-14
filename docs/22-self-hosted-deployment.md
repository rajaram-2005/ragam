# Self-hosted deployment (Docker Compose)

The default Compose deployment is **one local single-user instance**: the owner runs Core,
the Vite-built web app, and Caddy with Docker on their computer. Caddy serves the web bundle
and proxies `/api/*` to Core; workspace data remains in the named `ragam-data` volume.
The default HTTP listener is loopback-only. An optional LAN overlay keeps this single-user
mode but adds one shared Caddy Basic Auth gate and Caddy's private TLS; it is for a trusted
home network, not public hosting. LAN users still share the same workspace identity and data.
The separate hosted BYOK edition is documented in [30 — Hosted BYOK](30-hosted-byok.md).

## Scope and safety

- The stack uses one durable named volume, `ragam-data`, for Core's SQLite databases,
  provider key material, settings, conversation/context data and generated files.
  Caddy state lives in separate named volumes.
- The local Core remains single-user and has no email, individual accounts or sign-in
  screen. Default Compose publishes only `127.0.0.1:80` and remains the safest choice.
- LAN mode is a deliberate opt-in: it binds only to a private IPv4 address, requires a
  shared Caddy Basic Auth password, and serves HTTPS using Caddy's internal CA. The
  Core's own local-single-user guard remains enabled; Caddy passes `Host: localhost` and
  Core allows only the exact HTTPS origin generated for that LAN hostname. Do not deploy
  the LAN overlay on a public server or forward its ports through a router.
- LAN Basic Auth is a shared gate, not per-person identity or authorization. Everyone who
  knows the password can access the same single-user workspace. Choose a strong unique
  password and share the Caddy root certificate only with devices you control.
- Hosted BYOK still uses the separate Vercel/Supabase path. The Docker LAN mode does not
  enable hosted accounts or Supabase; it stores this one workspace on the Docker host.
- Provider URLs are opened by the Core **container**. A host's `127.0.0.1` is not the
  Core container; configure a provider on an address reachable from that container (or
  within the same Docker network) and add only its exact origin to
  `AETHERIS_TRUSTED_ORIGINS` when required. The container does not bundle or download
  model weights.
- No hosting, DNS, firewall, operating-system, hardware or external-account changes are
  performed by this repository work. The operator chooses whether and where to deploy.

## Manufacturing Operations mode

The local workspace includes an opt-out manufacturing prompt layer shared across all five dashboards. Its sidebar offers maintenance triage, quality/CAPA drafting and shift-handover starters that open Chat. When enabled, Core adds advisory guidance to supported text Chat requests and appends bounded safety-first guidance to Image/Video generation, editing and understanding prompts. This applies to native Klyvaron media routes as well as the currently selected media provider; it does not alter model weights, add manufacturing knowledge by itself, or control equipment. Klyvaron Lite and individual provider models may not reliably follow complex instructions, so treat all output as unverified assistance.

Company documents remain in the existing private Knowledge store. The user must separately enable Knowledge and approve sending matching excerpts for a particular Chat turn; the industry mode itself does not transfer files. Generated media is illustrative, not evidence of actual equipment or approved practice. Answers and media should be checked against approved site procedures and reviewed by qualified people. The mode is not a safety certification, work-order system, or substitute for lockout/tagout, permits, PPE, or operator judgment.

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

### Optional LAN-only access

The default remains loopback-only. To let your own devices on a trusted private network
use the same workspace, run `scripts/Start-Lan-Ragam.ps1` from PowerShell on the Docker
host. It asks for a private IPv4 address reserved for that host, a client hostname (that
same IP or an mDNS name ending in `.local`), and a strong shared password. It uses the
Caddy container to create a bcrypt hash, writes ignored local settings, validates the
Compose overlay, and starts the stack. The tracked overlay has no published port; only
a temporary Compose override outside the repository adds the exact private IPv4 after
validation. It does not switch off Core's local-only mode.

Open `https://<the-hostname-you-entered>` from a client on the LAN. Caddy's internal CA
certificate must be trusted by each client OS/browser; the launcher exports the public
root certificate to ignored `deploy/ragam-lan-root.crt`. Import that certificate only on
devices you control, then revisit the HTTPS address. **Do not bypass certificate warnings.**
The CA private key remains in the `ragam-caddy-data` volume; protect that Docker volume
and any backups. Never port-forward 80/443 or use a public DNS name for this LAN overlay.

Stop the LAN stack without deleting data with `scripts/Stop-Lan-Ragam.ps1`. It runs
`docker compose down` without `-v`; the workspace and Caddy CA volumes remain in place.
For non-Windows hosts, use the guarded launcher from PowerShell (`pwsh`) or reproduce
its checks before generating a temporary Compose override outside the repository. The
tracked `compose.lan.yaml` alone never publishes a host port; do not add an unvalidated
bind or use it as a substitute for the launcher.

For another Docker Compose UI, open `compose.yaml` and use its default settings to keep
the published address on `127.0.0.1`. For LAN-only access, use the guarded launcher and
never bind to `0.0.0.0`, a public address, or a hosted server.

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

In default loopback mode, Caddy state is regenerable and the app data that matters is in
`ragam-data`; that HTTP setup obtains no ACME certificate. In LAN mode, `ragam-caddy-data`
also contains the private key for Caddy's internal CA. Keep that volume private and backed
up if you want to preserve client trust; never copy or share its private key. If the CA
volume is lost, Caddy will create a new root and every client must trust the newly exported
certificate. A successful backup command is not a restore verification.

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

Rebuild the default local stack from reviewed repository source with `docker compose up -d --build`; back up first and keep the previous known-good images/backup until health and local workspace checks pass. For LAN mode, use `scripts/Start-Lan-Ragam.ps1` and `scripts/Stop-Lan-Ragam.ps1`; do not run the tracked overlay directly to publish a port. The local Docker edition does not import hosted accounts or hosted provider settings; the opt-in hosted BYOK deployment remains a separate service and data boundary.
