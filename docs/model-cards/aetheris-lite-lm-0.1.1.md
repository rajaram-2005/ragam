# Model card — Aetheris Lite LM 0.1.1

| | |
|---|---|
| **Identifier** | `aetheris-lite-lm@0.1.1` |
| **Family** | `aetheris-lite` |
| **Supersedes** | `aetheris-lite-lm@0.1.0` — kept as a record, still rollback-eligible |
| **Status** | `released` (0 hard failures, 0 soft failures) |
| **Licence** | MIT — first-party weights. No third-party weights are involved. |
| **Parameters** | 359,616 |
| **Base checkpoint** | **none** — trained from random initialisation |
| **Quantization** | none (float32) |
| **Context** | 128 characters |
| **Weights digest** | `53ae59b2a777be9d22f1f04b6cbc94aee3dad6144ac40e4e25c12f900164b60c` |
| **Config digest** | `25b76f2531a0fc544875c0c1d8441dfad0d98d2a7d9d0e5b439274b9e01b9e11` |
| **Corpus manifest digest** | `70c5b78c77bce0e122df93fe43504b6b780acf10b865baaa5076307b0883aa02` |
| **Vocabulary digest** | `98228a472eab78caa335205387b0126b87cdf14212375f39b57101f02c4c2605` |
| **Code revision** | `8d9cdf86913877e62ec36b434c398b4b9f7c0a67` — read beside the corpus, not after training |
| **Seeds** | model `0`, data `0`, split `20251012` |
| **Artifact** | `aetheris-lite-lm-53ae59b2a777.npz`, 1,446,862 bytes — **not in this repository** |
| **Machine-readable card** | [`aetheris-lite-lm-0.1.1.json`](./aetheris-lite-lm-0.1.1.json) |

> **The weights are not in this repository, by policy.** `.gitignore` excludes
> `artifacts/` and every weight format: Aetheris Lite checkpoints are produced by
> `services/fabric` and referenced by digest, never redistributed through Git.

## Why there is a 0.1.1

The model trains on **this repository's own text**. That means the release is a function
of the revision it was trained at, and 0.1.0 was trained at a tree that can no longer be
reconstructed exactly (its revision was recorded as `8108d30…-dirty`). Rather than
re-describe 0.1.0, or quietly re-issue it, this is a new version trained at a clean,
committed revision whose corpus can be rebuilt and checked:

| | 0.1.0 | 0.1.1 |
|---|---|---|
| Code revision | `8108d3098d575ca333ca86348fac2567a6364837-dirty` | `8d9cdf86913877e62ec36b434c398b4b9f7c0a67` |
| Corpus manifest digest | `c357293317e781f5…` | `70c5b78c77bce0e1…` |
| Corpus (train + validation) | 1,431,417 bytes | 2,646,300 bytes |
| Vocabulary | 143 characters | 148 characters |
| Parameters | 359,136 | 359,616 |
| Validation perplexity | 4.4033 | 4.8932 |

The perplexities are **not comparable with each other** and neither is presented as better:
the same 5,324,800-token budget was spent on a larger corpus, so a higher or lower number
here would say more about the text than about the model.

## What this model is

A **character-level decoder-only language model**, trained from random initialisation on
this repository's own text. It predicts the next character given up to 128
characters of context. Implementation: `services/fabric/fabric/lm/` — pure NumPy, no
PyTorch, no GPU, no network. Every gradient is derived by hand and checked against a
central finite difference.

## Intended use

**Demonstrating that the training pipeline and the on-device runtime work end to end**, and
serving as the artifact that the `klyvaron-lite` runtime in `services/core` loads,
validates and runs. It is a base completion model: it continues text.

## Out of scope

- **Not a chat assistant.** It does not follow instructions and has no safety behaviour.
  It *is* reachable from `/api/chat`, and the route refuses it: an unpinned request
  returns `model_not_instruction_tuned` (501), and pinning it by id returns a continuation
  labelled as one. Serving it as an assistant without that refusal would misrepresent it.
- **Not a general-purpose model.** It has no world knowledge beyond this repository's text.
- **Not compared to any pretrained model.** No such comparison was possible, and none is
  claimed anywhere.

## Training configuration

| Parameter | Value |
|---|---|
| Layers / heads / d_model / d_ff | 3 / 4 / 96 / 384 |
| Context window | 128 tokens |
| Steps / batch / tokens seen | 2,600 / 16 / 5,324,800 |
| Learning rate / warmup | 0.003 peak, 0.1 floor / 200 steps |
| Weight decay / grad clip | 0.01 / 1.0 |
| Dtype | float32 |
| Corpus split | 154 train / 17 validation files, whole-file, no overlap |
| Validation fraction / split seed | 0.1 / 20251012 |

## Evaluation

Held-out perplexity on a **file-disjoint** validation split — no document contributes to
both sides — against three baselines computed from the **same training statistics** and
scored on the **same 280,192 held-out tokens**.

| | Perplexity | Bits/char |
|---|---|---|
| `uniform` (`ln 148`) | 148.0000 | 7.2095 |
| `unigram` (training frequencies) | 32.9491 | 5.0422 |
| `bigram` (`P(next\|prev)`, training adjacencies) | 15.7588 | 3.9781 |
| **Aetheris Lite LM** | **4.8932** | **2.2908** |

**Verdict: beats the strongest baseline.** `perplexityVsBigram` = **0.310505**,
i.e. the model's perplexity is 31.1% of the bigram's
(3.22× better than the best non-neural baseline). That ratio, not the
raw perplexity, is what the release gate requires to be ≤ 1.0.

Other recorded metrics:

| Metric | Value |
|---|---|
| Training loss | 4.8597 → **1.4791** (improvement 3.380646, gate requires ≥ 1.0) |
| Validation unknown-character rate | **0.000011** (gate requires ≤ 0.02) |
| Wall time | 2,062.942 s (34 minutes, 165.2 MB peak, 2 CPU cores) |
| Tokens seen in training | 2,048 × 2,600 = 5,324,800 |

### Sample (greedy, temperature 0)

```
contactor and thermal limits in the contactor and thermal thermal in thermal thermal imits in the contactor and thermal 
```

At temperature 0.8 with top-k 40 it is noticeably less coherent, as expected from a model
this size:

```
pem: the to
a   indensent | The contactor record thermal second ever asses dits refused.
  cassify, and is the archived 
```

## Reproducibility across revisions

This model's corpus is this repository's own text, so **the revision and the corpus have to
be recorded together or neither means anything**. Three checks, run rather than asserted:

| Check | Result |
|---|---|
| Revision and corpus read at the same moment | `8d9cdf86913877e62ec36b434c398b4b9f7c0a67` — no `-dirty` suffix; `train.py` reads the revision beside the manifest |
| Manifest digest recomputed from that revision's own text | `70c5b78c77bce0e122df93fe43504b6b780acf10b865baaa5076307b0883aa02` — matched on re-derivation |
| Training from a *later* tree | refused: `--expect-manifest-digest 70c5b78c77bce0e122df93fe43504b6b780acf10b865baaa5076307b0883aa02` fails with the two digests, rather than training a different model and reporting success |

The run also writes its exact corpus next to its weights
(`aetheris-lite-lm-53ae59b2a777.corpus.json`, 2,646,300 bytes of text,
digest `47fc906701459115ed2987412323bb4e…`), so the model can be rebuilt even after the
repository has moved on.

## Limitations

The card's own list — facts about the artifact, generated by `model_limitations()`:

- trained from random initialisation; not derived from any pretrained base model
- character-level base model: it predicts the next character of repository text and follows no instructions (359,616 parameters, vocabulary of 148)
- output quality is low: this demonstrates the pipeline, not a usable assistant
- reachable from /api/chat, where an unpinned request is refused with model_not_instruction_tuned (501): it continues text and does not answer questions, and presenting it as an assistant would misrepresent it
- no comparison against any pretrained model was performed, and none is claimed

The provenance list — facts about the measurement, generated by `limitations_from_report()`:

- Character-level, not subword: sequences are long for the parameter count.
- Trained from scratch on 2,366,622 bytes of this repository's own text. It has no world knowledge, no instruction-following and no safety behaviour.
- Output quality is low by design of the experiment: 359,616 parameters trained for 2600 steps. This proves the pipeline, not the model.
- Evaluated only against bigram/uniform/unigram baselines on in-distribution held-out text; no comparison against any pretrained model was performed and none is claimed.
- Not instruction-tuned and has no tokenizer beyond ASCII-and-source-code characters; it cannot be exposed as a chat assistant in this state.
- 0.000011 of held-out characters are outside the training vocabulary and scored as <unk>; perplexity is slightly pessimistic because of it.
