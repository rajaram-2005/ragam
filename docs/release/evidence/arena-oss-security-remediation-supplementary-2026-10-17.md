# OSS security remediation — supplementary evidence

**Record date:** 2026-10-17 (session-authoritative UTC date)
**Status:** supplementary engineering evidence only; **NOT RELEASE QUALIFIED**
**Prior cutoff records:** preserved unchanged. This record supplements them and does not replace historical scanner logs or qualification artifacts.

## Clock and evidence handling

The sandbox host clock reported `2026-11-16T07:09:57Z`, which conflicts with the session-authoritative date above. The latest scanner run also stamped its artifacts with 2026-11-16. Those timestamps are preserved verbatim for traceability, but are not treated as reliable evidence of wall-clock date or review timeliness. Scanner reports and source inventories remain in restrictive, private `/tmp` directories; no raw scanner output was added to the repository or uploaded.

## Source identity and SAST follow-up

The audited base was branch `arena/947d8745-ragam`, commit `63729311f83f4b0bb17ef073ab1d8eb30a8985f5`, tree `9cf511d2c1e4d82ae62abe7b666eacb5d845bb35`. The final pre-commit SAST-only run was `ae850e81-6951-40fc-ad65-312d4f17ad96` (`npm run release:sast`) using pinned Semgrep CE **1.185.0**. It scanned an isolated, stable snapshot of 758 files / 13,364,983 bytes. The modified worktree was stable during the run, but dirty; therefore this run is not a clean-commit qualification.

Semgrep completed with five MEDIUM matches, all for `security.semgrep.rules.generic.wget-unencrypted-url`. Source-level review found each to be a fixed container-loopback health/admin probe with no sensitive payload or remotely reachable loopback hop. No rule was disabled or suppressed. Dispositions are keyed to the rule, location, and source-line-bound SHA-256 fingerprint:

| Location | Fingerprint | Technical disposition |
|---|---|---|
| `Dockerfile.web:22` | `sha256:3962b1a2b6843d3890920fbd8b1833c6ae243405bcf60f4115ff073226b54e12` | Contextual false positive: fixed Web-container loopback liveness request. |
| `compose.yaml:61` | `sha256:b2bc2d46fd23ebfa561a6999ecde4d9da1739d15287b0bd71bfd03fe1d3b0f38` | Contextual false positive: fixed Web-container loopback liveness request. |
| `compose.yaml:87` | `sha256:093d2c3623c7c1331ba5a5dddbcfd35f01a7b3ee5dbac0acbb364e1e74611c70` | Contextual false positive: Caddy's unpublished container-local admin health probe; no credentials or response body. |
| `scripts/release/open-source-security.mjs:1822` | `sha256:9f4a53779f40c94e47a7bc5a3d05c9b54b22c00244dbd03da553e77f0622d489` | Contextual false positive: fixed pre-scan Web-container loopback readiness request. |
| `security/dast/compose.yaml:70` | `sha256:34c3ee0b8056583a66d23795f375bfe34818080e0c5a017975eb3f115945c49c` | Contextual false positive: fixed DAST Web-container loopback liveness request. |

The technical-review gate passed for this run, but reviewer labels are explicitly **unauthenticated provenance**. The entries identify Arena.ai Agent Mode's AI-assisted source review; they are not human review, owner approval, or cryptographic attestation. The catalog rejects self-asserted `OWNER_ACCEPTED_RISK` entries because this repository has no authenticated owner-identity trust root. A human owner must provide any required approval through a separately trusted process.

The run's SAST gate and `SOURCE_INTEGRITY` gate **failed** because the source worktree was dirty; the overall result was **NOT QUALIFIED**. `SAST_FINDING_REVIEW` and `REPORT_CHECKSUMS` passed. DAST, synthetic auth/authz, Gitleaks, and Trivy were not part of this SAST-only run.

### Sanitized report verification

Private evidence directory: `/tmp/ragam-security-remediation-sast-final4/63729311f83f-2026-11-16T07-34-16-231Z-ae850e81/`.

| Artifact | Bytes | SHA-256 | Validation |
|---|---:|---|---|
| `reports/semgrep.json` | 33,246 | `9efbc3d1192db145554b9c269ac6e5e41b3d06501f3d7dd7f8a2e73f7190dba2` | `ragam-sanitized-semgrep-report/1`; 5 findings; sanitized projection |
| `reports/semgrep.sarif` | 7,236 | `755fc699af7072d0ab844ccaf4b0a7405bbe6c3bdbff4ef29d38b0aa8644b507` | SARIF 2.1.0; one run; sanitized projection |
| `source-snapshot.json` | 821 | `a2187f9f6f1aec09527ce20f4c368d8a91245d1ec1e5580e9405544555a2fcac` | Manifest hash independently checked |
| `source-inventory.json` | 418,525 | `1a9e686ca4543c0b160313dd6b32b51a93651708fa18f3bcddee3111b7291684` | Manifest hash independently checked; 1,818 entries |

`sha256sum -c SHA256SUMS-sast` and `sha256sum -c SHA256SUMS-source-snapshot` both passed independently. The JSON/SARIF structure and absence of source/secret-like fields were also independently checked. Snapshot SHA-256: `bf3f6d514736f065e0e684c6fc437105c91cebf578bcfa280f7a3cb671187e2f`; working-tree fingerprint: `69958ef6f2f455389f42e42f5c5eb077ad6c0b8efb8bb914dd07038de87f9630`. Snapshot stability and cleanup passed, but the dirty-worktree condition remains disqualifying.

## Other local verification

The following commands completed successfully on the remediation worktree:

- `npm test`: exit 0. Core: 1,082 passed, 0 failed, 4 skipped (1,086 total); Web: 143/143 passed; Fabric: 831 tests collected and the full quiet run exited 0 at 100%.
- `npm run web:build`: Vite production build succeeded.
- `npm run release:security:test`: **20/20**.
- `node --test services/core/test/release-qualification.test.mjs`: **14/14**.
- `npm run release:clean-gate`: **1/1**.
- JavaScript syntax checks for the security runner, utilities, and regression tests: passed.
- `node scripts/release/security-scan.mjs --out /tmp/ragam-security-scan-final.json`: **10 PASS / 0 FAIL** across 758 tracked files before the code commit. The post-commit rerun at `/tmp/ragam-security-scan-eb64c6d.json` also passed **10/10** across 759 tracked files. These local checks are ancillary and are not substitutes for pinned OSS scanner qualification.

Fabric's locked Python dependencies were installed into `/tmp/ragam-fabric-venv-637` from `services/fabric/requirements.lock`; no repository dependency file was changed.

## Post-commit full qualification addendum

A full run was performed on the clean remediation code commit `eb64c6d792248452d82a536a316dac65c89ac690` (tree `e626c9f3678364d860b3d99117f4ec33a03fc0ee`) on `arena/947d8745-ragam`. Run ID `2ebc1e8e-d2f0-4c14-8924-7b953e495692` used `npm run release:security:full`, the pinned Semgrep 1.185.0 binary, and `RAGAM_SECURITY_NO_DOWNLOAD=1`. The no-download setting deliberately prevented another release-asset transfer attempt for unavailable Gitleaks/Trivy; it is not evidence that either scanner ran.

- Overall result: **BLOCKED / NOT QUALIFIED**.
- **SAST PASS:** 5 MEDIUM findings; all 5 had source-bound technical dispositions; no HIGH/CRITICAL findings. No suppression was used.
- **SAST finding review PASS:** technical review only; reviewer identity and human/owner approval remain unauthenticated/not claimed.
- **Source integrity PASS:** detached clean-commit snapshot; 759 files / 13,373,649 bytes; snapshot SHA-256 `3b98a4f073769652230ed0c708eb4663298dc4056101efe52c5cf1c7520b9157`; stable during scan and cleanup succeeded.
- **DAST and authentication/authorization BLOCKED:** Docker and Podman unavailable; no stack, probes, image build, registry inspection, or ZAP scan ran.
- **Secrets and dependency scanning BLOCKED:** Gitleaks 8.30.1 and Trivy 0.76.2 were not installed or executed. There are no scanner findings to disposition from these gates.
- **REPORT_CHECKSUMS BLOCKED overall:** SAST reports and source-snapshot manifests verified; DAST/authz/Gitleaks/Trivy reports were absent, so the complete required report set could not pass.

For this run, sanitized Semgrep JSON (33,246 bytes) SHA-256 was `f845413e2edb0e499ab145683389c5d907c508dd1c241833d3e1c96f836fef79`; sanitized SARIF (7,236 bytes) SHA-256 was `755fc699af7072d0ab844ccaf4b0a7405bbe6c3bdbff4ef29d38b0aa8644b507`. Both report files and the source-snapshot manifests passed independent `sha256sum -c` verification. Evidence is retained privately under `/tmp/ragam-security-remediation-full-commit-eb64c6d/`; no raw report was uploaded. The sandbox clock still emitted 2026-11-16 timestamps, which remain disputed against the session date above.

This addendum qualifies only the exact code commit named above. It is not a release qualification; the blocked gates and owner actions below still apply.

## Remaining gates and owner actions

- **SAST:** **PASS** on clean code commit `eb64c6d792248452d82a536a316dac65c89ac690`; the earlier pre-commit SAST-only run failed source integrity because its worktree was dirty. No human reviewer or owner approval is claimed.
- **Finding review:** technical fingerprint-bound disposition **PASS** in the pre-commit SAST run; human/owner identity is **NOT AUTHENTICATED**.
- **Secrets:** **BLOCKED / NOT TESTED**. Pinned Gitleaks 8.30.1 did not execute. The baseline release-asset transfer failed with TLS/curl exit 35; a later GitHub CLI transfer ended with EOF. Neither result represents a secrets scan or a finding disposition. Six local refs and 259 reachable commits were inventoried, but were not scanned by Gitleaks.
- **Dependencies/configuration/containers:** **BLOCKED / NOT TESTED**. Pinned Trivy 0.76.2 did not execute; its local help and supported flags could not be inspected, so no Trivy invocation change is claimed. The baseline release-asset transfer failed with TLS/curl exit 35. No dependency, lockfile, IaC, filesystem-secret, or image scan completed.
- **Containers and DAST:** **BLOCKED / NOT TESTED** because neither Docker nor Podman is available. No image was built/scanned, no Compose stack was launched, no synthetic auth/authz probe ran, and no ZAP scan was performed. The DAST Compose source has stronger read-only/tmpfs controls and regression checks, but runtime isolation is unverified.
- **ZAP identity:** the lock still pins `ghcr.io/zaproxy/zaproxy:2.17.0@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6`; live OCI index and `linux/amd64` manifest identity remain **UNVERIFIED**. Parser tests now require the exact image, an OCI/Docker index media type, a unique exact-platform descriptor, and a digest-bearing manifest; tests do not replace a registry inspection.
- **Checksums:** SAST and source-snapshot checksum verification **PASS** for the exact run artifacts listed above. The overall `REPORT_CHECKSUMS` gate is **BLOCKED** because DAST/authz/Gitleaks/Trivy reports were not produced.
- **Source integrity:** **FAIL** for the earlier pre-commit SAST-only run due to a dirty worktree; **PASS** for the full run on code commit `eb64c6d792248452d82a536a316dac65c89ac690`. This record's later evidence-only update is outside that run and does not rewrite its source identity.
- **Signing:** **OWNER ACTION REQUIRED**. GPG and an authorized trusted project key/signature were unavailable; no key was generated and no signature was created.

Overall verdict remains **NOT RELEASE READY**. No production target, real account, live provider, credential rotation, key creation, history rewrite, or real-data operation was performed. No public scanner artifact upload occurred.
