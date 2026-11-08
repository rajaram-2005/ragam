# Evidence index

| File | What it proves |
|---|---|
| `baseline.json` | Repository state before any modification (commit, PRs, CI, governance, inventory) |
| `baseline-core.tap`, `baseline-core-configured.tap` | The 5 baseline Core failures and their resolution with a configured Python interpreter |
| `baseline-web.tap`, `baseline-fabric.log`, `baseline-desktop.tap` | Baseline suite results |
| `final-core.tap` | Final Core suite, run **without** `AETHERIS_PYTHON`, proving the repo-venv fallback repair |
| `final-web.tap`, `final-fabric.log`, `final-desktop.tap` | Final Web / Fabric / Desktop suites |
| `final-release-check.log` | `release-check.mjs` with measured totals 1085/143/823 = 2051 |
| `final-web-build.log` | Production Vite build |
| `final-npm-audit-web.log`, `final-npm-audit-desktop.log`, `final-python-advisory.log` | Dependency advisory checks |
| `final-security-scan.log`, `security-scan.json` | Secret scan, syntax, deployment and telemetry checks |
| `final-e2e-run.log`, `e2e-qualification.json` | 17 five-area E2E checks against an isolated test service |
| `training-segment-a.log`, `training-interrupted.log`, `training-resumed.log`, `training-rollback.log`, `training-evidence.json` | Real local training run, interruption, resume, evaluation and bit-identical replay |
| `training-worker-qualification.json`, `training-worker-cancellation.log`, `training-worker-resume.log`, `training-worker-failure.log`, `training-worker-jobs.json`, `training-worker-checkpoint.json`, `training-worker-checksums.txt`, `training-worker-preflight.json` | Real `LocalTrainingWorkerManager` SIGTERM cancellation, atomic checkpoint resume, advanced parameter state, second cancellation before completion and failure handling against the real 27,559,946-parameter JAX/NumPy trainer; two checkpoint digests, independent `sha256sum -c`, NPZ integrity and restart persistence |
| `final-artifact-build.log`, `final-artifact-verify.log`, `final-signing-refusal.log` | Reproducible build, independent checksum verification and fail-closed signing |
| `final-yaml-check.log`, `final-diff-check.log`, `final-lock-resolve.log` | Workflow YAML parse, whitespace check, pinned Python lock resolution |

TAP logs contain raw `node --test` output; no credential values, prompts or private datasets appear in any evidence file. The two 330 MB trainer checkpoint snapshots are intentionally retained only under the ignored `build/training-worker-qualification/` directory; their SHA-256 digests, sizes, independent `sha256sum -c` results and unpickled NPZ metadata are committed. Re-run `npm run release:training-worker` to regenerate both checkpoints and evidence on a host with the pinned Python dependencies.
