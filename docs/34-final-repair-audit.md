# 34 — Final repair, security and release audit

Date: 2026-11-06. Branch: `arena/bd07b58d-ragam`. Audited `main`: `50e6f6ef2228f7cb2604f350f296578678407271`.

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
| P0 | Retired macOS 14 hosted runner label | High | PR Desktop run [42259100183](https://github.com/rajaram-2005/ragam/actions/runs/42259100183) cancelled macOS before setup: `The configuration 'macos-14-arm64-us-default' is not supported` | Use the supported `macos-15` hosted arm64 label and pin it with a release-test guard |
| P2 | Duplicate web API skills surface | Low | `api.js` declared `skills` twice; the first block was unreachable and unused | Dead block removed; source-level duplicate-key regression test |
| P2 | Voice preset integration from PR #13 | Informational | PR #13 assumed first-party voice weights; current `main` retires tier-specific model artifacts and voice routes fail closed | No voice weights claimed; explicit 410 fail-closed regression test |
| P2 | Model artifact SHA-256 verification | Informational | `klyvaron-store.test.mjs` and `klyvaron-quantized.test.mjs` already reject digest mismatches; no weight payloads exist in the checkout | **PASS** on code paths; no model release claimed |

## 3. PR #13 reconciliation

PR #13 is based on `849d093` and cannot be merged cleanly into the model-independent architecture at `50e6f6e`. Its fixes were classified as follows:

- **Already superseded by #18–#20:** model-independent Lite/Pro/Max profiles, removal of tier-to-model mappings, media artifact ownership, terminal-state cancellation, reset timing equalization, internal-error sanitization, Linux desktop packaging, and desktop smoke diagnostics.
- **Retained and reimplemented against current `main`:** consent timestamp bounds, password-reset coexistence/token handling, plugin owner/member authorization, duplicate install route removal, Python worker cancellation, Python executable configuration, JS/Python tokenizer parity, and duplicate UI cleanup.
- **Obsolete, not ported:** frozen first-party weight pins, a mandatory weights installer, tier voice presets and the 0.1.1 retriever card. Current `main` has no corresponding weight payloads; tiers are processing/resource/context/orchestration profiles, not distinct models or mandatory downloads. Archived model-card metadata is explicitly not release evidence.
- **Action:** a clean replacement PR from the active branch carries the retained fixes. Old PR #13 is to be closed only after the replacement is accepted.

## 4. Verification after repair

Local suites on the repair branch, with `AETHERIS_PYTHON` pointing at an isolated Python 3.11 venv containing NumPy 2.4.6, JAX 0.10.2, PyAV 18.1.0, Pillow 13.0.0 and pytest 9.2.0:

| Suite | Result | Classification |
|---|---|---|
| Core | 1,049 passed, 0 failed, 4 skipped real-artifact acceptance cases out of 1,053 | **PASS** |
| Web | 131 passed, 0 failed, 0 skipped | **PASS** |
| Fabric | 823 passed, 0 failed, 0 skipped | **PASS** |
| Desktop loopback server | 4 passed, 0 failed, 0 skipped | **PASS** |
| Production web build | Vite build succeeded; bundle has no absolute backend URL | **PASS** |
| `release-check.mjs --core 1053 --web 131 --fabric 823` | Verified 2,007 tests, 28 artefacts, 3 packs | **PASS** |
| `npm audit` web + desktop production trees | 0 vulnerabilities | **PASS** |
| Python advisory audit | 8 packages checked; no installed version covered by a known advisory | **PASS** |
| Internal-error sanitization | Uncoded thrown error returns 500 `internal_error` with a generic message | **PASS** |
| Password-reset coexistence | Two accounts' codes survive independent requests and consumption | **PASS** |
| Plugin member boundary | Member can invoke read-only tools; writing tools and state changes remain owner-only | **PASS** |
| Worker cancellation | Pre-abort starts no child; running child receives SIGTERM; spawn failure is coded | **PASS** |
| Tokenizer parity | JS/Python parity fixture includes hyphen-part cases; both sides pass | **PASS** |
| Desktop workflow guard | `macos-15` label pinned, retired `macos-14` refused, no in-progress cancellation | **PASS** |

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
| Docker Compose | CI includes build, health, persistence and restore smoke | No live external deployment | **PASS** for CI smoke on prior commit; current branch PR evidence is added in the final report |

## 7. Release verdict

**NOT RELEASE READY.** Critical code defects found in this audit are repaired and local suites pass, but release acceptance still requires uninterrupted cross-platform CI on the release commit, actual installer execution evidence where runners support it, genuine end-to-end journeys with attachments/media/plugins/backup-restore, signed installers or an explicit unsigned-artifact decision, checksums for published artifacts, and explicit approval for release publication. None of those external or destructive steps is claimed here.

## 8. Evidence addendum

The replacement PR, its CI/Desktop runs, merge commit and the rerun of the cancelled macOS workflow are recorded in the final engineering report and in the PR itself.
