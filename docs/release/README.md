# RAGAM / Klyvaron — Release Readiness Remediation and Live Qualification

**Verdict: NOT RELEASE READY.** Baseline branch `arena/d44183df-ragam` at `80ad8458fb039962dcaee6293dd451d1c6932416` (`main` CI `42396395722`, Desktop `42396395647`, both successful). PR #28 remains open against `main`. The latest code/evidence commit `110f73e7fcb8878fc5ede9dc6fc9c4aab8d7f874` is green: push CI `42572046568`, push Desktop `42572046553`, PR CI `42572053423`, PR Desktop `42572053368`; `gh pr checks 28` reports 13 PASS / 0 FAIL / 2 intentional skips plus Vercel preview passes. The 16-check real-trainer cancellation/resume evidence was regenerated at parent commit `16db404f4085819c8cececb714a5aa6816f4609c`. An owner-authorized commercial SAST/DAST workflow is now implemented but `S02` remains **NOT TESTED**. The qualification gate regenerates identically from a clean checkout without the ignored `build/` directory.

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
