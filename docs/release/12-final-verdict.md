# 12 — Final release-readiness verdict

## **NOT RELEASE READY**

Machine-readable gate: [qualification.json](qualification.json). It is generated from the evidence files by `node scripts/release/generate-qualification.mjs` and validated by `services/core/test/release-qualification.test.mjs`; a PASS without recorded evidence, a BLOCKED without an exact unblock requirement, or a live-credential gate marked PASS without a call log is refused.

### What passes

Implementation-level confidence is now independently verifiable: the full Core/Web/Fabric/Desktop suites, measured `release-check.mjs`, production web build, static syntax and secret scan, dependency advisories, a real 17-check five-area backend E2E against an isolated test service, a real local training run with parameter updates/checkpoint/resume/rollback and before/after evaluation, a real 16-check `LocalTrainingWorkerManager` SIGTERM/atomic-checkpoint-resume/failure-path run against the 27,559,946-parameter JAX/NumPy trainer, reproducible clean-checkout artifacts with independently verified SHA-256 checksums, a CycloneDX SBOM, build provenance, a fail-closed signing workflow, a clean-checkout regression test that regenerates the same gate without any ignored `build/` directory, privacy-conscious telemetry with a documented disable method, and the model/tier separation and unavailable-model refusals.

### What does not pass

| Area | Status | Exact unblock requirement |
|---|---|---|
| Live third-party provider qualification (45 providers) | **BLOCKED** | Explicitly authorized test/staging credentials via the exact config fields in [provider-register.json](provider-register.json), plus owner authorization for one real call per provider |
| Klyvaron Lite/Pro/Max weights, load and inference | **BLOCKED** | Licensed weight payloads with trusted SHA-256 manifests, compatible hardware and an install procedure outside Git |
| User-consented training on a private dataset | **BLOCKED** | Explicit consent, owned/validated dataset and fingerprint |
| Foundation/adapter training | **BLOCKED** | Weights, architecture, hardware, consent and a reviewed implementation |
| Live five-area E2E / real video artifacts / remote MCP | **BLOCKED** | Authorized live providers and a remote MCP test server |
| Commercial SAST/DAST | **NOT TESTED** | A licensed tool run against the exact commit |
| Isolated staging deployment, monitoring, backup/restore and **executed rollback** | **BLOCKED** | An isolated staging environment and explicit owner approval to deploy and roll back |
| Production RLS / DB permissions | **BLOCKED** | Staging Supabase project with the migration applied |
| Cryptographic signature and independent verification | **BLOCKED** | `RAGAM_RELEASE_SIGNING_KEY_ID`, `RAGAM_RELEASE_SIGNING_KEY_FILE`, `RAGAM_RELEASE_SIGNING_AUTHORIZED_BY`, `RAGAM_RELEASE_SIGNING_CONFIRM=YES` and an authorized key outside the repository |
| Intended release location | **BLOCKED** | Owner-authorized GitHub Release / registry destination |
| GitHub branch protection, reviews, secret protection, release permissions | **BLOCKED** | `administration:read` permission or an owner statement (HTTP 403 today) |
| Real end-user installer launch | **NOT TESTED** | Real Linux/Windows/macOS machines and permission to install |
| Release publication | **BLOCKED** | **Separate explicit authorization from the repository owner**, after every mandatory gate passes |

### Non-negotiable compliance statement

No fabricated results, no fake provider calls, no mock-only proof of live operation, no fake model weights, no consent bypass, no hardcoded secrets, no unauthorized paid API usage, no destructive cleanup, no production deployment, no signing with an unauthorized key and no release publication were performed. No third-party model is represented as first-party Klyvaron. No foundation-model training claim is made for the tiny local smoke run or the bounded real-trainer cancellation/resume runs. No BLOCKED gate was converted into PASS, and T03 became PASS only after the missing real-trainer verification was executed with 16 recorded checks, raw logs, two independently verified checkpoint digests, measured step-1 → step-3 resume evidence and a regression guard.

**Release publication requires separate explicit authorization from the repository owner.**

## Gate summary (generated, not hand-written)

`docs/release/qualification.json` currently contains **71 gates**: **41 PASS**, **0 FAIL**, **25 BLOCKED**, **1 NOT TESTED**, **4 NOT APPLICABLE**; **28 mandatory gates are not PASS**. The remaining NOT TESTED item is a commercial SAST/DAST product scan. T03 is PASS because the real-trainer SIGTERM, atomic checkpoint resume and failure-path runs were actually executed and their evidence was recorded; no BLOCKED gate was converted into PASS.

Measured local verification behind the PASS gates: Core `1082/1086` (4 real-artifact acceptance cases skipped), Web `143/143`, Fabric `823/823`, Desktop `4/4`, `release-check.mjs` `2052` tests / 31 artefacts / 3 packs, production web build (50 modules), web+desktop `npm audit --omit=dev` 0 vulnerabilities, Python advisory audit clean, security scan `9/9`, five-area E2E `17/17`, committed tiny-training evidence `11/11`, real-trainer worker cancellation/resume/failure evidence `16/16`, committed-artifact SHA-256 verification `4/4`, clean-checkout gate regeneration `1/1`, and artifact verification `16/16` with byte-identical rebuild.

**Final objective status:** the repository is reproducibly buildable, locally verified and honestly qualified at implementation level. It is **not** staging-qualified, signed or published, and therefore remains **NOT RELEASE READY**.

## Post-remediation CI

Pushed branch `arena/d44183df-ragam` at `5e97ae95beeaa12caeb7f71b34b7b7456359bf8e`: PR #28 CI `42566510022` **PASS** (six jobs; one intentional fail-closed skip) and Desktop packages `42566510108` **PASS** (four platforms); push CI `42566504024` and push Desktop `42566504049` also **PASS**. `gh pr checks 28` reported 13 PASS / 0 FAIL / 2 skips plus Vercel preview passes. This head includes the clean-checkout qualification repair: artifact gates now use the committed `docs/release/artifacts/` set, `B04` accepts all recorded successful push/pull_request runs, and a regression test regenerates identical gate statuses without `build/`. The 16-check real-trainer cancellation/resume evidence was generated from source commit `38e3739d0dd534967c488bd410900958658a9b16`; later evidence-only and documentation commits contain no trainer or worker-runtime changes. Earlier transient Electron/toolset 504s were fixed by the documented mirror overrides and a bounded retry, then all four packaging jobs passed. Recorded in [evidence/ci-runs.json](evidence/ci-runs.json). CI success is build/test evidence, not live qualification.
