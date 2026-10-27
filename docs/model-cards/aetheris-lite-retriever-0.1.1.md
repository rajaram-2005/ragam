# Model card — Aetheris Lite Retriever 0.1.1

| | |
|---|---|
| **Identifier** | `aetheris-lite-retriever@0.1.1` |
| **Family** | `aetheris-lite-dual-encoder` |
| **Status** | `released` |
| **Licence** | MIT |
| **Parameters** | 18,928 |
| **Base checkpoint** | none — trained from scratch |
| **Quantization** | none (float64 NumPy arrays) |
| **Weights digest** | `8eabd7fb164af88a8449fc0ceae7b57b46e76503a1c6b78d5fe543790cc8657b` |
| **Config digest** | `8bb457b2d65626de` |
| **Dataset digest** | `64e7e42ebd0ae7174d7d9044ac407971dd00e0e748980f7595a5ccdaafd40fe4` |
| **Vocabulary digest** | `31812656b2aac89a` |
| **Code revision** | `00dcb35ecfa036d6de595f017b7f45ade2eb2eb7` (the revision this card was generated at) |
| **Seeds** | data `1`, model `7` |
| **Supersedes** | [`aetheris-lite-retriever@0.1.0`](./aetheris-lite-retriever-0.1.0.md) |
| **Machine-readable card** | [`aetheris-lite-retriever-0.1.1.json`](./aetheris-lite-retriever-0.1.1.json) |

**Supersedes** `aetheris-lite-retriever@0.1.0`. The corpus, configuration, seeds and
evaluation protocol are unchanged — dataset and config digests are identical to 0.1.0.
What changed is the tokenizer: the stemmed token stream now includes the parts of
hyphenated terms (in both the Python and JavaScript stemmers), where 0.1.0's stream
dropped them and treated an untrained compound as entirely out of vocabulary. The
vocabulary grew accordingly (digest `31812656b2aac89a`, 18,928 parameters against
0.1.0's 18,784), the weights are different, and the measured scores below are **lower**
than 0.1.0's. 0.1.0's card records this as a dated correction; its measurements stand
as the record of that artifact under the previous token stream. This release exists so
the artifact the current code produces has a card of its own, rather than 0.1.0's card
describing weights the pipeline no longer reproduces.

## What this model is

A dual-encoder text retriever. It encodes a query and a document chunk into 32-dimensional
vectors and ranks candidates by scaled dot product. **It does not generate text.** It is the
dense ranker behind the private knowledge pipeline's retrieval step, sitting alongside BM25.

It is the first-party Aetheris Lite artifact required by the release criteria: a model with a
versioned, reproducible evaluation, produced by a pipeline that records its own provenance.

## Intended use

- Re-ranking candidate chunks retrieved from a private, locally indexed corpus.
- Grounding chat answers in cited company sources (`useKnowledge` on the chat path).

**Out of scope:** generation, classification, summarisation, any use as a general assistant,
and any corpus whose vocabulary does not overlap the training domain (see *Limitations*).

## Training configuration

| Parameter | Value |
|---|---|
| Architecture | dual encoder, shared vocabulary, mean pooling |
| `dModel` | 48 |
| `dEmb` | 32 |
| Max context | 96 tokens |
| Pooling | mean |
| Decoding / retrieval `topK` | 10 |
| Optimizer | Adam (hand-written; all five parameter gradients verified against central finite differences to ~3e-10) |
| Learning rate | 0.03 |
| Batch size | 8 |
| Epochs | 25 |
| Logit scale | 10.0 |
| Loss | in-batch softmax with one hard negative per anchor |
| Training triples | 48 |

The full pipeline run took **0.64 s** wall clock using **39.5 MB** peak RSS and **1.45 s**
user CPU on 2 cores.

### Base selection

Two candidate widths were trained for 8 epochs each and compared by MRR on a validation
split carved from the training queries (12 of 48, seed `20251012`, disjoint from the
evaluation split), so the reported held-out score is not a maximum over candidates.

| Candidate | Parameters (at selection) | Validation MRR | Evaluation MRR |
|---|---|---|---|
| `dModel=24` | 9,184 | 0.2230 | 0.5401 |
| **`dModel=48` (selected)** | **18,304** | **0.3037** | **0.5971** |

The released model's 18,928 parameters exceed the candidate's 18,304 because the final
training vocabulary is fit on all 48 training queries rather than the 36-query fit split.

A **language-model** base was *not* selected: `languageModelBase = "not selected: no weights
available on this host"`. No pretrained checkpoint of any kind was used, because none could be
downloaded. This model is trained from scratch, which is a materially weaker starting point than
fine-tuning a pretrained encoder and is recorded as such.

## Evaluation

Held-out condition: `overlap=low`, `split_by=query`, 24 evaluation queries over a 96-document
corpus. The comparator is BM25 (k1=1.5, b=0.75) over the same corpus with the same tokeniser.

| Metric | BM25 | **Trained** | Untrained control |
|---|---|---|---|
| MRR | 0.3352 | **0.7873** (+134.9%) | 0.0583 |
| Recall@1 | 0.2500 | **0.7083** | 0.0417 |
| Recall@5 | 0.5417 | **0.9583** | 0.1250 |
| nDCG@10 | 0.3942 | **0.8383** | 0.0739 |
| Latency / query | 0.0157 ms | 0.0334 ms | — |

Against 0.1.0 on the identical condition, the trained model is worse on every ordering
metric (MRR 0.8497 → 0.7873, Recall@1 0.7917 → 0.7083, nDCG@10 0.8860 → 0.8383) and equal
on Recall@5. That is the measured cost of the tokenizer correction on this fixture; it is
reported here rather than traded away, because the correction fixes real retrieval of
hyphenated terms that the fixture under-represents.

The **untrained control** is the same architecture with the same seed, untrained. It exists
because a dense model that merely ties a random initialisation would prove nothing; at MRR 0.06
it confirms the improvement comes from training rather than from the architecture.

**Experiment ledger verdict: `accept`** — *"target 'mrr' improved 0.3352 -> 0.7873 (+134.9%),
meeting the required +0.0500"*, judged against an unchanged baseline recorded before the run.

### Held-out-topic condition (a genuine failure, reported not hidden)

| Metric | BM25 | Trained |
|---|---|---|
| MRR | **0.3820** | 0.0123 |
| Recall@1 | **0.2778** | 0.0000 |
| Recall@5 | **0.6111** | 0.0000 |

18 evaluation queries. Here documents *and* queries for the held-out topics are unseen and the
vocabularies barely overlap. **The trained model loses badly — worse than 0.1.0 did on the
same split (MRR 0.0937).** This is not the deployment condition (the pipeline splits by query),
but it is a real generalisation limit at this data volume and it is recorded in the card
rather than omitted.

### Latency

BM25 0.0157 ms/query vs dense 0.0334 ms/query on the generation run. Both are far below one
scheduler quantum, so the difference is **not** a meaningful performance claim; a 1.0 ms noise
floor is applied to latency comparisons so a sub-millisecond timing difference cannot decide
an experiment. The absolute service-level ceiling lives on this card instead: **25 ms/query, hard**.

`latencyMs` is wall-clock and varies between runs (0.0316–0.0334 observed for the dense
model). Every observed value is inside the noise floor and ~750× inside the ceiling.

## Release requirements

| Metric | Requirement | Category | Hard | Result |
|---|---|---|---|---|
| `mrr` | ≥ 0.60 | retrieval | **yes** | 0.7873 — passed |
| `latencyMs` | ≤ 25.0 | latency | **yes** | 0.033 — passed |
| `historicalFailures` | ≥ 1.0 | historical_failures | no | not measured — soft failure |

Validation recorded **0 hard failures** and **1 soft failure** (`historicalFailures` was not
measured — no failure corpus exists yet).

An undertrained run is *not* releasable and the pipeline proves it: at 3 epochs trained MRR is
below the 0.60 floor, so `release` fails, the run record is `failed`, and
`release.detail.released` is `null`. A known-good release is never overwritten by an unvalidated
checkpoint — `ModelReleaseManager.release()` validates first, and `rollback()` restores a
previously released version.

## Provenance

| | |
|---|---|
| Platform | Linux 6.1.158+ x86_64, glibc 2.36 |
| Python | 3.11.2 |
| NumPy | 2.4.6 |
| CPU count | 2 |
| GPU | **not detected**; no vendor tooling available on this host |
| Peak RSS | 40,480 KB |
| CPU time | 1.45 s user / 0.028 s system |
| Run status | `partial` (3 of 8 stages blocked) |

Sample held-out queries used in evaluation (recorded verbatim so the prompts are not a
post-hoc rationalisation):

```
what is the requirement for disconnect and response regarding contactor
explain insulation including measurement regarding isolation
where is heat with degrees specified
explain drain including level regarding cell
explain percentage including gauge regarding estimation
explain condition including deterioration regarding state
where is limiter with surge specified
where is current with limit specified
```

## Pipeline stages

| Stage | Status |
|---|---|
| data_validation | completed |
| base_selection | completed |
| domain_training | completed |
| sft | **blocked_needs_weights** — supervised fine-tuning needs a base language model and its weights |
| preference_optimization | **blocked_needs_weights** — no preference data, no reward signal, no compute to justify it |
| distillation | **blocked_needs_weights** — needs a teacher model, and no teacher is installed |
| evaluation | completed |
| release | completed |

The overall run status is therefore `partial`, never `completed`. Three of eight stages could not
run on this host.

## Limitations

There are **two** limitation lists, and they are not the same thing. Conflating them
is how a model card ends up claiming completeness it does not have, so both are
reproduced here verbatim, exactly as the pipeline generated them (including its
lower-casing).

### On the model card itself — `card.limitations` (3)

Properties of the released artifact:

1. trained from scratch; not derived from any pretrained base model
2. retriever only: it does not generate text
3. 'historicalFailures' was not measured

### On the run record — `run.limitations` (13)

Properties of *this run*, including every stage that could not execute:

1. the corpus is a generated engineering-documentation fixture, not a real company corpus
2. base selection covers the retriever configuration only; choosing between Mistral, Qwen, Llama, Gemma and DeepSeek needs weights that cannot be downloaded here
3. the validation split is small (12 of 48 training queries), so candidate scores carry a wide error bar; the selection is reproducible but not precise
4. trained from scratch on a fixture corpus; this is not fine-tuning of a pretrained model
5. sft: supervised fine-tuning needs a base language model and its weights
6. preference_optimization: no preference data, no reward signal and no compute to justify it
7. distillation: distillation needs a teacher model, and no teacher is installed
8. evaluated on a generated fixture corpus; this says nothing about quality on real documents
9. the dense model encodes the whole corpus in memory and scores by dense matrix product, so its latency is not comparable to a production ANN index
10. no comparison against Mistral, Qwen, Llama, Gemma or DeepSeek was possible: none can be installed on this host, so no superiority claim over them is made or implied
11. under a held-out-TOPIC split (unseen vocabulary, not the deployment condition) the dense model scores MRR 0.012346 against BM25 0.382011 — it does not generalise to entirely unseen topic vocabularies at this data volume
12. no weights artifact was written; configure output_dir to persist one
13. 3 of 8 pipeline stages could not run on this host: sft, preference_optimization, distillation

The card carries the three facts a future user of the weights needs. The run record
carries the thirteen facts someone reproducing or auditing this run needs — including
the blocked stages, which belong to the run, not to the artifact. Item 10 of the run
record is the standing instruction made concrete: **no comparison against Mistral,
Qwen, Llama, Gemma or DeepSeek was possible, so no superiority claim over them is
made or implied anywhere in this repository.**

---

## Reproducibility across revisions

This card was generated at `00dcb35`, the first revision whose tokenizers emit hyphen-part
tokens. The training is deterministic: generating this card twice from the same revision
produced identical weights digests, metrics and validation (latencyMs excepted, as above).
There is not yet a later re-verification revision to record; when the reproduce command is
re-run at a future `HEAD` and every deterministic field matches, that belongs here exactly
as it does on the 0.1.0 card — and if a future change moves the token stream again, this
card becomes a superseded record the same way, by correction, not by silent edit.

## Reproducing

```bash
cd services/fabric
python - <<'PY'
from fabric.pipeline import Pipeline, PipelineConfig
p = Pipeline(PipelineConfig(epochs=25, model_version='0.1.1')); rec = p.run()
print(rec.status, p.registry.current().identifier, p.registry.current().metrics)
PY
```

Requires only Python 3.11+ and NumPy. No GPU, no network, no model downloads. Results are
deterministic apart from `latencyMs`. The full benchmark matrix, including the conditions where
this model loses, is in [`../06-benchmarks.md`](../06-benchmarks.md), and the re-measurement
history is in the erratum in [`../07-improvement-cycle.md`](../07-improvement-cycle.md).

## Release history

| Event | Status | Notes |
|---|---|---|
| registered | candidate | — |
| validated | — | 2 requirements passed, 0 hard failures, 1 soft failure |
| released | released | supersedes `aetheris-lite-retriever@0.1.0` (identical configuration and corpus; corrected tokenizer) |

The registry retains 0.1.0 as the rollback target: a release never destroys its predecessor,
and this card does not alter any measurement recorded on 0.1.0's card.
