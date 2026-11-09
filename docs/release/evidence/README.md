# Evidence index

| File | What it proves |
|---|---|
| `baseline.json` | Repository state before any modification (commit, PRs, CI, governance, inventory) |
| `baseline-core.tap`, `baseline-core-configured.tap` | The 5 baseline Core failures and their resolution with a configured Python interpreter |
| `baseline-web.tap`, `baseline-fabric.log`, `baseline-desktop.tap` | Baseline suite results |
| `final-core.tap` | Final Core suite, run **without** `AETHERIS_PYTHON`, proving the repo-venv fallback repair and including the clean-checkout gate-regeneration regression test |
| `final-web.tap`, `final-fabric.log`, `final-desktop.tap` | Final Web / Fabric / Desktop suites |
| `final-release-check.log` | `release-check.mjs` with measured totals 1086/143/823 = 2052 |
| `final-web-build.log` | Production Vite build |
| `final-npm-audit-web.log`, `final-npm-audit-desktop.log`, `final-python-advisory.log` | Dependency advisory checks |
| `final-security-scan.log`, `security-scan.json` | Secret scan, syntax, deployment and telemetry checks |
| `final-e2e-run.log`, `e2e-qualification.json` | 17 five-area E2E checks against an isolated test service |
| `training-segment-a.log`, `training-interrupted.log`, `training-resumed.log`, `training-rollback.log`, `training-evidence.json` | Real local training run, interruption, resume, evaluation and bit-identical replay |
| `training-worker-qualification.json`, `training-worker-cancellation.log`, `training-worker-resume.log`, `training-worker-failure.log`, `training-worker-jobs.json`, `training-worker-checkpoint.json`, `training-worker-checksums.txt`, `training-worker-preflight.json`, `final-training-worker-run.log` | Real `LocalTrainingWorkerManager` SIGTERM cancellation, atomic checkpoint resume, advanced parameter state, second cancellation before completion and failure handling against the real 27,559,946-parameter JAX/NumPy trainer; two checkpoint digests, independent `sha256sum -c`, NPZ integrity, restart persistence and the reproducible 16/16 harness run |
| `final-artifact-build.log`, `final-artifact-verify.log`, `final-signing-refusal.log` | Reproducible build, independent checksum verification and fail-closed signing |
| `final-committed-artifacts-check.log`, `docs/release/artifacts/SHA256SUMS`, `docs/release/artifacts/manifest.json` | Four committed artifact digests verified in place with `sha256sum -c`; the qualification generator independently recomputes all four digests against both the manifest and checksum file in a clean checkout |
| `final-clean-gate.log` | `npm run release:clean-gate`: 1/1 PASS regression test regenerates the qualification report in a temporary tracked-tree copy with no `.git`, `node_modules`, `.venv` or `build/` directory |
| `final-commercial-sast-dast-refusal.log` | Direct `node scripts/release/commercial-sast-dast.mjs --out "$TMP_OUT"` with all eight `RAGAM_SAST_DAST_*` variables unset exits 2, names all eight exact inputs, runs no scan and writes no PASS evidence; `S02` remains NOT TESTED and `commercial-sast-dast.json` is intentionally absent |
| `final-yaml-check.log`, `final-diff-check.log`, `final-lock-resolve.log` | Workflow YAML parse, whitespace check, pinned Python lock resolution |
| `ci-runs.json` | Final code/evidence commit `110f73e7fcb8878fc5ede9dc6fc9c4aab8d7f874`: four successful CI/Desktop runs (`42572046568`, `42572046553`, `42572053423`, `42572053368`), 13 PASS / 0 FAIL / 2 intentional skips, and the NOT TESTED commercial SAST/DAST refusal |

TAP logs contain raw `node --test` output; no credential values, prompts or private datasets appear in any evidence file. No `commercial-sast-dast.json` PASS evidence exists: the fail-closed workflow requires an owner-authorized product, license, command, external report and independently supplied digest before it can run. The two 330 MB trainer checkpoint snapshots are intentionally retained only under the ignored `build/training-worker-qualification/` directory; their SHA-256 digests, sizes, independent `sha256sum -c` results and unpickled NPZ metadata are committed. Re-run `npm run release:training-worker` to regenerate both checkpoints and evidence on a host with the pinned Python dependencies. The older tiny NumPy smoke-training verifier also reads its own ignored `build/training-qualification/` run artifacts; a clean checkout keeps the committed `training-evidence.json`, segment logs and successful `final-training-verify.log` from the measured run, and does not claim to have re-executed those four segments without their local artifacts.
