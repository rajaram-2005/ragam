# Klyvaron production evidence standard

This is the required evidence contract for any Klyvaron Lite, Pro, or Max production release. It is a verifier specification, not evidence that any report has been produced or any model has passed. The current `release-evidence/{lite,pro,max}/v1.0.0/` directories are placeholders and must fail verification.

## Trust and evidence principles

- One tier, model id, semantic version, model revision, configuration and artifact digest per package. No cross-tier inheritance.
- Reports describe actual execution/measurements and use `evidenceClass: "production"`, `synthetic: false`, and `mockedResponses: false`. Test fixtures, simulations, mock endpoints, copied measurements and synthetic-only data are explicitly labelled and rejected.
- Evidence is immutable once signed. The package manifest hashes exact report-file bytes; any byte change invalidates its signature. Signatures bind exact report/manifest digests and purpose.
- The trust store contains public Ed25519 keys only, with principal identity, role and narrow purpose scopes. Four distinct principals/keys sign the evidence package, deployment verification, independent review and final release approval. The reviewer's principal must match `reviewerId`; the approval principal must match `approverId`; those identities must differ.
- Evidence packages expire no later than 90 days after issuance. Reports must have valid UTC timestamps at or before manifest issuance. An expired or future-dated package is rejected. Superseded manifest hashes are listed in `supersededEvidenceManifestSha256` in the operator-managed trust file; listed hashes are rejected. Current registry and publication records must pin the exact non-superseded manifest digest.
- Unknown report fields are rejected so evidence bundles cannot be used as a transport for private conversations, dataset rows, credentials, or unrelated payloads. Dataset contents and model weights do not belong in Git; only metadata, digests, and external artifact references belong in evidence reports.
- The verifier checks structure, consistency, hashes, trusted signatures and artifact bytes. It does not prove that human assertions are truthful, grant a license, execute inference/deployment/rollback, or replace independent review.

## Required package layout

For semantic version `1.0.0`, the exact package directory is `release-evidence/<tier>/v1.0.0/`. The checked-in scaffold READMEs mark absent evidence and are not valid package files; remove them when assembling a real package. A production package and its `signatures/` directory must contain exactly the required files below, with no unmanifested notes or payloads.

```text
release-evidence/<tier>/v<version>/
├── README.md                         # scaffold only; remove before production verification
├── model-identity.json
├── artifact-manifest.json
├── artifact-checksums.sha256
├── training-provenance.json
├── evaluation-report.json
├── performance-report.json
├── hardware-compatibility.json
├── security-report.json
├── deployment-evidence.json
├── rollback-test.json
├── independent-review.json
├── release-decision.json
└── signatures/
    ├── README.md                     # scaffold only; remove before production verification
    ├── evidence-manifest.json
    ├── evidence.attestation.json
    ├── deployment.attestation.json
    ├── independent-review.attestation.json
    └── release-decision.attestation.json
```

All required `.json` evidence files are JSON objects with the exact schema versions described below. Unrecognized fields fail closed. Files are regular non-symlink files; artifact paths are safe relative paths. The evidence verifier reads bounded metadata files and hashes model files from the operator-supplied artifact root; it never copies model weights into the repository.

## Identity and artifact binding

`model-identity.json` uses `klyvaron.production-model-identity.v1` with exactly:

- `tier`: `lite`, `pro`, or `max`;
- `modelId`: respectively `klyvaron-lite-assistant`, `klyvaron-pro-assistant`, or `klyvaron-max-assistant`;
- `version`: the exact SemVer matching the directory and release tag;
- `modelRevisionSha256`, `configurationSha256`, `artifactSha256`, `artifactManifestSha256`.

Every report repeats tier, model id, version, model revision digest and artifact digest. The manifest and identity must agree exactly.

`artifact-manifest.json` uses `klyvaron.production-artifact-manifest.v1`. It names one or more formats, tokenizer name/version/format and files `{path, sha256, bytes, role}`. Roles are `weights`, `tokenizer`, `configuration` or `other`; at least one non-empty weights file and tokenizer file are required. `artifactSha256` is the canonical SHA-256 of the sorted path/hash/byte-count/role file list. `artifactManifestSha256` is the canonical SHA-256 of the artifact manifest object. `artifact-checksums.sha256` is the exact sorted `<sha256><two spaces><path>` list. The verifier hashes every actual artifact file and checks file size and digest.

## Required reports

Every report below repeats common identity and declares production/non-synthetic/non-mocked evidence. The trust signer must authenticate the evidence manifest, and role-specific signatures authenticate deployment, review and approval reports.

1. **`training-provenance.json` — `klyvaron.production-training-provenance.v1`:** `sourceType: "licensed_open_weight_foundation"`, `method: "first_party_fine_tuning"`, `thirdPartyBasePresentedAsOriginal: false`; open-weight foundation id/revision/digest and license; approved license-review digest; training host id/resource class; versioned, licensed dataset ids and manifest/content digests; training configuration and run digests/id; completion time; `privateChatAutoIngested: false` and `privateChatsIncluded: false`. Dataset rows, chats and raw training text are prohibited. Pro/Max resource class cannot be `local_low_resource`.
2. **`evaluation-report.json` — `klyvaron.production-evaluation-report.v1`:** exact artifact, suite digest, run id/time, numeric quality and safety metrics, and named mandatory checks with passing result digests. Evaluation must be a signed real run, not a mock response.
3. **`performance-report.json` — `klyvaron.production-performance-report.v1`:** one or more actual hardware runs pinning device, OS, runtime/version, time and run digest; measured p50/p95 latency, tokens/second and peak resident bytes. Values must be finite and meaningful; zero or synthetic observations do not qualify.
4. **`hardware-compatibility.json` — `klyvaron.production-hardware-compatibility.v1`:** supported device/OS/architecture/runtime/version rows, report digest and measurement timestamp. Each row must match a measured performance run.
5. **`security-report.json` — `klyvaron.production-security-report.v1`:** pass decision, reviewer id/time, test-suite digest; any listed finding must have a resolved status and resolution report digest. No unresolved high/critical finding is allowed; this gate requires all findings resolved.
6. **`deployment-evidence.json` — `klyvaron.production-deployment-evidence.v1`:** an independent pipeline (`verificationMode: "independent_pipeline"`) names verifier id/organization and attests independence from training and deployment. Each target binds an actual inference run, verified hardware report, runtime, measured p95 latency/throughput/resource use and passing trace digests for: artifact retrieval, signature verification, checksum verification, model-revision match, inference, streaming, cancellation, model-selection routing, access control, request isolation, failure handling and recovery. At least one target must be a verified supported local consumer device, or a real verified cloud GPU endpoint with GPU model. Mocked inference is not accepted.
7. **`rollback-test.json` — `klyvaron.production-rollback-test.v1`:** passing test run/time, rollback completion, recovery verification, prior artifact digest distinct from the release artifact, restored prior digest, and recovery-probe digest.
8. **`independent-review.json` — `klyvaron.production-independent-review.v1`:** `decision: "approve"`, `independent: true`, reviewer id/organization/time, explicit false flags for involvement in training, deployment and artifact authoring, and resolved review findings. The signature principal must match this reviewer.
9. **`release-decision.json` — `klyvaron.production-release-decision.v1`:** explicit `decision: "approve"`, `authorized: true`, approver id, authority role, reason and approval timestamp. The signature principal must match the approver and differ from every other production signer, including the independent reviewer.

## Signed manifest and trust-store format

`signatures/evidence-manifest.json` has schema `klyvaron.production-evidence-manifest.v1` and fields `tier`, `modelId`, `version`, `modelRevisionSha256`, `artifactSha256`, `issuedAt`, `expiresAt`, `files` and `manifestSha256`. Each file row binds the exact required report path, byte count and raw-file SHA-256. `manifestSha256` is the canonical SHA-256 over the manifest body without `manifestSha256`. Every evidence file must appear exactly once; unknown/missing files fail.

Each attestation JSON is an Ed25519 object `{algorithm, keyId, purpose, signature}`. The required purposes are:

| File | Purpose |
|---|---|
| `evidence.attestation.json` | `klyvaron_release_evidence` |
| `deployment.attestation.json` | `klyvaron_deployment_verification` |
| `independent-review.attestation.json` | `klyvaron_independent_review` |
| `release-decision.attestation.json` | `klyvaron_release_decision` |

The trust JSON has format `klyvaron-evidence-trust/v1`, a `keys` list of public-key records, and optional `supersededEvidenceManifestSha256` SHA-256 digests. A production key record includes `publicKeyPem`, its matching `keyId`, `label`, `principalId`, `roles` and narrow `purposes`; private key data is forbidden. Required roles are `release_evidence_custodian`, `deployment_verifier`, `independent_reviewer` and `release_approver`. Keys/principals must be distinct for the four roles. Operators revoke/supersede a package by adding its manifest digest to the trust file under controlled release authority; the application does not create or rotate keys.

The signature payloads bind, respectively, the manifest digest, canonical deployment-report digest, canonical independent-review-report digest, and a decision-binding digest of the manifest plus the full exact release-decision report. All payloads are purpose-scoped and model-id-bound. Editing a report, changing tier/artifact/revision, changing approval, using an untrusted/wrong-role key, or reusing another tier's signatures blocks verification.

The separate registry publication record uses `klyvaron.production-publication-manifest.v1` and binds tier, model id, version, model revision SHA-256, artifact SHA-256, the exact production-evidence manifest SHA-256, `status: "published"`, publication time and location. Its `sha256` is the canonical digest of those body fields, and a distinct `release_manifest` attestation signs that digest.

## Verification

Run the independent production gate with the real operator-held artifact directory and public trust store:

```sh
node services/core/scripts/verify-klyvaron-release.mjs \
  --tag klyvaron-lite-v1.0.0 \
  --package-dir release-evidence/lite/v1.0.0 \
  --artifact-root /operator/artifacts/lite/v1.0.0 \
  --trust-store /operator/trust/klyvaron-evidence-trust.json \
  --registry-record /operator/registry/klyvaron-lite-assistant.json
```

Exit 0 means all checks passed for that exact package and current registry record; exit 2 means blocked. `--policy-check` verifies the no-direct-release lifecycle policy without claiming production evidence. The verifier performs no model inference, deployment, approval, rollback, network retrieval, or publication. For the actual current decisions and CI setup, see [Klyvaron release governance](klyvaron-release-governance.md).
