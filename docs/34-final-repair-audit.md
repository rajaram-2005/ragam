# 34 — Final repair, security and release audit

Initial audit: 2026-11-06 on `arena/bd07b58d-ragam` against `main` `50e6f6ef2228f7cb2604f350f296578678407271`. Final update: 2026-11-07 on `arena/b3736a56-ragam`; verified `main` code commit `36fef57e51c6b36a1efc6c5e16c3a699ea796665`. See [36 — Final engineering report](36-final-engineering-report.md).

This is an evidence-based inventory, not a release claim. It records what was reproduced, what was repaired, what is already covered by later pull requests, and what remains blocked. Classifications follow the release directive: **PASS**, **FAIL**, **BLOCKED**, **NOT TESTED**.

## 1. Read-only baseline

- Open PRs: only [#13](https://github.com/rajaram-2005/ragam/pull/13), `CONFLICTING`/`DIRTY` against `main`. A read-only `git merge-tree` reported 15 conflicted files.
- PRs #18–#20 are merged. They introduced the model-independent Klyvaron processor, fixed media ownership/reset timing, and repaired Linux desktop packaging.
- Latest completed full CI on `main`: [42247207190](https://github.com/rajaram-2005/ragam/actions/runs/42247207190) — **PASS**.
- Latest Desktop packages run on `main`: [42247207344](https://github.com/rajaram-2005/ragam/actions/runs/42247207344) — Linux and Windows jobs **PASS**, macOS job **cancelled**, so the run is not platform-complete.
- Local baseline: Core 1,034 passed / 5 failed / 4 skipped; Web 130/130; Fabric 822/822; desktop 4/4; production web build **PASS**.
- The five Core failures reproduced the same cause: `LocalTrainingWorkerManager` ignored `AETHERIS_PYTHON` and could not find NumPy on the default `python3`.

## 2. Prioritized repair plan

| Priority | Defect | Severity | Reproduced evidence | Repair |
|---|---|---|---|---|
| P0 | Python interpreter configuration ignored on retained worker paths | High | Core baseline failures 448, 449, 451, 452, 453 all report `preflight_failed: Python 3.11+ with NumPy is not installed` even with a configured venv | `klyvaron/python-executable.mjs` makes `AETHERIS_PYTHON` authoritative; training worker, local worker, multimodal host, qualification registry and `OnlineApp` use it |
| P0 | Password-reset codes for different accounts clobber one another | High | `AccountStore.requestReset` rewrote the installation-wide plaintext file with one account; `confirmReset` cleared it for everyone | Read/merge/write active entries; consume only one account; regression test with two accounts |
| P1 | Member/plugin authorization and duplicate install route | Medium | `context-routes.mjs` had two `/api/plugins/install` guards and all plugin invocations were owner-only; unknown plugin produced an uncoded 500 | One method-specific guard; member may invoke only registry-declared read-only capabilities; unknown plugin returns coded 404 |
| P1 | Worker cancellation did not reach the Python child | Medium | `runWorkerExec` lacked an `AbortSignal` and used only SIGTERM with no escalation | Shared `worker-exec.mjs`: pre-abort refusal, abort propagation, SIGTERM→SIGKILL, timeout escalation, coded spawn failures |
| P1 | JS/Python tokenizer dropped hyphen parts | Medium | A query for `ZEPHYR` could not match `ZEPHYR-9`; parity fixture had no hyphen-part case | Both stemmers now index whole token plus parts; parity fixture regenerated; archived model card and improvement-cycle erratum corrected without claiming a new artifact |
| P1 | Training consent accepted far-future timestamps | Medium | `Date.now() - createdAt` was only checked for being too large; `Date.now() + 1e12` never expired | Shared `consent.mjs` bounds missing, expired and future-dated consent with 60 s clock skew; worker and controller use it |
| P2 | Desktop workflow could cancel an in-flight platform matrix | Medium | `cancel-in-progress: true`; macOS job in run 42247207344 was cancelled | `cancel-in-progress: false` plus a release-test guard; `fail-fast: false` retained |
| P0 | Retired macOS 14 hosted runner label / macOS scheduling capacity | High | PR Desktop run [42259100183](https://github.com/rajaram-2005/ragam/actions/runs/42259100183) cancelled macOS before setup: `The configuration 'macos-14-arm64-us-default' is not supported`; post-merge `main` run [42262149899](https://github.com/rajaram-2005/ragam/actions/runs/42262149899) left its single `macos-15` job unassigned for 15m1s | Replace `macos-14` with supported labels; split Intel x64 onto `macos-15-intel` and Apple Silicon arm64 onto `macos-26`; pin both with a release-test guard |
| P2 | Duplicate web API skills surface | Low | `api.js` declared `skills` twice; the first block was unreachable and unused | Dead block removed; source-level duplicate-key regression test |
| P2 | Voice preset integration from PR #13 | Informational | PR #13 assumed first-party voice weights; current `main` retires tier-specific model artifacts and voice routes fail closed | No voice weights claimed; explicit 410 fail-closed regression test |
| P2 | Model artifact SHA-256 verification | Informational | `klyvaron-store.test.mjs` and `klyvaron-quantized.test.mjs` already reject digest mismatches; no weight payloads exist in the checkout | **PASS** on code paths; no model release claimed |

## 3. PR #13 reconciliation

PR #13 is based on `849d093` and cannot be merged cleanly into the model-independent architecture at `50e6f6e`. Its fixes were classified as follows:

- **Already superseded by #18–#20:** model-independent Lite/Pro/Max profiles, removal of tier-to-model mappings, media artifact ownership, terminal-state cancellation, reset timing equalization, internal-error sanitization, Linux desktop packaging, and desktop smoke diagnostics.
- **Retained and reimplemented against current `main`:** consent timestamp bounds, password-reset coexistence/token handling, plugin owner/member authorization, duplicate install route removal, Python worker cancellation, Python executable configuration, JS/Python tokenizer parity, and duplicate UI cleanup.
- **Obsolete, not ported:** frozen first-party weight pins, a mandatory weights installer, tier voice presets and the 0.1.1 retriever card. Current `main` has no corresponding weight payloads; tiers are processing/resource/context/orchestration profiles, not distinct models or mandatory downloads. Archived model-card metadata is explicitly not release evidence.
- **Action — completed:** [PR #21](https://github.com/rajaram-2005/ragam/pull/21) carried the retained fixes and merged as `fc4ae9c8520de03ecc45aab7ba2c2f0709d47cc0`; [PR #13](https://github.com/rajaram-2005/ragam/pull/13) is closed with a supersession comment. [PR #22](https://github.com/rajaram-2005/ragam/pull/22) later resolved the macOS Desktop scheduling/upload blockers and merged as `36fef57e51c6b36a1efc6c5e16c3a699ea796665`.

## 4. Verification after repair

Local suites on the repair branch, with `AETHERIS_PYTHON` pointing at an isolated Python 3.11 venv containing NumPy 2.4.6, JAX 0.10.2, PyAV 18.1.0, Pillow 13.0.0 and pytest 9.2.0:

| Suite | Result | Classification |
|---|---|---|
| Core | 1,050 passed, 0 failed, 4 skipped real-artifact acceptance cases out of 1,054 | **PASS** |
| Web | 141 passed, 0 failed, 0 skipped | **PASS** |
| Fabric | 823 passed, 0 failed, 0 skipped | **PASS** |
| Desktop loopback server | 4 passed, 0 failed, 0 skipped | **PASS** |
| Production web build | Vite build succeeded; bundle has no absolute backend URL | **PASS** |
| `release-check.mjs --core 1054 --web 141 --fabric 823` | Verified 2,018 tests, 31 artefacts, 3 packs | **PASS** |
| `npm audit` web + desktop production trees | 0 vulnerabilities | **PASS** |
| Python advisory audit | 8 packages checked; no installed version covered by a known advisory | **PASS** |
| Internal-error sanitization | Uncoded thrown error returns 500 `internal_error` with a generic message | **PASS** |
| Password-reset coexistence | Two accounts' codes survive independent requests and consumption | **PASS** |
| Plugin member boundary | Member can invoke read-only tools; writing tools and state changes remain owner-only | **PASS** |
| Worker cancellation | Pre-abort starts no child; running child receives SIGTERM; spawn failure is coded | **PASS** |
| Tokenizer parity | JS/Python parity fixture includes hyphen-part cases; both sides pass | **PASS** |
| Desktop workflow guard | `macos-15-intel`/`macos-26` labels and their x64/arm64 targets pinned, retired `macos-14` refused, no in-progress cancellation | **PASS** |
| Chat transcript tools | **PASS** | Local-only search/filter, message pins, Markdown export, keyboard shortcuts, opt-in client-side JSON syntax validation and catalogue context-limit reporting are covered by nine pure helper tests and one render test; no provider, credential, weight, backend or navigation change. |

## 5. Security and architecture findings

- Authentication, sessions, rate limiting, provider-key storage, CORS/network exposure, path traversal, upload validation, plugin permissions, command-execution boundaries and sensitive logging were inspected. No new release-blocking vulnerability was reproduced in the active product paths.
- `services/core` remains zero-dependency; localhost-only self-hosted defaults and the opt-in LAN overlay remain unchanged.
- Klyvaron Lite, Pro and Max remain resource/workflow profiles of one deterministic engine. Deterministic retrieval, extraction and summaries are not general-purpose model reasoning. User-authorized knowledge/memory persistence is not automatic model training.
- No Klyvaron weight payload is present in the checkout. Archived model-card digests are metadata only and are not production-model evidence.
- No live third-party provider credentials or connectivity were available. Provider adapters are contract-tested with fixtures, not live vendor calls: **NOT TESTED** for genuine third-party integration.
- Branch protection could not be read with the available GitHub integration (`403 Resource not accessible by integration`): **BLOCKED** for verification; recommendations are in [35-release-readiness.md](./35-release-readiness.md).
- Release publication, credential changes and destructive cleanup were not performed.

## 6. Cross-platform and deployment status at audit time

| Target | Packaging/build evidence | Runtime/installer execution | Classification |
|---|---|---|---|
| Web | Production build and UI tests PASS | Browser preview not executed in this sandbox | **PASS** for build/tests; **NOT TESTED** for human browser journey |
| Windows x64/ARM64 | Prior Desktop CI run passed both architectures | Actual NSIS installer launch not executed | **PASS** for packaging; **NOT TESTED** for installer launch |
| Linux x64/ARM64 | Prior Desktop CI run passed packaging and unpacked smoke | `.deb`/AppImage installation not executed | **PASS** for packaging/smoke; **NOT TESTED** for installer launch |
| macOS Intel/Apple Silicon | Prior packaging run passed on PR #20; `main` run 42247207344 had a cancelled macOS job | DMG launch not executed | **NOT TESTED** for a current uninterrupted release-commit run |
| Docker Compose | CI includes build, health, persistence and restore smoke | No live external deployment | **PASS** for CI smoke on prior commit; final `main` evidence is in [36 — Final engineering report](36-final-engineering-report.md) |

## 7. Release verdict

**NOT RELEASE READY.** Critical code defects found in this audit are repaired, local suites pass, and `main` CI/Desktop now pass on `36fef57` across all four Desktop jobs. Remaining release blockers are actual installer execution on end-user machines, genuine third-party E2E with credentials, signed installers or an explicit unsigned-release decision, versioned artifacts/checksums, production backup/restore/rollback, branch-protection verification, and explicit approval for release publication. None of those external or destructive steps is claimed here.

## 8. Evidence addendum

The replacement PR, its CI/Desktop runs, merge commits and final release evidence are recorded in [36 — Final engineering report](36-final-engineering-report.md), in this addendum, and in the PRs themselves.

## Evidence addendum — merged PR #21 and post-merge `main` verification

This addendum records the actual remote state after the audit above. It is an audit record, not a
release certificate.

| Item | Status | Verified evidence |
| --- | --- | --- |
| PR #13 reconciliation | **PASS** | [PR #13](https://github.com/rajaram-2005/ragam/pull/13) is closed; a comment explains supersession by [PR #21](https://github.com/rajaram-2005/ragam/pull/21). Applicable fixes were preserved in PR #21; obsolete model-weight, tier-voice and 0.1.1-card changes were not merged. |
| PR #20 Linux installer fix | **PASS** | [PR #20](https://github.com/rajaram-2005/ragam/pull/20) merged as `50e6f6ef2228f7cb2604f350f296578678407271`. Linux `homepage` and `build.linux.maintainer` remain in `main`. |
| PR #21 required checks | **PASS** | [PR #21](https://github.com/rajaram-2005/ragam/pull/21) merged as `fc4ae9c8520de03ecc45aab7ba2c2f0709d47cc0`; [CI run 42260948993](https://github.com/rajaram-2005/ragam/actions/runs/42260948993) passed and [Desktop run 42260948842](https://github.com/rajaram-2005/ragam/actions/runs/42260948842) passed Linux x64/ARM64, Windows x64/ARM64, and macOS x64/ARM64. Push [Desktop run 42260940084](https://github.com/rajaram-2005/ragam/actions/runs/42260940084) and [CI run 42260940231](https://github.com/rajaram-2005/ragam/actions/runs/42260940231) also passed. |
| Post-merge `main` CI | **PASS** | [CI run 42262149788](https://github.com/rajaram-2005/ragam/actions/runs/42262149788) passed on `fc4ae9c`. |
| Post-merge `main` Desktop | **FAIL** | [Desktop run 42262149899](https://github.com/rajaram-2005/ragam/actions/runs/42262149899) failed overall: Linux and Windows passed, while its single `macos-15` job was cancelled after 15m1s with an empty `runner_name`, no steps and no runner assignment. A cancelled job is not platform verification. |
| Failed-run remediation | **BLOCKED** | `gh run rerun 42262149899` and `gh run rerun 42262149899 --failed` returned `cannot be rerun; its workflow file may be broken`; `gh workflow run "Desktop packages" --ref main` returned HTTP 403 `Resource not accessible by integration`. |
| Split-run PR Desktop | **PASS** | [Desktop run 42351310889](https://github.com/rajaram-2005/ragam/actions/runs/42351310889) on `1ab6b7c` completed all four jobs: Linux x64/ARM64, Windows x64/ARM64, macOS Intel x64 and macOS Apple Silicon arm64. This PR-run evidence is not itself a `main` release-commit run; the final `main` run is recorded below. |
| Split-run push Desktop | **FAIL** | [Desktop run 42351292466](https://github.com/rajaram-2005/ragam/actions/runs/42351292466) on the same SHA built all four platform jobs successfully, but the macOS Intel artifact upload failed with a transient Azure Blob DNS `ENOTFOUND`. The rerun was blocked. A successful replacement run is recorded below. |
| Artifact upload hardening | **PASS** | One strict retry with `overwrite: true` handles a transient artifact-service DNS failure; a persistent upload failure still fails the job. The release test pins this guard, and PR/push/`main` Desktop runs on `7be957a`/`36fef57` uploaded successfully. |
| macOS runner repair | **PASS** | The Desktop matrix uses separate standard runners: `macos-15-intel` for Intel x64 and `macos-26` for Apple Silicon arm64, each building and smoke-testing its own native architecture. The release test refuses `macos-14` and asserts both labels/targets. The final `main` Desktop run passed all four platform jobs. |
| PR #22 required checks | **PASS** | [PR #22](https://github.com/rajaram-2005/ragam/pull/22) merged as `36fef57e51c6b36a1efc6c5e16c3a699ea796665`; PR [CI 42352390609](https://github.com/rajaram-2005/ragam/actions/runs/42352390609), PR [Desktop 42352390577](https://github.com/rajaram-2005/ragam/actions/runs/42352390577), push [CI 42352386133](https://github.com/rajaram-2005/ragam/actions/runs/42352386133) and push [Desktop 42352386122](https://github.com/rajaram-2005/ragam/actions/runs/42352386122) all passed. |
| Final `main` CI | **PASS** | [CI run 42352898134](https://github.com/rajaram-2005/ragam/actions/runs/42352898134) passed on `36fef57` with six jobs and one intentional Klyvaron evidence-gate skip. |
| Final `main` Desktop | **PASS** | [Desktop run 42352898123](https://github.com/rajaram-2005/ragam/actions/runs/42352898123) passed all four platform jobs on `36fef57`: Linux x64/ARM64, Windows x64/ARM64, macOS Intel x64 and macOS Apple Silicon arm64. |
| Final engineering report | **PASS** | [docs/36](36-final-engineering-report.md) is tracked in the repository and included in release verification. |
| Chat transcript tools | **PASS** (contract-tested) | Six local-only Chat features are implemented with regression tests and explicit `not live-verified` evidence text. No live provider call, credential, model weight or backend change is claimed. |
| Genuine third-party E2E | **NOT TESTED** | No live provider credentials or connectivity were available. Mocked adapters and loopback HTTP tests are not genuine third-party verification. |
| Klyvaron trained production models | **NOT TESTED** | No weight payloads are present in the checkout. Lite/Pro/Max remain resource/workflow profiles of one model-independent deterministic engine; archived model cards are metadata, not trained model evidence. The production evidence gate is skipped by design and fails closed. |
| Signed installers / versioned release | **NOT TESTED** | No signing credentials, versioned release artifacts, checksums, signatures or published release were created. Unsigned installers remain explicitly labelled. |
| Backup/restore/rollback | **NOT TESTED** | Local file-level backup/restore tests pass, but no release deployment restore or rollback was exercised. |
| Branch protection | **BLOCKED** | The GitHub integration returned HTTP 403 for the branch-protection API; recommendations are recorded in [docs/35](35-release-readiness.md), not claimed as configured. |

The earlier post-merge Desktop failure was an infrastructure/scheduling failure, not a source
regression: the job never received a runner. The split PR Desktop run proved the new runner labels
can build and smoke-test every supported architecture, while the matching push run exposed a
transient artifact-service DNS failure at upload. The strict upload retry and split runner labels
were then verified by PR #22 and by successful CI/Desktop runs on `main` `36fef57`; those runs are
release-commit evidence for build/runtime checks, not a release publication. **Release verdict
remains NOT RELEASE READY** because the remaining evidence gaps above are not closed or explicitly
accepted. See [36 — Final engineering report](36-final-engineering-report.md).
