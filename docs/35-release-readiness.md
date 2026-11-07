# 35 — Release readiness, artifact preparation and rollback

Status on 2026-11-07: **NOT RELEASE READY**. Verified `main` code commit: `36fef57e51c6b36a1efc6c5e16c3a699ea796665`; final `main` CI/Desktop runs passed, but this document does not publish a release, create credentials, sign artifacts, or claim that installers have been launched on real user machines. See [36 — Final engineering report](36-final-engineering-report.md).

## Version and changelog

- Current declared version: `0.2.0` (`VERSION`, root `package.json`, `apps/web/package.json`, `apps/desktop/package.json`, `services/core/package.json`).
- Proposed next version after acceptance: `0.2.1` (patch). It is **not** applied here because release acceptance criteria are unmet and a version bump without published artifacts would be a false claim.
- `CHANGELOG.md` carries an Unreleased final-repair entry. A published `0.2.1` entry would need a real date, at least three verified bullets, matching package versions, and a passing `release-check.mjs` invocation with measured suite totals from the release commit.
- `changes` in this repair set are limited to security/correctness fixes, regression tests, CI hardening and documentation. No product-surface expansion or Klyvaron architecture change is claimed.

## Required checks for `main`

Branch protection could not be read through the available GitHub integration (HTTP 403), so this is a recommendation, not a claim that protection is configured.

Require these checks before merge:

1. `CI / Core service (Node, zero dependencies)`
2. `CI / Web app (React + Vite)`
3. `CI / Fabric training service (Python + NumPy)`
4. `CI / Docker Compose build, health, persistence and restore smoke`
5. `CI / Documentation matches implementation`
6. `CI / Release verification (measured, not remembered)`
7. `Desktop packages / Linux x64 and ARM64`
8. `Desktop packages / Windows x64 and ARM64`
9. `Desktop packages / macOS Intel (x64)`
10. `Desktop packages / macOS Apple Silicon (arm64)`
11. Dependency advisory checks: web/desktop `npm audit` and `services/fabric/scripts/audit_python_deps.py`
12. Model/artifact evidence gate: fail closed when required real artifacts are absent

Recommended settings: require branches to be up to date, require linear history if the repository chooses it, disallow force-push to `main`, require conversation resolution, and do **not** enable auto-merge until all required checks pass. A cancelled or skipped Desktop job must not be counted as platform evidence.

## Artifacts and checksums

The Desktop workflow uploads unsigned artifacts named `ragam-${{ matrix.artifact }}` from `apps/desktop/release/*` with `if-no-files-found: error`. One strict retry with `overwrite: true` handles a transient artifact-service DNS failure; a persistent upload failure still fails the platform job. No code-signing credentials were available; treat every produced installer as **unsigned** until a signing identity is configured and verified.

A successful, uninterrupted Desktop packages run on the exact verified code commit now exists: [42352898123](https://github.com/rajaram-2005/ragam/actions/runs/42352898123). An operator may download its artifacts into a clean directory and produce checksums with:

```bash
RUN_ID=42352898123
OUT=release-artifacts
mkdir -p "$OUT"
gh run download "$RUN_ID" --dir "$OUT"
find "$OUT" -type f -not -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 sha256sum > "$OUT/SHA256SUMS"
(cd "$OUT" && sha256sum -c SHA256SUMS)
```

The checksum file must be generated from the exact downloaded bytes, committed to the release assets (not the source tree), and verified with `sha256sum -c`. No release artifacts have been downloaded or published, so **no checksum list is claimed**: **BLOCKED**.

## Installation instructions

- Docker single-user workspace: [22-self-hosted-deployment.md](./22-self-hosted-deployment.md) and [04-setup.md](./04-setup.md). Default is loopback-only; the LAN overlay is opt-in and requires Basic Auth plus private TLS.
- Hosted BYOK: [30-hosted-byok.md](./30-hosted-byok.md). Public registration remains disabled until production email delivery is configured. No provider key is created, read or used by this audit.
- Desktop: use the unsigned installer from the exact release run, verify it against `SHA256SUMS`, and follow the OS-specific prompts. Windows NSIS, macOS DMG, Linux AppImage and `.deb` artifacts are produced by CI; actual installer launch remains **NOT TESTED** in this sandbox.
- Model configuration: the built-in Klyvaron processor needs no model weights. External providers and local runtimes are explicitly configured by the user; no model download happens automatically.

## Backup, restore and rollback

- Docker workspace: use `scripts/Backup-Ragam.*` and `scripts/Restore-Ragam.*`. CI exercises cold backup of the named volume, restore and persistence of a synthetic workspace ID and conversation-history marker. Keep the previous volume snapshot until the restored service passes health checks.
- Desktop: preserve `.aetheris-data` (or the configured `AETHERIS_ONLINE_DATA_DIR`) before replacing an installation. Roll back by reinstalling the previous verified installer and restoring the preserved data directory; do not mix data directories across incompatible schema changes.
- Hosted BYOK: roll back the Vercel deployment to the previous known-good deployment and keep the Supabase migration unchanged unless an explicit, reviewed down migration exists. No production deployment or credential change was performed here.
- Release rollback: unpublish or mark the GitHub release as a draft, retain the prior version's artifacts and checksums, and restore documentation to the prior tagged commit. Release publication requires explicit approval.

## Required release evidence still outstanding

- Uninterrupted CI and Desktop packages runs on the exact verified code commit, including macOS: **PASS** — [CI 42352898134](https://github.com/rajaram-2005/ragam/actions/runs/42352898134) and [Desktop 42352898123](https://github.com/rajaram-2005/ragam/actions/runs/42352898123). This is build/runtime CI evidence, not a published release.
- Actual installer execution on supported runners: **NOT TESTED**.
- Live end-to-end journeys with a real configured provider, attachment processing, media generation, queued/running cancellation, restart persistence, permitted plugin execution, unauthorized-operation refusal, and backup/restore: **NOT TESTED** with genuine third-party credentials; loopback/contract coverage only.
- Live provider qualification: **BLOCKED**. Phase 2 provides a contract-tested fabric snapshot and a fail-closed consent gate, but no authorized live provider call, credential, connectivity proof or evidence digest exists.
- Live multimodal/model/sandbox/agent/deployment/release capabilities: **BLOCKED**. Phase 3–9 provides local-only contract-tested orchestration and explicit refusals; no provider inference, code sandbox, SCADA write, production rollback, telemetry transmission or release publication was performed.
- Code signing: **BLOCKED** (no signing credentials available).
- Published versioned artifacts and checksums: **BLOCKED** pending acceptance and explicit approval.
- Verified trained Pro/Max model weights: **NOT PRODUCED**. The active architecture is model-independent; archived model cards are metadata, not release evidence.

## Verdict

Do not publish a production release until the outstanding evidence is complete and approval is explicit. PRs #20–#22 are merged; PR #22's merge is not by itself a production release.
