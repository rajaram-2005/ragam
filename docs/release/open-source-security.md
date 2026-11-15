# Open-source security qualification

This is the zero-cost OSS security path, separate from both the commercial SAST/DAST
workflow and any live-production or provider qualification. It runs only against the
repository and, for DAST, a disposable local Compose environment. It does not scan
production, model/provider endpoints, third-party domains, or user data.

## Commands

```sh
npm run release:sast
npm run release:dast
npm run release:secrets
npm run release:dependencies
npm run release:security:full
npm run release:security:test
```

The individual commands each run the selected scanner plus its relevant control gates.
Only `release:security:full` can make an overall OSS qualification claim, and only
when all eight independent gates (SAST, individual finding review, DAST, auth/authz,
secret scanning, dependency scanning, report checksums, and source integrity) pass with
validated evidence, an exact clean commit, complete scope, and both active DAST scans.
A scanner that is missing, times out, cannot update its advisory data, returns parser
errors, or cannot produce valid reports blocks its gate; it is never treated as zero
findings. Set `RAGAM_SECURITY_NO_DOWNLOAD=1` to refuse automated scanner installation.

All output is written outside the checkout. By default, run directories are created
under `${TMPDIR:-/tmp}/ragam-security-qualification/`; set
`RAGAM_SECURITY_OUTPUT_DIR` to another private external directory when needed. The
runner resolves symlinks and refuses an output root that points into the source tree.
Each run contains sanitized unified evidence, a source-snapshot manifest, a
non-content per-file inventory (relative filename, classification, byte count, and
SHA-256 for included regular files; symlinks use a digest of their link target),
aggregate exclusion counts for generated output and user data, per-scanner JSON/SARIF/HTML
reports, and independent checksum manifests. `.aetheris-data` is represented only by
its aggregate exclusion count; its individual paths and contents are not persisted. CI
uploads those sanitized records as a 30-day artifact; source-file contents, raw scanner
output, logs, and tool installations are not uploaded. Native scanner output is captured
privately and removed. ZAP JSON is reduced to sanitized alerts; its HTML deliverables
are rendered from that sanitized JSON after native HTML validity is checked. Reports
omit source snippets, secret values, request/response bodies, cookies, and credentials.
Secret findings retain affected file/line and rotation guidance only. The runner
records the base commit/tree, working-tree fingerprint, exact snapshot fingerprint,
file counts, exclusions, and stability before/after scanning; any dirty or changing
worktree blocks release qualification.

## Scope and isolation

- **SAST — Semgrep CE 1.185.0:** scans JavaScript/TypeScript, Python, Docker/deployment
  configuration, Compose, GitHub Actions YAML, and the security runner with checked-in
  community rules. Scope includes the root package manifest, environment template,
  and pinned scanner lock. Scanner metrics, Semgrep version checks, and registry access are disabled. Parser
  errors make the result incomplete; `.semgrepignore` files and inline `nosem`
  comments are refused. The runner disables Semgrep's version-check network request
  and usage metrics; no rule is suppressed to obtain a pass. The
  preliminary engineering context for the earlier seven-MEDIUM report and subsequent
  six-MEDIUM worktree scan is documented in `docs/release/open-source-sast-triage.md`;
  it is not a substitute for fresh evidence or owner sign-off.
- **DAST — OWASP ZAP 2.17.0:** requires Docker Compose v2 and Buildx on Linux/amd64.
  `security/dast/compose.yaml` creates only an internal Docker network, publishes no
  host ports, and uses fresh tmpfs Core data. A fixed `http://edge:8080` alias is the
  sole target. ZAP runs passive spider/alerting plus time-bounded full-web and OpenAPI
  active scans. Both active scripts ignore warning-level process exits (`-I`) while
  preserving alerts in the reports; any nonzero active-scan exit or missing validated
  report blocks DAST and retains sanitized output. Synthetic owner/member checks
  exercise anonymous, owner, and member
  authorization boundaries; provider calls are refused before network work. Active
  mutations are confined to disposable test state. Before ZAP is pulled or run, the
  runner compares the locked OCI digest with the official GHCR version tag using
  `docker buildx imagetools inspect`; a mismatch or unavailable check blocks DAST.
  The digest currently in `security/scanner-versions.json` is explicitly unverified
  until that runtime comparison succeeds.
- **Secrets — Gitleaks 8.30.1:** scans tracked, untracked, and ignored non-generated
  working-tree files (including local `.env`, key, and credential files) plus all
  local Git refs in a temporary offline mirror. Known generated/cache outputs and the
  `.aetheris-data` local user-data store are separately classified and excluded from
  content scans; user-data contents and individual paths are not read into or persisted
  by the snapshot. Before mirroring history, a path-name-only Git inventory checks for
  historical `.aetheris-data` entries; if any exist or that inventory fails, the history
  scan is blocked before copying any history objects. The prior generated evidence file
  is excluded narrowly. Symlinks are not followed and cause the Gitleaks
  working-tree scan to fail closed. Inline allow-comments and repository ignore files are
  not accepted as suppression policy. CI fetches full history. Ignored in-scope files
  are included in the content hash and make the checkout ineligible for a clean-commit
  PASS. Reports identify locations and recommend revocation/rotation without
  printing secret values.
- **Dependencies/configuration — Trivy 0.76.2:** scans JavaScript and Python
  dependency lockfiles (including the Fabric `requirements.lock`), repository
  filesystems for vulnerabilities, misconfigurations, and secrets, and Docker,
  Compose, and supported IaC configuration. It also builds and scans the local
  Core and Web/Caddy images, with the Web image serving the isolated edge alias,
  when Docker is available. JSON reports
  are converted to minimal SARIF from the same native scan result. Fixed versions and
  compatibility-tested remediation guidance are retained; the scanner never
  upgrades dependencies.

Scanner release archives are version-pinned and SHA-256 checked before execution.
The Semgrep rule source, commit, archive checksum, and upstream license are checked in
under `security/semgrep/`; its rule files are distributed under their separate
upstream AGPL-3.0 license. Rules are not fetched from a paid or hosted registry.
The workflow uses the pinned Gitleaks CLI (MIT) rather than the Gitleaks GitHub Action.
The Action's v3 EULA requires a license key for organization-owned repositories but
not personal-account repositories; using the CLI avoids that separate EULA/license
path entirely. No paid scanner service or license is used.

## Separate qualification tracks

The optional commercial SAST/DAST workflow remains available in
`.github/workflows/release.yml` via `scripts/release/commercial-sast-dast.mjs`; this
OSS workflow neither runs nor changes its status. Neither OSS scans nor a local mock
claim commercial penetration testing, live-provider/model security, or production
qualification. Those remain `NOT TESTED` until independently authorized evidence is
provided.
