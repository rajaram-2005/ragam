# 36 — RAGAM / Aetheris Omni final engineering report

**Date:** 2026-11-07 (Asia/Kolkata)
**Verdict:** **NOT RELEASE READY**
**Verified code commit:** `36fef57e51c6b36a1efc6c5e16c3a699ea796665` (PR #22 merge into `main`)
**Working branch for this documentation sync:** `arena/b3736a56-ragam`
**Open pull requests at engineering verification:** none
**Published releases:** none

This report is tracked in the repository. The earlier workspace-only copy has been replaced with a
repository file, and the stale `IN PROGRESS` markers in [34](34-final-repair-audit.md) and the
outdated status line in [35](35-release-readiness.md) have been updated with the final `main`
evidence. It records the verified code commit, then separates what was actually tested from what
remains blocked or untested.

## 1. Executive verdict

| Acceptance criterion | Status | Evidence / reason |
| --- | --- | --- |
| All critical/high defects resolved | **PASS** | PR #21 resolved the audited P0/P1 defects with regression tests; PR #22 resolved the post-merge macOS scheduling and artifact-upload blockers. |
| Required CI workflows pass on release commit | **PASS** | `main` CI [42352898134](https://github.com/rajaram-2005/ragam/actions/runs/42352898134) and `main` Desktop [42352898123](https://github.com/rajaram-2005/ragam/actions/runs/42352898123) both succeeded on `36fef57`. |
| Supported platforms have verified build/runtime evidence | **PASS** | `main` Desktop completed Linux x64/ARM64, Windows x64/ARM64, macOS Intel x64 and macOS Apple Silicon arm64, each with packaged-app and loopback-Core smoke tests. |
| Essential E2E passes | **PASS (local/loopback/mocked)** | Docker Compose health, persistence and restore smoke passed in CI; deterministic contract fixtures and loopback tests passed. **NOT TESTED** for genuine third-party providers. |
| No unresolved release-blocking security findings | **PASS (scope tested)** | No new release-blocking vulnerability reproduced in active product paths; web/desktop production npm audits 0; Python advisory audit clean. No live-provider penetration test was possible. |
| Model capabilities accurately documented | **PASS** | No weight payloads are present; archived model cards are metadata only; the tokenizer correction is dated and does not claim a replacement model. |
| Installers/artifacts reproducible | **PASS (CI artifacts)** | Deterministic locked builds produce unsigned artifacts on the verified code commit. **BLOCKED** for versioned checksums/signatures: no publication or signing credentials were used. |
| Backup/restore/rollback verified | **PASS (local smoke)** / **NOT TESTED (release deployment)** | CI cold-backup/restore of a synthetic Compose volume passed; no production deployment restore or rollback was exercised. |
| No unresolved conflicting PR contains required fixes | **PASS** | PR #13 is closed/superseded; PR #20, #21 and #22 are merged; no open PRs remained at engineering verification. |
| Published production release | **BLOCKED** | Explicit approval is required; no release publication, credential change, destructive cleanup or major architecture change was performed. |

The previously active blocker — a successful Desktop run on current `main` — is resolved. The
overall verdict remains **NOT RELEASE READY** because genuine third-party E2E, signed/versioned
release artifacts, production rollback, branch-protection verification and release publication are
still outstanding. No completion percentage is claimed.

## 2. Repository and PR state

| Item | State | Link / SHA |
| --- | --- | --- |
| Verified `main` code commit | `36fef57e51c6b36a1efc6c5e16c3a699ea796665` | PR #22 merge commit |
| PR #13 | CLOSED, superseded | [PR #13](https://github.com/rajaram-2005/ragam/pull/13) |
| PR #20 | MERGED | [PR #20](https://github.com/rajaram-2005/ragam/pull/20), merge `50e6f6ef2228f7cb2604f350f296578678407271` |
| PR #21 | MERGED | [PR #21](https://github.com/rajaram-2005/ragam/pull/21), merge `fc4ae9c8520de03ecc45aab7ba2c2f0709d47cc0` |
| PR #22 | MERGED | [PR #22](https://github.com/rajaram-2005/ragam/pull/22), merge `36fef57e51c6b36a1efc6c5e16c3a699ea796665` |
| Documentation sync | PR from `arena/b3736a56-ragam` | Adds this report, updates stale audit/release evidence, and adds a regression guard; no product-code change |
| Open PRs at engineering verification | none | `gh pr list --state open` returned `[]` |
| Releases | none | `gh release list` returned empty |

PR #21 commits: `4ae2ec3` reset/plugin authorization, `2e87651` configured Python/consent/cancellation,
`1ad5b4c` tokenizer parity and model-card erratum, `d5bf3dc` CI/cleanup/docs, `4d42a16` supported
macOS 15 runner label for the PR. PR #22 commits: `1ab6b7c` separate macOS Intel/Apple Silicon jobs;
`7be957a` strict artifact-upload retry.

## 3. Defect inventory and repairs

Full evidence-backed inventory: [docs/34-final-repair-audit.md](34-final-repair-audit.md). Release
procedure and remaining blockers: [docs/35-release-readiness.md](35-release-readiness.md).

| Severity | Defect | Repair and regression evidence |
| --- | --- | --- |
| P0 | `AETHERIS_PYTHON` ignored on retained Python worker paths, producing five baseline Core failures | `services/core/src/klyvaron/python-executable.mjs` makes configured interpreter authoritative across worker, host, qualification and app paths; Core regression tests pass. |
| P0 | Password-reset codes for different accounts clobbered one another | `services/core/src/online/accounts.mjs` reads/merges/writes active entries and consumes only the used code; two-account regression test passes. |
| P0 | Retired `macos-14` label and a single `macos-15` job that stayed unassigned for 15m1s on `main` | `.github/workflows/desktop.yml` uses `macos-15-intel` for Intel x64 and `macos-26` for Apple Silicon arm64, each with its own build/smoke target; `services/core/test/release.test.mjs` pins both labels and refuses `macos-14`. Supported-label basis: [GitHub Docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [runner-images](https://github.com/actions/runner-images). |
| P1 | Member/plugin authorization and duplicate install route | One method-specific guard; member-only registry-declared read-only capabilities; owner-only writes; unknown plugin returns coded 404; internal errors sanitized. |
| P1 | Worker cancellation did not reach the Python child | `services/core/src/klyvaron/worker-exec.mjs` adds pre-abort refusal, SIGTERM→SIGKILL escalation, timeout escalation and coded spawn failures. |
| P1 | JS/Python tokenizer dropped hyphen parts | Both `services/core/src/knowledge/text.mjs` and `services/fabric/fabric/text.py` index whole token plus hyphen parts; parity fixture regenerated; archived card corrected. |
| P1 | Training consent accepted far-future timestamps | Shared `services/core/src/klyvaron/consent.mjs` bounds missing, expired and future-dated consent with 60 s clock skew. |
| P2 | Desktop workflow could cancel an in-flight matrix | `cancel-in-progress: false`, `fail-fast: false`, guarded by release test. |
| P2 | Transient artifact-service DNS failure failed an otherwise green Desktop push run | One strict retry with `overwrite: true`; a persistent upload failure still fails the job; guarded by release test. |
| P2 | Duplicate web API skills surface | Dead duplicate removed; source-level duplicate-key regression test passes. |
| P2 | Final report and audit docs were stale or workspace-only | This tracked report plus updated docs 34/35 and a docs-accuracy regression test guard the final `main` evidence and refuse stale `IN PROGRESS` markers. |
| Enhancement | Chat transcript tools | Local-only in-transcript search/filter, message pins, Markdown transcript export, keyboard shortcuts, opt-in client-side JSON syntax validation and catalogue context-limit reporting; nine pure helper tests and one render test. Implemented and contract-tested, not live-verified. |
| Enhancement | Provider fabric Phase 2 | Versioned local-only snapshot with normalized errors, model-discovery metadata, local/cloud state, health/evidence states, cost/latency scaffolding, explainable routing and fail-closed live-qualification gate; eight pure tests, one readiness test and one render test. Implemented and contract-tested, not live-verified. |
| Enhancement | Phase 3–9 orchestration | Versioned task envelope, bounded DAG validation, plan preview, local-only deterministic execution, explicit refusals for live/model/sandbox/deployment capabilities, benchmark evidence validation and platform-readiness evidence. Eight pure tests, one authenticated route test and one render test. Implemented and contract-tested, not live-verified. |
| Informational | PR #13 model-specific weight pins, mandatory weights installer, tier voice presets and 0.1.1 card | Not ported: current architecture is model-independent, no weight payloads exist, and archived cards are metadata. PR #13 was closed with a supersession comment. |

## 4. Files changed

PR #21 changed 44 files, including:

- Core runtime: `services/core/src/klyvaron/{consent,python-executable,worker-exec,training-worker,training-controller,local-worker,multimodal-host,qualification}.mjs`, `services/core/bin/klyvaron-local-worker.mjs`, `services/core/src/online/{accounts,app,context-routes}.mjs`, `services/core/src/plugins/registry.mjs`, `services/core/src/knowledge/text.mjs`, `services/core/src/server.mjs`, `.env.example`, `apps/web/src/api.js`.
- Tests/fixtures: `services/core/test/{accounts,docs,klyvaron-training-worker,klyvaron-user-worker-e2e,knowledge,online-mcp,release}.test.mjs`, `apps/web/test/structure.test.mjs`, `services/fabric/fabric/text.py`, `services/fabric/scripts/generate-parity-fixture.mjs`, `services/fabric/tests/fixtures/text-parity.json`, `services/fabric/tests/{test_parity,test_pipeline,test_robustness,test_sparsiz_cycle}.py`.
- Docs/CI: `.github/workflows/desktop.yml`, `CHANGELOG.md`, `README.md`, `docs/02-architecture.md`, `docs/03-status.md`, `docs/04-setup.md`, `docs/05-security.md`, `docs/07-improvement-cycle.md`, `docs/34-final-repair-audit.md`, `docs/35-release-readiness.md`, both `docs/model-cards/aetheris-lite-retriever-0.1.0.*` files.

PR #22 changed seven files: `.github/workflows/desktop.yml`, `CHANGELOG.md`, `README.md`,
`docs/02-architecture.md`, `docs/34-final-repair-audit.md`, `docs/35-release-readiness.md`,
`services/core/test/release.test.mjs`.

This documentation sync adds `docs/34-final-repair-audit.md`,
`docs/35-release-readiness.md` and `docs/36-final-engineering-report.md` to the tracked release
artefacts and updates `docs/34-final-repair-audit.md`, `docs/35-release-readiness.md`, `docs/03-status.md`,
`docs/04-setup.md`, `README.md`, `CHANGELOG.md`, `docs/02-architecture.md`,
`services/core/src/release/manifest.mjs` and `services/core/test/docs.test.mjs`.

Chat-area feature delivery adds `apps/web/src/chat-transcript.js` and
`apps/web/test/chat-transcript.test.mjs`, and updates `apps/web/src/areas/ChatArea.jsx`,
`apps/web/src/styles.css`, `apps/web/test/render.test.mjs`, `services/core/test/docs.test.mjs`,
`services/core/test/release.test.mjs` and the measured documentation counts. All six features are
local-only, have regression tests, and are explicitly **contract-tested, not live-verified**.

Provider fabric Phase 2 adds `services/core/src/providers/fabric.mjs` and
`services/core/test/provider-fabric.test.mjs`, and updates `services/core/src/online/app.mjs`,
`services/core/test/online.test.mjs`, `apps/web/src/areas/ChatArea.jsx`,
`apps/web/src/styles.css`, `apps/web/test/render.test.mjs`, `docs/27-provider-framework.md`,
`docs/35-release-readiness.md` and the measured documentation counts. It performs no live provider
call, credential change, model-weight download or architecture change.

Phase 3–9 delivery adds `services/core/src/orchestration/full.mjs`,
`services/core/test/orchestration.test.mjs` and `apps/web/src/orchestration-client.js`, and updates
`services/core/src/online/context-routes.mjs`, `services/core/test/online.test.mjs`,
`apps/web/src/api.js`, `apps/web/src/areas/ChatArea.jsx`, `apps/web/src/styles.css`,
`apps/web/test/api.test.mjs`, `apps/web/test/render.test.mjs`, `docs/27-provider-framework.md`,
`docs/35-release-readiness.md` and measured counts. It remains local-only and contract-tested.

## 5. Exact test counts and local verification

| Suite / check | Pass | Fail | Skip | Total / notes |
| --- | ---: | ---: | ---: | --- |
| Core | 1,068 | 0 | 4 | 1,072; four real-artifact acceptance cases skipped because ignored legacy fixtures are absent locally |
| Web | 143 | 0 | 0 | 143 |
| Fabric | 823 | 0 | 0 | 823; 823 progress dots, exit 0, no skip/failure markers |
| Desktop local | 4 | 0 | 0 | 4 |
| `release-check.mjs --core 1072 --web 143 --fabric 823` | **PASS** | 0 | — | 2,038 tests, 31 artefacts, 3 packs |
| Production Web build | **PASS** | 0 | — | Vite build |
| Web production `npm audit` | **PASS** | 0 | — | 0 vulnerabilities |
| Desktop production `npm audit` | **PASS** | 0 | — | 0 vulnerabilities |
| Python advisory audit | **PASS** | 0 | — | 8 packages checked; no installed version covered by a known advisory |
| Workflow YAML parse | **PASS** | 0 | — | `js-yaml` parse of `desktop.yml` |
| `git diff --check` | **PASS** | 0 | — | clean |

## 6. CI/CD and cross-platform results

### Final `main` release commit `36fef57`

- CI [42352898134](https://github.com/rajaram-2005/ragam/actions/runs/42352898134): **PASS**. Six jobs passed: Web app, Fabric, Core, Release verification, Documentation, Docker Compose smoke. Klyvaron production evidence gate: intentionally **SKIPPED** (fail-closed posture).
- Desktop packages [42352898123](https://github.com/rajaram-2005/ragam/actions/runs/42352898123): **PASS**. Four jobs passed: Linux x64/ARM64, Windows x64/ARM64, macOS Intel x64, macOS Apple Silicon arm64. Each built its native installer(s), smoke-tested the packaged app and loopback Core, and uploaded an unsigned artifact.

### PR #22 evidence

- PR CI [42352390609](https://github.com/rajaram-2005/ragam/actions/runs/42352390609): **PASS**.
- PR Desktop [42352390577](https://github.com/rajaram-2005/ragam/actions/runs/42352390577): **PASS**, all four jobs.
- Push CI [42352386133](https://github.com/rajaram-2005/ragam/actions/runs/42352386133): **PASS**.
- Push Desktop [42352386122](https://github.com/rajaram-2005/ragam/actions/runs/42352386122): **PASS**, all four jobs.
- `gh pr checks 22`: 13 **PASS**, 0 **FAIL**, 2 intentional **SKIPPED** (Klyvaron gate, Supabase Preview); `mergeStateStatus: CLEAN`.

### Earlier verified PR evidence

- PR #21 CI [42260948993](https://github.com/rajaram-2005/ragam/actions/runs/42260948993): **PASS**.
- PR #21 Desktop [42260948842](https://github.com/rajaram-2005/ragam/actions/runs/42260948842): **PASS** for Linux, Windows and the then-combined macOS job.
- Post-merge `main` CI [42262149788](https://github.com/rajaram-2005/ragam/actions/runs/42262149788): **PASS**.
- Post-merge `main` Desktop [42262149899](https://github.com/rajaram-2005/ragam/actions/runs/42262149899): **FAIL** — single `macos-15` job cancelled after 15m1s with no runner assignment; superseded by the successful `36fef57` run above.
- First split-run push Desktop [42351292466](https://github.com/rajaram-2005/ragam/actions/runs/42351292466): **FAIL** only at macOS Intel artifact upload due transient Azure Blob DNS `ENOTFOUND`; superseded by strict retry and successful `7be957a`/`36fef57` runs.

### Platform matrix

| Platform | Build / packaged smoke | Installer artifact | Real end-user install/launch |
| --- | --- | --- | --- |
| Linux x64 and ARM64 | **PASS** | AppImage + deb, unsigned | **NOT TESTED** |
| Windows x64 and ARM64 | **PASS** | NSIS, unsigned | **NOT TESTED** |
| macOS Intel x64 | **PASS** on `macos-15-intel` | DMG, unsigned | **NOT TESTED** |
| macOS Apple Silicon arm64 | **PASS** on `macos-26` | DMG, unsigned | **NOT TESTED** |
| Web | **PASS** production build | Vite bundle | **NOT TESTED** as a hosted production deployment |
| Docker Compose | **PASS** loopback-only build/health/persistence/restore smoke | CI-only stack | **NOT TESTED** as a production deployment |

Cancelled, skipped or unexecuted jobs were not counted as platform verification.

## 7. Security, E2E and architecture status

- **Security:** authentication, sessions, rate limiting, provider-key storage, CORS/network exposure, path traversal, upload validation, plugin permissions, command-execution boundaries and sensitive logging were audited. Regression tests cover reset coexistence, plugin authorization/internal-error sanitization, worker cancellation, consent freshness, tokenizer parity and duplicate API keys. Localhost-only defaults are preserved. Web/desktop production audits report 0 vulnerabilities; Python advisory audit found no installed version covered by a known advisory.
- **E2E distinction:** mocked provider adapters and deterministic contract fixtures **PASS**; loopback HTTP/Desktop/Compose tests **PASS**; genuine third-party provider integration **NOT TESTED** because no live credentials/connectivity were available. No claim of live provider verification is made.
- **Klyvaron:** Lite/Pro/Max remain resource/workflow/context/orchestration profiles of one model-independent deterministic engine, not distinct trained models or mandatory weight downloads. `git ls-files` found zero tracked weight-like files (`.safetensors`, `.bin`, `.pt`, `.pth`, `.onnx`, `.gguf`, `.npz`, `.ckpt`). Archived model cards are metadata only. The archived 0.1.0 configuration was re-measured at MRR `0.787269` versus the previously recorded `0.849702`; no replacement artifact or trained production model is claimed. The production evidence gate is intentionally skipped and fails closed.
- **Learning/personalization:** user-authorized knowledge/personalization and persistent memory where enabled are not represented as automatic model training or general intelligence. Deterministic retrieval, extraction and summaries are not presented as general-purpose model reasoning.

## 8. Deployment, installer and release readiness

- **Reproducibility:** **PASS** for CI builds from locked dependencies on the verified code commit. Desktop artifact names are `ragam-linux-x64-arm64`, `ragam-windows-x64-arm64`, `ragam-macos-intel-x64`, `ragam-macos-arm64`; each upload uses `if-no-files-found: error` and one strict retry.
- **Signing:** **NOT TESTED**. No signing credentials were available; every installer is explicitly **unsigned**.
- **Versioned release artifacts/checksums/signatures:** **NOT TESTED**. `VERSION` remains `0.2.0`; no release, checksum file, signature or published artifact was created.
- **Backup/restore/rollback:** local synthetic Compose cold-backup/restore **PASS**; production deployment restore/rollback **NOT TESTED**.
- **Branch protection:** **BLOCKED**. `gh api repos/rajaram-2005/ragam/branches/main/protection` returned HTTP 403 `Resource not accessible by integration`; recommendations are documented, not claimed as configured.
- **Provider fabric:** **PASS** (contract-tested) for local-only error/model/health/measurement/routing evidence; **BLOCKED** for live provider qualification because no authorized live call, credential, connectivity proof or evidence digest exists.
- **Phase 3–9 orchestration:** **PASS** (contract-tested) for versioned envelopes, bounded DAGs, local deterministic workflows and explicit refusals; **BLOCKED** for live provider calls, model inference, sandboxes, production deployment, telemetry and release publication.
- **Release publication:** **BLOCKED** pending explicit approval. No release was published, installers remain unsigned, no credentials were changed, and no destructive cleanup or architecture changes were made.

## 9. Limitations, risks and next safe repairs

1. Genuine third-party E2E requires real credentials/connectivity and must be distinguished from mocked/loopback tests.
2. Signed installers or an explicit unsigned-release decision, versioned artifacts and published checksums/signatures require credentials and approval.
3. Production backup/restore/rollback must be exercised on an actual release deployment before publication.
4. Branch-protection settings could not be verified with the current GitHub integration permissions; an authorized reviewer should confirm required checks, linear history, no force-push and conversation resolution.
5. Actual installer launches on end-user Windows/Linux/macOS machines are untested; CI packaged smoke tests are not a substitute.
6. Klyvaron must not be marketed as trained Pro/Max models without verified weight files, hashes and runtime qualification.
7. The macOS arm64 hosted runner annotation warns of possible longer queue times; a future capacity failure should produce a fresh successful run rather than counting a cancelled job as evidence.
8. Node.js 20 action deprecation and Ubuntu-latest migration warnings appear in CI annotations; they are non-blocking today but should be scheduled before the runner image changes.
9. The new Chat transcript tools are local-only and contract-tested; they are not a live provider, multimodal, research, coding, agent or production-deployment verification.
10. Provider fabric Phase 2 is contract-tested metadata only; live provider qualification, health probes, quality evaluation and cost measurement require explicit authorization and real evidence.
11. Phase 3–9 orchestration is local-only and contract-tested; live research, model multimodal inference, code execution sandboxes, agent side effects, SCADA writes, production rollback and release publication remain blocked or not tested.

## 10. Final acceptance

**NOT RELEASE READY.** All code-level critical/high defects identified in this audit are repaired with
regression tests, and both required workflows passed on the verified `main` code commit with all four
supported Desktop jobs green. The remaining evidence gaps and approval-gated actions above prevent a
production-release claim. No release was published, installers remain unsigned, and no credentials,
destructive cleanup, or architecture changes were made. Continue with the next safe repair only within
those bounds; publication, signing, credential changes, destructive cleanup, and architecture changes
require explicit approval.
