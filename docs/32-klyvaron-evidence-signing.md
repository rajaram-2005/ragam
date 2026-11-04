# Klyvaron qualification evidence: offline signing and audit procedure

This procedure separates measurement capture, human review, external signing and trust-anchor verification. The repository can prepare the canonical signing request, attach an externally generated signature to the unchanged report, validate operator-approved public trust input, and verify it against a public trust store. It does not contain a private-key signer, create keys, inspect private-key files, or choose which signers an operator should trust.

## Scope and current state

Phase 9 adds an API for assembling captured Windows, Linux and macOS target results into one unsigned qualification report, generating its exact signing message, and auditing the signed report. It does not establish that a capture is truthful: an operator must review the hardware/runtime evidence and the source run records before signing. Test keys and synthetic adapter results are test fixtures only. No production signing key, trusted production report, or signed Klyvaron qualification exists.

## Production release gate is separate and mandatory

This qualification ceremony is only one evidence source; it does not satisfy or bypass the mandatory production evidence package. Production approval/release also requires exact artifact and provenance binding, signed evaluation/performance/hardware/security evidence, independent real deployment and rollback, distinct trusted reviewers/approvers, current non-superseded signatures, and the explicit release decision described in [`klyvaron-evidence-standard.md`](klyvaron-evidence-standard.md). Registry state cannot jump from `trained` or `release_candidate` directly to `released`; CI blocks Klyvaron production tags without a complete package, real artifact bytes, trust anchors and current production-approved registry record. Current provisional decisions remain Lite **HOLD**, Pro **NOT RELEASED**, Max **NOT RELEASED**. No audit or production release has been performed.

## Operator sequence

1. On each target machine, run the host-bound capture CLI with the exact release record, pinned local artifact manifest, and reviewed adapter module:

   ```sh
   node scripts/klyvaron-evidence.mjs capture /secure/evidence/model-record.json /secure/models/candidate /secure/evidence/pinned-files.json /secure/adapters/host-adapters.mjs /secure/evidence/linux-capture.json
   ```

   Run it separately on Linux, macOS and Windows; the CLI derives OS, architecture and hardware from the actual host and cannot impersonate another target. `pinned-files.json` is an array of `{ "path", "sha256", "bytes" }` entries. The reviewed module must export `runtimeAdapter` (`id`, `version`, `inferenceSuiteSha256`, `coldStart`, `runInferenceSuite`) and `deploymentAdapter` (`readActiveArtifactSha256`, `activateArtifact`, `restoreArtifact`). The capture runs supplied JavaScript adapter code, so inspect and trust those local modules before execution; no default or synthetic adapter is installed. The coordinator refuses mismatched artifact bytes, incomplete inference results, unsupported OS/architecture, insufficient RAM, or an unverified rollback. Preserve each successful result and its raw run records in the operator's protected evidence store; do not commit model weights or private datasets.
2. Review the capture outputs independently. Confirm the model/tier/artifact identity, target OS and architecture, measured hardware report, runtime/version, inference suite digest/results, cold-start trace, and candidate-to-known-good rollback readback. A valid schema and digest do not prove the claims are true.
3. On a machine with no signing key available to the Ragam runtime, prepare the bundle with the standard-library-only CLI from `services/core`:

   ```sh
   node scripts/klyvaron-evidence.mjs prepare /secure/evidence/model-record.json /secure/evidence/captures.json /secure/evidence/qualification-signing-bundle.json
   ```

   The command writes a new file only (refuses overwrite) with private file permissions where supported. It contains the unsigned report plus a request with the canonical payload, exact UTF-8 `signingMessage`, and its SHA-256. Transfer only the request to an approved offline Ed25519 signing utility through the operator's controlled process. Sign the exact `signingMessage`; do not reserialize the payload or sign a different digest.
4. Have the external signer return an attestation JSON object with `algorithm: "ed25519"`, the signer's public-key `keyId`, `purpose: "tier_release_qualification"`, and the base64 signature. Attach it to the unchanged report using the CLI:

   ```sh
   node scripts/klyvaron-evidence.mjs finalize /secure/evidence/model-record.json /secure/evidence/qualification-signing-bundle.json /secure/evidence/attestation.json /secure/evidence/signed-qualification-report.json
   ```

   Finalization rebuilds the unsigned report and canonical signing request from the exact model record, refuses a changed bundle or malformed signature, and writes a new report without claiming the signature is trusted. Keep all private-key creation, custody and use outside this repository and outside the application. The CLI never accepts or loads a private key.
5. Independently approve a trust-source JSON containing only the signer's **public** key and a narrow purpose allowlist. Provision it to the installation data directory with the local CLI:

   ```sh
   node scripts/klyvaron-evidence.mjs provision-trust /secure/evidence/approved-public-trust.json /secure/ragam-data/klyvaron/evidence-trust.json
   ```

   The command validates public-key types and purpose scopes, refuses an empty store and will not replace an existing trust file; it writes restrictive file permissions where supported. The default trust store remains empty and there is no browser mutation route. Do not grant a qualification key dataset-review, training, artifact-integrity or release-manifest purposes unless that key is separately authorized for those duties. Rotation/revocation remains an operator-controlled procedure, not an app feature.
6. Audit the signed report against that public trust store:

   ```sh
   node scripts/klyvaron-evidence.mjs audit /secure/evidence/model-record.json /secure/evidence/signed-qualification-report.json /secure/evidence/evidence-trust.json
   ```

   Require `status: "verified"`; an absent/empty trust store, unknown key, wrong purpose, changed report, or mismatched model/tier/artifact/runtime/hardware is a refusal. Only then may the signed report be supplied to the existing release-registry transition gates. Audit does not itself update the release registry; the separate `decide` command evaluates an explicit registry snapshot and observed deployments.
7. Retain the unsigned capture bundle, reviewed report, signing request, signed report, public-key identity and human review record under the operator's evidence-retention policy. Never place private keys, private user chats, or unapproved datasets in the bundle.

## Per-tier release-decision evaluation

Once the verified release registry snapshot and separately collected deployment evidence are available, evaluate them with the CLI:

```sh
node scripts/klyvaron-evidence.mjs decide /secure/evidence/model-records.json /secure/evidence/deployments.json /secure/ragam-data/klyvaron/evidence-trust.json /secure/evidence/family-release-decision.json
```

The deployment file must contain one observed record per tier/platform, with `tier`, `modelId`, `artifactSha256`, `qualificationReportSha256`, `platform`, `architecture`, `runtimeId`, `runtimeVersion`, `hardwareClass`, `hardwareReportSha256`, `ramBytes`, `runtimeVerified: true`, and `hardwareCompatible: true`. Obtain those values from the real, reviewed deployment observations for the exact artifact; do not copy qualification-target rows and label them as deployed. The evaluator fails closed on missing or duplicate platform entries and any mismatch with the signed target. Exit code `0` means all three tiers are ready; exit code `2` means the evaluation completed but the family is `partial` or `blocked`. The output is a digest-stamped decision report, not a signature or a deployment action. The CLI does not run tests, install a release, execute a rollback, or prove that the supplied deployment observations are truthful.

## Canonical signing bytes

The request's message is exactly:

```text
klyvaron-evidence-attestation/v1\n<canonical JSON payload>
```

Here `\n` means one literal line-feed byte. The JSON is produced by `canonicalKlyvaronEvidenceJson`; the payload binds the purpose, model ID and qualification report digest. Ed25519 signs the UTF-8 bytes of that full message. The verifier checks the signature against the public key ID and purpose scope in the local trust store.

## Limitations

The CLI can coordinate a single-host capture only when the operator supplies reviewed runtime and deployment adapters; it does not provide those adapters or run an external signer. It can install an approved public trust file once, but does not rotate or revoke trust anchors. No automated independent reviewer is provisioned, and the schema cannot verify the truth of a signer’s attestations or replace an independent inspection of runtime traces and deployment logs. The synthetic adapter test is wiring coverage, not platform evidence. Linux-only access to this sandbox is not Windows/macOS qualification. Actual artifact-backed captures, offline signing, and per-tier release decisions remain pending.
