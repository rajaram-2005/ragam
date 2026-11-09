# RAGAM / Klyvaron — Release Readiness Remediation and Live Qualification

**Verdict: NOT RELEASE READY.** Baseline branch `arena/d44183df-ragam` at `80ad8458fb039962dcaee6293dd451d1c6932416` (`main` CI `42396395722`, Desktop `42396395647`, both successful). PR #28 remains open against `main`; its checks at `5e97ae95beeaa12caeb7f71b34b7b7456359bf8e` are green (push CI `42566504024`, push Desktop `42566504049`; PR CI `42566510022`, PR Desktop `42566510108`; 13 PASS / 0 FAIL / 2 intentional skips). The 16-check real-trainer cancellation/resume evidence was generated from source commit `38e3739d0dd534967c488bd410900958658a9b16`. The qualification gate now regenerates identically from a clean checkout without the ignored `build/` directory.

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
| 8 | Security scan, telemetry and fail-closed commercial SAST/DAST workflow | [07-security-and-telemetry.md](07-security-and-telemetry.md), [evidence/security-scan.json](evidence/security-scan.json), `scripts/release/commercial-sast-dast.mjs` |
| 9 | Mobile / CLI qualification | [08-mobile-cli.md](08-mobile-cli.md) |
| 10 | Signed/versioned artifact manifest and checksum verification | [09-artifacts-and-signing.md](09-artifacts-and-signing.md), `docs/release/artifacts/manifest.json` |
| 11 | Staging deployment and rollback evidence | [10-staging-deployment.md](10-staging-deployment.md) |
| 12 | GitHub governance verification | [11-github-governance.md](11-github-governance.md) |
| 13 | Final verdict | [12-final-verdict.md](12-final-verdict.md) |
| — | **Machine-readable release gate** | [qualification.json](qualification.json) |

Raw logs and TAP output are under [evidence/](evidence/). `build/release/0.2.0/` is the ignored local artifact staging directory; the committed, independently verifiable copy of the manifest, checksums, SBOM, provenance and both reproducible archives is in [artifacts/](artifacts/) (`cd docs/release/artifacts && sha256sum -c SHA256SUMS`). The qualification generator reads that committed set, so a clean checkout without `build/` regenerates the same gate statuses; this is guarded by the `release-qualification.test.mjs` clean-checkout regression test. Reuse `node scripts/release/build-release.mjs` from a clean checkout of the recorded commit to reproduce the bytes.

Status vocabulary: **PASS** (tested with recorded evidence), **FAIL** (tested and failed), **BLOCKED** (needs an unavailable credential, service, hardware, permission or external approval), **NOT TESTED** (no verification performed), **NOT APPLICABLE** (outside supported scope with justification). A `NOT TESTED` gate becomes `PASS` only after the missing verification is actually executed and its evidence is recorded; no status is changed merely by editing a verdict or checklist. T03 is now PASS because the real-trainer SIGTERM, checkpoint resume and failure-path runs were executed and recorded. `S02` remains NOT TESTED: the owner-authorized commercial SAST/DAST workflow is implemented, but no licensed product, external report or real scan evidence exists.
