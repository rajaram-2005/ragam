# 08 — Mobile and CLI qualification report

## Officially supported interfaces (established from the repository)

| Interface | Exists | Evidence |
|---|---|---|
| Web app (React + Vite, served same-origin with Core or via Vercel) | **Yes** | `apps/web/`, `apps/web/vercel.json`, `compose.yaml`, CI build |
| Desktop app (Electron; Linux x64/ARM64, Windows x64/ARM64, macOS Intel/Apple Silicon) | **Yes** | `apps/desktop/`, `.github/workflows/desktop.yml`, Desktop run `42396395647` |
| Self-hosted single-user workspace (Docker Compose + Caddy, launcher scripts) | **Yes** | `compose.yaml`, `compose.lan.yaml`, `scripts/Start-Ragam.cmd`, `scripts/Start-Lan-Ragam.ps1` |
| Hosted BYOK web deployment | **Yes (code path; not deployed)** | `services/core/src/hosted/byok.mjs`, `docs/30-hosted-byok.md` |
| Mobile application (iOS / Android / React Native / Flutter) | **No** | `git ls-files` contains no mobile source; no `apps/mobile` |
| End-user CLI client | **No** | `services/core/bin/`, `services/fabric/scripts/` and `scripts/*.ps1` are operator/worker entrypoints and launchers, not a supported CLI product |

## Qualification

| Gate | Status | Justification / requirement |
|---|---|---|
| Supported-interface inventory | **PASS** | Above table, derived from the checkout and [evidence/baseline.json](evidence/baseline.json) |
| Mobile installation, auth, configuration, API connectivity, core workflows, network interruption, error reporting, backend compatibility | **NOT APPLICABLE** | No mobile app exists. Marking a nonexistent client qualified would be a fabricated result; no such client is implied anywhere in the release material. |
| CLI installation, auth, configuration, API connectivity, core workflows, network interruption, error reporting, backend compatibility | **NOT APPLICABLE** | No CLI product exists. Operator scripts are not a CLI client and are not marked as one. |
| Web / Desktop / self-hosted API connectivity and error reporting | **PASS (partial, local scope)** | Real Core HTTP E2E in [06-e2e-qualification.md](06-e2e-qualification.md); CI packaged-app smoke tests; production web build |
| Real end-user installation on each desktop OS | **NOT TESTED** | Requires real Linux/Windows/macOS machines and permission to install |

If a mobile or CLI client is added in a future release it must be qualified separately; this report does not grant it a status by implication.
