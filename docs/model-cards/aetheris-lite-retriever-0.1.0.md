# Model card — Aetheris Lite Retriever 0.1.0

| | |
|---|---|
| **Identifier** | `aetheris-lite-retriever@0.1.0` |
| **Family** | `aetheris-lite-dual-encoder` |
| **Status** | `released` |
| **Licence** | MIT |
| **Parameters** | 18,784 |
| **Base checkpoint** | none — trained from scratch |
| **Quantization** | none (float64 NumPy arrays) |
| **Weights digest** | `db3366ea7f7bb0bbb4cedc9616a10977e4cf39a8f68d009a2f9b7d8cfcbc1871` |
| **Config digest** | `8bb457b2d65626de` |
| **Dataset digest** | `64e7e42ebd0ae7174d7d9044ac407971dd00e0e748980f7595a5ccdaafd40fe4` |
| **Vocabulary digest** | `3c719685e4125416` |
| **Code revision** | `aa11de45d6d3dd0dcbb4853278ca81f7f5d54ab9` (the revision this card was generated at) |
| **Seeds** | data `1`, model `7` |
| **Re-verified at** | `6be52b98dfdc6c4d741ff7d521541758ef512175` — see *Reproducibility across revisions* |
| **Machine-readable card** | [`aetheris-lite-retriever-0.1.0.json`](./aetheris-lite-retriever-0.1.0.json) |

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

Training ran in **1.06 s** using **40.9 MB** peak RSS and **2.27 s** user CPU on 2 cores.

### Base selection

Two candidate widths were trained for 8 epochs each and compared on the held-out evaluation
split. Selection was by held-out MRR, measured before the baseline was frozen, so the baseline
could not be mutated by the comparison.

| Candidate | Parameters | Held-out MRR | Recall@1 |
|---|---|---|---|
| `dModel=24` | 9,424 | 0.7563 | 0.7083 |
| **`dModel=48` (selected)** | **18,784** | **0.8326** | **0.7917** |

A **language-model** base was *not* selected: `languageModelBase = "not selected: no weights
available on this host"`. No pretrained checkpoint of any kind was used, because none could be
downloaded. This model is trained from scratch, which is a materially weaker starting point than
fine-tuning a pretrained encoder and is recorded as such.

## Evaluation

Held-out condition: `overlap=low`, `split_by=query`, 24 evaluation queries over a 96-document
corpus. The comparator is BM25 (k1=1.5, b=0.75) over the same corpus with the same tokeniser.

| Metric | BM25 | **Trained** | Untrained control |
|---|---|---|---|
| MRR | 0.3352 | **0.8497** (+153.5%) | 0.0500 |
| Recall@1 | 0.2500 | **0.7917** | 0.0417 |
| Recall@5 | 0.5417 | **0.9583** | 0.0833 |
| nDCG@10 | 0.3942 | **0.8860** | 0.0578 |
| Latency / query | 0.0211 ms | 0.0540 ms | — |

The **untrained control** is the same architecture with the same seed, untrained. It exists
because a dense model that merely ties a random initialisation would prove nothing; at MRR 0.05
it confirms the improvement comes from training rather than from the architecture.

**Experiment ledger verdict: `accept`** — *"target 'mrr' improved 0.3352 -> 0.8497 (+153.5%),
meeting the required +0.0500"*, judged against an unchanged baseline recorded before the run.

### Held-out-topic condition (a genuine failure, reported not hidden)

| Metric | BM25 | Trained |
|---|---|---|
| MRR | **0.3820** | 0.0937 |
| Recall@1 | **0.2778** | 0.0556 |
| Recall@5 | **0.6111** | 0.1667 |

18 evaluation queries. Here documents *and* queries for the held-out topics are unseen and the
vocabularies barely overlap. **The trained model loses badly.** This is not the deployment
condition (the pipeline splits by query), but it is a real generalisation limit at this data
volume and it is recorded in the card rather than omitted.

### Latency

BM25 0.0211 ms/query vs dense 0.0540 ms/query. Both are far below one scheduler quantum, so the
difference is **not** a meaningful performance claim; a 1.0 ms noise floor is applied to latency
comparisons so a sub-millisecond timing difference cannot decide an experiment. The absolute
service-level ceiling lives on this card instead: **25 ms/query, hard**.

`latencyMs` is wall-clock and varies between runs (0.0540, 0.0550, 0.0584 observed). Every
observed value is inside the noise floor and ~450× inside the ceiling.

## Release requirements

| Metric | Requirement | Category | Hard | Result |
|---|---|---|---|---|
| `mrr` | ≥ 0.60 | retrieval | **yes** | 0.8497 — passed |
| `latencyMs` | ≤ 25.0 | latency | **yes** | 0.055 — passed |
| `historicalFailures` | ≥ 1.0 | historical_failures | no | not measured — soft failure |

Validation recorded **0 hard failures** and **1 soft failure** (`historicalFailures` was not
measured — no failure corpus exists yet for a first release).

An undertrained run is *not* releasable and the pipeline proves it: at 3 epochs trained MRR is
0.3045, below the 0.60 floor, so `release` fails, the run record is `failed`, and
`release.detail.released` is `null`. A known-good release is never overwritten by an unvalidated
checkpoint — `ModelReleaseManager.release()` validates first, and `rollback()` restores a
previously released version.

## Provenance

| | |
|---|---|
| Platform | Linux 6.1.158+ x86_64, glibc 2.36 |
| Python | 3.11.2 |
| NumPy | 2.1.3 |
| CPU count | 2 |
| GPU | **not detected**; no vendor tooling available on this host |
| Peak RSS | 40,900 KB |
| CPU time | 2.27 s user / 0.036 s system |
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

### On the run record — `run.limitations` (12)

Properties of *this run*, including every stage that could not execute:

1. the corpus is a generated engineering-documentation fixture, not a real company corpus
2. base selection covers the retriever configuration only; choosing between Mistral, Qwen, Llama, Gemma and DeepSeek needs weights that cannot be downloaded here
3. trained from scratch on a fixture corpus; this is not fine-tuning of a pretrained model
4. sft: supervised fine-tuning needs a base language model and its weights
5. preference_optimization: no preference data, no reward signal and no compute to justify it
6. distillation: distillation needs a teacher model, and no teacher is installed
7. evaluated on a generated fixture corpus; this says nothing about quality on real documents
8. the dense model encodes the whole corpus in memory and scores by dense matrix product, so its latency is not comparable to a production ANN index
9. no comparison against Mistral, Qwen, Llama, Gemma or DeepSeek was possible: none can be installed on this host, so no superiority claim over them is made or implied
10. under a held-out-TOPIC split (unseen vocabulary, not the deployment condition) the dense model scores MRR 0.093673 against BM25 0.382011 — it does not generalise to entirely unseen topic vocabularies at this data volume
11. no weights artifact was written; configure output_dir to persist one
12. 3 of 8 pipeline stages could not run on this host: sft, preference_optimization, distillation

The card carries the three facts a future user of the weights needs. The run record
carries the twelve facts someone reproducing or auditing this run needs — including
the blocked stages, which belong to the run, not to the artifact. Item 9 of the run
record is the standing instruction made concrete: **no comparison against Mistral,
Qwen, Llama, Gemma or DeepSeek was possible, so no superiority claim over them is
made or implied anywhere in this repository.**

---

## Reproducibility across revisions

`codeRevision` records the commit this card was generated at, which is now behind
`HEAD`. That would be a problem if the numbers depended on the code that changed, so
the `reproduce` command was re-run at `6be52b9` and every deterministic field was
compared against this card:

| Field | `aa11de4` | `6be52b9` | Match |
|---|---|---|---|
| `weightsDigest` | `db3366ea7f7bb0bbb4cedc…` | `db3366ea7f7bb0bbb4cedc…` | yes |
| `configDigest` | `8bb457b2d65626de` | `8bb457b2d65626de` | yes |
| `datasetDigest` | `64e7e42ebd0ae7174d7d…` | `64e7e42ebd0ae7174d7d…` | yes |
| `parameterCount` | 18,784 | 18,784 | yes |
| `baseCheckpoint` | `null` | `null` | yes |
| `metrics.mrr` | 0.849702 | 0.849702 | yes |
| `metrics.recall@1` | 0.791667 | 0.791667 | yes |
| `validation.hardFailures` | `[]` | `[]` | yes |
| `metrics.latencyMs` | 0.0550 | 0.0554 | no — wall-clock, see below |

The intervening commits changed the Fabric service's bind default and added tests;
they did not touch the pipeline, the encoder or the metrics. `latencyMs` differs in
the fourth decimal place because it is a wall-clock measurement, and both values sit
far inside the 1.0 ms noise floor and the 25 ms hard ceiling.

At that revision this card was **not stale**: it reproduced bit-for-bit at `HEAD`.

**Correction (2026-10-25).** A tokenizer correction — the stemmed token stream now
includes the parts of hyphenated terms, in both the Python and JavaScript stemmers —
changed the data this configuration trains on, so the current pipeline **no longer
reproduces these weights bit-for-bit**: the same released configuration now measures
MRR **0.787269** against the 0.849702 recorded above. No measured value on this card
has been altered; the card is now the record of the released artifact at its training
revision, and re-issuing it from a fresh release run is open work. The full
re-measurement is in the erratum in
[docs/07](../07-improvement-cycle.md).

## Reproducing

```bash
cd services/fabric
python - <<'PY'
from fabric.pipeline import Pipeline, PipelineConfig
p = Pipeline(PipelineConfig(epochs=25)); rec = p.run()
print(rec.status, p.registry.current().identifier, p.registry.current().metrics)
PY
```

Requires only Python 3.11+ and NumPy. No GPU, no network, no model downloads. Results are
deterministic apart from `latencyMs`. The full benchmark matrix, including the conditions where
this model loses, is in [`../06-benchmarks.md`](../06-benchmarks.md).

## Release history

| Event | Status | Notes |
|---|---|---|
| registered | candidate | — |
| validated | — | 2 requirements passed, 0 hard failures, 1 soft failure |
| released | released | "first Aetheris Lite retriever"; superseded: none |

No parent version. No rollback targets exist yet, because no earlier version was ever released.
