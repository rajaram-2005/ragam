# Klyvaron production release governance

**Status: mandatory, fail closed. No Klyvaron production tier is approved by this repository or by this document.** Current decisions are provisional governance holds based on the evidence currently available; they are not independent audit findings.

| Tier | Current decision | Basis |
|---|---|---|
| Lite | **HOLD** | No complete, tier-specific, signed production evidence package is installed and independently verified. Existing Lite research/training artifacts do not establish production readiness. |
| Pro | **NOT RELEASED** | No complete, tier-specific, signed production evidence package or real GPU deployment evidence is installed and independently verified. |
| Max | **NOT RELEASED** | No complete, tier-specific, signed production evidence package or real GPU deployment evidence is installed and independently verified. |

A passing test suite, model card, benchmark, available file, candidate status, tier label, or approval for another tier cannot change these decisions. No exceptions or inherited evidence are permitted. Do not describe these provisional outcomes as an external audit, security certification, or production finding.

## Independent gates, per tier

Each exact tuple `(tier, model id, semantic version, model revision SHA-256, configuration SHA-256, artifact SHA-256)` must independently satisfy every item in [the evidence standard](klyvaron-evidence-standard.md):

1. **Identity and provenance:** real first-party fine-tuned weights; exact file hashes, byte counts, tokenizer and artifact formats; a licensed open-weight foundation and pinned revision; approved license review; versioned, licensed dataset manifests; reproducible training-run record; no private-chat auto-ingestion or third-party foundation model presented as original. Pro and Max may not be trained on the low-resource host.
2. **Evaluation and performance:** signed evaluation of the exact artifact, including quality and safety checks; measured latency, throughput, memory and runtime on identified real hardware; supported hardware/runtime evidence. A mock, simulation, synthetic-only run, copied deployment observation, or unexecuted benchmark is not production evidence.
3. **Security and deployed operation:** signed security review with all findings resolved; an independent verifier must retrieve and verify the real artifact/signature/checksum, match the model revision, exercise real inference, streaming, cancellation, routing, access control, isolation, failure recovery, and resource/latency behavior. Local evidence must use a verified supported consumer device; cloud evidence must use a real GPU endpoint.
4. **Rollback:** an observed rollback to a distinct known-good artifact and a successful recovery probe.
5. **Independent review and approval:** the independent reviewer must not have authored the artifact or participated in training or deployment. The final approval must be explicit and signed by a separately trusted, authorized release approver.
6. **Freshness and supersession:** every manifest is time-bounded (maximum 90 days), expired evidence is rejected, and superseded evidence-manifest digests are revoked in the operator-managed public trust file. Registry records bind approval and publication to the exact current manifest digest and artifact identity.

Signatures prove that a trusted key signed bytes; they do not prove the truth of a claim. The independent review remains a human/organizational responsibility. The verifier never upgrades a decision itself and never fabricates evidence, signatures, test results, or audit findings.

## Registry lifecycle

The release registry uses these distinct states:

`planned → training → trained → evaluated → release_candidate → production_approved → released → suspended`

`failed` is a terminal result until a new version is explicitly replanned. The legacy `deprecated` status remains for historical records; it is not a production approval. A suspended model is unavailable and cannot be silently resumed; a new reviewed version and evidence package are required.

- `planned → training` records an intentional training start.
- `training → trained` requires a verified artifact and trusted training-run evidence.
- `trained → evaluated` requires a valid signed held-out evaluation.
- `evaluated → release_candidate` requires the pre-production provenance, artifact, runtime, hardware, and tier gates.
- `release_candidate → production_approved` requires the complete, current, exact-identity production package and its distinct role-scoped signatures. Synthetic-only and mocked evidence are always rejected.
- `production_approved → released` additionally requires a signed `klyvaron.production-publication-manifest.v1` bound to the same tier, model id, version, artifact, revision and production-evidence manifest digest; it records `status: "published"`, publication time and location.
- `released → suspended` requires a recorded reason. Suspended and failed entries are never available for inference.

There is no direct `trained → released` or `release_candidate → released` path. The Core transition function enforces this independently of the CI tag gate. On registry reload, persisted production states are reverified; invalid or stale production state is refused rather than advertised. Runtime availability also requires a tier-specific deployment match.

## CI and operational release procedure

The CI workflow runs the static no-direct-transition policy check. Tags named `klyvaron-lite-v<semver>`, `klyvaron-pro-v<semver>`, or `klyvaron-max-v<semver>` additionally invoke the production package verifier. Missing trust configuration, package files, a real artifact root, signatures, or any required evidence causes a non-zero result. There is no `skip`, warning-only, mock, or network fallback.

A protected release environment must provide:

- an operator-managed public evidence trust store (public keys only, role/purpose scoped, with superseded manifest digests); and
- the exact tier/version artifact directory, separately from the Git repository.

In this repository those paths are represented by GitHub Actions variables `KLYVARON_TRUST_STORE_PATH`, `KLYVARON_ARTIFACT_ROOT`, and `KLYVARON_REGISTRY_RECORD_PATH`. The registry file must be in `production_approved` or `released` and pin the same current evidence-manifest digest. They must resolve to provisioned files/directories on the release runner. If they are unset or inaccessible, the production tag fails closed. Do not put private signing keys, provider credentials, or model weights in GitHub variables, workflow files, or this repository. No fallback downloads or hidden cloud inference are permitted.

Manual verification uses the same script:

```sh
node services/core/scripts/verify-klyvaron-release.mjs \
  --tag klyvaron-lite-v1.0.0 \
  --package-dir release-evidence/lite/v1.0.0 \
  --artifact-root /operator/artifacts/lite/v1.0.0 \
  --trust-store /operator/trust/klyvaron-evidence-trust.json \
  --registry-record /operator/registry/klyvaron-lite-assistant.json
```

The verifier checks package structure, schemas, cross-report identity, expiry, supersession, signatures and role authority, and hashes the real files under the artifact root. A passing report is evidence for a gate, not a command to publish. The actual registry transition and signed publication record remain separate controlled operations. Preserve Local-only privacy, routing/authentication, cost safeguards, and the existing 120-second interactive-adaptation cap; this release gate does not authorize a hidden provider fallback or unattended model training.

## Current evidence and decisions

The committed `release-evidence/{lite,pro,max}/v1.0.0/` directories contain explanatory placeholders only. They contain no production report or signature and are designed to fail the production verifier. No production trust anchor, independent deployment, rollback, review, or approval has been provisioned here. The decisions remain **Lite HOLD; Pro NOT RELEASED; Max NOT RELEASED** until real evidence is supplied and independently verified for each tier.
