# 07 — Security, operational qualification, telemetry and monitoring

## Security scan

`node scripts/release/security-scan.mjs` → [evidence/security-scan.json](evidence/security-scan.json): **9 PASS, 0 FAIL**. The exact tracked-file, text-file and Node-module counts are recorded in that generated JSON rather than copied here, so documentation cannot drift from the measured scan.

| Check | Result | Detail |
|---|---|---|
| `no_tracked_secret_or_weight_files` | PASS | No `.env`, `*.pem`, `*.key`, `credentials.json` or weight payloads tracked |
| `no_hardcoded_credential_literals` | PASS | 4 high-confidence patterns; 12 **reviewed synthetic** occurrences (redaction fixtures, PEM validator marker), 0 unreviewed |
| `node_syntax_all_modules` | PASS | 293 `.mjs`/`.js` files |
| `compose_defaults_loopback` | PASS | Single-user Docker binds `127.0.0.1` by default |
| `lan_requires_explicit_bind_and_auth` | PASS | LAN overlay needs explicit private bind, Basic Auth, internal TLS |
| `fabric_defaults_loopback` | PASS | Unauthenticated Fabric service defaults to loopback |
| `telemetry_privacy_invariants` | PASS | No transmission, no prompts/datasets/keys/account ids, allowlisted fields |
| `telemetry_disable_switch` | PASS | `AETHERIS_TELEMETRY_ENABLED=false` implemented and documented |
| `pinned_dependency_inputs` | PASS | Two npm lockfiles + Python lock |

Dependency advisories: `npm audit --omit=dev --audit-level=high` for [web](evidence/final-npm-audit-web.log) and [desktop](evidence/final-npm-audit-desktop.log), and `services/fabric/scripts/audit_python_deps.py` ([log](evidence/final-python-advisory.log)). Authentication/authorization, CSRF/origin, input validation, injection, file-upload and artifact-path validation are covered by the Core suite ([evidence/final-core.tap](evidence/final-core.tap)) including `request_capacity`, `csrf_rejected`, `origin_rejected`, `owner_required`, `local_only_blocked`, encoded-path-traversal and base64 re-encode checks; the E2E harness adds a member-vs-owner permission boundary.

### Explicitly out of scope (not hidden as PASS)

- Commercial SAST/DAST product scan: **NOT TESTED** — a fail-closed owner-authorized workflow exists, but no tool or license is configured and no scan was run.
- Live third-party penetration testing: **BLOCKED** — no authorized test/staging credentials.
- Production database permissions / RLS: **BLOCKED** — no staging Supabase project.
- Live provider rate-limit/timeout/network-failure cases: **BLOCKED** — see [03-provider-qualification.md](03-provider-qualification.md).
- Logging privacy review: performed structurally (allowlisted telemetry fields, `redactChatMessages`, `classifyText`/`redactDeep` in the Chat path); no raw prompt, private dataset, API key or personal data appears in reports.

### Fail-closed commercial SAST/DAST workflow

`scripts/release/commercial-sast-dast.mjs` (`npm run release:sast-dast`, also wired into `.github/workflows/release.yml` only behind an explicit `run_sast_dast` dispatch input) implements the workflow without pretending a product scan happened. With all eight owner-authorized inputs unset, the measured direct `node scripts/release/commercial-sast-dast.mjs --out "$TMP_OUT"` invocation exits **2**, writes no evidence and names every exact requirement ([evidence/final-commercial-sast-dast-refusal.log](evidence/final-commercial-sast-dast-refusal.log)). It never runs a tool or emits a fake PASS result by itself.

When all inputs are present, the owner-provided command runs the licensed commercial tool against the exact commit. The script then verifies a normalized JSON report stored **outside** the repository: schema, product, exact 40-character commit, owner identity, license confirmation, completed scan, independently supplied SHA-256, zero critical/high findings and no critical/high severity entries in the findings array. Only a privacy-preserving summary is written to `docs/release/evidence/commercial-sast-dast.json`; the command, raw tool output, raw findings, credentials and prompts are never stored in the repository. `S02` remains **NOT TESTED** until that real evidence file exists and passes these checks.

The dispatch workflow exposes the owner-controlled values as repository secrets (plus the run actor and exact commit). When `run_sast_dast` is requested it retains the verified summary in the staged artifact bundle; when it is not requested it records `sast-dast-status.json` as NOT TESTED. It never publishes a release.

Exact inputs: `RAGAM_SAST_DAST_AUTHORIZED_BY`, `RAGAM_SAST_DAST_PRODUCT`, `RAGAM_SAST_DAST_LICENSE_CONFIRM=YES`, `RAGAM_SAST_DAST_COMMAND`, `RAGAM_SAST_DAST_REPORT` (outside the repository), `RAGAM_SAST_DAST_REPORT_SHA256`, `RAGAM_SAST_DAST_COMMIT=<exact HEAD>` and `RAGAM_SAST_DAST_CONFIRM=YES`.

## Telemetry and monitoring

`services/core/src/telemetry/monitor.mjs` implements bounded, in-memory counters for:

- application health (`health_check`, `deployment_health`),
- API failure rates (`api_failure`, recorded in the Core request catch path),
- provider availability (`provider_available`, `provider_unavailable`),
- model loading failures (`model_load_failure`),
- inference latency (`inference_latency`, bounded numeric samples),
- training worker failures (`training_worker_failure`),
- job completion and cancellation (`job_completed`, `job_cancelled`),
- resource utilisation (`resource_sample`).

Privacy is structural: only `event`, `outcome`, `component` and `durationMs` are accepted; labels must match `[A-Za-z0-9._:-]{1,64}`; every extra field is dropped and counted in `redactedFields`; unknown events are refused. No transmission, no disk writes, no raw prompts, private datasets, API keys, account ids or free-form text. `readiness()` publishes the snapshot.

**Disable method:** set `AETHERIS_TELEMETRY_ENABLED=false` (also `0`, `no`, `off`) and restart Core; `record()` becomes a no-op and the snapshot reports `enabled: false`. Documented in `.env.example`. Live provider-availability and production deployment-health feeds remain BLOCKED until BL-01/BL-03 are unblocked; the counters do not pretend those feeds exist.
