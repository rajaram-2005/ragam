# 00 — Release baseline and capability classification

Captured **before any file was modified** on `arena/d44183df-ragam` at `80ad8458fb039962dcaee6293dd451d1c6932416`, equal to `origin/main`. Working tree clean. Open PRs: none. Latest `main` CI `42396395722` PASS (six jobs) and Desktop `42396395647` PASS (four jobs: Linux x64/ARM64, Windows x64/ARM64, macOS Intel x64, macOS Apple Silicon arm64). Machine-readable baseline: [evidence/baseline.json](evidence/baseline.json).

## Inventory

| Surface | Baseline |
|---|---|
| Version | `0.2.0` (`VERSION`, root/web/desktop/core `package.json`) |
| Product areas | Chat, Image, Video, Plugins, MCP (exactly five) |
| Core service | `services/core/src/online/app.mjs`, zero npm dependencies, Node 22 ESM, SQLite stores |
| Provider framework | `services/core/src/providers/catalog.mjs`: **46** providers — 23 `ready` (contract-tested wire), 22 `gateway_only` (fixture-tested adapters), 1 `pending` (`diffusers`, not selectable) |
| Provider fabric / orchestration | Phase 2 snapshot and Phase 3–9 local-only DAG planner; explicit refusals for live/model/sandbox/deployment capabilities |
| Klyvaron | One model-independent deterministic processor; Lite/Pro/Max are processing/resource/context profiles, **not** distinct trained models |
| Model artifacts | **0** tracked weight files; 12 archived cards, all `not_released`, metadata only |
| Workers | `LocalTrainingWorkerManager`, `klyvaron-local-worker.mjs`, Fabric Python service, media job queue |
| Deployment | `Dockerfile.core`, `Dockerfile.web`, `apps/web/vercel.json`, `compose.yaml` (loopback-only single user), `compose.lan.yaml` (opt-in private LAN with Caddy Basic Auth + internal TLS), `deploy/Caddyfile*`, Windows PowerShell launchers |
| Tests | 130 test files across Core (1,072), Web (143), Fabric (823), Desktop (4) at baseline |
| Mobile / CLI | No `apps/mobile`, no iOS/Android/React Native source, no end-user CLI product |

## Capability classification

| Capability | Classification | Reason |
|---|---|---|
| Auth, account/session lifecycle, CSRF/origin checks, SQLite persistence | **Real** | Implemented and exercised against real SQLite stores over real HTTP sockets ([evidence/e2e-qualification.json](evidence/e2e-qualification.json)) |
| Five-area API routing, provider/model selection, streaming, job queue, cancellation | **Real (local/isolated)** | Production modules driven over loopback; provider is an isolated test service, not a vendor |
| Provider wires (46) | **Real code, simulated responses** | Every wire has deterministic fixture tests; no authorized live credential exists |
| Image generation/storage/gallery/provenance | **Real pipeline, isolated provider** | Real PNG bytes stored and served; provider is an isolated test service |
| Video generation | **Real job lifecycle, no real artifact** | Queue creation/progress/failure/cancellation verified; no MP4 produced |
| Klyvaron Lite/Pro/Max model loading & inference | **Unavailable** | No weights, no runtime model; native tier model requests are refused with 410 |
| Multimodal first-party models | **Unavailable** | No image/audio/video weights; native multimodal requests refused |
| Foundation/adapter training on user data | **Unavailable** | No user dataset, consent record or installed model architecture |
| Real local NumPy smoke training | **Real, narrowly scoped** | See [05-training-qualification.md](05-training-qualification.md); tiny from-scratch model, not a production model |
| Live third-party provider qualification | **Unavailable / BLOCKED** | No authorized test/staging credentials |
| Staging deployment, rollback, signing, published artifacts | **Unavailable / BLOCKED** | No staging environment, signing key, release infrastructure or publication approval |
| Desktop installers | **Real build evidence in CI, real-user install NOT TESTED** | Four CI jobs build and smoke-test packaged apps; no end-user installation was performed |

## Baseline test observations

- Core without a configured Python: 1,072 tests, **1,063 pass / 5 fail / 4 skip** ([evidence/baseline-core.tap](evidence/baseline-core.tap)). All five failures were the local training-worker preflight refusing a default `python3` without NumPy.
- Core with `AETHERIS_PYTHON=.venv/bin/python` (documented configuration): 1,072 tests, **1,068 pass / 0 fail / 4 skip** ([evidence/baseline-core-configured.tap](evidence/baseline-core-configured.tap)). Four skips are real-artifact acceptance cases whose ignored legacy fixtures are absent.
- Web 143/143, Fabric 823/823, Desktop 4/4 at baseline.

The five failures were an environment prerequisite rather than a product defect, but they exposed a real clean-checkout reproducibility gap (the repository's own `.venv` was not a fallback). That was repaired at root cause; see [02-root-cause-repair.md](02-root-cause-repair.md).

## Post-remediation CI verification on the pushed branch

After the remediation commits, `arena/d44183df-ragam` at `744d29c29b4770c2036f511ebb6e976ed7a3ec3e` produced CI `42460843714` and Desktop packages `42460843680`, both `success` ([evidence/ci-runs.json](evidence/ci-runs.json)). All six CI jobs passed (Core, Web, Fabric, Docker Compose smoke, Documentation, Release verification); the Klyvaron production evidence gate was intentionally skipped and is never counted as model evidence. All four Desktop jobs passed. These runs confirm the pinned Python lock and the clean-checkout fallback work on a clean GitHub runner; they do not qualify live providers, models, staging, signing or publication.
