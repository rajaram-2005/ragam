# RAGAM / Klyvaron — Release Readiness Remediation and Live Qualification

**Verdict: NOT RELEASE READY.** Baseline branch `arena/d44183df-ragam` at `80ad8458fb039962dcaee6293dd451d1c6932416` (`main` CI `42396395722`, Desktop `42396395647`, both successful). PR #28 remains open against `main`; its checks at `60182490bd3b45f199cd8057ddf4b4a41f32c2dd` are green (CI `42467789374`, Desktop `42467789381`, 13 PASS / 0 FAIL / 2 intentional skips).

This directory contains the evidence for the remediation work. It is deliberately explicit about what was actually executed and what remains externally blocked. No live third-party provider call, no model weight download, no production deployment, no signing with an unauthorized key and no release publication was performed.

| # | Deliverable | File |
|---|---|---|
| 1 | Release baseline and capability classification | [00-baseline.md](00-baseline.md) |
| 2 | Complete release-blocker register | [01-blocker-register.md](01-blocker-register.md) |
| 3 | Root-cause and repair report | [02-root-cause-repair.md](02-root-cause-repair.md) |
| 4 | Provider-by-provider live qualification | [03-provider-qualification.md](03-provider-qualification.md), [provider-register.json](provider-register.json) |
| 5 | Klyvaron model-by-model qualification | [04-model-qualification.md](04-model-qualification.md), [model-register.json](model-register.json) |
| 6 | Training evidence and evaluation | [05-training-qualification.md](05-training-qualification.md), [evidence/training-evidence.json](evidence/training-evidence.json), [evidence/training-worker-qualification.json](evidence/training-worker-qualification.json) |
| 7 | Five-area E2E report | [06-e2e-qualification.md](06-e2e-qualification.md), [evidence/e2e-qualification.json](evidence/e2e-qualification.json) |
| 8 | Security scan and telemetry | [07-security-and-telemetry.md](07-security-and-telemetry.md), [evidence/security-scan.json](evidence/security-scan.json) |
| 9 | Mobile / CLI qualification | [08-mobile-cli.md](08-mobile-cli.md) |
| 10 | Signed/versioned artifact manifest and checksum verification | [09-artifacts-and-signing.md](09-artifacts-and-signing.md), `build/release/0.2.0/manifest.json` |
| 11 | Staging deployment and rollback evidence | [10-staging-deployment.md](10-staging-deployment.md) |
| 12 | GitHub governance verification | [11-github-governance.md](11-github-governance.md) |
| 13 | Final verdict | [12-final-verdict.md](12-final-verdict.md) |
| — | **Machine-readable release gate** | [qualification.json](qualification.json) |

Raw logs and TAP output are under [evidence/](evidence/). `build/release/0.2.0/` is the ignored local artifact staging directory; the committed, independently verifiable copy of the manifest, checksums, SBOM, provenance and both reproducible archives is in [artifacts/](artifacts/) (`cd docs/release/artifacts && sha256sum -c SHA256SUMS`). Reuse `node scripts/release/build-release.mjs` from a clean checkout of the recorded commit to reproduce the bytes.

Status vocabulary: **PASS** (tested with recorded evidence), **FAIL** (tested and failed), **BLOCKED** (needs an unavailable credential, service, hardware, permission or external approval), **NOT TESTED** (no verification performed), **NOT APPLICABLE** (outside supported scope with justification). A `NOT TESTED` gate becomes `PASS` only after the missing verification is actually executed and its evidence is recorded; no status is changed merely by editing a verdict or checklist. T03 is now PASS because the real-trainer SIGTERM/failure run was executed and recorded.
