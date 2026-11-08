# 11 — GitHub governance verification

Inspected with `gh api` and `gh run list` on `arena/d44183df-ragam`; raw observations in [evidence/baseline.json](evidence/baseline.json). **No branch protection or setting was changed or weakened.**

| Setting | Observed value | Status |
|---|---|---|
| Default branch | `main` | **PASS (verified)** |
| Visibility | `public` | **PASS (verified)** |
| `allow_merge_commit` / `allow_squash_merge` / `allow_rebase_merge` | all `true` | **PASS (verified)** |
| `delete_branch_on_merge` | `false` | **PASS (verified)** |
| Rulesets API | `[]` | **PASS (verified)** |
| Environments API | `total_count: 0` | **PASS (verified absence)** |
| Latest `main` CI / Desktop | `42396395722` / `42396395647`, both `success` | **PASS (verified)** |
| Required CI checks and protected release branches | `GET /branches/main/protection` → **HTTP 403** `Resource not accessible by integration` | **BLOCKED** |
| Required reviews and merge restrictions | Same 403; `rulesets: []` does not prove absence of protection | **BLOCKED** |
| Secret protection / Actions secrets | `GET /actions/secrets` → **HTTP 403** | **BLOCKED** |
| Release permissions | Not readable with the available token | **BLOCKED** |
| Signed commit / tag requirements | Not readable with the available token | **BLOCKED** |
| Deployment approval controls | **NOT APPLICABLE** — no GitHub Environments exist (`total_count: 0`), therefore there is no environment-level approval control to verify. This is an observed absence, not an assumed protection. | **NOT APPLICABLE** |

**Exact unblock requirement:** a token with `administration:read` (or a repository-owner session) to read branch protection, rulesets, secrets and release permissions; alternatively a signed statement from the repository owner for each setting. No secret values may be read. Branch protection must not be weakened to obtain a passing result. Recommended (not claimed as configured) required checks are listed in `docs/35-release-readiness.md`: the six CI jobs, four Desktop jobs, advisory audits and the fail-closed model/artifact evidence gate.
