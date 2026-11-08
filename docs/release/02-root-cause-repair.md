# 02 — Root-cause and repair report

## Baseline failure analysis

The first full Core run produced 5 failures out of 1,072 tests ([evidence/baseline-core.tap](evidence/baseline-core.tap)): four training-worker cases and one consent/resource case, all with `preflight_failed: Python 3.11+ with NumPy is not installed on this host`. Re-running with the documented `AETHERIS_PYTHON=.venv/bin/python` gave 1,068 pass / 0 fail / 4 skip ([evidence/baseline-core-configured.tap](evidence/baseline-core-configured.tap)). The tests were not suppressed, skipped or rewritten to hide a defect.

The root cause was a **clean-checkout reproducibility gap**: `inspectEnvironment()` probed `/tmp/accel-venv`, `/tmp/fabric-venv` and `python3`, but not the repository's own `.venv`. A developer who followed the documented setup still needed an extra shell export that CI never needs, because CI installs NumPy into the system interpreter.

## Repairs

| ID | Root cause | Change | Regression test | Evidence |
|---|---|---|---|---|
| R1 | Repo-local venv ignored by Python worker fallback | `services/core/src/klyvaron/python-executable.mjs` now exports `DEFAULT_PYTHON_FALLBACKS` with `<repo>/.venv/bin/python` first; `training-worker.mjs` uses it. An explicit `AETHERIS_PYTHON` remains authoritative. | `release-qualification.test.mjs` → "clean checkout with an in-repo venv is a Python fallback, and a configured interpreter still wins" | [evidence/final-core.tap](evidence/final-core.tap) |
| R2 | Python dependencies resolved by name on every CI run | Added `services/fabric/requirements.lock` (13 pinned packages from `pip freeze`); CI's three install steps now use `pip install -r ...`. | `release-qualification.test.mjs` → SBOM derived from committed lockfiles; security scan checks lock inputs | [evidence/final-python-advisory.log](evidence/final-python-advisory.log), `sbom.cdx.json` |
| R3 | No privacy-conscious operational monitoring | New `services/core/src/telemetry/monitor.mjs`: bounded in-memory counters for health, API failures, provider availability/unavailability, model-load failures, inference latency, training-worker failures, job completion/cancellation, resources and deployment health. **Allowlisted fields only** — prompts, datasets, keys, account ids and free-form text are dropped and counted as redactions. It transmits nothing. Wired into `OnlineApp.readiness()` and the API-failure path. | Four telemetry tests in `release-qualification.test.mjs` (redaction, unknown events/bounds, disable, runtime wiring) | [evidence/security-scan.json](evidence/security-scan.json), [07-security-and-telemetry.md](07-security-and-telemetry.md) |
| R4 | "ready in this build" could be read as live-qualified | `apps/web/src/components/ProviderCatalogue.jsx` now says "wire contract-tested in this build; live vendor qualification pending". | `apps/web/test/render.test.mjs` (two assertions) and `release-qualification.test.mjs` → I13 | [evidence/final-web.tap](evidence/final-web.tap) |
| R5 | No reproducible release/signing process | New `scripts/release/{lib,build-release,verify-release,sign-release,security-scan,e2e-qualification,generate-provider-register,generate-model-register,generate-qualification,verify-training-worker-cancellation}.mjs`, `scripts/release/{verify-training-evidence.py,inspect-training-checkpoint.py}`, and `.github/workflows/release.yml`. Checksums written with `node:crypto` and verified independently with `sha256sum -c`; SBOM from committed lockfiles; provenance from `git archive`; signing fails closed without four explicit inputs. | Six release-tooling tests (checksum tamper, SBOM, report validation, signing fail-closed, provider/model registers, evidence integrity) plus the real-trainer evidence guard | [09-artifacts-and-signing.md](09-artifacts-and-signing.md) |
| R6 | External Electron/toolset release host returned HTTP 504 during Desktop packaging | `.github/workflows/desktop.yml` uses the officially documented `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` overrides and retries the real unpacked-app build three times with backoff. No packaging check is skipped and checksums remain enforced. | `release-qualification.test.mjs` asserts the retry loop, both mirror variables and the real `electron-builder --dir` command | [evidence/ci-runs.json](evidence/ci-runs.json): Desktop run `42467789381`, all four platforms PASS |

## What was deliberately not done

- No failing test was skipped, weakened or replaced by a mock.
- No production functionality was replaced by a mock. The isolated provider used in E2E is a **test service**, clearly labelled, and never reported as a live vendor.
- No live provider call, model weight, credential, signature, deployment or publication was fabricated.
- No architecture change: Lite/Pro/Max remain profiles of one shared model-independent engine, because no separate trained models exist.
- No third-party model was represented as first-party Klyvaron.

## Additional measured qualification (not a code repair)

BL-07 was an evidence gap, not a production defect. `scripts/release/verify-training-worker-cancellation.mjs` starts the real `services/fabric/scripts/train_klyvaron.py` through `LocalTrainingWorkerManager`, observes step 1, cancels with SIGTERM, verifies the atomic checkpoint with `sha256sum -c` and an unpickled NPZ inspection, reloads the manager from disk, and records a real trainer failure path. The 12 measured checks and raw logs are in [evidence/training-worker-qualification.json](evidence/training-worker-qualification.json) and the accompanying `training-worker-*` files. This is a cancellation/lifecycle smoke test, not a production-model or foundation-training qualification; the 330 MB checkpoint stays in the ignored `build/` directory.

## Verification criteria for the repaired defects

All six repairs are guarded by tests that fail if the behaviour regresses; the full Core, Web, Fabric and Desktop suites, the measured `release-check.mjs`, the production web build, the security scan, the E2E harness, the training evidence verifier, the real-trainer cancellation harness and the independent artifact verifier are recorded under [evidence/](evidence/) and [09-artifacts-and-signing.md](09-artifacts-and-signing.md).
