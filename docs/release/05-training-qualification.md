# 05 — Training qualification evidence and evaluation

## Scope

Two distinct real local runs were executed. First, a **real, local, pure-NumPy, from-scratch tiny language-model smoke training** on the repository's own tracked text corpus verified parameter updates, evaluation, interruption, resume and rollback. Second, the **real 27,559,946-parameter JAX/NumPy trainer was launched through `LocalTrainingWorkerManager`** to verify SIGTERM cancellation, atomic checkpointing, restart persistence and failure handling. Neither run is Klyvaron Pro/Max foundation training, adapter/LoRA training, retrieval personalization, production-model inference, or training on user data. No user-owned private dataset was ingested. No external service, paid API or GPU was used. The operator consent records are in [evidence/training-evidence.json](evidence/training-evidence.json) and [evidence/training-worker-qualification.json](evidence/training-worker-qualification.json).

## What was executed

| Segment | Command / event | Result |
|---|---|---|
| A (before) | `train_lm.py --steps 10 --d-model 32 --n-layers 1 --d-ff 64 --seq-len 64 --batch-size 8 --checkpoint-every 10 --keep-checkpoint --snapshot-text manifest` | Completed. 16,224 parameters, loss **5.1599 → 4.5114**, validation perplexity **94.4250**, weights digest `262d8003…`. Log [evidence/training-segment-a.log](evidence/training-segment-a.log) |
| R1 (interruption) | `timeout 1.5 … --steps 120 --checkpoint-every 10 --keep-checkpoint` | Exit 124 (killed). Atomic checkpoint at **step 40** (`aetheris-checkpoint/v1`, 14 weight arrays, 28 Adam arrays, 40 losses). Log [evidence/training-interrupted.log](evidence/training-interrupted.log) |
| R2 (resume) | `--steps 120 --resume-from <step-40 checkpoint>` | "resumed from … at step 40; 80 steps remain". Completed 120 steps, loss **5.1599 → 3.3644**, validation perplexity **34.1122**, weights digest `f3242e25…`, artifact SHA-256 `be063aab…`. Log [evidence/training-resumed.log](evidence/training-resumed.log) |
| R3 (rollback / replay) | Same resume command into a fresh output directory | **Bit-identical** weights digest and artifact SHA-256 to R2. Log [evidence/training-rollback.log](evidence/training-rollback.log) |

Verification: `scripts/release/verify-training-evidence.py` → **11 PASS, 0 FAIL** ([evidence/training-evidence.json](evidence/training-evidence.json)). It independently loads the checkpoint with `allow_pickle=False`, checks its format/step/config digest, recomputes the artifact SHA-256 against the report, and compares the evaluations.

## Worker control-plane qualification against the real trainer

`npm run release:training-worker` → **12 PASS, 0 FAIL** ([evidence/training-worker-qualification.json](evidence/training-worker-qualification.json)). The harness generates a deterministic synthetic corpus, obtains a consent-bound preflight, starts the production trainer through `LocalTrainingWorkerManager`, and records:

| Event | Measured result | Evidence |
|---|---|---|
| Real trainer start | Python 3.11.2 / NumPy 2.4.6 / JAX 0.10.2; `27,559,946` parameters; 4 planned steps | [preflight](evidence/training-worker-preflight.json), [cancellation log](evidence/training-worker-cancellation.log) |
| Real progress | Step `1/4`, finite loss (`8.8687`), `rss=1066MB` | [cancellation log](evidence/training-worker-cancellation.log) |
| SIGTERM cancellation | `cancelJob` → `child.kill('SIGTERM')`; trainer logged `received signal 15` and exited `130` | [jobs](evidence/training-worker-jobs.json) |
| Atomic checkpoint | `330,788,264` bytes; SHA-256 `e6bc5d2a…`; worker-log prefix matches independently computed digest | [checkpoint](evidence/training-worker-checkpoint.json), [checksums](evidence/training-worker-checksums.txt) |
| Independent integrity | `sha256sum -c` → `OK`; NPZ loaded with `allow_pickle=False`: 90 weight arrays, 180 optimizer arrays, expected architecture digest, finite weights | [checkpoint](evidence/training-worker-checkpoint.json) |
| Restart persistence | Fresh manager restored `cancelled_checkpointed` with `checkpointVerified=true`; no orphan process | [jobs](evidence/training-worker-jobs.json) |
| Real failure path | A second real trainer process with an invalid corpus record exited `1`, was recorded as `failed` with no checkpoint, and left no active process | [failure log](evidence/training-worker-failure.log), [jobs](evidence/training-worker-jobs.json) |

The large checkpoint is deliberately kept in the ignored `build/training-worker-qualification/` directory; its digest and metadata are committed. This run proves cancellation/lifecycle behavior only. It does **not** qualify a production Klyvaron model, does not claim foundation training, and does not use licensed weights.

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
| SIGTERM cancellation of the **real** trainer | **PASS** | Real `LocalTrainingWorkerManager` → `train_klyvaron.py` run: signal 15, exit 130, `cancelled_checkpointed`, atomic checkpoint verified by `sha256sum -c` and unpickled NPZ inspection; see [evidence/training-worker-qualification.json](evidence/training-worker-qualification.json) |
| Training on a user-owned private dataset | **BLOCKED** | No consent, dataset or ownership validation was supplied |
| GPU/accelerator training | **NOT APPLICABLE / BLOCKED** | No GPU on this host |
| Foundation or adapter training | **BLOCKED** | No installed licensed architecture/weights; see [04-model-qualification.md](04-model-qualification.md) |

## Honest limitations

The 120-step smoke model **does not beat** the bigram baseline (validation perplexity 34.1122 vs 27.2280; ratio 1.2528). It is evidence of real parameter updates, checkpointing, resume and evaluation mechanics on a tiny model — **not** evidence of a capable production model, and no foundation-model training claim is made. A completed job alone would not prove learning; the changed weights digest, decreased loss and before/after perplexity are the evidence. The separate 27,559,946-parameter worker run is a bounded cancellation/lifecycle smoke test; it does not supply licensed weights, production inference, or a released model artifact.
