# 09 — Versioned artifact manifest, checksum verification and signing

## Reproducible process

| Requirement | Implementation | Status |
|---|---|---|
| Declared semantic version | `VERSION` = `0.2.0`, checked against root/web/desktop/core `package.json` by `build-release.mjs` | **PASS** |
| Exact source commit | The recorded commit now resolves after fetching its exact SHA into the local Git object database; its resolved tree matches `provenance.json`. This verifies the source/tree association, not the authenticity of the unsigned provenance claim | **PASS** |
| Clean checkout | `build-release.mjs` refuses a dirty tree unless `--allow-dirty` is passed and extracts `git archive <commit>` into an empty temp directory. The recorded clean-checkout field passes verification, but the unsigned record does not independently authenticate the build environment | **PASS** |
| Pinned dependencies | `apps/web/package-lock.json`, `apps/desktop/package-lock.json`, `services/fabric/requirements.lock` (CI installs from the lock); `npm ci` in the extracted checkout | **PASS** |
| Generated release artifacts | `ragam-source-0.2.0.tar.gz`, `ragam-web-0.2.0.tar.gz` (deterministic tar, `gzip -n`) | **PASS** |
| SHA-256 checksums | `SHA256SUMS` written with `node:crypto` | **PASS** |
| Independent checksum verification | `verify-release.mjs` shells out to `sha256sum -c SHA256SUMS` — a different implementation from the writer — and recomputes every manifest digest | **PASS** |
| CycloneDX 1.5 SBOM | `sbom.cdx.json` from the committed lockfiles only (never `node_modules`) | **PASS** |
| Build provenance consistency | The verifier confirms the fetched commit/tree, version, three lockfile digests, SBOM digest, and source/web artifact digests match the committed bundle. The metadata is unsigned, so this is consistency evidence, not authenticated builder/source attestation | **PASS** |
| Cryptographic signature with an authorized key | `sign-release.mjs` + `.github/workflows/release.yml`; **no authorized key exists** | **BLOCKED** |
| Independent signature verification | `verify-release.mjs --require-signature` imports only an owner-supplied armored public key into a throwaway GPG home, pins its full fingerprint, and verifies `SHA256SUMS.asc` over `SHA256SUMS`; no signed bundle or authorized public-key pin is available | **BLOCKED** |
| Intended release location | Verified artifact copies are committed as qualification evidence in `docs/release/artifacts/`; the local `build/release/0.2.0/` staging directory is ignored. No GitHub Release/registry or other publication destination was used | **BLOCKED** |
| Release publication | No publication step exists; `workflow_dispatch` only stages on the workflow run | **BLOCKED** (separate owner authorization) |

Commands:

```bash
node scripts/release/build-release.mjs --out build/release/0.2.0
node scripts/release/verify-release.mjs --dir build/release/0.2.0
node scripts/release/verify-release.mjs --dir docs/release/artifacts  # committed evidence copy
node scripts/release/verify-release.mjs --dir build/release/0.2.0 \
  --require-signature \
  --public-key /secure/path/authorized-public-key.asc \
  --fingerprint <full-owner-approved-fingerprint>
```

Historical logs: [evidence/final-artifact-build.log](evidence/final-artifact-build.log), [evidence/final-artifact-verify.log](evidence/final-artifact-verify.log), and [evidence/final-signing-refusal.log](evidence/final-signing-refusal.log). The authoritative cutoff run is [evidence/arena-artifact-verification-2026-10-17.log](evidence/arena-artifact-verification-2026-10-17.log); it records the provenance commit as unavailable in that shallow checkout. The later [supplementary verification log](evidence/arena-artifact-verification-supplementary-2026-10-17.log) records fetching the exact commit without changing the branch, rechecking provenance consistency, and the still-blocked required-signature run. Committed copies of the manifest, checksums, SBOM and provenance are in [artifacts/](artifacts/).

## Signing workflow (fail-closed, no fake signatures)

`scripts/release/sign-release.mjs` requires **all four** inputs and refuses with exit code 2 otherwise (verified by a regression test):

```bash
RAGAM_RELEASE_SIGNING_KEY_ID=<key id> \
RAGAM_RELEASE_SIGNING_KEY_FILE=/secure/path/authorized-private-key.asc \
RAGAM_RELEASE_SIGNING_AUTHORIZED_BY='repository owner' \
RAGAM_RELEASE_SIGNING_CONFIRM=YES \
node scripts/release/sign-release.mjs --dir build/release/0.2.0
```

It imports the key into a throwaway GPG home, produces a detached armor signature over `SHA256SUMS`, then independently verifies it with `gpg --verify`. It never generates a key, never picks a default keyring key, refuses a key file inside the repository (so no private key can be committed), and writes `signature.json` only after verification succeeds. `.github/workflows/release.yml` runs it only when `sign: true` is explicitly requested at `workflow_dispatch`; otherwise it writes `signature-status.json` with `"status":"UNSIGNED"`.

The hosted signing step is restricted to the repository owner and runs only when `sign: true` is explicitly selected. It accepts the owner-exported armored private key as the protected `RAGAM_RELEASE_SIGNING_PRIVATE_KEY_ASCII` secret, writes it to a mode-0600 file under `$RUNNER_TEMP` (`umask 077`), removes the secret from the step environment, passes only the temporary path to `sign-release.mjs`, and deletes the file on exit. The signer imports that key into its own throwaway GPG home, signs `SHA256SUMS`, verifies the signature, and never generates a key. Local manual signing still supplies `RAGAM_RELEASE_SIGNING_KEY_FILE` as a path outside the repository.

After signing, the workflow runs `verify-release.mjs --require-signature` as a separate verification step. It imports only an owner-exported armored public key into a fresh GPG home, requires its externally pinned full fingerprint, checks the detached signature over `SHA256SUMS`, and refuses private-key input. Configure the protected `RAGAM_RELEASE_VERIFY_PUBLIC_KEY_ASCII` and `RAGAM_RELEASE_VERIFY_FINGERPRINT` secrets from the owner-approved public key; the verifier neither creates keys nor signs. No valid signed bundle has been tested.

**Exact remaining requirement:** the owner must generate/export and authorize the key, configure `RAGAM_RELEASE_SIGNING_KEY_ID` and protected `RAGAM_RELEASE_SIGNING_PRIVATE_KEY_ASCII` for the owner-only workflow (or provide a local `RAGAM_RELEASE_SIGNING_KEY_FILE`), set the remaining signing variables, configure the owner-exported public key and pinned fingerprint for independent verification, and authorize a release destination. No private key or signature was created by this repository work and no release was published.

## Commercial SAST/DAST evidence in the staged bundle

`.github/workflows/release.yml` also has an explicit `run_sast_dast` dispatch input. When it is not requested, the workflow records `sast-dast-status.json` with `"status":"NOT TESTED"` in the staged bundle. When it is requested, the owner-authorized licensed tool runs, `scripts/release/commercial-sast-dast.mjs` validates the external report and the workflow copies only the privacy-preserving `commercial-sast-dast.json` summary into the staged bundle. No raw tool output, raw findings, license token or credential is stored. No commercial scan has been run and no such evidence file exists in this repository; see [07-security-and-telemetry.md](07-security-and-telemetry.md) and [evidence/final-commercial-sast-dast-refusal.log](evidence/final-commercial-sast-dast-refusal.log).

## Recorded build (actual bytes)

Built from clean checkout of commit `b53c8748a82946ac57b4471be177677258bcf4f5` (tree `17b9fd48c3a87190ba60179b1acf5771df2b1d72`), Node `v22.22.3`, linux/x64. The evidence files added after the build are in a later commit; the provenance commit above is the exact source of both artifacts — nothing from the working tree was used.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `ragam-source-0.2.0.tar.gz` | 2,718,279 | `94bb24e07a5ab20db7407d7cf49cd9ad9079103196009e1ad4dd020e2ff4710e` |
| `ragam-web-0.2.0.tar.gz` | 646,873 | `03affb534da321b861c545b65bda2864b12add98fc50dbd285d9a5bd740342d9` |
| `sbom.cdx.json` | 114,784 | `e5abd964d954626035e71fe554eed3f4a821b3fdcfbef8f21e3dc12a7eddfe7f` (340 components) |
| `provenance.json` | 1,886 | `008386ffa8640d87d6a0757aee241e090e644c38ed955079d478990681cccbfc` |

At the authoritative 2026-10-17 cutoff, a fresh `node scripts/release/verify-release.mjs --dir docs/release/artifacts` run emitted **17 checks: 14 PASS, 2 FAIL, 1 NOT TESTED**, then exited 1. SHA-256 checksums and artifact digests passed; provenance commit resolution and tree comparison failed because the recorded commit `b53c8748a82946ac57b4471be177677258bcf4f5` was absent from the shallow checkout at that time; detached-signature verification was NOT TESTED because the bundle was unsigned. The exact cutoff output is [evidence/arena-artifact-verification-2026-10-17.log](evidence/arena-artifact-verification-2026-10-17.log), and it remains unchanged.

In supplementary local revalidation, the exact recorded commit was fetched with `git fetch --no-tags origin b53c8748a82946ac57b4471be177677258bcf4f5` without changing `HEAD` or the current branch. The default verifier then reported **22 checks: 21 PASS, 0 FAIL, 1 NOT TESTED** and exited 0; commit/tree, lockfile, SBOM, and artifact-digest consistency checks passed. Its qualification-report checks validate schema/status integrity only and do not refresh the older committed snapshot. A separate `--require-signature` run reported **21 PASS, 1 BLOCKED** and exited 1 because `SHA256SUMS.asc` is missing. These later results are recorded in [evidence/arena-artifact-verification-supplementary-2026-10-17.log](evidence/arena-artifact-verification-supplementary-2026-10-17.log). Default verification success is not release acceptance: the required signature is absent, and the unsigned provenance metadata does not authenticate its builder/source claim. A second historical build into `build/release/0.2.0-repro` recorded byte-identical source and web artifacts ([evidence/final-reproducibility.log](evidence/final-reproducibility.log)); the signing workflow previously refused with exit code 2 and created no signature ([evidence/final-signing-refusal.log](evidence/final-signing-refusal.log)).

Committed copies of `manifest.json`, `SHA256SUMS`, `sbom.cdx.json`, `provenance.json` and both `.tar.gz` payloads are in [artifacts/](artifacts/); their content digests match the manifest and checksum file. The generator reads this committed set, recomputes every manifest digest, reruns independent `sha256sum -c`, compares provenance lockfile/SBOM/artifact digests, and requires the recorded commit and tree to resolve locally before A01/A07/A10 can pass. Its release-check gate also parses the log's measured totals and compares them with the current README and status document; log existence alone is insufficient. The clean-copy regression in `services/core/test/release-qualification.test.mjs` verifies that the stored 2,052-test release-check log cannot pass against the current 2,060 inventory, missing source Git objects do not pass provenance/reproducibility, current checksums are rerun, and an audit log that reports vulnerabilities cannot pass. It uses a temporary copy, leaves the committed `qualification.json` snapshot and cutoff log unchanged, and does not establish full current-branch release qualification. Other committed test/security evidence remains a historical snapshot unless freshly executed and recorded. No artifact was uploaded to a release destination.

The committed copy in [artifacts/](artifacts/) contains **both reproducible archives** as well as the metadata, so a reader can verify the bundle in place:

```bash
cd docs/release/artifacts && sha256sum -c SHA256SUMS
```

Result: all four entries `OK` ([evidence/final-committed-artifacts-check.log](evidence/final-committed-artifacts-check.log)). `.gitignore` has an explicit exception for this directory: these archives are reproducible build outputs, not model weights. No signature file (`SHA256SUMS.asc`) exists.
