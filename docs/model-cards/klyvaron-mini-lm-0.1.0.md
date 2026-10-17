# Model card — Klyvaron Mini LM 0.1.0

| | |
|---|---|
| **Identifier** | `klyvaron-mini-lm@0.1.0` |
| **Family** | `klyvaron-mini` — the architecture is `aetheris-core-v1`; `mini` is a preset of it, not a tier |
| **Status** | `released` (0 hard failures, 1 soft failure — the wall-clock target, below) |
| **Licence** | MIT — first-party weights. No third-party weights are involved. |
| **Parameters** | 1,421,952 |
| **Base checkpoint** | **none** — trained from random initialisation |
| **Quantization** | none (float32) |
| **Context** | 128 characters |
| **Weights digest** | `eaca87db5700b9ee99d162e650b23478bd9a57715e349dee0fb18a4dc3fda116` |
| **Model config digest** | `81ef35d1b440895620d488fcc99ec5ccfaa6aca1ac573106d6108c862929cc1c` — the 14 fields of `TransformerConfig`, hashed as the trainer serialises them |
| **Card config digest** | `19f11a49e5ec53769c3d67f9dbc60b96a9dcb706d5033808e553e876dc033dc7` — the model config **and** the training config together, which is what the release manager records |
| **Corpus manifest digest** | `f8dfef6fc61458cffd7a5c3e0db526a6212366de68a3f7ade95dfa0e70eb3ed7` |
| **Vocabulary digest** | `a8c0642bc24412a9bc3b93c13973c5ced462c2d44883d1949471f36cb393b24a` |
| **Code revision** | `e616bdc9863fa92588b389f7ff5ba0dc3a5dda6e-dirty` — read beside the corpus, at the revision the run started from |
| **Seeds** | model `0`, data `0`, split `20251012` |
| **Artifact** | `klyvaron-mini-lm-eaca87db5700.npz`, 5,696,206 bytes (sha256 `c0acb52b3efb64593360288997b3929c2a332810faa6de6c316e99097cee8237`) — **not in this repository** |
| **Run record** | [`../experiments/klyvaron-mini-lm-run.json`](../experiments/klyvaron-mini-lm-run.json) — the exact command, the config and the report's outcome |
| **Machine-readable card** | [`klyvaron-mini-lm-0.1.0.json`](./klyvaron-mini-lm-0.1.0.json) |

> **The weights are not in this repository, by policy.** `.gitignore` excludes `artifacts/` and every
> weight format: Klyvaron checkpoints are produced by `services/fabric` and referenced by digest,
> never redistributed through Git.
>
> **And the file is not retained anywhere.** The digests in the table above were read off the bytes
> that existed when the run finished; by 2026-10-16 `artifacts/` was no longer present in the
> workspace and no copy existed elsewhere on the machine. So the digest is the reference and the
> file is gone: this card records a released artifact rather than shipping one. That is a real
> limitation of this release, not a formality — an artifact nobody can load is a record, and the
> only reason the release is still checkable is that the gate ran before the bytes were lost, with
> its verdict, its metrics and its one soft failure written onto this card and into
> [`../experiments/klyvaron-mini-lm-run.json`](../experiments/klyvaron-mini-lm-run.json).

## What this model is

The **second artifact of the `aetheris-core-v1` architecture**, and the first one trained on an
assembled corpus rather than on this repository's text alone. It is a **character-level
decoder-only language model**, written and trained in pure NumPy — no PyTorch, no GPU, no network —
that predicts the next character given up to 128 characters of context. Every gradient is derived by
hand and checked against a central finite difference.

It is **trained from random initialisation**: `baseCheckpoint` is null on the card, and that is the
family's decision rather than an accident ([24](../24-own-models.md)). Neither this artifact nor any
other in this family is a pinned third-party model wearing our name.

Its **differentiator parts are off** — `age_buckets` 0, `state_classes` 0, no verdict head, no state
head — and the config says so. Those parts are implemented in the same trainer and measured
separately by a 900-step prototype
([`../experiments/differentiator-prototype.json`](../experiments/differentiator-prototype.json));
they are off here because labelling a general-purpose corpus with the age of the evidence behind each
token and with the state a person expressed is a mechanism that does not exist yet. A config may not
imply a capability its data cannot train.

## Why there is a Mini

`mini` is **not a tier**. Pro and Max are unbuilt: they need an accelerated trainer backend and
compute this machine does not have. `mini` is the size this host can train in one sitting, so it is
the artifact that makes the rest of the recipe real — corpus assembly with licence checking, a
tokenizer fitted on the training split only, a trainer, an evaluation gate and this card — instead of
described. What it does **not** do is move Pro or Max: no gate of theirs moves because this exists.

## Intended use

**Demonstrating that from-scratch training works end to end on a corpus this project can license and
reproduce**, and providing a second artifact for the runtime's artifact path to be tested against. It
is a base completion model: it continues text.

## Out of scope

- **Not a chat assistant.** It does not follow instructions and has no safety behaviour. It is not
  instruction-tuned, so a runtime that serves it reports `instructionTuned` false and `/api/chat`
  refuses an unpinned request with `model_not_instruction_tuned` (501) rather than presenting a
  completion as an answer.
- **Not a general-purpose model.** It has no world knowledge beyond the corpus below.
- **Not exported or runtime-verified.** Unlike `aetheris-lite-lm@0.1.1`, this artifact has not been
  through an export to the runtime's artifact format or a verification run in it. That path exists;
  it has not been run for these weights, and no measurement here claims it has.
- **Not compared to any pretrained model.** No such comparison was possible, and none is claimed.

## Training configuration

| Parameter | Value |
|---|---|
| Layers / heads / d_model / d_ff | 3 / 4 / 192 / 768 |
| Context window | 128 tokens |
| Steps / batch / tokens seen | 4,000 / 16 / 8,192,000 |
| Learning rate / warmup | 0.003 peak, 0.1 floor / 200 steps |
| Weight decay / grad clip | 0.01 / 1.0 |
| Optimiser | AdamW, β 0.9/0.95, ε 1e-08 |
| Dtype | float32 |
| Tokenizer | character-level, **352** characters, fitted on the training split only |
| Corpus split | 1,010 train / 196 validation files, held out **by source**, no source on both sides |
| Validation fraction / split seed | 0.1 / 20251012 |
| Extensions read | `.py`, `.pyi`, `.md`, `.rst`, `.txt`, `.js`, `.json`, `.ts` |

## Evaluation

Held-out perplexity on a validation split that is **two whole sources** — `pallets__click` and
`psf__requests`, 1,897,673 bytes, 196 files — neither of which contributed a single byte of training
text. Baselines are computed from the **training** statistics and scored on the **same 1,907,072
held-out characters**.

| | Perplexity | Bits/char |
|---|---|---|
| `uniform` (`ln 352`) | 352.0000 | 8.4594 |
| `unigram` (training frequencies) | 29.1000 | 4.8629 |
| `bigram` (`P(next\|prev)`, training adjacencies) | 15.8644 | 3.9877 |
| **Klyvaron Mini LM 0.1.0** | **4.7342** | **2.2431** |

**Verdict: beats the strongest baseline.** `perplexityVsBigram` = **0.298416** — the model's
perplexity is 29.8 % of the bigram's, 3.35× better than the best non-neural baseline. That ratio,
not the raw perplexity, is the hard requirement (≤ 1.0).

This number is a **harder test than the released Lite model's**: Lite's split was file-disjoint
inside one repository, so every validation document was near training text of the same kind. Mini is
evaluated on two Python projects whose files the model never saw, which is what "held out" is
usually assumed to mean. The two perplexities are not comparable with each other and neither is
presented as better.

Other recorded metrics:

| Metric | Value | Requirement |
|---|---|---|
| Training loss | 5.7551 → **0.8157** (improvement 4.939358) | ≥ 1.0 nats, hard — **met** |
| `perplexityVsBigram` | 0.298416 | ≤ 1.0, hard — **met** |
| Validation unknown-character rate | **0.000070** | ≤ 0.02, hard — **met** |
| Parameters | 1,421,952 | ≤ 5,000,000, soft — **met** |
| Wall time | 8,456.326 s (2 h 21 min, 419.2 MB peak, 2 CPU cores) | ≤ 3,600 s, soft — **NOT met** |

**The soft failure is recorded, not waived.** The gate's soft targets were written for a smaller run
and were not relaxed to make this one pass: 8,456 s against a 3,600 s target is a real miss, it is
listed in the card's own limitations, and it is the honest cost of training on two CPU cores. The
rate is documented in [24 §6](../24-own-models.md): about 9 GFLOP/s end to end, against 0.13–0.16
TFLOP/s for a bare fp32 matmul on the same host.

### Sample (greedy, temperature 0)

```
the status and the status and the same the same of the same of the same of the same of the same of the same of the same
```

At temperature 0.8 it is more varied and no more coherent, as expected at this size:

```
places sour tests changelors or and looken interametrization can integresserty.
  :pypi:`pytest-customate`
     *last re
```

## The corpus

Seven sources, each resolved to a commit SHA with its licence read **at that SHA**, and each recorded
in [`../experiments/corpus-sources.json`](../experiments/corpus-sources.json): this repository's own
text plus `pallets/flask`, `expressjs/express`, `psf/requests`, `microsoft/TypeScript`,
`pytest-dev/pytest` and `pallets/click`, all under the same SPDX allowlist the composed path uses
(Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, CC0-1.0, CC-BY-4.0). `numpy/numpy` was **refused**:
GitHub reports its licence as `NOASSERTION`, so zero bytes of it were written rather than a note that
someone thought it looked permissive.

The manifest the run reports embeds **every file's path, size and sha256**, the per-source summary and
the held-out source list, which is why the manifest digest — `f8dfef6f…` — is the claim about the
corpus.

**The manifest is narrower than the assembled directory, and that is stated rather than glossed.**
The run read eight extensions — `.py`, `.pyi`, `.md`, `.rst`, `.txt`, `.js`, `.json`, `.ts` — which
is **11,764,775 bytes of the 13,651,619 bytes assembled**. The remaining 1.89 MB was not trained on.
For this repository's own contribution it is the larger half: 1,160,058 of 3,018,919 bytes, because
`services/core` is `.mjs` (1,596,253 bytes) and `.mjs` was not on the list, as the web app's `.jsx`
and `.css` were not either. The missing text is a scope limit of this artifact, not a claim about
the corpus. The run also wrote its exact corpus snapshot beside its weights
(`klyvaron-mini-lm-eaca87db5700.corpus.json`, digest `8867227977aba3cc…`) so the model can be rebuilt
after the repository has moved on.

## Limitations

The card's own list — facts about the artifact, generated by `model_limitations()`:

- trained from random initialisation; not derived from any pretrained base model
- character-level base model: it predicts the next character of the text it was trained on and follows no instructions (1,421,952 parameters, vocabulary of 352)
- output quality is low: this demonstrates the pipeline, not a usable assistant
- not instruction-tuned: a runtime that serves it reports `instructionTuned` false, and `/api/chat` refuses an unpinned request with `model_not_instruction_tuned` (501), because it continues text and does not answer questions, and presenting it as an assistant would misrepresent it
- no comparison against any pretrained model was performed, and none is claimed
- `'wallSeconds' 8456.3260 exceeds the allowed maximum 3600.0000`

The provenance list — facts about the measurement, generated by `limitations_from_report()`:

- Character-level, not subword: sequences are long for the parameter count.
- Trained from scratch on 9,867,102 bytes assembled from 7 licence-checked sources, 2 of them held out whole for validation (pallets__click, psf__requests). It has no world knowledge, no instruction-following and no safety behaviour.
- Output quality is low by design of the experiment: 1,421,952 parameters trained for 4000 steps. This proves the pipeline, not the model.
- Evaluated only against bigram/uniform/unigram baselines on in-distribution held-out text; no comparison against any pretrained model was performed and none is claimed.
- Not instruction-tuned and has no tokenizer beyond ASCII-and-source-code characters; it cannot be exposed as a chat assistant in this state.
- 0.000070 of held-out characters are outside the training vocabulary and scored as `<unk>`; perplexity is slightly pessimistic because of it.

## Reproducing it

```bash
# 1. assemble the corpus (licence-checked, refuses what it cannot license)
python3 services/fabric/scripts/assemble_corpus.py --out artifacts/corpus

# 2. train (about 2.4 h on two CPU cores), holding out two sources whole
python3 -u services/fabric/scripts/train_lm.py \
  --corpus-root artifacts/corpus \
  --extensions .py,.pyi,.md,.rst,.txt,.js,.json,.ts \
  --validation-sources pallets__click,psf__requests \
  --run-name klyvaron-mini-lm --d-model 192 --n-layers 3 --n-heads 4 --d-ff 768 \
  --seq-len 128 --batch-size 16 --steps 4000 --warmup-steps 200 \
  --output-dir artifacts --json artifacts/klyvaron-mini-lm.report.json

# 3. run the report through the release gate and write the card
python3 services/fabric/scripts/lm_release.py \
  --report artifacts/klyvaron-mini-lm.report.json --version 0.1.0 \
  --name klyvaron-mini-lm --family klyvaron-mini \
  --out docs/model-cards/klyvaron-mini-lm-0.1.0.json
```

The digest check is available in the trainer: `--expect-manifest-digest f8dfef6f…` refuses to train
if the corpus on disk is not the corpus this card describes.

**What that command rebuilds, and what it does not.** It rebuilds an artifact of this kind — same
architecture, same size, same recipe — in about 2.4 h. It does not rebuild *these* bytes, and after
this card was written it would not even rebuild this corpus. Two reasons, both recorded rather than
smoothed over:

1. **The corpus was copied off a dirty working tree.** `assemble_corpus.py` copies this repository's
   own text from disk (every other source comes from a tarball at a pinned SHA) while recording only
   `git rev-parse HEAD`, and it truncates each source at a byte cap in sorted-path order. At assembly
   time 45 paths in this repository were uncommitted, so the recorded revision `e616bdc…` does not
   describe the bytes that were copied, and the cap makes the file set depend on the tree's shape at
   that moment. `f8dfef6f…` is a record of what was read, not a recipe.
2. **The assembler has been fixed, which does not retroactively fix this run.** It now records
   `clean` and a `treeDigest` over the path and content of every file copied, and marks the revision
   `-dirty` when the tree does not match it — the same suffix `train.code_revision()` has always
   written for the code revision. A corpus assembled from a clean tree is reproducible from the
   commit it names; a corpus assembled from a dirty one is a record, and now says so.
