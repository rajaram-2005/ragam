# 05 — Training qualification evidence and evaluation

## Scope

A **real, local, pure-NumPy, from-scratch tiny language-model smoke training** was executed on the repository's own tracked text corpus. This is **not** Klyvaron Pro/Max foundation training, not adapter/LoRA training, not retrieval personalization, and not training on user data. No user-owned private dataset was ingested. No external service, paid API or GPU was used. The operator consent record is in [evidence/training-evidence.json](evidence/training-evidence.json).

## What was executed

| Segment | Command / event | Result |
|---|---|---|
| A (before) | `train_lm.py --steps 10 --d-model 32 --n-layers 1 --d-ff 64 --seq-len 64 --batch-size 8 --checkpoint-every 10 --keep-checkpoint --snapshot-text manifest` | Completed. 16,224 parameters, loss **5.1599 → 4.5114**, validation perplexity **94.4250**, weights digest `262d8003…`. Log [evidence/training-segment-a.log](evidence/training-segment-a.log) |
| R1 (interruption) | `timeout 1.5 … --steps 120 --checkpoint-every 10 --keep-checkpoint` | Exit 124 (killed). Atomic checkpoint at **step 40** (`aetheris-checkpoint/v1`, 14 weight arrays, 28 Adam arrays, 40 losses). Log [evidence/training-interrupted.log](evidence/training-interrupted.log) |
| R2 (resume) | `--steps 120 --resume-from <step-40 checkpoint>` | "resumed from … at step 40; 80 steps remain". Completed 120 steps, loss **5.1599 → 3.3644**, validation perplexity **34.1122**, weights digest `f3242e25…`, artifact SHA-256 `be063aab…`. Log [evidence/training-resumed.log](evidence/training-resumed.log) |
| R3 (rollback / replay) | Same resume command into a fresh output directory | **Bit-identical** weights digest and artifact SHA-256 to R2. Log [evidence/training-rollback.log](evidence/training-rollback.log) |

Verification: `scripts/release/verify-training-evidence.py` → **11 PASS, 0 FAIL** ([evidence/training-evidence.json](evidence/training-evidence.json)). It independently loads the checkpoint with `allow_pickle=False`, checks its format/step/config digest, recomputes the artifact SHA-256 against the report, and compares the evaluations.

## Requested lifecycle checklist

| Requirement | Result | Evidence |
|---|---|---|
| User consent | **PASS (operator-initiated, synthetic)** | Consent record with basis, dataset ownership, fingerprint and purpose; no user data |
| Dataset ownership / validation | **PASS (repository-owned corpus)** | 496 train / 55 validation files, no overlap; manifest digest `66cff61f…` stable across segments |
| Dataset fingerprint | **PASS** | `corpus.manifestDigest` in every report |
| Stable training config | **PASS** | `configDigest` `714156ec13dd…`; a mismatched resume is refused by `train.py` |
| Resource preflight | **PASS (recorded)** | CPU x86_64, NumPy 2.4.6, ~239–242 MB peak, 10.3 s wall for R2 |
| Job creation / progress | **PASS** | 120 per-step loss records and progress log |
| Actual parameter updates | **PASS** | 10-step weights `262d8003…` ≠ 120-step weights `f3242e25…`; checkpoint bytes differ from the final artifact |
| Atomic checkpoint creation | **PASS** | `write_checkpoint` uses `.partial` + `Path.replace`; one intact checkpoint survived SIGTERM |
| Restart recovery / resume | **PASS** | `provenance.resumedFrom = {checkpoint, step: 40}`; full 120-step loss curve |
| Evaluation before / after | **PASS** | perplexity 94.4250 → 34.1122 |
| Checkpoint integrity | **PASS** | Format/step/losses/Adam state verified with `allow_pickle=False` |
| Rollback | **PASS** | Replaying from the retained step-40 checkpoint reproduced a bit-identical artifact |
| SIGTERM cancellation of the **real** trainer | **NOT TESTED** | Only the Core worker control plane is contract-tested with a stub trainer in `services/core/test/klyvaron-training-worker.test.mjs` |
| Training on a user-owned private dataset | **BLOCKED** | No consent, dataset or ownership validation was supplied |
| GPU/accelerator training | **NOT APPLICABLE / BLOCKED** | No GPU on this host |
| Foundation or adapter training | **BLOCKED** | No installed licensed architecture/weights; see [04-model-qualification.md](04-model-qualification.md) |

## Honest limitations

The 120-step smoke model **does not beat** the bigram baseline (validation perplexity 34.1122 vs 27.2280; ratio 1.2528). It is evidence of real parameter updates, checkpointing, resume and evaluation mechanics on a tiny model — **not** evidence of a capable production model, and no foundation-model training claim is made. A completed job alone would not prove learning; the changed weights digest, decreased loss and before/after perplexity are the evidence.
