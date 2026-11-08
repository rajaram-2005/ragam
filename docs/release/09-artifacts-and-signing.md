# 09 — Versioned artifact manifest, checksum verification and signing

## Reproducible process

| Requirement | Implementation | Status |
|---|---|---|
| Declared semantic version | `VERSION` = `0.2.0`, checked against root/web/desktop/core `package.json` by `build-release.mjs` | **PASS** |
| Exact source commit | `git rev-parse HEAD` recorded in `provenance.json`; source artifact is `git archive <commit>` | **PASS** |
| Clean checkout | `build-release.mjs` refuses a dirty tree unless `--allow-dirty` is passed, and extracts the committed tree into an empty temp directory; the web build runs from that extracted tree | **PASS** |
| Pinned dependencies | `apps/web/package-lock.json`, `apps/desktop/package-lock.json`, `services/fabric/requirements.lock` (CI installs from the lock); `npm ci` in the extracted checkout | **PASS** |
| Generated release artifacts | `ragam-source-0.2.0.tar.gz`, `ragam-web-0.2.0.tar.gz` (deterministic tar, `gzip -n`) | **PASS** |
| SHA-256 checksums | `SHA256SUMS` written with `node:crypto` | **PASS** |
| Independent checksum verification | `verify-release.mjs` shells out to `sha256sum -c SHA256SUMS` — a different implementation from the writer — and recomputes every manifest digest | **PASS** |
| CycloneDX 1.5 SBOM | `sbom.cdx.json` from the committed lockfiles only (never `node_modules`) | **PASS** |
| Build provenance | `provenance.json`: version, commit, tree, lockfile digests, artifact digests, builder, reproducibility strategy, explicit unsigned state | **PASS** |
| Cryptographic signature with an authorized key | `sign-release.mjs` + `.github/workflows/release.yml`; **no authorized key exists** | **BLOCKED** |
| Independent signature verification | `gpg --verify SHA256SUMS.asc SHA256SUMS` implemented in `sign-release.mjs`; cannot run without a signature | **BLOCKED** |
| Intended release location | Artifacts staged locally in `build/release/0.2.0/` (ignored) and copied to `docs/release/artifacts/` as committed evidence; no GitHub Release/registry used | **BLOCKED** |
| Release publication | No publication step exists; `workflow_dispatch` only stages on the workflow run | **BLOCKED** (separate owner authorization) |

Commands:

```bash
node scripts/release/build-release.mjs --out build/release/0.2.0
node scripts/release/verify-release.mjs --dir build/release/0.2.0
```

Logs: [evidence/final-artifact-build.log](evidence/final-artifact-build.log), [evidence/final-artifact-verify.log](evidence/final-artifact-verify.log), [evidence/final-signing-refusal.log](evidence/final-signing-refusal.log). Committed copies of the manifest, checksums, SBOM and provenance are in [artifacts/](artifacts/).

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

**Exact remaining requirement:** an owner-authorized signing key (key id + armored private key stored as a protected secret outside the repository), the four variables above, and an owner-authorized release destination. No signature, private key or published release was created.
